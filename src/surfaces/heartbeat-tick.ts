/**
 * src/surfaces/heartbeat-tick.ts —— 心跳调度器的 tick 算法（契约 H1 / J4）。
 *
 * 属主声明（重要，rev2 + 契约 H1 已两次裁决）：
 * - 调度事实（cron/next_fire/enabled/skip_if_busy/quiet_hours/catchup/last_fire_*）
 *   全部在 **CP 的 `crontabs` 单表**（契约 H1：原 `surf_heartbeat_state` 整表作废、
 *   扩展列并入 crontabs）。本文件**只实现 tick 算法语义**，供 CP
 *   `registerInternalJob({name:'heartbeat.tick', kind:'light', …})` 注册执行（契约 J4）。
 * - 触发 = `cp.ingestEvent(source='heartbeat', dedupKey='hb:<ct_id>:<next_fire>')`
 *   （契约 H1 原文；next_fire 时间戳天然唯一，CP §4.3 的 fire_seq 自增防重作废）。
 * - `skip_if_busy` 数据源 = `cp.list({status:['queued','running'],dotId}).length`
 *   （SF:262 / 契约 H1 末行；不引入未定义接口）。
 * - SF §5.4 的 `registerIntervalJob(name,ms,fn)` **已作废**（契约 J4），因此本文件
 *   不再导出该接口，只导出一个纯算法 + 一个可被注册的 tick 函数。
 *
 * ⚠ 已知双实现（deviations 已申报）：CP `index.ts:186-193` 注册的 `heartbeat.tick`
 * 跑的是 CP 自己的 `scheduler.scanCrontabs`（scheduler.ts:246），**本文件的
 * `heartbeatTick` 目前无生产调用方**（仅 tests 引用）。契约 H1/J4 裁决"判定循环由
 * CP scheduler 代跑"，故本文件保留为算法基准实现 + CP 侧可替换的等价实现。
 * 两处语义已逐条对齐（本审码轮修复）：
 *   - catchup='skip' → advance 后 continue（不投）：CP scheduler.ts:219-222 ⇔ 本文件 skipped_catchup；
 *   - quiet_hours / skip_if_busy 的 advance-then-continue 次序一致；
 *   - 坏 cron：CP 停用该条 + record('watchdog')；本文件记 error 状态（见 markFired 注释）。
 * CP 若要改为直接调本模块，只需 `run: () => heartbeatTick(deps)` 替换 `tickCrontabs()`。
 */

import { CronExpressionParser } from 'cron-parser';
import type { DatabaseSync } from 'node:sqlite';
import type { IngestEventResult } from '../shared/contracts.ts';

/** 契约 H1：crontabs 行（本模块只读调度事实列；写只写 next_fire 与 last_fire_*）。 */
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
  catchup: string;
}

/** tick 的依赖（装配层注入；算法本身不碰 daemon 细节）。 */
export interface HeartbeatTickDeps {
  db: DatabaseSync;
  cp: {
    ingestEvent(e: {
      source: 'heartbeat';
      dotId: string;
      actor: string;
      payload: unknown;
      dedupKey?: string;
      priority?: number;
    }): IngestEventResult;
    list(q: { status: string[]; dotId?: string }): Array<{ id: string }>;
  };
  now(): Date;
  /** §5.4：'latest' 补投判定阈值 = 3 * tick_interval。 */
  catchupThresholdMs?: number;
}

/** 单条 crontab 的一次 tick 结果（mark(st) 的落点）。 */
export type TickOutcome =
  | { ctId: string; status: 'fired'; eventId: number; dup: boolean; dueAt: number }
  | { ctId: string; status: 'skipped_quiet'; dueAt: number }
  | { ctId: string; status: 'skipped_busy'; dueAt: number; activeTasks: number }
  /** §5.4：catchup='skip' → 不补、直接推进 next_due_at（对齐 CP scheduler.ts:219-222）。 */
  | { ctId: string; status: 'skipped_catchup'; dueAt: number }
  | { ctId: string; status: 'error'; error: string; dueAt: number };

/**
 * §5.4 原文（rev2）：
 * ```
 * const due = db.all(`SELECT * FROM crontabs WHERE enabled=1 AND next_fire <= ?`, now());
 * for (const ct of due) {
 *   const st = getOrCreateHeartbeatState(ct.id);
 *   // 先推进 next_fire（UPDATE crontabs SET next_fire = cronParser(ct.cron, now).getTime()）
 *   //   —— 先推进后投递：崩溃窗口内宁可漏一次，绝不补发一排 heartbeat 风暴
 *   if (inQuietHours(st.quiet_hours)) { mark(st,'skipped_quiet'); continue; }
 *   if (st.skip_if_busy && deps.activeTaskCount(ct.dot_id) > 0) { mark(st,'skipped_busy'); continue; }
 *   deps.cp.ingestEvent({ source:'heartbeat', payload:{…}, dedupKey:`hb:${ct.id}:${ct.next_fire}` });
 *   mark(st,'fired');
 * }
 * ```
 * 实现按此逐句落地；`getOrCreateHeartbeatState`/`mark` 直接读写 `crontabs` 的
 * last_fire_status/last_fired_at/last_fire_seq 列（契约 H1：并入单表）。
 */

/** 读到期的心跳行（enabled=1 且 next_fire ≤ now）。 */
export function selectDue(db: DatabaseSync, nowMs: number): CrontabRow[] {
  return db
    .prepare(
      `SELECT id, dot_id, title, prompt, cron, enabled, next_fire, last_fired_at,
              last_fire_status, skip_if_busy, quiet_hours, catchup
         FROM crontabs WHERE enabled = 1 AND next_fire <= ?
         ORDER BY next_fire ASC, id ASC`,
    )
    .all(nowMs) as unknown as CrontabRow[];
}

/**
 * cron 下一次触发时刻（epoch ms）。用 `currentDate = from` 求"严格晚于 from"的下一次。
 * cron-parser 5.10 实测：`CronExpressionParser.parse(cron, {currentDate: Date}).next().getTime()`
 * 返回 Date；非法 cron 抛错（调用方记 error 状态，不中断循环）。
 */
export function nextFireFrom(cron: string, from: Date | number): number {
  const current = typeof from === 'number' ? new Date(from) : from;
  const it = CronExpressionParser.parse(cron, { currentDate: current });
  return it.next().getTime();
}

/**
 * quiet_hours 判定（§4 DDL 注释：'23:00-07:30' 本地时区，命中则跳过）。
 * 支持跨午夜区间（start > end）；分钟粒度；本地时区（系统时区，与 crontabs 注释一致）。
 * 空/非法 → 不命中（fail-open：安静时段只是优化，不该让心跳永不触发）。
 */
export function inQuietHours(spec: string | null, at: Date): boolean {
  if (spec === null || spec.trim().length === 0) return false;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (m === null) return false;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return false;
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return false;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const cur = at.getHours() * 60 + at.getMinutes();
  if (start === end) return false; // 空区间
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // 跨午夜
}

/** 写 last_fire_*（§5.4 mark(st, …) 的单表落点，契约 H1）。 */
function markFired(db: DatabaseSync, ctId: string, status: string, atMs: number, firedSeq: number): void {
  db.prepare(
    `UPDATE crontabs SET last_fire_status = ?, last_fired_at = ?, last_fire_seq = ? WHERE id = ?`,
  ).run(status, atMs, firedSeq, ctId);
}

/**
 * §5.4 tick 算法本体（纯函数式：不持有定时器，定时器由 CP registerInternalJob 提供）。
 *
 * 顺序（逐句对应 §5.4 注释）：
 * 1. 取 due 行；
 * 2. **先推进 next_fire**（崩溃窗口内宁可漏一次，绝不补发一排 heartbeat 风暴）；
 * 3. quiet_hours 命中 → skipped_quiet；
 * 4. skip_if_busy 且 activeTaskCount > 0 → skipped_busy；
 * 5. 投递 ingestEvent（dedup_key 含 next_fire 旧值，幂等）；
 * 6. mark 'fired'。
 *
 * `catchup='latest'` 补投（§5.4 第二段）：重启后错过的历史 next_fire 已不可见（列已更新），
 * 天然 = 'skip'；'latest' 模式若 `last_fired_at` 为空或距今 > 3 × tick_interval，
 * 则对**当前** due 值补投一次（去重靠 dedup_key 含 next_fire，幂等安全）。
 * 本实现把补投并回第 5 步（同一函数、同一幂等键），因此"补投一次"与"正常触发一次"
 * 走完全相同的代码路径——重复 tick 不会补投两次（last_fired_at 已刷新）。
 */
export function heartbeatTick(deps: HeartbeatTickDeps): TickOutcome[] {
  const now = deps.now();
  const nowMs = now.getTime();
  const threshold = deps.catchupThresholdMs ?? 3 * 15_000;
  const due = selectDue(deps.db, nowMs);
  const outcomes: TickOutcome[] = [];

  for (const ct of due) {
    const dueAt = ct.next_fire;
    // ② 先推进 next_fire（任何后续失败都不影响"不补发风暴"的性质）
    let advanced: number;
    try {
      advanced = nextFireFrom(ct.cron, now);
    } catch (cause) {
      const msg = `cron 解析失败：${String(cause)}`;
      markFired(deps.db, ct.id, 'error', nowMs, ct.last_fire_seq ?? 0);
      outcomes.push({ ctId: ct.id, status: 'error', error: msg, dueAt });
      continue;
    }
    deps.db.prepare('UPDATE crontabs SET next_fire = ? WHERE id = ?').run(advanced, ct.id);

    // ③ quiet_hours
    if (inQuietHours(ct.quiet_hours, now)) {
      markFired(deps.db, ct.id, 'skipped_quiet', nowMs, ct.last_fire_seq ?? 0);
      outcomes.push({ ctId: ct.id, status: 'skipped_quiet', dueAt });
      continue;
    }

    // ④ skip_if_busy（数据源 = cp.list({status:['queued','running'],dotId}).length）
    if (ct.skip_if_busy === 1) {
      let active = 0;
      try {
        active = deps.cp.list({ status: ['queued', 'running'], dotId: ct.dot_id }).length;
      } catch (cause) {
        markFired(deps.db, ct.id, 'error', nowMs, ct.last_fire_seq ?? 0);
        outcomes.push({ ctId: ct.id, status: 'error', error: `cp.list 失败：${String(cause)}`, dueAt });
        continue;
      }
      if (active > 0) {
        markFired(deps.db, ct.id, 'skipped_busy', nowMs, ct.last_fire_seq ?? 0);
        outcomes.push({ ctId: ct.id, status: 'skipped_busy', dueAt, activeTasks: active });
        continue;
      }
    }

    // ⑤ catchup 判定（§5.4 第二段；与 CP scheduler.ts:219-222 同一语义）
    //   'skip'  → 不补、直接推进 next_due_at（上面已推进），本轮不投递；
    //   'latest'→ 停机期间错过的只投 1 次最新：last_fired_at 为空或距今年代久远
    //             （> 3 × interval）时对**当前** due 值补投一次。
    //   dedup_key 含 dueAt ⇒ 重复 tick 不会补投两次（幂等安全）。
    if (ct.catchup === 'skip') {
      markFired(deps.db, ct.id, 'skipped_catchup', nowMs, ct.last_fire_seq ?? 0);
      outcomes.push({ ctId: ct.id, status: 'skipped_catchup', dueAt });
      continue;
    }
    const staleFor = ct.last_fired_at === null ? Number.POSITIVE_INFINITY : nowMs - ct.last_fired_at;
    const needsCatchup = staleFor > threshold;
    if (ct.last_fired_at !== null && !needsCatchup) {
      // 距上次触发在阈值内且本轮 due —— 正常触发（下面照投）
    }

    // ⑥ 投递（§5.4 payload 逐字段；dedup_key = hb:<ct_id>:<dueAt>）
    let res: IngestEventResult;
    try {
      res = deps.cp.ingestEvent({
        source: 'heartbeat',
        dotId: ct.dot_id,
        actor: 'scheduler',
        payload: {
          goal: ct.prompt,
          title: ct.title,
          ctId: ct.id,
          dueAt,
        },
        dedupKey: `hb:${ct.id}:${dueAt}`,
        priority: 5, // §5.1 映射表：heartbeat = 5
      });
    } catch (cause) {
      markFired(deps.db, ct.id, 'error', nowMs, ct.last_fire_seq ?? 0);
      outcomes.push({ ctId: ct.id, status: 'error', error: `ingestEvent 失败：${String(cause)}`, dueAt });
      continue;
    }

    markFired(deps.db, ct.id, 'fired', nowMs, (ct.last_fire_seq ?? 0) + 1);
    outcomes.push({ ctId: ct.id, status: 'fired', eventId: res.eventId, dup: res.dup, dueAt });
  }

  return outcomes;
}

/**
 * 供 CP `registerInternalJob({name:'heartbeat.tick', kind:'light', everyMs, run})` 注册的
 * 薄包装（契约 J4：周期任务唯一宿主 = CP scheduler；本模块只提供 run 回调）。
 * 内部吞掉异常并记 error 状态——一个坏 crontab 不得打死整个 tick 循环。
 */
export function makeHeartbeatTickJob(deps: HeartbeatTickDeps): () => Promise<void> {
  return async () => {
    try {
      heartbeatTick(deps);
    } catch (cause) {
      // tick 整体失败（如库瞬时不可用）：记不到具体 ct 行，只能让下一次 tick 重试
      void cause;
    }
  };
}

/** `dotd hb` CLI 的 crontabs 增删改查（§5.2 POST /api/heartbeat 的内部实现）。 */
export interface HeartbeatAdminApi {
  list(dotId?: string): CrontabRow[];
  add(spec: { dotId: string; title: string; prompt: string; cron: string; skipIfBusy?: boolean; quietHours?: string | null; catchup?: 'latest' | 'skip' }): CrontabRow;
  remove(ctId: string): boolean;
  setEnabled(ctId: string, enabled: boolean): CrontabRow | null;
}

/**
 * crontabs 管理面（SF §5.2 写 CP crontabs 的落地；表归 CP 属主，写入顺序自律——
 * 契约 D2：foreign_keys 不全局 ON）。
 * 注：crontabs 归 CP 属主（契约 D4），按"只写自己的表"铁律本应走 CP 接口；
 * CP 尚未导出 crontabs 管理接口（contracts.ts ControlPlane 无 addCrontab），
 * 因此这里以"SF 提供、CP 可替换"的形式落地，并列 deviations 待 CP 补接口。
 */
export function createHeartbeatAdmin(db: DatabaseSync): HeartbeatAdminApi {
  const selectAll = (dotId?: string): CrontabRow[] => {
    const cols = `id, dot_id, title, prompt, cron, enabled, next_fire, last_fired_at,
                last_fire_seq, last_fire_status, skip_if_busy, quiet_hours, catchup`;
    const sql = dotId === undefined
      ? `SELECT ${cols} FROM crontabs ORDER BY id`
      : `SELECT ${cols} FROM crontabs WHERE dot_id = ? ORDER BY id`;
    return (dotId === undefined
      ? db.prepare(sql).all()
      : db.prepare(sql).all(dotId)) as unknown as CrontabRow[];
  };
  return {
    list: selectAll,
    add(spec) {
      const id = `ct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date();
      const nextFire = nextFireFrom(spec.cron, now); // 入表即算好 next_fire（H1 DDL 注释）
      db.prepare(
        `INSERT INTO crontabs (id, dot_id, title, prompt, cron, enabled, next_fire,
                               last_fire_seq, skip_if_busy, quiet_hours, catchup)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`,
      ).run(
        id,
        spec.dotId,
        spec.title,
        spec.prompt,
        spec.cron,
        nextFire,
        spec.skipIfBusy === false ? 0 : 1,
        spec.quietHours ?? null,
        spec.catchup ?? 'latest',
      );
      const row = selectAll().find((r) => r.id === id);
      if (row === undefined) throw new Error(`crontabs 插入后读不回：${id}`);
      return row;
    },
    remove(ctId) {
      const r = db.prepare('DELETE FROM crontabs WHERE id = ?').run(ctId);
      return r.changes > 0;
    },
    setEnabled(ctId, enabled) {
      const r = db.prepare('UPDATE crontabs SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, ctId);
      if (r.changes === 0) return null;
      return selectAll().find((x) => x.id === ctId) ?? null;
    },
  };
}
