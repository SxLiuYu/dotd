/**
 * src/surfaces/http.ts —— HTTP 路由表 + 鉴权 + HMAC（surfaces.md §5.2；契约 H2/S-2/S-4）。
 *
 * 全 daemon **唯一监听** `127.0.0.1:7788`（契约 H2：CP 的 8642 作废，CP REST 子集由
 * 本路由器进程内转调 CP 函数）。鉴权/CORS/SSE/CLI base URL 四件事单点在此。
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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { EventBus } from '../shared/bus.ts';
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
import { LIMIT_ARCHIVE_BYTES } from '../memory/limits.ts';
import { createSchedule, listSchedules, removeSchedule } from '../control-plane/schedules.ts';
import { CronExpressionParser } from 'cron-parser';
import type { HookConfig, SurfacesConfig } from './types.ts';
import { createIngress, ingest, MAX_BODY_BYTES, normalizeHook, originAllowed } from './ingress.ts';
import { handleFeishuCallback, maybeDecryptFeishuBody } from './feishu-inbound.ts';
import { listOutbound } from './feishu-outbound.ts';
import { SseBus, parseStreamQuery } from './sse.ts';
import { createHeartbeatAdmin } from './heartbeat-tick.ts';
import { buildTaskView, type CallLogRow } from './task-view.ts';
import { PLAN_MARKER, plansFromMessages } from '../runner/plan.ts';
import { serveStatic } from './web.ts';
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
  | 'logs'
  | 'memory_archive'
  | 'memory_restore'
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

  // P1-6 可观测性：任务明细（CP getTask + getJournal 的投影，供 `dotd task <id>` 用）。
  // 细节查询参数走 query（`?verbose=1` 带每步耗时与 token 成本汇总）。
  mm = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (m === 'GET' && mm !== null) {
    return { route: 'task_by_id', params: { id: decodeURIComponent(mm[1]!) } };
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

// ── HTTP 服务 ────────────────────────────────────────────────────────

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
  now?(): Date;
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
    if (pathname.startsWith('/api/') && !originAllowed(req.headers, deps.cfg.http.allowedOrigins)) {
      ingress.rejects.record({ source: 'http', actor: null, reason: 'origin', detail: `Origin ${String(req.headers.origin ?? '')}` });
      json(res, 403, { error: 'origin', message: 'Origin/Referer 不在白名单' });
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

    // 鉴权（hooks/:source 走 HMAC，/api/stream 走 query token）
    if (match.route === 'hook_ingest') {
      await handleHookIngest(req, res, url, match.params.source!);
      return;
    }
    if (requiresMaster(match.route)) {
      const auth = authenticate(req.headers, deps.cfg.http, method);
      if (auth.error === 'missing' || auth.error === 'invalid') {
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
      const q = url.searchParams.get('token');
      if (q === null) {
        ingress.rejects.record({ source: 'http', actor: null, reason: 'auth', detail: 'stream 缺少 token 查询参数' });
        json(res, 401, { error: 'auth', message: 'SSE 订阅需 ?token=<master_token>' });
        return;
      }
      if (!safeEqualStr(q, deps.cfg.http.masterToken)) {
        ingress.rejects.record({ source: 'http', actor: null, reason: 'auth', detail: 'stream token 非法' });
        json(res, 401, { error: 'auth', message: '非法的 token 查询参数' });
        return;
      }
    }

    switch (match.route) {
      case 'health':
        json(res, 200, {
          ok: true,
          service: 'dotd',
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
        if (url.searchParams.get('verbose') === '1' || url.searchParams.get('verbose') === 'true') {
          // P2-2：带上"它打算怎么干"。计划存成该任务在 thread 里的 system 消息
          // （kind='text' + PLAN_MARKER，见 src/runner/plan.ts 文件头的选型理由），
          // 这里只读不写：取该任务最后一条计划即当前版本。
          const planMessages = deps.db
            .prepare(
              `SELECT role, kind, content FROM mem_messages
                WHERE task_id=? AND role='system' AND kind='text' AND content LIKE ?
                ORDER BY seq ASC`,
            )
            .all(id, `${PLAN_MARKER}%`) as Array<{ role: string; kind: string; content: string }>;
          const plan = plansFromMessages(
            planMessages.map((m, i) => ({
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
          json(res, 200, {
            ...base,
            view: buildTaskView({ task, steps, callLogs, now: now().getTime(), plan }),
          });
          return;
        }
        json(res, 200, base);
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

  /** §4.5 GET /api/stream：SSE 长连接（bus_seq 游标 + 断线补档）。 */
  async function handleStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (deps.sse.subscriberCount() >= MAX_SSE_CONNECTIONS) {
      json(res, 503, { error: 'sse_limit', message: `SSE 连接上限 ${MAX_SSE_CONNECTIONS}（§2.2）` });
      return;
    }
    const { topics, dotId, lastEventId } = parseStreamQuery(url.search, headerStr(req, 'last-event-id'));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 立即刷一帧注释，让客户端/代理确认连接建立
    res.write(': ok\n\n');

    const sub = deps.sse.subscribe({ lastEventId, channels: topics, dotId }, (frame) => {
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

/** 装配层入口：listen 到 cfg.http.host:port（契约 H2 唯一监听 127.0.0.1:7788）。 */
export function startHttpServer(deps: HttpDeps): Promise<Server> {
  const server = createHttpServer(deps);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(deps.cfg.http.port, deps.cfg.http.host, () => {
      server.removeListener('error', reject);
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
}
