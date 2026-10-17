/**
 * tests/surfaces-heartbeat-tick.test.ts —— §5.4 心跳 tick 算法 测试。
 *
 * 覆盖（任务要求的三项之三：heartbeat tick 算法）：
 * - 到期选取（enabled=1 且 next_fire ≤ now）；
 * - **先推进 next_fire 后投递**（崩溃窗口内宁可漏一次，绝不补发风暴）；
 * - quiet_hours 命中 → skipped_quiet（含跨午夜区间）；
 * - skip_if_busy = cp.list({queued,running},dotId).length > 0 → skipped_busy；
 * - 投递载荷/dedupKey/priority（hb:<ct_id>:<dueAt>、priority=5）；
 * - last_fire_* 落点（crontabs 单表，契约 H1）；
 * - cron 解析失败 → error 状态不中断循环；
 * - catchup='latest' 阈值判定；
 * - crontabs 管理面（add/remove/setEnabled/list，`dotd hb` 的实现）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { CronExpressionParser } from 'cron-parser';
import {
  createHeartbeatAdmin,
  heartbeatTick,
  inQuietHours,
  makeHeartbeatTickJob,
  nextFireFrom,
  selectDue,
} from '../src/surfaces/heartbeat-tick.ts';
import type { CrontabRow, HeartbeatTickDeps, TickOutcome } from '../src/surfaces/heartbeat-tick.ts';
import { heartbeatDedupKey } from '../src/surfaces/types.ts';
import type { IngestEventReq, IngestEventResult } from '../src/shared/contracts.ts';

// ── 测试替身 ────────────────────────────────────────────────────────

interface FakeCp {
  ingestCalls: IngestEventReq[];
  listCalls: Array<{ status: string[]; dotId?: string }>;
  /** 已见 dedupKey → eventId（模拟契约 E2 的 dedup 返回）。 */
  seen: Map<string, number>;
  /** 下一次 ingestEvent 抛错（模拟 CP 拒绝）。 */
  throwOnNext: boolean;
  activeCount: number;
}

function makeCp(): FakeCp {
  const state: FakeCp = {
    ingestCalls: [],
    listCalls: [],
    seen: new Map(),
    throwOnNext: false,
    activeCount: 0,
  };
  return state;
}

function makeDeps(dir: TempDataDir, cp: FakeCp, now: Date, catchupThresholdMs?: number): HeartbeatTickDeps {
  return {
    db: dir.db,
    cp: {
      ingestEvent(req: IngestEventReq): IngestEventResult {
        cp.ingestCalls.push(req);
        if (cp.throwOnNext) {
          cp.throwOnNext = false;
          throw new Error('CP 队列已满（maxQueued=200）');
        }
        const key = req.dedupKey ?? '';
        const prior = cp.seen.get(key);
        if (prior !== undefined) return { eventId: prior, dup: true };
        const eventId = 100 + cp.seen.size;
        cp.seen.set(key, eventId);
        return { eventId, dup: false };
      },
      list(q: { status: string[]; dotId?: string }): Array<{ id: string }> {
        cp.listCalls.push(q);
        return Array.from({ length: cp.activeCount }, () => ({ id: 'tk_x' }));
      },
    },
    now: () => now,
    ...(catchupThresholdMs !== undefined ? { catchupThresholdMs } : {}),
  };
}

/** 直接插一行 crontab（绕过管理面，精确控制 next_fire/last_fired_at）。 */
function insertCrontab(
  dir: TempDataDir,
  row: Partial<CrontabRow> & { id: string; cron: string },
): void {
  const r: CrontabRow = {
    dot_id: 'dot1',
    title: 't',
    prompt: 'p',
    enabled: 1,
    next_fire: 0,
    last_fired_at: null,
    last_fire_seq: 0,
    last_fire_status: null,
    skip_if_busy: 1,
    quiet_hours: null,
    catchup: 'latest',
    ...row,
  } as CrontabRow;
  dir.db
    .prepare(
      `INSERT INTO crontabs (id, dot_id, title, prompt, cron, enabled, next_fire, last_fired_at,
                             last_fire_seq, last_fire_status, skip_if_busy, quiet_hours, catchup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id, r.dot_id, r.title, r.prompt, r.cron, r.enabled, r.next_fire, r.last_fired_at,
      r.last_fire_seq, r.last_fire_status, r.skip_if_busy, r.quiet_hours, r.catchup,
    );
}

function readRow(dir: TempDataDir, id: string): CrontabRow {
  const row = dir.db.prepare('SELECT * FROM crontabs WHERE id = ?').get(id) as unknown as CrontabRow;
  assert.ok(row !== undefined, `crontabs 应有行 ${id}`);
  return row;
}

/** 本机时区的某个时刻（2026-01-15 12:00 本地）。 */
const NOON = new Date(2026, 0, 15, 12, 0, 0, 0);

// ═══════════════════════════════════════════════════════════════════
// 一、到期选取
// ═══════════════════════════════════════════════════════════════════

test('selectDue：只取 enabled=1 且 next_fire ≤ now 的行（按 next_fire 升序）', () => {
  const dir = makeTempDataDir();
  try {
    const nowMs = NOON.getTime();
    insertCrontab(dir, { id: 'ct_due', cron: '* * * * *', next_fire: nowMs - 1000 });
    insertCrontab(dir, { id: 'ct_due2', cron: '* * * * *', next_fire: nowMs - 5000 });
    insertCrontab(dir, { id: 'ct_future', cron: '* * * * *', next_fire: nowMs + 60_000 });
    insertCrontab(dir, { id: 'ct_disabled', cron: '* * * * *', next_fire: nowMs - 1, enabled: 0 });
    const due = selectDue(dir.db, nowMs);
    assert.deepEqual(due.map((d) => d.id), ['ct_due2', 'ct_due']);
  } finally {
    dir.cleanup();
  }
});

test('selectDue：恰等于 now 也算到期（<= 语义）', () => {
  const dir = makeTempDataDir();
  try {
    const nowMs = NOON.getTime();
    insertCrontab(dir, { id: 'ct_eq', cron: '* * * * *', next_fire: nowMs });
    assert.deepEqual(selectDue(dir.db, nowMs).map((d) => d.id), ['ct_eq']);
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 二、先推进 next_fire 后投递（§5.4 崩溃窗口铁律）
// ═══════════════════════════════════════════════════════════════════

test('tick：先推进 next_fire，再投递（失败也已是下一次时刻）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    const now = NOON;
    const dueAt = now.getTime() - 1000;
    insertCrontab(dir, { id: 'ct_1', cron: '*/5 * * * *', next_fire: dueAt });
    const deps = makeDeps(dir, cp, now);

    const out = heartbeatTick(deps);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, 'fired');
    assert.equal((out[0] as { dueAt: number }).dueAt, dueAt);

    // next_fire 已推进到"严格晚于 now"的下一次（*/5 → 12:05）
    const advanced = readRow(dir, 'ct_1').next_fire;
    assert.ok(advanced > now.getTime(), 'next_fire 必须已推进');
    assert.equal(new Date(advanced).getMinutes(), 5);

    // 投递发生过一次，dedupKey 用旧 next_fire（hb:<id>:<dueAt>）
    assert.equal(cp.ingestCalls.length, 1);
    assert.equal(cp.ingestCalls[0]!.dedupKey, heartbeatDedupKey('ct_1', dueAt));
    assert.equal(cp.ingestCalls[0]!.source, 'heartbeat');
    assert.equal(cp.ingestCalls[0]!.priority, 5); // §5.1：heartbeat = 5
    assert.deepEqual(cp.ingestCalls[0]!.payload, {
      goal: 'p',
      title: 't',
      ctId: 'ct_1',
      dueAt,
    });
    assert.equal(cp.ingestCalls[0]!.actor, 'scheduler');
  } finally {
    dir.cleanup();
  }
});

test('tick：cron 解析失败 → error 状态，循环不中断（其他 ct 照常）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    const now = NOON;
    insertCrontab(dir, { id: 'ct_bad', cron: 'not-a-cron', next_fire: now.getTime() - 1 });
    insertCrontab(dir, { id: 'ct_ok', cron: '*/5 * * * *', next_fire: now.getTime() - 1 });
    const out = heartbeatTick(makeDeps(dir, cp, now));

    assert.equal(out.length, 2);
    const bad = out.find((o) => o.ctId === 'ct_bad')!;
    assert.equal(bad.status, 'error');
    assert.match((bad as { error: string }).error, /cron/);
    const ok = out.find((o) => o.ctId === 'ct_ok')!;
    assert.equal(ok.status, 'fired');
    // 坏行不推进 next_fire（无法算下一次），但也不投递 → 不会风暴
    assert.equal(readRow(dir, 'ct_bad').next_fire, now.getTime() - 1);
    assert.equal(readRow(dir, 'ct_bad').last_fire_status, 'error');
  } finally {
    dir.cleanup();
  }
});

test('tick：ingestEvent 抛错（CP 拒收）→ error 状态，next_fire 仍已推进', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    cp.throwOnNext = true;
    const now = NOON;
    insertCrontab(dir, { id: 'ct_cp', cron: '*/5 * * * *', next_fire: now.getTime() - 1 });
    const out = heartbeatTick(makeDeps(dir, cp, now));
    assert.equal(out[0]!.status, 'error');
    assert.match((out[0] as { error: string }).error, /ingestEvent/);
    assert.ok(readRow(dir, 'ct_cp').next_fire > now.getTime());
    assert.equal(readRow(dir, 'ct_cp').last_fire_status, 'error');
  } finally {
    dir.cleanup();
  }
});

test('tick：同 dueAt 重放 → CP 判 dup，结果如实带回', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    const dueAt = NOON.getTime() - 1000;
    insertCrontab(dir, { id: 'ct_dup', cron: '*/5 * * * *', next_fire: dueAt });
    heartbeatTick(makeDeps(dir, cp, NOON)); // 第一次：fired
    // 人为把 next_fire 拨回同一 dueAt（模拟"崩溃后重启又选中同一行"）
    dir.db.prepare('UPDATE crontabs SET next_fire = ? WHERE id = ?').run(dueAt, 'ct_dup');
    const out2 = heartbeatTick(makeDeps(dir, cp, NOON));
    assert.equal(out2[0]!.status, 'fired');
    assert.equal((out2[0] as { dup: boolean }).dup, true); // CP dedup_key 命中
    assert.equal(cp.ingestCalls.length, 2); // 两次都到过 CP（dedup 在 CP 侧）
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 三、quiet_hours
// ═══════════════════════════════════════════════════════════════════

test('inQuietHours：日内区间与跨午夜区间', () => {
  assert.equal(inQuietHours('09:00-18:00', new Date(2026, 0, 15, 12, 0)), true);
  assert.equal(inQuietHours('09:00-18:00', new Date(2026, 0, 15, 8, 59)), false);
  assert.equal(inQuietHours('09:00-18:00', new Date(2026, 0, 15, 18, 0)), false); // 右开
  assert.equal(inQuietHours('23:00-07:30', new Date(2026, 0, 15, 23, 30)), true);  // 跨午夜
  assert.equal(inQuietHours('23:00-07:30', new Date(2026, 0, 15, 3, 0)), true);
  assert.equal(inQuietHours('23:00-07:30', new Date(2026, 0, 15, 7, 30)), false);
  assert.equal(inQuietHours(null, new Date()), false);           // 未配 → 不拦
  assert.equal(inQuietHours('', new Date()), false);
  assert.equal(inQuietHours('乱码', new Date()), false);          // fail-open
  assert.equal(inQuietHours('25:00-26:00', new Date()), false);   // 越界 → fail-open
  assert.equal(inQuietHours('12:00-12:00', new Date(2026, 0, 15, 12, 0)), false); // 空区间
});

test('tick：quiet_hours 命中 → skipped_quiet，不投递', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    const at = new Date(2026, 0, 15, 2, 0, 0, 0); // 凌晨 2 点
    insertCrontab(dir, { id: 'ct_q', cron: '*/5 * * * *', next_fire: at.getTime() - 1, quiet_hours: '23:00-07:00' });
    const out = heartbeatTick(makeDeps(dir, cp, at));
    assert.equal(out[0]!.status, 'skipped_quiet');
    assert.equal(cp.ingestCalls.length, 0);
    // next_fire 仍推进（否则下个 tick 反复选中同一行）
    assert.ok(readRow(dir, 'ct_q').next_fire > at.getTime());
    assert.equal(readRow(dir, 'ct_q').last_fire_status, 'skipped_quiet');
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 四、skip_if_busy
// ═══════════════════════════════════════════════════════════════════

test('tick：有 queued/running 任务 → skipped_busy（数据源 cp.list）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    cp.activeCount = 2;
    insertCrontab(dir, { id: 'ct_busy', cron: '*/5 * * * *', next_fire: NOON.getTime() - 1, dot_id: 'dot7' });
    const out = heartbeatTick(makeDeps(dir, cp, NOON));
    assert.equal(out[0]!.status, 'skipped_busy');
    assert.equal((out[0] as { activeTasks: number }).activeTasks, 2);
    // 查询用的正是 §5.4 规定的形状
    assert.deepEqual(cp.listCalls[0], { status: ['queued', 'running'], dotId: 'dot7' });
    assert.equal(cp.ingestCalls.length, 0);
    assert.equal(readRow(dir, 'ct_busy').last_fire_status, 'skipped_busy');
  } finally {
    dir.cleanup();
  }
});

test('tick：skip_if_busy=0 → 忙时也投递', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    cp.activeCount = 3;
    insertCrontab(dir, { id: 'ct_nb', cron: '*/5 * * * *', next_fire: NOON.getTime() - 1, skip_if_busy: 0 });
    const out = heartbeatTick(makeDeps(dir, cp, NOON));
    assert.equal(out[0]!.status, 'fired');
    assert.equal(cp.listCalls.length, 0); // 不查
    assert.equal(cp.ingestCalls.length, 1);
  } finally {
    dir.cleanup();
  }
});

test('tick：空闲（0 个活动任务）→ 照常 fired', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    insertCrontab(dir, { id: 'ct_idle', cron: '*/5 * * * *', next_fire: NOON.getTime() - 1 });
    const out = heartbeatTick(makeDeps(dir, cp, NOON));
    assert.equal(out[0]!.status, 'fired');
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 五、last_fire_* 落点（契约 H1：并入 crontabs 单表）
// ═══════════════════════════════════════════════════════════════════

test('last_fire_*：fired 时 last_fired_at/last_fire_seq/last_fire_status 都落 crontabs', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    insertCrontab(dir, { id: 'ct_mark', cron: '*/5 * * * *', next_fire: NOON.getTime() - 1 });
    heartbeatTick(makeDeps(dir, cp, NOON));
    heartbeatTick(makeDeps(dir, cp, NOON)); // 第二次（next_fire 已推进 → 不再 due）
    const row = readRow(dir, 'ct_mark');
    assert.equal(row.last_fire_status, 'fired');
    assert.equal(row.last_fired_at, NOON.getTime());
    assert.equal(row.last_fire_seq, 1);
    // 第二次 tick 无事可做（next_fire 已推到未来）
    const out2 = heartbeatTick(makeDeps(dir, cp, NOON));
    assert.deepEqual(out2, []);
    assert.equal(readRow(dir, 'ct_mark').last_fire_seq, 1);
  } finally {
    dir.cleanup();
  }
});

test('无 surf_heartbeat_state 表（契约 H1 作废；全部并入 crontabs）', () => {
  const dir = makeTempDataDir();
  try {
    const tables = dir.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'surf_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('surf_sse_cursor'));
    assert.ok(names.includes('surf_ingress_rejects'));
    assert.ok(names.includes('surf_tg_card_state'));
    assert.ok(!names.includes('surf_heartbeat_state'), '该表已作废');
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 六、nextFireFrom 与 catchup 阈值
// ═══════════════════════════════════════════════════════════════════

test('nextFireFrom：严格晚于 from 的下一次（cron-parser）', () => {
  const from = new Date(2026, 0, 15, 12, 0, 0, 0);
  assert.equal(new Date(nextFireFrom('*/5 * * * *', from)).getMinutes(), 5);
  assert.equal(new Date(nextFireFrom('0 9 * * *', from)).getHours(), 9);
  assert.equal(new Date(nextFireFrom('0 9 * * *', from)).getDate(), 16); // 当天 9 点已过 → 明天
  assert.equal(nextFireFrom('* * * * *', from.getTime()), from.getTime() + 60_000);
  assert.throws(() => nextFireFrom('bad cron', from));
});

test('catchup=latest：距上次触发超阈值时仍投递（阈值只影响判定不阻断）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    // 上次触发在 10 分钟前，tick 阈值 45s（3×15s）→ staleFor 远超阈值
    insertCrontab(dir, {
      id: 'ct_catch',
      cron: '*/5 * * * *',
      next_fire: NOON.getTime() - 1,
      last_fired_at: NOON.getTime() - 600_000,
      catchup: 'latest',
    });
    const out = heartbeatTick(makeDeps(dir, cp, NOON, 45_000));
    assert.equal(out[0]!.status, 'fired');
    assert.equal(cp.ingestCalls.length, 1);
  } finally {
    dir.cleanup();
  }
});

test('catchup=skip：配置为 skip 时不补投（对齐 CP scheduler.ts:219-222）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    insertCrontab(dir, {
      id: 'ct_skip',
      cron: '*/5 * * * *',
      next_fire: NOON.getTime() - 1,
      last_fired_at: NOON.getTime() - 600_000,
      catchup: 'skip',
    });
    // §5.4 第二段「catchup='skip' → 不补、直接推进 next_due_at」：
    // 即便 due 且距上次触发远超阈值，本轮也不投递一条事件。
    const out = heartbeatTick(makeDeps(dir, cp, NOON, 45_000));
    assert.equal(out[0]!.status, 'skipped_catchup');
    assert.equal(cp.ingestCalls.length, 0);
    // next_fire 已被推进（先推进后判定，不补发风暴的性质不变）
    const row = dir.db.prepare('SELECT next_fire, last_fire_status FROM crontabs WHERE id = ?').get('ct_skip') as { next_fire: number; last_fire_status: string };
    assert.ok(row.next_fire > NOON.getTime());
    assert.equal(row.last_fire_status, 'skipped_catchup');
  } finally {
    dir.cleanup();
  }
});

test('catchup=latest：距上次触发在阈值内且 due → 正常触发一次', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    insertCrontab(dir, {
      id: 'ct_fresh',
      cron: '*/5 * * * *',
      next_fire: NOON.getTime() - 1,
      last_fired_at: NOON.getTime() - 10_000,
      catchup: 'latest',
    });
    const out = heartbeatTick(makeDeps(dir, cp, NOON, 45_000));
    assert.equal(out[0]!.status, 'fired');
    assert.equal(cp.ingestCalls.length, 1);
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 七、crontabs 管理面（`dotd hb` / POST /api/heartbeat）
// ═══════════════════════════════════════════════════════════════════

test('管理面：add → 入表即算好 next_fire；list/remove/setEnabled', () => {
  const dir = makeTempDataDir();
  try {
    const admin = createHeartbeatAdmin(dir.db);
    const added = admin.add({
      dotId: 'dot1',
      title: '每日复盘',
      prompt: '复盘今天做了什么',
      cron: '0 22 * * *',
    });
    assert.match(added.id, /^ct_/);
    assert.equal(added.enabled, 1);
    assert.equal(added.catchup, 'latest');
    assert.equal(added.skip_if_busy, 1);
    // 入表即由 cron-parser 算好（DDL 注释逐字）
    assert.ok(added.next_fire > NOON.getTime());
    assert.equal(new Date(added.next_fire).getHours(), 22);

    assert.equal(admin.list('dot1').length, 1);
    const quiet = admin.add({
      dotId: 'dot1', title: '夜巡', prompt: 'p', cron: '*/10 * * * *',
      quietHours: '23:00-07:00', skipIfBusy: false,
    });
    assert.equal(quiet.quiet_hours, '23:00-07:00');
    assert.equal(quiet.skip_if_busy, 0);
    assert.equal(admin.list('dot1').length, 2);
    assert.equal(admin.list('other').length, 0);

    assert.equal(admin.setEnabled(added.id, false)?.enabled, 0);
    // list 不做 enabled 过滤（含停用行；停用与否由 tick 的 selectDue 决定）
    assert.equal(admin.list('dot1').length, 2);
    assert.equal(admin.setEnabled(added.id, true)?.enabled, 1);
    assert.equal(admin.remove(added.id), true);
    assert.equal(admin.remove(added.id), false); // 幂等：第二次无事可做
    assert.equal(admin.list('dot1').length, 1); // 只剩夜巡
  } finally {
    dir.cleanup();
  }
});

test('管理面：add 拒绝非法 cron（ConfigError 之外的明确报错，不落库）', () => {
  const dir = makeTempDataDir();
  try {
    const admin = createHeartbeatAdmin(dir.db);
    assert.throws(() => admin.add({ dotId: 'dot1', title: 'x', prompt: 'y', cron: 'bad' }));
    const rows = dir.db.prepare('SELECT COUNT(*) AS n FROM crontabs').get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    dir.cleanup();
  }
});

test('makeHeartbeatTickJob：吞掉 tick 整体异常（不打死注册方）', async () => {
  const dir = makeTempDataDir();
  try {
    // 给一个会炸的 deps（db 已关）——整体异常必须被吞
    const cp = makeCp();
    const deps = makeDeps(dir, cp, NOON);
    dir.cleanup(); // 关库
    const job = makeHeartbeatTickJob(deps);
    await job(); // 不抛即通过
    assert.equal(cp.ingestCalls.length, 0);
  } finally {
    dir.cleanup();
  }
});

test('tick 多条 crontab 时互不影响（一条 error 不挡其他 fired）', () => {
  const dir = makeTempDataDir();
  try {
    const cp = makeCp();
    const now = NOON;
    for (let i = 0; i < 5; i++) {
      insertCrontab(dir, { id: `ct_m${i}`, cron: i === 2 ? 'broken' : '*/5 * * * *', next_fire: now.getTime() - 1 });
    }
    const out = heartbeatTick(makeDeps(dir, cp, now));
    assert.equal(out.length, 5);
    assert.equal(out.filter((o) => o.status === 'fired').length, 4);
    assert.equal(out.filter((o) => o.status === 'error').length, 1);
    assert.equal(cp.ingestCalls.length, 4);
  } finally {
    dir.cleanup();
  }
});
