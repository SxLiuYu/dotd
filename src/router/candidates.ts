/**
 * src/router/candidates.ts —— 候选排序、本地闸门（health/warm）与错误分类。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §4.2 pickCandidates：`enabled && models[track]` 过滤；轨内排序 tier 升序、同 tier 按
 *   models.yml 声明顺序；Tier3 内部 lastVerifiedAt 新者先。
 * - §4.2 emergencyEligible 唯一执行位点：mode ∈ {EMERGENCY, RESTRICTED, TOTAL_OUTAGE}
 *   且 track === 'primary' → 过滤掉 emergencyEligible=false 的端点；LOCAL_FALLBACK 不过滤；
 *   light 轨永不受影响；**被过滤端点不写 tried**（不是"试过失败"，是"档位不允许"）。
 * - §4.2 本地闸门 localGate(ep, 2000)：health + warm 两道闸，2s 预算。
 * - §4.1 classifyError 表：429/5xx/超时/网络/鉴权/协议错误 的分类规则。
 * - §2.1 local.warm_grace_ms：/health 通过 ≠ 全量驻留，宽限期外不判 warm
 *   （机器实测：Colibrì :8001 OLMoE /health 约 1.8GB 即响应，全量驻留需约 2 分钟，
 *   warm 判据 = GET /profile 末条 turn 的 expert_disk_s 不超过阈值）。
 */

import type {
  ChatResponse,
  EndpointDef,
  FailureKind,
  RouterMode,
  Track,
} from '../shared/contracts.ts';
import type { ModelTransport, WarmState } from './types.ts';
import { classifyHttpFailure } from './transport.ts';

/** 本地闸门总预算（§4.2 localGate(ep, 2000)）。 */
export const LOCAL_GATE_BUDGET_MS = 2000;

/**
 * 单条 fallback 链的长度上限（PilotDeck `LITELLM_ROUTER_MAX_FALLBACKS` 同值）。
 *
 * 链再长也没有意义：前几个模型覆盖了"这一个模型限流/降级"，再往后通常已经是
 * 供应商整体故障——那该由换端点（下一个 base_url/凭据）解决，不是换模型。
 */
export const MAX_FALLBACK_MODELS = 5;

/**
 * 模型级故障：换同一端点的下一个模型就有可能好，**不该记到端点熔断窗口上**。
 *
 * 判据是"故障是否与单个模型绑定"：
 * - 是：限流/配额/服务端错误/超时/网络/协议错误/零用量空壳——凭据和端点通常都是好的；
 * - 否：鉴权（凭据问题，同端点所有模型一起挂）、engine_unavailable /
 *   pool_unverified（本地引擎或池资格问题，同样是端点级）。
 *
 * `empty_response` 归入模型级：OpenRouter 免费路由的空壳是按**模型**抖动的
 * （同一个 base_url 下换一个模型常常就正常），记到端点窗口会把好端点一起拖下水。
 *
 * 这条区分是迁移 PilotDeck `runFallbackChain` 时最要紧的一点：没有它，一个坏模型
 * 会把唯一 primary 端点拖进熔断，fallback 链等于白配。
 */
export function isModelScopedKind(kind: FailureKind): boolean {
  return (
    kind === 'rate_limit' ||
    kind === 'quota' ||
    kind === 'server_error' ||
    kind === 'timeout' ||
    kind === 'network' ||
    kind === 'bad_protocol' ||
    kind === 'empty_response'
  );
}

/**
 * 端点某轨的模型链：`[models[track], ...fallbackModels[track]]`。
 *
 * 去重（含与主模型重复的备份项，重复会让同一个模型白试一遍）、去空串、
 * 截断到 MAX_FALLBACK_MODELS 个备份。未配 fallbackModels 时退化为单元素链，
 * 行为与迁移前逐字一致。
 */
export function modelChain(ep: EndpointDef, track: Track): string[] {
  const primary = ep.models[track];
  const out: string[] = [];
  if (primary !== undefined && primary.length > 0) out.push(primary);
  const backups = ep.fallbackModels?.[track] ?? [];
  for (const m of backups) {
    if (m.length === 0) continue;
    if (out.includes(m)) continue;
    if (out.length >= 1 + MAX_FALLBACK_MODELS) break;
    out.push(m);
  }
  return out;
}

/**
 * 候选排序与筛选（§4.2 pickCandidates 逐字落地）。
 *
 * @param list     tier1/tier2 端点 + tier3 池端点（已合并，调用方负责合并来源）
 * @param mode     当前 RouterMode（决定 emergencyGate 是否生效）
 * @param track    请求轨道
 * @param rankKey  同 tier 内的健康度排序键（2026-10-17 起，ProviderHealthTracker 迁移）。
 *   `rankKey(ep.id, track)` 返回 null = 样本不足/没有历史 → **该端点不参与健康度排序，
 *   保持声明顺序**。这是硬约束：把新端点当成 0 分排到最后，等于永不试用它，
 *   而没有试用就没有样本，没有样本就永远排后面——闭环饿死。
 *   传 undefined（旧调用方）时行为与迁移前逐字一致。
 */
export function pickCandidates(
  list: readonly EndpointDef[],
  mode: RouterMode,
  track: Track,
  rankKey?: (endpointId: string, track: Track) => number | null,
): EndpointDef[] {
  const eligible = list.filter((e) => e.enabled && e.models[track] !== undefined);
  // §4.1 bad_protocol 附加动作：tool_calling 已被记为 no 的端点，本会话内不再选它做 primary
  // （light 轨不受影响——低智能分流不需要工具调用）。reload 重建 endpoints 后复位。
  const primaryOk =
    track === 'primary' ? eligible.filter((e) => e.capabilities?.tool_calling !== 'no') : eligible;
  const gate = emergencyGateActive(mode) && track === 'primary';
  const kept = gate ? primaryOk.filter((e) => e.emergencyEligible) : primaryOk;
  // tier 升序；同 tier 保持声明顺序（稳定排序）；Tier3 内部 lastVerifiedAt 新者先
  return kept
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.tier !== b.e.tier) return a.e.tier - b.e.tier;
      if (a.e.tier === 3 && b.e.tier === 3) {
        const av = a.e.lastVerifiedAt ?? 0;
        const bv = b.e.lastVerifiedAt ?? 0;
        if (av !== bv) return bv - av; // 新者先
      }
      // 健康度只在 tier1/2 内生效：tier3 的 lastVerifiedAt 已经是"新者先"的运行时信号，
      // 再叠一层延迟分位会让池排序在两个不同语义间反复摇摆。
      // 两边都有分 → 按分降序（分高的先试）；任一边没分 → 声明顺序（不罚新端点）。
      if (rankKey !== undefined) {
        const ka = rankKey(a.e.id, track);
        const kb = rankKey(b.e.id, track);
        if (ka !== null && kb !== null && ka !== kb) return kb - ka;
      }
      return a.i - b.i; // 声明顺序（主人钦定优先级）
    })
    .map((x) => x.e);
}

/** 应急收缩档位集合（§4.2：服务已落到 tier3 及更差）。 */
export function emergencyGateActive(mode: RouterMode): boolean {
  return mode === 'EMERGENCY' || mode === 'RESTRICTED' || mode === 'TOTAL_OUTAGE';
}

/**
 * Tier2 本地闸门：health + warm 两道（§4.2/§2.1）。
 *
 * 判据（逐字）：
 * - health：`GET {local.health_url}`，200 即过；失败 → 不 warm（engine_unavailable）。
 * - warm（可选 warm_check）：宽限期内 `/profile` 的 `json_eq` 不满足 → **不算失败**，
 *   只判"加载中"（graceUntil 未到 → 跳过该端点但不入窗，§2.1 warm_grace_ms 语义）；
 *   宽限期外仍不 warm → engine_unavailable。
 */
export interface LocalGateResult {
  ok: boolean;
  /** 加载中（宽限期内 warm 未过）——调用方按 busy 类跳过，**不入窗**。 */
  warming: boolean;
  reason: string;
  latencyMs: number;
}

export async function localGate(
  transport: ModelTransport,
  ep: EndpointDef,
  warm: WarmState,
  now: () => number,
  budgetMs: number = LOCAL_GATE_BUDGET_MS,
): Promise<LocalGateResult> {
  const started = now();
  if (ep.local === undefined) {
    return { ok: true, warming: false, reason: '非本地端点，无闸门', latencyMs: 0 };
  }
  const h = await transport.get(ep, ep.local.health_url, { timeoutMs: budgetMs });
  const latencyMs = now() - started;
  if (!h.ok || h.status < 200 || h.status >= 300) {
    warm.healthOkSince = null;
    warm.graceUntil = null;
    return {
      ok: false,
      warming: false,
      reason: `health 探测失败（HTTP ${h.status}${h.error !== undefined ? ` ${h.error}` : ''}）`,
      latencyMs,
    };
  }
  if (warm.healthOkSince === null) warm.healthOkSince = now();
  if (ep.local.warm_check === undefined) {
    warm.lastWarmOkAt = now();
    return { ok: true, warming: false, reason: 'health 通过（无 warm 检查）', latencyMs };
  }
  // warm 检查
  const graceMs = ep.local.warm_grace_ms ?? 0;
  if (warm.graceUntil === null) warm.graceUntil = warm.healthOkSince + graceMs;
  const w = await transport.get(ep, ep.local.warm_check.url, { timeoutMs: budgetMs });
  const warmLatency = now() - started;
  if (!w.ok || w.status < 200 || w.status >= 300) {
    const inGrace = warm.graceUntil > now();
    return {
      ok: false,
      warming: inGrace,
      reason: inGrace
        ? 'warm 探测未过（宽限期内，判加载中）'
        : 'warm 探测失败（宽限期外）',
      latencyMs: warmLatency,
    };
  }
  if (!matchesWarmCheck(w.json, ep.local.warm_check)) {
    const inGrace = warm.graceUntil > now();
    return {
      ok: false,
      warming: inGrace,
      reason: inGrace
        ? `warm 判据未满足 ${JSON.stringify(ep.local.warm_check)}（宽限期内，判加载中）`
        : `warm 判据未满足 ${JSON.stringify(ep.local.warm_check)}（宽限期外）`,
      latencyMs: warmLatency,
    };
  }
  warm.lastWarmOkAt = now();
  warm.graceUntil = null;
  warm.healthOkSince = null;
  return { ok: true, warming: false, reason: 'health+warm 通过', latencyMs: warmLatency };
}

/**
 * `json_eq` / `json_max` 逐键判定（§2.1 warm_check）。
 *
 * 键是点分路径：普通段取对象属性，数字段索引数组，`last` 取末元素。
 * Colibrì `/profile` 把 expert_disk_s 嵌在 `turns[]` 里（`{"seq":8,"turns":[{…}]}`），
 * 判据必须写 `turns.last.expert_disk_s` 才拿得到值——旧实现只比顶层键，
 * 于是宽限期外永远判不 warm，tier2 降级链实际是断的（2026-10-17 全方位测试高危项）。
 */
export function matchesWarmCheck(
  json: unknown,
  check: { json_eq?: Record<string, number>; json_max?: Record<string, number> },
): boolean {
  if (json === null || typeof json !== 'object') return false;
  if (check.json_eq !== undefined && !matchesJsonEq(json, check.json_eq)) return false;
  if (check.json_max !== undefined && !matchesJsonMax(json, check.json_max)) return false;
  return true;
}

/** 路径解析结果之一：目标数组为空——还没有任何样本可言。 */
const NO_HISTORY = Symbol('warm-check-no-history');

/**
 * 点分路径取值。数组段支持 `last`（末元素）与数字下标；空数组的 `last` 返回
 * NO_HISTORY（区别于"键不存在"：那是判据写错，必须判失败，不能让闸恒过）。
 */
function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      if (seg === 'last') {
        if (cur.length === 0) return NO_HISTORY;
        cur = cur[cur.length - 1];
        continue;
      }
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (cur !== null && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cur;
}

/** `json_eq` 逐键相等判定（§2.1 warm_check）。 */
export function matchesJsonEq(json: unknown, eq: Record<string, number>): boolean {
  if (json === null || typeof json !== 'object') return false;
  const obj = json as Record<string, unknown>;
  for (const [k, v] of Object.entries(eq)) {
    const actual = resolvePath(obj, k);
    if (typeof actual !== 'number' || actual !== v) return false;
  }
  return true;
}

/**
 * `json_max` 逐键"不超过阈值"判定（§2.1 warm_check）。
 *
 * 冷启动窗口里 Colibrì 每条 turn 的 expert_disk_s 是秒级（实测 10.0/1.0/0.9/0.47…），
 * 驻留后跌到 0.02 以下——写死 `== 0` 会被采样噪声反复打穿，故用阈值分界。
 * NO_HISTORY（`turns` 还是空数组）放行：没有任何磁盘 I/O 样本即没有违背；
 * 否则引擎重启后永远不会有第一条 turn，闸门会把 tier2 永久锁死。
 */
export function matchesJsonMax(json: unknown, max: Record<string, number>): boolean {
  if (json === null || typeof json !== 'object') return false;
  const obj = json as Record<string, unknown>;
  for (const [k, v] of Object.entries(max)) {
    const actual = resolvePath(obj, k);
    if (actual === NO_HISTORY) continue;
    if (typeof actual !== 'number' || actual > v) return false;
  }
  return true;
}

// ── 错误分类（§4.1 classifyError）──────────────────────────────────

/** 可识别的 transport 错误形状（http/stream/bad_protocol）。 */
interface TransportErrorLike {
  status?: number;
  retryAfterMs?: number | null;
  name?: string;
  kind?: 'timeout' | 'network';
  code?: string;
  message?: string;
}

/** transport/HTTP 错误 → FailureKind（§4.1 表）。 */
export function classifyError(err: unknown): { kind: FailureKind; retryAfterMs: number | null } {
  const e = err as TransportErrorLike | null;
  if (e === null || e === undefined) return { kind: 'network', retryAfterMs: null };
  if (typeof e.status === 'number') {
    // **复用 classifyHttpFailure**（2026-10-19 全仓库扫零调用方时发现）：
    // 这里原来把 401/403/402/429/5xx 的判断**逐条抄了一遍**，而 transport.ts 里
    // classifyHttpFailure() 实现的正是同一张 §4.1 分类表 —— 但那个函数零调用方。
    // 两份实现的分叉风险是实实在在的：改了规范只改一处，另一处就静默过期。
    // retryAfterMs 仍从 err 上取（它不参与分类，只影响退避时长）。
    return { kind: classifyHttpFailure(e.status, e.message ?? ''), retryAfterMs: e.retryAfterMs ?? null };
  }
  if (e.name === 'BadProtocolError') return { kind: 'bad_protocol', retryAfterMs: null };
  // 零用量空壳：与 bad_protocol 分开，见 contracts.ts 里 empty_response 的注释——
  // 它不能触发 capabilities.tool_calling='no'。
  if (e.name === 'EmptyResponseError') return { kind: 'empty_response', retryAfterMs: null };
  if (e.kind === 'timeout') return { kind: 'timeout', retryAfterMs: null };
  if (e.kind === 'network') return { kind: 'network', retryAfterMs: null };
  const code = e.code ?? '';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return { kind: 'timeout', retryAfterMs: null };
  }
  if (e.message !== undefined && /timeout|timed out/i.test(e.message)) {
    return { kind: 'timeout', retryAfterMs: null };
  }
  return { kind: 'network', retryAfterMs: null };
}

/** 供 stub 测试构造带 status 的错误（保持与 HttpFailure 同形状）。 */
export function makeHttpFailure(status: number, body: string, retryAfterMs: number | null = null): Error {
  return Object.assign(new Error(`HTTP ${status}: ${body}`), {
    name: 'HttpFailure',
    status,
    retryAfterMs,
  });
}

/** 是否 primary 轨的工具调用格式非法（§4.1：bad_protocol 时把 tool_calling 记为 no）。 */
export function isToolCallBadProtocol(resp: ChatResponse): boolean {
  if (resp.toolCalls === undefined || resp.toolCalls.length === 0) return false;
  return resp.toolCalls.some((tc) => {
    if (tc.name.length === 0) return true;
    try {
      JSON.parse(tc.arguments);
      return false;
    } catch {
      return true;
    }
  });
}
