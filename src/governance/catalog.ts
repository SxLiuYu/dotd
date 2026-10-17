/**
 * src/governance/catalog.ts —— 工具档位目录与人工收紧规则的 zod 加载（GOV §2.2/§2.3/§2.6）。
 *
 * 逐字来源：governance.md §2.3 的 zod 形状 + §2.2 tools.yml + §2.6 rules.yml；
 * 接缝契约 G1 连锁修改：`identityParam` 字段与 zod 必填校验**作废**
 * （登录态谓词改顶层 ToolCall.identity，见 src/shared/contracts.ts:isLoginSensitive）。
 *
 * 校验细则（GOV §2.3 逐字）：
 * - `tier == "spend"` 的条目必须带 spendParams（缺则加载失败）；
 * - 未登记的工具一律 deny（白名单制，白名单在执行方 evaluate）；
 * - rules.yml 自定义规则只能收紧（allow→approve 之类降档在加载时拒绝并告警）。
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ToolTier } from '../shared/contracts.ts';
import { ConfigError } from '../shared/errors.ts';
import { DEFAULT_POLICY, stricterOrEqual } from './policy.ts';
import type { Decision0 } from './policy.ts';

// ── zod 形状（GOV §2.3 逐字；rev2 修列：upgrade 与 YAML 数据形状一致）──────────────

const Tier = z.enum(['read', 'write_file', 'browser', 'spend', 'dangerous']);

/** GOV §2.3 ToolDef（identityParam 已按契约 G1 删除）。 */
export const ToolDef = z.object({
  name: z.string().min(3), // 与执行面注册名逐字一致
  tier: Tier,
  pathPrefixes: z.array(z.string()).optional(),
  spendParams: z
    .object({ required: z.array(z.string()).min(1) })
    .optional(),
  upgrade: z
    .object({
      tier: Tier,
      whenContains: z.array(z.string()).min(1), // 子串匹配，见 §3.1 upgradeHit
    })
    .optional(),
});

export const CatalogFile = z.object({ tools: z.array(ToolDef).nonempty() });

export type ToolDefT = z.infer<typeof ToolDef>;

/** GOV §2.6 rules.yml 条目形状（match 字段：tool / urlHost；其余谓词由本加载器定义）。 */
export const RuleDef = z.object({
  match: z
    .object({
      tool: z.string().optional(),
      urlHost: z.string().optional(),
      pathPrefix: z.string().optional(),
    })
    .default({}),
  decision: z.enum(['allow', 'review', 'approve', 'deny']),
  reason: z.string().min(1),
});

export const RulesFile = z.object({ rules: z.array(RuleDef).default([]) });

export type RuleDefT = z.infer<typeof RuleDef>;

// ── 解析后的目录 ────────────────────────────────────────────────────────────

export interface Catalog {
  /** name → 定义（含加载时的规范化校验结果）。 */
  tools: Map<string, ToolDefT>;
  /** 人工收紧规则（rules.yml，永远压过记忆）。 */
  rules: RuleDefT[];
}

/** 单条加载告警（GOV §2.6：降档在加载时被拒绝并告警——此处记录供 CLI/启动日志展示）。 */
export interface CatalogWarning {
  kind: 'rule_not_stricter' | 'rule_rejected' | 'spend_without_params' | 'unknown_tool_rule';
  detail: string;
}

export interface CatalogLoadResult {
  catalog: Catalog;
  warnings: CatalogWarning[];
}

// ── 最小 YAML 解析器（dotd 配置子集：块映射/块序列/流式集合/标量）────────────────
//
// 覆盖 dotd 六份 yml 实际用到的语法：
//   块映射（`key: value` / `key:` + 更深缩进子块）、块序列（`- item` / `- key: v`）、
//   流式集合（`[a, b]` / `{k: v}`）、标量（bool/int/float/null/引号串）、行尾注释。
// 明确不支持（也不需要）：锚点别名、多行折叠标量、复杂键、显式文档分隔多文档。
//
// 实现：先切成带缩进与原始行的 token 流，再按缩进递归下降。**保留每行原始缩进**是
// 正确处理「list item 首行 `- name: x` 后续同缩进 `tier: read` 属同一 map」的关键
// ——虚拟地把 `- ` 之后的文本提升到 `-` 的列位置即可。

interface YamlLine {
  /** 该行去除注释后的内容（可能为空串）。 */
  text: string;
  /** 首非空字符列（0 起）。空行为 -1。 */
  indent: number;
}

function tokenizeYaml(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(raw);
    const trimmed = stripped.trim();
    if (trimmed === '') {
      out.push({ text: '', indent: -1 });
      continue;
    }
    out.push({
      text: trimmed,
      indent: stripped.length - stripped.trimStart().length,
    });
  }
  return out;
}

/** 去行尾注释（引号内的 `#` 不算）。 */
function stripYamlComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) return s.slice(0, k);
  }
  return s;
}

class YamlParser {
  private readonly lines: YamlLine[];
  private pos = 0;

  constructor(text: string) {
    this.lines = tokenizeYaml(text);
  }

  /** 解析顶层（缩进 0 的块）。 */
  parse(): unknown {
    const v = this.parseBlock(0);
    return v;
  }

  private peek(): YamlLine | null {
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos]!;
      if (l.indent === -1) {
        this.pos++;
        continue;
      }
      return l;
    }
    return null;
  }

  /** 解析缩进 >= indent 的块（映射或序列，由首行形状判定）。 */
  private parseBlock(indent: number): unknown {
    const first = this.peek();
    if (first === null || first.indent < indent) return null;
    return first.text.startsWith('- ') || first.text === '-'
      ? this.parseSeq(first.indent)
      : this.parseMap(first.indent);
  }

  private parseSeq(indent: number): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (l === null || l.indent < indent) break;
      if (!(l.text.startsWith('- ') || l.text === '-')) break;
      if (l.indent > indent) {
        throw new Error(`YAML 序列缩进不一致（期望 ${indent}，实得 ${l.indent}）：${l.text}`);
      }
      this.pos++;
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      if (rest === '') {
        // `-` 独行：子块在更深缩进
        const child = this.peek();
        items.push(child !== null && child.indent > indent ? this.parseBlock(indent + 1) : null);
        continue;
      }
      // `- key: value`：把 rest 当作该 item 的首个映射行处理；后续同层续行归入同一映射。
      const virtIndent = indent + 2;
      const savedLines = this.lines.slice();
      const savedPos = this.pos;
      // 用"虚拟行"把 rest 顶替当前已消费位置，再按映射解析
      const head: YamlLine = { text: rest, indent: virtIndent };
      this.lines.splice(this.pos, 0, head);
      const item = this.parseItemMap(virtIndent);
      if (item === null) {
        // rest 不是 `k: v` 形态（裸标量/流式集合）
        this.lines.length = 0;
        this.lines.push(...savedLines);
        this.pos = savedPos + 1;
        items.push(parseScalar(rest));
        continue;
      }
      items.push(item);
    }
    return items;
  }

  /** 解析 list item 的映射部分（含更深缩进的嵌套块）。 */
  private parseItemMap(indent: number): Record<string, unknown> | null {
    const map = new Map<string, unknown>();
    let first = true;
    for (;;) {
      const l = this.peek();
      if (l === null || l.indent < indent) break;
      if (l.text.startsWith('- ') || l.text === '-') break;
      if (l.indent > indent) {
        throw new Error(`YAML 映射缩进不一致（期望 ${indent}，实得 ${l.indent}）：${l.text}`);
      }
      const kv = splitKeyValue(l.text);
      if (kv === null) {
        if (first) return null;
        throw new Error(`YAML 行无法解析（缺冒号）：${l.text}`);
      }
      first = false;
      this.pos++;
      if (kv.value === '') {
        const child = this.peek();
        map.set(kv.key, child !== null && child.indent > indent ? this.parseBlock(indent + 1) : null);
      } else {
        map.set(kv.key, parseScalar(kv.value));
      }
    }
    return Object.fromEntries(map);
  }

  private parseMap(indent: number): Record<string, unknown> {
    const map = new Map<string, unknown>();
    for (;;) {
      const l = this.peek();
      if (l === null || l.indent < indent) break;
      if (l.text === '---' || l.text === '...') {
        this.pos++;
        continue;
      }
      if (l.text.startsWith('- ') || l.text === '-') break;
      if (l.indent > indent) {
        throw new Error(`YAML 映射缩进不一致（期望 ${indent}，实得 ${l.indent}）：${l.text}`);
      }
      const kv = splitKeyValue(l.text);
      if (kv === null) throw new Error(`YAML 行无法解析（缺冒号）：${l.text}`);
      this.pos++;
      if (kv.value === '') {
        const child = this.peek();
        map.set(kv.key, child !== null && child.indent > indent ? this.parseBlock(indent + 1) : null);
      } else {
        map.set(kv.key, parseScalar(kv.value));
      }
    }
    return Object.fromEntries(map);
  }
}

/** 切 `key: value`（value 里的冒号不算——引号与流式集合内跳过）。 */
function splitKeyValue(text: string): { key: string; value: string } | null {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) {
        const key = text.slice(0, k).trim();
        const value = text.slice(k + 1).trim();
        if (key === '') return null;
        return { key, value };
      }
    }
  }
  return null;
}

function parseSimpleYaml(text: string): unknown {
  return new YamlParser(text).parse();
}

function parseScalar(v: string): unknown {
  if (v === '[]') return [];
  if (v === '{}') return {};
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return {};
    const out: Record<string, unknown> = {};
    for (const pair of inner.split(',')) {
      const c = pair.indexOf(':');
      if (c === -1) continue;
      out[pair.slice(0, c).trim()] = parseScalar(pair.slice(c + 1).trim());
    }
    return out;
  }
  return v;
}

// ── 加载入口（GOV §2.3：zod 失败 ⇒ throw ⇒ daemon 拒启动）─────────────────────

function readYamlFile(p: string): unknown {
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch (cause) {
    throw new ConfigError(`读不到配置文件 ${p}`, p, { cause });
  }
  try {
    return parseSimpleYaml(text);
  } catch (cause) {
    throw new ConfigError(`YAML 解析失败：${(cause as Error).message}`, p, { cause });
  }
}

/**
 * GOV §2.3 loadCatalog(p)：启动校验，zod 失败 ⇒ throw ⇒ daemon 拒启动。
 *
 * 额外校验（§2.3「校验细则」逐字）：
 * - tier == "spend" 必须带 spendParams（缺则加载失败）；
 * - 同名工具重复登记 ⇒ 加载失败（白名单制要求逐名唯一）。
 */
export function loadCatalogFile(p: string): CatalogLoadResult {
  const raw = readYamlFile(p);
  const parsed = CatalogFile.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `tools.yml 校验失败：${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      p,
    );
  }
  const tools = new Map<string, ToolDefT>();
  for (const def of parsed.data.tools) {
    if (def.tier === 'spend' && def.spendParams === undefined) {
      // GOV §2.3：spend 条目必须带 spendParams——钱都算不清的事不进审批（§2.5）。
      throw new ConfigError(`工具 ${def.name} 档位为 spend 但缺 spendParams.required`, p);
    }
    if (tools.has(def.name)) {
      throw new ConfigError(`工具 ${def.name} 重复登记（白名单制要求逐名唯一）`, p);
    }
    tools.set(def.name, def);
  }
  return { catalog: { tools, rules: [] }, warnings: [] };
}

/**
 * GOV §2.6 loadRules(p)：人工收紧规则，只能收紧不能放宽。
 * 试图放宽（approve→allow 之类）的条目在加载时**拒绝并告警**（该条不生效）。
 */
export function loadRulesFile(p: string, catalog: Catalog): CatalogLoadResult {
  const raw = readYamlFile(p);
  const parsed = RulesFile.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `rules.yml 校验失败：${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      p,
    );
  }
  const warnings: CatalogWarning[] = [];
  const accepted: RuleDefT[] = [];
  for (const rule of parsed.data.rules) {
    if (rule.match.tool !== undefined && !catalog.tools.has(rule.match.tool)) {
      // 收紧未登记的工具无意义（该工具本来就 deny），拒绝并告警。
      warnings.push({
        kind: 'unknown_tool_rule',
        detail: `rules.yml 引用未登记工具 ${rule.match.tool}，该条不生效`,
      });
      continue;
    }
    const tightened = rule.match.tool !== undefined
      ? DEFAULT_POLICY[catalog.tools.get(rule.match.tool)!.tier]
      : 'allow';
    if (!stricterOrEqual(tightened, rule.decision as Decision0)) {
      warnings.push({
        kind: 'rule_not_stricter',
        detail: `rules.yml 条目 ${JSON.stringify(rule.match)} 试图把 ${tightened} 放宽为 ${rule.decision}，已拒绝`,
      });
      continue;
    }
    accepted.push(rule);
  }
  catalog.rules = accepted;
  return { catalog, warnings };
}

/** 便捷入口：同时加载 tools.yml 与 rules.yml（装配层与测试用）。 */
export function loadCatalog(toolsPath: string, rulesPath?: string): CatalogLoadResult {
  const { catalog, warnings: w1 } = loadCatalogFile(toolsPath);
  if (rulesPath === undefined) return { catalog, warnings: w1 };
  const { catalog: c2, warnings: w2 } = loadRulesFile(rulesPath, catalog);
  return { catalog: c2, warnings: [...w1, ...w2] };
}

/** 目录查询（未登记 ⇒ undefined，调用方 deny，白名单制）。 */
export function lookupTool(catalog: Catalog, name: string): ToolDefT | undefined {
  return catalog.tools.get(name);
}

/** spend 参数契约校验（GOV §2.5：缺失或类型错 ⇒ deny("spend 参数契约不满足")）。 */
export function spendContractOk(
  def: ToolDefT,
  params: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[] } {
  if (def.spendParams === undefined) return { ok: true };
  const missing: string[] = [];
  for (const key of def.spendParams.required) {
    const v = params[key];
    if (v === undefined || v === null) {
      missing.push(key);
      continue;
    }
    if (key === 'amountCents' && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      missing.push(`${key}(需为正整数)`);
    }
    if (key === 'currency' && !(typeof v === 'string' && /^[A-Z]{3}$/.test(v))) {
      missing.push(`${key}(需 ISO4217 三字母)`);
    }
    if (key === 'category' && !(typeof v === 'string' && v.length > 0)) {
      missing.push(`${key}(需非空字符串)`);
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** GOV §2.1/§9.1：从 URL 取 host（browser/net 类规则的 urlHost 匹配用）。 */
export function hostOfUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u === '') return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}
