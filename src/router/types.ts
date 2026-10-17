/**
 * src/router/types.ts —— 模型路由（MR）模块私有类型。
 *
 * 铁律（CONVENTIONS.md「模块边界」）：跨模块可见类型一律在 src/shared/contracts.ts，
 * 本文件只放模块内部类型（配置形状、transport 协议、运行时状态）。
 *
 * 来源（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §2.1 models.yml 全量配置形状
 * - §2.2 free-models.yml 池条目形状
 * - §3.1 EndpointDef / RouterRuntime 注释（配置对象与运行时态分离）
 * - §4.1 熔断器记账规则 / §4.4 池两级测试 / §4.6 侦察候选
 * - §5.1 进程内 API 的 ProbeResult 等返回值
 */

import type {
  BreakerState,
  ChatChunk,
  ChatMessage,
  ChatResponse,
  EndpointDef,
  FailureKind,
  Track,
} from '../shared/contracts.ts';
// ═══════════════════════════════════════════════════════════════════
// 配置（models.yml，MR §2.1）
// ═══════════════════════════════════════════════════════════════════

export interface RoutingConfig {
  default_track: Track;
  /** 事件类型 → light 轨（前缀匹配，MR §2.1 routing.light_events）。 */
  light_events: string[];
  /**
   * 难度档 → light 轨（2026-10-17 迁移自 PilotDeck 的 difficulty judge）。
   * 只收 trivial/simple/moderate——`complex` 被 difficulty.ts 硬挡（那意味着
   * 要调工具，而 light 轨端点没有工具能力）。缺省 = ['trivial','simple']。
   */
  light_difficulties: string[];
}

export interface BreakerConfig {
  window_size: number;
  window_ms: number;
  min_samples: number;
  failure_ratio: number;
  consec_failures: number;
  backoff_initial_ms: number;
  backoff_max_ms: number;
  half_open_success_needed: number;
  half_open_max_concurrency: number;
  throttle_max_ms: number;
  busy_consec_limit: number;
}

/**
 * 求救投递通道名（SF §5.7）。
 * 2026-10-16 主人拍板：飞书机器人取代 Telegram 成为主通道；TG 保留为接线位
 * （未装配 gateway 时 available 恒 false）。email 阶段一同样不放开。
 */
export type AlertChannelName = 'feishu' | 'telegram' | 'email' | 'outbox';

export interface AlertsConfig {
  dedup_window_ms: number;
  /** 契约 T3：唯一配置源，值 = ~/.dotd/OUTBOX.md（原稿 /dot/state/OUTBOX.md 作废）。 */
  outbox_path: string;
  channel_order: AlertChannelName[];
  channel_timeout_ms: number;
}

export type ReconSourceType = 'openrouter_models' | 'github_curated';

export interface ReconSourceConfig {
  type: ReconSourceType;
  /** openrouter_models：模型 id 后缀过滤（如 ':free'）。 */
  filter?: string;
  /** github_curated：api.github.com contents/ URL（github.com 直连被墙，禁直连）。 */
  api_url?: string;
  raw_via?: 'base64';
}

export interface ReconConfig {
  interval_ms: number;
  max_candidates_per_scan: number;
  sources: ReconSourceConfig[];
  candidate_ttl_ms: number;
  rejected_cooldown_ms: number;
}

export interface ModelsConfig {
  version: number;
  reload_debounce_ms: number;
  /** tier1/tier2 端点（tier3 来自 free_models_file，tier4 来自 recon_candidate 表）。 */
  endpoints: EndpointDef[];
  free_models_file: string;
  routing: RoutingConfig;
  breaker: BreakerConfig;
  alerts: AlertsConfig;
  recon: ReconConfig;
}

/** models.yml 缺省值（MR §2.1 各键的注释值即默认值）。 */
export const BREAKER_DEFAULTS: BreakerConfig = {
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

export const ALERTS_DEFAULTS: Omit<AlertsConfig, 'outbox_path'> = {
  dedup_window_ms: 86_400_000,
  channel_order: ['feishu', 'telegram', 'email', 'outbox'],
  channel_timeout_ms: 10_000,
};

export const RECON_DEFAULTS: Omit<ReconConfig, 'sources'> = {
  interval_ms: 21_600_000,
  max_candidates_per_scan: 10,
  candidate_ttl_ms: 604_800_000,
  rejected_cooldown_ms: 2_592_000_000,
};

// ═══════════════════════════════════════════════════════════════════
// 配置（free-models.yml，MR §2.2）
// ═══════════════════════════════════════════════════════════════════

export interface FreeModelEntry {
  id: string;
  base_url: string;
  /** env 名；'none'/缺省 = 免鉴权端点。 */
  api_key_env: string | null;
  models: string[];
  style: 'openai';
  capabilities?: { tool_calling: 'yes' | 'no' | 'unknown'; context: number };
  rate?: { rpm: number; rpd: number };
  /** 微型工具调用往返测试通过时刻；null = 从未通过。 */
  last_verified: number | null;
  verify_staleness_ms: number;
  emergency_eligible: boolean;
}

export interface FreeModelsFile {
  version: number;
  updated_at: string | null;
  models: FreeModelEntry[];
}

// ═══════════════════════════════════════════════════════════════════
// transport 协议（MR §4.2 调用面；stub 与真实 HTTP 两份实现）
// ═══════════════════════════════════════════════════════════════════

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /**
   * 命中提示缓存的 prompt token 数（可选，provider 不报就没有）。
   *
   * 两种线格式都认（见 transport.ts 的 usageCacheRead）：OpenAI/OpenRouter 的
   * `prompt_tokens_details.cached_tokens`，以及 Anthropic 形状的顶层
   * `cache_read_input_tokens`（部分代理会重打成这个）。**不报就是 undefined**，
   * 不是 0——本地 Colibrì 这类没有缓存概念的引擎，把"没有"记成 0 会让
   * 缓存命中率算出 0%，与"报了但没命中"混为一谈。
   */
  cachedPromptTokens?: number;
}

export interface ChatCall {
  endpoint: EndpointDef;
  track: Track;
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ name: string; description?: string; parameters?: object }>;
  tool_choice?: 'auto' | 'required' | string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 单候选可用预算（§4.2 cap 规则）拆到三个超时上。 */
  cap: { connect_ms: number; idle_ms: number; total_ms: number };
  /** true = 池探测/探活等非业务调用（不计 model_call_log，仍计 breaker_sample，§4.4）。 */
  probe?: boolean;
}

export interface ChatOutcome {
  response: ChatResponse;
  usage?: Usage;
}

/** GET 结果（health/warm/池 /models/侦察元数据共用）。 */
export interface GetOutcome {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  latencyMs: number;
  error?: string;
}
/** 流式 chunk（re-export contracts 的 ChatChunk，便于模块内引用）。 */
export type { ChatChunk };

/** 侦察元数据条目（只读元数据，绝不发推理请求，§4.6）。 */
export interface ReconItem {
  base_url: string;
  model: string;
  api_key_note?: string;
  rate_note?: string;
  evidence?: Record<string, unknown>;
}

export interface MetadataQuery {
  url: string;
  kind: ReconSourceType;
  filter?: string;
  /** api.github.com contents/ 的 base64 解码开关。 */
  raw_via?: 'base64';
}

/**
 * 模型 transport（MR 唯一出网点）。
 * - stub 实现：按脚本回放，不发任何网络请求（DOTD_MODEL_TRANSPORT=stub）。
 * - 真实实现：OpenRouter/OpenAI 兼容 HTTP；仅当 env 未置 stub 时才会真的发请求。
 */
export interface ModelTransport {
  chat(call: ChatCall): Promise<ChatOutcome>;
  stream(call: ChatCall): AsyncIterable<ChatChunk> & {
    usage(): Promise<Usage | undefined>;
  };
  get(ep: EndpointDef, url: string, opts: { timeoutMs: number }): Promise<GetOutcome>;
  metadata(q: MetadataQuery): Promise<{ ok: boolean; items: ReconItem[]; error?: string }>;
}

// ═══════════════════════════════════════════════════════════════════
// 运行时状态（MR §3.1 RouterRuntime 注释：与配置对象分离）
// ═══════════════════════════════════════════════════════════════════

/** Tier2 本地引擎的 warm 判定状态（MR §2.1 local.warm_grace_ms）。 */
export interface WarmState {
  /** 首次探测到 health OK 的时刻（fail→ok 跳变时刷新）。 */
  healthOkSince: number | null;
  /** 宽限期截止时刻；期内 warm 不过只判"加载中"，期外不过 = engine_unavailable。 */
  graceUntil: number | null;
  lastWarmOkAt: number | null;
}

/** 探测结果（manualProbe 返回值，MR §5.1）。 */
export interface ProbeResult {
  endpointId: string;
  kind: 'health' | 'tool_roundtrip' | 'breaker';
  ok: boolean;
  detail: string;
  at: number;
  latencyMs: number;
}

/** 熔断器对外可读视图（snapshot 的 roles 项）。 */
export interface BreakerView {
  state: BreakerState;
  consecFailures: number;
  nextProbeAt: number | null;
  throttledUntil: number | null;
  lastKind: FailureKind | null;
}
