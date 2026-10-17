/**
 * tests/router-health.test.ts —— 端点健康度评分（迁移自 PilotDeck `ProviderHealthTracker`）。
 *
 * 迁移来源：PilotDeck（AGPL-3.0，github.com/OpenBMB/PilotDeck）的 provider 健康评分。
 * 移植的是**设计与判据**，不是代码——dotd 的熔断器、样本表、契约都是自己的一套。
 *
 * 攻击的真实病灶（本次迁移要填的坑）：
 * 1. `breaker_sample.latency_ms` 从建库起每笔结算都在写，**从来没有人读**——
 *    grep 全仓只有 INSERT 碰它。又一个死列（与 model_call_log.latency_ms 同病）。
 * 2. `pickCandidates` 的同 tier 排序只按**配置声明顺序**（静态）。于是两个都 closed
 *    的端点之间无法排序：一个 99% 成功 / 200ms，另一个 60% 成功 / 8s，请求按声明
 *    顺序均匀撒过去，一半请求被慢端点拖死。"谁现在更快"是动态问题，
 *    声明顺序答不了（§4.2 原文也只说"主人钦定优先级"，没有运行时信号）。
 *
 * 判据（全部可从现有数据算出，不新增 DDL、不建新表）：
 * - 成功率 = 窗口内 ok 占比；延迟分位 = ok 样本 latency 的 p50/p95（失败样本的
 *   latency 基本是超时天花板，混进来 p95 会失去分辨力）；
 * - score = 0.6×成功率 + 0.4×延迟分 × 冷却衰减。
 *
 * 最重要的性质（本文件大半测试都在守它）：
 * **样本不足时不给分，且不给分 ≠ 0 分**。把新端点按 0 分排到最后，它就永远拿不到
 * 流量，永远没有样本，永远排最后——闭环饿死。所以 `rankKey` 返回 null 时
 * `pickCandidates` 必须保持声明顺序。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { Breaker } from '../src/router/breaker.ts';
import { HealthTracker, explainHealth, percentile } from '../src/router/health.ts';
import { pickCandidates } from '../src/router/candidates.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { EndpointDef, Track } from '../src/shared/contracts.ts';

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

function rows(sql: string, ...args: Array<string | number | null>): Array<Record<string, unknown>> {
  return tmp.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

/** 造一个 HealthTracker（db 已建表；clock 可注入假时钟）。 */
function makeTracker(clock = 1_700_000_000_000): {
  tracker: HealthTracker;
  breaker: Breaker;
  /** 推进假时钟（闭包持有同一引用，改了就读到新值）。 */
  advance: (ms: number) => void;
  now: () => number;
} {
  let t = clock;
  const now = () => t;
  const breaker = new Breaker({
    db: tmp.db,
    // 窗口要够大，别让 5min window_ms 把测试样本刷掉
    cfg: {
      window_size: 100,
      window_ms: 3_600_000,
      min_samples: 5,
      failure_ratio: 0.5,
      // 3 次连续失败即 open——与生产默认同值。这个文件要验"open 时分数照算、
      // 只是不可用"，把阈值抬到 100 会让 open 永远造不出来。
      consec_failures: 3,
      backoff_initial_ms: 60_000,
      backoff_max_ms: 3_600_000,
      half_open_success_needed: 2,
      half_open_max_concurrency: 1,
      throttle_max_ms: 120_000,
      busy_consec_limit: 3,
    },
    now,
  });
  return { tracker: new HealthTracker({ breaker, now }), breaker, advance: (ms) => (t += ms), now };
}

/**
 * 经 `breaker.settle()` 灌样本（**不要**直接 INSERT breaker_sample）。
 *
 * 两条理由：一是 settle 是真实路径——latency 从哪来、样本怎么入窗，就该按生产
 * 走法验证；二是 health.ts 读 `throttled_until` / `state` 走的是 breaker 的
 * **内存镜像**（`allRows()`），直接 INSERT 库表的话镜像不更新，冷却/open
 * 相关断言会莫名失败（本次第一版就是这么踩坑的）。
 */
function seed(
  breaker: Breaker,
  endpointId: string,
  track: Track,
  samples: Array<{ ok: boolean; latencyMs: number | null }>,
  extra: { retryAfterMs?: number | null } = {},
): void {
  for (const s of samples) {
    breaker.settle({
      endpointId,
      track,
      ok: s.ok,
      kind: s.ok ? undefined : 'server_error',
      latencyMs: s.latencyMs ?? undefined,
      ...extra,
    });
  }
}

/** 把端点打成 open（3 次连续失败即 open，与生产 consec_failures 同值）。 */
function markOpen(breaker: Breaker, endpointId: string, track: Track): void {
  for (let i = 0; i < 3; i++) {
    breaker.settle({ endpointId, track, ok: false, kind: 'server_error', latencyMs: 10 });
  }
}

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

// ═══════════════════════════════════════════════════════════════════
// 1. 分位纯函数
// ═══════════════════════════════════════════════════════════════════

describe('percentile：线性插值（最近秩法在样本少时没用）', () => {
  it('单样本：任何分位都是它自己', () => {
    assert.equal(percentile([500], 50), 500);
    assert.equal(percentile([500], 95), 500);
  });

  it('两样本：p50 取中点，p95 偏向大值', () => {
    assert.equal(percentile([100, 200], 50), 150);
    assert.equal(percentile([100, 200], 95), 195);
  });

  it('十样本：p50/p95 不恒等于最大/最小值', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(xs, 50), 55);
    assert.equal(percentile(xs, 95), 95.5);
    assert.ok(percentile(xs, 95) < 100, 'p95 不该恒等于最大值');
  });

  it('空数组返回 0（调用方自己判 length，不在这里抛）', () => {
    assert.equal(percentile([], 50), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 评分判据
// ═══════════════════════════════════════════════════════════════════

describe('评分：成功率 × 延迟分位 × 冷却', () => {
  it('样本不足 → score 为 null，且 samples 如实上报（不猜）', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'e1', 'primary', [
      { ok: true, latencyMs: 100 },
      { ok: true, latencyMs: 120 },
    ]);
    const h = tracker.score('e1', 'primary');
    assert.equal(h.samples, 2);
    assert.equal(h.score, null, '不足 minSamples(5) 不给分');
    assert.equal(h.successRate, null, '成功率也不给——没有足够样本谈什么率');
    assert.equal(h.latencyP95, null);
  });

  it('零样本同样 null（新端点的正常状态，不是错误）', () => {
    const { tracker } = makeTracker();
    const h = tracker.score('never-seen', 'primary');
    assert.equal(h.samples, 0);
    assert.equal(h.score, null);
    assert.equal(h.usable, true, '没历史不等于不可用——closed 且未冷却');
  });

  it('全快全成功 → 满分', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'fast', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    const h = tracker.score('fast', 'primary');
    assert.equal(h.successRate, 1);
    assert.equal(h.latencyScore, 1, 'p95 ≤ fastMs(1000) 记满分');
    assert.equal(h.score, 1);
  });

  it('全慢（p95 ≥ slowMs）→ 延迟分 0，只剩成功率那 0.6', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'slow', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 30_000 })));
    const h = tracker.score('slow', 'primary');
    assert.equal(h.latencyScore, 0, 'p95 ≥ slowMs(15000) 记 0 分');
    assert.equal(h.score, 0.6, '成功率仍是 1 → 0.6×1 + 0.4×0');
  });

  it('成功率决定大头：同样快，一半失败的分明显低', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    const good = Array.from({ length: 5 }, () => ({ ok: true, latencyMs: 100 }));
    const bad = Array.from({ length: 5 }, () => ({ ok: false, latencyMs: 100 }));
    seed(breaker, 'good', 'primary', good);
    seed(breaker, 'half', 'primary', [...good, ...bad]);
    const hGood = tracker.score('good', 'primary');
    const hHalf = tracker.score('half', 'primary');
    assert.equal(hHalf.successRate, 0.5);
    assert.ok((hGood.score ?? 0) > (hHalf.score ?? 0), '成功的端点分必须更高');
    // 0.6×0.5 + 0.4×1 = 0.7（失败的样本 latency 不进 p95，延迟分仍是满分）
    assert.equal(hHalf.score, 0.7);
  });

  it('失败样本的 latency 不进分位（否则 p95 被抬成超时线，所有端点一样慢）', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'mix', 'primary', [
      { ok: true, latencyMs: 100 },
      { ok: true, latencyMs: 120 },
      { ok: true, latencyMs: 140 },
      { ok: true, latencyMs: 160 },
      { ok: true, latencyMs: 180 },
      { ok: false, latencyMs: 2000 }, // 失败=超时天花板
      { ok: false, latencyMs: 2000 },
      { ok: false, latencyMs: 2000 },
    ]);
    const h = tracker.score('mix', 'primary');
    assert.equal(h.latencyP95, 176, 'p95 只从 ok 样本算（[100..180] 五点线性插值）');
    assert.equal(h.successRate, 5 / 8);
  });

  it('429 冷却按剩余时间线性扣分，不是断崖', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'cool', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    // 一次 429（Retry-After 7.5s）→ throttled_until 落在 now+7500。
    // ok:false 是 breaker 的**实现现实**：软冷却写在 settle 的失败分支里（429 不 open，
    // 只写 throttled_until），所以只有 ok:false 的 settle 能造出冷却态。
    // 注意 sample 行的 ok=0 会让这次限流进成功率分母——那是熔断器的口径，
    // 与设计文档 §4.1 表格"窗口记 ok"存在实现差异（本次迁移不动熔断语义，只在
    // 测试里如实记下差异）。
    breaker.settle({
      endpointId: 'cool',
      track: 'primary',
      ok: false,
      kind: 'rate_limit',
      latencyMs: 100,
      retryAfterMs: 7500,
    });
    const h = tracker.score('cool', 'primary');
    assert.equal(h.cooldownRemainingMs, 7500);
    assert.ok(h.cooldownFactor > 0 && h.cooldownFactor < 1, '冷却中但没归零');
    assert.equal(h.usable, false, '冷却中的端点不可用');
    assert.ok((h.score ?? 1) < 1, '分数被冷却拉低');
  });

  it('冷却结束 → 冷却惩罚消失，分数回到冷却前（限流样本仍留在窗口里）', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker, advance } = makeTracker(now);
    seed(breaker, 'cool2', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    breaker.settle({
      endpointId: 'cool2',
      track: 'primary',
      ok: false,
      kind: 'rate_limit',
      latencyMs: 100,
      retryAfterMs: 5000,
    });
    const cooled = tracker.score('cool2', 'primary');
    assert.ok((cooled.score ?? 1) < 1, '冷却中分数被压低');
    advance(6000); // 冷却已过
    const h = tracker.score('cool2', 'primary');
    assert.equal(h.cooldownRemainingMs, 0, '冷却计时归零');
    assert.equal(h.cooldownFactor, 1, '惩罚系数回满');
    // 分数回到"冷却前"而不是 1：那次 429 的样本（ok=0）还留在窗口里，
    // 成功率是 8/9。**这是设计意图**——限流确实发生了，事后统计该看得见；
    // 冷却惩罚（让别的端点先上）才是临时的。两者不是一个东西。
    assert.equal(h.successRate, 8 / 9);
    assert.equal(h.score, 0.6 * (8 / 9) + 0.4 * 1);
  });

  it('open 端点：分数照算（UI 要看得见"它本来多好"），但 usable=false', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'down', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    const before = tracker.score('down', 'primary').score;
    markOpen(breaker, 'down', 'primary');
    const h = tracker.score('down', 'primary');
    assert.equal(typeof h.score, 'number', 'open 了照样给分——它度量"表现"，不是"能不能用"');
    assert.equal(h.usable, false, '但不可用：闸门归熔断器管，健康度不插嘴');
    // 3 次失败进窗口 → 成功率被拉低，分数随之下降（这是设计意图：
    // 分数反映近期表现，熔断只反映"现在能不能用"）
    assert.ok((h.score ?? 1) < (before ?? 0), '新失败进窗口，分数跟着掉');
  });

  it('自定义 fast/slow 线：换判据分数跟着变', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'mid', 'primary', Array.from({ length: 6 }, () => ({ ok: true, latencyMs: 3000 })));
    const strict = tracker.score('mid', 'primary', { fastMs: 100, slowMs: 200 });
    const loose = tracker.score('mid', 'primary', { fastMs: 100, slowMs: 60_000 });
    assert.equal(strict.latencyScore, 0, '对"快"要求苛刻 → 3s 算零分');
    assert.ok((loose.latencyScore ?? 0) > 0, '放宽上限 → 同样 3s 有分');
  });

  it('explainHealth：给人看的一句话（含"样本不足"分支）', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    assert.match(explainHealth(tracker.score('x', 'primary')), /样本不足/);
    seed(breaker, 'y', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    assert.match(explainHealth(tracker.score('y', 'primary')), /100% 成功 · p50 100ms/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. rankKey：不给分 ≠ 0 分（本迁移最容易写错的一条）
// ═══════════════════════════════════════════════════════════════════

describe('rankKey：同 tier 排序键', () => {
  it('样本不足 → null（调用方必须保持声明顺序，不得当 0 分）', () => {
    const { tracker } = makeTracker();
    assert.equal(tracker.rankKey('new-guy', 'primary'), null);
  });

  it('冷却中 → 负分段（有分但排在所有非冷却端点之后）', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'c', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    breaker.settle({
      endpointId: 'c',
      track: 'primary',
      ok: false,
      kind: 'rate_limit',
      latencyMs: 100,
      retryAfterMs: 5000,
    });
    assert.equal(tracker.rankKey('c', 'primary'), -1);
  });

  it('不冷却 → 就是分数本身', () => {
    const now = 1_700_000_000_000;
    const { tracker, breaker } = makeTracker(now);
    seed(breaker, 'ok', 'primary', Array.from({ length: 8 }, () => ({ ok: true, latencyMs: 100 })));
    assert.equal(tracker.rankKey('ok', 'primary'), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. pickCandidates 集成：健康度只在同 tier 内、且不饿死新端点
// ═══════════════════════════════════════════════════════════════════

describe('pickCandidates + rankKey：同 tier 内按健康度重排', () => {
  const list = [
    ep({ id: 'slow-first' }), // 声明顺序在前
    ep({ id: 'fast-second' }),
  ];

  it('不传 rankKey → 逐字等于迁移前（声明顺序）', () => {
    assert.deepEqual(
      pickCandidates(list, 'NORMAL', 'primary').map((e) => e.id),
      ['slow-first', 'fast-second'],
    );
  });

  it('两边都有分 → 分高的先试（哪怕它声明在后面）', () => {
    const rank = (id: string) => (id === 'fast-second' ? 0.95 : 0.3);
    assert.deepEqual(
      pickCandidates(list, 'NORMAL', 'primary', rank).map((e) => e.id),
      ['fast-second', 'slow-first'],
      '声明顺序是静态优先级；谁现在更快是运行时信号',
    );
  });

  it('一边没分（null）→ 保持声明顺序，不罚新端点', () => {
    const rankNewFirst = (id: string) => (id === 'fast-second' ? 0.9 : null);
    assert.deepEqual(
      pickCandidates(list, 'NORMAL', 'primary', rankNewFirst).map((e) => e.id),
      ['slow-first', 'fast-second'],
      '新端点没历史 → 不许被 0.9 的那个挤到后面，否则它永远拿不到样本',
    );
    const rankOldFirst = (id: string) => (id === 'slow-first' ? 0.9 : null);
    assert.deepEqual(
      pickCandidates(list, 'NORMAL', 'primary', rankOldFirst).map((e) => e.id),
      ['slow-first', 'fast-second'],
    );
  });

  it('tier 差异永远压倒健康度（降级链的方向不能反）', () => {
    const cross = [ep({ id: 'tier2-fast', tier: 2 }), ep({ id: 'tier1-slow', tier: 1 })];
    const rank = (id: string) => (id === 'tier2-fast' ? 1 : 0.1);
    assert.deepEqual(
      pickCandidates(cross, 'NORMAL', 'primary', rank).map((e) => e.id),
      ['tier1-slow', 'tier2-fast'],
      '本地引擎再快也不能抢先——§4.2 单向降级的根基',
    );
  });

  it('tier3 内部不吃健康度（lastVerifiedAt 已经是那里的运行时信号）', () => {
    const pool = [
      ep({ id: 'pool-old', tier: 3, lastVerifiedAt: 1000 }),
      ep({ id: 'pool-new', tier: 3, lastVerifiedAt: 9000 }),
    ];
    const rank = () => 0.99; // 就算给了分也不该用
    assert.deepEqual(
      pickCandidates(pool, 'NORMAL', 'primary', rank).map((e) => e.id),
      ['pool-new', 'pool-old'],
      '池排序保持 lastVerifiedAt 新者先，两个语义不叠加',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. 端到端：真实路由一次，样本从 breaker_sample 来（死列复活的证明）
// ═══════════════════════════════════════════════════════════════════

describe('端到端：路由一次之后 breaker_sample.latency_ms 第一次被读到', () => {
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

  it('latency_ms 列非 NULL 且健康度能算出来', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: [{ endpointId: 'cloud-main', content: 'ok' }],
      local: { 'local-llm': { health: true, warm: true } },
    });
    const r = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    await r.complete({
      track: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      attemptId: 'nonj:HEALTH01',
    });
    const samples = rows(
      `SELECT ok, latency_ms FROM breaker_sample WHERE endpoint_id='cloud-main' AND track='primary'`,
    );
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.ok, 1);
    assert.equal(typeof samples[0]?.latency_ms, 'number', '结算时把 latency 写进了样本');
    // 只有 1 个样本（< min_samples 5）→ snapshot 不投影 health 字段
    const snap = r.snapshot();
    assert.equal(snap.endpoints.find((e) => e.id === 'cloud-main')?.health, undefined);
    r.dispose();
  });

  it('样本攒够 → snapshot.health 出现，且字段与 tracker 一致', async () => {
    writeConfig();
    const stub = new StubTransport({
      script: Array.from({ length: 6 }, () => ({ endpointId: 'cloud-main', content: 'ok' })),
      local: { 'local-llm': { health: true, warm: true } },
    });
    const r = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    for (let i = 0; i < 6; i++) {
      await r.complete({
        track: 'primary',
        messages: [{ role: 'user', content: 'hi' }],
        attemptId: `nonj:HEALTH1${i}`,
      });
    }
    const h = r.endpointHealth('cloud-main', 'primary');
    assert.equal(h.samples, 6);
    assert.equal(h.successRate, 1);
    assert.equal(h.score, 1);
    const projected = r.snapshot().endpoints.find((e) => e.id === 'cloud-main')?.health;
    assert.ok(projected !== undefined, '样本够了才投影');
    assert.equal(projected?.samples, 6);
    assert.equal(projected?.successRate, 1);
    assert.equal(projected?.score, 1);
    r.dispose();
  });
});
