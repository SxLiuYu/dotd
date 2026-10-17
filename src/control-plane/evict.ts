/**
 * src/control-plane/evict.ts —— 队列淘汰（CP §4.4）+ 磁盘回收（CP §6.5）。
 *
 * 淘汰（CP §4.4，issue #15）：只在 submit/匹配产出 run_new 时、且当前 queued 数已达上限触发：
 *   候选 = 已存在 status='queued' 且 source_event_id 非空（自动生成）的任务，
 *         按 (priority DESC, created_at ASC) 排序；主人手动提交的任务永不入候选。
 *   （已知跨 dot 副作用与「为何不限定 dotId」的权衡见 evictForIncoming 内注释。）
 *   先试 merge（§6.2 合法目标集；running 走 note 注记）——由 match.ts 完成；
 *   merge 失败（无同目标）且 queued 已满 → 淘汰候选队首 → cancelled，
 *         记 resource_events(kind='queue_evict', detail=taskId)，腾位后再建新任务。
 *   stop_reason 不新增 evict 枚举（新枚举 queue_evict 已加在 resource_events.kind）。
 *
 * 磁盘回收（CP §6.5）：内部 job `queue.gc`（经 registerInternalJob 注册，每日 04:00 本地时区，
 * 与 surfaces event_log purge 同刻错峰）：task_results/steps/event_decisions/journal-blobs
 * 终态 >30 天清理（steps 删前把摘要写回 task_results.summary），tasks 骨架 >180 天删；
 * VACUUM INTO 目标 <500MB，超限先删再 wal_checkpoint(TRUNCATE)+VACUUM。
 * event_decisions 按 events.id 级联（surfaces purge 掉 event_log 行后，本模块清对应 decision）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlPlaneConfig } from './types.ts';
import type { Queue } from './queue.ts';

export interface EvictDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  queue: Queue;
  record(kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  /** journal-blobs 目录（绝对路径；由装配层从 dataDir 推出）。 */
  blobDirAbs: string;
}

/**
 * CP §4.4：queued 已达上限且 merge 失败时，淘汰候选队首（最旧最低优先自动任务）。
 * 返回被淘汰的 taskId 列表（供调用方记 resource_events / 测试断言）。
 */
export function evictForIncoming(
  db: DatabaseSync,
  cfg: ControlPlaneConfig,
  queue: Queue,
  _dotId: string,
  deps?: Partial<Pick<EvictDeps, 'record' | 'bus'>>,
): string[] {
  const need = 1; // 每次 run_new 只腾一个位（CP §4.4「淘汰候选队首」）
  // 候选 = 已存在 status='queued' 且 source_event_id 非空（自动生成）任务，
  // 按 (priority DESC, created_at ASC) 排序；主人手动提交（source_event_id IS NULL）
  // 永不入候选。
  //
  // 已知副作用（审码 finding，经权衡保留字面语义）：候选**不按 dotId 限定**。
  // 理由：queued 上限（cfg.maxQueued）本身是全局计数，CP §4.4 的淘汰目的是「腾位」；
  // 若限定同 dot，则「全局 queued 已满但本 dot 无 queued 自动任务」时腾不出位，
  // 新任务会把全局 queued 推过上限——与 §4.4 的配额意图冲突。
  // 代价：dot2 的入站事件可能淘汰 dot1 的队首自动任务（跨 dot 副作用）。
  // 若后续确认要 per-dot 配额，需同时把 maxQueued/queuedCount 改为 per-dot 计数，
  // 只改候选 SQL 会造成「腾位无效」的半吊子状态。
  const victims = db
    .prepare(
      `SELECT id FROM tasks
       WHERE status='queued' AND source_event_id IS NOT NULL
       ORDER BY priority DESC, created_at ASC LIMIT ?`,
    )
    .all(need) as Array<{ id: string }>;
  const evicted: string[] = [];
  for (const v of victims) {
    queue.cancelDirect(v.id, 'user');
    evicted.push(v.id);
    // CP §4.4：淘汰必须记 resource_events(kind='queue_evict', detail=taskId)。
    deps?.record?.('queue_evict', 'normal', v.id);
    deps?.bus?.publish('task.state', { taskId: v.id, to: 'cancelled', evict: true });
  }
  void cfg;
  return evicted;
}

/**
 * CP §6.5 每日 `queue.gc` 内部 job。
 * 步骤（逐字）：
 * 1. 终态 >30 天：steps 删前把摘要写回 task_results.summary；删 task_results/steps；
 *    event_decisions 按 events.id 级联清（surfaces purge 后的孤儿决策）。
 * 2. tasks 骨架 >180 天删。
 * 3. journal-blobs 终态任务目录清。
 * 4. `VACUUM INTO` 目标 <500MB；超限先删再 wal_checkpoint(TRUNCATE)+VACUUM。
 */
export function runQueueGc(deps: EvictDeps, now = Date.now()): {
  stepsDeleted: number;
  tasksDeleted: number;
  decisionsDeleted: number;
  blobsDeleted: number;
  vacuumed: boolean;
} {
  const db = deps.db;
  const terminalCutoff = now - deps.cfg.gcTerminalDays * 86_400_000;
  const taskCutoff = now - deps.cfg.gcTaskDays * 86_400_000;

  // 1a. steps 删前把摘要写回 task_results.summary（CP §6.5 逐字）
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO task_results(task_id, summary, ok)
       SELECT s.task_id,
              'GC 摘要：' || GROUP_CONCAT(s.tool_name || '#' || s.seq || ':' || s.status, ' | '),
              0
       FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE t.status IN ('done','failed','cancelled') AND t.updated_at < ?
       GROUP BY s.task_id
       ON CONFLICT(task_id) DO UPDATE SET summary=excluded.summary`,
    ).run(terminalCutoff);

    const steps = db
      .prepare(
        `DELETE FROM steps WHERE task_id IN (
           SELECT id FROM tasks WHERE status IN ('done','failed','cancelled') AND updated_at < ?)`,
      )
      .run(terminalCutoff);
    const decisions = db
      .prepare(
        `DELETE FROM event_decisions WHERE event_id IN (
           SELECT id FROM events WHERE received_at < ?)`,
      )
      .run(terminalCutoff);
    const results = db
      .prepare(
        `DELETE FROM task_results WHERE task_id IN (
           SELECT id FROM tasks WHERE status IN ('done','failed','cancelled') AND updated_at < ?)`,
      )
      .run(terminalCutoff);
    db.exec('COMMIT');
    var stepsDeleted = Number(steps.changes);
    var decisionsDeleted = Number(decisions.changes);
    void results;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw err;
  }

  // 2. tasks 骨架 >180 天
  const tasks = db
    .prepare(
      `DELETE FROM tasks WHERE status IN ('done','failed','cancelled') AND updated_at < ?`,
    )
    .run(taskCutoff);
  const tasksDeleted = Number(tasks.changes);

  // 3. journal-blobs：终态任务对应的 blob 文件清
  let blobsDeleted = 0;
  try {
    for (const row of db
      .prepare(
        `SELECT id FROM tasks WHERE status IN ('done','failed','cancelled') AND updated_at < ?`,
      )
      .all(taskCutoff) as Array<{ id: string }>) {
      // 该任务的 blob 文件在 GC 前已被上面 steps DELETE 解除引用，直接按前缀删
      const prefix = join(deps.blobDirAbs, `${row.id}.`);
      // node:fs 没有通配删，逐 seq 尝试（步数已知上限 2000，逐个 rmSync force 幂等）
      for (let seq = 1; seq <= 2_000; seq++) {
        const f = `${prefix}${seq}.json`;
        try {
          rmSync(f, { force: true });
          blobsDeleted += 1;
        } catch {
          // 不存在即跳过
        }
      }
    }
  } catch {
    // blob 目录缺失时不算 GC 失败
  }

  // 4. VACUUM INTO 目标 <500MB；超限先删再 wal_checkpoint(TRUNCATE)+VACUUM
  let vacuumed = false;
  const dbSizeMb = dbFileSizeMb(db);
  if (dbSizeMb > deps.cfg.dbSoftLimitMb) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    vacuumed = true;
    deps.record('disk_gc', 'normal', JSON.stringify({ dbSizeMb, vacuumed: true }));
  }
  deps.record(
    'disk_gc',
    'normal',
    JSON.stringify({ stepsDeleted, tasksDeleted, decisionsDeleted, blobsDeleted, dbSizeMb }),
  );

  return { stepsDeleted, tasksDeleted, decisionsDeleted, blobsDeleted, vacuumed };
}

/** 库文件体积（MB）。WAL 文件另计但软上限只约束主库（CP §3：dotd.db 软上限 500MB）。 */
function dbFileSizeMb(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
  const size = db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
  const pages = row?.page_count ?? 0;
  const pageSize = size?.page_size ?? 4096;
  return Math.round((pages * pageSize) / 1024 / 1024);
}

/** 每日 04:00 判定（本地时区；CP §6.5 / 开放问题 #6 时区待确认）。 */
export function isDailyDue(gcDailyAt: string, now = new Date()): boolean {
  const [hh, mm] = gcDailyAt.split(':');
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  return now.getHours() === h && now.getMinutes() === m;
}
