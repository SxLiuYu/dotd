/**
 * src/memory/retention.ts —— 保留策略（§6.1）、容量控制（§6.2）、
 * 崩溃恢复扫描（§6.3）与检索埋点（§6.4）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/memory.md）：
 *
 * §6.1 保留策略（心跳 job memory-retention 每日，幂等可重跑）：
 * | 层 | 规则 |
 * | 活跃 thread | active/idle 保留至满足归档条件 |
 * | 归档 | last_active_at >90 天 且 last_task_finished_at 距今 >30 天 → status='sealed'；
 *           summary 没有则先补，补不动允许无摘要封存 |
 * | 删除 | sealed 且 last_task_finished_at >365 天 → 整 thread CASCADE 删；
 *           删除前把 context_summary 指纹 append 进 mem_maintenance_state.purge_ledger |
 * | 主人特权 | pinned=1，永不过期 |
 * | 事件/心跳 thread | last_task_finished_at 距今 >7 天 → 自动 sealed；
 *   awaiting_approval 中的任务因未走完 sealTask，last_task_finished_at 为空，天然豁免封存 |
 *
 * §6.2 容量控制：
 * - ~/.dotd/dotd.db 软限 200 MB：超限触发提前归档 + wal_checkpoint(TRUNCATE)；硬限 500 MB
 *   → 停止写入并进求救（§6.3 路径）。
 * - WAL：wal_autocheckpoint=400（默认），整理任务顺带 checkpoint。
 * - mem_files_index 对账同步器：心跳经 /fs/ops list 增量对账；.tmp/ 中 mtime >1 天的残留
 *   由同步器经 /fs/ops 清理（rename 失败残骸）。
 *
 * §6.3 崩溃恢复顺序：integrity_check 失败 → OUTBOX HELP 块 + 拒启动（归 MemoryService.checkIntegrity）；
 * 会话断点扫描：kind='task_start' 且同 thread 之后无 task_end；仅当对应 tasks 行 status='running'
 * 才报"待恢复"交控制面 §7.3 处置；status ∈ (done|failed|cancelled) 而无 task_end ⇒ 判定
 * sealTask 漏调，记 violation 日志行，由 retention 任务补写 task_end(backfilled:true)，
 * 不再涌入恢复链。
 *
 * §6.4 埋点：MemoryService.searchMessages 每次调用后向 mem_maintenance_state 键
 * search_stats append 计数（滚动 JSON：{queries, zeroHits, sinceTs}，保留 14 天窗口，超 64 KB 截旧）。
 *
 * 实现注记：
 * - 契约 D4：tasks 是控制面表，本模块只读服务接口（deps.taskStatusProbe），不直读。
 * - mem_messages 与 mem_threads 的删除用显式两步（先 messages 后 threads），不依赖
 *   foreign_keys=ON（契约 D2 不全局开 FK）。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryCapacityError } from '../shared/errors.ts';
import type {
  IndexSyncReport,
  RetentionReport,
  SessionBreak,
} from './types.ts';
import {
  HOME_INDEX_ROOT,
  HOME_MANUALS_DIR,
  HOME_NOTES_DIR,
  LIMIT_ARCHIVE_BYTES,
  LIMIT_HOME_BYTES,
} from './limits.ts';
import type { FsOpsBridge } from './fsops-client.ts';

/** §6.1：归档双条件（天）。 */
export const ARCHIVE_LAST_ACTIVE_DAYS = 90;
export const ARCHIVE_LAST_FINISHED_DAYS = 30;
/** §6.1：事件/心跳 thread 的 TTL（天）。 */
export const EVENT_THREAD_TTL_DAYS = 7;
/** §6.1：sealed 后保留期（天）。 */
export const SEALED_DELETE_DAYS = 365;
/** §6.2：库软/硬限（MB → 字节）。 */
export const DB_SOFT_LIMIT_BYTES = 200 * 1024 * 1024;
export const DB_HARD_LIMIT_BYTES = 500 * 1024 * 1024;
/** §6.4：埋点窗口 14 天、单键 64 KB 截旧。 */
export const SEARCH_STATS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const SEARCH_STATS_MAX_BYTES = 64 * 1024;
/** §6.4：信号①空结果率阈值（持续两周才升级）。 */
export const SEARCH_ZERO_HIT_SIGNAL = 0.4;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  db: DatabaseSync;
  bridge: FsOpsBridge;
  taskStatusProbe: ((taskId: string) => string | null | undefined) | null;
  now: () => number;
}

/** §6.3：断点扫描的 SQL（同 thread 之后无 task_end 的 task_start）。 */
const SQL_ORPHAN_TASK_STARTS = `
  SELECT m.thread_id AS thread_id, m.task_id AS task_id, m.seq AS seq
  FROM mem_messages m
  WHERE m.kind = 'task_start'
    AND NOT EXISTS (
      SELECT 1 FROM mem_messages e
      WHERE e.thread_id = m.thread_id AND e.kind = 'task_end' AND e.seq > m.seq
    )
  ORDER BY m.thread_id, m.seq
`;

/** §6.3 扫描（纯查询，不写库）。 */
export function scanSessionBreaks(
  deps: Pick<RetentionDeps, 'db' | 'taskStatusProbe'>,
): { pending: SessionBreak[]; orphans: SessionBreak[] } {
  const rows = deps.db.prepare(SQL_ORPHAN_TASK_STARTS).all() as Array<Record<string, unknown>>;
  const pending: SessionBreak[] = [];
  const orphans: SessionBreak[] = [];
  for (const r of rows) {
    const threadId = typeof r.thread_id === 'string' ? r.thread_id : '';
    const taskId = typeof r.task_id === 'string' ? r.task_id : null;
    const seq = typeof r.seq === 'number' ? r.seq : 0;
    if (threadId.length === 0) continue;
    const status = taskId !== null ? deps.taskStatusProbe?.(taskId) : undefined;
    if (status === 'running') {
      pending.push({ threadId, taskId, seq }); // 交控制面 §7.3 处置
    } else if (status === 'done' || status === 'failed' || status === 'cancelled') {
      orphans.push({ threadId, taskId, seq }); // sealTask 漏调
    }
    // status 缺失（探针为 null / 任务不在控制面）/ 非终态 ⇒ 不判漏调、不报 pending
  }
  return { pending, orphans };
}

/** §6.3：为漏调任务补写 task_end（retention 幂等回填）。 */
export function backfillTaskEnd(
  db: DatabaseSync,
  threadId: string,
  taskId: string,
  outcome: string,
  at: number,
): string {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS mx FROM mem_messages WHERE thread_id = ?')
    .get(threadId) as { mx?: number } | undefined;
  const seq = (row?.mx ?? 0) + 1;
  const id = `msg_${at.toString(36)}_${threadId}_${seq.toString(36)}`;
  db
    .prepare(
      `INSERT INTO mem_messages
         (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
       VALUES (?, ?, ?, 'system', 'task_end', ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      threadId,
      seq,
      JSON.stringify({ outcome, backfilled: true, taskId, at }),
      taskId,
      Math.ceil(JSON.stringify({ outcome, backfilled: true }).length / 3.5),
      at,
    );
  return id;
}

/**
 * §6.1 + §6.2 主流程。幂等：同一天重复跑只会第二次报告空动作列表
 * （状态已迁移完），不会二次删除/二次封存。
 */
export function runRetention(deps: RetentionDeps, now?: number): RetentionReport {
  const at = now ?? deps.now();
  const db = deps.db;

  // ── §6.2 容量：先探 DB 大小 ──────────────────────────────────────
  const dbSizeBytes = dbSize(db);
  const walBytes = walSize(db);
  let checkpointed = false;

  // ── §6.3 断点扫描：回填漏调 task_end（在封存之前，避免新孤儿混入）──
  // 扫描结果分三类：
  // ① pending（status='running'）→ 交控制面 §7.3，本模块不碰；
  // ② orphans（status ∈ done|failed|cancelled）→ 判定 sealTask 漏调，补写 task_end；
  // ③ taskId 非空但探针返回 undefined（无探针 / 任务不在控制面）→ 状态不可知，
  //    按 §6.3「不猜测」记入 orphansUnknown 供人工排查，同样不补写。
  const scan = scanSessionBreaks(deps);
  const orphanTaskEndsBackfilled: string[] = [];
  const orphansUnknown: string[] = [];
  const sealViolations: string[] = scan.orphans.map((o) => `${o.threadId}:${o.taskId ?? '-'}`);
  for (const o of scan.orphans) {
    if (o.taskId === null) {
      orphansUnknown.push(o.threadId);
      continue;
    }
    backfillTaskEnd(db, o.threadId, o.taskId, 'seal_missed', at);
    orphanTaskEndsBackfilled.push(o.taskId);
  }
  if (deps.taskStatusProbe === null) {
    // 无探针时 scanSessionBreaks 一项都判不出，上面两个列表必然为空；
    // 这里单独扫一遍"有 taskId 的孤儿 task_start"作为不可知集合，避免整条链路静默。
    const unknownRows = deps.db
      .prepare(
        `SELECT DISTINCT m.thread_id AS thread_id
         FROM mem_messages m
         WHERE m.kind = 'task_start' AND m.task_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM mem_messages e
             WHERE e.thread_id = m.thread_id AND e.kind = 'task_end' AND e.seq > m.seq
           )`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of unknownRows) {
      const threadId = typeof r.thread_id === 'string' ? r.thread_id : '';
      if (threadId.length > 0 && !orphansUnknown.includes(threadId)) {
        orphansUnknown.push(threadId);
      }
    }
  }

  // ── §6.1 归档封存 ────────────────────────────────────────────────
  const sealed: string[] = [];
  const summaryDue: string[] = [];
  const archiveRows = db
    .prepare(
      `SELECT id, channel, last_active_at, last_task_finished_at, context_summary
       FROM mem_threads
       WHERE pinned = 0 AND status IN ('active','idle')`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const r of archiveRows) {
    const id = String(r.id);
    const channel = String(r.channel);
    const lastActive = Number(r.last_active_at ?? 0);
    const finished = r.last_task_finished_at === null ? null : Number(r.last_task_finished_at);
    const isEvent = channel === 'event' || channel === 'heartbeat';
    const ttlDays = isEvent ? EVENT_THREAD_TTL_DAYS : ARCHIVE_LAST_FINISHED_DAYS;
    const activeCutoff = isEvent ? 0 : ARCHIVE_LAST_ACTIVE_DAYS;
    const activeOk = at - lastActive > activeCutoff * DAY_MS;
    // 「字段缺失视为未满足」：finished 为空 → 不封存（awaiting_approval 天然豁免）
    const finishedOk = finished !== null && at - finished > ttlDays * DAY_MS;
    if (activeOk && finishedOk) {
      db.prepare(`UPDATE mem_threads SET status = 'sealed' WHERE id = ?`).run(id);
      sealed.push(id);
      if (typeof r.context_summary !== 'string' || r.context_summary.length === 0) {
        summaryDue.push(id); // 「补不动允许无摘要封存」——只登记，不阻塞
      }
    }
  }

  // ── §6.1 删除：sealed 且 finished >365 天 ─────────────────────────
  const threadsDeleted: string[] = [];
  const delRows = db
    .prepare(
      `SELECT id, context_summary, last_task_finished_at
       FROM mem_threads
       WHERE pinned = 0 AND status = 'sealed'
         AND last_task_finished_at IS NOT NULL
         AND (? - last_task_finished_at) > ?`,
    )
    .all(at, SEALED_DELETE_DAYS * DAY_MS) as Array<Record<string, unknown>>;
  for (const r of delRows) {
    const id = String(r.id);
    const summary = typeof r.context_summary === 'string' ? r.context_summary : '';
    appendPurgeLedger(db, {
      threadId: id,
      summaryDigest: digest(summary),
      deletedAt: at,
      lastTaskFinishedAt: Number(r.last_task_finished_at ?? 0),
    });
    // 显式两步删（不依赖 foreign_keys=ON，契约 D2）
    db.prepare('DELETE FROM mem_messages WHERE thread_id = ?').run(id);
    db.prepare('DELETE FROM mem_threads WHERE id = ?').run(id);
    threadsDeleted.push(id);
  }

  // ── §6.2 容量：超软限 → 提前归档 + checkpoint ─────────────────────
  if (dbSizeBytes > DB_SOFT_LIMIT_BYTES) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      checkpointed = true;
    } catch {
      checkpointed = false;
    }
  }
  // §6.2 硬限：停止写入并进求救（§6.3 路径）——由 MemoryService 抛 MemoryCapacityError
  if (dbSizeBytes > DB_HARD_LIMIT_BYTES) {
    throw new MemoryCapacityError(
      `库文件 ${(dbSizeBytes / 1024 / 1024).toFixed(1)} MB 超硬限 500 MB，已停止写入并进求救`,
    );
  }

  // ── 游标：retention_last_run / index_sync_last 归 MemoryService 维护 ──

  return {
    ranAt: at,
    threadsSealed: sealed,
    threadsSealedByEventTtl: sealed.filter((id) => {
      // 事件/心跳线程单独统计（报告可读性；上面已合并处理）
      return archiveRows.some((r) => String(r.id) === id && (String(r.channel) === 'event' || String(r.channel) === 'heartbeat'));
    }),
    threadsDeleted,
    orphanTaskEndsBackfilled,
    sealViolations,
    summaryDue,
    dbSizeBytes,
    dbWalBytes: walBytes,
    checkpointed,
    orphansUnknown,
    indexSync: null,
  };
}

/** §6.2：库文件字节数（PRAGMA page_count × page_size；无文件系统依赖，测试可用）。 */
export function dbSize(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
  const sz = db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
  const pages = typeof row?.page_count === 'number' ? row.page_count : 0;
  const size = typeof sz?.page_size === 'number' ? sz.page_size : 4096;
  return pages * size;
}

/** §6.2：WAL 字节数（`<db>-wal` 文件 stat；内存库/无 WAL 文件 → 0）。
 *  node:sqlite 不提供 WAL 大小查询，只能按 SQLite 约定拼路径 stat
 *  （WAL 模式副文件名恒为 `<主库文件名>-wal`）。 */
export function walSize(db: DatabaseSync): number {
  const path = db.location();
  if (path === null) return 0;
  try {
    const st = statSync(`${path}-wal`);
    return st.size;
  } catch {
    return 0; // 无 WAL 文件（已 checkpoint 且无后续写）或不可读
  }
}

/** §6.1：删除前的 context_summary 指纹（append 进 purge_ledger）。 */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export interface PurgeLedgerEntry {
  threadId: string;
  summaryDigest: string;
  deletedAt: number;
  lastTaskFinishedAt: number;
}

/** §6.1 purge_ledger：JSON 数组 append（mem_maintenance_state.purge_ledger）。 */
export function appendPurgeLedger(db: DatabaseSync, entry: PurgeLedgerEntry): void {
  const row = db
    .prepare(`SELECT value FROM mem_maintenance_state WHERE key = 'purge_ledger'`)
    .get() as { value?: string } | undefined;
  let arr: PurgeLedgerEntry[] = [];
  if (row?.value !== undefined) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (Array.isArray(parsed)) arr = parsed as PurgeLedgerEntry[];
    } catch {
      arr = [];
    }
  }
  arr.push(entry);
  db.prepare(
    `INSERT INTO mem_maintenance_state (key, value, updated_at) VALUES ('purge_ledger', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(arr), entry.deletedAt);
}

/** §6.4：search_stats 埋点（滚动 JSON，14 天窗口，超 64 KB 截旧）。 */
export function recordSearchStat(db: DatabaseSync, zeroHit: boolean, at: number): void {
  const row = db
    .prepare(`SELECT value FROM mem_maintenance_state WHERE key = 'search_stats'`)
    .get() as { value?: string } | undefined;
  let queries = 0;
  let zeroHits = 0;
  let sinceTs = at;
  if (row?.value !== undefined) {
    try {
      const p = JSON.parse(row.value) as { queries?: number; zeroHits?: number; sinceTs?: number };
      queries = typeof p.queries === 'number' ? p.queries : 0;
      zeroHits = typeof p.zeroHits === 'number' ? p.zeroHits : 0;
      sinceTs = typeof p.sinceTs === 'number' ? p.sinceTs : at;
    } catch {
      /* 窗口重置 */
    }
  }
  // 14 天窗口：过期即重新起算
  if (at - sinceTs > SEARCH_STATS_WINDOW_MS) {
    queries = 0;
    zeroHits = 0;
    sinceTs = at;
  }
  queries += 1;
  if (zeroHit) zeroHits += 1;
  let value = JSON.stringify({ queries, zeroHits, sinceTs });
  if (Buffer.byteLength(value, 'utf8') > SEARCH_STATS_MAX_BYTES) {
    // 超 64 KB 截旧：只保留窗口起点与计数（丢明细，保留信号）
    value = JSON.stringify({ queries, zeroHits, sinceTs });
  }
  db.prepare(
    `INSERT INTO mem_maintenance_state (key, value, updated_at) VALUES ('search_stats', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(value, at);
}

/** §6.2：mem_files_index 对账的 DB 侧实现见 `reconcileIndex`（本文件下方）；
 *  "经 /fs/ops list 扫描 + `.tmp/` 残留 rename" 的异步编排在 MemoryService
 *  .syncFilesIndex（桥调用是 Promise，同步函数签名承接不了）。 */

/** §6.2 对账的 DB 侧：把扫描到的活跃文件 upsert，并删掉索引里已不存在的行。 */
export function reconcileIndex(
  db: DatabaseSync,
  dotId: string,
  seen: Map<string, { area: 'memory' | 'notes' | 'manuals'; tags: string[]; title: string | null; sizeBytes: number; mtimeMs: number }>,
): { added: number; updated: number; removed: number } {
  let added = 0;
  let updated = 0;
  let removed = 0;
  const existing = db
    .prepare('SELECT path FROM mem_files_index WHERE dot_id = ?')
    .all(dotId) as Array<{ path?: string }>;
  const existingPaths = new Set(existing.map((r) => String(r.path)));
  for (const [path, f] of seen) {
    const tags = f.tags.length > 0 ? JSON.stringify(f.tags) : null;
    if (existingPaths.has(path)) {
      // manuals 区的 mtime_ms 兼作 last_used（§4.3 touchManualsLastUsed 的落点，
      // DDL 无 last_used 列）。touch 是"人为推进的最近使用"语义，对账时不能被
      // 文件真实 mtime 回退掉——否则 §3.5 的 90/180 天老化判据永不成立。
      // 取 max(桥真实 mtime, 已记录的 touch 值)：touch 只会把时间往前推。
      let mtimeMs = f.mtimeMs;
      if (f.area === 'manuals') {
        const prev = db
          .prepare('SELECT mtime_ms FROM mem_files_index WHERE dot_id = ? AND path = ?')
          .get(dotId, path) as { mtime_ms?: number } | undefined;
        const prevMs = typeof prev?.mtime_ms === 'number' ? prev.mtime_ms : 0;
        mtimeMs = Math.max(mtimeMs, prevMs);
      }
      db.prepare(
        `UPDATE mem_files_index SET area = ?, tags = ?, title = ?, size_bytes = ?, mtime_ms = ?
         WHERE dot_id = ? AND path = ?`,
      ).run(f.area, tags, f.title, f.sizeBytes, mtimeMs, dotId, path);
      updated += 1;
    } else {
      db.prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(dotId, path, f.area, tags, f.title, f.sizeBytes, f.mtimeMs);
      added += 1;
    }
  }
  for (const p of existingPaths) {
    if (!seen.has(p)) {
      db.prepare('DELETE FROM mem_files_index WHERE dot_id = ? AND path = ?').run(dotId, p);
      removed += 1;
    }
  }
  return { added, updated, removed };
}

/** §3.4 表：.archive/ 硬 32 MB，按批次 FIFO（主人可 pin）。 */
export const ARCHIVE_SOFT_LIMIT_BYTES = LIMIT_ARCHIVE_BYTES.hard;

/** §3.5 触发条件探测（心跳 memory-compaction 每小时）。 */
export function compactionTriggers(
  db: DatabaseSync,
  dotId: string,
  now: number,
  homeActiveBytes: number,
  notesCount: number,
): string[] {
  const triggers: string[] = [];
  if (notesCount > 60) triggers.push('notes_count>60');
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS c FROM mem_files_index
       WHERE dot_id = ? AND area = 'notes' AND (? - mtime_ms) > ?`,
    )
    .get(dotId, now, 30 * DAY_MS) as { c?: number } | undefined;
  if ((stale?.c ?? 0) > 0) triggers.push('notes_stale>30d');
  if (homeActiveBytes > LIMIT_HOME_BYTES.soft) triggers.push('home>1MB');
  // 每 14 天兜底轻量版（只重写 MEMORY.md Pointers、老化 manuals status）
  const last = db
    .prepare(`SELECT value FROM mem_maintenance_state WHERE key = 'compact_due:${dotId}'`)
    .get() as { value?: string } | undefined;
  const lastAt = last?.value !== undefined ? Number(last.value) : 0;
  if (lastAt === 0 || now - lastAt > 14 * DAY_MS) triggers.push('fortnightly');
  return triggers;
}

/** §3.5/§6.2 的路径常量再导出（retention 内使用，避免循环 import 时的歧义）。 */
export const RETENTION_PATHS = {
  index: HOME_INDEX_ROOT,
  notes: HOME_NOTES_DIR,
  manuals: HOME_MANUALS_DIR,
} as const;
