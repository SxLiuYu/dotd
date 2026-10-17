/**
 * src/control-plane/journal.ts —— 步骤级 journal：崩溃安全 + call_id 幂等对账（R3，CP §5）。
 *
 * 硬保证（CP §5.3 三条）：
 * 1. **已 succeeded 步永不重执行**：恢复从 succeeded 步直接取 result_json 注入上下文。
 * 2. **unknown 步先对账再决策**：执行面确认 `done` 则补记结果（不重放也不白花），确认
 *    `aborted` 才重放，仍未知才「注入未知提示 + 转审批」。这守住「绝不重复执行」——
 *    done 分支不执行、aborted 分支执行面保证未落地。
 * 3. **审计闭环**：孤儿步转 interrupted（不删）；治理 `uniq_open_step` 以
 *    journal_step=call_id 保证同一步至多一张活动审批单（幂等重试命中同一单）。
 *
 * 两步写入时序（CP §5.2；call_id 先写后调 = call_sent，endTool succeeded = call_done）：
 *   beginTool → INSERT started 行（synchronous=FULL，行提交先于任何外部调用）
 *   … exec.runTool …
 *   endTool   → UPDATE … WHERE task_id=? AND seq=? AND run_epoch=?
 *               行数 0 → 迟到 Runner，拒绝并记 stale_writer（CP §2.2 围栏）。
 *
 * 契约 J3 落点：唯一写路径接口 = beginTool→endTool / markPending / beginLlm→endLlm /
 * skipStep / getStepByCallId / reconcileAndResolve / tail。
 * 契约 J1：beginLlm 也返回 {seq, callId}，steps.call_id 对 llm 步同样填写。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SideEffect, Step, StepStatus } from '../shared/contracts.ts';
import { newCallId } from '../shared/ids.ts';
import { StepLimitError } from '../shared/errors.ts';
import type { ControlPlaneConfig, StepRow } from './types.ts';
import { toStep, writeJournalBlob } from './types.ts';

/**
 * 执行面对账面（CP §5.3 的 exec.reconcileCall / getCallResult）。
 * 真实实现归执行面（EX §5.4 ledger）；控制面只按契约消费三种结局。
 * 未注入时（测试/装配未接线）按 'unknown_host' 处理——保守进「注入提示 + 转审批」。
 */
export interface ExecReconciler {
  reconcileCall(callId: string): Promise<'done' | 'aborted' | 'unknown' | 'unknown_host'>;
  getCallResult(callId: string): Promise<{ resultJson: string } | null>;
}

/** 治理 forceApproval 面（CP §5.3 / 契约 J6：唯一发起点 = journal unknown 孤儿步）。 */
export interface GovernanceForcer {
  requestApproval(req: {
    taskId: string;
    kind: 'side_effect_unknown';
    subject: { journalStep: string; tool: string; params: string };
    reason: string;
  }): Promise<{ approvalId: number }>;
}

export interface JournalDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  record(kind: string, level: string, detail: string): void;
  /** 执行面对账（可缺省；缺省 = unknown_host）。 */
  exec?: ExecReconciler;
  /** 治理 forceApproval（可缺省；缺省 = 只注入提示，不转审批）。 */
  governance?: GovernanceForcer;
  /** treatUnknownAsRisk（CP §5.3：默认 true；应急模式强制 true，CT:29）。 */
  treatUnknownAsRisk?: boolean;
}

export class Journal {
  private readonly db: DatabaseSync;
  private readonly cfg: ControlPlaneConfig;
  private readonly deps: JournalDeps;
  /** CP §5.4 软上限已警告过的任务（每任务只警告一次，防日志轰炸）。 */
  private readonly softWarned = new Set<string>();

  constructor(deps: JournalDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.cfg = deps.cfg;
  }

  // ── 写入：工具步（CP §5.2 两步协议）────────────────────────────────

  /**
   * beginTool = call_sent。事务内：seq=max+1；callId=ULID()；
   * INSERT steps(task_id,seq,kind='tool',status='started',call_id,tool_name,args_json,
   *              side_effect,run_epoch,started_at)
   * 行提交（synchronous=FULL）先于任何外部调用——这就是「call_sent」记录。
   *
   * args >32KB → 落 journal-blobs/<task>.<seq>.json，args_json 存引用串（CP §5.4）。
   */
  beginTool(
    taskId: string,
    epoch: number,
    tool: string,
    args: unknown,
    se: SideEffect,
  ): { seq: number; callId: string } {
    const argsJson = this.truncate(taskId, args);
    const callId = newCallId();
    const seq = this.nextSeq(taskId);
    this.db
      .prepare(
        `INSERT INTO steps(task_id, seq, kind, status, call_id, tool_name, args_json,
                           result_json, side_effect, run_epoch, approval_id,
                           started_at, finished_at)
         VALUES(?,?,'tool','started',?,?,?,NULL,?,?,NULL,?,NULL)`,
      )
      .run(taskId, seq, callId, tool, argsJson, se, epoch, Date.now());
    return { seq, callId };
  }

  /**
   * endTool = call_done。UPDATE … WHERE task_id=? AND seq=? AND run_epoch=?；
   * 行数 0 → 迟到 Runner，拒绝并记 stale_writer（CP §2.2 围栏）。
   */
  endTool(
    taskId: string,
    epoch: number,
    seq: number,
    st: StepStatus,
    result?: unknown,
  ): void {
    const resultJson = result === undefined ? null : this.truncate(taskId, result, seq);
    const res = this.db
      .prepare(
        `UPDATE steps SET status=?, result_json=?, finished_at=?
         WHERE task_id=? AND seq=? AND run_epoch=?`,
      )
      .run(st, resultJson, Date.now(), taskId, seq, epoch);
    if (res.changes === 0) {
      this.deps.record('stale_writer', 'normal', JSON.stringify({ taskId, epoch, seq, what: 'endTool' }));
      this.deps.bus.publish('stale_writer', { taskId, epoch, seq, what: 'endTool' });
    }
  }

  /**
   * markPending（CP §5.2/§4.1）：需审批的工具步转 status='pending' 并写 approval_id。
   * **pending 步是「等待」，不是「崩溃孤儿」**——恢复扫描只认 started（issue #5a）。
   */
  markPending(taskId: string, epoch: number, seq: number, approvalId: number): void {
    const res = this.db
      .prepare(
        `UPDATE steps SET status='pending', approval_id=?, finished_at=NULL
         WHERE task_id=? AND seq=? AND run_epoch=?`,
      )
      .run(approvalId, taskId, seq, epoch);
    if (res.changes === 0) {
      this.deps.record('stale_writer', 'normal', JSON.stringify({ taskId, epoch, seq, what: 'markPending' }));
    }
  }

  // ── 写入：LLM 步（无外部副作用，只有钱）────────────────────────────

  /**
   * beginLlm（契约 J1 缺口裁定）：返回 {seq, callId}；steps.call_id 对 llm 步同样填写
   * （uq_steps_call 已覆盖）。主循环 LLM 调用的 attemptId = 该 callId。
   * 存 prompt hash 不存全文（体积；CP §5.2）。
   */
  beginLlm(taskId: string, epoch: number, promptDigest: string): { seq: number; callId: string } {
    const callId = newCallId();
    const seq = this.nextSeq(taskId);
    this.db
      .prepare(
        `INSERT INTO steps(task_id, seq, kind, status, call_id, tool_name, args_json,
                           result_json, side_effect, run_epoch, approval_id,
                           started_at, finished_at)
         VALUES(?,?,'llm','started',?,NULL,?,NULL,'safe',?,NULL,?,NULL)`,
      )
      .run(taskId, seq, callId, promptDigest, epoch, Date.now());
    return { seq, callId };
  }

  /** endLlm：UPDATE（结果截断）。started 孤儿 → 标 interrupted、不重放（省钱）。 */
  endLlm(taskId: string, epoch: number, seq: number, respDigest: string): void {
    const res = this.db
      .prepare(
        `UPDATE steps SET status='succeeded', result_json=?, finished_at=?
         WHERE task_id=? AND seq=? AND run_epoch=?`,
      )
      .run(respDigest, Date.now(), taskId, seq, epoch);
    if (res.changes === 0) {
      this.deps.record('stale_writer', 'normal', JSON.stringify({ taskId, epoch, seq, what: 'endLlm' }));
      this.deps.bus.publish('stale_writer', { taskId, epoch, seq, what: 'endLlm' });
    }
  }

  /**
   * 契约 J3 / CP §7.4「审批续跑」：审批放行后 Runner 领到任务（新 epoch），把该
   * pending 步转 started，**复用原 call_id**（契约 J1-2：pending 步从未派发过 exec、
   * ledger 无记录，无幂等冲突；重派换新 call_id 只适用于已派发过的孤儿步）。
   * `argsJson` = 治理 final_params_json（CP §7.4「以治理 final_params_json 执行」）。
   *
   * 围栏语义（注意与 endTool 的区别）：本步是**上一代 epoch** 写的 pending 行
   * （markPending 用的是当时的 epoch），而 Runner 此时持有 pop 给的新 epoch。
   * 因此这里按 `(task_id, seq)` 定位 + `status='pending'` 作条件，并把 run_epoch
   * 改写成新 epoch（后续 endTool 的围栏才能匹配）；这不是"无围栏写入"——
   * 条件是 status='pending'，只有从未派发过的审批等待步能被续跑，
   * started/succeeded/interrupted 一律 0 行 → 记 stale_writer。
   */
  resumeStep(taskId: string, epoch: number, seq: number, argsJson?: string): { callId: string } {
    const res = this.db
      .prepare(
        `UPDATE steps SET status='started', args_json=COALESCE(?, args_json),
                         run_epoch=?, finished_at=NULL, started_at=?
         WHERE task_id=? AND seq=? AND status='pending'`,
      )
      .run(argsJson ?? null, epoch, Date.now(), taskId, seq);
    if (res.changes === 0) {
      this.deps.record(
        'stale_writer',
        'normal',
        JSON.stringify({ taskId, epoch, seq, what: 'resumeStep' }),
      );
      this.deps.bus.publish('stale_writer', { taskId, epoch, seq, what: 'resumeStep' });
    }
    const row = this.db
      .prepare('SELECT call_id AS c FROM steps WHERE task_id=? AND seq=?')
      .get(taskId, seq) as { c: string | null } | undefined;
    return { callId: row?.c ?? '' };
  }

  /**
   * 契约 J3 新增：承接 GOV §8.2「deny/ok=false 由控制面把步标 skipped」的义务。
   * 按 call_id 定位（跨模块步引用一律 call_id，不外泄 (task_id,seq)）。
   */
  skipStep(callId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE steps SET status='skipped', result_json=?, finished_at=?
         WHERE call_id=? AND status IN ('pending','started')`,
      )
      .run(reason, Date.now(), callId);
  }

  // ── 读路径 ─────────────────────────────────────────────────────────

  /** 契约 J1/CP §5.5：治理/执行面按 call_id 反查步。 */
  getStepByCallId(callId: string): Step | null {
    const row = this.db.prepare('SELECT * FROM steps WHERE call_id=?').get(callId) as
      | StepRow
      | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** 治理重入核对用（GOV §8.2 journal.stepExists）。 */
  stepExists(callId: string): boolean {
    return this.getStepByCallId(callId) !== null;
  }

  /** CP §8 tail：末尾 n 步（默认 20；§7.3 重建顺序第 3 步用）。 */
  tail(taskId: string, n = 20): Step[] {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE task_id=? ORDER BY seq DESC LIMIT ?')
      .all(taskId, n) as unknown as StepRow[];
    return rows.reverse().map(toStep);
  }

  /** 恢复上下文提示（§7.3 第 4 步 / §5.3 injectRecoveryNote 的读取侧）。 */
  openStepNotes(taskId: string): Step[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM steps WHERE task_id=? AND status='interrupted'
         ORDER BY seq DESC LIMIT 5`,
      )
      .all(taskId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  /** merge 注记读取（§6.2：Runner 下一步决策前 SELECT 最新 note 注入）。 */
  pendingNotes(taskId: string): Step[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM steps WHERE task_id=? AND kind='tool' AND tool_name='system.note'
         ORDER BY seq DESC LIMIT 5`,
      )
      .all(taskId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  // ── 崩溃恢复对账（CP §5.3 核心）────────────────────────────────────

  /**
   * resolveOpenStep：对每条孤儿 started 步的统一处置函数。
   * daemon 重启（§7.1 步骤 3）、Runner abort 后重领（§7.4）都走它。
   *
   * 返回：
   * - 'replayed'    ：llm 或 safe/replayable → 标 interrupted，Runner 重放；
   * - 'took_result' ：exec 确认 done → 补记结果，不重放也不白花；
   * - 'deferred'    ：unknown 副作用（含 exec 报 'aborted' 的情形）→ 标 interrupted +
   *                   注入提示 +（treatUnknownAsRisk）转审批。**绝不返回 replayed**，
   *                   这是「绝不重复执行」的最后一道闸（见下方 'aborted' 分支注释）。
   */
  async reconcileAndResolve(
    taskId: string,
    seq: number,
  ): Promise<'replayed' | 'deferred' | 'took_result'> {
    const s = this.getStep(taskId, seq);
    if (s === null) return 'deferred';
    if (s.status !== 'started') return 'deferred';

    if (s.kind === 'llm') {
      this.markInterrupted(taskId, seq);
      return 'replayed'; // 不重放 LLM，从自然下一步续（省钱）
    }

    if (s.side_effect === 'safe' || s.side_effect === 'replayable') {
      this.markInterrupted(taskId, seq);
      return 'replayed'; // Runner 重放：重读页面/文件再决策
    }

    // unknown：先向执行面对账该 call_id 的真实结局（issue #6）
    const outcome = await this.reconcileOutcome(s);
    if (outcome === 'done') {
      const r = s.call_id !== null ? await this.callResultOrNull(s.call_id) : null;
      this.finalizeStepAsSucceeded(taskId, seq, r?.resultJson ?? null);
      return 'took_result'; // 补记，不重放
    }
    // unknown / unknown_host：无法判定，宁可让 agent 重观测
    this.markInterrupted(taskId, seq);
    this.injectRecoveryNote(taskId, seq, s);
    // 'aborted' 与 unknown 同路（2026-10-17 修，重复执行风险）：
    // 执行面的 'aborted' 并不是"保证未落地"——daemon.ts:485-490 把 ExecService 的
    // 'interrupted' 全部映射成 'aborted'，而 fleet.ts:843-862/895-897/930-932 里
    // 'interrupted' 有三个来源（container_lost / aborted / not_found），其中
    // container_lost 恰恰发生在「容器被 pause 或丢失、真实结局不明」时。
    // 尤其 guard 在 throttled/halted 会 pause 容器（guard.ts:224-244）→ 容器状态
    // suspended → canAcceptCalls=false（exec/types.ts:71-73）→ 之后任何对账都报
    // interrupted → 已执行过的 rm/net.post 会被判为可安全重放。
    // 因此只有 side_effect ∈ {safe,replayable} 才走上面的直接重放分支（:299-302）；
    // 走到这里的必然是 'unknown'，一律转审批，绝不重放。
    if (this.deps.treatUnknownAsRisk !== false && this.deps.governance !== undefined) {
      await this.requestUnknownSideEffectApproval(taskId, seq, s, outcome);
    }
    return 'deferred';
  }

  /**
   * 造 unknown 副作用孤儿步的审批单并回写 approval_id（幂等：同一 callId 因
   * uniq_open_step / subject_key='unk:'+callId 命中同一单）。
   * 治理不可用/抛错时降级为"只注入提示"（不炸恢复流程），但记 watchdog。
   */
  private async requestUnknownSideEffectApproval(
    taskId: string,
    seq: number,
    s: StepRow,
    outcome: 'aborted' | 'unknown' | 'unknown_host',
  ): Promise<void> {
    const governance = this.deps.governance;
    if (governance === undefined) return;
    try {
      const ap = await governance.requestApproval({
        taskId,
        kind: 'side_effect_unknown',
        subject: {
          journalStep: s.call_id ?? '',
          tool: s.tool_name ?? '',
          params: s.args_json ?? '',
        },
        reason: `孤儿步 ${taskId}#${seq} 副作用未知（exec=${outcome}），需主人确认`,
      });
      this.db
        .prepare('UPDATE steps SET approval_id=? WHERE task_id=? AND seq=?')
        .run(ap.approvalId, taskId, seq);
    } catch (err) {
      // 恢复流程不得因治理侧故障整体失败（一条任务失败不阻其余任务恢复）
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({
          taskId,
          seq,
          what: 'recovery_approval_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /** 执行面对账（异常降级为 unknown_host：对账本身失败 ≠ 确认未落地）。 */
  private async reconcileOutcome(s: StepRow): Promise<'done' | 'aborted' | 'unknown' | 'unknown_host'> {
    if (s.call_id === null || this.deps.exec === undefined) return 'unknown_host';
    try {
      return await this.deps.exec.reconcileCall(s.call_id);
    } catch (err) {
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({
          callId: s.call_id,
          what: 'reconcile_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return 'unknown_host';
    }
  }

  /** 取执行面结果（异常降级为 null：取不到结果不影响"不重放"决策）。 */
  private async callResultOrNull(callId: string): Promise<{ resultJson: string } | null> {
    if (this.deps.exec === undefined) return null;
    try {
      return await this.deps.exec.getCallResult(callId);
    } catch (err) {
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({
          callId,
          what: 'getCallResult_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  }

  /**
   * 执行面回报 `exec.call.interrupted(callId)` 的驱动入口（CP §7.4 / 契约 §8-⑫）：
   * 定位该 call 的 started 步走同一 reconcileAndResolve。'replayed' 时 Runner 原地继续
   * （任务不外抛 queued）；'deferred' 走 awaiting_approval。
   */
  async onExecInterrupted(callId: string): Promise<{
    taskId: string;
    seq: number;
    outcome: 'replayed' | 'deferred' | 'took_result';
  } | null> {
    const s = this.getStepByCallId(callId);
    if (s === null || s.status !== 'started') return null;
    const outcome = await this.reconcileAndResolve(s.taskId, s.seq);
    return { taskId: s.taskId, seq: s.seq, outcome };
  }

  // ── 内部原语 ───────────────────────────────────────────────────────

  private getStep(taskId: string, seq: number): StepRow | null {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE task_id=? AND seq=?')
      .get(taskId, seq) as StepRow | undefined;
    return row ?? null;
  }

  /** 孤儿步转 interrupted（不删；审计闭环）。 */
  private markInterrupted(taskId: string, seq: number): void {
    this.db
      .prepare(
        `UPDATE steps SET status='interrupted', finished_at=?
         WHERE task_id=? AND seq=? AND status='started'`,
      )
      .run(Date.now(), taskId, seq);
  }

  /** exec 确认 done → 补记 succeeded（不重放也不白花）。 */
  private finalizeStepAsSucceeded(taskId: string, seq: number, resultJson: string | null): void {
    this.db
      .prepare(
        `UPDATE steps SET status='succeeded', result_json=?, finished_at=?
         WHERE task_id=? AND seq=? AND status='started'`,
      )
      .run(resultJson, Date.now(), taskId, seq);
  }

  /**
   * injectRecoveryNote（CP §5.3）：下一步 messages 首条注入的提示文本。
   * 「你上一步 {tool}({args摘要}, callId={callId}) 因中断结果未知，先做观测确认再决定；
   *   不可确认且不可逆则已转审批。」
   * 落点 = steps 表内一条 kind='tool', tool_name='system.note' 的 succeeded 步
   * （§6.2 已定义该形态承载 merge 注记；恢复提示同路，读取侧见 pendingNotes/openStepNotes）。
   */
  private injectRecoveryNote(taskId: string, seq: number, s: StepRow): void {
    const text =
      `你上一步 ${s.tool_name ?? s.kind}(${this.brief(s.args_json)}, callId=${s.call_id ?? ''})` +
      ` 因中断结果未知，先做观测确认再决定；不可确认且不可逆则已转审批。`;
    this.db
      .prepare(
        `INSERT INTO steps(task_id, seq, kind, status, call_id, tool_name, args_json,
                           result_json, side_effect, run_epoch, approval_id,
                           started_at, finished_at)
         VALUES(?,?,'tool','succeeded',NULL,'system.note',?,?,NULL,?,NULL,?,?)`,
      )
      .run(
        taskId,
        this.nextSeq(taskId),
        JSON.stringify({ noteFor: seq }),
        text,
        s.run_epoch,
        Date.now(),
        Date.now(),
      );
  }

  private brief(argsJson: string | null): string {
    if (argsJson === null) return '';
    return argsJson.length > 200 ? `${argsJson.slice(0, 200)}…` : argsJson;
  }

  /**
   * 下一步序号 + CP §5.4 步数上限执行（本模块持有 cfg.stepSoftLimit/stepHardLimit，
   * 旧稿只声明不消费 = 死配置，审码 finding：已补执行）。
   * - 硬上限（默认 2000）：抛 StepLimitError，调用方（Runner 主循环）走
   *   failed(stop_reason='budget') 收口，不经 attempt 重试（CP §5.4 逐字）。
   * - 软上限（默认 500）：首次越线记 resource_events(kind='watchdog', warning)，
   *   不阻断（仅提醒，防日志轰炸）。每任务只警告一次（重启后重新计）。
   */
  private nextSeq(taskId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM steps WHERE task_id=?')
      .get(taskId) as { n: number };
    const next = row.n;
    if (next > this.cfg.stepHardLimit) {
      throw new StepLimitError(taskId, next, this.cfg.stepHardLimit);
    }
    if (next >= this.cfg.stepSoftLimit && !this.softWarned.has(taskId)) {
      this.softWarned.add(taskId);
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({
          taskId,
          warning: 'step_soft_limit',
          steps: next,
          softLimit: this.cfg.stepSoftLimit,
        }),
      );
    }
    return next;
  }

  /**
   * CP §5.4 大小控制：args/result >32KB 时写 blob 文件、列里只存引用串
   * `@blob:journal-blobs/<task_id>.<seq>.json`。
   */
  private truncate(taskId: string, value: unknown, seq?: number): string {
    let json: string;
    try {
      json = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      json = JSON.stringify({ __unserializable: String(value) });
    }
    if (json === undefined || json.length <= this.cfg.journalBlobMaxBytes) return json;
    const s = seq ?? this.nextSeq(taskId);
    return writeJournalBlob(this.cfg.blobDir, taskId, s, json);
  }
}
