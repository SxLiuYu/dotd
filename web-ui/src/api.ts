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

/**
 * 一套系统（2026-10-23）：dotd 控制台挂在 Charlie 的 `/console/` 下。
 * 同源 + 相对 base 构建，因此这里只需按路径前缀补 `/console`。
 * 该前缀下的请求由 Charlie 反代，并在服务端注入 master token；
 * 浏览器端不放真实 token（`getToken` 返回 sentinel）。
 */
const PROXIED_CONSOLE =
  typeof window !== 'undefined' && window.location.pathname.startsWith('/console');

const BASE =
  (import.meta.env.VITE_DOTD_BASE as string | undefined)?.replace(/\/$/, '') ??
  (PROXIED_CONSOLE ? '/console' : '');

const TOKEN_KEY = 'dotd_token';

export function getToken(): string | null {
  // /console 下由 Charlie 反代注入真实 token；这里给一个 sentinel，
  // 避免把 master token 写进浏览器存储。
  if (PROXIED_CONSOLE) return 'proxied';
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

/**
 * 活动总览的一行（GET /api/activity，2026-10-21 9.3 新增）。
 *
 * 与 QueueRow 的区别：QueueRow 说「在途的现在怎么样」，
 * ActivityRow 说「已经发生的事各自结果如何」—— 后者是主体。
 */
export interface ActivityRow {
  id: string;
  title: string;
  status: QueueRow['status'];
  priority: number;
  attempt: number;
  /** epoch 毫秒（服务端存字符串，这里按 number 用）。 */
  createdAt: string | number;
  updatedAt: string | number;
  stepCount: number;
  failedSteps: number;
}

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

/** 动态时间线的一条（GET /api/feed，M1 2026-10-23）。 */
export interface FeedItem {
  id: string;
  kind: 'task' | 'approval' | 'event' | 'schedule' | 'calendar' | 'system';
  at: number;
  title: string;
  body: string | null;
  attention: 'low' | 'normal' | 'high';
  taskId: string | null;
  approvalId: number | null;
  provenance: { source: string; ref: string; note?: string };
  action: { kind: string; label: string; goal?: string } | null;
}

/** 任务摘要（GET /api/tasks/:id 的 summary，M2 2026-10-23）。 */
export interface TaskSummary {
  state: string;
  stateLine: string;
  doing: string | null;
  elapsedMs: number | null;
  heartbeatAgeMs: number | null;
  stalled: boolean;
  next: string | null;
  needsOwner: boolean;
  progress: { done: number; total: number } | null;
}

export interface TaskBody {
  task: {
    id: string;
    title: string;
    status: string;
    priority: number;
    dotId: string;
    attempt: number;
    createdAt: number;
    updatedAt: number;
  };
  steps: unknown[];
  summary?: TaskSummary;
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

  /** 活动总览（「最近都干了什么」）。counts 是全库按状态分组，不受 limit 影响。 */
  activity: (limit = 30, status?: string) => {
    const q = status === undefined ? `limit=${limit}` : `limit=${limit}&status=${encodeURIComponent(status)}`;
    return request<{
      tasks: ActivityRow[];
      counts: Array<{ status: string; n: number }>;
      limit: number;
    }>('GET', `/api/activity?${q}`);
  },

  approvals: () => request<{ approvals: ApprovalRow[] }>('GET', '/api/approvals?state=pending&limit=100'),

  /** 动态时间线（只读投影：任务 / 审批 / 未识别事件 / 定时失败 / 今日日程）。 */
  feed: (limit = 100) => request<{ items: FeedItem[]; generatedAt: number }>('GET', `/api/feed?limit=${limit}`),

  /** 单任务 + 一行摘要（M2）。 */
  task: (id: string) => request<TaskBody>('GET', `/api/tasks/${encodeURIComponent(id)}`),

  /** 人格文件（M3）：GET 读，PUT 写（≤1 KB）。 */
  identity: () =>
    request<{ path: string; text: string; exists: boolean; limitBytes: number }>('GET', '/api/memory/identity'),
  saveIdentity: (text: string) =>
    request<{ ok: boolean; warning?: string; path: string; limitBytes: number }>('PUT', '/api/memory/identity', { text }),

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

  // 2026-10-22：必须能带 threadId。
  //
  // 现场：web 侧 1237 个 external_ref=NULL 的孤立线程，每个会话只有 1-2 条消息，
  // 于是"多轮对话接不上"——主人问"我刚才让你记的暗号"，模型看到的是空会话。
  // 根因就在这里：ChatView 把返回的 threadId 存进了 state，但 send() 从来没把它
  // 传回去，后端每轮都走 openThread 新建。
  // 服务端 http.ts 早已支持（带已知 threadId 就复用，未知则 404），缺的是客户端这一行。
  send: (text: string, opts: { dotId?: string; threadId?: string | null } = {}) =>
    request<{ taskId: string; threadId: string; status: string }>('POST', '/api/messages', {
      text,
      ...(opts.dotId !== undefined ? { dotId: opts.dotId } : {}),
      ...(typeof opts.threadId === 'string' && opts.threadId.length > 0
        ? { threadId: opts.threadId }
        : {}),
    }),

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
