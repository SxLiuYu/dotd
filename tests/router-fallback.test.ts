/**
 * tests/router-fallback.test.ts —— route 降级脚本回放 + breaker 持久化 + mode 转移。
 *
 * 依据（docs/design/modules/model-router.md，行号为该文档内位置）：
 * - §4.2 route() 主流程：tier1→2→3→4 单向降级，失败不向上涨档重试；
 *   tried 与 model_call_log 一一对；breaker 闸门在候选循环顶裁决。
 * - §4.1 熔断器：连续失败 3 次 open；half_open 到期放行探活；auth 立即 open 且不自动恢复。
 * - §4.3 mode 状态机：tier1 全挂但 tier2 可服务 → LOCAL_FALLBACK；全挂 → TOTAL_OUTAGE；
 *   emergencyActive 位与 mode 同事务落 router_state（daemon 重启不丢）。
 * - CONVENTIONS.md §7：stub 按端点 id × 轨道回放脚本，预置耗尽即抛错（不静默成功）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter, type HeartbeatApi } from '../src/router/ModelRouter.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { ChatResponse, RouteRequest, Track } from '../src/shared/contracts.ts';
import { AllEndpointsDownError, AuthConfigError, NoQualifiedPrimaryError } from '../src/shared/errors.ts';
import { makeHttpFailure } from '../src/router/candidates.ts';

/** RouteResult.response 联合窄化：流式分支才有 asyncIterator。 */
function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && Symbol.asyncIterator in v;
}

// ── 脚手架：临时 configDir + 最小 models.yml ─────────────────────────

let tmp: TempDataDir;
let cfgDir: string;
let jobs: Array<{ name: string; run: () => Promise<void> }>;
const scheduler: HeartbeatApi = {
  registerInternalJob(spec) {
    jobs.push({ name: spec.name, run: spec.run });
  },
};

/** 造一份三端点 models.yml：tier1（云端）+ tier2（本地，带 local 节）。 */
function writeConfig(extra = ''): void {
  mkdirSync(cfgDir, { recursive: true });
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
${extra}
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
  writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
}

/**
 * 造路由（stub transport 按脚本回放）。
 *
 * `localHealth` 默认 true = stub 未配 local 探测时 `/health` 返回 200（§4.2 本地闸门
 * 第一关直接过）；传 false 即构造"本地引擎挂了"（health 503 → engine_unavailable）。
 */
function makeRouter(
  script: Array<{ endpointId: string; content?: string; track?: Track; fail?: Error }>,
  opts: { localHealth?: boolean } = {},
): {
  router: ModelRouter;
  stub: StubTransport;
} {
  const stub = new StubTransport({
    script: script.map((s) => ({
      endpointId: s.endpointId,
      content: s.content ?? 'ok',
      ...(s.track !== undefined ? { track: s.track } : {}),
      ...(s.fail !== undefined ? { fail: s.fail } : {}),
    })),
    local: { 'local-llm': { health: opts.localHealth ?? true, warm: opts.localHealth ?? true } },
  });
  const router = ModelRouter.load({
    db: tmp.db,
    configDir: cfgDir,
    scheduler,
    channels: null,
    bus: tmp.bus,
    transport: stub,
  });
  return { router, stub };
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    track: 'primary',
    messages: [{ role: 'user', content: 'hi' }],
    attemptId: 'nonj:TEST0001',
    ...over,
  };
}

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  jobs = [];
  writeConfig();
});

afterEach(() => {
  tmp.cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// 1. route 降级脚本回放（§4.2）
// ═══════════════════════════════════════════════════════════════════

describe('route 降级脚本回放（MR §4.2）', () => {
  it('tier1 连续 500 → 熔断 open → 后续请求直接降级 tier2', async () => {
    const { router, stub } = makeRouter([
      // tier1 前三次：500（连续失败 3 → open）
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      // tier2 兜底：前两次是 tier1 未熔断期间的降级承载，第三次是 open 后的 breaker_skip 承载
      { endpointId: 'local-llm', content: '本地回答' },
      { endpointId: 'local-llm', content: '本地回答' },
      { endpointId: 'local-llm', content: '本地回答' },
    ]);

    const r1 = await router.complete(req());
    assert.equal(r1.meta.endpointId, 'local-llm', '第 1 次：tier1 失败后降级 tier2');
    // RouteResult.response 是 ChatResponse | AsyncIterable<ChatChunk> 联合：非流式分支窄化
    const body = r1.response;
    assert.ok(!isAsyncIterable(body), 'complete() 返回非流式响应体');
    assert.equal((body as ChatResponse).content, '本地回答');
    assert.equal(r1.meta.tried.length, 2, 'tried 含 tier1 失败 + tier2 成功');
    assert.equal(r1.meta.tried[0]?.endpointId, 'cloud-main');
    assert.equal(r1.meta.tried[0]?.ok, false);
    assert.equal(r1.meta.tried[0]?.kind, 'server_error');
    assert.equal(r1.meta.degraded, true, 'tier2 承载 primary → degraded=true（§4.3）');

    // 第 2 次：tier1 再败一次 → consec=2（未 open），仍降级 tier2
    const r2 = await router.complete(req());
    assert.equal(r2.meta.endpointId, 'local-llm');
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'closed',
      'consec=2 < consec_failures=3，仍未 open',
    );

    // 第 3 次：tier1 第 3 次失败 → open；本圈内 tier2 承载，mode 应落到 LOCAL_FALLBACK
    const r3 = await router.complete(req());
    assert.equal(r3.meta.endpointId, 'local-llm', '第 3 次：tier1 已 open，breaker_skip 后仍走 tier2');
    assert.equal(
      r3.meta.tried.some((t) => t.endpointId === 'cloud-main' && t.ok === false),
      true,
      'tried 记录 breaker_skip',
    );
    assert.equal(stub.pending('cloud-main'), 0, 'open 后不再消耗 tier1 脚本');
    assert.equal(router.mode, 'LOCAL_FALLBACK', 'tier1 open + tier2 承载 → LOCAL_FALLBACK（§4.3）');
    router.dispose();
  });

  it('单向降级：绝不向上涨档重试（tier2 成功后不再试 tier1）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', content: '本地回答' },
      // 故意再放一条 tier1 成功脚本：若路由"涨档重试"就会命中它
      { endpointId: 'cloud-main', content: '不该被用到' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm');
    assert.equal(r.meta.attemptSeq, 1, 'attemptSeq 在单次 route 内自增');
    router.dispose();
  });

  it('全候选失败 → AllEndpointsDownError，tried 逐条在案', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', fail: new Error('本地引擎也挂了') },
    ]);
    await assert.rejects(
      () => router.complete(req()),
      (err: unknown) => {
        assert.ok(err instanceof AllEndpointsDownError, `应抛 AllEndpointsDownError，实得 ${String(err)}`);
        assert.equal(err.tried.length, 2);
        return true;
      },
    );
    router.dispose();
  });

  it('attemptId/attemptSeq 落 model_call_log（§4.8 与 tried 一一对）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', content: 'ok' },
    ]);
    await router.complete(req({ attemptId: 'nonj:LOG0001', eventId: 'ev-1' }));
    const rows = tmp.db
      .prepare('SELECT attempt_id, attempt_seq, endpoint_id, outcome, degraded FROM model_call_log ORDER BY id')
      .all() as Array<{ attempt_id: string; attempt_seq: number; endpoint_id: string; outcome: string; degraded: number }>;
    assert.equal(rows.length, 2, '失败一次 + 成功一次都记账');
    assert.equal(rows[0]?.attempt_id, 'nonj:LOG0001');
    assert.equal(rows[0]?.outcome, 'fail');
    assert.equal(rows[1]?.outcome, 'ok');
    assert.equal(rows[1]?.degraded, 1, 'tier2 承载 primary → degraded=1');
    router.dispose();
  });

  it('429 软冷却：不 open，只写 throttled_until（§4.1）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(429, 'slow down', 30_000) },
      { endpointId: 'local-llm', content: '本地回答' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm');
    const b = router.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(b?.roles.primary.breaker, 'closed', '429 不 open');
    assert.ok((b?.roles.primary.throttledUntil ?? 0) > 0, 'throttled_until 已置');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. breaker 持久化与状态机（§4.1/§4.7）
// ═══════════════════════════════════════════════════════════════════

describe('breaker 持久化与状态机（MR §4.1）', () => {
  it('auth 失败立即 open 且重启后仍锁定，open 后首请求转抛 AuthConfigError', async () => {
    const script = [
      { endpointId: 'cloud-main', fail: makeHttpFailure(401, 'bad key') },
      { endpointId: 'local-llm', content: '本地回答' },
    ];
    const first = makeRouter(script);
    await first.router.complete(req());
    first.router.dispose();

    // 重启：Breaker.loadFromDb 恢复 open + auth 锁定
    const second = makeRouter([{ endpointId: 'local-llm', content: 'ok' }]);
    await assert.rejects(
      () => second.router.complete(req()),
      (err: unknown) => {
        assert.ok(err instanceof AuthConfigError, `应抛 AuthConfigError，实得 ${String(err)}`);
        assert.equal(err.endpointId, 'cloud-main');
        return true;
      },
      'auth 锁定的端点 open 后首个请求转抛，不再把 401 透传给调用方',
    );
    second.router.dispose();
  });

  it('resetBreaker 放行后恢复 closed（主人换 key，§5.1）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(401, 'bad key') },
      { endpointId: 'local-llm', content: 'ok' },
    ]);
    await router.complete(req());
    assert.equal(router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker, 'open');
    router.resetBreaker('cloud-main');
    const b = router.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(b?.roles.primary.breaker, 'closed');
    router.dispose();
  });

  it('连续失败 3 次才 open（consec_failures，不是一次就跳）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(503, 'x') },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'cloud-main', fail: makeHttpFailure(503, 'x') },
      { endpointId: 'local-llm', content: 'ok' },
    ]);
    await router.complete(req());
    let b = router.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(b?.roles.primary.breaker, 'closed', '第 1 次失败不 open');
    assert.equal(b?.roles.primary.consecFailures, 1);
    await router.complete(req());
    b = router.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(b?.roles.primary.consecFailures, 2);
    assert.equal(b?.roles.primary.breaker, 'closed', '第 2 次失败仍不 open');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. mode 状态机与持久化（§4.3）
// ═══════════════════════════════════════════════════════════════════

describe('mode 状态机（MR §4.3）', () => {
  it('tier1 熔断 + tier2 可服务 → LOCAL_FALLBACK 且 emergencyActive=false', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'local-llm', content: 'ok' },
    ]);
    // 三次请求各让 tier1 失败一次：第 3 次后 consec=3 → open，tier2 承载
    await router.complete(req());
    assert.equal(router.mode, 'NORMAL', 'tier1 只失败 1 次，仍可服务');
    await router.complete(req());
    assert.equal(router.mode, 'NORMAL', 'tier1 失败 2 次，仍未熔断');
    await router.complete(req());
    assert.equal(router.mode, 'LOCAL_FALLBACK', 'tier1 第 3 次失败 → open，tier2 可服务');
    assert.equal(router.emergencyActive, false, 'LOCAL_FALLBACK 不算应急收缩');
    const persisted = tmp.db
      .prepare("SELECT value FROM router_state WHERE key='mode'")
      .get() as { value: string } | undefined;
    assert.equal(persisted?.value, 'LOCAL_FALLBACK', 'mode 落 router_state（重启可恢复）');
    router.dispose();
  });

  it('重启后从 router_state 恢复 mode（§4.7 对账第 4 步）', async () => {
    const first = makeRouter([
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'local-llm', content: 'ok' },
    ]);
    await first.router.complete(req());
    await first.router.complete(req());
    await first.router.complete(req());
    assert.equal(first.router.mode, 'LOCAL_FALLBACK');
    first.router.dispose();

    // 同库重开：load() 从 router_state 读回 mode，并因 breaker 仍 open 重算校验
    const second = makeRouter([{ endpointId: 'local-llm', content: 'ok' }]);
    assert.equal(second.router.mode, 'LOCAL_FALLBACK', '重启恢复 mode');
    second.router.dispose();
  });

  it('TOTAL_OUTAGE：两轨都不可服务', async () => {
    const { router } = makeRouter(
      [
        { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      ],
      { localHealth: false },
    );
    // 本地引擎 health 503 → engine_unavailable（立即 open，§4.1）；
    // tier1 第 3 次 500 后也 open → 一圈无任何候选承载
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    assert.equal(router.mode, 'TOTAL_OUTAGE');
    assert.equal(router.emergencyActive, true, 'TOTAL_OUTAGE → emergencyActive=true');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 定时任务与 error 裁决（契约 J4 / §4.2）
// ═══════════════════════════════════════════════════════════════════

describe('定时任务注册与错误裁决（契约 J4 / MR §4.2）', () => {
  it('load() 注册四个内部任务（名字逐字对齐契约 J4）', () => {
    const { router } = makeRouter([{ endpointId: 'cloud-main', content: 'ok' }]);
    const names = jobs.map((j) => j.name).sort();
    assert.deepEqual(names, [
      'breaker.probe_timer',
      'recon.scan',
      'router.janitor',
    ].sort());
    router.dispose();
  });

  it('dispose() 后心跳回调不再执行', async () => {
    const { router } = makeRouter([{ endpointId: 'cloud-main', content: 'ok' }]);
    const probe = jobs.find((j) => j.name === 'breaker.probe_timer');
    assert.ok(probe !== undefined);
    router.dispose();
    await probe.run(); // 不应抛错（disposed 直接返回）
  });

  it('池端点无合格证 + 有待批候选 → NoQualifiedPrimaryError（§4.2 裁决 1）', async () => {
    // 造一个 tier3 池端点（无 last_verified）+ 一条 needs_approval 候选。
    // 场景走真实时序：tier1/tier2 先各自挂到 open，主人才往池里加候选（reload 生效），
    // 此后一次请求里唯一"试过且失败"的就是池端点的 pool_unverified。
    const { router } = makeRouter([
      // tier2 本地引擎挂掉（health 探测失败 → engine_unavailable → 立即 open）
      { endpointId: 'local-llm', fail: new Error('本地引擎也挂了') },
      // tier1 第 3 次失败后 open
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', fail: makeHttpFailure(500, 'boom') },
      // 池端点 tool_roundtrip 失败 → pool_unverified（本轮唯一硬失败）
      { endpointId: 'pool-free-1', fail: new Error('池模型没工具能力') },
    ]);
    // 直接插一条待批侦察候选（走 SQL 只为构造裁决分支，正常路径由 recon.scan 产生）
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, state, found_at, updated_at)
         VALUES ('recon:test0001', 'openrouter_models', 'https://free.example/v1', 'free/model-x',
                 'needs_approval', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    // 前三次请求把 tier1 打到 open（每次 1 次 500）、tier2 立即 open；池此刻还是空的
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    await assert.rejects(() => router.complete(req()), AllEndpointsDownError);
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'open',
      '三次 500 后 tier1 open',
    );
    // 主人往池里加条目（正常路径 = 治理批准侦察候选后由 recon 写文件，这里等价构造）
    writeFileSync(
      join(cfgDir, 'free-models.yml'),
      `version: 1
updated_at: null
models:
  - id: pool-free-1
    base_url: https://free.example/v1
    api_key_env: none
    models: [free/model-x]
    style: openai
    capabilities: { tool_calling: unknown, context: 0 }
    last_verified: null
    verify_staleness_ms: 86400000
    emergency_eligible: true
`,
      'utf8',
    );
    router.reloadConfig();
    // 第 4 次：tier1 已 open（breaker_skip）、tier2 open（breaker_skip）、
    // 池端点 tool_roundtrip 失败 → pool_unverified，且无其他硬故障、有待批候选
    // → 满足裁决 1
    await assert.rejects(
      () => router.complete(req()),
      (err: unknown) => {
        assert.ok(
          err instanceof NoQualifiedPrimaryError,
          `应抛 NoQualifiedPrimaryError，实得 ${String(err)}`,
        );
        return true;
      },
    );
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. 半开探活槽泄漏回归（2026-10-17 实测）
// ═══════════════════════════════════════════════════════════════════

describe('半开探活槽：探活结束必须还槽（MR §4.1）', () => {
  it('half_open 首次成功后不迁移状态，但槽要还——否则后续请求全被 busy_skip 挡死', async () => {
    // 可控时钟：先打满 consec_failures 让 tier1 open，再把时钟推过 next_probe_at。
    let clock = 1_700_000_000_000;
    const stub = new StubTransport({
      script: [
        // 前三次 500 → open
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        { endpointId: 'cloud-main', content: '', fail: makeHttpFailure(500, 'boom') },
        // 第 1 次半开探活成功（half_open_ok=1，状态仍 half_open）
        { endpointId: 'cloud-main', content: '探活一' },
        // 第 2 次半开探活成功（half_open_ok=2 → closed）
        { endpointId: 'cloud-main', content: '探活二' },
        // tier2 兜底脚本（若槽泄漏，半开那两次会降级到这里）
        { endpointId: 'local-llm', content: '本地兜底' },
        { endpointId: 'local-llm', content: '本地兜底' },
        { endpointId: 'local-llm', content: '本地兜底' },
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler,
      channels: null,
      bus: tmp.bus,
      transport: stub,
      now: () => clock,
    });

    // 三次请求把 tier1 打到 open（每次各败一次，tier2 承载）
    for (let i = 0; i < 3; i++) {
      const r = await router.complete(req());
      assert.equal(r.meta.endpointId, 'local-llm');
    }
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'open',
      '三次 500 后 tier1 open',
    );

    // 时钟推过 next_probe_at（首次 open 会把 backoff ×2 = 120s），跑探活心跳：
    // primary 轨只迁移状态，不发合成 ping
    clock += 600_001;
    const probe = jobs.find((j) => j.name === 'breaker.probe_timer');
    assert.ok(probe !== undefined);
    await probe.run();
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'half_open',
      'next_probe_at 到期 → half_open',
    );

    // 第 1 次半开请求：拿到槽、真调 tier1、成功 → half_open_ok=1（状态不变）
    const p1 = await router.complete(req());
    assert.equal(p1.meta.endpointId, 'cloud-main', '半开第 1 次：放行探活请求');
    assert.equal((p1.response as ChatResponse).content, '探活一');
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'half_open',
      'half_open_success_needed=2：1 次成功还不足以上锁 closed',
    );

    // 第 2 次请求：槽必须在第 1 次探活结束时已归还，否则这里被 busy_skip 挡下、
    // half_open_ok 永远停在 1，端点卡在半开状态直到 daemon 重启。
    const p2 = await router.complete(req());
    assert.equal(
      p2.meta.endpointId,
      'cloud-main',
      '半开第 2 次：槽已归还，请求应再次放行（busy_skip 即为回归）',
    );
    assert.equal((p2.response as ChatResponse).content, '探活二');
    assert.equal(
      router.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.roles.primary.breaker,
      'closed',
      '两次连续成功 → closed',
    );
    assert.equal(router.mode, 'NORMAL', 'tier1 恢复承载 primary → NORMAL');
    assert.equal(stub.pending('local-llm'), 0, 'tier2 兜底脚本没被多消耗（没有偷偷降级）');
    router.dispose();
  });
});
