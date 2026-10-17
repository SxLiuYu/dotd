/**
 * src/control-plane/match.ts —— 事件→目标匹配（R4，CP §6）+ ingestEvent（契约 E1/E2）。
 *
 * 幂等核心（CP §6.1，issue #1 修复；旧稿"dedup_key 保证不重复建任务"是错的——
 * 那是 surfaces 的事件行去重，防不了本模块重复建 task）：
 *
 * > **「建任务 + 写 event_decisions」必须在同一个 BEGIN IMMEDIATE 事务里。**
 *
 * - `deterministicTaskId(e.id)`：task 主键直接由 events.id 派生（`'tk_ev_'+id`，
 *   ids.ts:eventTaskId），崩溃重放到同一 event 行 → 主键撞 tasks.id PK → 事务回滚，
 *   绝不会产生第二个任务。
 * - 重启时 replayUndecidedEvents() 只是重跑这个幂等事务；已建任务的事件已有
 *   event_decisions 行，exists 短路（CP §6.1 末段）。
 *
 * 置信度分档（CP §6.2）：
 * - 规则命中恒 1.0 → 直接执行；
 * - ≥0.85 → 直接执行；
 * - 0.55–0.85 → 执行 + 推通知（可撤销）；
 * - <0.55 → 不建/不并，写 ignore + surfaces 收件箱高亮（status='inbox'）等 retryMatch。
 *
 * 模型层（契约 T1）：调 `complete({track:'light', deadlineMs:15000, attemptId:'nonj:…'})`；
 * 全灭抛 AllEndpointsDownError / NoQualifiedPrimaryError → event_decisions 不建、
 * 事件留 surfaces 收件箱等主人。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  EventDecision,
  EventsRow,
  TaskImpact,
  TaskStatus,
} from '../shared/contracts.ts';
import { AllEndpointsDownError } from '../shared/errors.ts';
import { newNonJournalAttemptId } from '../shared/ids.ts';
import type { ControlPlaneConfig, EventRow, ResourceEventKind, ResourceEventLevel } from './types.ts';
import { tx } from './types.ts';
import type { Queue } from './queue.ts';
import { evictForIncoming } from './evict.ts';

/** 事件规则（config/event-rules.yml 的形状；加载归治理/配置层，这里只消费）。 */
export interface EventRule {
  id: string;
  match: { source?: string; actor?: string; payloadContains?: string };
  action: 'run_new' | 'merge' | 'ignore';
  task?: { title?: string; goal?: string; priority?: number };
  reason: string;
}

/** 低智能模型调用面（契约 T1：complete({track:'light',…})；MR 侧薄封装可选）。 */
export interface LowBrain {
  complete(req: {
    track: 'light';
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    attemptId: string;
    deadlineMs: number;
  }): Promise<{ response: { content: string } }>;
}

export interface MatchDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  queue: Queue;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  /** 规则层（config/event-rules.yml；阶段一默认空 rules）。 */
  rules: EventRule[];
  /** 模型层（可缺省；缺省时规则未命中直接落 inbox）。 */
  lowBrain?: LowBrain;
  /** scheduler.wake 的同进程低延迟唤醒（CP §2.3）。 */
  wake(): void;
  /** CP §4.4：淘汰记 resource_events(kind='queue_evict')；缺省则不落库（测试可省）。 */
  record?: (kind: ResourceEventKind, level: ResourceEventLevel, detail: string) => void;
}

/** 匹配产出（内部结构；落库时拆成 event_decisions 列）。 */
export interface Match {
  action: 'run_new' | 'merge' | 'ignore';
  taskId: string | null;
  confidence: number;
  reason: string;
  via: 'rule' | 'llm' | 'manual';
  title?: string;
  goal?: string;
  priority?: number;
  dotId?: string;
}

export class Matcher {
  private readonly db: DatabaseSync;
  private readonly cfg: ControlPlaneConfig;
  private readonly queue: Queue;
  private readonly deps: MatchDeps;

  constructor(deps: MatchDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.queue = deps.queue;
  }

  // ── ingestEvent（契约 E2：唯一机器事件入口；wakeIngest 并入其内部唤醒）─────

  /**
   * 契约 E2：
   *   ingestEvent(e): { eventId:number; dup:boolean }
   * 撞 dedup_key UNIQUE → 幂等返回 {eventId: 旧 id, dup: true}，不重入管线（契约 E1）。
   * 落库后 setImmediate(scheduler.wake)——同进程低延迟，不等 1s tick（CP §2.3）。
   */
  ingestEvent(e: {
    source: 'http' | 'file' | 'heartbeat' | 'telegram' | 'email';
    dotId: string;
    actor: string;
    payload: unknown;
    dedupKey?: string;
    priority?: number;
  }): { eventId: number; dup: boolean } {
    const payload = safeStringify(e.payload);
    const existing =
      e.dedupKey !== undefined
        ? (this.db
            .prepare('SELECT id FROM events WHERE dedup_key=?')
            .get(e.dedupKey) as { id: number } | undefined)
        : undefined;
    if (existing !== undefined) return { eventId: existing.id, dup: true };

    const res = this.db
      .prepare(
        `INSERT INTO events(source, dot_id, actor, dedup_key, payload, status, received_at)
         VALUES(?,?,?,?,?,'pending',?)`,
      )
      .run(e.source, e.dotId, e.actor, e.dedupKey ?? null, payload, Date.now());
    const eventId = Number(res.lastInsertRowid);
    setImmediate(() => this.deps.wake());
    return { eventId, dup: false };
  }

  // ── 扫描未决策事件（CP §6.1 谓词）──────────────────────────────────

  /**
   * CP §8 listUndecidedEvents。谓词（CP §6.1）：
   *   NOT EXISTS(SELECT 1 FROM event_decisions d WHERE d.event_id=e.id)
   *   AND e.status IN ('pending','inbox')
   * 契约 E1：events.status 取值 pending/matched/ignored/inbox（旧稿 'enqueued' 作废）。
   */
  listUndecidedEvents(limit = 50): EventsRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
         WHERE e.status IN ('pending','inbox')
           AND NOT EXISTS(SELECT 1 FROM event_decisions d WHERE d.event_id=e.id)
         ORDER BY e.received_at ASC, e.id ASC LIMIT ?`,
      )
      .all(limit) as unknown as EventRow[];
    // 逐字段投影成契约 E1 的 camelCase（审码 finding：原来 as unknown as EventsRow[]
    // 直接把 snake_case DB 行当 camelCase 返回，消费方读 dotId 得 undefined）。
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      dotId: r.dot_id,
      actor: r.actor,
      dedupKey: r.dedup_key,
      payload: r.payload,
      status: r.status,
      receivedAt: r.received_at,
    }));
  }

  /** CP §7.1 步骤 6：重启后重跑幂等事务（exists 短路；deterministicTaskId 防双建）。 */
  replayUndecidedEvents(limit = 50): void {
    for (const e of this.listUndecidedEvents(limit)) {
      const row = this.toEventRow(e);
      const m = this.matchByRule(row);
      if (m === null) continue; // 规则未中且模型层缺省 → 留 inbox 等主人
      this.decideAndCreate(row, m);
    }
  }

  // ── 匹配管线（CP §6.1：规则层①优先、模型层②）────────────────────────

  /**
   * 跑一条未决策事件：规则层 → 模型层 → inbox。
   * 同步部分（落库+规则匹配）保持 <10ms（契约 E1 时序裁定）；LLM 匹配异步
   * 由 scheduler.wake 驱动，不阻塞 ingestEvent 调用方。
   */
  async processEvent(eventId: number): Promise<EventDecision | null> {
    const row = this.getEventRow(eventId);
    if (row === null) return null;
    if (this.hasDecision(eventId)) return null;

    const rule = this.matchByRule(row);
    if (rule !== null) {
      return this.decideAndCreate(row, rule);
    }
    const llm = await this.matchByLlm(row);
    if (llm !== null) {
      return this.decideAndCreate(row, llm);
    }
    // 两条都无产出 → 落 inbox 等主人（CP §6.1 末段 / CP §6.2 <0.55 同路）。
    this.db.prepare(`UPDATE events SET status='inbox' WHERE id=?`).run(eventId);
    this.deps.bus.publish('event.undecided', { eventId, source: row.source });
    return null;
  }

  /** 规则层：config/event-rules.yml；命中恒 confidence=1.0、零成本可解释（CP §6.2）。 */
  matchByRule(e: EventRow): Match | null {
    for (const r of this.deps.rules) {
      if (r.match.source !== undefined && r.match.source !== e.source) continue;
      if (r.match.actor !== undefined && r.match.actor !== e.actor) continue;
      if (r.match.payloadContains !== undefined) {
        if (!e.payload.toLowerCase().includes(r.match.payloadContains.toLowerCase())) continue;
      }
      const target =
        r.action === 'merge' ? this.findMergeTarget(e.dot_id) : null;
      if (r.action === 'merge' && target === null) {
        // 目标已终态则退化 run_new（CP §6.2）
        return {
          action: 'run_new',
          taskId: null,
          confidence: 1.0,
          reason: `${r.id}：无同目标，退化 run_new`,
          via: 'rule',
          title: r.task?.title,
          goal: r.task?.goal,
          priority: r.task?.priority,
          dotId: e.dot_id,
        };
      }
      return {
        action: r.action,
        taskId: r.action === 'merge' ? target : null,
        confidence: 1.0,
        reason: r.reason,
        via: 'rule',
        title: r.task?.title,
        goal: r.task?.goal,
        priority: r.task?.priority,
        dotId: e.dot_id,
      };
    }
    return null;
  }

  /**
   * 模型层：严格 JSON 解析一次（CP §6.1）。
   * 全灭（AllEndpointsDownError / NoQualifiedPrimaryError）→ 返回 null，事件留 inbox。
   */
  private async matchByLlm(e: EventRow): Promise<Match | null> {
    const brain = this.deps.lowBrain;
    if (brain === undefined) return null;
    let content: string;
    try {
      const res = await brain.complete({
        track: 'light',
        attemptId: newNonJournalAttemptId(),
        deadlineMs: 15_000,
        messages: [
          {
            role: 'system',
            content:
              '你是事件分流器。只输出 JSON：{"action":"run_new"|"merge"|"ignore",' +
              '"confidence":0..1,"reason":"…","taskId":"merge 目标或 null",' +
              '"title":"run_new 标题","goal":"run_new 目标","priority":0..9}',
          },
          {
            role: 'user',
            content: `source=${e.source} actor=${e.actor} payload=${e.payload.slice(0, 4000)}`,
          },
        ],
      });
      content = res.response.content;
    } catch (err) {
      if (err instanceof AllEndpointsDownError) return null;
      throw err;
    }
    const parsed = parseJsonOnce(content);
    if (parsed === null) return null;
    const confidence = clamp01(parsed.confidence);
    const action = parsed.action === 'merge' || parsed.action === 'ignore' ? parsed.action : 'run_new';
    return {
      action,
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
      confidence,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'llm 分流',
      via: 'llm',
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      goal: typeof parsed.goal === 'string' ? parsed.goal : undefined,
      priority: typeof parsed.priority === 'number' ? parsed.priority : undefined,
      dotId: e.dot_id,
    };
  }

  /**
   * CP §6.2 置信度分档 + §6.1 幂等事务：
   * - ≥0.55 → 执行（run_new/merge）；merge 目标已终态退化 run_new；
   * - <0.55 → 只写 ignore 决策 + events.status='inbox'；
   * - 「INSERT tasks(id='tk_ev_'+events.id) + INSERT event_decisions +
   *   UPDATE events.status」在**同一 BEGIN IMMEDIATE 事务**（防双建）。
   */
  decideAndCreate(e: EventRow, m: Match): EventDecision {
    return tx(this.db, () => {
      if (this.hasDecision(e.id)) {
        // 双保险：已决策直接跳过（重启 replay 命中此路）
        return this.getDecision(e.id)!;
      }
      const now = Date.now();
      const confidence = clamp01(m.confidence);
      const dotId = m.dotId ?? e.dot_id;

      if (confidence < 0.55) {
        this.insertDecision(e.id, 'ignore', null, confidence, m.reason, m.via, now);
        this.db.prepare(`UPDATE events SET status='inbox' WHERE id=?`).run(e.id);
        this.deps.bus.publish('event.undecided', { eventId: e.id, source: e.source });
        return this.getDecision(e.id)!;
      }

      let taskId: string | null = null;
      if (m.action === 'run_new') {
        // CP §4.4：queued 已达上限 → 先试 merge，失败淘汰队首自动任务腾位。
        const queued = this.queuedCount();
        const room = queued < this.cfg.maxQueued;
        const mergeTarget = room ? null : this.findMergeTarget(dotId);
        if (!room && mergeTarget !== null) {
          this.insertNote(mergeTarget, e, now);
          taskId = mergeTarget;
          this.insertDecision(e.id, 'merge', taskId, confidence, m.reason, m.via, now);
          this.markMatched(e.id);
          return this.getDecision(e.id)!;
        }
        if (!room) {
          // CP §4.4：merge 失败且 queued 已满 → 淘汰候选队首自动任务腾位。
          // record/bus 必须传入，否则淘汰只改状态不落 resource_events（旧实现漏接线）。
          evictForIncoming(this.db, this.cfg, this.queue, dotId, {
            record: this.deps.record,
            bus: this.deps.bus,
          });
        }
        this.queue.submit({
          title: m.title ?? defaultTitle(e),
          goal: m.goal ?? defaultGoal(e),
          priority: m.priority ?? 5,
          dotId,
          sourceEventId: e.id,
        });
        taskId = `tk_ev_${e.id}`;
        // CP §6.1 幂等核心：建任务 + 写 event_decisions 必须在同一事务内落库，
        // 否则重启 replay 时 hasDecision() 判 false 会双建任务（deterministicTaskId 撞 PK）。
        this.insertDecision(e.id, 'run_new', taskId, confidence, m.reason, m.via, now);
      } else if (m.action === 'merge') {
        const target = m.taskId !== null ? this.liveTask(m.taskId) : null;
        if (target === null) {
          // merge 目标不存在或已终态 → 退化 run_new（CP §6.2）
          this.queue.submit({
            title: m.title ?? defaultTitle(e),
            goal: m.goal ?? defaultGoal(e),
            priority: m.priority ?? 5,
            dotId,
            sourceEventId: e.id,
          });
          taskId = `tk_ev_${e.id}`;
          this.insertDecision(e.id, 'run_new', taskId, confidence, m.reason, m.via, now);
        } else {
          this.insertNote(target.id, e, now);
          taskId = target.id;
          this.insertDecision(e.id, 'merge', taskId, confidence, m.reason, m.via, now);
        }
      } else {
        this.insertDecision(e.id, 'ignore', null, confidence, m.reason, m.via, now);
      }
      if (m.action !== 'ignore') this.markMatched(e.id);
      else this.db.prepare(`UPDATE events SET status='ignored' WHERE id=?`).run(e.id);
      return this.getDecision(e.id)!;
    });
  }

  /**
   * CP §8 retryMatch：主人手动覆写决策（via='manual' UPSERT 覆盖旧决策）。
   * CP §6.2：撤销 = 任务 cancelled + event_decisions 行删除（事件回未决策，可重匹配）；
   * <0.55 的一键 retryMatch 走 manual UPSERT。
   */
  retryMatch(eventLogId: number, m: EventDecision): void {
    const now = Date.now();
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO event_decisions(event_id, action, task_id, confidence, reason, via, decided_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(event_id) DO UPDATE SET action=excluded.action, task_id=excluded.task_id,
             confidence=excluded.confidence, reason=excluded.reason, via=excluded.via,
             decided_at=excluded.decided_at`,
        )
        .run(eventLogId, m.action, m.taskId, m.confidence, m.reason, 'manual', now);
      if (m.action === 'run_new') {
        this.queue.submit({
          title: `手动重匹配：事件 #${eventLogId}`,
          goal: m.reason,
          priority: 2,
          sourceEventId: eventLogId,
        });
        this.db.prepare(`UPDATE events SET status='matched' WHERE id=?`).run(eventLogId);
      } else if (m.action === 'ignore') {
        this.db.prepare(`UPDATE events SET status='ignored' WHERE id=?`).run(eventLogId);
      } else {
        this.db.prepare(`UPDATE events SET status='matched' WHERE id=?`).run(eventLogId);
      }
    });
    this.deps.wake();
  }

  /** CP §8 taskImpact（契约 T2：字段名以 MR 为准 snake_case；held = awaiting+paused）。 */
  taskImpact(): TaskImpact {
    const q = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='queued' AND priority<=2 THEN 1 ELSE 0 END) AS qp,
           SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS r,
           SUM(CASE WHEN status IN ('awaiting_approval','paused') THEN 1 ELSE 0 END) AS h
         FROM tasks`,
      )
      .get() as { qp: number | null; r: number | null; h: number | null };
    return {
      queued_primary: q.qp ?? 0,
      running: q.r ?? 0,
      held: q.h ?? 0,
    };
  }

  /** skip_if_busy 数据源（契约 H1：cp.list({status:['queued','running'],dotId}).length）。 */
  busyCount(dotId: string): number {
    return this.queue.list({ status: ['queued', 'running'], dotId }).length;
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private getEventRow(eventId: number): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as
      | EventRow
      | undefined;
    return row ?? null;
  }

  /**
   * 契约 E1 的 camelCase EventsRow → 本模块内部 snake_case EventRow。
   * **逐字段映射**（不用 as 强转）：消费方读 row.dotId 必须拿到 dot_id 的值，
   * 强转会让 camelCase 键在 DB 行上全部 undefined（审码 finding：类型投影偷工）。
   */
  toEventRow(e: EventsRow): EventRow {
    return {
      id: e.id,
      source: e.source,
      dot_id: e.dotId,
      actor: e.actor,
      dedup_key: e.dedupKey,
      payload: e.payload,
      status: e.status,
      received_at: e.receivedAt,
    };
  }

  /**
   * 只跑规则层的同步匹配入口（CP §6.1：规则层①优先、同步 <10ms）。
   * 供 scheduler.wake 用——ingestEvent 的 setImmediate 回调里不能 await LLM。
   * 未命中规则返回 null（调用方再决定是否走异步 LLM 路径）。
   */
  processEventSync(eventId: number): EventDecision | null {
    const row = this.getEventRow(eventId);
    if (row === null) return null;
    if (this.hasDecision(eventId)) return null;
    const rule = this.matchByRule(row);
    if (rule === null) return null;
    return this.decideAndCreate(row, rule);
  }

  private hasDecision(eventId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM event_decisions WHERE event_id=?')
      .get(eventId) as { x?: number } | undefined;
    return row !== undefined;
  }

  private getDecision(eventId: number): EventDecision | null {
    const row = this.db
      .prepare('SELECT * FROM event_decisions WHERE event_id=?')
      .get(eventId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      eventId: row['event_id'] as number,
      action: row['action'] as EventDecision['action'],
      taskId: (row['task_id'] as string | null) ?? null,
      confidence: row['confidence'] as number,
      reason: row['reason'] as string,
      via: row['via'] as EventDecision['via'],
      decidedAt: row['decided_at'] as number,
    };
  }

  private insertDecision(
    eventId: number,
    action: EventDecision['action'],
    taskId: string | null,
    confidence: number,
    reason: string,
    via: EventDecision['via'],
    decidedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO event_decisions(event_id, action, task_id, confidence, reason, via, decided_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(eventId, action, taskId, confidence, reason, via, decidedAt);
  }

  private markMatched(eventId: number): void {
    // 契约 E1：status='enqueued' 作废 → 'matched'
    this.db.prepare(`UPDATE events SET status='matched' WHERE id=?`).run(eventId);
  }

  private queuedCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='queued'`)
      .get() as { n: number };
    return row.n;
  }

  /** merge 目标集（CP §6.2）：仅 queued/running/paused 的非终态任务。 */
  private findMergeTarget(dotId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM tasks
         WHERE dot_id=? AND status IN ('queued','running','paused')
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                  updated_at DESC LIMIT 1`,
      )
      .get(dotId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private liveTask(taskId: string): { id: string; status: TaskStatus } | null {
    const row = this.db
      .prepare('SELECT id, status FROM tasks WHERE id=?')
      .get(taskId) as { id: string; status: TaskStatus } | undefined;
    if (row === undefined) return null;
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') return null;
    return row;
  }

  /**
   * merge 注记（CP §6.2）：向 running 任务 merge = 插一条 kind='tool',
   * tool_name='system.note', status='succeeded' 步（seq 递增、带当前 epoch）。
   * 读取侧 = journal.pendingNotes（Runner 下一步决策前注入）。
   */
  private insertNote(targetTaskId: string, e: EventRow, now: number): void {
    const epochRow = this.db
      .prepare('SELECT run_epoch AS ep FROM tasks WHERE id=?')
      .get(targetTaskId) as { ep: number } | undefined;
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM steps WHERE task_id=?')
      .get(targetTaskId) as { n: number };
    this.db
      .prepare(
        `INSERT INTO steps(task_id, seq, kind, status, call_id, tool_name, args_json,
                           result_json, side_effect, run_epoch, approval_id,
                           started_at, finished_at)
         VALUES(?,?,'tool','succeeded',NULL,'system.note',?,?,NULL,?,NULL,?,?)`,
      )
      .run(
        targetTaskId,
        seqRow.n,
        JSON.stringify({ mergedEventId: e.id }),
        `并入事件 #${e.id}（${e.source}/${e.actor}）：${e.payload.slice(0, 2000)}`,
        epochRow?.ep ?? 0,
        now,
        now,
      );
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────────

function safeStringify(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return JSON.stringify({ __unserializable: String(payload) });
  }
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(Math.max(n, 0), 1);
}

/** 严格 JSON 解析一次（CP §6.1：失败即视为无产出）。 */
function parseJsonOnce(text: string): {
  action?: string;
  taskId?: string;
  confidence?: number;
  reason?: string;
  title?: string;
  goal?: string;
  priority?: number;
} | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof v !== 'object' || v === null) return null;
    return v as Record<string, never>;
  } catch {
    return null;
  }
}

function defaultTitle(e: EventRow): string {
  return `事件 #${e.id}（${e.source}）`;
}

function defaultGoal(e: EventRow): string {
  return `处理来自 ${e.source}/${e.actor} 的事件：${e.payload.slice(0, 500)}`;
}
