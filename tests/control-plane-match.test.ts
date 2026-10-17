/**
 * tests/control-plane-match.test.ts —— 事件匹配幂等 + 置信度分档 + taskImpact（CP §6）。
 *
 * 依据 control-plane.md：
 * - §6.1 幂等核心：「建任务 + 写 event_decisions」必须在同一 BEGIN IMMEDIATE 事务；
 *   task 主键由 deterministicTaskId(event.id) 派生 → 崩溃重放撞 PK → 事务回滚，
 *   绝不双建（修 issue #1）。
 * - §6.2 置信度分档：规则命中恒 1.0；≥0.85 直接执行；0.55–0.85 执行+通知；
 *   <0.55 → ignore + events.status='inbox'。
 * - 契约 E1/E2：dedup_key UNIQUE 幂等；events.status 取值 pending/matched/ignored/inbox。
 * - 契约 T2：taskImpact 字段名 snake_case（queued_primary/running/held）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Matcher } from '../src/control-plane/match.ts';
import type { EventRule, LowBrain } from '../src/control-plane/match.ts';
import { AllEndpointsDownError } from '../src/shared/errors.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';

const tmps: TempDataDir[] = [];

function fixture(opts: { rules?: EventRule[]; lowBrain?: LowBrain; maxQueued?: number } = {}): {
  tmp: TempDataDir;
  queue: Queue;
  matcher: Matcher;
} {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = {
    ...DEFAULT_CP_CONFIG,
    ...(opts.maxQueued !== undefined ? { maxQueued: opts.maxQueued } : {}),
  };
  const queue = new Queue({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: (kind, level, detail) => {
      tmp.db
        .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
        .run(Date.now(), level, kind, detail);
    },
  });
  const matcher = new Matcher({
    db: tmp.db,
    cfg,
    queue,
    bus: tmp.bus,
    rules: opts.rules ?? [],
    ...(opts.lowBrain !== undefined ? { lowBrain: opts.lowBrain } : {}),
    wake: () => {},
    record: (kind, level, detail) => {
      tmp.db
        .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
        .run(Date.now(), level, kind, detail);
    },
  });
  return { tmp, queue, matcher };
}

/** 低智能模型 stub：按脚本返回 JSON 串。 */
function lowBrainOf(script: ReadonlyArray<string | Error>): LowBrain & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async complete() {
      const next = script[state.calls];
      state.calls += 1;
      if (next === undefined) throw new Error('脚本耗尽');
      if (next instanceof Error) throw next;
      return { response: { content: next } };
    },
  };
}

const taskCount = (tmp: TempDataDir): number =>
  (tmp.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

const decisionOf = (tmp: TempDataDir, eventId: number): Record<string, unknown> | null =>
  (tmp.db.prepare('SELECT * FROM event_decisions WHERE event_id=?').get(eventId) as
    | Record<string, unknown>
    | undefined) ?? null;

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});

// ── 契约 E1/E2：ingestEvent 去重 ──────────────────────────────────

test('ingestEvent 撞 dedup_key → 幂等返回 {dup:true}，不重入管线', () => {
  const { matcher, tmp } = fixture();
  const a = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: { x: 1 }, dedupKey: 'k1' });
  const b = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: { x: 1 }, dedupKey: 'k1' });
  assert.equal(a.dup, false);
  assert.equal(b.dup, true);
  assert.equal(b.eventId, a.eventId, '返回同一 event 行 id');
  const n = (tmp.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  assert.equal(n, 1);
});

test('ingestEvent 无 dedup_key 时允许多条（NULL 互不冲突）', () => {
  const { matcher, tmp } = fixture();
  matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p1' });
  matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p2' });
  assert.equal((tmp.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 2);
});

// ── §6.1 幂等核心：deterministicTaskId 防双建 ──────────────────────

test('§6.1 同一事件重复 decideAndCreate → 只建一个任务（PK=event_id 派生）', () => {
  const { matcher, tmp } = fixture({
    rules: [{ id: 'r1', match: { source: 'http' }, action: 'run_new', task: { title: 'T', goal: 'G' }, reason: '命中' }],
  });
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  // 直接构造 EventRow 形状（snake_case）
  const e = {
    id: eventId,
    source: 'http' as const,
    dot_id: 'dot1',
    actor: 'u',
    dedup_key: null,
    payload: 'p',
    status: 'pending' as const,
    received_at: Number(row['received_at']),
  };
  const m = matcher.matchByRule(e)!;
  assert.ok(m !== null);
  const d1 = matcher.decideAndCreate(e, m);
  assert.equal(d1.action, 'run_new');
  assert.equal(taskCount(tmp), 1);

  // 崩溃重放：同一 event 再跑一次（hasDecision 短路）
  const d2 = matcher.decideAndCreate(e, m);
  assert.equal(d2.eventId, d1.eventId);
  assert.equal(taskCount(tmp), 1, '绝不双建');
  assert.equal(decisionOf(tmp, eventId)!['action'], 'run_new');
});

test('§6.1 任务主键 = tk_ev_<events.id>（确定性派生）', () => {
  const { matcher, tmp } = fixture({
    rules: [{ id: 'r1', match: { source: 'telegram' }, action: 'run_new', reason: 'x' }],
  });
  const { eventId } = matcher.ingestEvent({ source: 'telegram', dotId: 'dot1', actor: 'u', payload: 'hi' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  matcher.decideAndCreate(
    {
      id: eventId,
      source: 'telegram',
      dot_id: 'dot1',
      actor: 'u',
      dedup_key: null,
      payload: 'hi',
      status: 'pending',
      received_at: Number(row['received_at']),
    },
    matcher.matchByRule({
      id: eventId,
      source: 'telegram',
      dot_id: 'dot1',
      actor: 'u',
      dedup_key: null,
      payload: 'hi',
      status: 'pending',
      received_at: Number(row['received_at']),
    })!,
  );
  const ids = (tmp.db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids, [`tk_ev_${eventId}`]);
  assert.equal(
    (tmp.db.prepare('SELECT source_event_id FROM tasks WHERE id=?').get(`tk_ev_${eventId}`) as {
      source_event_id: number;
    }).source_event_id,
    eventId,
    'source_event_id 弱引用 events.id（淘汰候选判据）',
  );
});

test('§6.1 重启重放：已决策事件被 exists 短路，未决策的重跑幂等事务', () => {
  const { matcher, tmp } = fixture({
    rules: [{ id: 'r1', match: { source: 'http' }, action: 'run_new', reason: 'x' }],
  });
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  matcher.processEvent; // 引用避免未使用告警
  // 手动决策（模拟上一世代已处理）
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  const e = {
    id: eventId,
    source: 'http' as const,
    dot_id: 'dot1',
    actor: 'u',
    dedup_key: null,
    payload: 'p',
    status: 'pending' as const,
    received_at: Number(row['received_at']),
  };
  matcher.decideAndCreate(e, matcher.matchByRule(e)!);
  assert.equal(taskCount(tmp), 1);

  // 重启：replayUndecidedEvents 只扫未决策事件 → 无新增
  matcher.replayUndecidedEvents();
  assert.equal(taskCount(tmp), 1);
  assert.equal(matcher.listUndecidedEvents().length, 0, '已 matched 的事件不在未决策集');
});

// ── §6.2 置信度分档 ──────────────────────────────────────────────

test('§6.2 规则命中恒 confidence=1.0、零成本可解释', () => {
  const { matcher, tmp } = fixture({
    rules: [{ id: 'r1', match: { source: 'file', payloadContains: '发票' }, action: 'run_new', reason: '规则命中' }],
  });
  const { eventId } = matcher.ingestEvent({ source: 'file', dotId: 'dot1', actor: 'scan', payload: 'x 发票 y' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  const m = matcher.matchByRule({
    id: eventId,
    source: 'file',
    dot_id: 'dot1',
    actor: 'scan',
    dedup_key: null,
    payload: 'x 发票 y',
    status: 'pending',
    received_at: Number(row['received_at']),
  })!;
  assert.equal(m.confidence, 1.0);
  assert.equal(m.via, 'rule');
});

test('§6.2 <0.55 → 只写 ignore + events.status=inbox（不建任务）', () => {
  const { matcher, tmp } = fixture({ lowBrain: lowBrainOf(['{"action":"run_new","confidence":0.3,"reason":"不确定"}']) });
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  const e = {
    id: eventId,
    source: 'http' as const,
    dot_id: 'dot1',
    actor: 'u',
    dedup_key: null,
    payload: 'p',
    status: 'pending' as const,
    received_at: Number(row['received_at']),
  };
  // 规则未命中 → 走模型层
  const m = matcher.matchByRule(e);
  assert.equal(m, null);
  const d = matcher.decideAndCreate(e, {
    action: 'run_new',
    taskId: null,
    confidence: 0.3,
    reason: '不确定',
    via: 'llm',
    dotId: 'dot1',
  });
  assert.equal(d.action, 'ignore');
  assert.equal(taskCount(tmp), 0, '低置信度不建任务');
  assert.equal((tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status, 'inbox');
});

test('§6.2 0.55–0.85 → 执行 + 通知（可撤销）', () => {
  const { matcher, tmp } = fixture();
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  const d = matcher.decideAndCreate(
    {
      id: eventId,
      source: 'http',
      dot_id: 'dot1',
      actor: 'u',
      dedup_key: null,
      payload: 'p',
      status: 'pending',
      received_at: Number(row['received_at']),
    },
    { action: 'run_new', taskId: null, confidence: 0.7, reason: '中置信', via: 'llm', dotId: 'dot1' },
  );
  assert.equal(d.action, 'run_new', '中置信度仍执行');
  assert.equal(taskCount(tmp), 1);
  assert.equal((tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status, 'matched');
});

test('§6.2 模型层全灭（AllEndpointsDownError）→ 不建决策，事件留 inbox', async () => {
  const brain = lowBrainOf([new AllEndpointsDownError(['primary', 'backup'])]);
  const { matcher, tmp } = fixture({ lowBrain: brain });
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  const r = await matcher.processEvent(eventId);
  assert.equal(r, null);
  assert.equal(taskCount(tmp), 0);
  assert.equal(decisionOf(tmp, eventId), null, '不写 event_decisions');
  assert.equal((tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status, 'inbox');
});

test('§6.2 merge 目标已终态 → 退化 run_new', () => {
  const { matcher, tmp, queue } = fixture();
  const dead = queue.submit({ title: 'dead', goal: 'g' });
  queue.finish(dead.id, queue.pop()!.runEpoch, { ok: true, summary: 's' });
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string, unknown>;
  const d = matcher.decideAndCreate(
    {
      id: eventId,
      source: 'http',
      dot_id: 'dot1',
      actor: 'u',
      dedup_key: null,
      payload: 'p',
      status: 'pending',
      received_at: Number(row['received_at']),
    },
    { action: 'merge', taskId: dead.id, confidence: 0.9, reason: '并入', via: 'llm', dotId: 'dot1' },
  );
  assert.equal(d.action, 'run_new', '退化');
  assert.equal(taskCount(tmp), 2, '原终态任务 + 新建任务');
});

// ── §4.4 队列满 → 淘汰腾位 ───────────────────────────────────────

test('§4.4 queued 达上限且无 merge 目标 → 淘汰自动任务后建新任务', () => {
  const { matcher, tmp } = fixture({ maxQueued: 2 });
  // 先造 2 个 queued 的自动任务占满（dot2；与新事件不同 dot，使 merge 无目标）
  const e1 = matcher.ingestEvent({ source: 'http', dotId: 'dot2', actor: 'u', payload: 'p1' });
  const e2 = matcher.ingestEvent({ source: 'http', dotId: 'dot2', actor: 'u', payload: 'p2' });
  for (const eid of [e1.eventId, e2.eventId]) {
    const row = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(eid) as Record<string, unknown>;
    matcher.decideAndCreate(
      { id: eid, source: 'http', dot_id: 'dot2', actor: 'u', dedup_key: null, payload: 'p', status: 'pending', received_at: Number(row['received_at']) },
      { action: 'run_new', taskId: null, confidence: 0.9, reason: 'r', via: 'llm', dotId: 'dot2' },
    );
  }
  assert.equal(taskCount(tmp), 2);

  // 第三个：queued 已满且同 dot 无 merge 目标 → 淘汰候选队首自动任务
  const e3 = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p3' });
  const row3 = tmp.db.prepare('SELECT * FROM events WHERE id=?').get(e3.eventId) as Record<string, unknown>;
  matcher.decideAndCreate(
    { id: e3.eventId, source: 'http', dot_id: 'dot1', actor: 'u', dedup_key: null, payload: 'p', status: 'pending', received_at: Number(row3['received_at']) },
    { action: 'run_new', taskId: null, confidence: 0.9, reason: 'r', via: 'llm', dotId: 'dot1' },
  );
  const statuses = (tmp.db.prepare('SELECT id, status FROM tasks ORDER BY created_at').all() as Array<{ id: string; status: string }>);
  assert.equal(statuses.length, 3);
  assert.equal(statuses.filter((s) => s.status === 'cancelled').length, 1, '淘汰了一个');
  assert.equal(statuses.filter((s) => s.status === 'queued').length, 2, '队列回落到上限内');
  // 淘汰记了 resource_events(kind='queue_evict')
  const evicted = (tmp.db.prepare("SELECT COUNT(*) AS n FROM resource_events WHERE kind='queue_evict'").get() as { n: number }).n;
  assert.equal(evicted, 1);
});

// ── 契约 T2：taskImpact snake_case ───────────────────────────────

test('契约 T2：taskImpact = {queued_primary, running, held}（held = awaiting+paused）', () => {
  const { matcher, queue } = fixture();
  // 一个先被 pop 走、随后转 awaiting_approval 的任务（held）
  const r = queue.submit({ title: 'run', goal: 'g', priority: 8 });
  assert.equal(queue.pop()?.id, r.id, 'pop 领走 run');
  // 一个 queued 且 priority<=2（算 queued_primary）
  queue.submit({ title: 'p1', goal: 'g', priority: 1 });
  // 一个 queued priority=9（不算 queued_primary）
  queue.submit({ title: 'p9', goal: 'g', priority: 9 });
  // 一个 paused（held）
  const p = queue.submit({ title: 'pause', goal: 'g' });
  queue.pauseByReason(p.id, 'watermark');
  // awaiting_approval：held 计入（不占 running/queued_primary）
  queue.setAwaitingApproval(r.id, queue.currentEpoch(r.id)!, 1);

  assert.deepEqual(matcher.taskImpact(), {
    queued_primary: 1,
    running: 0,
    held: 2,
  });
});

// ── retryMatch（CP §6.2 手动覆写） ──────────────────────────────

test('retryMatch 以 via=manual UPSERT 覆写旧决策', () => {
  const { matcher, tmp } = fixture();
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'p' });
  matcher.retryMatch(eventId, {
    eventId,
    action: 'run_new',
    taskId: null,
    confidence: 1,
    reason: '主人手动',
    via: 'manual',
    decidedAt: Date.now(),
  });
  const d = decisionOf(tmp, eventId)!;
  assert.equal(d['via'], 'manual');
  assert.equal(d['action'], 'run_new');
  assert.equal(taskCount(tmp), 1);
});

// ── camelCase 投影（审码 finding：原来 as unknown as 把 snake_case 行当 camelCase 返回）──

test('listUndecidedEvents 返回契约 E1 的 camelCase EventsRow（dotId 有值，非 undefined）', () => {
  const { matcher } = fixture();
  const { eventId } = matcher.ingestEvent({
    source: 'http',
    dotId: 'dot-alpha',
    actor: 'someone',
    payload: '{"k":1}',
  });
  const rows = matcher.listUndecidedEvents(10);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.id, eventId);
  assert.equal(r.dotId, 'dot-alpha', 'camelCase dotId 必须拿到 DB 列 dot_id 的值');
  assert.equal(r.source, 'http');
  assert.equal(r.actor, 'someone');
  assert.equal(r.payload, '{"k":1}');
  assert.equal(r.status, 'pending');
  assert.ok(typeof r.receivedAt === 'number');
  // snake_case 键不应残留在投影结果上
  assert.equal((r as unknown as { dot_id?: string }).dot_id, undefined);
});

test('toEventRow 逐字段投影 snake_case EventRow（消费方读 dotId 有值）', () => {
  const { matcher } = fixture();
  const { eventId } = matcher.ingestEvent({ source: 'http', dotId: 'dot-beta', actor: 'a', payload: 'p' });
  const camel = matcher.listUndecidedEvents(10)[0]!;
  const snake = matcher.toEventRow(camel);
  assert.equal(snake.id, eventId);
  assert.equal(snake.dot_id, 'dot-beta');
  assert.equal(snake.source, 'http');
  assert.equal(snake.actor, 'a');
  assert.equal(snake.payload, 'p');
  assert.equal(snake.status, 'pending');
  assert.ok(typeof snake.received_at === 'number');
  // 规则层消费 snake 行：source 匹配能命中（证明投影值可用，不是 undefined）
  const m = matcher.matchByRule(snake);
  assert.equal(m, null, '无规则时返回 null');
});
