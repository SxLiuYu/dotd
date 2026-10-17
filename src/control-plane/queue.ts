/**
 * src/control-plane/queue.ts —— SQLite 持久化任务队列（CP §4）。
 *
 * 铁律（CP §4.1 三条硬门控）：
 * 1. **进 running 只经 pop()**，pop 内强制背压 ∈ {normal,guarded} 且
 *    runningCount(dot)<maxRunningTasks 且 run_epoch+=1。因此审批放行
 *    `awaiting_approval →(ok)→ queued`（不是直转 running）——maxRunningTasks=1 时
 *    不可能出现两个并发 Runner。
 * 2. `paused / awaiting_approval` 是可再入态，不占 runningCount。
 * 3. `resolveOpenStep` 只处理 status='started' 的孤儿步；pending 步不算孤儿
 *    （数据上 started=执行中被打断，pending=正常等待）。
 *
 * 围栏（CP §2.2）：每次把任务从可领态转入 running，`tasks.run_epoch += 1`，
 * pop 返回的 Task 快照带此 epoch。Runner 所有回写必带 epoch；每条 UPDATE 都
 * `WHERE task_id=? AND run_epoch=?`，受影响行数 0 → 迟到/僵尸 Runner，
 * 写 resource_events(kind='stale_writer') 并拒绝。
 *
 * 实现说明（node:sqlite，CONVENTIONS.md §2）：DatabaseSync 是**同步** API，
 * 没有 db.transaction() 包装器，也没有 async 变体——本文件的事务用 types.ts:tx
 * 补出（BEGIN IMMEDIATE … COMMIT / ROLLBACK），CP §4.2 的伪码由此逐条落地。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SideEffect, Step, Task, TaskStatus } from '../shared/contracts.ts';
import type {
  ControlPlaneConfig,
  ResourceEventKind,
  ResourceEventLevel,
  StepRow,
  TaskRow,
} from './types.ts';
import { isTerminal, TASK_TRANSITIONS, toStep, toTask, tx } from './types.ts';
import { eventTaskId, newTaskId } from '../shared/ids.ts';
import { DotdError } from '../shared/errors.ts';

/** 队列依赖（scheduler/daemon 注入；bus 与 guard 由 index.ts 组装时接上）。 */
export interface QueueDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  /** 事件总线（stale_writer / task.state / task.budget_exhausted 发布）。 */
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  /** 内存水位（pop 门控：CP §4.2 `if (guard.level === 'throttled' || 'halted') return null`）。 */
  guardLevel(): 'normal' | 'guarded' | 'throttled' | 'halted';
  /** 记录 resource_events 行（CP §3.1.4；guard/recovery/evict 共用）。 */
  record(kind: ResourceEventKind, level: ResourceEventLevel, detail: string): void;
  /** 记忆模块 sealTask 钩子（契约 M3：所有终态收口必须调；未注入时跳过）。 */
  sealTask?: (
    task: Task,
    outcome: 'done' | 'failed' | 'cancelled',
    reason?: string,
  ) => Promise<void>;
}

/** CP §4.1 非法转移错误（队列类错误；与 stale_writer 的围栏拒绝区分）。 */
export class IllegalTransitionError extends DotdError {
  readonly taskId: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(`任务 ${taskId} 非法状态转移 ${from} → ${to}`, 'ILLEGAL_TRANSITION');
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/** CP §8 submit 请求（跨模块签名在 contracts.ts:SubmitReq；这里加内部语义）。 */
export interface SubmitInput {
  title: string;
  goal: string;
  priority?: number;
  runAt?: number;
  dotId?: string;
  /** 契约 E1：弱引用 events.id（NULL=主人手动提交，永不入淘汰候选）。 */
  sourceEventId?: number;
  threadId?: string;
  payloadJson?: string;
}

export class Queue {
  private readonly db: DatabaseSync;
  private readonly cfg: ControlPlaneConfig;
  private readonly deps: QueueDeps;

  constructor(deps: QueueDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.cfg = deps.cfg;
  }

  // ── 行读取 ─────────────────────────────────────────────────────────

  private getRow(taskId: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as
      | TaskRow
      | undefined;
    return row ?? null;
  }

  /** CP §8 getTask。 */
  getTask(taskId: string): Task | null {
    const row = this.getRow(taskId);
    return row === null ? null : toTask(row);
  }

  /** CP §8 list。 */
  list(q: { status?: TaskStatus[]; dotId?: string; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status !== undefined && q.status.length > 0) {
      where.push(`status IN (${q.status.map(() => '?').join(',')})`);
      args.push(...q.status);
    }
    if (q.dotId !== undefined) {
      where.push('dot_id=?');
      args.push(q.dotId);
    }
    const limit = q.limit ?? 200;
    const sql = `SELECT * FROM tasks${
      where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY created_at ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** CP §8 getJournal：按 seq 升序返回全部步。 */
  getJournal(taskId: string): Step[] {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE task_id=? ORDER BY seq ASC')
      .all(taskId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  // ── 围栏写入原语（CP §2.2）──────────────────────────────────────────

  /**
   * 带 epoch 围栏的条件 UPDATE：SET 子句占位符由 params 提供，尾接
   * `WHERE id=? AND run_epoch=?`。受影响行数 0 → 迟到/僵尸 Runner：记
   * resource_events(kind='stale_writer') 并发总线，返回 false 让调用方拒绝。
   */
  private fenceUpdate(
    taskId: string,
    epoch: number,
    setSql: string,
    params: (string | number | null)[],
    what: string,
  ): boolean {
    const res = this.db
      .prepare(`UPDATE tasks SET ${setSql} WHERE id=? AND run_epoch=?`)
      .run(...(params as (string | number)[]), taskId, epoch);
    const ok = res.changes === 1;
    if (!ok) {
      this.deps.record('stale_writer', 'normal', JSON.stringify({ taskId, epoch, what }));
      this.deps.bus.publish('stale_writer', { taskId, epoch, what });
    }
    return ok;
  }

  /** 取当前 epoch（recovery/journal 内部用）。 */
  currentEpoch(taskId: string): number | null {
    const row = this.db.prepare('SELECT run_epoch AS e FROM tasks WHERE id=?').get(taskId) as
      | { e: number }
      | undefined;
    return row?.e ?? null;
  }

  // ── 状态机（CP §4.1）────────────────────────────────────────────────

  /**
   * 合法转移硬校验：非法 → 抛 IllegalTransitionError（CP §4.1「非法转移在
   * transition() 硬校验，throw」）。转移本身不改 run_epoch（围栏只由 pop 递增）。
   */
  transition(taskId: string, to: TaskStatus): Task {
    const row = this.getRow(taskId);
    if (row === null) throw new DotdError(`任务不存在：${taskId}`, 'TASK_NOT_FOUND');
    const allowed = TASK_TRANSITIONS[row.status];
    if (!allowed.includes(to)) throw new IllegalTransitionError(taskId, row.status, to);
    const res = this.db
      .prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status=?')
      .run(to, Date.now(), taskId, row.status);
    if (res.changes === 0) throw new IllegalTransitionError(taskId, row.status, to);
    const out = this.getTask(taskId)!;
    this.deps.bus.publish('task.state', {
      taskId,
      from: row.status,
      to,
      epoch: out.runEpoch,
    });
    return out;
  }

  // ── submit / pop（CP §4.2）──────────────────────────────────────────

  /**
   * CP §8 submit。幂等由调用方保证：匹配层的「建任务+写 event_decisions」在同一
   * BEGIN IMMEDIATE 事务里（match.ts:decideAndCreate），且 task 主键由
   * `deterministicTaskId(event_log.id)` 派生（ids.ts:eventTaskId），崩溃重放撞
   * tasks.id PK → 回滚，绝不双建（CP §6.1/§7.2）。
   */
  submit(input: SubmitInput): Task {
    const now = Date.now();
    const id = input.sourceEventId !== undefined ? eventTaskId(input.sourceEventId) : newTaskId();
    this.db
      .prepare(
        `INSERT INTO tasks(id, dot_id, title, goal, payload_json, status, priority, run_at,
                           source_event_id, session_id, thread_id, attempt, max_attempts,
                           run_epoch, last_heartbeat_at, resume_from_seq, stop_reason,
                           budget_tokens, usage_tokens, budget_exhausted,
                           created_at, updated_at)
         VALUES(?,?,?,?,?,'queued',?,?,?,?,?,0,3,0,NULL,NULL,NULL,?,0,0,?,?)`,
      )
      .run(
        id,
        input.dotId ?? 'dot1',
        input.title,
        input.goal,
        input.payloadJson ?? null,
        input.priority ?? 5,
        input.runAt ?? null,
        input.sourceEventId ?? null,
        null,
        input.threadId ?? null,
        this.cfg.budgetTokensDefault,
        now,
        now,
      );
    const out = this.getTask(id)!;
    this.deps.bus.publish('task.state', { taskId: id, from: null, to: 'queued', epoch: 0 });
    return out;
  }

  /**
   * CP §4.2 pop：单写者事务 + 围栏递增。逐条对应伪码：
   * - `if (guard.level === 'throttled' || 'halted') return null` —— 停 pop；
   * - `if (runningCount(dotId) >= cfg.maxRunningTasks) return null`；
   * - ORDER BY priority ASC, COALESCE(run_at, created_at) ASC,
   *   resume_from_seq IS NOT NULL DESC（审批放行的续跑任务优先于新任务）；
   * - UPDATE ... SET status='running', run_epoch=run_epoch+1, last_heartbeat_at=?,
   *   updated_at=? WHERE id=? AND status='queued'（条件 UPDATE 防并发双领）；
   * - 返回含新 run_epoch 的快照，交 Runner 当围栏凭据。
   */
  pop(dotId?: string): Task | null {
    const dot = dotId ?? 'dot1';
    const level = this.deps.guardLevel();
    if (level === 'throttled' || level === 'halted') return null;
    return tx(this.db, () => {
      if (this.runningCount(dot) >= this.cfg.maxRunningTasks) return null;
      const now = Date.now();
      const row = this.db
        .prepare(
          `SELECT id FROM tasks
           WHERE dot_id=? AND status='queued' AND (run_at IS NULL OR run_at<=?)
           ORDER BY priority ASC,
                    COALESCE(run_at, created_at) ASC,
                    resume_from_seq IS NOT NULL DESC
           LIMIT 1`,
        )
        .get(dot, now) as { id: string } | undefined;
      if (row === undefined) return null;
      const res = this.db
        .prepare(
          `UPDATE tasks SET status='running', run_epoch=run_epoch+1,
                  last_heartbeat_at=?, updated_at=?
           WHERE id=? AND status='queued'`,
        )
        .run(now, now, row.id);
      if (res.changes === 0) return null;
      const out = this.getTask(row.id)!;
      this.deps.bus.publish('task.state', {
        taskId: row.id,
        from: 'queued',
        to: 'running',
        epoch: out.runEpoch,
      });
      return out;
    });
  }

  /** runningCount（CP §4.2 门控）：只数 running——paused/awaiting_approval 不占额度。 */
  runningCount(dotId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE dot_id=? AND status='running'`)
      .get(dotId) as { n: number };
    return row.n;
  }

  /**
   * CP §8 heartbeat：围栏 + 预算返回位（CP §2.2/§6.4）。
   *
   * `live`（P0-3 在途心跳）与步尾心跳的**唯一区别**在于副作用约束：
   *  - 步尾心跳带 `usage.tokens`，并且会（首次越线时）置 `budget_exhausted`、发
   *    `task.budget_exhausted` 事件——这些是"这一轮真的烧了 token"的记账，**每轮只该发生一次**；
   *  - 在途心跳只是"容器还活着、工具确实在推进"的证据，**不带 token**，若走同一路径会
   *    变成 500ms 一次的空心跳，进而让 nextSeq 的预算判据/事件流被噪声污染：
   *    每次都被判 overBudget → 每次注册 `budget_exhausted` 事件。
   * 因此 `live` 只做两件事：围栏校验 + 刷新 `last_heartbeat_at`。
   * 围栏语义完全一致（epoch 不符/任务已非 running → `aborted:true`）。
   *
   * `skipBudget`（联调/测试用）：只刷新心跳，不读不写预算位。装配层不使用。
   */
  heartbeat(
    taskId: string,
    epoch: number,
    usage?: { tokens: number },
    opts: { live?: { at?: number }; skipBudget?: boolean } = {},
  ): { overBudget: boolean; aborted: boolean } {
    const row = this.getRow(taskId);
    if (row === null) return { overBudget: false, aborted: false };
    const now = opts.live !== undefined ? (opts.live.at ?? Date.now()) : Date.now();
    const usageTokens = row.usage_tokens + (usage?.tokens ?? 0);
    if (opts.live !== undefined) {
      // 在途心跳：只续时刻，不动 usage/预算位（见方法注释）
      const alive = this.fenceUpdate(
        taskId,
        epoch,
        'last_heartbeat_at=?, updated_at=?',
        [now, now],
        'heartbeat',
      );
      return { overBudget: false, aborted: !alive };
    }
    const ok = this.fenceUpdate(
      taskId,
      epoch,
      'usage_tokens=?, last_heartbeat_at=?, updated_at=?',
      [usageTokens, now, now],
      'heartbeat',
    );
    // 围栏拒绝 = 看门狗/背压已 abort（CP §2.2），Runner 必须让位。
    if (!ok) return { overBudget: false, aborted: true };
    if (opts.skipBudget === true) return { overBudget: false, aborted: false };
    const overBudget = usageTokens >= row.budget_tokens;
    if (overBudget && row.budget_exhausted === 0) {
      this.db
        .prepare('UPDATE tasks SET budget_exhausted=1 WHERE id=? AND run_epoch=?')
        .run(taskId, epoch);
      this.deps.bus.publish('task.budget_exhausted', {
        taskId,
        epoch,
        usageTokens,
        budget: row.budget_tokens,
      });
    }
    // 行已被 abort/看门狗转到别的状态（同 epoch 内可能发生）：告知 Runner 别再写。
    const stillRunning = this.getRow(taskId)?.status === 'running';
    return { overBudget, aborted: !stillRunning };
  }

  /**
   * CP §8 finish：带 epoch 的终态收口。
   * - ok → done；
   * - err 且 attempt<max → queued(attempt+1, run_at=now+backoff)；
   * - err 且 attempt≥max → failed。
   * 契约 M3：done/failed 收口都必须调 memory.sealTask。
   *
   * 迟到拒止（CP §7.4「abort 后旧协程任何迟到 heartbeat/endTool/finish → epoch 围栏拒绝」）：
   * reclaimInFlight/watchdog 回收时 run_epoch **保持**（CP §7.1 步骤 3），单靠 epoch
   * 围栏拦不住同 epoch 的迟到写——因此这里补 status 前置条件：只有仍是 'running' 的
   * 行才允许收口，否则记 stale_writer 并整体拒绝。
   */
  finish(taskId: string, epoch: number, r: { ok: boolean; summary: string }): void {
    const row = this.getRow(taskId);
    if (row === null) return;
    if (row.status !== 'running') {
      // 已被回收/看门狗/背压改道（epoch 保持 → 靠 status 判迟到）
      this.deps.record(
        'stale_writer',
        'normal',
        JSON.stringify({ taskId, epoch, status: row.status, what: 'finish' }),
      );
      this.deps.bus.publish('stale_writer', { taskId, epoch, what: 'finish' });
      return;
    }
    const now = Date.now();
    if (r.ok) {
      const ok = this.fenceUpdate(
        taskId,
        epoch,
        "status='done', stop_reason=NULL, updated_at=?",
        [now],
        'finish',
      );
      if (ok) {
        // 状态已落库之后的一切都是「附带动作」，失败不得抛给调用方：
        // 抛出去会让 Runner 走 onFatal → 再 finish 一次 → 因 status≠running 记 stale_writer，
        // 用户看到的是「任务 done 但 task_results 读不到」+ 一条莫名的 stale_writer。
        // 权威 = tasks.status；结果行可后补（queue.gc/诊断），故这里只记账不抛。
        this.writeResultSafely(taskId, r.summary, true, epoch);
        this.seal(taskId, 'done', r.summary);
        this.deps.bus.publish('task.state', { taskId, from: 'running', to: 'done', epoch });
      }
      return;
    }
    const nextAttempt = row.attempt + 1;
    if (nextAttempt < row.max_attempts) {
      const backoff = Math.min(2 ** nextAttempt * 1_000, 60_000);
      const ok = this.fenceUpdate(
        taskId,
        epoch,
        "status='queued', attempt=?, run_at=?, updated_at=?",
        [nextAttempt, now + backoff, now],
        'finish',
      );
      if (ok) {
        this.deps.bus.publish('task.state', {
          taskId,
          from: 'running',
          to: 'queued',
          epoch,
          attempt: nextAttempt,
        });
      }
      return;
    }
    const ok = this.fenceUpdate(
      taskId,
      epoch,
      "status='failed', updated_at=?",
      [now],
      'finish',
    );
    if (ok) {
      this.writeResultSafely(taskId, r.summary, false, epoch);
      this.seal(taskId, 'failed', r.summary);
      this.deps.bus.publish('task.state', { taskId, from: 'running', to: 'failed', epoch });
    }
  }

  /** CP §8 cancel（主人/guard/watchdog 三来源）。 */
  cancel(taskId: string, by: 'user' | 'guard' | 'watchdog'): void {
    const row = this.getRow(taskId);
    if (row === null || isTerminal(row.status)) return;
    this.db
      .prepare(`UPDATE tasks SET status='cancelled', stop_reason=?, updated_at=? WHERE id=?`)
      .run(by === 'user' ? 'user' : 'tool_risk', Date.now(), taskId);
    this.deps.bus.publish('task.state', { taskId, from: row.status, to: 'cancelled', by });
    this.seal(taskId, 'cancelled', by);
  }

  /** CP §8 resume：主人手动 resume paused → queued（保 priority）。 */
  resume(taskId: string): void {
    const row = this.getRow(taskId);
    if (row === null || row.status !== 'paused') return;
    this.db
      .prepare(
        `UPDATE tasks SET status='queued', stop_reason=NULL, run_at=NULL, updated_at=? WHERE id=?`,
      )
      .run(Date.now(), taskId);
    this.deps.bus.publish('task.state', {
      taskId,
      from: 'paused',
      to: 'queued',
      epoch: row.run_epoch,
    });
  }

  /**
   * CP §8 pauseByReason（模型路由/执行面可调用，补旧稿缺失）。
   * 契约 T1：熔断耗尽 → paused(stop_reason='circuit_open')，不加 waiting_model 态；
   * 恢复由订阅 router.mode_changed 后批量回 queued（见 index.ts:resumeCircuitOpenTasks）。
   */
  pauseByReason(
    taskId: string,
    reason: 'circuit_open' | 'watermark' | 'budget' | 'tool_risk',
  ): void {
    const row = this.getRow(taskId);
    if (row === null || isTerminal(row.status)) return;
    if (row.status !== 'running' && row.status !== 'queued') return;
    this.db
      .prepare(`UPDATE tasks SET status='paused', stop_reason=?, updated_at=? WHERE id=?`)
      .run(reason, Date.now(), taskId);
    this.deps.bus.publish('task.state', {
      taskId,
      from: row.status,
      to: 'paused',
      stopReason: reason,
    });
  }

  /** CP §8 pauseDotQueue/resumeDotQueue（契约 G3：per-dot quarantine）。 */
  pauseDotQueue(dotId: string): void {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='paused', stop_reason='tool_risk', updated_at=?
         WHERE dot_id=? AND status IN ('queued','running')`,
      )
      .run(Date.now(), dotId);
    if (res.changes > 0) {
      this.deps.record('watchdog', 'normal', JSON.stringify({ dotId, paused: res.changes }));
      this.deps.bus.publish('task.state', { dotId, to: 'paused', stopReason: 'tool_risk' });
    }
  }

  resumeDotQueue(dotId: string): void {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='queued', stop_reason=NULL, updated_at=?
         WHERE dot_id=? AND status='paused' AND stop_reason='tool_risk'`,
      )
      .run(Date.now(), dotId);
    if (res.changes > 0) {
      this.deps.bus.publish('task.state', { dotId, to: 'queued', resumed: res.changes });
    }
  }

  /**
   * CP §8-S8 / 契约 T1：路由熔断恢复后把 `paused(stop_reason='circuit_open')`
   * 的任务批量回 queued（不转 running——CP §4.1 门控 1：重新排入队首等 pop 拿围栏）。
   * 由 index.ts 订阅 `router.mode_changed`（to 回到可用态）时调用。
   * 返回恢复的任务数。
   */
  resumeCircuitOpenTasks(): number {
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='queued', stop_reason=NULL, run_at=NULL, updated_at=?
         WHERE status='paused' AND stop_reason='circuit_open'`,
      )
      .run(Date.now());
    if (res.changes > 0) {
      this.deps.bus.publish('task.state', { to: 'queued', resumed: res.changes, reason: 'circuit_open_recovered' });
      this.deps.record('watchdog', 'normal', JSON.stringify({ circuitOpenRecovered: res.changes }));
    }
    return Number(res.changes);
  }

  // ── 会话绑定（契约 M2：唯一回写通道，禁止 Runner 直接 UPDATE tasks）──────

  /** CP §8 bindSession：Runner 首步回写 tasks 独有列（issue #8）。带 epoch 围栏。 */
  bindSession(taskId: string, epoch: number, ids: { sessionId: string; threadId: string }): void {
    // 契约 M1：thread ≡ session，两列同值。
    this.fenceUpdate(
      taskId,
      epoch,
      'session_id=?, thread_id=?, updated_at=?',
      [ids.threadId, ids.threadId, Date.now()],
      'bindSession',
    );
  }

  // ── 审批联动（CP §7.4 审批续跑；契约 J6 钩子签名定案）─────────────────

  /**
   * CP §8 setAwaitingApproval：running → awaiting_approval。
   * 契约 J6 修正：实际调用方是 Runner（治理不持有 epoch）。
   */
  setAwaitingApproval(taskId: string, epoch: number, approvalId: number): void {
    const ok = this.fenceUpdate(
      taskId,
      epoch,
      "status='awaiting_approval', updated_at=?",
      [Date.now()],
      'setAwaitingApproval',
    );
    if (ok) {
      this.deps.bus.publish('task.state', {
        taskId,
        from: 'running',
        to: 'awaiting_approval',
        approvalId,
      });
    }
  }

  /**
   * CP §8 onApprovalSettled（治理 decide() 落定后调用；契约 J6 含 meta{note,revoke}）：
   * - ok → queued（resume_from_seq=该 pending 步 seq，priority=min(priority,2)），
   *   **不是直入 running**（CP §4.1 门控 1：重新排入队首等 pop 拿围栏）。
   * - deny/expired → 该 pending 步 skipped（契约 J3），任务回 queued 改道；
   *   Runner 领到后按 resume_from_seq 跳过该步继续。
   */
  onApprovalSettled(
    taskId: string,
    approvalId: number,
    ok: boolean,
    meta?: { note?: string; revoke?: string },
  ): void {
    const row = this.getRow(taskId);
    if (row === null) return;
    const now = Date.now();
    if (ok) {
      const pending = this.pendingStepByApproval(taskId, approvalId);
      const resumeFrom = pending?.seq ?? row.resume_from_seq;
      this.db
        .prepare(
          `UPDATE tasks SET status='queued', resume_from_seq=?, priority=?, stop_reason=NULL,
                  updated_at=? WHERE id=?`,
        )
        .run(resumeFrom ?? null, Math.min(row.priority, 2), now, taskId);
      this.deps.bus.publish('task.state', {
        taskId,
        from: 'awaiting_approval',
        to: 'queued',
        resumeFromSeq: resumeFrom ?? null,
        note: meta?.note,
      });
      return;
    }
    this.db
      .prepare(
        `UPDATE steps SET status='skipped', finished_at=?
         WHERE task_id=? AND approval_id=? AND status='pending'`,
      )
      .run(now, taskId, approvalId);
    this.db
      .prepare(
        `UPDATE tasks SET status='queued', resume_from_seq=?, stop_reason=NULL, updated_at=?
         WHERE id=?`,
      )
      .run(row.resume_from_seq, now, taskId);
    this.deps.bus.publish('task.state', {
      taskId,
      from: 'awaiting_approval',
      to: 'queued',
      skipped: true,
      revoke: meta?.revoke,
    });
  }

  /** 审批续跑定位：该 approvalId 对应的 pending 步（契约 J1-2：复用原 call_id）。 */
  pendingStepByApproval(taskId: string, approvalId: number): Step | null {
    const row = this.db
      .prepare(
        `SELECT * FROM steps WHERE task_id=? AND status='pending' AND approval_id=?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(taskId, approvalId) as Step | undefined;
    return row ?? null;
  }

  // ── 内部：结果落库 / sealTask 收口（契约 M3）─────────────────────────

  private writeResult(taskId: string, summary: string, ok: boolean): void {
    this.db
      .prepare(
        `INSERT INTO task_results(task_id, summary, ok) VALUES(?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET summary=excluded.summary, ok=excluded.ok`,
      )
      .run(taskId, summary, ok ? 1 : 0);
  }

  /**
   * 终态收口路径专用的 writeResult：**永不抛出**。
   *
   * 背景（审码 finding，静默失败）：finish()/markFailed() 都先 fenceUpdate 改状态、
   * 再 writeResult 写结果行。状态是权威，结果行是附属。若 writeResult 抛错（表被锁、
   * 磁盘满、schema 漂移），旧实现会把异常抛回调用方——Runner 的 onFatal 再 finish 一次，
   * 因 status≠running 记 stale_writer，于是用户看到「任务显示 done 但没有结果」
   * 外加一条误导性的 stale_writer。这里降级为记账，状态转移语义不受影响。
   */
  private writeResultSafely(taskId: string, summary: string, ok: boolean, epoch: number): void {
    try {
      this.writeResult(taskId, summary, ok);
    } catch (err) {
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({
          taskId,
          epoch,
          what: 'writeResult_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /**
   * 契约 M3（S2'）：控制面在 finish()（done 正常）、finish 失败路径（attempt≥max→failed）、
   * 看门狗 reclaim 判 failed、背压 kill、queue_evict 淘汰（cancelled）、优雅关停落账
   * ——每个终态收口点都必须调 memory.sealTask(task, outcome, stopReason)。
   * 未注入 sealTask（装配层未接线或测试未提供）时跳过——不阻塞队列语义。
   */
  private seal(taskId: string, outcome: 'done' | 'failed' | 'cancelled', reason: string): void {
    const hook = this.deps.sealTask;
    if (hook === undefined) return;
    const row = this.getRow(taskId);
    if (row === null) return;
    void Promise.resolve(hook(toTask(row), outcome, reason)).catch(() => {
      // sealTask 失败不得反过来炸掉队列收口（记忆模块自己记 violation）。
    });
  }

  /** 看门狗判 failed（CP §7.4 reclaimTask；契约 M3 收口）。 */
  markFailed(taskId: string, epoch: number, reason: string): void {
    const ok = this.fenceUpdate(
      taskId,
      epoch,
      "status='failed', updated_at=?",
      [Date.now()],
      'watchdog',
    );
    if (ok) {
      this.writeResultSafely(taskId, reason, false, epoch);
      this.seal(taskId, 'failed', reason);
      this.deps.bus.publish('task.state', { taskId, to: 'failed', epoch, reason });
    }
  }

  /** queue_evict 淘汰（CP §4.4：cancelled，stop_reason 不新增 evict 枚举）。 */
  cancelDirect(taskId: string, stopReason: 'user' | 'tool_risk' | 'watermark'): void {
    const row = this.getRow(taskId);
    if (row === null || isTerminal(row.status)) return;
    this.db
      .prepare(`UPDATE tasks SET status='cancelled', stop_reason=?, updated_at=? WHERE id=?`)
      .run(stopReason, Date.now(), taskId);
    this.deps.bus.publish('task.state', { taskId, from: row.status, to: 'cancelled', stopReason });
    this.seal(taskId, 'cancelled', stopReason);
  }

  // ── reclaim（CP §7.4 / §7.1 步骤 3）────────────────────────────────

  /**
   * 在途任务回收（recovery 步骤 3 / reclaimTask）：running → queued、attempt+1、
   * priority=min(priority,2)、last_heartbeat_at=NULL；run_epoch **保持**（下次 pop 再 +1）。
   * 带 epoch 围栏：旧 Runner 协程的迟到 heartbeat/endTool/finish 全部被拒（CP §2.2）。
   */
  reclaimInFlight(taskId: string, epoch: number, reason: string): boolean {
    const row = this.getRow(taskId);
    if (row === null || row.status !== 'running') return false;
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='queued', attempt=attempt+1, priority=MIN(priority,2),
                last_heartbeat_at=NULL, run_at=NULL, updated_at=?
         WHERE id=? AND run_epoch=? AND status='running'`,
      )
      .run(now, taskId, epoch);
    if (res.changes === 0) {
      this.deps.record('stale_writer', 'normal', JSON.stringify({ taskId, epoch, what: `reclaim:${reason}` }));
      return false;
    }
    this.deps.bus.publish('task.state', {
      taskId,
      from: 'running',
      to: 'queued',
      epoch,
      reason,
    });
    return true;
  }

  // ── 步读取原语（journal/recovery 共用；写路径只在 journal.ts）──────────

  /** 读一条步。 */
  getStep(taskId: string, seq: number): Step | null {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE task_id=? AND seq=?')
      .get(taskId, seq) as StepRow | undefined;
    return row === undefined ? null : toStep(row);
  }

  /** started 孤儿步：恢复扫描只认 started（CP §4.1 硬门控 3，pending 不算孤儿）。 */
  openStartedSteps(taskId: string): Step[] {
    const rows = this.db
      .prepare(`SELECT * FROM steps WHERE task_id=? AND status='started' ORDER BY seq ASC`)
      .all(taskId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  /** 当前最大 seq（journal 分配步号用）。 */
  maxSeq(taskId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM steps WHERE task_id=?')
      .get(taskId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  /** 副作用词表反查（供 recovery/审计）。 */
  sideEffectOf(callId: string): SideEffect | null {
    const row = this.db
      .prepare('SELECT side_effect AS se FROM steps WHERE call_id=?')
      .get(callId) as { se: SideEffect | null } | undefined;
    return row?.se ?? null;
  }
}
