/**
 * tests/router-zero-usage-cache.test.ts —— 零用量空壳重试 + 缓存感知排序。
 *
 * 迁移来源：PilotDeck（AGPL-3.0，github.com/OpenBMB/PilotDeck）的 "zero-usage retry"
 * 与 "cache-aware switching"。移植的是**设计与判据**，不是代码。
 *
 * 依据（docs/design/modules/model-router.md §4.1）：响应 200 但内容不可用归
 * bad_protocol 一类处理。本次把其中"零用量空壳"单拆成一个 kind（empty_response），
 * 因为它与 bad_protocol 的**下游判决不同**（见下）。
 *
 * 攻击的真实病灶（记忆 openrouter-free-route-empty-shell）：OpenRouter 免费路由
 * 实测约四成带工具负载的调用回 200 空壳。dotd 此前只挡了"无 choices"那一种，
 * 而"有 choices 但既无正文也无工具调用、completion_tokens=0"这一种会被当成成功：
 *   - breaker 记一个 ok 样本（端点看起来很健康）；
 *   - Runner 的 feedLlm 见 toolCalls 为空 → doneFlag 置真、summaryText 留空；
 *   - 任务以"任务完成"静默收口，没有任何地方会发现模型什么都没说。
 * 两个假象同时成立，所以这个坑必须填。
 *
 * 本文件最重要的两条性质（都在守"别把好端点冤枉死"）：
 * 1. 空壳**不**触发 `capabilities.tool_calling='no'`。空壳是 provider 过载，
 *    不是"这个端点不会调工具"——混进 bad_protocol 会让一次免费路由抖动把端点
 *    永久踢出 primary 轨，直到配置 reload。
 * 2. 缓存分**不能单独决定排序**。它只在健康度有分时做同一档内的微调；
 *    没有缓存数据时（当前部署全部端点都是如此）排序与只有健康度时逐字一致。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { CacheTracker, explainCacheRate } from '../src/router/cache.ts';
import { classifyError, isModelScopedKind } from '../src/router/candidates.ts';
import {
  EmptyResponseError,
  StubTransport,
  isEmptyShellResponse,
  usageCacheRead,
} from '../src/router/transport.ts';
import type { Usage } from '../src/router/types.ts';
import type { ChatResponse, RouteRequest, Track } from '../src/shared/contracts.ts';

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

// ═══════════════════════════════════════════════════════════════════
// 1. 纯函数：空壳判据（三条同时满足才算，故意保守）
// ═══════════════════════════════════════════════════════════════════

describe('isEmptyShellResponse：三条同时满足才算空壳', () => {
  const resp = (content: string, toolCalls?: ChatResponse['toolCalls']): ChatResponse => ({
    content,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  });
  const u = (completionTokens: number): Usage => ({ promptTokens: 100, completionTokens });

  it('无正文 + 无工具调用 + completion_tokens=0 → 空壳', () => {
    assert.equal(isEmptyShellResponse(resp(''), undefined), true, 'usage 缺失也算');
    assert.equal(isEmptyShellResponse(resp(''), u(0)), true);
    assert.equal(isEmptyShellResponse(resp('   \n\t '), u(0)), true, '纯空白也算空');
  });

  it('有正文 → 不是空壳（哪怕 completion_tokens=0）', () => {
    assert.equal(isEmptyShellResponse(resp('好'), u(0)), false);
  });

  it('有工具调用 → 不是空壳（纯工具轮本来就没有正文）', () => {
    const calls = [{ id: 'c1', name: 'fs.read', arguments: '{"path":"/tmp"}' }];
    assert.equal(isEmptyShellResponse(resp('', calls), u(0)), false);
    assert.equal(isEmptyShellResponse(resp('', calls), undefined), false);
  });

  it('provider 真做了功（completion_tokens>0）→ 不是空壳，不重试', () => {
    assert.equal(isEmptyShellResponse(resp(''), u(5)), false, '推理类模型可能把内容放别的字段');
    assert.equal(isEmptyShellResponse(resp(''), u(1)), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 纯函数：缓存命中数解析（认不出 → undefined，不是 0）
// ═══════════════════════════════════════════════════════════════════

describe('usageCacheRead：认不出返回 undefined', () => {
  it('OpenAI/OpenRouter 形状：prompt_tokens_details.cached_tokens', () => {
    assert.equal(usageCacheRead({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } }), 64);
  });

  it('Anthropic 形状：顶层 cache_read_input_tokens', () => {
    assert.equal(usageCacheRead({ input_tokens: 100, cache_read_input_tokens: 40 }), 40);
  });

  it('cached_tokens=0 是"报了但没命中"，与 undefined 区分', () => {
    assert.equal(usageCacheRead({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }), 0);
  });

  it('本地引擎不报缓存 → undefined（不是 0）', () => {
    assert.equal(usageCacheRead({ prompt_tokens: 100, completion_tokens: 7 }), undefined);
    assert.equal(usageCacheRead(undefined), undefined);
    assert.equal(usageCacheRead(null), undefined);
  });

  it('脏数据不当成命中数', () => {
    assert.equal(usageCacheRead({ prompt_tokens_details: { cached_tokens: '64' } }), undefined);
    assert.equal(usageCacheRead({ prompt_tokens_details: { cached_tokens: -1 } }), undefined);
    assert.equal(usageCacheRead({ prompt_tokens_details: null }), undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. 故障归类：empty_response 是模型级，且不连坐 tool_calling
// ═══════════════════════════════════════════════════════════════════

describe('empty_response 归类', () => {
  it('classifyError 认 EmptyResponseError', () => {
    assert.equal(classifyError(new EmptyResponseError('空壳')).kind, 'empty_response');
  });

  it('是模型级故障（换同一端点的下一个模型）', () => {
    assert.equal(isModelScopedKind('empty_response'), true);
  });

  it('与 bad_protocol 是不同 kind（下游判决分道扬镳）', () => {
    assert.equal(classifyError(new EmptyResponseError('空壳')).kind === 'bad_protocol', false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. CacheTracker：命中率与保守纪律
// ═══════════════════════════════════════════════════════════════════

describe('CacheTracker.hitRate', () => {
  /** 直接插 model_call_log 行（缓存统计只读这张表，不需要真发请求）。 */
  function logCall(
    endpointId: string,
    track: Track,
    pt: number,
    cpt: number | null,
    ts: number,
    outcome: 'ok' | 'fail' = 'ok',
  ): void {
    tmp.db
      .prepare(
        `INSERT INTO model_call_log
           (attempt_id, attempt_seq, event_id, track, endpoint_id, model, degraded, outcome, kind,
            latency_ms, prompt_tokens, completion_tokens, cached_prompt_tokens, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `nonj:C${Math.random().toString(36).slice(2, 8)}`,
        1,
        null,
        track,
        endpointId,
        'm',
        0,
        outcome,
        null,
        10,
        pt,
        5,
        cpt,
        ts,
      );
  }

  const T0 = 1_700_000_000_000;

  it('样本不足 min_samples → null（不猜，与 health.ts 同纪律）', () => {
    for (let i = 0; i < 4; i++) logCall('e1', 'primary', 100, 100, T0);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    assert.equal(c.hitRate('e1', 'primary')?.hitRate, null, '4 条不够，不给分');
    assert.equal(c.hitRate('e1', 'primary')?.samples, 4);
  });

  it('按 token 加权，不是按次数平均', () => {
    // 一次大 prompt 全命中 + 四次小 prompt 全 miss：按次数算是 20%，按 token 算是 80%
    logCall('e1', 'primary', 800, 800, T0);
    for (let i = 0; i < 4; i++) logCall('e1', 'primary', 50, 0, T0);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    const r = c.hitRate('e1', 'primary');
    assert.equal(r?.hitRate, 800 / 1000, '大 prompt 全命中更值得优先');
    assert.equal(r?.promptTokens, 1000);
    assert.equal(r?.cachedPromptTokens, 800);
  });

  it('provider 不报缓存的样本不计入分子分母', () => {
    for (let i = 0; i < 5; i++) logCall('e1', 'primary', 100, null, T0);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    const r = c.hitRate('e1', 'primary');
    assert.equal(r?.samples, 0, '没有一条有数据');
    assert.equal(r?.totalCalls, 5, '但总调用数照记（供 UI 说明）');
    assert.equal(r?.hitRate, null);
  });

  it('报了 0 命中的样本照计（"不支持"与"没命中"必须可分）', () => {
    for (let i = 0; i < 5; i++) logCall('e1', 'primary', 100, 0, T0);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    assert.equal(c.hitRate('e1', 'primary')?.hitRate, 0);
  });

  it('只统计 ok 行（失败调用没有可信 usage）', () => {
    for (let i = 0; i < 5; i++) logCall('e1', 'primary', 100, 100, T0, 'fail');
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    assert.equal(c.hitRate('e1', 'primary')?.samples, 0);
  });

  it('窗口过期 → 不计', () => {
    for (let i = 0; i < 5; i++) logCall('e1', 'primary', 100, 100, T0 - 31 * 60 * 1000);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    assert.equal(c.hitRate('e1', 'primary')?.samples, 0);
  });

  it('explainCacheRate：无数据时说"不报命中数"，不说"命中率 0%"', () => {
    assert.equal(explainCacheRate(null), '无缓存数据（该 provider 不报命中数）');
    for (let i = 0; i < 5; i++) logCall('e1', 'primary', 100, null, T0);
    const c = new CacheTracker({ db: tmp.db, now: () => T0 });
    assert.equal(explainCacheRate(c.hitRate('e1', 'primary')), '无缓存数据（该 provider 不报命中数）');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. 端到端：空壳走模型链，且不连坐 tool_calling
// ═══════════════════════════════════════════════════════════════════

describe('端到端：零用量空壳重试', () => {
  /** 三模型链的 cloud-main + tier2 local-llm，与 model-fallback 测试同构。 */
  const PRIMARY_CHAIN = ['vendor/model-a', 'vendor/model-b', 'vendor/model-c'] as const;

  function writeConfig(): void {
    writeFileSync(
      join(cfgDir, 'models.yml'),
      `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    fallback_models: { primary: [vendor/model-b, vendor/model-c] }
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
  channel_order: [outbox]
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

  /** 造路由。脚本项带 usage 才能构造空壳（completionTokens=0 + content=''）。 */
  function makeRouter(
    script: Array<{
      endpointId: string;
      model?: string;
      content?: string;
      usage?: Usage;
      track?: Track;
    }>,
  ): { router: ModelRouter; stub: StubTransport } {
    const stub = new StubTransport({
      script: script.map((s) => ({
        endpointId: s.endpointId,
        content: s.content ?? 'ok',
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.track !== undefined ? { track: s.track } : {}),
        ...(s.usage !== undefined ? { usage: s.usage } : {}),
      })),
      local: { 'local-llm': { health: true, warm: true } },
    });
    writeConfig();
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    return { router, stub };
  }

  const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({
    track: 'primary',
    messages: [{ role: 'user', content: 'hi' }],
    attemptId: 'nonj:ZUC00001',
    ...over,
  });

  /** 空壳脚本项：content 空 + completionTokens 0。 */
  const shell = (endpointId: string, model: string) => ({
    endpointId,
    model,
    content: '',
    usage: { promptTokens: 100, completionTokens: 0 } as Usage,
  });
  const good = (endpointId: string, model: string, content = '真答案') => ({
    endpointId,
    model,
    content,
  });

  function logRows(): Array<{ endpoint_id: string; model: string; outcome: string; kind: string | null; cached_prompt_tokens: number | null }> {
    return tmp.db
      .prepare('SELECT endpoint_id, model, outcome, kind, cached_prompt_tokens FROM model_call_log ORDER BY id')
      .all() as ReturnType<typeof logRows>;
  }

  it('主模型空壳 → 换链上下一个模型，调用方拿到真答案', async () => {
    const { router } = makeRouter([
      shell('cloud-main', PRIMARY_CHAIN[0]),
      good('cloud-main', PRIMARY_CHAIN[1], 'model-b 的答案'),
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.model, PRIMARY_CHAIN[1], '用的是第二个模型');
    assert.equal((r.response as { content: string }).content, 'model-b 的答案');
    assert.equal(r.meta.tried.length, 2, '两次尝试都记账');
    assert.equal(r.meta.tried[0]?.ok, false, '第一次是失败');
    assert.equal(r.meta.tried[0]?.kind, 'empty_response');
    router.dispose();
  });

  it('空壳不入熔断窗口（端点与凭据是好的，坏的是这一个模型）', async () => {
    const { router } = makeRouter([
      shell('cloud-main', PRIMARY_CHAIN[0]),
      good('cloud-main', PRIMARY_CHAIN[1]),
    ]);
    await router.complete(req());
    const snap = router.snapshot();
    const ep = snap.endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(ep?.roles.primary.breaker, 'closed');
    assert.equal(ep?.roles.primary.consecFailures, 0, '模型级故障不连坐端点');
    router.dispose();
  });

  it('整条链都空壳 → 记 kind=empty_response 并换端点', async () => {
    const { router } = makeRouter([
      shell('cloud-main', PRIMARY_CHAIN[0]),
      shell('cloud-main', PRIMARY_CHAIN[1]),
      shell('cloud-main', PRIMARY_CHAIN[2]),
      good('local-llm', 'olmoe-1b', '本地兜底'),
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm', '链尾失败换端点');
    const rows = logRows().filter((x) => x.endpoint_id === 'cloud-main');
    assert.equal(rows.length, 3, '三个模型各记一行');
    assert.ok(rows.every((x) => x.kind === 'empty_response'), 'kind 逐行对得上');
    router.dispose();
  });

  it('空壳不把端点判成"不会工具调用"：连排三次空壳后仍会被再次选中', async () => {
    // 若误走 bad_protocol 路径，三次空壳会把 cloud-main 记
    // capabilities.tool_calling='no'，此后 primary 轨再也选不到它（pickCandidates 滤除）。
    const stub = new StubTransport({
      script: [
        shell('cloud-main', PRIMARY_CHAIN[0]),
        shell('cloud-main', PRIMARY_CHAIN[1]),
        shell('cloud-main', PRIMARY_CHAIN[2]),
        good('local-llm', 'olmoe-1b', '本地兜底'),
        good('cloud-main', PRIMARY_CHAIN[0], 'cloud 恢复'),
      ],
      local: { 'local-llm': { health: true, warm: true } },
    });
    writeConfig();
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    const r1 = await router.complete(req({ attemptId: 'nonj:ZUC00001' }));
    assert.equal(r1.meta.endpointId, 'local-llm');
    const r2 = await router.complete(req({ attemptId: 'nonj:ZUC00002' }));
    assert.equal(
      r2.meta.endpointId,
      'cloud-main',
      '空壳是模型级过载，不是"这个端点不会调工具"——不能把它永久踢出 primary',
    );
    router.dispose();
  });

  it('cached_prompt_tokens 落账：报了就记，不报就是 NULL', async () => {
    const { router } = makeRouter([
      {
        endpointId: 'cloud-main',
        model: PRIMARY_CHAIN[0],
        content: 'ok',
        usage: { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 64 },
      },
      good('local-llm', 'olmoe-1b'),
    ]);
    await router.complete(req());
    const rows = logRows();
    assert.equal(rows[0]?.cached_prompt_tokens, 64, '命中数照记');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. 排序键合成：缓存只在健康度有分时做同一档内的微调
// ═══════════════════════════════════════════════════════════════════

describe('排序键：缓存不能单独决定排序', () => {
  /** 两个同 tier 端点：cache-hot 声明在前，cache-cold 声明在后。 */
  function twoEndpointRouter(): ModelRouter {
    writeFileSync(
      join(cfgDir, 'models.yml'),
      `version: 1
endpoints:
  - id: cache-hot
    tier: 1
    base_url: https://a.example/v1
    models: { primary: m-a, light: m-a }
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }
  - id: cache-cold
    tier: 1
    base_url: https://b.example/v1
    models: { primary: m-b, light: m-b }
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }
routing:
  default_track: primary
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
  channel_order: [outbox]
  channel_timeout_ms: 10000
recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources: []
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`,
      'utf8',
    );
    writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
    return ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: new StubTransport({ script: [] }),
    });
  }

  /**
   * 直接插 model_call_log 行（缓存统计只读这张表，与 breaker_sample 无关）。
   * 时间戳用真实 now——CacheTracker 的窗口是 30min，写死常量会落到窗口外。
   */
  function logCache(endpointId: string, cached: number | null): void {
    tmp.db
      .prepare(
        `INSERT INTO model_call_log
           (attempt_id, attempt_seq, event_id, track, endpoint_id, model, degraded, outcome, kind,
            latency_ms, prompt_tokens, completion_tokens, cached_prompt_tokens, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `nonj:C${Math.random().toString(36).slice(2, 8)}`,
        1,
        null,
        'primary',
        endpointId,
        'm',
        0,
        'ok',
        null,
        10,
        100,
        5,
        cached,
        Date.now(),
      );
  }

  it('健康度打平 → 缓存热的那端被优先选中（平局打破者）', async () => {
    const router = twoEndpointRouter();
    // 两端都没有 breaker 样本 → 健康度都没分 → 排序退化为声明顺序。
    // 这时缓存也不该说话（见下一个测试），所以先各灌 6 条 ok 的健康样本。
    const stub = new StubTransport({
      script: [
        ...Array.from({ length: 6 }, () => ({ endpointId: 'cache-hot', content: 'ok' })),
        ...Array.from({ length: 6 }, () => ({ endpointId: 'cache-cold', content: 'ok' })),
      ],
    });
    // stub 已构造进 router，改用运行时追加脚本的方式灌样本
    void stub;
    router.dispose();

    // 重新造一个，脚本可控
    const r2 = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: new StubTransport({
        script: [
          ...Array.from({ length: 6 }, () => ({
            endpointId: 'cache-hot',
            content: 'ok',
            usage: { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 100 },
          })),
          ...Array.from({ length: 6 }, () => ({
            endpointId: 'cache-cold',
            content: 'ok',
            usage: { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 0 },
          })),
        ],
      }),
    });
    // 交替发请求，让两端都攒够健康样本（pickCandidates 会按排序挑，顺序不固定也行）
    for (let i = 0; i < 12; i++) {
      await r2.complete({
        track: 'primary',
        messages: [{ role: 'user', content: 'hi' }],
        attemptId: `nonj:ZUC${String(i).padStart(4, '0')}`,
      });
    }
    const hot = r2.endpointHealth('cache-hot', 'primary');
    const cold = r2.endpointHealth('cache-cold', 'primary');
    assert.ok(hot.score !== null && cold.score !== null, '两端都攒够了样本');
    assert.equal(
      r2.endpointCacheRate('cache-hot', 'primary')?.hitRate,
      1,
      'cache-hot 全命中',
    );
    assert.equal(
      r2.endpointCacheRate('cache-cold', 'primary')?.hitRate,
      0,
      'cache-cold 全 miss',
    );
    // 两端成功率相同、延迟都极小 → 健康度打平，缓存是唯一的区分信号
    const final = await r2.complete({
      track: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      attemptId: 'nonj:ZUCFFFF',
    });
    assert.equal(
      final.meta.endpointId,
      'cache-hot',
      '健康度打平时缓存热的那端赢——这正是 cache-aware 要打断的冷启动环',
    );
    r2.dispose();
  });

  it('缓存热但健康度差 → 健康度赢（省算力不能换成功率）', async () => {
    const router = twoEndpointRouter();
    router.dispose();
    const r = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: new StubTransport({
        script: [
          // cache-hot：缓存全命中，但 6 次里挂 3 次（成功率 0.5）
          ...Array.from({ length: 3 }, () => ({
            endpointId: 'cache-hot',
            content: 'ok',
            usage: { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 100 },
          })),
          ...Array.from({ length: 3 }, () => ({
            endpointId: 'cache-hot',
            content: '',
            usage: { promptTokens: 100, completionTokens: 0 },
            fail: Object.assign(new Error('boom'), { status: 500 }),
          })),
          // cache-cold：缓存全 miss，但 6 次全成
          ...Array.from({ length: 6 }, () => ({
            endpointId: 'cache-cold',
            content: 'ok',
            usage: { promptTokens: 100, completionTokens: 7, cachedPromptTokens: 0 },
          })),
        ],
      }),
    });
    for (let i = 0; i < 12; i++) {
      await r.complete({
        track: 'primary',
        messages: [{ role: 'user', content: 'hi' }],
        attemptId: `nonj:ZUW${String(i).padStart(4, '0')}`,
      });
    }
    assert.equal(r.endpointCacheRate('cache-hot', 'primary')?.hitRate, 1, '缓存确实更热');
    assert.ok(
      (r.endpointHealth('cache-hot', 'primary').score ?? 0) <
        (r.endpointHealth('cache-cold', 'primary').score ?? 0),
      '但健康度明显更差',
    );
    const final = await r.complete({
      track: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      attemptId: 'nonj:ZUWFFFF',
    });
    assert.equal(
      final.meta.endpointId,
      'cache-cold',
      '为了省算力把请求送给更可能失败的端点，这个交易不划算',
    );
    r.dispose();
  });

  it('没有缓存数据 → 排序与只有健康度时逐字一致（声明顺序）', async () => {
    const router = twoEndpointRouter();
    router.dispose();
    const r = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: new StubTransport({
        script: [
          ...Array.from({ length: 6 }, () => ({ endpointId: 'cache-hot', content: 'ok' })),
          ...Array.from({ length: 6 }, () => ({ endpointId: 'cache-cold', content: 'ok' })),
        ],
      }),
    });
    for (let i = 0; i < 12; i++) {
      await r.complete({
        track: 'primary',
        messages: [{ role: 'user', content: 'hi' }],
        attemptId: `nonj:ZUX${String(i).padStart(4, '0')}`,
      });
    }
    // 两家都不报缓存命中数（stub 默认 usage 没有 cachedPromptTokens）
    assert.equal(r.endpointCacheRate('cache-hot', 'primary')?.samples, 0);
    assert.equal(r.endpointCacheRate('cache-cold', 'primary')?.samples, 0);
    // 健康度打平 → 落回声明顺序，声明在前者先
    const final = await r.complete({
      track: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      attemptId: 'nonj:ZUXFFFF',
    });
    assert.equal(
      final.meta.endpointId,
      'cache-hot',
      '没有缓存数据时不为一个尚无数据的信号改变现有行为',
    );
    r.dispose();
  });

  it('有缓存数据但没有任何健康样本 → 缓存也不能把端点提到前面', () => {
    // 构造状态：model_call_log 有缓存行，breaker_sample 一行没有。
    // （只插 model_call_log 是安全的——缓存统计只读这张表；健康度读的是另一张。）
    for (let i = 0; i < 6; i++) logCache('cache-cold', 100);
    const router = twoEndpointRouter();
    assert.equal(router.endpointCacheRate('cache-cold', 'primary')?.hitRate, 1, '缓存数据在');
    assert.equal(
      router.endpointHealth('cache-cold', 'primary').score,
      null,
      '但健康度没分 → 复合键必须是 null',
    );
    router.dispose();
  });
});
