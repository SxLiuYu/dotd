/**
 * src/runner/plan.ts —— P2-2 显式计划与目标锚定。
 *
 * ## 这是什么，不是什么
 *
 * **是**：一份**可观测的产物**。任务开始时让模型写一份 3–7 条的短计划，存进 thread；
 * 之后每一轮 LLM 请求把它作为一条 system 注记带上（抗跑偏），主人能在
 * `dotd task --verbose` 里看见"它打算怎么干"，任务结束能对比计划 vs 实际。
 *
 * **不是**：新的控制流。主循环仍然是 `stepLlm → stepTool` 的自由决策循环——
 * **计划绝不驱动执行顺序**。dotd 的卖点就是"不是固定 DAG、由模型在运行时决定下一步"，
 * 把计划做成强制流程等于把最值钱的东西换掉。所以：
 * - 计划只是**上下文**（一条 system 注记），不是调度器；
 * - Runner 从不读计划来决定"下一步该调什么工具"；
 * - 计划缺失、写坏、只写了两条，主循环照常跑（不阻塞、不报错）。
 *
 * ## 为什么是这个数据形态（必答题 1）
 *
 * 计划存成 **thread 的一条 `mem_messages`（role='system', kind='text'）**，不新建表、不改迁移：
 * - **契约 D2**（不改已发布迁移包）：`mem_messages.kind` 的 CHECK 白名单写死在
 *   `db/migrations/040_memory.sql:26-28`，加新 kind 必须改已发布包 → 越线。故用现成的
 *   `kind='text'` + `role='system'`，语义上它就是"系统给模型的一条注记"，事实正确；
 * - **契约 D4**（表所有权）：`mem_messages` 属 MEM，Runner 通过注入的 MemoryService 写，
 *   合规；新表则要新迁移包 + 新属主 + 新 dao，为一个 ~300 字的产物不值当；
 * - **journal 步不行**：`steps.kind` CHECK 只有 ('llm','tool')（`000_control_plane.sql:78`），
 *   且每条 steps 都计入步数上限、会被看门狗/恢复对账当"在途步"看待——计划不是执行步，
 *   占步数会污染 CP §5.4 预算与 §5.3 孤儿步对账；
 * - **thread 消息还免费得到两件事**：随会话重放（`buildSessionReplay`）天然可见，
 *   以及主人已经在看的"会话历史"里就是计划本身。
 *
 * ## 修订历史（不覆盖）
 *
 * 每次修订追加**一条新的** thread 消息，内容是全量计划快照 + 版本号。读取时取最后一条
 * 为"当前计划"，全部条目构成修订历史（复盘要看"改过几次、怎么改的"）。
 *
 * ## 默认值纪律
 *
 * **默认关闭**（`DOTD_PLAN` 未设置 = 关）。开启后才会多花一次模型调用去写计划；
 * 关闭时 Runner 的请求体与改动前**逐字一致**（静态守卫见 tests/runner-plan.test.ts）。
 */

import type { Message } from '../shared/contracts.ts';

/** 计划条目：一条 = 一句可执行的动作。 */
export interface PlanItem {
  /** 1 起的序号（展示与复盘用；不代表执行顺序承诺）。 */
  index: number;
  /** 一句话动作描述。 */
  text: string;
  /** 进度标记（仅用于"计划 vs 实际"对照；由模型在修订时更新，Runner 不解释它）。 */
  status: PlanStatus;
}

/** 计划条目状态（不带"进行中"以外的执行语义：Runner 不会据此调度）。 */
export type PlanStatus = 'todo' | 'doing' | 'done' | 'dropped';

/** 一份计划快照（某一版）。 */
export interface Plan {
  /** 从 1 起的版本号；每次修订 +1。 */
  version: number;
  /** 3–7 条（超出按 7 截断，少于 1 条视为无效）。 */
  items: PlanItem[];
  /** 这一版相对上一版改了什么（首版为空串）。 */
  revisionReason: string;
}

/** 计划在 thread 消息里的识别前缀（稳定标记，读取侧据此区分"计划"与普通助手正文）。 */
export const PLAN_MARKER = '[[dotd.plan]]';

/**
 * 判断模型正文里"看起来像计划"的廉价预筛（避免每轮都对正文做完整 JSON 解析）。
 * 命中后仍要走 `parsePlan` 严格校验。
 */
export const PLAN_MARKER_HINT = '"items"';

/** 两份计划内容是否相同（用于"只有真变了才算一次修订"）。 */
export function samePlan(a: Plan, b: Plan): boolean {
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    const x = a.items[i]!;
    const y = b.items[i]!;
    if (x.text !== y.text || x.status !== y.status) return false;
  }
  return true;
}

/** 计划条目的上下限（与提示词里的要求一致）。 */
export const PLAN_MIN_ITEMS = 3;
export const PLAN_MAX_ITEMS = 7;

/** 计划 JSON 的体积上限（字符）。超过视为写坏，按无效处理。 */
const PLAN_MAX_CHARS = 4000;

/** 让模型产出计划时用的提示（作为一条 user 消息追加在目标之后）。 */
export const PLAN_REQUEST_TEXT = `在动手之前，先用一份短计划把这件事拆开：${PLAN_MIN_ITEMS}–${PLAN_MAX_ITEMS} 条，每条一句话、是一个可执行的动作（不是感想）。
只输出 JSON，不要任何解释文字，格式：
{"items":[{"text":"...","status":"todo"}],"revisionReason":""}
status 取值：todo / doing / done / dropped。
这份计划之后每轮都会给你看一遍，用来提醒你原目标；但它**不是**必须照做的流程——中途发现更合适的走法，直接在回复里给出新的完整计划就可以。`;

/** 让模型修订计划时的提示。 */
export function revisionRequestText(current: Plan): string {
  return `你正在执行任务，下面是当前计划（第 ${current.version} 版）：
${formatPlanForPrompt(current)}

如果目标、约束或已完成的事实让你需要改计划，就在下一轮**直接**用这份 JSON 结构给出新的完整计划：
{"items":[{"text":"...","status":"todo|doing|done|dropped"}],"revisionReason":"为什么改"}
不改就继续干活，不必每次都重写。`;
}

/**
 * 把一份计划渲染成给模型看的一段文本（**每轮注入**的那条 system 注记）。
 *
 * 设计取向：短、可扫读、不复述目标（目标已在 messages 末尾的 user 消息里）。
 */
export function formatPlanForPrompt(plan: Plan): string {
  const lines = plan.items.map((it) => `${it.index}. [${statusLabel(it.status)}] ${it.text}`);
  const head = `# 当前计划（第 ${plan.version} 版）`;
  const tail =
    '这是你自己定下的计划，用来防止跑偏：每轮动手前对一下"这一步在推进哪一条"。' +
    '它不约束你的选择——发现计划不对就改它（在回复里给出新的完整计划 JSON），而不是硬着头皮走完。';
  const reason = plan.revisionReason.length > 0 ? `\n本次修订原因：${plan.revisionReason}` : '';
  return `${head}\n${lines.join('\n')}\n${tail}${reason}`;
}

function statusLabel(s: PlanStatus): string {
  switch (s) {
    case 'done':
      return '已完成';
    case 'doing':
      return '进行中';
    case 'dropped':
      return '已放弃';
    default:
      return '未开始';
  }
}

/**
 * 从模型输出里解析计划。**宽容**：允许 ```json 围栏、前后缀说明文字；
 * 解析不出合法结构则返回 null（调用方按"本轮没写计划"处理，绝不抛错炸主循环）。
 */
export function parsePlan(raw: string): Plan | null {
  if (raw.length === 0 || raw.length > PLAN_MAX_CHARS) return null;
  const jsonText = extractJsonObject(raw);
  if (jsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { items?: unknown; revisionReason?: unknown; version?: unknown };
  const rawItems = obj.items;
  if (!Array.isArray(rawItems)) return null;
  const items: PlanItem[] = [];
  for (const it of rawItems.slice(0, PLAN_MAX_ITEMS)) {
    const text = typeof it === 'string' ? it : (it as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const statusRaw = (it as { status?: unknown })?.status;
    items.push({
      index: items.length + 1,
      text: text.trim(),
      status: isPlanStatus(statusRaw) ? statusRaw : 'todo',
    });
  }
  if (items.length === 0) return null;
  const versionRaw = obj.version;
  const reason = typeof obj.revisionReason === 'string' ? obj.revisionReason.trim() : '';
  return {
    version: typeof versionRaw === 'number' && Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : 1,
    items,
    revisionReason: reason,
  };
}

function isPlanStatus(v: unknown): v is PlanStatus {
  return v === 'todo' || v === 'doing' || v === 'done' || v === 'dropped';
}

/** 从任意文本里抠出第一个平衡的 `{...}`（容忍 ```json 围栏与前后说明）。 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 计划 → thread 消息正文（带稳定标记，读取侧靠它区分）。 */
export function serializePlan(plan: Plan): string {
  return `${PLAN_MARKER}${JSON.stringify({ version: plan.version, items: plan.items, revisionReason: plan.revisionReason })}`;
}

/** 从一条 thread 消息里还原计划；不是计划消息则返回 null。 */
export function planFromMessage(m: Message): Plan | null {
  if (m.role !== 'system' || m.kind !== 'text') return null;
  if (!m.content.startsWith(PLAN_MARKER)) return null;
  return parsePlan(m.content.slice(PLAN_MARKER.length));
}

/**
 * 从 thread 消息序列里取出**当前计划**（最后一条）与**修订历史**（全部）。
 * 纯函数：不读库、不看时钟，便于逐字段断言。
 */
export function plansFromMessages(messages: readonly Message[]): { current: Plan | null; history: Plan[] } {
  const history: Plan[] = [];
  for (const m of messages) {
    const p = planFromMessage(m);
    if (p !== null) history.push(p);
  }
  return { current: history.length > 0 ? history[history.length - 1]! : null, history };
}

/** 格式化成给主人看的"计划 vs 实际"对照文本（`dotd task --verbose` 用）。 */
export function renderPlan(plan: Plan): string {  const done = plan.items.filter((i) => i.status === 'done').length;
  const lines = [
    `计划（第 ${plan.version} 版）：${plan.items.length} 条，已完成 ${done} 条`,
  ];
  for (const it of plan.items) lines.push(`  ${it.index}. ${statusLabel(it.status)}  ${it.text}`);
  if (plan.revisionReason.length > 0) lines.push(`  本次修订：${plan.revisionReason}`);
  return lines.join('\n');
}
