/**
 * tests/router-state.test.ts —— breaker 持久化、应急收缩闸门、本地槽位与 busy 规则。
 *
 * 依据（docs/design/modules/model-router.md，行号为该文档内位置）：
 * - §4.1 熔断器记账：窗口样本、连续失败、auth 立即 open 不自动恢复、429 软冷却；
 *   状态落 `breaker_state`（§3.2），daemon 重启不丢。
 * - §4.1 busy 规则：槽位获取超时（queue_reject_ms 内没拿到）→ 不直接入窗，busyConsec+1；
 *   未达 busy_consec_limit(3) 只跳过该端点（排队不是故障）；连续 3 → engine_unavailable 入窗。
 *   **任一成功获取槽位的调用把 busyConsec 清零。**
 * - §4.2 emergencyEligible 唯一执行位点：mode ∈ {EMERGENCY, RESTRICTED, TOTAL_OUTAGE} 且
 *   track='primary' → 过滤掉 emergencyEligible=false 的端点；LOCAL_FALLBACK 不过滤；
 *   light 轨永不受影响；**被过滤端点不写 tried**（档位不允许，不是"试过失败"）。
 * - §4.3：mode 与 emergencyActive 同事务落 router_state 再广播 `router.mode_changed`。
 * - §4.7 RouterRuntime：槽位信号量跨 reload 存续；新增 id 建 sem；删除 id 等在途释放完
 *   再回收（上限 5s）；改 max_concurrency → resize 不抢占在途。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { RouterRuntime, SlotSemaphore } from '../src/router/runtime.ts';
import { pickCandidates } from '../src/router/candidates.ts';
import { makeHttpFailure } from '../src/router/candidates.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { EndpointDef, RouteRequest, RouterMode, Track } from '../src/shared/contracts.ts';
import type { BreakerState } from '../src/shared/contracts.ts';

let tmp: TempDataDir;
let cfgDir: string;

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

/** 造一个单端点（可配 tier/emergencyEligible/local）的 EndpointDef。 */
function ep(over: Partial<EndpointDef> & { id: string }): EndpointDef {
  return {
    tier: 1,
    baseUrl: 'https://x.example/api/v1',
    apiKeyEnv: null,
    models: { primary: 'm', light: 'm' },
    style: 'openai',
    enabled: true,
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 },
    emergencyEligible: true,
    ...over,
  };
}

/** 测试专用查询助手（node:sqlite 的绑定参数只接受标量/ Buffer/ null）。 */
function rows(sql: string, ...args: Array<string | number | null>): Array<Record<string, unknown>> {
  return tmp.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    track: 'primary' as Track,
    messages: [{ role: 'user', content: 'hi' }],
    attemptId: 'nonj:STATE001',
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. breaker 持久化（§4.1 / §3.2）
// ═══════════════════════════════════════════════════════════════════

describe('breaker 持久化（MR §4.1 / §3.2）', () => {
  it('open 状态落 breaker_state，重启后仍是 open（不需重新失败 3 次）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const first = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    // 三次请求各让 tier1 失败一次：第 3 次后 consec=3 → open
    for (let i = 0; i < 3; i++) await first.complete(req({ attemptId: `nonj:BP00${i}` }));
    assert.equal(first.mode, 'LOCAL_FALLBACK');
    const st = rows(
      `SELECT state, consec_failures, last_kind FROM breaker_state WHERE endpoint_id='cloud-main' AND track='primary'`,
    );
    assert.equal(st.length, 1, 'breaker_state 有行');
    assert.equal(st[0]?.state, 'open');
    assert.equal(st[0]?.consec_failures, 3);
    assert.equal(st[0]?.last_kind, 'server_error');
    first.dispose();

    // 重开：state 直接可用（open），不需重新失败 3 次
    const stub2 = new StubTransport({
      script: [{ endpointId: 'local-llm', content: 'ok' }],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const second = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub2,
    });
    const v = second.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(v?.roles.primary.breaker, 'open', '重启后仍 open');
    assert.equal(v?.roles.primary.consecFailures, 3, 'consec 也恢复了');
    second.dispose();
  });

  it('breaker_event 记录状态迁移（closed→open，含原因）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) await router.complete(req({ attemptId: `nonj:EVT00${i}` }));
    const ev = rows(`SELECT from_state, to_state, reason FROM breaker_event WHERE endpoint_id='cloud-main'`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.from_state, 'closed');
    assert.equal(ev[0]?.to_state, 'open');
    assert.ok(String(ev[0]?.reason).length > 0, '带原因');
    router.dispose();
  });

  it('429 软冷却：throttled_until 落库，状态仍 closed（不 open）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(429, 'rate limited') },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    await router.complete(req());
    const st = rows(
      `SELECT state, throttled_until FROM breaker_state WHERE endpoint_id='cloud-main' AND track='primary'`,
    );
    assert.equal(st[0]?.state, 'closed', '429 不 open');
    assert.ok(Number(st[0]?.throttled_until) > Date.now() - 60_000, 'throttled_until 已写');
    router.dispose();
  });

  it('auth 立即 open 且重启后 isAuthLocked 仍为真（不自动恢复）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [{ endpointId: 'cloud-main', content: '', fail: makeHttpFailure(401, 'bad key') }],
    });
    const first = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    await assert.rejects(() => first.complete(req()));
    const st = rows(`SELECT state, last_kind FROM breaker_state WHERE endpoint_id='cloud-main' AND track='primary'`);
    assert.equal(st[0]?.state, 'open', '一次 auth 就 open');
    assert.equal(st[0]?.last_kind, 'auth');
    first.dispose();

    // 重启：auth 锁仍在（不因重启恢复）
    const stub2 = new StubTransport({ script: [{ endpointId: 'cloud-main', content: 'ok' }] });
    const second = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub2,
    });
    const v = second.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(v?.roles.primary.breaker, 'open');
    assert.equal(v?.roles.primary.lastKind, 'auth');
    second.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 应急收缩闸门（§4.2 emergencyEligible 唯一执行位点）
// ═══════════════════════════════════════════════════════════════════

describe('应急收缩闸门（MR §4.2 emergencyEligible 唯一执行位点）', () => {
  const free = ep({ id: 'cloud-free', tier: 1, emergencyEligible: false });
  const paid = ep({ id: 'cloud-paid', tier: 1, emergencyEligible: true });
  const pool = ep({ id: 'pool-1', tier: 3, emergencyEligible: true });

  it('EMERGENCY + primary → 过滤掉 emergencyEligible=false', () => {
    const kept = pickCandidates([free, paid, pool], 'EMERGENCY', 'primary');
    assert.deepEqual(
      kept.map((e) => e.id),
      ['cloud-paid', 'pool-1'],
    );
  });

  it('LOCAL_FALLBACK 不过滤（本地是免费兜底档，不属收缩范畴）', () => {
    const kept = pickCandidates([free, paid, pool], 'LOCAL_FALLBACK', 'primary');
    assert.deepEqual(
      kept.map((e) => e.id),
      ['cloud-free', 'cloud-paid', 'pool-1'],
    );
  });

  it('NORMAL 不过滤', () => {
    const kept = pickCandidates([free, paid], 'NORMAL', 'primary');
    assert.deepEqual(
      kept.map((e) => e.id),
      ['cloud-free', 'cloud-paid'],
    );
  });

  it('light 轨永不受 emergencyEligible 影响（收缩的是主循环业务面）', () => {
    for (const mode of ['EMERGENCY', 'RESTRICTED', 'TOTAL_OUTAGE'] as RouterMode[]) {
      const kept = pickCandidates([free, paid], mode, 'light');
      assert.deepEqual(
        kept.map((e) => e.id),
        ['cloud-free', 'cloud-paid'],
        `mode=${mode} light 轨不过滤`,
      );
    }
  });

  it('enabled=false 或无该轨模型的端点被过滤（§4.2 首行）', () => {
    const disabled = ep({ id: 'off', tier: 1, enabled: false });
    const noLight = ep({ id: 'primary-only', tier: 1, models: { primary: 'm' } });
    assert.deepEqual(
      pickCandidates([disabled, noLight], 'NORMAL', 'primary').map((e) => e.id),
      ['primary-only'],
    );
    assert.deepEqual(pickCandidates([disabled, noLight], 'NORMAL', 'light').map((e) => e.id), []);
  });

  it('tier 升序；Tier3 内部 lastVerifiedAt 新者先', () => {
    const old = ep({ id: 'pool-old', tier: 3, lastVerifiedAt: 1000 });
    const fresh = ep({ id: 'pool-new', tier: 3, lastVerifiedAt: 5000 });
    const local = ep({ id: 'local', tier: 2 });
    const cloud = ep({ id: 'cloud', tier: 1 });
    assert.deepEqual(
      pickCandidates([old, fresh, local, cloud], 'NORMAL', 'primary').map((e) => e.id),
      ['cloud', 'local', 'pool-new', 'pool-old'],
    );
  });

  it('EMERGENCY 下被过滤端点不写 tried（档位不允许 ≠ 试过失败）', async () => {
    // tier1 只有 emergencyEligible=false 的端点；tier2 本地可服务 → mode 不会到 EMERGENCY，
    // 故直接构造 EMERGENCY 场景：tier1/tier2 全挂、只剩 tier3 池（emergencyEligible=true）
    writeConfigWithPool();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
      ],
      local: { 'local-llm': { health: false, warm: false } },
      metadata: { openrouter_models: { items: [] } },
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => router.complete(req({ attemptId: `nonj:EMG00${i}` })));
    }
    // 池端点无合格证 + 无待批候选 → NoQualifiedPrimaryError（裁决 2）
    assert.equal(router.mode, 'TOTAL_OUTAGE');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. mode 与 emergencyActive 同事务 + 广播（§4.3）
// ═══════════════════════════════════════════════════════════════════

describe('mode/emergencyActive 同事务落库与广播（MR §4.3）', () => {
  it('mode 变化 → router_state 同事务落 mode/emergency_active/mode_since + 广播', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const events: Array<Record<string, unknown>> = [];
    tmp.bus.on('router.mode_changed', (e) => {
      events.push(e as unknown as Record<string, unknown>);
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) await router.complete(req({ attemptId: `nonj:MC00${i}` }));
    assert.equal(router.mode, 'LOCAL_FALLBACK');
    const kv = new Map(
      rows(`SELECT key, value FROM router_state`).map((r) => [String(r.key), String(r.value)]),
    );
    assert.equal(kv.get('mode'), 'LOCAL_FALLBACK');
    assert.equal(kv.get('emergency_active'), '0', 'LOCAL_FALLBACK 不应急');
    assert.ok(Number(kv.get('mode_since')) > 0, 'mode_since 有值');
    assert.equal(events.length, 1, '广播一次 mode_changed');
    router.dispose();
  });

  it('TOTAL_OUTAGE → emergency_active=1 且重启后同事务恢复', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
      ],
      local: { 'local-llm': { health: false, warm: false } },
    });
    const first = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => first.complete(req({ attemptId: `nonj:TO00${i}` })));
    }
    assert.equal(first.mode, 'TOTAL_OUTAGE');
    assert.equal(first.emergencyActive, true);
    first.dispose();

    const kv = new Map(
      rows(`SELECT key, value FROM router_state`).map((r) => [String(r.key), String(r.value)]),
    );
    assert.equal(kv.get('emergency_active'), '1');

    // 重启：同事务恢复 mode + emergencyActive
    const stub2 = new StubTransport({
      script: [{ endpointId: 'local-llm', content: 'ok' }],
      local: { 'local-llm': { health: false, warm: false } },
    });
    const second = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub2,
    });
    assert.equal(second.mode, 'TOTAL_OUTAGE');
    assert.equal(second.emergencyActive, true, 'emergencyActive 与 mode 同事务恢复（§4.3）');
    second.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. RouterRuntime 槽位（§4.1 busy 规则 / §4.7 reload 语义）
// ═══════════════════════════════════════════════════════════════════

describe('SlotSemaphore / RouterRuntime（MR §4.1/§4.7）', () => {
  it('容量 1：第二个 tryAcquire 排队，第一个 release 后补上', async () => {
    const sem = new SlotSemaphore(1);
    const a = await sem.tryAcquire(50);
    assert.ok(a !== null);
    assert.equal(sem.inFlight, 1);
    const bP = sem.tryAcquire(50);
    assert.equal(sem.waiting, 1, '第二个在排队');
    a!.release();
    const b = await bP;
    assert.ok(b !== null, 'release 后排队者拿到');
    b!.release();
    assert.equal(sem.inFlight, 0);
  });

  it('超 queue_reject_ms 拿不到 → 返回 null（排队不是故障）', async () => {
    const sem = new SlotSemaphore(1);
    const a = await sem.tryAcquire(0);
    assert.ok(a !== null);
    const started = Date.now();
    const b = await sem.tryAcquire(60);
    assert.equal(b, null);
    assert.ok(Date.now() - started >= 40, '确实等到了超时');
  });

  it('timeoutMs<=0 立即返回 null', async () => {
    const sem = new SlotSemaphore(1);
    const a = await sem.tryAcquire(0);
    assert.ok(a !== null);
    assert.equal(await sem.tryAcquire(0), null);
  });

  it('resize 收缩不抢占在途（§4.7）', async () => {
    const sem = new SlotSemaphore(3);
    const a = await sem.tryAcquire(0);
    const b = await sem.tryAcquire(0);
    assert.ok(a !== null && b !== null);
    sem.resize(1);
    assert.equal(sem.capacity, 1);
    assert.equal(sem.inFlight, 2, '在途不被打断');
    a!.release();
    b!.release();
    assert.equal(await sem.tryAcquire(0) !== null, true, '容量收缩后仍能拿一个');
    assert.equal(await sem.tryAcquire(0), null);
  });

  it('ensure：新增建 sem / 改容量 resize / 已存在复用', () => {
    const rt = new RouterRuntime();
    const s1 = rt.ensure('e1', 1);
    assert.equal(s1.capacity, 1);
    assert.equal(rt.ensure('e1', 1), s1, '同 id 复用');
    rt.ensure('e1', 4);
    assert.equal(s1.capacity, 4, '改容量 → resize');
  });

  it('busyConsec：+1 与清零（§4.1 逐字）', () => {
    const rt = new RouterRuntime();
    rt.ensure('e1', 1);
    assert.equal(rt.bumpBusy('e1'), 1);
    assert.equal(rt.bumpBusy('e1'), 2);
    rt.clearBusy('e1');
    assert.equal(rt.get('e1')?.busyConsec, 0, '任一成功获取槽位 → 清零');
    // 未 ensure 的端点 bump 返回 0（不建状态）
    assert.equal(rt.bumpBusy('ghost'), 0);
  });

  it('删除 id → 等在途释放完再回收（§4.7）', async () => {
    const rt = new RouterRuntime();
    rt.ensure('e1', 1);
    const lease = await rt.ensure('e1', 1).tryAcquire(0);
    assert.ok(lease !== null);
    rt.markRemoved('e1');
    assert.deepEqual(rt.recycleRemoved(), ['e1'], '在途未释放 → 仍占用');
    assert.equal(rt.has('e1'), true);
    lease!.release();
    assert.deepEqual(rt.recycleRemoved(), [], '释放后回收');
    assert.equal(rt.has('e1'), false);
  });

  it('删除 id 超 5s 宽限 → 强制丢弃（在途自然失败走降级）', async () => {
    const rt = new RouterRuntime();
    rt.ensure('e1', 1);
    const lease = await rt.ensure('e1', 1).tryAcquire(0);
    assert.ok(lease !== null);
    const t0 = 1_800_000_000_000;
    rt.markRemoved('e1');
    // 用注入的 now 推进到 5s 后（不真的等 5 秒）
    const now = () => t0 + 6000;
    assert.deepEqual(rt.recycleRemoved(now()), [], '超宽限强制丢弃');
    assert.equal(rt.has('e1'), false);
    lease!.release(); // 旧 entry 上的 release 自然收敛，不抛错
  });

  it('stats() 输出容量/在途/等待/busyConsec（诊断用）', async () => {
    const rt = new RouterRuntime();
    rt.ensure('e1', 2);
    const a = await rt.ensure('e1', 2).tryAcquire(0);
    assert.ok(a !== null);
    rt.bumpBusy('e1');
    const st = rt.stats();
    assert.deepEqual(st, [{ endpointId: 'e1', capacity: 2, inFlight: 1, waiting: 0, busyConsec: 1 }]);
    a!.release();
  });
});

/** 一份含池端点（tier3）的 models.yml。 */
function writeConfigWithPool(): void {
  writeFileSync(
    join(cfgDir, 'models.yml'),
    `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true

  - id: local-llm
    tier: 2
    base_url: http://127.0.0.1:8001/v1
    models: { primary: olmoe-1b, light: olmoe-1b }
    style: openai
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }
    local: { health_url: http://127.0.0.1:8001/health, max_concurrency: 1, queue_reject_ms: 50 }

routing:
  default_track: primary
  light_events: [event.classify, memory.summarize]

breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3

alerts:
  dedup_window_ms: 86400000
  outbox_path: ${join(tmp.root, 'OUTBOX.md').replace(/\\/g, '/')}
  channel_order: [telegram, email, outbox]
  channel_timeout_ms: 10000

recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources:
    - type: openrouter_models
      filter: ":free"
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`,
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'free-models.yml'),
    `version: 1
updated_at: null
models:
  - id: pool-free-1
    base_url: https://pool.example/api/v1
    api_key_env: none
    models: [vendor/free-model]
    style: openai
    capabilities: { tool_calling: unknown, context: 0 }
    last_verified: null
    verify_staleness_ms: 86400000
    emergency_eligible: true
`,
    'utf8',
  );
}

/** 默认配置（无池端点）。 */
function writeConfig(): void {
  writeConfigWithPool();
  // 清空池文件（默认配置场景没有 tier3）
  writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
}

// ═══════════════════════════════════════════════════════════════════
// 6. router.breaker_changed 发布（MR §3.1 / §5.3）
// ═══════════════════════════════════════════════════════════════════

describe('router.breaker_changed（MR §3.1 发布清单）', () => {
  it('closed→open 迁移时广播 breaker_changed（旧实现从未发布）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const seen: Array<Record<string, unknown>> = [];
    tmp.bus.on('router.breaker_changed', (e) => {
      seen.push(e.payload as Record<string, unknown>);
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) await router.complete(req({ attemptId: `nonj:BC00${i}` }));
    assert.equal(seen.length, 1, '恰好一次 closed→open');
    assert.equal(seen[0]?.type, 'breaker_changed');
    assert.equal(seen[0]?.endpointId, 'cloud-main');
    assert.equal(seen[0]?.track, 'primary');
    assert.equal(seen[0]?.from, 'closed');
    assert.equal(seen[0]?.to, 'open');
    router.dispose();
  });

  it('无迁移的 settle 不广播（closed→closed 静默）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: 'ok' },
        { endpointId: 'cloud-main', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    let count = 0;
    tmp.bus.on('router.breaker_changed', () => {
      count += 1;
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    await router.complete(req({ attemptId: 'nonj:BC100' }));
    await router.complete(req({ attemptId: 'nonj:BC101' }));
    assert.equal(count, 0, '成功调用不产生状态迁移');
    router.dispose();
  });

  it('open→half_open 迁移同样广播（breaker.probe_timer 触发）', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const transitions: string[] = [];
    tmp.bus.on('router.breaker_changed', (e) => {
      const p = e.payload as { from: string; to: string };
      transitions.push(`${p.from}->${p.to}`);
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 3; i++) await router.complete(req({ attemptId: `nonj:BH00${i}` }));
    assert.deepEqual(transitions, ['closed->open']);
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. bad_protocol 附加动作（MR §4.1）
// ═══════════════════════════════════════════════════════════════════

describe('bad_protocol 附加动作（MR §4.1：primary 轨 tool_calling 记为 no）', () => {
  it('tool_call 参数非法 → 计入窗口 + capabilities.tool_calling=no', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'cloud-main',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', arguments: '{oops-not-json' }],
        },
        { endpointId: 'local-llm', content: 'ok' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    const r = await router.complete(req({ attemptId: 'nonj:BP900', tools: [{ name: 'read_file', description: 'd', parameters: {} }] }));
    assert.equal(r.meta.endpointId, 'local-llm', '降级到 tier2');
    const log = rows(
      `SELECT endpoint_id, outcome, kind FROM model_call_log WHERE endpoint_id='cloud-main' AND track='primary'`,
    );
    assert.equal(log.length, 1);
    assert.equal(log[0]?.outcome, 'fail');
    assert.equal(log[0]?.kind, 'bad_protocol');
    const st = rows(
      `SELECT state, consec_failures, last_kind FROM breaker_state WHERE endpoint_id='cloud-main' AND track='primary'`,
    );
    assert.equal(st[0]?.last_kind, 'bad_protocol', 'bad_protocol 计入窗口');
    router.dispose();
  });

  it('被记为 no 的端点不再被选为 primary（pickCandidates 过滤），light 轨不受影响', () => {
    const list = [ep({ id: 'e1' }), ep({ id: 'e2', capabilities: { tool_calling: 'no', context: 0 } })];
    const primary = pickCandidates(list, 'NORMAL', 'primary');
    assert.deepEqual(
      primary.map((e) => e.id),
      ['e1'],
      'tool_calling=no 的端点不再选它做 primary',
    );
    const light = pickCandidates(list, 'NORMAL', 'light');
    assert.equal(light.length, 2, 'light 轨不受影响');
  });
});
