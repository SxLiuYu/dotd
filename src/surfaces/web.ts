/**
 * src/surfaces/web.ts —— Web UI 静态托管（surfaces.md §2.1/§7/§9）。
 *
 * 依据：
 * - §2.1：全 daemon 唯一 HTTP 监听 = `127.0.0.1:7788`（契约 H2：CP 的 8642 作废，
 *   CP REST 子集由本模块路由器进程内转调）。
 * - §7：Web UI 页面结构（聊天流 / Queue+Breaker+Approvals 右栏 / Events / Models /
 *   Logs / Settings）；SSE 断线重连 `Last-Event-ID = bus_seq`，超窗 → resync +
 *   REST 快照校正（§4.5）。
 * - §9 Windows 落地：`netsh interface portproxy` 把 127.0.0.1:7788 转发到 WSL IP，
 *   `dotd serve` 启动自检提示重跑（本文件只做托管，不绑 WSL 网络细节）。
 * - web-ui/ 的 vite 产物默认 `dist/`（web-ui/vite.config.ts build.outDir）；
 *   dist 不存在（未构建）时返回一段说明页而不是 404 裸奔。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';

/** SPA 托管的默认根目录（相对 dotd/ 仓库根）。 */
export const DEFAULT_WEB_ROOT = 'web-ui/dist';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticHostOptions {
  /** 静态根目录（绝对路径）。 */
  root: string;
  /** index.html 不存在时的占位页（未构建 web-ui 的提示）。 */
  fallbackHtml?: string;
}

/** 未构建时的占位页（§7 页面结构的一句话说明 + 构建命令）。 */
export function notBuiltHtml(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>dotd · Web UI 未构建</title></head><body>',
    '<h1>dotd daemon 在跑，Web UI 还没构建</h1>',
    '<p>构建命令：<code>npm --prefix dotd run build:web</code>（= <code>tsc --noEmit</code> + <code>vite build</code>）。</p>',
    '<p>API 不受影响：<code>/api/health</code>、<code>/api/stream</code> 等端点照常可用。</p>',
    '</body></html>',
  ].join('');
}

/**
 * 把 URL 路径解析成静态根内的文件路径。
 * 安全：归一化后必须仍在 root 内（拒 `../` 穿越与绝对路径注入）。
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  // 先解 query/fragment，再解 percent-encoding（攻击者用 %2e%2e%2f 绕过字面检查）；
  // 解码失败（畸形 %）按原样处理，仍会被下面的越界检查拦下。
  let clean = urlPath.split('?')[0]!.split('#')[0]!;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 保留原串
  }
  if (clean.includes('\0')) return null;
  // URL 路径永远是 '/' 分隔；Windows 的 normalize 会把 '/a/b' 变成 '\a\b'，
  // 但**前导分隔符要显式剥掉**（否则 resolve 把它当绝对路径 → 逃逸 root）。
  const rel = clean.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  const full = resolve(root, normalize(rel));
  const rootAbs = resolve(root);
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null;
  return full;
}

/** 目录请求 → index.html（SPA 深链：未命中文件时也回落 index.html）。 */
function withIndex(p: string): string {
  return p.endsWith(sep) || p.endsWith('/') ? join(p, 'index.html') : p;
}

/**
 * 静态文件处理器：命中 → 200 + MIME；未命中 → SPA 回落 index.html；
 * index.html 也没有（未构建）→ 200 占位页。
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StaticHostOptions,
): Promise<void> {
  const target = withIndex(resolveStaticPath(opts.root, req.url ?? '/') ?? resolve(opts.root, 'index.html'));
  let filePath = target;
  let st = await statSafe(filePath);
  if ((st === null || !st.isFile()) && extname(filePath) === '') {
    // SPA 路由（无扩展名的深链）→ index.html
    filePath = join(opts.root, 'index.html');
    st = await statSafe(filePath);
  }
  if (st === null || !st.isFile()) {
    const html = opts.fallbackHtml ?? notBuiltHtml();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const immutable = /\/assets\//.test(filePath) || /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(filePath);
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(st.size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      res.destroy();
      resolvePromise();
    });
    stream.on('end', () => resolvePromise());
    stream.pipe(res);
  });
}

async function statSafe(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}
