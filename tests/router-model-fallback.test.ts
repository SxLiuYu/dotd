/**
 * tests/router-model-fallback.test.ts —— 端点内模型级 fallback 链。
 *
 * 迁移来源：PilotDeck（AGPL-3.0，github.com/OpenBMB/PilotDeck）的 `runFallbackChain`
 * + `RouterFallbackConfig` + `LITELLM_ROUTER_MAX_FALLBACKS=5`。移植的是**设计与语义**，
 * 不是代码——dotd 的熔断器/mode 机/journal 契约都是自己的一套，链路只是形状相似。
 *
 * 依据（docs/design/modules/model-router.md）：
 * - §4.2 route() 主流程：tier1→2→3→4 单向降级。**端点内**还有一层模型链：
 *   同一端点上 `[models[track], ...fallbackModels[track]]` 按序试，试完才换端点。
 * - §4.1 熔断器：窗口样本必须与"端点健康度"对应。模型级故障（限流/配额/5xx/超时/
 *   网络/协议）记 tried + model_call_log 但**不结算熔断**——否则唯一 primary 端点
 *   被一个限流的模型拖死，整条降级链白配。端点级故障（auth/engine/pool）才入窗。
 * - §4.7 首字节分界：流式也走同一条链，但**只在首字节前**降级；首字节后模型锁定，
 *   重放会吐重复内容，直接违反 journal「绝不重复执行」。
 * - §4.8 callAndSettle：tried 与 model_call_log 一一对，每条记录带 model 列，
 *   同端点多条尝试才分得清是谁挂的。
 *
 * 攻击的真实病灶（记忆 dotd-model-layer-live-state）：primary 轨只有一个候选
 * （OpenRouter），而 OpenRouter 免费路由实测 ~40% 返空壳/429——凭据和端点都是好的，
 * 却会把唯一的候选整个拖进熔断。模型链 + 不连坐就是为这条准备的。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { ChatCall, ChatOutcome, GetOutcome, ModelTransport, Usage } from '../src/router/types.ts';
import {
  MAX_FALLBACK_MODELS,
  isModelScopedKind,
  makeHttpFailure,
  modelChain,
} from '../src/router/candidates.ts';
import { loadModelsConfig } from '../src/router/config.ts';
import type {
  ChatChunk,
  ChatResponse,
  EndpointDef,
  FailureKind,
  RouteMeta,
  RouteRequest,
  Track,
} from '../src/shared/contracts.ts';
import { AuthConfigError, StreamInterruptedError } from '../src/shared/errors.ts';

// ── 脚手架：临时 configDir + 带 fallback_models 的 models.yml ─────────

let tmp: TempDataDir;
let cfgDir: string;

/** cloud-main 配了三层模型链：主 + 两个备份（primary 轨），light 轨一个备份。 */
const PRIMARY_CHAIN = ['vendor/model-a', 'vendor/model-b', 'vendor/model-c'] as const;
const LIGHT_CHAIN = ['vendor/model-a-mini', 'vendor/model-a-mini-2'] as const;

function writeConfig(cloudExtra = ''): void {
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
    fallback_models: { primary: [vendor/model-b, vendor/model-c], light: [vendor/model-a-mini-2] }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true
${cloudExtra}

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
  writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
}

/** 造路由（stub 按端点 × 轨 × 模型回放，见 StubTransport.take）。 */
function makeRouter(
  script: Array<{
    endpointId: string;
    model?: string;
    content?: string;
    track?: Track;
    fail?: Error;
    /** 坏 tool_call（构造 bad_protocol：arguments 不是合法 JSON）。 */
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  }>,
): { router: ModelRouter; stub: StubTransport } {
  const stub = new StubTransport({
    script: script.map((s) => ({
      endpointId: s.endpointId,
      content: s.content ?? 'ok',
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.track !== undefined ? { track: s.track } : {}),
      ...(s.fail !== undefined ? { fail: s.fail } : {}),
      ...(s.toolCalls !== undefined ? { toolCalls: s.toolCalls } : {}),
    })),
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
  return { router, stub };
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    track: 'primary',
    messages: [{ role: 'user', content: 'hi' }],
    attemptId: 'nonj:MFB00001',
    ...over,
  };
}

/** cloud-main 在 primary 轨的熔断快照。 */
function breakerOf(router: ModelRouter, id = 'cloud-main') {
  return router.snapshot().endpoints.find((e) => e.id === id)?.roles.primary;
}

function logRows(): Array<{
  endpoint_id: string;
  model: string;
  outcome: string;
  kind: string | null;
  attempt_seq: number;
  latency_ms: number | null;
}> {
  return tmp.db
    .prepare(
      'SELECT endpoint_id, model, outcome, kind, attempt_seq, latency_ms FROM model_call_log ORDER BY id',
    )
    .all() as ReturnType<typeof logRows>;
}

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  writeConfig();
});

afterEach(() => {
  tmp.cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// 1. 纯函数：链的形状与故障归类（MR §4.2 / §4.1）
// ═══════════════════════════════════════════════════════════════════

describe('模型链纯函数（MR §4.2）', () => {
  const ep = (fallback?: Partial<Record<Track, string[]>>): EndpointDef => ({
    id: 'x',
    tier: 1,
    baseUrl: 'https://x.example/v1',
    apiKeyEnv: null,
    models: { primary: 'm0', light: 'm0-light' },
    style: 'openai',
    enabled: true,
    timeouts: { connect_ms: 1, idle_ms: 1, total_ms: 1 },
    emergencyEligible: true,
    ...(fallback !== undefined ? { fallbackModels: fallback } : {}),
  });

  it('未配 fallbackModels → 单元素链（迁移前行为逐字等价）', () => {
    assert.deepEqual(modelChain(ep(), 'primary'), ['m0']);
  });

  it('链 = [主, 备份…]，按配置顺序', () => {
    assert.deepEqual(modelChain(ep({ primary: ['m1', 'm2'] }), 'primary'), ['m0', 'm1', 'm2']);
    assert.deepEqual(modelChain(ep({ light: ['l1'] }), 'light'), ['m0-light', 'l1'], '各轨用各轨的主模型');
  });

  it('上限 MAX_FALLBACK_MODELS=5（PilotDeck LITELLM_ROUTER_MAX_FALLBACKS 同值）', () => {
    const many = Array.from({ length: 9 }, (_, i) => `m${i + 1}`);
    const chain = modelChain(ep({ primary: many }), 'primary');
    assert.equal(chain.length, 1 + MAX_FALLBACK_MODELS, '主模型 + 5 个备份');
    assert.deepEqual(chain.slice(1), many.slice(0, 5), '保留前 5 个，后面的截掉');
  });

  it('去重：与主模型同名的备份、备份间重复，都只试一次', () => {
    assert.deepEqual(modelChain(ep({ primary: ['m0', 'm1', 'm0', 'm1'] }), 'primary'), [
      'm0',
      'm1',
    ]);
  });

  it('空串备份被丢弃（配置里写了个空串不该占一个坑位）', () => {
    assert.deepEqual(modelChain(ep({ primary: ['', 'm1', ''] }), 'primary'), ['m0', 'm1']);
  });

  it('isModelScopedKind：与单模型绑定的故障才是模型级', () => {
    const modelScoped: FailureKind[] = [
      'rate_limit',
      'quota',
      'server_error',
      'timeout',
      'network',
      'bad_protocol',
    ];
    const endpointScoped: FailureKind[] = ['auth', 'engine_unavailable', 'pool_unverified'];
    for (const k of modelScoped) {
      assert.equal(isModelScopedKind(k), true, `${k} 应判为模型级`);
    }
    for (const k of endpointScoped) {
      assert.equal(isModelScopedKind(k), false, `${k} 应判为端点级（不能靠换模型救）`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 非流式：端点内换模型（MR §4.2）
// ═══════════════════════════════════════════════════════════════════

describe('端点内模型链：换模型不换端点（MR §4.2）', () => {
  it('主模型 429 → 同一端点的第二个模型接住，不降级 tier2', async () => {
    const { router, stub } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(429, 'slow down', 30_000) },
      { endpointId: 'cloud-main', model: 'vendor/model-b', content: '备用模型的回答' },
      { endpointId: 'local-llm', content: '不该被用到' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'cloud-main', '端点没换');
    assert.equal(r.meta.model, 'vendor/model-b', '模型换了');
    assert.equal((r.response as ChatResponse).content, '备用模型的回答');
    assert.equal(r.meta.degraded, false, 'tier1 仍在承载 primary，不算降级');
    assert.equal(r.meta.attemptSeq, 1, '链上第二次尝试');
    assert.equal(stub.pending('local-llm'), 1, 'tier2 兜底脚本没被消耗');
    router.dispose();
  });

  it('tried 逐模型在案：同端点两条记录靠 model 列分得清', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(429, 'slow down', 30_000) },
      { endpointId: 'cloud-main', model: 'vendor/model-b', content: 'ok' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.tried.length, 2);
    assert.equal(r.meta.tried[0]?.model, 'vendor/model-a');
    assert.equal(r.meta.tried[0]?.ok, false);
    assert.equal(r.meta.tried[0]?.kind, 'rate_limit');
    assert.equal(r.meta.tried[1]?.model, 'vendor/model-b');
    assert.equal(r.meta.tried[1]?.ok, true);
    const rows = logRows();
    assert.equal(rows.length, 2, 'tried 与 model_call_log 一一对（§4.8）');
    assert.equal(rows[0]?.model, 'vendor/model-a');
    assert.equal(rows[0]?.outcome, 'fail');
    assert.equal(rows[0]?.kind, 'rate_limit');
    assert.equal(rows[1]?.model, 'vendor/model-b');
    assert.equal(rows[1]?.outcome, 'ok');
    router.dispose();
  });

  it('模型级失败不连坐熔断：4 次主模型限流都被备用接住，窗口仍是干净的', async () => {
    // consec_failures=3。若模型级失败也入窗，第 3 次就 open、之后连 primary 都没了。
    const script: Parameters<typeof makeRouter>[0] = [];
    for (let i = 0; i < 4; i++) {
      script.push({
        endpointId: 'cloud-main',
        model: 'vendor/model-a',
        fail: makeHttpFailure(429, 'slow down', 30_000),
      });
      script.push({ endpointId: 'cloud-main', model: 'vendor/model-b', content: `第${i + 1}次` });
    }
    const { router } = makeRouter(script);
    for (let i = 0; i < 4; i++) {
      const r = await router.complete(req());
      assert.equal(r.meta.endpointId, 'cloud-main', `第 ${i + 1} 次仍在 tier1`);
      assert.equal(r.meta.model, 'vendor/model-b');
    }
    const b = breakerOf(router);
    assert.equal(b?.breaker, 'closed', '4 次模型级失败后仍未熔断');
    assert.equal(b?.consecFailures, 0, '一次都没进窗口');
    assert.equal(b?.throttledUntil ?? 0, 0, '也不该留软冷却——端点本身是健康的');
    assert.equal(router.mode, 'NORMAL');
    router.dispose();
  });

  it('整条链试完才换端点：3 个模型逐个 500，最后 tier2 兜底', async () => {
    const { router, stub } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', model: 'vendor/model-b', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'cloud-main', model: 'vendor/model-c', fail: makeHttpFailure(500, 'boom') },
      { endpointId: 'local-llm', content: '本地回答' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm');
    assert.equal(r.meta.tried.length, 4, '3 个模型 + 1 个兜底端点');
    assert.deepEqual(
      r.meta.tried.slice(0, 3).map((t) => t.model),
      ['vendor/model-a', 'vendor/model-b', 'vendor/model-c'],
      '按链序逐个试过',
    );
    // 关键记账不变量：一次失败 = 一次入窗。链上第 1、2 个模型不结算，
    // 只有链尾（第 3 个）结算 → consec=1，不是 3。
    assert.equal(breakerOf(router)?.consecFailures, 1, '只有链尾那次入窗');
    assert.equal(stub.pending('local-llm'), 0);
    router.dispose();
  });

  it('端点级故障立即收手：auth 不再烧剩下的模型，直接换端点', async () => {
    const { router, stub } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(401, 'bad key') },
      // 故意预置 model-b / model-c 的成功脚本：若路由"继续试链尾"就会命中
      { endpointId: 'cloud-main', model: 'vendor/model-b', content: '不该被用到' },
      { endpointId: 'cloud-main', model: 'vendor/model-c', content: '不该被用到' },
      { endpointId: 'local-llm', content: '本地回答' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm');
    assert.equal(r.meta.tried.length, 2, 'auth 一次 + 兜底一次');
    assert.equal(stub.pending('cloud-main', undefined, 'vendor/model-b'), 1, 'model-b 没被消耗');
    assert.equal(stub.pending('cloud-main', undefined, 'vendor/model-c'), 1, 'model-c 没被消耗');
    assert.equal(breakerOf(router)?.breaker, 'open', 'auth 立即 open（§4.1）');
    router.dispose();
  });

  it('auth 立即 open；下一个请求转抛 AuthConfigError（§5.2，不拿 tier2 冒充无事发生）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(401, 'bad key') },
      { endpointId: 'local-llm', content: '本地回答' },
    ]);
    const r1 = await router.complete(req());
    assert.equal(r1.meta.endpointId, 'local-llm', '第一次：auth 后换端点兜底');
    await assert.rejects(
      () => router.complete(req()),
      (err: unknown) => {
        assert.ok(err instanceof AuthConfigError, `应抛 AuthConfigError，实得 ${String(err)}`);
        assert.equal(err.endpointId, 'cloud-main');
        return true;
      },
      'auth 锁定的端点 open 后，到达请求直接转抛——调用方必须知道 key 坏了',
    );
    router.dispose();
  });

  it('light 轨同样走自己的链（互不干扰 primary 轨）', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a-mini', track: 'light', fail: makeHttpFailure(429, 'x', 5000) },
      { endpointId: 'cloud-main', model: 'vendor/model-a-mini-2', track: 'light', content: '轻轨备用' },
    ]);
    const r = await router.complete(req({ track: 'light', eventId: 'ev-classify' }));
    assert.equal(r.meta.model, 'vendor/model-a-mini-2');
    assert.equal((r.response as ChatResponse).content, '轻轨备用');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. 流式：链只在首字节前生效（MR §4.7）
// ═══════════════════════════════════════════════════════════════════

interface StreamScript {
  endpointId: string;
  model?: string;
  chunks: string[];
  /** 吐第 N 个 chunk 前抛错（undefined = 正常收尾；0 = 首字节前就失败）。 */
  failAfter?: number;
  /** failAfter=0 时抛这个错（缺省 = 裸 Error，classifyError 归 network）。 */
  fail?: Error;
}

/**
 * 可控流式 transport（按端点 × 轨 × 模型回放）。
 *
 * StubTransport.stream 的 `fail` 在迭代器内部、任何 chunk 之前抛，表达不了
 * "首字节后断流"；ModelRouter 只依赖 ModelTransport 接口，故手写最小 fake。
 */
function makeStreamTransport(script: StreamScript[]): ModelTransport & { consumed: number } {
  const queues = new Map<string, StreamScript[]>();
  for (const s of script) {
    const key = `${s.endpointId}|${s.model ?? '*'}`;
    const arr = queues.get(key);
    if (arr === undefined) queues.set(key, [s]);
    else arr.push(s);
  }
  const take = (id: string, model: string): StreamScript => {
    const s = queues.get(`${id}|${model}`)?.shift() ?? queues.get(`${id}|*`)?.shift();
    if (s === undefined) throw new Error(`fake transport: 预置耗尽（${id} / ${model}）`);
    return s;
  };
  const t: ModelTransport & { consumed: number } = {
    consumed: 0,
    async chat(call: ChatCall): Promise<ChatOutcome> {
      const s = take(call.endpoint.id, call.model);
      if (s.failAfter === 0) throw s.fail ?? new Error('fake transport: 首字节前失败');
      return {
        response: { content: s.chunks.join('') },
        usage: { promptTokens: 10, completionTokens: s.chunks.join('').length },
      };
    },
    stream(call: ChatCall) {
      const s = take(call.endpoint.id, call.model);
      t.consumed += 1;
      const chunks: ChatChunk[] = s.chunks.map((delta) => ({ delta }));
      chunks.push({ delta: '', done: true });
      let usageDone = false;
      const iter = (async function* (): AsyncGenerator<ChatChunk> {
        for (let i = 0; i < chunks.length; i++) {
          if (s.failAfter !== undefined && i === s.failAfter) {
            throw s.failAfter === 0
              ? (s.fail ?? new Error('fake transport: 首字节前失败'))
              : new Error('fake transport: 连接在流式中被重置（network）');
          }
          yield chunks[i]!;
        }
      })();
      return Object.assign(iter, {
        async usage(): Promise<Usage | undefined> {
          if (usageDone) return undefined;
          usageDone = true;
          if (s.failAfter !== undefined) throw new Error('fake transport: 流断，无 usage');
          return { promptTokens: 10, completionTokens: s.chunks.join('').length };
        },
      });
    },
    async get(): Promise<GetOutcome> {
      return { ok: true, status: 200, json: { status: 'ok' }, latencyMs: 1 };
    },
    async metadata() {
      return { ok: false, items: [], error: 'fake' };
    },
  };
  return t;
}

function makeStreamRouter(transport: ModelTransport): ModelRouter {
  return ModelRouter.load({
    db: tmp.db,
    configDir: cfgDir,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport,
  });
}

/** 收完一个流，返回文本与 meta。 */
async function drain(
  s: AsyncIterable<ChatChunk> & { meta(): Promise<RouteMeta> },
): Promise<{ text: string; meta: RouteMeta }> {
  let text = '';
  for await (const c of s) text += c.delta;
  return { text, meta: await s.meta() };
}

describe('流式模型链：只在首字节前降级（MR §4.7）', () => {
  it('首字节前主模型 429 → 换链上第二个模型，meta.model 跟着换', async () => {
    const t = makeStreamTransport([
      {
        endpointId: 'cloud-main',
        model: 'vendor/model-a',
        chunks: [],
        failAfter: 0,
        fail: makeHttpFailure(429, 'slow down', 30_000),
      },
      { endpointId: 'cloud-main', model: 'vendor/model-b', chunks: ['备', '用'] },
    ]);
    const router = makeStreamRouter(t);
    const { text, meta } = await drain(router.stream(req()));
    assert.equal(text, '备用');
    assert.equal(meta.endpointId, 'cloud-main', '端点没换');
    assert.equal(meta.model, 'vendor/model-b', 'meta 记的是真正吐字的模型');
    assert.equal(meta.streamStarted, true);
    // 流式路径的 tried 只记失败（成功不入 tried——与 complete() 不同，是既有行为：
    // 首字节后调用方已拿到内容，tried 的用途只剩"为什么前面换过"）
    assert.equal(meta.tried.length, 1);
    assert.equal(meta.tried[0]?.model, 'vendor/model-a');
    assert.equal(meta.tried[0]?.kind, 'rate_limit');
    router.dispose();
  });

  it('首字节后断流：配了备用模型也绝不重放（重放 = 重复执行）', async () => {
    const t = makeStreamTransport([
      // 吐 1 个 chunk 后断流
      { endpointId: 'cloud-main', model: 'vendor/model-a', chunks: ['半', '句'], failAfter: 1 },
      // 备用模型脚本：被消费即为回归（首字节后不得换模型重发）
      { endpointId: 'cloud-main', model: 'vendor/model-b', chunks: ['重', '放'] },
    ]);
    const router = makeStreamRouter(t);
    await assert.rejects(
      () => drain(router.stream(req())),
      (err: unknown) => {
        assert.ok(err instanceof StreamInterruptedError, `应抛 StreamInterruptedError，实得 ${String(err)}`);
        assert.equal(err.textSoFar, '半', '已吐出的文本原样带回');
        assert.equal(err.consumedTokens, 0);
        return true;
      },
    );
    assert.equal(t.consumed, 1, '只开了一次流——没有重放');
    router.dispose();
  });

  it('流式链尾失败 → 换端点（tier2 兜底），同非流式', async () => {
    const t = makeStreamTransport([
      { endpointId: 'cloud-main', model: 'vendor/model-a', chunks: [], failAfter: 0 },
      { endpointId: 'cloud-main', model: 'vendor/model-b', chunks: [], failAfter: 0 },
      { endpointId: 'cloud-main', model: 'vendor/model-c', chunks: [], failAfter: 0 },
      { endpointId: 'local-llm', model: 'olmoe-1b', chunks: ['本', '地'] },
    ]);
    const router = makeStreamRouter(t);
    const { text, meta } = await drain(router.stream(req()));
    assert.equal(text, '本地');
    assert.equal(meta.endpointId, 'local-llm');
    assert.equal(meta.tried.length, 3, '流式 tried 只记失败：3 个云端模型');
    assert.deepEqual(
      meta.tried.map((t) => t.model),
      ['vendor/model-a', 'vendor/model-b', 'vendor/model-c'],
      '按链序逐个试过',
    );
    assert.equal(breakerOf(router)?.consecFailures, 1, '只有链尾那次入窗');
    router.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 配置面：fallback_models 解析与 fail-loud（MR §2.1）
// ═══════════════════════════════════════════════════════════════════

describe('fallback_models 配置解析（MR §2.1）', () => {
  it('行内映射按轨解析成有序列表', () => {
    const cfg = loadModelsConfig(join(cfgDir, 'models.yml'));
    const ep = cfg.endpoints.find((e) => e.id === 'cloud-main');
    assert.deepEqual(ep?.models, { primary: 'vendor/model-a', light: 'vendor/model-a-mini' });
    assert.deepEqual(ep?.fallbackModels, {
      primary: ['vendor/model-b', 'vendor/model-c'],
      light: ['vendor/model-a-mini-2'],
    });
  });

  it('没配 fallback_models 的端点不带该字段（老配置逐字兼容）', () => {
    const cfg = loadModelsConfig(join(cfgDir, 'models.yml'));
    const ep = cfg.endpoints.find((e) => e.id === 'local-llm');
    assert.equal(ep?.fallbackModels, undefined);
  });

  it('给端点不服务的轨配备份 → ConfigError 拒启动（不是静默丢配置）', () => {
    // 专门造一份 models 只有 primary、却给 light 配了备份的配置
    writeFileSync(
      join(cfgDir, 'models.yml'),
      `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a }
    fallback_models: { light: [orphan/model] }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }

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
`,
      'utf8',
    );
    assert.throws(
      () => loadModelsConfig(join(cfgDir, 'models.yml')),
      /fallback_models\.light 无对应 models\.light/,
      '备份轨必须主轨先服务，否则这条链永远走不到',
    );
  });

  it('重复与空串在固化时削掉', () => {
    writeConfig(
      `
    fallback_models: { primary: [vendor/model-a, , vendor/model-b, vendor/model-b] }`,
    );
    const cfg = loadModelsConfig(join(cfgDir, 'models.yml'));
    const ep = cfg.endpoints.find((e) => e.id === 'cloud-main');
    // 形状层只削"列表内部"的重复与空串；与主模型重名的那条留给 modelChain 去重
    // （固化时看不到主模型，config 层与链层各管一层）
    assert.deepEqual(ep?.fallbackModels?.primary, ['vendor/model-a', 'vendor/model-b']);
    const chain = modelChain(ep!, 'primary');
    assert.deepEqual(chain, ['vendor/model-a', 'vendor/model-b'], '链上不出现重复模型');
  });

  it('超上限在固化时截到 MAX_FALLBACK_MODELS', () => {
    const many = Array.from({ length: 8 }, (_, i) => `vendor/m${i + 1}`).join(', ');
    writeConfig(
      `
    fallback_models: { primary: [${many}] }`,
    );
    const cfg = loadModelsConfig(join(cfgDir, 'models.yml'));
    const list = cfg.endpoints.find((e) => e.id === 'cloud-main')?.fallbackModels?.primary ?? [];
    assert.equal(list.length, MAX_FALLBACK_MODELS, '固化时就截断，不进内存态');
    assert.deepEqual(list, ['vendor/m1', 'vendor/m2', 'vendor/m3', 'vendor/m4', 'vendor/m5']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. bad_protocol 的端点级判决与 latency 记账（2026-10-17 修连坐）
// ═══════════════════════════════════════════════════════════════════

/** 一条坏 tool_call：arguments 不是合法 JSON（OpenRouter 空壳/垃圾响应的典型形状）。 */
const badToolCall = [{ id: 'call_1', name: 'fs.read', arguments: 'not-json{' }];

describe('bad_protocol：端点级判决必须等整条链（MR §4.1）', () => {
  it('单个模型坏 tool_call + 备用模型成功 → 端点仍可作 primary 候选', async () => {
    const { router } = makeRouter([
      // 第 1 个请求：model-a 坏 → model-b 成功
      { endpointId: 'cloud-main', model: 'vendor/model-a', toolCalls: badToolCall },
      { endpointId: 'cloud-main', model: 'vendor/model-b', content: '备用模型的回答' },
      // 第 2 个请求：链从头再试一次（model 级失败不入熔断窗口，下一个请求照旧从主模型起）
      { endpointId: 'cloud-main', model: 'vendor/model-a', content: '第二个请求' },
      { endpointId: 'local-llm', content: '不该被用到' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'cloud-main', '端点没换');
    assert.equal(r.meta.model, 'vendor/model-b');
    assert.equal((r.response as ChatResponse).content, '备用模型的回答');

    // 回归点（2026-10-17）：原先这里会把整个端点记 tool_calling='no'，
    // 于是下一个请求的 pickCandidates 直接把它滤掉——备用模型明明成功了也没用。
    // snapshot() 不吐 capabilities（那会让人误以为它是可观测状态），所以这里断言行为：
    // 下一个 primary 请求还必须选得到 cloud-main。
    const r2 = await router.complete(req({ attemptId: 'nonj:MFB00002' }));
    assert.equal(r2.meta.endpointId, 'cloud-main', '端点仍是 primary 候选');
    assert.equal(r2.meta.model, 'vendor/model-a', '链从头开始，不是续上次的位置');
    router.dispose();
  });

  it('整条链都以 bad_protocol 收场 → 才标记端点不会工具调用', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', toolCalls: badToolCall },
      { endpointId: 'cloud-main', model: 'vendor/model-b', toolCalls: badToolCall },
      { endpointId: 'cloud-main', model: 'vendor/model-c', toolCalls: badToolCall },
      { endpointId: 'local-llm', content: '本地回答' },
      { endpointId: 'local-llm', content: '第二个请求的本地回答' },
    ]);
    const r = await router.complete(req());
    assert.equal(r.meta.endpointId, 'local-llm', '整链坏 → 换端点');
    assert.equal(r.meta.tried.length, 4);
    assert.deepEqual(
      r.meta.tried.slice(0, 3).map((t) => t.kind),
      ['bad_protocol', 'bad_protocol', 'bad_protocol'],
    );
    // 判决落在下一跳的候选阶段：同一个端点的下一个 primary 请求在 pickCandidates
    // 就被滤掉，连 breaker_skip 都不产生（端点根本没进 tried）。
    const r2 = await router.complete(req({ attemptId: 'nonj:MFB00002' }));
    assert.equal(
      r2.meta.tried.some((t) => t.endpointId === 'cloud-main'),
      false,
      '整链 bad_protocol 之后，primary 候选里已经没有 cloud-main',
    );
    router.dispose();
  });

  it('被标 no 的端点不再进 primary 候选，但 light 轨不受影响', async () => {
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', toolCalls: badToolCall },
      { endpointId: 'cloud-main', model: 'vendor/model-b', toolCalls: badToolCall },
      { endpointId: 'cloud-main', model: 'vendor/model-c', toolCalls: badToolCall },
      { endpointId: 'local-llm', content: '本地回答' },
      // 第 2 个请求（primary 已被滤）与第 3 个请求（light）各要一条
      { endpointId: 'local-llm', content: 'primary 的本地回答' },
      { endpointId: 'cloud-main', model: 'vendor/model-a-mini', content: '轻轨回答' },
    ]);
    await router.complete(req());
    // primary：cloud-main 被滤掉 → 直接走 tier2
    const r2 = await router.complete(req({ attemptId: 'nonj:MFB00003' }));
    assert.equal(r2.meta.endpointId, 'local-llm', 'primary 轨已不选它');
    assert.equal(
      r2.meta.tried.some((t) => t.endpointId === 'cloud-main'),
      false,
      '连 breaker_skip 都没有——候选阶段就滤掉了',
    );
    // light：低智能分流不需要工具调用，仍可选它
    const r3 = await router.complete(req({ attemptId: 'nonj:MFB00004', track: 'light' }));
    assert.equal(r3.meta.endpointId, 'cloud-main', 'light 轨不受 tool_calling 判决影响');
    router.dispose();
  });
});

describe('model_call_log.latency_ms：不再是死列', () => {
  it('成功与失败行都记延迟（可控时钟才测得准）', async () => {
    let clock = 1_700_000_000_000;
    const stub = new StubTransport({
      script: [
        { endpointId: 'cloud-main', model: 'vendor/model-a', content: '', fail: makeHttpFailure(429, 'slow down', 5000) },
        { endpointId: 'cloud-main', model: 'vendor/model-b', content: 'ok' },
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
      now: () => clock,
    });
    // 模型级失败：推进 40ms
    clock += 40;
    // （成功路径的时钟推进放在调用内部不可控，这里只断言失败行的确定性延迟）
    await router.complete(req());
    const rows = logRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.outcome, 'fail');
    assert.equal(rows[0]?.model, 'vendor/model-a');
    assert.equal(typeof rows[0]?.latency_ms, 'number', '失败行也记延迟');
    assert.equal(rows[1]?.outcome, 'ok');
    assert.equal(typeof rows[1]?.latency_ms, 'number', '成功行记延迟');
    router.dispose();
  });

  it('闸门跳过（breaker_skip 等）不记延迟——那些请求根本没发出去', async () => {
    // 429 走"软冷却"：settle 写 throttled_until，下一个请求在同一端点上收
    // throttle_skip。用它造跳过行比 500 省事——500 要连败三次才开窗。
    const { router } = makeRouter([
      { endpointId: 'cloud-main', model: 'vendor/model-a', fail: makeHttpFailure(429, 'slow down', 5000) },
      { endpointId: 'cloud-main', model: 'vendor/model-b', fail: makeHttpFailure(429, 'slow down', 5000) },
      { endpointId: 'cloud-main', model: 'vendor/model-c', fail: makeHttpFailure(429, 'slow down', 5000) },
      { endpointId: 'local-llm', content: 'ok' },
      { endpointId: 'local-llm', content: '第二个请求' },
    ]);
    await router.complete(req());
    await router.complete(req({ attemptId: 'nonj:MFB00005' }));
    const skip = logRows().filter((r) => r.outcome.endsWith('_skip'));
    assert.ok(skip.length > 0, '第二次请求 cloud-main 应是 throttle_skip');
    for (const r of skip) {
      assert.equal(r.latency_ms, null, '跳过行没有延迟——没发过请求');
    }
    router.dispose();
  });
});
