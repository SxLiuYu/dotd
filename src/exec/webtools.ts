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
function run(
  argv: string[],
  session?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // 2026-10-21：identity → --session。容器侧 browser.* 靠 launchPersistentContext +
  // /dot/profiles 卷做持久登录态；agent-browser 的等价物是具名 session —— 实测跨进程
  // 保留 cookie（开一次百度，另一个进程 --session 读得到 BAIDUID）。
  const full: string[] =
    session === undefined ? argv : [String(argv[0]), '--session', session, ...argv.slice(1)];
  return new Promise((resolve) => {
    execFile(
      BIN,
      full,
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

/**
 * identity → agent-browser 的 `--session` 名。
 *
 * 为什么要这个映射：容器侧 browser.* 的 identity 是 `site:<host>` 这种字符串
 * （见 src/runner/dot.ts 的 siteIdentityOf），里面带冒号；而 `--session` 会变成
 * 磁盘上的目录名，直接塞进去会出问题。这里做一次确定性哈希：同一个 identity
 * 永远映射到同一个 session，登录态才能跨调用保持；不同 identity 不会撞车
 * （撞车 = 两个站共用 cookie，那比不持久更糟）。
 *
 * `anon`/空 → 不传 session，走 agent-browser 的默认匿名会话（无痕语义）。
 */
function sessionOf(identity: unknown): string | undefined {
  if (typeof identity !== 'string' || identity.length === 0) return undefined;
  if (identity === 'anon') return undefined;
  // FNV-1a 32 位：够短、够稳、无需引入 crypto 依赖。
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    h ^= identity.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `id-${h.toString(16).padStart(8, '0')}`;
}

/**
 * 从工具参数推 identity（复刻 src/runner/dot.ts 的 resolveBrowserIdentity 规则）。
 *
 * 为什么要在这里再算一遍：宿主工具只收到 `call.args`，runner 派生的
 * `call.identity` 不会进 args（见 ExecService.runToolInner: host(call.args)）。
 * 规则必须和 runner 一致，否则"治理审查认为这是登录态、实际执行却用匿名 session"
 * 这种错位迟早出事：
 *   - 显式 args.identity 优先（含 'anon' = 无痕）
 *   - 缺省时按 url 域名派生 site:<host>
 *   - 都没有就用同任务上一次 open 的（snapshot/act 靠这条接上会话）
 *
 * 最后那条是必须的：agent-browser 的 session 决定"看的是哪个浏览器实例"。
 * browser.open 带 url 能派生 session，但紧接着的 browser.snapshot / browser.act
 * **没有 url**，派生不出 identity —— 早先让它们退化成匿名 session，结果 open
 * 打开的页面根本不在那个 session 里，snapshot 只能看见空白页（实测返回
 * "(no interactive elements)"）。所以记一份"这个任务当前在哪个站"给后续继承。
 */
const lastIdentityByTask = new Map<string, string>();

function identityOf(args: Record<string, unknown>, taskKey?: string): unknown {
  const explicit = args['identity'];
  if (typeof explicit === 'string' && explicit.length > 0) {
    // 'anon' 是显式要求无痕，不记进继承表（否则后续 snapshot 反而带上登录态）
    if (taskKey !== undefined && explicit !== 'anon') lastIdentityByTask.set(taskKey, explicit);
    return explicit;
  }
  const url = args['url'];
  if (typeof url === 'string' && url.length > 0) {
    try {
      const host = new URL(url).hostname;
      if (host.length > 0) {
        const id = `site:${host}`.slice(0, 80);
        if (taskKey !== undefined) lastIdentityByTask.set(taskKey, id);
        return id;
      }
    } catch {
      return undefined;
    }
  }
  // 没有 url（snapshot/act/screenshot/close）：继承同任务上一次 open 的站点
  return taskKey === undefined ? undefined : lastIdentityByTask.get(taskKey);
}

/** agent-browser 没装好时给一条能自己修的话，而不是干巴巴的 ENOENT。 */
function friendlyFailure(stderr: string, code: number): string {
  // **`not found` 不等于「没装」**（2026-10-22 真机，提交那一步炸了）。
  //
  // agent-browser 找不到元素时输出：
  //   `✗ Element not found: button[type="submit"]. Verify the selector…`
  // 老正则 `/ENOENT|not found/i` 把它判成「agent-browser 不可用：请确认已安装」，
  // 于是模型以为环境坏了、放弃任务——而真相只是选择器没匹配上。
  //
  // 真机现场：点 submit 报「请确认已安装」，紧接着 browser.open 又成功。
  // 这一句假话直接毁掉了整个填表任务（前 28 步全白做）。
  if (/ENOENT/i.test(stderr)) {
    return `${BIN} 不可用：请确认已安装（npm i -g agent-browser && agent-browser install --with-deps）`;
  }
  // 元素没找到：这是**页面的问题**，不是环境的问题，必须说清楚。
  if (/Element not found/i.test(stderr)) {
    return (
      '没找到这个元素——页面结构和快照时不一样了。' +
      '先用 web.snapshot 重新取一份（ref 会变），再用新的 ref 操作；' +
      '也可以用 browser.snapshot 看完整结构确认选择器。'
    );
  }
  if (/Chrome not found|executable-path/i.test(stderr)) {
    return 'agent-browser 找不到 Chrome：运行 agent-browser install 下载（首次约 190MB）';
  }
  const first = stderr.trim().split('\n').slice(0, 6).join('\n');
  return first === '' ? `agent-browser 退出码 ${code}` : first;
}

/**
 * 这次调用算不算失败（2026-10-22 真机）。
 *
 * **agent-browser 出事时退出码常常还是 0**，失败只写在 stdout 开头：
 *   ✗ Element not found: button["type=submit"]. Verify the selector…
 * 老代码一律只看 `code !== 0`，于是把失败当成功，回一句 `✓ Done`。
 *
 * 真机代价：填表任务点了 5 次"提交"其实一次都没点中，
 * 模型最后判定「我没有浏览器能力」，前 28 步全白做。
 */
/**
 * 每个浏览器 session 上一次见到的 URL（2026-10-22）。
 *
 * 用来判断「刚才这个动作把页面带走了吗」—— 地址变了就是动作生效的最硬证据。
 * 按 session 分开记：同一任务可能有匿名页和登录页两个上下文。
 */
const lastUrlBySession = new Map<string, string>();
function isFailure(r: { code: number; stdout: string; stderr: string }): boolean {
  if (r.code !== 0) return true;
  const said = r.stdout.trim();
  return said.startsWith('✗') || /Element not found/i.test(said);
}

/** 把一次失败的调用转成人话错误。 */
function failureOf(r: { code: number; stdout: string; stderr: string }): WebResult {
  const raw = r.stderr.trim() === '' ? r.stdout : r.stderr;
  return { ok: false, error: friendlyFailure(raw, r.code) };
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
  const session = sessionOf(args['identity']);

  if (rawUrl !== '') {
    const url = safeUrl(rawUrl);
    if (url === null) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };
    const opened = await run(['open', url], session);
    if (isFailure(opened)) return failureOf(opened);
    // 记下起点，这样紧接着的 web.act 才能判断「页面有没有被带走」。
    lastUrlBySession.set(session ?? '', url);
  }

  const snap = await run(interactive ? ['snapshot', '-i'] : ['snapshot'], session);
  if (isFailure(snap)) return failureOf(snap);
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
  const session = sessionOf(args['identity']);

  // **没有 url 时读「当前页」，不要重新发 GET**（2026-10-22 真机）。
  //
  // 现场：模型在 httpbin 表单页点了提交 → 跳到 /post（POST 的结果页）。
  // 它想确认结果，于是调 web.read({url:'https://httpbin.org/post'})，
  // 而老的 webRead 一律 `agent-browser read <url>` —— 那是一次**新的 GET**，
  // httpbin 的 /post 只收 POST ⇒ 405。
  // 模型拿到「✗ Read failed with HTTP 405」，判定提交失败，重新打开表单又填一遍。
  //
  // 页面本来就在浏览器里渲染着（且带着 POST 的响应），直接读当前页就对了。
  // 只有显式给了 url 才导航——那时调用方确实想换页。
  let url = '';
  if (rawUrl !== '') {
    const safe = safeUrl(rawUrl);
    if (safe === null) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };
    url = safe;
  }

  const r = url === '' ? await run(['read'], session) : await run(['read', url], session);
  if (isFailure(r)) return failureOf(r);
  const out = clip(r.stdout.trim());
  const where = url === '' ? '当前页' : url;
  if (out === '') return { ok: true, output: `（${where} 没有可读正文——可能是空页面或需要登录）` };
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

  const session = sessionOf(args['identity']);
  const r = await run(argv, session);
  if (isFailure(r)) return failureOf(r);

  // **失败不能只看退出码**（2026-10-22 真机，实测）。
  //
  // agent-browser 找不到元素时：退出码 **0**，失败写在 stdout 里：
  //   `✗ Element not found: button[type="submit"]. …`
  // 于是老代码把它当成功，回一句 `✓ Done` —— 模型以为点了，其实没点。
  // 填表任务因此反复"提交"却原地不动，最后判定自己没能力。
  //
  // 判据：输出以 `✗` 开头（agent-browser 的失败记号），或者带上 Element not found。
  const said = r.stdout.trim();
  if (said.startsWith('✗') || /Element not found/i.test(said)) {
    return { ok: false, error: friendlyFailure(said, 0) };
  }

  // **先取 URL，再取快照**（2026-10-22 真机，顺序踩过坑）。
  //
  // 现场：点提交后返回里同时出现
  //   `— 操作后的可交互元素 —` 还是**提交前的表单**
  //   `— 当前页面 — https://httpbin.org/post`（已经跳走了）
  // 一份自相矛盾的材料。模型据此认为「还没提交」，重新打开表单又填一遍。
  //
  // 原因很简单：click 触发的跳转还没生效，`snapshot` 就先跑了；等 `get url` 时
  // 页面才跳完。**先查 URL 后取快照**，两者才都反映跳转之后的状态。
  const before = lastUrlBySession.get(session ?? '');
  const urlAfter = await run(['get', 'url'], session);
  const after = await run(['snapshot', '-i'], session);
  const tail = after.code === 0 ? clip(after.stdout.trim()) : '';
  const nowUrl = urlAfter.code === 0 ? urlAfter.stdout.trim() : '';

  // **必须报出当前 URL**（2026-10-22 真机：填表任务提交成功后模型看不见）。
  //
  // 现场：模型 click 了 "Submit order"，httpbin 跳到了 JSON 结果页。
  // 那里的快照只剩一个 `checkbox "Pretty-print"` —— 正确、但**看不出是结果页**。
  // 于是模型以为没提交成功，重新 open 表单、又填了一遍，跑 64 步。
  // 而表单其实早就提交了，服务端也回显了。
  //
  // 只要把「现在在哪个 URL」说清楚，`/post` 这个跳转就是铁证。
  // 这和 §0.1 那次「收口轮说不清你有什么」是同一类：模型不是不会做，是看不见现状。
  // **明说「跳转了」**，不要只丢一个 URL 让模型自己体会。
  //
  // 真机：只给 URL 时模型照样不认;它要的是一句「这一步成功了」。
  // 地址变了 = 动作生效了，这是最硬的证据。
  const moved = nowUrl !== '' && before !== undefined && before !== nowUrl;
  const where =
    nowUrl === ''
      ? ''
      : `\n\n— 当前页面 —\n${nowUrl}` +
        (moved
          ? `\n（操作前是 ${before}，**页面已经跳转**——这说明动作生效了，` +
            '不要重复提交同一步，直接看下面的内容判断结果。）'
          : '');
  if (nowUrl !== '') lastUrlBySession.set(session ?? '', nowUrl);
  const head = r.stdout.trim() === '' ? `已执行 ${action}` : clip(r.stdout.trim());
  const body = tail === '' ? head : `${head}\n\n— 操作后的可交互元素 —\n${tail}`;
  return { ok: true, output: body + where };
}

// ══════════════════════════════════════════════════════════════════
// browser.* 兼容层（2026-10-21，统一到 agent-browser）
// ══════════════════════════════════════════════════════════════════
//
// ## 为什么保留这层
// 容器里那五个 browser.* 还在（playwright 驱动），但它们只能猜 CSS 选择器。
// 宿主侧的 hostTools 优先于容器分发（ExecService.runTool 先查 this.hostTools），
// 所以在这里注册同名工具就等于**覆盖**容器实现，既统一到一条路径，又不必删
// 容器里的代码（回滚容易）。
//
// ## 参数为什么这么怪
// browser.act 的老形状是 `{action, selector, value}`，模型已经按这个习惯调用
// （历史对话里都是）。语义上 selector 和 @eN 引用是一回事——agent-browser 的
// click/fill 本来就接受任意选择器，`@e1` 只是它自己的简写。所以直接透传，
// 模型写 @e1 也行，写 `button.submit` 也行，不用改习惯也不用改 schema。
//
// identity 语义完全照抄 src/runner/dot.ts 的 resolveBrowserIdentity：
// 显式传就用显式的，anon 走无痕，缺省按域名给 site:<host> 做持久登录态。

// ── 截图落盘：写进容器的 home 卷，保住 A3「截图随回复推送」 ──────────────
//
// 为什么不能随便存个临时路径：`src/surfaces/screenshot-push.ts` 只认
// `/dot/home/screenshots/*.png`，并靠 `MemoryService.readHomeFile` → bridge
// 从容器 home 卷读字节再推飞书。容器版 browser.screenshot 就是照这个约定做的；
// 宿主版如果只顾着"存下来就行"，那条推送会静默失效（不报错，只是永远收不到图）。
//
// 桥只能读（FsOpsBridge 只有 read/list/stat/rename），但 `/dot/home` 是 docker
// volume，挂到宿主就是普通目录 —— 于是让截图直接写到卷里，路径用
// `docker inspect` 按容器名+挂载点动态解析，不写死 `/var/lib/docker`（root 可能
// 被改、多 dot 时卷名也不同）。
const SCREENSHOT_DIR_IN_HOME = '/dot/home/screenshots';

/** 文件字节数；拿不到返回 null（只用于回包里的 bytes 字段，不阻断流程）。 */
async function statSize(abs: string): Promise<number | null> {
  const r = await new Promise<string>((resolve) => {
    execFile('stat', ['-c', '%s', abs], { timeout: 10_000, windowsHide: true }, (err, stdout) =>
      resolve(err === null ? String(stdout ?? '').trim() : ''),
    );
  });
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 解析 dot 的 home 卷在宿主上的真实路径；拿不到返回 null（不影响截图本身）。 */
async function hostHomeDir(dotId: string): Promise<string | null> {
  const container = `dotd-dot-${dotId}`;
  const out = await new Promise<string>((resolve) => {
    execFile(
      'docker',
      ['inspect', container, '--format', '{{range .Mounts}}{{if eq .Destination "/dot/home"}}{{.Source}}{{end}}{{end}}'],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => resolve(err === null ? String(stdout ?? '').trim() : ''),
    );
  });
  return out === '' ? null : out;
}

/** browser.act 的 action → agent-browser 子命令。submit 拆成 click 同义处理。 */
const LEGACY_ACTIONS: Record<string, string> = {
  click: 'click',
  type: 'type',
  fill: 'fill',
  submit: 'click',
  select: 'select',
  scroll: 'scroll',
  wait: 'wait',
};

/**
 * browser.* 统一入口：把老参数形状翻译成 web.* 的实现。
 *
 * 这一个函数覆盖 open/snapshot/act/screenshot/close 五个名字，
 * 因为它们的差异只在"翻译成哪条命令"。
 */
export async function legacyBrowser(
  tool: 'browser.open' | 'browser.snapshot' | 'browser.act' | 'browser.screenshot' | 'browser.close',
  args: Record<string, unknown>,
  taskKey?: string,
): Promise<WebResult> {
  const session = sessionOf(identityOf(args, taskKey));

  if (tool === 'browser.open') {
    const rawUrl = typeof args['url'] === 'string' ? args['url'] : '';
    if (rawUrl === '') return { ok: false, error: 'browser.open 需要 url' };
    const url = safeUrl(rawUrl);
    if (url === null) return { ok: false, error: `只支持 http(s) URL，收到：${rawUrl}` };
    // 2026-10-22 真机缺陷：**冷启动 + 首次导航叠在一起会超时**，慢站一律打不开。
    //
    // 现场：https://www.scrapingcourse.com/ecommerce/ 用 curl 只要 6.5s（HTTP 200），
    // 但 browser.open 稳定在 27~28s 报
    //   `Operation timed out. The page may still be loading or the element may not exist.`
    // 紧接着 browser.snapshot 返回 `(no interactive elements)` / `(empty page)` ——
    // 看起来像「网站有问题」或「网络不通」，实测两者都不是。
    //
    // 手动拆开就成功（同一 URL、同一 session）：
    //   open about:blank   → ✓ launched browser（把冷启动这一步单独吃掉）
    //   open <url>         → ✓ Ecommerce Test Site to Learn Web Scraping
    // 说明超时的不是网络，是 agent-browser 内部对**单次 open 动作**的固定预算
    // （实测卡在 27~28s，且 AGENT_BROWSER_DEFAULT_TIMEOUT 设成 3s 也不影响快站，
    //  设成 120s 也不放宽慢站 —— 即该变量在本版本被忽略，别指望它）。
    //
    // 修法：**先无 URL 起一次浏览器把冷启动分离出去**，再导航。
    // 代价是多一次子进程调用（约几十毫秒）；收益是所有慢站都能打开。
    // 已起过的 session 上是幂等的（open 无 URL 只是确保浏览器在跑）。
    const boot = await run(['open'], session);
    if (isFailure(boot)) return failureOf(boot);
    const r = await run(['open', url], session);
    if (isFailure(r)) return failureOf(r);
    // 老的 browser.open 返回 {url,title}；这里给同样的信息，历史调用方不用改。
    const title = r.stdout.trim().split('\n')[0]?.replace(/^[\s✓]+/, '') ?? '';
    return {
      ok: true,
      output: JSON.stringify({ url, title: title === '' ? url : title }),
    };
  }

  if (tool === 'browser.snapshot') {
    // 老接口没 url（沿用当前页），selector 参数用于局部截图——agent-browser 的
    // snapshot 不支持局部，忽略它比报错好（模型常在参数里多带一个 selector）。
    return webSnapshot({ identity: identityOf(args, taskKey) });
  }

  if (tool === 'browser.screenshot') {
    // 存进容器 home 卷，保住 A3「截图随回复推送」（screenshot-push 只认
    // /dot/home/screenshots/*.png）。dotId 从任务名反推不出来，用 daemon 侧的
    // 单 dot 约定：容器名 dotd-dot-<dotId>，通常就是配置里的第一个 dot。
    const dotId = typeof args['dot_id'] === 'string' ? args['dot_id'] : 'dot1';
    const home = await hostHomeDir(dotId);
    if (home === null) {
      // 拿不到卷路径不阻断截图：退回 agent-browser 自己的临时目录，
      // 并在返回里说清"这张图不会被自动推送"，别让人以为推送坏了。
      const r = await run(['screenshot'], session);
      if (isFailure(r)) return failureOf(r);
      return {
        ok: true,
        output: `${r.stdout.trim()}\n（提示：没能定位容器 home 卷，此图不会随回复自动推送）`,
      };
    }
    const name = `shot-${Date.now().toString(36)}.png`;
    const abs = `${home}/screenshots/${name}`;
    const r = await run(['screenshot', abs], session);
    if (isFailure(r)) return failureOf(r);
    // 与容器版同形：{path: '/dot/home/screenshots/...'}，screenshot-push 靠这个字段取值
    const homePath = `${SCREENSHOT_DIR_IN_HOME}/${name}`;
    const size = await statSize(abs);
    return {
      ok: true,
      output: JSON.stringify({ path: homePath, bytes: size === null ? undefined : size }),
    };
  }

  if (tool === 'browser.close') {
    const r = await run(['close'], session);
    // 页面关了，继承就没意义了；不清会让下一次 snapshot 指向一个已销毁的 session
    if (taskKey !== undefined) lastIdentityByTask.delete(taskKey);
    if (isFailure(r)) return failureOf(r);
    return { ok: true, output: '已关闭' };
  }

  // browser.act
  const action = typeof args['action'] === 'string' ? args['action'] : '';
  const cmd = LEGACY_ACTIONS[action];
  if (cmd === undefined) {
    return { ok: false, error: `browser.act 不支持 action=${action}（可用：${Object.keys(LEGACY_ACTIONS).join('/')}）` };
  }
  const selector = typeof args['selector'] === 'string' ? args['selector'] : '';
  const value = typeof args['value'] === 'string' ? args['value'] : '';

  const argv: string[] = [cmd];
  if (cmd === 'wait') {
    // 老的 wait 可以等时间或等元素；agent-browser 的 wait 两者都收。
    argv.push(selector === '' ? '500' : selector);
  } else if (cmd === 'scroll') {
    argv.push(value === '' ? 'down' : value);
  } else {
    if (selector === '') return { ok: false, error: `browser.act 的 ${action} 需要 selector` };
    if (value !== '') argv.push(selector, value);
    else argv.push(selector);
  }

  const r = await run(argv, session);
  if (isFailure(r)) return failureOf(r);
  return { ok: true, output: r.stdout.trim() === '' ? `已执行 ${action}` : clip(r.stdout.trim()) };
}
