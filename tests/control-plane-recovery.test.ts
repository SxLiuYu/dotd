/**
 * tests/control-plane-recovery.test.ts —— 重启恢复（CP §7）+ 失联重领（§7.4）。
 *
 * 依据 control-plane.md：
 * - §7.1 daemon 启动序列步骤 2–6（步骤 1 归 db/migrate.ts、步骤 7 归 index.ts）：
 *   ```
 *   2 meta 'last_shutdown' = 优雅标记 或 'crash'
 *   3 recoverInFlight()：running → started 孤儿 resolveOpenStep（§5.3）→ queued,
 *     attempt+1, run_epoch 保持（下次 pop 再 +1）, priority=min(priority,2)
 *   4 recoverAwaiting()：awaiting_approval / paused 原样保留；停机期间已落定审批按 §7.4 续跑
 *   5 catchUpHeartbeats()：crontabs catchup='latest' 到期记账
 *   6 replayUndecidedEvents()：§6.1 幂等事务（exists 短路；deterministicTaskId 防双建）
 *   ```
 * - §7.4 reclaimTask 三触发共用子程序：看门狗超时 / 背压 halted abort / exec.interrupted。
 *   共性：abort 旧协程 → 任务回 queued、attempt+1 → 旧协程迟到写被 epoch 围栏拒（§2.2）。
 * - §5.3 三条硬保证：已 succeeded 步永不重执行；unknown 先对账；孤儿步转 interrupted 不删。
 *
 * §7.2 崩溃窗口逐项（beginTool/endTool/finish 三行）见 control-plane-journal.test.ts，
 * 本文件补 §7.1 启动序列的编排与 §7.4 的队列侧归位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Journal } from '../src/control-plane/journal.ts';
import type { ExecReconciler } from '../src/control-plane/journal.ts';
import { Matcher } from '../src/control-plane/match.ts';
import { Scheduler } from '../src/control-plane/scheduler.ts';
import {
  recoverOnStartup,
  reclaimTask,
  markGracefulShutdown,
} from '../src/control-plane/recovery.ts';
import type { ApprovalsReader } from '../src/control-plane/recovery.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';

const tmps: TempDataDir[] = [];

interface Fixture {
  tmp: TempDataDir;
  queue: Queue;
  journal: Journal;
  matcher: Matcher;
  scheduler: Scheduler;
  events: Array<{ kind: string; detail: string }>;
  exec: ExecReconciler;
}

function fixture(opts: { exec?: ExecReconciler; rules?: import('../src/control-plane/match.ts').EventRule[] } = {}): Fixture {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = DEFAULT_CP_CONFIG;
  const events: Array<{ kind: string; detail: string }> = [];
  const record = (kind: string, _level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void => {
    events.push({ kind, detail });
    tmp.db
      .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
      .run(Date.now(), _level, kind, detail);
  };
  const queue = new Queue({ db: tmp.db, cfg, bus: tmp.bus, guardLevel: () => 'normal', record });
  const journal = new Journal({ db: tmp.db, cfg, bus: tmp.bus, record, ...(opts.exec !== undefined ? { exec: opts.exec } : {}) });
  const matcher = new Matcher({ db: tmp.db, cfg, queue, bus: tmp.bus, rules: opts.rules ?? [], wake: () => {}, record });
  const scheduler = new Scheduler({
    db: tmp.db,
    cfg,
    queue,
    guard: {
      currentLevel: () => 'normal',
      tick: () => ({ level: 'normal' }),
      status: () => ({ level: 'normal' }),
      calibrateOrUseFallback: () => {},
    } as unknown as import('../src/control-plane/guard.ts').Guard,
    journal,
    matcher,
    bus: tmp.bus,
    record,
    fireHeartbeat: () => {},
  });
  ACTIVE_DB = tmp;
  return { tmp, queue, journal, matcher, scheduler, events, exec: opts.exec ?? defaultExec() };
}

/** 执行面对账 stub：默认 unknown_host（保守路径）。 */
function defaultExec(): ExecReconciler {
  return {
    async reconcileCall() {
      return 'unknown_host';
    },
    async getCallResult() {
      return null;
    },
  };
}

function makeRunning(f: Fixture, priority = 5): { taskId: string; epoch: number } {
  const t = f.queue.submit({ title: 't', goal: 'g', priority });
  const run = f.queue.pop()!;
  return { taskId: t.id, epoch: run.runEpoch };
}

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  ACTIVE_DB = null;
  ACTIVE_EVENTS.length = 0;
});

// ── §7.1 步骤 2：优雅标记 ─────────────────────────────────────────

test('§7.1 步骤 2：markGracefulShutdown 后启动记录 graceful；无标记 = crash', async () => {
  const f = fixture();
  await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );
  assert.equal(lastShutdownKind(f), 'crash', '无优雅标记 → crash');

  markGracefulShutdown(f.tmp.db);
  await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );
  assert.equal(lastShutdownKind(f), 'graceful', '有优雅标记 → graceful');
});

function lastShutdownKind(f: Fixture): string {
  const rows = f.tmp.db
    .prepare("SELECT detail FROM resource_events WHERE kind='watchdog' ORDER BY id DESC")
    .all() as Array<{ detail: string }>;
  for (const r of rows) {
    if (r.detail.includes('lastShutdown')) {
      const m = r.detail.match(/"lastShutdown":"(\w+)"/);
      if (m) return m[1]!;
    }
  }
  throw new Error('未找到 lastShutdown 记录');
}

function guardStub(f: Fixture): import('../src/control-plane/guard.ts').Guard {
  void f;
  return {
    currentLevel: () => 'normal',
    calibrateOrUseFallback: () => {},
  } as unknown as import('../src/control-plane/guard.ts').Guard;
}

/**
 * recoverOnStartup 的 record 依赖：既写 resource_events（断言可读），
 * 也收进内存数组（与 fixture 的 record 行为一致）。guardStub/reclaimTask 也用它。
 */
function noop(kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void {
  const row = ACTIVE_DB;
  if (row !== null) {
    row.db
      .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
      .run(Date.now(), level, kind, detail);
  }
  ACTIVE_EVENTS.push({ kind, detail });
}

/** 当前测试的 tmp.db（fixture 创建时设置，afterEach 清理）。 */
let ACTIVE_DB: TempDataDir | null = null;
const ACTIVE_EVENTS: Array<{ kind: string; detail: string }> = [];

// ── §7.1 步骤 3：recoverInFlight ──────────────────────────────────

test('§7.1 步骤 3：running → queued、attempt+1、priority=min(priority,2)、run_epoch 保持', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f, 7);
  const before = f.tmp.db
    .prepare('SELECT attempt, run_epoch FROM tasks WHERE id=?')
    .get(taskId) as { attempt: number; run_epoch: number };
  assert.equal(before.attempt, 0);

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  const after = f.tmp.db
    .prepare('SELECT status, attempt, run_epoch, priority FROM tasks WHERE id=?')
    .get(taskId) as { status: string; attempt: number; run_epoch: number; priority: number };
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 1, 'attempt+1');
  assert.equal(after.run_epoch, epoch, 'run_epoch 保持（下次 pop 再 +1）');
  assert.equal(after.priority, 2, 'priority=min(7,2)');
  assert.deepEqual(report.inFlightRecovered, [taskId]);
});

test('§7.1 步骤 3：started 孤儿步先 resolveOpenStep 再归位（safe → replayed）', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'fs.read', { p: '/a' }, 'safe');

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'replayed' }]);
  const step = f.tmp.db
    .prepare('SELECT status, finished_at FROM steps WHERE task_id=? AND seq=1')
    .get(taskId) as { status: string; finished_at: number | null };
  assert.equal(step.status, 'interrupted', '孤儿步转 interrupted 不删（§5.3 审计闭环）');
  assert.ok(step.finished_at !== null);
  assert.equal(f.queue.getTask(taskId)!.status, 'queued');
});

test('§7.1 步骤 3：已 succeeded 步绝不重执行（§5.3 硬保证 1）', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'fs.read', { p: '/a' }, 'safe');
  f.journal.endTool(taskId, epoch, 1, 'succeeded', { content: 'original' });

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.deepEqual(report.openStepsResolved, [], 'succeeded 步不是孤儿，不触发 resolveOpenStep');
  const step = f.tmp.db
    .prepare('SELECT status, result_json FROM steps WHERE task_id=? AND seq=1')
    .get(taskId) as { status: string; result_json: string };
  assert.equal(step.status, 'succeeded');
  assert.equal(step.result_json, JSON.stringify({ content: 'original' }), '原结果原样保留');
});

test('§7.1 步骤 3：pending 步不算孤儿（resolveOpenStep 只处理 started）', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'web.click', { url: 'u' }, 'unknown');
  f.journal.markPending(taskId, epoch, 1, 42);

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.deepEqual(report.openStepsResolved, []);
  assert.equal(
    (f.tmp.db.prepare('SELECT status FROM steps WHERE task_id=? AND seq=1').get(taskId) as { status: string }).status,
    'pending',
  );
});

test('§7.1 步骤 3：unknown 孤儿经 exec.reconcileCall=done → 补记结果不重放（took_result）', async () => {
  const f = fixture({
    exec: {
      async reconcileCall() {
        return 'done';
      },
      async getCallResult() {
        return { resultJson: JSON.stringify({ ok: true, data: 'exec-ledger' }) };
      },
    },
  });
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'web.click', { url: 'u' }, 'unknown');

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'took_result' }]);
  const step = f.tmp.db
    .prepare('SELECT status, result_json FROM steps WHERE task_id=? AND seq=1')
    .get(taskId) as { status: string; result_json: string };
  assert.equal(step.status, 'succeeded', '补记 succeeded，不重放');
  assert.equal(step.result_json, JSON.stringify({ ok: true, data: 'exec-ledger' }));
});

test('§7.1 步骤 3：unknown 孤儿对账仍未知 + treatUnknownAsRisk → 转审批（deferred，interrupted+approval_id）', async () => {
  const approvals: number[] = [];
  const f = fixture({
    exec: {
      async reconcileCall() {
        return 'unknown';
      },
      async getCallResult() {
        return null;
      },
    },
  });
  // 治理 forceApproval：模拟落 approvals 返回 approval_id（幂等键 = callId）
  (f.journal as unknown as { deps: { governance?: unknown } }).deps.governance = {
    async requestApproval() {
      approvals.push(1);
      return { approvalId: 7 };
    },
  };
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'web.click', { url: 'u' }, 'unknown');

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'deferred' }]);
  const step = f.tmp.db
    .prepare('SELECT status, approval_id FROM steps WHERE task_id=? AND seq=1')
    .get(taskId) as { status: string; approval_id: number | null };
  assert.equal(step.status, 'interrupted', '孤儿步转 interrupted（§5.3 审计闭环，不删）');
  assert.equal(step.approval_id, 7, '治理 approval_id 回写该步（契约 J1：journal_step=call_id）');
  assert.equal(approvals.length, 1, '请求一次审批');
  assert.equal(f.queue.getTask(taskId)!.status, 'queued');
});

// ── §7.1 步骤 4：recoverAwaiting ─────────────────────────────────

test('§7.1 步骤 4：awaiting_approval 与 paused 原样保留（不随重启丢）', async () => {
  const f = fixture();
  const a = makeRunning(f);
  // 第二个 running 直接用 SQL 造（模拟重启前已并存；maxRunningTasks 是 pop 软门控，重启不查）
  const b = f.queue.submit({ title: 'b', goal: 'g' });
  f.tmp.db.prepare("UPDATE tasks SET status='running', run_epoch=run_epoch+1 WHERE id=?").run(b.id);
  f.queue.setAwaitingApproval(a.taskId, a.epoch, 1);
  f.queue.pauseByReason(b.id, 'watermark');

  await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
    undefined,
  );

  assert.equal(f.queue.getTask(a.taskId)!.status, 'awaiting_approval');
  assert.equal(f.queue.getTask(b.id)!.status, 'paused');
});

test('§7.1 步骤 4：停机期间审批已 approved → 按 §7.4 审批续跑回 queued(resume_from_seq)', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'web.click', { url: 'u' }, 'unknown');
  f.journal.markPending(taskId, epoch, 1, 99);
  f.queue.setAwaitingApproval(taskId, epoch, 99);

  const reader: ApprovalsReader = {
    listForTask: (id) => (id === taskId ? [{ id: 99, status: 'approved' }] : []),
  };
  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
    reader,
  );

  const t = f.queue.getTask(taskId)!;
  assert.equal(t.status, 'queued', '回 queued 而非直入 running（CP §4.1 门控 1）');
  assert.equal(t.resumeFromSeq, 1, 'resume_from_seq=该 pending 步 seq');
  assert.equal(t.priority, 2, 'priority=min(priority,2)');
  assert.deepEqual(report.approvalsResumed, [{ taskId, approvalId: 99, ok: true }]);
});

test('§7.1 步骤 4：停机期间审批 denied → pending 步 skipped，任务回 queued 改道', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  f.journal.beginTool(taskId, epoch, 'web.click', { url: 'u' }, 'unknown');
  f.journal.markPending(taskId, epoch, 1, 100);
  f.queue.setAwaitingApproval(taskId, epoch, 100);

  const reader: ApprovalsReader = {
    listForTask: (id) => (id === taskId ? [{ id: 100, status: 'rejected' }] : []),
  };
  await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
    reader,
  );

  assert.equal(
    (f.tmp.db.prepare('SELECT status FROM steps WHERE task_id=? AND seq=1').get(taskId) as { status: string }).status,
    'skipped',
    '契约 J3：deny → 该 pending 步 skipped',
  );
  assert.equal(f.queue.getTask(taskId)!.status, 'queued');
});

// ── §7.1 步骤 5/6 ────────────────────────────────────────────────

test('§7.1 步骤 5：catchUpHeartbeats 统计 catchup=latest 的到期 crontab', async () => {
  const f = fixture();
  const past = Date.now() - 60_000;
  f.tmp.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire, catchup)
       VALUES('ct_hb', 'dot1', 'heartbeat', 'hb', '* * * * *', 1, ?, 'latest')`,
    )
    .run(past);
  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );
  assert.equal(report.heartbeatsCaughtUp, 1);
});

test('§7.1 步骤 6：未决策事件重放幂等（已决策短路，未决策重建）', async () => {
  const f = fixture({
    rules: [
      { id: 'r1', match: { payloadContains: 'b' }, action: 'run_new', task: { title: '重放' }, reason: '规则命中' },
    ],
  });
  const e1 = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'a' });
  const row1 = f.tmp.db.prepare('SELECT * FROM events WHERE id=?').get(e1.eventId) as Record<string, unknown>;
  f.matcher.decideAndCreate(
    { id: e1.eventId, source: 'http', dot_id: 'dot1', actor: 'u', dedup_key: null, payload: 'a', status: 'pending', received_at: Number(row1['received_at']) },
    { action: 'run_new', taskId: null, confidence: 0.9, reason: 'r', via: 'llm' },
  );
  // 第二个事件不决策（留给重启重放；规则 r1 命中它）
  f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'b' });

  const report = await recoverOnStartup(
    { db: f.tmp.db, queue: f.queue, journal: f.journal, matcher: f.matcher, guard: guardStub(f), bus: f.tmp.bus, record: noop },
    f.scheduler,
  );

  assert.equal(report.eventsReplayed, 1, '只重放未决策的那一条');
  const decisions = f.tmp.db.prepare('SELECT event_id, action FROM event_decisions').all() as Array<{ event_id: number; action: string }>;
  assert.equal(decisions.length, 2, '两条事件各一条决策，无二行（PK=event_id）');
  const tasks = f.tmp.db.prepare('SELECT id FROM tasks ORDER BY id').all() as Array<{ id: string }>;
  assert.equal(tasks.length, 2, '每个事件一个任务，无双建');
});

// ── §7.4 reclaimTask ─────────────────────────────────────────────

test('§7.4 reclaimTask(watchdog)：running → queued、attempt+1，旧 epoch 迟到写被拒', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);

  reclaimTask(
    { db: f.tmp.db, queue: f.queue, record: noop },
    taskId,
    'watchdog',
  );

  const t = f.queue.getTask(taskId)!;
  assert.equal(t.status, 'queued');
  assert.equal(t.attempt, 1);
  assert.equal(t.runEpoch, epoch, 'reclaim 自身不递增 epoch（下次 pop 再 +1）');

  // 旧协程迟到 finish → 围栏拒绝（status 已非 running，finish 前置校验拦下）
  let stale = 0;
  const queue2 = new Queue({
    db: f.tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: f.tmp.bus,
    guardLevel: () => 'normal',
    record: (kind) => {
      if (kind === 'stale_writer') stale += 1;
    },
  });
  queue2.finish(taskId, epoch, { ok: true, summary: 'late' });
  assert.ok(stale >= 1, '迟到 finish 被记 stale_writer');
  assert.equal(f.queue.getTask(taskId)!.status, 'queued', '迟到 finish 不生效');
});

test('§7.4 reclaimTask 幂等：非 running 任务第二次 reclaim 无效', async () => {
  const f = fixture();
  const { taskId } = makeRunning(f);
  reclaimTask({ db: f.tmp.db, queue: f.queue, record: noop }, taskId, 'halted');
  const after = f.queue.getTask(taskId)!;
  reclaimTask({ db: f.tmp.db, queue: f.queue, record: noop }, taskId, 'halted');
  assert.equal(f.queue.getTask(taskId)!.attempt, after.attempt, 'attempt 不再递增');
});

test('§7.4 reclaim 后 pop 拿新 epoch，原协程 heartbeat 被围栏拒', async () => {
  const f = fixture();
  const { taskId, epoch } = makeRunning(f);
  reclaimTask({ db: f.tmp.db, queue: f.queue, record: noop }, taskId, 'exec_interrupted');

  const run = f.queue.pop()!;
  assert.equal(run.id, taskId);
  assert.equal(run.runEpoch, epoch + 1, 'pop 递增 epoch');
  const hb = f.queue.heartbeat(taskId, epoch, { tokens: 10 });
  assert.equal(hb.aborted, true, '旧 epoch heartbeat 被围栏拒 → aborted');
});
