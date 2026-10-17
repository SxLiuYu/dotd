/**
 * tests/router-endpoint-concurrency.test.ts —— P1-1 证明③：单并发端点下并发请求必须**排队成功**。
 *
 * ## 缺陷（HEAD 实测）
 * `ModelRouter` 里唯一的请求闸是 `acquireSlot()`，但它：
 *   - `if (ep.local === undefined) return { release: noop }` —— **只对带 `local:` 段的端点生效**；
 *   - 只在 `ep.tier === 2` 的分支里被调用（`ModelRouter.ts:539-560`）。
 * 而 `runModelChain`（Tier1/Tier3/Tier4 的生产主路径）**完全没有闸**。
 *
 * 后果：开并发后，两个请求同时打到 `max_concurrency: 1` 的端点，第二个不会排队，
 * 而是直接并发发出 → 端点返回 busy/429 → 记为失败。开并发只会制造失败。
 *
 * ## 本文件钉住
 * ③-a Tier1（无 local 段，生产主路径）+ 单并发端点：两个并发请求都成功，端点侧并发峰值 = 1；
 * ③-b Tier2 + 带 local 段（max_concurrency:1）：同样排队，不能 busy 失败；
 * ③-c 三个并发：全部成功且峰值仍为 1（逐个放行）；
 * ③-d 串行调用行为逐字不变。
 *
 * ## 观测手段
 * 用**真** `StubTransport` + 一层薄装饰器：只给 `chat()` 加"模拟端点处理耗时"的延迟，
 * 并统计在途峰值。被测代码全部走真件（ModelRouter 的排队逻辑），stub 只当假上游。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { ChatCall, ChatOutcome, ModelTransport } from '../src/router/types.ts';
import type { RouteRequest } from '../src/shared/contracts.ts';

const tmps: TempDataDir[] = [];
const cfgDirs: string[] = [];
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  for (const d of cfgDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
test.after(sweepTempPaths);

interface Rig {
  tmp: TempDataDir;
  router: ModelRouter;
  stub: StubTransport;
  /** 端点侧观测到的并发峰值（>1 = Router 没排队，并发穿透了）。 */
  peak(): number;
  /** 每次 chat 进入时的在途数序列（诊断用）。 */
  trace(): number[];
}

/** 给真 StubTransport 套一层"端点处理耗时 + 并发观测"。 */
function instrument(stub: StubTransport, workMs: number): {
  transport: ModelTransport;
  peak: () => number;
  trace: () => number[];
} {
  let inflight = 0;
  let peak = 0;
  const trace: number[] = [];
  const transport: ModelTransport = {
    async chat(call: ChatCall): Promise<ChatOutcome> {
      inflight += 1;
      trace.push(inflight);
      peak = Math.max(peak, inflight);
      try {
        // 模拟端点真的在处理（这样并发才会重叠；并发穿透才观测得到）
        await new Promise((r) => setTimeout(r, workMs));
        return await stub.chat(call);
      } finally {
        inflight -= 1;
      }
    },
    stream: (call) => stub.stream(call),
    get: (ep, url, o) => stub.get(ep, url, o),
    metadata: (q) => stub.metadata(q),
  };
  return { transport, peak: () => peak, trace: () => trace };
}

function makeRig(opts: {
  tier: 1 | 2;
  withLocal: boolean;
  workMs?: number;
  /** 端点顶层 `max_concurrency`（P1-1 新增的远程端点声明）；不给 = 未声明走兜底。 */
  remoteConcurrency?: number;
}): Rig {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cfgDir = mkdtempSync(join(tmpdir(), 'dotd-ep-conc-'));
  cfgDirs.push(cfgDir);
  mkdirSync(cfgDir, { recursive: true });

  const localLine = opts.withLocal
    ? '    local: { health_url: http://127.0.0.1:8999/health, max_concurrency: 1, queue_reject_ms: 500 }\n'
    : '';
  // 远程端点的显式声明（P1-1 新字段）：顶层 max_concurrency
  const remoteLine = opts.remoteConcurrency !== undefined ? `    max_concurrency: ${opts.remoteConcurrency}\n` : '';
  writeFileSync(
    join(cfgDir, 'models.yml'),
    `version: 1
endpoints:
  - id: solo
    tier: ${opts.tier}
    base_url: https://solo.example/api/v1
    api_key_env: SOLO_KEY
    models: { primary: solo-model, light: solo-model }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true
${localLine}${remoteLine}
routing:
  default_track: primary
  light_events: []
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
  channel_timeout_ms: 1000
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

  const stub = new StubTransport({
    // fallback 是**按条消费**的（take() 里 shift()）：并发 N 个请求就要 N 条。
    // 少给会让后到的请求拿到"预置耗尽"异常，被误判成端点失败。
    fallback: Array.from({ length: 8 }, () => ({ endpointId: '*', content: 'ok' })),
    local: { solo: { health: true, warm: true } },
  });
  const { transport, peak, trace } = instrument(stub, opts.workMs ?? 40);

  const router = ModelRouter.load({
    db: tmp.db,
    configDir: cfgDir,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport,
  });
  return { tmp, router, stub, peak, trace };
}

function req(tag: string): RouteRequest {
  return {
    track: 'primary',
    messages: [{ role: 'user', content: tag }],
    attemptId: `nonj:${tag}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ③ 单并发端点 + 并发请求 → 第二个必须排队后成功
// ═══════════════════════════════════════════════════════════════════

test('③-a Tier1（生产主路径，无 local 段）+ 单并发端点：两个并发请求都成功，端点侧并发峰值=1', async () => {
  const rig = makeRig({ tier: 1, withLocal: false, remoteConcurrency: 1 });
  const [a, b] = await Promise.all([rig.router.complete(req('A')), rig.router.complete(req('B'))]);

  assert.equal(String((a.response as { content?: string }).content), 'ok');
  assert.equal(String((b.response as { content?: string }).content), 'ok');
  assert.equal(rig.stub.calls.length, 2, '两个请求都真的到达了端点');
  assert.equal(
    rig.peak(),
    1,
    `单并发端点的并发峰值必须是 1（实际 ${rig.peak()}，trace=${rig.trace().join(',')}）` +
      '—— 大于 1 说明 Router 没排队，直接并发穿透',
  );
});

test('③-b Tier2 + 带 local 段（max_concurrency:1）：同样必须排队，不能 busy 失败', async () => {
  const rig = makeRig({ tier: 2, withLocal: true });
  const [a, b] = await Promise.all([rig.router.complete(req('A')), rig.router.complete(req('B'))]);
  assert.equal(String((a.response as { content?: string }).content), 'ok');
  assert.equal(String((b.response as { content?: string }).content), 'ok');
  assert.equal(rig.peak(), 1, `Tier2 本地端点并发峰值必须是 1（实际 ${rig.peak()}）`);
});

test('③-c 三个并发 × 单并发端点：全部成功且峰值仍为 1（排队是逐个放行的）', async () => {
  const rig = makeRig({ tier: 1, withLocal: false, workMs: 30, remoteConcurrency: 1 });
  const results = await Promise.all([
    rig.router.complete(req('A')),
    rig.router.complete(req('B')),
    rig.router.complete(req('C')),
  ]);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(String((r.response as { content?: string }).content), 'ok');
  }
  assert.equal(rig.peak(), 1, `三个并发时峰值仍须为 1（实际 ${rig.peak()}，trace=${rig.trace().join(',')}）`);
  assert.equal(rig.stub.calls.length, 3);
});

test('③-e 未声明并发能力的远程端点：走保守兜底（4），不是无限并发', async () => {
  const rig = makeRig({ tier: 1, withLocal: false, workMs: 20 }); // 不给 remoteConcurrency
  const results = await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => rig.router.complete(req(t))),
  );
  assert.equal(results.length, 6, '六个都成功（排队后依次通过）');
  assert.ok(
    rig.peak() <= 4,
    `未声明时按 DEFAULT_REMOTE_CONCURRENCY=4 兜底，实际峰值 ${rig.peak()}（超过 4 等于没有闸）`,
  );
});

test('③-f 并发上限被显式声明为 2 → 峰值最多 2（声明值严格生效）', async () => {
  const rig = makeRig({ tier: 1, withLocal: false, workMs: 20, remoteConcurrency: 2 });
  await Promise.all(['A', 'B', 'C', 'D'].map((t) => rig.router.complete(req(t))));
  assert.equal(rig.peak(), 2, `声明 max_concurrency:2 时峰值应为 2，实际 ${rig.peak()}`);
});

test('③-d 串行调用（不并发）行为逐字不变：没有任何额外排队延迟', async () => {
  const rig = makeRig({ tier: 1, withLocal: false, workMs: 1 });
  const a = await rig.router.complete(req('A'));
  const b = await rig.router.complete(req('B'));
  assert.equal(String((a.response as { content?: string }).content), 'ok');
  assert.equal(String((b.response as { content?: string }).content), 'ok');
  assert.equal(rig.peak(), 1);
  assert.deepEqual(rig.trace(), [1, 1], '串行时每次进入都在途=1（没有额外挂起）');
});
