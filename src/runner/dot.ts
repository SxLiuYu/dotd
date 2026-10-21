/**
 * src/runner/dot.ts —— 主循环 Dot：LLM↔工具协程（CP §12 骨架契约 + 接缝契约 ⑤–⑪）。
 *
 * 定位（CONVENTIONS.md §4 模块边界表）：Runner = `src/runner/` + `tests/runner-*.test.ts`；
 * 跨模块类型一律 import `src/shared/contracts.ts`，不 import 任何他人模块的实现类。
 * 本文件不建 Docker、不发 HTTP、不直写 tasks/steps 表——全部经注入的四个服务面：
 *   ControlPlane（队列/journal/审批联动/背压）、ModelRouter（模型）、ExecService（工具）、
 *   MemoryService（注入/重建/WRITE-SEAL）、Governance（裁决/认领）。
 *
 * 骨架逐条对应 control-plane.md §12（lines 635–684）与接缝契约 §8 ①–⑫：
 *   ⑤ openThread → bindSession → buildContextBundle
 *   ⑥ 每步 beginLlm → complete({track:'primary', attemptId=callId}) → endLlm
 *   ⑦ 工具步 beginTool(call_sent) → evaluate →
 *        allow/review_pass → runTool → endTool(call_done)
 *        deny → skipStep(callId) → 结果回喂，任务改道
 *        approve → markPending + setAwaitingApproval → Runner 让位
 *   ⑧ SF 卡片/通知（approval:created 由治理发，Runner 不直发）
 *   ⑨ 审批续跑：pop 领到 resume_from_seq 步 → resumeStep(同 callId) → claim() → 执行
 *   ⑩ 结果回报：assistant 全文 appendMessage 入 thread；tool 消息只 digest+200 预览（S6 双写禁令）
 *   ⑪ 任务终态 → memory.sealTask（WRITE-SEAL，三种 outcome 全走）→ cp.finish
 *   ⑫ 崩溃穿插：started 孤儿步 → exec.reconcileCall 三分流（journal.reconcileAndResolve）
 *   模型故障支线：complete 抛 AllEndpointsDownError/NoQualifiedPrimaryError →
 *      cp.pauseByReason(taskId,'circuit_open')（无 waiting_model 态）
 *
 * 与 CP §12 伪码的差异（全部记入 deviations，不静默偏离）：
 * 1. `queue.popLoop()` 在仓库里是 `Scheduler.popLoop(dotId='dot1')`（queue.ts 无该方法），
 *    Runner 自己实现 pop 循环（见 `start()`），语义等价：pop 为 null 时等下一个 tick/wake。
 * 2. CP §12 的 `ctx`（feedToolResult/feedSystemNote/nextStep/digest/tokensThisStep/done/summary）
 *    在仓库里没有实现类；Runner 用本文件的 `RunContext` 承担同一职责，
 *    消息装填顺序照 CP §7.3（buildSessionReplay → tool_result 全文覆盖 → journal.tail →
 *    openStepNotes 首条）逐条落地。
 * 3. `memory.readFileNotes/writeFileNotes`（CP §12 两行）在仓库 MemoryService 接口里不存在
 *    （/dot/home 的读写已归执行面 fs.* 工具与 /fs/ops 桥）。Runner 改为：
 *    开始时 `buildContextBundle` 注入文件记忆（CT:21"开始读"），
 *    结束时 WRITE-SEAL 已内含"未写记忆则提醒一轮"的收口（memory.md §4.3 伪码）。
 * 4. WRITE-SEAL 触发权：CP §12 只写 `queue.finish`，而 Queue.finish() 内部已按契约 M3
 *    调注入的 `sealTask` 钩子（queue.ts:350）。为避免同一次收口 seal 两次，
 *    Runner 提供 `sealOnFinish` 开关（默认 false = 交给 Queue 的钩子），
 *    Runner 自己只在 Queue 未注入 sealTask 时兜底（见 `sealTaskOnce`）。
 * 5. 步数上限（CP §5.4）的执行主体在 Journal（journal.ts:429-451 越线抛
 *    StepLimitError），Runner **不持计数器**：拿 `tail()` 默认 20 行判上限是死码
 *    （审码 finding ①）。Runner 的义务是在 `runNext()` 接住 StepLimitError 并按
 *    CP §5.4 收口：`failTask`（→ Queue.markFailed，不经 attempt 重试）。
 *    因此 RunnerOptions 不再有 stepSoftLimit/stepHardLimit（改由
 *    `createControlPlane({ cfg })` 的 ControlPlaneConfig 配置）。
 */

import type {
  ChatMessage,
  ControlPlane,
  ExecServiceApi,
  ExecToolCall,
  GovernanceApi,
  MemoryServiceApi,
  Message,
  ModelRouterApi,
  RouteRequest,
  Step,
  Task,
  ToolName,
  ToolSpec,
} from '../shared/contracts.ts';
import { AllEndpointsDownError, DotdError, NoQualifiedPrimaryError, StepLimitError, StreamInterruptedError } from '../shared/errors.ts';
import { newNonJournalAttemptId } from '../shared/ids.ts';
import { composeSystemPrompt } from './system-prompt.ts';
import { buildToolSpecs } from './tool-catalog.ts';
import {
  PLAN_MARKER_HINT,
  PLAN_REQUEST_TEXT,
  formatPlanForPrompt,
  parsePlan,
  plansFromMessages,
  samePlan,
  serializePlan,
  type Plan,
} from './plan.ts';

/**
 * 原地打转护栏的阈值（见 DotRunner.checkRepeat）。
 *
 * SOFT：从第几次开始回喂"你已经做过 N 次了"的强注记（仍派发）；
 * HARD：第几次强制收口。
 *
 * 取值依据（2026-10-18 真实数据）：观察到的原地打转是同一 (工具,参数) 重复 3–5 次；
 * 而正常任务里"写完再读"是**不同工具或不同参数**，不会撞这条判据。
 * 取 2/4：第 2 次开始提醒，第 4 次跳过派发强令收尾。
 * 2026-10-18 校准记录：试过降到 3，但会误伤"合法重复 8 次再收尾"的场景
 * （tests/runner-plan.test.ts 的抗跑偏用例抓到，模型的正常回答被护栏顶掉）。
 * 所以**次数不是可靠判据**——真正的判据是"结果有没有变化"（见 repeatSignature + last）。
 * 2026-10-18 实测校准：E 用例每项重复恰好 3 次才收尾，所以硬阈必须 ≤4；
 * 而"写完再读"是不同工具/不同参数，第 2 次软提醒不会误伤它们（有单测钉住判据）。
 */
/**
 * 会话历史重放的 token 预算（2026-10-19）。
 *
 * 为什么不能直接用任务预算：任务预算是 200000，对"重放历史"来说等于不限，
 * 结果长会话每次请求都要背上全部历史。取 8000 是因为：
 *   - 基础开销（system prompt + 工具 schema + 记忆）约 8400 tokens；
 *   - 加上 8000 的历史，总计约 16000，对当前模型是舒适区；
 *   - packSessionReplay 从新到旧累加，超预算丢弃的是**最旧**的那部分。
 */
const REPLAY_BUDGET_TOKENS = 8_000;

const REPEAT_SOFT_LIMIT = 2;
const REPEAT_HARD_LIMIT = 4;

/**
 * 同一文件被"整篇重写"多少次就认定在打转（2026-10-19 实测缺陷）。
 *
 * 现场：主人说"在文件最后再加一行 S3-DELTA"。模型读了文件，然后把整篇内容
 * 连同新行一起 `fs.write` 回去 —— 内容从 4 行变 5 行。下一轮它又觉得"我再加一行"，
 * 于是 5 行变 6 行……实测把一个 4 行文件加到 **22 行**，烧掉 43 次工具调用 / 82 秒。
 *
 * 为什么原有守卫全都没拦住：
 *   - 重复守卫按「工具 + 参数签名」判重，而每次 `fs.write` 的 content 都在变长，
 *     签名永不相等 → 计数永远是 1；
 *   - 「结果是否相同」也失效：`size_bytes` 每次都变；
 *   - 「同一工具调用次数」阈值也没到（fs.write 夹杂着 fs.read）。
 * 这三条判据都建立在"参数或结果不变"上，而这类打转恰恰是**每次都在变**的。
 *
 * 所以补一条专门的判据：**同一路径 + 新内容是旧内容的延长（前缀关系）**。
 * 这精确描述了"想追加、于是整篇重写"，且不会误伤：
 *   - 写不同文件 → 路径不同，不受影响；
 *   - 改了中间内容再写回 → 不是前缀关系，不受影响；
 *   - 写完发现问题、修正 → 只有 1~2 次，低于阈值。
 */
const SAME_PATH_REWRITE_LIMIT = 3;

/**
 * 护栏连续"跳过派发"的最大轮数。超过就由产品侧收口。
 *
 * 为什么需要它：护栏的机制是"跳过本次派发 → 下一轮 LLM 在没有工具可调时给结论"。
 * 但如果模型固执地继续返回工具调用，外层 while 会一直转（实测能把单测挂死）。
 * 2 轮足够给模型两次机会；再多基本可以确定它不会自我纠正。
 */
const REPEAT_MAX_SKIPS = 2;

// ── 1. 依赖面 ────────────────────────────────────────────────────────────

export interface RunnerDeps {
  /** 队列/journal/审批联动/背压（contracts.ts:ControlPlane）。 */
  cp: ControlPlane;
  /** 模型（contracts.ts:ModelRouterApi；主循环 track:'primary'）。 */
  router: ModelRouterApi;
  /** 工具执行（contracts.ts:ExecServiceApi）。 */
  exec: ExecServiceApi;
  /** 注入/重建/WRITE-SEAL（contracts.ts:MemoryServiceApi）。 */
  memory: MemoryServiceApi;
  /** 裁决/认领/强制审批（contracts.ts:GovernanceApi）。 */
  governance: GovernanceApi;
}

/** 运行参数（DDL 与 config 已由骨架落好，这里只覆盖运行期行为）。 */
export interface RunnerOptions {
  /** 归属 dotId（缺省 'dot1'；阶段一恒单 dot）。 */
  dotId?: string;
  /** 工具调用超时（EX §5.2：sync 上限 60s；异步工具同值由容器端另行约束）。 */
  toolDeadlineMs?: number;
  /**
   * 步数上限**不在 Runner 选项里**：CP §5.4 的执行主体是 `Journal.nextSeq`
   * （control-plane/journal.ts:429-451，读 ControlPlaneConfig.stepSoftLimit/HardLimit）。
   * 装配层要调上限改 `createControlPlane({ cfg: { stepHardLimit } })`；
   * Runner 只负责接住越线时抛出的 `StepLimitError` 并按 CP §5.4 收口
   * （failed + 不经 attempt 重试，见 `runNext`）。
   */
  /**
   * 终态收口是否由 Runner 自己调 sealTask（WRITE-SEAL）。
   * 默认 false：Queue.finish/markFailed/cancel/cancelDirect 内部已按契约 M3 调
   * 注入的 sealTask 钩子（queue.ts:350/609/398/622），Runner 再调会双封。
   * 装配层没给 Queue 注入 sealTask 时置 true（或调 `ensureSealHook`）。
   */
  sealOnFinish?: boolean;
  /** pop 循环的空转间隔（毫秒）。CP §12 `popLoop` 挂起等 tick 的等价物。 */
  idlePollMs?: number;
  /** 生命周期日志（默认静默；测试/装配层可注入）。 */
  log?: (msg: string) => void;
  /**
   * 会话增量总线（roadmap P0-2）。缺省 undefined = 不发布任何 chat.* 主题，
   * 行为与接入流式之前**逐字一致**；装配层注入 daemon 的 `EventBus.publish`。
   * 只在总线注入**且**未显式关闭流式时才走 `router.stream()`（见 `streamMode`）。
   */
  bus?: ChatDeltaPublisher;
  /**
   * 流式文本增量开关：缺省 = 由 `DOTD_STREAM_CHAT` 决定（除 `off` 外都算开）。
   * 关闭 = 逐字回退到 `router.complete()` 路径（roadmap P0-2「风险与回退」）。
   */
  streamChat?: boolean;
  /**
   * delta 合帧窗口（毫秒）。SSE 有每订阅者 200 条 delta 上限
   * （surfaces/sse.ts `SSE_DELTA_QUEUE_LIMIT`），逐 token 推送会溢出丢帧，
   * 故按窗口合并；窗口内文本很短时合并后照样下发，保证首个字**立刻**可见。
   */
  streamFlushMs?: number;
  /** delta 合帧的字符阈值（与 streamFlushMs 取先到者）。 */
  streamFlushChars?: number;
  /**
   * §4.3「补写一轮」开关（P1-4）：任务 done 且本次没写过记忆文件时，
   * 在 `cp.finish()` **之前**再问模型一轮"要么写 notes/manuals，要么回 SKIP"。
   *
   * **默认 false = 与既有行为逐字相同**（不多花一次模型调用、主循环 LLM 轮次不变）。
   * 生产语义由装配层显式打开：`src/daemon.ts` 传 `memoryRedo: true`。
   * 关着 = 老行为：sealTask 记 missed，但不会再提醒（也就不会补写）。
   */
  memoryRedo?: boolean;
  /**
   * P2-2 显式计划开关。
   *
   * **默认 false = 与既有行为逐字一致**（不多花模型调用、请求体一条字节都不多）。
   * 生产语义由装配层显式打开：`DOTD_PLAN=on`（见 `src/daemon.ts`），并有静态守卫
   * （tests/runner-plan.test.ts）防止默认值被悄悄改成开。
   *
   * 打开后只做一件事：任务开始时多问模型一轮，产出一份 3–7 条的短计划；之后每轮把它
   * 作为一条 system 注记带上。**计划不驱动执行**（不是固定 DAG，见 `plan.ts` 文件头）。
   */
  plan?: boolean;
  /**
   * 计划每多少轮刷新一次（让模型有机会修订）。默认 0 = 只在任务开始时写一次，
   * 执行中靠模型自己在回复里给出新版本来修订（推荐：零额外调用）。
   * >0 时每 N 轮追加一次"要改计划就现在改"的提示（仍由模型决定改不改）。
   */
  planRefreshEvery?: number;
}

/**
 * `chat.delta` / `chat.final` 的最小发布面（结构上兼容 `shared/bus.ts` 的
 * `EventBus.publish`）。Runner 只 import shared 类型，不 import bus 实现（CONVENTIONS §4）。
 *
 * payload 形状**照抄现有生产者/消费者**，不另造格式：
 * - 生产者 `surfaces/http.ts:522`：`chat.final = {kind:'chat.final', threadId, taskId, text}`
 * - 消费者 `web-ui/src/views/ChatView.tsx:75-94`：按 `threadId` 过滤、按 `taskId` 聚合
 *   `text`（delta 累加、final 覆盖同 taskId 的 delta 行）。
 */
export interface ChatDeltaPublisher {
  publish(topic: string, payload: Record<string, unknown>, opts?: { dotId?: string }): unknown;
}

/** 一次 `runNext()` 的结果（Runner 协程的单次让位语义）。 */
export interface TaskRunOutcome {
  taskId: string;
  epoch: number;
  status:
    | 'done' // ctx.done → finish(ok:true)
    | 'failed' // 步数硬上限 / 工具结果持续不可用
    | 'suspended' // awaiting_approval（让位，等 gov.decide → queued 再 pop）
    | 'paused' // 模型熔断 → paused(circuit_open)
    | 'aborted' // 背压/看门狗已 abort（迟到 Runner，交 reclaimTask）
    | 'budget' // overBudget → finish(ok:true, summary:'budget')
    | 'none'; // pop 返回 null（无可领任务）
  summary?: string;
}

// ── 2. RunContext：CP §12 伪码 `ctx` 的仓库落地 ───────────────────────────

/** digest+200 字预览（接缝 S6 / memory.md:214：mem_messages 同 kind 只存预览）。 */
function digestPreview(value: unknown, limit = 200): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = '[unserializable]';
  }
  if (text === undefined || text === null) text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 稳定摘要（LLM 步 prompt/response 只存 digest，CP §5.2）。 */
function digestOf(text: string): string {
  // 轻量摘要：长度 + 首尾。journal 只要可辨性，不要全文（体积）。
  if (text.length <= 160) return text;
  return `${text.slice(0, 80)}…[${text.length}]…${text.slice(-40)}`;
}

/**
 * 接缝 G5 / 接缝契约.md:299「goalDigest 由 Runner 在 evaluate 前截取（≤800B）注入」。
 * 治理 precheck 档的 goalBytes 预算固定 800（gate.ts:222 / governance-support.ts:144），
 * 超长 goal 会被 sanitizeText 截断前先占用 token 预算，故这里按**字节**截断
 * （文档口径是字节不是字符），避免多字节字符把 800B 预算吃穿。
 */
function goalDigestOf(goal: string): string {
  const enc = new TextEncoder();
  if (enc.encode(goal).length <= 800) return goal;
  // 二分最近的截断点，保证 ≤800B 且不切断多字节序列。
  let lo = 0;
  let hi = goal.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(goal.slice(0, mid)).length <= 800) lo = mid;
    else hi = mid - 1;
  }
  return goal.slice(0, lo);
}

/**
 * 护栏判重用的"语义签名"：**剔除不影响动作语义的参数**后再序列化。
 *
 * 为什么需要（2026-10-18 实测踩到，很隐蔽）：
 * 模型反复执行同一条命令 `echo A`，但每次把 `timeout_ms` 从 5000 改成 10000 再改回来。
 * 原始参数串因此不同 —— 护栏认为这是"不同调用"，计数永远到不了硬上限，
 * 实测 4 次同命令 + 4 次变体 = 18 次 shell.run 仍未触发，任务一直打转。
 *
 * timeout/超时这类参数只影响"等多久"，不影响"做什么"。把它们剔掉，
 * 判重才真正对齐"同一个动作做了几次"。
 */
export function normalizeResultForRepeatForTest(value: unknown): string {
  return normalizeResultForRepeat(value);
}

export function repeatSignatureForTest(argumentsJson: string): string {
  return repeatSignature(argumentsJson);
}

function repeatSignature(argumentsJson: string): string {
  // 只看顶层键（工具参数都是扁平对象）；解析失败就退回原串，宁可少判重也不误判。
  const IGNORED = new Set(['timeout_ms', 'timeoutMs', 'timeout', 'deadline_ms', 'deadlineMs']);
  try {
    const obj = JSON.parse(argumentsJson) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return argumentsJson;
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([k]) => !IGNORED.has(k))
      .map(([k, v]) => {
        // **路径参数也要归一化**（2026-10-18 实测）：g1.txt 与 /dot/home/g1.txt 指向同一文件，
        // 但原样比较是两个不同签名 → 护栏数不到重复。实测就是这样让同文件被写了 8 次。
        if (k === 'path' && typeof v === 'string') {
          const norm = v
            .replace(/\\/g, '/')
            .replace(/^\/dot\/home(?:\/|$)/, '')
            .replace(/^\.\//, '');
          return [k, norm] as [string, unknown];
        }
        return [k, v] as [string, unknown];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  } catch {
    return argumentsJson;
  }
}

/**
 * 判"结果有没有变化"前先归一化：剔掉时间戳/耗时这类**每次都不一样、但不代表进展**的字段。
 *
 * 2026-10-18 实测：fs.write 的返回是 {path, size_bytes, written_at}，
 * written_at 每次都变 → 两次结果字符串永不相等 → "同结果"判据形同虚设，
 * 同参数 fs.write 调 4 次护栏都不动。
 */
function normalizeResultForRepeat(value: unknown): string {
  const VOLATILE = new Set([
    'written_at',
    'writtenAt',
    'at',
    'ts',
    'timestamp',
    'wall_ms',
    'wallMs',
    'peak_mem_mb',
    'peakMemMb',
    'finished_at',
    'finishedAt',
    'started_at',
    'startedAt',
  ]);
  try {
    const text = JSON.stringify(value ?? null);
    const obj = JSON.parse(text) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return text;
    const clean: Record<string, unknown> = {};
    const src = obj as Record<string, unknown>;
    for (const k of Object.keys(src).sort()) {
      if (!VOLATILE.has(k)) clean[k] = src[k];
    }
    return JSON.stringify(clean);
  } catch {
    return '';
  }
}

/**
 * 读-改-写配对用的路径键：把 /dot/home 前缀与 ./ 去掉、反斜杠归一，
 * 让 "MEMORY.md" 与 "/dot/home/MEMORY.md" 命中同一条记录（与 fs 层同一套规范）。
 */
function normalizePathForReadSize(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/dot\/home(?=\/|$)/, '')
    .replace(/^\.\//, '');
}

/** 一次 LLM 响应在主循环里的归一形状。 */
interface LlmStep {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/** CP §12 `ctx`：装填 messages、喂结果、判 done、记账。 */
class RunContext {
  readonly messages: Message[] = [];
  /** 已成功执行、尚未以全文回喂给模型的工具结果（callId → resultJson）。 */
  private readonly pendingResults = new Map<string, string>();
  /**
   * 本轮 LLM 的正文（模型的思路）。工具调用落 thread 时要带上它，
   * 否则重建后"思路"和"调用"断成两条消息，模型会丢失自己的推理结论
   * （实测：明明已经改用相对路径成功，最后却汇报"绝对路径被接受了"）。
   */
  currentTurnText = '';

  /**
   * 本任务的图片附件（2026-10-18 多模态）。任务开始时从 goal 里解析出路径并读成 data URL，
   * 之后每轮请求都带上——这样模型是**真的在"看"图**，而不是自己写脚本解析像素。
   */
  taskImages: Array<{ url: string; mimeType?: string }> = [];
  /**
   * 本轮工具调用（callId → 工具名）。有工具结果回喂时，必须紧跟一条 assistant 的
   * tool_calls 消息把它们"接住"：OpenAI 兼容协议里裸的 role=tool 会被网关拒
   * （`messages with role 'tool' must be a response to a preceding message with
   * tool_calls`），接缝 S6 的双写禁令只要求"结果只有一份"，没要求丢掉调用声明。
   */
  private readonly pendingCalls = new Map<string, string>();
  /** callId → 原始参数串（在 assistant.tool_calls 里原样复述，便于模型对上号）。 */
  private readonly callArgs = new Map<string, string>();
  /** 系统注记（merge note / 恢复提示），排在下一次 LLM 请求前。 */
  private readonly notes: string[] = [];
  private tokens = 0;
  private doneFlag = false;
  private summaryText = '';

  constructor(
    /** 任务目标（user 消息，§4.1 事件任务无历史对话时唯一输入）。 */
    readonly goal: string,
  ) {}

  push(...msgs: Message[]): void {
    this.messages.push(...msgs);
  }

  /**
   * CP §12 `ctx.feedToolResult(callId, resultJson)`。
   * `toolName` 用于在回喂时补回对应的工具调用声明（见 pendingCalls）。
   */
  feedToolResult(callId: string, resultJson: string | null, toolName?: string): void {
    if (resultJson === null) return;
    this.pendingResults.set(callId, resultJson);
    if (toolName !== undefined && toolName.length > 0) this.pendingCalls.set(callId, toolName);
  }

  /**
   * 本轮 LLM 发出的工具调用整体登记（callId → 工具名 → 原始参数串）。
   * 工具结果回喂时用它在 assistant 消息里复原 tool_calls，保证协议上的因果配对。
   */
  noteToolCalls(calls: ReadonlyArray<{ id: string; name: string; arguments: string }>): void {
    for (const c of calls) {
      this.pendingCalls.set(c.id, c.name);
      this.callArgs.set(c.id, c.arguments);
    }
  }

  /** CP §12 `ctx.feedSystemNote(note)`。 */
  feedSystemNote(note: string): void {
    this.notes.push(note);
  }

  /**
   * CP §12 `ctx.feed(res)`：工具结果落账（不直接进 messages，见 buildMessages）。
   *
   * 成功与失败**都**以 JSON 回喂（失败是 `{status:'error',error:{code,message,retryable}}`）：
   * 模型要按 code 判断"改参数"还是"重试"，只给一句中文摘要它会当成噪声跳过。
   * 只有 deny / 记忆拒写这类"没派发"的结果保持单行文本（它们的语义是改道，不是执行失败）。
   */
  feed(res: {
    ok: boolean;
    callId: string;
    value: unknown;
    toolName?: string;
    dispatched?: boolean;
    /** 本次派发实际用的参数（`stepTool` 传给 exec 的那份，已补 home 前缀）。 */
    calledWith?: Record<string, unknown>;
  }): void {
    const toolName = res.toolName ?? this.pendingCalls.get(res.callId);
    if (toolName !== undefined) this.pendingCalls.set(res.callId, toolName);
    if (res.dispatched === false) {
      // 未派发（deny / 记忆硬限）：一次性系统注记，不进 tool 通道（没有执行结果可回）。
      this.notes.push(`工具调用未执行：${digestPreview(res.value)}`);
      this.pendingCalls.delete(res.callId);
      this.callArgs.delete(res.callId);
      return;
    }
    // 派发成功/失败都保留调用声明：`drainResults()` 靠 `pendingCalls` 判断
    // "这条结果有对应声明"（→ 进 tool 通道），并从 `callArgs` 复原
    // `assistant.tool_calls` 的原始参数串。**这里不能删**——原实现删了，回喂参数退化 `{}`。
    //
    // 补登记 name/args（**仅在缺失时**）：`stepTool` 收到的 `callId` 是 **journal 步
    // call_id**，而 `noteToolCalls()` 登记的是**模型给的** tool_call id。两者在真实链路
    // 上并不相等（Runner 用 journal callId 派发，保证契约 J1/幂等），所以按模型 id 登记
    // 的声明在这里查不到 → 必须用 `res.toolName` 与本次派发实参兜底，否则回喂给模型的
    // `assistant.tool_calls.arguments` 会退化成 `{}`（模型看不到自己当初传了什么）。
    if (!this.pendingCalls.has(res.callId) && res.toolName !== undefined) {
      this.pendingCalls.set(res.callId, res.toolName);
    }
    if (!this.callArgs.has(res.callId) && res.calledWith !== undefined) {
      this.callArgs.set(res.callId, JSON.stringify(res.calledWith));
    }
    this.pendingResults.set(res.callId, JSON.stringify(res.value ?? null));
  }

  /** CP §12 `ctx.feed(resp)`：LLM 响应。 */
  feedLlm(resp: LlmStep, usageTokens: number): void {
    this.tokens += usageTokens;
    if (resp.toolCalls.length === 0) {
      this.doneFlag = true;
      this.summaryText = resp.content;
    }
  }

  /** 一次工具执行后的附加用量（容器侧 wall/内粗估；主预算仍以模型 usage 为准）。 */
  addTokens(n: number): void {
    this.tokens += n;
  }

  /** CP §12 `ctx.tokensThisStep`（自上次 heartbeat 起的增量由 Runner 记账，这里给累计）。 */
  get totalTokens(): number {
    return this.tokens;
  }

  /**
   * P2-2 当前计划（null = 没有计划 / 功能关闭）。
   *
   * **只作为上下文**：每轮请求以一条 system 注记带上它，绝不用来决定下一步调什么工具
   * （计划不是控制流，见 `plan.ts` 文件头）。`setPlan` 由 Runner 在计划产出/修订时调用。
   */
  private planNote: string | null = null;
  /** 计划占用的估算 token（供成本口径与"何时省略"判据使用）。 */
  private planTokens = 0;

  setPlan(text: string | null): void {
    this.planNote = text !== null && text.length > 0 ? text : null;
    this.planTokens = this.planNote === null ? 0 : Math.ceil(this.planNote.length / 3.5);
  }

  /** 当前计划文本（null = 无）。 */
  get plan(): string | null {
    return this.planNote;
  }

  /** 本任务已记录的计划修订历史（供"只有真变了才算修订"与复盘使用）。 */
  private planVersions: Plan[] = [];

  recordPlan(plan: Plan): void {
    this.planVersions.push(plan);
  }

  planHistory(): Plan[] {
    return [...this.planVersions];
  }

  /** 计划每轮额外占用的估算 token 数（0 = 功能关闭或无计划）。 */
  get planTokenCost(): number {
    return this.planTokens;
  }

  /** CP §12 `ctx.done`。 */
  get done(): boolean {
    return this.doneFlag;
  }

  /**
   * 主动收口（护栏用）：把 done 置真并给出收尾正文。
   *
   * 与 `feedLlm` 里那条（模型自己说完了）不同——这里是**产品判定**模型在原地打转，
   * 由 Runner 代它收口，避免烧光步数预算。摘要里会写明原因，主人能看到发生过什么。
   */
  markDone(summary?: string): void {
    this.doneFlag = true;
    // **绝不覆盖模型已经给出的结论**：`summaryText` 非空说明模型上一轮已经正常收尾，
    // 护栏的占位文案只该在"模型没有给出任何结论"时兜底。
    // 2026-10-18 实测：早先无条件覆盖，把模型的"整理完了。"换成了护栏文案，
    // 把主人的正常回答顶掉了（tests/runner-plan.test.ts 那条抗跑偏用例抓到）。
    if (this.summaryText.length > 0) return;
    if (summary !== undefined && summary.length > 0) this.summaryText = summary;
    else this.summaryText = '任务完成';
  }

  /** CP §12 `ctx.summary`。 */
  get summary(): string {
    return this.summaryText.length > 0 ? this.summaryText : '任务完成';
  }

  /** 取走并清空待回喂的系统注记。 */
  drainNotes(): string[] {
    const out = [...this.notes];
    this.notes.length = 0;
    return out;
  }

  /**
   * 取走并清空待回喂的工具结果。
   *
   * 结果全文回喂：工具返回值是模型下一步决策的唯一依据（`fs.read` 的正文、
   * `shell.run` 的错误输出都在里面），digest 后的 200 字预览会让它对着半截
   * 内容猜。双写禁令（S6）约束的是**入 thread** 的那份（`reportTool` 仍只存预览），
   * 不是发给模型的请求体。
   */
  drainResults(): Array<{ callId: string; toolName: string; args: string; text: string; dispatched: boolean }> {
    const out: Array<{ callId: string; toolName: string; args: string; text: string; dispatched: boolean }> = [];
    for (const [callId, json] of this.pendingResults) {
      // 声明（name + 原始参数串）与结果表**同寿命**：两边的清理都只在这里发生。
      const decl = this.takeCallDecl(callId);
      out.push({
        callId,
        toolName: decl.name,
        args: decl.args,
        text: json,
        // 有调用声明 = 本轮真的派发过 → 可进 tool 通道；否则是恢复期补喂的历史结果。
        dispatched: decl.dispatched,
      });
    }
    this.pendingResults.clear();
    return out;
  }

  /**
   * 取一条工具调用声明（name + 原始参数串）并清掉。
   *
   * 2026-10-18 修（P0-2 把这条真实缺陷照出来了）：原先 `feed()` 在把结果登记进
   * `pendingResults` 的同时就把 `pendingCalls` **删掉了**，于是 `drainResults()` 再查
   * `pendingCalls` 永远查不到 → `dispatched` 恒为 false、本轮的 `assistant.tool_calls`
   * 声明整段丢失，回喂给模型的参数退化成 `{}`（journal 里明明有正确 args）。
   * 修法：`feed()` 不再删声明，清理统一在本方法里做——两张表同寿命。
   */
  private takeCallDecl(callId: string): { name: string; args: string; dispatched: boolean } {
    const name = this.pendingCalls.get(callId);
    const args = this.callArgs.get(callId);
    this.pendingCalls.delete(callId);
    this.callArgs.delete(callId);
    return { name: name ?? '', args: args ?? '{}', dispatched: name !== undefined };
  }

  /**
   * 组装发给模型的 ChatMessage[]（接缝 ⑥ 的请求体）。
   *
   * 顺序（CP §7.3）：system prompt（**恒为 messages[0]**）→ 文件记忆快照
   * （MEMORY.md + manuals 片段 + 会话摘要，作为独立的 system 注记，不混进 prompt，
   * 以免覆盖 system prompt 这种"伪装成对话的注入"）→ 会话历史（assistant 全文）→
   * assistant.tool_calls + 本轮 tool 结果 → 系统注记 → 任务目标（user，恒为最后一条）。
   */
  /**
   * 已经带进上下文的工具调用声明（来自 thread 重建的 assistant/tool_call 消息）。
   *
   * `buildMessages` 用它做去重：那些调用已经有 `assistant.tool_calls` 了，
   * 不能再按内存里的 pendingCalls 补一条——重复声明会让模型被自己的历史带偏。
   */
  get declaredCallIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const m of this.messages) {
      if (m.kind !== 'tool_call') continue;
      for (const c of parseToolCallContent(m.content)) ids.add(c.id);
    }
    return ids;
  }

  /**
   * 自造工具清单（S2，2026-10-19）。
   *
   * **必须做成类字段而不是 ctx.push()**：buildMessages 是自己重新组装 out 数组的，
   * 不会把 this.messages 里的 system 消息带出去（planNote 同理）。
   * 2026-10-19 踩坑：先写成 ctx.push，日志显示"发现 1 个工具"，但模型回答
   * "我上下文里没有工具清单" —— 注入的内容压根没进请求体。
   */
  toolInventoryNote: string | null = null;

  /** TOOL-REUSE-GUARD：本任务是否已经提醒过一次"你有现成工具"（只提醒一次）。 */
  toolReuseHinted = false;

  /** 任务目标：恒为最后一条 user 消息（§4.1 事件任务没有历史对话时它是唯一输入）。 */
  buildMessages(bundle: {
    memoryMd: string;
    manualExcerpts: Array<{ path: string; text: string }>;
    summary: string | null;
  }): Message[] {
    const out: Message[] = [];

    // ① 运行手册：每一次请求都要在，且必须是第一条（模型只认最前面那份 system）。
    const prompt = composeSystemPrompt();
    out.push({
      id: 'sys:prompt',
      threadId: '',
      seq: 0,
      role: 'system',
      kind: 'text',
      content: prompt,
      tokenEst: Math.ceil(prompt.length / 3.5),
      createdAt: 0,
    });

    // ② 文件记忆快照（任务开始时注入的那一份；内容由 MemoryService 控预算）。
    const fileParts: string[] = [];
    if (bundle.memoryMd.length > 0) fileParts.push(`# MEMORY.md\n${bundle.memoryMd}`);
    for (const m of bundle.manualExcerpts) fileParts.push(`# ${m.path}\n${m.text}`);
    if (bundle.summary !== null && bundle.summary.length > 0) {
      fileParts.push(`# 会话摘要\n${bundle.summary}`);
    }
    if (fileParts.length > 0) {
      const joined = fileParts.join('\n\n');
      out.push({
        id: 'sys:file-memory',
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'text',
        content: joined,
        tokenEst: Math.ceil(joined.length / 3.5),
        createdAt: 0,
      });
    }

    // ②b P2-2 当前计划（关闭时 planNote 恒 null，本段一行不产出 → 请求体逐字不变）。
    //     位置在"文件记忆之后、会话历史之前"：既要每轮都在，又不能盖过运行手册。
    if (this.planNote !== null) {
      out.push({
        id: 'sys:plan',
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'text',
        content: this.planNote,
        tokenEst: this.planTokens,
        createdAt: 0,
      });
    }

    // ②c 自造工具清单（S2）：放在 plan 之后、历史之前 —— 属于"开工前该知道的事实"。
    if (this.toolInventoryNote !== null) {
      out.push({
        id: 'sys:tool-inventory',
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'text',
        content: this.toolInventoryNote,
        tokenEst: Math.ceil(this.toolInventoryNote.length / 3.5),
        createdAt: 0,
      });
    }

    // 历史裁剪（2026-10-19 实测发现）：原来无条件把整个会话历史塞进去。
    // 现场：一个线程累积到 461 条消息，其中 460 条是历史 tool_result（只有 2 条真实
    // 用户消息），每次调用都装载 prompt=28035 tokens —— 绝大部分是早已作废的工具输出。
    //
    // 裁剪规则（保守，只丢最没信息量的那类）：
    //   ① 保留全部 user/assistant 正文（那是对话本身）；
    //   ② tool_result 只保留最近若干条（旧结果的价值随时间快速衰减：
    //      几轮前的列目录输出对当前判断没有意义）；
    //   ③ 从尾部往前数着保留，保证"最近的对话一定在"。
    //
    // 为什么按条数而不是按 token：逐条估算 token 每轮都做太贵，而这里要的只是
    // 一个上界。60 条工具结果足以覆盖单个任务的完整上下文。
    const KEEP_RECENT_TOOL_RESULTS = 60;
    const kept: Message[] = [];
    let toolResultsKept = 0;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m === undefined) continue;
      if (m.kind === 'tool_result') {
        if (toolResultsKept >= KEEP_RECENT_TOOL_RESULTS) continue;
        toolResultsKept += 1;
      }
      kept.push(m);
    }
    kept.reverse();
    out.push(...kept);

    // ③ 本回合工具结果：同一轮 LLM 发出的多个调用先合并成**一条** assistant.tool_calls，
    //    再跟各自的 tool 结果。裸 role=tool 会被 OpenAI 兼容网关以"没有前置 tool_calls"
    //    拒绝；模型侧回放的 assistant 消息（本文件 messages[]）本就丢弃了调用声明，
    //    这里按 pendingCalls 复原是唯一的因果来源。
    //
    //    没有调用声明的结果（恢复期从 steps 补喂的历史结果）不进 tool 通道——
    //    它们凑不出 args/name，硬塞进去只会造出一条无主的 role=tool。
    const results = this.drainResults();
    const dispatched = results.filter((r) => r.dispatched);
    const recovered = results.filter((r) => !r.dispatched);
    for (const r of recovered) {
      // 恢复重建只有 steps 里的 result_json：以"历史结果"形态告诉模型这件事做过、
      // 结果是什么，避免它重新执行一遍。
      const text = `历史工具结果（此前已执行，无需重做）：${r.text}`;
      out.push({
        id: `note:recovered:${r.callId}`,
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'text',
        content: text,
        tokenEst: Math.ceil(text.length / 3.5),
        createdAt: 0,
      });
    }
    // 去重：从 thread 重建时已经带回了 assistant/tool_call 声明的调用，不要再补一条。
    // 否则同一轮调用会被注入两次（实测：一条 58 步任务的 assistant/tool_call 累积到 20 条、
    // 1280 token，模型被重复的历史带偏，36 次工具调用里只有 9 种不同参数）。
    const declared = new Set(this.declaredCallIds);
    const withName = dispatched.filter((r) => !declared.has(r.callId));
    if (withName.length > 0) {
      const callMsg: Message = {
        id: `assistant:calls:${withName[0]!.callId}`,
        threadId: '',
        seq: 0,
        role: 'assistant',
        kind: 'tool_call',
        content: '',
        tokenEst: 0,
        createdAt: 0,
      };
      (callMsg as Message & { toolCalls?: Array<{ id: string; name: string; arguments: string }> }).toolCalls =
        withName.map((r) => ({ id: r.callId, name: r.toolName, arguments: r.args }));
      out.push(callMsg);
    }
    for (const r of dispatched) {
      // 内容里内嵌 call_id：toChatMessage 靠它填 tool_call_id，与上面 assistant.tool_calls
      // 的 id 逐一配对（Message 契约不必为此加字段）。
      const text = `call_id=${r.callId}\n${r.text}`;
      out.push({
        id: `tool:${r.callId}`,
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'tool_result',
        content: text,
        tokenEst: Math.ceil(text.length / 3.5),
        createdAt: 0,
      });
    }
    for (const n of this.drainNotes()) {
      out.push({
        id: `note:${n.length}:${out.length}`,
        threadId: '',
        seq: 0,
        role: 'system',
        kind: 'text',
        content: n,
        tokenEst: Math.ceil(n.length / 3.5),
        createdAt: 0,
      });
    }

    // ④ 任务目标：恒为最后一条 user 消息（§4.1 事件任务没有历史对话时它是唯一输入）。
    out.push({
      id: 'user:goal',
      threadId: '',
      seq: 0,
      role: 'user',
      kind: 'text',
      content: this.goal,
      tokenEst: Math.ceil(this.goal.length / 3.5),
      createdAt: 0,
    });
    return out;
  }
}

// ── 3. 主循环 ────────────────────────────────────────────────────────────

export class DotRunner {
  private readonly cp: ControlPlane;
  private readonly router: ModelRouterApi;
  private readonly exec: ExecServiceApi;
  private readonly memory: MemoryServiceApi;
  private readonly governance: GovernanceApi;
  private readonly dotId: string;
  private readonly toolDeadlineMs: number;
  private readonly sealOnFinish: boolean;
  private readonly idlePollMs: number;
  private readonly log: (msg: string) => void;
  /** 会话增量总线（roadmap P0-2）。null = 不发布 chat.*（行为与接入前一致）。 */
  private readonly chatBus: ChatDeltaPublisher | null;
  /** 三个流式参数在构造期定版（读一次 env，运行期不再看环境，便于测试可复现）。 */
  private readonly streamEnabled: boolean;
  private readonly streamFlushMs: number;
  private readonly streamFlushChars: number;
  /** P1-4：收口前"补写一轮"开关（RunnerOptions.memoryRedo，默认开）。 */
  private readonly memoryRedoEnabled: boolean;
  /** P2-2：显式计划开关（RunnerOptions.plan，**默认关** —— 见 RunnerOptions 注释）。 */
  private readonly planEnabled: boolean;
  /** P2-2：每 N 轮提示模型"要不要修订计划"（0 = 不主动提示，只靠模型自发）。 */
  private readonly planRefreshEvery: number;

  /** 工具 sideEffect 词表缓存（契约 J2：唯一事实源 = exec.getCapabilities）。 */
  private sideEffectOf = new Map<string, 'safe' | 'replayable' | 'unknown'>();
  /**
   * 工具 mode / max_deadline_ms 缓存（P0-3：`deadline_ms` 的选档依据）。
   *
   * 缺陷本体：两个 `runTool` 调用点过去一律发 `toolDeadlineMs`（缺省 60_000，
   * 语义是"EX §5.2 的 sync 上限"），于是 async 工具（shell.run 等，目录声明
   * max_deadline_ms=30min）在容器侧只剩 60s —— 任何 3 分钟以上的工具都会先被
   * 本地 deadline 标成 timeout，任务回 queued 重跑、副作用干两遍。
   * 修复：按 catalog mode 选档——async 取目录声明的 max_deadline_ms，
   * sync 保持 `toolDeadlineMs`（同步工具的既有上限一字不改）。
   */
  private deadlineCapOf = new Map<string, { mode: 'sync' | 'async'; maxDeadlineMs: number }>();
  /**
   * 接缝 M6：beforeWrite 软限 warning 暂存（callId → warning），
   * 等工具结果回来后附回响应；派发失败/异常时随步清理。
   */
  private readonly memoryWarnings = new Map<string, string>();
  /** 已封存任务（幂等：同一 task 多次收口只 seal 一次）。 */
  private readonly sealed = new Set<string>();
  /**
   * 原地打转护栏：本任务内的 (工具名 + 参数) 重复计数。
   *
   * 为什么需要它（2026-10-18 实测）：模型在"做完再确认一遍"这类指令上会自我循环——
   * 同一条 prompt 下，"明确单步" 4 步完成，而"创建…然后读回确认…" 跑到 **185 步**，
   * 内容是同参数 fs.write / fs.read 反复执行。上下文配对已经修对（11/11），
   * 所以这不是"看不见自己做过什么"，而是模型**看到了也还要再做一遍**。
   *
   * 这是与模型无关的产品侧兜底：同一 (工具, 参数) 第 N 次出现时，把"已经做过、结果如下"
   * 强注回喂，让模型无法再假装没做过；超过硬上限则直接收口，避免烧光步数预算。
   */
  /**
   * 原地打转护栏：**按任务 ID 分桶**，跨 run_epoch 保留。
   *
   * 为什么必须按任务而不是按"本次 Runner 运行"（2026-10-18 崩溃恢复测试踩到）：
   * 任务被恢复/重试时会重新领取（run_epoch+1），如果在这里清空计数，
   * 护栏就从 1 重新数起 —— 而原地打转往往正是**跨 epoch** 的（崩溃后接着重复同一动作）。
   * 实测：一条任务里 `sleep 3; echo step1` 被重复 4 次仍未触发护栏，
   * 因为中途经历过一次 kill -9 恢复，计数被重置了。
   */
  /**
   * 本任务内**读到过**的文件大小（path → size_bytes）。
   *
   * 用途：模型"读文件 → 改 → 整篇写回"时，自动在 fs.write 上补 expected_size，
   * 让执行面做乐观并发控制（CAS）。2026-10-18 实测：10 个并发 RMW 进程写同一文件
   * 会丢 8/11 的更新；而**模型自己从不主动传 expected_size**（提示词写了两轮也没用）。
   * 所以改由 Runner 在派发时自动补——不依赖模型自觉。
   *
   * 只在同一任务内有效（跨任务的数据由执行面 statSync 现查，不靠这份缓存）。
   */
  private readonly readSizes = new Map<string, number>();

  /** 本任务从目标里解析出的图片（data URL），每轮请求都带上。 */
  private cachedGoalImages: Array<{ url: string; mimeType?: string }> = [];

  private readonly repeatGuard = new Map<string, Map<string, { count: number; last: string; sameResultCount?: number }>>();
  /** 连续被护栏跳过派发的轮数（按任务 ID）；超过 REPEAT_MAX_SKIPS 就真的收口（防死循环）。 */
  private readonly repeatSkipsByTask = new Map<string, number>();

  /**
   * 每任务 × 每工具的调用次数（2026-10-19）。
   *
   * 为什么需要：重复守卫只认"同一 (工具,参数)"，而模型会**交替**调用 A、B、A、B 绕开它。
   * 现场：一个"查 zen 并存笔记"的任务跑到 25 步还没写文件 ——
   *   net.get(zen) → fs.stat(note 不存在) → net.get(zen) → fs.stat(note 不存在) → …
   * 每一步单看都是"新调用"，守卫完全沉默。这里用"同一工具的总调用次数"兜底。
   */
  private readonly toolCallCounts = new Map<string, Map<string, number>>();

  /**
   * 每任务 × 每路径的「整篇重写」追踪（2026-10-19）：记住上一次写进去的内容，
   * 用来判断下一次写入是不是"在旧内容尾巴上又接了一段"。
   * 见 {@link SAME_PATH_REWRITE_LIMIT} 的现场说明。
   */
  private readonly rewritesByPath = new Map<string, Map<string, { content: string; count: number }>>();

  private running = false;

  constructor(deps: RunnerDeps, opts: RunnerOptions = {}) {
    this.cp = deps.cp;
    this.router = deps.router;
    this.exec = deps.exec;
    this.memory = deps.memory;
    this.governance = deps.governance;
    this.dotId = opts.dotId ?? 'dot1';
    this.toolDeadlineMs = opts.toolDeadlineMs ?? 60_000;
    this.sealOnFinish = opts.sealOnFinish ?? false;
    this.idlePollMs = opts.idlePollMs ?? 1_000;
    this.log = opts.log ?? (() => {});
    this.chatBus = opts.bus ?? null;
    this.streamEnabled = opts.streamChat ?? streamChatFromEnv();
    this.streamFlushMs = opts.streamFlushMs ?? STREAM_FLUSH_MS;
    this.streamFlushChars = opts.streamFlushChars ?? STREAM_FLUSH_CHARS;
    this.memoryRedoEnabled = opts.memoryRedo ?? false;
    this.planEnabled = opts.plan ?? false;
    this.planRefreshEvery = opts.planRefreshEvery ?? 0;
  }

  // ── 3.1 pop 循环（CP §12 `for await (const task of loop)`）──────────────

  /**
   * 启动常驻循环。**调用方负责 abort**：传入的 signal 触发后在当前步边界退出
   * （CP §2.1-4：协程只能 AbortSignal，不能 SIGSTOP）。
   */
  async start(signal?: AbortSignal): Promise<void> {
    this.running = true;
    // 常驻协程的生存纪律（审码 finding B）：`maxRunning=1` 下这个 while 是**唯一**的消费者。
    // 任何一轮意外抛错都必须被吞掉并退避重试——否则协程直接退出，队列从此永久静止，
    // 而 daemon 进程还活着、HTTP 还回 200，是"进程半死"最难排查的形态。
    let backoff = this.idlePollMs;
    while (this.running && signal?.aborted !== true) {
      let out: TaskRunOutcome;
      try {
        out = await this.runNext();
      } catch (err) {
        // 这里能收到的只剩"连收口都失败"的错误（pop 抛错已在 runNext 内兜住）。
        this.log(`runner: 循环轮次异常（${errText(err)}），${Math.min(backoff, START_MAX_BACKOFF_MS)}ms 后重试`);
        await this.idleWait(signal, backoff);
        backoff = Math.min(backoff * 2, START_MAX_BACKOFF_MS);
        continue;
      }
      backoff = this.idlePollMs;
      if (out.status === 'none') {
        await this.idleWait(signal);
      }
    }
  }

  /** 优雅停循环（在途任务跑完本步即退）。 */
  stop(): void {
    this.running = false;
  }

  /** CP §2.1 空转等待：等 idlePollMs 或提前被唤醒（装配层可调 wakeNow）。 */
  private idleWait(signal?: AbortSignal, delayMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, delayMs ?? this.idlePollMs);
      if (typeof t.unref === 'function') t.unref();
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }

  // ── 3.2 单任务主循环 ───────────────────────────────────────────────────

  /**
   * 领一个任务并跑到让位点。对应 CP §12 的 `for await (const task of loop) { … }` 单轮。
   * 返回 'none' = 队列空（pop 返回 null）。
   */
  async runNext(): Promise<TaskRunOutcome> {
    // 审码 finding B：pop 原本在 try 之外。cp.pop 走的是 SQLite（`DatabaseSync`，
    // 同步抛错），库忙/库损坏/库被另一个进程锁住时它直接抛，异常会穿过 start() 的
    // while 让常驻协程退出。这里把它兜成 'none'：本轮让位，下一轮再 pop。
    let task: Task | null;
    try {
      task = this.cp.pop(this.dotId);
    } catch (err) {
      this.log(`runner: pop 异常（${errText(err)}），本轮让位`);
      return { taskId: '', epoch: 0, status: 'none' };
    }
    if (task === null) return { taskId: '', epoch: 0, status: 'none' };
    try {
      return await this.runTask(task);
    } catch (err) {
      // CP §5.4 硬上限：Journal.nextSeq 抛 StepLimitError（journal.ts:434-436）。
      // 必须走 failTask（装配层转发 Queue.markFailed，queue.ts:628-641）——
      // 走 finish(ok:false) 会在 attempt<max_attempts 时把任务回 queued 重试
      // （queue.ts:364-384），与 CP §5.4「failed(stop_reason='budget')，不重试」冲突。
      if (err instanceof StepLimitError) {
        const reason = `budget:${err.message}`;
        this.log(`runner: ${reason}`);
        this.failTask(task, task.runEpoch, reason);
        await this.seal(task, 'failed', 'budget');
        return {
          taskId: task.id,
          epoch: task.runEpoch,
          status: 'failed',
          summary: reason,
        };
      }
      return this.onFatal(task, err);
    }
  }

  /** CP §12 骨架主体。 */
  private async runTask(task: Task): Promise<TaskRunOutcome> {
    const epoch = task.runEpoch;
    // readSizes 是"本任务读过的文件大小"，**每个任务开始时清空**（跨任务没有意义，
    // 而且会把上个任务的数据带进来造成误判）。
    this.readSizes.clear();
    // 注意：**不清空** repeatGuard —— 计数按 taskId 分桶、跨 run_epoch 保留（见字段注释）。
    this.log(`runner: 领任务 ${task.id}（epoch=${epoch} resume_from_seq=${task.resumeFromSeq ?? '-'}）`);

    // 多模态：任务目标里若提到 home 内的图片文件（飞书图片走这条路），
    // 读成 data URL 缓存起来，供每轮 buildMessages 挂到消息上。
    this.cachedGoalImages = await this.loadGoalImages(task);

    // ⑤ 会话绑定（S5：修旧稿只读不写）
    let session = task;
    if (session.threadId === null) {
      const threadId = await this.memory.openThread(session.dotId, 'event', {
        title: session.title,
        originTaskId: session.id,
      });
      this.cp.bindSession(session.id, epoch, { sessionId: threadId, threadId });
      session = this.cp.getTask(session.id) ?? { ...session, threadId, sessionId: threadId };
    }

    // ⑤ 文件记忆注入（CT:21「开始读」；CP §12 的 readFileNotes 在仓库归 buildContextBundle）
    const bundle = await this.memory.buildContextBundle(
      session.dotId,
      `${session.title}\n${session.goal}`,
      session.budgetTokens,
      { threadId: session.threadId ?? undefined, taskId: session.id },
    );

    // **自造工具清单注入**（S2，2026-10-19）。
    //
    // 目标：让"造过的工具"在每次任务开头就摆在模型眼前，而不是指望它想起来去 tool.list。
    // 实测证明提示词不够 —— 同类任务它直接 shell.run 手写了一遍，压根没想起去查。
    let toolInventory: string | null = null;
    try {
      // 复用 toolCall()：它负责补 issued_at 等必需字段。
      // 2026-10-19 踩坑：手写对象漏了 issued_at，容器回 400「字段 issued_at 必须是非空字符串」，
      // 而外层只看到 "发现 0 个工具" —— 症状完全看不出是字段缺失。
      const r = await this.exec.runTool(
        toolCall(task, `inventory_${task.id}`, 'tool.list', {}, 60_000),
      );
      // 诊断（2026-10-19：这条链路查了两小时没定位，先把原始结构打出来）
      const raw = JSON.stringify(r).slice(0, 400);
      this.log(`runner: tool.list 原始返回 ${task.id}：${raw}`);
      const payload = (r as { result?: { tools?: Array<Record<string, unknown>> } }).result;
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      const usable = tools.filter(
        (x) => typeof x['name'] === 'string' && typeof x['description'] === 'string' && String(x['description']).length > 0,
      );
      this.log(`runner: 工具清单 ${task.id}：发现 ${usable.length} 个自造工具`);
      if (usable.length > 0) {
        // 措辞刻意写成"指令"而不是"告知"：2026-10-19 实测，只写
        // "（这些是以前造的，别重写）" 时模型照样手写 shell.run —— 它把这句当成背景信息。
        // 改了三点：① 明确说"先检查"；② 给出具体调用格式；③ 说明什么时候才该新造。
        toolInventory =
          '# 你已有的自造工具（动手前先看这份清单）\n' +
          usable.map((x) => `- ${String(x['name'])}：${String(x['description'])}`).join('\n') +
          '\n' +
          '\n**规则**：\n' +
          // 2026-10-19 实测踩坑：动态工具已注册成**独立工具**（名字就是 word-count，
          // 参数直接是 manifest.params），但清单还写着"用 tool.invoke(name, args) 调它"，
          // 于是模型把参数包成 {name:'word-count', args:{text}} 发给 word-count 本身，
          // 造成一层多余嵌套。措辞必须与"它现在是一个独立工具"的事实一致。
          '1. 上面有能干这活的 → **直接调用那个工具**（它的名字就是工具名，参数按该工具的参数填），' +
          '**不要**用 shell.run 重写一遍；\n' +
          '2. 没有但以后还会重复 → 用 tool.create 造一个（造完记得也 invoke 一次自测）；\n' +
          '3. 只有一次性临时活、上面也没有对口的，才直接用 shell.run。';
      }
    } catch (err) {
      this.log(`runner: 工具清单注入失败 ${task.id}：${err instanceof Error ? err.message : String(err)}`);
    }

    // ⑤/§7.3 重建顺序：buildSessionReplay（LLM 全文）→ tool_result 全文覆盖 → journal.tail → 提示
    const ctx = new RunContext(session.goal);
    const replay = session.threadId === null
      ? []
      : await this.memory.buildSessionReplay(
          session.threadId,
          session.id,
          // **会话重放要有自己的预算**（2026-10-19 实测发现的上下文膨胀根因）：
          // 原来直接传 session.budgetTokens（=200000），等于"不限"——
          // 一个 461 条消息的线程被完整重放，prompt 累积到 28247 tokens，
          // 其中 19878 是历史，而历史里 460 条是早已作废的工具输出。
          //
          // 会话重放只是"让模型知道刚才聊到哪"，不需要把全部历史背下来：
          // 8000 tokens 足够容纳几十轮对话，超出部分由 packSessionReplay 从最旧开始丢弃
          // （它是从新到旧累加的，所以丢的永远是最旧的——正好是我们想要的）。
          REPLAY_BUDGET_TOKENS,
        );
    for (const m of replay) {
      ctx.push(m);
      if (m.kind === 'tool_result') {
        // §7.3 第 2 步：用 call_id 从 steps 取全文覆盖 digest（messages 只存预览）
        const callId = callIdOfToolMessage(m);
        if (callId !== null) {
          const step = this.cp.journal.getStepByCallId(callId);
          if (step !== null && step.resultJson !== null) ctx.feedToolResult(step.callId ?? callId, step.resultJson);
        }
      }
    }
    for (const s of this.cp.journal.tail(session.id)) {
      if (s.kind === 'tool' && s.status === 'succeeded' && s.callId !== null) {
        ctx.feedToolResult(s.callId, s.resultJson);
      }
    }

    // **把自造工具清单推入上下文**（S2）。放在历史之后、当前提示之前：
    // 它是"这次开工前该知道的事实"，位置比历史更靠近当前请求。
    if (toolInventory !== null) {
      // 注意：这里**不能** ctx.push() —— buildMessages 自己组装 out 数组，
      // 不读 this.messages 里的 system 消息。必须赋给字段（见 RunContext.toolInventoryNote）。
      ctx.toolInventoryNote = toolInventory;
    }
    // CP §5.3 恢复注记（merge/注入）与 §7.3 第 4 步 openStepNotes 首条：
    // 两个方法在 Journal 实现里存在（journal.ts:256/276），但 CP §8 契约面
    // 只登记到 tail，故本处改从 tail 取 system.note 步（等价且不扩契约面）。
    for (const s of this.cp.journal.tail(session.id, 5)) {
      if (s.toolName === 'system.note') ctx.feedSystemNote(noteText(s));
    }
    for (const s of this.cp.journal.tail(session.id, 5)) {
      if (s.status === 'interrupted') ctx.feedSystemNote(noteText(s));
    }

    // 文件记忆快照缓存到 ctx（后续每步 LLM 请求复用同一份注入）
    this.cacheBundle(ctx, bundle);

    // P2-2 显式计划：任务开始时（或从会话历史里恢复出旧计划）把它挂到 ctx 上。
    //
    // 三条纪律（见 plan.ts 文件头）：
    //   1. **默认关闭** —— planEnabled=false 时本段一次都不进，请求体逐字不变；
    //   2. **失败不阻塞** —— 模型没写出可解析的计划就静默跳过，主循环照常跑；
    //   3. **不驱动执行** —— 计划只是每轮带上的 system 注记，Runner 从不据它调度。
    if (this.planEnabled) {
      const restored = plansFromMessages(replay).current;
      if (restored !== null) {
        // 续跑/重试：沿用上一代写下的计划（不重复问模型，省一次调用）
        ctx.setPlan(formatPlanForPrompt(restored));
        this.log(`runner: 沿用已有计划 ${session.id}（第 ${restored.version} 版，${restored.items.length} 条）`);
      } else {
        await this.seedPlan(session, ctx);
      }
    }

    // ⑨ 审批续跑：领到的任务带 resume_from_seq → 该 pending 步 pending→started（同 callId）
    if (session.resumeFromSeq !== null) {
      const resumed = await this.resumePendingStep(session, epoch, session.resumeFromSeq, ctx);
      if (resumed === 'rejected') {
        return this.finishTask(session, epoch, { ok: false, summary: `审批续跑失败：步骤 ${session.resumeFromSeq}` });
      }
      if (resumed === 'executed') {
        const out = this.afterStep(session, epoch, ctx);
        if (out !== null) return out;
      }
    }

    // ⑥/⑦ 主循环
    //
    // CP §5.4 步数上限的执行主体是 **Journal.nextSeq**（journal.ts:429-451）：
    // 硬上限越线抛 StepLimitError，软上限首次越线由 Journal 自己记 watchdog。
    // Runner 不再自持计数器——`tail()` 默认只取 20 行（journal.ts:246），
    // 拿它当步数判上限是死码（审码 finding ①）。Runner 的义务是**接住**
    // StepLimitError 并按 CP §5.4 收口：failed(stop_reason='budget')，
    // **不经 attempt 重试**（见 runNext 的 catch 分支）。
    while (!ctx.done) {
      const llm = await this.stepLlm(session, epoch, ctx);
      if (llm.kind === 'pause') return llm.out;
      if (llm.kind === 'abort') return llm.out;

      // P2-2 计划修订：模型可以**在正文里**给出新版本计划（显式动作）。
      // 修订只是"记下来 + 下一轮注入"，**绝不改本轮的工具调用**——计划不是控制流。
      if (this.planEnabled) this.capturePlanRevision(session, ctx, llm.step.content);

      if (llm.step.toolCalls.length === 0) {
        ctx.feedLlm({ content: llm.step.content, toolCalls: [] }, llm.tokens);
        continue; // done=true → 退出 while
      }

      // 本轮调用的声明先登记：工具结果回喂时要靠它复原 assistant.tool_calls
      // （协议要求 role=tool 必须紧跟在一个带 tool_calls 的 assistant 消息之后）。
      ctx.noteToolCalls(llm.step.toolCalls);
      // 记录"模型给的 id → 本轮真正用的 journal callId"，供 reportToolCalls 用。
      // 两者不同：模型发的是 call_00_xxx，journal 发的是 ULID。**tool 结果用的是后者**，
      // 所以 assistant.tool_calls 必须也用后者，否则 role:tool 永远配不上前置声明，
      // 模型会看到一堆"无主的工具结果"并无视它们（实测导致写-读死循环 46 步）。
      const journalIds: Array<{ id: string; name: string; arguments: string }> = [];
      for (const call of llm.step.toolCalls) {
        if (ctx.done) break;
        // 原地打转护栏（见 repeatGuard 注释）：同 (工具,参数) 反复调用时介入。
        const guard = this.checkRepeat(call, ctx, session.id);
        if (guard === 'stop') {
          // 护栏判定必须收尾：**跳过本次派发**，让下一轮 LLM 在"没有工具可调"的情况下
          // 直接产出结论（而不是由产品替它写结论——那会顶掉模型的正常回答）。
          const skips = (this.repeatSkipsByTask.get(session.id) ?? 0) + 1;
          this.repeatSkipsByTask.set(session.id, skips);
          if (skips > REPEAT_MAX_SKIPS) {
            // 兜底：模型连"不许调工具"的强令都不理，仍在给工具调用 —— 产品侧收口，
            // 否则外层 while 会一直转（实测能把测试挂死）。
            this.log(`runner: 护栏连续跳过 ${skips} 轮仍不收敛，产品侧收口 ${session.id}`);
            ctx.markDone(
              `我停下了：同一个动作反复执行且结果没有变化（最近一次：${call.name}），` +
                `说明这一步已经做完。以现有结果为准收尾。`,
            );
            break;
          }
          this.log(`runner: 原地打转护栏触发，跳过派发并强制模型收尾 ${session.id}`);
          ctx.feedSystemNote(
            '你已经反复调用同一个工具且结果没有变化。现在不要再调用任何工具，直接给出最终结论。',
          );
          break;
        }
        if (guard !== null) ctx.feedSystemNote(guard.note);
        const out = await this.stepTool(session, epoch, ctx, call, journalIds);
        if (out.kind === 'pause') return out.out;
        if (out.kind === 'abort') return out.out;
        if (out.kind === 'suspend') return out.out;
        if (out.kind === 'fail') return out.out;
        if (out.kind === 'continue') continue;
      }

      const hb = this.afterStep(session, epoch, ctx);
      if (hb !== null) return hb;
    }

    // ⑪ 任务终态：WRITE-SEAL → finish(ok:true)
    const done = await this.finishTask(session, epoch, { ok: true, summary: ctx.summary });
    this.resetRepeatGuard(session.id);
    return done;
  }

  // ── 3.2b P2-2 显式计划（可观测产物，不是控制流）─────────────────────────

  /**
   * 任务开始前问模型要一份计划。
   *
   * **怎么问**：单独发一次 `router.complete`（不带 tools），prompt = 运行手册 + 目标
   * + `PLAN_REQUEST_TEXT`。为什么不复用主循环第一轮？因为那一轮的产出是"工具调用"，
   * 让它在同一轮里既出计划又出工具调用会让计划变成"事后合理化"；单独问一次，
   * 计划才是"动手前想清楚"。
   *
   * **失败怎么办**：解析不出、模型报错、超时 —— 一律**静默跳过**（记一条日志），
   * 主循环照常跑。计划是增强项，不能成为新的失败点（memory.md §8 软线语义）。
   *
   * **成本**：一次额外调用（约 300 输出 token）。这就是它默认关闭的原因。
   */
  private async seedPlan(task: Task, ctx: RunContext): Promise<void> {
    const systemPrompt = composeSystemPrompt();
    const req: RouteRequest = {
      track: 'primary',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${task.goal}\n\n${PLAN_REQUEST_TEXT}` },
      ],
      attemptId: newNonJournalAttemptId(),
      maxTokens: 512,
    };
    let text = '';
    try {
      const resp = await this.router.complete(req);
      const chat = resp.response as { content?: string };
      text = typeof chat.content === 'string' ? chat.content : '';
    } catch (err) {
      // 计划写不出来不是任务失败：记一笔，主循环照常（顶多失去抗跑偏这条增强）。
      this.log(`runner: 生成计划失败 ${task.id}（${errText(err)}），本轮无计划继续`);
      return;
    }
    const plan = parsePlan(text);
    if (plan === null) {
      this.log(`runner: 计划无法解析 ${task.id}，本轮无计划继续`);
      return;
    }
    await this.savePlan(task, plan, ctx);
  }

  /** 把模型在**正文里**给出的新计划记下来（修订）；不是计划 JSON 就什么都不做。 */
  private capturePlanRevision(task: Task, ctx: RunContext, content: string): void {
    if (content.indexOf(PLAN_MARKER_HINT) === -1 && content.indexOf('"items"') === -1) return;
    const parsed = parsePlan(content);
    if (parsed === null) return;
    // 只有"确实变了"才算一次修订：否则每轮正文里带一句 JSON 示例都会刷版本号。
    const hist = ctx.planHistory();
    const current = hist.length > 0 ? hist[hist.length - 1]! : null;
    if (current !== null && samePlan(current, parsed)) return;
    const next: Plan = {
      version: current === null ? 1 : current.version + 1,
      items: parsed.items,
      revisionReason: parsed.revisionReason,
    };
    void this.savePlan(task, next, ctx);
  }

  /** 落库（追加一条 thread 消息）+ 挂到 ctx（下一轮起生效）。 */
  private async savePlan(task: Task, plan: Plan, ctx: RunContext): Promise<void> {
    ctx.recordPlan(plan);
    ctx.setPlan(formatPlanForPrompt(plan));
    const threadId = this.threadIdOf(task);
    if (threadId === null) return;
    try {
      // role='system' + kind='text'：mem_messages.kind 的 CHECK 白名单写死在已发布迁移
      // （040_memory.sql:26-28，契约 D2 不改已发布包），故用现成 kind，靠 PLAN_MARKER 区分。
      // taskId 带上：主人的会话历史与 task --verbose 都能按任务找到它。
      await this.memory.appendMessage(threadId, {
        role: 'system',
        kind: 'text',
        content: serializePlan(plan),
        taskId: task.id,
      });
    } catch (err) {
      // 记忆问题不炸主循环；ctx 上的计划仍生效（本任务内可用）。
      this.log(`runner: 计划落库失败 ${task.id}（${errText(err)}）`);
    }
  }

  // ── 3.3 ⑥ LLM 步 ──────────────────────────────────────────────────────

  private async stepLlm(
    task: Task,
    epoch: number,
    ctx: RunContext,
  ): Promise<
    | { kind: 'ok'; step: LlmStep; tokens: number }
    | { kind: 'pause'; out: TaskRunOutcome }
    | { kind: 'abort'; out: TaskRunOutcome }
  > {
    const { seq, callId } = this.cp.journal.beginLlm(task.id, epoch, digestOf(ctx.goal));
    const messages = ctx.buildMessages(this.cachedBundle(ctx));
    // roadmap P0-2：总线在场 + 开关打开 → 走流式（增量实时上总线）；
    // 其余情况**逐字**走 complete()。两条路径的返回值归一成同一个 LlmStep，
    // 失败也抛给下面同一个 catch 分支——失败/降级语义只存在一份实现。
    //
    // 注意 `req` **两条路径共用同一份对象**：除 `stream` 标记外没有任何字段差异，
    // 这样"无总线时行为不变"是可对照的（tests/runner-stream.test.ts 断言了请求体）。
    // 原地打转护栏已触发过 → 这一轮**不给任何工具**（清单清空）：
    // 实测模型连"不许再调工具"的强令都会无视，继续发工具调用直到产品侧收口
    // （2026-10-20 整理 163 邮箱连打转 3 次，主人只收到系统收口说明、收不到正式回复）。
    // 把工具从清单里拿掉是唯一的物理强制 —— 模型只能写文字结论，正是护栏要的。
    // repeatSkipsByTask 的键是 task.id（= 主循环里的 session.id，见收口日志）。
    const repeatSkips = this.repeatSkipsByTask.get(task.id) ?? 0;
    const tools = repeatSkips > 0 ? [] : await this.toolSpecs(task);
    // 先问"能不能流式"，再定请求体：`stream` 标记只在确实走流式时才出现（complete 请求逐字不变）。
    const useStream = this.useStream();
    // 多模态：在**投影之后**的 ChatMessage 数组上挂图片。
    // 2026-10-19 修：早先挂到 ctx.messages（那时历史还没从 thread 重建完，数组是空的），
    // find 找不到 user 消息 → 图片静默丢失 → 模型只能自己写脚本解像素。
    const wireMessages = messages.map(toChatMessage);
    const withImages =
      this.cachedGoalImages.length === 0
        ? wireMessages
        : attachImagesToLastUser(wireMessages, this.cachedGoalImages);
    const req: RouteRequest = {
      track: 'primary',
      messages: withImages,
      tools,
      tool_choice: 'auto',
      attemptId: callId, // 契约 J1：attemptId = journal 步 callId
      maxTokens: 4096,
      ...(useStream ? { stream: true } : {}),
    };
    let resp;
    try {
      resp = useStream ? await this.streamLlm(task, req, callId) : await this.completeLlm(task, req);
    } catch (err) {
      // 模型故障支线：熔断耗尽 → paused(circuit_open)，等 router.mode_changed 批量回 queued
      if (err instanceof AllEndpointsDownError || err instanceof NoQualifiedPrimaryError) {
        // **三种"模型不可用"必须分开标**（2026-10-19 实测改）。
        //
        // 原来这一支不分情况一律 `pauseByReason('circuit_open')`，导致：
        // 网关端口没起来（AllEndpointsDownError）→ 任务标成 circuit_open →
        // 而恢复路径 resumeCircuitOpenTasks 只在 router.mode_changed / breaker_changed 时跑，
        // 网关修好时两者都不发生 → **任务永远卡在 paused**（实测）。
        //
        // 现在按真实成因标 reason，恢复逻辑可以分别处理：
        //  - no_qualified_primary：配置问题，改配置才好，不会自愈（提示主人改配置）
        //  - endpoints_unreachable：网关/网络问题，网关恢复即好（提示检查网关）
        //  - circuit_open：breaker 真的开了，backoff 后自愈（发 breaker_changed 唤醒）
        const pauseReason =
          err instanceof AllEndpointsDownError ? 'endpoints_unreachable' : 'no_qualified_primary';
        const hint =
          pauseReason === 'endpoints_unreachable'
            ? '所有模型端点都连不上 —— 先检查模型网关（relay / gpt-load）是否在跑；网关恢复后任务会自动回队。'
            : '没有合格的主端点 —— 这是配置问题（config/models.yml 的 primary 端点/凭据），改好配置后手动 resume。';
        // **必须留日志**（2026-10-18 实测）：关键故障必须能在日志里看见，
        // 否则主人只看到"不回话"，无从判断是端点挂了还是 dotd 坏了。
        this.log(
          `runner: 模型不可用 → paused(${pauseReason}) ${task.id}` +
            `（${err instanceof Error ? err.name : 'unknown'}：${errText(err)}）。${hint}`,
        );
        this.cp.pauseByReason(task.id, pauseReason);
        await this.seal(task, 'cancelled', pauseReason);
        return {
          kind: 'pause',
          out: { taskId: task.id, epoch, status: 'paused', summary: err.message },
        };
      }
      // 其余模型错误：LLM 步记 failed，任务按 err 收口（attempt<max → queued 重试）
      this.cp.journal.endLlm(task.id, epoch, seq, `error:${errText(err)}`);
      this.cp.finish(task.id, epoch, { ok: false, summary: `模型调用失败：${errText(err)}` });
      await this.seal(task, 'failed', 'model_error');
      return {
        kind: 'abort',
        out: { taskId: task.id, epoch, status: 'failed', summary: `模型调用失败：${errText(err)}` },
      };
    }

    const { step, tokens } = resp;
    this.cp.journal.endLlm(task.id, epoch, seq, digestOf(step.content));
    // 记住本轮正文：工具调用落 thread 时要带上它（见 RunContext.currentTurnText）。
    ctx.currentTurnText = step.content;
    ctx.feedLlm(step, tokens);
    // ⑩ 结果回报：assistant 轮入 thread。
    //
    // **工具调用轮也必须入 thread**，而且要落 assistant/text（正文）+ assistant/tool_call
    // （调用声明）两条。为什么（2026-10-18 真实故障）：
    //   原先只落「content 非空且无 toolCalls」的轮次，工具调用轮整轮丢弃。于是
    //   thread 里只剩一堆**没有归属**的 system/tool_result。下一轮重建上下文时，
    //   `role:'tool'` 找不到前置的 assistant.tool_calls（协议要求它们必须配对），
    //   结果全被降级成孤立注记 —— 模型看不到自己上一轮做过什么，
    //   于是**每轮都从第一步重来**。实测一条 4 步任务跑成 729 步死循环仍未停。
    //
    // 判据改成"这一轮有任何内容就落"：有正文落正文，有调用落调用声明。
    // 有工具调用时，正文随调用声明一起落（一条消息，见 reportToolCalls 注释）；
    // 没有调用的纯正文轮才单独落一条 assistant/text。
    if (step.toolCalls.length === 0 && step.content.length > 0) {
      await this.reportAssistant(ctx, task, step.content);
    }
    if (step.toolCalls.length === 0 && step.content.length > 0) {
      // 会话流式：正文定稿 → chat.final 覆盖前端按 taskId 拼出来的增量行
      // （web-ui ChatView 的覆盖逻辑；与 http.ts:522 同 payload）。纯工具调用轮不推，
      // 那时没有给主人看的定稿内容。
      this.publishChatFinal(task, step.content);
    }
    return { kind: 'ok', step, tokens };
  }

  /**
   * 是否具备流式条件：总线在场 + `DOTD_STREAM_CHAT` 未关 + router 确有 stream 方法（鸭子类型）。
   *
   * 工具调用**不是**障碍：`ChatChunk.toolCalls`（增量）→ `StreamToolCallAccumulator`
   * （shared/tool-stream.ts 的容错聚合）→ `stream.toolCalls()`（成品）这条链已经打通，
   * 流式回合与 complete() 回合一样能派发工具，见 `streamLlm` 与防假完成用例。
   */
  private useStream(): boolean {
    if (!this.streamEnabled) return false;
    if (this.chatBus === null) return false;
    return typeof (this.router as Partial<ModelRouterApi>).stream === 'function';
  }

  // ── 3.3a ⑥ 两条模型调用路径（返回值同形，失败都抛给 stepLlm 的统一 catch）────

  /**
   * 非流式路径（与接入流式之前**逐字**相同的那几行）：`router.complete` →
   * `{response:{content,toolCalls}}` + usage → 归一成 LlmStep + tokens。
   */
  private async completeLlm(
    task: Task,
    req: RouteRequest,
  ): Promise<{ step: LlmStep; tokens: number }> {
    void task;
    const resp = await this.router.complete(req);
    const usage = resp.usage ?? { promptTokens: 0, completionTokens: 0 };
    const chat = resp.response as { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
    const step: LlmStep = {
      content: typeof chat.content === 'string' ? chat.content : '',
      toolCalls: (chat.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
      })),
    };
    return { step, tokens: usage.promptTokens + usage.completionTokens };
  }

  /**
   * 流式路径（roadmap P0-2；MR §4.7）。
   *
   * 分工（不越界、不重造）：
   * - **候选扫描 / 首字节分界 / tier 降级 / 熔断结算 / `meta.tried` 记账 / 零用量空壳重试**
   *   全在 `ModelRouter.stream()`（src/router/ModelRouter.ts:605-791）里，本方法一律不碰；
   * - 本方法只做三件事：把 `chunk.delta` 合帧推到 `chat.delta`、把流收成与非流式同形的
   *   `LlmStep`、给首字节后的断流留一条可排查的日志后**原样上抛**。
   *
   * 失败语义对齐 complete() 路径（`dot.ts` 的 stepLlm catch 分支）：
   * - 首字节前全候选耗尽 → router 抛 `AllEndpointsDownError`/`NoQualifiedPrimaryError`
   *   → 原样上抛 → 同一个 catch 走 `pauseByReason(circuit_open)`，与 complete 逐字一致；
   * - 首字节前首候选失败 → router 自己换下一候选（等价非流式"换端点"），Runner 无感；
   * - 首字节后断流 → router 抛 `StreamInterruptedError`（**绝不自动重放**）。它落到 catch
   *   里的 "其余模型错误" 分支，与非流式网络错误的收口完全同路（journal 记 error、
   *   finish(ok:false)、seal(failed,'model_error')、任务 queued 重试）。
   *   **本方法绝不把已吐出的半句当成功**：那样 `ctx.feedLlm` 会把任务判成 done，
   *   等于拿半截答案交差。
   *
   * usage：`ModelRouter.stream()` 目前不把 transport 的 usage 透传出来（见交付报告
   * 「router 缺陷观察」），故这里按本仓库既有的字符近似（`tokenEst = len/3.5`）
   * 记 completion 用量；断流时按已交付字数记账（半句也不白算）。
   */
  private async streamLlm(
    task: Task,
    req: RouteRequest,
    callId: string,
  ): Promise<{ step: LlmStep; tokens: number }> {
    const stream = this.router.stream(req);
    const sink = new ChatDeltaSink(
      (text) => this.publishChatDelta(task, callId, text),
      this.streamFlushMs,
      this.streamFlushChars,
    );
    let content = '';
    try {
      for await (const chunk of stream) {
        const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
        if (delta.length > 0) {
          content += delta;
          sink.push(delta);
        }
        if (chunk.done === true) break; // 与 ModelRouter 同口径：done 后不再等下一个值
      }
      sink.close();
    } catch (err) {
      // 已交付的增量先落总线上：前端能看见"模型说到哪儿了"（回合最终会失败收尾）。
      sink.close();
      // 首字节后断流（StreamInterruptedError）**不得**折成一条 step 返回：
      // `ctx.feedLlm` 对 toolCalls=[] 的响应会置 done=true，而 `stepLlm` 的成功分支
      // 必然调 `endLlm`+`feedLlm`——返回半句就等于把任务判成 done、拿半截答案交差。
      // 正确收口是让它**上抛**，落到 stepLlm 里与 complete() 路径**共用**的 catch：
      // 同一个"其余模型错误"分支 → journal 记 error、finish(ok:false)、
      // seal(failed,'model_error')、attempt<max 回 queued 重试（可恢复）。
      // 已吐出的半句只留在总线与 journal 的错误摘要里，不进 ctx.messages。
      if (err instanceof StreamInterruptedError) {
        this.log(
          `runner: 流式回合首字节后断流 ${task.id}（已交付 ${err.textSoFar.length} 字，` +
            `consumedTokens=${err.consumedTokens}）→ 按模型错误收口（不重放）`,
        );
      }
      throw err;
    }
    // 工具调用：**等流读完**才取（roadmap P0-2 第 4 条：不在流中途派发），
    // 由 MR 用 shared/tool-stream.ts 的聚合器收成成品，与 complete() 的
    // `chat.toolCalls` 同形——下游 `stepTool`/`ctx.noteToolCalls` 完全无感。
    const toolCalls = stream.toolCalls().map((c) => ({
      id: c.id,
      name: c.name,
      arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
    }));
    // 防假完成硬兜底：既没有正文、也没有工具调用的回合不是完结轮，不能以 done 收口。
    if (content.trim().length === 0 && toolCalls.length === 0) {
      throw new Error('流式回合既无正文也无工具调用，按模型错误收口以触发重试');
    }
    return { step: { content, toolCalls }, tokens: approxTokens(content.length) };
  }

  // ── 3.3b chat.* 总线（roadmap P0-2：payload 照抄 http.ts:522 与 ChatView 的约定）────

  /** `chat.delta`：一次合帧后的增量。payload 至少含 {taskId, threadId, callId, delta}。 */
  private publishChatDelta(task: Task, callId: string, delta: string): void {
    if (this.chatBus === null || delta.length === 0) return;
    try {
      this.chatBus.publish(
        'chat.delta',
        {
          kind: 'chat.delta',
          taskId: task.id,
          threadId: this.threadIdOf(task),
          callId,
          delta,
        },
        { dotId: this.dotId },
      );
    } catch (err) {
      // 总线是展示面：发布失败绝不能炸主循环（与记忆软线同策）。
      this.log(`runner: publish chat.delta 失败 ${task.id}：${errText(err)}`);
    }
  }

  /** `chat.final`：回合定稿全文 + 工具调用计数（前端据此覆盖同 taskId 的增量行）。 */
  private publishChatFinal(task: Task, text: string): void {
    if (this.chatBus === null) return;
    try {
      this.chatBus.publish(
        'chat.final',
        {
          kind: 'chat.final',
          taskId: task.id,
          threadId: this.threadIdOf(task),
          text,
          toolCalls: 0,
        },
        { dotId: this.dotId },
      );
    } catch (err) {
      this.log(`runner: publish chat.final 失败 ${task.id}：${errText(err)}`);
    }
  }

  /** 文件记忆只在任务开始时注入一次；这里持有该快照供后续每步复用。 */
  private cachedBundle(ctx: RunContext): {
    memoryMd: string;
    manualExcerpts: Array<{ path: string; text: string }>;
    summary: string | null;
  } {
    const cached = (ctx as unknown as { __bundle?: unknown }).__bundle;
    if (cached !== undefined) {
      return cached as {
        memoryMd: string;
        manualExcerpts: Array<{ path: string; text: string }>;
        summary: string | null;
      };
    }
    // 未注入过（测试直连 stepLlm 的罕见路径）：退化为空，不阻塞主循环。
    return { memoryMd: '', manualExcerpts: [], summary: null };
  }

  /** 缓存 bundle（runTask ⑤ 注入后调一次）。 */
  private cacheBundle(
    ctx: RunContext,
    bundle: { memoryMd: string; manualExcerpts: Array<{ path: string; text: string }>; summary: string | null },
  ): void {
    (ctx as unknown as { __bundle?: unknown }).__bundle = bundle;
  }

  /**
   * 工具清单（MR §3.1 ToolSpec）。
   *
   * 两层分工：`parameters` 逐字透传 `/capabilities` 的 args_schema（契约事实源，
   * Runner 不自己发明参数）；`description` 来自 `tool-catalog.ts` 的说明书
   * （何时用/参数怎么填/返回什么/失败怎么读），参数行与当前 schema 求交，
   * 宿主/容器两份目录有差异时也不会教模型填一个不存在的字段。
   */
  /**
   * 模型可见的工具清单（S2(b)，2026-10-19）。
   *
   * **动态注册自造工具**：不只用 tool.invoke 这个泛用入口，还把 tools/<name>/ 里
   * 每个自造工具**当成独立工具**塞进清单 —— 名字直接用 <name>，参数 schema 从
   * manifest.params 生成。
   *
   * 为什么必须这么做（2026-10-19 定位的根因）：
   *   早先只把工具清单作为**文本**注入上下文，模型必须自己完成
   *   「看到文字说有 word-count → 想到要用 tool.invoke(name='word-count')」这个间接映射。
   *   实测 deepseek-v4.1-flash / glm-5.3-flash / agnes-3.0-flash **三个模型全部失败**，
   *   都选择用 shell.run 手写。三个不同厂商同时失败说明不是"模型不听话"，
   *   而是**任务难度本身超纲**：间接映射比"从工具列表里选一个"难得多。
   *
   *   改成独立工具后，word-count 和 fs.read 在模型眼里是一类东西，选它不需要额外推理。
   *
   * 安全：动态工具**仍然走 tool.invoke 的实际执行路径**（这里只改"暴露方式"），
   * 所以 tool.create / tool.invoke 的 dangerously 档审批约束一字不动 —— 模型能"看见"
   * 这些工具，但真正执行时治理层照常拦。
   */
  /**
   * 本轮已动态注册成独立 tool 的自造工具名（S2(b)，2026-10-19）。
   *
   * 用途只有一个：**执行路由**。这些名字只出现在模型可见的 tools 里，
   * 既不在 11 名契约词表（CAPABILITY_CATALOG）、也不在 config/tools.yml 白名单，
   * 所以不能直接当 exec 工具名派发（会被 validateToolCall / gate 判 unknown_tool）。
   * 派发前统一翻译成 tool.invoke(name=<它>, args=<模型给的参数>)。
   *
   * **为什么翻译而不是把它们加进白名单**：tool.invoke 是 dangerous 档（每次执行需主人
   * 审批）。翻译后自造工具自动继承这条审批约束，不新增任何绕过治理的路径；
   * 若改成"动态工具登记进白名单"，等于让模型自己写的脚本直接越过审批跑。
   */
  private readonly dynamicToolNames = new Set<string>();

  private async toolSpecs(task: Task): Promise<Array<{ name: string; description?: string; parameters?: object }>> {
    const caps = await this.getCapabilities();
    const base = buildToolSpecs(caps);

    // 动态追加自造工具（读失败就当没有，不影响主流程）
    try {
      const dyn = await this.dynamicToolSpecs(task);
      if (dyn.length === 0) return base;
      // 名字冲突时以底座为准（内置工具优先，避免被自造工具顶掉）
      const taken = new Set(base.map((s) => s.name));
      const extra = dyn.filter((d) => !taken.has(d.name));
      // 记下来供执行路由用（见 dynamicToolNames 注释）。
      for (const d of extra) this.dynamicToolNames.add(d.name);
      return extra.length > 0 ? [...base, ...extra] : base;
    } catch (err) {
      this.log(`runner: 动态工具注册失败（不影响内置工具）：${err instanceof Error ? err.message : String(err)}`);
      return base;
    }
  }

  /** 读 tools/ 下所有工具，转成 tool schema。 */
  private async dynamicToolSpecs(task: Task): Promise<Array<{ name: string; description?: string; parameters?: object }>> {
    if (!(await this.hasToolList())) return [];
    const r = await this.exec.runTool(toolCall(task, `dynspec_${Date.now()}`, 'tool.list', {}, 60_000));
    const payload = (r as { result?: { tools?: Array<Record<string, unknown>> } }).result;
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    const out: Array<{ name: string; description?: string; parameters?: object }> = [];
    for (const x of tools) {
      const name = typeof x['name'] === 'string' ? x['name'] : '';
      const desc = typeof x['description'] === 'string' ? x['description'] : '';
      if (name.length === 0 || desc.length === 0) continue;
      if (x['broken'] !== undefined && x['broken'] !== null) continue; // 坏工具别暴露
      const params = (x['params'] ?? {}) as Record<string, unknown>;
      const props: Record<string, { type: string; description?: string }> = {};
      for (const [k, v] of Object.entries(params)) {
        props[k] = { type: 'string', description: typeof v === 'string' ? v : String(v) };
      }
      out.push({
        name,
        description:
          `【自造工具】${desc}` +
          (typeof x['returns'] === 'string' ? `\n返回：${x['returns']}` : ''),
        parameters: { type: 'object', properties: props, additionalProperties: true },
      });
    }
    return out;
  }

  /** 当前能力目录里有没有 tool.list（没有就别白跑一次调用）。 */
  private async hasToolList(): Promise<boolean> {
    try {
      const caps = await this.getCapabilities();
      return caps.some((c) => c.name === 'tool.list');
    } catch {
      return false;
    }
  }

  private async getCapabilities(): Promise<Array<{ name: string; mode: 'sync' | 'async'; max_deadline_ms: number; args_schema: object; sideEffect: 'safe' | 'replayable' | 'unknown' }>> {
    const caps = await this.exec.getCapabilities(this.dotId);
    for (const c of caps) {
      this.sideEffectOf.set(c.name, c.sideEffect);
      this.deadlineCapOf.set(c.name, { mode: c.mode, maxDeadlineMs: c.max_deadline_ms });
    }
    return caps;
  }

  /**
   * 派发一个工具时该声明多少 deadline（P0-3）。
   *
   * - async 工具：用目录声明的 `max_deadline_ms`（缺省 ExecConfig.asyncDeadlineMs）。
   *   这些工具本来就可能跑几十分钟，用 sync 档的 60s 去卡它们是**本地凭空造出来的超时**；
   * - sync 工具：保持 Runner 的 `toolDeadlineMs`（EX §5.2 的 60s 档），一字不改。
   * 未登记的目录项按 sync 处理（保守：不放大未知工具的上限）。
   */
  private toolDeadlineMsFor(tool: string): number {
    return toolDeadlineMsFor(this.toolDeadlineMs, this.deadlineCapOf.get(tool));
  }

  /**
   * 本次调用的实际 deadline：**模型要求的超时**与**档位上限**取较小值。
   *
   * - 模型在参数里传了 timeout_ms（正整数）→ 尊重它（更短的超时是模型自己的选择）；
   * - 模型没传或传得不合法 → 用档位默认（sync 60s / async 目录上限）；
   * - 无论如何不超过档位上限：那是安全兜底，不能被工具参数绕过。
   */
  /**
   * 给 fs.write 自动补 expected_size（乐观并发控制）。
   *
   * 触发条件（缺一不可）：
   *   1. 工具是 fs.write；
   *   2. 模型**没有**自己传 expected_size（尊重模型的显式选择）；
   *   3. 本任务此前 fs.read 过同一个文件（说明这是"读-改-写"，没有基线就无从校验）。
   *
   * 补上之后，执行面会校验文件大小；若期间被别的任务改过 → stale_write（可重试），
   * 模型重读一遍即可。这样并发丢数据从"靠模型自觉"变成"默认就安全"。
   */
  private withAutoExpectedSize(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    if (tool !== 'fs.write') return args;
    if (args['expected_size'] !== undefined) return args;
    const path = args['path'];
    if (typeof path !== 'string') return args;
    const key = normalizePathForReadSize(path);
    const size = this.readSizes.get(key);
    if (size === undefined) return args;
    return { ...args, expected_size: size };
  }

  /** 记下一次 fs.read 看到的文件大小（供 withAutoExpectedSize 用）。 */
  private noteReadSize(args: Record<string, unknown>, value: unknown): void {
    const path = args['path'];
    if (typeof path !== 'string') return;
    const size = (value as { size_bytes?: unknown } | null)?.size_bytes;
    if (typeof size !== 'number' || !Number.isFinite(size)) return;
    this.readSizes.set(normalizePathForReadSize(path), size);
  }

  private effectiveDeadlineMs(tool: string, args: Record<string, unknown>): number {
    const cap = this.toolDeadlineMsFor(tool);
    const want = args['timeout_ms'];
    if (typeof want !== 'number' || !Number.isFinite(want) || want <= 0) return cap;
    return Math.min(want, cap);
  }

  // ── 3.35 原地打转护栏 ──────────────────────────────────────────────────

  /**
   * 同一 (工具, 参数) 的重复调用检测。返回 null = 正常派发。
   *
   * 阈值（取自真实数据：观察到的重复是 3–5 次同参数调用）：
   *  - 第 1 次：正常派发；
   *  - 第 2 次：正常派发（模型可能确实需要重试一次，比如刚写就想读回）；
   *  - 第 3 次起：**回喂一条强注记**——"你已经用完全相同的参数调用过 N 次，结果如下，
   *    不要再用同样参数"；仍照常派发（不阻断，避免误杀"确实需要再跑一次"的偶发场景）；
   *  - 第 {@link REPEAT_HARD_LIMIT} 次：**强制收口**，把已观察到的最后一轮结果当作结论。
   *
   * 为什么不做成硬拦截在第 3 次：真实任务里"写完再读"是两次同文件的**不同**调用，
   * 不会撞这条判据；撞到的是**完全相同的 工具+参数**，那种情况第 3 次基本不可能是必要的。
   * 但保守起见，先软后硬，给模型一次自我纠正的机会。
   */
  private checkRepeat(
    call: { id: string; name: string; arguments: string },
    ctx: RunContext,
    taskId: string,
  ): { note: string } | 'stop' | null {
    const key = `${call.name}::${repeatSignature(call.arguments)}`;
    let bucket = this.repeatGuard.get(taskId);
    if (bucket === undefined) {
      bucket = new Map();
      this.repeatGuard.set(taskId, bucket);
    }
    const rec = bucket.get(key) ?? { count: 0, last: '' };
    rec.count += 1;
    bucket.set(key, rec);

    // **跨工具打转**（2026-10-19 实测到的真实缺陷）：重复守卫原本只认
    // "同一 (工具,参数)"，但模型会交替调用 A、B、A、B 绕开它。
    // 现场：一个"查 zen 并存笔记"的任务跑到 25 步还没写文件 ——
    //   net.get(zen) → fs.stat(note)不存在 → net.get(zen) → fs.stat(note)不存在 → …
    // 每一步单独看都是"新的调用"，守卫完全沉默。
    //
    // 这里用**同一工具的近期调用次数**兜底：不看具体参数，只看"这个工具是不是
    // 在这个任务里被用得太多"。阈值放得比单参数守卫宽，避免误伤合法的批量操作
    // （比如连续读 10 个文件）；但同一工具超过 6 次、且任务已跑很久，就该提示了。
    const perTool = this.toolCallCounts.get(taskId) ?? new Map<string, number>();
    const used = (perTool.get(call.name) ?? 0) + 1;
    perTool.set(call.name, used);
    this.toolCallCounts.set(taskId, perTool);
    if (used === 6 && (call.name === 'net.get' || call.name === 'fs.stat')) {
      return {
        note:
          `【检查方向】\`${call.name}\` 在这个任务里已经调用 ${used} 次了。` +
          `如果你已经**拿到了需要的信息**（比如接口返回了内容、文件确实不存在），` +
          `就不要再重复查询 —— 直接用已有结果完成任务（该写文件就写文件，该回答就回答）。` +
          `重复同样的查询不会让答案变得更好。`,
      };
    }

    // **结果没变化才是真打转**（2026-10-18 校准）：次数本身不可靠 ——
    // 有的任务合法地重复同一动作 8 次（tests/runner-plan.test.ts 的抗跑偏用例），
    // 靠次数拦会误伤；而"同一调用 + 结果一字不差"几乎必然是原地打转。
    //
    // 实现：recordRepeatResult 每次记下"这次返回了什么"，并在**结果与上次相同**时
    // 递增 sameResultCount。同结果的重复从第 2 次起就强令收尾（不等 4 次）。
    // 同结果重复：第 2 次强令收尾，第 4 次直接返回 stop（跳过派发）。
    // **必须有 stop 出口**——只回喂注记会让模型"被提醒但照做"，无限循环
    // （2026-10-18 实测把单测挂在 300s 不动）。
    // **注意时序**（2026-10-18 实测）：checkRepeat 在**派发前**执行，
    // recordRepeatResult 在**派发后**执行。所以这里读到的是"上一轮结束时的状态"：
    //   sameResultCount=1 → 上两次结果相同（已重复过一次）
    //   sameResultCount=2 → 已连续三次结果相同
    // 因此阈值要比"直觉次数"低 1。原先写 >=2/>=4 实际要求连续 3/5 次才动手，
    // 实测同参数 fs.write 跑了 5 次护栏都没介入。
    // **同路径整篇重写**（2026-10-19 实测缺陷，见 SAME_PATH_REWRITE_LIMIT）。
    // 放在"同结果"判据之前：这类打转的结果每次都变，走不到下面那些分支。
    const rewriteNote = this.checkSamePathRewrite(call, taskId);
    if (rewriteNote !== null) return rewriteNote;

    const sameResult = rec.sameResultCount ?? 0;
    if (sameResult >= 3) return 'stop';
    if (sameResult >= 1) {
      return {
        note:
          `【必须收尾】${call.name} 用完全相同的参数已经调用 ${rec.count} 次，` +
          `而且**每次都返回一样的结果**：${rec.last}。` +
          `重复不会产生新信息，现在立刻停止调用工具，直接给出最终结论。`,
      };
    }

    if (rec.count < REPEAT_SOFT_LIMIT) return null;

    if (rec.count >= REPEAT_HARD_LIMIT * 2) {
      // 已经给过两次强令收尾仍不收敛。返回 'stop' 让 Runner 跳过派发，
      // **仍不代写结论**——由下一轮 LLM 在没有工具可调的情况下产出正文。
      return 'stop';
    }

    if (rec.count >= REPEAT_HARD_LIMIT) {
      // 第一次到硬上限：**不直接收口**，而是下一条强指令让模型自己给结论。
      return {
        note:
          `【必须收尾】你已经用完全相同的参数调用 ${call.name} ${rec.count} 次，结果没有变化。` +
          `最近一次结果：${rec.last || '（无）'}。` +
          `现在立刻停止调用工具，直接根据已有信息给出最终结论。`,
      };
    }

    return {
      note:
        `注意：你已经用**完全相同的参数**调用 ${call.name} ${rec.count} 次了。` +
        `最近一次结果：${rec.last.length > 0 ? rec.last : '（无）'}。` +
        `如果目标已经达成，请现在直接给出结论收尾；不要重复同一个调用。`,
    };
  }

  /**
   * 检测"想追加，于是把整篇内容重写一遍"造成的打转（2026-10-19 实测缺陷）。
   *
   * 判据：同一路径、且**新内容以旧内容为前缀**（即在旧尾巴上又接了一段）。
   * 这正是"再加一行"被实现成"读全文 → 拼一行 → 整篇写回"的特征。
   *
   * 返回 null 表示没问题；返回 note 表示给出强令收尾的注记。
   * 注意：这里**不立刻 stop**，先给一次明确指令；只有累计超过阈值才硬停，
   * 避免误伤"确实要连续追加两三条"的合法场景（阈值 3）。
   */
  private checkSamePathRewrite(
    call: { name: string; arguments: string },
    taskId: string,
  ): { note: string } | 'stop' | null {
    if (call.name !== 'fs.write') return null;
    let obj: unknown;
    try {
      obj = JSON.parse(call.arguments);
    } catch {
      return null;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rec0 = obj as Record<string, unknown>;
    const rawPath = rec0['path'];
    const rawContent = rec0['content'];
    if (typeof rawPath !== 'string' || typeof rawContent !== 'string') return null;
    // 路径归一化，与 repeatSignature 的做法保持一致（g1.txt ≡ /dot/home/g1.txt）
    const path = rawPath
      .replace(/\\/g, '/')
      .replace(/^\/dot\/home(?:\/|$)/, '')
      .replace(/^\.\//, '');

    let perPath = this.rewritesByPath.get(taskId);
    if (perPath === undefined) {
      perPath = new Map();
      this.rewritesByPath.set(taskId, perPath);
    }
    const prev = perPath.get(path);
    let count = 1;
    if (prev !== undefined) {
      // 前缀关系：新内容 = 旧内容 + 后续追加的一段
      const isAppendStyle = rawContent.length > prev.content.length && rawContent.startsWith(prev.content);
      count = isAppendStyle ? prev.count + 1 : 1;
    }
    perPath.set(path, { content: rawContent, count });

    if (count < SAME_PATH_REWRITE_LIMIT) return null;

    if (count >= SAME_PATH_REWRITE_LIMIT + 2) return 'stop';
    return {
      note:
        `【必须收尾】你正在反复把 \`${path}\` 的**整篇内容**重写一遍来"追加"：` +
        `已经连续 ${count} 次，每次都在上一次的末尾又接了一段，文件越来越长。` +
        `**停止再写这个文件。** 你要加的那一行，第一次写入时就已经加进去了；` +
        `再写一次只会变成重复的两行。现在直接停止调用工具，用一句话告诉主人结果。`,
    };
  }
  /** 派发后回填该调用的结果摘要，供下一次重复时的注记引用（让模型看到真实结果）。 */
  private recordRepeatResult(
    taskId: string,
    call: { name: string; arguments: string },
    value: unknown,
  ): void {
    const key = `${call.name}::${repeatSignature(call.arguments)}`;
    const rec = this.repeatGuard.get(taskId)?.get(key);
    if (rec === undefined) return;
    try {
      // **时间戳类字段必须先剔掉**（2026-10-18 实测）：fs.write 每次返回的
      // written_at 都不一样，于是"结果一字不差"永远不成立，sameResultCount 停在 1，
      // 护栏永远不介入 —— 实测同参数 fs.write 调 4 次仍未触发。
      // 这些字段只是"什么时候做的"，不改变"做成了什么"。
      const text = normalizeResultForRepeat(value);
      const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      if (trimmed === rec.last) {
        rec.sameResultCount = (rec.sameResultCount ?? 1) + 1;
      } else {
        rec.sameResultCount = 1;
      }
      rec.last = trimmed;
    } catch {
      rec.last = '';
      rec.sameResultCount = 0;
    }
  }

  /**
   * 任务真正终态时清空该任务的护栏状态（避免内存与跨任务误伤）。
   *
   * **toolCallCounts 也要清**（2026-10-19 审计发现）：它按 taskId 累积
   * （`Map<taskId, Map<toolName, count>>`），但此前只有 set 没有 delete ——
   * 每个任务留一条永不释放，daemon 长期运行内存会一路涨。
   * 同一处还有 repeatGuard / repeatSkipsByTask，三者生命周期一致，一起清。
   */
  private resetRepeatGuard(taskId: string): void {
    this.repeatGuard.delete(taskId);
    this.repeatSkipsByTask.delete(taskId);
    this.toolCallCounts.delete(taskId);
    this.rewritesByPath.delete(taskId);
    browserIdentityByTask.delete(taskId); // A1：浏览器身份表同样随任务终态释放
  }


  // ── 3.4 ⑦ 工具步 ──────────────────────────────────────────────────────

  private async stepTool(
    task: Task,
    epoch: number,
    ctx: RunContext,
    call: { id: string; name: string; arguments: string },
    journalIds?: Array<{ id: string; name: string; arguments: string }>,
  ): Promise<
    | { kind: 'ok' }
    | { kind: 'continue' }
    | { kind: 'suspend'; out: TaskRunOutcome }
    | { kind: 'pause'; out: TaskRunOutcome }
    | { kind: 'abort'; out: TaskRunOutcome }
    | { kind: 'fail'; out: TaskRunOutcome }
  > {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.arguments) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = { __raw: call.arguments };
    }

    // ═══ 动态工具执行路由（S2(b)，2026-10-19）══════════════════════════════
    //
    // 自造工具被动态注册成独立 tool 后，模型会**直接**发 call.name = 'word-count'。
    // 但那名字不在契约词表、也不在治理白名单里，直接派发必然被两边拒绝：
    //   src/exec/protocol.ts validateToolCall → findCapability() → unknown_tool
    //   src/governance/gate.ts  lookupTool()  → undefined     → deny('工具未登记')
    //
    // 所以在这里翻译成真正的执行入口 tool.invoke（agent-runtime/server.ts 的
    // 'tool.invoke' 分支 → toolStore.invoke(name, args)）。翻译后：
    //   · 治理只认 tool.invoke → dangerous 档审批约束原样生效，不新增绕过路径；
    //   · journal 记的也是 tool.invoke → 审批恢复（resumePendingStep）能按
    //     final_params_json 正确重放，不会去执行一个不存在的工具名。
    const isDynamicTool = this.dynamicToolNames.has(call.name);
    // 兜底（2026-10-19 实测）：模型的旧习惯是把参数包成 {name:'<它自己>', args:{...}}
    // ——因为早先清单教它用 tool.invoke(name,args)。现在它是一等工具，那层包裹是多余的，
    // 直接原样透传会让工具收到两个它不认识的参数。判定要严格，避免误伤真有 name/args 参数的工具：
    // 只认"键恰好是 name+args、name 等于该工具名、args 是普通对象"这一种形状。
    const dynamicArgs: Record<string, unknown> = (() => {
      if (!isDynamicTool) return args;
      const keys = Object.keys(args).sort();
      const wrapped =
        keys.length === 2 &&
        keys[0] === 'args' &&
        keys[1] === 'name' &&
        args['name'] === call.name &&
        args['args'] !== null &&
        typeof args['args'] === 'object' &&
        !Array.isArray(args['args']);
      if (wrapped) {
        this.log(`runner: 动态工具 ${call.name} 收到多余包裹 {name,args}，已自动拆开`);
        return args['args'] as Record<string, unknown>;
      }
      return args;
    })();
    const execTool = isDynamicTool ? 'tool.invoke' : call.name;
    const execArgs: Record<string, unknown> = isDynamicTool
      ? { name: call.name, args: dynamicArgs }
      : args;

    // S1：sideEffect 词表唯一事实源 = exec.getCapabilities；未声明按 unknown
    // 注意用 execTool：真正执行的是 tool.invoke，审计/派发口径必须与之一致。
    const se = this.sideEffectOf.get(execTool) ?? 'unknown';
    const { seq, callId } = this.cp.journal.beginTool(task.id, epoch, execTool, execArgs, se);
    // 用 **journal callId** 登记声明（与 tool 结果里的 call_id 同源），不是模型给的 id。
    // **必须在这里落声明**：thread 里的顺序必须是
    //   assistant/tool_call（声明） → system/tool_result（结果）
    // 协议要求 role:tool 紧跟在一个带 tool_calls 的 assistant 之后；反过来就是"无主"。
    // 2026-10-18 实测：声明曾落在工具执行之后，导致 13/13 条 role:tool 全部无主，
    // 模型完全无视自己上一轮的结果，写-读死循环烧到 118 步。
    await this.reportToolCalls(
      task,
      [{ id: callId, name: call.name, arguments: call.arguments }],
      ctx.currentTurnText,
    );
    journalIds?.push({ id: callId, name: call.name, arguments: call.arguments });

    // ═══ TOOL-REUSE-GUARD（S2(b)，2026-10-19）═══════════════════════════════
    //
    // 为什么是代码而不是提示词：提示词已试满 3 次全失败（见 docs/prompt-attempts.md）——
    //   ① 注入工具清单 / ② 改指令式措辞 / ③ 写进 shell.run 说明书
    // 模型照样用 shell.run 手写脚本。观察到的模式是"它压根没把已有工具纳入候选"。
    //
    // 这条守卫做一件很窄的事：**当模型想用 shell.run，而 task 的上下文里已经注入了
    // 自造工具清单时，先拦一次**，回喂一句"你有现成工具，先看看"。
    // 模型下一次仍坚持 shell.run 的话**放行** —— 守卫只提醒一次，不做硬拦截：
    // 强拦会让"确实该用 shell 的活"卡死，那比不复用更糟。
    if (call.name === 'shell.run' && ctx.toolInventoryNote !== null && !ctx.toolReuseHinted) {
      ctx.toolReuseHinted = true;
      this.cp.journal.skipStep(callId, 'tool_reuse_hint');
      ctx.feed({
        ok: false,
        callId,
        toolName: call.name,
        dispatched: false,
        value: {
          code: 'tool_reuse_available',
          message:
            '先等一下：你已经造过能干这类活的工具，别用 shell 重写一遍。' +
            '按上下文里的「你已有的自造工具」清单，用 tool.invoke 调它；' +
            '如果确实没有对口的，再重新发一次同样的 shell.run（这次不会被拦）。',
          available: ctx.toolInventoryNote,
        },
      });
      return { kind: 'continue' };
    }

    // 接缝 G5：goalDigest 由 Runner 在 evaluate 前截取（≤800B）注入治理审查档
    const verdict = await this.governance.evaluate(
      { dotId: task.dotId, taskRef: { taskId: task.id, journalStepId: callId }, emergency: this.router.emergencyActive },
      {
        callId,
        tool: execTool,
        params: execArgs,
        identity: resolveBrowserIdentity(execTool, execArgs, browserIdentityByTask.get(task.id)),
      },
      { goalDigest: goalDigestOf(ctx.goal) },
    );

    if (verdict.kind === 'deny') {
      // 接缝 ⑦ deny 支线：步标 skipped + 结果回喂（任务改道，不直接失败）。
      // 没有实际派发 → dispatched:false，走系统注记（否则会造出一条无主 tool_result）。
      this.cp.journal.skipStep(callId, `deny:${verdict.reason}`);
      ctx.feed({
        ok: false,
        callId,
        toolName: call.name,
        dispatched: false,
        value: { denied: true, tool: call.name, reason: verdict.reason },
      });
      return { kind: 'continue' };
    }

    if (verdict.kind === 'approve' || verdict.kind === 'review_approve') {
      // 接缝 ⑦ approve 支线：markPending + setAwaitingApproval → Runner 让位
      this.cp.journal.markPending(task.id, epoch, seq, verdict.approvalId);
      this.cp.setAwaitingApproval(task.id, epoch, verdict.approvalId);
      return {
        kind: 'suspend',
        out: {
          taskId: task.id,
          epoch,
          status: 'suspended',
          summary: `等待审批 #${verdict.approvalId}（${call.name}）`,
        },
      };
    }

    // 接缝 M6：fs.write 前置 beforeWrite 检查点——软限 warning 附回工具响应，
    // 硬限（HARD_LIMIT 等）不派发、直接把 error 回喂让模型改道。
    if (call.name === 'fs.write') {
      const path = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const chk = await this.memory.beforeWrite(task.dotId, path, content);
      if (!chk.ok) {
        this.cp.journal.endTool(
          task.id,
          epoch,
          seq,
          'failed',
          { memory_rejected: chk.error ?? 'HARD_LIMIT', warning: chk.warning ?? null },
        );
        ctx.feed({
          ok: false,
          callId,
          toolName: call.name,
          dispatched: false,
          value: { memory_rejected: chk.error ?? 'HARD_LIMIT', warning: chk.warning ?? null },
        });
        return { kind: 'continue' };
      }
      if (chk.warning !== undefined) this.memoryWarnings.set(callId, chk.warning);
    }

    // allow / review_pass：执行（S1 ledger 幂等 = 同 call_id 至多一次）
    // **模型传的 timeout_ms 必须真正生效**（2026-10-18 实测）：
    // 原来 sync 工具在 Runner 侧固定 60s，模型传 timeout_ms=600000 也只等 60s ——
    // 工具说"可以等 10 分钟"、Runner 说"我只等 1 分钟"，同一概念两处不一致，
    // 模型据此做的判断（比如"这命令慢，我把超时设长点"）全部落空。
    // 取二者较小值：模型要求的更短就听模型的；更长则被 Runner 的档位上限截断（安全兜底不变）。
    // **自动补 expected_size**（2026-10-18）：模型不会主动传 CAS 参数（提示词写两轮都没用），
    // 所以由 Runner 在本任务读到过该文件时自动补上——把并发保护变成"默认行为"而不是"模型自觉"。
    // 只在本任务 fs.read 过它、且模型自己没传时才补；新建文件（没读过）不补。
    const argsForExec = this.withAutoExpectedSize(execTool, execArgs);
    const res = await this.exec.runTool(
      toolCall(task, callId, execTool, argsForExec, this.effectiveDeadlineMs(execTool, argsForExec)),
    );
    const ok = res.status === 'ok';
    const warning = this.memoryWarnings.get(callId);
    const result = warning === undefined
      ? (ok ? res.result : res.error)
      : { ...(ok ? (res.result ?? {}) : (res.error ?? {})), warning };
    this.cp.journal.endTool(task.id, epoch, seq, ok ? 'succeeded' : 'failed', result ?? null);
    // 成败都以 JSON 回喂（失败 = 容器端的 {code,message,retryable}）：模型要靠 code 决定改参还是重试。
    ctx.feed({ ok, callId, toolName: call.name, value: result, calledWith: withHomeRootArgs(call.name, args) });
    // 回填护栏记录：下一次同参数调用时，注记能引用**真实的上一次结果**。
    this.recordRepeatResult(task.id, call, ok ? result : { failed: true, error: result });
    // fs.read 成功 → 记下大小，供后续 fs.write 自动补 expected_size（CAS）。
    if (ok && call.name === 'fs.read') this.noteReadSize(args, result);
    this.memoryWarnings.delete(callId);
    // ⑩ 结果回报：tool 消息只 digest+200 预览入 thread（S6 双写禁令；全文在 steps）
    await this.reportTool(ctx, task, callId, call.name, ok, result);
    return { kind: 'ok' };
  }

  // ── 3.5 ⑨ 审批续跑 ────────────────────────────────────────────────────

  /**
   * 审批放行后任务回 queued（resume_from_seq=该步）→ pop 拿新 epoch →
   * 把 pending 步转 started（**复用原 call_id**，契约 J1-2）→ claim() 固化
   * final_params_json → 执行。deny/expired 的步已被 CP 标 skipped，此处跳过。
   */
  private async resumePendingStep(
    task: Task,
    epoch: number,
    seq: number,
    ctx: RunContext,
  ): Promise<'executed' | 'skipped' | 'rejected'> {
    const target = this.stepAt(task.id, seq);
    if (target === null) return 'skipped';
    if (target.status === 'skipped') return 'skipped'; // deny/expired 已由 CP 收口
    if (target.status !== 'pending') return 'skipped';

    // pending→started（同 callId，带新 epoch；0 行 = 迟到 Runner）
    const { callId } = this.cp.journal.resumeStep(
      task.id,
      epoch,
      seq,
      this.finalParamsJsonOf(task.id, seq),
    );
    if (callId === '') return 'rejected';

    // 接缝 ⑨「恢复执行一律 claim() 后按 final_params_json+note」：
    // claim() 把 final_params_json 固化并回传；执行只认回传值（S2：不复用内存旧参）。
    let args = this.finalParamsOf(task.id, seq) ?? {};
    if (target.approvalId !== null) {
      const claimRes = await this.governance.claim(target.approvalId);
      if (!claimRes.ok) {
        // revoke 抢先 / 已 executing / 终态：不执行，标 skipped 让任务改道
        this.cp.journal.skipStep(callId, `claim:${claimRes.reason ?? claimRes.status ?? 'failed'}`);
        return 'skipped';
      }
      if (claimRes.finalParams !== undefined) args = claimRes.finalParams;
    }

    const toolName = target.toolName ?? '';
    const res = await this.exec.runTool(toolCall(task, callId, toolName, args, this.toolDeadlineMsFor(toolName)));
    const ok = res.status === 'ok';
    const result = ok ? res.result : res.error;
    this.cp.journal.endTool(task.id, epoch, seq, ok ? 'succeeded' : 'failed', result ?? null);
    // 续跑执行的结果同样要回喂给模型：否则下一轮 LLM 只看到"主人批了"，看不到批的动作到底
    // 出了什么结果（approve_once 之后模型往往还要基于这个结果收尾）。
    ctx.noteToolCalls([{ id: callId, name: toolName, arguments: JSON.stringify(args) }]);
    ctx.feed({ ok, callId, toolName, value: result });
    // ⑩ 结果回报：审批续跑执行的那一步同样要入 thread（否则续跑步骤在会话里缺席）
    await this.reportTool(ctx, task, callId, toolName, ok, result);
    return 'executed';
  }

  // ── 3.5b ⑩ 结果回报（接缝契约 §8 ⑩）────────────────────────────────

  /**
   * ⑩「结果回报：assistant 全文 appendMessage 入 thread（tool 消息只 digest+预览，S6 双写禁令）」。
   * - tool 消息：`kind='tool_result'`，正文 = digest+200 字预览 + 内嵌 call_id
   *   （供 §7.3 重建时按 call_id 回 steps 取全文覆盖）。
   * - assistant 全文：每轮 LLM 无 tool_calls 时由 `reportAssistant` 落（见 stepLlm 之后）。
   * thread 缺失（未绑会话）时静默跳过——bindSession 失败不应炸主循环。
   */
  private async reportTool(
    ctx: RunContext,
    task: Task,
    callId: string,
    toolName: string,
    ok: boolean,
    value: unknown,
  ): Promise<void> {
    const threadId = this.threadIdOf(task);
    if (threadId === null) return;
    try {
      await this.memory.appendMessage(threadId, {
        role: 'system',
        kind: 'tool_result',
        content: digestPreview(JSON.stringify({ call_id: callId, tool: toolName, ok, value })),
        taskId: task.id,
      });
    } catch (err) {
      // 记忆问题不炸主循环（memory.md §8 软线语义）
      this.log(`runner: reportTool 失败 ${task.id}/${callId}：${errText(err)}`);
    }
  }

  /** assistant 全文入 thread（接缝 ⑩ 前半句）。 */
  private async reportAssistant(ctx: RunContext, task: Task, content: string): Promise<void> {
    if (content.length === 0) return;
    const threadId = this.threadIdOf(task);
    if (threadId === null) return;
    try {
      await this.memory.appendMessage(threadId, {
        role: 'assistant',
        kind: 'text',
        content,
        taskId: task.id,
      });
    } catch (err) {
      this.log(`runner: reportAssistant 失败 ${task.id}：${errText(err)}`);
    }
  }

  /**
   * 把本轮的**工具调用声明**落进 thread（kind='tool_call'，role='assistant'）。
   *
   * 为什么必须落：OpenAI 兼容协议要求每条 `role:'tool'` 消息都紧跟在一个带
   * `tool_calls` 的 assistant 消息之后。重建上下文时 Runner 靠 thread 里的这条声明
   * 复原配对关系；缺了它，工具结果会退化成孤立注记，模型「失忆」并无限重试同一动作。
   *
   * 内容形状与 toChatMessage 的解析约定一致：`{ calls: [{ call_id, name, arguments }] }`，
   * arguments 用**模型原样给的字符串**（不要 JSON.stringify 二次编码）。
   */
  private async reportToolCalls(
    task: Task,
    calls: ReadonlyArray<{ id: string; name: string; arguments: string }>,
    /** 本轮的 assistant 正文（模型的思路）。与调用声明一起落，重建时才能还原成一条消息。 */
    text = '',
  ): Promise<void> {
    const threadId = this.threadIdOf(task);
    if (threadId === null) return;
    try {
      await this.memory.appendMessage(threadId, {
        role: 'assistant',
        kind: 'tool_call',
        // 形状：{ calls: [...], text?: '...' }。
        // **text 必须存在这里**（2026-10-18 二次修正）：早先正文和声明是两条独立消息，
        // 重建时变成两条 assistant —— 模型看到"我先解释一下"和"调用"断成两截，
        // 容易丢失自己的推理结论（实测：反复退回已被否定的写法）。
        // 也不能把声明 JSON 当正文塞回去（那更糟：模型看到一段自己没写过的 JSON）。
        content: JSON.stringify({
          calls: calls.map((c) => ({ call_id: c.id, name: c.name, arguments: c.arguments })),
          ...(text.length > 0 ? { text } : {}),
        }),
        taskId: task.id,
      });
    } catch (err) {
      this.log(`runner: reportToolCalls 失败 ${task.id}：${errText(err)}`);
    }
  }

  /**
   * 从任务目标里解析 home 内的图片路径并读成 data URL（2026-10-18 多模态）。
   *
   * 为什么需要：飞书图片被下载到 home 后，目标里写的是**路径**。若只给文本，
   * 模型只能自己写脚本解析像素——纯色图能凑合，真实截图根本没法看。
   * 而模型本身是有视觉能力的（实测 glm/Qwen/deepseek 都能认色），缺的只是"把图发给它"。
   *
   * 读法：用 shell.run 执行 base64（fs.read 只取文本，二进制会被破坏）。
   * 失败静默返回空数组——图片读不到不该让任务起不来，模型仍可用其他手段。
   */
  private async loadGoalImages(task: Task): Promise<Array<{ url: string; mimeType?: string }>> {
    // 只在目标里出现 media/ 路径时才尝试（避免每个任务都跑一次 shell）
    const m = /media\/[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp)/i.exec(task.goal);
    if (m === null) return [];
    const rel = m[0];
    try {
      const r = await this.exec.runTool({
        call_id: `img-load-${Date.now()}`,
        task_id: task.id,
        dot_id: task.dotId,
        issued_at: new Date().toISOString(),
        tool: 'shell.run',
        args: { cmd: `base64 -w0 '${rel}'`, timeout_ms: 15000 },
        deadline_ms: 20_000,
      });
      if (r.status !== 'ok') return [];
      const stdout = (r.result as { stdout?: unknown } | null)?.stdout;
      if (typeof stdout !== 'string' || stdout.length === 0) return [];
      const ext = rel.split('.').pop()?.toLowerCase() ?? 'png';
      const mime =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : 'image/png';
      this.log(`runner: 已加载任务图片 ${rel}（${stdout.length} 字节 base64）→ 随请求下发给模型`);
      return [{ url: `data:${mime};base64,${stdout.trim()}`, mimeType: mime }];
    } catch (err) {
      this.log(`runner: 读取任务图片失败 ${rel}：${errText(err)}`);
      return [];
    }
  }

  /** 当前任务的 threadId（ctx 持有 runTask 绑定的那份；未绑则 null）。 */
  private threadIdOf(task: Task): string | null {
    return task.threadId ?? task.sessionId ?? null;
  }

  // ── 3.6 每步后的心跳 / 预算 / 让位判定 ─────────────────────────────────

  /** CP §12 `const hb = queue.heartbeat(...)` 三连判。返回非 null = 立即让位。 */
  private afterStep(task: Task, epoch: number, ctx: RunContext): TaskRunOutcome | null {
    const hb = this.cp.heartbeat(task.id, epoch, { tokens: ctx.totalTokens });
    if (hb.aborted) {
      return { taskId: task.id, epoch, status: 'aborted', summary: 'stale_writer/abort' };
    }
    if (hb.overBudget) {
      // CP §6.4：主动 finish(ok:true, summary:'budget')
      this.cp.finish(task.id, epoch, { ok: true, summary: 'budget' });
      void this.seal(task, 'done', 'budget');
      return { taskId: task.id, epoch, status: 'budget', summary: 'budget' };
    }
    return null;
  }

  // ── 3.7 ⑪ WRITE-SEAL + finish ─────────────────────────────────────────

  /**
   * 契约可选字段 `failTask`（CP §5.4 硬上限专用）：装配层实现转发 Queue.markFailed；
   * 老实现缺该方法时退化为 `finish(ok:false)`（attempt<max 会重试，语义弱一档）。
   */
  private failTask(task: Task, epoch: number, reason: string): void {
    if (this.cp.failTask !== undefined) {
      this.cp.failTask(task.id, epoch, reason);
      return;
    }
    this.cp.finish(task.id, epoch, { ok: false, summary: reason });
  }

  private async finishTask(
    task: Task,
    epoch: number,
    r: { ok: boolean; summary: string },
  ): Promise<TaskRunOutcome> {
    // ── P1-4：WRITE-SEAL 的"补写一轮"必须发生在 finish **之前** ──────────
    //
    // 老的"假提醒"：sealTask 由 CP 钩子在 queue.finish() **内部**调用，那一刻任务
    // 已是终态、主循环已退出，它追加的提醒消息永远没有下一轮 LLM 去读。
    // 所以这里在 finish 前先把"该不该补写"问清楚（needsMemoryRedo 只做判定、不写库），
    // 该补就真跑一轮（memoryWriteRedo），然后才 finish —— 这样补写轮里的
    // fs.write 落在**任务仍 running** 的时间窗内，journal/心跳/围栏全部照常成立。
    if (r.ok) {
      await this.memoryWriteRedo(task, epoch);
    }
    // P1-2：会话摘要也在收口前触发（同样因为 finish 之后主循环已退出）。
    // 与补写轮的顺序：先补写（可能产生新的 notes），再摘要（把本轮的对话压进去）。
    await this.refreshSummary(task);
    this.cp.finish(task.id, epoch, r);
    await this.seal(task, r.ok ? 'done' : 'failed', r.ok ? undefined : r.summary);
    return {
      taskId: task.id,
      epoch,
      status: r.ok ? 'done' : 'failed',
      summary: r.summary,
    };
  }

  /**
   * P1-2 §4.4：会话摘要触发（收口前）。
   *
   * 为什么放在这里而不是"每步之后"：摘要是**会话级**的压缩动作，一次任务结束时做一次
   * 最划算（消息已成批、且不影响本轮的上下文）。放在 finish 之前同样是因为
   * finish 之后主循环已退出——虽然摘要本身不需要再跑主循环，但"任务仍在 running"
   * 时做的记忆写更容易与 STALE/恢复路径对账。
   *
   * Runner 只做两件事：判 threadId、调注入的 `refreshContextSummary`。
   * 摘要**怎么生成**（低智能轨 / 提示词 / JSON）全在 MEM 与装配层，Runner 不碰 router。
   * 任何异常都吞掉（§8 记忆软线），且不带 outcome 条件——failed 的任务对话同样值得摘要。
   */
  private async refreshSummary(task: Task): Promise<void> {
    const fn = this.memory.refreshContextSummary?.bind(this.memory);
    if (fn === undefined) return;
    const threadId = this.threadIdOf(task);
    if (threadId === null) return;
    try {
      const updated = await fn(threadId);
      if (updated) this.log(`runner: 已更新会话摘要 ${task.id}/${threadId}`);
    } catch (err) {
      this.log(`runner: refreshContextSummary 失败 ${task.id}：${errText(err)}`);
    }
  }

  /**
   * §4.3「补写一轮」的**真实执行**（P1-4，2026-10-18）。
   *
   * 为什么是一条独立路径，而不是复用 stepLlm：补写轮要的是"**只能写记忆**"这个约束，
   * 而 stepLlm 是主循环的通用回合（带全部工具、会推进 ctx.done、会走流式与 chat.* 总线）。
   * 两者语义不同，硬塞进 stepLlm 只会把主循环的完成判据搞脏（流式回合甚至需要 toolCalls
   * 才能算"有内容"）。这里复用同一套**原语**（journal.beginLlm/endLlm、router.complete、
   * stepTool 派发）但把它们串成一条受控的、只有一次机会的回合：
   *   1. beginLlm 记账（attemptId = 本步 callId，与主循环同口径）；
   *   2. complete(不带 tools 的请求) → 模型要么调 fs.write/shell.run，要么回 SKIP；
   *   3. 若它调了工具，走 stepTool（治理/幂等/journal 全照常，不绕过任何门）；
   *   4. 一轮即止：**绝不**循环追问（追问会把"补写"变成"再来一轮猜"）。
   *
   * 零打扰条件（任一成立就跳过，不花任何模型调用）：
   *   - `memoryRedoEnabled=false`（开关）；
   *   - 本任务不是 done、或已经提醒过（injectOnce 跨 attempt 幂等）；
   *   - 本次任务已经写过记忆文件（needsMemoryRedo 的判据与 sealTask 同源）。
   *
   * 任何异常都吞掉并记日志：记忆问题不炸主循环（memory.md §8 软线），
   * 补写失败绝不能把一个本来成功的任务拖成失败。
   */
  private async memoryWriteRedo(task: Task, epoch: number): Promise<void> {
    if (!this.memoryRedoEnabled) return;
    // 任务可能已被看门狗/背压改道：不再替它跑任何回合（epoch 围栏由 CP 兜底，这里先省掉调用）
    if (this.cp.getTask(task.id)?.status !== 'running') return;

    let need = false;
    try {
      // 能力探测：旧装配/测试替身没有 needsMemoryRedo 时，行为逐字回到"不补写"
      const probe = this.memory.needsMemoryRedo?.bind(this.memory);
      if (probe === undefined) return;
      need = await probe(task, 'done');
    } catch (err) {
      this.log(`runner: needsMemoryRedo 失败 ${task.id}：${errText(err)}`);
      return;
    }
    if (!need) return;

    // injectOnce：先记账再问——即使这一轮模型崩溃/超时，也不会在下一 attempt 里重复提醒
    try {
      this.memory.markMemoryReminder?.(task.id);
    } catch {
      // 记账失败不拦主路径
    }

    let seq = -1;
    let callId = '';
    try {
      const begin = this.cp.journal.beginLlm(task.id, epoch, digestOf(MEMORY_REDO_PROMPT));
      seq = begin.seq;
      callId = begin.callId;
      // 请求体刻意**不带 tools**：这一步只允许"写记忆或 SKIP"，不给它别的动作面。
      // 有的模型会无视约束照样发 tool_calls（尤其 tool_choice:'none' 不被支持时），
      // 那种情况在下面按"不认识的名字 → deny 回喂"处理，不派发。
      const req: RouteRequest = {
        track: 'primary',
        messages: [
          { role: 'system', content: MEMORY_REDO_PROMPT },
          {
            role: 'user',
            content:
              `任务「${task.title}」已完成：${task.goal}\n` +
              '如果本次产生了可复用的经验，请用 fs.write 写进 notes/ 或 manuals/；' +
              '没有值得沉淀的内容就只回复 SKIP。',
          },
        ],
        attemptId: callId,
        maxTokens: 1024,
        // 不组网、不流式：这是收口路径上的附加回合，必须最短最可控
        tool_choice: 'none',
      };
      const resp = await this.router.complete(req);
      const chat = resp.response as { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
      const content = typeof chat.content === 'string' ? chat.content : '';
      const tokens = (resp.usage?.promptTokens ?? 0) + (resp.usage?.completionTokens ?? 0);

      const calls = (chat.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
      }));
      const skipped = calls.length === 0 && /^\s*SKIP\s*$/i.test(content);

      if (skipped) {
        // SKIP = 模型明确说"没有可沉淀的"：记一次 missed（不重复提醒已由 injectOnce 保证）
        this.cp.journal.endLlm(task.id, epoch, seq, 'memory_redo:skip');
        this.log(`runner: 补写轮 SKIP ${task.id}`);
      } else if (calls.length > 0) {
        this.cp.journal.endLlm(task.id, epoch, seq, digestOf(content));
        // 补写轮的工具调用同样要过治理与幂等：用与主循环**同一个** stepTool 入口。
        // 主循环已结束、没有会话上下文可喂，因此给一个一次性 scratch ctx：
        // 结果照常落 journal + thread（reportTool），只是不进主循环的 messages。
        const scratch = new RunContext(task.goal);
        for (const call of calls) {
          const out = await this.stepTool(task, epoch, scratch, call);
          if (out.kind === 'suspend' || out.kind === 'abort' || out.kind === 'fail') {
            this.log(`runner: 补写轮工具受阻（${call.name}，${out.kind}），按收口继续`);
            break;
          }
        }
        this.log(`runner: 补写轮执行了 ${calls.length} 个工具调用 ${task.id}`);
      } else {
        // 有正文但不是 SKIP：模型可能真写了（工具调用被网关吞掉）或只是解释。
        // 判定"写没写"交给收口判定（journal 探针），不在这里猜。
        this.cp.journal.endLlm(task.id, epoch, seq, digestOf(content));
        this.log(`runner: 补写轮无工具调用（正文 ${content.length} 字）${task.id}`);
      }
      // 用量记账：补写轮的 token 也算任务成本（否则预算会被悄悄透支）
      if (tokens > 0) this.cp.heartbeat(task.id, epoch, { tokens });
    } catch (err) {
      // 软降级：补写轮失败不影响任务终态。LLM 步按 error 收口留痕即可。
      this.log(`runner: 补写轮失败 ${task.id}：${errText(err)}`);
      if (seq >= 0) {
        try {
          this.cp.journal.endLlm(task.id, epoch, seq, `error:${errText(err)}`);
        } catch {
          // 迟到写被围栏拒绝是正常竞态
        }
      }
    }
  }

  /**
   * WRITE-SEAL（契约 M3 / memory.md §4.3）：三种终态全走，且**同一任务只封一次**。
   * 默认（sealOnFinish=false）由 Queue.finish 内部的 sealTask 钩子承担，Runner 只在
   * 该钩子缺失（装配层未注入）或异常路径（paused/aborted 未走 finish）时兜底。
   *
   * 去重键**封写成功后才登记**（审码 finding ⑦）：先记键会让一次空跑（开关关闭）
   * 把键占住，导致开关后注入的同一 (task,outcome,reason) 真封被静默吞掉——
   * 与「同任务只封一次」的注释语义相反。
   */
  private async seal(task: Task, outcome: 'done' | 'failed' | 'cancelled', reason?: string): Promise<void> {
    const key = `${task.id}:${outcome}:${reason ?? ''}`;
    if (this.sealed.has(key)) return;
    if (!this.sealOnFinish) return;
    try {
      await this.memory.sealTask(task, outcome, reason);
      this.sealed.add(key);
    } catch (err) {
      // 记忆问题不炸主循环（memory.md §8 软线语义）；失败不登记，允许后续收口重试
      this.log(`runner: sealTask 失败 ${task.id}：${errText(err)}`);
    }
  }

  /** 未预期异常：记 failed 收口（attempt<max 时 CP 会自行回 queued 重试）。 */
  private async onFatal(task: Task, err: unknown): Promise<TaskRunOutcome> {
    const msg = errText(err);
    this.log(`runner: 任务 ${task.id} 主循环异常：${msg}`);
    let finished = false;
    try {
      this.cp.finish(task.id, task.runEpoch, { ok: false, summary: `runner:${msg}` });
      finished = true;
    } catch (finishErr) {
      // 围栏拒绝（epoch 已变 / 任务已被取消）是正常竞态，交给看门狗或下一任 Runner。
      this.log(`runner: finish 收口失败（${errText(finishErr)}），改走 failTask`);
    }
    if (!finished) {
      // 审码 finding C：收口失败若只记日志，任务会**停在 running 白占 maxRunning=1**
      // 直到看门狗 180s 回收。补一次 failTask（CP §5.4 通道，不经 attempt 重试）。
      try {
        this.failTask(task, task.runEpoch, `runner:${msg}`);
      } catch (failErr) {
        this.log(`runner: failTask 也失败（${errText(failErr)}），交看门狗回收 ${task.id}`);
      }
    }
    await this.seal(task, 'failed', msg);
    return { taskId: task.id, epoch: task.runEpoch, status: 'failed', summary: msg };
  }

  // ── 3.8 内部小工具 ─────────────────────────────────────────────────────

  private stepAt(taskId: string, seq: number): Step | null {
    const rows = this.cp.journal.tail(taskId, 5000);
    return rows.find((s) => s.seq === seq) ?? null;
  }

  /** 该 (taskId, seq) 步的 args_json（治理 final_params_json 落库前的旧值兜底）。 */
  private finalParamsJsonOf(taskId: string, seq: number): string | undefined {
    return this.stepAt(taskId, seq)?.argsJson ?? undefined;
  }

  /** 同上，解析成对象；不可解析时返回 null（退化为空参数）。 */
  private finalParamsOf(taskId: string, seq: number): Record<string, unknown> | null {
    const json = this.finalParamsJsonOf(taskId, seq);
    if (json === undefined) return null;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 忽略：退化为空参数
    }
    return null;
  }
}

// ── 4. 自由函数 ──────────────────────────────────────────────────────────

/**
 * 常驻循环单轮异常后的退避上限（审码 finding B）。
 * 60s 与 CP 的心跳超时同量级：退避到顶时仍远小于"运维会误判为卡死"的时长，
 * 又足以让 SQLITE_BUSY 这类瞬时故障自愈而不打爆日志。
 */
const START_MAX_BACKOFF_MS = 60_000;

// ── P1-4：WRITE-SEAL 补写一轮的系统提示 ─────────────────────────────────────

/**
 * 补写轮的 system 文案（导出供测试断言"这一轮的 prompt 确实带提醒"）。
 *
 * 两条硬约束写死在提示里：① 只允许写记忆文件（notes/ 或 manuals/）；② 没有可沉淀的
 * 内容就**只回 SKIP**（Runner 靠这个字面量判定"模型拒绝补写"，并据此记 missed 而不是
 * 再猜它写了没写——猜会退化成又一种"假提醒"）。
 */
export const MEMORY_REDO_PROMPT = [
  '任务已经结束。现在做最后一件收尾动作：判断本次工作有没有值得长期保留的经验。',
  '如果有：用 fs.write 把它写进 notes/（过程与结论）或 manuals/（可复用的操作手册），',
  '写法要能让以后的自己直接照着做；没有值得沉淀的内容时，只回复一个词：SKIP。',
  '不要重复任务已经完成的内容，也不要执行任何与写记忆无关的动作。',
].join('\n');

// ── 流式增量上总线（roadmap P0-2）────────────────────────────────────────────

/**
 * delta 合帧窗口：50ms / 32 字符取先到者（roadmap P0-2 第 2 条的节流口径）。
 * 逐 token 推送会让 `SSE_DELTA_QUEUE_LIMIT`（每订阅者 200 条，surfaces/sse.ts:204-207）
 * 在长回答里溢出丢帧；合帧后一次回答只占几十帧。
 */
const STREAM_FLUSH_MS = 50;
const STREAM_FLUSH_CHARS = 32;

/** `DOTD_STREAM_CHAT`：`off`/`0`/`false`/`no`/`disable*` 关；缺省与其它值都算开（roadmap P0-2）。 */
function streamChatFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOTD_STREAM_CHAT;
  if (raw === undefined) return true;
  return !/^(off|0|false|no|disable[d]?)$/i.test(raw.trim());
}

/**
 * 既有字符近似（`RunContext` 的 `tokenEst` 同口径）：MR 的流式面不透出 transport usage，
 * 用它给流式回合记一次与离线聚合可比的 completion 用量，而不是记 0
 * （记 0 会让 `overBudget` 永不触发，预算形同虚设）。
 */
function approxTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/**
 * `chat.delta` 合帧器。
 *
 * 第一个 delta **立即**下发（首字延迟 ≤ 一次流读取），之后攒到窗口/字数再发：
 * - `flushMs` 由第一段未发送文本到达时起算（不无脑 setInterval）；
 * - `flush()` 幂等，回合结束与断流路径都会调，保证最后一段不丢。
 *
 * 前端按 `taskId` 累加 `delta`、被 `chat.final` 覆盖（web-ui ChatView:74-94），
 * 所以这里只需保证**顺序**与**不丢**，不承担全文正确性（那是 chat.final 的活）。
 */
class ChatDeltaSink {
  private buf = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = false;
  private closed = false;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly flushMs: number,
    private readonly flushChars: number,
  ) {}

  push(delta: string): void {
    if (this.closed) return;
    this.buf += delta;
    if (!this.sent || this.buf.length >= this.flushChars) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
      // 展示面定时器不得吊住进程（与 idleWait 的 unref 同策）
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buf.length === 0) return;
    const text = this.buf;
    this.buf = '';
    this.sent = true;
    this.emit(text);
  }

  /** 收口（断流/正常结束）：清定时器并发出残留增量。 */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }
}

/** 容器 home 根（EX §7 护栏；与 exec/protocol.ts:393 同值，跨模块不 import 实现）。 */
const CONTAINER_HOME_ROOT = '/dot/home';

/** 带 home 路径参数的 fs 工具（EX §5.2 能力目录：均声明 path 为绝对路径）。 */
const FS_PATH_TOOLS = new Set(['fs.read', 'fs.write', 'fs.list', 'fs.stat']);

/**
 * HomeRelPath → 容器绝对路径（memory.md:237 逐字：「容器绝对路径 = '/dot/home/' +
 * HomeRelPath，由 exec 工具层拼接，本模块接口不出现绝对路径」）。
 *
 * 只在**确为相对路径**时补前缀（不以 `/` 开头、非盘符、非空）；其余形态（绝对路径、
 * 空串、非字符串）原样返回，交给 fleet 侧护栏裁决——此处不重复校验，避免两套规则漂移。
 * 非 fs 工具或 args 不可变时原样返回，零拷贝。
 */
function withHomeRootArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!FS_PATH_TOOLS.has(tool)) return args;
  const raw = args.path;
  if (typeof raw !== 'string' || raw.length === 0) return args;
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) return args;
  return { ...args, path: `${CONTAINER_HOME_ROOT}/${raw}` };
}

/**
 * 一次工具派发的 `deadline_ms` 选档（P0-3，与 `resolveToolDeadlineMs` 同一套口径的 Runner 侧投影）。
 *
 * - `cap` 缺省（目录里没有这个工具）：保守按 sync 档，用 `syncTierMs`（不放大未知工具上限）；
 * - `cap.mode === 'async'`：用目录声明的 `max_deadline_ms`（≤0 时回落 `syncTierMs` 以外的
 *   既有常量 ASYNC_*，见下）。这些工具的用户语义就是"可能要跑很久"，
 *   用 60s 卡它属于本地凭空造超时；
 * - `cap.mode === 'sync'`：`syncTierMs` 原样（EX §5.2 的 60s 档）。
 */
export function toolDeadlineMsFor(
  syncTierMs: number,
  cap: { mode: 'sync' | 'async'; maxDeadlineMs: number } | undefined,
): number {
  if (cap === undefined || cap.mode === 'sync') return syncTierMs;
  return cap.maxDeadlineMs > 0 ? cap.maxDeadlineMs : ASYNC_TOOL_DEADLINE_FALLBACK_MS;
}

/** async 工具目录未声明上限时的兜底（= 执行面 ExecConfig.asyncDeadlineMs 的同值）。 */
const ASYNC_TOOL_DEADLINE_FALLBACK_MS = 30 * 60_000;

/**
 * ExecToolCall（EX §5.3）：call_id/dot_id/identity 顶层 + deadline_ms。
 * `deadlineMs` 由调用点按 toolDeadlineMsFor() 选档后传入（P0-3：async 工具
 * 不再被 sync 档的 60s 掐断）——自由函数不持默认值，避免选档逻辑被绕开。
 *
 * 路径域适配（接缝契约 §S5 / memory.md:237）：模型与记忆层的唯一权威域是
 * HomeRelPath（`notes/2026-10-15-x.md`），而 EX 能力目录要求 fs.* 的 path 为
 * 容器绝对路径 `/dot/home/<rel>`（exec/protocol.ts:97-116 args_schema 逐字）。
 * 拼接责任在 exec 工具层：模型给相对路径时在此补 `/dot/home/` 前缀；
 * 模型已给绝对路径（或任何非相对写法）时原样透传，由 fleet 侧护栏裁决。
 */
/**
 * TOOL-REUSE-GUARD 的匹配器（S2(b)，2026-10-19）。
 *
 * 目的：判断"这个任务的活，是不是某个自造工具已经能干"。
 *
 * 判据刻意保守 —— 宁可漏判（放行 shell.run）也不要误判（把正常任务卡死）：
 *  ① 工具名出现在 goal 里 → 命中（最强信号，如 goal 含 "word-count"）
 *  ② 中文二元组（bigram）重叠 ≥ 2 个 → 命中
 *     例：goal「统计…中文字…英文单词」vs 工具描述「统计…中文字符数…英文单词数」
 *         共享 bigram：统计 / 中文 / 英文 / 单词 → 4 个，明确命中
 *  ③ 英文词（≥4 字母，排除通用词）重叠 ≥ 2 个 → 命中
 *
 * 为什么用 bigram 而不是分词：项目里没有中文分词依赖，bigram 对中英混排够用，
 * 且不需要引入新依赖（目标 S2 不包含"加依赖"这件事）。
 *
 * @returns 命中的工具名；没命中返回 null
 */
export function matchToolForGoal(
  goal: string,
  tools: Array<{ name: string; description: string }>,
): { name: string; why: string } | null {
  const g = goal.toLowerCase();
  // 中文二元组（连续两个汉字）
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    const cjk = s.match(/[一-龥]{2,}/g) ?? [];
    for (const run of cjk) {
      for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
    }
    return out;
  };
  // 英文词（≥4 字母），排除过于通用的
  const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'test', 'text', 'code', 'file', 'data']);
  const words = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []) {
      if (!STOP.has(w)) out.add(w);
    }
    return out;
  };

  const goalBi = bigrams(g);
  const goalWords = words(g);

  let best: { name: string; why: string; score: number } | null = null;
  for (const tl of tools) {
    // ① 工具名直接出现
    if (g.includes(tl.name.toLowerCase())) {
      return { name: tl.name, why: 'goal 里直接提到了这个工具名' };
    }
    const desc = tl.description.toLowerCase();
    const descBi = bigrams(desc);
    const descWords = words(desc);

    const biHit = [...goalBi].filter((x) => descBi.has(x));
    const wordHit = [...goalWords].filter((x) => descWords.has(x));
    const score = biHit.length + wordHit.length * 2;

    // ②③ 至少 2 个中文 bigram 或 2 个英文词（或 1 个词 + 1 个 bigram）
    const strong = biHit.length >= 2 || wordHit.length >= 2;
    if (strong && (best === null || score > best.score)) {
      const parts: string[] = [];
      if (biHit.length > 0) parts.push('中文词重叠 ' + biHit.slice(0, 4).join('/'));
      if (wordHit.length > 0) parts.push('英文词重叠 ' + wordHit.slice(0, 3).join('/'));
      best = { name: tl.name, why: parts.join('，'), score };
    }
  }
  return best === null ? null : { name: best.name, why: best.why };
}

function toolCall(
  task: Task,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  deadlineMs: number,
): ExecToolCall {
  const call: ExecToolCall = {
    call_id: callId,
    task_id: task.id,
    dot_id: task.dotId,
    tool: tool as ToolName,
    args: withHomeRootArgs(tool, args),
    deadline_ms: deadlineMs,
    issued_at: new Date().toISOString(),
  };
  const id = identityOf(args);
  if (id !== undefined) call.identity = id;
  // A1（2026-10-21）浏览器登录态持久化：容器端 launchPersistentContext +
  // /dot/profiles 卷早已就绪，但宿主从不填 identity → 一切调用挤共享
  // ephemeral，容器一重启登录态全丢（Muse 的"登进去"因此不可能）。
  // 规则：显式 args.identity 优先（含 'anon'=无痕）；缺省时 browser.open
  // 按网址域名派发 site:<host>，同任务的 act/snapshot/close 继承最后一次
  // open 的身份；browser.close 清除。派发与治理审查用同一判定。
  const resolved = resolveBrowserIdentity(tool, args, browserIdentityByTask.get(task.id));
  if (resolved !== undefined) {
    call.identity = resolved;
    if (tool === 'browser.open') browserIdentityByTask.set(task.id, resolved);
  }
  if (tool === 'browser.close') browserIdentityByTask.delete(task.id);
  // A1：身份由顶层 call.identity 承载（契约 G1）；容器侧 args schema 是
  // additionalProperties:false，args.identity 留在 args 里会被容器 400 拒。
  if (tool.startsWith('browser.') && call.args.identity !== undefined) {
    const rest: Record<string, unknown> = { ...call.args };
    delete rest.identity;
    call.args = rest;
  }
  return call;
}

/**
 * 契约 G1：顶层 identity。'anon'/null = 非登录态；**缺失 = fail-closed 按登录态**
 * （治理 isLoginSensitive 判定）。Runner 从模型 args 里**不取**身份（模型无法伪造），
 * 这里只透传 args 中显式出现的 identity 字段；缺失时不设（undefined），
 * 让治理按 fail-closed 处理。
 */
/** A1：任务级浏览器身份表（taskId → 最近一次 browser.open 的 identity）。模块级
 * 与 identityOf 同域（toolCall 是模块函数）；resetRepeatGuard 负责随任务终态清理。 */
const browserIdentityByTask = new Map<string, string>();

/** A1：从网址派生持久站点身份（site:<host>）；解析不了就不派发（fail-closed 由治理兜）。 */
export function siteIdentityOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const host = new URL(url).hostname;
    if (host.length === 0) return undefined;
    return `site:${host}`.slice(0, 80);
  } catch {
    return undefined;
  }
}

/**
 * A1：浏览器系工具的身份解析（纯函数，toolCall 与治理审查共用同一判定）。
 * 显式 args.identity 永远优先（'anon'=无痕，模型可显式要求不持久）；browser.open
 * 缺省派发 site:<host>；其余 browser.* 继承该任务最近一次 open 的身份。
 * 非 browser.* 一律 undefined（不挂 identity 字段）。
 */
export function resolveBrowserIdentity(
  tool: string,
  args: Record<string, unknown>,
  prev: string | undefined,
): string | undefined {
  if (!tool.startsWith('browser.')) return undefined;
  const explicit = args.identity;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (tool === 'browser.open') return siteIdentityOf(args.url);
  return prev;
}

function identityOf(args: Record<string, unknown>): string | undefined {
  const v = args.identity;
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

/**
 * Message → ChatMessage（主循环请求体）。
 *
 * role 映射是这一层的全部职责（`ChatMessage` 只有 system/user/assistant/tool 四值，
 * 而 `Message` 的 kind 有十种）：
 * - `tool_result` → `role:'tool'` + `tool_call_id`：OpenAI 兼容协议要求它紧跟在一个
 *   带 tool_calls 的 assistant 消息之后（那条由 buildMessages 按 pendingCalls 复原）。
 *   没有 callId 的历史结果不会走到这里（buildMessages 已把它降级成系统注记）。
 * - `tool_call` → `role:'assistant'` + `tool_calls`：声明本身不是给模型读的正文，
 *   但缺了它，后面的 role=tool 在网关看来就是"无主"的。
 * - 其余（text / task_start / memory_note …）按 m.role 原样投影。
 */
/**
 * 把图片挂到消息数组里**最后一条 user 消息**上（2026-10-19）。
 *
 * 为什么单独抽出来：原实现挂到 ctx.messages（那时还没装填完），图片静默丢失。
 * 这里对**已经组装好的数组**操作，并且只在没有 images 时才挂（不覆盖已有的）。
 * 返回新数组，不改原对象——避免缓存被污染到下一轮。
 */
function attachImagesToLastUser(
  messages: ChatMessage[],
  images: Array<{ url: string; mimeType?: string }>,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'user') {
      const out = [...messages];
      out[i] = { ...m, images };
      return out;
    }
  }
  return messages;
}

function toChatMessage(m: Message): ChatMessage {
  if (m.kind === 'tool_result') {
    const out: ChatMessage = { role: 'tool', content: m.content };
    const cid = callIdOfToolMessage(m);
    if (cid !== null) out.tool_call_id = cid;
    return out;
  }
  const withCalls = m as Message & {
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  };
  // tool_call 消息有两条来源，必须都认：
  //   ① 本轮刚产出、挂在对象属性上的 toolCalls（内存路径）；
  //   ② **从 thread 重建**时读回来的普通行（只有 content 里那份 JSON）。缺了 ②，
  //      跨轮/跨任务重建就复原不出 assistant.tool_calls，role:tool 会变成无主消息。
  if (m.kind === 'tool_call' && !(Array.isArray(withCalls.toolCalls) && withCalls.toolCalls.length > 0)) {
    const parsed = parseToolCallContent(m.content);
    if (parsed.length > 0) withCalls.toolCalls = parsed;
  }
  if (m.kind === 'tool_call' && Array.isArray(withCalls.toolCalls) && withCalls.toolCalls.length > 0) {
    // **content 必须是空串，不能是那份 JSON**（2026-10-18 修）：
    // tool_call 行的 content 是"调用声明"的序列化形式，不是给模型看的正文。
    // 原来把它当 content 塞回去，模型每轮都看到
    //   assistant: '{"calls":[{"call_id":"...","name":"fs.write",...}]}'
    // —— 一段它自己没写过的 JSON 冒充"它说过的话"，导致它误读自己的历史
    // （实测：明明改用相对路径成功了，最后却汇报"绝对路径被接受了"）。
    // 正文本来就由另一条 assistant/text 行承载（reportAssistant 单独写）。
    const out = { role: 'assistant' as const, content: parseToolCallText(m.content) } as ChatMessage & {
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    out.tool_calls = withCalls.toolCalls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments },
    }));
    return out;
  }
  // **必须带上 images**（2026-10-19 实测）：原来这里只返回 role+content，
  // 把多模态附件整条丢掉 —— 日志显示"已加载任务图片"，但模型收到的仍是纯文本，
  // 于是它只能自己写 python 解 PNG 像素（能认纯色块，真实截图完全没法看）。
  return {
    role: m.role,
    content: m.content,
    ...(m.images === undefined ? {} : { images: m.images }),
  };
}

/**
 * 从 tool_call 消息的 content 解析调用声明（reportToolCalls 写入的形状）。
 *
 * 内容形如 `{"calls":[{"call_id":"...","name":"fs.write","arguments":"{...}"}]}`。
 * 解析失败返回空数组——调用方据此退回"没有声明"的降级路径，不抛。
 */
function parseToolCallText(content: string): string {
  try {
    const obj = JSON.parse(content) as { text?: unknown };
    return typeof obj.text === 'string' ? obj.text : '';
  } catch {
    return '';
  }
}

function parseToolCallContent(content: string): Array<{ id: string; name: string; arguments: string }> {
  try {
    const obj = JSON.parse(content) as { calls?: unknown };
    if (!Array.isArray(obj.calls)) return [];
    const out: Array<{ id: string; name: string; arguments: string }> = [];
    for (const c of obj.calls) {
      if (c === null || typeof c !== 'object') continue;
      const r = c as Record<string, unknown>;
      if (typeof r['call_id'] !== 'string' || typeof r['name'] !== 'string') continue;
      out.push({
        id: r['call_id'],
        name: r['name'],
        arguments: typeof r['arguments'] === 'string' ? r['arguments'] : '{}',
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** tool_result 消息里嵌的 call_id（双写禁令下只从内容解析，全文以 steps 为准）。 */
function callIdOfToolMessage(m: Message): string | null {
  const match = /call_id["'\s:=]+([A-Za-z0-9_-]{8,})/.exec(m.content);
  return match?.[1] ?? null;
}

/** system.note / interrupted 步的注入文本（CP §5.3 injectRecoveryNote / §6.2 merge 注记）。 */
function noteText(s: Step): string {
  const body = s.resultJson ?? s.argsJson ?? '';
  return body.length > 0 ? body : `系统注记（${s.toolName ?? s.kind}#${s.seq}）`;
}

function errText(err: unknown): string {
  if (err instanceof DotdError) return `${err.code}:${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export { newNonJournalAttemptId };
