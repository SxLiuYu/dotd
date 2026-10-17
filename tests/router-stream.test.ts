/**
 * tests/router-stream.test.ts —— 流式：首字节分界、断流不重放、meta() 时点。
 *
 * 依据（docs/design/modules/model-router.md，行号为该文档内位置）：
 * - §4.7 分界点 = 首字节：`meta()` 在选定端点、**首个 chunk 下发前** resolve；
 *   `RouteMeta.streamStarted` 自此为 true。
 * - §4.7 首字节**前**的一切失败等价于非流式：换下一候选，
 *   `recordOk/recordFailure` 在 callEndpoint reject 时点结算——journal 无感。
 * - §4.7 首字节**后**断流（network）：路由**绝不自动换端点重放**（重发会向调用方吐重复
 *   内容，直接违反"绝不重复执行"）——抛 `StreamInterruptedError { consumedTokens,
 *   textSoFar, meta }`，同时 `recordFailure(ep, track, 'network')`。
 * - §4.7 `meta()` 失败语义：首字节前全候选耗尽 → `meta()` reject 与 `stream()` 同步抛
 *   `AllEndpointsDownError`/`NoQualifiedPrimaryError`，`meta()` **永不挂起**。
 * - §4.1：整流未完成不得 recordOk——窗口里它就是不健康。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import type {
  ChatChunk,
  EndpointDef,
  RouteMeta,
  RouteRequest,
  Track,
} from '../src/shared/contracts.ts';
import { AllEndpointsDownError, StreamInterruptedError } from '../src/shared/errors.ts';
import type { ChatCall, ChatOutcome, GetOutcome, ModelTransport, Usage } from '../src/router/types.ts';

let tmp: TempDataDir;
let cfgDir: string;

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeConfig();
});

afterEach(() => {
  tmp.cleanup();
});

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
  writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
}

/** 一条流式脚本：chunks 逐段吐出；`failAfter` = 吐第 N 个 chunk 后抛错。 */
interface StreamScript {
  endpointId: string;
  chunks: string[];
  /** 吐完这些 chunk 后抛错（undefined = 正常收尾）。 */
  failAfter?: number;
  usage?: Usage;
}

/**
 * 可控流式 transport。
 *
 * StubTransport.stream 对 `fail` 是在迭代器内部、**任何 chunk 之前**抛，构造不出
 * "首字节后断流"；而 ModelRouter 只依赖 ModelTransport 接口，故手写最小 fake：
 * chat 走同一套脚本（首字节前失败 → 换候选），stream 逐段回放。
 */
function makeStreamTransport(script: StreamScript[]): ModelTransport {
  const queues = new Map<string, StreamScript[]>();
  for (const s of script) {
    const arr = queues.get(s.endpointId);
    if (arr === undefined) queues.set(s.endpointId, [s]);
    else arr.push(s);
  }
  const take = (id: string): StreamScript | undefined => queues.get(id)?.shift();
  const toOutcome = (s: StreamScript | undefined): ChatOutcome => {
    if (s === undefined) throw new Error('fake transport: chat 预置耗尽');
    return {
      response: { content: s.chunks.join('') },
      usage: s.usage ?? { promptTokens: 10, completionTokens: s.chunks.join('').length },
    };
  };
  return {
    async chat(call: ChatCall): Promise<ChatOutcome> {
      const s = take(call.endpoint.id);
      if (s !== undefined && s.failAfter === 0) throw new Error('stub: chat 阶段即失败');
      return toOutcome(s);
    },
    stream(call: ChatCall) {
      const s = take(call.endpoint.id);
      if (s === undefined) throw new Error('fake transport: stream 预置耗尽');
      const chunks: ChatChunk[] = [];
      for (const c of s.chunks) chunks.push({ delta: c });
      chunks.push({ delta: '', done: true });
      let usageResolved = false;
      const iter = (async function* (): AsyncGenerator<ChatChunk> {
        for (let i = 0; i < chunks.length; i++) {
          if (s.failAfter !== undefined && i === s.failAfter) {
            throw new Error('fake transport: 连接在流式中被重置（network）');
          }
          yield chunks[i]!;
        }
      })();
      return Object.assign(iter, {
        async usage(): Promise<Usage | undefined> {
          if (usageResolved) return undefined;
          usageResolved = true;
          if (s.failAfter !== undefined) throw new Error('fake transport: 流断，无 usage');
          return s.usage ?? { promptTokens: 10, completionTokens: s.chunks.join('').length };
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
}

function makeRouter(transport: ModelTransport): ModelRouter {
  return ModelRouter.load({
    db: tmp.db,
    configDir: cfgDir,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport,
  });
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    track: 'primary' as Track,
    messages: [{ role: 'user', content: 'hi' }],
    attemptId: 'nonj:STREAM01',
    ...over,
  };
}

/** 测试专用查询助手（node:sqlite 的绑定参数只接受标量/ Buffer/ null）。 */
function rows(sql: string, ...args: Array<string | number | null>): Array<Record<string, unknown>> {
  return tmp.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

/** 收完一个流，返回文本与 meta。 */
async function drain(s: AsyncIterable<ChatChunk> & { meta(): Promise<RouteMeta> }) {
  let text = '';
  for await (const c of s) text += c.delta;
  return { text, meta: await s.meta() };
}

describe('流式分界点 = 首字节（MR §4.7）', () => {
  it('正常流：meta() 在首字节前 resolve，chunks 原样吐出', async () => {
    const router = makeRouter(
      makeStreamTransport([{ endpointId: 'cloud-main', chunks: ['你', '好', '世界'] }]),
    );
    const s = router.stream(req());
    const it = s[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value?.delta, '你', '首个 chunk 已就绪');
    // 此刻 meta() 必须已 resolve（首字节前 resolve，§4.7 分界点）
    const m = await s.meta();
    assert.equal(m.endpointId, 'cloud-main');
    assert.equal(m.streamStarted, true);
    assert.equal(m.attemptSeq, 0);
    assert.deepEqual(m.tried, [], '一次成功，无降级痕迹');
    let text = first.value?.delta ?? '';
    for (let n = await it.next(); n.done !== true; n = await it.next()) text += n.value?.delta ?? '';
    assert.equal(text, '你好世界');
    router.dispose();
  });

  it('首字节前失败 → 换下一候选（等价非流式，journal 无感）', async () => {
    const router = makeRouter(
      makeStreamTransport([
        { endpointId: 'cloud-main', chunks: [], failAfter: 0 },
        { endpointId: 'local-llm', chunks: ['本地', '回答'] },
      ]),
    );
    const { text, meta } = await drain(router.stream(req()));
    assert.equal(text, '本地回答', '降级到 tier2 成功');
    assert.equal(meta.endpointId, 'local-llm');
    assert.equal(meta.tier, 2);
    assert.equal(meta.attemptSeq, 1, '第二个候选');
    assert.equal(meta.tried.length, 1, 'tried 记了第一个候选的失败');
    assert.equal(meta.tried[0]?.endpointId, 'cloud-main');
    // 失败在首字节前 → 已入 breaker 窗口
    const samples = rows(`SELECT endpoint_id, ok FROM breaker_sample WHERE endpoint_id='cloud-main'`);
    assert.ok(samples.length >= 1, 'cloud-main 的失败已入窗');
    router.dispose();
  });

  it('首字节前全候选耗尽 → meta() 与 stream() 同步抛耗尽错误（meta() 永不挂起）', async () => {
    const router = makeRouter(
      makeStreamTransport([
        { endpointId: 'cloud-main', chunks: [], failAfter: 0 },
        { endpointId: 'local-llm', chunks: [], failAfter: 0 },
      ]),
    );
    const s = router.stream(req());
    await assert.rejects(async () => {
      for await (const _c of s) void _c;
    }, AllEndpointsDownError);
    await assert.rejects(async () => s.meta(), AllEndpointsDownError, 'meta() 同步 reject，不挂起');
    router.dispose();
  });
});

describe('首字节后断流：绝不重放（MR §4.7）', () => {
  it('断流 → 抛 StreamInterruptedError 带 consumedTokens/textSoFar，不换端点', async () => {
    const router = makeRouter(
      makeStreamTransport([
        { endpointId: 'cloud-main', chunks: ['已经', '吐出的', '半句'], failAfter: 3 },
        // 若路由错误地重放，下面这条会被消费
        { endpointId: 'local-llm', chunks: ['重放内容'] },
      ]),
    );
    const s = router.stream(req());
    let text = '';
    let err: unknown;
    try {
      for await (const c of s) text += c.delta;
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof StreamInterruptedError, `实得 ${String(err)}`);
    assert.equal(err.textSoFar, text);
    assert.equal(text, '已经吐出的半句', '只拿到已吐出的部分');
    assert.ok(err.textSoFar.length > 0, 'textSoFar 非空');
    assert.equal(typeof err.consumedTokens, 'number', 'consumedTokens 有值');
    // tier2 脚本没被消费 → 没有重放
    const log = rows(`SELECT endpoint_id, outcome FROM model_call_log ORDER BY id`);
    assert.deepEqual(
      log.map((r) => `${r.endpoint_id}:${r.outcome}`),
      ['cloud-main:stream_broken'],
      '只记一次 stream_broken，没有第二个端点的调用',
    );
    router.dispose();
  });

  it('断流同时 recordFailure(network)——整流未完成不得 recordOk', async () => {
    const router = makeRouter(
      makeStreamTransport([{ endpointId: 'cloud-main', chunks: ['半句'], failAfter: 1 }]),
    );
    const s = router.stream(req());
    await assert.rejects(async () => {
      for await (const _c of s) void _c;
    }, StreamInterruptedError);
    const samples = rows(`SELECT ok, kind FROM breaker_sample WHERE endpoint_id='cloud-main'`);
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.ok, 0, '记失败');
    assert.equal(samples[0]?.kind, 'network', '断流按 network 归类（§4.7）');
    // 没有 ok 样本混入
    assert.equal(
      rows(`SELECT COUNT(*) AS n FROM breaker_sample WHERE endpoint_id='cloud-main' AND ok=1`)[0]?.n,
      0,
    );
    router.dispose();
  });

  it('断流后同端点熔断按窗口推进（3 次断流 → open）', async () => {
    const router = makeRouter(
      makeStreamTransport([
        { endpointId: 'cloud-main', chunks: ['a'], failAfter: 1 },
        { endpointId: 'cloud-main', chunks: ['b'], failAfter: 1 },
        { endpointId: 'cloud-main', chunks: ['c'], failAfter: 1 },
      ]),
    );
    for (let i = 0; i < 3; i++) {
      const s = router.stream(req({ attemptId: `nonj:STREAM0${i}` }));
      await assert.rejects(async () => {
        for await (const _c of s) void _c;
      }, StreamInterruptedError);
    }
    const v = router.snapshot().endpoints.find((e) => e.id === 'cloud-main');
    assert.equal(v?.roles.primary.breaker, 'open', '连续 3 次断流 → 熔断打开（§4.1）');
    router.dispose();
  });

  it('断流后 meta() 仍可读（调用方需要 meta 做 journal 裁决）', async () => {
    const router = makeRouter(
      makeStreamTransport([{ endpointId: 'cloud-main', chunks: ['半句'], failAfter: 1 }]),
    );
    const s = router.stream(req());
    await assert.rejects(async () => {
      for await (const _c of s) void _c;
    }, StreamInterruptedError);
    const m = await s.meta();
    assert.equal(m.endpointId, 'cloud-main');
    assert.equal(m.streamStarted, true);
    router.dispose();
  });
});

describe('流式与灯轨（MR §2.1 light_events）', () => {
  it('light 轨流式同样走首字节分界', async () => {
    const router = makeRouter(
      makeStreamTransport([{ endpointId: 'cloud-main', chunks: ['摘要', '文本'] }]),
    );
    const { text, meta } = await drain(router.stream(req({ track: 'light' })));
    assert.equal(text, '摘要文本');
    assert.equal(meta.endpointId, 'cloud-main');
    const log = rows(`SELECT track, outcome FROM model_call_log`);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.track, 'light');
    router.dispose();
  });
});
