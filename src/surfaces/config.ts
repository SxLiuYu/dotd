/**
 * src/surfaces/config.ts —— `~/.dotd/config.yml` 的 `surfaces:` 节加载与校验。
 *
 * 依据：
 * - 契约 S-4：CP 提供统一 config 加载器，`surfaces` 节 schema 属主 = SF（本文件）。
 * - GOV §2.3：zod 校验失败 ⇒ throw ⇒ daemon 拒启动（错误类 ConfigError）。
 * - 配置注释（config/dotd.yml:9-13）：`${VAR}` 由加载器展开，未设置 → fail-closed 拒启动，
 *   不静默回落空串；路径支持 `~` 展开为 daemon 用户 HOME。
 * - CONVENTIONS.md「依赖决策」：能用内置模块不用第三方——本机 node_modules 无任何 YAML
 *   解析器（已核：无 yaml/js-yaml，且禁止 npm install），因此本文件实现一个**只覆盖
 *   config.yml 实际用到子集**的极简 YAML 读取器（注释 / 嵌套 map / map 列表 / 标量列表 /
 *   引号字符串），足以解析 dotd.yml 全部六个配置节。未覆盖的 YAML 特性记 deviations。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../shared/errors.ts';
import type { SurfacesConfig } from './types.ts';

// ── 极简 YAML 子集读取器 ──────────────────────────────────────────────

type YamlValue = string | number | boolean | null | YamlMap | YamlList;
interface YamlMap {
  [k: string]: YamlValue;
}
type YamlList = YamlValue[];

/** 去掉行尾注释（引号内的 # 不动；# 必须由空白或行首引导）。 */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

/** 解析标量（含单/双引号字符串、行内流式列表 `[a, b]`）。 */
function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // 行内流式列表：`["a", "b"]` / `[1, 2]` / `[]`（config.yml 的 *_tokens/allowlist 用它）
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowList(s);
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * 解析行内流式列表（只支持一层扁平列表：元素是标量，不含嵌套 `[]`/`{}`）。
 * 分隔符 = 顶层逗号（引号内的逗号不拆）。
 */
function parseFlowList(s: string): YamlList {
  const inner = s.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: YamlList = [];
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if ((ch === ',' || i === inner.length) && !inSingle && !inDouble) {
      const piece = inner.slice(start, i).trim();
      if (piece.length > 0) out.push(parseScalar(piece));
      start = i + 1;
    }
  }
  return out;
}

function splitKeyValue(body: string): { key: string; value: string } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const key = body.slice(0, i).trim();
      const value = body.slice(i + 1).trim();
      if (key.length === 0) return null;
      return { key: unquoteKey(key), value };
    }
  }
  return null;
}

function unquoteKey(key: string): string {
  if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1);
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}

/** 栈帧：一个容器 + 其缩进层级 + 它在父容器里的落点（供"占位 map 升级为 list"用）。 */
interface Frame {
  indent: number;
  container: YamlMap | YamlList;
  /** 本容器作为父 map 的某个 key 的占位时的回写点。 */
  slot: { map: YamlMap; key: string } | null;
}

/** 把帧的容器从"空 map 占位"升级成 list（`key:` 后紧跟 `- item` 的形状）。 */
function upgradeToList(frame: Frame): YamlList {
  const existing = frame.container;
  if (Array.isArray(existing)) return existing;
  if (frame.slot !== null && Object.keys(existing).length === 0) {
    const list: YamlList = [];
    frame.slot.map[frame.slot.key] = list;
    frame.container = list;
    return list;
  }
  throw new ConfigError('YAML 列表项落在非空 map 之下（结构不支持）', null);
}

/**
 * 解析 YAML 子集：任意深度嵌套 map（2 空格缩进）、`key: value` 标量、
 * `- value` 与 `- key: value` 列表（含 map 项及其续行）、引号字符串、行尾/整行注释。
 * 不支持：块标量 `|`/`>`、锚点、流式集合 `{}`/`[]`、多文档、tab 缩进。
 */
function parseYamlSubset(text: string): YamlMap {
  const root: YamlMap = {};
  const stack: Frame[] = [{ indent: -1, container: root, slot: null }];

  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li]!;
    const noComment = stripLineComment(rawLine);
    if (noComment.trim().length === 0) continue;
    if (/^\s*---\s*$/.test(noComment) || /^\s*\.\.\.\s*$/.test(noComment)) continue;

    const indent = noComment.length - noComment.trimStart().length;
    const body = noComment.trim();

    // 出栈到父层级（缩进 ≤ 栈顶即离开当前容器）
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const top = stack[stack.length - 1]!;

    if (body === '-' || body.startsWith('- ')) {
      const itemText = body === '-' ? '' : body.slice(2).trim();
      let list: YamlList;
      if (Array.isArray(top.container)) {
        list = top.container;
      } else {
        list = upgradeToList(top);
      }
      if (itemText.length === 0) {
        // `-` 独占一行：项是嵌套 map，由后续更深缩进的行填充
        const item: YamlMap = {};
        list.push(item);
        stack.push({ indent, container: item, slot: null });
        continue;
      }
      const kv = splitKeyValue(itemText);
      if (kv === null) {
        list.push(parseScalar(itemText));
        continue;
      }
      const item: YamlMap = {};
      list.push(item);
      item[kv.key] = kv.value.length === 0 ? ({} as YamlMap) : parseScalar(kv.value);
      // 列表项 map 的续行只需比 `-` 深一格（内容列 = indent + 2，但 4 空格缩进的
      // 仓库配置写作 indent + 2；阈值取 indent + 1 才能同时容纳两种风格）。
      stack.push({ indent: indent + 1, container: item, slot: null });
      continue;
    }

    const kv = splitKeyValue(body);
    if (kv === null) {
      throw new ConfigError(`YAML 第 ${li + 1} 行无法解析：${body}`, null);
    }
    if (Array.isArray(top.container)) {
      throw new ConfigError(`YAML 第 ${li + 1} 行：key 出现在列表容器之下（${body}）`, null);
    }
    if (kv.value.length === 0) {
      const child: YamlMap = {};
      top.container[kv.key] = child;
      stack.push({ indent, container: child, slot: { map: top.container, key: kv.key } });
    } else {
      top.container[kv.key] = parseScalar(kv.value);
    }
  }
  return root;
}

// ── `${VAR}` 展开与 `~` 路径展开 ──────────────────────────────────────

/** 展开 `${VAR}`；未设置 → fail-closed（ConfigError），绝不静默回落空串。 */
export function expandEnv(value: string, opts: { strict?: boolean } = {}): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = process.env[name];
    if (v === undefined || v.length === 0) {
      if (opts.strict !== false) {
        throw new ConfigError(`环境变量 ${name} 未设置（配置占位 ${whole} 无法展开，fail-closed）`, null);
      }
      return '';
    }
    return v;
  });
}

/** 展开行首 `~` 为 daemon 用户 HOME（config/dotd.yml:12 注释约定）。 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
}

/**
 * `config.yml` 到底在哪 —— **唯一**判据。
 *
 * 为什么要单拎出来（2026-10-26，同类缺陷第十五例）：同一个 daemon 进程里有两处
 * 在找这份文件，用的却不是同一条规则 ——
 *
 *     loadSurfacesConfig()            → DOTD_CONFIG ?? ~/.dotd/config.yml   （无视 DOTD_HOME）
 *     cpReserveMbFromEnvOrConfig()    → join(cfg.dataDir, 'config.yml')     （= DOTD_HOME 下）
 *
 * 实测（`DOTD_HOME=/tmp/h17` 里 port=7001/token=dotdhome-token/reserve=2222，
 * `HOME=/tmp/hh17/.dotd` 里 port=7000/token=home-token/reserve=1111）：
 *
 *     dataDir       = /tmp/h17
 *     surfaces.port = 7000   token = home-token      ← 读的是 HOME 那份
 *     dotdReserveMb = 2222                            ← 读的是 DOTD_HOME 那份
 *
 * 也就是说 `surfaces:` 节（端口、master_token、飞书密钥）来自**用户 HOME**，
 * 而其余键来自**数据目录**。谁把 `DOTD_HOME` 指到别处（`CHARLIE_HOME=/data`
 * 这类容器部署、临时实例、冒烟夹具），都会拿到"一半来自 A、一半来自 B"的配置，
 * 而且两边日志都正常 —— 正是这条主线反复出现的形状：**同一件事两处判据**。
 *
 * 现在按 `DOTD_HOME`（数据目录根）来：它才是这个系统的"一个根"，
 * 也与 `scripts/init-config.mjs` / `scripts/setup.mjs` / `voice/integration/one_system.py`
 * 写配置时用的位置一致 —— 写哪儿就读哪儿。
 *
 * 顺序：`DOTD_CONFIG`（显式文件）> `<DOTD_HOME>/config.yml`（**存在才用**）
 * > `~/.dotd/config.yml`。"存在才用"是为了不制造回归：`DOTD_HOME` 指到别处、
 * 但配置仍放在 `~/.dotd` 的老布局照样能起（此时两处读的都是 `~/.dotd` 那份，
 * 依旧同判据）。注意这里**不**走 `<configDir>`：18.13 已定 config.yml 身份不同 ——
 * 它是"指向某一份文件的路径"，不是"跟着配置目录走的一类文件"。
 */
export function resolveConfigFile(
  opts: {
    env?: NodeJS.ProcessEnv;
    /** 用于展开 `~` / 回落的默认 home（测试注入；缺省 `homedir()`）。 */
    home?: string;
    exists?: (p: string) => boolean;
  } = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  const expand = (p: string): string =>
    p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
  const explicit = (env.DOTD_CONFIG ?? '').trim();
  if (explicit.length > 0) return resolve(expand(explicit));
  const homeEnv = (env.DOTD_HOME ?? '').trim();
  if (homeEnv.length > 0) {
    const hosted = join(resolve(expand(homeEnv)), 'config.yml');
    if (exists(hosted)) return hosted;
  }
  return join(home, '.dotd', 'config.yml');
}

// ── 监听地址（F6：可配置 bind，但默认必须是回环）─────────────────────────

/**
 * **代码默认监听地址**（安全默认值，判据钉死这一行）。
 *
 * 为什么默认回环而不是 0.0.0.0：dotd 的 master token 就是这台机器的全权凭据，
 * 监听 0.0.0.0 = 把它交给整个二层网络。升级 daemon 不应突然让原本只有本机能碰的
 * 端口变成局域网可碰 —— 那是「静默扩面」，最难被发现、也最难归责。
 * 因此扩大监听面必须是**显式**的：改 config/dotd.yml 的 host，或设 DOTD_HTTP_HOST。
 *
 * 参照 progress-criteria.sh 的写法：判据守的是**代码默认值**（DEFAULT_HTTP_HOST /
 * zod .default），不是部署配置值（config/dotd.yml 的 host 是主人的选择）。
 */
export const DEFAULT_HTTP_HOST = '127.0.0.1';

/** 环境变量覆盖名：不改配置文件也能换 bind（容器/ systemd 场景更顺手）。 */
export const HTTP_HOST_ENV = 'DOTD_HTTP_HOST';

/** 默认监听端口（契约 H2）。zod .default 与它必须同值。 */
export const DEFAULT_HTTP_PORT = 7788;

/**
 * 环境变量覆盖名：不改配置文件也能换端口。
 *
 * 为什么**必须**有这一条（2026-10-26，同类缺陷第十四例）：
 * `DOTD_HTTP_PORT` 早就有人在读，但读它的不是 daemon：
 *   - `voice/integration/one_system.py::resolve_http_port()` 用它决定**反代目标**；
 *   - `scripts/soak.sh` 用它决定**探哪个端口**；
 *   - 三个 `.mjs` 冒烟脚本把它交给子进程，自己也用它拼 URL。
 * 而 `parseSurfacesSection()` 只认 config.yml 的 `surfaces.http.port`。于是：
 *
 *      DOTD_HTTP_PORT=7799 node src/daemon.ts     ← 仍然监听 7788
 *      one_system 反代 → 127.0.0.1:7799          ← 没人监听
 *
 * 实测（本仓库，真跑 loadSurfacesConfig）：
 *     不设           → host=127.0.0.1 port=7788
 *     DOTD_HTTP_PORT → host=127.0.0.1 port=7788   ← 环境变量被无视
 *     DOTD_HTTP_HOST → host=0.0.0.0   port=7788   ← host 认，port 不认
 * 两个行为旋钮一个认一个不认，是这条主线的老形状：**同一件事两处判据**。
 * 后果不是"端口不对"这么明显 —— 是 8000 的 /api 全 502，而两边日志都说自己正常。
 */
export const HTTP_PORT_ENV = 'DOTD_HTTP_PORT';

/**
 * 解析最终监听端口。优先级：`DOTD_HTTP_PORT` > 配置里的 `port:` > DEFAULT_HTTP_PORT。
 *
 * 非法值**不静默忽略**：设了 `DOTD_HTTP_PORT=abc` 却安静地监听 7788，
 * 正是"配置了没生效、日志一路绿"。这里直接抛，让启动失败得明明白白。
 */
export function resolveHttpPort(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = (env[HTTP_PORT_ENV] ?? '').trim();
  if (fromEnv.length > 0) {
    const n = /^\d+$/.test(fromEnv) ? Number(fromEnv) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(`${HTTP_PORT_ENV} 非法：${fromEnv}（要求 1-65535 的整数）`, null);
    }
    return n;
  }
  return configured ?? DEFAULT_HTTP_PORT;
}

/**
 * 解析最终监听地址。优先级：`DOTD_HTTP_HOST` > 配置里的 `host:` > DEFAULT_HTTP_HOST。
 *
 * 三个细节：
 * - 配置里的 host 也走一次**非严格** ${VAR} 展开，这样写成 "${DOTD_HTTP_HOST}"
 *   这种模板时，变量未设置就回落到默认（而不是像严格展开那样直接拒启动）；
 * - 展开后为空（写了空串 / 占位符没值）→ 回落到 DEFAULT_HTTP_HOST：fail-closed 到回环，
 *   绝不回落 0.0.0.0；
 * - 环境变量优先级最高，是为了运维能在不改文件的情况下临时开一次（测完就把变量撤掉）。
 */
export function resolveHttpHost(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env[HTTP_HOST_ENV] ?? '').trim();
  if (fromEnv.length > 0) return fromEnv;
  const raw = configured === undefined ? '' : expandEnv(String(configured), { strict: false }).trim();
  return raw.length > 0 ? raw : DEFAULT_HTTP_HOST;
}

/**
 * 该 bind 值是否只落在回环上（true = 本机可达）。
 *
 * `0.0.0.0` / `::` / `*` 是**所有网卡**，不是回环 —— 这是最容易搞错的一条：
 * 它们看着像「占位符」，实际是把端口开到整个局域网。判据里必须分开。
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h.length === 0) return false;
  if (h === 'localhost') return true;
  if (h.startsWith('127.')) return true;
  if (h === '::1') return true;
  // IPv4-mapped IPv6（::ffff:127.0.0.1）
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped !== null) return mapped[1]!.startsWith('127.');
  return false;
}

// ── zod schema（surfaces: 节） ────────────────────────────────────────


const httpSchema = z.object({
  host: z.string().min(1).default(DEFAULT_HTTP_HOST),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
  master_token: z.string().min(1),
  readonly_tokens: z.array(z.string()).default([]),
  allowed_origins: z.array(z.string()).default([]),
});

const hookSchema = z.object({
  source: z.string().min(1),
  secret: z.string().min(1),
  dot_id: z.string().min(1).default('dot1'),
  rate_limit_per_min: z.coerce.number().int().positive().default(60),
});

const jsonlWatchSchema = z.object({
  path: z.string().min(1),
  dot_id: z.string().min(1).default('dot1'),
  enabled: z.boolean().default(false),
  idle_debounce_ms: z.coerce.number().int().nonnegative().default(500),
});

const heartbeatSchema = z.object({
  tick_interval_s: z.coerce.number().int().positive().default(15),
});

const telegramSchema = z.object({
  bot_token: z.string().default(''),
  allowlist: z.array(z.coerce.number()).default([]),
  edit_throttle_ms: z.coerce.number().int().nonnegative().default(1200),
  // §5.5 出站目标 chat（可缺省；缺省退 allowlist[0]，再无则 deliver 如实报错）
  owner_chat_id: z.coerce.number().int().optional(),
});

const uiSchema = z.object({
  stream_deltas: z.boolean().default(true),
});

/**
 * 过程可视化（T5）。默认全关 —— 升级后不会突然开始给主人发进度。
 *
 * 用 nonnegative 而不是正数下限：throttle=0 是有意义的（每次都推），
 * 强制 >=1 会让"我不想节流"这个选择变得说不出口。
 */
const progressSchema = z.object({
  enabled: z.boolean().default(false),
  every_n_steps: z.coerce.number().int().nonnegative().default(3),
  min_interval_ms: z.coerce.number().int().nonnegative().default(90_000),
});

const feishuSchema = z.object({
  app_id: z.string().default(''),
  app_secret: z.string().default(''),
  owner_chat_id: z.string().optional(),
  verification_token: z.string().default(''),
  encrypt_key: z.string().default(''),
  edit_throttle_ms: z.coerce.number().int().nonnegative().default(1200),
  /**
   * Web 发起的任务，结果要不要也推到飞书？
   *
   * 默认 false。理由（2026-10-21 实测）：24 小时 50 个任务里 32 个来自 Web，
   * 但 44 条回复**全部**推到了飞书 —— 人在电脑前看着 Web 会话，
   * 手机上又原样收一遍。这不是「通知」，是重复。
   * 飞书里发起的任务（channel=feishu）不受影响，照常回。
   */
  mirror_web_to_feishu: z.boolean().default(false),
});

/**
 * 每日简报（D1）。`time` 只做形状校验（HH:MM 允许一位小时，与安静时段同口径），
 * 真正的"到点了吗"由 `daily-brief.ts` 的 `shouldSendBrief` 判 —— 那里也有单测。
 */
const briefSchema = z.object({
  enabled: z.boolean().default(false),
  time: z.string().default('08:30'),
  chat_id: z.string().optional(),
  window_min: z.coerce.number().int().positive().default(180),
  max_chars: z.coerce.number().int().positive().max(4000).default(1200),
});

/**
 * 连接看门狗（U3 的「持续在线」那一半）。interval_min 与 quiet_hours 同 crontabs 语义：
 * quiet_hours 空串 = 不设安静时段；字符串解析成 {start,end} 由 parseSurfacesSection 做。
 */
const connWatchSchema = z.object({
  enabled: z.boolean().default(false),
  interval_min: z.coerce.number().int().positive().max(1440).default(15),
  quiet_hours: z.string().optional(),
});
const surfacesSchema = z.object({
  http: httpSchema,
  hooks: z.array(hookSchema).default([]),
  jsonl_watch: z.array(jsonlWatchSchema).default([]),
  heartbeat: heartbeatSchema.default({ tick_interval_s: 15 }),
  telegram: telegramSchema.default({ bot_token: '', allowlist: [], edit_throttle_ms: 1200 }),
  feishu: feishuSchema.default({
    app_id: '',
    app_secret: '',
    verification_token: '',
    encrypt_key: '',
    edit_throttle_ms: 1200,
    mirror_web_to_feishu: false,
  }),
  ui: uiSchema.default({ stream_deltas: true }),
  progress: progressSchema.default({ enabled: false, every_n_steps: 3, min_interval_ms: 90_000 }),
  brief: briefSchema.default({ enabled: false, time: '08:30', window_min: 180, max_chars: 1200 }),
  conn_watch: connWatchSchema.default({ enabled: false, interval_min: 15 }),
});

/**
 * 从整个 config.yml 的解析结果中取 `surfaces:` 节并校验。
 * 段缺失/非法即拒启动（fail-closed）：http 段缺失时无法确定监听端口与 token。
 */
/**
 * 解析 quiet_hours 字符串（`HH:MM-HH:MM`，本地时区）成结构化边界。
 *
 * 与 `src/control-plane/scheduler.ts` 的 `inQuietHours()` 同一个形状：
 * 写错就当作「没设安静时段」（返回 null）—— 宁可多报一句，也不要因为一个格式笔误
 * 让所有连接故障被静音。跨午夜（start > end）由 `inQuietHours()` 处理。
 */
export function parseQuietHours(raw: string | undefined): { start: string; end: string } | null {
  if (raw === undefined) return null;
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(raw.trim());
  if (m === null) return null;
  return { start: m[1] ?? '', end: m[2] ?? '' };
}

export function parseSurfacesSection(root: YamlMap): SurfacesConfig {
  const raw = root['surfaces'];
  if (raw === undefined || raw === null) {
    throw new ConfigError('config.yml 缺 surfaces: 节（交互面无法确定监听端口与 token）', null);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config.yml 的 surfaces: 节不是 map', null);
  }
  const parsed = surfacesSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`surfaces 配置校验失败：${issues}`, null);
  }
  const s = parsed.data;
  return {
    http: {
      host: resolveHttpHost(s.http.host),
      port: resolveHttpPort(s.http.port),
      masterToken: expandEnv(s.http.master_token),
      readonlyTokens: s.http.readonly_tokens.map((t) => expandEnv(t)),
      allowedOrigins: s.http.allowed_origins,
    },
    hooks: s.hooks.map((h) => ({
      source: h.source,
      secret: expandEnv(h.secret),
      dotId: h.dot_id,
      rateLimitPerMin: h.rate_limit_per_min,
    })),
    jsonlWatch: s.jsonl_watch.map((w) => ({
      path: expandHome(w.path),
      dotId: w.dot_id,
      enabled: w.enabled,
      idleDebounceMs: w.idle_debounce_ms,
    })),
    heartbeat: { tickIntervalS: s.heartbeat.tick_interval_s },
    telegram: {
      botToken: expandEnv(s.telegram.bot_token, { strict: false }),
      allowlist: s.telegram.allowlist,
      editThrottleMs: s.telegram.edit_throttle_ms,
      ...(s.telegram.owner_chat_id !== undefined ? { ownerChatId: s.telegram.owner_chat_id } : {}),
    },
    feishu: {
      appId: expandEnv(s.feishu.app_id, { strict: false }),
      appSecret: expandEnv(s.feishu.app_secret, { strict: false }),
      ...(s.feishu.owner_chat_id !== undefined ? { ownerChatId: expandEnv(s.feishu.owner_chat_id, { strict: false }) } : {}),
      verificationToken: expandEnv(s.feishu.verification_token, { strict: false }),
      encryptKey: expandEnv(s.feishu.encrypt_key, { strict: false }),
      editThrottleMs: s.feishu.edit_throttle_ms,
      mirrorWebToFeishu: s.feishu.mirror_web_to_feishu,
    },
    ui: { streamDeltas: s.ui.stream_deltas },
    progress: {
      enabled: s.progress.enabled,
      everyNSteps: s.progress.every_n_steps,
      minIntervalMs: s.progress.min_interval_ms,
    },
    brief: {
      enabled: s.brief.enabled,
      time: s.brief.time,
      chatId: s.brief.chat_id !== undefined && s.brief.chat_id !== '' ? s.brief.chat_id : null,
      windowMin: s.brief.window_min,
      maxChars: s.brief.max_chars,
    },
    connWatch: {
      enabled: s.conn_watch.enabled,
      intervalMin: s.conn_watch.interval_min,
      quietHours: parseQuietHours(s.conn_watch.quiet_hours),
    },
  };
}

/**
 * 读 config.yml 并返回 surfaces 配置。
 * @param configPath 显式路径（测试传临时文件；缺省走 `resolveConfigFile()`）。
 */
export function loadSurfacesConfig(configPath?: string): SurfacesConfig {
  const path = configPath ?? resolveConfigFile();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`读不到配置文件 ${path}`, path, { cause });
  }
  const cfg = parseSurfacesSection(parseYamlSubset(text));
  // fail-closed：master token 展开后不得为空串（空 = 任何人都能以主人身份操作）
  if (cfg.http.masterToken.trim().length === 0) {
    throw new ConfigError('surfaces.http.master_token 展开后为空（fail-closed）', path);
  }
  return cfg;
}
