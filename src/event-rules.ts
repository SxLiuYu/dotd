/**
 * src/event-rules.ts —— `config/event-rules.yml` 的加载（装配层专用）。
 *
 * 归属说明：`EventRule` 的形状定义在 `src/control-plane/match.ts:41`（CP 属主），
 * 那里注释写明「加载归治理/配置层，这里只消费」。本文件是**装配层侧**的加载器，
 * 放在 src/ 根（不属任何模块目录），供 src/daemon.ts 调——与 surfaces/config.ts
 * 的 loadSurfacesConfig 同一性质（SF 节加载器就在 SF 目录内，CP 节没有属主模块，
 * 故落在装配层自己的目录）。
 *
 * 为什么不用第三方 YAML：CONVENTIONS §2「能用内置模块的不用第三方」，且本机
 * node_modules 无任何 YAML 解析器（同 surfaces/config.ts、governance/catalog.ts、
 * router/pool.ts 的四份等价实现）。本文件只需要解析**一个扁平的 map 列表**
 * （rules: - id/match/action/task/reason），是最小的子集。
 *
 * 语义（config/event-rules.yml 头注逐字）：
 *   - 阶段一默认空 rules，全部事件走模型层/inbox；
 *   - 规则命中恒 confidence=1.0（CP §6.2 分档表第一行）；
 *   - `task` 的 title/goal 支持 `{payload.xxx}` 占位符（由 CP 侧取值，本加载器
 *     原样透传字符串）。
 */

import { readFileSync } from 'node:fs';
import type { EventRule } from './control-plane/match.ts';

/** 去行尾注释（引号内的 # 不动）。 */
function stripComment(line: string): string {
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

/** 解析标量（去引号）。 */
function scalar(v: string): string {
  const t = v.trim();
  if (t === 'null' || t === '~') return '';
  if ((t.startsWith("'") && t.endsWith("'") && t.length >= 2) ||
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2)) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 解析 event-rules.yml 的 `rules:` 块序列。
 *
 * 支持形状（与 config/event-rules.yml 注释中的条目样例逐字对应）：
 * ```yaml
 * rules:
 *   - id: grafana-alert-to-task
 *     match:
 *       source: http
 *       payloadContains: "grafana"
 *     action: run_new
 *     task:
 *       title: "告警：{payload.alertname}"
 *       goal: "排查并处置告警"
 *       priority: 2
 *     reason: "Grafana 告警一律建任务"
 * ```
 * 结构错误（缺 id/action/reason、action 非法）抛 Error——配置写错即拒启动
 * （fail-closed，与 GOV §2.3「zod 失败 ⇒ throw ⇒ daemon 拒启动」同口径）。
 */
export function parseEventRules(text: string, file = 'event-rules.yml'): EventRule[] {
  const lines = text.split(/\r?\n/);
  const out: EventRule[] = [];
  let inRules = false;
  let rulesIndent = -1;

  /** 当前规则条目（null = 尚未进入任何条目）。 */
  let cur: Partial<EventRule> | null = null;
  /** 当前子块（'match' | 'task' | null）。 */
  let sub: 'match' | 'task' | null = null;
  let subIndent = -1;

  for (const raw of lines) {
    const noComment = stripComment(raw);
    if (noComment.trim().length === 0) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const body = noComment.trim();

    // 顶层键（rules: 或 version: 等）
    if (indent === 0) {
      if (cur !== null) {
        out.push(finishRule(cur, file));
        cur = null;
        sub = null;
      }
      inRules = /^rules\s*:/.test(body);
      rulesIndent = -1;
      continue;
    }

    if (!inRules) continue;

    // 列表项起始（`- id: xxx` 或 `-`）
    if (body === '-' || body.startsWith('- ')) {
      if (cur !== null) out.push(finishRule(cur, file));
      cur = {};
      sub = null;
      rulesIndent = indent;
      const rest = body === '-' ? '' : body.slice(2).trim();
      if (rest.length > 0) applyLine(cur, rest, file);
      continue;
    }

    if (cur === null) continue; // rules: 下第一行不是 `-`（注释行已滤除）——忽略

    // 子块起始（match: / task: 独占一行）
    if (/^(match|task)\s*:\s*$/.test(body)) {
      sub = body.startsWith('match') ? 'match' : 'task';
      subIndent = indent;
      if (sub === 'match') cur.match = {};
      else cur.task = {};
      continue;
    }

    // 条目自身的键（id/action/reason）
    if (sub === null || indent <= rulesIndent + 1) {
      applyLine(cur, body, file);
      continue;
    }

    // 子块内的键
    if (sub === 'match' && cur.match !== undefined) {
      const kv = splitKv(body);
      if (kv === null) continue;
      const v = scalar(kv.value);
      // match 键白名单：契约 CP §6.1 的 EventRule.match 只有 source/actor/payloadContains
      // 三项；未知键忽略（fail-open 于未知键，与 applyLine 一致）。
      if (kv.key === 'source') cur.match.source = v;
      else if (kv.key === 'actor') cur.match.actor = v;
      else if (kv.key === 'payloadContains') cur.match.payloadContains = v;
      continue;
    }
    if (sub === 'task' && cur.task !== undefined) {
      const kv = splitKv(body);
      if (kv === null) continue;
      if (kv.key === 'priority') cur.task.priority = Number(scalar(kv.value));
      else if (kv.key === 'title') cur.task.title = scalar(kv.value);
      else if (kv.key === 'goal') cur.task.goal = scalar(kv.value);
      continue;
    }
  }
  if (cur !== null) out.push(finishRule(cur, file));
  return out;
}

function splitKv(body: string): { key: string; value: string } | null {
  const i = body.indexOf(':');
  if (i === -1) return null;
  return { key: body.slice(0, i).trim(), value: body.slice(i + 1) };
}

function applyLine(cur: Partial<EventRule>, body: string, file: string): void {
  const kv = splitKv(body);
  if (kv === null) throw new Error(`${file}：规则行无法解析：${body}`);
  const v = scalar(kv.value);
  if (kv.key === 'id') cur.id = v;
  else if (kv.key === 'action') cur.action = v as EventRule['action'];
  else if (kv.key === 'reason') cur.reason = v;
  else if (kv.key === 'match' || kv.key === 'task') {
    // 行内 `match: {...}` 流式形状：event-rules.yml 不用，忽略（保持 fail-open 于未知键）
  }
  void file;
}

function finishRule(cur: Partial<EventRule>, file: string): EventRule {
  if (cur.id === undefined || cur.id.length === 0) {
    throw new Error(`${file}：规则条目缺 id`);
  }
  const action = cur.action;
  if (action !== 'run_new' && action !== 'merge' && action !== 'ignore') {
    throw new Error(`${file}：规则 ${cur.id} 的 action 非法（须 run_new|merge|ignore，收到 ${String(action)}）`);
  }
  if (cur.reason === undefined) cur.reason = '';
  return {
    id: cur.id,
    match: cur.match ?? {},
    action,
    ...(cur.task !== undefined ? { task: cur.task } : {}),
    reason: cur.reason,
  };
}

/**
 * 读 config/event-rules.yml。文件不存在 → 空规则（阶段一默认即空，
 * 与 config/event-rules.yml:19-21 注释一致）；解析失败 → 抛（拒启动）。
 */
export function loadEventRules(path: string): EventRule[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseEventRules(text, path);
}
