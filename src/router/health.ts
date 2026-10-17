/**
 * src/router/health.ts —— 端点健康度评分（迁移自 PilotDeck `ProviderHealthTracker`）。
 *
 * 移植的是**设计与判据**，不是代码（PilotDeck 是 AGPL-3.0，dotd 与它的熔断器、
 * journal 契约都不同）。PilotDeck 那边解决的问题：router 只知道"端点开没开"（二值），
 * 于是**两个都 closed 的端点之间无法排序**——一个 99% 成功率 / 200ms，另一个
 * 60% 成功率 / 8s，请求均匀撒过去，一半的用户请求被慢端点拖死。
 * 它的解法是给每个 provider 记一个滚动分数：成功率 × 延迟分位 × 冷却惩罚。
 *
 * dotd 的对应缺口（本次迁移要填的坑）：
 * - `breaker_sample.latency_ms` **从 2026-10-16 起每笔结算都在写，从来没有人读**
 *   （grep 全仓：只有 writeSample 的 INSERT 碰它）。又一个死列。
 * - `pickCandidates` 的同 tier 排序只按**配置声明顺序**（§4.2「主人钦定优先级」），
 *   运行时再快的备胎也永远排在慢的后面——因为声明顺序是静态的，而"谁现在更快"
 *   是动态的。真实病灶见记忆 `dotd-model-layer-live-state`：primary 轨只有一个
 *   候选，没有第二个可比的；一旦主人按 §8 开放问题 6 配上第二个候选，
 *   "两个都 closed，选哪个"就成了每天都要面对的决策。
 *
 * 判据（三条，全部可从现有数据算出，不新增 DDL）：
 * 1. **成功率**：窗口内 ok 样本占比。样本不足 min_samples 时不给分（返回 null），
 *    不猜——新端点没有历史，"假设它健康"和"假设它不健康"都是编造。
 * 2. **延迟分位**：窗口内 ok 样本的 latency_ms 取 p50 / p95。只取 ok 样本：
 *    失败的样本 latency 通常是超时值，混进来会把 p95 抬成超时线，失去分辨力。
 * 3. **冷却惩罚**：429 软冷却（throttled_until）按剩余比例扣分；open / half_open
 *    直接把可用性打成 0（分数照算，供 UI 看"它本来多好"，但排序上不可用）。
 *
 * 合成（PilotDeck 的形状，权重取整好解释）：
 *   score = 0.6 × successRate + 0.4 × latencyScore
 *   score *= cooldownFactor（1 = 无冷却；0 = 冷却中）
 * latencyScore = 1 - clamp((p95 - fast) / (slow - fast))，即 p95 在 fast..slow 之间
 *   线性映射到 1..0；比 fast 快记满分，比 slow 慢记 0 分。
 *
 * 与熔断器的分工（重要，别混）：
 * - 熔断器答"这个端点**能不能用**"（二值闸门，§4.1）。
 * - 健康度答"这个端点**有多好**"（连续分数，只用于同 tier 内的排序）。
 * 健康分**绝不**参与闸门判定——一个慢端点只要还 closed，就该继续服务；把慢降级
 * 成"不可用"会让熔断器的窗口统计与真实流量脱钩（没人访问就没有样本，没有样本
 * 就永远 half_open 不了）。它唯一的作用是排序，且只在样本足够时才说话。
 */

import type { Breaker, BreakerRow } from './breaker.ts';
import type { Track } from '../shared/contracts.ts';

/** 窗口内最少样本数（与 §4.1 min_samples 同源，但独立缺省：探活类端点可能永远到不了）。 */
const DEFAULT_MIN_SAMPLES = 5;
/** latencyScore 的"满分线"：p95 ≤ 此值记 1 0。 */
const DEFAULT_FAST_MS = 1000;
/** latencyScore 的"零分线"：p95 ≥ 此值记 0 分。 */
const DEFAULT_SLOW_MS = 15_000;
/** 成功率的权重（其余给延迟）。 */
const SUCCESS_WEIGHT = 0.6;
/** 延迟分的权重。 */
const LATENCY_WEIGHT = 0.4;

export interface HealthScoreOptions {
  /** 最少样本数；不足则 successRate / latencyScore 均为 null。 */
  minSamples?: number;
  /** p95 满分线（ms）。 */
  fastMs?: number;
  /** p95 零分线（ms）。 */
  slowMs?: number;
  /** 查询时刻（测试假时钟）。 */
  now?: number;
}

/** 一个端点×轨道的健康度快照。 */
export interface EndpointHealth {
  endpointId: string;
  track: Track;
  /** 窗口样本数（含失败）。不足 minSamples 时下面两个为 null。 */
  samples: number;
  /** 成功率 0..1；样本不足 = null（不猜）。 */
  successRate: number | null;
  /** ok 样本 latency 的 p50 / p95（ms）；样本不足或无 ok 样本 = null。 */
  latencyP50: number | null;
  latencyP95: number | null;
  /** 0..1；样本不足 = null。 */
  latencyScore: number | null;
  /** 综合分 0..1；样本不足 = null。 */
  score: number | null;
  /** 429 软冷却剩余（0 = 未冷却）。 */
  cooldownRemainingMs: number;
  /** 冷却衰减系数 0..1（1 = 无冷却）。 */
  cooldownFactor: number;
  /** 当前是否可服务（closed 或 half_open 且未冷却）。 */
  usable: boolean;
}

export interface HealthTrackerStore {
  /** breaker 的窗口明细（breaker_sample 只归 MR 读写，这里复用它已写好的列）。 */
  breaker: Breaker;
  /** 同 tier 排序时的可选参照（缺省用内置 fast/slow 线）。 */
  now?: () => number;
}

/**
 * 端点健康度评分器。
 *
 * 无自己的表、无持久化：全部从 `breaker_sample` 现算。理由：
 * - 那列的样本本来就每笔结算都写（含 latency_ms），再建一张"健康度表"就是双写，
 *   两份账漂移只是时间问题（§4.8 同样的教训）。
 * - 评分是**派生量**，随时可重算；持久化只会得到过期数字。
 */
export class HealthTracker {
  private readonly breaker: Breaker;
  private readonly now: () => number;

  constructor(store: HealthTrackerStore) {
    this.breaker = store.breaker;
    this.now = store.now ?? Date.now;
  }

  /**
   * 单端点×轨道评分。
   *
   * `okLatencies` 只收成功样本：失败的 latency 几乎都是超时天花板（total_ms），
   * 混进来 p95 会被抬到超时线，所有端点看起来一样慢，分数失去分辨力。
   */
  score(endpointId: string, track: Track, opts: HealthScoreOptions = {}): EndpointHealth {
    const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
    const fastMs = opts.fastMs ?? DEFAULT_FAST_MS;
    const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS;
    const now = opts.now ?? this.now();

    const row = this.breakerRow(endpointId, track);
    const { samples, failures, okLatencies } = this.window(endpointId, track, now);

    const cooldownRemainingMs =
      row?.throttled_until === null || row?.throttled_until === undefined
        ? 0
        : Math.max(0, row.throttled_until - now);
    // 冷却按剩余时间对满分线做线性衰减：剩一半时间 → 扣一半分（不是断崖，
    // 断崖会让"刚好冷却完"和"还要冷却 60s"看起来一样）。
    const cooldownFactor =
      cooldownRemainingMs === 0 ? 1 : Math.max(0, 1 - cooldownRemainingMs / Math.max(slowMs, 1));

    const enough = samples >= minSamples;
    const successRate = enough ? (samples - failures) / samples : null;
    const latencyP50 = enough && okLatencies.length > 0 ? percentile(okLatencies, 50) : null;
    const latencyP95 = enough && okLatencies.length > 0 ? percentile(okLatencies, 95) : null;
    const latencyScore =
      latencyP95 === null ? null : clamp01(1 - (latencyP95 - fastMs) / Math.max(slowMs - fastMs, 1));

    let score: number | null = null;
    if (successRate !== null && latencyScore !== null) {
      score = clamp01(SUCCESS_WEIGHT * successRate + LATENCY_WEIGHT * latencyScore) * cooldownFactor;
      score = clamp01(score);
    }

    const state = row?.state ?? 'closed';
    // half_open 视作可用（探活请求本来就要打过去）；busy 之类不在这里——那是
    // route() 循环的即时裁决，与"这个端点整体多好"无关。
    const usable = (state === 'closed' || state === 'half_open') && cooldownRemainingMs === 0;

    return {
      endpointId,
      track,
      samples,
      successRate,
      latencyP50,
      latencyP95,
      latencyScore,
      score,
      cooldownRemainingMs,
      cooldownFactor,
      usable,
    };
  }

  /**
   * 同 tier 内的排序键（`pickCandidates` 用）。
   *
   * 返回 null = "没资格说话"（样本不足或没有历史），调用方必须**保持声明顺序**，
   * 不得当成 0 分排到最后——那等于惩罚新端点，而新端点恰恰最需要被试用。
   * 有分时按分数降序；冷却中的端点（cooldownRemainingMs > 0）排在同分段之后，
   * 免得一次 429 就把备胎永久推到主端点后面。
   */
  rankKey(endpointId: string, track: Track, opts: HealthScoreOptions = {}): number | null {
    const h = this.score(endpointId, track, opts);
    if (h.score === null) return null;
    // 冷却中：在"有分"区间里取一个低于任何非冷却分的值（-1 段），
    // 冷却结束后自然回到自己的分数段。
    return h.cooldownRemainingMs > 0 ? -1 : h.score;
  }

  /** breaker_state 行（不存在 = 从没被访问过，按 closed 对待）。 */
  private breakerRow(endpointId: string, track: Track): BreakerRow | undefined {
    return this.breaker.allRows().find((r) => r.endpoint_id === endpointId && r.track === track);
  }

  /** 窗口样本统计 + ok 样本的延迟列表（升序，供分位计算）。 */
  private window(
    endpointId: string,
    track: Track,
    now: number,
  ): { samples: number; failures: number; okLatencies: number[] } {
    const stats = this.breaker.windowStats(endpointId, track, now);
    const okLatencies = this.breaker
      .okLatencies(endpointId, track, now)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    return { samples: stats.samples, failures: stats.failures, okLatencies };
  }
}

/**
 * 线性插值分位（导出供测试；最近秩法在样本少时跳动太大，
 * 例如 3 个样本的 p95 恒等于最大值，等于没算）。
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = sorted[lo] as number;
  const hiV = sorted[hi] as number;
  return loV + (hiV - loV) * (pos - lo);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 供 CLI/Web UI 显示"为什么这个端点排在后面"。 */
export function explainHealth(h: EndpointHealth): string {
  if (h.score === null) {
    return `样本不足（${h.samples} 条），按声明顺序`;
  }
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const ms = (n: number) => `${Math.round(n)}ms`;
  const latency =
    h.latencyP95 === null ? '无成功样本' : `p50 ${ms(h.latencyP50 ?? 0)} / p95 ${ms(h.latencyP95)}`;
  const cool = h.cooldownRemainingMs > 0 ? `，429 冷却剩 ${ms(h.cooldownRemainingMs)}` : '';
  return `${pct(h.successRate ?? 0)} 成功 · ${latency} · 分 ${pct(h.score)}${cool}`;
}
