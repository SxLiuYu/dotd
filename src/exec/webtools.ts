/**
 * src/exec/webtools.ts —— 宿主侧浏览器工具（web.*，W2，2026-10-21）
 *
 * ## 为什么是宿主侧 CLI，不是容器里的 playwright
 * 容器里那套 browser.* 只能"猜 CSS 选择器"，模型看不到页面上哪些东西可点；
 * 而且容器 rootfs 只读，Chrome（200MB+）塞不进镜像。
 *
 * agent-browser（vercel-labs，GitHub 44.4k stars）把浏览器做成 CLI，
 * 每次调用独立进程，靠一个常驻的浏览器 session 串起来。它的核心设计是
 * **引用**：
 *   $ agent-browser snapshot -i
 *   - link "Learn more" [ref=e1]
 *   $ agent-browser click @e1
 * 模型读到的是"有哪些可交互元素"，而不是几百 KB HTML，也不用猜选择器。
 * 这是当前 AI 浏览器自动化的主流形状。
 *
 * ## 安全边界
 * 这些工具在宿主上 spawn 一个 CLU，只喂固定的子命令名（action 走白名单映射），
 * 模型无法注入任意 shell。参数一律经 execFile 的数组形式传递，不过 shell。
 * 浏览器只能访问网络，碰不到宿主文件系统（除了它自己的下载目录）。
 */
import { execFile } from 'node:child_process';

/** agent-browser 可执行文件；允许用环境变量换路径（测试/换机时用）。 */
const BIN = process.env['DOTD_AGENT_BROWSER_BIN'] ?? 'agent-browser';

/** 单次调用超时：浏览器首次启动要下载/热身，给宽一点。 */
const TIMEOUT_MS = 110_000;

/** 输出上限：页面正文可能很长，截断避免把模型上下文撑爆。 */
const MAX_OUTPUT = 60_000;

export interface WebResult {
  ok: boolean;
  /** 成功时的可读输出（已截断）。 */
  output?: string;
  /** 失败原因。 */
  error?: string;
}

/** 跑一条 agent-browser 子命令。数组传参，绝不过 shell。 */
function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      BIN,
      argv,
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // 2026-10-21：spawn 失败（二进制不存在/无执行权限）时 stderr 是空的，
        // 真实原因只在 err.message 里（"spawn xxx ENOENT"）。不带上它的话，
        // 下面 friendlyFailure 只能吐出"退出码 1"，等于让人自己猜。
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

/** 截断到 MAX_OUTPUT，并标注截断事实（模型需要知道它没看到全部）。 */
function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n…（输出过长，已截断 ${s.length - MAX_OUTPUT} 字符）`;
}

/** 只允许 http(s)：挡住 file:// 之类越界读取。 */
function safeUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null;
  } catch {
    return null;
  }
}

/** agent-browser 没装好时给一条能自己修的话，而不是干巴巴的 ENOENT。 */
function friendlyFailure(stderr: string, code: number): string {
  if (/ENOENT|not found/i.test(stderr)) {
    return `${BIN} 不可用：请确认已安装（npm i -g agent-browser && agent-browser install --with-deps）`;
  }
  if (/Chrome not found|executable-path/i.test(stderr)) {
    return 'agent-browser 找不到 Chrome：运行 agent-browser install 下载（首次约 190MB）';
  }
  const first = stderr.trim().split('\n').slice(0, 6).join('\n');
  return first === '' ? `agent-browser 退出码 ${code}` : first;
}

/**
 * 取页面结构。
 *
 * 默认 `interactive_only`：只列可交互元素并带 @eN 引用 —— 这是模型真正
 * 需要的东西（"我能点哪些"），而不是整棵无障碍树（噪声大得多）。
 * 传 false 时给完整快照，用于理解页面结构。
 */
export async function webSnapshot(args: Record<string, unknown>): Promise<WebResult> {
  const rawUrl = typeof args['url'] === 'string' ? args['url'] : '';
  const interactive = args['interactive_only'] !== false;

  if (rawUrl !== '') {
    const url = safeUrl(rawUrl);
    if (url === null) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };
    const opened = await run(['open', url]);
    if (opened.code !== 0) {
      return { ok: false, error: friendlyFailure(opened.stderr, opened.code) };
    }
  }

  const snap = await run(interactive ? ['snapshot', '-i'] : ['snapshot']);
  if (snap.code !== 0) {
    return { ok: false, error: friendlyFailure(snap.stderr, snap.code) };
  }
  const out = clip(snap.stdout.trim());
  if (out === '' || out === '(empty page)') {
    return {
      ok: true,
      output:
        (rawUrl !== '' ? `已打开 ${rawUrl}\n` : '') +
        '（页面上没有可交互元素；可先用 web.read 取正文，或 interactive_only=false 看结构）',
    };
  }
  return { ok: true, output: (rawUrl !== '' ? `已打开 ${rawUrl}\n` : '') + out };
}

/**
 * 取正文。
 *
 * 这是 W2 的解法：容器里的 net.get 只是 HTTP 客户端，遇到 JS 渲染的页面
 * 拿到的是一堆空壳（实测模型两次 net_get 都失败，只能答"没有拿到任何内容"）。
 * 走真实浏览器渲染后再取文本，拿到的是用户实际看到的东西。
 */
export async function webRead(args: Record<string, unknown>): Promise<WebResult> {
  const rawUrl = typeof args['url'] === 'string' ? args['url'] : '';
  if (rawUrl === '') return { ok: false, error: '缺少 url 参数' };
  const url = safeUrl(rawUrl);
  if (url === null) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };

  const r = await run(['read', url]);
  if (r.code !== 0) return { ok: false, error: friendlyFailure(r.stderr, r.code) };
  const out = clip(r.stdout.trim());
  if (out === '') return { ok: true, output: `（${url} 没有可读正文——可能是空页面或需要登录）` };
  return { ok: true, output: out };
}

/** action → agent-browser 子命令。只映射固定的几个，杜绝任意命令。 */
const ACTIONS = new Set(['click', 'fill', 'type', 'press', 'scroll', 'dblclick', 'select', 'check']);

/**
 * 用引用操作页面。
 *
 * ref 就是 snapshot 返回的 `@e1` 那种东西。模型不必知道 CSS 选择器，
 * 也不怕页面改版导致选择器失效——每次操作前重新 snapshot 拿新引用即可。
 */
export async function webAct(args: Record<string, unknown>): Promise<WebResult> {
  const action = typeof args['action'] === 'string' ? args['action'] : '';
  if (!ACTIONS.has(action)) {
    return { ok: false, error: `action 只能是 ${[...ACTIONS].join('/')}，收到：${action}` };
  }
  const ref = typeof args['ref'] === 'string' ? args['ref'] : '';
  const text = typeof args['text'] === 'string' ? args['text'] : '';

  const argv: string[] = [action];
  if (action === 'press') {
    if (text === '') return { ok: false, error: 'press 需要 text（键名，如 Enter）' };
    argv.push(text);
  } else if (action === 'scroll') {
    argv.push(text === '' ? 'down' : text);
  } else {
    if (ref === '') return { ok: false, error: `${action} 需要 ref（如 "@e1"，来自 web.snapshot）` };
    if (text !== '') argv.push(ref, text);
    else argv.push(ref);
  }

  const r = await run(argv);
  if (r.code !== 0) return { ok: false, error: friendlyFailure(r.stderr, r.code) };

  // 操作后页面可能变了：顺手回一份新快照，省掉模型再调一次。
  // 失败不影响动作本身的结果（有些动作本来就会跳转走）。
  const after = await run(['snapshot', '-i']);
  const tail = after.code === 0 ? clip(after.stdout.trim()) : '';
  const head = r.stdout.trim() === '' ? `已执行 ${action}` : clip(r.stdout.trim());
  return { ok: true, output: tail === '' ? head : `${head}\n\n— 操作后的可交互元素 —\n${tail}` };
}
