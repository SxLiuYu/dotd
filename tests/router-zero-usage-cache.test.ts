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
import { Breaker } from '../src/router/breaker.ts';
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
// 0. 测试基建：Usage 的唯一构造入口（防"字段不全的强转"复发）
// ═══════════════════════════════════════════════════════════════════

/**
 * 构造 `Usage`，**显式给出每个字段**，不做 `as Usage` 强转。
 *
 * 为什么单开一个 helper：此前本文件用 `{ promptTokens, completionTokens } as Usage`
 * 糊过 tsc，于是"provider 到底报没报缓存"这个信号被**静默省略**——
 * StubTransport 把 `usage` 原样当响应 usage 返回（src/router/transport.ts:268），
 * ModelRouter.logCall 再把 `cachedPromptTokens ?? null` 落库（ModelRouter.ts:1035），
 * 所以"不报"永远是 NULL（= 无缓存数据），而不是"报了但没命中"（= 0）。
 * 两个语义在缓存命中率上是不同的数（cache.ts:107）。这个 helper 让"报了几个字段"
 * 在调用点上肉眼可见；`tests/router-usage-shape.guard.test.ts` 静态挡住 as 强转复发。
 */
function usageOf(promptTokens: number, completionTokens: number, cachedPromptTokens?: number): Usage {
  return {
    promptTokens,
    completionTokens,
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
  };
}

/**
 * 经 `breaker.settle()` 灌健康样本（同 tests/router-health.test.ts:96 的纪律：
 * **不要**直接 INSERT breaker_sample，否则 breaker 的内存镜像不更新）。
 *
 * 排序用例必须靠它先把排序**钉在确定状态**，而不是让空库的"未置位"状态
 * 碰巧等于声明顺序——见下面「排序键」一节的失败复现记录。
 */
function seedHealth(endpointId: string, samples: Array<{ ok: boolean; latencyMs: number }>): void {
  const breaker = new Breaker({ db: tmp.db, now: Date.now, cfg: BREAKER_CFG });
  for (const s of samples) {
    breaker.settle({
      endpointId,
      track: 'primary',
      ok: s.ok,
      ...(s.ok ? {} : { kind: 'server_error' as const }),
      latencyMs: s.latencyMs,
    });
  }
}

/** 与「排序键」用例里 models.yml 的 breaker: 段**同值**（window_ms 决定样本会不会过期）。 */
const BREAKER_CFG = {
  window_size: 20,
  window_ms: 300_000,
  min_samples: 5,
  failure_ratio: 0.5,
  consec_failures: 3,
  backoff_initial_ms: 60_000,
  backoff_max_ms: 3_600_000,
  half_open_success_needed: 2,
  half_open_max_concurrency: 1,
  throttle_max_ms: 120_000,
  busy_consec_limit: 3,
};

// ═══════════════════════════════════════════════════════════════════
// 1. 纯函数：空壳判据（三条同时满足才算，故意保守）
// ═══════════════════════════════════════════════════════════════════

describe('isEmptyShellResponse：三条同时满足才算空壳', () => {
  const resp = (content: string, toolCalls?: ChatResponse['toolCalls']): ChatResponse => ({
    content,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  });
  const u = (completionTokens: number): Usage => usageOf(100, completionTokens);

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
    usage: usageOf(100, 0),
    // 故意不给 cachedPromptTokens：零用量空壳的 provider 不会报缓存命中数。
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
        usage: usageOf(100, 7, 64),
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

/**
 * 本节的小结（修复前 3 个用例在此全红，见各用例注释里的实测记录）：
 *
 * 1. **用例状态的构造必须确定**。旧写法靠"发 12 次 complete 循环、让两端各攒够样本"，
 *    而 12 次里请求打到哪端取决于排序自己 —— 这就是自我指涉的循环构造，最脆。
 *    现在改为：健康样本用 `seedHealth()` 经 breaker.settle 直接灌、缓存样本用
 *    `logCache()` 直接插 model_call_log，两者都是**生产写路径**、且各自独立于排序；
 *    每个用例最后只发**一次** complete，只断言"这一次选了谁"。
 *
 * 2. **不能按端点写 StubTransport 脚本**。它的脚本是每端点一个独立 FIFO
 *    （transport.ts:161 Map / 入队 :210-213 / 消费 :256 / 耗尽 :259 抛错），
 *    而排序会把请求集中到排第一的端点 → 另一端预置永不消费 → 先耗尽的一端被记成
 *    network 失败、连开熔断（实测连续三次 tried:[cache-hot:false,cache-cold:true]，
 *    第 12 次循环直接 AllEndpointsDownError）。本节的 stub 只用 `fallback`
 *    （全局队列、不分桶；take() 先查端点键、查不到才走 fallback，:248-258）。
 */
describe('排序键：缓存不能单独决定排序', () => {
  type Order = readonly ['cache-hot', 'cache-cold'] | readonly ['cache-cold', 'cache-hot'];

  /**
   * 两个同 tier 端点的配置模板。@param order 决定声明顺序
   * （声明顺序 = 同分时的最终裁决，candidates.ts:127）。
   * 只写配置、不造 router——造 router 走 `routerWith()`，顺带消掉了原先
   * "先 new 一个 router 再 dispose、然后重建"的死代码。
   */
  function writeTwoEndpointConfig(order: Order = ['cache-hot', 'cache-cold']): void {
    const blocks: Record<string, string> = {
      'cache-hot': `  - id: cache-hot
    tier: 1
    base_url: https://a.example/v1
    models: { primary: m-a, light: m-a }
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }`,
      'cache-cold': `  - id: cache-cold
    tier: 1
    base_url: https://b.example/v1
    models: { primary: m-b, light: m-b }
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }`,
    };
    writeFileSync(
      join(cfgDir, 'models.yml'),
      `version: 1
endpoints:
${order.map((id) => blocks[id]).join('\n')}
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
  }

  /**
   * 造 router。脚本一律走 `fallback`（全局队列），端点自己的脚本为空，
   * 这样"哪端承载"不会决定"会不会耗尽"——见本节小结第 2 条。
   */
  function routerWith(
    responses: Array<{ content?: string; usage?: Usage }> = [{}],
    order?: Order,
  ): ModelRouter {
    const stub = new StubTransport({
      script: [],
      fallback: responses.map((r) => ({
        content: r.content ?? 'ok',
        usage: r.usage ?? usageOf(100, 7),
      })),
    });
    writeTwoEndpointConfig(order);
    return ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
  }

  /** 一次 complete。本节每个用例只用一次——不靠循环攒状态。 */
  const ask = (router: ModelRouter, attemptId: string) =>
    router.complete({
      track: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      attemptId,
    });

  /**
   * 灌"健康度**逐位相等**"的样本：两端都是 6 样本 0 失败、成功延迟全 10ms。
   *
   * 为什么必须显式灌：空库不是"打平"，是"两端都没分"。`pickCandidates` 在任一侧
   * rankKey 为 null 时**整段跳过缓存项、直接落回声明顺序**（candidates.ts:122-127）。
   * 若不灌，用例会在缓存一行都没被读过的情况下变绿——什么都没验。
   *
   * 为什么延迟写死 10ms 才能逐位相等：score = 0.6*成功率 + 0.4*clamp01(1-(p95-1000)/14000)
   * （health.ts:47-53/142/146），延迟由 breaker_sample 的**成功样本**算 p95
   * （health.ts:195-202）。两端成功率、样本数、p95 全相同 → 分数同一串浮点运算 → 完全相等。
   */
  function seedTiedHealth(): void {
    seedHealth(
      'cache-hot',
      Array.from({ length: 6 }, () => ({ ok: true, latencyMs: 10 })),
    );
    seedHealth(
      'cache-cold',
      Array.from({ length: 6 }, () => ({ ok: true, latencyMs: 10 })),
    );
  }

  /**
   * 直接插 model_call_log 行（缓存统计只读这张表，与 breaker_sample 无关）。
   *
   * `ts` 默认真实 now：CacheTracker 只统计 ts >= now-30min 的行（cache.ts:97，
   * 实测"窗口外补行凑数"无效：5 行里窗口外 4 行 samples 仍计 0），所以必须是窗口内。
   * 窗口内行不影响健康度——健康度读 breaker_sample，两张表互不相干。
   */
  function logCache(
    endpointId: string,
    cached: number | null,
    ts: number = Date.now(),
    attemptSeq = 1,
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
        attemptSeq,
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
        ts,
      );
  }

  /**
   * 灌满 5 条（= min_samples）窗口内缓存样本：
   *   cache-hot  5/5 命中 → hitRate 1
   *   cache-cold 0/5 命中 → hitRate 0（"报了但没命中" = 0，不是 NULL）
   * 少于 5 条时 hitRate 是 null、微调项退化为 0（cache.ts:38/113/121），用例就什么都没验。
   */
  function seedCacheSamples(): void {
    for (let i = 0; i < 5; i++) logCache('cache-hot', 100, Date.now(), i + 1);
    for (let i = 0; i < 5; i++) logCache('cache-cold', 0, Date.now(), i + 1);
  }

  it('健康度打平 → 缓存热的那端被优先选中（平局打破者）', async () => {
    seedTiedHealth();
    seedCacheSamples();
    const router = routerWith();

    // 三个前提先自检：任一不成立，这条用例验的就是别的命题
    const hot = router.endpointHealth('cache-hot', 'primary');
    const cold = router.endpointHealth('cache-cold', 'primary');
    assert.ok(hot.score !== null && cold.score !== null, '两端都必须有分（否则不进缓存微调分支）');
    assert.equal(hot.score, cold.score, '前提①：健康度逐位相等（显式构造，不靠运气）');
    assert.equal(router.endpointCacheRate('cache-hot', 'primary')?.hitRate, 1, '前提②：cache-hot 全命中');
    assert.equal(router.endpointCacheRate('cache-cold', 'primary')?.hitRate, 0, '前提③：cache-cold 全 miss');

    // 健康度相等 + 缓存 1 vs 0 → 排序键相差 CACHE_RANK_WEIGHT*1 = 0.05
    // （ModelRouter.ts:102/1392），cache-hot 必须翻过"声明顺序"赢下来。
    const final = await ask(router, 'nonj:ZUC0001');
    assert.equal(
      final.meta.endpointId,
      'cache-hot',
      '健康度打平时缓存热的那端赢——这正是 cache-aware 要打断的冷启动环',
    );
    router.dispose();
  });

  it('健康度打平 + 缓存冷的那端声明在前 → 缓存热的那端仍被优先选中（证明是缓存而非声明顺序）', async () => {
    // 上一条里"cache-hot 胜出"与"它声明在前"同向，单独看排除不了"其实只是按声明顺序选的"。
    // 把声明顺序反过来：若缓存不参与排序 → 打平落回声明顺序 → 会选 cache-cold；
    // 只有缓存项真的进了排序键，cache-hot 才能翻过声明顺序赢。
    seedTiedHealth();
    seedCacheSamples();
    const router = routerWith([{}], ['cache-cold', 'cache-hot']);

    const hot = router.endpointHealth('cache-hot', 'primary');
    const cold = router.endpointHealth('cache-cold', 'primary');
    assert.equal(hot.score, cold.score, '前提：健康度逐位相等');
    assert.equal(router.endpointCacheRate('cache-hot', 'primary')?.hitRate, 1, 'cache-hot 全命中');
    assert.equal(router.endpointCacheRate('cache-cold', 'primary')?.hitRate, 0, 'cache-cold 全 miss');

    const final = await ask(router, 'nonj:ZUC0002');
    assert.equal(
      final.meta.endpointId,
      'cache-hot',
      '声明顺序与缓存偏好相反时仍选缓存热的——否则这条性质只是"按声明顺序"的假象',
    );
    router.dispose();
  });

  it('缓存热但健康度差 → 健康度赢（省算力不能换成功率）', async () => {
    // 健康样本灌成"cache-hot 差、cache-cold 好"，两端都过 min_samples：
    //   cache-hot  6 样本 1 失败、成功延迟全 10ms → 0.6*(5/6) + 0.4*1 = 0.9
    //   cache-cold 6 样本 0 失败、成功延迟全 10ms → 0.6*(6/6) + 0.4*1 = 1.0
    // 缓存项最多贡献 0.05（CACHE_RANK_WEIGHT），0.1 的健康差翻不过去
    // —— 这正是 ModelRouter.ts:1378-1382 写明的设计意图。
    seedHealth('cache-hot', [
      { ok: true, latencyMs: 10 },
      { ok: true, latencyMs: 10 },
      { ok: true, latencyMs: 10 },
      { ok: true, latencyMs: 10 },
      { ok: false, latencyMs: 10 },
      { ok: true, latencyMs: 10 },
    ]);
    seedHealth(
      'cache-cold',
      Array.from({ length: 6 }, () => ({ ok: true, latencyMs: 10 })),
    );
    seedCacheSamples();
    // 即便 cache-hot 声明在前（对它最有利），也必须被健康度压回去
    const router = routerWith([{}], ['cache-hot', 'cache-cold']);

    assert.equal(router.endpointCacheRate('cache-hot', 'primary')?.hitRate, 1, '前提：缓存确实更热');
    assert.ok(
      (router.endpointHealth('cache-hot', 'primary').score ?? 0) <
        (router.endpointHealth('cache-cold', 'primary').score ?? 0),
      '前提：健康度确实更差',
    );

    const final = await ask(router, 'nonj:ZUW0001');
    assert.equal(
      final.meta.endpointId,
      'cache-cold',
      '为了省算力把请求送给更可能失败的端点，这个交易不划算',
    );
    router.dispose();
  });

  it('没有缓存数据 → 排序与只有健康度时逐字一致（声明顺序）', async () => {
    seedTiedHealth();
    // 一次真调用落库，但 usage 不带 cachedPromptTokens → logCall 落 NULL
    // （ModelRouter.ts:1035 `usage?.cachedPromptTokens ?? null`），NULL 样本被排除在
    // 分子分母之外（cache.ts:107）→ samples 0 → 微调项恒为 0。
    const router = routerWith([{}]);
    assert.equal(router.endpointCacheRate('cache-hot', 'primary')?.samples, 0);
    assert.equal(router.endpointCacheRate('cache-cold', 'primary')?.samples, 0);

    const hot = router.endpointHealth('cache-hot', 'primary');
    const cold = router.endpointHealth('cache-cold', 'primary');
    assert.equal(hot.score, cold.score, '前提：健康度逐位相等 → 只剩声明顺序可决定');

    const final = await ask(router, 'nonj:ZUX0001');
    assert.equal(
      final.meta.endpointId,
      'cache-hot',
      '没有缓存数据时不为一个尚无数据的信号改变现有行为',
    );
    router.dispose();
  });

  it('有缓存数据但没有任何健康样本 → 缓存也不能把端点提到前面', () => {
    // 构造状态：model_call_log 有缓存行，breaker_sample 一行没有。
    // （只插 model_call_log 是安全的——缓存统计只读这张表；健康度读的是另一张。）
    for (let i = 0; i < 6; i++) logCache('cache-cold', 100);
    const router = routerWith([]);
    assert.equal(router.endpointCacheRate('cache-cold', 'primary')?.hitRate, 1, '缓存数据在');
    assert.equal(
      router.endpointHealth('cache-cold', 'primary').score,
      null,
      '但健康度没分 → 复合键必须是 null',
    );
    router.dispose();
  });
});
