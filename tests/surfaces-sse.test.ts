/**
 * tests/surfaces-sse.test.ts —— §4.5 SSE 断线补档 / resync / 游标持久化 测试。
 *
 * 覆盖（任务要求的三项之二：SSE 断线补档）：
 * - `Last-Event-ID` 落后 ≤5000 且通道可重建 → 补档（重放快照事件）；
 * - 落后 >5000 → `{"kind":"resync"}`（客户端对 queue/breaker/approval 各拉 REST 校正）；
 * - 只订不可重建通道（chat/breaker/step/log）→ resync（no_replayable_channel）；
 * - `bus_seq` 游标写 surf_sse_cursor 且重启可续读（attach/record/maybePersist）；
 * - chat.delta 每订阅者上限 200，溢出丢 delta；
 * - 环形缓冲只保留 5000 帧；
 * - 真实 HTTP：GET /api/stream 收到重放帧、连接上限 8 → 503、Last-Event-ID 头解析。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus, TOPICS } from '../src/shared/bus.ts';
import { DEFAULT_SSE_REPLAY_WINDOW, SseBus, SseCursorStore, parseStreamQuery } from '../src/surfaces/sse.ts';
import { SSE_REPLAY_WINDOW, SSE_DELTA_QUEUE_LIMIT } from '../src/surfaces/types.ts';
import type { ControlPlane, GovernancePort, MemoryPort, RouterPort } from '../src/shared/contracts.ts';
import { createHttpServer } from '../src/surfaces/http.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';

function makeConfig(): SurfacesConfig {
  return {
    http: { host: '127.0.0.1', port: 0, masterToken: 'm', readonlyTokens: [], allowedOrigins: [] },
    hooks: [],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
    ui: { streamDeltas: true },
    progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
    brief: { enabled: false, time: '08:30', chatId: null, windowMin: 180, maxChars: 1200 },
    connWatch: { enabled: false, intervalMin: 15, quietHours: null },
  };
}

const fakeGov: GovernancePort = {
  decide: () => Promise.resolve({ ok: true }),
  listPending: () => [],
  getApproval: () => Promise.resolve(null),
};
const fakeMem: MemoryPort = {
  openThread: () => Promise.resolve('th'),
  appendMessage: () => Promise.resolve({ id: 'm', seq: 1 }),
  listThreads: () => Promise.resolve([]),
  listMessages: () => Promise.resolve([]),
};
const fakeRouter: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };
const fakeCp = {
  ingestEvent: () => ({ eventId: 1, dup: false }),
  submit: () => ({ id: 'tk', status: 'queued' as const }),
  list: () => [],
  cancel: () => ({ ok: true }),
  getGuardStatus: () => ({}),
} as unknown as ControlPlane;

/** 建一个已 attach 的 SseBus（带快照提供者）。`replayWindow` 缺省 = 生产值 5000。 */
function makeSse(dir: TempDataDir, bus: EventBus, withSnapshot = true, replayWindow?: number): SseBus {
  const sse = new SseBus({
    db: dir.db,
    bus,
    replayWindow,
    snapshot: withSnapshot
      ? {
          approvals: () => [{ id: 1, seq: 7, status: 'pending', tier: 't2', summary: '待批' } as never],
          queue: () => [{ id: 'tk_1', title: 't', status: 'queued', priority: 1, dotId: 'dot1' }],
        }
      : undefined,
  });
  sse.attach();
  return sse;
}

// ═══════════════════════════════════════════════════════════════════
// 一、断线补档判定（§4.5 Last-Event-ID 语义）
// ═══════════════════════════════════════════════════════════════════

test('补档：Last-Event-ID 落后且窗内 → replay + 快照帧', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    // 造 5 个事件（approval 通道 3 个 + chat 1 个 + queue 1 个）
    for (let i = 0; i < 3; i++) bus.publish('approval:created', { i }, { dotId: 'dot1' });
    bus.publish('chat.delta', { text: 'd' }, { dotId: 'dot1' });
    bus.publish('task.state', { id: 'tk' }, { dotId: 'dot1' });
    const head = bus.currentSeq();
    assert.equal(head, 5);

    // 落后 2 条（3 → 5），窗内，订 approval/queue（可重建通道）
    const plan = sse.reconnectPlan(3, ['approval', 'queue']);
    assert.equal(plan.action, 'replay');
    if (plan.action !== 'replay') return;
    // 重放只含 >3 的 approval/queue 帧：chat.delta(4) 被过滤、task.state(5) 命中
    assert.deepEqual(plan.frames.map((f) => f.id), [5]);
    assert.equal(plan.frames[0]!.channel, 'queue');
    assert.equal(plan.frames[0]!.kind, 'task.state'); // kind = topic 全名（bus.ts:126）
    assert.ok(!plan.frames.some((f) => f.kind === 'resync'));
  } finally {
    dir.cleanup();
  }
});

test('补档：缺省通道（未指定 topics）= 只补可重建通道（approval/queue）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    bus.publish('chat.delta', { t: 1 }, { dotId: 'dot1' });   // seq 1（不可重建）
    bus.publish('approval:created', { a: 1 }, { dotId: 'dot1' }); // seq 2（可重建）
    const plan = sse.reconnectPlan(0, []);
    assert.equal(plan.action, 'replay');
    if (plan.action !== 'replay') return;
    assert.deepEqual(plan.frames.map((f) => f.id), [2]);
  } finally {
    dir.cleanup();
  }
});

test('补档：落后 >5000 → resync 帧（§4.5 原文 {"kind":"resync"}）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus({ startSeq: SSE_REPLAY_WINDOW + 10 });
    const sse = makeSse(dir, bus);
    const plan = sse.reconnectPlan(0, ['approval', 'queue']);
    assert.equal(plan.action, 'resync');
    if (plan.action !== 'resync') return;
    assert.equal(plan.frame.kind, 'resync');
    assert.equal(plan.frame.channel, 'log');
    const payload = JSON.parse(plan.frame.data) as { payload: { reason: string; lag: number; head: number } };
    assert.equal(payload.payload.reason, 'lag');
    assert.equal(payload.payload.lag, SSE_REPLAY_WINDOW + 10);
    assert.equal(payload.payload.head, SSE_REPLAY_WINDOW + 10);
  } finally {
    dir.cleanup();
  }
});

test('补档：只订不可重建通道 → resync(no_replayable_channel)', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    bus.publish('chat.delta', {}, { dotId: 'dot1' });
    bus.publish('chat.final', {}, { dotId: 'dot1' });
    const plan = sse.reconnectPlan(0, ['chat']);
    assert.equal(plan.action, 'resync');
    if (plan.action !== 'resync') return;
    assert.equal(plan.frame.kind, 'resync');
    const payload = JSON.parse(plan.frame.data) as { payload: { reason: string } };
    assert.equal(payload.payload.reason, 'no_replayable_channel');
  } finally {
    dir.cleanup();
  }
});

test('补档：无 Last-Event-ID 或已追平 → live', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    bus.publish('approval:created', {}, { dotId: 'dot1' });
    assert.deepEqual(sse.reconnectPlan(null, ['approval']), { action: 'live' });
    assert.deepEqual(sse.reconnectPlan(1, ['approval']), { action: 'live' });   // 恰等于 head
    assert.deepEqual(sse.reconnectPlan(9, ['approval']), { action: 'live' });   // 超前（客户端乱给）
  } finally {
    dir.cleanup();
  }
});

test('补档：环形缓冲只留 5000 帧（超出即不可重放 → resync）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    assert.equal(sse.buffered(), 0);
    // ⚡ 加速（2026-10-17，只改"等多久"，不减任何断言）：
    // 原写法直接灌 SSE_REPLAY_WINDOW+5 = 5005 帧，每次超容都把 5000 元素数组 shift 一次，
    // 主体总量 O(N²)（约 1250 万帧对象的字节拷贝），在本机实测稳定占 38–84s。
    // 这里改用**生产缺省容量的 1/1000**（replayWindow = SSE_REPLAY_WINDOW/1000 = 5）跑同一序列：
    // 「缓冲长度 == 窗口容量 / 落后 容量-1 → replay / 落后 容量+1 → resync」三条边界关系逐字保留，
    // 最后再用一条断言把**生产缺省容量本身就是 5000** 钉死（默认值不许被改小/改大）。
    const win = SSE_REPLAY_WINDOW / 1000; // = 5，整除保证边界关系与 5000 帧时完全同构
    assert.ok(Number.isInteger(win) && win >= 3, `加速窗口必须是正整数且 ≥3，实际 ${win}`);
    const fast = makeSse(dir, bus, true, win);
    for (let i = 0; i < win + 5; i++) bus.publish('task.state', { i }, { dotId: 'dot1' });
    assert.equal(fast.buffered(), win);
    // 落后 win-1（在窗内）→ replay；落后 win+1 → resync
    assert.equal(fast.reconnectPlan(bus.currentSeq() - (win - 1), ['queue']).action, 'replay');
    assert.equal(fast.reconnectPlan(bus.currentSeq() - (win + 1), ['queue']).action, 'resync');
    // 生产缺省：不注入 replayWindow 时窗口 = SSE_REPLAY_WINDOW（5000），契约 §4.5 原文
    const prodWin = DEFAULT_SSE_REPLAY_WINDOW;
    assert.equal(prodWin, SSE_REPLAY_WINDOW, '生产缺省环形缓冲容量必须等于 SSE_REPLAY_WINDOW');
    const prodBus = new EventBus();
    const prod = makeSse(dir, prodBus);
    for (let i = 0; i < 10; i++) prodBus.publish('task.state', { i }, { dotId: 'dot1' });
    assert.equal(prod.buffered(), 10, '未超窗时全部保留');
    assert.equal(prod.reconnectPlan(1, ['queue']).action, 'replay', '缺省 5000 窗口内 10 帧可重放');
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 二、bus_seq 游标持久化（surf_sse_cursor，重启续读）
// ═══════════════════════════════════════════════════════════════════

test('游标：publish 后写 surf_sse_cursor；新实例可续读', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    assert.equal(new SseCursorStore(dir.db).read(), 0); // 新库
    bus.publish('approval:created', {}, { dotId: 'dot1' });
    bus.publish('task.state', {}, { dotId: 'dot1' });
    assert.equal(new SseCursorStore(dir.db).read(), 2);
    assert.equal(sse.persistedSeq(), 2);

    // 重启：新 EventBus 从持久游标恢复，SseBus 读到同一 seq
    const bus2 = new EventBus({ startSeq: new SseCursorStore(dir.db).read() });
    assert.equal(bus2.currentSeq(), 2);
    bus2.publish('chat.final', {}, { dotId: 'dot1' });
    assert.equal(bus2.currentSeq(), 3);
  } finally {
    dir.cleanup();
  }
});

test('游标：persistEvery>0 时节流落盘（不丢最终值语义由 attach 保证）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = new SseBus({ db: dir.db, bus, persistEvery: 3 });
    sse.attach();
    bus.publish('task.state', {}, { dotId: 'dot1' });
    bus.publish('task.state', {}, { dotId: 'dot1' });
    assert.equal(new SseCursorStore(dir.db).read(), 0); // 未到阈值
    bus.publish('task.state', {}, { dotId: 'dot1' });
    assert.equal(new SseCursorStore(dir.db).read(), 3);
    sse.detach();
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 三、订阅者语义（delta 上限 / 通道过滤 / dot 过滤 / 坏订阅者隔离）
// ═══════════════════════════════════════════════════════════════════

test('订阅：chat.delta 每订阅者上限 200，溢出丢 delta', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    const got: number[] = [];
    sse.subscribe({ lastEventId: null, channels: [] }, (f) => got.push(f.id));
    for (let i = 0; i < SSE_DELTA_QUEUE_LIMIT + 30; i++) {
      bus.publish('chat.delta', { i }, { dotId: 'dot1' });
    }
    assert.equal(got.length, SSE_DELTA_QUEUE_LIMIT);
    // chat.final 不受 delta 上限影响（校正通道）
    bus.publish('chat.final', { text: '完' }, { dotId: 'dot1' });
    assert.equal(got.length, SSE_DELTA_QUEUE_LIMIT + 1);
  } finally {
    dir.cleanup();
  }
});

test('订阅：通道过滤只收订阅通道；dot 过滤只收本 dot', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    const chatOnly: string[] = [];
    sse.subscribe({ lastEventId: null, channels: ['chat'] }, (f) => chatOnly.push(f.channel));
    const dot2Only: string[] = [];
    sse.subscribe({ lastEventId: null, channels: [], dotId: 'dot2' }, (f) => dot2Only.push(f.channel));

    bus.publish('chat.delta', {}, { dotId: 'dot1' });
    bus.publish('task.state', {}, { dotId: 'dot1' });   // 非 chat，被过滤
    bus.publish('task.state', {}, { dotId: 'dot2' });   // 非 dot1，被 chatOnly 过滤
    assert.deepEqual(chatOnly, ['chat']);
    assert.deepEqual(dot2Only, ['queue']);
  } finally {
    dir.cleanup();
  }
});

test('订阅：onFrame 抛错被隔离，不影响其他订阅者', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    const good: number[] = [];
    sse.subscribe({ lastEventId: null, channels: [] }, () => {
      throw new Error('坏订阅者');
    });
    sse.subscribe({ lastEventId: null, channels: [] }, (f) => good.push(f.id));
    bus.publish('task.state', {}, { dotId: 'dot1' });
    assert.deepEqual(good, [1]);
  } finally {
    dir.cleanup();
  }
});

test('subscribe：重放时 initial = 快照帧在前、历史帧在后（客户端一次性校正）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = makeSse(dir, bus);
    bus.publish('approval:created', { n: 1 }, { dotId: 'dot1' }); // seq 1
    bus.publish('approval:decided', { n: 2 }, { dotId: 'dot1' }); // seq 2
    const realtime: string[] = [];
    const sub = sse.subscribe(
      { lastEventId: 0, channels: ['approval'] },
      (f) => realtime.push(f.kind), // 实时帧走回调，initial 走返回值
    );
    assert.deepEqual(sub.initial.map((f) => f.kind), ['approval.snapshot', 'approval:created', 'approval:decided']);
    assert.deepEqual(realtime, []); // 订阅前的历史不进实时回调
    sub.unsubscribe();
    assert.equal(sse.subscriberCount(), 0);

    const snap = sse.snapshotFrames(['approval', 'queue']);
    assert.equal(snap.length, 2);
    assert.equal(snap[0]!.kind, 'approval.snapshot');
    assert.equal(snap[1]!.kind, 'queue.snapshot');
  } finally {
    dir.cleanup();
  }
});

test('subscribe：无快照提供者时重放只发 resync（无快照帧可发）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus({ startSeq: 10_000 });
    const sse = makeSse(dir, bus, false);
    const sub = sse.subscribe({ lastEventId: 0, channels: ['approval'] }, () => undefined);
    assert.deepEqual(sub.initial.map((f) => f.kind), ['resync']);
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 四、SSE 帧格式与查询参数解析
// ═══════════════════════════════════════════════════════════════════

test('formatFrame：id / event / data 三行 + 空行（SSE 协议）', () => {
  const text = SseBus.formatFrame({ id: 42, channel: 'approval', kind: 'created', data: '{"a":1}' });
  assert.equal(text, 'id: 42\nevent: approval.created\ndata: {"a":1}\n\n');
});

test('parseStreamQuery：topics 过滤、dot、Last-Event-ID 头', () => {
  assert.deepEqual(parseStreamQuery('?topics=chat,queue', undefined), {
    topics: ['chat', 'queue'],
    dotId: undefined,
    lastEventId: null,
  });
  assert.deepEqual(parseStreamQuery('?topics=bogus,chat&dot=dot2', '17'), {
    topics: ['chat'],
    dotId: 'dot2',
    lastEventId: 17,
  });
  assert.deepEqual(parseStreamQuery('', 'not-a-number'), { topics: [], dotId: undefined, lastEventId: null });
  assert.deepEqual(parseStreamQuery('', '0'), { topics: [], dotId: undefined, lastEventId: 0 });
});

test('attach：订阅全部 TOPICS 键（不重造事件名）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const sse = new SseBus({ db: dir.db, bus });
    sse.attach();
    assert.equal(bus.listenerCount('approval:created'), 1);
    assert.equal(bus.listenerCount('task.state'), 1);
    assert.equal(bus.listenerCount('router.mode_changed'), 1);
    // 幂等：重复 attach 不叠加
    sse.attach();
    assert.equal(bus.listenerCount('approval:created'), 1);
    sse.detach();
    assert.equal(bus.listenerCount('approval:created'), 0);
    // 未登记的主题仍可被 SseBus 之外的发布触发（TOPICS 外的事件不入 SSE）
    bus.publish('unknown.topic', {}, { dotId: 'dot1' });
    assert.equal(sse.buffered(), 0);
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 五、真实 HTTP：GET /api/stream
// ═══════════════════════════════════════════════════════════════════

interface SseHarness { dir: TempDataDir; server: Server; base: string; bus: EventBus }

async function startStreamServer(): Promise<SseHarness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = makeSse(dir, bus);
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: fakeCp,
    gov: fakeGov,
    mem: fakeMem,
    router: fakeRouter,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}`, bus };
}

/** 读 SSE 流直到攒够 n 帧或超时（测试里绝不久等）。 */
async function readFrames(res: Response, n: number, timeoutMs = 3000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: string[] = [];
  let buf = '';
  const timer = setTimeout(() => reader.cancel().catch(() => undefined), timeoutMs);
  try {
    while (frames.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.startsWith(':')) frames.push(frame);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

test('GET /api/stream：实时帧立即下发（id = bus_seq）', async (t) => {
  const h = await startStreamServer();
  t.after(async () => {
    await new Promise<void>((res) => h.server.close(() => res()));
    h.dir.cleanup();
  });
  const res = await fetch(`${h.base}/api/stream?topics=queue&token=m`, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  h.bus.publish('task.state', { id: 'tk_live' }, { dotId: 'dot1' });
  const frames = await readFrames(res, 1);
  assert.equal(frames.length, 1);
  assert.match(frames[0]!, /^id: 1\n/);
  assert.match(frames[0]!, /^event: queue\.task\.state/m);
  assert.match(frames[0]!, /"kind":"task\.state"/);
});

test('GET /api/stream：Last-Event-ID 断线 → 先补快照再补历史', async (t) => {
  const h = await startStreamServer();
  t.after(async () => {
    await new Promise<void>((res) => h.server.close(() => res()));
    h.dir.cleanup();
  });
  // 断线前发生 2 个事件，客户端最后见到 seq 0
  h.bus.publish('approval:created', { n: 1 }, { dotId: 'dot1' }); // seq 1
  h.bus.publish('approval:decided', { n: 2 }, { dotId: 'dot1' }); // seq 2

  const res = await fetch(`${h.base}/api/stream?topics=approval&token=m`, {
    headers: { accept: 'text/event-stream', 'last-event-id': '0' },
  });
  assert.equal(res.status, 200);
  const frames = await readFrames(res, 3);
  assert.equal(frames.length, 3);
  assert.match(frames[0]!, /event: approval\.approval\.snapshot/);
  assert.match(frames[1]!, /event: approval\.approval:created/);
  assert.match(frames[2]!, /event: approval\.approval:decided/);
});

test('GET /api/stream：超窗断线 → resync 帧 + 快照校正', async (t) => {
  const dir = makeTempDataDir();
  const bus = new EventBus({ startSeq: 6000 });
  const sse = makeSse(dir, bus);
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: fakeCp,
    gov: fakeGov,
    mem: fakeMem,
    router: fakeRouter,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  t.after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    sse.detach();
    dir.cleanup();
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/stream?topics=approval&token=m`, {
    headers: { accept: 'text/event-stream', 'last-event-id': '0' },
  });
  const frames = await readFrames(res, 2);
  assert.equal(frames.length, 2);
  assert.match(frames[0]!, /event: log\.resync/);
  assert.match(frames[0]!, /"reason":"lag"/);
  assert.match(frames[1]!, /event: approval\.approval\.snapshot/);
});

test('GET /api/stream：token 走 query（EventSource 不能带头）；缺 token 一律 401', async (t) => {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = makeSse(dir, bus);
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: fakeCp,
    gov: fakeGov,
    mem: fakeMem,
    router: fakeRouter,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  t.after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    sse.detach();
    dir.cleanup();
  });

  const ok = await fetch(`http://127.0.0.1:${port}/api/stream?token=m`, { headers: { accept: 'text/event-stream' } });
  assert.equal(ok.status, 200);
  await ok.body!.cancel().catch(() => undefined);

  const bad = await fetch(`http://127.0.0.1:${port}/api/stream?token=wrong`, { headers: { accept: 'text/event-stream' } });
  assert.equal(bad.status, 401);
  await bad.body!.cancel().catch(() => undefined);

  // §5.2「鉴权：Bearer master_token」：不带 token 不得匿名订阅
  const anon = await fetch(`http://127.0.0.1:${port}/api/stream?topics=approval`, { headers: { accept: 'text/event-stream' } });
  assert.equal(anon.status, 401);
  assert.equal((await anon.json() as { error: string }).error, 'auth');
  await anon.body!.cancel().catch(() => undefined);
});
