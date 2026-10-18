/**
 * src/shared/contracts.ts —— 跨模块契约的唯一权威（TS 面）。
 *
 * 铁律（骨架约定，见 dotd/CONVENTIONS.md「模块边界」）：
 *   八个实现模块**只准 import 本文件**定义跨模块接口/事件名/表所有权注释，
 *   **不得各自另定接口**。模块内部私有类型放各自的 types.ts。
 *
 * 来源（逐字可溯，行号指 docs/design/modules/ 下文件）：
 * - 接缝契约.md §1 D1–D6（库/迁移/表所有权）、§9 统一术语表、§10 待改清单
 * - control-plane.md §3（Task/Step/EventDecision）、§8（ControlPlane 接口）
 * - model-router.md §3.1（Track/Tier/BreakerState/FailureKind/EndpointDef/RouterMode/
 *   RouteRequest/RouteMeta/RouteResult/RouterSnapshot/RouterEvent）、§5.1–5.3
 * - governance.md §3.1（GovCtx/Decision/ToolCall）、§3.2（ApprovalStatus/TRANSITIONS/
 *   Verdict）、§3.5（ApprovalView）、§3.6（SyntheticSubject）、§8.1–8.2
 * - execution.md §5.3（协议 ToolCall/ToolResult）、§10（Capability/ExecService）
 * - memory.md §5.1（Memory 类型族）、§8（MemoryService）
 * - surfaces.md §3（surfaces 配置）、§4.5（BusEvent）、§4.6（RawInbound）、§5.7
 *   （NotificationChannels）
 *
 * 本文件只承载"跨模块可见"的部分；每个模块的对外服务接口按属主分文件存放
 * （src/control-plane/types.ts 等），但**跨模块引用的类型一律从这里导出**。
 */

// ═══════════════════════════════════════════════════════════════════
// §1 表所有权（契约 D4 唯一权威，替代六方各自的声明）
// ═══════════════════════════════════════════════════════════════════

/**
 * 契约 D4 表所有权登记表（逐字）。D2 铁律：不建跨模块所有权的 FOREIGN KEY；
 * 同属主 FK 允许（如 approvals→decisions）。
 */
export const TABLE_OWNERSHIP = {
  /** CP 控制面 */
  controlPlane: [
    'tasks',
    'task_results',
    'steps',
    'event_decisions',
    'resource_events',
    'events',
    'crontabs',
  ],
  /** MR 模型路由（他模块取状态一律走 ModelRouter.snapshot()，禁止自行 SELECT；唯一例外 T3 OUTBOX 守门） */
  router: [
    'breaker_state',
    'breaker_sample',
    'breaker_event',
    'router_state',
    'pool_probe_result',
    'recon_candidate',
    'alert_dispatch',
    'model_call_log',
  ],
  /** GOV 治理 */
  governance: [
    'approvals',
    'decisions',
    'approval_rules',
    'endpoint_grants',
    'quarantines',
    'audit_log',
    'audit_archive',
    'spend_ledger',
    'gov_seq',
  ],
  /** EX 执行面 */
  exec: [
    'exec_dots',
    'image_builds',
    'containers',
    'exec_identities',
    'exec_volumes',
    'exec_calls',
    'exec_disk_policy',
  ],
  /** MEM 记忆 */
  memory: ['mem_threads', 'mem_messages', 'mem_files_index', 'mem_maintenance_state'],
  /** SF 交互面 */
  surfaces: ['surf_jsonl_offset', 'surf_tg_card_state', 'surf_ingress_rejects', 'surf_sse_cursor'],
} as const;

export type TableOwner = keyof typeof TABLE_OWNERSHIP;

/** 契约 D5 前缀：仅 mem_/surf_/exec_（含 gov_seq 这类 GOV 自有名）保留，其余无前缀。 */
export const TABLE_PREFIXES = ['mem_', 'surf_', 'exec_'] as const;

/** 契约 D1：唯一库文件（db/conn.ts 消费；WSL 内 daemon 用户 HOME 下）。 */
export const DEFAULT_DB_PATH = '~/.dotd/dotd.db';

// ═══════════════════════════════════════════════════════════════════
// §2 控制面（CP）—— types.ts / §8 接口的跨模块可见面
// ═══════════════════════════════════════════════════════════════════

/** CP §3：tasks.status 七态。契约 T1：不加 waiting_model。 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

/** CP §3：steps.status 六态。started = 执行中（崩溃孤儿即 started）。 */
export type StepStatus = 'pending' | 'started' | 'succeeded' | 'failed' | 'interrupted' | 'skipped';

/** CP §3：kind 两态。 */
export type StepKind = 'llm' | 'tool';

/**
 * 契约 §9：副作用档 = Capability 字段 sideEffect（J2）。
 * 未声明按 unknown 安全默认；journal 崩溃恢复分流唯一依据（CP §5.1）。
 */
export type SideEffect = 'safe' | 'replayable' | 'unknown';

/** CP §3：tasks.stop_reason CHECK（契约 §9：任务挂起等模型 = paused(stop_reason='circuit_open')）。 */
export type StopReason = 'user' | 'tool_risk' | 'circuit_open' | 'watermark' | 'budget' | 'shutdown';

export interface Task {
  id: string;
  dotId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: number; // 0 最高；1=主人 interactive，7=bulk
  runAt: number | null;
  /** 契约 E1：source_event_log_id → source_event_id（弱引用 events.id）。 */
  sourceEventId: number | null;
  /** 契约 M1：thread ≡ session，tasks.session_id 与 thread_id 同值。 */
  sessionId: string | null;
  threadId: string | null;
  attempt: number;
  maxAttempts: number;
  /** 围栏：每次转 running +1（CP §2.2）。 */
  runEpoch: number;
  lastHeartbeatAt: number | null;
  budgetTokens: number;
  usageTokens: number;
  resumeFromSeq: number | null;
  stopReason: StopReason | null;
  createdAt: number;
  updatedAt: number;
}

export interface Step {
  taskId: string;
  seq: number;
  kind: StepKind;
  status: StepStatus;
  /** 契约 J1：llm 步同样填写（uq_steps_call 已覆盖）。 */
  callId: string | null;
  toolName: string | null;
  argsJson: string | null;
  resultJson: string | null;
  sideEffect: SideEffect | null;
  runEpoch: number;
  approvalId: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/** CP §3：event_decisions（本模块自有，键=events.id，天然幂等）。 */
export interface EventDecision {
  /** 契约 E1：event_log_id → event_id。 */
  eventId: number;
  action: 'run_new' | 'merge' | 'ignore';
  taskId: string | null;
  confidence: number;
  reason: string;
  via: 'rule' | 'llm' | 'manual';
  decidedAt: number;
}

/** 契约 E2：投递接口签名（唯一）。术语作废：submitEnvelope / Envelope / enqueue(env)。 */
export interface IngestEventReq {
  source: 'http' | 'file' | 'heartbeat' | 'telegram' | 'email';
  dotId: string;
  actor: string;
  payload: unknown;
  dedupKey?: string;
  priority?: number;
}
export interface IngestEventResult {
  /** 撞 dedup_key UNIQUE → 幂等返回旧 id（契约 E1）。 */
  eventId: number;
  dup: boolean;
}

export interface SubmitReq {
  title: string;
  goal: string;
  priority?: number;
  runAt?: number;
  dotId?: string;
  /** 契约 E2：采纳 MEM Q1——对话任务由 SF 先 memory.openThread 再带 threadId 提交。 */
  threadId?: string;
  /** 契约 E2：落 tasks.payload_json TEXT（MEM 的 title 前缀编码方案作废）。 */
  payloadJson?: string;
  eventId?: number;
}

/** 契约 T2：字段名以 MR 为准（snake_case），CP:560 camelCase 作废。 */
export interface TaskImpact {
  queued_primary: number;
  running: number;
  /** held = awaiting_approval + paused 数。 */
  held: number;
}

/** CP §8：ControlBusEvent（onBus 可订阅的主题名）。 */
export type ControlBusEvent =
  | 'task.state'
  | 'task.budget_exhausted'
  | 'guard.level'
  | 'event.undecided'
  | 'stale_writer';

/**
 * CP §8 ControlPlane 接口（跨模块引用面）。
 * 说明：完整实现在 src/control-plane/，本处登记**其他模块会调用的**方法签名，
 * 避免八个模块各抄一份。属主私有方法（如 journal.tail）不在此展开。
 */
export interface ControlPlane {
  // 队列
  submit(req: SubmitReq): Task;
  pop(dotId?: string): Task | null; // 仅 Runner；内部 run_epoch+1
  heartbeat(
    taskId: string,
    epoch: number,
    usage?: { tokens: number },
    /**
     * P0-3 在途心跳（执行面轮询驱动）：
     *  - `live`：只做围栏校验 + 刷新 last_heartbeat_at（不记账、不发预算事件）；
     *  - `skipBudget`：只刷新心跳，不读不写预算位（联调/测试用）。
     * 省略 = 步尾心跳（原语义：记 usage、判预算）。
     */
    opts?: { live?: { at?: number }; skipBudget?: boolean },
  ): { overBudget: boolean; aborted: boolean };
  finish(taskId: string, epoch: number, r: { ok: boolean; summary: string }): void;
  cancel(taskId: string, by: 'user' | 'guard' | 'watchdog'): void;
  resume(taskId: string): void;
  list(q: { status?: TaskStatus[]; dotId?: string; limit?: number }): Task[];
  getTask(id: string): Task | null;
  getJournal(taskId: string): Step[];

  // 事件（契约 E2：唯一机器事件入口；wakeIngest 并入其内部唤醒）
  ingestEvent(e: IngestEventReq): IngestEventResult;
  listUndecidedEvents(limit?: number): EventsRow[];
  retryMatch(eventLogId: number, m: EventDecision): void;

  // 会话/线程绑定（契约 M2：唯一回写通道；MEM"Runner 直接 UPDATE tasks"作废）
  bindSession(taskId: string, epoch: number, ids: { sessionId: string; threadId: string }): void;

  // 审批联动（契约 J6：钩子签名定案）
  setAwaitingApproval(taskId: string, epoch: number, approvalId: number): void;
  onApprovalSettled(
    taskId: string,
    approvalId: number,
    ok: boolean,
    meta?: { note?: string; revoke?: string },
  ): void;

  // journal（契约 J3：唯一写路径；GOV 的 beginStep/endStep 改名 beginTool/endTool）
  journal: {
    beginTool(
      taskId: string,
      epoch: number,
      tool: string,
      args: unknown,
      se: SideEffect,
    ): { seq: number; callId: string };
    markPending(taskId: string, epoch: number, seq: number, approvalId: number): void;
    endTool(taskId: string, epoch: number, seq: number, st: StepStatus, result?: unknown): void;
    /** 契约 J1 缺口裁定：beginLlm 返回 {seq, callId}（旧稿只返回 seq）。 */
    beginLlm(taskId: string, epoch: number, promptDigest: string): { seq: number; callId: string };
    endLlm(taskId: string, epoch: number, seq: number, respDigest: string): void;
    /**
     * 契约 §8 ⑨ / CP §7.4「审批续跑」：审批放行后 Runner 领到任务（新 epoch），
     * 把该 pending 步转 started，**复用原 call_id**（契约 J1-2：pending 步从未派发过
     * exec、ledger 无记录，无幂等冲突；重派换新 call_id 只适用于已派发过的孤儿步）。
     * `argsJson` = 治理 final_params_json（CP §7.4「以治理 final_params_json 执行」）。
     * 返回该步 callId 供执行面对账与 endTool。
     */
    resumeStep(taskId: string, epoch: number, seq: number, argsJson?: string): { callId: string };
    /** 契约 J3 新增：承接 GOV"deny/ok=false 由控制面把步标 skipped"的义务。 */
    skipStep(callId: string, reason: string): void;
    getStepByCallId(callId: string): Step | null;
    /**
     * CP §5.3/§7.4 三分流。**异步**：unknown 步要先向执行面对账
     * `exec.reconcileCall(callId)`（IO），故返回 Promise；磁盘稿（设计方案.md:168、
     * control-plane.md:541）写成同步是旧稿，契约裁定以 async 为准
     * （返回词表不变：'replayed' | 'deferred' | 'took_result'）。
     */
    reconcileAndResolve(
      taskId: string,
      seq: number,
    ): Promise<'replayed' | 'deferred' | 'took_result'>;
    tail(taskId: string, n?: number): Step[];
  };

  // 背压与预算
  getGuardStatus(): {
    level: 'normal' | 'guarded' | 'throttled' | 'halted';
    memAvailableMb: number;
    baseMb: number;
    daemonRssMb: number;
    recent: ResourceEventRow[];
  };
  /** CP §8（补旧稿缺失）：模型路由/执行面可调用。 */
  pauseByReason(
    taskId: string,
    reason: 'circuit_open' | 'watermark' | 'budget' | 'tool_risk',
  ): void;
  /**
   * Runner 专用（CP §5.4 硬上限）：直接把在途任务判 failed 并写 stop_reason，
   * **不经 attempt 重试**（步数 2000 已说明任务本身失控，重试无意义）。
   * 装配层实现转发到 Queue.markFailed（看门狗同路径）。
   * **可选**：契约追加时既有控制面实现尚未提供该方法（改他人文件超出本模块边界），
   * Runner 侧用鸭子类型探测，缺省时退化为 `finish(ok:false)`（attempt<max 会重试，
   * 语义弱一档——见 src/runner/dot.ts `failTask()` 与 deviations）。
   */
  failTask?(taskId: string, epoch: number, reason: string): void;
  /** 契约 G3（O6 裁定）：per-dot 队列 pause/resume。 */
  pauseDotQueue(dotId: string): void;
  resumeDotQueue(dotId: string): void;
  /** 契约 T2：注入 ModelRouter.load。 */
  taskImpact(): TaskImpact;

  // 统一调度器（契约 J4：周期任务唯一宿主）
  registerInternalJob(spec: {
    name: string;
    kind: 'light' | 'heavy';
    cron?: string;
    everyMs?: number;
    run: () => Promise<void>;
  }): void;

  // 事件总线
  onBus(event: ControlBusEvent, handler: (payload: unknown) => void): void;
}

/** events 行（契约 E1 最小 DDL 的 TS 投影）。 */
export interface EventsRow {
  id: number;
  source: 'http' | 'file' | 'heartbeat' | 'telegram' | 'email';
  dotId: string;
  actor: string;
  dedupKey: string | null;
  /** JSON；业务扩展进 payload 不加列（SF C1）。 */
  payload: string;
  status: 'pending' | 'matched' | 'ignored' | 'inbox';
  receivedAt: number;
}

/** resource_events 行（CP §3.1）。 */
export interface ResourceEventRow {
  id: number;
  ts: number;
  level: 'normal' | 'guarded' | 'throttled' | 'halted';
  kind:
    | 'watermark'
    | 'container_pause'
    | 'container_unpause'
    | 'container_kill'
    | 'queue_evict'
    | 'disk_gc'
    | 'stale_writer'
    | 'watchdog'
    | 'budget';
  detail: string;
}

// ═══════════════════════════════════════════════════════════════════
// §3 模型路由（MR）
// ═══════════════════════════════════════════════════════════════════

/** 契约 §9：路由轨道 track:'primary'|'light'（作废 routeHint:'low'、completeMain）。 */
export type Track = 'primary' | 'light';
export type Tier = 1 | 2 | 3 | 4;
export type BreakerState = 'closed' | 'open' | 'half_open';

export type FailureKind =
  | 'rate_limit'
  | 'quota'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'bad_protocol'
  | 'engine_unavailable'
  | 'pool_unverified'
  /**
   * 零用量空壳（迁移自 PilotDeck "zero-usage retry"）：200 + 有 choices，但无正文、
   * 无工具调用、completion_tokens 为 0 或 usage 缺失。
   *
   * 与 bad_protocol 的关键区别：**不**触发 `capabilities.tool_calling='no'`。
   * 空壳是 provider 过载/降级，不是"这个端点不会调工具"——把两者混为一类，
   * 一次免费路由抖动就能把好端点永久踢出 primary 轨（§4.1）。
   */
  | 'empty_response';

export interface EndpointDef {
  id: string;
  tier: Tier;
  baseUrl: string;
  apiKeyEnv: string | null;
  models: Partial<Record<Track, string>>;
  /**
   * 同端点内的备用模型链（MR §4.2 模型级 fallback）。
   *
   * 主模型失败时按声明顺序逐个试，试完才换端点。解决"端点只有一份凭据、
   * 但主模型本身限流/降级"的场景——OpenRouter 免费路由实测会返空壳或 429，
   * 此时凭据与端点都是好的，却会把唯一的 primary 候选整个拖死。
   *
   * 与 `models` 的关系：`models[track]` 是链首，本字段是链尾；两者都不写才报错。
   * 每条链最多 MAX_FALLBACK_MODELS(5) 个（PilotDeck LITELLM_ROUTER_MAX_FALLBACKS 同值）。
   */
  fallbackModels?: Partial<Record<Track, string[]>>;
  style: 'openai';
  enabled: boolean;
  timeouts: { connect_ms: number; idle_ms: number; total_ms: number };
  emergencyEligible: boolean;
  local?: {
    health_url: string;
    warm_check?: {
      url: string;
      /** 逐键相等判定；键是点分路径（数字段索引数组，`last` 取末元素）。 */
      json_eq?: Record<string, number>;
      /** 逐键"不超过阈值"判定（路径语义同 json_eq）；Colibrì /profile 的冷热分界用它。 */
      json_max?: Record<string, number>;
    };
    warm_grace_ms?: number;
    max_concurrency: number;
    queue_reject_ms: number;
  };
  capabilities?: { tool_calling: 'yes' | 'no' | 'unknown'; context: number };
  rate?: { rpm: number; rpd: number };
  /**
   * P1-1 生产请求并发上限（可选，远程端点用）。
   *
   * 语义：本端点**同时**最多允许多少个在途模型请求；超出的请求由 ModelRouter
   * 的生产信号量**排队**（不是快速失败），排队超时才降级换端点。
   *
   * 为什么不复用 `local.max_concurrency`：那个字段挂在 `local:` 段下，而 `local:`
   * 在本仓库的语义是「Tier2 本地引擎」（含 health_url / warm 探活），远程端点没有
   * 也不该有那个段。远程端点要声明"我知道自己只支持 N 并发"（免费额度、单实例网关）
   * 时用本字段。缺省 = 未声明 = 按 `DEFAULT_REMOTE_CONCURRENCY` 兜底（见 ModelRouter）。
   */
  maxConcurrency?: number;
  lastVerifiedAt?: number;
}

export type RouterMode = 'NORMAL' | 'LOCAL_FALLBACK' | 'EMERGENCY' | 'RESTRICTED' | 'TOTAL_OUTAGE';

/** MR §3.1：attemptId = journal 步骤 id，调用方生成，重试时不变。attemptSeq 由路由自增回传。 */
export interface RouteRequest {
  track: Track;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  tool_choice?: 'auto' | 'required' | string;
  maxTokens?: number;
  temperature?: number;
  eventId?: string;
  /** journal 步 = callId；非 journal 上下文 = 'nonj:'+ULID（契约 J1）。 */
  attemptId: string;
  deadlineMs?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface RouteMeta {
  endpointId: string;
  tier: Tier;
  model: string;
  /** true = 非标准档位承载 primary，供治理加验（MR §4.3/§6.3）。 */
  degraded: boolean;
  attemptSeq: number;
  tried: TryRecord[];
  streamStarted: boolean;
}

export interface RouteResult {
  meta: RouteMeta;
  response: ChatResponse | AsyncIterable<ChatChunk>;
  usage?: { promptTokens: number; completionTokens: number };
}

/** MR §3.1 RouterSnapshot：Web UI / CLI `dotd models status` 消费。 */
export interface RouterSnapshot {
  mode: RouterMode;
  emergencyActive: boolean;
  endpoints: Array<{
    id: string;
    tier: Tier;
    emergencyEligible: boolean;
    roles: Record<
      Track,
      {
        breaker: BreakerState;
        consecFailures: number;
        nextProbeAt: number | null;
        throttledUntil: number | null;
        lastKind: FailureKind | null;
      }
    >;
    /**
     * 健康度评分（2026-10-17 ProviderHealthTracker 迁移，MR §4.2 同 tier 排序的运行时依据）。
     * 可选：样本不足（< minSamples）时**不给分**——"没有历史"不等于"差"，编一个 0 分
     * 会让新端点永远排最后，从而永远拿不到样本（闭环饿死）。
     */
    health?: {
      samples: number;
      successRate: number | null;
      latencyP50: number | null;
      latencyP95: number | null;
      score: number | null;
      cooldownRemainingMs: number;
    };
  }>;
  pool: Array<{ id: string; lastVerifiedAt: number | null; qualifiedForPrimary: boolean }>;
  pendingRecon: number;
  openAlerts: number;
  lastAlert: { signature: string; sentAt: number; channel: string } | null;
}

/** MR §3.1 RouterEvent（总线主题名 = router.* 族，见 bus.ts TOPICS）。 */
export type RouterEvent =
  | { type: 'mode_changed'; from: RouterMode; to: RouterMode; at: number }
  | { type: 'breaker_changed'; endpointId: string; track: Track; from: BreakerState; to: BreakerState }
  | { type: 'recon_proposal'; candidateId: string; summary: string }
  | { type: 'help_needed'; signature: string; urgent: boolean };

/** MR §5.1：TaskImpactProvider 由 CP taskImpact() 实现、ModelRouter.load 注入。 */
export type TaskImpactProvider = () => TaskImpact;

/** 最小 OpenAI 风格消息/工具形状（MR 调用面通用）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}
export interface ChatResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}
export interface ChatChunk {
  delta: string;
  done?: boolean;
  /**
   * 流式回合中的工具调用**增量**（roadmap P0-2；对齐 OpenAI 兼容 SSE 的
   * `choices[0].delta.tool_calls`）。
   *
   * 语义是**增量**，不是成品：同一个 `index` 的多块要按到达顺序拼接
   * （`name` 取首个非空值、`argumentsDelta` 逐块累加）才是完整调用；
   * 完整调用 = `{id, name, arguments}`，与 `ChatResponse.toolCalls` 同形（见 shared/tool-stream.ts 的
   * `StreamToolCallAccumulator`）。
   *
   * 可选字段：不产出工具调用的 chunk（纯文本流）不带它，旧调用方读取 `delta`/`done` 不受影响。
   */
  toolCalls?: StreamToolCallDelta[];
}

/** `ChatChunk.toolCalls` 的单条增量（只增不改，`ChatResponse.toolCalls` 仍是成品形状）。 */
export interface StreamToolCallDelta {
  /** 同一回合内工具调用的序号（OpenAI 语义；缺省时由聚合器按到达顺序对待）。 */
  index: number;
  /** 调用 id：通常只在首个分片出现。 */
  id?: string;
  /** 工具名：可能被拆成多个分片，拼接后才是全名。 */
  name?: string;
  /** 参数 JSON 的**文本分片**，逐块累加才是完整 JSON。 */
  argumentsDelta?: string;
}
export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: object;
}
export interface TryRecord {
  endpointId: string;
  tier: Tier;
  track: Track;
  ok: boolean;
  kind?: FailureKind;
  /** 本次尝试实际用的模型名（端点内 fallback 链逐条可辨，否则同端点多条记录分不清）。 */
  model?: string;
  at: number;
  ms?: number;
}

// ═══════════════════════════════════════════════════════════════════
// §4 治理（GOV）
// ═══════════════════════════════════════════════════════════════════

/** GOV §2：五档分级（§9.3 默认策略 read/write_file→allow；browser→review；spend/dangerous→approve）。 */
export type ToolTier = 'read' | 'write_file' | 'browser' | 'spend' | 'dangerous';

/** GOV §3.2：approvals.status 八态（契约 G2 词汇表单源）。 */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'revoked';

/** GOV §3.2 合法迁移表（TRANSITIONS；非法迁移抛错并记审计 illegal_transition）。 */
export const APPROVAL_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['executing', 'revoked'],
  rejected: [],
  expired: [],
  executing: ['executed', 'failed'],
  executed: [],
  failed: [],
  revoked: [],
};

/** GOV §3.3：Verdict 三值（契约 §9：展示 AP-#<seq>）。 */
export type Verdict = 'approve_once' | 'approve_remember' | 'reject';

/** GOV §3.6：approvals.kind 三值。 */
export type ApprovalKind = 'tool_call' | 'synthetic' | 'question';

/** GOV §3.6：非工具单的主语。 */
export type SyntheticSubject =
  | { kind: 'recon_candidate'; model: string; baseUrl: string; license?: string; sourceUrl?: string }
  | { kind: 'side_effect_unknown'; taskId: string; step: string }
  | { kind: 'question'; prompt: string; options?: string[] };

export interface GovCtx {
  dotId: string;
  taskRef: { taskId: string; eventId?: string; journalStepId: string };
  emergency: boolean;
}

export type Decision =
  | { kind: 'allow'; decisionId: string; brief: PrecheckBrief | null }
  | { kind: 'review_pass'; decisionId: string; brief: PrecheckBrief }
  | { kind: 'review_approve'; approvalId: number }
  | { kind: 'approve'; approvalId: number }
  | { kind: 'deny'; decisionId: string; reason: string };

/** GOV §3.5 ApprovalView（Web/TG 卡片唯一数据源；SF §7 页面不自行判定状态合法性）。 */
export interface ApprovalView {
  id: number;
  seq: number;
  kind: ApprovalKind;
  tier: ToolTier | null;
  status: ApprovalStatus;
  summary: string;
  fullParams: unknown;
  reason: string;
  riskBrief?: PrecheckBrief;
  expiresAt: string;
  remindedAt?: string;
  taskRef: GovCtx['taskRef'];
  subject?: SyntheticSubject;
}

export interface PrecheckBrief {
  verdict?: 'safe' | 'risky';
  kind?: string;
  reason?: string;
  [k: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// §5 执行面（EX）
// ═══════════════════════════════════════════════════════════════════

/**
 * EX §5.3 宿主↔容器协议 ToolCall（与 GOV 的 ToolCall 是两份不同形状，勿混）：
 * - 本份是**发给容器的执行协议**，call_id 由控制面 journal 生成，全局唯一，幂等键；
 * - GOV §3.1 的 ToolCall 是**治理判定入参**（callId/tool/params/tierHint）。
 * 契约 J1：两者 call_id == callId == exec_calls.call_id == model_call_log.attempt_id。
 */
export interface ExecToolCall {
  call_id: string;
  task_id: string;
  dot_id: string;
  /** 契约 G1：顶层 identity（'anon'/null=非登录态；缺失=fail-closed 按登录态）。 */
  identity?: string;
  /** 契约 M5：11 名工具词表。 */
  tool: ToolName;
  args: Record<string, unknown>;
  deadline_ms: number;
  issued_at: string;
}

export type ToolName =
  | 'fs.read'
  | 'fs.write'
  | 'fs.list'
  | 'fs.stat'
  | 'shell.run'
  | 'browser.open'
  | 'browser.act'
  | 'browser.snapshot'
  | 'browser.close'
  | 'net.get'
  | 'net.post';

/**
 * 契约外工具的**网关名**（P2-1）。
 *
 * 刻意不并进 `ToolName`：那 11 个名字是 AGENT↔容器 的逐字契约（两份 protocol.ts
 * 同形，有防漂移测试）。`mcp.call` 是**宿主侧**的扩展点网关——它不进容器、
 * 目录由 `mcp_servers` 配置决定是否出现，因此单独成类型。
 */
export type GatewayToolName = 'mcp.call';

/** 一次 exec 调用能出现的全部工具名（契约 11 名 + 网关）。 */
export type ExecToolName = ToolName | GatewayToolName;

export interface ExecToolResult {
  call_id: string;
  job_id?: string;
  status: 'ok' | 'error' | 'cancelled' | 'running';
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  usage?: { wall_ms: number; peak_mem_mb: number };
  finished_at?: string;
}

/** EX §10 Capability + 契约 J2 增字段 sideEffect。 */
export interface Capability {
  name: string;
  mode: 'sync' | 'async';
  max_deadline_ms: number;
  args_schema: object;
  /** J2：未声明按 unknown 安全默认；journal 崩溃恢复分流唯一依据。 */
  sideEffect: SideEffect;
}

/** 契约 J5：EX 新增 getContainerStats。hasInflightCall 判据 = exec_calls.state IN ('sent','running')。 */
export interface ContainerStats {
  memMb: number;
  hasInflightCall: boolean;
}

export interface DotExecStatus {
  dotId: string;
  state: string;
  resources: { memMb: number; cpuMillis: number };
  browser: { running: boolean; contexts: number };
  disk: { usedMb: number; capMb: number };
}

// ═══════════════════════════════════════════════════════════════════
// §6 记忆（MEM）
// ═══════════════════════════════════════════════════════════════════

export type MemoryArea = 'memory' | 'notes' | 'manuals' | 'archive';
export type HomeRelPath = string;
export type ThreadChannel = 'web' | 'telegram' | 'feishu' | 'cli' | 'email' | 'event' | 'heartbeat';
export type ThreadStatus = 'active' | 'idle' | 'sealed' | 'purged';
export type MsgRole = 'user' | 'assistant' | 'system';
export type MsgKind =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_verdict'
  | 'task_start'
  | 'task_end'
  | 'memory_note'
  | 'system_error';

export interface Message {
  id: string;
  threadId: string;
  seq: number;
  role: MsgRole;
  kind: MsgKind;
  content: string;
  taskId?: string;
  eventId?: string;
  tokenEst: number;
  createdAt: number;
}

/**
 * MEM §1 mem_threads 行投影（session ≡ thread，契约 M1）。
 * 追加原因：packSessionReplay（inject.ts）与 loadThreadRow 需要整行投影，
 * 而契约此前只登记了 ThreadSummary（列表最小投影）。
 */
export interface Thread {
  id: string;
  dotId: string;
  channel: ThreadChannel;
  externalRef: string | null;
  title: string | null;
  /** event/heartbeat 幂等锚（一个事件任务一个 thread）。 */
  originTaskId: string | null;
  status: ThreadStatus;
  /** 主人 keep（§6.1）：永不自动封存/删除。 */
  pinned: boolean;
  contextSummary: string | null;
  contextSummaryUptoSeq: number;
  lastActiveAt: number;
  /** sealTask 写入 = 封存/断点扫描锚（§4.3、§6.1）。 */
  lastTaskFinishedAt: number | null;
  createdAt: number;
}

export interface ContextBundle {
  memoryMd: string;
  manualExcerpts: Array<{ path: HomeRelPath; text: string }>;
  summary: string | null;
  recentMessages: Message[];
  usedTokens: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  warning?: string;
  error?:
    | 'HARD_LIMIT'
    | 'NOTES_COUNT_LIMIT'
    | 'HOME_CAPACITY'
    | 'READONLY_PHASE'
    /** 路径越出 /dot/home（与执行面 fs.read 的 path_outside_home 同语义，2026-10-18 统一）。 */
    | 'PATH_OUTSIDE_HOME';
}

/** MEM §5.1 CompactionJobSpec（经 §4.5 通道投递 = submit + payloadJson）。 */
export interface CompactionJobSpec {
  jobId: string;
  kind: 'memory-compaction' | 'memory-summarize';
  dotId: string;
  threadId?: string;
  triggers: string[];
  dryRun: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// §7 交互面（SF）
// ═══════════════════════════════════════════════════════════════════

/** SF §4.6 RawInbound（source 与 CP events.source CHECK 逐字一致）。 */
export interface RawInbound {
  source: 'http' | 'file' | 'heartbeat' | 'telegram';
  dotId: string;
  text?: string;
  payload: unknown;
  dedupKey?: string;
  actor: string;
}

/** SF §5.7 NotificationChannels（MR 注入用；阶段一 channels 传 null）。 */
export interface NotificationChannels {
  deliver(channel: 'telegram' | 'feishu' | 'email', text: string): Promise<{ ok: boolean; error?: string }>;
  available(channel: 'telegram' | 'feishu' | 'email'): boolean;
}

/** 契约 T4：求救适配器成立；notifySOS/notifyRecovery 作废。 */

/**
 * 交互面（SF）转调的治理端口（契约 S-2：唯一裁决写路径在 GOV `decide()`）。
 * 形状照 governance.md:340 `decide(approvalId, channel, verdict, actor, note?)` 与
 * governance.md:440-441 `listPending()`/`getApproval()` 登记；实现归 GOV，
 * SF 的 HTTP/TG/CLI 只是通道适配层（任何情况下不 UPDATE approvals）。
 */
export interface GovernancePort {
  decide(
    approvalId: number,
    channel: 'web' | 'telegram' | 'cli',
    verdict: Verdict,
    actor: string,
    note?: string,
  ): Promise<{ ok: boolean; finalStatus?: ApprovalStatus; reason?: string }>;
  listPending(limit?: number): ApprovalView[];
  getApproval(idOrSeq: number): Promise<ApprovalView | null>;
}

/**
 * 交互面（SF）转调的记忆端口（契约 S-1：会话历史属主 = MEM，
 * SF 原 §2.0"会话历史→CP 属主"一句已作废）。
 * `POST /api/messages` 时序：openThread → appendMessage → cp.submit({threadId, priority:1})；
 * `GET /api/conversations` 经 listThreads/listMessages 读（MEM §8 接口）。
 */
export interface MemoryPort {
  openThread(
    dotId: string,
    channel: ThreadChannel,
    opts?: { externalRef?: string; title?: string; originTaskId?: string },
  ): Promise<string>;
  appendMessage(
    threadId: string,
    msg: { role: MsgRole; kind: MsgKind; content: string; taskId?: string; eventId?: string },
  ): Promise<{ id: string; seq: number }>;
  listThreads(
    dotId: string,
    opts: { status?: ThreadStatus; limit: number; cursor?: string },
  ): Promise<ThreadSummary[]>;
  listMessages(threadId: string, opts: { beforeSeq?: number; limit: number }): Promise<Message[]>;
}

/** MEM §8 listThreads 的最小投影（SF /api/conversations 只展示这些字段）。 */
export interface ThreadSummary {
  id: string;
  title: string | null;
  channel: ThreadChannel;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * 交互面（SF）转调的路由端口（SF §5.2 `GET /api/breaker` / `/api/models/rank`）。
 * 契约 T1：熔断状态查询走 `snapshot()`（CP 摘要 `breakerState()` 已作废）。
 */
export interface RouterPort {
  snapshot(): RouterSnapshot;
}

// ═══════════════════════════════════════════════════════════════════
// §9 Runner 依赖面（src/runner/dot.ts 主循环只 import 这些接口）
// ═══════════════════════════════════════════════════════════════════

/**
 * Runner 视角的 ModelRouter（MR §5.1 进程内 API 的跨模块投影）。
 * 主循环调 `complete()`（契约 T1：作废 completeMain；track:'primary'）；
 * `snapshot()`/`emergencyActive` 供治理应急判定与任务挂起判据读取。
 */
export interface ModelRouterApi {
  complete(req: RouteRequest): Promise<RouteResult>;
  /**
   * 流式（§4.7）：正文增量经异步迭代器下发；**工具调用**在回合结束后经 `toolCalls()`
   * 以成品形状交回（与 `ChatResponse.toolCalls` 同形），调用方须**等流读完**再读它。
   */
  stream(req: RouteRequest): AsyncIterable<ChatChunk> & {
    meta(): Promise<RouteMeta>;
    toolCalls(): Array<{ id: string; name: string; arguments: string }>;
  };
  trackForEvent(eventType: string): Track;
  /**
   * 按请求形状判轨道（2026-10-17 起，迁移自 PilotDeck 的 difficulty judge）。
   * 判据只认形状：带 tools → complex → 必 primary（light 轨端点无工具能力）。
   * 可选方法——未装配该方法的旧 daemon 上 `?.()` 即得 undefined，调用方回落
   * `trackForEvent`/默认轨。
   */
  trackForRequest?(req: {
    tools?: readonly ToolSpec[] | undefined;
    toolChoice?: RouteRequest['tool_choice'];
    messages: readonly ChatMessage[];
  }): Track;
  snapshot(): RouterSnapshot;
  readonly emergencyActive: boolean;
}

/**
 * Runner 视角的 ExecService（EX §10 的跨模块投影，只登记主循环用到的）。
 * `getCapabilities` = 工具 sideEffect 词表唯一事实源（契约 J2：CP 不维护第二注册表）。
 */
export interface ExecServiceApi {
  runTool(call: ExecToolCall): Promise<ExecToolResult>;
  getCapabilities(dotId: string): Promise<Capability[]>;
  reconcileCall(callId: string): Promise<'done' | 'aborted' | 'unknown' | 'unknown_host'>;
  getCallResult(callId: string): Promise<unknown>;
  cancelTool(callId: string, reason: string): Promise<void>;
}

/**
 * Runner 视角的 MemoryService（MEM §8 的跨模块投影）。
 * 契约 M3：WRITE-SEAL 全覆盖——Runner 在三种终态收口点都调 `sealTask`；
 * 契约 M1：恢复重建唯一入口 = `buildSessionReplay`（MEM `load()` 降为内部低层）。
 */
export interface MemoryServiceApi {
  openThread(
    dotId: string,
    channel: ThreadChannel,
    opts?: { externalRef?: string; title?: string; originTaskId?: string },
  ): Promise<string>;
  appendMessage(
    threadId: string,
    msg: { role: MsgRole; kind: MsgKind; content: string; taskId?: string; eventId?: string },
  ): Promise<{ id: string; seq: number }>;
  appendSystemMessage(threadId: string, msg: { kind: MsgKind; content: string }): Promise<{ id: string; seq: number }>;
  buildContextBundle(
    dotId: string,
    taskText: string,
    budgetTokens: number,
    opts?: { threadId?: string; taskId?: string },
  ): Promise<ContextBundle>;
  buildSessionReplay(threadId: string, taskId: string, budgetTokens: number): Promise<Message[]>;
  /**
   * 接缝 M6 / memory.md:457「软限 warning 由 Runner 前置 beforeWrite 检查点附回工具响应」。
   * Runner 在 fs.write 派发前调它拿 MemoryWriteResult；`warning` 附回工具结果给模型，
   * `ok:false`（HARD_LIMIT 等）则不派发、直接把 error 回喂。
   */
  beforeWrite(dotId: string, path: HomeRelPath, content: string): Promise<MemoryWriteResult>;
  sealTask(task: Task, outcome: 'done' | 'failed' | 'cancelled', stopReason?: string): Promise<void>;
  /**
   * P1-4 §4.3「补写一轮」的前置判定：done 且没写过记忆文件 → true。
   * **必须在 cp.finish() 之前问**——sealTask 在 finish 内部被调用时任务已终态，
   * Runner 不可能再发 LLM 请求（老的"假提醒"就死在这里）。只判定、不写库、不抛。
   *
   * 可选（与 `trackForRequest?` 同款理由）：旧装配/测试替身没有它时 Runner
   * 跳过补写轮，行为逐字回到改动之前——而不是让整个 Runner 依赖面变 hard break。
   */
  needsMemoryRedo?(task: Task, outcome: 'done' | 'failed' | 'cancelled'): Promise<boolean>;
  /** §4.3 injectOnce：同一任务已提醒过则不再提醒（跨 attempt 幂等）。可选，缺省视为未提醒。 */
  hasMemoryReminder?(taskId: string): boolean;
  /** 记录"已提醒"（Runner 决定补写时先记账再问）。可选。 */
  markMemoryReminder?(taskId: string, at?: number): void;
  /**
   * P1-2 §4.4：会话摘要触发（够阈值时把 upto_seq 之后的增量压成摘要写回）。
   * 走 MEM 内部注入的 track:'light' seam，Runner 只负责**在收口前**调一次。
   * 可选：旧装配没有它时跳过（行为回到"摘要恒为 null"）。
   */
  refreshContextSummary?(threadId: string): Promise<boolean>;
}

/**
 * Runner 视角的 Governance（GOV §8.1 的跨模块投影）。
 * 契约 J6：`setAwaitingApproval` 由 **Runner** 调（治理不持 epoch）；
 * 接缝 §8 ⑧：deny/ok=false → Runner 调 `journal.skipStep(callId, reason)`。
 * `forceApproval` 承接 CP §5.3 unknown 孤儿步转审批（kind='side_effect_unknown'）。
 */
export interface GovernanceApi {
  /**
   * 接缝 G5：`goalDigest` 由 **Runner** 在 evaluate 前截取（≤800B）注入（不走 GovCtx）。
   * `opts` 透传给治理 `evaluate(ctx, call, opts, rt)`（gate.ts:233 的 EvaluateOpts）；
   * 缺省 = 不传（治理内部 `?? ''`）。
   */
  evaluate(ctx: GovCtx, call: GovToolCall, opts?: { goalDigest?: string }): Promise<Decision>;
  /**
   * 接缝 §8 ⑨「恢复执行一律 claim() 后按 final_params_json+note」的执行前认领。
   * 条件 UPDATE `WHERE status='approved'` 原子认领（GOV §3.3.6）；认领成功即把
   * `final_params_json` 固化并回传（S2：执行不复用内存旧参）。
   */
  claim(approvalId: number): Promise<{
    ok: boolean;
    finalParams?: Record<string, unknown>;
    reason?: string;
    status?: ApprovalStatus;
  }>;
  forceApproval(
    taskId: string,
    req: {
      kind: SyntheticSubject['kind'];
      subject: Record<string, unknown>;
      reason: string;
      ttlMs?: number;
    },
  ): Promise<{ approvalId: number }>;
}

/**
 * GOV §3.1 ToolCall（治理判定入参；与 EX 的 ExecToolCall 是两份不同形状，勿混）。
 *
 * 契约 G1 增补字段 `identity`（追加式，不改动既有字段语义）：
 * 顶层身份，'anon'/null = 非登录态；**缺失 = fail-closed 按登录态**
 * （见 §8 isLoginSensitive）。注入方是 Runner/控制面，模型无法伪造；
 * 磁盘稿的 params.withIdentity / args.with_identity / tools.yml identityParam 全部作废。
 */
export interface GovToolCall {
  callId: string;
  tool: string;
  params: Record<string, unknown>;
  tierHint?: ToolTier;
  /** 契约 G1：顶层身份（'anon'/null=非登录态；缺失=fail-closed 按登录态）。 */
  identity?: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// §8 登录态谓词（契约 G1，唯一落点）
// ═══════════════════════════════════════════════════════════════════

/**
 * 契约 G1 统一谓词（逐字）：
 *   isLoginSensitive(call) = call.tool.startsWith('browser.')
 *                            && call.identity != null
 *                            && call.identity !== 'anon'
 * `identity` 缺失（undefined）且工具为 browser.* → fail-closed 按登录态
 * （decision.reason 记 `identity_missing`）；`null` 与 `'anon'` 同义 = 非登录态
 * （接缝契约 G1：「未登录浏览的表示法 = identity:'anon' 或 null」）。
 * 作废：params.withIdentity、args.with_identity、tools.yml identityParam、loginSensitive 静态标记。
 */
export function isLoginSensitive(call: {
  tool: string;
  identity?: string | null;
}): boolean {
  if (!call.tool.startsWith('browser.')) return false;
  if (call.identity === undefined) return true; // 缺失 fail-closed（≠ null：null 显式表示未登录）
  return call.identity !== null && call.identity !== 'anon';
}

// ═══════════════════════════════════════════════════════════════════
// §9 执行面容器完整服务面（EX §10 全量投影，追加式）
// ═══════════════════════════════════════════════════════════════════

/**
 * `ExecServiceApi`（§7，Runner 视角）之外的**其余调用方**需要的 EX 服务面：
 *  - 控制面（CP）：容器生命周期（boot/reconcile/recreate/suspend/destroy）+ 状态查询；
 *  - 治理（GOV）：`setEgressWhitelist`（§2.1-2 出网白名单）+ `pauseContainer`（J5）；
 *  - 记忆（MEM）：契约 S4'/M4 的 `fsOps` 桥（注入读取/索引对账/原子写，仅宿主 token 可调）。
 *
 * 追加式新增（2026-10-15）：不改 §7 `ExecServiceApi` 与任何既有签名语义。
 * 容器状态机 16 态的词表见 `DOT_CONTAINER_STATES`（EX §4.1，逐字）。
 */
export const DOT_CONTAINER_STATES = [
  'absent',
  'image_ready',
  'created',
  'booting',
  'ready',
  'busy',
  'idle',
  'suspended',
  'idle_stop_requested',
  'stopped',
  'quarantined',
  'unhealthy',
  'create_failed',
  'build_failed',
  'removed',
  'lost',
] as const;

/** 契约 D4：EX 自有表清单（模块边界铁律的机器可读投影）。 */
export const EXEC_OWNED_TABLES = [
  'exec_dots',
  'image_builds',
  'containers',
  'exec_identities',
  'exec_volumes',
  'exec_calls',
  'exec_disk_policy',
] as const;

/** 容器状态（`DOT_CONTAINER_STATES` 的元素类型）。 */
export type DotContainerState = (typeof DOT_CONTAINER_STATES)[number];

/** 一次 boot 的结果（EX §13.1）。 */
export interface BootReport {
  /** docker ping 是否可用（false ⇒ degraded，未做任何容器动作）。 */
  dockerAvailable: boolean;
  /** 本次 boot 实际创建的 dot 列表。 */
  created: string[];
  /** 状态未变化的 dot（已 ready 等）。 */
  adopted: string[];
  /** 走 recreate 的 dot（lost/unhealthy/exited 等）。 */
  recreated: string[];
  /** boot 内对缺失容器 create/boot 失败的 dot → 原因。 */
  failed: Array<{ dotId: string; reason: string }>;
  /** reconcile 阶段对 open calls 的逐条判定。 */
  reconciled: ReconcileEntry[];
  /** SQLite 无账但 docker 侧存在的容器（EX §13.1：只标记 orphan，不擅杀）。 */
  orphans: string[];
  /** boot 内部发生的不影响主流程的告警（如 API 版本漂移）。 */
  warnings: string[];
}

/** 幂等对账条目（EX §5.4-3：reconcileOpenCalls 的逐条判定）。 */
export interface ReconcileEntry {
  callId: string;
  dotId: string;
  /**
   * done = 取回结果（不重派）；doing = 续轮询；interrupted/skipped = 交给 journal 决定重派；
   * result_compacted = §5.4-4：调用确认幂等成功但结果已被压缩（retryable:false，
   * journal 视同 done-但-降级，不得重派）。
   */
  outcome: 'done' | 'doing' | 'interrupted' | 'skipped' | 'result_compacted';
  jobId?: string;
  /** outcome='interrupted'/'skipped' 时的原因。 */
  reason?: string;
  at: string;
}

/** 单个 dot 的执行面快照（CP 状态查询 / SF 面板展示；`DotExecStatus` 的完整投影）。 */
export interface DotStatusSnapshot extends DotExecStatus {
  endpoint: string | null;
  inflight: number;
  lastHealthAt: string | null;
  recreateCount: number;
  profileCount: number;
  volumes: Array<{ name: string; kind: string; quotaMb: number; usageMb: number | null }>;
}

/** fsOps 请求（契约 S4'/M4：host-side 桥，仅宿主 token 可调）。 */
export interface FsOpsRequest {
  op: 'read' | 'list' | 'stat' | 'rename';
  path: string;
  target?: string;
  /** 对账透传（容器不理解；ExecService.fsOps 的 dotId 参数会覆盖它）。 */
  dotId?: string;
}

/**
 * fsOps 响应（契约 S4'/M4；形状与容器侧 `agent-runtime/fs.ts` 的 fsOpsOk 逐字对齐，
 * size/sizeBytes、mtime/mtimeMs 双写，使 MEM 的 `src/memory/fsops-client.ts`
 * 无论走本桥还是直连容器 agent-runtime 都读到同一形状）。
 */
export interface FsOpsResponse {
  op: FsOpsRequest['op'];
  ok: boolean;
  content?: string;
  encoding?: 'utf8' | 'base64';
  /** op='list'：目录项（path 为 home 相对路径；mtime/mtimeMs 双写供 MEM 索引对账）。 */
  entries?: Array<{
    name: string;
    path?: string;
    type: 'file' | 'dir' | 'other';
    size?: number;
    sizeBytes?: number;
    mtime?: string;
    mtimeMs?: number;
  }>;
  /** op='stat'：嵌套对象（MEM 读 stat.sizeBytes / stat.mtimeMs / stat.isDir）。 */
  stat?: {
    path?: string;
    type: 'file' | 'dir' | 'other';
    size?: number;
    sizeBytes?: number;
    mtime?: string;
    mtimeMs?: number;
    isDir?: boolean;
  };
  /** op='rename'：目标路径回显。 */
  target?: string;
  error?: { code: string; message: string };
}

/**
 * ExecService 完整面（CP/GOV/MEM 视角）。
 * 实现 = `src/exec/ExecService.ts` 的 `ExecServiceImpl`；stub 形态见 CONVENTIONS §7。
 */
export interface ExecService {
  // —— 生命周期（EX §13.1/§13.2，契约 J4 由 CP 的 registerInternalJob 驱动）——
  boot(dotIds: string[]): Promise<BootReport>;
  reconcileCall(callId: string): Promise<ReconcileEntry>;
  recreateContainer(dotId: string): Promise<void>;
  suspendDot(dotId: string): Promise<void>;
  resumeDot(dotId: string): Promise<void>;
  destroyDotContainer(dotId: string, opts?: { keepVolumes?: boolean }): Promise<void>;

  // —— 状态与资源（契约 J5）——
  getDotStatus(dotId: string): Promise<DotStatusSnapshot>;
  getContainerStats(dotId: string): Promise<ContainerStats>;
  pauseContainer(dotId: string): Promise<void>;
  unpauseContainer(dotId: string): Promise<void>;

  // —— 身份与网络 ——
  setIdentityProfile(dotId: string, identityKey: string): Promise<{ profileHash: string }>;
  setEgressWhitelist(ports: number[]): Promise<void>;

  // —— MEM 注入桥（契约 S4'/M4）——
  fsOps(dotId: string, req: FsOpsRequest): Promise<FsOpsResponse>;

  // —— §7 ExecServiceApi 的成员（同签名，此处合流便于单一依赖点）——
  runTool(call: ExecToolCall): Promise<ExecToolResult>;
  getCapabilities(dotId: string): Promise<Capability[]>;
  getCallResult(callId: string): Promise<unknown>;
  cancelTool(callId: string, reason: string): Promise<void>;
}
