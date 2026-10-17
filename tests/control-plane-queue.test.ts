/**
 * tests/control-plane-queue.test.ts —— 队列门控 + epoch 围栏 + 审批续跑（CP §4 / §2.2 / §7.4）。
 *
 * 依据 control-plane.md：
 * - §4.1 三条硬门控：进 running 只经 pop()；paused/awaiting_approval 不占 runningCount；
 *   非法转移在 transition() 硬校验 throw。
 * - §2.2 run_epoch 围栏：每次转 running +1；Runner 回写带 epoch，0 行 → stale_writer + 拒。
 * - §4.2 pop 的排序与条件 UPDATE；§4.4 淘汰候选。
 * - §7.4 审批续跑：ok → queued + resume_from_seq（不是直入 running）；deny → 步 skipped。
 * - 契约 M3：所有终态收口点都必须调 memory.sealTask。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import type { QueueDeps } from '../src/control-plane/queue.ts';
import { evictForIncoming } from '../src/control-plane/evict.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';
import type { GuardLevel } from '../src/control-plane/guard.ts';

const tmps: TempDataDir[] = [];

/** 建一个 Queue；返回库、队列与可改写的背压档位。 */
function fixture(opts: {
  maxRunningTasks?: number;
  budgetTokens?: number;
  sealTask?: QueueDeps['sealTask'];
} = {}): {
  tmp: TempDataDir;
  queue: Queue;
  level: { value: GuardLevel };
  resCount(): number;
} {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const level = { value: 'normal' as GuardLevel };
  const queue = new Queue({
    db: tmp.db,
    cfg: {
      ...DEFAULT_CP_CONFIG,
      ...(opts.maxRunningTasks !== undefined ? { maxRunningTasks: opts.maxRunningTasks } : {}),
      ...(opts.budgetTokens !== undefined ? { budgetTokensDefault: opts.budgetTokens } : {}),
    },
    bus: tmp.bus,
    guardLevel: () => level.value,
    record: () => {},
    ...(opts.sealTask !== undefined ? { sealTask: opts.sealTask } : {}),
  });
  return {
    tmp,
    queue,
    level,
    resCount() {
      const row = tmp.db.prepare('SELECT COUNT(*) AS n FROM resource_events').get() as { n: number };
      return row.n;
    },
  };
}

/** sealTask 是 fire-and-forget（队列收口不得被它阻塞），断言前先让出微任务。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});

// ── §4.1 状态机与转移硬校验 ──────────────────────────────────────────

test('非法状态转移抛 IllegalTransitionError（CP §4.1 硬校验）', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  assert.throws(() => queue.transition(t.id, 'done'), /非法状态转移 queued → done/);
  assert.throws(() => queue.transition(t.id, 'paused'), /非法状态转移 queued → paused/);
  assert.equal(queue.transition(t.id, 'running').status, 'running');
});

test('终态不可再转移（done 的合法集合为空）', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  queue.finish(t.id, run.runEpoch, { ok: true, summary: 's' });
  assert.equal(queue.getTask(t.id)!.status, 'done');
  assert.throws(() => queue.transition(t.id, 'queued'), /非法状态转移 done → queued/);
});

// ── §4.2 pop 门控 ──────────────────────────────────────────────────

test('pop 进 running 且 run_epoch+1；并发第二次 pop 返回 null（maxRunningTasks=1）', () => {
  const { queue } = fixture();
  const a = queue.submit({ title: 'a', goal: 'a' });
  queue.submit({ title: 'b', goal: 'b' });
  const first = queue.pop();
  assert.ok(first !== null);
  assert.equal(first.status, 'running');
  assert.equal(first.runEpoch, 1, '首次 pop epoch=1');
  assert.equal(queue.runningCount('dot1'), 1);
  assert.equal(queue.pop(), null, '并发额度已满');
  assert.equal(queue.getTask(a.id)!.status, 'running');
});

test('pop 排序：priority ASC → COALESCE(run_at,created_at) ASC → resume_from_seq 优先', () => {
  const { queue } = fixture({ maxRunningTasks: 5 });
  queue.submit({ title: 'p5', goal: 'g', priority: 5 });
  queue.submit({ title: 'p9', goal: 'g', priority: 9 });
  queue.submit({ title: 'p2', goal: 'g', priority: 2 });
  const first = queue.pop()!;
  assert.equal(first.title, 'p2', 'priority 最小者先出');

  // 续跑任务优先于新任务（resume_from_seq IS NOT NULL DESC）
  const t = queue.submit({ title: 'resume', goal: 'g', priority: 8 });
  queue.transition(t.id, 'running');
  queue.onApprovalSettled(t.id, 42, true);
  const next = queue.pop()!;
  assert.equal(next.title, 'resume', '审批放行续跑优先');
});

test('pop 到点才出（run_at 未到 → null）', () => {
  const { queue } = fixture();
  queue.submit({ title: 'later', goal: 'g', runAt: Date.now() + 60_000 });
  assert.equal(queue.pop(), null);
});

test('throttled/halted 时 pop 一律 null（CP §4.2 背压门控）', () => {
  const f = fixture();
  f.queue.submit({ title: 't1', goal: 'g' });
  f.level.value = 'guarded';
  assert.ok(f.queue.pop() !== null, 'guarded 允许 pop');
  f.level.value = 'throttled';
  f.queue.submit({ title: 't2', goal: 'g' });
  assert.equal(f.queue.pop(), null, 'throttled 停 pop');
  f.level.value = 'halted';
  assert.equal(f.queue.pop(), null, 'halted 停 pop');
});

// ── §2.2 epoch 围栏 / stale_writer ─────────────────────────────────

test('迟到 Runner 的 heartbeat/finish 被围栏拒并记 stale_writer', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  let recorded = 0;
  const queue = new Queue({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {
      recorded += 1;
    },
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!; // epoch 1

  // 迟到 Runner 用旧 epoch（0）回写
  assert.equal(queue.heartbeat(t.id, 0, { tokens: 1 }).aborted, true, '围栏拒 → aborted');
  queue.finish(t.id, 0, { ok: true, summary: 'late' });
  assert.equal(queue.getTask(t.id)!.status, 'running', '迟到 finish 未生效');
  assert.ok(recorded >= 2, `至少 heartbeat+finish 两次 stale_writer，实际 ${recorded}`);

  // 正确 epoch 才能收口
  queue.finish(t.id, run.runEpoch, { ok: true, summary: 'ok' });
  assert.equal(queue.getTask(t.id)!.status, 'done');
});

test('reclaimInFlight 后旧 epoch 迟到写被拒；epoch 保持、下次 pop 再 +1', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  assert.equal(queue.reclaimInFlight(t.id, run.runEpoch, 'watchdog'), true);
  const after = queue.getTask(t.id)!;
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 1);
  assert.equal(after.priority, Math.min(after.priority, 2));
  assert.equal(after.lastHeartbeatAt, null);
  assert.equal(after.runEpoch, run.runEpoch, 'epoch 保持，等下次 pop 再 +1');

  queue.finish(t.id, run.runEpoch, { ok: true, summary: 'late' });
  assert.equal(queue.getTask(t.id)!.status, 'queued', '旧协程迟到 finish 被拒');

  const again = queue.pop()!;
  assert.equal(again.runEpoch, run.runEpoch + 1);
});

test('heartbeat 累计 usage 并在超预算时置 budget_exhausted + 只发一次总线', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const queue = new Queue({
    db: tmp.db,
    cfg: { ...DEFAULT_CP_CONFIG, budgetTokensDefault: 100 },
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {},
  });
  let events = 0;
  tmp.bus.on('task.budget_exhausted', () => {
    events += 1;
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  assert.equal(queue.heartbeat(t.id, run.runEpoch, { tokens: 60 }).overBudget, false);
  assert.equal(queue.heartbeat(t.id, run.runEpoch, { tokens: 60 }).overBudget, true);
  assert.equal(queue.getTask(t.id)!.usageTokens, 120);
  assert.equal(events, 1, '超预算只发一次总线');
});

// ── §4.1 门控 2：paused / awaiting_approval 不占 runningCount ────────

test('awaiting_approval 不占 runningCount；放行回 queued 而非直入 running', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  queue.setAwaitingApproval(t.id, run.runEpoch, 7);
  assert.equal(queue.runningCount('dot1'), 0, 'awaiting_approval 不占额度');
  assert.equal(queue.pop(), null);

  queue.onApprovalSettled(t.id, 7, true);
  const after = queue.getTask(t.id)!;
  assert.equal(after.status, 'queued', 'CP §4.1 门控 1：不是直入 running');
  assert.equal(after.priority, Math.min(after.priority, 2));

  const again = queue.pop()!;
  assert.equal(again.runEpoch, run.runEpoch + 1, '重新排队的任务也经 pop 拿新 epoch');
});

test('pauseByReason 与 pauseDotQueue/resumeDotQueue（circuit_open 而非 waiting_model）', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  queue.pop()!;
  queue.pauseByReason(t.id, 'circuit_open');
  assert.equal(queue.getTask(t.id)!.status, 'paused');
  assert.equal(queue.getTask(t.id)!.stopReason, 'circuit_open');
  assert.equal(queue.runningCount('dot1'), 0, 'paused 不占额度');

  queue.resume(t.id);
  assert.equal(queue.getTask(t.id)!.stopReason, null);
  assert.equal(queue.getTask(t.id)!.status, 'queued');

  queue.pop()!;
  queue.pauseDotQueue('dot1');
  assert.equal(queue.getTask(t.id)!.status, 'paused');
  queue.resumeDotQueue('dot1');
  assert.equal(queue.getTask(t.id)!.status, 'queued');
});

// ── §4.2 finish 重试与退避 ─────────────────────────────────────────

test('finish 失败 attempt<max → queued(attempt+1, 退避)；≥max → failed', () => {
  const { tmp, queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  let epoch = queue.pop()!.runEpoch;
  // 「退避到未来」的判据取 finish **之前**的时刻 t0：run_at = now + backoff(>0)
  // 必 > t0，恒真且不受中间耗时影响。
  // 不能取断言处的 Date.now()——那等价于要求「finish 到断言之间耗时 < backoff」，
  // 全量并发跑时该测试会被同文件其他 test 的重活拖过 backoff 窗口而**假失败**
  // （本机 807 全量跑实测：此测试耗时 7396ms，单文件跑仅 202ms）。
  // backoff 退化成 0 / 负数由下一条 pop()===null 的行为断言兜底抓住。
  const t0 = Date.now();
  queue.finish(t.id, epoch, { ok: false, summary: 'boom' });
  const q = queue.getTask(t.id)!;
  assert.equal(q.status, 'queued');
  assert.equal(q.attempt, 1);
  assert.ok(q.runAt !== null && q.runAt > t0, '退避到未来');
  assert.equal(queue.pop(), null, '退避未到点不重领');

  // 把 run_at 拨到现在再领（退避语义已在上面断言过）
  tmp.db.prepare('UPDATE tasks SET run_at=NULL WHERE id=?').run(t.id);
  epoch = queue.pop()!.runEpoch;
  assert.equal(epoch, 2);
  assert.equal(queue.getTask(t.id)!.attempt, 1);
  queue.finish(t.id, epoch, { ok: false, summary: 'boom2' });
  assert.equal(queue.getTask(t.id)!.attempt, 2);

  tmp.db.prepare('UPDATE tasks SET run_at=NULL WHERE id=?').run(t.id);
  epoch = queue.pop()!.runEpoch;
  queue.finish(t.id, epoch, { ok: false, summary: 'boom3' });
  assert.equal(queue.getTask(t.id)!.status, 'failed', 'attempt 用尽 → failed');
});

// ── 契约 M3：所有终态收口必须调 sealTask ────────────────────────────

test('契约 M3：done / cancel / failed / queue_evict 都调 sealTask', async () => {
  const sealed: Array<{ taskId: string; outcome: string; reason?: string }> = [];
  const { tmp, queue } = fixture({
    sealTask: async (task, outcome, reason) => {
      sealed.push({ taskId: task.id, outcome, reason });
    },
  });
  const t1 = queue.submit({ title: 'done', goal: 'g' });
  queue.finish(t1.id, queue.pop()!.runEpoch, { ok: true, summary: 's' });
  await flush();
  assert.equal(sealed.at(-1)?.outcome, 'done');

  const t2 = queue.submit({ title: 'cancel', goal: 'g' });
  queue.cancel(t2.id, 'user');
  await flush();
  assert.equal(sealed.at(-1)?.outcome, 'cancelled');
  assert.equal(sealed.at(-1)?.reason, 'user');

  const t3 = queue.submit({ title: 'fail', goal: 'g' });
  let epoch = queue.pop()!.runEpoch;
  queue.finish(t3.id, epoch, { ok: false, summary: 'x' });
  for (let i = 0; i < 2; i += 1) {
    tmp.db.prepare('UPDATE tasks SET run_at=NULL WHERE id=?').run(t3.id);
    epoch = queue.pop()!.runEpoch;
    queue.finish(t3.id, epoch, { ok: false, summary: 'x' });
  }
  await flush();
  assert.equal(queue.getTask(t3.id)!.status, 'failed');
  assert.equal(sealed.at(-1)?.outcome, 'failed');

  const t4 = queue.submit({ title: 'evict', goal: 'g' });
  queue.cancelDirect(t4.id, 'user');
  await flush();
  assert.equal(sealed.at(-1)?.taskId, t4.id);
  assert.equal(sealed.at(-1)?.outcome, 'cancelled');
});

// ── bindSession（契约 M2：唯一回写通道）────────────────────────────

test('bindSession 写 session_id ≡ thread_id 且带围栏', () => {
  const { queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  queue.bindSession(t.id, run.runEpoch, { sessionId: 'th_1', threadId: 'th_1' });
  assert.equal(queue.getTask(t.id)!.sessionId, 'th_1');
  assert.equal(queue.getTask(t.id)!.threadId, 'th_1');
  // 旧 epoch 迟到写被拒（列不变）
  queue.bindSession(t.id, 0, { sessionId: 'th_bad', threadId: 'th_bad' });
  assert.equal(queue.getTask(t.id)!.threadId, 'th_1');
});

// ── 审批 deny：步 skipped（契约 J3 / CP §7.4）──────────────────────

test('审批 deny → pending 步 skipped + 任务回 queued 改道', () => {
  const { tmp, queue } = fixture();
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  tmp.db
    .prepare(
      `INSERT INTO steps(task_id, seq, kind, status, call_id, tool_name, args_json,
                         result_json, side_effect, run_epoch, approval_id, started_at, finished_at)
       VALUES(?,1,'tool','pending','call_x','shop.checkout','{}',NULL,'unknown',?,99,?,NULL)`,
    )
    .run(t.id, run.runEpoch, Date.now());
  queue.setAwaitingApproval(t.id, run.runEpoch, 99);
  queue.onApprovalSettled(t.id, 99, false, { note: '主人拒绝' });
  const step = tmp.db.prepare('SELECT status FROM steps WHERE call_id=?').get('call_x') as {
    status: string;
  };
  assert.equal(step.status, 'skipped');
  assert.equal(queue.getTask(t.id)!.status, 'queued');
});

// ── 队列淘汰（CP §4.4）────────────────────────────────────────────

test('evictForIncoming 只淘汰 queued 且 source_event_id 非空的自动任务', () => {
  const { tmp, queue } = fixture();
  queue.submit({ title: 'auto1', goal: 'g', priority: 9, sourceEventId: 1 });
  queue.submit({ title: 'auto2', goal: 'g', priority: 3, sourceEventId: 2 });
  const manual = queue.submit({ title: 'manual', goal: 'g', priority: 9 });

  const victims = evictForIncoming(tmp.db, DEFAULT_CP_CONFIG, queue, 'dot1', {
    record: () => {},
    bus: tmp.bus,
  });
  assert.deepEqual(victims, ['tk_ev_1'], 'priority 最大（最低优先）且最旧者先淘汰');
  assert.equal(queue.getTask('tk_ev_1')!.status, 'cancelled');
  assert.equal(queue.getTask('tk_ev_1')!.stopReason, 'user');
  assert.equal(queue.getTask('tk_ev_2')!.status, 'queued');
  assert.equal(queue.getTask(manual.id)!.status, 'queued', '手动任务永不入候选');
});
