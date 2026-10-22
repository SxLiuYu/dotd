/**
 * src/surfaces/dashboard.ts —— 仪表盘（agent 写 HTML，主人用手机/浏览器打开）
 *
 * 为什么要这个文件（对标 Claude Duet 的「构建仪表盘」）
 *   Duet 的招牌场景之一是：让它把几个数据源做成一份能一眼看完的页面，
 *   之后你每天看那份页面，而不是每天重问一遍。dotd 的过程可视化（progress）
 *   是「任务在干什么」，活动总览（activity）是「最近干了什么」，
 *   但**没有**「主人自己攒的那一页」。这个文件补的就是这一页。
 *
 * 事实源与形态（刻意选最笨的一种）
 *   - 页面 = 容器 home 里的 `dashboards/<slug>.html` 一个**静态 HTML 文件**。
 *   - daemon 用 `GET /d/<slug>` 原样吐出它（`src/surfaces/http.ts` 的 `serveDashboard`）。
 *   - 不建表、不加工具、不加前端工程：agent 早就能用 `fs.write` 写文件，
 *     多一个「dashboard.write」只会多一条要维护的治理档位与一份 prompt 说明书。
 *   - 更新 = 定时任务重写这份 HTML（schedule.create + fs.write），
 *     于是「页面会自己变新」这件事复用已有的定时与审批链路，不另造调度。
 *
 * 为什么默认**不许跑 JS**（CSP 见 dashboardCsp）
 *   页面是模型写的，又跑在主人自己的浏览器、同一个 127.0.0.1:7788 源上。
 *   允许内联脚本 = 给「模型写错一行」或「模型被页面内容带偏」开了一条同源执行权，
 *   而 localStorage 里就躺着 master token。所以默认 `default-src 'none'`：
 *   只允许内联样式与 data: 图片。要图表就写**静态 SVG**（一样好看，且不会动）。
 *   真要交互，改 CSP 是有意识的决定，不该是默认值。
 *
 * 边界（别把本文当承诺）
 *   - 容器 home 是**可重置**的：`dotd` 的 fleet reset 会清掉 `dashboards/`。
 *     需要长期留存的页面，让 agent 同时写一份到 `notes/`（受记忆归档保护）。
 *   - stub 容器（`DOTD_FLEET=stub`）没有真文件，`/d/<slug>` 会 404 —— 这是设计，
 *     不是缺陷：没有页面就不该假装有。
 */

/** 仪表盘在容器 home 里的目录名（相对路径，不含前导 `/dot/home/`）。 */
export const DASHBOARD_DIR = 'dashboards';

/**
 * 单页字节上限。512KB 足够放下几千行表格 + 内联 SVG；
 * 超过它多半是模型把整份原始数据贴进页面了 —— 那不是仪表盘，是导出文件。
 */
export const DASHBOARD_MAX_BYTES = 512 * 1024;

/**
 * slug 白名单：小写字母/数字开头，允许中间用 `-`，最长 63。
 *
 * 为什么不用宽松匹配再过滤危险字符：URL 路径是**外部输入**，
 * 白名单是唯一不会漏的口径（`..`、`%2e%2e`、反斜杠、NUL 这些都进不来）。
 */
export const DASHBOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** slug 校验结果。reason 是给日志/404 文案用的，不进页面。 */
export type SlugParse =
  | { ok: true; slug: string }
  | { ok: false; reason: 'empty' | 'bad_slug' };

/**
 * 解析 URL 里的 slug。只认完整正则匹配，**不做任何归一化**
 * （归一化会让 `A` 与 `a` 指向同一文件，也会让路径穿越有可乘之机）。
 */
export function parseDashboardSlug(raw: string | null | undefined): SlugParse {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const s = raw.trim();
  if (s === '') return { ok: false, reason: 'empty' };
  if (!DASHBOARD_SLUG_RE.test(s)) return { ok: false, reason: 'bad_slug' };
  return { ok: true, slug: s };
}

/** HTML 校验结果。 */
export type HtmlCheck = { ok: true } | { ok: false; reason: 'empty' | 'too_large' | 'not_html' };

/**
 * 校验要托管的一份 HTML。
 *
 * 三条都是「宁可 404 也别把奇怪的东西当页面发出去」：
 *   empty      —— 空文件是写一半的产物，发出去只会让主人以为坏了
 *   too_large  —— 见 DASHBOARD_MAX_BYTES 的注释
 *   not_html   —— 既不是 `<!doctype html>` 也不含 `<html`。模型偶尔会把 JSON
 *                 或 markdown 写到 .html 路径下，那种内容浏览器会当纯文本渲染，
 *                 看起来像「页面只有一块乱码」。直接拒更诚实。
 */
export function validateDashboardHtml(html: string): HtmlCheck {
  if (html.length === 0) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(html, 'utf8') > DASHBOARD_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const head = html.slice(0, 512).toLowerCase();
  const looksHtml = head.includes('<!doctype html') || head.includes('<html');
  if (!looksHtml) return { ok: false, reason: 'not_html' };
  return { ok: true };
}

/** slug → 容器 home 内相对路径（`dashboards/<slug>.html`）。 */
export function dashboardHomePath(slug: string): string {
  return DASHBOARD_DIR + '/' + slug + '.html';
}

/**
 * 托管仪表盘时下发的 CSP。
 *
 * `default-src 'none'` 兜住一切（fetch/XHR/iframe/表单/外链脚本）；
 * 只放三个口子：内联样式、data: 图片、data: 字体。
 * `base-uri 'none'` 与 `form-action 'none'` 防「页面里插一个 <base> 改掉相对地址」。
 */
export function dashboardCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * 拼给主人点的那条链接。
 *
 * baseUrl 为空时返回 `null`：宁可让调用方说「本机打开 /d/<slug>」，
 * 也不要拼出 `http:///d/x` 这种点了必然失败的东西（手机主人会以为服务挂了）。
 */
export function dashboardUrl(baseUrl: string | null | undefined, slug: string): string | null {
  if (baseUrl === null || baseUrl === undefined) return null;
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base === '') return null;
  if (!/^https?:\/\//i.test(base)) return null;
  return base + '/d/' + slug;
}

/**
 * 从 HTML 里取 `<title>`，取不到返回 null。
 *
 * 只做**最小**实体解码：标题是要显示在飞书/日志里的纯文本，
 * 留着 `&amp;` 会显得很业余，但为它引一个解码库不值得。
 */
export function extractDashboardTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  if (m === null) return null;
  const raw = m[1];
  if (raw === undefined) return null;
  const t = raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t === '' ? null : t;
}

/** 一页的元信息（给 CLI / 飞书文案用；不读文件内容）。 */
export interface DashboardMeta {
  slug: string;
  title: string | null;
  bytes: number;
}

/** 渲染一行「有哪些页面」的人类可读文案（CLI `dotd dashboard list` 用）。 */
export function renderDashboardList(rows: readonly DashboardMeta[], baseUrl?: string | null): string {
  if (rows.length === 0) {
    return [
      '还没有仪表盘。',
      '',
      '让它做一个：给它一句话，例如「把最近 7 天的任务和待审批做成一个页面」。',
      '它会写到 ' + DASHBOARD_DIR + '/<slug>.html，然后就能从 /d/<slug> 打开。',
    ].join('\n');
  }
  const lines: string[] = ['共 ' + rows.length + ' 个仪表盘：', ''];
  for (const r of rows) {
    const name = r.title ?? r.slug;
    const url = baseUrl === null || baseUrl === undefined ? null : dashboardUrl(baseUrl, r.slug);
    lines.push('· ' + name + '（' + r.slug + '，' + formatBytes(r.bytes) + '）');
    if (url !== null) lines.push('  ' + url);
  }
  return lines.join('\n');
}

/** 字节数转人话（只保留一位小数，够用且稳定）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}