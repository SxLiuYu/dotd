/**
 * src/control-plane/scheduler.ts —— 统一调度器（R7 / CP §2.1 / §4.3 + 契约 J4/H1）。
 *
 * 本模块的 scheduler 是**全系统唯一周期任务宿主**（CP §1.1 R7）：治理
 * `expirePending/compactAudit`、模型路由 janitor、心跳调度、§6.5 GC 均经
 * `registerInternalJob` 挂到这里（governance.md:624、model-router.md:373）。
 *
 * tick 主循环（CP §2.1，1s）：
 *   ① 跑 heartbeat 到期判定（crontabs，契约 H1：先推进 next_fire 后投递、quiet_hours、
 *      skip_if_busy、catchup='latest' 补投一次）；
 *   ② pop 队首交 Runner（经 popLoop 异步迭代器；throttled/halted 时挂起）；
 *   ③ 看门狗（10s 子周期）；
 *   ④ memory guard（5s 子周期）；
 *   ⑤ 所有 registerInternalJob（治理/路由 cron；kind:'light' 在 throttled/halted 跳轮，S4）。
 *
 * 事件入口侧（CP §2.3）：`submit`/`ingestEvent` 成功后 `setImmediate(() => wake())`，
 * 不等 1s tick——本文件提供 wake() 与 popLoop 的即时唤醒。
 */

import type { DatabaseSync } from 'node:sqlite';
import { CronExpressionParser } from 'cron-parser';
import type { Task } from '../shared/contracts.ts';
import type { ControlPlaneConfig, CrontabRow } from './types.ts';
import type { Queue } from './queue.ts';
import type { Guard } from './guard.ts';
import type { Journal } from './journal.ts';
import type { Matcher } from './match.ts';
import { DEFAULT_CP_CONFIG } from './types.ts';

/** CP §8 registerInternalJob spec（契约 J4）。 */
export interface InternalJobSpec {
  name: string;
  kind: 'light' | 'heavy';
  cron?: string;
  everyMs?: number;
  run: () => Promise<void>;
}

interface InternalJob extends InternalJobSpec {
  /** 下次到期时刻（cron 用 cron-parser 算；everyMs 用累加）。 */
  nextAt: number;
  lastRunAt: number | null;
  lastError: string | null;
}

export interface SchedulerDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  queue: Queue;
  guard: Guard;
  journal: Journal;
  matcher: Matcher;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  record(kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void;
  /** 心跳触发：向本模块 ingestEvent 投一条 heartbeat 事件（CP §4.3）。 */
  fireHeartbeat(ct: CrontabRow, missed: number): void;
  /** 看门狗判 failed 后调记忆 sealTask（契约 M3）——经 queue.markFailed 内部完成。 */
}

export class Scheduler {
  private readonly jobs: InternalJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private lastGcDay: string | null = null;
  private wakeResolvers: Array<() => void> = [];
  private stopped = true;
  private readonly deps: SchedulerDeps;
  private readonly cfg: ControlPlaneConfig;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.watchdogImpl = new ControlPlaneWatchdog({
      db: deps.db,
      queue: deps.queue,
      journal: deps.journal,
      bus: deps.bus,
      record: deps.record,
      cfg: deps.cfg,
    });
  }

  // ── 注册（契约 J4：周期任务唯一宿主）────────────────────────────────

  /**
   * 契约 J4：GOV expirePending/compactAudit、MR pool.probe.* / recon.scan /
   * breaker.probe_timer / router.janitor、CP queue.gc、H1 heartbeat.tick、
   * MEM memory-compaction/memory-retention 全部挂这里。
   * 重名 = 覆盖（热加载）。
   */
  registerInternalJob(spec: InternalJobSpec): void {
    const nextAt = this.nextDue(spec, Date.now());
    const existing = this.jobs.findIndex((j) => j.name === spec.name);
    const job: InternalJob = { ...spec, nextAt, lastRunAt: null, lastError: null };
    if (existing >= 0) this.jobs[existing] = job;
    else this.jobs.push(job);
  }

  /** 已注册 job 名清单（诊断/测试用）。 */
  jobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }

  // ── 启停 ───────────────────────────────────────────────────────────

  /** CP §7.1 步骤 7：scheduler.start（所有 registerInternalJob + heartbeat_target 扫描）。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.tickMs);
    // 不 unref：daemon 生命周期由 stop()/优雅关停显式结束（单进程常驻）。
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 优雅关停（CP §2.1-4）：停 tick、停 pop 与心跳投递。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.wakeAll();
  }

  // ── 唤醒（CP §2.3 同进程低延迟）────────────────────────────────────

  /**
   * CP §2.3：submit/ingestEvent 成功后 setImmediate 调它，不等 1s tick。
   * 两件事（CP §6.1 匹配管线 + CP §12 popLoop）：
   *   ① scanUndecidedEvents()——扫 event_log 中「未被决策」的行逐行跑匹配，
   *      产出一条 event_decisions +（run_new 时）建任务。规则层同步跑（<10ms，
   *      契约 E1 时序裁定）；模型层（LLM）异步驱动，不阻塞本调用。
   *   ② wakeAll()——解析 popLoop 等待者，让 Runner 立刻尝试 pop 新任务。
   */
  wake(): void {
    this.scanUndecidedEvents();
    this.wakeAll();
  }

  /**
   * CP §6.1 匹配管线的驱动本体（原稿缺失的生产接线：只有 recovery 的重放路径
   * 调 replayUndecidedEvents，正常运行期 ingestEvent 后事件会一直停在
   * status='pending' 直到重启才被匹配）。
   *
   * 谓词（matcher.listUndecidedEvents）：NOT EXISTS(event_decisions)
   *   AND events.status IN ('pending','inbox')，按 received_at 升序。
   * 已决策事件由 decideAndCreate 的 exists 双保险短路（幂等）。
   */
  scanUndecidedEvents(limit = 50): number {
    const pending = this.deps.matcher.listUndecidedEvents(limit);
    for (const e of pending) {
      // 规则层同步：命中即落决策（含建任务的同一事务）。
      if (this.deps.matcher.matchByRule(this.deps.matcher.toEventRow(e)) !== null) {
        this.deps.matcher.processEventSync(e.id);
        continue;
      }
      // 模型层异步：LLM 匹配要等网络，fire-and-forget 不阻塞 wake 调用方
      // （CP §6.2「LLM 匹配异步化」）。异常吞掉记 watchdog，绝不让未捕获
      // rejection 炸掉 ingestEvent 的 setImmediate 回调。
      void this.deps.matcher
        .processEvent(e.id)
        .catch((err: unknown) => {
          this.deps.record(
            'watchdog',
            'normal',
            JSON.stringify({ eventId: e.id, error: err instanceof Error ? err.message : String(err) }),
          );
        });
    }
    return pending.length;
  }

  private wakeAll(): void {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of resolvers) r();
  }

  private async waitWake(ms: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        const idx = this.wakeResolvers.indexOf(resolve);
        if (idx >= 0) this.wakeResolvers.splice(idx, 1);
        resolve();
      }, ms);
      if (typeof t.unref === 'function') t.unref();
      this.wakeResolvers.push(resolve);
    });
  }

  // ── popLoop（CP §12 骨架：`for await (const task of queue.popLoop())`）───

  /**
   * pop 队首交 Runner。throttled/halted 时 pop() 自身返回 null（门控），
   * 循环挂起等下一次 tick/wake。迭代器结束 = stop() 被调（优雅关停）。
   */
  async *popLoop(dotId = 'dot1'): AsyncGenerator<Task> {
    while (!this.stopped) {
      const t = this.deps.queue.pop(dotId);
      if (t !== null) {
        yield t;
        continue;
      }
      await this.waitWake(this.cfg.tickMs);
    }
  }

  // ── 主 tick ────────────────────────────────────────────────────────

  /**
   * 一次 tick。测试/恢复路径可直接调（不必等 1s 定时器）——因此**不查 stopped**：
   * stop() 的语义是停定时器与 popLoop，手动 tick 是显式驱动（CP §7.1 步骤 5 的
   * 心跳补投、看门狗的单元测试都走这条路）。
   */
  async tick(): Promise<void> {
    this.tickCount += 1;
    const now = Date.now();

    // ① heartbeat_target 到期扫描（契约 H1：tick 算法语义采信 SF §5.4 rev2）
    this.scanCrontabs(now);

    // ③ 看门狗（10s 子周期）
    if (this.tickCount % 10 === 0) this.watchdog(now);

    // ④ memory guard（5s 子周期）
    if (this.tickCount % 5 === 0) this.deps.guard.tick();

    // ⑤ registerInternalJob（kind:'light' 在 throttled/halted 跳轮——契约 J4/S4）
    const level = this.deps.guard.currentLevel();
    for (const job of this.jobs) {
      if (now < job.nextAt) continue;
      if (job.kind === 'light' && (level === 'throttled' || level === 'halted')) continue;
      await this.runJob(job, now);
    }
  }

  // ── ① heartbeat 扫描（CP §4.3 + 契约 H1）───────────────────────────

  /**
   * 到期后尊重 surfaces 定义的语义触发：quiet_hours 内跳过、skip_if_busy=1 且同 dot
   * 有 live 任务则跳过（写 last_fire_status='skipped_busy'）。
   * 补跑语义（采信 surfaces）：catchup='latest' → 错过 k 次只投 1 次最新；
   * catchup='skip' → 不补、直接推进 next_due_at。
   * 触发 = fireHeartbeat() → ingestEvent(source='heartbeat',
   * dedupKey='hb:<ct_id>:<next_fire>')（next_fire 时间戳天然唯一防重）。
   */
  /** 公开化：heartbeat.tick 内部 job 的判定循环本体（契约 H1）。 */
  tickCrontabs(now = Date.now()): void {
    this.scanCrontabs(now);
  }

  private scanCrontabs(now: number): void {
    const due = this.deps.db
      .prepare(`SELECT * FROM crontabs WHERE enabled=1 AND next_fire<=? ORDER BY next_fire ASC`)
      .all(now) as unknown as CrontabRow[];
    for (const ct of due) {
      const missed = this.countMissed(ct, now);
      if (this.inQuietHours(ct, now)) {
        this.advance(ct, now, 'skipped_quiet');
        continue;
      }
      if (ct.skip_if_busy === 1 && this.deps.matcher.busyCount(ct.dot_id) > 0) {
        this.advance(ct, now, 'skipped_busy');
        continue;
      }
      if (ct.catchup === 'skip') {
        this.advance(ct, now, null); // 不补，直接推进 next_due_at
        continue;
      }
      // catchup='latest'：错过 k 次只投 1 次最新（goal 附"停机期间错过 k 次"）
      this.deps.fireHeartbeat(ct, missed);
      this.advance(ct, now, 'fired');
    }
  }

  /** 推进 next_fire（cron-parser 算下一次）；回写 last_fire_*（surfaces 声明"调度器维护"）。 */
  private advance(ct: CrontabRow, now: number, status: string | null): void {
    let nextFire: number;
    try {
      nextFire = this.cronNext(ct.cron, now);
    } catch {
      // 坏 cron：停用该条，避免每 tick 撞同一错误
      this.deps.db.prepare(`UPDATE crontabs SET enabled=0 WHERE id=?`).run(ct.id);
      this.deps.record('watchdog', 'normal', JSON.stringify({ crontab: ct.id, badCron: ct.cron }));
      return;
    }
    if (status !== null) {
      this.deps.db
        .prepare(
          `UPDATE crontabs SET next_fire=?, last_fired_at=?, last_fire_seq=last_fire_seq+1,
                   last_fire_status=? WHERE id=?`,
        )
        .run(nextFire, now, status, ct.id);
    } else {
      this.deps.db
        .prepare(`UPDATE crontabs SET next_fire=?, last_fire_seq=last_fire_seq+1 WHERE id=?`)
        .run(nextFire, ct.id);
    }
  }

  private countMissed(ct: CrontabRow, now: number): number {
    let n = 0;
    let cursor = ct.next_fire;
    while (cursor <= now && n < 10_000) {
      n += 1;
      try {
        cursor = this.cronNext(ct.cron, cursor);
      } catch {
        break;
      }
    }
    return Math.max(0, n - 1);
  }

  private cronNext(cron: string, from: number): number {
    const it = CronExpressionParser.parse(cron, { currentDate: new Date(from) });
    return it.next().getTime();
  }

  /** quiet_hours 形如 '23:00-07:30'（本地时区；CP §11 开放问题 #6）。 */
  private inQuietHours(ct: CrontabRow, now: number): boolean {
    if (ct.quiet_hours === null || ct.quiet_hours === '') return false;
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(ct.quiet_hours);
    if (m === null) return false;
    const startH = Number(m[1]);
    const startM = Number(m[2]);
    const endH = Number(m[3]);
    const endM = Number(m[4]);
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨午夜
  }

  // ── ③ 看门狗（CP §4.1/§2.2：10s 扫心跳超时）────────────────────────

  /**
   * 看门狗：10s 扫 `status='running' AND now-last_heartbeat_at > HEARTBEAT_TIMEOUT_MS`
   * → abort 旧协程 → resolveOpenStep（epoch 围栏使旧协程迟到写回被拒）
   * → 回 queued、attempt+1；run_epoch 已在下次 pop 时递增。
   *
   * 硬兜底（CP §6.4）：usage≥1.2×budget 时看门狗旁路 abort（记 resource_events
   * kind='budget'），Runner 迟到写被 epoch 围栏拒。**该兜底不依赖心跳超时**——
   * 预算爆掉的任务即使心跳新鲜也必须被拦（Runner 可能卡在预算判断之前）。
   *
   * P0-3 说明：心跳不再只来自 Runner 步尾——执行面在工具在途期间每轮成功
   * `GET /jobs/{id}` 都续一次（ExecService 的注入回调 → `queue.heartbeat(live)`）。
   * 因此"工具跑 10 分钟"不会被误回收，而"工具真的卡死"时上游不再答话、
   * 心跳自然停，本方法仍按 180s 回收。
   */
  watchdog(now: number): void {
    this.watchdogImpl.watchdog(now);
  }

  /**
   * 看门狗本体（P0-3 抽出为独立类，见文件尾 `ControlPlaneWatchdog`）：
   * 行为与旧的内联实现逐字一致，只是从"不可测的 Scheduler 方法"变成可直接驱动。
   * 注意：**在构造函数里建**（不能写字段初始化器——TS 规定参数属性 `deps` 要等
   * 父构造跑完才可用，字段初始化器会先于它执行）。
   */
  private readonly watchdogImpl: ControlPlaneWatchdog;

  // ── ⑤ 内部 job 执行 ────────────────────────────────────────────────

  private async runJob(job: InternalJob, now: number): Promise<void> {
    job.nextAt = this.nextDue(job, now);
    job.lastRunAt = now;
    try {
      await job.run();
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      this.deps.record('watchdog', 'normal', JSON.stringify({ job: job.name, error: job.lastError }));
    }
  }

  private nextDue(spec: InternalJobSpec, now: number): number {
    if (spec.cron !== undefined) {
      try {
        return this.cronNext(spec.cron, now);
      } catch {
        return now + (spec.everyMs ?? 60_000);
      }
    }
    return now + (spec.everyMs ?? 60_000);
  }

  // ── 诊断 ───────────────────────────────────────────────────────────

  jobStatus(): Array<{ name: string; kind: string; nextAt: number; lastRunAt: number | null; lastError: string | null }> {
    return this.jobs.map((j) => ({
      name: j.name,
      kind: j.kind,
      nextAt: j.nextAt,
      lastRunAt: j.lastRunAt,
      lastError: j.lastError,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════
// 看门狗（P0-3：从 Scheduler 方法原样抽出成独立类，行为逐字不变）
// ═══════════════════════════════════════════════════════════════════

/**
 * 看门狗本体（CP §4.1/§2.2 + §6.4 硬兜底）。
 *
 * 为什么单独成类而不是留在 Scheduler 里：
 *  - Scheduler 一构造就要 Matcher/Guard/bus/record 一整套依赖，单元测试很难只钉"回收判据"；
 *  - 看门狗是唯一能把 running 任务打回 queued、让副作用重跑的地方（P0-3 事故点），
 *    它必须能被测试直接驱动（含注入虚拟 now），而不是绕 tester 的整条 tick 链。
 * Scheduler.watchdog(now) 只是转发：tick 的调用点、行为、异常语义全部不变。
 */
export interface ControlPlaneWatchdogDeps {
  db: DatabaseSync;
  queue: Pick<Queue, 'getTask' | 'markFailed'>;
  journal: Pick<Journal, 'tail' | 'skipStep'>;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  record(kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void;
  cfg?: Partial<Pick<ControlPlaneConfig, 'heartbeatTimeoutMs' | 'budgetHardFactor'>>;
}

export class ControlPlaneWatchdog {
  constructor(private readonly deps: ControlPlaneWatchdogDeps) {}

  private get cfg(): { heartbeatTimeoutMs: number; budgetHardFactor: number } {
    return {
      heartbeatTimeoutMs: this.deps.cfg?.heartbeatTimeoutMs ?? DEFAULT_CP_CONFIG.heartbeatTimeoutMs,
      budgetHardFactor: this.deps.cfg?.budgetHardFactor ?? DEFAULT_CP_CONFIG.budgetHardFactor,
    };
  }

  /**
   * 看门狗：10s 扫 `status='running' AND now-last_heartbeat_at > HEARTBEAT_TIMEOUT_MS`
   * → abort 旧协程 → resolveOpenStep（epoch 围栏使旧协程迟到写回被拒）
   * → 回 queued、attempt+1；run_epoch 已在下次 pop 时递增。
   *
   * 硬兜底（CP §6.4）：usage≥1.2×budget 时看门狗旁路 abort（记 resource_events
   * kind='budget'），Runner 迟到写被 epoch 围栏拒。**该兜底不依赖心跳超时**——
   * 预算爆掉的任务即使心跳新鲜也必须被拦（Runner 可能卡在预算判断之前）。
   */
  watchdog(now: number): void {
    const cutoff = now - this.cfg.heartbeatTimeoutMs;
    const overBudget = this.deps.db
      .prepare(
        `SELECT id, run_epoch AS epoch, usage_tokens AS usage, budget_tokens AS budget
         FROM tasks WHERE status='running'
           AND usage_tokens >= budget_tokens * ?`,
      )
      .all(this.cfg.budgetHardFactor) as Array<{
      id: string;
      epoch: number;
      usage: number;
      budget: number;
    }>;
    for (const t of overBudget) {
      this.deps.record(
        'budget',
        'normal',
        JSON.stringify({ taskId: t.id, usage: t.usage, budget: t.budget }),
      );
      this.deps.queue.markFailed(t.id, t.epoch, `budget 硬兜底：${t.usage}/${t.budget}`);
    }

    // ② 心跳超时回收
    const stale = this.deps.db
      .prepare(
        `SELECT id, run_epoch AS epoch, last_heartbeat_at AS hb, usage_tokens AS usage,
                budget_tokens AS budget, attempt, max_attempts AS max
         FROM tasks WHERE status='running'
           AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
      )
      .all(cutoff) as Array<{
      id: string;
      epoch: number;
      hb: number | null;
      usage: number;
      budget: number;
      attempt: number;
      max: number;
    }>;
    for (const t of stale) {
      // 已在①里被判 failed 的跳过（状态已非 running）
      if (this.deps.queue.getTask(t.id)?.status !== 'running') continue;
      this.deps.record(
        'watchdog',
        'normal',
        JSON.stringify({ taskId: t.id, epoch: t.epoch, lastHeartbeatAt: t.hb, now }),
      );
      // 孤儿 started 步：reconcileAndResolve 是异步的（要对账 exec），看门狗路径用
      // 同步的"标 interrupted"收尾，异步对账由 daemon 重启恢复/exec.interrupted 路径补齐
      // （CP §5.3：daemon 重启与 Runner abort 后重领共用同一函数）。
      //
      // ⚠ 顺序曾经反了（2026-10-18 修）：老代码先 `skipStep(callId,'watchdog_reclaim')`
      // 把 started 改成 **skipped**，再 UPDATE `WHERE status='started'` → 条件已不成立，
      // 那条 UPDATE 是**空操作**（实测终态恒为 skipped）。后果不只是"死语句"：
      //   - `skipped` 的契约语义是"治理拒绝/审批过期，这一步从未打算执行"（GOV §8.2），
      //     拿它标记"已经派发出去、结果未知"的调用是把事故伪装成正常跳过；
      //   - Runner 重建上下文时只把 **interrupted** 步注入恢复注记（dot.ts 的
      //     `feedSystemNote(noteText(s))`，"上一步结果未知，先观测再决定"），skipped 不注入
      //     —— 模型下一轮会以为没发生过，直接重做。
      // 现在：先把 started → interrupted 并**写入原因**，skipStep 只兜 pending 的（从未派发）步。
      for (const s of this.deps.journal.tail(t.id, 50)) {
        if (s.status !== 'started') continue;
        const cur = this.deps.db
          .prepare(
            `UPDATE steps SET status='interrupted', result_json=?, finished_at=?
             WHERE task_id=? AND seq=? AND status='started'`,
          )
          .run('watchdog_reclaim', now, t.id, s.seq);
        if (cur.changes === 0 && s.callId !== null) {
          // 已被别处改过（并发对账/竞态）：按 skipped 兜底留痕，至少不留在 started。
          this.deps.journal.skipStep(s.callId, 'watchdog_reclaim');
        }
      }
      const nextAttempt = t.attempt + 1;
      if (nextAttempt >= t.max) {
        this.deps.queue.markFailed(t.id, t.epoch, 'watchdog：重试次数用尽');
        continue;
      }
      const backoff = Math.min(2 ** nextAttempt * 1_000, 60_000);
      const res = this.deps.db
        .prepare(
          `UPDATE tasks SET status='queued', attempt=?, run_at=?, priority=MIN(priority,2),
                  last_heartbeat_at=NULL, updated_at=? WHERE id=? AND run_epoch=? AND status='running'`,
        )
        .run(nextAttempt, now + backoff, now, t.id, t.epoch);
      if (res.changes === 0) {
        this.deps.record(
          'stale_writer',
          'normal',
          JSON.stringify({ taskId: t.id, epoch: t.epoch, what: 'watchdog' }),
        );
      } else {
        this.deps.bus.publish('task.state', {
          taskId: t.id,
          from: 'running',
          to: 'queued',
          epoch: t.epoch,
          attempt: nextAttempt,
        });
      }
    }
  }
}
