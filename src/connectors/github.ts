/**
 * src/connectors/github.ts —— GitHub REST 连接器（第一批）。
 *
 * 覆盖三个只读端点：/notifications、/repos/:owner/:repo/issues、/repos/:owner/:repo/pulls。
 *
 * 设计纪律（与 mail/ 同款）：
 *   - **永不抛**：超时 / 网络错 / HTTP 错 / 坏 JSON 一律折叠成结构化 {ok:false,error} 返回；
 *   - 零运行时依赖：只用全局 fetch（Node 22+ 自带），不引任何 HTTP 库；
 *   - token 只从环境变量 DOTD_GITHUB_TOKEN（GITHUB_TOKEN_ENV）读，缺失时走未认证公开 API
 *     （限速 60 请求/h）；token 只进请求头，不进返回值、不进任何日志（本文件无 console）；
 *   - 每个带响应的返回都带 rateLeft（x-ratelimit-remaining），调用方据此决定要不要放缓；
 *   - 超时 15s（AbortSignal.timeout）；测试可经 opts.timeoutMs 收短。
 *
 * 特例：/notifications 是个人数据，未认证必然 401 —— 不浪费那次请求，无 token 直接返回
 * 结构化 no_token（issues/pulls 无此限制，未认证可查公开仓库）。
 */

import { GITHUB_TOKEN_ENV } from './registry.ts';

const GITHUB_API_BASE = 'https://api.github.com';

/** 生产默认超时。内部 15s < sync 工具档 60s（SPEC_BLOCK.md 有说明）。 */
export const GITHUB_TIMEOUT_MS = 15_000;

export interface GithubOpts {
  /** 超时毫秒数，缺省 15_000。测试打桩时收短。 */
  timeoutMs?: number;
  /** 页码（Link 头分页），缺省 1。 */
  page?: number;
  /** 每页条数，缺省 20，上限 100（GitHub 上限）。 */
  perPage?: number;
  /** API 基址；仅供测试/代理覆写，正常走官方 API。 */
  baseUrl?: string;
}

/** 统一返回形状：成功带 data + rateLeft（+分页），失败带 error，两边都不抛。 */
export interface GithubResult<T> {
  ok: boolean;
  /** 成功时的已整形数据。 */
  data?: T;
  /** 失败时的结构化原因，前缀即错误码：no_token / timeout / network / http_NNN / bad_json / bad_shape。 */
  error?: string;
  /** HTTP 状态码（拿到响应时才有）。 */
  status?: number;
  /** x-ratelimit-remaining（响应头里有时才有）。 */
  rateLeft?: number;
  /** Link 头解析出的下一页页码。 */
  nextPage?: number;
  /** Link 头解析出的上一页页码。 */
  prevPage?: number;
}

/** /notifications 条目（已整形：reason / subject.title / repo 必看字段拍平到顶层）。 */
export interface GithubNotification {
  id: string;
  /** 触发原因：mention / review_requested / comment 等（GitHub 原词）。 */
  reason: string;
  /** subject.title。 */
  title: string;
  /** subject.type：Issue / PullRequest / Release 等。 */
  subjectType: string;
  /** subject.url（API url，非 html url）。 */
  url: string;
  /** repository.full_name，如 "octo/hello"。 */
  repo: string;
  updatedAt: string;
  unread: boolean;
}

/** open issue 条目（已剥离混进 issues 端点的 PR，按 updated 倒序）。 */
export interface GithubIssue {
  number: number;
  title: string;
  /** html url。 */
  url: string;
  /** 作者 login。 */
  user: string;
  updatedAt: string;
  comments: number;
  /** 标签名列表（GitHub 的 labels 元素可能是对象或字符串，都收）。 */
  labels: string[];
}

/** open pull request 条目（按 updated 倒序）。 */
export interface GithubPull {
  number: number;
  title: string;
  url: string;
  user: string;
  updatedAt: string;
  draft: boolean;
}

// ── 原始载荷（只声明我们读的字段，unknown 起步，映射时逐个收窄）────────────

interface RawSubject {
  title?: unknown;
  type?: unknown;
  url?: unknown;
}
interface RawRepo {
  full_name?: unknown;
}
interface RawUser {
  login?: unknown;
}
interface RawNotification {
  id?: unknown;
  reason?: unknown;
  subject?: RawSubject;
  repository?: RawRepo;
  updated_at?: unknown;
  unread?: unknown;
}
interface RawIssue {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  user?: RawUser;
  updated_at?: unknown;
  comments?: unknown;
  labels?: unknown;
  /** 存在这个键 = 该条目其实是 PR（GitHub issues 端点会捎带 open PR）。 */
  pull_request?: unknown;
}
interface RawPull {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  user?: RawUser;
  updated_at?: unknown;
  draft?: unknown;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 当前是否配了 token（调用时读环境，不缓存 —— 测试与运行期热配友好）。 */
export function hasGithubToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env[GITHUB_TOKEN_ENV];
  return typeof token === 'string' && token.length > 0;
}

// ── 低层 GET ─────────────────────────────────────────────────────────

async function ghGet<T>(path: string, query: URLSearchParams, opts: GithubOpts): Promise<GithubResult<T>> {
  const base = opts.baseUrl ?? GITHUB_API_BASE;
  const url = `${base}${path}?${query.toString()}`;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const headers: Record<string, string> = {
    // GitHub 要求 UA；API 版本与 Accept 按官方 REST 建议
    accept: 'application/vnd.github+json',
    'user-agent': 'dotd-connector',
    'x-github-api-version': '2022-11-28',
  };
  const token = process.env[GITHUB_TOKEN_ENV];
  if (typeof token === 'string' && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: `timeout: GitHub 请求 ${timeoutMs}ms 超时（${msg}）` };
    }
    return { ok: false, error: `network: ${msg}` };
  }

  const rateLeft = rateLeftOf(res.headers);
  if (!res.ok) {
    // 带上响应体前 200 字符：GitHub 的错误信息（如 "Requires authentication"）就在里面
    const body = await res.text().catch(() => '');
    const snippet = body.length > 0 ? ` ${body.slice(0, 200)}` : '';
    return { ok: false, status: res.status, rateLeft, error: `http_${res.status}: ${res.statusText}${snippet}` };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: res.status, rateLeft, error: `bad_json: 响应不是合法 JSON（${msg}）` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, status: res.status, rateLeft, error: 'bad_shape: 期望 JSON 数组' };
  }
  return { ok: true, status: res.status, rateLeft, ...pagesOf(res.headers.get('link')), data: parsed as T };
}

function rateLeftOf(h: Headers): number | undefined {
  const v = h.get('x-ratelimit-remaining');
  if (v === null) return undefined;
  const num = Number(v);
  return Number.isFinite(num) ? num : undefined;
}

/** Link 头（RFC 5988）→ next/prev 页码。解析不了的字段静默跳过。 */
function pagesOf(link: string | null): { nextPage?: number; prevPage?: number } {
  const out: { nextPage?: number; prevPage?: number } = {};
  if (link === null) return out;
  for (const part of link.split(',')) {
    const m = /<([^>]*)>\s*;\s*rel\s*=\s*"?([a-z]+)"?/i.exec(part);
    if (m === null) continue;
    const page = Number(new URL(m[1]!, 'https://api.github.com').searchParams.get('page') ?? NaN);
    if (!Number.isFinite(page)) continue;
    if (m[2] === 'next') out.nextPage = page;
    else if (m[2] === 'prev') out.prevPage = page;
  }
  return out;
}

function pageQuery(opts: GithubOpts): URLSearchParams {
  const q = new URLSearchParams();
  const per = Math.min(Math.max(opts.perPage ?? 20, 1), 100);
  q.set('per_page', String(per));
  if (opts.page !== undefined && opts.page > 1) q.set('page', String(opts.page));
  return q;
}

/**
 * 把 ghGet 的失败结果重建成调用方期望的形状（错误分支不带 data，
 * 显式搬运 ok/error/status/rateLeft，免去对 data 泛型的不变型 cast）。
 */
function errorOf<T>(r: GithubResult<unknown>): GithubResult<T> {
  return { ok: false, error: r.error, status: r.status, rateLeft: r.rateLeft };
}

const enc = encodeURIComponent;

// ── 三个端点 ─────────────────────────────────────────────────────────

/** GET /notifications —— 需要 token；无 token 直接结构化报错（不浪费请求）。 */
export async function githubNotifications(opts: GithubOpts = {}): Promise<GithubResult<GithubNotification[]>> {
  if (!hasGithubToken()) {
    return {
      ok: false,
      error: `no_token: /notifications 是个人数据，未认证必 401。设 ${GITHUB_TOKEN_ENV} 后重试`,
    };
  }
  const r = await ghGet<RawNotification[]>('/notifications', pageQuery(opts), opts);
  if (!r.ok) return errorOf<GithubNotification[]>(r);
  const data = (r.data ?? []).map((raw) => ({
    id: typeof raw.id === 'string' ? raw.id : String(raw.id ?? ''),
    reason: s(raw.reason),
    title: s(raw.subject?.title),
    subjectType: s(raw.subject?.type),
    url: s(raw.subject?.url),
    repo: s(raw.repository?.full_name),
    updatedAt: s(raw.updated_at),
    unread: raw.unread !== false,
  }));
  return { ...r, data };
}

/** GET /repos/:owner/:repo/issues —— 只收 open，按 updated 倒序；剥离混进来的 PR。 */
export async function githubIssues(owner: string, repo: string, opts: GithubOpts = {}): Promise<GithubResult<GithubIssue[]>> {
  const q = pageQuery(opts);
  q.set('state', 'open');
  q.set('sort', 'updated');
  q.set('direction', 'desc');
  const r = await ghGet<RawIssue[]>(`/repos/${enc(owner)}/${enc(repo)}/issues`, q, opts);
  if (!r.ok) return errorOf<GithubIssue[]>(r);
  const data = (r.data ?? [])
    .filter((raw) => raw.pull_request === undefined)
    .map((raw) => ({
      number: n(raw.number),
      title: s(raw.title),
      url: s(raw.html_url),
      user: s(raw.user?.login),
      updatedAt: s(raw.updated_at),
      comments: n(raw.comments),
      labels: labelsOf(raw.labels),
    }))
    // API 侧 sort=updated&direction=desc 已排；这里兜底一次，防上游参数被忽略时调用方拿到乱序
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { ...r, data };
}

/** GET /repos/:owner/:repo/pulls —— 只收 open，按 updated 倒序。 */
export async function githubPulls(owner: string, repo: string, opts: GithubOpts = {}): Promise<GithubResult<GithubPull[]>> {
  const q = pageQuery(opts);
  q.set('state', 'open');
  q.set('sort', 'updated');
  q.set('direction', 'desc');
  const r = await ghGet<RawPull[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls`, q, opts);
  if (!r.ok) return errorOf<GithubPull[]>(r);
  const data = (r.data ?? [])
    .map((raw) => ({
      number: n(raw.number),
      title: s(raw.title),
      url: s(raw.html_url),
      user: s(raw.user?.login),
      updatedAt: s(raw.updated_at),
      draft: raw.draft === true,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { ...r, data };
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item !== '') out.push(item);
    } else if (typeof item === 'object' && item !== null && 'name' in item) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') out.push(name);
    }
  }
  return out;
}