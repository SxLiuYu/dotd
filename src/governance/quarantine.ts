/**
 * src/governance/quarantine.ts —— Dot 隔离的持久化与解除（GOV §5.4）。
 *
 * 逐字来源：governance.md §5.4「quarantine 的持久化与解除（评审缺口#5）」；
 * 表结构见 db/migrations/020_governance.sql:76-84（quarantines，含 uniq_quarantine 部分索引
 * ——同 dot 同时至多一条 active）。
 *
 * 关键设计（§5.4 逐字）：postReview 判 quarantine ⇒ **先 INSERT 成功才发事件**；
 * 控制面调度器**每次出队前同步查询** `isQuarantined(dotId)`——daemon 重启后表仍在，
 * 隔离不丢。`governance:quarantine` 事件只是 UI/通知加速器。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { GovDeps } from './types.ts';
import { appendAudit } from './audit.ts';
import { toQuarantineView } from './review.ts';
import type { QuarantineView } from './review.ts';

/**
 * GOV §5.4：控制面出队前同步查询。幂等、可反复调用；daemon 重启后读表仍在。
 * 注意这是**同步**函数（调度器热路径，禁异步 DB 往返）。
 */
export function isQuarantined(db: DatabaseSync, dotId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS x FROM quarantines WHERE dot_id=$dotId AND status='active' LIMIT 1`)
    .get({ dotId }) as { x?: number } | undefined;
  return row !== undefined;
}

export interface QuarantineInput {
  dotId: string;
  decisionId: string;
  reason: string;
  approvalId?: number | null;
}

export interface QuarantineOutcome {
  /** 是否新开了一条 active 隔离（false = 该 dot 已在隔离中，幂等返回既有行）。 */
  created: boolean;
  view: QuarantineView;
}

/**
 * GOV §5.4：postReview 判 quarantine ⇒ 先 INSERT 成功才发事件。
 *
 * 顺序不可换（§5.4 逐字）：事件只是加速器，持久性靠表。INSERT 撞 `uniq_quarantine`
 * （同 dot 已有 active）时**不报错**——幂等返回既有隔离行（重复触发后审不该炸任务流）。
 */
export function quarantineDot(
  db: DatabaseSync,
  deps: Pick<GovDeps, 'bus' | 'controlPlane'> | null,
  input: QuarantineInput,
): QuarantineOutcome {
  const existing = db
    .prepare(
      `SELECT * FROM quarantines WHERE dot_id=$dotId AND status='active' ORDER BY id DESC LIMIT 1`,
    )
    .get({ dotId: input.dotId }) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    return { created: false, view: toQuarantineView(existing) };
  }

  const res = db
    .prepare(
      `INSERT INTO quarantines (dot_id, reason, decision_id, approval_id, status)
       VALUES ($dotId, $reason, $decisionId, $approvalId, 'active')`,
    )
    .run({
      dotId: input.dotId,
      reason: input.reason,
      decisionId: input.decisionId,
      approvalId: input.approvalId ?? null,
    }) as unknown as { lastInsertRowid: number | bigint };
  const id = Number(res.lastInsertRowid);

  appendAudit(db, {
    dotId: input.dotId,
    decisionId: input.decisionId,
    approvalId: input.approvalId ?? null,
    actor: 'system',
    channel: 'system',
    action: 'quarantine',
    reason: input.reason,
    details: { quarantineId: id },
  });

  const row = db
    .prepare('SELECT * FROM quarantines WHERE id=$id')
    .get({ id }) as Record<string, unknown>;
  const view = toQuarantineView(row);

  // 先落库成功，再发事件（§5.4）。消费者：Web 弹详情、TG 求救（仅为加速器）。
  deps?.bus.publish('governance:quarantine', {
    dotId: view.dotId,
    decisionId: view.decisionId,
    approvalId: view.approvalId,
    reason: view.reason,
  }, { dotId: view.dotId });

  return { created: true, view };
}

/**
 * GOV §5.4 解除：`liftQuarantine(dotId, actor)`（Web「解除隔离」按钮 /
 * CLI `dotd quarantine lift`）——置 lifted + 审计 + 事件 `governance:quarantine_lifted`；
 * 控制面收到后可经 `hooks.resumeDotQueue(dotId)` 恢复。
 *
 * 幂等：无 active 行时返回 ok=false（ CLI 可据此提示"该 Dot 未在隔离中"），
 * 绝不制造第二条记录。
 */
export function liftQuarantine(
  db: DatabaseSync,
  deps: Pick<GovDeps, 'bus' | 'controlPlane'> | null,
  dotId: string,
  actor: string,
): { ok: true; view: QuarantineView } | { ok: false; reason: string } {
  const active = db
    .prepare(`SELECT * FROM quarantines WHERE dot_id=$dotId AND status='active' LIMIT 1`)
    .get({ dotId }) as Record<string, unknown> | undefined;
  if (active === undefined) return { ok: false, reason: `Dot ${dotId} 未在隔离中` };

  const id = Number(active.id);
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE quarantines SET status='lifted', lifted_by=$actor, lifted_at=$now WHERE id=$id`,
  ).run({ actor, now: nowIso, id });

  appendAudit(db, {
    dotId,
    decisionId: String(active.decision_id),
    actor: 'owner',
    channel: 'cli',
    action: 'quarantine_lifted',
    reason: `由 ${actor} 解除隔离`,
    details: { quarantineId: id, actor },
  });

  const row = db
    .prepare('SELECT * FROM quarantines WHERE id=$id')
    .get({ id }) as Record<string, unknown>;
  const view = toQuarantineView(row);

  deps?.bus.publish('governance:quarantine_lifted', { dotId }, { dotId });
  // 契约 G3（O6 裁定）：控制面提供 per-dot 队列暂停/恢复语义。
  deps?.controlPlane.resumeDotQueue(dotId);

  return { ok: true, view };
}

/** 当前 active 隔离（Web 状态页展示用；无则 null）。 */
export function activeQuarantine(db: DatabaseSync, dotId: string): QuarantineView | null {
  const row = db
    .prepare(`SELECT * FROM quarantines WHERE dot_id=$dotId AND status='active' LIMIT 1`)
    .get({ dotId }) as Record<string, unknown> | undefined;
  return row === undefined ? null : toQuarantineView(row);
}

/** 隔离历史（CLI `dotd quarantine ls`；默认只回看 50 条）。 */
export function listQuarantines(db: DatabaseSync, limit = 50): QuarantineView[] {
  const rows = db
    .prepare('SELECT * FROM quarantines ORDER BY id DESC LIMIT $limit')
    .all({ limit: Math.max(1, Math.floor(limit)) }) as unknown as Record<string, unknown>[];
  return rows.map(toQuarantineView);
}
