/**
 * src/memory/types.ts —— 记忆模块（MEM）的类型与对外服务接口。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/ 下磁盘版）：
 * - memory.md §5.1（MemoryArea/HomeRelPath/Message/CompactionJobSpec 已在
 *   src/shared/contracts.ts 登记，本文件不重复定义，只 import）
 * - memory.md §8（MemoryService 接口）：契约 D4「模块属主分文件存放对外服务接口」，
 *   contracts.ts 头注亦如此规定，故 MemoryService 本体落本文件。
 * - memory.md §6.1/§6.2/§6.4（RetentionReport/MemoryStatus/MessageHit 由 §8 返回类型推导）
 * - 接缝契约 M2（回写通道唯一 = ControlPlane.bindSession，MEM 不自行 UPDATE tasks）
 * - 接缝契约 T3（OUTBOX 守门经 MR outboxUnresolvedSignatures()，不开 SELECT 例外）
 *
 * 模块私有类型不放 contracts.ts（契约 §6：跨模块接口一律 shared，模块私有放各自 types.ts）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ContextBundle,
  HomeRelPath,
  MemoryWriteResult,
  Message,
  MsgKind,
  MsgRole,
  Task,
  TaskStatus,
  Thread,
  ThreadChannel,
  ThreadStatus,
} from '../shared/contracts.ts';
import type { FsOpsBridge } from './fsops-client.ts';

// ═══════════════════════════════════════════════════════════════════
// §1 行投影（mem_threads / mem_messages / mem_files_index）
// ═══════════════════════════════════════════════════════════════════

export type { Thread };

/** §8 listThreads 返回行（列表投影，不带正文）。 */
export interface ThreadSummary {
  id: string;
  channel: ThreadChannel;
  title: string | null;
  status: ThreadStatus;
  pinned: boolean;
  lastActiveAt: number;
  lastTaskFinishedAt: number | null;
  messageCount: number;
  hasSummary: boolean;
}

/** §8 searchMessages 命中行（§6.4 埋点的消费面）。 */
export interface MessageHit {
  message: Message;
  /** 命中片段（命中词前后各留上下文，供交互面高亮）。 */
  snippet: string;
}

/** §6.4 检索埋点（mem_maintenance_state.search_stats，滚动 JSON）。 */
export interface SearchStats {
  queries: number;
  zeroHits: number;
  /** 统计窗口起点（14 天窗口，超 64 KB 截旧）。 */
  sinceTs: number;
}

// ═══════════════════════════════════════════════════════════════════
// §2 注入/收口/维护的返回形状（§8 接口推导）
// ═══════════════════════════════════════════════════════════════════

/** §6.1 保留策略报告（心跳 job memory-retention 每日产物）。 */
export interface RetentionReport {
  ranAt: number;
  /** 归档封存的 thread（last_active_at>90d 且 last_task_finished_at>30d）。 */
  threadsSealed: string[];
  /** 事件/心跳 thread 按 7 天 TTL 封存。 */
  threadsSealedByEventTtl: string[];
  /** sealed>365 天整删（含消息；purge_ledger 留指纹）。 */
  threadsDeleted: string[];
  /** §6.3 判定 sealTask 漏调、由 retention 回填 task_end 的任务 id。 */
  orphanTaskEndsBackfilled: string[];
  /** §6.3 判定的漏调 violation（回填前快照）。 */
  sealViolations: string[];
  /** 封存时无摘要、待投递 memory-summarize 的 thread。 */
  summaryDue: string[];
  dbSizeBytes: number;
  dbWalBytes: number;
  /** 超 db 软限时做了 wal_checkpoint(TRUNCATE)。 */
  checkpointed: boolean;
  /** 无 tasks 状态探针（控制面未注入）时无法判定的孤儿任务。 */
  orphansUnknown: string[];
  indexSync: IndexSyncReport | null;
}

/** §6.2 mem_files_index 对账同步报告。 */
export interface IndexSyncReport {
  dotId: string;
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  /** .tmp/ 中 mtime>1 天的残留，经 /fs/ops rename 移入 .archive/tmp-residue/。 */
  tmpResidueMoved: string[];
  errors: string[];
}

/** §6.3 会话断点扫描结果（仅 pending 项交控制面 §7.3 处置）。 */
export interface SessionBreak {
  threadId: string;
  taskId: string | null;
  seq: number;
}

/** §8 status() 汇总输出。 */
export interface MemoryStatus {
  db: {
    sizeBytes: number;
    walBytes: number;
    softLimitBytes: number;
    hardLimitBytes: number;
    level: 'ok' | 'soft' | 'hard';
  };
  home: {
    activeBytes: number;
    softLimitBytes: number;
    hardLimitBytes: number;
    notesCount: number;
    manualsBytes: number;
    indexedFiles: number;
    level: 'ok' | 'soft' | 'hard';
  };
  threads: { active: number; idle: number; sealed: number; purged: number; pinned: number };
  maintenance: {
    retentionLastRun: number | null;
    indexSyncLast: number | null;
    /** 待整理触发项（§3.5 触发条件，非空即应投递 memory-compaction）。 */
    compactTriggers: string[];
    summarizeDue: number;
  };
  searchStats: SearchStats;
  seal: { missed: number; violations: number; backfilled: number };
  feedback: { notes: number; recallMiss: number };
  bridge: { available: boolean; kind: string };
}

/** §5.2 检查点 2 的原子写计划（tmp+rename；write 本身由工具层 fs.write 执行）。 */
export interface AtomicWritePlan extends MemoryWriteResult {
  /** `.tmp/<ulid>.md`（工具层 fs.write 目标）。 */
  tmpPath?: HomeRelPath;
  /** 规范路径（commitAtomicWrite 的 rename 目标）。 */
  finalPath?: HomeRelPath;
}

/** §6.4 升级判据的检索信号窗口。 */
export interface SearchSignal {
  stats: SearchStats;
  zeroHitRate: number;
  /** ②「上下文明明有但答不出」类纠错条数（retention 周报消费）。 */
  recallMissNotes: number;
}

// ═══════════════════════════════════════════════════════════════════
// §3 sealTask 入参（契约 Task 无 newManualIds，模块内扩展不改契约语义）
// ═══════════════════════════════════════════════════════════════════

/**
 * sealTask 的 task 入参。契约 Task（contracts.ts）没有 newManualIds 字段，
 * §4.3 伪码 `touchManualsLastUsed(task.newManualIds)` 需要它；按「不改既有签名语义」
 * 的约定在模块内扩展为可选字段，控制面不传时退化为空列表。
 */
export interface SealTaskInput extends Task {
  /** 本次任务新写/更新的 manuals home 相对路径（§4.3 touchManualsLastUsed）。 */
  newManualIds?: HomeRelPath[];
}

// ═══════════════════════════════════════════════════════════════════
// §4 依赖注入（跨模块 seam，一律走接口，不 import 他人实现）
// ═══════════════════════════════════════════════════════════════════

/**
 * tasks 状态探针（契约 D4：读别人的表一律走对方服务接口——此处即
 * ControlPlane.getTask(id)?.status）。缺省 = 无探针，§6.3 断点扫描只能记
 * orphansUnknown，不猜测、不直读 tasks 表。
 */
export type TaskStatusProbe = (taskId: string) => TaskStatus | null | undefined;

/**
 * journal 探针（§4.3 `anyMemoryFileTouchedSince`）：返回任务开始后命中
 * /dot/home 规范路径的 fs.write/shell.run 步记录路径列表。真源在控制面
 * journal（steps 表），本模块不直读。
 */
export type JournalMemoryProbe = (
  taskId: string,
  sinceMs: number,
) => string[] | Promise<string[]>;

/** 契约 T3：MR 只读方法 outboxUnresolvedSignatures() 的注入形状。 */
export type UnresolvedSignatureProbe = () => string[] | Promise<string[]>;

/**
 * home 写原语（§4.2 骨架补建落盘）。返回 false = 没写成（调用方不报错，
 * 只是这一轮没有骨架，注入侧照旧降级）。
 */
export type HomeWriter = (
  dotId: string,
  path: HomeRelPath,
  content: string,
) => Promise<boolean> | boolean;

export interface MemoryDeps {
  /** 全 daemon 共享的唯一连接（契约 D2；由装配层 openDb→migrate 后传入）。 */
  db: DatabaseSync;
  /** §7 S4' /fs/ops 桥客户端；缺省/null = 桥不可用（注入降级，不阻塞任务）。 */
  bridge?: FsOpsBridge | null;
  /**
   * home 写原语（首次部署补建 MEMORY.md 骨架用）。
   *
   * 为什么单独开：FsOpsBridge 只读（契约 S4' 只有 read/list/stat/rename），
   * 而落盘必须走工具层的 fs.write（自动建父目录、过沙箱护栏）。注入 null 时
   * 骨架补建自动跳过——读侧降级逻辑不受影响。
   */
  homeWriter?: HomeWriter | null;
  /** 控制面任务状态探针（ControlPlane.getTask 投影；契约 D4）。 */
  taskStatusProbe?: TaskStatusProbe;
  /** 控制面 journal 探针（§4.3 wroteMemory 判据；契约 S6）。 */
  journalMemoryProbe?: JournalMemoryProbe;
  /** 契约 T3：OUTBOX.md 路径（~/.dotd/OUTBOX.md）。 */
  outboxPath?: string;
  /** 契约 T3：未收敛 HELP 块签名（MR outboxUnresolvedSignatures）。 */
  unresolvedSignatures?: UnresolvedSignatureProbe;
  /** §6.3 integrity_check 失败时的外部动作（装配层接拒启动/SOS）。 */
  onCorruption?: (error: Error) => void;
  /** 测试注入时钟；缺省 Date.now。 */
  now?: () => number;
}

// ═══════════════════════════════════════════════════════════════════
// §5 对外服务接口（memory.md §8，逐条对齐 + §5.2 两个检查点补充）
// ═══════════════════════════════════════════════════════════════════

export interface LoadResult {
  thread: Thread;
  summary: string | null;
  messages: Message[];
}

export interface AppendMessageInput {
  role: MsgRole;
  kind: MsgKind;
  content: string;
  taskId?: string;
  eventId?: string;
}

export interface OpenThreadOpts {
  externalRef?: string;
  title?: string;
  originTaskId?: string;
}

export interface MemoryService {
  // 线程/会话生命周期（session ≡ thread，§4.1）
  openThread(
    dotId: string,
    channel: ThreadChannel,
    opts?: OpenThreadOpts,
  ): Promise<string>;
  /** = openThread('dot1','event')：Runner 首步建 thread（control-plane.md:555 调用形）。 */
  create(): Promise<string>;
  /** ≡ getThreadWithMessages（control-plane.md:447/555 调用形）。 */
  load(sessionId: string): Promise<LoadResult | null>;
  /** sessions.get 别名。 */
  get(id: string): Promise<LoadResult | null>;
  appendMessage(threadId: string, msg: AppendMessageInput): Promise<{ id: string; seq: number }>;
  /** S7 用（治理审批结果入线）。 */
  appendSystemMessage(
    threadId: string,
    msg: { kind: MsgKind; content: string; taskId?: string },
  ): Promise<{ id: string; seq: number }>;
  sealThread(threadId: string): Promise<void>;
  /** §4.4 回写通道（rev2 补）。 */
  updateContextSummary(threadId: string, summary: string, uptoSeq: number): Promise<void>;

  // 注入与重建（契约 M1：恢复唯一入口 = buildSessionReplay）
  buildContextBundle(
    dotId: string,
    taskText: string,
    budgetTokens: number,
    opts?: { threadId?: string; taskId?: string },
  ): Promise<ContextBundle>;
  buildSessionReplay(threadId: string, taskId: string, budgetTokens: number): Promise<Message[]>;

  // 收口与限额检查点（契约 M3：三种终态全走）
  sealTask(task: SealTaskInput, outcome: 'done' | 'failed' | 'cancelled', stopReason?: string): Promise<void>;
  beforeWrite(dotId: string, path: HomeRelPath, content: string): Promise<MemoryWriteResult>;
  /** §5.2 检查点 2：返回 tmp+rename 计划（write 由工具层执行）。 */
  atomicWrite(dotId: string, path: HomeRelPath, content: string): Promise<AtomicWritePlan>;
  /** §5.2 检查点 2 后半：/fs/ops rename 落规范路径并刷新索引。 */
  commitAtomicWrite(dotId: string, tmpPath: HomeRelPath, finalPath: HomeRelPath): Promise<boolean>;
  /** §5.2 检查点 3：维护用检索（不进模型工具面，避免双轨检索）。 */
  searchHome(dotId: string, query: string, opts?: { limit?: number }): Promise<Array<{ path: HomeRelPath; snippet: string }>>;
  touchManualsLastUsed(dotId: string, paths: HomeRelPath[]): Promise<void>;

  // 查询（交互面唯一入口，S11）
  listThreads(
    dotId: string,
    opts: { status?: ThreadStatus; limit: number; cursor?: string },
  ): Promise<ThreadSummary[]>;
  listMessages(threadId: string, opts: { beforeSeq?: number; limit: number }): Promise<Message[]>;
  searchMessages(
    query: string,
    opts: { dotId?: string; sinceDays?: number; limit: number },
  ): Promise<MessageHit[]>;

  // §6.4 人工纠错记录（dotd feedback note → thr_feedback，kind='memory_note'）
  /**
   * @param text 反馈原文。
   * @param opts.tag 子集筛选标签。§6.4 升级信号②按 `recall-miss` 过滤
   *   「上下文明明有但答不出」类；普通反馈不传（默认 null）。
   */
  appendFeedbackNote(text: string, opts?: { tag?: string }): Promise<{ id: string; seq: number }>;

  // 维护（幂等，可安全重跑）
  runRetention(now?: number): Promise<RetentionReport>;
  /** §6.2 索引对账同步器（心跳增量对账，可单独跑）。 */
  syncFilesIndex(dotId: string): Promise<IndexSyncReport>;
  /** §3.5 触发条件探测（非空即应投递 memory-compaction，track=light）。 */
  compactionTriggers(dotId: string): string[];
  /** §6.3 崩溃恢复：integrity_check；失败写 OUTBOX HELP 块并抛 MemoryCorruptionError。 */
  checkIntegrity(): void;
  /** §6.3 会话断点扫描（pending 项交控制面 §7.3；孤儿由 retention 回填）。 */
  scanSessionBreaks(): { pending: SessionBreak[]; orphans: SessionBreak[] };
  /** §3.6 OUTBOX 体积守门（按块轮转；未收敛块永不轮转）。 */
  runOutboxGuard(): Promise<{ rotated: number; kept: number; archivePath: string | null }>;
  status(): Promise<MemoryStatus>;
  /** §6.4 升级判据信号（持续两周才生效，由 retention 周报消费）。 */
  searchSignal(): SearchSignal;
  /** 诊断：展开后的 OUTBOX.md 绝对路径（构造时已做 ~ 展开）。 */
  outboxFilePath(): string;
}
