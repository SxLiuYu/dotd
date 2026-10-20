/**
 * src/surfaces/types.ts —— 交互面模块私有类型（契约 §6：模块私有类型放各自的 types.ts，
 * 跨模块类型一律 import src/shared/contracts.ts）。
 *
 * 来源：docs/design/modules/surfaces.md（rev2）§3/§4.5/§4.6/§5.1/§5.2/§5.7。
 */

import type {
  ApprovalView,
  ControlPlane,
  GovernancePort,
  MemoryPort,
  NotificationChannels,
  RawInbound,
  RouterPort,
  RouterSnapshot,
} from '../shared/contracts.ts';
import type { BusEvent } from '../shared/bus.ts';

// ── §3 配置（surfaces: 节）────────────────────────────────────────────

/** §3 `surfaces.http`。 */
export interface HttpSurfaceConfig {
  host: string;
  port: number;
  masterToken: string;
  readonlyTokens: string[];
  allowedOrigins: string[];
}

/** §3 `surfaces.hooks[]`。 */
export interface HookConfig {
  source: string;
  secret: string;
  dotId: string;
  rateLimitPerMin: number;
}

/** §3 `surfaces.jsonl_watch[]`（阶段一定型、默认 enabled:false）。 */
export interface JsonlWatchConfig {
  path: string;
  dotId: string;
  enabled: boolean;
  idleDebounceMs: number;
}

/** §3 `surfaces.heartbeat`。 */
export interface HeartbeatConfig {
  tickIntervalS: number;
}

/** §3 `surfaces.telegram`（阶段二才全量实现，配置先定型）。 */
export interface TelegramConfig {
  botToken: string;
  allowlist: number[];
  editThrottleMs: number;
  /**
   * §5.5 出站目标 chat（主人自己的 chat）。可缺省：缺省时装配层应退到
   * `allowlist[0]`；两者都无 → `deliver('telegram')` 如实报「chat id 未配置」
   * （绝不静默投 chat_id=0）。阶段二接线位，见 deviations。
   */
  ownerChatId?: number;
}

/** §3 `surfaces.feishu`（2026-10-16 主人指定：飞书机器人取代 Telegram）。 */
export interface FeishuConfig {
  /** 自建应用 App ID（cli_ 开头）。 */
  appId: string;
  /** 自建应用 App Secret。 */
  appSecret: string;
  /** 出站目标 chat_id（oc_ 开头的群，或 open_id）。缺省时只做入站。 */
  ownerChatId?: string;
  /** 事件订阅的 verification token（飞书开放平台"事件与订阅"页可查；用于校验推送来源）。 */
  verificationToken?: string;
  /** 加密密钥（Encrypt Key）；设了就把请求体视为 AES 加密。 */
  encryptKey?: string;
  editThrottleMs: number;
  /**
   * API 根地址（T3，2026-10-20）。
   * 默认 `https://open.feishu.cn`。存在的唯一理由是**让测试能拦**：
   * 写这条时想让假服务器接住卡片请求，发现 URL 硬编码在 fetch 里，
   * 根本没法注入 —— 于是测试只能连真飞书，那就不可能跑了。
   * 生产永远不传。
   */
  apiBase?: string;
}

/** §3 `surfaces.ui`。 */
export interface UiConfig {
  streamDeltas: boolean;
}

/**
 * 过程可视化（T5，2026-10-20）。
 *
 * 为什么单独一段而不是塞进 UiConfig：UiConfig 管的是 Web/SSE 那边的流式行为，
 * 这个是"往飞书推不推、多频繁"。两者受众不同（浏览器 vs 手机），
 * 开关也该分开 —— 你可能想看流的输出但不希望手机响。
 */
export interface ProgressSurfaceConfig {
  enabled: boolean;
  everyNSteps: number;
  minIntervalMs: number;
}

/** `~/.dotd/config.yml` 的 `surfaces:` 节全量（SF 拥有 schema，契约 S-4）。 */
export interface SurfacesConfig {
  http: HttpSurfaceConfig;
  hooks: HookConfig[];
  jsonlWatch: JsonlWatchConfig[];
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  feishu: FeishuConfig;
  ui: UiConfig;
  progress: ProgressSurfaceConfig;
}

// ── §5.1 入站 ────────────────────────────────────────────────────────

/**
 * §5.1 `ingest()` 的依赖（把 IngressDeps 的签名收敛到本模块的端口类型上：
 * RawInbound / ControlPlane / EventBus 已在 contracts.ts，其余端口见 §7 新增）。
 */
export interface SurfacesDeps {
  cp: ControlPlane;
  gov: GovernancePort;
  mem: MemoryPort;
  router: RouterPort;
  bus: import('../shared/bus.ts').EventBus;
  /** MR 注入用（MR:678 load({channels})）；阶段一装配层传 null，适配器不装配。 */
  channels: NotificationChannels | null;
  now(): Date;
  /** §5.4：skip_if_busy 数据源 = cp.list({status:['queued','running'],dotId}).length（契约 H1）。 */
  activeTaskCount(dotId: string): number;
}

/** §5.1 ingest() 的返回（HTTP 层据此映射 200/202/503）。 */
export interface IngestOutcome {
  eventId: number;
  dup: boolean;
}

/** §5.1 优先级映射表（interactive=1 / heartbeat·hook=5 / bulk=7）。 */
export const PRIORITY_MAP = {
  interactive: 1,
  telegram: 1,
  heartbeat: 5,
  http: 5,
  file: 7,
} as const;

/** §4 表：dedup_key 生成规则（传给 cp.ingestEvent，命中 events.dedup_key UNIQUE）。 */
export function heartbeatDedupKey(ctId: string, nextFireEpochMs: number): string {
  return `hb:${ctId}:${nextFireEpochMs}`;
}

/** §4 表：`file:<path>:<inode>:<gen>:<行号>`（gen 解决截断/旋转冲突）。 */
export function fileDedupKey(path: string, inode: number, gen: number, lineNo: number): string {
  return `file:${path}:${inode}:${gen}:${lineNo}`;
}

/** §4 表：`<source>:<payload.id ?? payload.delivery_id ?? sha256(body)[0:16]>`。 */
export function webhookDedupKey(source: string, extId: string | undefined, bodySha256Hex: string): string {
  const anchor = extId !== undefined && extId.length > 0 ? extId : bodySha256Hex.slice(0, 16);
  return `${source}:${anchor}`;
}

/** §4 表：`tg:<update_id>`（长轮询重拉的幂等锚）。 */
export function telegramDedupKey(updateId: number): string {
  return `tg:${updateId}`;
}

/** §4 表：`fs:<event_id>`（飞书事件推送的幂等锚）。 */
export function feishuDedupKey(eventId: string): string {
  return `fs:${eventId}`;
}

// ── §5.7 出站通知 ────────────────────────────────────────────────────

/** §5.7 deliver 结果（MR 计 10s 超时，本模块内部对 Telegram 快重试）。 */
export type DeliverResult = { ok: boolean; error?: string };

/** channels.ts 的出站目标（cli/file/http 可用；telegram 留接线位；feishu 2026-10-16 接上）。 */
export type OutboundChannelName = 'cli' | 'file' | 'http' | 'telegram' | 'feishu' | 'email';

// ── §4.5 SSE ─────────────────────────────────────────────────────────

/** §4.5 BusEvent 的 SSI 通道子集（本模块转发表用）。 */
export type SseTopic = string;

/** SSE 订阅请求（`GET /api/stream?topics=…&last_event_id=…`）。 */
export interface SseSubscription {
  /** 通道过滤；空 = 全部六通道。 */
  topics: BusEvent['channel'][];
  /** Last-Event-ID 头（bus_seq）。 */
  lastEventId: number | null;
  /** dot 过滤（缺省全部）。 */
  dotId?: string;
}

/** §4.5 重放窗：游标落后 head 且 ≤5000 条内 → 重放快照事件，否则发 resync。 */
export const SSE_REPLAY_WINDOW = 5000;

/** §4.5：每订阅者瞬态队列上限 200，溢出丢 delta，靠 chat.final 校正。 */
export const SSE_DELTA_QUEUE_LIMIT = 200;

// ── §5.2 HTTP 响应投影（路由表返回给 web.ts 的语义层）─────────────────

/** 路由层统一返回（web.ts 只负责写状态码/JSON，不含业务）。 */
export interface HttpErrorShape {
  status: number;
  code: string;
  message: string;
  /** 503 时给 hook 方的重投等待（§5.1 末段）。 */
  retryAfterMs?: number;
}

/** GET /api/breaker / /api/models/rank 的投影源（MR snapshot 直出）。 */
export type BreakerView = RouterSnapshot;

/** GET /api/approvals?state=pending 的行形状（GOV ApprovalView 直出）。 */
export type ApprovalRowView = ApprovalView;

/** §4.6 RawInbound 在本模块的再导出（ingress.ts 的入参即此类型）。 */
export type { RawInbound };
