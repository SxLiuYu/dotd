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
import { parse as parseYaml } from 'yaml';
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

// ── YAML 解析（2026-10-19 换用成熟库 yaml@2）────────────────────────────────
//
// 原来这里是约 220 行手写解析器（tokenizeYaml / YamlParser / splitKeyValue / parseScalar）。
// 换掉的理由不是"代码丑"，是**它反复出事**：
//   ① 流式数组用朴素 split(逗号) 切分，不感知引号；
//   ② 单引号字符串跨行吞并 —— 注释里写一个单引号就能让后续语句全部错位；
//   ③ 多行块序列在某些缩进下解析残缺（实测 tools.yml 20 项只认出 11 项）。
// 这些都是「自己实现的解析器必然要处理的边界」，而标准库已经处理好了。
//
// 语义差异：标准 YAML 比手写版**更宽松**（支持锚点、多行标量、多文档等）。
// 对 dotd 无害 —— 配置文件是我们自己写的，宽松只会更不容易出错。
// zod 校验（CatalogFile / RulesFile）仍然是真正的守门人，YAML 层只负责"变成对象"。

function parseSimpleYaml(text: string): unknown {
  // 用 yaml 库的 parse；失败抛错（调用方 readYamlFile 会包装成 ConfigError）
  return parseYaml(text);
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
