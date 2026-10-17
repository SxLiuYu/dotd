/**
 * src/control-plane/index.ts —— ControlPlane 组装（对外唯一门面）。
 *
 * 装配顺序（CONVENTIONS.md §4：daemon.ts 装配层 CP→MR→GOV→EX→MEM→SF）：
 *   const cp = createControlPlane({ db, bus, ... });
 *   cp.recover();      // CP §7.1 启动恢复（HTTP listen 之前）
 *   cp.scheduler.start();
 *
 * 跨模块接口一律 import src/shared/contracts.ts（CONVENTIONS.md §6）；本文件只做
 * 依赖注入与门面转发，不另定接口。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type {
  ControlPlane,
  EventDecision,
  EventsRow,
  IngestEventReq,
  IngestEventResult,
  ResourceEventRow,
  Step,
  Task,
  TaskImpact,
  TaskStatus,
} from '../shared/contracts.ts';
import type { ControlPlaneConfig, ResourceEventKind, ResourceEventLevel } from './types.ts';
import { DEFAULT_CP_CONFIG } from './types.ts';
import { Queue } from './queue.ts';
import { Journal } from './journal.ts';
import type { ExecReconciler, GovernanceForcer } from './journal.ts';
import { Matcher } from './match.ts';
import type { EventRule, LowBrain } from './match.ts';
import { Guard } from './guard.ts';
import type { ExecPorts, GuardDeps } from './guard.ts';
import { Scheduler } from './scheduler.ts';
import type { InternalJobSpec } from './scheduler.ts';
import { recoverOnStartup } from './recovery.ts';
import type { ApprovalsReader, RecoveryReport } from './recovery.ts';
import { runQueueGc } from './evict.ts';
import { isDailyDue } from './evict.ts';

export interface ControlPlaneDeps {
  db: DatabaseSync;
  bus: EventBus;
  cfg?: Partial<ControlPlaneConfig>;
  /** 规则层（config/event-rules.yml；阶段一默认空 rules）。 */
  rules?: EventRule[];
  /** 模型层（MR complete({track:'light'}) 薄封装）。 */
  lowBrain?: LowBrain;
  /** 执行面（契约 J5 容器指令 + §5.3 对账）。 */
  exec?: ExecPorts & ExecReconciler;
  /** 治理 forceApproval（unknown 孤儿步转审批）。 */
  governance?: GovernanceForcer;
  /** 治理 approvals 只读（恢复步骤 4）。 */
  approvals?: ApprovalsReader;
  /** 记忆模块 sealTask 钩子（契约 M3）。 */
  sealTask?: (
    task: Task,
    outcome: 'done' | 'failed' | 'cancelled',
    reason?: string,
  ) => Promise<void>;
  /** journal-blobs 绝对目录（装配层从 dataDir 推出）。 */
  blobDirAbs?: string;
  /** 已知 dotId 清单（guard 容器指令遍历用；阶段一恒 ['dot1']）。 */
  dotIds?: string[];
  /** treatUnknownAsRisk（CP §5.3：默认 true；应急强制 true）。 */
  treatUnknownAsRisk?: boolean;
}

export interface ControlPlaneInstance extends ControlPlane {
  /** 内部件（daemon 装配层/SF 转调用）。 */
  readonly queue: Queue;
  /** 内部 Journal 实例（contracts.ts:ControlPlane.journal 是方法门面，见下）。 */
  readonly journalImpl: Journal;
  readonly matcher: Matcher;
  readonly guard: Guard;
  readonly scheduler: Scheduler;
  /** CP §7.1 启动恢复；返回报告（测试断言用）。 */
  recover(approvalsReader?: ApprovalsReader): Promise<RecoveryReport>;
  /** 优雅关停（CP §2.1-4）：停 tick、落 shutdown 标记。 */
  shutdown(): void;
  /** 队列 GC job 本体（经 registerInternalJob('queue.gc') 挂 scheduler）。 */
  runQueueGcNow(): ReturnType<typeof runQueueGc>;
}

export function createControlPlane(deps: ControlPlaneDeps): ControlPlaneInstance {
  const cfg: ControlPlaneConfig = { ...DEFAULT_CP_CONFIG, ...deps.cfg };
  const bus = deps.bus;
  const db = deps.db;
  const dotIds = deps.dotIds ?? ['dot1'];

  const record = (
    kind: ResourceEventKind,
    level: ResourceEventLevel,
    detail: string,
  ): void => {
    db.prepare(
      `INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)`,
    ).run(Date.now(), level, kind, detail);
  };

  // 先建 guard 再建 queue：pop 的门控要读水位（CP §4.2 `if guard throttled/halted return null`）。
  // guard 需要 queue（解冻时把 paused(watermark) 批量回 queued），用惰性门面打破环。
  const guard: Guard = new Guard({
    db,
    cfg,
    queue: undefined as unknown as Queue,
    bus,
    record,
    knownDotIds: () => dotIds,
    exec: deps.exec,
  });
  const queue: Queue = new Queue({
    db,
    cfg,
    bus,
    guardLevel: () => guard.currentLevel(),
    record,
    sealTask: deps.sealTask,
  });
  // 补回 queue 引用（构造后再赋值；Guard 内只在运行期读）。
  (guard as unknown as { deps: GuardDeps }).deps.queue = queue;

  const journalImpl: Journal = new Journal({
    db,
    cfg,
    bus,
    record,
    exec: deps.exec,
    governance: deps.governance,
    treatUnknownAsRisk: deps.treatUnknownAsRisk,
  });

  // scheduler 后建；matcher 的 wake 用惰性门面（构造顺序 matcher → scheduler）。
  const matcher: Matcher = new Matcher({
    db,
    cfg,
    queue,
    bus,
    rules: deps.rules ?? [],
    lowBrain: deps.lowBrain,
    wake: () => scheduler.wake(),
    record,
  });
  const scheduler: Scheduler = new Scheduler({
    db,
    cfg,
    queue,
    guard,
    journal: journalImpl,
    matcher,
    bus,
    record,
    fireHeartbeat: (ct, missed) => {
      // CP §4.3：触发 = ingestEvent(source='heartbeat', dedupKey='hb:<ct_id>:<next_fire>')
      matcher.ingestEvent({
        source: 'heartbeat',
        dotId: ct.dot_id,
        actor: ct.id,
        payload: { crontabId: ct.id, title: ct.title, prompt: ct.prompt, missed },
        dedupKey: `hb:${ct.id}:${ct.next_fire}`,
      });
    },
  });

  // queue.gc 内部 job（CP §6.5 / 契约 J4：每日 04:00 本地时区；heavy，内部错峰）
  scheduler.registerInternalJob({
    name: 'queue.gc',
    kind: 'heavy',
    everyMs: 60_000,
    run: async () => {
      if (!isDailyDue(cfg.gcDailyAt)) return;
      runQueueGc({
        db,
        cfg,
        queue,
        record,
        bus,
        blobDirAbs: deps.blobDirAbs ?? 'journal-blobs',
      });
    },
  });

  // heartbeat.tick（契约 H1/J4：判定循环由本模块 scheduler 代跑）
  scheduler.registerInternalJob({
    name: 'heartbeat.tick',
    kind: 'light',
    everyMs: 15_000,
    run: async () => {
      scheduler.tickCrontabs();
    },
  });

  // CP §8-S8 / 契约 T1：订阅 router.mode_changed —— 路由从降级态恢复（非 TOTAL_OUTAGE 的
  // 可用态）时把 paused(stop_reason='circuit_open') 批量回 queued。
  // 旧稿缺失此接线：熔断暂停的任务除主人手动 resume 外永远卡在 paused。
  // RouterMode 词表：NORMAL/LOCAL_FALLBACK/EMERGENCY/RESTRICTED/TOTAL_OUTAGE。
  // 判据：to 不是 TOTAL_OUTAGE 且 from 是 TOTAL_OUTAGE/EMERGENCY/RESTRICTED → 恢复。
  const offModeChanged = bus.on<{ from: string; to: string }>('router.mode_changed', (ev) => {
    const degraded = (m: string): boolean =>
      m === 'TOTAL_OUTAGE' || m === 'EMERGENCY' || m === 'RESTRICTED';
    if (!degraded(ev.payload.from) || degraded(ev.payload.to)) return;
    // 记账在 queue.resumeCircuitOpenTasks 内部（bus.publish + record 一致口径），
    // 这里不重复记——否则一次恢复写两条 watchdog。
    queue.resumeCircuitOpenTasks();
  });

  const instance: ControlPlaneInstance = {
    queue,
    journalImpl,
    matcher,
    guard,
    scheduler,

    // ── 队列 ──
    submit(req): Task {
      const t = queue.submit(req);
      scheduler.wake();
      return t;
    },
    pop(dotId?: string): Task | null {
      return queue.pop(dotId);
    },
    heartbeat(taskId, epoch, usage) {
      return queue.heartbeat(taskId, epoch, usage);
    },
    finish(taskId, epoch, r) {
      queue.finish(taskId, epoch, r);
    },
    cancel(taskId, by) {
      queue.cancel(taskId, by);
    },
    resume(taskId) {
      queue.resume(taskId);
      scheduler.wake();
    },
    list(q: { status?: TaskStatus[]; dotId?: string; limit?: number }): Task[] {
      return queue.list(q);
    },
    getTask(id): Task | null {
      return queue.getTask(id);
    },
    getJournal(taskId): Step[] {
      return queue.getJournal(taskId);
    },

    // ── 事件（契约 E2）──
    ingestEvent(e: IngestEventReq): IngestEventResult {
      return matcher.ingestEvent(e);
    },
    listUndecidedEvents(limit?: number): EventsRow[] {
      return matcher.listUndecidedEvents(limit);
    },
    retryMatch(eventLogId: number, m: EventDecision): void {
      matcher.retryMatch(eventLogId, m);
    },

    // ── 会话绑定（契约 M2）──
    bindSession(taskId, epoch, ids) {
      queue.bindSession(taskId, epoch, ids);
    },

    // ── 审批联动（契约 J6）──
    setAwaitingApproval(taskId, epoch, approvalId) {
      queue.setAwaitingApproval(taskId, epoch, approvalId);
    },
    onApprovalSettled(taskId, approvalId, ok, meta) {
      queue.onApprovalSettled(taskId, approvalId, ok, meta);
    },

    // ── journal（契约 J3；门面转发，避免与实例字段 journalImpl 撞名）──
    journal: {
      beginTool(taskId, epoch, tool, args, se) {
        return journalImpl.beginTool(taskId, epoch, tool, args, se);
      },
      markPending(taskId, epoch, seq, approvalId) {
        journalImpl.markPending(taskId, epoch, seq, approvalId);
      },
      endTool(taskId, epoch, seq, st, result) {
        journalImpl.endTool(taskId, epoch, seq, st, result);
      },
      beginLlm(taskId, epoch, promptDigest) {
        return journalImpl.beginLlm(taskId, epoch, promptDigest);
      },
      endLlm(taskId, epoch, seq, respDigest) {
        journalImpl.endLlm(taskId, epoch, seq, respDigest);
      },
      resumeStep(taskId, epoch, seq, argsJson) {
        return journalImpl.resumeStep(taskId, epoch, seq, argsJson);
      },
      skipStep(callId, reason) {
        journalImpl.skipStep(callId, reason);
      },
      getStepByCallId(callId) {
        return journalImpl.getStepByCallId(callId);
      },
      reconcileAndResolve(taskId, seq) {
        return journalImpl.reconcileAndResolve(taskId, seq);
      },
      tail(taskId, n) {
        return journalImpl.tail(taskId, n);
      },
    },

    // ── 背压与预算 ──
    getGuardStatus() {
      return guard.status();
    },
    pauseByReason(taskId, reason) {
      queue.pauseByReason(taskId, reason);
    },
    pauseDotQueue(dotId) {
      queue.pauseDotQueue(dotId);
    },
    resumeDotQueue(dotId) {
      queue.resumeDotQueue(dotId);
    },
    taskImpact(): TaskImpact {
      return matcher.taskImpact();
    },

    // ── 统一调度器（契约 J4）──
    registerInternalJob(spec: InternalJobSpec): void {
      scheduler.registerInternalJob(spec);
    },

    // ── 事件总线 ──
    onBus(event, handler) {
      return bus.on(event, (e) => handler(e.payload));
    },

    // ── 生命周期 ──
    async recover(approvalsReader?: ApprovalsReader): Promise<RecoveryReport> {
      const report = await recoverOnStartup(
        {
          db,
          queue,
          journal: journalImpl,
          matcher,
          guard,
          exec: deps.exec,
          bus,
          record,
        },
        scheduler,
        approvalsReader ?? deps.approvals,
      );
      guard.calibrateOrUseFallback();
      return report;
    },
    shutdown(): void {
      offModeChanged();
      scheduler.stop();
      db.prepare(
        `INSERT INTO resource_events(ts, level, kind, detail) VALUES(?, 'normal', 'watchdog', ?)`,
      ).run(Date.now(), JSON.stringify({ shutdown_marker: true }));
    },
    runQueueGcNow() {
      return runQueueGc({
        db,
        cfg,
        queue,
        record,
        bus,
        blobDirAbs: deps.blobDirAbs ?? 'journal-blobs',
      });
    },
  };

  return instance;
}
