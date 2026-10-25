/**
 * src/control-plane/types.ts —— 控制面私有类型 + 配置 + 事务 helper。
 *
 * 铁律（CONVENTIONS.md §6）：跨模块可见的类型一律 import src/shared/contracts.ts，
 * 本文件只放控制面**私有**的类型与工具函数。
 *
 * 依据（control-plane.md，下称 CP）：
 * - CP §2.2 并发额度与 epoch 围栏：pop 转 running 时 run_epoch+1，Runner 所有回写带 epoch；
 *   UPDATE `WHERE task_id=? AND run_epoch=?` 受影响行数 0 → 迟到/僵尸 Runner，拒绝并记
 *   resource_events(kind='stale_writer')。
 * - CP §4.1 三条硬门控：进 running 只经 pop()；paused/awaiting_approval 不占 runningCount；
 *   resolveOpenStep 只处理 status='started' 的孤儿步（pending=待审批，不是孤儿）。
 * - CP §5.4 journal 大小控制：args/result >32KB 截断为 `@blob:journal-blobs/<task>.<seq>.json`；
 *   单任务步数软上限 500（warning）/硬上限 2000 → failed(stop_reason='budget')。
 * - CP §6.3 内存水位四级背压：首启自动基线标定 + 兜底固定值 + 滞回。
 * - CP §6.4 token 预算执行主体 = Runner + heartbeat 返回位：usage≥budget 置 budget_exhausted=1，
 *   heartbeat 返回 overBudget:true；usage≥1.2×budget 看门狗旁路 abort（kind='budget'）。
 * - 契约 J4：registerInternalJob 是全系统周期任务唯一宿主。
 */

import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  EventDecision,
  SideEffect,
  Step,
  StepKind,
  StepStatus,
  StopReason,
  Task,
  TaskStatus,
} from '../shared/contracts.ts';

// ── 1. 私有行类型（DB 行投影；跨模块可见的 Task/Step/EventDecision 已在 contracts.ts）───

/**
 * tasks 表行（snake_case 原样；契约 E2 的 payload_json 也在内）。
 * 转成跨模块形状用 types.ts:toTask（剔除 payload_json）。
 */
export interface TaskRow {
  id: string;
  dot_id: string;
  title: string;
  goal: string;
  payload_json: string | null;
  status: TaskStatus;
  priority: number;
  run_at: number | null;
  source_event_id: number | null;
  session_id: string | null;
  thread_id: string | null;
  attempt: number;
  max_attempts: number;
  run_epoch: number;
  last_heartbeat_at: number | null;
  resume_from_seq: number | null;
  stop_reason: StopReason | null;
  budget_tokens: number;
  usage_tokens: number;
  budget_exhausted: number;
  created_at: number;
  updated_at: number;
}

/** steps 表行（snake_case；contracts.ts:Step 是 camelCase 投影，映射见 toStep）。 */
export interface StepRow {
  task_id: string;
  seq: number;
  kind: StepKind;
  status: StepStatus;
  call_id: string | null;
  tool_name: string | null;
  args_json: string | null;
  result_json: string | null;
  side_effect: SideEffect | null;
  run_epoch: number;
  approval_id: number | null;
  started_at: number;
  finished_at: number | null;
}

/** resource_events.kind 词表（CP §3.1.4；跨模块形状在 contracts.ts:ResourceEventRow）。 */
export type ResourceEventKind =
  | 'watermark'
  | 'container_pause'
  | 'container_unpause'
  | 'container_kill'
  | 'queue_evict'
  | 'disk_gc'
  | 'stale_writer'
  | 'watchdog'
  | 'budget';

/** 资源事件档位（= GuardLevel 的词表；CP §6.3 四级）。 */
export type ResourceEventLevel = 'normal' | 'guarded' | 'throttled' | 'halted';

/** resource_events 表行（snake_case；契约形状在 contracts.ts:ResourceEventRow）。 */
export interface ResourceEventRow {
  id: number;
  ts: number;
  level: ResourceEventLevel;
  kind: ResourceEventKind;
  detail: string;
}

/** event_decisions 表行（含 contracts.ts 未承载的 id）。 */
export interface EventDecisionRow extends EventDecision {
  /** 自增主键（event_id 是 events.id，非本表主键；UPSERT 需要行号）。 */
  id: number;
}

/** events 表行（跨模块形状在 contracts.ts:EventsRow，这里只做 DB 读出的类型断言用）。 */
export interface EventRow {
  id: number;
  source: 'http' | 'file' | 'heartbeat' | 'telegram' | 'email';
  dot_id: string;
  actor: string;
  dedup_key: string | null;
  payload: string;
  status: 'pending' | 'matched' | 'ignored' | 'inbox';
  received_at: number;
}

/** crontabs 表行（契约 H1：单表归 CP，原 surf_heartbeat_state 行为扩展列并入）。 */
export interface CrontabRow {
  id: string;
  dot_id: string;
  title: string;
  prompt: string;
  cron: string;
  enabled: number;
  next_fire: number;
  last_fired_at: number | null;
  last_fire_seq: number;
  last_fire_status: string | null;
  skip_if_busy: number;
  quiet_hours: string | null;
  catchup: 'latest' | 'skip';
  /** 一次性任务（迁移 150）：1 = 触发成功后自动停用，不再重复。 */
  once: number;
  /**
   * 主动推送开关（迁移 170，T4）。0 = 任务照跑，但结果不推给主人。
   *
   * **和 quiet_hours 的区别必须记住**：
   *   quiet_hours 命中 → 任务**不执行**（scheduler advance 掉，标 skipped_quiet）
   *   proactive=0     → 任务**照常执行**，只是结果不推送
   * 后者不可省：有些定时任务的价值在副作用（写文件、更新记忆），
   * 结果本身不值得打扰主人。把两者并成一个开关，"安静"就变成了"不干活"。
   */
  proactive: number;
  /** 同一任务两次主动推送的最小间隔小时数（迁移 170）。0 = 不节流。 */
  throttle_hours: number;
  /** 上次真推出去的时刻（epoch ms，迁移 170）。NULL = 从没推过。 */
  last_push_at: number | null;
}

// ── 2. 配置（config/dotd.yml 的 CP 侧投影）────────────────────────────────

export interface ControlPlaneConfig {
  /**
   * 并发额度（CP §2.2）。**默认 1 = 严格串行**，与既有行为逐字相同。
   *
   * P1-1：允许 >1，但必须由装配层显式声明（`config/dotd.yml` 或 `DOTD_MAX_RUNNING`），
   * 不得改默认值——默认值突然变大会让所有人在没要求的情况下改变行为（多任务并行
   * 意味着更多容器/端点压力、更难排查的交叉失败）。见 `truthyEnv` 与 daemon 装配。
   */
  maxRunningTasks: number;
  /**
   * P1-1：为主人对话（priority=1，`dotd ask` / 飞书 / web 消息）**预留**的额外名额。
   *
   * 语义：额度满时，只要有 interactive 任务在排队，就允许它额外进入，最多超过
   * `maxRunningTasks` 这么多条。**默认 0 = 不预留**（行为与改动前逐字相同）。
   *
   * 为什么需要它（而不是只靠优先级排序）：`pop()` 在额度满时会直接返回 null，
   * **根本走不到"看队列里有没有 interactive"那一步**——优先级只在有空位时才有意义。
   * 所以必须有一个"满额时仍可放行 interactive"的通道。
   */
  interactiveReserve: number;
  /**
   * P1-1：可被 interactive 抢占的优先级阈值（含）。
   *
   * 语义：额度满、且预留格已用完时，若队列里有 interactive 任务，且 running 中存在
   * priority >= 本值的任务（默认 5 = heartbeat/hook 这类后台任务），就抢占**最晚开始**
   * 的那一条：把它退回 queued（**attempt 不变、不记失败**），让出名额给对话。
   * 填 0 = 关闭抢占（只靠 interactiveReserve）。
   *
   * 默认 5：与 `PRIORITY_MAP` 的后台档一致（interactive=1 / heartbeat·hook=5 / bulk=7）。
   * bulk(7) 同样可被抢占；重任务不会被抢占（priority < 5 的按重要性处理）。
   */
  preemptiblePriority: number;
  /** 队列上限（CP §4.4：maxQueued=200）。 */
  maxQueued: number;
  /** 心跳超时（CP §4.1 看门狗：running 且 now-last_heartbeat_at > 该值即 reclaim）。 */
  heartbeatTimeoutMs: number;
  /** 优雅关停宽限（CP §2.1：shutdownGraceMs=30s）。 */
  shutdownGraceMs: number;
  /** scheduler 主 tick（CP §2.1：1s）。 */
  tickMs: number;
  /** journal 单值截断阈值（CP §5.4：32KB）。 */
  journalBlobMaxBytes: number;
  /** journal-blobs 目录（相对 dataDir 的键名见 makeBlobPath）。 */
  blobDir: string;
  /** 单任务步数软上限（CP §5.4：500，warning）。 */
  stepSoftLimit: number;
  /** 单任务步数硬上限（CP §5.4：2000 → failed(budget)）。 */
  stepHardLimit: number;
  /** 预算硬兜底倍数（CP §6.4：usage≥1.2×budget 时看门狗旁路 abort）。 */
  budgetHardFactor: number;
  /** 默认 token 预算（tasks DDL DEFAULT 200000，CP §3.1.1）。 */
  budgetTokensDefault: number;
  /** 内存水位预留（config/dotd.yml：dotdReserveMb 默认 6144）。 */
  dotdReserveMb: number;
  /** 兜底固定水位线（CP §6.3，未标定前）：normal/guarded/throttled 的 MB 阈值。 */
  fallbackThresholds: { normalMb: number; guardedMb: number; throttledMb: number };
  /** 自动基线标定采样时长（CP §6.3：30min）。 */
  calibrateMs: number;
  /** 磁盘回收：dotd.db 软上限（CP §3：500MB）。 */
  dbSoftLimitMb: number;
  /** 磁盘回收：终态保留天数（CP §6.5：30 天）。 */
  gcTerminalDays: number;
  /** 磁盘回收：tasks 骨架保留天数（CP §6.5：180 天）。 */
  gcTaskDays: number;
  /** 每日 GC 的本地时刻（CP §6.5：04:00）。 */
  gcDailyAt: string;
  /** daemon 自身 RSS 软上限 MB（CP §6.3：daemonRssMaxMb=1024）。 */
  daemonRssMaxMb: number;
  /**
   * 低水位把队列钉住多久算"异常"（毫秒，默认 5 分钟）。
   *
   * 只影响**观测**：连续这么久处于 throttled/halted 且队列非空时，Guard 记一条
   * `resource_events(kind='watermark_stuck')`（每窗口最多一次）。默认值让
   * "真内存紧张"和"阈值配错"都能在日志/Web 上直接看见，不用再靠人守着 queue 快照
   * （2026-10-24 真机踩过 30 分钟静默卡死）。
   */
  watermarkStuckAlertMs: number;
  /**
   * 水位 throttled 时是否仍放行**一条交互任务**（默认 false = 严格保护）。
   *
   * 为什么默认关：throttled 会 `pause` 容器（CP §6.3），放行的任务照样调不动工具，
   * 只会多一条失败记录；而且标定修好之后 throttled 是**真**内存紧张，不该硬跑。
   * 它存在是为了"机器长期低于基线、但主人仍想让它答一句"的场景，
   * 由 `DOTD_INTERACTIVE_UNDER_PRESSURE=1` 显式打开。
   */
  allowInteractiveWhenThrottled: boolean;
}

/** 默认值逐条对应 config/dotd.yml 的键与 CP 正文数值。 */
export const DEFAULT_CP_CONFIG: ControlPlaneConfig = {
  maxRunningTasks: 1,
  /** P1-1：默认不预留、不抢占——与既有行为逐字相同。 */
  interactiveReserve: 0,
  preemptiblePriority: 0,
  maxQueued: 200,
  heartbeatTimeoutMs: 180_000,
  shutdownGraceMs: 30_000,
  tickMs: 1_000,
  journalBlobMaxBytes: 32 * 1024,
  blobDir: 'journal-blobs',
  stepSoftLimit: 500,
  stepHardLimit: 2_000,
  budgetHardFactor: 1.2,
  budgetTokensDefault: 200_000,
  dotdReserveMb: 6144,
  fallbackThresholds: { normalMb: 10 * 1024, guardedMb: 6 * 1024, throttledMb: 3 * 1024 },
  calibrateMs: 30 * 60 * 1000,
  dbSoftLimitMb: 500,
  gcTerminalDays: 30,
  gcTaskDays: 180,
  gcDailyAt: '04:00',
  daemonRssMaxMb: 1024,
  watermarkStuckAlertMs: 5 * 60_000,
  allowInteractiveWhenThrottled: false,
};

/** CP §5.4：args/result >32KB 时的 blob 引用前缀（契约 D6 目录树）。 */
export const BLOB_PREFIX = '@blob:journal-blobs/';

// ── 3. 事务 helper（node:sqlite 同步 API）─────────────────────────────────

/**
 * 同步事务。node:sqlite 的 DatabaseSync 没有 `db.transaction()` 包装器
 * （CONVENTIONS.md §2：API 是同步的 prepare().get()/.all()/.run()、exec()），
 * 这里按 better-sqlite3 的语义补一个：BEGIN IMMEDIATE … COMMIT / ROLLBACK。
 *
 * CP §4.2 要求 pop 是"单写者事务 + 围栏递增"，且明写 `BEGIN IMMEDIATE` 使未来任何
 * 第二个写进程与 pop 串行化；CP §6.1 的"建任务+写 event_decisions 同一
 * BEGIN IMMEDIATE 事务"同样落在这里。
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已由 SQLite 自动回滚时忽略
    }
    throw err;
  }
}

// ── 4. blob 落盘（CP §5.4 journal 大小控制）────────────────────────────────

/**
 * 把超限的 args/result 写到 `<blobDir>/<taskId>.<seq>.json`，返回引用串
 * `@blob:journal-blobs/<taskId>.<seq>.json`。
 *
 * CP §3：磁盘上限（CT:37）——`steps.args_json/result_json` 单值截断 32KB，
 * 超出落 journal-blobs/<task_id>.<seq>.json（≤500MB）。
 */
export function writeJournalBlob(
  blobDir: string,
  taskId: string,
  seq: number,
  value: string,
): string {
  const file = join(blobDir, `${taskId}.${seq}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf8');
  return `${BLOB_PREFIX}${taskId}.${seq}.json`;
}

// ── 5. 常量：状态机与转移表 ──────────────────────────────────────────────

/** CP §4.1：非终态集合（占 runningCount 的只有 running；其余两个是可再入态）。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

/** CP §4.1 状态机：合法转移（非法转移在 transition() 硬校验 throw）。 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_approval', 'paused', 'done', 'failed', 'queued'],
  awaiting_approval: ['queued', 'running', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

/** CP §4.4：merge 目标集——仅非终态任务。 */
export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ── 6. 行 → 接口对象映射 ────────────────────────────────────────────────

/** TaskRow（snake_case）→ contracts.ts:Task（camelCase）。 */
export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    dotId: row.dot_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    runAt: row.run_at,
    sourceEventId: row.source_event_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    runEpoch: row.run_epoch,
    lastHeartbeatAt: row.last_heartbeat_at,
    budgetTokens: row.budget_tokens,
    usageTokens: row.usage_tokens,
    resumeFromSeq: row.resume_from_seq,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * StepRow（snake_case）→ contracts.ts:Step（camelCase）。
 * journal.ts/queue.ts 的 SELECT * 读出的是 DB 行，经这里转成跨模块形状；
 * 跨模块引用一步一律 call_id（契约 J1-1），(task_id,seq) 不外泄。
 */
export function toStep(row: StepRow): Step {
  return {
    taskId: row.task_id,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    callId: row.call_id,
    toolName: row.tool_name,
    argsJson: row.args_json,
    resultJson: row.result_json,
    sideEffect: row.side_effect,
    runEpoch: row.run_epoch,
    approvalId: row.approval_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
