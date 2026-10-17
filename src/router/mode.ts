/**
 * src/router/mode.ts —— Router mode 状态机（全局单实例，持久化于 router_state）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md §4.3）：
 * ```
 * mode = 能服务 primary 轨的最高档（最小 tier）；无 primary 能力但 light 可用 → RESTRICTED；
 *        全不可用 → TOTAL_OUTAGE。tier1 有任一（emergencyEligible 过滤后仍）可服务端点
 *        → NORMAL，以此类推。
 * ```
 * - `mode_changed` 事件即时：(a) 写 router_state；(b) 广播给治理/队列；(c) 触发求救/恢复
 *   通报判定（§4.5）。**mode 重算与 emergencyActive 位更新必须在同一次 SQLite 事务内完成
 *   后再广播。**
 * - **降级即求救评估，升级必发恢复通报。** mode 变差（档位升高）时调用 maybeSendHelp()；
 *   mode 变好时调用 sendRecovery()。
 * - LOCAL_FALLBACK 时 primary 轨默认不入本地（7B 撑不起主循环，CONTEXT 明言），
 *   除非 models.yml 给 tier2 端点显式写了 models.primary（主人主动授权），此时
 *   `RouteMeta.degraded=true` 且同值落 model_call_log.degraded 列（§4.3/§6.3）。
 *
 * 术语（契约 §9/T1）：任务挂起等模型 = `paused(stop_reason='circuit_open')`；
 * 作废词 `waiting_model` 不出现在本模块。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type { EndpointDef, RouterMode, Track } from '../shared/contracts.ts';
import type { Breaker } from './breaker.ts';
import { pickCandidates } from './candidates.ts';

/** 档位序号（越大越差）。 */
export const MODE_SEVERITY: Record<RouterMode, number> = {
  NORMAL: 0,
  LOCAL_FALLBACK: 1,
  EMERGENCY: 2,
  RESTRICTED: 3,
  TOTAL_OUTAGE: 4,
};

export interface ModeDeps {
  db: DatabaseSync;
  bus: EventBus;
  breaker: Breaker;
  now?: () => number;
}

/** mode 重算的一次输入。 */
export interface ModeInput {
  /** 全部候选（tier1/2 配置 + tier3 池；tier4 只在提案里，不参与服务判定）。 */
  candidates: readonly EndpointDef[];
  /** 池端点是否持有新鲜合格证（§4.3：无 tool-qualified 池模型 → RESTRICTED）。 */
  isToolQualified: (ep: EndpointDef) => boolean;
  /** 当前是否正在服务某端点（mode 恢复判定的"实际承载"）。 */
  servedBy: string | null;
}

/**
 * mode 管理器。
 *
 * 关键不变量（§4.3）：
 * - 写 `router_state` 的三行（mode/emergency_active/primary_endpoint_id）+ mode_since 在
 *   **同一个事务**里，再广播 `router.mode_changed`（§4.3 末句）。
 * - emergencyActive = mode ∈ {EMERGENCY, RESTRICTED, TOTAL_OUTAGE}（§4.3 图：EMERGENCY 与
 *   RESTRICTED 都标 emergencyActive=true；TOTAL_OUTAGE 更差，同语义）。
 * - 治理模块读 `snapshot().emergencyActive` 自刷新（契约 T1：`governance:emergency` 作废）。
 */
export class ModeManager {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus;
  private readonly breaker: Breaker;
  private readonly now: () => number;
  private mode: RouterMode = 'NORMAL';
  private modeSince = 0;
  private primaryEndpointId: string | null = null;
  /** 变化监听（ModelRouter 挂求救/恢复评估）。 */
  onChange:
    | ((e: { from: RouterMode; to: RouterMode; at: number; servedBy: string | null }) => Promise<void>)
    | null = null;

  constructor(deps: ModeDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.breaker = deps.breaker;
    this.now = deps.now ?? Date.now;
    this.loadFromDb();
  }

  get current(): RouterMode {
    return this.mode;
  }

  get emergencyActive(): boolean {
    return isEmergencyMode(this.mode);
  }

  get since(): number {
    return this.modeSince;
  }

  get primaryEndpoint(): string | null {
    return this.primaryEndpointId;
  }

  private loadFromDb(): void {
    const rows = this.db.prepare('SELECT key, value FROM router_state').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const m = map.get('mode');
    if (m !== undefined && isRouterMode(m)) this.mode = m;
    const since = map.get('mode_since');
    if (since !== undefined) this.modeSince = Number(since) || this.now();
    else this.modeSince = this.now();
    this.primaryEndpointId = map.get('primary_endpoint_id') ?? null;
  }

  /** 从 SQLite 恢复后立即重算一遍校验（§4.7 对账第 4 步：配置可能已被主人改过）。 */
  recompute(input: ModeInput): RouterMode {
    const next = this.compute(input);
    if (next !== this.mode) this.apply(next, input.servedBy);
    else this.primaryEndpointId = input.servedBy;
    return this.mode;
  }

  /**
   * §4.3 计算规则：
   * - tier1 有任一可服务端点（emergencyEligible 过滤后仍 breaker 不 open）→ NORMAL；
   * - 否则 tier2 有任一可服务 → LOCAL_FALLBACK；
   * - 否则 tier3 有任一**持合格证**的池端点 → EMERGENCY；
   * - 否则（只剩不合格模型）light 可用 → RESTRICTED；全挂 → TOTAL_OUTAGE。
   *
   * 注：Tier4 侦察候选"只侦察只提案"，不算可服务端点（§4.6）。
   */
  private compute(input: ModeInput): RouterMode {
    const cap = (tier: 1 | 2 | 3): boolean => {
      const eps = pickCandidates(input.candidates, this.mode, 'primary').filter((e) => e.tier === tier);
      for (const ep of eps) {
        if (ep.tier === 3 && !input.isToolQualified(ep)) continue;
        if (this.servesTrack(ep)) return true;
      }
      return false;
    };
    const lightCapable = (): boolean => {
      // RESTRICTED 的"light 尽力"指的是**本地引擎的低智能轨**（§4.3 图：LOCAL_FALLBACK 的
      // 下一跳注释即「tier2 light 可用」）：tier1 云端端点挂的是业务主轨，其 light 轨
      // breaker 从未被 light 请求打过（closed）——若把这种"无样本的 closed"算作可服务，
      // 云端全挂时 mode 会永远停在 RESTRICTED，永远到不了 TOTAL_OUTAGE。
      // 故 light 可用性只认 tier2 本地端点；tier3 池端点不持合格证即不可服务（cap(3) 已判过）。
      for (const ep of pickCandidates(input.candidates, this.mode, 'light')) {
        if (ep.tier !== 2) continue;
        if (!this.localEngineUp(ep)) continue;
        if (this.servesTrack(ep, 'light')) return true;
      }
      return false;
    };
    if (cap(1)) return 'NORMAL';
    if (cap(2)) return 'LOCAL_FALLBACK';
    if (cap(3)) return 'EMERGENCY';
    if (lightCapable()) return 'RESTRICTED';
    return 'TOTAL_OUTAGE';
  }

  /** 端点×轨道是否"可服务"：breaker 非 open 且未被 429 软冷却挡住。 */
  private servesTrack(ep: EndpointDef, track: Track = 'primary'): boolean {
    if (!ep.enabled || ep.models[track] === undefined) return false;
    const b = this.breaker.view(ep.id, track);
    if (b.state === 'open') return false;
    if (b.throttledUntil !== null && b.throttledUntil > this.now()) return false;
    return true;
  }

  /**
   * Tier2 本地引擎当前是否健康（mode 判定的 light 轨前置条件）。
   *
   * route() 里 Tier2 的 engine_unavailable 只落在**当前请求轨**的 breaker 上
   * （§4.1：engine_unavailable 计入 light 轨窗口——引擎挂了 primary 轨也必然挂）。
   * 因此在 mode 重算时，light 轨判"可服务"必须同时看该端点的 primary 轨是否
   * 因 engine_unavailable 而 open：否则本地引擎挂了（light 轨无样本、closed），
   * mode 会误判 RESTRICTED 而永远到不了 TOTAL_OUTAGE（§4.3 图的最后一级）。
   */
  private localEngineUp(ep: EndpointDef): boolean {
    if (ep.local === undefined) return true;
    const p = this.breaker.view(ep.id, 'primary');
    if (p.state === 'open' && p.lastKind === 'engine_unavailable') return false;
    const l = this.breaker.view(ep.id, 'light');
    if (l.state === 'open' && l.lastKind === 'engine_unavailable') return false;
    return true;
  }

  /**
   * 落库 + 广播（§4.3 (a)(b)(c)：同一次事务写 router_state 后广播，再触发求救/恢复判定）。
   */
  apply(next: RouterMode, servedBy: string | null): void {
    const from = this.mode;
    const at = this.now();
    if (from === next) {
      this.primaryEndpointId = servedBy;
      this.persist(next, at, servedBy);
      return;
    }
    // 同一次 SQLite 事务内完成 mode 与 emergencyActive 位更新（§4.3 末句）
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      this.persist(next, at, servedBy);
      this.db.prepare('COMMIT').run();
    } catch (cause) {
      this.db.prepare('ROLLBACK').run();
      throw cause;
    }
    this.mode = next;
    this.modeSince = at;
    this.primaryEndpointId = servedBy;
    this.bus.publish('router.mode_changed', {
      type: 'mode_changed',
      from,
      to: next,
      at,
    });
    // 降级即求救评估，升级必发恢复通报（§4.3 末条）
    if (MODE_SEVERITY[next] > MODE_SEVERITY[from]) {
      this.bus.publish('router.help_needed', {
        type: 'help_needed',
        signature: `${from}->${next}`,
        urgent: next === 'TOTAL_OUTAGE',
      });
    } else {
      this.bus.publish('router.recovered', { type: 'mode_changed', from, to: next, at });
    }
    void this.onChange?.({ from, to: next, at, servedBy });
  }

  private persist(mode: RouterMode, at: number, servedBy: string | null): void {
    const rows: Array<[string, string]> = [
      ['mode', mode],
      // emergency_active 必须与**本次落库的 mode** 同源（§4.3 末句：同一次事务内完成）。
      // 早先写成 this.mode（旧值）→ apply() 里 this.mode=next 在 persist() 之后执行，
      // 导致 mode 已切到 TOTAL_OUTAGE 而 emergency_active 仍留 '0'（治理读到的收缩位滞后一圈）。
      ['emergency_active', isEmergencyMode(mode) ? '1' : '0'],
      ['primary_endpoint_id', servedBy ?? ''],
      ['mode_since', String(at)],
    ];
    for (const [k, v] of rows) {
      this.db
        .prepare(
          `INSERT INTO router_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        )
        .run(k, v, at);
    }
  }

  /** 快照数据（snapshot() 消费）。 */
  view(): { mode: RouterMode; emergencyActive: boolean; since: number; primaryEndpointId: string | null } {
    return {
      mode: this.mode,
      emergencyActive: this.emergencyActive,
      since: this.modeSince,
      primaryEndpointId: this.primaryEndpointId,
    };
  }
}

/**
 * 应急收缩档位集合（§4.3：EMERGENCY/RESTRICTED/TOTAL_OUTAGE → emergencyActive=true）。
 * 落库（persist）与内存 getter 必须走同一判定，否则两边会不一致。
 */
export function isEmergencyMode(mode: RouterMode): boolean {
  return mode === 'EMERGENCY' || mode === 'RESTRICTED' || mode === 'TOTAL_OUTAGE';
}

function isRouterMode(v: string): v is RouterMode {
  return (
    v === 'NORMAL' ||
    v === 'LOCAL_FALLBACK' ||
    v === 'EMERGENCY' ||
    v === 'RESTRICTED' ||
    v === 'TOTAL_OUTAGE'
  );
}
