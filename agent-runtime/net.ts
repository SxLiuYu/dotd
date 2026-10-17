/**
 * agent-runtime/net.ts —— net.get / net.post（容器侧出站 HTTP）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 11 工具词表里 `net.get`/`net.post` 一直"登记了但容器侧未实现"：
 * 旧 `server.ts` 直接返回 `not_implemented`。模型在工具目录里看得见它们、
 * 尝试调用、然后拿到一个永远失败的码——这是"能力看起来有、实际没有"的典型。
 * 本文件把它做成真的。
 *
 * ── 默认策略（本轮确立的价值观：默认保守）────────────────────────────
 * **默认关闭**。理由：dotd 的立身之本是完全自托管，唯一允许的外部依赖是
 * "可换 base_url 的模型 API"。任何让 agent 主动出网的能力都会把主人的
 * **隐私（请求内容里会带任务上下文）与账单（第三方 API 可能计费）** 交给外部服务。
 * 所以：
 *   - `DOTD_NET_TOOLS` 未设 / 为 `off` → 两个工具都返回 `net_tools_disabled`
 *     （**可预测的失败码**，不是 not_implemented：模型读得到"该能力被主人关闭"）。
 *   - `DOTD_NET_TOOLS=get` → **只**放开 net.get（GET 无请求体，泄露面最小）。
 *   - `DOTD_NET_TOOLS=all` → get + post（post 有对外副作用，默认不给）。
 * 治理侧另有一道闸（GOV 档位：net.get=read、net.post=write_file，
 * `config/tools.yml` 可加 `urlHost` 规则收紧到白名单域名）——两层独立生效。
 *
 * ── 硬边界（与宿主 netguard 配合）────────────────────────────────────
 * 宿主 `src/exec/netguard.ts` 的 DOTD-OUT 链只允许容器**出外网**、显式 DROP
 * 到宿主网关/loopback —— 也就是说容器 net.* 到不了 daemon 自己、
 * 也到不了宿主机上的本地服务。本文件的额外护栏（防"就算网络层漏了也不出事"）：
 *   - **只允许 http/https**（拒 file:/ftp:/data: 等，防 SSRF 变体读本地文件）；
 *   - **拒绝指向 loopback / 私有网段 / link-local / 元数据服务的主机名与 IP**
 *     （169.254.169.254、127.0.0.1、localhost、10./172.16-31./192.168./::1 等）——
 *     这就是 SSRF 防护，也是"自托管系统不该被模型拿去探内网"的底线；
 *   - 重定向**不自动跟随**：3xx 原样返回 `location`，由模型自己决定要不要再发一次
 *     （跟随会把"出网"悄悄延长到我们没审过的域名）；
 *   - 超时：`deadline_ms` 与 `NET_TIMEOUT_MAX_MS` 取小；
 *   - 体积上限：响应体流式累计，超 `NET_RESPONSE_MAX_BYTES` 立即中止并返回
 *     `net_too_large`（不把内存打爆，也不把巨大的 HTML 塞进上下文）。
 *
 * ── 返回形状 ────────────────────────────────────────────────────────
 * `{ url, finalUrl, status, contentType, headers, body, bodyTruncated }`
 * - `status` 是真实 HTTP 状态码（4xx/5xx **不**算工具错误：模型的职责是读错误页）；
 * - 只有网络层失败（DNS/连接/TLS/超时）才返回 error，码见 `NET_ERROR_CODES`。
 */

import type { ToolResult } from './protocol.ts';
import { ERROR_CODES, errorResult, okResult } from './protocol.ts';

/** net.* 的开关取值（`DOTD_NET_TOOLS`）。 */
export type NetToolsMode = 'off' | 'get' | 'all';

/** 缺省值：关闭（见文件头「默认策略」）。 */
export const NET_TOOLS_DEFAULT_MODE: NetToolsMode = 'off';

/** 响应体上限（4MB，与 fs.read 同量级；超过即中止）。 */
export const NET_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** 单次请求的超时上限（deadline_ms 更小时以 deadline 为准）。 */
export const NET_TIMEOUT_MAX_MS = 30_000;

/** 重定向上限：本实现**不跟随**，但会把 location 回给模型；此常量只用于测试断言。 */
export const NET_MAX_REDIRECTS = 0;

/** net.* 私有错误码（与协议 ERROR_CODES 并列；宿主按字符串分流，不冲突）。 */
export const NET_ERROR_CODES = {
  /** 主人没开这个能力（默认）。 */
  disabled: 'net_tools_disabled',
  /** 该模式只放开 GET，调了 POST。 */
  postDisabled: 'net_post_disabled',
  /** URL 不合法 / 协议不是 http(s)。 */
  badUrl: 'net_bad_url',
  /** SSRF 防护：目标是 loopback/私有网段/元数据地址。 */
  blockedHost: 'net_blocked_host',
  /** 网络层失败（DNS/连接/TLS）。 */
  network: 'net_network_error',
  /** 超时。 */
  timeout: 'net_timeout',
  /** 响应超过体积上限。 */
  tooLarge: 'net_too_large',
} as const;

/**
 * 解析 `DOTD_NET_TOOLS`。无法识别的值按 **off** 处理并附 warning（绝不因为
 * 拼错而意外放开出网——与 doctor 的"拼错告警"同一原则）。
 */
export function parseNetToolsMode(raw: string | undefined): { mode: NetToolsMode; warning: string | null } {
  if (raw === undefined || raw.trim().length === 0) return { mode: NET_TOOLS_DEFAULT_MODE, warning: null };
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return { mode: 'off', warning: null };
  if (v === 'get' || v === 'getonly' || v === 'get_only') return { mode: 'get', warning: null };
  if (v === 'all' || v === 'on' || v === '1' || v === 'true') return { mode: 'all', warning: null };
  return {
    mode: 'off',
    warning: `DOTD_NET_TOOLS=${JSON.stringify(raw)} 无法识别（只认 off|get|all），已按 off 处理——出网能力不会被拼错放开`,
  };
}

/** 私有/保留网段（SSRF 防护用；IPv4 + IPv6）。 */
const PRIVATE_V4 = [
  [/^10\./, '10/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local（含 169.254.169.254 云元数据）'],
  [/^192\.168\./, '192.168/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16/12'],
  [/^0\./, '0/8'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64/10 运营商级 NAT'],
] as const;

/** IPv4 映射网段的 IPv6 十六进制形式（`::ffff:a.b.c.d` → `::ffff:7f00:1`）。 */
function unmapIpv4FromHex(h: string): string | null {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m === null) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * 判定 host 是否被禁止访问。返回 `null` = 允许；否则返回人类可读原因。
 *
 * 覆盖：localhost/`*.local`、字面量 IPv4 私有段、IPv6 loopback/ULA/link-local、
 * 以及 `[::ffff:127.0.0.1]` 这类 IPv4 映射写法。
 *
 * ⚠ 实测坑（本函数第一版就踩了）：`new URL('http://[::ffff:127.0.0.1]/')` 的
 * `hostname` 是 **`[::ffff:7f00:1]`**——URL 解析器把映射地址规范化成了十六进制，
 * 所以只按点分正则判 `::ffff:\d+\.` 会**漏掉整个 IPv4 映射面**（等于 SSRF 防护失效）。
 * 这里两种形态都判。
 *
 * **不做 DNS 解析**（容器内解析结果可能与宿主不同；DNS rebinding 的纵深防御靠
 * netguard 的网络层，不在这里假装能挡住）。
 */
export function blockedHostReason(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h.length === 0) return '空主机名';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost（本机）';
  if (h.endsWith('.local')) return 'mDNS .local 域名';
  if (h === '::1' || h === '::') return 'IPv6 loopback';
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'IPv6 唯一本地地址（ULA）';
  if (/^fe80:/.test(h)) return 'IPv6 link-local';
  // IPv4 映射的 IPv6：点分形态（::ffff:127.0.0.1）与 URL 规范化后的十六进制形态（::ffff:7f00:1）
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mappedDotted !== null) {
    const r = blockedHostReason(mappedDotted[1]!);
    if (r !== null) return `IPv4 映射地址：${r}`;
  }
  const mappedHex = unmapIpv4FromHex(h);
  if (mappedHex !== null) {
    const r = blockedHostReason(mappedHex);
    if (r !== null) return `IPv4 映射地址（十六进制形态 ${h} → ${mappedHex}）：${r}`;
  }
  for (const [re, label] of PRIVATE_V4) {
    if (re.test(h)) return `私有/保留网段 ${label}`;
  }
  return null;
}

/** 单次请求的输入（工具调用 args 已校验过形状）。 */
export interface NetRequest {
  callId: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, unknown>;
  body?: string;
  deadlineMs: number;
}

/** 可注入的 fetch 面（测试打假上游；生产就是全局 fetch）。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 默认可用性探针：运行时有全局 fetch 即可（Node 24 必然有）。 */
export function defaultFetch(): FetchLike | null {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  return typeof f === 'function' ? f.bind(globalThis) as FetchLike : null;
}

/** 允许的请求头：只放行无害的语义头，**禁止**覆盖 Host/Content-Length/Cookie 等。 */
const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'cache-control',
  'if-none-match',
  'if-modified-since',
]);

/** 规范化请求头：过滤非法名/值与非白名单键。 */
export function sanitizeHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase();
    if (!ALLOWED_HEADERS.has(key)) continue;
    if (typeof v !== 'string') continue;
    // 头注入防护：CR/LF 不允许
    if (/[\r\n]/.test(v)) continue;
    out[key] = v;
  }
  return out;
}

/** 是否为允许的出网协议。 */
export function isAllowedProtocol(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/**
 * 执行一次 net.* 调用。所有失败都以 `errorResult` 返回（不抛），
 * 因为工具层任何异常都会变成 Runner 的硬失败。
 */
export async function runNetCall(
  req: NetRequest,
  opts: { mode: NetToolsMode; fetchImpl?: FetchLike | null; now?: () => number } = { mode: NET_TOOLS_DEFAULT_MODE },
): Promise<ToolResult> {
  const mode = opts.mode;
  // ① 开关闸（默认 off）
  if (mode === 'off') {
    return errorResult(
      req.callId,
      NET_ERROR_CODES.disabled,
      `出网工具默认关闭（DOTD_NET_TOOLS=${mode}）。主人需显式设 DOTD_NET_TOOLS=get（只读）或 all（含 POST）才能使用 ${req.method === 'GET' ? 'net.get' : 'net.post'}。`,
      false,
    );
  }
  if (req.method === 'POST' && mode !== 'all') {
    return errorResult(
      req.callId,
      NET_ERROR_CODES.postDisabled,
      `DOTD_NET_TOOLS=get 只放开只读的 net.get；net.post 会把数据发给外部服务，需要 DOTD_NET_TOOLS=all 才能用。`,
      false,
    );
  }

  // ② URL 合法性
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return errorResult(req.callId, NET_ERROR_CODES.badUrl, `url 不是合法绝对地址：${req.url}`, false);
  }
  if (!isAllowedProtocol(u)) {
    return errorResult(
      req.callId,
      NET_ERROR_CODES.badUrl,
      `只允许 http/https（收到 ${u.protocol}）——file:/ftp:/data: 等协议被拒`,
      false,
    );
  }
  if (u.username.length > 0 || u.password.length > 0) {
    return errorResult(req.callId, NET_ERROR_CODES.badUrl, 'URL 不允许内嵌账号密码', false);
  }

  // ③ SSRF 防护
  const blocked = blockedHostReason(u.hostname);
  if (blocked !== null) {
    return errorResult(
      req.callId,
      NET_ERROR_CODES.blockedHost,
      `拒绝访问 ${u.hostname}：${blocked}。net.* 只用于访问公网，不得访问本机/内网/元数据服务。`,
      false,
    );
  }

  // ④ 发出请求
  const fetchImpl = opts.fetchImpl === undefined ? defaultFetch() : opts.fetchImpl;
  if (fetchImpl === null || fetchImpl === undefined) {
    return errorResult(req.callId, NET_ERROR_CODES.network, '运行时没有可用的 fetch（Node <18？）', false);
  }
  const timeoutMs = Math.max(1, Math.min(req.deadlineMs, NET_TIMEOUT_MAX_MS));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const headerObj = sanitizeHeaders(req.headers);
  const init: RequestInit = {
    method: req.method,
    headers: headerObj,
    // 不跟随重定向：3xx 原样返回，由模型决定是否再发（见文件头）
    redirect: 'manual',
    signal: timeoutSignal,
    ...(req.method === 'POST' && req.body !== undefined ? { body: req.body } : {}),
  };

  let res: Response;
  try {
    res = await fetchImpl(u.toString(), init);
  } catch (cause) {
    const isAbort =
      (cause as { name?: string } | null)?.name === 'TimeoutError' ||
      (cause as { name?: string } | null)?.name === 'AbortError';
    if (isAbort) {
      return errorResult(
        req.callId,
        NET_ERROR_CODES.timeout,
        `${req.method} ${u.hostname} 超过 ${timeoutMs}ms 未完成（可重试或缩短目标）`,
        true,
      );
    }
    return errorResult(
      req.callId,
      NET_ERROR_CODES.network,
      `网络错误（${req.method} ${u.hostname}）：${cause instanceof Error ? cause.message : String(cause)}`,
      true,
    );
  }

  // ⑤ 流式读取 + 体积上限
  const contentType = res.headers.get('content-type') ?? '';
  const read = await readBodyWithLimit(res, NET_RESPONSE_MAX_BYTES);
  const headers: Record<string, string> = {};
  for (const [k, v] of res.headers) headers[k] = v;
  // 3xx 不跟随：把 location 显式回给模型，避免"看起来成功了但内容不对"
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    return okResult(req.callId, {
      url: u.toString(),
      finalUrl: u.toString(),
      status: res.status,
      contentType,
      headers,
      body: read.text,
      bodyTruncated: read.truncated,
      redirect: loc,
      note: loc !== null ? `3xx 未自动跟随；如需继续请再发 net.get 到 ${loc}` : '3xx 无 location 头',
    });
  }
  return okResult(req.callId, {
    url: u.toString(),
    finalUrl: res.url.length > 0 ? res.url : u.toString(),
    status: res.status,
    contentType,
    headers,
    body: read.text,
    bodyTruncated: read.truncated,
  });
}

/** 流式读响应体，超过 `limit` 立即取消并标记截断。 */
async function readBodyWithLimit(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body === null) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        const keep = limit - (total - value.byteLength);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } catch {
    // 读取中途断开：已拿到的部分照常返回（truncated 标记由调用方语义决定）
    truncated = true;
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString('utf8'), truncated };
}
