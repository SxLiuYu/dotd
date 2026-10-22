/**
 * src/memory/MemoryService.ts —— 记忆模块（MEM）唯一实现与对外接口。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/memory.md）：
 * - §8 对外接口：MemoryService 全量方法（线程生命周期/注入重建/收口限额/查询/维护）。
 * - §4.1 会话模型：thread ≡ session（契约 M1）；外部幂等域规则见 §5.3——
 *   telegram=chatId 幂等生效；web/cli external_ref=NULL；event/heartbeat 恒 NULL，
 *   幂等靠 origin_task_id 唯一 + 调用方 event_id 判重。
 * - §4.2 注入预算、§4.3 WRITE-SEAL、§4.4 滚动摘要回写、§4.6 与 journal/审批的关系
 *   （mem_messages 的 tool_* 只存 digest+200 字符预览）。
 * - §6.1–6.4 保留/容量/恢复/埋点；§8 错误约定：只抛 MemoryCapacityError 与
 *   MemoryCorruptionError，软限/摘要失败以返回值降级表达，记忆问题不炸主循环。
 * - 契约 D4：只写自己的表（mem_*）；读别人的表一律走对方服务接口
 *   （tasks → taskStatusProbe；alert_dispatch → unresolvedSignatures）。
 * - 契约 M2：回写通道唯一 = ControlPlane.bindSession，本模块不自行 UPDATE tasks。
 * - CONVENTIONS §5：node:sqlite API 同步，无 async 变体；行是无原型对象。
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryCorruptionError, MemoryCapacityError } from '../shared/errors.ts';
import { ulid } from '../shared/ulid.ts';
import type {
  ContextBundle,
  HomeRelPath,
  MemoryWriteResult,
  Message,
  Thread,
  ThreadChannel,
  ThreadStatus,
} from '../shared/contracts.ts';
import { FsOpsHttpBridge, NULL_FS_OPS_BRIDGE } from './fsops-client.ts';
import type { FsOpsBridge } from './fsops-client.ts';
import { buildContextBundle as buildBundle, readMemoryMd, packSessionReplay } from './inject.ts';
import { ensureMemoryMdText } from './inject.ts';
import { rankManuals } from './inject.ts';
import { ftsIndexText, ftsMatchQuery, highlightSnippet } from './cjk-tokenize.ts';
import { sealTask as runSeal } from './seal.ts';
import {
  checkFileLimits,
  classifyHomeArea,
  estimateTokens,
  HOME_INDEX_ROOT,
  isNoteExempt,
  isNotePath,
  isReadonlyPhase,
  isReservedPath,
  LIMIT_HOME_BYTES,
  normalizeHomePath,
  isMemoryPath,
  SUMMARIZE_MESSAGE_THRESHOLD,
  SUMMARY_TOKEN_LIMIT,
  tokensOfText,
} from './limits.ts';
import {
  appendPurgeLedger,
  backfillTaskEnd,
  compactionTriggers as computeTriggers,
  dbSize,
  digest as digest16,
  reconcileIndex,
  recordSearchStat,
  runRetention as runRetentionCore,
  scanThreadsNeedingSummary,
  scanSessionBreaks,
  SEARCH_STATS_MAX_BYTES,
  SEARCH_STATS_WINDOW_MS,
  SEARCH_ZERO_HIT_SIGNAL,
  DB_SOFT_LIMIT_BYTES,
  DB_HARD_LIMIT_BYTES,
  walSize,
} from './retention.ts';import { appendOutboxBlock, runOutboxGuard } from './outbox-guard.ts';
import { toMessage, toThread } from './rows.ts';
import type {
  AtomicWritePlan,
  HomeWriter,
  IndexSyncReport,
  LoadResult,
  MemoryDeps,
  MemoryService,
  MessageHit,
  RetentionReport,
  SealTaskInput,
  SearchSignal,
  SearchStats,
  SessionBreak,
  SummarizeProbe,
  ThreadSummary,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** §6.4 纠错 tag：`recall-miss`（retention 周报过滤用）。 */
const RECALL_MISS_TAG = 'recall-miss';
/** §6.4：人工纠错专属 thread。 */
const FEEDBACK_THREAD_TITLE = 'thr_feedback';
const PREVIEW_CHARS = 200; // §4.6：digest + 200 字符预览

/** §3.6 / 契约 T3：OUTBOX.md 默认位置（daemon 宿主机文件）。 */
export const DEFAULT_OUTBOX_PATH = '~/.dotd/OUTBOX.md';

/**
 * `~/x` → HOME 展开（config/dotd.yml「路径支持 ~ 展开为 daemon 用户 HOME」，
 * 契约 T3 同款约定）。与 src/router/paths.ts 的 expandHome 同语义——那里是 MR
 * 模块的实现，MEM 不跨模块 import（分层），故本模块持一份等价实现。
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}

export class MemoryServiceImpl implements MemoryService {
  private readonly db: DatabaseSync;
  private bridge: FsOpsBridge;
  private readonly homeWriter: HomeWriter | null;
  private readonly taskStatusProbe: ((taskId: string) => string | null | undefined) | null;
  private readonly journalMemoryProbe:
    | ((taskId: string, sinceMs: number) => string[] | Promise<string[]>)
    | null;
  private readonly outboxPath: string;
  private readonly unresolvedSignatures: (() => string[] | Promise<string[]>) | null;
  private readonly onCorruption: ((error: Error) => void) | null;
  private readonly now: () => number;
  /** §4.4 摘要生成 seam（P1-2；缺省 null = 摘要功能关闭）。 */
  private readonly summarize: SummarizeProbe | null;
  /**
   * FTS5 可用性缓存（P1-3）。`null` = 尚未探测；探测结果在首次检索/首次写入时落定。
   * 表被 DROP / 老库没迁移 / 迁移失败 → `false`，检索自动降级 LIKE 并留痕。
   */
  private ftsAvailable: boolean | null = null;
  /** 首次探测时是否已做过"索引是否落后于消息表"的对账（只做一次，见 ftsProbe）。 */
  private ftsBackfilled = false;

  constructor(deps: MemoryDeps) {
    this.db = deps.db;
    this.bridge = deps.bridge ?? NULL_FS_OPS_BRIDGE;
    this.homeWriter = deps.homeWriter ?? null;
    this.taskStatusProbe = deps.taskStatusProbe ?? null;
    this.journalMemoryProbe = deps.journalMemoryProbe ?? null;
    // 装配层传的路径同样可能带 ~（config/dotd.yml 的 alerts.outbox_path），
    // 入口统一展开，避免下游 join(dirname(...)) 拿到 '~/.dotd' 这种假目录。
    this.outboxPath = expandHome(deps.outboxPath ?? DEFAULT_OUTBOX_PATH);
    this.unresolvedSignatures = deps.unresolvedSignatures ?? null;
    this.onCorruption = deps.onCorruption ?? null;
    this.now = deps.now ?? Date.now;
    this.summarize = deps.summarize ?? null;

    // §6.3：启动检查点由装配层显式调 checkIntegrity()，构造期不做 IO 副效应。
  }

  // ── 装配辅助 ──────────────────────────────────────────────────────

  /** 装配层替换桥（容器起来后从 stub 换成真实 HTTP 桥）。 */
  setBridge(bridge: FsOpsBridge | null): void {
    this.bridge = bridge ?? NULL_FS_OPS_BRIDGE;
  }

  /** 默认真实桥（daemon 装配层用；测试用 StubFsOpsBridge）。 */
  static defaultBridge(): FsOpsBridge {
    return new FsOpsHttpBridge();
  }

  // ═══════════════════════════════════════════════════════════════════
  // §4.1 线程/会话生命周期
  // ═══════════════════════════════════════════════════════════════════

  async openThread(
    dotId: string,
    channel: ThreadChannel,
    opts: { externalRef?: string; title?: string; originTaskId?: string } = {},
  ): Promise<string> {
    const now = this.now();
    const externalRef = opts.externalRef ?? null;

    // §5.3 external_ref 域规则：UNIQUE 仅对非空 external_ref 生效（partial index），
    // 即当前只有 telegram 通道幂等；event/heartbeat 幂等靠 origin_task_id。
    // cli 通道按 DDL 注释 external_ref = NULL（单主人，无复用需求），专属 thread
    // （thr_feedback）靠 title 定位，不占用 partial unique index 的名额。
    if (externalRef !== null) {
      const existing = this.db
        .prepare('SELECT id FROM mem_threads WHERE channel = ? AND external_ref = ?')
        .get(channel, externalRef) as { id?: string } | undefined;
      if (existing?.id !== undefined) {
        this.db
          .prepare('UPDATE mem_threads SET last_active_at = ? WHERE id = ?')
          .run(now, existing.id);
        return existing.id;
      }
    } else if (opts.title !== undefined) {
      const existing = this.db
        .prepare('SELECT id FROM mem_threads WHERE channel = ? AND title = ?')
        .get(channel, opts.title) as { id?: string } | undefined;
      if (existing?.id !== undefined) {
        this.db
          .prepare('UPDATE mem_threads SET last_active_at = ? WHERE id = ?')
          .run(now, existing.id);
        return existing.id;
      }
    }
    if (opts.originTaskId !== undefined) {
      const existing = this.db
        .prepare(
          `SELECT id FROM mem_threads
           WHERE origin_task_id = ? AND channel IN ('event','heartbeat')`,
        )
        .get(opts.originTaskId) as { id?: string } | undefined;
      if (existing?.id !== undefined) return existing.id;
    }

    const id = `thr_${ulid(now)}`;
    this.db
      .prepare(
        `INSERT INTO mem_threads
           (id, dot_id, channel, external_ref, title, origin_task_id, status, pinned,
            context_summary, context_summary_upto_seq, last_active_at, last_task_finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, NULL, 0, ?, NULL, ?)`,
      )
      .run(id, dotId, channel, externalRef, opts.title ?? null, opts.originTaskId ?? null, now, now);
    return id;
  }

  async create(): Promise<string> {
    // §8：create() = openThread('dot1','event')（Runner 首步建 thread）
    return this.openThread('dot1', 'event');
  }

  async load(sessionId: string): Promise<LoadResult | null> {
    const row = this.db
      .prepare('SELECT * FROM mem_threads WHERE id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const thread = toThread(row);
    const messages = this.db
      .prepare('SELECT * FROM mem_messages WHERE thread_id = ? ORDER BY seq ASC')
      .all(sessionId)
      .map((r) => toMessage(r as Record<string, unknown>));
    return { thread, summary: thread.contextSummary, messages };
  }

  async get(id: string): Promise<LoadResult | null> {
    return this.load(id);
  }

  async appendMessage(
    threadId: string,
    msg: {
      role: Message['role'];
      kind: Message['kind'];
      content: string;
      taskId?: string;
      eventId?: string;
    },
  ): Promise<{ id: string; seq: number }> {
    const now = this.now();
    // §5.3：每 thread 从 1 单调；同事务 max(seq)+1
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS mx FROM mem_messages WHERE thread_id = ?')
      .get(threadId) as { mx?: number } | undefined;
    const seq = (row?.mx ?? 0) + 1;
    const id = `msg_${ulid(now)}`;
    this.db
      .prepare(
        `INSERT INTO mem_messages
           (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        threadId,
        seq,
        msg.role,
        msg.kind,
        msg.content,
        msg.taskId ?? null,
        msg.eventId ?? null,
        tokensOfText(msg.content),
        now,
      );
    // §5.3：last_active_at 在任意消息追加时刷新
    this.db.prepare('UPDATE mem_threads SET last_active_at = ? WHERE id = ?').run(now, threadId);
    // P1-3：写路径同步 FTS（external content 表无法在触发器里调 JS 做 CJK bigram，
    // 故由这里双写；索引 token 文本与查询侧共用 cjk-tokenize.ts 的同一个纯函数）。
    this.syncMessageFts(midOfLastInsert(this.db), msg.content);
    return { id, seq };
  }

  // ═══════════════════════════════════════════════════════════════════
  // P1-3 FTS5 索引维护（contentless 表，见 db/migrations/110_memory_fts.sql）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 探测 FTS 表是否可用（存在且是虚表）。结果缓存在 `ftsAvailable`。
   * 不可用 = 老库未迁移 / 迁移失败 / 表被人工 DROP —— 检索降级 LIKE。
   */
  private ftsProbe(): boolean {
    if (this.ftsAvailable !== null) return this.ftsAvailable;
    try {
      const row = this.db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='mem_messages_fts'")
        .get() as { x?: number } | undefined;
      if (row === undefined) {
        this.ftsAvailable = false;
        return false;
      }
      // 真正打一次（虚表存在但索引损坏时，MATCH 会抛错；这里用 count 轻量探活）
      this.db.prepare('SELECT count(*) AS c FROM mem_messages_fts').get();
      this.ftsAvailable = true;
      // **不要在这里做全量对账**（2026-10-19 实测改）。
      //
      // 原来这里有一句 `if (!this.ftsBackfilled) { this.ftsBackfilled = true; this.ensureMessageFts(); }`
      // —— 注释写的是"不进入热路径"，但它**就在热路径上**：ftsProbe 由 syncMessageFts 调，
      // 而 syncMessageFts 在 appendMessage 里，appendMessage 在 POST /api/messages 的处理里。
      //
      // 实测代价：冷启动后第一次发消息，ensureMessageFts→resyncMessageFts 要全量重灌
      // 5349 条消息的索引 —— **appendMessage 耗时 15884 ms**，主人看到的就是"第一句话要等 15 秒"。
      //
      // 对账改由装配层在**启动阶段**调 `ensureMessageFts()` 完成（daemon.ts）。
      // 这里只保留轻量探活：索引缺失/损坏时降级到 LIKE 检索，不影响写路径。
    } catch {
      this.ftsAvailable = false;
    }
    return this.ftsAvailable;
  }

  /**
   * 写一条消息的 FTS 索引（contentless 表：INSERT(rowid, tokens)）。
   * 失败不抛——记忆检索是增强能力，不得炸主循环；失败会让下次检索降级 LIKE。
   */
  private syncMessageFts(rowid: number | null, content: string): void {
    if (rowid === null) return;
    if (!this.ftsProbe()) return;
    try {
      this.db
        .prepare('INSERT INTO mem_messages_fts(rowid, tokens) VALUES (?, ?)')
        .run(rowid, ftsIndexText(content));
    } catch {
      this.ftsAvailable = false; // 下次检索自动降级，并留痕
    }
  }

  /**
   * 全量重建索引：contentless FTS 不支持 `rebuild`（没有内容表），只能清空后重灌。
   * 用在迁移后的首次启动 / 健康检查发现索引落后时（见 `resyncMessageFts()`）。
   */
  resyncMessageFts(): number {
    if (!this.ftsProbe()) return 0;
    try {
      this.db.exec("INSERT INTO mem_messages_fts(mem_messages_fts) VALUES('delete-all')");
      const rows = this.db.prepare('SELECT rowid, content FROM mem_messages').all() as Array<{
        rowid?: number;
        content?: string;
      }>;
      const ins = this.db.prepare('INSERT INTO mem_messages_fts(rowid, tokens) VALUES (?, ?)');
      let n = 0;
      for (const r of rows) {
        if (typeof r.rowid !== 'number' || typeof r.content !== 'string') continue;
        ins.run(r.rowid, ftsIndexText(r.content));
        n++;
      }
      return n;
    } catch {
      this.ftsAvailable = false;
      return 0;
    }
  }

  /** 索引是否与消息表同步（条数一致）。诊断 / 测试用。 */
  ftsStatus(): { available: boolean; indexed: number; messages: number; inSync: boolean } {
    const messages = (this.db.prepare('SELECT count(*) AS c FROM mem_messages').get() as { c?: number } | undefined)?.c ?? 0;
    if (!this.ftsProbe()) return { available: false, indexed: 0, messages, inSync: false };
    const indexed = (this.db.prepare('SELECT count(*) AS c FROM mem_messages_fts').get() as { c?: number } | undefined)?.c ?? 0;
    return { available: true, indexed, messages, inSync: indexed === messages };
  }

  /** 记录一次降级（§6.4 maintenance kv，非静默）。 */
  private recordFtsDegraded(reason: string): void {
    const at = this.now();
    const key = 'fts_degraded_count';
    const prev = this.readKvNumber(key) ?? 0;
    this.writeKv(key, String(prev + 1), at);
    this.writeKv('fts_degraded_last', JSON.stringify({ reason, at }), at);
  }

  /**
   * 迁移后的首次回填（幂等）：索引条数 < 消息条数时全量重灌。
   *
   * 为什么放在代码里而不是迁移包：迁移包是纯 SQL，contentless FTS 没有内容表、
   * `'rebuild'` 命令对它无效；逐行喂入还需要 bigram 切分（JS）。而且迁移包写数据行会
   * 破坏"新建库模板 = 结构 + 空表"的不变式（tests/db-template.test.ts 会红）。
   *
   * @returns 实际灌入的条数（0 = 已同步或 FTS 不可用）。
   */
  ensureMessageFts(): number {
    const st = this.ftsStatus();
    if (!st.available) return 0;
    if (st.inSync) return 0;
    return this.resyncMessageFts();
  }

  async appendSystemMessage(
    threadId: string,
    msg: { kind: Message['kind']; content: string; taskId?: string },
  ): Promise<{ id: string; seq: number }> {
    return this.appendMessage(threadId, { role: 'system', ...msg });
  }

  async sealThread(threadId: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(`UPDATE mem_threads SET status = 'sealed', last_task_finished_at = ? WHERE id = ?`)
      .run(now, threadId);
  }

  /**
   * §4.4 会话摘要的**真实触发点**（P1-2，2026-10-18）。
   *
   * 为什么之前恒为 NULL：`updateContextSummary()` 有实现、接口有声明，但**全仓库零调用方**
   * （`needsSummarize()` 同样零调用）。于是 `thread.context_summary` 永远是 null，
   * `buildContextBundle` 只能用"最近 N 条消息"，会话一长就只能硬截断——越聊越忘，而且静默。
   *
   * 触发判据（`needsSummarize`）：消息条数 > SUMMARIZE_MESSAGE_THRESHOLD(64) 或注入 token 超预算。
   * 只摘要**新增的尾部**（upto_seq 之后），已进摘要的不重算——代价是 O(增量) 不是 O(会话)。
   *
   * 语义：
   *  - 摘要走注入的 `summarize`（装配层接 `router.complete({track:'light'})`），MEM 不发 HTTP；
   *  - `context_summary_upto_seq` = 本次被摘要覆盖到的**最后一条消息 seq**（精确值，不是行数）；
   *  - `buildContextBundle`/`packSessionReplay` 只重放 upto_seq 之后的消息（见 inject.ts）；
   *  - 任何失败（无 summarize 入口 / 模型抛错 / 返回空）→ **不写、不抛**，下次再试。
   *
   * @returns 是否真的更新了摘要（供观测/测试；永不抛）。
   */
  async refreshContextSummary(threadId: string): Promise<boolean> {
    if (this.summarize === null) return false;
    try {
      const row = this.loadThreadRow(threadId);
      if (row === null) return false;
      const thread = toThread(row);
      const uptoSeq = thread.contextSummaryUptoSeq;

      // 只取 upto_seq 之后的**增量**；只保留有对话语义的 kind（记账类消息不进摘要）
      const fresh = (
        this.db
          .prepare('SELECT * FROM mem_messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC')
          .all(threadId, uptoSeq) as unknown as Array<Record<string, unknown>>
      ).map(toMessage);
      const usable = fresh.filter(
        (m) => m.kind === 'text' || m.kind === 'tool_result' || m.kind === 'task_start',
      );
      if (usable.length === 0) return false;

      const allCount = this.db
        .prepare('SELECT COUNT(*) AS c FROM mem_messages WHERE thread_id = ?')
        .get(threadId) as { c?: number } | undefined;
      const prev = thread.contextSummary;
      const prevTokens = prev === null ? 0 : tokensOfText(prev);
      const freshTokens = usable.reduce((n, m) => n + m.tokenEst, 0);
      if (!needsSummarize(allCount?.c ?? 0, prevTokens + freshTokens)) return false;

      // **摘要输入必须只留对话语义**（2026-10-19 实测修的）。
      //
      // 原来这里是 `usable.map((m) => `${m.role}：${m.content}`)` —— 把 tool_result 的
      // 完整 JSON（`{"call_id":"01M56...","tool":"fs.write","ok":true,...}`）原样灌进去。
      // 实测一个 122 条工具输出 + 5 条对话的线程：**工具输出占 99%**。
      // 模型被 JSON 淹没，产出的"摘要"就是把 JSON 截断到 1800 字节 —— 等于没摘要。
      //
      // 新做法（两段压缩）：
      //  ① 工具调用压成记号（`（工具 fs.write✓）`）——保留"做过什么"，去掉 JSON；
      //  ② **连续相同的记号合并成一条带计数的**（`（工具 fs.write✓ ×7）`）。
      //     第二步是实测补的：只做①时，一个 73 次工具调用的线程输入里还是
      //     73 行 `（工具 fs.read✓）`，把仅有的几句对话冲得看不见。
      //     合并后同类操作塌成一行，对话重新成为主体。
      const compressForSummary = (m: (typeof usable)[number]): string => {
        if (m.kind !== 'tool_result') return `${m.role}：${m.content}`;
        // 从 JSON 里尽量取出工具名与成败，取不到就退化成通用记号
        let tool = '';
        let ok = '';
        try {
          const j = JSON.parse(m.content) as { tool?: unknown; ok?: unknown };
          if (typeof j.tool === 'string') tool = j.tool;
          if (typeof j.ok === 'boolean') ok = j.ok ? '✓' : '✗';
        } catch {
          // 非 JSON（老数据/截断）——只标记存在，不带内容
        }
        return tool.length > 0 ? `\u0000TOOL:${tool}${ok}` : '\u0000TOOL:调用';
      };

      // 先压成记号，再把「连续相同」的记号折叠成 ×N
      const folded: string[] = [];
      let runMark = '';
      let runCount = 0;
      const flushRun = (): void => {
        if (runCount === 0) return;
        const label = runMark.slice('\u0000TOOL:'.length);
        folded.push(runCount === 1 ? `（工具 ${label}）` : `（工具 ${label} ×${runCount}）`);
        runMark = '';
        runCount = 0;
      };
      for (const m of usable) {
        const piece = compressForSummary(m);
        if (piece.startsWith('\u0000TOOL:')) {
          if (piece === runMark) runCount += 1;
          else {
            flushRun();
            runMark = piece;
            runCount = 1;
          }
        } else {
          flushRun();
          folded.push(piece);
        }
      }
      flushRun();

      // **摘要绝不能吃自己**（2026-10-22 实测修，这是"没有上下文"的直接病因）。
      //
      // 原写法把 `【已有摘要】` 和新增对话拼在一起再喂给 summarize，于是每一轮都是
      // 「上一份摘要」被再压一次 —— 摘要的摘要的摘要。每轮丢一点事实、多记一点
      // 摘要器自己的腔调，误差单调累积且**不可逆**（原文被 upto_seq 永久排除，回不来）。
      //
      // 现场：飞书主线程 385 条消息、upto_seq=384，即 384 条历史全部不再回放，
      // 唯一代表它们的就是一段 501 字摘要 —— 而那段摘要的正文是
      // 「你这次发来的还是摘要 + 上一轮对话，没有新的指令……请给路径」。
      // 摘要器把"我在摘要一段摘要"这个处境本身写成了摘要。上下文就是这样丢光的。
      //
      // 修法：旧摘要**不再进入待压缩材料**，而是作为「已知背景」单独声明、
      // 明确要求"不许在输出里描述这个过程"。新增对话才是要压缩的对象。
      // 摘要仍是滚动的（prev 的**内容要点**会被保留），但不再被当作可再压缩的文本。
      const transcript = [
        prev !== null
          ? `【已知背景（此前已总结，仅供你避免重复，不要在摘要里复述它）】\n${prev}\n`
          : '',
        '【本轮需要你压缩的新增对话】',
        ...folded,
      ]
        .filter((s) => s.length > 0)
        .join('\n');
      const produced = await this.summarize(threadId, transcript, { maxTokens: SUMMARY_TOKEN_LIMIT });
      const summary = (produced ?? '').trim();
      if (summary.length === 0) return false; // 空摘要 = 本次没成功，不覆盖已有摘要

      // upto_seq 取"被覆盖的最后一条消息的 seq"（精确值，不是条数）
      const lastSeq = usable[usable.length - 1]!.seq;
      await this.updateContextSummary(threadId, summary, lastSeq);
      return true;
    } catch {
      // 记忆问题不炸主循环（§8）：摘要失败保持原状，下次任务再试
      return false;
    }
  }

  async updateContextSummary(threadId: string, summary: string, uptoSeq: number): Promise<void> {
    // §4.4：新 context_summary ≤600 tokens（超限截断，防写入失控）
    const trimmed =
      tokensOfText(summary) > SUMMARY_TOKEN_LIMIT
        ? summary.slice(0, SUMMARY_TOKEN_LIMIT * 3.5)
        : summary;
    this.db
      .prepare(
        'UPDATE mem_threads SET context_summary = ?, context_summary_upto_seq = ? WHERE id = ?',
      )
      .run(trimmed, uptoSeq, threadId);
  }

  // ═══════════════════════════════════════════════════════════════════
  // §4.2 注入与 §4.1 重建
  // ═══════════════════════════════════════════════════════════════════

  async buildContextBundle(
    dotId: string,
    taskText: string,
    budgetTokens: number,
    opts: { threadId?: string; taskId?: string } = {},
  ): Promise<ContextBundle> {
    const threadId = opts.threadId ?? null;
    const thread = threadId !== null ? this.loadThreadRow(threadId) : null;
    // P1-2：已进摘要的那段消息**不再重复注入**——否则摘要与原文双份占预算，越摘要越挤。
    // 只取 context_summary_upto_seq 之后的消息。
    //
    // ⚠ 边界：若 upto_seq 已经覆盖到**最后一条**消息（摘要把整段会话都吃掉了），
    // 这里不能把消息列表清空——那样"会话部分"恒为空、摘要反而永远放得下，
    // 与 §4.2 的预算砍序（消息优先于摘要）自相矛盾，也让"最近几条"这个锚点消失。
    // 所以此时保留全部消息，由 buildBundle 的既有预算逻辑决定谁被砍。
    const uptoSeq = typeof thread?.context_summary_upto_seq === 'number' ? thread.context_summary_upto_seq : 0;
    const rawMessages =
      threadId !== null
        ? (
            this.db
              .prepare('SELECT * FROM mem_messages WHERE thread_id = ? ORDER BY seq ASC')
              .all(threadId) as unknown as Array<Record<string, unknown>>
          ).map((r) => toMessage(r))
        : [];
    const hasTail = rawMessages.some((m) => m.seq > uptoSeq);
    const messages = hasTail ? rawMessages.filter((m) => m.seq > uptoSeq) : rawMessages;
    const manuals = this.db
      .prepare(
        `SELECT path, title, tags, size_bytes AS sizeBytes
         FROM mem_files_index WHERE dot_id = ? AND area = 'manuals'`,
      )
      .all(dotId)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          path: String(row.path),
          area: 'manuals' as const,
          title: typeof row.title === 'string' ? row.title : null,
          tags: parseTags(row.tags),
          sizeBytes: Number(row.sizeBytes ?? 0),
        };
      });

    const summary: string | null =
      typeof thread?.context_summary === 'string' ? thread.context_summary : null;

    // §4.2 前置：home 卷首次部署时 MEMORY.md 尚不存在（命名卷空白起步，无任何
    // 代码路径负责建它）。此时每个任务都会走降级分支记一次 memory_missed。
    // 补建只做判定+交付骨架内容，落盘由 exec.fsOps 的 fs.write 承担。
    const seed = await ensureMemoryMdText(this.bridge, dotId, new Date(this.now()));
    if (seed.seeded) {
      const written = await this.writeHomeFile(dotId, HOME_INDEX_ROOT, seed.text);
      if (written) {
        this.reconcileSeedIndex(dotId, HOME_INDEX_ROOT, seed.text);
      }
    }

    const bundle = await buildBundle(
      { bridge: this.bridge, dotId, manuals },
      taskText,
      { summary, messages, budgetTokens },
    );

    // §4.2：桥不可用 → 本次跳过并在 messages 记 kind='system_error' 注记 +
    // memory_missed=1，不阻塞任务
    if (bundle.bridgeFailed && threadId !== null) {
      await this.appendSystemMessage(threadId, {
        kind: 'system_error',
        taskId: opts.taskId,
        content: JSON.stringify({
          stage: 'buildContextBundle',
          error: bundle.bridgeError ?? 'bridge_unavailable',
          memoryMissed: 1,
        }),
      });
      this.markMissedRaw(`inject:${dotId}:${opts.taskId ?? '-'}`, 'bridge_unavailable', this.now());
    }
    return {
      memoryMd: bundle.memoryMd,
      manualExcerpts: bundle.manualExcerpts,
      summary: bundle.summary,
      recentMessages: bundle.recentMessages,
      usedTokens: bundle.usedTokens,
    };
  }

  async buildSessionReplay(threadId: string, taskId: string, budgetTokens: number): Promise<Message[]> {
    const row = this.loadThreadRow(threadId);
    if (row === null) return [];
    // P1-2：与 buildContextBundle 同口径——只重放 upto_seq 之后的消息，
    // 之前那段已由 context_summary 代表（packSessionReplay 会把摘要排在最前）。
    const uptoSeq = typeof row.context_summary_upto_seq === 'number' ? row.context_summary_upto_seq : 0;
    const messages = this.db
      .prepare('SELECT * FROM mem_messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC')
      .all(threadId, uptoSeq)
      .map((r) => toMessage(r as Record<string, unknown>));
    const packed = packSessionReplay(toThread(row), messages, budgetTokens);
    // taskId 参与命中段，便于交互面回看（不改消息内容）
    void taskId;
    return packed;
  }

  // ═══════════════════════════════════════════════════════════════════
  // §4.3 收口与 §5.2 检查点
  // ═══════════════════════════════════════════════════════════════════

  async sealTask(
    task: SealTaskInput,
    outcome: 'done' | 'failed' | 'cancelled',
    stopReason?: string,
  ): Promise<void> {
    await runSeal(
      {
        appendSystemMessage: async (threadId, msg) => {
          const r = await this.appendSystemMessage(threadId, msg);
          return r;
        },
        touchThreadFinished: (threadId, at) => {
          this.db
            .prepare('UPDATE mem_threads SET last_task_finished_at = ? WHERE id = ?')
            .run(at, threadId);
        },
        touchManuals: async (dotId, paths) => this.touchManualsLastUsed(dotId, paths),
        probeMemoryWrites: async (taskId, sinceMs) => {
          if (this.journalMemoryProbe === null) return [];
          const paths = await this.journalMemoryProbe(taskId, sinceMs);
          return paths.filter(isMemoryWritePathLoose);
        },
        markMissed: (taskId, outcome2, at) => this.markMissedRaw(taskId, outcome2, at),
        hasReminded: (taskId) => this.readKv(`reminded:${taskId}`) !== null,
        markReminded: (taskId, at) => this.writeKv(`reminded:${taskId}`, String(at), at),
      },
      task,
      outcome,
      stopReason,
    );
  }

  /**
   * §4.3「补写一轮」的前置判定（P1-4，2026-10-18）。
   *
   * 只回答一个问题：**这次收口值不值得再问模型一轮"要么写记忆、要么 SKIP"**。
   * 判据与 sealTask 内部同源（probeMemoryWrites + 路径前缀），只是**提前到 finish 之前**问——
   * 因为 sealTask 由 CP 钩子在 `queue.finish()` 内部调用，那时任务已终态、Runner
   * 主循环已退出，不可能再发 LLM 请求（这正是老的"假提醒"缺陷）。
   *
   * 不写库、不抛（判不出来 = 不补写，软降级）。
   */
  async needsMemoryRedo(
    task: SealTaskInput,
    outcome: 'done' | 'failed' | 'cancelled',
  ): Promise<boolean> {
    // failed/cancelled：止损优先，不问（§4.3：只记 missed）
    if (outcome !== 'done') return false;
    // injectOnce：本任务已经提醒过 → 不再重复提醒（跨 attempt 幂等）
    if (this.readKv(`reminded:${task.id}`) !== null) return false;
    try {
      if (this.journalMemoryProbe === null) {
        // 无探针 = 无法判定"写没写"。此时**不补写**：假提醒的坑已经踩过一次，
        // 不能再靠"查不到就当没写"去打一轮白工。
        return false;
      }
      const since = task.createdAt > 0 ? task.createdAt : task.updatedAt;
      const paths = await this.journalMemoryProbe(task.id, since);
      return paths.filter(isMemoryWritePathLoose).length === 0;
    } catch {
      return false;
    }
  }

  /** §4.3 injectOnce 的读侧（跨 attempt 幂等）。 */
  hasMemoryReminder(taskId: string): boolean {
    return this.readKv(`reminded:${taskId}`) !== null;
  }

  /** §4.3 injectOnce 的写侧（Runner 决定补写时先记账再问）。 */
  markMemoryReminder(taskId: string, at?: number): void {
    const t = at ?? this.now();
    this.writeKv(`reminded:${taskId}`, String(t), t);
  }

  /**
   * 写前检查点（接缝 M6）。**只在路径落在记忆层管辖范围内时**才施加记忆规则。
   *
   * 记忆层的规范（§3.2/§6.2）有意只管三处：`MEMORY.md`、`notes/*.md`、`manuals/**`。
   * 它管的是"长期记忆的组织方式"，不是"整个 home 能不能写"——`/dot/home` 下还有
   * 工作文件、临时产物、脚本，那些该由执行面的沙箱护栏（路径必须留在 /dot/home 内）
   * 负责，不该被"note 命名必须是 YYYY-MM-DD-slug.md"这种记忆规范拦下。
   *
   * 改之前这里对任意路径都跑 `checkFileLimits`，而它内部 `classifyHomeArea` 对规范外
   * 路径返回 null → HARD_LIMIT。于是 `fs.write("work/report.txt")` 这类完全合法的
   * 普通写文件会被拒，错误信息还是"路径不在记忆规范内"，模型只能反复重试。
   * （2026-10-18 真实模型端到端时实测：模型连试 3 次 fs.write 都被拒，最后放弃任务。）
   *
   * 两层校验的分工：
   * - 记忆层（这里）：**只在记忆范围内**管命名、容量、软硬限；
   * - 执行面（`validateToolCall` / `checkHomePath`）：管路径必须留在 /dot/home 内、
   *   不许 `..` 逃逸、不许碰保留前缀。那是真正的安全边界，与记忆规范无关。
   */
  async beforeWrite(dotId: string, path: HomeRelPath, content: string): Promise<MemoryWriteResult> {
    const norm = normalizeHomePath(path);
    if (norm === null) {
      // 形状非法（绝对路径、盘符、`..` 逃逸）：**拒**，不是放行。
      // 这是安全边界，执行面护栏同样会拒；两层都守，任一层漏了都不至于放行。
      // 措辞要**可操作**（2026-10-18 实测）：模型写 /dot/home/m2.txt 被拒，原来只说
      // "不许绝对路径 / .. 逃逸" —— 但 /dot/home 正是家目录本身，模型据此以为路径不安全，
      // 换了三个写法反复撞墙。真正的原因只是"要写相对路径"，那就直接这么告诉它。
      const hint = path.startsWith('/') || /^[A-Za-z]:/.test(path)
        ? `请改用 home 内的**相对路径**（去掉 /dot/home 前缀），例如 "m2.txt" 或 "notes/x.md"`
        : `路径不能含 ".."：请改用 home 内相对路径`;
      // 越界用专门错误码（2026-10-18 统一）：原先报 HARD_LIMIT(限额) 会让模型以为是容量问题，
      // 而执行面 fs.read 对同类情况报 path_outside_home —— 两边语义不同，模型学不到一致的规则。
      return { ok: false, error: 'PATH_OUTSIDE_HOME', warning: `home 路径不合规（${path}）。${hint}` };
    }
    if (!isMemoryPath(norm)) return { ok: true }; // 记忆层不管：交给执行面护栏
    const usage = await this.homeUsage(dotId, norm);
    return checkFileLimits(norm, content, usage);
  }

  /**
   * §4.2 骨架补建落盘（homeWriter 注入时才动；未注入返回 false）。
   *
   * 只走 homeWriter：FsOpsBridge 是只读面（契约 S4' 无 write），覆盖写语义
   * 由工具层 fs.write 保证（自动建父目录、过沙箱护栏）。任何失败都吞掉返回
   * false——记忆问题不炸主循环（§8），这一轮没骨架就照旧降级。
   */
  private async writeHomeFile(dotId: string, path: HomeRelPath, content: string): Promise<boolean> {
    if (this.homeWriter === null) return false;
    try {
      return await this.homeWriter(dotId, path, content);
    } catch {
      return false;
    }
  }

  /** 骨架落盘后同步 mem_files_index（不依赖心跳对账，索引立即有行）。 */
  private reconcileSeedIndex(dotId: string, path: HomeRelPath, content: string): void {
    const norm = normalizeHomePath(path);
    if (norm === null) return;
    const area = classifyHomeArea(norm);
    if (area === null || area === 'archive') return;
    reconcileIndex(this.db, dotId, new Map([[norm, {
      area,
      tags: [],
      title: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs: this.now(),
    }]]));
  }

  async atomicWrite(dotId: string, path: HomeRelPath, content: string): Promise<AtomicWritePlan> {
    // §5.2 检查点 1 + 2：先限额，再给 tmp+rename 计划（write 由工具层 fs.write 执行）
    const base = await this.beforeWrite(dotId, path, content);
    if (!base.ok) return base;
    const norm = normalizeHomePath(path);
    if (norm === null) return { ok: false, error: 'HARD_LIMIT', warning: '非法路径' };
    return { ...base, tmpPath: `.tmp/${ulid(this.now())}.md`, finalPath: norm };
  }

  async commitAtomicWrite(dotId: string, tmpPath: HomeRelPath, finalPath: HomeRelPath): Promise<boolean> {
    // §5.2 检查点 2 后半：rename 经 /fs/ops（S4'）；rename 限 home 内由桥保证
    const ok = await this.bridge.rename(dotId, tmpPath, finalPath);
    if (ok) {
      const norm = normalizeHomePath(finalPath);
      const st = norm !== null ? await this.bridge.stat(dotId, norm) : null;
      if (norm !== null && st !== null) {
        // classifyHomeArea 可能返回 'archive'（保留前缀），索引面不收；
        // 走到这里说明 finalPath 已过 beforeWrite 校验，理论上只可能是三区之一。
        const area = classifyHomeArea(norm);
        if (area !== null && area !== 'archive') {
          reconcileIndex(this.db, dotId, new Map([[norm, {
            area,
            tags: [],
            title: null,
            sizeBytes: st.sizeBytes,
            mtimeMs: st.mtimeMs,
          }]]));
        }
      }
    }
    return ok;
  }

  async searchHome(
    dotId: string,
    query: string,
    opts: { limit?: number } = {},
  ): Promise<Array<{ path: HomeRelPath; snippet: string }>> {
    // §5.2 检查点 3：维护用检索，不进模型工具面（避免双轨检索）。
    // 经 /fs/ops read 逐文件 LIKE（无向量库、无 FTS5——§6.4 默认不启用）。
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare('SELECT path FROM mem_files_index WHERE dot_id = ?')
      .all(dotId) as Array<{ path?: string }>;
    const out: Array<{ path: HomeRelPath; snippet: string }> = [];
    const q = query.toLowerCase();
    for (const r of rows) {
      const p = String(r.path);
      const text = await this.bridge.read(dotId, p);
      if (text === null) continue;
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      out.push({ path: p, snippet: text.slice(start, start + 160).replace(/\s+/g, ' ') });
      if (out.length >= limit) break;
    }
    return out;
  }

  async touchManualsLastUsed(dotId: string, paths: HomeRelPath[]): Promise<void> {
    // §4.3：done 时刷新 manuals 的 last_used（§3.5 老化判据按此字段）。
    // 落点 = mem_files_index.mtime_ms（镜像索引，DDL 无 last_used 列，不改表结构）。
    const now = this.now();
    for (const p of paths) {
      const norm = normalizeHomePath(p);
      if (norm === null) continue;
      if (classifyHomeArea(norm) !== 'manuals') continue;
      this.db
        .prepare('UPDATE mem_files_index SET mtime_ms = ? WHERE dot_id = ? AND path = ?')
        .run(now, dotId, norm);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // §8 查询（交互面唯一入口 S11）
  // ═══════════════════════════════════════════════════════════════════

  async listThreads(
    dotId: string,
    opts: { status?: ThreadStatus; limit: number; cursor?: string },
  ): Promise<ThreadSummary[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const rows =
      opts.status !== undefined
        ? this.db
            .prepare(
              `SELECT t.*, (SELECT COUNT(*) FROM mem_messages m WHERE m.thread_id = t.id) AS msg_count
               FROM mem_threads t
               WHERE t.dot_id = ? AND t.status = ? AND t.id < ?
               ORDER BY t.last_active_at DESC, t.id DESC LIMIT ?`,
            )
            .all(dotId, opts.status, opts.cursor ?? '￿', limit)
        : this.db
            .prepare(
              `SELECT t.*, (SELECT COUNT(*) FROM mem_messages m WHERE m.thread_id = t.id) AS msg_count
               FROM mem_threads t
               WHERE t.dot_id = ? AND t.id < ?
               ORDER BY t.last_active_at DESC, t.id DESC LIMIT ?`,
            )
            .all(dotId, opts.cursor ?? '￿', limit);
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        channel: toThread(row).channel,
        title: typeof row.title === 'string' ? row.title : null,
        status: toThread(row).status,
        pinned: Number(row.pinned ?? 0) === 1,
        lastActiveAt: Number(row.last_active_at ?? 0),
        lastTaskFinishedAt:
          typeof row.last_task_finished_at === 'number' ? row.last_task_finished_at : null,
        messageCount: Number(row.msg_count ?? 0),
        hasSummary: typeof row.context_summary === 'string' && row.context_summary.length > 0,
      } satisfies ThreadSummary;
    });
  }

  async listMessages(threadId: string, opts: { beforeSeq?: number; limit: number }): Promise<Message[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const rows =
      opts.beforeSeq !== undefined
        ? this.db
            .prepare(
              'SELECT * FROM mem_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(threadId, opts.beforeSeq, limit)
        : this.db
            .prepare('SELECT * FROM mem_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?')
            .all(threadId, limit);
    return rows
      .map((r) => toMessage(r as Record<string, unknown>))
      .reverse(); // 输出从旧到新
  }

  async searchMessages(
    query: string,
    opts: { dotId?: string; sinceDays?: number; limit: number },
  ): Promise<MessageHit[]> {
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const since =
      opts.sinceDays !== undefined ? this.now() - opts.sinceDays * DAY_MS : 0;
    const dotId = opts.dotId;

    // P1-3：优先走 FTS5（bm25 排序 + CJK bigram，见 cjk-tokenize.ts 头注）；
    // FTS 不可用（老库/表被 DROP/索引损坏）或无有效 token 时，**降级到原来的 LIKE 全表扫描**，
    // 结果不丢，且降级行为记入 maintenance kv（不静默）。
    const matchExpr = ftsMatchQuery(query);
    if (matchExpr.length > 0 && this.ftsProbe()) {
      const hits = this.searchMessagesFts(matchExpr, { dotId, since, limit, query });
      if (hits !== null) {
        recordSearchStat(this.db, hits.length === 0, this.now());
        return hits;
      }
      // FTS 查询抛错（索引损坏等）→ 落到 LIKE，并记一次降级
      this.ftsAvailable = false;
      this.recordFtsDegraded('query_error');
    } else {
      // 表不存在 = 迁移缺失；空查询不算降级（与 LIKE 版同样返回空）
      if (matchExpr.length > 0 && !this.ftsProbe()) this.recordFtsDegraded('unavailable');
    }

    const rows =
      dotId !== undefined
        ? this.db
            .prepare(
              `SELECT m.* FROM mem_messages m
               JOIN mem_threads t ON t.id = m.thread_id
               WHERE m.content LIKE ? AND t.dot_id = ? AND m.created_at >= ?
               ORDER BY m.created_at DESC LIMIT ?`,
            )
            .all(`%${escapeLike(query)}%`, dotId, since, limit)
        : this.db
            .prepare(
              `SELECT * FROM mem_messages
               WHERE content LIKE ? AND created_at >= ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(`%${escapeLike(query)}%`, since, limit);
    const hits = rows.map((r) => {
      const m = toMessage(r as Record<string, unknown>);
      return { message: m, snippet: makeSnippet(m.content, query) } satisfies MessageHit;
    });
    // §6.4 埋点归属：本模块 searchMessages 内联写 mem_maintenance_state.search_stats
    recordSearchStat(this.db, hits.length === 0, this.now());
    return hits;
  }

  /**
   * FTS 分支。返回 `null` 表示"FTS 查询失败，调用方应降级 LIKE"。
   *
   * 排序 = `bm25(mem_messages_fts)` **升序**（SQLite 的 bm25() 返回负数，越小越相关），
   * 再按 recency 兜底——与 LIKE 版的"最新优先"在相关性打平时保持一致。
   */
  private searchMessagesFts(
    matchExpr: string,
    opts: { dotId?: string; since: number; limit: number; query: string },
  ): MessageHit[] | null {
    const { dotId, since, limit, query } = opts;
    try {
      const rows =
        dotId !== undefined
          ? this.db
              .prepare(
                `SELECT m.*, bm25(mem_messages_fts) AS rank FROM mem_messages_fts
                 JOIN mem_messages m ON m.rowid = mem_messages_fts.rowid
                 JOIN mem_threads t ON t.id = m.thread_id
                 WHERE mem_messages_fts MATCH ? AND t.dot_id = ? AND m.created_at >= ?
                 ORDER BY rank ASC, m.created_at DESC LIMIT ?`,
              )
              .all(matchExpr, dotId, since, limit)
          : this.db
              .prepare(
                `SELECT m.*, bm25(mem_messages_fts) AS rank FROM mem_messages_fts
                 JOIN mem_messages m ON m.rowid = mem_messages_fts.rowid
                 WHERE mem_messages_fts MATCH ? AND m.created_at >= ?
                 ORDER BY rank ASC, m.created_at DESC LIMIT ?`,
              )
              .all(matchExpr, since, limit);
      return (rows as Array<Record<string, unknown>>).map((r) => {
        const m = toMessage(r);
        return { message: m, snippet: highlightSnippet(m.content, query) } satisfies MessageHit;
      });
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // §6.4 人工纠错记录（dotd feedback note → thr_feedback）
  // ═══════════════════════════════════════════════════════════════════

  async appendFeedbackNote(text: string, opts: { tag?: string } = {}): Promise<{ id: string; seq: number }> {
    // §6.4：专属 thread thr_feedback（channel='cli'，kind='memory_note'）；
    // cli 通道 external_ref = NULL（DDL 域规则），靠 title 定位专属 thread。
    // tag 是升级信号②的子集筛选器：只有显式标 recall-miss 的反馈才计入
    // 「上下文明明有但答不出」；普通反馈也进 thr_feedback 但不带该 tag。
    // 默认不带 tag——否则按 tag 过滤等价于全量计数，信号②失去区分度。
    const threadId = await this.openThread('dot1', 'cli', {
      title: FEEDBACK_THREAD_TITLE,
    });
    const content = JSON.stringify({
      text,
      tag: opts.tag ?? null,
      at: this.now(),
    });
    return this.appendMessage(threadId, { role: 'user', kind: 'memory_note', content });
  }

  // ═══════════════════════════════════════════════════════════════════
  // §6.1–6.3 维护（幂等）
  // ═══════════════════════════════════════════════════════════════════

  async runRetention(now?: number): Promise<RetentionReport> {
    const at = now ?? this.now();
    const report = runRetentionCore(
      { db: this.db, bridge: this.bridge, taskStatusProbe: this.taskStatusProbe, now: this.now },
      at,
    );
    this.writeKv('retention_last_run', String(at), at);
    // §6.3：补写完漏调后，同步刷新这些 thread 的 last_task_finished_at（封存锚点）
    for (const taskId of report.orphanTaskEndsBackfilled) {
      this.db
        .prepare(
          `UPDATE mem_threads SET last_task_finished_at = ?
           WHERE id IN (SELECT DISTINCT thread_id FROM mem_messages WHERE task_id = ?)`,
        )
        .run(at, taskId);
    }
    // §6.3 + §8：retention 是 violation/回填计数的唯一写入方，回写 kv 才能让
    // status().seal 三个计数对外可见（此前只进 report 对象，报告面永久为 0）。
    if (report.sealViolations.length > 0) {
      const v = this.readKvNumber('seal_violations') ?? 0;
      this.writeKv('seal_violations', String(v + report.sealViolations.length), at);
    }
    if (report.orphanTaskEndsBackfilled.length > 0) {
      const b = this.readKvNumber('seal_backfilled') ?? 0;
      this.writeKv('seal_backfilled', String(b + report.orphanTaskEndsBackfilled.length), at);
    }
    // **存量会话补摘要**（2026-10-19）：摘要本来只在任务收口前触发（Runner 的 refreshSummary），
    // 于是「摘要机制接通之前」就聊了几百条的存量线程**永远不会被处理**——
    // 实测接通后 423 个线程里只有 1 个有摘要，5 个 >64 条的大线程全是 null。
    // 这里每天补几个（limit=20 防把低智能轨打满），失败静默（refreshContextSummary 自己吞异常）。
    for (const threadId of scanThreadsNeedingSummary(this.db, 64, 20)) {
      try {
        await this.refreshContextSummary(threadId);
      } catch {
        // 摘要失败不影响 retention 本身
      }
    }
    return report;
  }

  async syncFilesIndex(dotId: string): Promise<IndexSyncReport> {
    const at = this.now();
    const report: IndexSyncReport = {
      dotId,
      scanned: 0,
      added: 0,
      updated: 0,
      removed: 0,
      tmpResidueMoved: [],
      errors: [],
    };
    if (this.bridge.available() === false) {
      report.errors.push('bridge_unavailable');
      this.writeKv('index_sync_last', String(at), at);
      return report;
    }
    // §6.2：心跳经 /fs/ops list 增量对账（索引范围 = MEMORY.md + notes/ + manuals/；
    // .archive/.tmp/.dotd 永不入索）。list 是单层目录项 → 递归下钻（manuals 有子目录）。
    const seen = new Map<
      string,
      { area: 'memory' | 'notes' | 'manuals'; tags: string[]; title: string | null; sizeBytes: number; mtimeMs: number }
    >();
    const scanDir = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) return; // 防环/防爆（home 内不会出现这种深度）
      const entries = await this.bridge.list(dotId, dir);
      for (const e of entries) {
        if (e.type === 'dir') {
          // 目录项本身不在索引域（classifyHomeArea 只认文件）；判据换成"其下可能有合规文件"
          if (!isReservedPath(e.path) && (e.path === 'notes' || e.path === 'manuals' || e.path.startsWith('manuals/'))) {
            await scanDir(e.path, depth + 1);
          }
          continue;
        }
        if (e.type !== 'file') continue;
        const area = classifyHomeArea(e.path);
        // classifyHomeArea 的返回值含 'archive'（保留前缀判定在前，实际不会返回），
        // 这里收窄成索引面三区，顺带满足 reconcileIndex 的 Map 值类型。
        if (area === null || area === 'archive') continue;
        const st = await this.bridge.stat(dotId, e.path);
        if (st === null) continue;
        let tags: string[] = [];
        let title: string | null = null;
        if (area === 'notes' || area === 'manuals') {
          const text = await this.bridge.read(dotId, e.path);
          if (text !== null) {
            const head = parseFileHead(text);
            tags = head.tags;
            title = head.title;
          }
        }
        seen.set(e.path, { area, tags, title, sizeBytes: st.sizeBytes, mtimeMs: st.mtimeMs });
        report.scanned += 1;
      }
    };
    await scanDir('', 0);
    const diff = reconcileIndex(this.db, dotId, seen);
    report.added = diff.added;
    report.updated = diff.updated;
    report.removed = diff.removed;

    // §6.2：.tmp/ 中 mtime >1 天的残留由同步器经 /fs/ops 清理（rename 移入 .archive/tmp-residue/）
    const tmpEntries = await this.bridge.list(dotId, '.tmp');
    for (const e of tmpEntries) {
      if (e.type !== 'file') continue;
      const mtime = e.mtimeMs ?? 0;
      if (at - mtime > DAY_MS) {
        const target = `.archive/tmp-residue/${e.name}`;
        const ok = await this.bridge.rename(dotId, e.path, target);
        if (ok) report.tmpResidueMoved.push(e.path);
      }
    }
    this.writeKv('index_sync_last', String(at), at);
    return report;
  }

  /**
   * §3.5 触发条件探测（心跳 job memory-compaction 每小时调用）。
   *
   * fortnightly 是"两次兜底整理之间至少隔 14 天"的节流触发器：探测命中后
   * 立即推进 compact_due:<dotId> 游标到本次时刻，这样同一批 triggers 被
   * 心跳反复看到时不会每小时都重新满足（游标只读不写会让它退化成
   * "每次都触发"，与设计第 3 条相反）。其他两个触发器（notes_count>60 /
   * notes_stale>30d / home>1MB）与时间无关，无节流需求。
   */
  compactionTriggers(dotId: string): string[] {
    const usage = this.homeActiveUsage(dotId);
    const triggers = computeTriggers(this.db, dotId, this.now(), usage.activeBytes, usage.notesCount);
    if (triggers.includes('fortnightly')) {
      this.writeKv(`compact_due:${dotId}`, String(this.now()), this.now());
    }
    return triggers;
  }

  checkIntegrity(): void {
    // §6.3：integrity_check 失败 → ①不经 SQLite 直接 append 写 ~/.dotd/OUTBOX.md HELP 块
    //        （签名 db_corrupt）→ ②抛 MemoryCorruptionError（装配层拒启动）
    let ok = false;
    let detail = '';
    try {
      const row = this.db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined;
      ok = row?.integrity_check === 'ok';
      detail = row?.integrity_check ?? 'no_result';
    } catch (cause) {
      ok = false;
      detail = String(cause);
    }
    if (ok) return;
    try {
      appendOutboxBlock(
        this.outboxPath,
        'db_corrupt',
        `integrity_check 失败：${detail}\n拒绝启动（与控制面"迁移失败拒启动"同级别）。`,
        this.now(),
      );
    } catch {
      // 连 OUTBOX 都写不了时仍要抛错拒启动
    }
    const err = new MemoryCorruptionError(`integrity_check 未通过：${detail}`);
    this.onCorruption?.(err);
    throw err;
  }

  scanSessionBreaks(): { pending: SessionBreak[]; orphans: SessionBreak[] } {
    return scanSessionBreaks({ db: this.db, taskStatusProbe: this.taskStatusProbe });
  }

  /** §6.3：retention 回填（暴露给 Runner/CLI 手动触发；幂等）。 */
  backfillOrphanTaskEnds(now?: number): string[] {
    const at = now ?? this.now();
    const scan = scanSessionBreaks({ db: this.db, taskStatusProbe: this.taskStatusProbe });
    const out: string[] = [];
    for (const o of scan.orphans) {
      if (o.taskId === null) continue;
      backfillTaskEnd(this.db, o.threadId, o.taskId, 'seal_missed', at);
      out.push(o.taskId);
    }
    return out;
  }

  async runOutboxGuard(): Promise<{ rotated: number; kept: number; archivePath: string | null }> {
    return runOutboxGuard({
      outboxPath: this.outboxPath,
      unresolvedSignatures: this.unresolvedSignatures ?? undefined,
      now: this.now,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // §8 status() 与 §6.4 升级信号
  // ═══════════════════════════════════════════════════════════════════

  async status(): Promise<import('./types.ts').MemoryStatus> {
    const at = this.now();
    const dbBytes = dbSize(this.db);
    // §6.2：db 用量必须含 WAL 才是真实占用（wal_autocheckpoint=400 只做被动兜底，
    // 高写入负载下 WAL 可能远大于主库）。WAL 大小走 retention.walSize()
    // （`<db>-wal` stat；无 WAL 文件/内存库 → 0）。
    const walBytes = walSize(this.db);
    // §3.4：home 活跃集口径与 beforeWrite 的只读期判据同源（桥真实聚合 + 索引聚合取 max），
    // 避免 status() 报 0 字节却判 hard、而 beforeWrite 又放行的自相矛盾。
    const bridgedBytes = await this.homeActiveBytesFromBridge('dot1');
    const threads = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM mem_threads GROUP BY status')
      .all() as Array<{ status?: string; c?: number }>;
    const byStatus = (s: ThreadStatus): number =>
      threads.find((t) => t.status === s)?.c ?? 0;
    const pinned = this.db
      .prepare('SELECT COUNT(*) AS c FROM mem_threads WHERE pinned = 1')
      .get() as { c?: number } | undefined;

    // 待整理项（status() 是纯读，不做 fortnightly 游标推进——那属于心跳探测的副作用）
    const usage = this.homeActiveUsage('dot1');
    const activeBytes =
      bridgedBytes === null ? usage.activeBytes : Math.max(usage.activeBytes, bridgedBytes);
    const triggers = computeTriggers(this.db, 'dot1', this.now(), activeBytes, usage.notesCount);
    const summarizeDue = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM mem_threads t
         WHERE t.dot_id = 'dot1' AND (SELECT COUNT(*) FROM mem_messages m WHERE m.thread_id = t.id) > ?`,
      )
      .get(SUMMARIZE_MESSAGE_THRESHOLD) as { c?: number } | undefined;

    const stats = this.readSearchStats(at);
    return {
      db: {
        sizeBytes: dbBytes,
        walBytes,
        softLimitBytes: DB_SOFT_LIMIT_BYTES,
        hardLimitBytes: DB_HARD_LIMIT_BYTES,
        level: dbBytes > DB_HARD_LIMIT_BYTES ? 'hard' : dbBytes > DB_SOFT_LIMIT_BYTES ? 'soft' : 'ok',
      },
      home: {
        activeBytes,
        softLimitBytes: LIMIT_HOME_BYTES.soft,
        hardLimitBytes: LIMIT_HOME_BYTES.hard,
        notesCount: usage.notesCount,
        manualsBytes: usage.manualsBytes,
        indexedFiles: usage.indexedFiles,
        level: isReadonlyPhase(activeBytes)
          ? 'hard'
          : activeBytes > LIMIT_HOME_BYTES.soft
            ? 'soft'
            : 'ok',
      },
      threads: {
        active: byStatus('active'),
        idle: byStatus('idle'),
        sealed: byStatus('sealed'),
        purged: byStatus('purged'),
        pinned: pinned?.c ?? 0,
      },
      maintenance: {
        retentionLastRun: this.readKvNumber('retention_last_run'),
        indexSyncLast: this.readKvNumber('index_sync_last'),
        compactTriggers: triggers,
        summarizeDue: summarizeDue?.c ?? 0,
      },
      searchStats: stats,
      seal: {
        missed: this.readKvNumber('seal_missed_count') ?? 0,
        violations: this.readKvNumber('seal_violations') ?? 0,
        backfilled: this.readKvNumber('seal_backfilled') ?? 0,
      },
      feedback: {
        notes: this.feedbackCount(),
        recallMiss: this.feedbackRecallMiss(),
      },
      // FsOpsHttpBridge.available() 可能返回 Promise（探测一次连通性）
      bridge: { available: await this.bridge.available(), kind: this.bridge.kind },
    };
  }

  searchSignal(): SearchSignal {
    const at = this.now();
    const stats = this.readSearchStats(at);
    return {
      stats,
      zeroHitRate: stats.queries > 0 ? stats.zeroHits / stats.queries : 0,
      recallMissNotes: this.feedbackRecallMiss(),
    };
  }

  /** §6.4 信号① 的机读判定（持续两周由 retention 周报把关，这里只给当前值）。 */
  zeroHitSignalActive(): boolean {
    const s = this.searchSignal();
    return s.stats.queries >= 10 && s.zeroHitRate > SEARCH_ZERO_HIT_SIGNAL;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部辅助
  // ═══════════════════════════════════════════════════════════════════

  private loadThreadRow(threadId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM mem_threads WHERE id = ?').get(threadId);
    return row === undefined ? null : (row as Record<string, unknown>);
  }

  private writeKv(key: string, value: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO mem_maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, at);
  }

  private readKv(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM mem_maintenance_state WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private readKvNumber(key: string): number | null {
    const v = this.readKv(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** §4.3 markMemoryMissed(task.id)：计数 + 明细键。 */
  private markMissedRaw(taskId: string, outcome: string, at: number): void {
    const key = `missed:${taskId}`;
    const already = this.readKv(key);
    if (already !== null) return; // 幂等：同任务只记一次
    this.writeKv(key, outcome, at);
    const prev = this.readKvNumber('seal_missed_count') ?? 0;
    this.writeKv('seal_missed_count', String(prev + 1), at);
    if (outcome.startsWith('no_thread') || outcome === 'seal_missed') {
      const v = this.readKvNumber('seal_violations') ?? 0;
      this.writeKv('seal_violations', String(v + 1), at);
    }
    // 明细环形保留最近 200 条（复盘用；不占主链）
    const detail = this.readKv('missed_recent');
    let arr: Array<{ taskId: string; outcome: string; at: number }> = [];
    if (detail !== null) {
      try {
        const parsed = JSON.parse(detail) as unknown;
        if (Array.isArray(parsed)) arr = parsed as Array<{ taskId: string; outcome: string; at: number }>;
      } catch {
        arr = [];
      }
    }
    arr.push({ taskId, outcome, at });
    if (arr.length > 200) arr = arr.slice(arr.length - 200);
    let value = JSON.stringify(arr);
    if (Buffer.byteLength(value, 'utf8') > SEARCH_STATS_MAX_BYTES) {
      arr = arr.slice(Math.ceil(arr.length / 2));
      value = JSON.stringify(arr);
    }
    this.writeKv('missed_recent', value, at);
  }

  private readSearchStats(at: number): SearchStats {
    const raw = this.readKv('search_stats');
    if (raw === null) return { queries: 0, zeroHits: 0, sinceTs: at };
    try {
      const p = JSON.parse(raw) as { queries?: number; zeroHits?: number; sinceTs?: number };
      return {
        queries: typeof p.queries === 'number' ? p.queries : 0,
        zeroHits: typeof p.zeroHits === 'number' ? p.zeroHits : 0,
        sinceTs: typeof p.sinceTs === 'number' ? p.sinceTs : at,
      };
    } catch {
      return { queries: 0, zeroHits: 0, sinceTs: at };
    }
  }

  private feedbackCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM mem_messages m
         JOIN mem_threads t ON t.id = m.thread_id
         WHERE m.kind = 'memory_note' AND t.title = ?`,
      )
      .get(FEEDBACK_THREAD_TITLE) as { c?: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * §6.4 升级信号②：thr_feedback 中 tag = recall-miss 的条数。
   * 注意 content 是 JSON 串，`"tag":"recall-miss"` 带引号匹配，避免误命中
   * 正文里出现 recall-miss 字样的普通反馈。
   */
  private feedbackRecallMiss(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM mem_messages m
         JOIN mem_threads t ON t.id = m.thread_id
         WHERE m.kind = 'memory_note' AND t.title = ? AND m.content LIKE ?`,
      )
      .get(FEEDBACK_THREAD_TITLE, `%"tag":"${RECALL_MISS_TAG}"%`) as { c?: number } | undefined;
    return row?.c ?? 0;
  }

  /** 索引口径的 home 活跃集用量（mem_files_index 汇总，无桥也可用）。 */
  private homeActiveUsage(dotId: string): {
    activeBytes: number;
    notesCount: number;
    manualsBytes: number;
    indexedFiles: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS b, COUNT(*) AS c FROM mem_files_index WHERE dot_id = ?`,
      )
      .get(dotId) as { b?: number; c?: number } | undefined;
    // 排除口径与 limits.ts 的 NOTE_EXEMPT_RE 完全一致（月度摘要 + 下划线留痕）。
    // 不用 SQL LIKE 打这条口径：LIKE 的 `_` 是单字符通配符，`notes/_%` 会把
    // `notes/2026-01-01-x.md` 全误伤；要 ESCAPE 又必须在 SQL 字面量里堆 8 个
    // 反斜杠（TS 层）才拿到一个转义符，可读性与可维护性都不可接受。
    // 改为取回 path 列表后用 JS 正则判一次（与 beforeWrite 同源），索引行数在
    // 千级，成本可忽略。
    const noteRows = this.db
      .prepare('SELECT path FROM mem_files_index WHERE dot_id = ? AND area = ?')
      .all(dotId, 'notes') as Array<{ path?: unknown }>;
    let notesCount = 0;
    for (const r of noteRows) {
      const p = typeof r.path === 'string' ? r.path : '';
      // 只统计合法 note 名里"非豁免"的那批（口径 = NOTE_NAME_RE 且非 NOTE_EXEMPT_RE）
      if (p.length > 0 && !isNoteExempt(p)) notesCount += 1;
    }
    const manuals = this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS b FROM mem_files_index WHERE dot_id = ? AND area = 'manuals'`,
      )
      .get(dotId) as { b?: number } | undefined;
    return {
      activeBytes: row?.b ?? 0,
      notesCount,
      manualsBytes: manuals?.b ?? 0,
      indexedFiles: row?.c ?? 0,
    };
  }

  /**
   * home 活跃集真实聚合（§3.4「home 全量（不含 .archive/.dotd/.tmp）」）。
   *
   * 口径优先级：桥可达时按桥真实大小逐文件汇总（权威，未对账也能算对）；
   * 桥不可用时退回 mem_files_index 索引聚合。两者取 max 是为了在"索引滞后于
   * 桥"时不让判据变松——写前检查（只读期）必须比 status() 严。
   *
   * 修史：此前 homeUsageFromBridge 只 stat MEMORY.md + list notes/manuals 一层，
   * manuals/<domain>/*.md 子目录漏算；且 homeUsage 的只读期判据只认索引聚合值，
   * 索引缺失时 0 字节也能判 hard，而 beforeWrite 又放行——两条路径自相矛盾。
   */
  private async homeActiveBytesFromBridge(dotId: string): Promise<number | null> {
    if (this.bridge.available() === false) return null;
    const dirs = ['', 'notes', 'manuals'];
    let total = 0;
    const seen = new Set<string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const entries = await this.bridge.list(dotId, dir);
      for (const e of entries) {
        if (e.type === 'dir') {
          if (seen.has(e.path)) continue; // 防环
          seen.add(e.path);
          await walk(e.path, depth + 1);
          continue;
        }
        if (e.type !== 'file') continue;
        // 只计活跃集：保留前缀（.archive/.tmp/.dotd）与不合规路径不算
        if (isReservedPath(e.path) || classifyHomeArea(e.path) === null) continue;
        const st = await this.bridge.stat(dotId, e.path);
        if (st !== null) total += st.sizeBytes;
      }
    };
    for (const d of dirs) await walk(d, 0);
    return total;
  }

  /** 写前检查用的目标画像：索引 + 桥双口径，取更严者。 */
  private async homeUsage(
    dotId: string,
    normPath: string,
  ): Promise<{
    targetBytes: number;
    activeBytes: number;
    notesCount: number;
    manualsBytes: number;
    readonlyPhase: boolean;
  }> {
    const agg = this.homeActiveUsage(dotId);
    const row = this.db
      .prepare('SELECT size_bytes FROM mem_files_index WHERE dot_id = ? AND path = ?')
      .get(dotId, normPath) as { size_bytes?: number } | undefined;
    let targetBytes = row?.size_bytes ?? 0;
    // 索引缺失但桥上有真文件（未对账）→ 用桥 stat 补
    if (targetBytes === 0 && this.bridge.available() !== false) {
      const st = await this.bridge.stat(dotId, normPath);
      if (st !== null) targetBytes = st.sizeBytes;
    }
    // 活跃集总量：桥可达时用桥真实聚合，与索引聚合取 max（不让判据因索引滞后而放松）
    const bridged = await this.homeActiveBytesFromBridge(dotId);
    const activeBytes = bridged === null ? agg.activeBytes : Math.max(agg.activeBytes, bridged);
    return {
      targetBytes,
      activeBytes,
      notesCount: agg.notesCount,
      manualsBytes: agg.manualsBytes,
      readonlyPhase: isReadonlyPhase(activeBytes),
    };
  }

  /** §6.2：对外暴露库大小（CLI/status 用）。 */
  dbUsage(): { sizeBytes: number; softLimitBytes: number; hardLimitBytes: number } {
    const b = dbSize(this.db);
    return { sizeBytes: b, softLimitBytes: DB_SOFT_LIMIT_BYTES, hardLimitBytes: DB_HARD_LIMIT_BYTES };
  }

  /** §6.2：库超软限时提前 checkpoint（整理任务顺带，防 WAL 膨胀）。 */
  checkpointWal(): boolean {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch {
      return false;
    }
  }

  /** §6.2：硬限判定（供装配层在写入前拦一道，抛 MemoryCapacityError 走 SOS）。 */
  assertDbCapacity(): void {
    const b = dbSize(this.db);
    if (b > DB_HARD_LIMIT_BYTES) {
      throw new MemoryCapacityError(
        `库文件 ${(b / 1024 / 1024).toFixed(1)} MB 超硬限 500 MB，停止写入`,
      );
    }
  }

  /** §6.1：purge_ledger 追加（保留给 CLI/测试断言指纹留存）。 */
  recordPurge(threadId: string, summary: string, at: number, lastTaskFinishedAt: number): void {
    appendPurgeLedger(this.db, {
      threadId,
      summaryDigest: digest16(summary),
      deletedAt: at,
      lastTaskFinishedAt,
    });
  }

  /** §3.6：OUTBOX 追加（崩溃恢复路径由 checkIntegrity 调用；这里暴露给装配层）。 */
  appendOutbox(signature: string, body: string): void {
    appendOutboxBlock(this.outboxPath, signature, body, this.now());
  }

  /**
   * 诊断：展开后的 OUTBOX.md 绝对路径。
   * 构造时已做 ~ 展开（config/dotd.yml 的 alerts.outbox_path 与默认值都可能是 ~/...），
   * 因此这里返回的永远是可 fs.stat 的绝对路径。
   */
  outboxFilePath(): string {
    return this.outboxPath;
  }

  /** 诊断：当前桥种类。 */
  bridgeKind(): string {
    return this.bridge.kind;
  }

  /** 诊断：读一次 MEMORY.md（CLI notes show 用）。 */
  async readHomeFile(dotId: string, path: HomeRelPath): Promise<string | null> {
    const norm = normalizeHomePath(path);
    if (norm === null) return null;
    return this.bridge.read(dotId, norm);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 纯函数辅助（导出供测试）
// ═══════════════════════════════════════════════════════════════════

/** 读刚写入那行的 rowid（contentless FTS 需要用它当键；mem_messages 是 rowid 表）。 */
function midOfLastInsert(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT last_insert_rowid() AS r').get() as { r?: number } | undefined;
  return typeof row?.r === 'number' && row.r > 0 ? row.r : null;
}

/** LIKE 转义（§6.4：会话历史检索 = content LIKE + thread 时间窗）。 */
export function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/** §4.6 / 检索命中片段（前后各留上下文）。 */
export function makeSnippet(content: string, query: string, width = 60): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, width * 2);
  const start = Math.max(0, idx - width);
  return content.slice(start, start + query.length + width * 2).replace(/\s+/g, ' ');
}

/** §3.2 文件头元信息解析（date/task/tags 或 domain/status/last_used）。 */
export function parseFileHead(text: string): { tags: string[]; title: string | null; date: string | null } {
  const tags: string[] = [];
  let title: string | null = null;
  let date: string | null = null;
  const lines = text.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const t = line.trim();
    const tagsM = /^tags\s*:\s*\[(.*)\]/.exec(t);
    if (tagsM !== null) {
      for (const piece of tagsM[1]!.split(',')) {
        const v = piece.trim().replace(/^['"]|['"]$/g, '');
        if (v.length > 0) tags.push(v);
      }
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(t);
    if (h1 !== null && title === null) title = h1[1]!.trim();
    const dateM = /^date\s*:\s*(\S+)/.exec(t);
    if (dateM !== null) date = dateM[1]!;
  }
  return { tags, title, date };
}

/** §4.6：tool_* 消息只存 digest+200 字符预览（双写禁令）。 */
export function digestWithPreview(content: string): { digest: string; preview: string } {
  return {
    digest: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16),
    preview: content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) : content,
  };
}

/** §4.4：是否该投递摘要任务（消息数 >64 或注入估算超 4000 tokens）。 */
export function needsSummarize(messageCount: number, injectTokens: number): boolean {
  return messageCount > SUMMARIZE_MESSAGE_THRESHOLD || injectTokens > 4000;
}

/** §3.2：MEMORY.md 是否超硬限（CLI/status 用）。 */
export function memoryMdOverHardLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > 4 * 1024;
}

/** 内部：journal 步路径判据（含容器绝对路径与 home 相对路径两种形态）。 */
function isMemoryWritePathLoose(p: string): boolean {
  if (p.startsWith('/dot/home/')) {
    const rel = p.slice('/dot/home/'.length);
    return rel === 'MEMORY.md' || rel.startsWith('notes/') || rel.startsWith('manuals/');
  }
  return p === 'MEMORY.md' || p.startsWith('notes/') || p.startsWith('manuals/');
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
  return [];
}

/** 装配层工厂：openDb→migrate 之后由 daemon.ts 调用（契约 D2：共享同一连接）。 */
export function createMemoryService(deps: MemoryDeps): MemoryServiceImpl {
  return new MemoryServiceImpl(deps);
}

export { MemoryCapacityError, MemoryCorruptionError, estimateTokens, SEARCH_STATS_WINDOW_MS, existsSync, statSync };
