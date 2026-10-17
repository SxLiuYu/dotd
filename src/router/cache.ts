/**
 * src/router/cache.ts —— 提示缓存命中率（迁移自 PilotDeck 的 cache-aware switching）。
 *
 * 移植的是**设计与判据**，不是代码（PilotDeck 是 AGPL-3.0）。
 *
 * PilotDeck 那边解决的问题：多个 provider 都能serve同一个请求，但它们的**提示缓存
 * 状态不同**。缓存命中不只省钱——命中部分的 prompt 不用重新前向计算，首字延迟和
 * 吞吐都直接受益。它的解法是按最近的缓存命中率给 provider 排序，优先把请求送给
 * 缓存还热着的那个。
 *
 * dotd 的对应缺口（本次迁移要填的坑）：
 * - `model_call_log.prompt_tokens` 一直在写，但"其中多少命中了缓存"从来没记，
 *   cache-aware 排序无从算起（2026-10-17 加 migration 100 补这一列）；
 * - 更根本的是**冷启动死循环**：健康度排序按实测延迟挑端点，而"谁的缓存热"只能
 *   从历史调用里看出来。一个端点缓存明明是热的，却因为近期没被选中而没有新样本，
 *   于是永远选不中它——命中率数据永远攒不起来。缓存命中率作为独立排序信号，
 *   正是为了打断这个环。
 *
 * 判据（与 health.ts 同源的保守纪律）：
 * - **窗口内调用数不足 min_samples 时不给分（返回 null），不猜**。新端点没有历史，
 *   "假设它缓存热"和"假设它缓存冷"都是编造；
 * - 只统计**有缓存数据的样本**（cached_prompt_tokens 非 NULL）。provider 不报缓存的
 *   样本混进来会把命中率稀释成 0，等于惩罚不支持缓存的引擎——而它们本来就无从命中；
 * - 命中率 = Σcached / Σprompt（按 token 加权，不是按次数的简单平均：一次大 prompt
 *   全命中比十次小 prompt 全命中更值得优先）。
 *
 * 与熔断器/健康度的分工（重要，别混）：
 * - 熔断器答"能不能用"，健康度答"有多可靠"，缓存答"有多热"；
 * - 缓存分**绝不**单独决定排序——它只作为健康度的加权项，且只在有数据时生效。
 *   当前部署（Colibrì / OpenRouter 免费路由 / hy3 代理）没有一家报缓存命中数，
 *   于是这个加权项对 everyone 都是 0，排序与只有健康度时逐字一致。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Track } from '../shared/contracts.ts';

/** 窗口内最少调用数（不足则 hitRate 返回 null，不猜）。 */
const DEFAULT_MIN_SAMPLES = 5;
/** 统计窗口（ms）。与熔断窗口同量级：缓存热度是会过期的，30min 前的命中说明不了现在。 */
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

export interface CacheRateOptions {
  /** 最少样本数（有缓存数据的调用数）；不足则返回 null。 */
  minSamples?: number;
  /** 统计窗口（ms）。 */
  windowMs?: number;
  /** 查询时刻（测试假时钟）。 */
  now?: number;
}

/** 一个端点×轨道的缓存热度快照。 */
export interface EndpointCacheRate {
  endpointId: string;
  track: Track;
  /** 窗口内**有缓存数据**的调用数（cached_prompt_tokens 非 NULL）。 */
  samples: number;
  /** 窗口内总调用数（含不报缓存的）——供 UI 说明"多少样本根本没数据"。 */
  totalCalls: number;
  /** 有缓存数据的样本的 prompt token 总和。 */
  promptTokens: number;
  /** 其中命中的 token 总和。 */
  cachedPromptTokens: number;
  /** 命中率 0..1；samples < minSamples 时为 null（不猜）。 */
  hitRate: number | null;
}

export interface CacheTrackerStore {
  db: DatabaseSync;
  now?: () => number;
}

/**
 * 提示缓存命中率计算器。
 *
 * 无自己的表：全部从 `model_call_log` 现算（派生量，随时可重算；持久化只会得到
 * 过期数字）。只读 `outcome='ok'` 的行——失败调用没有可信的 usage，
 * 而 breaker_skip 那类根本没有发出请求。
 */
export class CacheTracker {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(store: CacheTrackerStore) {
    this.db = store.db;
    this.now = store.now ?? Date.now;
  }

  hitRate(endpointId: string, track: Track, opts: CacheRateOptions = {}): EndpointCacheRate | null {
    const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const now = opts.now ?? this.now();

    const rows = this.db
      .prepare(
        `SELECT prompt_tokens AS pt, cached_prompt_tokens AS cpt
           FROM model_call_log
          WHERE endpoint_id = ? AND track = ? AND outcome = 'ok'
            AND ts >= ? AND prompt_tokens IS NOT NULL
          ORDER BY ts DESC`,
      )
      .all(endpointId, track, now - windowMs) as Array<{ pt: number; cpt: number | null }>;

    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let samples = 0;
    for (const r of rows) {
      if (r.cpt === null) continue; // 这家不报缓存：不计入分子分母（见文件头判据 2）
      samples += 1;
      promptTokens += r.pt;
      cachedPromptTokens += Math.min(r.cpt, r.pt);
    }

    const enough = samples >= minSamples;
    return {
      endpointId,
      track,
      samples,
      totalCalls: rows.length,
      promptTokens,
      cachedPromptTokens,
      hitRate: enough && promptTokens > 0 ? cachedPromptTokens / promptTokens : null,
    };
  }
}

/** 供 CLI/Web UI 显示"这个端点的缓存有多热"。 */
export function explainCacheRate(r: EndpointCacheRate | null): string {
  if (r === null || r.samples === 0) return '无缓存数据（该 provider 不报命中数）';
  if (r.hitRate === null) {
    return `缓存样本不足（${r.samples}/${r.totalCalls} 条有数据），不参与排序`;
  }
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return `${pct(r.hitRate)} 命中 · ${r.cachedPromptTokens}/${r.promptTokens} token · ${r.samples} 条样本`;
}
