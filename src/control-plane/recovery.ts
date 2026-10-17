/**
 * src/control-plane/recovery.ts —— 重启恢复（R5，CP §7）。
 *
 * daemon 启动序列（CP §7.1，在 HTTP listen 之前执行——契约 H2 后 HTTP 归 SF 唯一监听，
 * 因此本序列在 daemon 装配层调 SF listen 之前跑完）：
 * ```
 * 1 open db + 迁移（失败→拒启动+写 OUTBOX.md）——归 db/conn.ts + db/migrate.ts
 * 2 meta 'last_shutdown' = 优雅标记 或 'crash'
 * 3 recoverInFlight()：running → 孤儿 started 步 resolveOpenStep → queued, attempt+1,
 *   run_epoch 保持（下次 pop 再 +1），priority=min(priority,2)
 * 4 recoverAwaiting()：awaiting_approval 与 paused 原样保留；审批停机期间已落定则走 §7.4
 * 5 catchUpHeartbeats()：§4.3 catchup 语义（latest=补1次/skip=不补）
 * 6 replayUndecidedEvents()：§6.1 幂等事务
 * 7 guard.calibrateOrUseFallback()；scheduler.start(...)；http.listen
 * ```
 *
 * 崩溃窗口逐项（CP §7.2）见 tests/control-plane-recovery.test.ts 的矩阵用例：
 * | 崩溃在 | 库状态 | 恢复 | 后果 |
 * | event_log INSERT 前 | 无 event 行 | surfaces 重投/重扫 | 本模块无关 |
 * | event 已落，未决策 | event_decisions 无行 | 步骤 6 重跑 | 幂等：PK=event_id |
 * | 建任务事务中 | task 半写/无 | 事务回滚，步骤 6 重跑 | deterministicTaskId 撞 PK |
 * | beginTool 提交后、执行中 | started 孤儿 | 步骤 3 resolveOpenStep | unknown 先 reconcile |
 * | endTool 提交前 | started 孤儿（结果丢） | 同上 + 对账 done 则补记 | 不赌"其实没执行" |
 * | endTool 提交后 | succeeded | 步骤 3 从尾部重建 | 结果注入，不重执行 |
 * | finish 事务中 | running 无 task_results | 步骤 3：回 queued attempt+1 | 多数步短路 |
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '../shared/contracts.ts';
import type { Queue } from './queue.ts';
import type { Journal } from './journal.ts';
import type { Matcher } from './match.ts';
import type { Guard } from './guard.ts';
import type { Scheduler } from './scheduler.ts';
import type { ExecReconciler } from './journal.ts';

export interface RecoveryDeps {
  db: DatabaseSync;
  queue: Queue;
  journal: Journal;
  matcher: Matcher;
  guard: Guard;
  /** 执行面对账（unknown 步 reconcileCall；缺省 = unknown_host 保守路径）。 */
  exec?: ExecReconciler;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  record(kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void;
}

export interface RecoveryReport {
  /** 步骤 3：从 running 回 queued 的任务。 */
  inFlightRecovered: string[];
  /** 步骤 3：对账失败但已兜底归位（queued）的任务——必须可观测，不许静默跳过。 */
  inFlightFailed: Array<{ taskId: string; epoch: number; error: string }>;
  /** 步骤 3：处置过的孤儿 started 步。 */
  openStepsResolved: Array<{ taskId: string; seq: number; outcome: string }>;
  /**
   * 步骤 3：因「副作用未知/无法判定」而降级为 deferred 的孤儿步（= 启动后等主人审批）。
   * 需求（2026-10-17 审计）：A 修复把 unknown 孤儿步从"可重放"改成"必须审批"之后，
   * 这个决策**不能是静默的**——启动日志与诊断接口都要能回答"有没有东西在等我批"。
   * 与 approvalsPending 的关系：本字段是启动那一刻新产生的；approvals 表是权威待批集合。
   */
  inFlightDeferred: Array<{
    taskId: string;
    seq: number;
    tool: string;
    /** 治理落单后的 approval_id（治理不可用时为 null）。 */
    approvalId: number | null;
  }>;
  /** 步骤 4：停机期间已落定的审批续跑。 */
  approvalsResumed: Array<{ taskId: string; approvalId: number; ok: boolean }>;
  /** 步骤 5：补投的心跳次数。 */
  heartbeatsCaughtUp: number;
  /** 步骤 6：重放的未决策事件数。 */
  eventsReplayed: number;
}

/**
 * CP §7.1 步骤 2 的「优雅标记」：daemon 退出时置 1；无标记 = 崩溃。
 * 落点 = tasks 之外的 kv：本模块不建 meta 表（契约 D3），用 resource_events 的
 * 一行 kind='watchdog' 记录 shutdown 标记，启动时读最后一行判定。
 */
const SHUTDOWN_MARKER = 'shutdown_marker';

export function markGracefulShutdown(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO resource_events(ts, level, kind, detail) VALUES(?, 'normal', 'watchdog', ?)`,
  ).run(Date.now(), JSON.stringify({ [SHUTDOWN_MARKER]: true }));
}

function lastShutdownGraceful(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT detail FROM resource_events WHERE kind='watchdog' AND detail LIKE ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(`%${SHUTDOWN_MARKER}%`) as { detail: string } | undefined;
  return row !== undefined;
}

/**
 * 步骤 3 recoverInFlight：在途任务经 epoch 围栏回可继续态、journal 归置。
 * 对每条 running 任务：先 abort（正常重启无 in-process handle，防御性），
 * 再对 started 孤儿步 resolveOpenStep（§5.3 同一函数），最后任务 → queued、
 * attempt+1、priority=min(priority,2)、last_heartbeat_at=NULL；run_epoch **保持**
 * （下次 pop 再 +1）。
 *
 * 隔离语义（审码 finding，任务永久卡死）：对账要经执行面（exec.reconcileCall /
 * getCallResult），那是**网络调用**——容器没起来、docker socket 不通、执行面半装配
 * 都会抛。旧实现没有 per-task try，一条任务对账抛错会让整个 recoverInFlight 抛 →
 * cp.recover() 抛 → assembleDaemon 抛 → **daemon 根本起不来**。
 * 现在：单条任务失败只记账 + 把该任务放回 queued（任务本身不丢，下一轮看门狗/
 * 重启还能再收口），其余任务照常恢复。
 */
async function recoverInFlight(deps: RecoveryDeps, report: RecoveryReport): Promise<void> {
  const running = deps.db
    .prepare(
      `SELECT id, run_epoch AS epoch FROM tasks WHERE status='running' ORDER BY created_at ASC`,
    )
    .all() as Array<{ id: string; epoch: number }>;
  for (const t of running) {
    try {
      for (const s of deps.journal.tail(t.id, 2_000)) {
        if (s.status !== 'started') continue;
        const outcome = await deps.journal.reconcileAndResolve(t.id, s.seq);
        report.openStepsResolved.push({ taskId: t.id, seq: s.seq, outcome });
        if (outcome === 'deferred') {
          // A 修复的可观测面：unknown 副作用降级为"等审批"时必须能被主人看见。
          // approval_id 由 journal 回写该步（治理不可用时为 null，此时只剩恢复注记）。
          const row = deps.db
            .prepare('SELECT approval_id AS a FROM steps WHERE task_id=? AND seq=?')
            .get(t.id, s.seq) as { a: number | null } | undefined;
          report.inFlightDeferred.push({
            taskId: t.id,
            seq: s.seq,
            tool: s.toolName ?? s.kind,
            approvalId: row?.a ?? null,
          });
        }
      }
      deps.queue.reclaimInFlight(t.id, t.epoch, 'recovery');
      report.inFlightRecovered.push(t.id);
    } catch (err) {
      // 可观测且不静默：记 resource_event + 进报告的 failed 列表（CLI/日志可读）。
      const message = err instanceof Error ? err.message : String(err);
      report.inFlightFailed.push({ taskId: t.id, epoch: t.epoch, error: message });
      deps.record(
        'watchdog',
        'normal',
        JSON.stringify({ taskId: t.id, epoch: t.epoch, what: 'recovery_failed', error: message }),
      );
      // 兜底归位：孤儿步没对账完，但任务不能停在 running（会白占 maxRunning 额度、
      // 且没有任何协程持有它 → 永久卡死）。queued 是无损的：已 succeeded 步仍会被
      // Runner 从尾部重建跳过（§5.3 硬保证 1），started 孤儿步下次仍走对账。
      try {
        deps.queue.reclaimInFlight(t.id, t.epoch, 'recovery_degraded');
      } catch {
        // 连归位都失败（库级故障）：保持 running 交看门狗心跳超时兜底。
      }
    }
  }
}

/**
 * 步骤 4 recoverAwaiting：awaiting_approval 与 paused 原样保留（审批/挂起不随重启丢——
 * 库中即状态）。对 awaiting_approval：查治理 approvals 当前态，若停机期间已落定（ok），
 * 按 §7.4 审批续跑路径转 queued(resume_from_seq)；deny/expired 同理。不依赖内存回调，
 * 纯读库（issue #5c：恢复也走上下文重建）。
 *
 * 治理 approvals 表的读取经注入的 approvalsReader（治理属主表，只读接口）。
 */
export interface ApprovalsReader {
  /** 返回该任务的未决/已落定审批（taskRef 关联）。 */
  listForTask(taskId: string): Array<{ id: number; status: string }>;
}

async function recoverAwaiting(
  deps: RecoveryDeps,
  reader: ApprovalsReader | undefined,
  report: RecoveryReport,
): Promise<void> {
  if (reader === undefined) return;
  const awaiting = deps.db
    .prepare(`SELECT id FROM tasks WHERE status='awaiting_approval' ORDER BY created_at ASC`)
    .all() as Array<{ id: string }>;
  for (const t of awaiting) {
    for (const ap of reader.listForTask(t.id)) {
      if (ap.status === 'approved') {
        deps.queue.onApprovalSettled(t.id, ap.id, true);
        report.approvalsResumed.push({ taskId: t.id, approvalId: ap.id, ok: true });
      } else if (ap.status === 'rejected' || ap.status === 'expired' || ap.status === 'revoked') {
        deps.queue.onApprovalSettled(t.id, ap.id, false);
        report.approvalsResumed.push({ taskId: t.id, approvalId: ap.id, ok: false });
      }
    }
  }
}

/**
 * 步骤 5 catchUpHeartbeats（CP §4.3 / 契约 H1）：surfaces catchup 语义
 * （latest=补1次/skip=不补）。crontabs 的到期扫描在 scheduler.start 后自然跑
 * （scanCrontabs 已实现 catchup 分支），这里只补"停机期间" missed 的 latest 投递
 * 统计——实际投递由 scheduler 首个 tick 完成，避免与 tick 重复投。
 */
function catchUpHeartbeats(
  deps: RecoveryDeps,
  scheduler: Scheduler,
  report: RecoveryReport,
): void {
  const now = Date.now();
  const overdue = deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM crontabs WHERE enabled=1 AND next_fire<=? AND catchup='latest'`,
    )
    .get(now) as { n: number };
  // scheduler 首个 tick 会按 catchup='latest' 补投一次；此处只记账。
  report.heartbeatsCaughtUp = overdue.n;
  void scheduler;
}

/**
 * CP §7.1 完整启动恢复序列（步骤 2–6；步骤 1 归 db/migrate.ts，步骤 7 归 index.ts）。
 * 在 HTTP listen 之前执行（契约 H2：HTTP 唯一监听归 SF，装配层先跑本函数再 listen）。
 */
export async function recoverOnStartup(
  deps: RecoveryDeps,
  scheduler: Scheduler,
  approvalsReader?: ApprovalsReader,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    inFlightRecovered: [],
    inFlightFailed: [],
    openStepsResolved: [],
    inFlightDeferred: [],
    approvalsResumed: [],
    heartbeatsCaughtUp: 0,
    eventsReplayed: 0,
  };

  // 步骤 2：优雅标记判定（无优雅标记 = 崩溃）。只影响日志/审计，不影响恢复动作
  // （崩溃与优雅关停走同一恢复路径，CP §2.1-4：超时强退也交 §7 恢复兜底）。
  const graceful = lastShutdownGraceful(deps.db);
  deps.record('watchdog', 'normal', JSON.stringify({ lastShutdown: graceful ? 'graceful' : 'crash' }));

  // 步骤 3
  await recoverInFlight(deps, report);

  // 步骤 4
  await recoverAwaiting(deps, approvalsReader, report);

  // 步骤 5
  catchUpHeartbeats(deps, scheduler, report);

  // 步骤 6：重跑幂等事务（exists 短路；deterministicTaskId 防双建）
  const undecided = deps.matcher.listUndecidedEvents(200);
  deps.matcher.replayUndecidedEvents(200);
  report.eventsReplayed = undecided.length;

  return report;
}

/** CP §7.4 reclaimTask：三触发（看门狗超时 / 背压 halted abort / exec.interrupted）共用。 */
export function reclaimTask(
  deps: Pick<RecoveryDeps, 'db' | 'queue' | 'record'>,
  taskId: string,
  reason: 'watchdog' | 'halted' | 'exec_interrupted',
): void {
  // abort 该 task 现绑定的 Runner 协程由装配层/执行面持有 AbortSignal；队列侧只做
  // 状态归位：task → queued, attempt+1；run_epoch 由下次 pop 递增；旧协程迟到写被拒。
  deps.record('watchdog', 'normal', JSON.stringify({ taskId, reason, reclaim: true }));
  deps.queue.reclaimInFlight(taskId, deps.queue.currentEpoch(taskId) ?? 0, reason);
}

/** 供 index.ts 暴露的 Task 快照（测试/诊断用）。 */
export function snapshotTask(task: Task): Task {
  return task;
}
