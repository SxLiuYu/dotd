/**
 * src/surfaces/connections.ts —— 已连接应用总览：纯聚合 + 渲染（2026-10-23）
 *
 * 要解决什么问题
 *   dotd 的连接能力散在六个地方：邮箱账号（mail_accounts 表）、日历源（.ics 目录）、
 *   连接器（connectors/registry.ts 的 github / rss）、MCP server（`<configDir>/mcp-servers.yml`，
 *   通常是 `~/.dotd/`；仓库 config/ 下那份只是模板）、
 *   模型端点（`<configDir>/models.yml`，通常 `~/.dotd/`；同样是模板 vs 运行期两份）、
 *   通知通道（飞书 app_id + owner_chat_id）与 HTTP 控制台。
 *   于是主人心里只有一个问题：「我到底连了什么？哪个断了？」
 *   今天没有任何一处能回答它 —— 每一处要么只有日志，要么只在**成功时**才留下痕迹，
 *   而坏掉的那一处恰恰是看不见的（失败是沉默的）。
 *
 * 这个文件只做两件事：
 *   buildConnections() 把事实聚合成行；renderConnections() 把行渲染成中文。
 *
 * 为什么不做 IO（不读库、不读文件、不读环境变量、不碰网络）
 *   一个「总览」如果自己去探活，它自己就成了新的故障点：断网时它既查不出来，
 *   又拖慢启动，而且会给出「脚本认为的状态」而不是「系统真实的状态」。
 *   事实的唯一来源是各子系统**已经知道**的东西（表里的 last_ok_at、registry 的 status、
 *   日历目录扫描出的 errors），这里只负责把它们摆在一起、排序、翻译成人话。
 *   全部输入由 ConnectionInput 注入 —— 于是这个模块可测、可回放、不依赖任何外部状态。
 *
 * 为什么要把 ready / not_configured / error 分开
 *   「配了但还没用过」「压根没配」「配了但坏了」在排查上是三件完全不同的事。
 *   混成一句「不可用」，等于把排查的起点抹掉了：主人不知道该去填配置，
 *   还是该去查网络。同理，被**禁用**的模型端点也必须出现在列表里（not_configured）——
 *   「配了但关着」是最容易被误判成「没配」的情况，而这正是本模块存在的理由。
 *
 * 绝不输出凭证
 *   会出现在渲染文本里的，只有：是否配置（是/否）、邮箱地址、IMAP 主机名、
 *   端点地址、模型名、环境变量**名**、以及会话**数量**。
 *   token / 密码 / app_secret / chat id 全文永远不进来 —— 它们连参数都不该传进来
 *   （看 ConnectionInput：飞书只收「app_id 是否存在」与「主人会话数量」，收不到值本身）。
 *   这条不是洁癖：总览是要打到终端和日志里的，一次泄露就是永久泄露。
 */

import type { ConnectorInfo } from '../connectors/registry.ts';
import { GITHUB_TOKEN_ENV } from '../connectors/registry.ts';

/** 连接的六个来源。这个顺序就是渲染顺序，也是「从最贴身到最外围」的顺序。 */
export type ConnectionKind = 'mail' | 'calendar' | 'connector' | 'mcp' | 'model' | 'channel';

/**
 * 单条连接的状态词表。
 *   connected     真的通了（有成功证据）
 *   ready         配好了、没有失败证据，但还没有成功证据（例如刚配好的邮箱、无凭证概念的 RSS）
 *   public_only   只能走公开接口（未认证），能用但受限
 *   not_configured 没配，或配了但被关着
 *   error         配了但坏了（有失败证据）
 */
export type ConnectionStatus = 'connected' | 'ready' | 'public_only' | 'not_configured' | 'error';

/** 邮箱账号事实。只收「身份 + 健康度」，收不到密码/授权码。 */
export interface ConnectionMailAccount {
  id: string;
  label: string;
  email: string;
  imapHost: string;
  /** 'active' | 'disabled'。用 string 而不是字面量联合：库里是自由文本，脏值也不该让总览崩。 */
  status: string;
  /** 最近一次成功的时间（ISO 文本）。null = 从未成功过。 */
  lastOkAt: string | null;
  /** 最近一次失败的错误原文。null = 没有失败记录。 */
  lastError: string | null;
}

/** 日历源事实。name 是 .ics 文件名或目录名，errors 是该源的解析错误。 */
export interface ConnectionCalendarSource {
  name: string;
  eventCount: number;
  errors: string[];
}

/** MCP server 事实。toolCount 是配置里 allowTools 白名单的条数（不是握手拿到的工具数）。 */
export interface ConnectionMcpServer {
  name: string;
  toolCount: number;
}

/** 模型端点事实。只收端点地址与模型名，收不到 api key。 */
export interface ConnectionModelEndpoint {
  tier: string;
  endpoint: string;
  model: string;
  enabled: boolean;
}

/**
 * 聚合所需的全部事实。
 * 注意 channel 只收「app_id 是否为空」与「主人会话**数量**」——
 * chat id 全文和 app_secret 不进这个结构，从源头上保证渲染不出凭证。
 */
export interface ConnectionInput {
  mailAccounts: ConnectionMailAccount[];
  calendar: { dir: string; sources: ConnectionCalendarSource[]; errors: string[] };
  /** 直接传 connectorCatalog() 的结果。 */
  connectors: ConnectorInfo[];
  mcpServers: ConnectionMcpServer[];
  models: ConnectionModelEndpoint[];
  channel: { feishuAppId: string; ownerChatCount: number; httpHost: string; httpPort: number };
}

/** 总览里的一行。detail 是一行事实，hint 是「没连上时怎么办」。 */
export interface ConnectionRow {
  kind: ConnectionKind;
  id: string;
  name: string;
  status: ConnectionStatus;
  detail: string;
  /** 只在 not_configured / public_only / error 时给 —— 「已连接」不需要指路。 */
  hint?: string;
}

/** 状态的中文词表。渲染和未来的 Web 界面共用一份，避免两处翻译不一致。 */
export const CONNECTION_STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: '已连接',
  ready: '已就绪',
  public_only: '仅公开接口',
  not_configured: '未配置',
  error: '异常',
};

/** 分组标题。顺序即渲染顺序（见 KIND_ORDER 的注释）。 */
const KIND_TITLE: Record<ConnectionKind, string> = {
  mail: '邮箱',
  calendar: '日历',
  connector: '连接器',
  mcp: 'MCP',
  model: '模型端点',
  channel: '通知与控制台',
};

/**
 * 固定的 kind 顺序。
 * 为什么固定：总览每次输出的行序必须一致 —— 主人一眼扫过去靠的是肌肉记忆，
 * 今天「邮箱在第三行、明天在第五行」会让「哪一行变了」这件事失去意义。
 * 所以顺序写在代码里，不按数量、不按严重程度重排（严重的用状态词和统计行标出来）。
 */
const KIND_ORDER: readonly ConnectionKind[] = ['mail', 'calendar', 'connector', 'mcp', 'model', 'channel'];

/**
 * 字典序比较。
 * 刻意不用 localeCompare：它的结果依赖 ICU 与区域设置，
 * 同一份输入在不同机器上可能排出不同顺序，而这里的排序必须是确定的（可断言、可回放）。
 */
function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 同 kind 内按 id 排序。id 才是稳定标识；name 可能重名（两个 tier 里同名的端点）。 */
function byId(a: ConnectionRow, b: ConnectionRow): number {
  return byText(a.id, b.id);
}

/** 邮箱 → 行。四种状态互斥，判定顺序即优先级，见每条注释。 */
function mailRows(accounts: ConnectionMailAccount[]): ConnectionRow[] {
  return accounts.map((a) => {
    // 「谁」这个前缀每行都要有：总览里同名账号很常见（两个「工作邮箱」连不同域）。
    const who = `${a.label}（${a.email}）`;
    // 非 active 一律当未配置：禁用是主人显式关掉的，不是故障，不该进「需处理」之外的告警语义。
    // 这里用 !== 'active' 而不是 === 'disabled'：库里脏值（例如 'archived'）也归到这一类，
    // 总览的目标是「告诉我它到底通不通」，而不是把状态词表校验一遍。
    if (a.status !== 'active') {
      return {
        kind: 'mail',
        id: a.id,
        name: a.label,
        status: 'not_configured',
        detail: `${who}已禁用`,
        hint: '在邮箱账号里重新启用，或删除后重新添加',
      };
    }
    // 有成功证据就是 connected —— **即使同时有失败记录**。
    // 理由：last_ok_at 说明链路曾经通过，偶发失败不该把「已连接」降级成「异常」，
    // 否则一次网络抖动就会让总览变红，主人很快就学会无视它。
    if (a.lastOkAt !== null) {
      return {
        kind: 'mail',
        id: a.id,
        name: a.label,
        status: 'connected',
        detail: `${who}最近成功 ${a.lastOkAt}`,
      };
    }
    // 从未成功过且有失败原文 → error，错误原文照实带出来（这是排查的唯一线索）。
    if (a.lastError !== null) {
      return {
        kind: 'mail',
        id: a.id,
        name: a.label,
        status: 'error',
        detail: `${who}最近失败：${a.lastError}`,
        hint: '检查密码/应用专用密码或网络',
      };
    }
    // 配好了但一次都没用过。这不是故障，但也不是「已连接」——
    // 很多邮箱的错只有真跑一次才暴露（服务端没开 IMAP 就是典型）。
    return {
      kind: 'mail',
      id: a.id,
      name: a.label,
      status: 'ready',
      detail: '已配置，尚未使用过',
    };
  });
}

/**
 * 日历 → **一行**（不按源展开）。
 * 为什么不展开：日历源的粒度对主人没用（他关心的是「日历通了没」），
 * 而一个目录里有 20 个 .ics 时，展开会把其它连接挤出屏幕 —— 总览的可用性就是它的全部价值。
 * 「dir 存不存在」由调用方通过 errors 体现（本模块不做 IO，没法自己去 stat）。
 */
function calendarRows(cal: ConnectionInput['calendar']): ConnectionRow[] {
  const totalEvents = cal.sources.reduce((n, s) => n + s.eventCount, 0);
  const fact = `${cal.sources.length} 个日历源 / ${totalEvents} 个事件`;
  const head = { kind: 'calendar' as const, id: 'calendar', name: '日历' };
  if (cal.errors.length > 0) {
    // 只带第一个错误：总览是概览，堆一串错误就退化成日志了。剩余数量给个总数即可。
    // noUncheckedIndexedAccess：errors[0] 可能是 undefined，兜成空串（此处长度已 > 0，纯防御）。
    const first = cal.errors[0] ?? '';
    const tail = `（共 ${cal.errors.length} 个错误）`;
    // 一个源都没有 + 有错 → 更像是「目录没放对/不存在」，按未配置处理并指路；
    // 否则就是「有源但坏了」，按异常处理。这两种的下一步动作完全不同。
    if (cal.sources.length === 0) {
      return [
        {
          ...head,
          status: 'not_configured',
          detail: `${first}${tail}`,
          hint: `把 .ics 文件放进 ${cal.dir}`,
        },
      ];
    }
    return [
      {
        ...head,
        status: 'error',
        detail: `${fact}；${first}${tail}`,
        hint: '检查 .ics 文件能否解析（编码 / 换行 / 体积），必要时删掉损坏的那一个',
      },
    ];
  }
  return [{ ...head, status: 'ready', detail: fact }];
}

/**
 * 连接器 → 行：直接映射 registry 的 status 词表（不重新判断、不探测）。
 * registry 已经按环境变量算过「认没认证」，这里再算一遍就是两套口径，早晚漂移。
 */
function connectorRows(connectors: ConnectorInfo[]): ConnectionRow[] {
  return connectors.map((c) => {
    // 'public-only' → 'public_only'：只是连字符与下划线的写法差别，语义完全一致。
    const status: ConnectionStatus =
      c.status === 'connected' ? 'connected' : c.status === 'public-only' ? 'public_only' : 'ready';
    const row: ConnectionRow = {
      kind: 'connector',
      id: c.id,
      name: c.name,
      status,
      detail: c.desc,
    };
    if (status === 'public_only') {
      // 只有 github 有「认证能提额度」这回事；其它连接器万一将来也 public-only，
      // 就退回不含变量名的通用说法（宁可少写，也不要指名一个不存在的变量）。
      const env = c.id === 'github' ? GITHUB_TOKEN_ENV : null;
      row.hint = env === null ? '设置对应 token 环境变量可提高限额' : `设置 ${env} 环境变量可提高限额`;
    }
    return row;
  });
}

/**
 * MCP → 空则一行「没配」，不空则每个 server 一行。
 * 为什么空也要一行：MCP 是主人最容易「以为自己配了」的一块（yaml 写在 config 目录里，
 * 写错文件名就静默失效）。留一行未配置，比什么都不显示更能让人想起来去补。
 */
function mcpRows(servers: ConnectionMcpServer[]): ConnectionRow[] {
  if (servers.length === 0) {
    return [
      {
        kind: 'mcp',
        id: 'mcp',
        name: 'MCP 工具通道',
        status: 'not_configured',
        detail: '没有配置任何 MCP server',
        // 2026-10-26：路径改成 daemon **真正会读**的位置。
        // daemon 读 `DOTD_MCP_CONFIG ?? join(cfg.configDir, 'mcp-servers.yml')`，
        // 托管部署里 configDir 是 `~/.dotd`。原来写 `config/mcp-servers.yml`，
        // 人会去改仓库模板，而那份没人读。
        hint: '在 <home>/mcp-servers.yml（通常 ~/.dotd/）里添加 server；仓库 config/ 下那份只是模板',
      },
    ];
  }
  // `toolCount` 是**配置里声明的白名单条数**（`allowTools?.length`），不是握手拿到的
  // 工具总数 —— `loadMcpServers()` 只解析 YAML，`McpClient.listTools()` 要等真正
  // 调用时才跑。所以「已声明」不等于「连得上」：command 写错、机器上没有那个可执行
  // 文件，这里照样显示 connected。
  //
  // 2026-10-26 改了文案（原来 detail 是 `${toolCount} 个工具`，注释还写着
  // "能列出来就说明已经握手成功过" —— 那是错的）。status 值保留 'connected'
  // 不动（控制台/脚本在读它，改语义要单独决定）；先把话说准，不让人以为这里探过活。
  return servers.map((s) => ({
    kind: 'mcp',
    id: s.name,
    name: s.name,
    status: 'connected',
    detail:
      s.toolCount > 0 ? `已声明（白名单 ${s.toolCount} 个工具）` : '已声明（未限制工具白名单）',
  }));
}

/**
 * 模型端点 → 每个端点一行，**禁用的也要出现**。
 * 「配了但 enabled: false」是最容易被误判成「没配」的情况：配置在，模型就是不用，
 * 主人只会看到「模型老是走 fallback」，永远想不到是自己关了一个。
 * 排序按 tier 再 endpoint（不是按 id）：tier 是主人脑子里的分组（primary / secondary / ...），
 * 按 tier 排出来的列表读起来是「主模型在最上面」，而不是字母表。
 */
/**
 * 端点名 → `host[:port]`（去掉协议与路径）。
 *
 * 为什么 name 里要带 host：`tier` 是数字（1 / 2），同一 tier 配两个端点时列表会出现
 * 两行一模一样的「1」，主人没法看出哪条断了。带上 host 之后每行自证身份，
 * 而完整 URL 仍在 `detail` 里（排版上更长的信息放右侧）。
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint; // 不是合法 URL 就原样给，别在总览里抛错
  }
}

function modelRows(models: ConnectionModelEndpoint[]): ConnectionRow[] {
  const sorted = models
    .slice() // 不改调用方的数组：排序是渲染需求，不该成为副作用
    .sort((a, b) => byText(a.tier, b.tier) || byText(a.endpoint, b.endpoint) || byText(a.model, b.model));
  return sorted.map((m) => {
    const id = `${m.tier}/${m.endpoint}`;
    if (!m.enabled) {
      return {
        kind: 'model',
        id,
        name: `${m.tier} · ${endpointHost(m.endpoint)}`,
        status: 'not_configured',
        detail: `已禁用（${m.endpoint} · ${m.model}）`,
        // 与 MCP 那条同一个坑（2026-10-26）：daemon 读的是 `<configDir>/models.yml`，
        // 托管部署里是 `~/.dotd/models.yml`（且热加载）。写死 `config/models.yml`
        // 会把人指去改仓库模板 —— 那份没人读。
        hint: '在运行期的 models.yml（通常 ~/.dotd/）里把该端点的 enabled 改成 true；仓库 config/ 下那份只是模板',
      };
    }
    return {
      kind: 'model',
      id,
      name: `${m.tier} · ${endpointHost(m.endpoint)}`,
      status: 'connected',
      detail: `${m.endpoint} · ${m.model}`,
    };
  });
}

/**
 * 通知与控制台 → 两行：飞书 + HTTP 控制台。
 *
 * 飞书三态：
 *   没 app_id                     → not_configured（连应用都没建，指路到 config.yml）
 *   有 app_id 但没有主人会话      → **error**，而不是「未配置」：这是最坑的一种半配置。
 *       飞书入站会给非白名单会话回 403，消息静默丢弃 —— 主人会以为「机器人没收到」，
 *       实际是收到了但被自己的配置挡掉了。必须显式说出来。
 *   app_id 与会话都有             → connected。**只说会话数量**，绝不打 chat id 全文。
 *
 * HTTP 控制台没有「未配置」这一态：daemon 起来就一定有监听地址，
 * 所以这一行永远存在（也是极端空输入时唯一的兜底行）。
 */
function channelRows(ch: ConnectionInput['channel']): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  if (ch.feishuAppId === '') {
    rows.push({
      kind: 'channel',
      id: 'feishu',
      name: '飞书通知',
      status: 'not_configured',
      detail: '未配置飞书应用（app_id 为空）',
      hint: '在 ~/.dotd/config.yml 的 feishu: 段填 app_id 与 owner_chat_id',
    });
  } else if (ch.ownerChatCount > 0) {
    rows.push({
      kind: 'channel',
      id: 'feishu',
      name: '飞书通知',
      status: 'connected',
      // 数量而非 id：主人知道「有几个会话能收」就够了，chat id 全文属于凭证级别。
      detail: `app_id 已配，主人会话 ${ch.ownerChatCount} 个`,
    });
  } else {
    rows.push({
      kind: 'channel',
      id: 'feishu',
      name: '飞书通知',
      status: 'error',
      detail: '未配主人会话，入站消息会被 403 丢弃',
      hint: '在 ~/.dotd/config.yml 的 feishu: 段填 owner_chat_id',
    });
  }
  rows.push({
    kind: 'channel',
    id: 'http',
    name: 'HTTP 控制台',
    status: 'connected',
    detail: `http://${ch.httpHost}:${ch.httpPort}`,
  });
  return rows;
}

/**
 * 聚合入口：把事实变成有序的行。
 *
 * 排序在这里一次做定，而不是让渲染层各自排：
 * 渲染可能有两三个消费方（CLI、Web、将来的 `/connections` 接口），
 * 只要有一处忘了排，屏幕上的顺序就会分叉。
 *
 * 极端输入（全空、脏值、超长数组）不抛异常、不筛掉「不好看」的行：
 * 总览的价值在于「它说的话都是真的」，行数多少是次要的。
 */
export function buildConnections(input: ConnectionInput): ConnectionRow[] {
  // 直接按 KIND_ORDER 的顺序拼装 → kind 顺序天然固定，不需要最后再按 rank 排序。
  // 每组内部再按规则排（mail/connector/mcp/channel 用 id；model 用 tier→endpoint）。
  return [
    ...mailRows(input.mailAccounts).sort(byId),
    ...calendarRows(input.calendar),
    ...connectorRows(input.connectors).sort(byId),
    ...mcpRows(input.mcpServers).sort(byId),
    ...modelRows(input.models), // 已按 tier→endpoint 排好，不能再按 id 覆盖
    ...channelRows(input.channel).sort(byId),
  ];
}

/**
 * 统计：总数 / 已连接 / 需处理。
 * issues 里含 public_only：它确实「能用」，但也是一句「你可以更好」的待办（补个 token），
 * 所以算进「需处理」。ready 两边都不算 —— 它不是问题，但也还谈不上「连上了」。
 */
export function connectionSummary(rows: ConnectionRow[]): { total: number; connected: number; issues: number } {
  let connected = 0;
  let issues = 0;
  for (const r of rows) {
    if (r.status === 'connected') connected++;
    else if (r.status === 'error' || r.status === 'not_configured' || r.status === 'public_only') issues++;
  }
  return { total: rows.length, connected, issues };
}

/**
 * 渲染成终端友好的中文多行文本。
 *
 * 格式：按 kind 分组（空组不出现），每行「· 名称 — 状态：事实」，有 hint 就同一条追加（hint），
 * 末尾一行统计。为什么 hint 同行而不是另起一行：一个分区里有 5 行 hint 会让块高度翻倍，
 * 而主人扫视时是「按行」看的 —— 挂在同一行才跟得上「这一行为什么没连上」。
 *
 * 用 '\n' 而不是 os.EOL：输出还会被塞进飞书消息、日志、测试断言，
 * 混进 '\r' 会让断言和排版都变得难写。终端两种都能显示。
 */
export function renderConnections(rows: ConnectionRow[]): string {
  const lines: string[] = [];
  for (const kind of KIND_ORDER) {
    const group = rows.filter((r) => r.kind === kind);
    if (group.length === 0) continue; // 空组不出现：一排空标题只会让真正的问题更难找
    lines.push(KIND_TITLE[kind]);
    for (const row of group) {
      const hintText = typeof row.hint === 'string' && row.hint.length > 0 ? `（${row.hint}）` : '';
      lines.push(`  · ${row.name} — ${CONNECTION_STATUS_TEXT[row.status]}：${row.detail}${hintText}`);
    }
  }
  const s = connectionSummary(rows);
  lines.push(`共 ${s.total} 项，connected ${s.connected} 项，需处理 ${s.issues} 项`);
  return lines.join('\n');
}
