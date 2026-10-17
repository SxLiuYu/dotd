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
 * | POST /api/messages {text}                | cp.submit({title:text.slice(0,60),goal:text,priority:1}) |
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
import type { HookConfig, SurfacesConfig } from './types.ts';
import { createIngress, ingest, MAX_BODY_BYTES, normalizeHook, originAllowed } from './ingress.ts';
import { handleFeishuCallback, maybeDecryptFeishuBody } from './feishu-inbound.ts';
import { SseBus, parseStreamQuery } from './sse.ts';
import { createHeartbeatAdmin } from './heartbeat-tick.ts';
import { buildTaskView, type CallLogRow } from './task-view.ts';
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
  if (m === 'POST' && p === '/api/approvals/decision') {
    // 便捷别名（无 :id 时不合法，仍路由过去由 handler 报错）
    return { route: 'approval_decision', params: {} };
  }
  if (m === 'GET' && p === '/api/events') return { route: 'events', params: {} };
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

export interface HttpDeps {
  db: DatabaseSync;
  bus: EventBus;
  cp: ControlPlane;
  gov: GovernancePort;
  mem: MemoryPort;
  router: RouterPort;
  channels: NotificationChannels | null;
  sse: SseBus;
  cfg: SurfacesConfig;
  /**
   * §5.7 求救投递顺序与兜底文件（由装配层从 ModelRouter.alertsRoute() 取真值）。
   * 缺省 = 编译期默认顺序；`/api/channels` 与 `dotd sos-test` 靠它说话。
   */
  alertsRoute?: () => { order: readonly string[]; outboxPath: string };
  /** Web UI 静态根（绝对路径；缺省 repo 根 web-ui/dist）。 */
  webRoot?: string;
  now?(): Date;
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
        const threadId = await deps.mem.openThread(dotId, 'web');
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
          json(res, 200, { ...base, view: buildTaskView({ task, steps, callLogs, now: now().getTime() }) });
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
