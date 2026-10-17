/**
 * src/router/difficulty.ts —— 难度判别分流（迁移自 PilotDeck 的四级难度判定）。
 *
 * 移植来源：PilotDeck（AGPL-3.0）"Smart Routing" 的 difficulty judge——它按任务
 * 特征打四级分（trivial / simple / moderate / complex），简单的活扔给便宜模型，
 * 旗舰模型只留给难活。移植的是**设计与保守判据**，不是代码。
 *
 * dotd 为什么要它、以及为什么必须比 PilotDeck 保守得多：
 * dotd 的双轨不是"贵/便宜"之分，是**"能不能调工具"之分**。light 轨的本地端点
 * （Colibrì OLMoE）已实测无工具调用能力（记忆 `olmoe-tier2-live-state` /
 * `colibri-moe-engine-only-limitation`），而主循环的每一步 LLM 调用都带 `tools`。
 * 所以这里判错一次的代价不是多花钱，是**任务步骤拿不到工具、整个任务跑偏**。
 *
 * 因此判据只认一样东西：**请求自己长什么样**，不猜任务语义。
 *   - 带 tools / tool_choice='required' → 永远是 complex（主循环形状，不降级）；
 *   - 不带 tools 且内容短 → simple（GOV 审查、CP 事件分流都是这个形状）；
 *   - 其余 → moderate（按调用方配置决定，见 `DifficultyPolicy`）。
 *
 * 判据刻意不用"看起来简单的中文短句"这类语义特征：同一个"帮我把这堆文件按日期
 * 归档"既像 simple 又必须调 fs 工具。请求形状是**事实**，内容难度是**猜测**，
 * 拿猜测换工具能力不划算。
 */

import type { ChatMessage, ToolSpec, Track } from '../shared/contracts.ts';

/** 四级难度（与 PilotDeck 同名同义）。 */
export type Difficulty = 'trivial' | 'simple' | 'moderate' | 'complex';

export interface DifficultyInput {
  /** 请求是否带工具定义（主循环每步都带）。 */
  tools?: readonly ToolSpec[] | undefined;
  toolChoice?: 'auto' | 'required' | string | undefined;
  messages: readonly ChatMessage[];
}

/** 短内容的字符阈值（simple 与 moderate 的分界）。 */
export const SHORT_CONTENT_CHARS = 2000;
/** 极短内容的字符阈值（trivial 与 simple 的分界）。 */
export const TRIVIAL_CONTENT_CHARS = 200;

/** 全部消息的正文字符总量（system+user+assistant+tool 都算）。 */
export function contentLength(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += typeof m.content === 'string' ? m.content.length : 0;
  return n;
}

/**
 * 难度判别（纯函数，无副作用、不读配置）。
 *
 * 返回 complex 的两种形状都是"这一步要调工具"——这是唯一不可让步的判据：
 * light 轨端点没有工具能力，把带 tools 的请求送过去等于让模型空手干活。
 */
export function judgeDifficulty(input: DifficultyInput): Difficulty {
  const wantsTools =
    (input.tools !== undefined && input.tools.length > 0) || input.toolChoice === 'required';
  if (wantsTools) return 'complex';
  const len = contentLength(input.messages);
  if (len <= TRIVIAL_CONTENT_CHARS) return 'trivial';
  if (len <= SHORT_CONTENT_CHARS) return 'simple';
  return 'moderate';
}

/**
 * 难度 → 轨道策略。
 *
 * 关键取舍：**moderate 默认留在 primary**。dotd 里不带 tools 的 moderate 请求
 * 目前只有一种——长文本审查/摘要（GOV review 的长 diff），它有 primary 轨的
 * 富上下文价值；而 light 轨端点的 context 窗口与指令遵循都弱一截。
 * trivial/simple 才降 light：那两个档的内容短到本地模型不会翻车，
 * 且省下的正是"每个事件都打一次旗舰模型"的那部分开销。
 *
 * `light_difficulties` 可由 models.yml 的 `routing.light_difficulties` 覆盖，
 * 但**永远不允许把 complex 放进去**（见 resolveTrack 的断言式注释）。
 */
export interface DifficultyPolicy {
  /** 哪些难度档走 light 轨（缺省 trivial+simple）。 */
  lightDifficulties: readonly Difficulty[];
  /** 事件类型未命中 light_events 时的默认轨。 */
  defaultTrack: Track;
}

export const DEFAULT_LIGHT_DIFFICULTIES: readonly Difficulty[] = ['trivial', 'simple'];

/** 难度档 → 轨道（策略可覆盖，但 complex 永不被下放）。 */
export function resolveTrack(
  difficulty: Difficulty,
  policy: DifficultyPolicy,
): Track {
  // complex = 要调工具。light 轨端点没有工具能力（OLMoE 实测），
  // 所以哪怕配置写了 light_difficulties: [complex] 也不认——那是配置错误，
  // 静默照做会让主循环每一步都空手干活。这里硬编码挡住，配置层另有校验。
  if (difficulty === 'complex') return 'primary';
  return policy.lightDifficulties.includes(difficulty) ? 'light' : policy.defaultTrack;
}

/**
 * 事件类型 + 请求形状 → 轨道（`trackForEvent` 的增强版，两者串联）。
 *
 * 串联顺序有意如此：**事件类型优先**。命中 `light_events` 的调用方（GOV/CP）
 * 已经显式声明"这是低智能活"，不该被请求形状再拉回 primary；而未命中的
 * 调用方（主循环）靠形状判据保护——它带 tools，必然 complex，必然 primary。
 */
export function trackFor(
  eventType: string | undefined,
  input: DifficultyInput,
  lightEvents: readonly string[],
  policy: DifficultyPolicy,
): Track {
  if (eventType !== undefined && matchesLightEvent(eventType, lightEvents)) return 'light';
  return resolveTrack(judgeDifficulty(input), policy);
}

/** `light_events` 前缀匹配（与 ModelRouter.trackForEvent 同款判据，抽成纯函数复用）。 */
export function matchesLightEvent(eventType: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => eventType === p || eventType.startsWith(`${p}.`) || eventType.startsWith(p),
  );
}
