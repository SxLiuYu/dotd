/**
 * src/runner/tool-catalog.ts —— Runner 私有的「给模型看的工具说明书」。
 *
 * 定位（CONVENTIONS.md §4 模块边界表）：Runner = `src/runner/`；本文件只被
 * `dot.ts` 的 `toolSpecs()` 消费，**不对外导出契约、不进 shared/exec/agent-runtime**。
 *
 * 为什么要有它：契约层（`src/exec/protocol.ts` 的 CAPABILITY_CATALOG）给的是
 * JSON Schema，模型从 schema 只能看出「有 path 这个字段」，看不出「什么时候该用它、
 * 路径怎么写、失败长什么样」。schema 是给校验器看的，description 是给模型看的——
 * 两者职责不同，故分开维护，schema 仍逐字透传 CAPABILITY_CATALOG（不在此处复制）。
 *
 * 内容口径（**每一条都必须能在仓库里找到出处，禁止编造**）：
 * - 参数名/必填：以 `/capabilities` 真实返回的 `args_schema.properties/required` 为准；
 *   宿主（`src/exec/protocol.ts`）与容器（`agent-runtime/protocol.ts`）两份目录
 *   有差异，`toolDescriptionFor()` 会自动剔除当前 schema 里不存在的参数行——
 *   宁可不提，也不教模型填一个会被 `additionalProperties:false` 拒掉的字段。
 * - 成功/失败形状：`agent-runtime/fs.ts`、`shell.ts`、`server.ts`（真容器）与
 *   `src/exec/stub-runtime.ts`（stub 容器）两套实现的**交集**。
 * - 错误码：`agent-runtime/protocol.ts` 的 ERROR_CODES + stub 侧同码名。
 *
 * 单测：`tests/runner-tool-catalog.test.ts`（11 个工具全覆盖、参数名防编造、
 * 不含模板串、长度上限、system prompt 进 messages[0]）。
 */

import type { Capability } from '../shared/contracts.ts';

/** 一个工具在 prompt 里的完整说明书。 */
export interface ToolDoc {
  /** 工具名（= 契约词表 11 名之一）。 */
  name: string;
  /**
   * 工具描述（ToolSpec.description）。写法：一句"干什么"，再"何时用/何时别用"、
   * "典型调用"、"限制"。不写"这是 X 工具"这类废话。
   */
  description: string;
  /**
   * 参数逐条说明（参数名 → 一行说明）。**只写真实存在的问题**：
   * 渲染时会与当前 schema 求交，schema 里没有的键一律丢弃。
   */
  params: Record<string, string>;
  /** 参数说明之后追加的"调用形态/取值约定"，用于 enum、组合约束这类一行装不下的信息。 */
  notes?: string[];
  /** 成功返回什么（给模型读的一行）。 */
  returns: string;
  /** 失败返回什么（错误码 → 该怎么处理）。 */
  failures: string;
}

/**
 * 容器 home 根（EX §7）。与 `src/exec/protocol.ts` 的 HOME_ROOT 同值；
 * 跨模块不 import 实现，故此处字面量 + 单测断言一致。
 */
export const HOME_ROOT = '/dot/home';

/** 错误码词表里与本说明书相关的几条（agent-runtime/protocol.ts ERROR_CODES 同名字面量）。 */
export const TOOL_ERROR_HINTS: Readonly<Record<string, string>> = {
  not_a_file: '路径不存在或不是常规文件 —— 先用 fs.list 确认目录里有什么，别猜文件名',
  not_found: '文件不存在 —— 先 fs.list / fs.stat 确认，再决定是新建还是换路径',
  not_a_directory: '目标不是目录 —— fs.list 只枚举目录',
  path_outside_home: '路径越出 /dot/home —— 换成 home 内路径重试',
  path_hidden: '/dot/home/.dotd 下是被隐藏的内部保留区，不可访问，换路径',
  symlink_escape: '路径链到 home 外（symlink）—— 换真实路径重试',
  bad_path: 'path 不是非空字符串 —— 补齐参数',
  bad_args: '参数类型/取值不合法 —— 对照本文说明改正后重试，不要原样重发',
  too_large: '文件超过体积上限 —— 分片处理或换策略，重试无用',
  too_deep: 'fs.list 递归深度超过 4 —— 分层列目录',
  deadline_exceeded: '执行超时（进程组已被 kill）—— 缩小工作量后重试',
  interrupted: '上一次运行被打断、本调用未完成 —— 可安全重试',
  browser_crashed: '浏览器进程崩溃（retryable）—— 下次调用会自动重开，直接重试',
  too_many_pages: '该身份并发页面已达上限 3 —— 先 browser.close 再开新页',
  identity_required: '浏览器类工具缺登录身份 —— 只能以非登录态（匿名）浏览',
  unknown_tool: '工具不在能力目录（治理一律拒绝）—— 换登记过的工具',
};

/** 11 个工具的说明书（顺序与契约词表一致，便于人工核对）。 */
export const TOOL_DOCS: readonly ToolDoc[] = [
  {
    name: 'fs.read',
    description:
      '读取 /dot/home 下的一个文本文件，原样返回全文。任务一开始就应该用它读 MEMORY.md（系统已注入一份，被截断或需要看原文件时再读）；读笔记、读上次留下的手册、核对文件内容都用它。' +
      '只能读文本，不要用它读二进制；一次只能读一个文件，要遍历目录先 fs.list。它不返回"第几行到第几行"，大文件请用 shell.run 配合 head/sed 截取。',
    params: {
      path: '要读的文件路径，写 home 内相对路径（如 MEMORY.md、notes/2026-10-15-x.md、reports/a.txt）。不要写 /dot/home/... 开头的绝对路径。',
    },
    returns:
      '返回值是 JSON：path（home 内相对路径）、size_bytes、content（UTF-8 全文）、truncated（恒为 false，超 4MB 直接报错而不是截断）。',
    failures:
      'not_a_file（不存在或不是文件）、too_large（>4MB）、path_outside_home / path_hidden / symlink_escape（路径不合法）。' +
      '读不到时先 fs.list 看目录，不要换个拼写反复试同一个路径。',
  },
  {
    name: 'fs.write',
    description:
      '把一段 UTF-8 文本整体写进 /dot/home 下的文件，**覆盖**同路径原有内容，父目录不存在会自动创建。' +
      '任务结束时把值得留到下次的东西写进 notes/ 或 manuals/，以及维护 MEMORY.md 索引，都靠它。' +
      '注意它是覆盖不是追加：改已有文件要先 fs.read 出原文，在内存里改好再整篇写回（否则会丢内容）；只追加一行用 shell.run 的 `>>` 更省事。' +
      '**改已有文件时请传 expected_size**（就是 fs.read 返回的 size_bytes）：万一你读完之后别人改过这个文件，' +
      '写入会被拒（stale_write）而不是默默覆盖掉对方的改动——重新读一遍再改即可。这个参数在多个任务并发时就靠它防丢数据。' +
      '**MEMORY.md 有固定结构，别往末尾随便追加**（2026-10-18 实测：直接 append 会把内容塞进最后一个 \'## Pointers\' 段，把索引搞乱）：' +
      '文件是 `# MEMORY (index)` / `updated: <ISO时间>` / `## Interests` / `## Current concerns` / `## Pointers` 五部分；' +
      '要记的事追加到 **`## Current concerns` 段末尾**（写成 `- 一句话 → notes/xxx.md`）；' +
      '`## Pointers` 只放指向 notes 的路径条目；同时把 `updated:` 改成当前时间。',
    params: {
      path: '目标文件路径，**写 home 内相对路径**（如 reports/weekly.md、notes/2026-10-18-review.md）。父目录不必先建，会自动创建。' +
        '/dot/home/... 开头也接受（会被规范成同一个文件，2026-10-18 起读写一致），但写相对路径更短。' +
        '**notes/ 下的文件名有硬规范**：必须是 YYYY-MM-DD-短横线-slug.md（例：notes/2026-10-18-model-e2e.md），否则会被拒；' +
        '其它目录（reports/、tmp/、work/ 等）没有命名要求。被拒时读 warning 里的原因，按它改路径再写一次。',
      content: '要写入的完整 UTF-8 文本。必须是整篇文件的最终内容，不是"要追加的那段"。',
      expected_size:
        '可选。修改已有文件时传 fs.read 返回的 size_bytes 做乐观锁：' +
        '若文件在此期间被别人改过，写入会被拒（stale_write）而不是默默覆盖对方改动。新建文件传 0。',
    },
    returns: '返回值是 JSON：path（home 内相对路径）、size_bytes（写入字节数）、written_at（ISO 时间）。',
    failures:
      'bad_args（content 不是字符串）、too_large（>8MB）、路径类错误同 fs.read。' +
      '另有一种特殊失败：记忆层判定该文件超硬限时，工具根本不会被派发，你会收到 memory_rejected（如 HARD_LIMIT）——' +
      '这时应拆分文件或改成追加到更小的文件，而不是改写同样大的内容再试。',
  },
  {
    name: 'fs.list',
    description:
      '列出一个目录里有什么（文件名、类型 file/dir、字节数），按名字排序。' +
      '读文件前不确定路径、不确定笔记放在哪、想看看上次留下了什么，先 fs.list 再动手，比盲猜路径省一整轮。' +
      '它只列目录，不读内容；最多递归 4 层，单次最多返回 2000 条（超了 truncated=true）。',
    params: {
      path: '要枚举的目录，写 home 内相对路径；列整个家目录就写 .（一个点）。不要写 /dot/home 绝对路径。',
      depth: '递归深度，整数 1–4，缺省 1 = 只看这一层。目录不深时直接用 2，省一次调用。',
    },
    returns:
      '返回值是 JSON：path、entries[]（每项 name / path / type: file|dir / size_bytes，目录没有 size_bytes）、truncated。',
    failures: 'not_a_directory（路径是文件或不存在）、too_deep（depth>4）、路径类错误同 fs.read。',
  },
  {
    name: 'fs.remove',
    description:
      '删除 home 里的一个文件或空目录。**删除前会自动把旧内容存进 .archive/ 一次**，删错了能捞回来。' +
      '目录只允许删空的（非空会报 not_empty）——避免一条命令删掉整个目录树。' +
      '主人说"删掉那个文件""清理一下"时用它；只是想清空内容不想删文件，用 fs.write 写空串。',
    params: {
      path: 'home 内相对路径。要删整个非空目录，先逐个删里面的文件。',
    },
    returns: '返回 JSON：path、removed、archivedTo（归档到哪了，.archive/ 下）、note。',
    failures: 'not_a_file（本来就不存在）、not_empty（目录非空）、path_outside_home（越界）。',
  },
  {
    name: 'fs.stat',
    description:
      '查单个路径的元信息：是文件还是目录、多大、最后修改时间。' +
      '两种情况用它：① 写之前先确认文件存在不存在（决定走 fs.write 新建还是先 fs.read 再覆盖）；② 判断记忆/笔记是不是过期了（mtime）。' +
      '要内容就 fs.read，fs.stat 只给元信息。',
    params: {
      path: '要查的路径，写 home 内相对路径（文件或目录都可以）。不要写 /dot/home/... 绝对路径。',
    },
    returns: '返回值是 JSON：path、type（file|dir）、size_bytes、mtime（ISO 时间）、mode（Unix 权限位数字）。',
    failures: 'not_a_file（路径根本不存在）、路径类错误同 fs.read。',
  },
  {
    name: 'shell.run',
    description:
      '**动手前先想一句：我已造的工具里有没有能干这事的？** 有就先用 tool.invoke 调它，别用 shell 重写一遍。' +
      '（已造工具清单在上下文里，或随时 tool.list 查。）' +
      '在容器里执行一条 bash 命令（`bash -c`，工作目录是 /dot/home，无 TTY），返回退出码与 stdout/stderr。' +
      '适合：grep 搜内容、按行截取大文件、统计/排序、批量处理、装在本机工具链里的命令行工具。' +
      '简单读一个文件用 fs.read 更快更省；fs.read 读不动的大文件、需要"按条件筛"时才用 shell。' +
      '**文件系统边界（重要）**：shell 能读整个**容器**文件系统（/etc、/usr 等都在），' +
      '而 fs.* 只能读写 /dot/home。所以 fs.read 报 path_outside_home 时，如果确实要看容器内的系统文件，' +
      '可以用 shell；但**主人家的文件（/root、dotd.db、密钥）在容器里看不见**，那是宿主，别去试。' +
      '限制：环境变量只有 PATH/HOME/LANG/DISPLAY/SHELL（家里拿不到任何密钥）；**不能联网**（没有 curl 到外网的通道，要联网用 net.*）；' +
      'stdout/stderr 各截断 1MB；timeout_ms 必填且到时整组进程会被 SIGKILL。命令里出现 rm/sudo/docker/`> /dev/` 会触发人工审批，任务会挂起等主人，能用 fs.* 就别写 rm。',
    params: {
      cmd: '完整的 bash 命令串（可以带管道、&&、重定向）。例：`grep -rn "关键词" notes/ | head -50`。不要在 cmd 里再套一层 `bash -c`。',
      timeout_ms: '整数毫秒，必填。按真实预期给（grep 几秒就够，批量处理给足），超时即杀。必须 ≤ 本次调用的硬截止（正常装配下为 60000）。',
      cwd: '可选，命令的工作目录（home 内的绝对或相对路径）；不写就是 /dot/home。',
    },
    returns:
      '返回值是 JSON：exit_code（整数，被杀时为 null）、signal、stdout、stderr、stdout_truncated / stderr_truncated（是否被 1MB 截断）、uid、degraded。' +
      '**退出码非 0 也是 status=ok**——要自己看 exit_code 和 stderr 判断命令是否真的成功。',
    failures:
      'bad_args（缺 timeout_ms / timeout_ms 超过 deadline）、deadline_exceeded（超时被杀）、路径类错误（cwd 不合法）。',
  },
  {
    name: 'browser.open',
    description:
      '在容器内的真实 Chromium（已装反检测隐身插件、有图形显示）里打开一个 http(s) 网址，返回最终 URL 与页面标题。' +
      '需要点按钮、填表单、看登录后的页面、抓渲染后的内容时才用它；能用 net.get 直接拿到 JSON/HTML 的接口就别开浏览器（慢且吃内存）。' +
      '每调用一次就进入"这个身份的浏览器会话"：登录态按身份持久保存在 profile 卷里，下次调用还在。' +
      '跑完记得 browser.close：每个身份最多 2 个浏览器上下文、3 个页面，不关会被回收或撞上限。',
    params: {
      url: 'http(s) 开头的完整网址。只接受 http/https，不能是 file:// 或 data:。',
      identity: '浏览器身份；不填=按域名自动持久登录态，anon=无痕',
    },
    returns: '返回值是 JSON：url（跳转后的最终地址）、title（页面标题）。页面正文要用 browser.snapshot 拿。',
    failures:
      'bad_args（url 不是字符串）、browser_crashed（进程崩了，retryable，直接重试）、too_many_pages（并发页超限，先 browser.close）、' +
      'identity_required（没给登录身份，被拒）。',
  },
  {
    name: 'browser.act',
    description:
      '在已打开的页面上做一个动作：点击、输入、按键、下拉选择、滚动、等待。' +
      '必须先 browser.open（否则没有页面可用）；每次动作前最好先 browser.snapshot 看结构，动作后也要 snapshot 确认结果——' +
      '网页会异步加载，点完立刻断言往往读到旧内容（必要时先 act wait 等一下）。' +
      '定位只认 CSS 选择器；用 `text=提交` 这种 Playwright 角色写法不稳定，优先 `#submit`、`button[type=submit]`、`input[name=q]` 这类确定的选择器。',
    params: {
      action: '动作名，只能是 click | type | press | select | scroll | wait 之一（见下方约定）。',
      selector: 'CSS 选择器，如 `#login`、`input[name="q"]`、`button.submit`。click / type / press / select 必填；scroll / wait 不需要。',
      value: 'type = 要填的文本；press = 按键名（如 Enter、Escape）；select = 选项 value。click / scroll / wait 忽略此参数。',
      timeout_ms: '可选，本动作的等待上限（毫秒）；不写时 scroll 默认滚动 800 像素、wait 默认等 1000 毫秒。',
    },
    notes: [
      'wait：不传 selector 时只等待；配合 timeout_ms 当"等一下再截图"用。',
      '点击/输入后页面若跳转或重绘，下一轮先 browser.snapshot 再决定下一步。',
    ],
    returns:
      '返回值是 JSON，随动作不同：click → {clicked}、type → {filled}、press → {pressed, key}、select → {selected, value}、scroll → {scrolled}、wait → {waited_ms}。',
    failures:
      'bad_args（action 不在枚举内 / 缺 selector / 缺 value）、browser_crashed（retryable）。' +
      '找不到元素通常表现为动作超时后 browser_crashed——先把选择器改准再重试，别原样循环。',
  },
  {
    name: 'browser.snapshot',
    description:
      '取当前页面的可读快照（页面结构/无障碍树的文本形式），用来"看"页面：按钮叫什么、输入框在哪、列表里有哪些项。' +
      'browser.open 之后、以及每次 browser.act 之后都应该用它确认状态，这是浏览器流程里唯一的"读"动作。' +
      '它不返回截图图片，返回的是文本结构。',
    params: {
      selector: '可选的 CSS 选择器，只看某一块区域（如 `#main`、`div.list`）。整页看就省略。',
    },
    returns: '返回值是 JSON：text（可读快照文本），部分实现另带 html（简化后的 DOM）。',
    failures: 'browser_crashed（retryable）。没有打开页面时也返回 ok，但 text 为空——先 browser.open。',
  },
  {
    name: 'browser.screenshot',
    description:
      '把当前页面截成 PNG 图片存到 home 的 screenshots 目录，随回复自动推送给主人看。' +
      '适合"让主人看见网页长什么样"的场景：填好的表单、查到的账单页面、比价结果页。' +
      '截图是文件不是文本，要读页面内容仍用 browser.snapshot。',
    params: {},
    returns: '返回值是 JSON：path（PNG 在 home 里的路径）、bytes（字节数）、sha256。图片本体不进对话。',
    failures: 'browser_crashed（retryable）。没有打开页面时报错。测试桩页面不支持时返回 bad_args。',
  },
  {
    name: 'browser.close',
    description:
      '关闭当前身份的浏览器上下文，释放内存。' +
      '浏览器流程做完就调一次；**profile 目录留在卷上，登录态不会丢**，下次 browser.open 还是登录的。' +
      '不调也不报错，但占用会被计数（每身份 3 页上限），后续开页可能撞 too_many_pages。',
    params: {},
    returns: '返回值是 JSON：closed: true。',
    failures: '极少失败；浏览器已崩溃时也返回成功（幂等）。',
  },
  {
    name: 'net.get',
    description:
      '发一个 HTTP GET 取数据，适合调 JSON API、抓静态页面源码、看某个 URL 的响应头。' +
      '能直接拿到数据的接口一律用它，比开浏览器快一个数量级；需要执行页面 JS、要携带登录 Cookie 的，才退回 browser.*。' +
      '**注意：出网默认是关的**——主人没开时你会收到 net_tools_disabled，那就改用 shell / browser 或直接告诉主人"需要我联网查吗"。',
    params: {
      url: '完整的 http(s) 网址，查询参数直接写在 URL 上（如 ?q=x&limit=5）。',
      headers: '可选，一个键值对象，如 {"accept":"application/json"}。只认 accept / accept-language / content-type / user-agent / cache-control 等无害头。',
    },
    returns:
      '返回值是 JSON：url、status（HTTP 状态码）、contentType、headers、body（响应体文本）、bodyTruncated（是否因超过 4MB 被截断）。' +
      '3xx 不会自动跟随，会额外给 redirect 字段告诉你跳去哪。',
    failures:
      'net_tools_disabled（主人没开联网，**别再重试**，换个办法或问主人）、net_post_disabled（只开了只读）、' +
      'net_bad_url（不是 http/https 或内嵌账号密码）、net_blocked_host（目标是本机/内网/元数据地址，被拒）、' +
      'net_timeout（超时，可重试）、net_network_error（DNS/连接失败）、net_too_large（响应过大）。' +
      '4xx/5xx **不算失败**：那是对方的状态码，照常看 status 与 body。',
  },
  {
    name: 'net.post',
    description:
      '发一个 HTTP POST（JSON 或表单）到外部服务。' +
      '只在确实需要提交数据时用它：它对**外部世界有副作用**（可能下单、发帖、改远端数据），治理会按写操作级别审查，必要时会请主人审批。' +
      '能读就别写；写之前想清楚参数，因为一旦提交，重试可能重复生效。默认只有 DOTD_NET_TOOLS=all 时才可用。',
    params: {
      url: '完整的 http(s) 网址。',
      body: '请求体字符串。发 JSON 就自己序列化成字符串，并配 Content-Type 头。',
      headers: '可选，一个键值对象。发 JSON 记得写 {"content-type":"application/json"}。',
    },
    returns: '返回值是 JSON：url、status、contentType、headers、body、bodyTruncated（同 net.get）。',
    failures:
      'net_tools_disabled / net_post_disabled（主人只开了 GET；**不要绕道**用 shell curl）、net_bad_url、net_blocked_host、' +
      'net_timeout、net_network_error。提交成功但对方报错时看 status 与 body，不要盲目重发。',
  },
  {
    name: 'schedule.create',
    description:
      '创建一个**定时任务**：到点后自动以一条新任务的形式执行你写的 prompt。' +
      '主人说"每天 9 点提醒我……""每周一帮我汇总……""过两小时提醒我……"这类需求时用它。' +
      '注意：它不是闹钟，到点是**真的去执行那件事**（比如去查天气、去读文件），然后通过飞书把结果告诉主人。' +
      'cron 是 5 段（分 时 日 月 周），最短间隔 1 分钟。创建前先想清楚 prompt 写什么——那是将来无人值守时唯一的目标说明。',
    params: {
      title: '这条定时任务的名字，简短好认（如「早间天气」「周报汇总」）。',
      prompt:
        '到点要执行的那件事，写成一句完整任务描述。' +
        '例：「查一下北京今天的天气，用一句话告诉我气温和是否需要带伞」。' +
        '要写得让"将来只有这句话可用"的你也知道该干什么。',
      cron:
        '5 段 cron：分 时 日 月 周。常用例子：' +
        '"0 9 * * *" = 每天 9:00；"30 8 * * 1-5" = 工作日 8:30；"0 */2 * * *" = 每两小时整点。',
      once:
        '一次性任务：传 true 表示**触发成功后就停用**，不再重复。' +
        '主人说"今天下午 3 点提醒我开会"这类只说一次的场景要传它；' +
        '说"每天/每周"的不要传。注意 cron 仍需算出目标时刻 —— ' +
        '比如今天（10月19日）15:00 用 "0 15 19 10 *" 把日、月锁死到具体日期。',
      quiet_hours: "可选。安静时段内不触发，形如 '23:00-07:30'。夜里不想被打扰就传。",
    },
    returns: '返回 JSON：id、title、cron、next_fire_at（下次触发时刻），以及一句确认说明。',
    failures:
      'schedule_invalid（cron 写错/段数不对/间隔太短）。**把 error 里的原话告诉主人**并请他确认时间，不要自己猜着重试。',
  },
  {
    name: 'schedule.remove',
    description:
      '停用一条定时任务（主人说"把那个提醒删了""不用再提醒了"）。' +
      '注意是**停用不是硬删**：这条任务会被标记为不启用，不再触发，但记录还在（管理界面能恢复）。' +
      'id 从 schedule.list 拿；不确定是哪一条就先 list 一遍再删，别猜。',
    params: {
      id: '要停用的定时任务 id（形如 ct_xxx，从 schedule.list 返回里取）。',
    },
    returns: '返回 JSON：id、removed=true、note（说明是停用可恢复）。',
    failures: 'schedule_not_found（没有这条或已经停用了）、schedule_invalid（没给 id）。',
  },
  {
    name: 'schedule.list',
    description:
      '列出已经创建的定时任务（含下次触发时间、上次触发结果）。主人问"我现在有哪些定时任务"时用它。',
    params: {},
    returns: '返回 JSON：count 与 schedules[]（每项含 id、title、cron、next_fire_at、last_fire_status）。',
    failures: '一般不会失败；返回 count=0 说明还没建过。',
  },
  {
    name: 'tool.list',
    description:
      '列出**你已经造出来的工具**。开始一个复杂、可能重复的活之前先看一眼 —— ' +
      '如果之前造过类似的工具，直接 tool.invoke 复用，不要重复造。',
    params: {},
    returns: '返回 JSON：tools[]，每项含 name、description、params（参数说明）、entry、returns。' +
      '带 broken 字段的表示这个工具坏了（manifest 损坏或入口文件缺失），别用。',
    failures: '一般不会失败；tools=[] 表示还没造过工具。',
  },
  {
    name: 'tool.create',
    description:
      '**造一个新工具**：把一段脚本存成可复用的工具，以后同类活直接调用。' +
      '什么时候用：主人交代一个"以后还会重复做"的活（每周抓某个网站、批量处理某类文件、' +
      '固定格式的数据转换），而现有工具做不了 —— 这时应该造工具而不是每次重写脚本。' +
      '什么时候不用：一次性的临时活，直接用 shell.run 跑完就行，不必沉淀。' +
      '脚本约定：从 argv[1] 读一个 JSON 拿参数；结果打到 stdout；exit 0 = 成功。',
    params: {
      name: '工具名：小写字母开头，只含小写字母/数字/连字符，2-40 字符（如 fetch-jobs）。',
      description: '这个工具干什么 —— 以后靠这句话决定何时复用，要写具体（别写"处理数据"，写"从某招聘网站抓前端岗位并按城市分组"）。',
      script: '实现代码。从 argv[1] 读 JSON 参数，结果打 stdout，exit 0 表示成功。',
      entry: '入口文件名，默认 run.sh；按扩展名选解释器（.sh→bash / .py→python3 / .mjs→node）。',
      params: '参数说明 JSON（可选），形如 {"url":"要抓的网址"} —— 帮助以后的你正确调用。',
      returns: '返回什么（可选，一句话）。',
    },
    returns: '返回 JSON：manifest（工具定义）与 path（落盘位置）。同名已存在时覆盖，旧版本自动进 .archive/。',
    failures: 'tool_create_invalid（名字不合法 / description 或 script 为空 / entry 带路径）。' +
      '注意：这个操作需要主人审批一次。',
  },
  {
    name: 'tool.invoke',
    description:
      '**调用一个你已经造好的工具**。开始活之前先 tool.list 看看有没有能用的，有就直接复用。',
    params: {
      name: '要调用的工具名（从 tool.list 拿）。',
      args: '传给工具的参数 JSON 对象，会原样作为 argv[1] 传进去。',
    },
    returns: '返回 JSON：ok、exitCode、stdout、stderr、truncated（输出超 32KB 被截断）、elapsedMs。',
    failures: 'tool_not_found（没这个工具，先用 tool.list 确认）、超时（默认 60s）。' +
      '工具有 stderr 且 exitCode≠0 时，把 stderr 原样告诉主人，别自己编原因。',
  },
      {
        name: 'mail.account.add',
        description:
          '接入一个邮箱账号（IMAP 收信 + SMTP 发信），凭证 AES-256-GCM 加密入库。' +
          '主人说"把我的 163 邮箱接进来/帮我把 QQ 邮箱配上"时用它。' +
          '网易 163/126/yeah 这类国内邮箱**不能用登录密码**，要网页版设置里开的' +
          '「客户端授权码」；QQ 邮箱同理是授权码。密码只出现在这次调用里，' +
          '之后库里只有密文，日志和回复里都不会再出现。加完账号不会立刻验证，' +
          '第一次 mail.list 才是真验证。',
        params: {
          label: '账号显示名，之后所有 mail.* 都用它指代这个账号。简短好认：如 "163"、"工作邮箱"。',
          email: '邮箱地址，如 user@163.com。也是 IMAP/SMTP 的登录用户名。',
          imapHost: '收信服务器，如 imap.163.com、imap.qq.com。',
          smtpHost: '发信服务器，如 smtp.163.com、smtp.qq.com。',
          password: '密码或客户端授权码。网易 163 必须用授权码（网页版 设置 → POP3/SMTP/IMAP → 开启并新增授权密码），登录密码会直接被拒。',
          imapPort: '可选。IMAP 端口，缺省 993（SSL）。',
          smtpPort: '可选。SMTP 端口，缺省 465（SSL）。',
        },
        returns: '返回 JSON：id（账号 id）、label、email，确认凭证已加密存储。',
        failures:
          'BAD_ARG（缺参数）。添加本身不会试连——连不上/凭证错会在第一次 mail.list 时报错，把 error 原话告诉主人。',
      },
      {
        name: 'mail.account.list',
        description:
          '列出已接入的邮箱账号：label、email、IMAP/SMTP 服务器和端口。' +
          '主人问"我接了哪些邮箱"、或你要替它调 mail.list 之前不确定 label 叫什么时用它。' +
          '不联网、纯查库，永远安全。',
        params: {},
        returns: '返回 JSON：count 和 accounts 数组（id/label/email/imap/smtp/status）。',
        failures: '几乎不失败。列表为空说明还没接过任何邮箱，建议主人用 mail.account.add 接入。',
      },
      {
        name: 'mail.account.remove',
        description:
          '移除一个已接入的邮箱账号，连同它的加密凭证一起删。' +
          '主人说"把 xx 邮箱移除/别再连那个邮箱了"时用。' +
          '不确定 label 叫什么就先 mail.account.list 看一眼，别按猜测的名字删。',
        params: { account: '要移除的账号 label 或 id。' },
        returns: '返回 JSON：removed: true/false。false = 没找到这个账号。',
        failures: 'BAD_ARG（缺 account）。',
      },
      {
        name: 'mail.list',
        description:
          '列出某邮箱收件箱**最近**的邮件（主题/发件人/日期/UID），不读正文。' +
          '主人说"看看有什么邮件/收件箱有什么新的"就用它；要读某一封的正文再用 mail.read。' +
          '第一次对某账号调用时会做真实 IMAP 登录——这一步就是凭证验证。',
        params: {
          account: '账号 label 或 id，如 "163"。',
          limit: '可选。拉几封，缺省 20，最多 50。主人只要"最近的几封"就传 5。',
        },
        returns: '返回 JSON：邮件数组（uid/subject/from/date/seen）。按时间倒序。',
        failures:
          '账号不存在（先 mail.account.list）；IMAP 登录失败——凭证错或被服务商风控（163 报 Unsafe Login 之外的拒绝时如实转述）。',
      },
      {
        name: 'mail.read',
        description:
          '读一封邮件的完整内容：正文（纯文本）+ 附件名列表。' +
          '必须先有 mail.list 或 mail.search 给的 uid。' +
          '主人说"读一下那封 xx/第一封说了什么"时，先 list 拿 uid 再 read。',
        params: {
          account: '账号 label 或 id。',
          uid: '邮件 UID，从 mail.list / mail.search 的结果里原样拿，别自己编。',
        },
        returns: '返回 JSON：完整邮件（subject/from/to/date/text 正文/attachments 附件名）。',
        failures: 'BAD_ARG；uid 不存在（换 mail.list 重新拿）。正文过长时会被截断。',
      },
      {
        name: 'mail.search',
        description:
          '在某邮箱里按关键词搜邮件。适合"找一下 xx 发给我的那封/搜一下发票"' +
          '这类不是"最近几封"而是"找特定邮件"的场景。搜完要读正文就接着用 mail.read。',
        params: {
          account: '账号 label 或 id。',
          keyword: '关键词。会去匹配主题/发件人/正文。主人给的是人名就传人名，是项目名就传项目名。',
          limit: '可选。最多返回几封，缺省 20。',
        },
        returns: '返回 JSON：命中的邮件数组（uid/subject/from/date），同 mail.list 形状。',
        failures: 'BAD_ARG（缺 keyword）；账号不存在（先 mail.account.list）。',
      },
      {
        name: 'mail.draft',
        description:
          '起草一封邮件（**不发送**）：建一份草稿存进库里，返回草稿 id。' +
          '主人说"帮我给 xx 写个邮件说 yy"，先起稿给他/她过目；' +
          '要真的发出去必须再走 mail.send（那是 dangerous 工具，会弹审批卡片）。' +
          '正文写前先想清楚称呼、正文、落款；主人没给的信息别编。',
        params: {
          account: '用哪个账号发（label 或 id）。没有就先问主人用哪个邮箱发。',
          to: '收件人邮箱数组，如 ["a@b.com"]。多个收件人就传多个。',
          subject: '主题。一句话说清来意，别空着。',
          body: '正文（纯文本）。分段落写，结尾按主人的习惯落款。',
        },
        returns: '返回 JSON：draftId、to、subject，确认草稿已存。',
        failures: 'BAD_ARG（缺参数/to 为空）。',
      },
      {
        name: 'mail.send',
        description:
          '把一份草稿**真正发出去**。dangerous：邮件发出去收不回来，收件人是外部的人。' +
          '只在主人明确说"发"之后调用；系统的审批闸门会先弹卡片给主人确认，' +
          '你被批准后才会真正发送。发完把结果（message-id）告诉主人。',
        params: { draftId: '草稿 id，从 mail.draft 的返回里拿。' },
        returns: '返回 JSON：sent: true、messageId（SMTP 收据）。',
        failures:
          '草稿不存在或已发送；SMTP 认证失败（授权码不对/端口错）——如实转述 error，别假装发出去了。',
      },
      {
        name: 'calendar.add',
        description:
          '往主人的**本地日历**加一条日程（订阅来的 .ics 日历只读，加不进去）。' +
          '主人说"帮我记一下周三下午 3 点和产品评审/加个日程"时用它。' +
          '时间三种写法：带时区的 ISO（2026-10-25T09:00:00+08:00，最稳）、本地时刻（2026-10-25 09:00）、全天（2026-10-25）；' +
          '结束时给 end 或 durationMin（分钟），都不给按 1 小时算。' +
          '同 标题+开始+结束 的事件已存在时直接返回已有那条，不重复加 —— 放心重试。',
        params: {
          summary: '日程标题，一句话，如 "周会"、"看牙"。别空着。',
          start: '开始时间，三选一：2026-10-25T09:00:00+08:00（带时区）/ 2026-10-25 09:00（本机时区）/ 2026-10-25（全天）。',
          end: '可选。结束时间，写法同 start；与 durationMin 二选一。',
          durationMin: '可选。时长按分钟给，如 90。缺省 60。',
          location: '可选。地点，如 "会议室 A"。',
          notes: '可选。备注，存进事件描述；放会议链接、议程这类信息。',
        },
        returns:
          '返回 JSON：event（uid/summary/startMs/endMs/allDay/location/source=local）、duplicate（true=已存在未重复加）、text（含冲突提示）。' +
          'uid 留好 —— calendar.edit / calendar.delete 都要用它。',
        failures:
          'BAD_ARG：时间写法认不出（按三种写法重写再试）、durationMin 不是正整数、结束早于开始、summary 为空。' +
          '写文件失败会返回系统错误原文 —— 如实转告主人，别假装加上了。',
      },
      {
        name: 'calendar.edit',
        description:
          '改一条**本地日历**事件的标题/时间/地点/备注。只改得动 source=local 的事件：' +
          '订阅来的 .ics 是别人系统的投影，本工具改不了它，别拿订阅事件的 uid 来试。' +
          '主人说"把周会改到 4 点/那条日程地点换成 xx"时用。给哪个字段改哪个，没给的不动；' +
          '只改 start 而不给 end/durationMin 时，事件按原时长整体平移。',
        params: {
          id: '事件 id，从 calendar.add 的返回或 calendar.list 结果里拿。',
          summary: '可选。新标题，一句话讲清楚改完叫什么，如 "周会（改）"。',
          start: '可选。新开始时间，写法同 calendar.add。',
          end: '可选。新结束时间，写法同 start；不给则只平移开始、时长不变。',
          durationMin: '可选。新时长，按分钟给正整数，如 90；给了会覆盖 end。',
          location: '可选。新地点，如 "会议室 A"；传空串表示清空地点。',
          notes: '可选。新备注，存进事件描述，会整体替换原备注。',
        },
        returns: '返回 JSON：event（改后的完整事件，source=local）。',
        failures:
          'BAD_ARG（缺 id / 时间写法不对）；id 不存在（多半是拿成了订阅事件的 uid —— 用 calendar.list 确认来源再改）。',
      },
      {
        name: 'calendar.delete',
        description:
          '删一条**本地日历**事件。同样只删得动 source=local 的事件，订阅 .ics 只读。' +
          '主人说"把那条日程删了/周会取消了"时用。按 uid 精确匹配，不会误删别的日程。',
        params: {
          id: '要删的本地事件 id（calendar.add 的返回或 calendar.list 结果里拿）。',
        },
        returns: '返回 JSON：removed。true=已删；false=本地日历里没有这个 id（把原话转告主人，别反复重试）。',
        failures: 'BAD_ARG（缺 id）；写文件失败时返回系统错误原文。',
      },
  {
    name: 'github.notifications',
    description:
      '列出当前配置的 GitHub 账号的未读/最新通知：谁在哪个仓库 mention 了你、请你 review、' +
      'issue 有新评论。配了 DOTD_GITHUB_TOKEN 才可用（未配时连接器状态是 public-only）。' +
      '要查某个仓库的 issue / PR 清单用 github.issues / github.pulls，别用通知凑。',
    params: {},
    returns:
      'JSON 数组，每条含 id、reason（mention / review_requested / comment 等原词）、title、' +
      'type（Issue / PullRequest / Release）、url、repo（owner/name）、updatedAt、unread；' +
      '另带 rateLeft（剩余 API 配额）。',
    failures:
      'no_token：没配 DOTD_GITHUB_TOKEN —— 提示主人去配，不要重试；' +
      'timeout / network：15s 超时或网络不通 —— 稍后重试；' +
      'http_401 / http_403：token 无效或配额耗尽（对照 rateLeft）—— 别原样重发。',
  },
  {
    name: 'github.issues',   // github.pulls 同形，把 issue 换成 PR
    description:
      '列一个仓库当前 open 的 issues，按最后更新时间倒序（GitHub 的 PR 会混进 issues 接口，已剥离）。' +
      '查公开仓库不需要 token；私有仓库需要。要知道每页还有没有下一页看 nextPage。',
    params: {
      owner: '仓库属主，如 octo/hello 里的 octo',
      repo: '仓库名，如 octo/hello 里的 hello',
      page: '页码，从 1 起；缺省 1，翻页看返回里的 nextPage',
      limit: '每页条数，1-50，缺省 20（工具层口径统一用 limit；内部映射 GitHub 的 per_page）',
    },
    returns:
      'JSON 数组，每条含 number、title、url（html url）、user（作者 login）、updatedAt、' +
      'labels（标签名字符串数组）；github.pulls 每条另有 draft 布尔。另带 rateLeft。',
    failures:
      'http_404：仓库不存在或（私有仓库）没配 token —— 先核对 owner/repo 拼写；' +
      'http_403：未认证限速 60 请求/小时耗尽 —— 配 token 或稍后再试；' +
      'timeout / network / bad_json：网络层问题 —— 稍后重试。',
  },
  {
    name: 'github.pulls',
    description:
      '列一个仓库当前 open 的 pull requests，按最后更新时间倒序。查公开仓库不需要 token；' +
      '私有仓库需要。要看每页是否还有更多看返回里的 nextPage。',
    params: {
      owner: '仓库属主，如 octo/hello 里的 octo',
      repo: '仓库名，如 octo/hello 里的 hello',
      page: '页码，从 1 起；缺省 1，翻页看返回里的 nextPage',
      limit: '每页条数，1-50，缺省 20（工具层口径统一用 limit；内部映射 GitHub 的 per_page）',
    },
    returns:
      'JSON 数组，每条含 number、title、url、user（作者 login）、updatedAt、labels、draft 布尔；' +
      '另带 rateLeft（剩余 API 配额）。',
    failures:
      'http_404：仓库不存在或（私有仓库）没配 token —— 先核对 owner/repo 拼写；' +
      'http_403：未认证限速耗尽 —— 配 token 或稍后再试；' +
      'timeout / network / bad_json：网络层问题 —— 稍后重试。',
  },
  {
    name: 'rss.read',
    description:
      '抓一个 RSS 2.0 或 Atom 源并解析成条目列表。url 必须是 feed 地址（不是文章页）。' +
      '返回按 link 去重，同一链接只出一次。',
    params: {
      url: '订阅源 URL，http(s)，如 https://example.com/feed.xml',
    },
    returns:
      '{ title, items }：items 每条含 title、link、published（源里的原始时间串，RSS 是 RFC822，' +
      'Atom 是 ISO 8601）、text（摘要纯文本，已去 HTML 标签、解实体）。',
    failures:
      'bad_xml：地址不是订阅源（多半是普通网页）—— 换真正的 feed 地址；' +
      'http_404 / http_403：源挂了或反爬 —— 换源或稍后再试；' +
      'timeout / network：15s 超时或网络不通 —— 稍后重试。',
  },
  {
    name: 'vault.sites',
    description:
      '列出保险库里已保存的网站条目（只有 site 和 user，密码值永远不给模型）。' +
      '在 browser.act 的参数里写 $vault:site:user 占位符，宿主执行时会换成真值——' +
      '密码不进对话也不进日志。',
    params: {},
    returns: '{ entries }：每条 { site, user }。没有条目时是空数组。',
    failures:
      '用 $vault: 占位符但保险库里没有该条目 → 工具调用直接 vault_missing，' +
      '请让主人在 CLI 用 dotd vault add 添加。',
  },
];

/** 工具名 → 说明书（未知工具返回 null，调用方退回最小描述）。 */
export function toolDocOf(name: string): ToolDoc | null {
  return TOOL_DOCS.find((d) => d.name === name) ?? null;
}

/** `args_schema` 的属性名集合（非对象/无 properties 时为空）。 */
export function schemaParamNames(argsSchema: object | undefined): string[] {
  if (argsSchema === null || typeof argsSchema !== 'object') return [];
  const props = (argsSchema as { properties?: unknown }).properties;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>);
}

/**
 * 把参数说明渲染成 text（只保留 schema 里真实存在的参数；顺序跟 schema 走，
 * 这样模型看到的顺序与它填 JSON 的顺序一致）。
 *
 * `extraParams` 用于 schema 里有、说明书里没写到的字段：由渲染器兜底生成
 * 一行，**不会**因为漏写就让模型面对一个裸字段。
 */
export function renderParamLines(doc: ToolDoc, argsSchema: object | undefined): string[] {
  const names = schemaParamNames(argsSchema);
  if (names.length === 0) return [];
  return names.map((n) => {
    const line = doc.params[n];
    // 兜底行必须自己讲清"本环境支持它"，否则模型会以为这是别的版本才有的字段而绕开。
    const text = line ?? '本环境支持该字段（可选），按下方调用形态里的取值约定填写。';
    return `- ${n}：${text}`;
  });
}

/**
 * 一个工具发给模型的完整 description（ToolSpec.description）。
 *
 * @param cap      `/capabilities` 返回的能力项（schema 从 `cap.args_schema` 读，保真）
 * @param fallback 说明书缺失时的兜底描述（真实环境里 = 旧模板串；单测断言它永不命中）
 */
export function toolDescriptionFor(cap: Capability, fallback?: string): string {
  const doc = toolDocOf(cap.name);
  if (doc === null) {
    return fallback ?? `工具 ${cap.name}（mode=${cap.mode}，sideEffect=${cap.sideEffect}）`;
  }
  const lines: string[] = [doc.description];
  const paramLines = renderParamLines(doc, cap.args_schema);
  if (paramLines.length > 0) lines.push('', '参数：', ...paramLines);
  const notes = (doc.notes ?? []).filter((n) => {
    // note 里若点名了某个参数，而该参数在当前 schema 里不存在，就整条不渲染——
    // 与参数行同一条防编造规则。
    const mentioned = [...n.matchAll(/`?([a-z][a-z0-9_]{1,24})`?/g)]
      .map((m) => m[1] ?? '')
      .filter((w) => w.length > 0);
    const known = new Set([...schemaParamNames(cap.args_schema), ...Object.keys(doc.params)]);
    const invented = mentioned.filter((w) => /^[a-z_]+$/.test(w) && KNOWN_PARAM_WORDS.has(w) && !known.has(w));
    return invented.length === 0;
  });
  if (notes.length > 0) lines.push('', ...notes);
  lines.push('', `成功返回：${doc.returns}`, `失败：${doc.failures}`);
  // 执行形态提示放最后：模型读描述时先关心"怎么用"，再关心"后台怎么跑"。
  lines.push(
    '',
    `执行形态：mode=${cap.mode}（${cap.mode === 'sync' ? '同步返回结果' : '异步任务，Runner 会自动轮询到终态'}）：` +
      `sideEffect=${cap.sideEffect}（${SIDE_EFFECT_HINT[cap.sideEffect] ?? '未声明副作用，按最保守处理'}）。` +
      `单次最长 ${Math.round(cap.max_deadline_ms / 1000)} 秒。`,
  );
  return lines.join('\n');
}

/** sideEffect 档位在 prompt 里的解释（契约 J2：崩溃恢复分流的唯一依据）。 */
export const SIDE_EFFECT_HINT: Readonly<Record<string, string>> = {
  safe: '只读或可随时重做，崩溃后重试无风险',
  replayable: '自带幂等键，同一次调用重复执行不会产生第二份副作用（但内容会被覆盖写，改之前先读）',
  unknown: '副作用不确定，崩溃/重试可能重复生效，因此这类调用可能被要求人工审批',
};

/** 说明书里会用到、但**不属于任何工具参数**的常见英文词（用于 notes 防编造过滤）。 */
const KNOWN_PARAM_WORDS = new Set([
  'url',
  'status',
  'body',
  'headers',
  'content',
  'path',
  'depth',
  'cmd',
  'timeout_ms',
  'selector',
  'value',
  'action',
  'cwd',
  'content_base64',
  'truncated',
  'size_bytes',
  'exit_code',
  'text',
]);

/**
 * 「要不要联网查 / 怎么查」的判据（B 项的落地形态：**不做搜索工具，给模型一份手册**）。
 *
 * 为什么不做内置 web_search 工具（2026-10-18 实测结论，写在这里让后来人不用重做）：
 * - 本机实测 `html.duckduckgo.com`、`api.duckduckgo.com`、`google.com/search` **全部连接超时**；
 *   只有 `www.bing.com/search` 返回 200，但同一查询连发 5 次拿到的是**与查询完全无关**的结果
 *   （查 `dotd agent harness` → 返回 "DiskGenius 数据恢复软件"），且响应来自 `cn.bing`、
 *   未登录态会降级。把这种结果当"搜索结果"喂给模型，比没有搜索更糟（模型会当真）。
 * - 要稳定就得接付费/带 key 的搜索 API —— 那是**新增外部依赖与账单**，违反本项目
 *   "唯一外部依赖是可换 base_url 的模型 API" 的立身之本。
 * - 因此：搜索能力表达为 **net.get + 本手册**。主人若能提供自己的搜索端点（自建 SearxNG、
 *   公司内网检索、已付费的 API），模型直接 `net.get <那个端点>?...` 即可，不需要我们内置。
 */
export const NET_SEARCH_GUIDE = `联网查资料的判据（没有内置搜索工具，用 net.get 自己拼 URL）：
- 先问自己：这件事**必须**用今天的实时信息吗？代码/文档/本机文件里已有的，别联网。
  联网会把主人问的问题发给外部服务——这是隐私代价，能省就省。
- 出网默认关闭。若 net.get 返回 net_tools_disabled，说明主人没开；**不要**改用 shell curl 绕过去
  （那是同一个出网行为，绕过治理），直接告诉主人"需要联网的话请设 DOTD_NET_TOOLS=get"。
- 开了以后，优先直连**权威数据源**，而不是搜索引擎：
  · 官方 API 的 JSON（如 https://api.github.com/repos/<owner>/<repo>/issues?state=open）
  · 官方文档、RSS/Atom 订阅、sitemap、公开数据集
  这些结果结构稳定、可解析、不会突然变成广告页。
- 确实需要"搜索"时：主人若在 config 里给了搜索端点就用它；没有的话，**不要**去抓 google/bing
  的网页（实测会被重定向到地区版、返回与查询无关的内容，还可能触发验证码），
  而是直连你知道站点的 URL，或如实告诉主人"我查不到，需要你给一个搜索服务"。
- 抓回来的 HTML 很长时：只读你需要的片段（fs.write 存档后 shell.run grep），别把整页塞进推理。`;

/**
 * 工具清单里发给模型的整体引导段（放在 system prompt 之后、工具定义之前使用，
 * 也可直接拼进 system prompt）。讲清 11 个工具的分工与通用约束。
 */
export const TOOLS_GUIDE = `工具按"先便宜后昂贵"选（主人可能额外接了自己的工具，见各自说明）：
1. 看盘：fs.list（目录）→ fs.stat（在不在/多大）→ fs.read（读文本）。这是绝大多数任务的第一步。
2. 写盘：fs.write（覆盖整篇；改文件前必须先 fs.read 原文再整篇写回）。
   删除：fs.remove（先归档再删，可恢复；目录只删空的）。
3. 命令：shell.run（grep/截取/处理大文件；有超时、不能联网、危险命令要审批）。
   **读文档也用 shell.run**（不要用 fs.read——它只能读纯文本，二进制会被破坏）：
   · PDF：\`pdftotext 文件.pdf -\` 直接打出文本；\`pdfinfo 文件.pdf\` 看页数/元信息
   · Word(.docx) / Excel(.xlsx)：本质是 zip+xml，用 python3 解（zipfile 读内部 xml，正则或 ElementTree 取文本）
   · 纯文本/代码/日志：fs.read 就够
4. 网页：browser.open → browser.snapshot（看结构）→ browser.screenshot（要给主人看画面：PNG 存 screenshots/，随回复自动推）→ browser.act（点/填/等）→ browser.snapshot（确认）→ browser.close。
5. 接口：net.get / net.post。能直接拿数据就别开浏览器；net.post 对外有副作用，谨慎。**出网默认关闭**。
6. 定时：schedule.create（建）、schedule.list（看）、schedule.remove（停用；不是硬删，可恢复）。cron 是 5 段（分 时 日 月 周）。
   7. 邮件：mail.account.list 看接了哪些 → mail.list / mail.search / mail.read 收、搜、读 → mail.draft 起稿 → mail.send 真发（dangerous，必过主人审批）；接入 mail.account.add，移除 mail.account.remove。
   8. 日历：calendar.add 记日程 → calendar.edit 改 → calendar.delete 删（写的是本地日历；订阅 .ics 只读）。约时间前先 calendar.conflicts 查冲突。
   9. 连接器：github.notifications（GitHub 通知）/ github.issues / github.pulls（仓库 issue/PR 清单）/ rss.read（抓 RSS/Atom 源）。都是只读；没配 DOTD_GITHUB_TOKEN 时 GitHub 只能查公开仓。/ vault.sites（保险库条目名清单，配合 $vault:site:user 占位符用）。
   10. 造工具：tool.create / tool.list / tool.invoke。
      **写脚本前先看有没有「你已有的自造工具」**：对口就 tool.invoke，别重写。
      没对口但以后会重复 → tool.create 造一个。
通用约定：
- 路径一律写成 home 内相对路径（MEMORY.md、notes/x.md）或 /dot/home/... 绝对路径，别写宿主机路径、别写 /tmp。
- 一次只发一类动作。需要先看结果才知道下一步的，就分开两次调用；只有互不依赖的读操作才可以合并成一轮。
- 结果是 JSON；失败时结构是 {"status":"error","error":{"code","message","retryable"}}。
  先读 code 和 message 再决定：retryable=true 可以重试，false 说明参数或路径错了，原样重发只会再失败一次。
- 任何工具都可能被治理拦下：deny 时你会收到 {"denied":true,"reason":...}，这表示这条动作不被允许，请换一条路完成目标，而不是换个工具重试同一个动作。

${NET_SEARCH_GUIDE}`;

/**
 * 组装一份可直接上线的工具清单：schema 来自能力目录（逐字透传），
 * description 来自本文件的说明书（参数行与 schema 求交）。
 *
 * 分离成纯函数是为了可测：`toolSpecs()` 只是"取能力目录 + 调它"。
 */
export function buildToolSpecs(
  caps: readonly Capability[],
): Array<{ name: string; description: string; parameters: object }> {
  return caps.map((c) => ({
    name: c.name,
    description: toolDescriptionFor(c),
    parameters: c.args_schema,
  }));
}

/** 所有说明书条目覆盖的工具名（单测拿它与契约词表比对）。 */
export function documentedToolNames(): string[] {
  return TOOL_DOCS.map((d) => d.name);
}
