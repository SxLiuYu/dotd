/**
 * web-ui/src/api.ts —— 与 dotd HTTP 面的最小客户端（surfaces.md §5.2 路由表）。
 *
 * 鉴权（http.ts:236-255）：除 /api/health、/api/status、/api/whoami、/api/stream
 * 外，全部路由要 `Authorization: Bearer <master_token>`；readonly token 只能 GET。
 * SSE（§4.5）：EventSource 不能带头 → token 走 `?token=`（明文妥协，契约原文）。
 *
 * 基址：默认相对当前页面 origin（daemon 与 UI 同源部署）；开发期可用
 * `VITE_DOTD_BASE`（如 http://127.0.0.1:7788）指向另跑的 daemon。
 * token：`localStorage.dotd_token`，登录页写入；无 token 时各视图显示提示而非静默 401。
 */

const BASE = (import.meta.env.VITE_DOTD_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

const TOKEN_KEY = 'dotd_token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式：仅本次会话有效 */
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    /* 非 JSON 响应：原样带出去 */
  }
  if (!res.ok) {
    const msg =
      typeof json === 'object' && json !== null && 'message' in json && typeof (json as { message: unknown }).message === 'string'
        ? (json as { message: string }).message
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, json, msg);
  }
  return json as T;
}

// ── 类型（与 http.ts 各 handler 的响应形状逐字段对齐） ─────────────────

export interface QueueRow {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'paused' | 'done' | 'failed' | 'cancelled';
  priority: number;
  dotId: string;
  updatedAt: number;
}

export interface ApprovalRow {
  id: number;
  seq: number;
  kind: string;
  tier: string | null;
  status: string;
  summary: string;
  fullParams: unknown;
  reason: string;
  riskBrief?: { verdict?: string; kind?: string; reason?: string; [k: string]: unknown };
  expiresAt: string;
  remindedAt?: string;
  taskRef: { taskId: string; eventId?: string; journalStepId: string };
  subject?: unknown;
}

export interface EventRow {
  id: number;
  source: string;
  dotId: string;
  actor: string | null;
  dedupKey: string;
  payload: string;
  status: string;
  receivedAt: number;
}

export interface EndpointRankRow {
  id: string;
  tier: number;
  emergencyEligible: boolean;
  roles: Record<string, string>;
}

export interface StatusBody {
  ok: boolean;
  service: string;
  dotId: string;
  at: string;
  busSeq: number;
  queue: { queued: number; running: number; awaitingApproval: number; paused: number };
  router: { mode: string; endpoints: number };
  approvalsPending: number;
}

export type Verdict = 'approve_once' | 'approve_remember' | 'reject';

// ── REST ──────────────────────────────────────────────────────────────

export const api = {
  status: () => request<StatusBody>('GET', '/api/status'),

  /** 不发消息也需要的队列快照（默认 queued,running；这里显式要全态，供队列视图过滤）。 */
  queue: (statuses: string) =>
    request<{ queue: QueueRow[] }>('GET', `/api/queue?status=${encodeURIComponent(statuses)}&limit=200`),

  cancelTask: (id: string) => request<{ ok: boolean; taskId: string }>('POST', `/api/queue/${encodeURIComponent(id)}/cancel`),

  approvals: () => request<{ approvals: ApprovalRow[] }>('GET', '/api/approvals?state=pending&limit=100'),

  decide: (id: number, verdict: Verdict, note?: string) =>
    request<{ ok: boolean; finalStatus: string; reason?: string }>('POST', `/api/approvals/${id}/decision`, {
      verdict,
      note,
      channel: 'web',
    }),

  events: (limit = 100, since?: number) => {
    const q = since === undefined ? `limit=${limit}` : `limit=${limit}&since=${since}`;
    return request<{ events: EventRow[]; since: string | null }>('GET', `/api/events?${q}`);
  },

  models: () =>
    request<{ mode: string; rank: EndpointRankRow[]; pool: unknown; pendingRecon: number }>('GET', '/api/models/rank'),

  breaker: () => request<{ snapshot: unknown }>('GET', '/api/breaker'),

  send: (text: string, dotId?: string) =>
    request<{ taskId: string; threadId: string; status: string }>('POST', '/api/messages', { text, dotId }),

  conversations: (threadId: string) =>
    request<{ threadId: string; messages: Array<{ seq: number; role: string; kind: string; content: string; createdAt: number }> }>(
      'GET',
      `/api/conversations?thread=${encodeURIComponent(threadId)}&limit=200`,
    ),
};

// ── SSE（§4.5：topics 过滤 + Last-Event-ID 重连 + resync 校正） ──────────

export interface SseFrame {
  seq: number;
  channel: string;
  event: string;
  data: unknown;
}

/** 一条 SSE 文本帧 → SseFrame；解析失败返回 null（心跳/注释行）。 */
export function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split('\n');
  let id: number | null = null;
  let event = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) id = Math.floor(n);
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data += (data.length > 0 ? '\n' : '') + line.slice(5).trim();
    }
  }
  if (id === null || event.length === 0) return null;
  let parsed: unknown = null;
  try {
    parsed = data.length > 0 ? (JSON.parse(data) as unknown) : null;
  } catch {
    parsed = data;
  }
  return { seq: id, channel: event, event, data: parsed };
}

export interface SseHandlers {
  onFrame: (frame: SseFrame) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * 订阅 `/api/stream`。游标（Last-Event-ID）由本函数内部维护：断线后浏览器原生
 * EventSource 会自动带该头重连（§4.5）；超出重放窗时服务端先发 resync 帧，
 * 调用方在 onFrame 收到 `event === 'resync'` 时应重拉 REST 快照校正。
 * 返回关闭函数。
 */
export function subscribeStream(topics: string[], handlers: SseHandlers): () => void {
  const token = getToken();
  const q = new URLSearchParams({ topics: topics.join(',') });
  if (token !== null) q.set('token', token);
  const url = `${BASE}/api/stream?${q.toString()}`;
  const es = new EventSource(url);
  es.onopen = () => handlers.onOpen?.();
  es.onerror = (e) => handlers.onError?.(e);
  for (const ch of topics) {
    es.addEventListener(ch, (ev) => {
      const me = ev as MessageEvent<string>;
      const frame = parseFrame(`id: ${me.lastEventId}\nevent: ${ch}\ndata: ${me.data ?? ''}`);
      if (frame !== null) handlers.onFrame(frame);
    });
  }
  return () => es.close();
}
