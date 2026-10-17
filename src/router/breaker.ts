/**
 * src/router/breaker.ts —— 熔断器（端点 × 角色），状态持久化到 SQLite。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §4.1 状态机：closed → open（失败率≥0.5 且窗口≥5样本 / 连续失败≥3 / auth·quota 立即）
 *   → half_open（next_probe_at 到期）→ closed（half_open_ok≥2）；half_open 任一失败 → open
 *   （backoff ×2 上限 1h；quota 类起步 30min）。
 * - §3.2 表：breaker_state（单行状态）/ breaker_sample（环形窗口明细）/
 *   breaker_event（迁移审计，90 天回收）。
 * - §4.1 记账表：429 软冷却（throttled_until，窗口记 ok）、auth 不自动恢复（半开只允许
 *   配置 reload 后触发）、engine_unavailable 起步 5min、pool_unverified 起步 60s。
 * - 契约 D2：全 daemon 共享一条连接，同步事务，无异步 API。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { BreakerState, FailureKind, Track } from '../shared/contracts.ts';
import type { BreakerConfig, BreakerView } from './types.ts';

/** auth 类初始退避：不自动恢复，退避给到上限（半开只允许 reload 后触发，§4.1）。 */
const AUTH_BACKOFF_MS = 3_600_000;
/** quota 类初始退避：§4.1 表格"backoff 起步 30min"。 */
const QUOTA_BACKOFF_MS = 1_800_000;
/** engine_unavailable 初始退避：本地引擎挂了不会秒好（§4.1）。 */
const ENGINE_BACKOFF_MS = 300_000;
/** 429 软冷却上限（§2.1 breaker.throttle_max_ms）。 */
const DEFAULT_THROTTLE_MAX_MS = 120_000;
/** 单条 last_error 截断长度（§3.2 DDL 注释）。 */
const LAST_ERROR_MAX = 500;

/**
 * breaker_state 单行（内存镜像；SQLite 为唯一事实源）。
 * 导出给 health.ts 读 `throttled_until` / `state` 算冷却惩罚——只读，不写。
 */
export interface BreakerRow {
  endpoint_id: string;
  track: Track;
  state: BreakerState;
  opened_at: number | null;
  next_probe_at: number | null;
  backoff_ms: number;
  consec_failures: number;
  half_open_ok: number;
  throttled_until: number | null;
  last_kind: FailureKind | null;
  last_error: string | null;
  updated_at: number;
}

/** 一次调用结算的输入（route() 内每个端点尝试一次）。 */
export interface SettleInput {
  endpointId: string;
  track: Track;
  ok: boolean;
  kind?: FailureKind;
  latencyMs?: number;
  /** 429 Retry-After（毫秒）；超过 throttle_max_ms 按 open 处理（§4.1）。 */
  retryAfterMs?: number | null;
  /** 失败详情（截断后落 last_error）。 */
  detail?: string;
}

export interface BreakerStore {
  /** 供 breaker 读写自己八张表里的三张（契约 D4：只归 MR）。 */
  db: DatabaseSync;
  cfg: BreakerConfig;
  /** 时钟注入（测试用假时钟；缺省 Date.now）。 */
  now?: () => number;
}

/** 半开并发槽：half_open_max_concurrency=1（§4.1 补 rev1 缺口）。 */
export class HalfOpenSlot {
  private held = false;
  constructor(private readonly max: number) {}
  tryAcquire(): boolean {
    if (this.held) return false;
    if (this.max <= 0) return false;
    this.held = true;
    return true;
  }
  release(): void {
    this.held = false;
  }
  get busy(): boolean {
    return this.held;
  }
}

/**
 * 熔断器。
 *
 * 语义要点（全部来自 §4.1）：
 * - 状态**持久化**：每次状态变化同事务写 breaker_state + breaker_event，daemon 重启不丢。
 * - 429 软冷却**不 open**：写 throttled_until，窗口记 ok（不是故障）。
 * - auth 立即 open 且**不自动恢复**：`authLocked` 位阻止定时半开，只有
 *   `allowHalfOpenAfterReload()`（配置 reload 事件）能解开（防烧探活额度）。
 * - quota 立即 open，backoff 起步 30min。
 */
export class Breaker {
  private readonly db: DatabaseSync;
  private readonly cfg: BreakerConfig;
  private readonly now: () => number;
  /** 内存镜像（SQLite 为唯一事实源，此为读加速 + 半开槽这类不可持久化字段）。 */
  private readonly rows = new Map<string, BreakerRow>();
  private readonly halfOpenSlots = new Map<string, HalfOpenSlot>();
  /** auth 熔断锁定：重启不丢（从 last_kind='auth' 且 state='open' 恢复，§4.7 启动对账）。 */
  private readonly authLocked = new Set<string>();
  /** 状态变化监听（ModelRouter 广播 router.breaker_changed / 触发 mode 重算）。 */
  onTransition: ((e: {
    endpointId: string;
    track: Track;
    from: BreakerState;
    to: BreakerState;
    reason: string;
  }) => void) | null = null;

  constructor(store: BreakerStore) {
    this.db = store.db;
    this.cfg = store.cfg;
    this.now = store.now ?? Date.now;
  }

  // ── 行读写（SQLite 为事实源）──────────────────────────────────────

  private key(endpointId: string, track: Track): string {
    return `${endpointId}|${track}`;
  }

  /** 取行（不存在则造 closed 默认行，不写库——避免给未用端点落垃圾行）。 */
  private ensureRow(endpointId: string, track: Track): BreakerRow {
    const k = this.key(endpointId, track);
    const cached = this.rows.get(k);
    if (cached !== undefined) return cached;
    const row = this.db
      .prepare('SELECT * FROM breaker_state WHERE endpoint_id = ? AND track = ?')
      .get(endpointId, track) as BreakerRow | undefined;
    if (row !== undefined) {
      this.rows.set(k, row);
      if (row.state === 'open' && row.last_kind === 'auth') this.authLocked.add(k);
      return row;
    }
    const fresh: BreakerRow = {
      endpoint_id: endpointId,
      track,
      state: 'closed',
      opened_at: null,
      next_probe_at: null,
      backoff_ms: this.cfg.backoff_initial_ms,
      consec_failures: 0,
      half_open_ok: 0,
      throttled_until: null,
      last_kind: null,
      last_error: null,
      updated_at: this.now(),
    };
    this.rows.set(k, fresh);
    return fresh;
  }

  /**
   * 落库：`breaker_state` 每次结算都 upsert（consec_failures 等计数要实时可见），
   * 但 `breaker_event` **只在状态真的变化时**才写一行。
   *
   * 依据（§3.2 表注释逐字）：`breaker_event` 是**迁移审计**（90 天回收），不是样本流水——
   * 样本明细在 `breaker_sample`。若每次 settle 都写 event，一次成功的 route 就会产出
   * `closed→closed` 噪音行，把真正的 closed→open/half_open 迁移淹掉，审计表失去意义。
   */
  private persist(row: BreakerRow, from: BreakerState, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO breaker_state
           (endpoint_id, track, state, opened_at, next_probe_at, backoff_ms, consec_failures,
            half_open_ok, throttled_until, last_kind, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_id, track) DO UPDATE SET
           state=excluded.state, opened_at=excluded.opened_at, next_probe_at=excluded.next_probe_at,
           backoff_ms=excluded.backoff_ms, consec_failures=excluded.consec_failures,
           half_open_ok=excluded.half_open_ok, throttled_until=excluded.throttled_until,
           last_kind=excluded.last_kind, last_error=excluded.last_error,
           updated_at=excluded.updated_at`,
      )
      .run(
        row.endpoint_id,
        row.track,
        row.state,
        row.opened_at,
        row.next_probe_at,
        row.backoff_ms,
        row.consec_failures,
        row.half_open_ok,
        row.throttled_until,
        row.last_kind,
        row.last_error,
        row.updated_at,
      );
    if (from === row.state) return; // 无迁移 → 不写审计行
    this.db
      .prepare(
        'INSERT INTO breaker_event (endpoint_id, track, from_state, to_state, reason, ts) VALUES (?,?,?,?,?,?)',
      )
      .run(row.endpoint_id, row.track, from, row.state, reason, row.updated_at);
  }

  // ── 查询面 ───────────────────────────────────────────────────────

  state(endpointId: string, track: Track): BreakerState {
    return this.ensureRow(endpointId, track).state;
  }

  view(endpointId: string, track: Track): BreakerView {
    const r = this.ensureRow(endpointId, track);
    return {
      state: r.state,
      consecFailures: r.consec_failures,
      nextProbeAt: r.next_probe_at,
      throttledUntil: r.throttled_until,
      lastKind: r.last_kind,
    };
  }

  /** 429 软冷却剩余（0 = 未冷却）。 */
  throttledRemainingMs(endpointId: string, track: Track): number {
    const r = this.ensureRow(endpointId, track);
    if (r.throttled_until === null) return 0;
    return Math.max(0, r.throttled_until - this.now());
  }

  /** half_open 槽（运行时态，不持久化，§4.1）。 */
  halfOpenSlot(endpointId: string, track: Track): HalfOpenSlot {
    const k = this.key(endpointId, track);
    let s = this.halfOpenSlots.get(k);
    if (s === undefined) {
      s = new HalfOpenSlot(this.cfg.half_open_max_concurrency);
      this.halfOpenSlots.set(k, s);
    }
    return s;
  }

  /** 该端点×角色是否处于 auth 锁定（open 且最近一次失败是 auth）。 */
  isAuthLocked(endpointId: string, track: Track): boolean {
    return this.authLocked.has(this.key(endpointId, track));
  }

  /** 扫描 next_probe_at 到期者（心跳 breaker.probe_timer 用）。 */
  dueProbes(now = this.now()): Array<{ endpointId: string; track: Track }> {
    const out: Array<{ endpointId: string; track: Track }> = [];
    for (const row of this.rows.values()) {
      if (row.state !== 'open') continue;
      if (this.authLocked.has(this.key(row.endpoint_id, row.track))) continue;
      if (row.next_probe_at !== null && row.next_probe_at <= now) {
        out.push({ endpointId: row.endpoint_id, track: row.track });
      }
    }
    return out;
  }

  // ── 状态迁移 ─────────────────────────────────────────────────────

  private transition(
    row: BreakerRow,
    to: BreakerState,
    reason: string,
    patch: Partial<BreakerRow> = {},
  ): void {
    const from = row.state;
    const now = this.now();
    row.state = to;
    row.updated_at = now;
    Object.assign(row, patch);
    if (to === 'open') {
      row.opened_at = now;
      row.next_probe_at = now + row.backoff_ms;
      row.half_open_ok = 0;
      this.halfOpenSlot(row.endpoint_id, row.track).release();
    } else if (to === 'half_open') {
      row.next_probe_at = null;
      row.half_open_ok = 0;
      this.halfOpenSlot(row.endpoint_id, row.track).release();
    } else {
      // closed：清零连续失败与半开计数，解除 auth 锁定（reload 放行/人工 resetBreaker）
      row.consec_failures = 0;
      row.half_open_ok = 0;
      row.next_probe_at = null;
      row.throttled_until = null;
      this.authLocked.delete(this.key(row.endpoint_id, row.track));
      this.halfOpenSlot(row.endpoint_id, row.track).release();
    }
    this.persist(row, from, reason);
    this.onTransition?.({
      endpointId: row.endpoint_id,
      track: row.track,
      from,
      to,
      reason,
    });
  }

  private openWith(row: BreakerRow, reason: string, backoffMs?: number): void {
    if (backoffMs !== undefined) row.backoff_ms = Math.min(backoffMs, this.cfg.backoff_max_ms);
    this.transition(row, 'open', reason);
  }

  /**
   * 到期 open → half_open（§4.1：放行 1 个探活请求）。
   * auth 锁定者跳过（半开只允许配置 reload 事件后触发）。
   */
  maybeHalfOpen(endpointId: string, track: Track): boolean {
    const row = this.ensureRow(endpointId, track);
    if (row.state !== 'open') return false;
    const k = this.key(endpointId, track);
    if (this.authLocked.has(k)) return false;
    if (row.next_probe_at === null || row.next_probe_at > this.now()) return false;
    this.transition(row, 'half_open', 'next_probe_at 到期，半开探活');
    return true;
  }

  /** 配置 reload 后放开 auth 锁定（§4.1：换 key 后重试）。 */
  allowHalfOpenAfterReload(): void {
    for (const row of this.rows.values()) {
      if (row.state === 'open' && row.last_kind === 'auth') {
        this.authLocked.delete(this.key(row.endpoint_id, row.track));
        row.next_probe_at = Math.min(row.next_probe_at ?? this.now(), this.now() + 5000);
        this.persist(row, 'open', '配置 reload：解除 auth 半开锁定');
      }
    }
  }

  /** 主人手动放行（CLI `dotd models reset-breaker`，§5.1）。 */
  reset(endpointId: string, track?: Track): void {
    const tracks: Track[] = track === undefined ? ['primary', 'light'] : [track];
    for (const t of tracks) {
      const row = this.ensureRow(endpointId, t);
      this.authLocked.delete(this.key(endpointId, t));
      row.backoff_ms = this.cfg.backoff_initial_ms;
      this.transition(row, 'closed', '主人手动放行 resetBreaker');
    }
  }

  // ── 结算（§4.1 记账表逐行落地）───────────────────────────────────

  /**
   * 一次调用结算。
   *
   * - ok=true：closed 清零连续失败；half_open 下 half_open_ok++，达
   *   `half_open_success_needed`(2) 转 closed。
   * - ok=false：写窗口样本；auth/quota 立即 open；其余按连续失败/失败率判 open。
   */
  settle(input: SettleInput): void {
    const { endpointId, track, ok, kind } = input;
    const row = this.ensureRow(endpointId, track);
    const now = this.now();
    row.last_kind = kind ?? null;
    row.last_error = input.detail === undefined ? null : input.detail.slice(0, LAST_ERROR_MAX);
    this.writeSample(endpointId, track, ok, kind ?? null, input.latencyMs ?? null, now);

    if (ok) {
      if (row.state === 'half_open') {
        row.half_open_ok += 1;
        if (row.half_open_ok >= this.cfg.half_open_success_needed) {
          row.backoff_ms = this.cfg.backoff_initial_ms;
          this.transition(row, 'closed', `半开 ${row.half_open_ok} 次连续成功`);
        } else {
          row.updated_at = now;
          this.persist(row, 'half_open', `半开探活成功 ${row.half_open_ok}/${this.cfg.half_open_success_needed}`);
        }
      } else if (row.state === 'closed') {
        row.consec_failures = 0;
        row.updated_at = now;
        this.persist(row, 'closed', '调用成功');
      } else {
        // open 态收到成功（理论上不会发生：open 时请求已被跳过）——仅记账不改状态
        row.updated_at = now;
        this.persist(row, row.state, 'open 态成功样本');
      }
      return;
    }

    // ── 失败分支 ──
    row.consec_failures += 1;

    if (kind === 'auth') {
      this.authLocked.add(this.key(endpointId, track));
      this.openWith(row, '鉴权失败（401/403，不自动恢复）', AUTH_BACKOFF_MS);
      return;
    }
    if (kind === 'quota') {
      this.openWith(row, '配额耗尽（402/quota 429）', QUOTA_BACKOFF_MS);
      return;
    }
    if (kind === 'rate_limit') {
      // §4.1：429 不 open，写 throttled_until；超过 throttle_max_ms 按 open 处理
      const ra = input.retryAfterMs ?? 0;
      if (ra > this.cfg.throttle_max_ms) {
        this.openWith(row, `429 Retry-After ${ra}ms 超过软冷却上限`, Math.max(ra, row.backoff_ms));
        return;
      }
      row.throttled_until = now + Math.min(ra, this.cfg.throttle_max_ms);
      row.updated_at = now;
      this.persist(row, row.state, `429 软冷却 ${Math.min(ra, this.cfg.throttle_max_ms)}ms`);
      return;
    }

    if (kind === 'engine_unavailable') {
      this.openWith(row, '本地引擎不可用（health/warm/槽位三连）', ENGINE_BACKOFF_MS);
      return;
    }

    if (row.state === 'half_open') {
      // 半开任一失败 → open，backoff ×2（上限 1h）
      row.backoff_ms = Math.min(row.backoff_ms * 2, this.cfg.backoff_max_ms);
      this.transition(row, 'open', `半开探活失败（${kind ?? 'unknown'}），backoff ×2`);
      return;
    }

    if (row.consec_failures >= this.cfg.consec_failures) {
      row.backoff_ms = Math.min(row.backoff_ms * 2, this.cfg.backoff_max_ms);
      this.transition(row, 'open', `连续失败 ${row.consec_failures} 次（${kind ?? 'unknown'}）`);
      return;
    }

    // 失败率判定（窗口内样本数 ≥ min_samples 且失败率 ≥ failure_ratio）
    const stats = this.windowStats(endpointId, track, now);
    if (stats.samples >= this.cfg.min_samples && stats.failures / stats.samples >= this.cfg.failure_ratio) {
      row.backoff_ms = Math.min(row.backoff_ms * 2, this.cfg.backoff_max_ms);
      this.transition(
        row,
        'open',
        `窗口失败率 ${(stats.failures / stats.samples).toFixed(2)}（${stats.failures}/${stats.samples}）`,
      );
      return;
    }

    row.updated_at = now;
    this.persist(row, row.state, `失败样本（${kind ?? 'unknown'}）`);
  }

  // ── 窗口（breaker_sample 环形明细）───────────────────────────────

  private writeSample(
    endpointId: string,
    track: Track,
    ok: boolean,
    kind: FailureKind | null,
    latencyMs: number | null,
    ts: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO breaker_sample (endpoint_id, track, ok, kind, latency_ms, ts) VALUES (?,?,?,?,?,?)',
      )
      .run(endpointId, track, ok ? 1 : 0, kind, latencyMs, ts);
    // 体积回收（§3.2「体积与回收」）：删窗口外 + TRIM 到 window_size
    this.db
      .prepare('DELETE FROM breaker_sample WHERE endpoint_id = ? AND track = ? AND ts < ?')
      .run(endpointId, track, ts - this.cfg.window_ms);
    const excess = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM breaker_sample WHERE endpoint_id = ? AND track = ?',
      )
      .get(endpointId, track) as { n: number };
    if (excess.n > this.cfg.window_size) {
      this.db
        .prepare(
          `DELETE FROM breaker_sample WHERE id IN (
             SELECT id FROM breaker_sample WHERE endpoint_id = ? AND track = ?
             ORDER BY id ASC LIMIT ?)`,
        )
        .run(endpointId, track, excess.n - this.cfg.window_size);
    }
  }

  windowStats(
    endpointId: string,
    track: Track,
    now = this.now(),
  ): { samples: number; failures: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS samples,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures
         FROM breaker_sample
         WHERE endpoint_id = ? AND track = ? AND ts >= ?`,
      )
      .get(endpointId, track, now - this.cfg.window_ms) as
      | { samples: number; failures: number }
      | undefined;
    return { samples: row?.samples ?? 0, failures: row?.failures ?? 0 };
  }

  /**
   * 窗口内**成功**样本的 latency_ms（升序；调用方自己再排也行）。
   *
   * 为什么单独一个方法而不是塞进 windowStats：`breaker_sample.latency_ms`
   * 从建库起每笔结算都在写，直到 2026-10-17 健康度评分落地才有人读——是个死列。
   * 只取 ok 样本：失败样本的 latency 基本就是 total_ms 超时天花板，混进来
   * p95 会被抬成超时线，所有端点看起来一样慢，分位失去分辨力。
   * latency_ms 为 NULL 的样本（闸门跳过、探活未计时）直接排除。
   */
  okLatencies(endpointId: string, track: Track, now = this.now()): number[] {
    const rows = this.db
      .prepare(
        `SELECT latency_ms FROM breaker_sample
         WHERE endpoint_id = ? AND track = ? AND ts >= ? AND ok = 1 AND latency_ms IS NOT NULL
         ORDER BY latency_ms ASC`,
      )
      .all(endpointId, track, now - this.cfg.window_ms) as Array<{ latency_ms: number }>;
    return rows.map((r) => r.latency_ms);
  }

  /** 全量视图（snapshot / janitor 用）。 */
  allRows(): BreakerRow[] {
    return [...this.rows.values()];
  }

  /** 从 SQLite 重载（daemon 重启后 load() 调用；auth 锁定随之恢复）。 */
  loadFromDb(): void {
    this.rows.clear();
    this.authLocked.clear();
    const rows = this.db.prepare('SELECT * FROM breaker_state').all() as unknown as BreakerRow[];
    for (const row of rows) {
      this.rows.set(this.key(row.endpoint_id, row.track), row);
      if (row.state === 'open' && row.last_kind === 'auth') {
        this.authLocked.add(this.key(row.endpoint_id, row.track));
      }
    }
  }

  /** 回收（janitor：breaker_sample/breaker_event 90 天）。 */
  janitor(now = this.now()): { samples: number; events: number } {
    const a = this.db
      .prepare('DELETE FROM breaker_sample WHERE ts < ?')
      .run(now - this.cfg.window_ms)
      .changes;
    const b = this.db
      .prepare('DELETE FROM breaker_event WHERE ts < ?')
      .run(now - 90 * 86_400_000)
      .changes;
    return { samples: Number(a), events: Number(b) };
  }
}

/** 供外部构造默认软冷却上限（配置缺省时）。 */
export const DEFAULT_THROTTLE_MAX = DEFAULT_THROTTLE_MAX_MS;
