/**
 * src/surfaces/http.ts —— HTTP 路由表 + 鉴权 + HMAC（surfaces.md §5.2；契约 H2/S-2/S-4）。
 *
 * 全 daemon **唯一监听**，默认 `127.0.0.1:7788`（契约 H2：CP 的 8642 作废，CP REST 子集由
 * 本路由器进程内转调 CP 函数）。鉴权/CORS/SSE/CLI base URL 四件事单点在此。
 *
 * F6（2026-10-22）：host 变成可配置（`surfaces.http.host` / 环境变量 `DOTD_HTTP_HOST`），
 * 但**代码默认值仍是回环**（`DEFAULT_HTTP_HOST`，判据 scripts/regress/web-console-criteria.sh
 * 钉住它）。扩到非回环只收紧、绝不放宽这里的判定 —— 见下面「暴露面」段的三条处置。
 *
 * §5.2 鉴权（逐字落地）：
 * - `Bearer master_token`：全部读写；
 * - `readonly_tokens` 仅 GET；
 * - 带 `Origin`/`Referer` 必须命中白名单（防 DNS rebinding）；
 * - hooks 用 HMAC：`X-Dotd-Timestamp`（±300s）+ `X-Dotd-Nonce`（LRU 5k 防重放）
 *   + `X-Dotd-Signature: sha256=hex(hmac(ts\n nonce\n body))`；body ≤256KB。
 *
 * §5.2 路由表（rev2 全部写明属主）：
 * | GET /api/health · /api/whoami            | 本模块 |
 * | POST /api/messages {text, threadId?}     | cp.submit({title:text.slice(0,60),goal:text,priority:1}) |
 *                                             |   **threadId 语义**（2026-10-19 实测补充）：|
 *                                             |   - 不传 → 每句话**新建会话**（多轮对话接不上，|
 *                                             |     但长期记忆仍生效，实测能答出历史上的暗号）；|
 *                                             |   - 传已有的 → 复用该会话，**本会话上下文连续**|
 *                                             |     （实测："我刚才让你记的暗号"能准确答出）。|
 *                                             |   飞书路径按 chat_id 自动复用，不受此影响。   |
 * | GET /api/queue?dot=                     | cp.list() 投影 |
 * | POST /api/queue/:id/cancel              | cp.cancel(id,'user') |
 * | GET /api/conversations?dot=&before=&limit= | 记忆模块会话 API（MemoryPort） |
 * | GET /api/approvals?state=pending · :id  | gov.listPending() / ApprovalView |
 * | POST /api/approvals/:id/decision        | gov.decide(id,'web'|'cli',verdict,actor)（唯一写路径在 GOV）|
 * | GET /api/events?since=                  | CP events 表分页（received_at 排序）|
 * | GET /api/guard · /api/breaker · /api/models/rank | cp.getGuardStatus() / MR snapshot |
 * | GET /api/stream?topics=…                | SSE，游标 = bus_seq（§4.5）|
 * | POST /api/hooks · /api/heartbeat         | 写 config.yml（hooks）/ 写 CP crontabs |
 * | POST /hooks/:source                     | §5.1 ingest，202 {eventId}；dup 200 {eventId,dup:true} |
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { BusChannel, EventBus } from '../shared/bus.ts';
import type {
  ApprovalView,
  ControlPlane,
  EventsRow,
  GovernancePort,
  MemoryPort,
  NotificationChannels,
  RawInbound,
  RouterPort,
  Task,
  TaskStatus,
  Verdict,
} from '../shared/contracts.ts';
import { ConfigError } from '../shared/errors.ts';
import { DEFAULT_DOT_ID } from '../shared/ids.ts';
import { HOME_IDENTITY, LIMIT_ARCHIVE_BYTES, LIMIT_IDENTITY_MD } from '../memory/limits.ts';
import { MAX_IMPORT_BYTES, buildImportNote } from './memory-import.ts';
import { createSchedule, listSchedules, removeSchedule } from '../control-plane/schedules.ts';
import { CronExpressionParser } from 'cron-parser';
import type { HookConfig, SurfacesConfig } from './types.ts';
import { createIngress, ingest, MAX_BODY_BYTES, normalizeHook, originAllowed } from './ingress.ts';
import { DEFAULT_HTTP_HOST, isLoopbackBindHost } from './config.ts';
import { handleFeishuCallback, maybeDecryptFeishuBody } from './feishu-inbound.ts';
import { listOutbound } from './feishu-outbound.ts';
import { SseBus, parseStreamQuery } from './sse.ts';
import { createHeartbeatAdmin } from './heartbeat-tick.ts';
import { buildTaskView, type CallLogRow } from './task-view.ts';
import { buildTaskSummary } from './task-summary.ts';
import { PLAN_MARKER, plansFromMessages } from '../runner/plan.ts';
import { serveStatic } from './web.ts';
import type { DailyBrief } from './daily-brief.ts';
import type { FeedSnapshot } from './feed.ts';
import type { ProofBundle } from './proof.ts';
import type { ConnectionRow } from './connections.ts';
import { connectionSummary, renderConnections } from './connections.ts';
import {
  dashboardCsp,
  dashboardHomePath,
  parseDashboardSlug,
  validateDashboardHtml,
} from './dashboard.ts';
import { resolve } from 'node:path';

// ── 常量（§5.2 逐字） ────────────────────────────────────────────────

/** §5.2：hooks 用 HMAC 时间窗 ±300s。 */
export const HMAC_WINDOW_MS = 300 * 1000;
/** §5.2：X-Dotd-Nonce LRU 容量 5k。 */
export const HMAC_NONCE_LRU = 5_000;
/** §2.2：SSE 连接 ≤8。 */
export const MAX_SSE_CONNECTIONS = 8;
/** §5.2：body ≤256KB。 */
export const MAX_BODY = MAX_BODY_BYTES;

export type Route =
  | 'health'
  | 'status'
  | 'whoami'
  | 'messages'
  | 'queue'
  | 'queue_cancel'
  | 'queue_resume'
  | 'conversations'
  | 'approvals'
  | 'approval_by_id'
  | 'approval_decision'
  | 'vault_list'
  | 'vault_put'
  | 'vault_delete'
  | 'events'
  | 'guard'
  | 'breaker'
  | 'models_rank'
  | 'channels'
  | 'stream'
  | 'hooks_admin'
  | 'heartbeat_admin'
  | 'hook_ingest'
  | 'task_by_id'
  | 'task_proof'
  | 'devices'
  | 'device_by_id'
  | 'device_rotate'
  | 'device_turn'
  | 'device_task'
  | 'device_stream'
  | 'device_events'
  | 'device_approval'
  | 'device_memory'
  | 'device_memory_turn'
  | 'device_prefs'
  | 'device_pref_delete'
  | 'device_proactive_decide'
  | 'memory_prefs'
  | 'activity'
  | 'brief'
  | 'feed'
  | 'connections'
  | 'logs'
  | 'memory_archive'
  | 'memory_restore'
  | 'memory_identity'
  | 'memory_import'
  | 'schedules'
  | 'schedule_by_id'
  | 'container'
  | 'outbound'
  | 'static';

export interface MatchResult {
  route: Route;
  params: Record<string, string>;
}

/**
 * 路由表（§5.2 原文；顺序即优先级——更具体的模式在前）。
 * 返回 null = 无匹配（调用方回落静态托管）。
 */
export function matchRoute(method: string, pathname: string): MatchResult | null {
  const m = method.toUpperCase();
  const p = pathname.replace(/\/+$/, '') || '/';

  // 精确匹配优先
  if (m === 'GET' && (p === '/api/health' || p === '/api/healthz')) return { route: 'health', params: {} };
  // §5.2 补订：/api/status = 复合探针（health + queue + breaker + 审批数），
  // 冒烟脚本与 CLI `/status`（surfaces.md:273）共用这一个端点（跨模块对接缺口，
  // 由装配期冒烟发现；数据全部取自已有属主投影，不新增事实源）。
  if (m === 'GET' && p === '/api/status') return { route: 'status', params: {} };
  // D1/D3（2026-10-22，对标 Claude Duet）：每日简报 / 已连接应用总览。
  // 两个都是**只读聚合**，数据全部来自本机库与日历目录；不含任何凭证
  //（邮箱只到地址与主机名，模型端点只到 base_url 与模型名）。
  if (m === 'GET' && p === '/api/brief') return { route: 'brief', params: {} };
  if (m === 'GET' && p === '/api/feed') return { route: 'feed', params: {} };
  if (m === 'GET' && p === '/api/connections') return { route: 'connections', params: {} };
  if (m === 'GET' && p === '/api/whoami') return { route: 'whoami', params: {} };
  if (m === 'POST' && p === '/api/messages') return { route: 'messages', params: {} };
  if (m === 'GET' && p === '/api/queue') return { route: 'queue', params: {} };
  if (m === 'GET' && p === '/api/conversations') return { route: 'conversations', params: {} };
  if (m === 'GET' && p === '/api/approvals') return { route: 'approvals', params: {} };
  // A2 保险库（2026-10-21）：列条目名 / 写入（secret 只走回环 + master token）/ 删除。
  // 写路径只有 daemon（D2 单写者），CLI 是瘦客户端。
  if (m === 'GET' && p === '/api/vault') return { route: 'vault_list', params: {} };
  if (m === 'POST' && p === '/api/vault/entries') return { route: 'vault_put', params: {} };
  if (m === 'DELETE' && p === '/api/vault/entries') return { route: 'vault_delete', params: {} };
  if (m === 'POST' && p === '/api/approvals/decision') {
    // 便捷别名（无 :id 时不合法，仍路由过去由 handler 报错）
    return { route: 'approval_decision', params: {} };
  }
  if (m === 'GET' && p === '/api/events') return { route: 'events', params: {} };
  // 记忆备份入口（2026-10-18）：.archive/ 有内容但原先只能手动 docker exec 恢复，
  // 等于"有能力、没入口"。这两条把路补上。
  // 容器状态（2026-10-19）：quarantined 是 recreate_count>3/24h 的**保护机制**，
  // 但隔离后所有依赖容器的任务都会失败，且现象是"模型说容器有问题"——不好排查。
  // 这里给一个查询/重置入口。
  // 出站审计（2026-10-19）：飞书回复有没有发出去、发到哪、失败原因。
  // 原来只写日志，而日志每次 daemon 重启都被清空 -> "我没收到回复"无从查证。
  if (m === 'GET' && p === '/api/outbound') return { route: 'outbound', params: {} };
  if (m === 'GET' && p === '/api/container') return { route: 'container', params: {} };
  if (m === 'POST' && p === '/api/container/reset') return { route: 'container', params: { action: 'reset' } };

  // 定时任务（2026-10-18）：crontabs 表与调度器早就有，缺创建入口。
  if (p === '/api/schedules') {
    if (m === 'GET') return { route: 'schedules', params: {} };
    if (m === 'POST') return { route: 'schedules', params: {} };
  }
  {
    const mm = /^\/api\/schedules\/([^/]+)$/.exec(p);
    if (mm !== null && m === 'DELETE') return { route: 'schedule_by_id', params: { id: mm[1]! } };
  }
  if (m === 'GET' && p === '/api/memory/archive') return { route: 'memory_archive', params: {} };
  if (m === 'POST' && p === '/api/memory/restore') return { route: 'memory_restore', params: {} };
  // M3（2026-10-23）：人格文件读写。GET 读，PUT 写（≤1 KB）。
  if ((m === 'GET' || m === 'PUT') && p === '/api/memory/identity') return { route: 'memory_identity', params: {} };
  // M4（2026-10-24）：旧助手记忆导入。只写 notes/，不碰 MEMORY.md。
  if (m === 'POST' && p === '/api/memory/import') return { route: 'memory_import', params: {} };
  if (m === 'GET' && p === '/api/guard') return { route: 'guard', params: {} };
  if (m === 'GET' && p === '/api/breaker') return { route: 'breaker', params: {} };
  if (m === 'GET' && p === '/api/models/rank') return { route: 'models_rank', params: {} };
  if (m === 'GET' && p === '/api/channels') return { route: 'channels', params: {} };
  if (m === 'GET' && p === '/api/stream') return { route: 'stream', params: {} };
  if (m === 'POST' && p === '/api/hooks') return { route: 'hooks_admin', params: {} };
  if (m === 'POST' && p === '/api/heartbeat') return { route: 'heartbeat_admin', params: {} };
  // P1-6：入站拒绝审计（`dotd logs` 的属主端点；此前 CLI 只能拿 /api/guard 凑）。
  if (m === 'GET' && p === '/api/logs') return { route: 'logs', params: {} };

  // 参数化
  let mm = /^\/api\/queue\/([^/]+)\/cancel$/.exec(p);
  if (m === 'POST' && mm !== null) return { route: 'queue_cancel', params: { id: decodeURIComponent(mm[1]!) } };

  // surfaces.md:273 主人 /resume 的 HTTP 属主：circuit_open 暂停任务除 mode_changed
  // 批量回队外的单人恢复路径（cp.resume，queue.ts:411）。
  mm = /^\/api\/queue\/([^/]+)\/resume$/.exec(p);
  if (m === 'POST' && mm !== null) return { route: 'queue_resume', params: { id: decodeURIComponent(mm[1]!) } };

  mm = /^\/api\/approvals\/([^/]+)$/.exec(p);
  if (m === 'GET' && mm !== null) {
    return { route: 'approval_by_id', params: { id: decodeURIComponent(mm[1]!) } };
  }

  mm = /^\/api\/approvals\/([^/]+)\/decision$/.exec(p);
  if (m === 'POST' && mm !== null) {
    return { route: 'approval_decision', params: { id: decodeURIComponent(mm[1]!) } };
  }

  // 语音设备（2026-10-23，阶段 2）：主人管理设备；设备 token 只走 /api/device/*。
  if (p === '/api/devices') {
    if (m === 'GET') return { route: 'devices', params: {} };
    if (m === 'POST') return { route: 'devices', params: {} };
  }
  mm = /^\/api\/devices\/([^/]+)$/.exec(p);
  if (m === 'DELETE' && mm !== null) {
    return { route: 'device_by_id', params: { id: decodeURIComponent(mm[1]!) } };
  }
  mm = /^\/api\/devices\/([^/]+)\/rotate$/.exec(p);
  if (m === 'POST' && mm !== null) {
    return { route: 'device_rotate', params: { id: decodeURIComponent(mm[1]!) } };
  }
  if (m === 'POST' && p === '/api/device/turn') return { route: 'device_turn', params: {} };
  if (m === 'GET' && p === '/api/device/stream') return { route: 'device_stream', params: {} };
  if (m === 'POST' && p === '/api/device/events') return { route: 'device_events', params: {} };
  mm = /^\/api\/device\/tasks\/([^/]+)$/.exec(p);
  if (m === 'GET' && mm !== null) {
    return { route: 'device_task', params: { id: decodeURIComponent(mm[1]!) } };
  }
  mm = /^\/api\/device\/approvals\/([^/]+)$/.exec(p);
  if (m === 'POST' && mm !== null) {
    return { route: 'device_approval', params: { id: decodeURIComponent(mm[1]!) } };
  }

  // 阶段 5（2026-10-24）：单一记忆源 + 单一主动推送决策。
  // 设备面：读自己的一整份记忆（消息 + 偏好）、补写反射轮次、写偏好、问「该不该推」。
  if (m === 'GET' && p === '/api/device/memory') return { route: 'device_memory', params: {} };
  if (m === 'POST' && p === '/api/device/memory/turn') {
    return { route: 'device_memory_turn', params: {} };
  }
  if (m === 'PUT' && p === '/api/device/prefs') return { route: 'device_prefs', params: {} };
  mm = /^\/api\/device\/prefs\/([^/]+)$/.exec(p);
  if (m === 'DELETE' && mm !== null) {
    return { route: 'device_pref_delete', params: { key: decodeURIComponent(mm[1]!) } };
  }
  if (m === 'POST' && p === '/api/device/proactive/decide') {
    return { route: 'device_proactive_decide', params: {} };
  }
  // 主人面：Web/CLI 看语音侧偏好（与设备面同一张表，证明「一个事实源」）。
  if (m === 'GET' && p === '/api/memory/prefs') return { route: 'memory_prefs', params: {} };

  // 执行凭证（2026-10-23）：`dotd prove <taskId>` 的属主端点。只读，投影自本机 journal。
  mm = /^\/api\/tasks\/([^/]+)\/proof$/.exec(p);
  if (m === 'GET' && mm !== null) {
    return { route: 'task_proof', params: { id: decodeURIComponent(mm[1]!) } };
  }

  // P1-6 可观测性：任务明细（CP getTask + getJournal 的投影，供 `dotd task <id>` 用）。
  // 细节查询参数走 query（`?verbose=1` 带每步耗时与 token 成本汇总）。
  mm = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (m === 'GET' && mm !== null) {
    return { route: 'task_by_id', params: { id: decodeURIComponent(mm[1]!) } };
  }

  // 9.3（2026-10-21）活动/回执总览：`dotd activity` 与 Web 活动页的数据源。
  // 与 task_by_id 是「一个任务」vs「最近一批任务」的关系，同一数据投影面。
  if (m === 'GET' && p === '/api/activity') {
    return { route: 'activity', params: {} };
  }

  mm = /^\/hooks\/([^/]+)$/.exec(p);
  if (m === 'POST' && mm !== null) {
    return { route: 'hook_ingest', params: { source: decodeURIComponent(mm[1]!) } };
  }

  return null;
}

// ── HMAC 验签（§5.2） ────────────────────────────────────────────────

export interface HmacVerifyInput {
  secret: string;
  /** X-Dotd-Timestamp（epoch 秒或毫秒——按位数自适应）。 */
  timestamp: string | undefined;
  nonce: string | undefined;
  /** X-Dotd-Signature：`sha256=hex(hmac(ts\n nonce\n body))`。 */
  signature: string | undefined;
  /** 原始 body（未解析前的字节）。 */
  body: Buffer | string;
  nowMs: number;
}

export type HmacVerifyResult =
  | { ok: true; tsMs: number; nonce: string }
  | { ok: false; reason: 'missing' | 'format' | 'timestamp' | 'signature' | 'nonce' };

/** §5.2 签名串：`ts\n nonce\n body`（换行拼接，hex 摘要，前缀 `sha256=`）。 */
export function hmacSignature(secret: string, ts: string, nonce: string, body: Buffer | string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${ts}\n${nonce}\n`);
  mac.update(body);
  return `sha256=${mac.digest('hex')}`;
}

/** 常量时间比较（防时序侧信道）。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** 解析时间戳（10 位 = 秒，13 位 = 毫秒）。 */
function parseTs(ts: string): number | null {
  if (!/^\d+$/.test(ts)) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return ts.length <= 10 ? n * 1000 : n;
}

/**
 * §5.2 HMAC 校验：时间窗 ±300s + LRU 5k 防重放 + 常量时间比签名。
 *
 * 顺序要紧：**先验签，后碰 nonce**。反过来的话，任何拿着新鲜 nonce 的伪造请求
 * （签名是错的）都会把这个 nonce 烧掉——真客户端随后用同一个 nonce 重发就被当成
 * 重放拒掉，等于外部输入能单方面废掉合法调用方的 nonce（2026-10-17 修）。
 * nonceSeen 由调用方实现"判定并登记"（NonceCache.has），所以只有走到这里的请求
 * ——时间窗对、签名对——才配占用一个 nonce。
 */
export function verifyHmac(input: HmacVerifyInput, nonceSeen: (nonce: string) => boolean): HmacVerifyResult {
  if (input.timestamp === undefined || input.nonce === undefined || input.signature === undefined) {
    return { ok: false, reason: 'missing' };
  }
  const tsMs = parseTs(input.timestamp);
  if (tsMs === null) return { ok: false, reason: 'format' };
  if (Math.abs(input.nowMs - tsMs) > HMAC_WINDOW_MS) return { ok: false, reason: 'timestamp' };
  if (!/^sha256=[0-9a-f]{64}$/.test(input.signature)) return { ok: false, reason: 'format' };
  const expect = hmacSignature(input.secret, input.timestamp, input.nonce, input.body);
  if (!safeEqualHex(expect, input.signature)) return { ok: false, reason: 'signature' };
  if (nonceSeen(input.nonce)) return { ok: false, reason: 'nonce' };
  return { ok: true, tsMs, nonce: input.nonce };
}

/** §5.2：X-Dotd-Nonce 的 LRU 5k（容量满时丢最旧）。 */
export class NonceCache {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number = HMAC_NONCE_LRU) {}

  /** 判定并登记：true = 已见过（重放）。 */
  has(nonce: string): boolean {
    if (this.seen.has(nonce)) return true;
    this.seen.add(nonce);
    this.order.push(nonce);
    if (this.order.length > this.capacity) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.seen.delete(dropped);
    }
    return false;
  }

  size(): number {
    return this.seen.size;
  }
}

// ── 鉴权（Bearer master / readonly） ─────────────────────────────────

export type AuthKind = 'master' | 'readonly' | 'none';

/** §5.2：Bearer master_token 全部读写；readonly_tokens 仅 GET。 */
export function authenticate(
  headers: IncomingMessage['headers'],
  cfg: { masterToken: string; readonlyTokens: readonly string[] },
  method: string,
): { kind: AuthKind; token: string | null; error?: 'missing' | 'invalid' | 'readonly_write' } {
  const header = headers['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) return { kind: 'none', token: null, error: 'missing' };
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (m === null) return { kind: 'none', token: null, error: 'invalid' };
  const token = m[1]!.trim();
  if (safeEqualStr(token, cfg.masterToken)) return { kind: 'master', token };
  if (cfg.readonlyTokens.some((t) => safeEqualStr(token, t))) {
    if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      return { kind: 'readonly', token, error: 'readonly_write' };
    }
    return { kind: 'readonly', token };
  }
  return { kind: 'none', token: null, error: 'invalid' };
}

/** 语音设备身份（阶段 2）：设备 token 只认这条链，不碰 master/readonly。 */
export interface DeviceAuth {
  id: string;
  dotId: string;
  name: string;
}

/** 路由是否属于设备面（只允许设备 token）。 */
export function isDeviceRoute(route: Route): boolean {
  return (
    route === 'device_turn' ||
    route === 'device_task' ||
    route === 'device_stream' ||
    route === 'device_events' ||
    route === 'device_approval' ||
    route === 'device_memory' ||
    route === 'device_memory_turn' ||
    route === 'device_prefs' ||
    route === 'device_pref_delete' ||
    route === 'device_proactive_decide'
  );
}

/** 设备 token 只存 sha256；库里没有明文。 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 本地日期 `YYYY-MM-DD`（额度和主人的时区一致，不用 UTC 切日）。 */
import { localDay } from './device-usage.ts';
export { localDay };
import {
  decideDevicePush,
  deleteDevicePref,
  listDevicePrefs,
  listDevicePushLog,
  mirrorDeviceTurn,
  setDevicePref,
  snapshotDeviceMemory,
  voicePushPolicy,
} from './voice-memory.ts';

export function findDeviceByToken(db: DatabaseSync, token: string): DeviceAuth | null {
  const row = db
    .prepare('SELECT id, dot_id AS dotId, name, status FROM devices WHERE token_hash = ?')
    .get(hashDeviceToken(token)) as { id: string; dotId: string; name: string; status: string } | undefined;
  if (row === undefined || row.status !== 'active') return null;
  return { id: row.id, dotId: row.dotId, name: row.name };
}

/** 取 Authorization: Bearer 的 token 原文（不校验，没有返回 null）。 */
function bearerFromHeaders(headers: IncomingMessage['headers']): string | null {
  const raw = Array.isArray(headers['authorization']) ? headers['authorization'][0] : headers['authorization'];
  if (raw === undefined || raw.length === 0) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m === null ? null : m[1]!.trim();
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ── 暴露面（F6：可配置 bind ⇒ 鉴权边界只能收紧，不能放宽）────────────────
//
// 把监听地址从回环扩到局域网，**改变的是「谁能连上这个端口」**，一个请求字节都没变。
// 于是三条原本靠「只有本机能连」兜住的假设同时失效，本段逐条处置：
//
//   ① Origin 白名单空 = 全部放行（ingress.ts 的 originAllowed：allow.length === 0
//      直接 return true）。回环监听时这不叫漏洞（能连上的只有本机进程）；扩到局域网
//      后它等于「任何局域网网页把浏览器指到本机，就能带着用户 Origin 打 /api」。
//      → 处置见 originAllowedForBind()：非回环 + 空/通配白名单 ⇒ 一律拒绝带
//        Origin/Referer 的请求，主人必须显式写下自己要用的来源。
//
//   ② /api/stream 的 token 走 ?token=（EventSource 不能设请求头，§4.5 明文妥协）。
//      URL 会被浏览器写进**历史记录**、被上游**代理/网关日志**整条记走、还可能通过
//      Referer 带出去。回环时这些落点都在本机同一人手里，风险≈0；扩到局域网后它们
//      变成「共享设备 / 中间代理看得到你的 master token」。
//      → 本轮处置：监听时打警告（不删功能：删了手机控制台就用不了，代价更大）+
//        前端 meta referrer=no-referrer（web-ui/index.html，堵住 Referer 这条），
//        并把「上 HTTPS / 反代」列为未解决风险如实上报。
//
//   ③ 保险库写路径。daemon.ts:1553 注释写着「secret 只走本机回环 + master token」，
//      但**代码从来没验过回环**。扩面后这条注释第一次变成实际承诺。
//      → 处置见 requireLoopbackPeer 判定：非回环监听时，带 secret 过线的
//        POST/DELETE /api/vault/entries 只对回环对端开放（403 并如实说明原因）。

/**
 * 对端地址是否本机回环。
 *
 * 只看 socket 的 remoteAddress，不信任何转发头：`X-Forwarded-For` 是客户端可编的，
 * 拿它判回环等于把门钥匙交给门外的人。**反代场景因此不在本轮支持范围内**
 * （见交付报告的残留风险）：套一层 nginx 后所有对端都是代理，判定恒真。
 */
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const raw = (req.socket?.remoteAddress ?? '').toLowerCase();
  if (raw.length === 0) return false;
  const addr = raw.replace(/^\[/, '').replace(/\]$/, '');
  if (addr.startsWith('127.')) return true;
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  // Unix socket / 命名管道（没有 IP 字面量）= 本机进程，算回环。
  if (!/[:.]/.test(addr)) return true;
  return false;
}

/**
 * Origin 白名单是不是「没写字 / 写了通配」。
 *
 * 空数组 = originAllowed 直接放行全部；含 `*` 是主人的「通配」意图（现 matcher 其实
 * 不认它，会让浏览器全 403 —— 属于配置写错）。两种都要在非回环监听时按「未显式授权」
 * 处理，这样「扩面 + 忘了配白名单」不会等于「扩面 + 没有 Origin 闸」。
 */
export function originsAreLenient(allowed: readonly string[]): boolean {
  return allowed.length === 0 || allowed.some((o) => o.trim().length === 0 || o.includes('*'));
}

/**
 * Origin 闸（§5.2 防 DNS rebinding）在「本次监听的暴露面」下的实际判定。
 * @param bindLoopback 绑的是回环（只有本机可达）还是可路由地址（局域网可达）。
 */
export function originAllowedForBind(
  headers: { origin?: string; referer?: string },
  allowed: readonly string[],
  bindLoopback: boolean,
): boolean {
  if (bindLoopback) return originAllowed(headers, allowed);
  if (originsAreLenient(allowed)) {
    // 未显式授权 ⇒ 带 Origin/Referer 的一律拒；无来源客户端（curl / CLI / hooks）不受影响。
    const fromBrowser = (headers.origin?.length ?? 0) > 0 || (headers.referer?.length ?? 0) > 0;
    return !fromBrowser;
  }
  return originAllowed(headers, allowed);
}

/**
 * 需要「回环对端」才放行的路由：secret 明文过线的那两条写路径。
 * 回环监听时恒不触发（不改既有行为）；扩到局域网后才生效 ⇒ 只收紧、不放宽。
 */
export function routeRequiresLoopbackPeer(route: Route): boolean {
  return route === 'vault_put' || route === 'vault_delete';
}

/** 暴露面的启动期一句话结论（daemon 日志与判据都读它）。 */
export function describeBind(cfg: SurfacesConfig): string {
  const loopback = isLoopbackBindHost(cfg.http.host);
  const lenient = originsAreLenient(cfg.http.allowedOrigins);
  return [
    `监听 ${cfg.http.host}:${cfg.http.port}`,
    loopback ? '回环（仅本机可达）' : '非回环（同局域网可达）',
    lenient ? 'Origin 白名单未显式授权' : `Origin 白名单 ${cfg.http.allowedOrigins.length} 条`,
  ].join(' · ');
}

// ── HTTP 服务 ────────────────────────────────────────────────────────

/** 9.3 活动总览的一行（`GET /api/activity` 的投影，不是表结构）。 */
interface ActivityRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  attempt: number;
  createdAt: string | number;
  updatedAt: string | number;
  /** 该任务累计步数（steps 表计数）。 */
  stepCount: number;
  /** 其中失败的步数 —— 「卡在哪」的第一眼线索。 */
  failedSteps: number;
}

export interface MemoryArchiveEntry {
  /** .archive/ 里的文件名（含时间戳前缀）。 */
  name: string;
  /** 归档时刻（ISO，取自文件名前缀）。 */
  archivedAt: string;
  /** 原始相对路径（把归档名里的 _ 还原成 /）。 */
  originalPath: string;
  /** 字节数。 */
  sizeBytes: number;
}

/** A2 保险库端口（2026-10-21）：daemon 装配；未装配 = daemon 缺 DOTD_MAIL_KEY。 */
export interface VaultPort {
  list(): Array<{ site: string; user: string }>;
  put(site: string, user: string, secret: string): void;
  remove(site: string, user: string): boolean;
}

export interface HttpDeps {
  db: DatabaseSync;
  bus: EventBus;
  cp: ControlPlane;
  gov: GovernancePort;
  mem: MemoryPort;
  router: RouterPort;
  channels: NotificationChannels | null;
  sse: SseBus;
  /** A2：保险库（可选；缺省 = 未配钥匙，写路径报 501）。 */
  vault?: VaultPort;
  cfg: SurfacesConfig;
  /**
   * §5.7 求救投递顺序与兜底文件（由装配层从 ModelRouter.alertsRoute() 取真值）。
   * 缺省 = 编译期默认顺序；`/api/channels` 与 `dotd sos-test` 靠它说话。
   */
  alertsRoute?: () => { order: readonly string[]; outboxPath: string };
  /** Web UI 静态根（绝对路径；缺省 repo 根 web-ui/dist）。 */
  webRoot?: string;

  /**
   * 仪表盘（D2）：从容器 home 读文件。daemon 装配时传 exec 侧的 fs.read(base64) 实现。
   * 缺省 = `/d/<slug>` 一律 503 —— 没装这条腿时宁可明说，也别回一个空页面。
   */
  readHomeFile?: (dotId: string, path: string) => Promise<Buffer | null>;
  /** 仪表盘所属 dot。阶段一恒 dot1（多 Dot 是阶段三）。 */
  dotId?: string;
  /**
   * 每日简报（D1）：daemon 装配好的取数+渲染闭包（`insight.ts` 的 `buildBrief`）。
   * 缺省 = `/api/brief` 回 503 —— 没装这条腿时明说，别回一句「今天没事」。
   */
  brief?: (nowMs?: number) => DailyBrief;
  /**
   * 动态（M1，2026-10-23）：同一份投影供 Web / `dotd feed`。
   * 缺省 = `/api/feed` 回 503 —— 没装这条腿时明说，别回一条空时间线。
   */
  feed?: (nowMs?: number, opts?: { limit?: number; since?: number }) => FeedSnapshot;
  /**
   * 执行凭证（P1，2026-10-23）：journal + exec_calls + 审批 + 模型调用 + 审计的投影。
   * 缺省 = 503；任务不存在 = 404。默认不含明文参数。
   */
  proof?: (taskId: string, opts?: { includeArgs?: boolean }) => ProofBundle | null;
  /** 已连接应用总览（D3）：同上，`insight.ts` 的 `buildConnectionsView`。 */
  connections?: () => ConnectionRow[];  now?(): Date;
  /**
   * 列出 .archive/ 里的记忆备份（按时间倒序）。
   * 2026-10-18：归档能力做完后补的"入口"——之前只能手动 docker exec cp 恢复。
   */
  listMemoryArchive?(): Promise<MemoryArchiveEntry[]>;
  /** 把某个归档写回原路径（覆盖前同样会归档当前版本）；返回结果供 API 直接回给调用方。 */
  restoreMemoryArchive?(archive: string): Promise<{ ok: boolean; restoredTo?: string; error?: string }>;
}

/** §5.2 路由 → 是否需要主人 token（hooks/:source 与 /api/stream 例外处理）。 */
function requiresMaster(route: Route): boolean {
  switch (route) {
    case 'health':
    case 'status':
    case 'whoami':
      return false;
    case 'stream':
      return false; // token 可走 query（EventSource 不能带头）
    case 'device_turn':
    case 'device_task':
    case 'device_stream':
    case 'device_events':
    case 'device_approval':
    case 'device_memory':
    case 'device_memory_turn':
    case 'device_prefs':
    case 'device_pref_delete':
    case 'device_proactive_decide':
      return false; // 设备 token 校验在 handle() 的设备分支里
    default:
      return true;
  }
}

/**
 * 建 HTTP 服务（不 listen——listen 由 daemon 装配层做，便于测试用随机端口）。
 * 返回 node:http.Server；`close()` 由装配层/测试调用。
 */
export function createHttpServer(deps: HttpDeps): Server {
  const now = deps.now ?? (() => new Date());
  const nonces = new NonceCache();
  // F6：本次监听是否只有本机能连。决定 Origin 闸的松紧与保险库写路径的可见性，
  // 只用来**收紧**（true 时行为与扩面改造前逐字一致）。
  const bindLoopback = isLoopbackBindHost(deps.cfg.http.host);
  const ingress = createIngress({
    db: deps.db,
    bus: deps.bus,
    cp: deps.cp,
    gov: deps.gov,
    mem: deps.mem,
    router: deps.router,
    channels: deps.channels,
    now,
    activeTaskCount: (dotId) => deps.cp.list({ status: ['queued', 'running'], dotId }).length,
  });
  const hbAdmin = createHeartbeatAdmin(deps.db);
  const webRoot = deps.webRoot ?? resolve(process.cwd(), 'web-ui/dist');

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'internal', message: String(cause) }));
    });
  });

  /** 读 body（≤256KB；超限即拒）。 */
  const readBody = async (req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      total += buf.length;
      if (total > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'size', message: `body 超过 ${MAX_BODY} 字节` }));
        return null;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
    });
    res.end(text);
  };

  /**
   * 仪表盘（D2）：`/d/<slug>` —— 把容器 home 里的 `dashboards/<slug>.html` 原样托管。
   *
   * 为什么这条路由**不走 /api 前缀、也不要 token**：它是给主人在手机浏览器里
   * 直接点开的页面，与 web-ui 静态资源同级。写权限仍然只在 agent → 治理那条链上
   * （模型只能通过 fs.write 写文件），所以「能看」不等于「能改」。
   *
   * 三处刻意从严：
   *   ① slug 白名单（`parseDashboardSlug`），路径穿越在进入 fs 之前就被拒；
   *   ② 只发 `text/html` + 严格 CSP（`dashboardCsp`），模型写的页面不许在主人的
   *      同源里跑脚本 —— localStorage 里躺着 master token；
   *   ③ 内容不符（空/非 HTML/超 512KB）回 422 并说明原因，不硬发。
   */
  async function serveDashboard(req: IncomingMessage, res: ServerResponse, rawSlug: string): Promise<void> {
    const parsed = parseDashboardSlug(decodeURIComponent(rawSlug));
    if (!parsed.ok) {
      json(res, 404, { error: 'dashboard', message: parsed.reason === 'empty' ? '没给页面名' : '页面名不合法（只允许小写字母/数字/中划线）' });
      return;
    }
    const read = deps.readHomeFile;
    if (read === undefined) {
      json(res, 503, { error: 'dashboard', message: 'daemon 没装配仪表盘读取能力（readHomeFile 未传）' });
      return;
    }
    let buf: Buffer | null = null;
    try {
      buf = await read(deps.dotId ?? 'dot1', dashboardHomePath(parsed.slug));
    } catch (cause) {
      json(res, 503, { error: 'dashboard', message: '读页面失败：' + String(cause) });
      return;
    }
    if (buf === null) {
      json(res, 404, {
        error: 'dashboard',
        message: '没有这个仪表盘。让它做一份：一句话说清要看什么，它会写到 ' + dashboardHomePath(parsed.slug),
      });
      return;
    }
    const html = buf.toString('utf8');
    const check = validateDashboardHtml(html);
    if (!check.ok) {
      json(res, 422, {
        error: 'dashboard_invalid',
        reason: check.reason,
        message:
          check.reason === 'too_large'
            ? '页面太大（上限 512KB），别把原始数据整份贴进 HTML'
            : check.reason === 'not_html'
              ? '这个文件不是 HTML（开头既没有 <!doctype html> 也没有 <html>）'
              : '文件是空的',
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 页面可能随时被定时任务重写，缓存一份旧的就是给人看错数据
      'cache-control': 'no-store',
      'content-security-policy': dashboardCsp(),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-length': String(buf.length),
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // CORS 预检（allowed_origins 白名单）
    if (method === 'OPTIONS') {
      const origin = req.headers.origin;
      const allow = origin !== undefined && deps.cfg.http.allowedOrigins.includes(origin) ? origin : undefined;
      res.writeHead(204, {
        'access-control-allow-origin': allow ?? '',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,last-event-id,x-dotd-timestamp,x-dotd-nonce,x-dotd-signature',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      res.end();
      return;
    }

    // Origin/Referer 白名单（§5.2：防 DNS rebinding；对全部 /api 生效）
    // F6：非回环监听时，白名单为空/含通配 = 未显式授权 ⇒ 带浏览器来源的请求一律拒
    //（见文件头「暴露面」段第①条）。
    if (pathname.startsWith('/api/') && !originAllowedForBind(req.headers, deps.cfg.http.allowedOrigins, bindLoopback)) {
      ingress.rejects.record({ source: 'http', actor: null, reason: 'origin', detail: `Origin ${String(req.headers.origin ?? '')}` });
      json(res, 403, {
        error: 'origin',
        message: bindLoopback
          ? 'Origin/Referer 不在白名单'
          : 'Origin/Referer 不在白名单（daemon 正监听非回环地址：必须在 surfaces.http.allowed_origins 显式写出你的来源，空/通配不放行）',
      });
      return;
    }

    // 仪表盘（D2）：`GET /d/<slug>`。放在 matchRoute 之前 —— 它不属于 API 路由表，
    // 也不是 SPA 静态资源（那些应以 index.html 兜底，而这里必须 404/422 说人话）。
    if ((method === 'GET' || method === 'HEAD') && (pathname === '/d' || pathname.startsWith('/d/'))) {
      await serveDashboard(req, res, pathname === '/d' ? '' : pathname.slice(3));
      return;
    }
    const match = matchRoute(method, pathname);
    if (match === null) {
      // 非 /api、非 /hooks 的 GET/HEAD → 静态托管（SPA）
      if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api') && !pathname.startsWith('/hooks')) {
        await serveStatic(req, res, { root: webRoot });
        return;
      }
      json(res, 404, { error: 'not_found', message: `${method} ${pathname}` });
      return;
    }

    // 设备面鉴权（阶段 2）：设备 token 只能走 /api/device/*，且只能看自己设备的任务。
    let device: DeviceAuth | null = null;
    if (isDeviceRoute(match.route)) {
      const token = bearerFromHeaders(req.headers);
      device = token === null ? null : findDeviceByToken(deps.db, token);
      if (device === null) {
        ingress.rejects.record({ source: 'http', actor: null, reason: 'auth', detail: '设备 token 缺失/非法/已吊销' });
        json(res, 401, { error: 'auth', message: '缺少或非法的设备 token' });
        return;
      }
      deps.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now().getTime(), device.id);
    }

    // 鉴权（hooks/:source 走 HMAC，/api/stream 走 query token）
    if (match.route === 'hook_ingest') {
      await handleHookIngest(req, res, url, match.params.source!);
      return;
    }
    if (requiresMaster(match.route)) {
      const auth = authenticate(req.headers, deps.cfg.http, method);
      if (auth.error === 'missing' || auth.error === 'invalid') {
        // 设备令牌是**合法身份**，只是没有管理面权限 —— 403 而不是 401，
        // 这样语音端能区分「令牌过期/吊销」和「走错门」。
        const bearer = bearerFromHeaders(req.headers);
        if (bearer !== null && findDeviceByToken(deps.db, bearer) !== null) {
          ingress.rejects.record({
            source: 'http',
            actor: 'device',
            reason: 'auth',
            detail: `设备令牌访问管理面 ${method} ${pathname}`,
          });
          json(res, 403, { error: 'device_scope', message: '设备令牌只能访问 /api/device/*' });
          return;
        }
        ingress.rejects.record({ source: 'http', actor: null, reason: 'auth', detail: `Bearer token ${auth.error}` });
        json(res, 401, { error: 'auth', message: '缺少或非法的 Bearer token' });
        return;
      }
      if (auth.error === 'readonly_write') {
        ingress.rejects.record({ source: 'http', actor: 'readonly', reason: 'auth', detail: 'readonly token 尝试写操作' });
        json(res, 403, { error: 'auth', message: 'readonly token 仅允许 GET' });
        return;
      }
    } else if (match.route === 'stream') {
      // EventSource 不能设请求头 → token 走 ?token=（§4.5 明文妥协）。
      // §5.2「鉴权：Bearer master_token」：缺 token 与错 token 一律 401——
      //   readonly token 只走 Authorization 头，不在这里放行。
      // F6：?token= 把 master token 写进 URL，于是浏览器历史、上游代理访问日志、
      //   Referer 都可能留下它。回环监听时无所谓（落点都在本机同一人手里），
      //   扩到局域网后它是真实泄露面。这里**接受 Authorization 头**作为首选通道
      //   （fetch/自建 EventSource 替代者能带），头缺失或不对才回落到 query。
      //   只加通道、不放宽判定：仍是「必须等于 master_token」，readonly 依旧不行。
      const fromHeader = bearerFromHeaders(req.headers);
      const fromQuery = url.searchParams.get('token');
      const isMaster =
        (fromHeader !== null && safeEqualStr(fromHeader, deps.cfg.http.masterToken)) ||
        (fromQuery !== null && safeEqualStr(fromQuery, deps.cfg.http.masterToken));
      // 非回环 + 仍在用 ?token= ⇒ 说一句（一次进程一条，不刷屏）：功能不挡，但要把
      // 「token 已进 URL」这件事摆到明面上，别让主人以为头通道自动生效了。
      if (!bindLoopback && fromQuery !== null && safeEqualStr(fromQuery, deps.cfg.http.masterToken)) {
        warnExposureOnce(
          'stream-query-token',
          `SSE 正用 ?token=<master_token> 订阅（token 出现在 URL 里，会进浏览器历史与任何中间代理日志）。` +
            ` 当前监听 ${deps.cfg.http.host}:${deps.cfg.http.port} 是非回环地址；` +
            ` 自带 Authorization 头也能订阅（本端口已支持），建议前端改用头通道。`,
        );
      }
      if (!isMaster) {
        const detail = fromHeader === null && fromQuery === null ? 'stream 缺少 token' : 'stream token 非法';
        ingress.rejects.record({ source: 'http', actor: null, reason: 'auth', detail });
        json(res, 401, {
          error: 'auth',
          message: fromHeader === null && fromQuery === null
            ? 'SSE 订阅需 Authorization: Bearer <master_token>（或 ?token=<master_token>）'
            : '非法的 token',
        });
        return;
      }
    }

    // F6：保险库写路径 —— daemon.ts:1553 注释承诺「secret 只走本机回环 + master token」，
    // 但代码此前从未验回环。监听一旦扩到局域网，这条承诺第一次需要被执行：
    // 带 secret 明文过线的两条写路径只对本机回环对端开放（读路径不受影响）。
    if (!bindLoopback && routeRequiresLoopbackPeer(match.route) && !isLoopbackPeer(req)) {
      const peer = req.socket?.remoteAddress ?? '?';
      ingress.rejects.record({ source: 'http', actor: 'master', reason: 'auth', detail: `vault 写路径来自非回环对端 ${peer}` });
      json(res, 403, {
        error: 'loopback_required',
        message: '保险库写操作（新增/删除 secret）只在回环对端开放；daemon 当前监听非回环地址。' +
          '请在该机器本机执行 dotd vault add/rm，或把 surfaces.http.host 收回 127.0.0.1。',
      });
      return;
    }

    switch (match.route) {
      case 'health':
        json(res, 200, {
          ok: true,
          service: 'dotd',
          /**
           * 一套系统（2026-10-23）：Charlie 产品壳启动 dotd 子进程时用它做兼容声明。
           * 只加字段，不改任何既有键；老前端忽略它。
           */
          apiVersion: 1,
          dotId: DEFAULT_DOT_ID,
          busSeq: deps.sse.currentSeq(),
          at: now().toISOString(),
        });
        return;

      // §5.2 补订（冒烟/CLI /status 的复合探针）：health + queue 计数 +
      // breaker 模式 + 待批数。全部取自既有属主投影（cp.list / router.snapshot /
      // gov.listPending），本层不新增事实源、不写库。
      case 'status': {
        const queueRows: Task[] = deps.cp.list({
          status: ['queued', 'running', 'awaiting_approval', 'paused'],
          limit: 200,
        });
        const snap = deps.router.snapshot();
        const pending = deps.gov.listPending(200);
        json(res, 200, {
          ok: true,
          service: 'dotd',
          dotId: DEFAULT_DOT_ID,
          at: now().toISOString(),
          busSeq: deps.sse.currentSeq(),
          queue: {
            queued: queueRows.filter((t) => t.status === 'queued').length,
            running: queueRows.filter((t) => t.status === 'running').length,
            awaitingApproval: queueRows.filter((t) => t.status === 'awaiting_approval').length,
            paused: queueRows.filter((t) => t.status === 'paused').length,
          },
          router: { mode: snap.mode, endpoints: snap.endpoints.length },
          approvalsPending: pending.length,
        });
        return;
      }

      case 'whoami': {
        const auth = authenticate(req.headers, deps.cfg.http, method);
        json(res, 200, {
          kind: auth.kind,
          port: deps.cfg.http.port,
          routes: [
            'GET /api/health', 'GET /api/status', 'GET /api/whoami', 'POST /api/messages', 'GET /api/queue',
            'POST /api/queue/:id/cancel', 'GET /api/conversations', 'GET /api/approvals',
            'GET /api/approvals/:id', 'POST /api/approvals/:id/decision', 'GET /api/events',
            'GET /api/guard', 'GET /api/breaker', 'GET /api/models/rank', 'GET /api/stream',
            'GET /api/memory/archive', 'POST /api/memory/restore',
            'POST /api/hooks', 'POST /api/heartbeat', 'POST /hooks/:source',
          ],
        });
        return;
      }

      case 'messages': {
        const body = await readJson(req, res);
        if (body === null) return;
        const text = typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text : '';
        if (text.trim().length === 0) {
          json(res, 400, { error: 'schema', message: 'text 不能为空' });
          return;
        }
        const dotId = typeof (body as { dotId?: unknown }).dotId === 'string' ? (body as { dotId: string }).dotId : DEFAULT_DOT_ID;
        // 契约 S-1：POST /api/messages = memory.openThread('web',…) → appendMessage(user)
        //   → cp.submit({threadId, priority:1})
        //
        // 2026-10-18 修：**请求里带 threadId 时必须复用该会话**。
        // 原实现无条件 openThread() 新建，于是每次 POST 都是新会话 —— 多轮对话接不上：
        //   主人问"我刚才让你记的暗号是什么"，模型看到的是一个全新的空会话，
        //   答"这个会话刚开场，我们还没聊过别的"（实测）。
        // 校验：thread 必须存在且属于同一 dotId，否则退回新建（不因脏 id 拒请求）。
        const requested = (body as { threadId?: unknown }).threadId;
        let threadId: string;
        if (typeof requested === 'string' && requested.length > 0) {
          // 校验会话**确实存在**：listMessages 对不存在的 thread 返回空数组（不抛错），
          // 拿它判存在会把脏 id 放过去。直接查 surf 层的会话视图（GET /api/conversations
          // 用的同一个来源），找不到就 404。
          const known = (await deps.mem.listThreads(dotId, { limit: 500 })).find(
            (x) => x.id === requested,
          );
          if (known !== undefined) {
            threadId = requested;
          } else {
            json(res, 404, { error: 'not_found', message: `会话不存在：${requested}` });
            return;
          }
        } else {
          threadId = await deps.mem.openThread(dotId, 'web');
        }
        await deps.mem.appendMessage(threadId, { role: 'user', kind: 'text', content: text });
        const task: Task = deps.cp.submit({
          title: text.slice(0, 60),
          goal: text,
          priority: 1, // §5.1：interactive = 1（主人任务永不淘汰）
          dotId,
          threadId,
        });
        deps.bus.publish('chat.final', { kind: 'chat.final', threadId, taskId: task.id, text }, { dotId });
        json(res, 202, { taskId: task.id, threadId, status: task.status });
        return;
      }

      case 'queue': {
        const dot = url.searchParams.get('dot') ?? undefined;
        const statusRaw = url.searchParams.get('status');
        const VALID: TaskStatus[] = ['queued', 'running', 'awaiting_approval', 'paused', 'done', 'failed', 'cancelled'];
        const statuses: TaskStatus[] = statusRaw === null
          ? ['queued', 'running']
          : (statusRaw.split(',').filter((s): s is TaskStatus => (VALID as string[]).includes(s)));
        const limit = Number(url.searchParams.get('limit') ?? '100');
        const rows: Task[] = deps.cp.list({ status: statuses.length > 0 ? statuses : ['queued', 'running'], dotId: dot, limit: Number.isFinite(limit) ? limit : 100 });
        json(res, 200, {
          queue: rows.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            dotId: t.dotId,
            updatedAt: t.updatedAt,
          })),
        });
        return;
      }

      case 'queue_cancel': {
        const id = match.params.id!;
        try {
          deps.cp.cancel(id, 'user');
          json(res, 200, { ok: true, taskId: id });
        } catch (cause) {
          json(res, 404, { error: 'cancel_failed', message: String(cause) });
        }
        return;
      }

      case 'queue_resume': {
        const id = match.params.id!;
        try {
          deps.cp.resume(id);
          json(res, 200, { ok: true, taskId: id, status: 'queued' });
        } catch (cause) {
          json(res, 409, { error: 'resume_failed', message: String(cause) });
        }
        return;
      }

      case 'conversations': {
        const dot = url.searchParams.get('dot') ?? DEFAULT_DOT_ID;
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const threadId = url.searchParams.get('thread');
        if (threadId !== null) {
          const before = url.searchParams.get('before');
          const msgs = await deps.mem.listMessages(threadId, {
            limit: Number.isFinite(limit) ? limit : 50,
            beforeSeq: before === null ? undefined : Number(before),
          });
          json(res, 200, { threadId, messages: msgs });
          return;
        }
        const threads = await deps.mem.listThreads(dot, { limit: Number.isFinite(limit) ? limit : 50 });
        json(res, 200, { threads });
        return;
      }

      case 'approvals': {
        const state = url.searchParams.get('state') ?? 'pending';
        if (state !== 'pending') {
          json(res, 400, { error: 'schema', message: 'state 仅支持 pending（GOV 属主，SF 只读投影）' });
          return;
        }
        const rows: ApprovalView[] = deps.gov.listPending(Number(url.searchParams.get('limit') ?? '50'));
        json(res, 200, { approvals: rows });
        return;
      }

      case 'approval_by_id': {
        const id = Number(match.params.id);
        if (!Number.isFinite(id)) {
          json(res, 400, { error: 'schema', message: '审批 id 必须是数字（或展示序号 #seq）' });
          return;
        }
        const view = await deps.gov.getApproval(id);
        if (view === null) {
          json(res, 404, { error: 'not_found', message: `审批 ${id} 不存在` });
          return;
        }
        json(res, 200, { approval: view });
        return;
      }

      case 'vault_list': {
        json(res, 200, { entries: deps.vault?.list() ?? [] });
        return;
      }

      case 'vault_put': {
        if (deps.vault === undefined) {
          json(res, 501, { error: 'not_implemented', message: '保险库未装配（daemon 缺 DOTD_MAIL_KEY）' });
          return;
        }

        const vbody = await readJson(req, res);
        if (vbody === null) return;
        const vb = vbody as { site?: unknown; user?: unknown; secret?: unknown };
        if (
          typeof vb.site !== 'string' || vb.site.length === 0 ||
          typeof vb.user !== 'string' || vb.user.length === 0 ||
          typeof vb.secret !== 'string'
        ) {
          json(res, 400, { error: 'schema', message: '需要 site/user/secret 三个字符串（secret 允许空串）' });
          return;
        }

        try {
          deps.vault.put(vb.site, vb.user, vb.secret);
        } catch (cause) {
          json(res, 500, { error: 'vault_error', message: String(cause) });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      case 'vault_delete': {
        if (deps.vault === undefined) {
          json(res, 501, { error: 'not_implemented', message: '保险库未装配' });
          return;
        }

        const dbody = await readJson(req, res);
        if (dbody === null) return;
        const db = dbody as { site?: unknown; user?: unknown };
        if (typeof db.site !== 'string' || typeof db.user !== 'string') {
          json(res, 400, { error: 'schema', message: '需要 site/user 两个字符串' });
          return;
        }
        json(res, 200, { ok: deps.vault.remove(db.site, db.user) });
        return;
      }

      case 'approval_decision': {
        const id = Number(match.params.id);
        if (!Number.isFinite(id)) {
          json(res, 400, { error: 'schema', message: '审批 id 必须是数字' });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { verdict?: unknown; note?: unknown; channel?: unknown; actor?: unknown };
        const verdict = b.verdict;
        if (verdict !== 'approve_once' && verdict !== 'approve_remember' && verdict !== 'reject') {
          json(res, 400, {
            error: 'schema',
            message: "verdict 必须是 'approve_once'|'approve_remember'|'reject'（GOV §3.3.1）",
          });
          return;
        }
        // §5.2 原文：gov.decide(id, 'web'|'cli', verdict, actor)。通道身份由调用方声明
        // （CLI 的 approve/deny 走本端点时带 channel='cli'），actor 同理——
        // GOV 把两者原值写进 approvals.decided_by / gov_audit，不能在本层拍死 'web'。
        const channel = b.channel === 'cli' || b.channel === 'telegram' ? b.channel : 'web';
        const actorRaw = typeof b.actor === 'string' && b.actor.trim().length > 0 ? b.actor.trim().slice(0, 64) : channel;
        const note = typeof b.note === 'string' ? b.note.slice(0, 500) : undefined; // GOV:345 ≤500 字符
        const r = await deps.gov.decide(id, channel, verdict as Verdict, actorRaw, note);
        // §6：late 裁决 {ok:false, finalStatus, reason} 原样转 UI toast（本层只透传）
        json(res, r.ok ? 200 : 409, { ok: r.ok, finalStatus: r.finalStatus, reason: r.reason });
        return;
      }

      case 'events': {
        const sinceRaw = url.searchParams.get('since');
        const limitRaw = url.searchParams.get('limit');
        // since/limit 都是外部输入，直接 Number() 有两个坑：
        //   Number('abc') = NaN → 绑进 SQLite 变 NULL → `received_at < NULL` 恒空，
        //   前端看到的是"没有新事件"而不是"你参数写错了"；
        //   limit=-1 / 0 → SQLite 的 LIMIT -1 是"不限行"，一次拉全表。
        // 两者都在本层挡掉，回 400 带机读 reason（2026-10-17 修）。
        let since: number | null = null;
        if (sinceRaw !== null) {
          const n = Number(sinceRaw);
          if (!Number.isFinite(n)) {
            json(res, 400, { error: 'bad_since', message: 'since 必须是有限数字' });
            return;
          }
          since = n;
        }
        let limit = 100;
        if (limitRaw !== null) {
          const n = Number(limitRaw);
          if (!Number.isInteger(n) || n < 1 || n > 500) {
            json(res, 400, { error: 'bad_limit', message: 'limit 必须是 1..500 的整数' });
            return;
          }
          limit = n;
        }
        // §5.2：CP events 表分页，id 为 TEXT 按 received_at 排序分页（契约 E1）
        const rows = since === null
          ? (deps.db.prepare(
              `SELECT id, source, dot_id AS dotId, actor, dedup_key AS dedupKey, payload, status, received_at AS receivedAt
                 FROM events ORDER BY received_at DESC, id DESC LIMIT ?`,
            ).all(limit) as unknown as EventsRow[])
          : (deps.db.prepare(
              `SELECT id, source, dot_id AS dotId, actor, dedup_key AS dedupKey, payload, status, received_at AS receivedAt
                 FROM events WHERE received_at < ? ORDER BY received_at DESC, id DESC LIMIT ?`,
            ).all(since, limit) as unknown as EventsRow[]);
        json(res, 200, { events: rows, since: sinceRaw });
        return;
      }

      case 'guard': {
        const st = deps.cp.getGuardStatus();
        json(res, 200, st);
        return;
      }

      /**
       * P1-6 `GET /api/tasks/:id[?verbose=1]` —— 任务明细。
       *
       * 事实源全是已有属主投影（CP getTask/getJournal + model_call_log），
       * 本路由只做"读 + 投影"，不写库、不新增表。
       * `verbose=1` 时附带 `taskView`（成本/耗时/瓶颈三段），`dotd task <id> --verbose` 直接渲染它。
       */
      /**
       * 9.3（2026-10-21）`GET /api/activity` —— 「它最近都干了什么」。
       *
       * 与 `task_by_id` 的分工：那个回答"这一个任务每一步如何"，
       * 这个回答"最近这一批任务各自结果如何"。两者都是只读投影，不写库。
       *
       * query：
       *   limit  返回条数（默认 20，上限 100）
       *   status 只看某状态（done/failed/running/...）；缺省全部
       *
       * 为什么不复用 /api/queue：queue 只有**在途**（queued/running），
       * 而"干过什么"的主体是**已完成**的。两者的 SQL 谓词正好互补。
       */
      case 'activity': {
        const rawLimit = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;
        const statusFilter = url.searchParams.get('status');
        const where = statusFilter !== null && statusFilter !== '' ? 'WHERE status = ?' : '';
        const params: Array<string | number> =
          statusFilter !== null && statusFilter !== '' ? [statusFilter] : [];
        let rows: ActivityRow[] = [];
        try {
          rows = deps.db
            .prepare(
              `SELECT t.id, t.title, t.status, t.priority, t.attempt,
                      t.created_at AS createdAt, t.updated_at AS updatedAt,
                      (SELECT count(*) FROM steps s WHERE s.task_id = t.id) AS stepCount,
                      (SELECT count(*) FROM steps s WHERE s.task_id = t.id AND s.status = 'failed') AS failedSteps
                 FROM tasks t
                 ${where}
                ORDER BY t.created_at DESC
                LIMIT ?`,
            )
            .all(...params, limit) as unknown as ActivityRow[];
        } catch (cause) {
          json(res, 500, { error: 'db', message: `读活动失败：${String(cause)}` });
          return;
        }
        // 总览数字：按状态分组（不受 limit 影响，回答"整体如何"而不是"这页如何"）
        let counts: Array<{ status: string; n: number }> = [];
        try {
          counts = deps.db
            .prepare('SELECT status, count(*) AS n FROM tasks GROUP BY status')
            .all() as unknown as Array<{ status: string; n: number }>;
        } catch {
          counts = [];
        }
        json(res, 200, { tasks: rows, counts, limit });
        return;
      }

      // D1（2026-10-22）：每日简报。同一份数据既供 `dotd brief`，也供飞书每天那条推送
      //（推送侧用同一个 provider，见 daemon 的 briefTimer）—— 口径只有一处。
      case 'brief': {
        const provider = deps.brief;
        if (provider === undefined) {
          json(res, 503, { error: 'brief', message: 'daemon 没装配简报能力（insightDeps 未传）' });
          return;
        }
        try {
          const nowMs = now().getTime();
          json(res, 200, provider(nowMs));
        } catch (cause) {
          json(res, 500, { error: 'brief', message: `生成简报失败：${String(cause)}` });
        }
        return;
      }

      // M1（2026-10-23，对标 Muse 动态页）：只读时间线。
      // 数据全部来自已有属主（tasks/approvals/crontabs/events/日历），不写库、不推送。
      case 'feed': {
        const provider = deps.feed;
        if (provider === undefined) {
          json(res, 503, { error: 'feed', message: 'daemon 没装配动态投影（feedOf 未传）' });
          return;
        }
        const limitRaw = url.searchParams.get('limit');
        const sinceRaw = url.searchParams.get('since');
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        const since = sinceRaw === null ? undefined : Number(sinceRaw);
        if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
          json(res, 400, { error: 'bad_limit', message: 'limit 必须是正整数' });
          return;
        }
        if (since !== undefined && !Number.isFinite(since)) {
          json(res, 400, { error: 'bad_since', message: 'since 必须是 epoch 毫秒' });
          return;
        }
        try {
          json(res, 200, provider(now().getTime(), { ...(limit !== undefined ? { limit } : {}), ...(since !== undefined ? { since } : {}) }));
        } catch (cause) {
          json(res, 500, { error: 'feed', message: `生成动态失败：${String(cause)}` });
        }
        return;
      }

      // D3（2026-10-22）：已连接应用总览。只读；行里不含任何凭证（见 connections.ts 的约束）。
      case 'connections': {
        const provider = deps.connections;
        if (provider === undefined) {
          json(res, 503, { error: 'connections', message: 'daemon 没装配连接总览能力（insightDeps 未传）' });
          return;
        }
        try {
          const rows = provider();
          const summary = connectionSummary(rows);
          json(res, 200, { rows, summary, text: renderConnections(rows) });
        } catch (cause) {
          json(res, 500, { error: 'connections', message: `生成连接总览失败：${String(cause)}` });
        }
        return;
      }
      case 'task_by_id': {
        const id = match.params.id!;
        const task = deps.cp.getTask(id);
        if (task === null) {
          json(res, 404, { error: 'not_found', taskId: id, message: `任务 ${id} 不存在` });
          return;
        }
        const steps = deps.cp.getJournal(id);
        const callIds = steps.map((s) => s.callId).filter((c): c is string => c !== null && c.length > 0);
        // model_call_log 只取本任务 LLM 步对应的行（契约 J1：attempt_id = 步 call_id）
        const callLogs: CallLogRow[] =
          callIds.length === 0
            ? []
            : (deps.db
                .prepare(
                  `SELECT attempt_id AS attemptId, outcome,
                          latency_ms AS latencyMs, prompt_tokens AS promptTokens,
                          completion_tokens AS completionTokens,
                          endpoint_id AS endpointId, model, degraded
                     FROM model_call_log
                    WHERE attempt_id IN (${callIds.map(() => '?').join(',')})
                    ORDER BY id ASC`,
                )
                .all(...callIds) as unknown as CallLogRow[]);
        const base = {
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            dotId: task.dotId,
            attempt: task.attempt,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          steps,
        };

        // M2（2026-10-23）：一行摘要 —— 「它在干嘛 / 多久了 / 要不要我出手」。
        // 计划与结果都从已有事实读，不新增表；没有计划时 summary.next=null，不猜。
        const planRows = deps.db
          .prepare(
            `SELECT role, kind, content FROM mem_messages
              WHERE task_id=? AND role='system' AND kind='text' AND content LIKE ?
              ORDER BY seq ASC`,
          )
          .all(id, `${PLAN_MARKER}%`) as Array<{ role: string; kind: string; content: string }>;
        const plan = plansFromMessages(
          planRows.map((m, i) => ({
            id: `plan:${i}`,
            threadId: '',
            seq: i,
            role: m.role as 'system',
            kind: m.kind as 'text',
            content: m.content,
            tokenEst: 0,
            createdAt: 0,
          })),
        ).current;
        let resultSummary: string | null = null;
        try {
          const row = deps.db
            .prepare('SELECT summary FROM task_results WHERE task_id=?')
            .get(id) as { summary?: string } | undefined;
          resultSummary = typeof row?.summary === 'string' ? row.summary : null;
        } catch {
          resultSummary = null;
        }
        const summary = buildTaskSummary({
          task,
          steps,
          plan,
          resultSummary,
          now: now().getTime(),
        });

        if (url.searchParams.get('verbose') === '1' || url.searchParams.get('verbose') === 'true') {
          // P2-2：带上"它打算怎么干"。计划存成该任务在 thread 里的 system 消息
          // （kind='text' + PLAN_MARKER，见 src/runner/plan.ts 文件头的选型理由），
          // 这里只读不写：取该任务最后一条计划即当前版本。
          json(res, 200, {
            ...base,
            summary,
            view: buildTaskView({ task, steps, callLogs, now: now().getTime(), plan }),
          });
          return;
        }
        json(res, 200, { ...base, summary });
        return;
      }

      // ── 语音设备面（阶段 2，2026-10-23）────────────────────────────
      //
      // 边界（docs/voice-merge-plan.md 阶段 2）：
      //   - 设备 token 只能读自己设备产生的任务；读写都过 external_ref 校验。
      //   - 设备永远不能批准危险动作（device_approval 恒 403 并记账）。
      //   - 设备面不暴露 master 能力：/api/queue、/api/memory 等一律 401。
      case 'devices': {
        if (method === 'GET') {
          const rows = deps.db
            .prepare(
              `SELECT d.id, d.dot_id AS dotId, d.name, d.status,
                      d.last_seen_at AS lastSeenAt, d.created_at AS createdAt,
                      d.daily_tasks AS dailyTasks, d.daily_chars AS dailyChars,
                      d.daily_tokens AS dailyTokens,
                      COALESCE(u.tasks, 0) AS usedTasks, COALESCE(u.chars, 0) AS usedChars,
                      COALESCE(u.tokens, 0) AS usedTokens
                 FROM devices d
                 LEFT JOIN device_usage u ON u.device_id = d.id AND u.day = ?
                ORDER BY d.created_at DESC LIMIT 200`,
            )
            .all(localDay(now().getTime())) as Array<Record<string, unknown>>;
          json(res, 200, { devices: rows, day: localDay(now().getTime()) });
          return;
        }
        if (method !== 'POST') {
          json(res, 405, { error: 'method', message: `${method} /api/devices` });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { name?: unknown; dotId?: unknown };
        const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : '';
        if (name.length === 0) {
          json(res, 400, { error: 'schema', message: 'name 不能为空' });
          return;
        }
        const dotId = typeof b.dotId === 'string' && b.dotId.length > 0 ? b.dotId : DEFAULT_DOT_ID;
        const id = `dev_${randomBytes(8).toString('hex')}`;
        const token = `dt_${randomBytes(32).toString('hex')}`;
        deps.db
          .prepare(
            'INSERT INTO devices (id, dot_id, name, token_hash, status, created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(id, dotId, name, hashDeviceToken(token), 'active', now().getTime());
        // 明文 token 只在这里出现一次；之后只能吊销重建。
        json(res, 201, { id, name, dotId, token, status: 'active' });
        return;
      }

      case 'device_by_id': {
        const id = match.params.id!;
        const r = deps.db
          .prepare("UPDATE devices SET status='revoked' WHERE id = ? AND status='active'")
          .run(id);
        if (r.changes === 0) {
          json(res, 404, { error: 'not_found', message: `设备 ${id} 不存在或已吊销` });
          return;
        }
        // 吊销后同一 token 立即失效：findDeviceByToken 只认 status='active'。
        json(res, 200, { ok: true, id, status: 'revoked' });
        return;
      }

      case 'device_rotate': {
        const id = match.params.id!;
        const token = `dt_${randomBytes(32).toString('hex')}`;
        const r = deps.db
          .prepare("UPDATE devices SET token_hash = ? WHERE id = ? AND status = 'active'")
          .run(hashDeviceToken(token), id);
        if (r.changes === 0) {
          json(res, 404, { error: 'not_found', message: `设备 ${id} 不存在或已吊销` });
          return;
        }
        json(res, 200, { ok: true, id, token, message: '旧令牌立即失效，把新令牌更新到设备/Charlie 配置' });
        return;
      }

      case 'device_turn': {
        const d = device!;
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { text?: unknown; threadId?: unknown };
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (text.length === 0) {
          json(res, 400, { error: 'schema', message: 'text 不能为空' });
          return;
        }

        // 阶段 3：一台设备同一时刻只允许 1 个语音任务（说话不能排在批量任务后面，
        // 也不能自己和自己抢上下文）。要并发请用另一台设备。
        const inflight = deps.db
          .prepare(
            `SELECT t.id AS id FROM tasks t
               JOIN mem_threads th ON th.id = t.thread_id
              WHERE th.channel = 'voice' AND th.external_ref = ?
                AND t.status IN ('queued','running','awaiting_approval','paused')
              LIMIT 1`,
          )
          .get(d.id) as { id: string } | undefined;
        if (inflight !== undefined) {
          json(res, 409, {
            error: 'device_busy',
            message: `这台设备还有一个任务没结束（${inflight.id}）；等它说完再来`,
            taskId: inflight.id,
          });
          return;
        }

        // 配额：0 = 不限额（显式关闭）。计数按本地日期，跨天自动换行。
        const day = localDay(now().getTime());
        const quota = deps.db
          .prepare('SELECT daily_tasks AS tasks, daily_chars AS chars, daily_tokens AS tokens FROM devices WHERE id = ?')
          .get(d.id) as { tasks: number; chars: number; tokens: number } | undefined;
        const used = deps.db
          .prepare('SELECT tasks, chars, tokens FROM device_usage WHERE device_id = ? AND day = ?')
          .get(d.id, day) as { tasks: number; chars: number; tokens: number } | undefined;
        const usedTasks = used?.tasks ?? 0;
        const usedChars = used?.chars ?? 0;
        const usedTokens = used?.tokens ?? 0;
        if (quota !== undefined && quota.tasks > 0 && usedTasks >= quota.tasks) {
          json(res, 429, {
            error: 'device_quota',
            message: `今天这台设备的任务额度用完了（${usedTasks}/${quota.tasks}）；明天再来`,
            kind: 'tasks',
            used: usedTasks,
            limit: quota.tasks,
          });
          return;
        }
        if (quota !== undefined && quota.tokens > 0 && usedTokens >= quota.tokens) {
          // token 是上一天/前几轮累计的，提交时就拒绝——不能让一整天的话都在
          // 任务跑到模型才发现超支（那时已经花掉了）。
          json(res, 429, {
            error: 'device_quota',
            message: `今天这台设备的 token 额度用完了（${usedTokens}/${quota.tokens}）；明天再来`,
            kind: 'tokens',
            used: usedTokens,
            limit: quota.tokens,
          });
          return;
        }
        if (quota !== undefined && quota.chars > 0 && usedChars + text.length > quota.chars) {
          json(res, 429, {
            error: 'device_quota',
            message: `今天这台设备的字数额度用完了（${usedChars}/${quota.chars}）；明天再来`,
            kind: 'chars',
            used: usedChars,
            limit: quota.chars,
          });
          return;
        }

        const requested = typeof b.threadId === 'string' && b.threadId.length > 0 ? b.threadId : null;
        let threadId: string;
        if (requested !== null) {
          const row = deps.db
            .prepare('SELECT channel, external_ref AS externalRef FROM mem_threads WHERE id = ?')
            .get(requested) as { channel: string; externalRef: string | null } | undefined;
          if (row === undefined || row.channel !== 'voice' || row.externalRef !== d.id) {
            json(res, 404, { error: 'not_found', message: `会话不属于该设备：${requested}` });
            return;
          }
          threadId = requested;
        } else {
          // external_ref = device_id 的 partial UNIQUE 让同一设备复用同一条 voice 会话：
          // 语音是连续对话，不该每句话开一个新 thread。
          threadId = await deps.mem.openThread(d.dotId, 'voice', { externalRef: d.id, title: d.name });
        }
        await deps.mem.appendMessage(threadId, { role: 'user', kind: 'text', content: text });
        const task: Task = deps.cp.submit({
          title: text.slice(0, 60),
          goal: text,
          priority: 1,
          dotId: d.dotId,
          threadId,
        });
        deps.db
          .prepare(
            `INSERT INTO device_usage (device_id, day, tasks, chars, updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(device_id, day) DO UPDATE SET
               tasks = tasks + 1,
               chars = chars + excluded.chars,
               updated_at = excluded.updated_at`,
          )
          .run(d.id, day, 1, text.length, now().getTime());
        json(res, 202, { taskId: task.id, threadId, status: task.status, deviceId: d.id });
        return;
      }

      case 'device_task': {
        const d = device!;
        const id = match.params.id!;
        const task = deps.cp.getTask(id);
        if (task === null || task.threadId === null) {
          json(res, 404, { error: 'not_found', message: `任务 ${id} 不存在` });
          return;
        }
        const owner = deps.db
          .prepare('SELECT external_ref AS externalRef FROM mem_threads WHERE id = ?')
          .get(task.threadId) as { externalRef: string | null } | undefined;
        if (owner === undefined || owner.externalRef !== d.id) {
          // 不区分「不存在」和「不是你的」：别让设备枚举主人的任务 id。
          json(res, 404, { error: 'not_found', message: `任务 ${id} 不存在` });
          return;
        }
        const steps = deps.cp.getJournal(id);
        let resultSummary: string | null = null;
        try {
          const row = deps.db
            .prepare('SELECT summary FROM task_results WHERE task_id=?')
            .get(id) as { summary?: string } | undefined;
          resultSummary = typeof row?.summary === 'string' ? row.summary : null;
        } catch {
          resultSummary = null;
        }
        const summary = buildTaskSummary({
          task,
          steps,
          plan: null,
          resultSummary,
          now: now().getTime(),
        });
        // 语音端要的是"能直接播报的一句话"：取本任务最后一条 assistant 正文。
        // 不跨任务取（thread 会复用），否则上一轮的答复会被当成本轮结果念出来。
        let reply: string | null = null;
        try {
          const row = deps.db
            .prepare(
              `SELECT content FROM mem_messages
                WHERE task_id = ? AND role = 'assistant' AND kind = 'text'
                ORDER BY seq DESC LIMIT 1`,
            )
            .get(id) as { content?: string } | undefined;
          reply = typeof row?.content === 'string' && row.content.length > 0 ? row.content : null;
        } catch {
          reply = null;
        }
        json(res, 200, {
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            attempt: task.attempt,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          summary,
          reply,
        });
        return;
      }

      case 'device_stream': {
        const d = device!;
        const taskId = url.searchParams.get('task');
        if (taskId === null || taskId.length === 0) {
          json(res, 400, { error: 'schema', message: '缺少 task 参数' });
          return;
        }
        const task = deps.cp.getTask(taskId);
        if (task === null || task.threadId === null) {
          json(res, 404, { error: 'not_found', message: `任务 ${taskId} 不存在` });
          return;
        }
        const owner = deps.db
          .prepare('SELECT external_ref AS externalRef FROM mem_threads WHERE id = ?')
          .get(task.threadId) as { externalRef: string | null } | undefined;
        if (owner === undefined || owner.externalRef !== d.id) {
          json(res, 404, { error: 'not_found', message: `任务 ${taskId} 不存在` });
          return;
        }
        await handleStream(req, res, url, {
          taskId,
          dotId: d.dotId,
          deviceId: d.id,
          channels: ['chat', 'approval', 'step'],
        });
        return;
      }

      case 'device_events': {
        const d = device!;
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { kind?: unknown; detail?: unknown };
        const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
        if (!/^[a-z][a-z0-9._-]{0,40}$/.test(kind)) {
          json(res, 400, { error: 'schema', message: 'kind 必须是 [a-z][a-z0-9._-]{0,40}' });
          return;
        }
        const detail =
          typeof b.detail === 'string' ? b.detail.replace(/\s+/g, ' ').trim().slice(0, 500) : null;
        const at = now().getTime();
        const r = deps.db
          .prepare('INSERT INTO voice_events (dot_id, device_id, kind, detail, at) VALUES (?,?,?,?,?)')
          .run(d.dotId, d.id, kind, detail, at);
        try {
          deps.db
            .prepare(
              `INSERT INTO audit_log (ts, dot_id, actor, channel, action, tier, tool, decision, reason)
               VALUES (datetime('now'), ?, 'agent', 'system', 'voice_reflex', 'read', ?, 'executed', ?)`,
            )
            .run(d.dotId, kind, detail);
        } catch {
          // 审计失败不能把记账吞掉；voice_events 已落库。
        }
        json(res, 201, { ok: true, id: Number(r.lastInsertRowid), at });
        return;
      }

      case 'device_approval': {
        // 语音设备不能代替主人点同意：这是合并方案里写死的一条边界。
        const d = device!;
        const raw = match.params.id!;
        const n = Number(raw);
        try {
          deps.db
            .prepare(
              `INSERT INTO audit_log (ts, dot_id, actor, channel, action, tier, tool, decision, reason)
               VALUES (datetime('now'), ?, 'agent', 'system', 'device_approval_denied', 'dangerous', 'approval', 'denied', ?)`,
            )
            .run(d.dotId, `设备 ${d.id} 尝试批准 #${Number.isFinite(n) ? n : '?'}；已拒绝`);
        } catch {
          /* 审计尽力而为，拒绝本身不能因此放过 */
        }
        json(res, 403, {
          error: 'device_approval_forbidden',
          message: '危险动作需要主人在手机/Web 批准；语音设备不能代替你点同意',
          approvalId: raw,
        });
        return;
      }

      /**
       * 阶段 5（2026-10-24）：单一记忆源。
       *
       * GET /api/device/memory?limit=&before=
       *   设备读自己的一整份记忆：voice thread 的消息 + 偏好。
       *   消息本来就在 dotd（/api/device/turn 写入），这里只是把它交回 Charlie，
       *   让 Charlie 的 conversation_history.json 降级成缓存而不是第二个事实源。
       */
      case 'device_memory': {
        const d = device!;
        const limitRaw = Number(url.searchParams.get('limit') ?? '50');
        if (!Number.isFinite(limitRaw) || limitRaw <= 0 || limitRaw > 200) {
          json(res, 400, { error: 'schema', message: 'limit 必须是 1..200 的整数' });
          return;
        }
        const beforeRaw = url.searchParams.get('before');
        const beforeSeq = beforeRaw === null ? undefined : Number(beforeRaw);
        if (beforeSeq !== undefined && (!Number.isFinite(beforeSeq) || beforeSeq < 0)) {
          json(res, 400, { error: 'schema', message: 'before 必须是非负整数（消息 seq）' });
          return;
        }
        const snap = await snapshotDeviceMemory(deps.db, deps.mem, d.id, {
          limit: Math.floor(limitRaw),
          beforeSeq,
        });
        json(res, 200, snap);
        return;
      }

      /**
       * POST /api/device/memory/turn {userText, reply, dedupeKey?}
       *
       * 反射/本地场景的回复不经过 dotd 的任务管线，过去只留在 Charlie 的本地
       * history 里，Web 端看不见。设备把整轮补写回来，dotd 才是唯一历史。
       * `dedupeKey` 由调用方给（例如 session + 时间戳），重试不会写两遍。
       */
      case 'device_memory_turn': {
        const d = device!;
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { userText?: unknown; reply?: unknown; dedupeKey?: unknown };
        const userText = typeof b.userText === 'string' ? b.userText.trim() : '';
        const reply = typeof b.reply === 'string' ? b.reply.trim() : '';
        if (userText === '' && reply === '') {
          json(res, 400, { error: 'schema', message: 'userText 与 reply 至少有一个非空' });
          return;
        }
        if (userText.length > 4000 || reply.length > 8000) {
          json(res, 413, { error: 'too_large', message: '单轮正文超限（userText ≤4000 / reply ≤8000）' });
          return;
        }
        const dedupeKey = typeof b.dedupeKey === 'string' ? b.dedupeKey.slice(0, 200) : undefined;
        const r = await mirrorDeviceTurn(deps.db, deps.mem, d, {
          userText,
          reply,
          dedupeKey,
          nowMs: now().getTime(),
        });
        json(res, r.duplicate === true ? 200 : 201, { ok: true, ...r });
        return;
      }

      /** PUT /api/device/prefs {key, value} —— 语音侧偏好写进 dotd。 */
      case 'device_prefs': {
        const d = device!;
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { key?: unknown; value?: unknown };
        const key = typeof b.key === 'string' ? b.key.trim() : '';
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
          json(res, 400, { error: 'schema', message: 'key 必须是 [A-Za-z0-9._-]{1,64}' });
          return;
        }
        if (typeof b.value !== 'string' || b.value.length > 2000) {
          json(res, 400, { error: 'schema', message: 'value 必须是不超过 2000 字的字符串' });
          return;
        }
        const pref = setDevicePref(deps.db, d.id, key, b.value, now().getTime());
        json(res, 200, { ok: true, pref });
        return;
      }

      /** DELETE /api/device/prefs/:key */
      case 'device_pref_delete': {
        const d = device!;
        const key = match.params.key!;
        const removed = deleteDevicePref(deps.db, d.id, key);
        json(res, removed ? 200 : 404, removed ? { ok: true, key } : { error: 'not_found', key });
        return;
      }

      /**
       * POST /api/device/proactive/decide {kind, text}
       *
       * 唯一决策入口：Charlie 想问「这句主动话该不该说」，dotd 用同一套三道闸
       * 回答。拒绝也是 200（调用方读 `allow`），不把「不许说」伪装成网络错误。
       */
      case 'device_proactive_decide': {
        const d = device!;
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { kind?: unknown; text?: unknown };
        const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
        if (!/^[a-z][a-z0-9._-]{0,40}$/.test(kind)) {
          json(res, 400, { error: 'schema', message: 'kind 必须是 [a-z][a-z0-9._-]{0,40}' });
          return;
        }
        const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : '';
        const nowMs = now().getTime();
        const decision = decideDevicePush(
          deps.db,
          d.id,
          kind,
          text,
          nowMs,
          localDay(nowMs),
          voicePushPolicy(),
        );
        json(res, 200, { ...decision, kind, at: nowMs });
        return;
      }

      /**
       * GET /api/memory/prefs?device=&push=1 —— 主人面（master）。
       *
       * 不传 device 时按设备列一遍；`push=1` 附带最近决策日志。
       * 这是「语音里说过的，Web 里记得」的可验证出口：同一张 device_prefs 表。
       */
      case 'memory_prefs': {
        const only = url.searchParams.get('device');
        const withPush = url.searchParams.get('push') === '1';
        const rows =
          only === null
            ? (deps.db
                .prepare(
                  `SELECT id, name, dot_id AS dotId FROM devices
                    WHERE status = 'active' ORDER BY created_at ASC`,
                )
                .all() as Array<{ id: string; name: string; dotId: string }>)
            : (deps.db
                .prepare(
                  `SELECT id, name, dot_id AS dotId FROM devices
                    WHERE id = ? AND status = 'active'`,
                )
                .all(only) as Array<{ id: string; name: string; dotId: string }>);
        if (only !== null && rows.length === 0) {
          json(res, 404, { error: 'not_found', message: `设备 ${only} 不存在或已吊销` });
          return;
        }
        const devices = rows.map((r) => ({
          deviceId: r.id,
          name: r.name,
          dotId: r.dotId,
          prefs: listDevicePrefs(deps.db, r.id),
          ...(withPush ? { pushLog: listDevicePushLog(deps.db, r.id, 50) } : {}),
        }));
        json(res, 200, { devices });
        return;
      }

      /**
       * GET /api/tasks/:id/proof —— 执行凭证（2026-10-23）。
       *
       * 只读投影。`?args=1` 才带明文参数预览（默认只给 hash），避免把 token / 邮件正文
       * 意外写进别人会看的文件。
       */
      case 'task_proof': {
        const provider = deps.proof;
        if (provider === undefined) {
          json(res, 503, { error: 'proof', message: 'daemon 没装配执行凭证投影（proofOf 未传）' });
          return;
        }
        const id = match.params.id!;
        try {
          const bundle = provider(id, { includeArgs: url.searchParams.get('args') === '1' });
          if (bundle === null) {
            json(res, 404, { error: 'not_found', taskId: id, message: `任务 ${id} 不存在` });
            return;
          }
          json(res, 200, bundle);
        } catch (cause) {
          json(res, 500, { error: 'proof', message: `生成执行凭证失败：${String(cause)}` });
        }
        return;
      }

      /**
       * P1-6 `GET /api/logs` —— 入站拒绝审计（`surf_ingress_rejects` 的属主端点）。
       *
       * 此前 CLI 的 `dotd logs` 只能拿 `/api/guard` 凑一个近似值并附带
       * "读路径待补"的说明——那是"承诺有了、路没通"。这里把路补上：
       * 直接读 SF 自己的拒绝审计表（`auth/origin/rate/schema/size/allowlist/parse`）。
       */
      /** GET /api/outbound?limit=20&kind=task_reply —— 出站审计。 */
      case 'outbound': {
        const limitRaw = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 20;
        const kind = url.searchParams.get('kind') ?? undefined;
        const items = listOutbound(deps.db, {
          limit,
          ...(kind === undefined || kind.length === 0 ? {} : { kind }),
        });
        json(res, 200, {
          ok: true,
          count: items.length,
          items: items.map((x) => ({ ...x, at: x.at })),
        });
        return;
      }

      /**
       * GET  /api/container               容器状态（state/recreate_count/最近健康）
       * POST /api/container/reset         重置为 ready 并清零 recreate_count
       *
       * 为什么需要重置入口：recreate_count > 3/24h 会触发 quarantined（§4.1 保护），
       * 但隔离后**所有依赖容器的任务都失败**，而报错是"模型说容器有问题"——
       * 主人和排查者都不容易联想到这是主动保护。2026-10-19 实测：一天内为重建镜像
       * 反复 recreate 7 次，直接把自己锁死。
       */
      case 'container': {
        const row = deps.db
          .prepare('SELECT dot_id, state, docker_container_id, recreate_count, last_health_at, updated_at FROM containers WHERE dot_id = ?')
          .get(DEFAULT_DOT_ID) as Record<string, unknown> | undefined;
        if (row === undefined) {
          json(res, 404, { ok: false, error: '没有该 dot 的容器记录（可能还没 boot 过）' });
          return;
        }
        if (match.params.action !== 'reset') {
          json(res, 200, {
            ok: true,
            container: {
              dotId: row['dot_id'],
              state: row['state'],
              dockerId: row['docker_container_id'],
              recreateCount: row['recreate_count'],
              lastHealthAt: row['last_health_at'],
              updatedAt: row['updated_at'],
              hint:
                row['state'] === 'quarantined'
                  ? '容器被隔离（24h 内重建超过 3 次）。确认容器本身正常后，POST /api/container/reset 重置。'
                  : undefined,
            },
          });
          return;
        }
        deps.db
          .prepare('UPDATE containers SET state = ?, recreate_count = 0, updated_at = ? WHERE dot_id = ?')
          .run('ready', now().toISOString(), DEFAULT_DOT_ID);
        json(res, 200, { ok: true, reset: true, note: '已重置为 ready 并清零 recreate_count' });
        return;
      }

      /**
       * GET  /api/schedules        列出定时任务（?all=1 含已停用）
       * POST /api/schedules        创建 {title, prompt, cron, quietHours?, catchup?}
       */
      case 'schedules': {
        if (method === 'GET') {
          const all = url.searchParams.get('all') === '1';
          const rows = listSchedules(deps.db, { includeDisabled: all });
          json(res, 200, {
            schedules: rows.map((x) => ({ ...x, nextFireAt: new Date(x.nextFireAt).toISOString() })),
            count: rows.length,
          });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as Record<string, unknown>;
        const r = createSchedule(
          deps.db,
          {
            title: typeof b['title'] === 'string' ? b['title'] : '',
            prompt: typeof b['prompt'] === 'string' ? b['prompt'] : '',
            cron: typeof b['cron'] === 'string' ? b['cron'] : '',
            ...(typeof b['quietHours'] === 'string' ? { quietHours: b['quietHours'] } : {}),
            ...(b['catchup'] === 'skip' || b['catchup'] === 'latest' ? { catchup: b['catchup'] } : {}),
            ...(typeof b['dotId'] === 'string' ? { dotId: b['dotId'] } : {}),
          },
          (cron, from) => CronExpressionParser.parse(cron, { currentDate: new Date(from) }).next().getTime(),
        );
        if (!r.ok) {
          json(res, 400, { ok: false, error: r.error });
          return;
        }
        json(res, 201, {
          ok: true,
          schedule: {
            ...r.schedule!,
            nextFireAt: new Date(r.schedule!.nextFireAt).toISOString(),
          },
        });
        return;
      }

      /** DELETE /api/schedules/:id —— 停用（不硬删）。 */
      case 'schedule_by_id': {
        const id = match.params.id ?? '';
        const r = removeSchedule(deps.db, decodeURIComponent(id));
        json(res, r.ok ? 200 : 404, r);
        return;
      }

      /**
       * GET /api/memory/archive —— 列出 .archive/ 里的备份（按时间倒序）。
       *
       * 为什么需要（2026-10-18）：fs.write 覆盖前自动把旧版本存进 .archive/，
       * 但恢复只能靠手动 `docker exec cp` —— 等于"有能力、没入口"。
       */
      case 'memory_archive': {
        if (deps.listMemoryArchive === undefined) {
          json(res, 501, { error: 'not_configured', message: '本实例未装配记忆归档查询' });
          return;
        }
        const pathFilter = url.searchParams.get('path');
        const limitRaw = url.searchParams.get('limit');
        let limit = 50;
        if (limitRaw !== null) {
          const n = Number(limitRaw);
          if (!Number.isInteger(n) || n < 1 || n > 500) {
            json(res, 400, { error: 'bad_limit', message: 'limit 必须是 1..500 的整数' });
            return;
          }
          limit = n;
        }
        const all = await deps.listMemoryArchive();
        const items = all
          .filter((x) => pathFilter === null || x.originalPath === pathFilter)
          .slice(0, limit);
        // 配额可见性（2026-10-18）：.archive/ 有 32MB 硬上限 + FIFO 修剪，
        // 但如果没人知道"快满了"，会直到某天发现老备份被悄悄删掉。
        // 这里把总量/占比算出来；达到 80% 给 warning。数字全部来自已列出的条目，不额外 IO。
        const totalBytes = all.reduce((s, x) => s + x.sizeBytes, 0);
        const quotaBytes = LIMIT_ARCHIVE_BYTES.hard;
        const usedPct = quotaBytes === 0 ? 0 : Math.round((totalBytes / quotaBytes) * 1000) / 10;
        json(res, 200, {
          items,
          filter: pathFilter,
          limit,
          total: all.length,
          totalBytes,
          quotaBytes,
          usedPct,
          ...(usedPct >= 80
            ? {
                warning:
                  `备份已占用 ${usedPct}%（${totalBytes}/${quotaBytes} 字节），接近上限后会按时间先后删除最旧的备份。` +
                  `如需保留某份，请先把它另存到 notes/ 或取回本地。`,
              }
            : {}),
        });
        return;
      }

      /**
       * POST /api/memory/restore —— 把某个归档版本写回原文件（覆盖前同样会归档当前版本）。
       * body: { archive: ".archive/<文件名>" | "<文件名>" }
       */
      case 'memory_restore': {
        if (deps.restoreMemoryArchive === undefined) {
          json(res, 501, { error: 'not_configured', message: '本实例未装配记忆恢复' });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const want = (body as { archive?: unknown }).archive;
        if (typeof want !== 'string' || want.trim().length === 0) {
          json(res, 400, { error: 'schema', message: '需要 archive（.archive/ 里的文件名）' });
          return;
        }
        const r = await deps.restoreMemoryArchive(want.trim());
        json(res, r.ok ? 200 : 400, r);
        return;
      }

      // M3（2026-10-23）：人格文件。GET 读原文，PUT 覆盖写（≤1 KB）。
      // 写入走 MemoryPort.writeIdentity → homeWriter（工具层 fs.write），
      // 与记忆骨架同一条通道；HTTP 层不直接碰文件系统。
      case 'memory_identity': {
        const dotId = deps.dotId ?? DEFAULT_DOT_ID;
        if (method === 'GET') {
          const read = deps.mem.readIdentity;
          if (read === undefined) {
            json(res, 501, { error: 'not_configured', message: '本实例未装配人格文件读取' });
            return;
          }
          try {
            const text = await read.call(deps.mem, dotId);
            json(res, 200, {
              path: HOME_IDENTITY,
              text: text ?? '',
              exists: text !== null,
              limitBytes: LIMIT_IDENTITY_MD.hard,
            });
          } catch (cause) {
            json(res, 500, { error: 'identity', message: `读人格文件失败：${String(cause)}` });
          }
          return;
        }
        const write = deps.mem.writeIdentity;
        if (write === undefined) {
          json(res, 501, { error: 'not_configured', message: '本实例未装配人格文件写入' });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const text = (body as { text?: unknown }).text;
        if (typeof text !== 'string') {
          json(res, 400, { error: 'schema', message: '需要 text（字符串）' });
          return;
        }
        const r = await write.call(deps.mem, dotId, text);
        json(res, r.ok ? 200 : 400, {
          ...r,
          path: HOME_IDENTITY,
          limitBytes: LIMIT_IDENTITY_MD.hard,
        });
        return;
      }

      // M4（2026-10-24）：旧助手记忆导入。正文 → `notes/YYYY-MM-DD-import-<source>.md`。
      // 只落事实，不自动改 MEMORY.md；16 KB 上限（超了 413，让主人拆分）。
      case 'memory_import': {
        const write = deps.mem.writeNote;
        if (write === undefined) {
          json(res, 501, { error: 'not_configured', message: '本实例未装配记忆导入' });
          return;
        }
        const body = await readJson(req, res);
        if (body === null) return;
        const text = (body as { text?: unknown }).text;
        const source = (body as { source?: unknown }).source;
        if (typeof text !== 'string' || text.trim().length === 0) {
          json(res, 400, { error: 'schema', message: '需要 text（旧助手整理的快照正文）' });
          return;
        }
        const src = typeof source === 'string' && source.trim().length > 0 ? source : 'unknown';
        const built = buildImportNote({ text, source: src, now: new Date() });
        if (!built.ok) {
          json(res, built.error === 'TOO_LARGE' ? 413 : 400, {
            error: built.error,
            message: built.message,
            limitBytes: MAX_IMPORT_BYTES,
          });
          return;
        }
        const dotId = deps.dotId ?? DEFAULT_DOT_ID;
        const r = await write.call(deps.mem, dotId, built.path, built.content);
        json(res, r.ok ? 201 : 400, {
          ...r,
          path: built.path,
          bytes: built.bytes,
          limitBytes: MAX_IMPORT_BYTES,
          note: r.ok ? '导入的是原始快照，整理 MEMORY.md 请投一次正常任务' : undefined,
        });
        return;
      }

      case 'logs': {
        const limitRaw = url.searchParams.get('limit');
        let limit = 50;
        if (limitRaw !== null) {
          const n = Number(limitRaw);
          if (!Number.isInteger(n) || n < 1 || n > 500) {
            json(res, 400, { error: 'bad_limit', message: 'limit 必须是 1..500 的整数' });
            return;
          }
          limit = n;
        }
        const rows = deps.db
          .prepare(
            `SELECT id, at, source, actor, reason, detail
               FROM surf_ingress_rejects ORDER BY id DESC LIMIT ?`,
          )
          .all(limit) as unknown as Array<{
          id: number;
          at: string;
          source: string;
          actor: string | null;
          reason: string;
          detail: string | null;
        }>;
        json(res, 200, { rejects: rows, limit });
        return;
      }

      case 'breaker': {
        json(res, 200, { snapshot: deps.router.snapshot() });
        return;
      }

      case 'models_rank': {
        const snap = deps.router.snapshot();
        const rank = snap.endpoints
          .map((e) => ({
            id: e.id,
            tier: e.tier,
            emergencyEligible: e.emergencyEligible,
            roles: Object.fromEntries(
              (Object.keys(e.roles) as Array<'primary' | 'light'>).map((t) => [t, e.roles[t].breaker]),
            ),
          }))
          .sort((a, b) => a.tier - b.tier);
        json(res, 200, { mode: snap.mode, rank, pool: snap.pool, pendingRecon: snap.pendingRecon });
        return;
      }

      case 'channels': {
        // §5.7 求救自检：如实报每个通道的**当前**可用性 + 投递顺序 + 兜底文件 +
        // 最近 10 条 alert_dispatch 台账。台账是账本先行协议的落点，因此它说的
        // "实际投到哪了"比任何可用性猜测都硬。CLI `dotd sos-test` 与本端点共用。
        const ch = deps.channels;
        const available = {
          feishu: ch?.available('feishu') ?? false,
          telegram: ch?.available('telegram') ?? false,
          email: ch?.available('email') ?? false,
        };
        const route = deps.alertsRoute?.();
        const recent = deps.db
          .prepare(
            `SELECT signature, kind, mode, delivered_via AS deliveredVia,
                    channels_tried AS channelsTried, sent_at AS sentAt,
                    delivered_at AS deliveredAt, resolved_at AS resolvedAt
               FROM alert_dispatch ORDER BY id DESC LIMIT 10`,
          )
          .all() as unknown as Array<Record<string, unknown>>;
        json(res, 200, {
          available,
          order: route?.order ?? ['feishu', 'telegram', 'email', 'outbox'],
          outboxPath: route?.outboxPath ?? '~/.dotd/OUTBOX.md',
          recent,
        });
        return;
      }

      case 'stream': {
        await handleStream(req, res, url);
        return;
      }

      case 'hooks_admin': {
        const body = await readJson(req, res);
        if (body === null) return;
        // Q1（§12）：UI 写 hooks 推阶段二——阶段一返回 not_implemented 而不是假成功
        json(res, 501, { error: 'not_implemented', message: 'hooks 在线编辑属阶段二（surfaces.md Q1）' });
        return;
      }

      case 'heartbeat_admin': {
        const body = await readJson(req, res);
        if (body === null) return;
        const b = body as { op?: unknown; ctId?: unknown; dotId?: unknown; title?: unknown; prompt?: unknown; cron?: unknown; skipIfBusy?: unknown; quietHours?: unknown; catchup?: unknown; enabled?: unknown };
        const op = typeof b.op === 'string' ? b.op : '';
        try {
          if (op === 'add') {
            const row = hbAdmin.add({
              dotId: typeof b.dotId === 'string' ? b.dotId : DEFAULT_DOT_ID,
              title: typeof b.title === 'string' ? b.title : '未命名心跳',
              prompt: typeof b.prompt === 'string' ? b.prompt : '',
              cron: typeof b.cron === 'string' ? b.cron : '',
              skipIfBusy: b.skipIfBusy !== false,
              quietHours: typeof b.quietHours === 'string' ? b.quietHours : null,
              catchup: b.catchup === 'skip' ? 'skip' : 'latest',
            });
            json(res, 201, { ok: true, crontab: row });
            return;
          }
          if (op === 'remove' && typeof b.ctId === 'string') {
            json(res, 200, { ok: hbAdmin.remove(b.ctId), ctId: b.ctId });
            return;
          }
          if (op === 'set_enabled' && typeof b.ctId === 'string') {
            const row = hbAdmin.setEnabled(b.ctId, b.enabled === true);
            json(res, row === null ? 404 : 200, { ok: row !== null, crontab: row });
            return;
          }
          json(res, 200, { ok: true, crontabs: hbAdmin.list(typeof b.dotId === 'string' ? b.dotId : undefined) });
        } catch (cause) {
          json(res, 400, { error: 'heartbeat', message: String(cause) });
        }
        return;
      }

      default:
        json(res, 404, { error: 'not_found', message: `${method} ${pathname}` });
    }
  }

  /** 读并解析 JSON body（空 body → {}）。 */
  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    const buf = await readBody(req, res);
    if (buf === null) return null;
    if (buf.length === 0) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch (cause) {
      json(res, 400, { error: 'parse', message: `body 不是合法 JSON：${String(cause)}` });
      return null;
    }
  }

  /** §5.2 POST /hooks/:source：HMAC → ingest（202 {eventId}；dup 200 {eventId,dup:true}）。 */
  async function handleHookIngest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    source: string,
  ): Promise<void> {
    // 飞书事件订阅走专属通道：不用 X-Dotd-* HMAC（飞书没有该方案），改用
    // verification token（body 内）+ 可选 Encrypt Key AES。鉴权强度同密：
    // token 与出站 app_secret 同存 ~/.dotd/tokens.env。详见 feishu-inbound.ts。
    if (source === 'feishu') {
      const fbody = await readBody(req, res);
      if (fbody === null) return; // 413 已写
      let fparsed: unknown;
      try {
        fparsed = fbody.length === 0 ? {} : JSON.parse(fbody.toString('utf8'));
      } catch (cause) {
        ingress.rejects.record({ source: 'http', actor: 'feishu', reason: 'parse', detail: String(cause) });
        json(res, 400, { error: 'parse', message: `飞书回调 body 不是合法 JSON：${String(cause)}` });
        return;
      }
      const dec = maybeDecryptFeishuBody(fparsed, deps.cfg.feishu);
      if (!dec.ok) {
        ingress.rejects.record({ source: 'http', actor: 'feishu', reason: 'parse', detail: dec.detail });
        json(res, 400, { error: 'parse', message: dec.detail });
        return;
      }
      const out = await handleFeishuCallback(dec.body, {
        cp: deps.cp,
        mem: deps.mem,
        db: deps.db,
        bus: deps.bus,
        cfg: deps.cfg.feishu,
        dotId: DEFAULT_DOT_ID,
      });
      if ('error' in out.body) {
        ingress.rejects.record({
          source: 'http',
          actor: 'feishu',
          reason: out.body.error,
          detail: out.body.message,
        });
      }
      json(res, out.httpStatus, out.body);
      return;
    }
    const cfg: HookConfig | undefined = deps.cfg.hooks.find((h) => h.source === source);
    if (cfg === undefined) {
      ingress.rejects.record({ source: 'http', actor: `hook:${source}`, reason: 'auth', detail: `未登记的 hook source：${source}` });
      json(res, 401, { error: 'auth', message: `未登记的 hook source：${source}` });
      return;
    }
    const body = await readBody(req, res);
    if (body === null) return; // 413 已写

    const headerName = (n: string): string | undefined => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const v = verifyHmac(
      {
        secret: cfg.secret,
        timestamp: headerName('x-dotd-timestamp'),
        nonce: headerName('x-dotd-nonce'),
        signature: headerName('x-dotd-signature'),
        body,
        nowMs: now().getTime(),
      },
      (nonce) => nonces.has(nonce),
    );
    if (!v.ok) {
      ingress.rejects.record({
        source: 'http',
        actor: `hook:${source}`,
        reason: v.reason === 'timestamp' || v.reason === 'nonce' || v.reason === 'signature' ? 'auth' : 'auth',
        detail: `HMAC 校验失败：${v.reason}`,
      });
      json(res, 401, { error: 'auth', message: `HMAC 校验失败：${v.reason}` });
      return;
    }

    let parsed: unknown;
    try {
      parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch (cause) {
      ingress.rejects.record({ source: 'http', actor: `hook:${source}`, reason: 'parse', detail: String(cause) });
      json(res, 400, { error: 'parse', message: `body 不是合法 JSON：${String(cause)}` });
      return;
    }
    const dotId = url.searchParams.get('dot') ?? cfg.dotId;
    // dedup_key 唯一规则（契约 §4）：走 ingress.normalizeHook，不在这里另写一份
    // sha/ extId 提取逻辑（http.ts 与 ingress.ts 双实现是分叉源，已合一）。
    const norm = normalizeHook(source, parsed, deps.cfg.hooks, { actor: `hook:${cfg.source}` });
    if (!norm.ok) {
      ingress.rejects.record({ source: 'http', actor: `hook:${source}`, reason: norm.reason, detail: norm.detail });
      json(res, 401, { error: 'auth', message: norm.detail });
      return;
    }
    const raw: RawInbound = {
      source: 'http',
      dotId,
      payload: parsed,
      dedupKey: norm.hook.dedupKey,
      actor: `hook:${cfg.source}`,
    };
    const out = ingest(raw, {
      db: deps.db,
      bus: deps.bus,
      cp: deps.cp,
      rejects: ingress.rejects,
      rateLimiter: ingress.limiter,
      hooks: deps.cfg.hooks,
      allowedOrigins: deps.cfg.http.allowedOrigins,
      now,
    });
    if (out.status === 'rejected') {
      json(res, out.httpStatus, { error: out.reason, retryAfterMs: out.retryAfterMs });
      return;
    }
    // §5.2：202 {eventId}；dup 命中 200 {eventId, dup:true}（CP 返回旧行）
    json(res, out.httpStatus, { eventId: out.eventId, dup: out.dup });
  }

  /**
   * §4.5 GET /api/stream：SSE 长连接（bus_seq 游标 + 断线补档）。
   *
   * `override`（阶段 2，2026-10-23）：语音设备面不能自己挑 dot/channel ——
   * dotId 由设备 token 定死，taskId 必须来自 URL 且已校验归属。传了 override
   * 就忽略 query 里的 topics/dot/task，只保留 last-event-id 断点。
   */
  async function handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    override?: { taskId?: string; dotId?: string; deviceId?: string; channels?: readonly BusChannel[] },
  ): Promise<void> {
    if (deps.sse.subscriberCount() >= MAX_SSE_CONNECTIONS) {
      json(res, 503, { error: 'sse_limit', message: `SSE 连接上限 ${MAX_SSE_CONNECTIONS}（§2.2）` });
      return;
    }
    const parsed = parseStreamQuery(url.search, headerStr(req, 'last-event-id'));
    const topics = override?.channels ?? parsed.topics;
    const dotId = override?.dotId ?? parsed.dotId;
    const taskId = override?.taskId ?? parsed.taskId;
    const deviceId = override?.deviceId;
    const lastEventId = parsed.lastEventId;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-store：这条流里是任务内容/审批事件，中间代理（哪怕局域网里的缓存网关）
      // 不该留档；no-transform 防 gzip 代理把 SSE 帧攒着不发。
      'cache-control': 'no-cache, no-transform, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 立即刷一帧注释，让客户端/代理确认连接建立
    res.write(': ok\n\n');

    const sub = deps.sse.subscribe({ lastEventId, channels: topics, dotId, taskId, deviceId }, (frame) => {
      res.write(SseBus.formatFrame(frame));
      // chat.delta 高频：尽量即时下发（Node 的 socket 会自行合并写）
    });
    for (const f of sub.initial) res.write(SseBus.formatFrame(f));

    const keepAlive = setInterval(() => {
      res.write(`: ping ${now().toISOString()}\n\n`);
    }, 25_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      sub.unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  return server;
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// ── 暴露面告警的进程内去重 ────────────────────────────────────────────
//
// 同一次启动里 assertHttpConfig（配置自检）和 startHttpServer（真正 listen）都会看
// 一眼 bind。不去重就在日志里刷两遍同样的「⚠ 已暴露到局域网」，而日志噪音正是
// 让人后来直接跳过的东西。key = host:port，因此测试用不同端口天然不受影响。
const exposureWarned = new Set<string>();

function warnExposureOnce(key: string, message: string): void {
  if (exposureWarned.has(key)) return;
  exposureWarned.add(key);
  process.emitWarning(message);
}

/** 装配层入口：listen 到 cfg.http.host:port（契约 H2 默认 127.0.0.1:7788；F6 起可配置）。 */
export function startHttpServer(deps: HttpDeps): Promise<Server> {
  const server = createHttpServer(deps);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(deps.cfg.http.port, deps.cfg.http.host, () => {
      server.removeListener('error', reject);
      // F6：真正绑下去了，才算「暴露」成立 —— 非回环必须在这里说清楚，
      // 让主人/日志知道端口已不在本机命名空间内（详见文件头「暴露面」段）。
      const host = deps.cfg.http.host;
      if (!isLoopbackBindHost(host)) {
        warnExposureOnce(
          `listen:${host}:${deps.cfg.http.port}`,
          [
            `HTTP 已监听非回环地址 ${host}:${deps.cfg.http.port} —— 同一网络内的其他机器现在都能连这个端口。`,
            `  · 该端口用 ${DEFAULT_HTTP_HOST} 之外的地址暴露后，master token 就是局域网级别的凭据；`,
            `  · SSE 仍兼容 ?token=<master_token>，token 会进 URL（浏览器历史/代理日志/Referer），非回环下请优先用 Authorization 头；`,
            `  · 保险库写操作（vault add/rm）已改为仅回环对端可调用；`,
            `  · 若要收回：把 surfaces.http.host 改回 ${DEFAULT_HTTP_HOST} 并重启 daemon。`,
          ].join('\n'),
        );
      }
      resolvePromise(server);
    });
  });
}

/** 配置自检（daemon 启动时调用；fail-closed）。 */
export function assertHttpConfig(cfg: SurfacesConfig): void {
  if (cfg.http.port !== 7788) {
    // 不拒绝——允许测试/开发改端口，但给一条明确告警（契约 H2 的默认值）
    process.emitWarning(`HTTP 监听端口为 ${cfg.http.port}（契约 H2 默认 127.0.0.1:7788）`);
  }
  if (cfg.http.masterToken.length === 0) {
    throw new ConfigError('surfaces.http.master_token 为空（fail-closed）', null);
  }

  // ── F6：非回环监听的显式告警 + Origin 白名单不许「没写/通配」──────────────
  //
  // 为什么默认值必须是回环、而扩大它必须付出「额外写明」的代价：见 config.ts
  // DEFAULT_HTTP_HOST 的注释。这里守的是**非回环那一侧**的门槛。
  const loopback = isLoopbackBindHost(cfg.http.host);
  if (!loopback) {
    // ① Origin 白名单：空数组在 originAllowed 里 = 放行任何来源；含 `*` 是主人的
    //    通配意图。两者在回环下都无伤大雅（能连上的只有本机），在非回环下等于
    //    「扩面 + DNS rebinding 防护形同不存在」。fail-closed 拒启动，让主人补
    //    一行明确来源，而不是默默把 /api 摊给整个二层网络。
    if (originsAreLenient(cfg.http.allowedOrigins)) {
      throw new ConfigError(
        [
          `surfaces.http.host = ${cfg.http.host} 是非回环地址，但 allowed_origins 没写清（空或含 *）。`,
          '非回环监听必须显式列出要放行的来源，例如：',
          `  allowed_origins: ["http://${cfg.http.host}:${cfg.http.port}"]`,
          `（回环监听没有这个要求：把 host 改回 ${DEFAULT_HTTP_HOST} 即可照常启动。）`,
        ].join('\n'),
        null,
      );
    }
    // ② 白名单写了、但一条都不指向这个 bind 地址 ⇒ 浏览器打开控制台会全 403
    //    （Origin 是 http://<bind>:port，白名单里只有 localhost 时匹配不上）。
    //    不拒启动（主人可能就是要挡住浏览器、只留 CLI），但要告警：这是最容易
    //    被当成「鉴权坏了」去乱改 token 的场景，先把真相写在日志里。
    const covers = cfg.http.allowedOrigins.some((o) => originHostMatches(o, cfg.http.host));
    if (!covers) {
      // 同 host:port 只说一次：这不是错误，刷两遍只会让人整段跳过。
      warnExposureOnce(
        `origins:${cfg.http.host}:${cfg.http.port}`,
        [
          `HTTP 监听非回环 ${cfg.http.host}:${cfg.http.port}，但 allowed_origins 里没有一条指向它：`,
          `  已配置 ${JSON.stringify(cfg.http.allowedOrigins)}`,
          `  浏览器按 http://${cfg.http.host}:${cfg.http.port} 访问时 Origin 匹配不上，/api 会全部 403。`,
          '  要网页可用，请把它加进 allowed_origins；只要 CLI/API 可用则忽略本条。',
        ].join('\n'),
      );
    }
    warnExposureOnce(
      `assert:${cfg.http.host}:${cfg.http.port}`,
      `HTTP 配置为监听非回环地址 ${cfg.http.host}:${cfg.http.port}（默认 ${DEFAULT_HTTP_HOST}）：端口对整个局域网可达，` +
        '请确认这是主人的本意。风险与缓解见 src/surfaces/http.ts 文件头「暴露面」段。',
    );
  }
}

/** 来源 URL 的 host 是否就是监听地址（用于「白名单里有没有一条真的对得上」的判断）。 */
function originHostMatches(origin: string, bindHost: string): boolean {
  let hostname = '';
  try {
    hostname = new URL(origin.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  const b = bindHost.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (hostname === b) return true;
  // ::1 与 localhost / 127.0.0.1 之间互认（浏览器可能写其中任一种）
  if (isLoopbackBindHost(b) && isLoopbackBindHost(hostname)) return true;
  return false;
}