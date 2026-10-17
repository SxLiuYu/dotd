/**
 * src/governance/audit.ts —— 治理审计日志：只追加写入 + 保留回收（GOV §6）。
 *
 * 逐字来源：governance.md §6.1 动作枚举、§6.2 保留上限与回收；
 * 落库结构见 db/migrations/020_governance.sql:85-103（audit_log / audit_archive 两张表，
 * **不加列不改结构**——契约 D2）。
 *
 * 三条硬规则（§6 原文）：
 * 1. 只追加：本模块不提供任何 UPDATE/DELETE audit_log 的公开入口（除 §6.2 的归档删除）；
 * 2. `details` 超 2KB ⇒ 存截断文并置 `details_truncated=1`；
 * 3. 在线窗口 `max(90 天, 20000 行)`，cron `compactAudit()` 每日按 **id 区间**归档。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sanitizeText } from './config.ts';

/** GOV §6.1 动作枚举（21 个；audit_log.action **不加 CHECK**，加枚举不必走迁移）。 */
export type AuditAction =
  | 'decision'
  | 'approval_created'
  | 'approval_decided'
  | 'late_decision'
  | 'approval_expired'
  | 'approval_revoked'
  | 'approval_claimed'
  | 'reentry_after_terminal'
  | 'memory_created'
  | 'memory_revoked'
  | 'memory_hit'
  | 'memory_expired'
  | 'precheck'
  | 'precheck_degraded'
  | 'postreview'
  | 'spend_recorded'
  | 'spend_voided'
  | 'emergency_on'
  | 'emergency_off'
  | 'quarantine'
  | 'quarantine_lifted'
  | 'catalog_reloaded'
  | 'illegal_transition';

/** 审计动作的 actor 三值（§7 DDL 注释：'agent'|'owner'|'system'）。 */
export type AuditActor = 'agent' | 'owner' | 'system';

/** 一条审计写入请求（调用方只填业务字段，ts/id 由 DB 默认值与函数补）。 */
export interface AuditEntry {
  dotId?: string | null;
  taskId?: string | null;
  journalStep?: string | null;
  decisionId?: string | null;
  approvalId?: number | null;
  actor: AuditActor;
  channel?: 'web' | 'telegram' | 'cli' | 'system' | null;
  action: AuditAction;
  tier?: string | null;
  tool?: string | null;
  /** 该次治理动作的裁决（allow/review_pass/approve/deny…）。 */
  decision?: string | null;
  reason?: string | null;
  /** 任意 JSON；入库前 sanitize + 超 2KB 截断。 */
  details?: unknown;
}

/** details 截断阈值（GOV §6.2 实列，评审缺口#9）。 */
export const DETAILS_LIMIT = 2 * 1024;

/**
 * GOV §6.2 截断标记：`details` 超 2KB ⇒ 存截断文并置 `details_truncated=1`。
 * 序列化走 JSON.stringify；undefined → NULL。截断时附 `…[truncated]` 尾巴便于人读识别。
 */
export function encodeDetails(details: unknown): { json: string | null; truncated: number } {
  if (details === undefined || details === null) return { json: null, truncated: 0 };
  let raw: string;
  try {
    raw = JSON.stringify(details) ?? 'null';
  } catch (cause) {
    // 循环引用/大数字等：退化为文案，绝不因为审计写不进而炸掉业务路径。
    raw = JSON.stringify({ unserializable: String(cause) });
  }
  const text = sanitizeText(raw);
  if (text.length <= DETAILS_LIMIT) return { json: text, truncated: 0 };
  const cut = text.slice(0, DETAILS_LIMIT - '…[truncated]'.length) + '…[truncated]';
  return { json: cut, truncated: 1 };
}

/** GOV §6：只追加写入一条审计（返回自增 id，便于调用方串联）。 */
export function appendAudit(db: DatabaseSync, entry: AuditEntry): number {
  const { json, truncated } = encodeDetails(entry.details);
  // §7「入库与出图前各跑一遍」：audit_log 也是入库面，reason/tool 等文本字段同样脱敏
  // （模型自填文本可能带 cookie/token 形态——审计是给人看的，但不能把凭据抄进本地库）。
  const sanitized = (v: string | null | undefined): string | null =>
    v === null || v === undefined ? null : sanitizeText(v);
  const res = db
    .prepare(
      `INSERT INTO audit_log
         (dot_id, task_id, journal_step, decision_id, approval_id,
          actor, channel, action, tier, tool, decision, reason, details_json, details_truncated)
       VALUES ($dotId, $taskId, $journalStep, $decisionId, $approvalId,
               $actor, $channel, $action, $tier, $tool, $decision, $reason, $detailsJson, $detailsTruncated)`,
    )
    .run({
      dotId: entry.dotId ?? null,
      taskId: entry.taskId ?? null,
      journalStep: entry.journalStep ?? null,
      decisionId: entry.decisionId ?? null,
      approvalId: entry.approvalId ?? null,
      actor: entry.actor,
      channel: entry.channel ?? null,
      action: entry.action,
      tier: entry.tier ?? null,
      tool: sanitized(entry.tool),
      decision: entry.decision ?? null,
      reason: sanitized(entry.reason),
      detailsJson: json,
      detailsTruncated: truncated,
    }) as unknown as { changes: number; lastInsertRowid: number | bigint };
  return Number(res.lastInsertRowid);
}

/** 审计行投影（Web「审计」页 / CLI `dotd audit tail/replay` 只读展示）。 */
export interface AuditRow {
  id: number;
  ts: string;
  dotId: string | null;
  taskId: string | null;
  journalStep: string | null;
  decisionId: string | null;
  approvalId: number | null;
  actor: string;
  channel: string | null;
  action: AuditAction;
  tier: string | null;
  tool: string | null;
  decision: string | null;
  reason: string | null;
  detailsJson: string | null;
  detailsTruncated: number;
}

const AUDIT_COLUMNS = `id, ts, dot_id, task_id, journal_step, decision_id, approval_id,
       actor, channel, action, tier, tool, decision, reason, details_json, details_truncated`;

function toAuditRow(r: Record<string, unknown>): AuditRow {
  return {
    id: Number(r.id),
    ts: String(r.ts),
    dotId: (r.dot_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    journalStep: (r.journal_step as string | null) ?? null,
    decisionId: (r.decision_id as string | null) ?? null,
    approvalId: r.approval_id === null || r.approval_id === undefined ? null : Number(r.approval_id),
    actor: String(r.actor),
    channel: (r.channel as string | null) ?? null,
    action: String(r.action) as AuditAction,
    tier: (r.tier as string | null) ?? null,
    tool: (r.tool as string | null) ?? null,
    decision: (r.decision as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    detailsJson: (r.details_json as string | null) ?? null,
    detailsTruncated: Number(r.details_truncated ?? 0),
  };
}

/** GOV §6：`dotd audit tail`——按 id 倒序取最近 n 条（人读时序正序返回）。 */
export function tailAudit(db: DatabaseSync, n = 50): AuditRow[] {
  const rows = db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id DESC LIMIT $n`)
    .all({ n: Math.max(1, Math.floor(n)) }) as unknown as Record<string, unknown>[];
  return rows.map(toAuditRow).reverse();
}

/** GOV §6：`dotd audit replay`——按过滤条件正序回放（task/step/decision 三索引可走）。 */
export function replayAudit(
  db: DatabaseSync,
  filter: { taskId?: string; journalStep?: string; decisionId?: string; limit?: number } = {},
): AuditRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.taskId !== undefined) {
    where.push('task_id = $taskId');
    params.taskId = filter.taskId;
  }
  if (filter.journalStep !== undefined) {
    where.push('journal_step = $journalStep');
    params.journalStep = filter.journalStep;
  }
  if (filter.decisionId !== undefined) {
    where.push('decision_id = $decisionId');
    params.decisionId = filter.decisionId;
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  params.limit = Math.max(1, Math.floor(filter.limit ?? 500));
  const rows = db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log${clause} ORDER BY id ASC LIMIT $limit`)
    .all(params as Record<string, never>) as unknown as Record<string, unknown>[];
  return rows.map(toAuditRow);
}

// ── §6.2 保留上限与回收 ──────────────────────────────────────────────────────

/** 归档单位：一段连续的 audit_log id 区间（§6.2「以 id 区间为归档单位」）。 */
export interface ArchiveSegment {
  minId: number;
  maxId: number;
  minTs: string;
  maxTs: string;
  rows: number;
  /** 估算字节数（行数 × 平均行长 + 固定开销；用于 ≤10MB 分段判定）。 */
  bytes: number;
}

export interface CompactOptions {
  /** 在线窗口天数（默认 GOV_DEFAULTS.auditRetentionDays=90）。 */
  retentionDays: number;
  /** 单段字节上限（默认 10MB）。 */
  chunkBytes: number;
  /** 归档目录（缺省从库文件目录推导 `<dbdir>/audit-archive`）。 */
  archiveDir?: string;
  /** 归档总量上限（MB，默认 200）；超限删最旧文件 + manifest 行。 */
  archiveCapMb: number;
}

export interface CompactResult {
  /** 本次归档的段（空 = 无需回收）。 */
  archived: ArchiveSegment[];
  /** 因超总量上限被删掉的最旧归档文件名。 */
  deletedFiles: string[];
  /** 归档后的 audit_log 行数。 */
  remaining: number;
}

/**
 * 从库文件路径推导归档目录：`PRAGMA database_list` 的 main 文件同级的 `audit-archive/`。
 * （GOV 不为归档另开配置项；库在测试里落在临时目录，归档自然跟着走，不碰真实 ~/.dotd。）
 */
export function defaultArchiveDir(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA database_list').get() as
    | { file?: string | null }
    | undefined;
  const file = row?.file;
  const dir = typeof file === 'string' && file.length > 0 ? dirname(file) : process.cwd();
  return join(dir, 'audit-archive');
}

/**
 * GOV §6.2 compactAudit() 的 cron 日任务：
 * 1. 以 id 区间为归档单位：`SELECT min(id),max(id),count(*) … WHERE ts < cutoff GROUP BY`
 *    每 ≤10MB 一段；
 * 2. 导出 `audit-<minid>-<maxid>.jsonl.gz` + sha256 入库（audit_archive 行）；
 * 3. `DELETE FROM audit_log WHERE id BETWEEN @min AND @max` 同事务提交；
 * 4. 归档总量 ≤ `DOTD_AUDIT_ARCHIVE_MB`（默认 200MB），超限删最旧文件 + manifest 行。
 */
export function compactAudit(db: DatabaseSync, opts: CompactOptions): CompactResult {
  const archiveDir = opts.archiveDir ?? defaultArchiveDir(db);
  const cutoff = new Date(Date.now() - opts.retentionDays * 86_400_000).toISOString();
  const avgRowBytes = estimateAvgRowBytes(db);

  // 1. 取候选区间：早于 cutoff 的行按 id 连续分段。
  const candidates = db
    .prepare(
      `SELECT id, ts FROM audit_log WHERE ts < $cutoff ORDER BY id ASC`,
    )
    .all({ cutoff }) as unknown as { id: number; ts: string }[];

  const segments: ArchiveSegment[] = [];
  if (candidates.length === 0) {
    enforceArchiveCap(db, archiveDir, opts.archiveCapMb);
    return { archived: [], deletedFiles: [], remaining: countRows(db) };
  }

  let cur: { minId: number; maxId: number; minTs: string; maxTs: string; rows: number; bytes: number } | null =
    null;
  for (const row of candidates) {
    const bytes = avgRowBytes + 64; // 每行固定开销（id/ts/换行）
    if (cur === null || cur.bytes + bytes > opts.chunkBytes) {
      if (cur !== null) segments.push(cur);
      cur = {
        minId: Number(row.id),
        maxId: Number(row.id),
        minTs: String(row.ts),
        maxTs: String(row.ts),
        rows: 1,
        bytes,
      };
      continue;
    }
    cur.maxId = Number(row.id);
    cur.maxTs = String(row.ts);
    cur.rows += 1;
    cur.bytes += bytes;
  }
  if (cur !== null) segments.push(cur);

  // 2+3. 逐段：写文件 → manifest 行 → 同事务删行。
  const archived: ArchiveSegment[] = [];
  for (const seg of segments) {
    const rows = db
      .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE id BETWEEN $min AND $max ORDER BY id ASC`)
      .all({ min: seg.minId, max: seg.maxId }) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;

    const jsonl = rows.map((r) => JSON.stringify(toAuditRow(r))).join('\n') + '\n';
    const gz = gzipSync(Buffer.from(jsonl, 'utf8'), { level: 6 });
    const sha256 = createHash('sha256').update(gz).digest('hex');
    const file = `audit-${seg.minId}-${seg.maxId}.jsonl.gz`;

    mkdirSync(archiveDir, { recursive: true });
    const abs = join(archiveDir, file);
    if (existsSync(abs)) rmSync(abs);
    writeFileSync(abs, gz);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO audit_archive (file, min_id, max_id, min_ts, max_ts, rows, bytes, sha256)
         VALUES ($file, $minId, $maxId, $minTs, $maxTs, $rows, $bytes, $sha256)`,
      ).run({
        file,
        minId: seg.minId,
        maxId: seg.maxId,
        minTs: seg.minTs,
        maxTs: seg.maxTs,
        rows: seg.rows,
        bytes: gz.byteLength,
        sha256,
      });
      db.prepare('DELETE FROM audit_log WHERE id BETWEEN $min AND $max').run({
        min: seg.minId,
        max: seg.maxId,
      });
      db.exec('COMMIT');
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 已回滚
      }
      throw cause;
    }
    archived.push({ ...seg, bytes: gz.byteLength });
  }

  // 4. 总量上限：超限删最旧文件 + manifest 行（最旧 = min_id 最小）。
  const deletedFiles = enforceArchiveCap(db, archiveDir, opts.archiveCapMb);
  return { archived, deletedFiles, remaining: countRows(db) };
}

function countRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS n FROM audit_log').get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function estimateAvgRowBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT avg(length(coalesce(details_json,'')) + length(coalesce(reason,'')) + 96) AS b
         FROM audit_log WHERE id > (SELECT max(id) FROM audit_log) - 200`,
    )
    .get() as { b?: number | null } | undefined;
  const b = row?.b;
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? Math.floor(b) : 220;
}

/** §6.2 第 4 步：归档总量超上限时删最旧文件 + manifest 行，返回删掉的文件名。 */
export function enforceArchiveCap(
  db: DatabaseSync,
  archiveDir: string,
  capMb: number,
): string[] {
  const capBytes = capMb * 1024 * 1024;
  const rows = db
    .prepare('SELECT file, bytes, min_id FROM audit_archive ORDER BY min_id ASC')
    .all() as unknown as { file: string; bytes: number; min_id: number }[];
  let total = rows.reduce((sum, r) => sum + Number(r.bytes), 0);
  const deleted: string[] = [];
  for (const r of rows) {
    if (total <= capBytes) break;
    const abs = join(archiveDir, r.file);
    try {
      if (existsSync(abs)) unlinkSync(abs);
    } catch {
      // 文件已不在：仍清 manifest 行，避免永久漏账
    }
    db.prepare('DELETE FROM audit_archive WHERE file = $file').run({ file: r.file });
    total -= Number(r.bytes);
    deleted.push(r.file);
  }
  return deleted;
}

/** 读回一个归档段的 sha256 与行数（CLI `dotd audit replay` 归档回放/校验用）。 */
export function verifyArchiveFile(
  absPath: string,
  expectSha256: string,
): { ok: boolean; bytes: number; sha256: string } {
  const buf = readFileSync(absPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { ok: sha256 === expectSha256, bytes: buf.byteLength, sha256 };
}

// ── §6.2 表清理（90 天，仅终态行且无被引用）────────────────────────────────────

export interface PurgeResult {
  approvals: number;
  decisions: number;
  quarantines: number;
}

/**
 * GOV §6.2 表清理：90 天前的终态行，且**无被引用**才删
 * （`spend_ledger.approval_id`、`audit_log.approval_id` 指向的 approvals 行保留；
 * audit_log.decision_id 指向的 decisions 行保留——LEFT JOIN 反连接删除）。
 *
 * `decisions` 与 `quarantines` 的 active 行永不清理（active quarantine 无此状态，见 DDL
 * status CHECK 只有 active/lifted；expired 的 decisions 满 90 天清）。
 */
export function purgeTerminal(db: DatabaseSync, retentionDays: number): PurgeResult {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result: PurgeResult = { approvals: 0, decisions: 0, quarantines: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    // approvals：终态 + 无 spend_ledger/audit_log 引用（反连接删除）。
    const a = db
      .prepare(
        `DELETE FROM approvals
          WHERE status IN ('rejected','expired','executed','failed','revoked')
            AND created_at < $cutoff
            AND NOT EXISTS (SELECT 1 FROM spend_ledger s WHERE s.approval_id = approvals.id)
            AND NOT EXISTS (SELECT 1 FROM audit_log g WHERE g.approval_id = approvals.id)`,
      )
      .run({ cutoff }) as unknown as { changes: number };
    result.approvals = Number(a.changes);

    // decisions：无 audit_log 引用才删（active 隔离永不清理，其 decision_id 被 quarantines 引用）。
    const d = db
      .prepare(
        `DELETE FROM decisions
          WHERE ts < $cutoff
            AND NOT EXISTS (SELECT 1 FROM audit_log g WHERE g.decision_id = decisions.id)
            AND NOT EXISTS (SELECT 1 FROM quarantines q WHERE q.decision_id = decisions.id)`,
      )
      .run({ cutoff }) as unknown as { changes: number };
    result.decisions = Number(d.changes);

    // quarantines：仅 lifted 且满 90 天（active 永不清理，§6.2 逐字）。
    const q = db
      .prepare(`DELETE FROM quarantines WHERE status = 'lifted' AND lifted_at < $cutoff`)
      .run({ cutoff }) as unknown as { changes: number };
    result.quarantines = Number(q.changes);

    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }
  return result;
}

/** 记忆表终态行清理（GOV §6.2：approval_rules/endpoint_grants 终态行同 90 天清理）。 */
export function purgeMemoryTerminal(db: DatabaseSync, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const r = db
    .prepare(
      `DELETE FROM approval_rules
        WHERE status IN ('revoked','expired') AND created_at < $cutoff`,
    )
    .run({ cutoff }) as unknown as { changes: number };
  const g = db
    .prepare(
      `DELETE FROM endpoint_grants
        WHERE status IN ('revoked','expired') AND created_at < $cutoff`,
    )
    .run({ cutoff }) as unknown as { changes: number };
  return Number(r.changes) + Number(g.changes);
}

/** 归档目录大小（MB，供 CLI 展示与测试断言）。 */
export function archiveSizeMb(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try {
      total += statSync(join(dir, f)).size;
    } catch {
      // 竞态删除
    }
  }
  return total / (1024 * 1024);
}
