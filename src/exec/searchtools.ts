/**
 * src/exec/searchtools.ts —— 宿主侧搜索工具（search.*，2026-10-22）
 *
 * ## 为什么需要它
 * 实测（docs/net-reachability-20261022.md）：本机直连只能到 baidu/bing/zhihu/github，
 * jd/taobao/tmall/amazon 直连与代理**都不通**。也就是说模型手里的 net.get / web.read
 * 拿去查"京东上某个东西多少钱"，无论怎么降级都拿不到东西——不是工具坏了，是这条路
 * 本身不通。而 argo 走的是它自己的 272 个源（含 anysearch），不受本机出口限制。
 *
 * ## 为什么是宿主侧 CLI
 * 和 web.*（webtools.ts）同一个理由：argo 是宿主上的 Python CLI，容器 rootfs 只读，
 * 装不进去；而且搜索只是读网络，宿主侧跑不扩大真实风险。
 *
 * ## 安全边界
 * 只 spawn 固定子命令（search/fetch），模型只能影响**参数值**，不能影响可执行文件
 * 与子命令名。参数一律经 execFile 的数组形式传递，绝不过 shell。
 */
import { execFile } from 'node:child_process';

/** argo 入口（Python CLI）。允许用环境变量换路径（换机/测试）。 */
const BIN = process.env['DOTD_ARGO_BIN'] ?? '/root/argo/bin/argo';

/** 调 argo 用的解释器。argo 要求 3.8+，容器外的宿主 python3 满足。 */
const PY = process.env['DOTD_ARGO_PYTHON'] ?? 'python3';

/** 单次超时：argo 自己预算 10s，但首跑要 import（实测 +7s），给足。 */
const TIMEOUT_MS = 120_000;

/** 输出上限：搜索结果 JSON 很长，截断避免撑爆模型上下文。 */
const MAX_OUTPUT = 40_000;

export interface SearchResult {
  ok: boolean;
  output?: string;
  error?: string;
}

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n…（输出过长，已截断 ${s.length - MAX_OUTPUT} 字符）`;
}

/** 跑一条 argo 子命令。数组传参，绝不过 shell。 */
function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      PY,
      [BIN, ...argv],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const spawnMsg = err === null ? '' : String((err as { message?: unknown }).message ?? '');
        const code =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code as number)
              : 1;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || spawnMsg,
        });
      },
    );
  });
}

/** 把 argo 的 JSON 压成模型好读的短清单（原始 JSON 太长，且大半是计时埋点）。 */
function compactSearch(json: string, limit: number): string | null {
  let d: unknown;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  const o = d as {
    results?: { title?: unknown; url?: unknown; snippet?: unknown }[];
    count?: unknown;
    errors?: unknown;
  };
  if (!Array.isArray(o.results)) return null;
  const rows = o.results.slice(0, limit).map((r, i) => {
    const title = typeof r.title === 'string' ? r.title : '(无标题)';
    const url = typeof r.url === 'string' ? r.url : '';
    const snip = typeof r.snippet === 'string' ? r.snippet.replace(/\s+/g, ' ').trim() : '';
    return `${i + 1}. ${title}\n   ${url}\n   ${snip.slice(0, 400)}`;
  });
  const errs = Array.isArray(o.errors) && o.errors.length > 0 ? `\n\n（argo 报错：${JSON.stringify(o.errors).slice(0, 300)}）` : '';
  return `共 ${String(o.count ?? rows.length)} 条，显示前 ${rows.length} 条：\n\n${rows.join('\n\n')}${errs}`;
}

export async function searchWeb(args: Record<string, unknown>): Promise<SearchResult> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { ok: false, error: '缺少 query 参数' };

  const limit =
    typeof args['limit'] === 'number' && Number.isFinite(args['limit'])
      ? Math.max(1, Math.min(20, Math.trunc(args['limit'])))
      : 5;

  const argv: string[] = ['search', query, '--engine', 'anysearch'];
  if (typeof args['time_range'] === 'string' && args['time_range'] !== '') {
    argv.push('--time-range', args['time_range']);
  }

  const r = await run(argv);
  if (r.code !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim() || `退出码 ${String(r.code)}`).slice(0, 800);
    return { ok: false, error: `argo search 失败：${why}` };
  }
  const compact = compactSearch(r.stdout.trim(), limit);
  return { ok: true, output: clip(compact ?? r.stdout.trim()) };
}

export async function searchFetch(args: Record<string, unknown>): Promise<SearchResult> {
  const rawUrl = typeof args['url'] === 'string' ? args['url'] : '';
  if (rawUrl === '') return { ok: false, error: '缺少 url 参数' };
  if (!/^https?:\/\//i.test(rawUrl)) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };

  const r = await run(['fetch', rawUrl]);
  if (r.code !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim() || `退出码 ${String(r.code)}`).slice(0, 800);
    return { ok: false, error: `argo fetch 失败：${why}` };
  }
  const out = r.stdout.trim();
  if (out === '') return { ok: true, output: `（${rawUrl} 没有抓到正文）` };
  return { ok: true, output: clip(out) };
}
