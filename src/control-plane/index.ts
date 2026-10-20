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
import { shouldPush } from '../surfaces/proactive.ts';
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

/**
 * P1-1：抢占后的 journal 对账。
 *
 * 被抢占的任务退回 queued 时，journal 里可能还有 `started` 的孤儿步（当时正在等工具返回）。
 * 不处理的话，"抢占"就等于"批量制造 unknowns"，与 P0-3 立下的"绝不重复执行"直接冲突。
 *
 * 做法：把该任务所有 `started` 步逐个交给 `journal.reconcileAndResolve`——
 * 它就是 CP §5.3 的既有三分流（不要在这里另写一套判据）：
 *   - llm / safe / replayable 步 → 标 interrupted，由重跑的 Runner 重新决策（不重放副作用）；
 *   - unknown 副作用步 → 先向执行面按 call_id 对账真实结局（done 就补 succeeded，不重放）。
 *
 * 不抛：任何异常都吞掉（对账失败还能靠下轮 pop/看门狗/重启恢复兜底），
 * 但会记一条 resource_event 便于复盘。
 */
async function reconcilePreempted(
  holder: { j: Journal | null },
  taskId: string,
): Promise<void> {
  const journal = holder.j;
  if (journal === null) return;
  for (const s of journal.tail(taskId, 200)) {
    if (s.status !== 'started') continue;
    await journal.reconcileAndResolve(taskId, s.seq);
  }
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
    // P1-1：抢占后对账（惰性取 journalImpl——它在 queue 之后构造）
    reconcileAfterPreempt: (taskId) => {
      void reconcilePreempted(journalHolder, taskId).catch(() => {
        // 对账失败不炸队列：下轮 pop / 看门狗 / 重启恢复仍会兜底
      });
    },
  });
  /** 惰性 holder：journalImpl 在建 queue 之后才存在。 */
  const journalHolder: { j: Journal | null } = { j: null };
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
  journalHolder.j = journalImpl;

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
      /**
       * T4（2026-10-20）：主动推送判定。
       *
       * 任务**照常触发** —— 判定的只是"结果要不要主动告诉主人"。
       * 为什么不在任务创建前拦：定时任务的价值常常在副作用（写文件、更新记忆），
       * 不推送不等于不该跑。把两者混一起会让"安静"变成"不干活"。
       *
       * 判定结论随 payload 传给下游（Runner 结束时据此决定发不发），
       * 同时把 last_push_at 落库 —— 放内存的话一次重启就能让节流归零。
       */
      const nowMs = Date.now();
      const decision = shouldPush({
        proactive: ct.proactive === 1,
        quietHours: ct.quiet_hours,
        throttleHours: ct.throttle_hours,
        lastPushAt: ct.last_push_at,
        now: nowMs,
        // 目标会话存在性在下游判（这里拿不到 surfaces 配置）；
        // 这里只做时域三闸，hasTarget 恒真不误拒。
        hasTarget: true,
      });

      if (decision.allowed) {
        // 立刻记上"推过了"，防同一任务在短窗口内被重复触发时连发。
        // 用 nowMs 而不是任务完成时刻：节流窗口的语义是"两次打扰之间"，
        // 从触发时刻算更严格，也更简单。
        try {
          db.prepare('UPDATE crontabs SET last_push_at=? WHERE id=?').run(nowMs, ct.id);
        } catch {
          // 记不上不影响任务本身；下一次会因为 last_push_at 为旧值而提前放行
        }
      } else if (decision.reason !== 'disabled') {
        // disabled 是主人主动关的，天天记一条日志是噪音。
        // 其他原因值得记：安静时段/节流说明系统在工作。
        //
        // 走 bus 而不是 record()：record 落的是 resource_events 表，
        // 它的 kind 是资源治理词表（watermark/disk_gc/...），
        // 把"没推送"塞进去会污染那张表的语义。
        bus.publish('log', {
          level: 'info',
          msg: `crontab ${ct.id} 不主动推送：${decision.detail ?? decision.reason}`,
        });
      }

      // CP §4.3：触发 = ingestEvent(source='heartbeat', dedupKey='hb:<ct_id>:<next_fire>')
      matcher.ingestEvent({
        source: 'heartbeat',
        dotId: ct.dot_id,
        actor: ct.id,
        payload: {
          crontabId: ct.id,
          title: ct.title,
          prompt: ct.prompt,
          missed,
          // 下游据此决定结果发不发主人
          proactive: decision.allowed,
        },
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
  // **端点级熔断恢复也要唤醒暂停任务**（2026-10-19 实测补）。
  //
  // 上面的 mode_changed 订阅只在 **router mode** 从降级态（TOTAL_OUTAGE/EMERGENCY/
  // RESTRICTED）恢复时才触发。但实测发现一种常见情况它覆盖不到：
  //
  //   模型网关短暂不可达 → **端点熔断**（breaker open）→ 任务 paused(circuit_open)
  //   → 网关恢复 → breaker 自己转 closed
  //   → **router mode 从头到尾都是 NORMAL**，mode_changed 根本没发
  //   → 任务永远卡在 paused，只有主人手动 resume
  //
  // 现场：gpt-load 网关端口没起来，一个任务 paused；网关修好后新任务正常，
  // 那个旧任务一直卡着。查库发现 breaker 已 closed、mode 一直 NORMAL。
  //
  // 修法：同时订阅端点级事件，任一端点转 closed 就尝试唤醒。
  // resumeCircuitOpenTasks 内部幂等（没东西可恢复就是空操作），重复调用无害。
  const offBreakerChanged = bus.on<{ endpointId: string; track: string; from: string; to: string }>(
    'router.breaker_changed',
    (ev) => {
      if (ev.payload.to !== 'closed') return;
      queue.resumeCircuitOpenTasks();
    },
  );

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
    heartbeat(taskId, epoch, usage, opts) {
      return queue.heartbeat(taskId, epoch, usage, opts);
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
      offBreakerChanged();
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
