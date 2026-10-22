/**
 * src/router/config.ts —— models.yml 加载与校验（MR §2.1）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md §2.1）：
 * - 配置可变部分全在两个 YAML：models.yml（tier1/2 端点 + routing/breaker/alerts/recon 节）
 *   与 free-models.yml（tier3 池，见 pool.ts）。
 * - "换供应商改一行配置"由 models.yml 的 base_url 热切换兑现（reloadConfig + 文件监听）。
 * - GOV §2.3 同款理念：配置校验失败 → throw ConfigError → daemon 拒启动（不静默回落默认值）。
 * - 本文件用极简映射解析（不引第三方 YAML 库；CONVENTIONS §2：能用内置模块的不用第三方）。
 * - 值支持 `${ENV_VAR}` / `${ENV_VAR:-默认值}`（解析前展开，见 expandEnvText）。
 */

import { readFileSync } from 'node:fs';
import { ConfigError } from '../shared/errors.ts';
import type { EndpointDef, Tier, Track } from '../shared/contracts.ts';
import type {
  AlertChannelName,
  AlertsConfig,
  BreakerConfig,
  ModelsConfig,
  ReconConfig,
  ReconSourceConfig,
  RoutingConfig,
} from './types.ts';
import { ALERTS_DEFAULTS, BREAKER_DEFAULTS, RECON_DEFAULTS } from './types.ts';
import { MAX_FALLBACK_MODELS } from './candidates.ts';

/** 求救通道白名单（channel_order 解析时逐项过滤，未知值直接丢弃）。 */
const ALERT_CHANNELS: readonly AlertChannelName[] = ['feishu', 'telegram', 'email', 'outbox'];

/** 读 models.yml 并解析（失败抛 ConfigError，拒启动）。 */
export function loadModelsConfig(path: string): ModelsConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`读不到 models.yml：${path}`, path, { cause });
  }
  const cfg = parseModelsYaml(expandEnvText(text, path), path);
  validateModelsConfig(cfg, path);
  return cfg;
}

/**
 * 展开 `${NAME}` / `${NAME:-默认值}`（models.yml 唯一的环境变量注入点，解析前做）。
 *
 * 为什么需要：tier2 的 Colibrì 只绑 Windows 127.0.0.1:8001，WSL 里的 daemon 要经
 * 默认网关 + win-relay 高位端口才够得着，而网关 IP 会随 WSL 重启漂移。写成环境变量
 * （默认值兜底）既保住"改一行配置换供应商"，又不用把易失的 IP 焊死在配置里。
 * 未设置且无默认值 → ConfigError 拒启动（静默变空串只会变成连不上的 URL）。
 * 在解析前替换而非解析后遍历：行内值里 `${…}` 自带花括号，会先被行内解析器切碎。
 */
function expandEnvText(text: string, file: string): string {
  if (!text.includes('${')) return text;
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}\n]*))?\}/g,
    (whole, name: string, dflt?: string) => {
      const v = process.env[name];
      if (v !== undefined && v.length > 0) return v;
      if (dflt !== undefined) return dflt;
      throw new ConfigError(`models.yml 引用未设置的环境变量 ${name}（可写 \${${name}:-默认值} 兜底）`, file);
    },
  );
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const t = v.replace(/\s+#.*$/, '').trim();
  if (t.length === 0 || t === 'null') return dflt;
  const n = Number(t);
  return Number.isFinite(n) ? n : dflt;
}

function scalar(v: string | undefined): string {
  const t = (v ?? '').replace(/\s+#.*$/, '').trim();
  if (t === 'null' || t === '~') return '';
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  const t = (v ?? '').trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return dflt;
}

/**
 * 行内值解析结果（MR §2.1 行内标量 / 嵌套映射 / 数组）。
 */
type InlineValue = string | InlineMapValue | InlineValue[];

interface InlineMapValue {
  [key: string]: InlineValue;
}

/**
 * 极简行内值解析器（只认 `{}` / `[]` / 标量三种，够 models.yml 用）。
 *
 * 为什么不用 split(',')：嵌套映射（MR §2.1 `warm_check.json_eq`，真实
 * dotd/config/models.yml:43 即 `json_eq: { expert_disk_s: 0 }`）按逗号切分会把
 * `{ expert_disk_s: 0 }` 切成裸字符串，二次解析得空对象 → warm 判据恒真，
 * 「/health 通过≠全量驻留」被静默作废。故用括号深度计数切分。
 */
class InlineParser {
  private i = 0;

  constructor(private readonly s: string) {}

  /** 顶层映射（不以 `{` 开头 → 空映射）。 */
  map(): InlineMapValue {
    const start = this.s.indexOf('{');
    if (start < 0) return {};
    this.i = start + 1;
    return this.pairs('}');
  }

  private peek(): string {
    return this.s[this.i] ?? '';
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  /**
   * 读到 stop 中任一字符（或串尾）为止；key 与行内标量值都用它。
   *
   * `${…}` 组内的 `}`、`,`、`:` 不算终止符——环境变量占位符（expandEnvText）
   * 自带花括号，按普通字符切会把 `${VAR:-http://h:18001}` 拦腰砍断。
   */
  private token(stop: string): string {
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '$' && this.s[this.i + 1] === '{') {
        depth++;
        this.i += 2;
        continue;
      }
      if (depth > 0) {
        if (c === '}') depth--;
        this.i++;
        continue;
      }
      if (stop.includes(c)) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }

  private pairs(close: string): InlineMapValue {
    const out: InlineMapValue = {};
    this.ws();
    if (this.peek() === close) {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const key = scalar(this.token(':,'));
      this.ws();
      if (this.peek() !== ':') return out;
      this.i++;
      const val = this.value();
      if (key.length > 0) out[key] = val;
      this.ws();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === close) this.i++;
      return out;
    }
  }

  private value(): InlineValue {
    this.ws();
    const c = this.peek();
    if (c === '{') {
      this.i++;
      return this.pairs('}');
    }
    if (c === '[') return this.array();
    return scalar(this.token(',}]'));
  }

  private array(): InlineValue[] {
    this.i++; // 吃掉 '['
    const out: InlineValue[] = [];
    this.ws();
    if (this.peek() === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === ']') this.i++;
      return out;
    }
  }
}

/** InlineValue → 字符串（嵌套值退化为 JSON 文本，调用方只对标量感兴趣）。 */
function inlineStr(v: InlineValue | undefined): string {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 解析 `{ a: 1, b: x }` 行内映射为字符串映射（timeouts/local 等平铺场景）。 */
function inlineMap(v: string): Record<string, string> {
  const deep = new InlineParser(v).map();
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(deep)) out[k] = inlineStr(val);
  return out;
}

/**
 * 解析 `{ primary: [a, b] }` 行内映射为字符串数组映射（fallback_models 用）。
 *
 * 与 inlineMap 的差别只在数组值不被 JSON.stringify 成文本——fallback 链要的是
 * 有序列表本身。标量值按单元素列表收（`primary: a` 等价 `primary: [a]`），
 * 非字符串元素（数字等）转字符串，空串丢弃。
 */
function inlineListMap(v: string): Record<string, string[]> {
  const deep = new InlineParser(v).map();
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(deep)) {
    const items = Array.isArray(val) ? val : [val];
    const list = items
      .map((item) => (typeof item === 'string' ? scalar(item) : inlineStr(item)))
      .filter((s) => s.length > 0);
    if (list.length > 0) out[k] = list;
  }
  return out;
}

/** 从 `warm_check` 行内值取 url 与判据映射（后者展平成字符串映射，固化时转 number）。 */
function extractWarmCheck(v: string): {
  url: string;
  jsonEq: Record<string, string>;
  jsonMax: Record<string, string>;
} {
  const m = new InlineParser(v).map();
  const url = scalar(inlineStr(m.url));
  const jsonEq: Record<string, string> = {};
  const raw = m.json_eq;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, val] of Object.entries(raw)) jsonEq[k] = inlineStr(val);
  }
  const jsonMax: Record<string, string> = {};
  const rawMax = m.json_max;
  if (rawMax !== null && typeof rawMax === 'object' && !Array.isArray(rawMax)) {
    for (const [k, val] of Object.entries(rawMax)) jsonMax[k] = inlineStr(val);
  }
  return { url, jsonEq, jsonMax };
}

/** 行首缩进空格数（续行块判定用）。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 把续行字段重组成行内映射文本，交给 InlineParser（复用同一套行内解析）。 */
function toInlineText(fields: Array<[string, string]>): string {
  if (fields.length === 0) return '{}';
  const parts = fields.map(([k, v]) => (v.length === 0 ? `${k}:` : `${k}: ${v}`));
  return `{ ${parts.join(', ')} }`;
}

/**
 * 端点内"键: 后面无值"的续行块（models/local/warm_check/json_eq/timeouts）。
 *
 * 真实 dotd/config/models.yml:19-21 的 openrouter-main 正是此形状：
 *   models:
 *     primary: anthropic/claude-sonnet-4.5
 *     light:   google/gemini-2.5-flash
 * 旧实现只认行内 `models: { primary: …, light: … }`，续行落到 applyEndpointField 的
 * default 被丢弃 → models={} → validateModelsConfig 抛"未声明任何 models"→ daemon 拒启。
 */
interface ContBlock {
  key: string;
  /** 父键自身缩进（子行必须更深才算它的续行）。 */
  indent: number;
  fields: Array<[string, string]>;
}

/** 可以带续行子键的键集合（其余键无值即真空值，不开块）。 */
const BLOCK_KEYS = new Set(['models', 'fallback_models', 'local', 'warm_check', 'json_eq', 'timeouts']);

/** 解析 models.yml（MR §2.1 全量形状）。 */
export function parseModelsYaml(text: string, file = 'models.yml'): ModelsConfig {
  // 行尾归一：Windows 工作区（core.autocrlf=true）读出来是 CRLF，只按 '\n' 切行
  // 会把 `\r` 留在每行末尾 —— 缩进判断、`# 注释`剥离、`key: value` 取值全部失真，
  // 实测整份 models.yml 被解析成 **0 个端点**（daemon 报「未定义任何端点」拒启动）。
  const lines = text.split(/\r?\n/);
  const cfg: ModelsConfig = {
    version: 1,
    reload_debounce_ms: 1500,
    endpoints: [],
    free_models_file: 'config/free-models.yml',
    routing: {
      default_track: 'primary',
      light_events: [],
      light_difficulties: ['trivial', 'simple'],
    },
    breaker: { ...BREAKER_DEFAULTS },
    alerts: { ...ALERTS_DEFAULTS, outbox_path: '~/.dotd/OUTBOX.md' },
    recon: { ...RECON_DEFAULTS, sources: [] },
  };

  type Section = 'none' | 'endpoints' | 'routing' | 'breaker' | 'alerts' | 'recon' | 'recon_sources';
  let section: Section = 'none';
  let curEp: MutableEndpoint | null = null;
  /** routing.light_events 的续行列表块（`- event.classify` 形状）。 */
  let curLightEvents: string[] | null = null;
  let curLightEventsIndent = 0;
  /** 端点内续行块栈（models/local/warm_check/json_eq/timeouts）。 */
  const contStack: ContBlock[] = [];

  const flushEp = (): void => {
    if (curEp !== null) {
      const ep = finalizeEndpoint(curEp);
      cfg.endpoints.push(ep);
      curEp = null;
    }
  };

  /** 出栈到给定缩进：块关闭即提交（有父块 → 并入父块字段，否则落到端点字段）。 */
  const contPopTo = (indent: number): void => {
    while (contStack.length > 0) {
      const top = contStack[contStack.length - 1];
      if (top === undefined || indent <= top.indent) {
        const b = contStack.pop();
        if (b === undefined) break;
        const inline = toInlineText(b.fields);
        const parent = contStack[contStack.length - 1];
        if (parent !== undefined) parent.fields.push([b.key, inline]);
        else if (curEp !== null) applyEndpointField(curEp, b.key, inline);
        continue;
      }
      break;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (line.trim().length === 0) continue;

    const top = /^(\S+):\s*(.*)$/.exec(line);
    if (top !== null && !/^\s/.test(line)) {
      contPopTo(0); // 顶层键 = 所有续行块到此结束
      curLightEvents = null;
      const k = top[1]!;
      const v = top[2] ?? '';
      switch (k) {
        case 'endpoints':
          flushEp();
          section = 'endpoints';
          continue;
        case 'routing':
          section = 'routing';
          continue;
        case 'breaker':
          section = 'breaker';
          continue;
        case 'alerts':
          section = 'alerts';
          continue;
        case 'recon':
          section = 'recon';
          continue;
        case 'free_models_file':
          cfg.free_models_file = scalar(v) || cfg.free_models_file;
          section = 'none';
          continue;
        case 'version':
          cfg.version = num(v, 1);
          section = 'none';
          continue;
        case 'reload_debounce_ms':
          cfg.reload_debounce_ms = num(v, 1500);
          section = 'none';
          continue;
        default:
          section = 'none';
          continue;
      }
    }

    if (section === 'endpoints') {
      const ind = indentOf(line);
      contPopTo(ind); // 同级/更浅键、新端点项都先关闭已开块
      const item = /^\s*-\s+(\S+):\s*(.*)$/.exec(line);
      if (item !== null) {
        flushEp();
        curEp = {
          id: scalar(item[2]),
          tier: 1,
          baseUrl: '',
          apiKeyEnv: null,
          models: {},
          fallbackModels: {},
          style: 'openai',
          enabled: true,
          timeouts: { connect_ms: 5000, idle_ms: 60000, total_ms: 180000 },
          emergencyEligible: true,
        };
        const k = item[1];
        if (k !== undefined && k !== 'id') applyEndpointField(curEp, k, item[2] ?? '');
        continue;
      }
      const kv = /^\s+(\S+):\s*(.*)$/.exec(line);
      if (kv !== null && curEp !== null) {
        const k = kv[1];
        if (k === undefined) continue;
        const val = (kv[2] ?? '').trim();
        const open = contStack[contStack.length - 1];
        if (val.length === 0 && BLOCK_KEYS.has(k)) {
          contStack.push({ key: k, indent: ind, fields: [] });
          continue;
        }
        if (open !== undefined) {
          // 更深缩进的续行键：原样收进当前块，块关闭时统一交给 applyEndpointField
          open.fields.push([k, val]);
          continue;
        }
        applyEndpointField(curEp, k, val);
      }
      continue;
    }

    if (section === 'routing') {
      const ind = indentOf(line);
      if (curLightEvents !== null && ind <= curLightEventsIndent) curLightEvents = null;
      const listItem = /^\s*-\s*(\S.*)$/.exec(line);
      if (listItem !== null) {
        // 列表项只可能属于 light_events（§2.1 routing 下唯一列表）
        if (curLightEvents !== null) curLightEvents.push(scalar(listItem[1]!));
        continue;
      }
      const kv = /^\s+(\S+):\s*(.*)$/.exec(line);
      if (kv === null) continue;
      if (kv[1] === 'default_track') {
        const t = scalar(kv[2]);
        cfg.routing.default_track = t === 'light' ? 'light' : 'primary';
      } else if (kv[1] === 'light_events') {
        const v = (kv[2] ?? '').trim();
        if (v.startsWith('[')) {
          cfg.routing.light_events = v
            .slice(1, v.endsWith(']') ? -1 : undefined)
            .split(',')
            .map((s) => scalar(s))
            .filter((s) => s.length > 0);
          curLightEvents = null;
        } else {
          curLightEvents = [];
          cfg.routing.light_events = curLightEvents;
          curLightEventsIndent = ind;
        }
      } else if (kv[1] === 'light_difficulties') {
        const v = (kv[2] ?? '').trim();
        if (v.startsWith('[')) {
          cfg.routing.light_difficulties = v
            .slice(1, v.endsWith(']') ? -1 : undefined)
            .split(',')
            .map((s) => scalar(s))
            .filter((s) => s.length > 0);
        }
        // 无方括号时保持缺省（['trivial','simple']）——续行列表形状对本键不必要：
        // 它最多三个值，行内写得下。真写了续行块会被上面的 listItem 分支吞掉，
        // 那正是 light_events 曾经的坑，不重犯。
      }
      continue;
    }

    if (section === 'breaker') {
      const kv = /^\s+(\S+):\s*(.*)$/.exec(line);
      if (kv === null) continue;
      const k = kv[1];
      if (k === undefined) continue;
      assignNumber(
        cfg.breaker as unknown as Record<string, number>,
        k,
        kv[2],
        BREAKER_DEFAULTS as unknown as Record<string, number>,
      );
      continue;
    }

    if (section === 'alerts') {
      const kv = /^\s+(\S+):\s*(.*)$/.exec(line);
      if (kv === null) continue;
      if (kv[1] === 'outbox_path') cfg.alerts.outbox_path = scalar(kv[2]) || cfg.alerts.outbox_path;
      else if (kv[1] === 'channel_order') {
        const v = (kv[2] ?? '').trim();
        cfg.alerts.channel_order = v
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => scalar(s))
          .filter((s): s is AlertChannelName => ALERT_CHANNELS.includes(s as AlertChannelName));
      } else if (kv[1] === 'dedup_window_ms') cfg.alerts.dedup_window_ms = num(kv[2], cfg.alerts.dedup_window_ms);
      else if (kv[1] === 'channel_timeout_ms') {
        cfg.alerts.channel_timeout_ms = num(kv[2], cfg.alerts.channel_timeout_ms);
      }
      continue;
    }

    if (section === 'recon' || section === 'recon_sources') {
      const src = /^\s*-\s+(\S+):\s*(.*)$/.exec(line);
      if (src !== null) {
        const s: ReconSourceConfig = { type: 'openrouter_models' };
        applyReconSource(s, src[1]!, src[2] ?? '');
        cfg.recon.sources.push(s);
        section = 'recon_sources';
        continue;
      }
      const kv = /^\s+(\S+):\s*(.*)$/.exec(line);
      if (kv === null) continue;
      const k = kv[1]!;
      const v = kv[2] ?? '';
      if (k === 'sources') {
        section = 'recon_sources';
        continue;
      }
      if (k === 'interval_ms') cfg.recon.interval_ms = num(v, cfg.recon.interval_ms);
      else if (k === 'max_candidates_per_scan') {
        cfg.recon.max_candidates_per_scan = num(v, cfg.recon.max_candidates_per_scan);
      } else if (k === 'candidate_ttl_ms') cfg.recon.candidate_ttl_ms = num(v, cfg.recon.candidate_ttl_ms);
      else if (k === 'rejected_cooldown_ms') {
        cfg.recon.rejected_cooldown_ms = num(v, cfg.recon.rejected_cooldown_ms);
      } else {
        // sources 下一条目的续行
        const last = cfg.recon.sources[cfg.recon.sources.length - 1];
        if (last !== undefined) applyReconSource(last, k, v);
      }
      continue;
    }
  }
  contPopTo(0); // 文件结尾：关闭所有未闭续行块
  flushEp();
  return cfg;
}

function applyReconSource(s: ReconSourceConfig, key: string, value: string): void {
  const v = scalar(value);
  if (key === 'type') s.type = v === 'github_curated' ? 'github_curated' : 'openrouter_models';
  else if (key === 'filter') s.filter = v;
  else if (key === 'api_url') s.api_url = v;
  else if (key === 'raw_via') s.raw_via = v === 'base64' ? 'base64' : undefined;
}

/**
 * 端点中间态：字段与 EndpointDef 相同，但 local 先按"字符串映射"累积
 * （YAML 既可能行内 `local: {…}` 也可能缩进续行逐键给），finalizeEndpoint 固化。
 */
interface MutableEndpoint {
  id: string;
  tier: Tier;
  baseUrl: string;
  apiKeyEnv: string | null;
  models: Partial<Record<Track, string>>;
  fallbackModels: Partial<Record<Track, string[]>>;
  style: 'openai';
  enabled: boolean;
  timeouts: { connect_ms: number; idle_ms: number; total_ms: number };
  emergencyEligible: boolean;
  /** 中间态：原始字符串值；finalizeEndpoint 转成 EndpointDef['local']。 */
  local?: Record<string, string>;
  /** P1-1：端点顶层的生产并发上限（与 `local.max_concurrency` 不同，远程端点用）。 */
  maxConcurrency?: number;
}

function applyEndpointField(ep: MutableEndpoint, key: string, value: string): void {
  const v = value.trim();
  switch (key) {
    case 'id':
      ep.id = scalar(value);
      break;
    case 'tier': {
      const t = Number(scalar(value));
      ep.tier = t === 2 ? 2 : t === 3 ? 3 : t === 4 ? 4 : 1;
      break;
    }
    case 'base_url':
      ep.baseUrl = scalar(value);
      break;
    case 'api_key_env': {
      const s = scalar(value);
      ep.apiKeyEnv = s.length === 0 || s === 'none' ? null : s;
      break;
    }
    case 'style':
      ep.style = 'openai';
      break;
    case 'enabled':
      ep.enabled = bool(value, true);
      break;
    case 'emergency_eligible':
      ep.emergencyEligible = bool(value, true);
      break;
    // P1-1：端点**顶层**的 max_concurrency = 生产请求并发上限（远程端点用）。
    // 注意与 `local:` 段下的同名续行键区分：那个是 Tier2 本地引擎的硬上限。
    case 'max_concurrency': {
      const n = Number(scalar(value));
      if (Number.isFinite(n) && n > 0) ep.maxConcurrency = Math.floor(n);
      break;
    }
    case 'models': {
      const m = inlineMap(v);
      const models: Partial<Record<Track, string>> = {};
      if (m.primary !== undefined) models.primary = scalar(m.primary);
      if (m.light !== undefined) models.light = scalar(m.light);
      ep.models = models;
      break;
    }
    case 'fallback_models': {
      // 形状：`{ primary: [a, b], light: [c] }`（行内）或续行块
      //   fallback_models:
      //     primary: [a, b]
      // 只支持行内数组——YAML 块列表（`- a`）在本仓库的极简解析器里会被静默丢弃
      // （续行块只收 `key: value` 对），所以不用它，免得配了不生效。
      const m = inlineListMap(v);
      ep.fallbackModels = m;
      break;
    }
    case 'timeouts': {
      const m = inlineMap(v);
      ep.timeouts = {
        connect_ms: num(m.connect_ms, ep.timeouts.connect_ms),
        idle_ms: num(m.idle_ms, ep.timeouts.idle_ms),
        total_ms: num(m.total_ms, ep.timeouts.total_ms),
      };
      break;
    }
    case 'local': {
      // 行内映射：按字符串原样落进中间态，finalizeEndpoint 统一转数字
      const m = inlineMap(v);
      const next: Record<string, string> = {
        health_url: scalar(m.health_url),
        max_concurrency: scalar(m.max_concurrency),
        queue_reject_ms: scalar(m.queue_reject_ms),
      };
      const grace = scalar(m.warm_grace_ms ?? '');
      if (grace.length > 0) next.warm_grace_ms = grace;
      // warm_check 可能行内嵌在 local 内（§2.1：`local: { …, warm_check: { url, json_eq } }`），
      // 也可能是续行块重组进来的子键；两种形状都从映射里取，不假设只有顶层 url。
      const wc = extractWarmCheck(m.warm_check ?? (m.url !== undefined ? v : ''));
      if (wc.url.length > 0) {
        next.warm_url = wc.url;
        next.warm_json_eq = toInlineText(Object.entries(wc.jsonEq));
        next.warm_json_max = toInlineText(Object.entries(wc.jsonMax));
      }
      ep.local = next;
      break;
    }
    case 'health_url':
    case 'warm_check':
    case 'warm_grace_ms':
    case 'max_concurrency':
    case 'queue_reject_ms': {
      // local: 下的续行（缩进两级，逐键给）
      if (ep.local === undefined) {
        ep.local = { health_url: '', max_concurrency: '1', queue_reject_ms: '8000' };
      }
      const local: Record<string, string> = ep.local;
      if (key === 'health_url') local.health_url = scalar(value);
      else if (key === 'warm_grace_ms') local.warm_grace_ms = scalar(value);
      else if (key === 'max_concurrency') local.max_concurrency = scalar(value);
      else if (key === 'queue_reject_ms') local.queue_reject_ms = scalar(value);
      else if (key === 'warm_check') {
        // 行内 `warm_check: { url: …, json_eq: { … } }`（§2.1 warm 判据）
        const wc = extractWarmCheck(v);
        local.warm_url = wc.url;
        local.warm_json_eq = toInlineText(Object.entries(wc.jsonEq));
        local.warm_json_max = toInlineText(Object.entries(wc.jsonMax));
      }
      break;
    }
    default:
      break;
  }
}

/** 把中间态（字符串映射）固化成 EndpointDef.local。 */
function finalizeEndpoint(ep: MutableEndpoint): EndpointDef {
  const base: EndpointDef = {
    id: ep.id,
    tier: ep.tier,
    baseUrl: ep.baseUrl,
    apiKeyEnv: ep.apiKeyEnv,
    models: ep.models,
    style: ep.style,
    enabled: ep.enabled,
    timeouts: ep.timeouts,
    emergencyEligible: ep.emergencyEligible,
  };
  const fb = sanitizeFallbackModels(ep.fallbackModels);
  if (fb !== undefined) base.fallbackModels = fb;
  // P1-1：端点顶层的 max_concurrency = 生产请求并发上限（远程端点用，与 local: 段无关）。
  if (ep.maxConcurrency !== undefined && ep.maxConcurrency > 0) {
    base.maxConcurrency = ep.maxConcurrency;
  }
  if (ep.local === undefined) return base;  const raw = ep.local;
  const local: NonNullable<EndpointDef['local']> = {
    health_url: raw.health_url ?? '',
    max_concurrency: num(raw.max_concurrency, 1),
    queue_reject_ms: num(raw.queue_reject_ms, 8000),
  };
  if (raw.warm_grace_ms !== undefined && raw.warm_grace_ms.length > 0) {
    local.warm_grace_ms = num(raw.warm_grace_ms, 150000);
  }
  if (raw.warm_url !== undefined && raw.warm_url.length > 0) {
    // warm_json_eq / warm_json_max 已是展平的 `{ k: v }` 行内文本（见 extractWarmCheck），逐个转 number
    const jsonEq = numberMap(inlineMap(raw.warm_json_eq ?? ''));
    const jsonMax = numberMap(inlineMap(raw.warm_json_max ?? ''));
    const check: NonNullable<EndpointDef['local']>['warm_check'] = { url: raw.warm_url };
    if (Object.keys(jsonEq).length > 0) check.json_eq = jsonEq;
    if (Object.keys(jsonMax).length > 0) check.json_max = jsonMax;
    local.warm_check = check;
  }
  const out: EndpointDef = { ...base, local };
  return out;
}

/**
 * 固化 fallback_models：去重、去空、截断到上限。
 *
 * 只做"形状合法化"。给端点没声明的轨配备份是死配置，但那类错误交给
 * validateModelsConfig 抛（能带上端点 id 与轨名），不在这里静默丢弃。
 */
function sanitizeFallbackModels(
  raw: Partial<Record<Track, string[]>>,
): Partial<Record<Track, string[]>> | undefined {
  const out: Partial<Record<Track, string[]>> = {};
  for (const track of ['primary', 'light'] as const) {
    const list = raw[track];
    if (list === undefined || list.length === 0) continue;
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const m of list) {
      const s = m.trim();
      if (s.length === 0 || seen.has(s)) continue;
      seen.add(s);
      dedup.push(s);
      if (dedup.length >= MAX_FALLBACK_MODELS) break;
    }
    if (dedup.length > 0) out[track] = dedup;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 展平的 `{ k: v }` 行内文本 → 数字映射（非数字项丢弃，见 finalizeEndpoint）。 */
function numberMap(m: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(m)) {
    const n = Number(scalar(val));
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function assignNumber(
  target: Record<string, number>,
  key: string,
  value: string | undefined,
  dflt: Record<string, number>,
): void {
  const d = dflt[key];
  if (d === undefined) return;
  target[key] = num(value, d);
}

/** 启动期校验（GOV §2.3 同款：失败即拒启动）。 */
export function validateModelsConfig(cfg: ModelsConfig, file: string): void {
  if (cfg.endpoints.length === 0) {
    throw new ConfigError('models.yml 未定义任何端点', file);
  }
  const seen = new Set<string>();
  for (const ep of cfg.endpoints) {
    if (ep.id.length === 0) throw new ConfigError('存在 id 为空的端点', file);
    if (seen.has(ep.id)) throw new ConfigError(`端点 id 重复：${ep.id}`, file);
    seen.add(ep.id);
    if (ep.baseUrl.length === 0) throw new ConfigError(`端点 ${ep.id} 缺 base_url`, file);
    if (ep.tier === 2 && ep.local === undefined) {
      throw new ConfigError(`Tier2 端点 ${ep.id} 缺 local 节（health_url 等必填）`, file);
    }
    if (ep.tier === 2 && ep.local !== undefined && ep.local.health_url.length === 0) {
      throw new ConfigError(`Tier2 端点 ${ep.id} 的 local.health_url 为空`, file);
    }
    if (Object.keys(ep.models).length === 0) {
      throw new ConfigError(`端点 ${ep.id} 未声明任何 models（primary/light 至少一个）`, file);
    }
    // fallback_models 只能给端点确实服务的轨配备份。给不存在的轨配是死配置
    // （那条轨永远不会选到这个端点），配了不生效比报错更难查。
    const fb = ep.fallbackModels;
    if (fb !== undefined) {
      for (const track of ['primary', 'light'] as const) {
        if (fb[track] !== undefined && ep.models[track] === undefined) {
          throw new ConfigError(
            `端点 ${ep.id} 的 fallback_models.${track} 无对应 models.${track}（备份轨必须主轨先服务）`,
            file,
          );
        }
      }
    }
    // warm_check 空判据 = 闸门恒过，「/health 通过≠全量驻留」被静默作废（2026-10-17
    // 全方位测试：原 colibri-olmoe 判据写错嵌套层级，等效于此）。拒启动 rather than 放行。
    const wc = ep.local?.warm_check;
    if (wc !== undefined && Object.keys(wc.json_eq ?? {}).length === 0 && Object.keys(wc.json_max ?? {}).length === 0) {
      throw new ConfigError(`端点 ${ep.id} 的 warm_check 无有效判据（json_eq/json_max 至少一个非空）`, file);
    }
  }
  if (cfg.alerts.channel_order.length === 0) {
    throw new ConfigError('alerts.channel_order 为空', file);
  }
  if (!cfg.alerts.channel_order.includes('outbox')) {
    throw new ConfigError('alerts.channel_order 必须含 outbox（最后一级兜底，§4.5）', file);
  }
}
