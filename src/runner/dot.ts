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
} from '../shared/contracts.ts';
import { AllEndpointsDownError, DotdError, NoQualifiedPrimaryError, StepLimitError } from '../shared/errors.ts';
import { newNonJournalAttemptId } from '../shared/ids.ts';
import { composeSystemPrompt } from './system-prompt.ts';
import { buildToolSpecs } from './tool-catalog.ts';

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
  feed(res: { ok: boolean; callId: string; value: unknown; toolName?: string; dispatched?: boolean }): void {
    const toolName = res.toolName ?? this.pendingCalls.get(res.callId);
    if (toolName !== undefined) this.pendingCalls.set(res.callId, toolName);
    if (res.dispatched === false) {
      // 未派发（deny / 记忆硬限）：一次性系统注记，不进 tool 通道（没有执行结果可回）。
      this.notes.push(`工具调用未执行：${digestPreview(res.value)}`);
      this.pendingCalls.delete(res.callId);
      this.callArgs.delete(res.callId);
      return;
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

  /** CP §12 `ctx.done`。 */
  get done(): boolean {
    return this.doneFlag;
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
      out.push({
        callId,
        toolName: this.pendingCalls.get(callId) ?? '',
        args: this.callArgs.get(callId) ?? '{}',
        text: json,
        // 有调用声明 = 本轮真的派发过 → 可进 tool 通道；否则是恢复期补喂的历史结果。
        dispatched: this.pendingCalls.has(callId),
      });
      this.pendingCalls.delete(callId);
      this.callArgs.delete(callId);
    }
    this.pendingResults.clear();
    return out;
  }

  /**
   * 组装发给模型的 ChatMessage[]（接缝 ⑥ 的请求体）。
   *
   * 顺序（CP §7.3）：system prompt（**恒为 messages[0]**）→ 文件记忆快照
   * （MEMORY.md + manuals 片段 + 会话摘要，作为独立的 system 注记，不混进 prompt，
   * 以免覆盖 system prompt 这种"伪装成对话的注入"）→ 会话历史（assistant 全文）→
   * assistant.tool_calls + 本轮 tool 结果 → 系统注记 → 任务目标（user，恒为最后一条）。
   */
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

    out.push(...this.messages);

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
    const withName = dispatched;
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

  /** 工具 sideEffect 词表缓存（契约 J2：唯一事实源 = exec.getCapabilities）。 */
  private sideEffectOf = new Map<string, 'safe' | 'replayable' | 'unknown'>();
  /**
   * 接缝 M6：beforeWrite 软限 warning 暂存（callId → warning），
   * 等工具结果回来后附回响应；派发失败/异常时随步清理。
   */
  private readonly memoryWarnings = new Map<string, string>();
  /** 已封存任务（幂等：同一 task 多次收口只 seal 一次）。 */
  private readonly sealed = new Set<string>();
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
    this.log(`runner: 领任务 ${task.id}（epoch=${epoch} resume_from_seq=${task.resumeFromSeq ?? '-'}）`);

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

    // ⑤/§7.3 重建顺序：buildSessionReplay（LLM 全文）→ tool_result 全文覆盖 → journal.tail → 提示
    const ctx = new RunContext(session.goal);
    const replay = session.threadId === null
      ? []
      : await this.memory.buildSessionReplay(session.threadId, session.id, session.budgetTokens);
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

      if (llm.step.toolCalls.length === 0) {
        ctx.feedLlm({ content: llm.step.content, toolCalls: [] }, llm.tokens);
        continue; // done=true → 退出 while
      }

      // 本轮调用的声明先登记：工具结果回喂时要靠它复原 assistant.tool_calls
      // （协议要求 role=tool 必须紧跟在一个带 tool_calls 的 assistant 消息之后）。
      ctx.noteToolCalls(llm.step.toolCalls);
      for (const call of llm.step.toolCalls) {
        if (ctx.done) break;
        const out = await this.stepTool(session, epoch, ctx, call);
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
    return this.finishTask(session, epoch, { ok: true, summary: ctx.summary });
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
    const req: RouteRequest = {
      track: 'primary',
      messages: messages.map(toChatMessage),
      tools: await this.toolSpecs(),
      tool_choice: 'auto',
      attemptId: callId, // 契约 J1：attemptId = journal 步 callId
      maxTokens: 4096,
    };
    let resp;
    try {
      resp = await this.router.complete(req);
    } catch (err) {
      // 模型故障支线：熔断耗尽 → paused(circuit_open)，等 router.mode_changed 批量回 queued
      if (err instanceof AllEndpointsDownError || err instanceof NoQualifiedPrimaryError) {
        this.cp.pauseByReason(task.id, 'circuit_open');
        await this.seal(task, 'cancelled', 'circuit_open');
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

    const usage = resp.usage ?? { promptTokens: 0, completionTokens: 0 };
    const tokens = usage.promptTokens + usage.completionTokens;
    const chat = resp.response as { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
    const step: LlmStep = {
      content: typeof chat.content === 'string' ? chat.content : '',
      toolCalls: (chat.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
      })),
    };
    this.cp.journal.endLlm(task.id, epoch, seq, digestOf(step.content));
    ctx.feedLlm(step, tokens);
    // ⑩ 结果回报前半句：assistant 全文 appendMessage 入 thread（接缝契约 §8 ⑩）。
    // 只落有正文的轮次；纯工具调用轮（content 为空）不入 thread，避免噪声刷屏。
    if (step.toolCalls.length === 0 && step.content.length > 0) {
      await this.reportAssistant(ctx, task, step.content);
    }
    return { kind: 'ok', step, tokens };
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
  private async toolSpecs(): Promise<Array<{ name: string; description?: string; parameters?: object }>> {
    const caps = await this.getCapabilities();
    return buildToolSpecs(caps);
  }

  private async getCapabilities(): Promise<Array<{ name: string; mode: 'sync' | 'async'; max_deadline_ms: number; args_schema: object; sideEffect: 'safe' | 'replayable' | 'unknown' }>> {
    const caps = await this.exec.getCapabilities(this.dotId);
    for (const c of caps) this.sideEffectOf.set(c.name, c.sideEffect);
    return caps;
  }

  // ── 3.4 ⑦ 工具步 ──────────────────────────────────────────────────────

  private async stepTool(
    task: Task,
    epoch: number,
    ctx: RunContext,
    call: { id: string; name: string; arguments: string },
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

    // S1：sideEffect 词表唯一事实源 = exec.getCapabilities；未声明按 unknown
    const se = this.sideEffectOf.get(call.name) ?? 'unknown';
    const { seq, callId } = this.cp.journal.beginTool(task.id, epoch, call.name, args, se);

    // 接缝 G5：goalDigest 由 Runner 在 evaluate 前截取（≤800B）注入治理审查档
    const verdict = await this.governance.evaluate(
      { dotId: task.dotId, taskRef: { taskId: task.id, journalStepId: callId }, emergency: this.router.emergencyActive },
      { callId, tool: call.name, params: args, identity: identityOf(args) },
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
    const res = await this.exec.runTool(toolCall(task, callId, call.name, args, this.toolDeadlineMs));
    const ok = res.status === 'ok';
    const warning = this.memoryWarnings.get(callId);
    const result = warning === undefined
      ? (ok ? res.result : res.error)
      : { ...(ok ? (res.result ?? {}) : (res.error ?? {})), warning };
    this.cp.journal.endTool(task.id, epoch, seq, ok ? 'succeeded' : 'failed', result ?? null);
    // 成败都以 JSON 回喂（失败 = 容器端的 {code,message,retryable}）：模型要靠 code 决定改参还是重试。
    ctx.feed({ ok, callId, toolName: call.name, value: result });
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
    const res = await this.exec.runTool(toolCall(task, callId, toolName, args, this.toolDeadlineMs));
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
 * ExecToolCall（EX §5.3）：call_id/dot_id/identity 顶层 + deadline_ms。
 * `deadlineMs` 由 Runner 的 `toolDeadlineMs` 选项传入（EX §5.2 sync 上限 60s）——
 * 自由函数不持默认值，避免选项形同虚设（审码 finding：死选项）。
 *
 * 路径域适配（接缝契约 §S5 / memory.md:237）：模型与记忆层的唯一权威域是
 * HomeRelPath（`notes/2026-10-15-x.md`），而 EX 能力目录要求 fs.* 的 path 为
 * 容器绝对路径 `/dot/home/<rel>`（exec/protocol.ts:97-116 args_schema 逐字）。
 * 拼接责任在 exec 工具层：模型给相对路径时在此补 `/dot/home/` 前缀；
 * 模型已给绝对路径（或任何非相对写法）时原样透传，由 fleet 侧护栏裁决。
 */
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
  return call;
}

/**
 * 契约 G1：顶层 identity。'anon'/null = 非登录态；**缺失 = fail-closed 按登录态**
 * （治理 isLoginSensitive 判定）。Runner 从模型 args 里**不取**身份（模型无法伪造），
 * 这里只透传 args 中显式出现的 identity 字段；缺失时不设（undefined），
 * 让治理按 fail-closed 处理。
 */
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
  if (m.kind === 'tool_call' && Array.isArray(withCalls.toolCalls) && withCalls.toolCalls.length > 0) {
    const out = { role: 'assistant' as const, content: m.content } as ChatMessage & {
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    out.tool_calls = withCalls.toolCalls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments },
    }));
    return out;
  }
  return { role: m.role, content: m.content };
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
