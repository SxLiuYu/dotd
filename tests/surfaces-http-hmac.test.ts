/**
 * tests/surfaces-http-hmac.test.ts —— §5.2 签名校验 / 鉴权 / 路由表 集成测试。
 *
 * 覆盖（任务要求的三项之一：签名校验）：
 * - HMAC：合法签名通过、错 secret 拒、时间戳超窗拒、nonce 重放拒、格式错拒；
 * - NonceCache 的 LRU 5k 语义；
 * - Bearer：master 全通、readonly 只读、缺/错 token 401；
 * - Origin 白名单（DNS rebinding 防护）；
 * - 路由表：/hooks/:source 未登记 source 401、body >256KB 413、dup 200 vs 新事件 202。
 *
 * 起真实 HTTP server（随机端口，127.0.0.1），不占 7788（契约 H2 只约束 daemon 监听）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import {
  HMAC_NONCE_LRU,
  NonceCache,
  authenticate,
  createHttpServer,
  hmacSignature,
  matchRoute,
  verifyHmac,
  MAX_BODY,
} from '../src/surfaces/http.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type { ControlPlane, GovernancePort, IngestEventResult, MemoryPort, NotificationChannels, RouterPort } from '../src/shared/contracts.ts';

// ── 测试替身（SF 只依赖 contracts.ts 的端口面）────────────────────────

const MASTER = 'master-token-abc';
const READONLY = 'readonly-token-xyz';

function makeConfig(overrides: Partial<SurfacesConfig['http']> = {}): SurfacesConfig {
  return {
    http: {
      host: '127.0.0.1',
      port: 0,
      masterToken: MASTER,
      readonlyTokens: [READONLY],
      allowedOrigins: ['http://127.0.0.1:5173'],
      ...overrides,
    },
    hooks: [
      { source: 'grafana', secret: 'hook-secret-1', dotId: 'dot1', rateLimitPerMin: 600 },
      { source: 'github', secret: 'hook-secret-2', dotId: 'dot1', rateLimitPerMin: 600 },
    ],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
    ui: { streamDeltas: true },
    progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
  };
}

/** 记录型 CP 替身：ingestEvent 按 dedupKey 判重（模拟契约 E2 的返回形状）。 */
function makeFakeCp(seed: Array<{ dedupKey: string; eventId: number }> = []) {
  const seen = new Map<string, number>(seed.map((s) => [s.dedupKey, s.eventId]));
  const calls: Array<Record<string, unknown>> = [];
  let nextId = 100;
  return {
    calls,
    get seen(): ReadonlyMap<string, number> {
      return seen;
    },
    ingestEvent(req: Record<string, unknown>): IngestEventResult {
      calls.push(req);
      const key = typeof req['dedupKey'] === 'string' ? req['dedupKey'] : undefined;
      if (key !== undefined && seen.has(key)) return { eventId: seen.get(key)!, dup: true };
      const eventId = ++nextId;
      if (key !== undefined) seen.set(key, eventId);
      return { eventId, dup: false };
    },
    submit(req: Record<string, unknown>): { id: string; status: 'queued'; threadId?: string } {
      calls.push({ ...req, _kind: 'submit' });
      return { id: 'tk_test_1', status: 'queued', threadId: typeof req['threadId'] === 'string' ? req['threadId'] : undefined };
    },
    list(): Array<{ id: string; title: string; status: string; priority: number; dotId: string; updatedAt: string }> {
      return [];
    },
    cancel(id: string): { ok: boolean } {
      calls.push({ _kind: 'cancel', id });
      return { ok: true };
    },
    getGuardStatus(): Record<string, unknown> {
      return { guard: 'ok' };
    },
  };
}

/** 记录型 GOV 替身：capture decide() 的 channel/actor（§5.2 不硬编码 'web'）。 */
function makeFakeGov() {
  const decisions: Array<{ approvalId: number; channel: string; verdict: string; actor: string; note?: string }> = [];
  return {
    decisions,
    decide(approvalId: number, channel: string, verdict: string, actor: string, note?: string): Promise<{ ok: boolean }> {
      decisions.push({ approvalId, channel, verdict, actor, ...(note !== undefined ? { note } : {}) });
      return Promise.resolve({ ok: true });
    },
    listPending(): never[] {
      return [];
    },
    getApproval(): Promise<null> {
      return Promise.resolve(null);
    },
  };
}

const fakeMem: MemoryPort = {
  async openThread(): Promise<string> {
    return 'th_test';
  },
  async appendMessage(): Promise<{ id: string; seq: number }> {
    return { id: 'm1', seq: 1 };
  },
  async listThreads(): Promise<never[]> {
    return [];
  },
  async listMessages(): Promise<never[]> {
    return [];
  },
};

const fakeRouter: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };

interface Harness {
  dir: TempDataDir;
  server: Server;
  base: string;
  cp: ReturnType<typeof makeFakeCp>;
  gov: ReturnType<typeof makeFakeGov>;
  sse: SseBus;
  bus: EventBus;
}

async function startServer(
  seed?: Array<{ dedupKey: string; eventId: number }>,
  cfgOverrides?: Partial<SurfacesConfig['http']>,
  opts?: { channels?: NotificationChannels | null; alertsRoute?: () => { order: readonly string[]; outboxPath: string } },
): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const cfg = makeConfig(cfgOverrides);
  const cp = makeFakeCp(seed);
  const gov = makeFakeGov();
  const sse = new SseBus({ db: dir.db, bus });
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: cp as unknown as ControlPlane,
    gov: gov as unknown as GovernancePort,
    mem: fakeMem,
    router: fakeRouter,
    channels: opts?.channels ?? null,
    sse,
    cfg,
    webRoot: dir.root,
    ...(opts?.alertsRoute !== undefined ? { alertsRoute: opts.alertsRoute } : {}),
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}`, cp, gov, sse, bus };
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((res) => h.server.close(() => res()));
  h.sse.detach();
  h.dir.cleanup();
}

/** 签一个 hook 请求（按 §5.2 的签名串）。 */
function sign(secret: string, ts: string, nonce: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}\n${nonce}\n${body}`).digest('hex')}`;
}

async function postHook(
  h: Harness,
  source: string,
  body: string,
  opts: { ts?: string; nonce?: string; sig?: string; secret?: string } = {},
): Promise<Response> {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? `n-${Math.random().toString(36).slice(2, 10)}`;
  const sig = opts.sig ?? sign(opts.secret ?? 'hook-secret-1', ts, nonce, body);
  return fetch(`${h.base}/hooks/${source}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dotd-timestamp': ts,
      'x-dotd-nonce': nonce,
      'x-dotd-signature': sig,
    },
    body,
  });
}

// ═══════════════════════════════════════════════════════════════════
// 一、HMAC 纯函数层（§5.2 逐字）
// ═══════════════════════════════════════════════════════════════════

test('HMAC：签名串 = sha256=hex(hmac(ts\\n nonce\\n body))', () => {
  const expect = hmacSignature('s', '1700000000', 'nonce1', '{"a":1}');
  const manual = `sha256=${createHmac('sha256', 's').update('1700000000\nnonce1\n{"a":1}').digest('hex')}`;
  assert.equal(expect, manual);
  assert.match(expect, /^sha256=[0-9a-f]{64}$/);
});

test('HMAC：合法请求 verifyHmac 通过并回 tsMs/nonce', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = '{"id":42}';
  const res = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n1', signature: hmacSignature('sec', ts, 'n1', body), body, nowMs: now },
    () => false,
  );
  assert.deepEqual(res, { ok: true, tsMs: now, nonce: 'n1' });
});

test('HMAC：毫秒时间戳（13 位）同样受理', () => {
  const now = 1_700_000_000_000;
  const body = '{}';
  const res = verifyHmac(
    { secret: 'sec', timestamp: String(now), nonce: 'n1', signature: hmacSignature('sec', String(now), 'n1', body), body, nowMs: now + 1000 },
    () => false,
  );
  assert.equal(res.ok, true);
});

test('HMAC：错误 secret → signature 拒', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const res = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n1', signature: hmacSignature('WRONG', ts, 'n1', '{}'), body: '{}', nowMs: now },
    () => false,
  );
  assert.deepEqual(res, { ok: false, reason: 'signature' });
});

test('HMAC：时间戳超窗（±300s）→ timestamp 拒', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor((now - 301_000) / 1000)); // 301 秒前
  const res = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n1', signature: hmacSignature('sec', ts, 'n1', '{}'), body: '{}', nowMs: now },
    () => false,
  );
  assert.deepEqual(res, { ok: false, reason: 'timestamp' });
});

test('HMAC：边界内（恰 300s）仍通过', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor((now - 300_000) / 1000));
  const res = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n1', signature: hmacSignature('sec', ts, 'n1', '{}'), body: '{}', nowMs: now },
    () => false,
  );
  assert.equal(res.ok, true);
});

test('HMAC：nonce 重放 → nonce 拒（重放检查先于比签）', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const res = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'replayed', signature: hmacSignature('sec', ts, 'replayed', '{}'), body: '{}', nowMs: now },
    () => true, // nonce 已见过
  );
  assert.deepEqual(res, { ok: false, reason: 'nonce' });
});

test('HMAC：签名错的请求不许烧 nonce（否则伪造报文能废掉合法调用方的重发）', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const nonces = new NonceCache();
  const seen = (n: string): boolean => nonces.has(n);

  // ① 伪造：nonce 新鲜、签名是错的 → 必须只以 signature 拒，且不占用 nonce
  const forged = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n-1', signature: `sha256=${'0'.repeat(64)}`, body: '{}', nowMs: now },
    seen,
  );
  assert.deepEqual(forged, { ok: false, reason: 'signature' });
  assert.equal(nonces.size(), 0, '验签没过就不该登记 nonce');

  // ② 真客户端随后用同一个 nonce 重发 → 必须放行（此前会被误判成重放）
  const legit = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n-1', signature: hmacSignature('sec', ts, 'n-1', '{}'), body: '{}', nowMs: now },
    seen,
  );
  assert.equal(legit.ok, true, '合法重发不能被上一批伪造请求废掉');
  assert.equal(nonces.size(), 1);

  // ③ 同一个 nonce 真重放 → 仍然拒
  const replay = verifyHmac(
    { secret: 'sec', timestamp: ts, nonce: 'n-1', signature: hmacSignature('sec', ts, 'n-1', '{}'), body: '{}', nowMs: now },
    seen,
  );
  assert.deepEqual(replay, { ok: false, reason: 'nonce' });
});

test('HMAC：缺头/格式错 → missing / format', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    verifyHmac({ secret: 's', timestamp: undefined, nonce: 'n', signature: 'sha256=x', body: '{}', nowMs: now }, () => false),
    { ok: false, reason: 'missing' },
  );
  assert.deepEqual(
    verifyHmac({ secret: 's', timestamp: 'abc', nonce: 'n', signature: 'sha256=x', body: '{}', nowMs: now }, () => false),
    { ok: false, reason: 'format' },
  );
  const ts = String(Math.floor(now / 1000));
  assert.deepEqual(
    verifyHmac({ secret: 's', timestamp: ts, nonce: 'n', signature: 'deadbeef', body: '{}', nowMs: now }, () => false),
    { ok: false, reason: 'format' },
  );
});

test('NonceCache：同 nonce 二次判定为重放；LRU 容量 5k', () => {
  const cache = new NonceCache(3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('a'), true); // 重放
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), false);
  assert.equal(cache.has('d'), false); // 挤掉最旧的 'a'
  assert.equal(cache.has('a'), false); // 'a' 已被淘汰 → 视为新 nonce
  assert.equal(cache.size(), 3);

  const big = new NonceCache(HMAC_NONCE_LRU);
  for (let i = 0; i < HMAC_NONCE_LRU; i++) big.has(`n${i}`);
  assert.equal(big.size(), HMAC_NONCE_LRU);
  assert.equal(big.has('n0'), true); // 容量内仍记得
  big.has('overflow');
  assert.equal(big.has('n0'), false); // 溢出后最旧的被淘汰
});

// ═══════════════════════════════════════════════════════════════════
// 二、Bearer 鉴权（§5.2：master 全读写 / readonly 仅 GET）
// ═══════════════════════════════════════════════════════════════════

test('鉴权：master token → master；readonly → 仅 GET 通', () => {
  const cfg = makeConfig().http;
  assert.equal(authenticate({ authorization: `Bearer ${MASTER}` }, cfg, 'POST').kind, 'master');
  assert.equal(authenticate({ authorization: `Bearer ${READONLY}` }, cfg, 'GET').kind, 'readonly');
  const write = authenticate({ authorization: `Bearer ${READONLY}` }, cfg, 'POST');
  assert.equal(write.kind, 'readonly');
  assert.equal(write.error, 'readonly_write');
});

test('鉴权：缺/错 token → none + missing/invalid', () => {
  const cfg = makeConfig().http;
  assert.equal(authenticate({}, cfg, 'GET').error, 'missing');
  assert.equal(authenticate({ authorization: 'Basic abc' }, cfg, 'GET').error, 'invalid');
  assert.equal(authenticate({ authorization: 'Bearer nope' }, cfg, 'GET').error, 'invalid');
});

// ═══════════════════════════════════════════════════════════════════
// 三、真实 HTTP 集成（hook 签名 → ingest → CP）
// ═══════════════════════════════════════════════════════════════════

test('POST /hooks/grafana：签名正确 → 202 {eventId}', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await postHook(h, 'grafana', '{"id":"g-1","alert":"x"}');
  assert.equal(res.status, 202);
  const body = await res.json() as { eventId: number; dup: boolean };
  assert.equal(body.dup, false);
  assert.ok(body.eventId > 0);
  assert.equal(h.cp.calls.length, 1);
  assert.equal(h.cp.calls[0]!['source'], 'http');
  assert.equal(h.cp.calls[0]!['dedupKey'], 'grafana:g-1');
});

test('POST /hooks/grafana：dedupKey 已存在 → 200 {dup:true}', async (t) => {
  const h = await startServer([{ dedupKey: 'grafana:g-9', eventId: 55 }]);
  t.after(() => close(h));
  const res = await postHook(h, 'grafana', '{"id":"g-9"}');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { eventId: 55, dup: true });
});

test('POST /hooks/grafana：签名错 → 401 且不投 CP', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await postHook(h, 'grafana', '{"id":"g-2"}', { secret: 'wrong-secret' });
  assert.equal(res.status, 401);
  const body = await res.json() as { error: string; message: string };
  assert.equal(body.error, 'auth');
  assert.match(body.message, /HMAC/);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /hooks/grafana：时间戳过期 → 401 timestamp', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  const res = await postHook(h, 'grafana', '{}', { ts: stale });
  assert.equal(res.status, 401);
  assert.match((await res.json() as { message: string }).message, /timestamp/);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /hooks/grafana：nonce 重放 → 401 nonce（第二次同 nonce）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const nonce = 'fixed-nonce-1';
  assert.equal((await postHook(h, 'grafana', '{"id":"r1"}', { nonce })).status, 202);
  const second = await postHook(h, 'grafana', '{"id":"r1"}', { nonce });
  assert.equal(second.status, 401);
  assert.match((await second.json() as { message: string }).message, /nonce/);
  // 只投递过一次（第一次），重放被挡在鉴权层
  assert.equal(h.cp.calls.length, 1);
});

test('POST /hooks/unknown：未登记 source → 401（不进 HMAC 也不进 CP）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await postHook(h, 'not-registered', '{"a":1}');
  assert.equal(res.status, 401);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /hooks/grafana：body 超 256KB → 413', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const big = JSON.stringify({ id: 'big', blob: 'x'.repeat(MAX_BODY + 1024) });
  const res = await postHook(h, 'grafana', big);
  assert.equal(res.status, 413);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /hooks/grafana：body 不是合法 JSON → 400 parse', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await postHook(h, 'grafana', 'not-json{');
  assert.equal(res.status, 400);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /hooks/grafana：签名覆盖已收到的 body（改一个字节即失败）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const body = '{"id":"t","v":1}';
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'tamper-1';
  const sig = sign('hook-secret-1', ts, nonce, body);
  const res = await fetch(`${h.base}/hooks/grafana`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dotd-timestamp': ts,
      'x-dotd-nonce': nonce,
      'x-dotd-signature': sig,
    },
    body: `${body.slice(0, -1)}2}`, // 篡改最后一位
  });
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════
// 四、API 鉴权与 Origin 白名单
// ═══════════════════════════════════════════════════════════════════

test('GET /api/health 无 token 可通（§5.2 明文豁免）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; service: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, 'dotd');
});

test('GET /api/queue：缺 token → 401', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  assert.equal((await fetch(`${h.base}/api/queue`)).status, 401);
});

test('GET /api/queue：readonly token 可读', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/queue`, { headers: { authorization: `Bearer ${READONLY}` } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { queue: unknown[] }).queue, []);
});

test('POST /api/messages：readonly token 写 → 403', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${READONLY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.status, 403);
  assert.equal(h.cp.calls.length, 0);
});

test('POST /api/messages：master token → 202 且 cp.submit priority=1', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '帮我查一下' }),
  });
  assert.equal(res.status, 202);
  const submit = h.cp.calls.find((c) => c['_kind'] === 'submit');
  assert.ok(submit !== undefined);
  assert.equal(submit['priority'], 1); // §5.1 interactive = 1
  assert.equal(submit['goal'], '帮我查一下');
});

test('Origin 不在白名单 → 403（DNS rebinding 防护）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/queue`, {
    headers: { authorization: `Bearer ${MASTER}`, origin: 'http://evil.example.com' },
  });
  assert.equal(res.status, 403);
});

test('Origin 在白名单 → 放行', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/queue`, {
    headers: { authorization: `Bearer ${MASTER}`, origin: 'http://127.0.0.1:5173' },
  });
  assert.equal(res.status, 200);
});

test('拒绝审计落 surf_ingress_rejects（auth 拒绝可查）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  await fetch(`${h.base}/api/queue`); // 401
  await postHook(h, 'grafana', '{}', { secret: 'wrong' }); // 401
  const rows = h.dir.db.prepare('SELECT reason, COUNT(*) AS n FROM surf_ingress_rejects GROUP BY reason').all() as Array<{ reason: string; n: number }>;
  const auth = rows.find((r) => r.reason === 'auth');
  assert.ok(auth !== undefined);
  assert.ok(auth.n >= 2);
});

test('POST /api/approvals/:id/decision：channel/actor 由请求体声明，不硬编码 web', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  // CLI 的 approve/deny 走同一端点：channel='cli' 必须透传到 GOV
  // （gate.ts 把 channel 原值写进 approvals.decided_by，§5.6 CLI 通道身份）
  const cli = await fetch(`${h.base}/api/approvals/12/decision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'approve_once', channel: 'cli' }),
  });
  assert.equal(cli.status, 200);
  assert.deepEqual(h.gov.decisions[0], { approvalId: 12, channel: 'cli', verdict: 'approve_once', actor: 'cli' });

  // actor 显式给出时原样透传（§5.2 gov.decide(id, channel, verdict, actor)）
  const withActor = await fetch(`${h.base}/api/approvals/13/decision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'reject', channel: 'cli', actor: 'owner@phone' }),
  });
  assert.equal(withActor.status, 200);
  assert.deepEqual(h.gov.decisions[1], { approvalId: 13, channel: 'cli', verdict: 'reject', actor: 'owner@phone' });

  // 缺省（Web UI）：channel='web'、actor='web'（§5.2 原文的 web 分支）
  const web = await fetch(`${h.base}/api/approvals/14/decision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'approve_remember' }),
  });
  assert.equal(web.status, 200);
  assert.deepEqual(h.gov.decisions[2], { approvalId: 14, channel: 'web', verdict: 'approve_remember', actor: 'web' });
});

test('POST /api/approvals/:id/decision：verdict 非法 → 400 且不调 GOV', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const res = await fetch(`${h.base}/api/approvals/12/decision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict: 'approve' }),
  });
  assert.equal(res.status, 400);
  assert.equal(h.gov.decisions.length, 0);
});

test('GET /api/events：since/limit 是脏值 → 400（不许静默变空列表或拉全表）', async (t) => {
  const h = await startServer();
  t.after(() => close(h));
  const head = { authorization: `Bearer ${MASTER}` };

  // ① since 不是数字：旧实现 Number('abc')=NaN → 绑库成 NULL → 恒空 200，
  //    前端会把"参数写错"读成"没有新事件"
  const badSince = await fetch(`${h.base}/api/events?since=abc`, { headers: head });
  assert.equal(badSince.status, 400);
  assert.equal((await badSince.json() as { error?: string }).error, 'bad_since');

  // ② limit=-1：SQLite 的 LIMIT -1 是"不限行"，一次拉全表
  const badLimit = await fetch(`${h.base}/api/events?limit=-1`, { headers: head });
  assert.equal(badLimit.status, 400);
  assert.equal((await badLimit.json() as { error?: string }).error, 'bad_limit');

  const bigLimit = await fetch(`${h.base}/api/events?limit=99999`, { headers: head });
  assert.equal(bigLimit.status, 400);

  // ③ 正常值照旧 200
  const ok = await fetch(`${h.base}/api/events?limit=5`, { headers: head });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json() as { events?: unknown[] }).events));
});

// ═══════════════════════════════════════════════════════════════════
// 五、路由表匹配（§5.2 逐条）
// ═══════════════════════════════════════════════════════════════════

test('matchRoute：§5.2 全路由可解析，参数路径取到 id/source', () => {
  const cases: Array<[string, string]> = [
    ['GET', '/api/health'],
    ['GET', '/api/whoami'],
    ['POST', '/api/messages'],
    ['GET', '/api/queue'],
    ['POST', '/api/queue/tk_1/cancel'],
    ['GET', '/api/conversations'],
    ['GET', '/api/approvals'],
    ['GET', '/api/approvals/12'],
    ['POST', '/api/approvals/12/decision'],
    ['GET', '/api/events'],
    ['GET', '/api/guard'],
    ['GET', '/api/breaker'],
    ['GET', '/api/models/rank'],
    ['GET', '/api/stream'],
    ['POST', '/api/hooks'],
    ['POST', '/api/heartbeat'],
    ['POST', '/hooks/grafana'],
  ];
  for (const [method, path] of cases) {
    const m = matchRoute(method, path);
    assert.ok(m !== null, `${method} ${path} 应命中路由`);
  }
  assert.equal(matchRoute('POST', '/api/queue/tk_1/cancel')?.route, 'queue_cancel');
  assert.equal(matchRoute('GET', '/api/approvals/12')?.params.id, '12');
  assert.equal(matchRoute('POST', '/hooks/github')?.params.source, 'github');
  assert.equal(matchRoute('GET', '/api/nope'), null);
  assert.equal(matchRoute('DELETE', '/api/queue'), null);
});

// ═══════════════════════════════════════════════════════════════════
// 九、/api/channels（§5.7 求救自检）
// ═══════════════════════════════════════════════════════════════════

/** 通道可用性可编排的 NotificationChannels 替身。 */
function makeFakeChannels(avail: { feishu?: boolean; telegram?: boolean; email?: boolean }): NotificationChannels {
  return {
    available(channel: 'telegram' | 'feishu' | 'email'): boolean {
      return avail[channel] === true;
    },
    async deliver(): Promise<{ ok: boolean }> {
      return { ok: false };
    },
  } as unknown as NotificationChannels;
}

test('matchRoute：GET /api/channels 命中 channels 路由（POST 不命中）', () => {
  assert.deepEqual(matchRoute('GET', '/api/channels'), { route: 'channels', params: {} });
  assert.equal(matchRoute('POST', '/api/channels'), null);
});

test('GET /api/channels：如实报可用性、真投递顺序、兜底文件与最近台账', async () => {
  const h = await startServer(undefined, undefined, {
    channels: makeFakeChannels({ feishu: true }),
    alertsRoute: () => ({ order: ['feishu', 'telegram', 'email', 'outbox'], outboxPath: '/tmp/OUTBOX.md' }),
  });
  try {
    // 台账两条：一条真投进了飞书，一条 pending（账本先行协议的残留态）
    h.dir.db
      .prepare(
        `INSERT INTO alert_dispatch (signature, kind, mode, failing_json, channels_tried, delivered_via, sent_at)
         VALUES ($sig, $kind, $mode, $fj, $ct, $dv, $sa)`,
      )
      .run({ sig: 'sig-ok', kind: 'help', mode: 'degraded', fj: '[]', ct: 'feishu', dv: 'feishu', sa: 1000 });
    h.dir.db
      .prepare(
        `INSERT INTO alert_dispatch (signature, kind, mode, failing_json, channels_tried, delivered_via, sent_at)
         VALUES ($sig, $kind, $mode, $fj, $ct, $dv, $sa)`,
      )
      .run({ sig: 'sig-pending', kind: 'recovery', mode: 'emergency', fj: '[]', ct: 'feishu,outbox', dv: 'pending', sa: 2000 });

    const res = await fetch(`${h.base}/api/channels`, { headers: { authorization: `Bearer ${MASTER}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      available: Record<string, boolean>;
      order: string[];
      outboxPath: string;
      recent: Array<Record<string, unknown>>;
    };
    // 可用性取的是通道替身的真值，不是编译期猜测
    assert.deepEqual(body.available, { feishu: true, telegram: false, email: false });
    // 顺序/兜底路径取的是 router.alertsRoute() 的真值
    assert.deepEqual(body.order, ['feishu', 'telegram', 'email', 'outbox']);
    assert.equal(body.outboxPath, '/tmp/OUTBOX.md');
    // 台账按 id 倒序，两条都在
    assert.equal(body.recent.length, 2);
    assert.equal(body.recent[0]!['signature'], 'sig-pending');
    assert.equal(body.recent[0]!['deliveredVia'], 'pending');
    assert.equal(body.recent[1]!['deliveredVia'], 'feishu');
  } finally {
    await close(h);
  }
});

test('GET /api/channels：没装配 channels（deps.channels=null）→ 全 false，不谎报可用', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/api/channels`, { headers: { authorization: `Bearer ${MASTER}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { available: Record<string, boolean>; order: string[]; outboxPath: string };
    assert.deepEqual(body.available, { feishu: false, telegram: false, email: false });
    // 没传 alertsRoute 时回落编译期默认（形状仍完整，CLI 不会判"形状不对"）
    assert.deepEqual(body.order, ['feishu', 'telegram', 'email', 'outbox']);
    assert.equal(body.outboxPath, '~/.dotd/OUTBOX.md');
  } finally {
    await close(h);
  }
});

test('GET /api/channels：要 master token（缺 token 401）', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/api/channels`);
    assert.equal(res.status, 401);
  } finally {
    await close(h);
  }
});
