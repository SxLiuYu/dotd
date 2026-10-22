/**
 * tests/proactive-event.test.ts —— F7 事件驱动主动打扰的闸门单元判据（2026-10-22）
 *
 * 盯三件事，写错的代价各不相同：
 *   1. 默认关 + 「没配过策略」必须**原样透传**。升级后已有的事件源不能突然
 *      开始给主人发消息，也不能突然把已经在收的东西变哑 —— 后者更糟。
 *   2. 安静时段拦在**进管线之前**（ingest=false），开关/节流只拦推送（ingest=true）。
 *      混一起的话，"安静"会变成"不干活"，与 crontabs 的既有语义背离。
 *   3. force 只顶开节流，不顶开开关和安静时段。
 *
 * 三道闸的算法本身在 proactive.test.ts 里判；这里只判"事件路径怎么读它"。
 */
import {
  decideEventPush,
  isInQuietHours,
  readEventPushPolicy,
  recordEventFire,
} from '../src/surfaces/proactive.ts';
import type { EventPushPolicy } from '../src/surfaces/proactive.ts';
import { DatabaseSync } from 'node:sqlite';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const at = (h: number, m = 0): number => new Date(2026, 9, 20, h, m, 0, 0).getTime();

/** 读回策略行（.get() 的类型是 Record|undefined，这里统一收窄成策略形状）。 */
const polRow = (d: DatabaseSync, actor: string): EventPushPolicy =>
  d.prepare('SELECT * FROM event_push_policy WHERE actor=?').get(actor) as unknown as EventPushPolicy;

const pol = (over: Partial<EventPushPolicy> = {}): EventPushPolicy => ({
  source: 'http',
  actor: 'sub_a',
  enabled: 1,
  quiet_hours: null,
  throttle_hours: 6,
  last_push_at: null,
  last_fire_at: null,
  last_fire_status: null,
  ...over,
});

// ── 1. 没配过策略 = 闸门完全不介入 ──────────────────────────────
{
  const d = decideEventPush({ policy: null, now: at(12) });
  ok('无策略行不介入', d.intervenes === false);
  ok('无策略行照旧进管线', d.ingest === true);
  ok('无策略行照旧可推送', d.announce === true);
  ok('无策略行不动 last_push_at', d.markPushAt === false);
}

// ── 2. 默认关：进管线、不推送 ───────────────────────────────────
{
  const d = decideEventPush({ policy: pol({ enabled: 0 }), now: at(12) });
  ok('enabled=0 时事件仍进管线', d.ingest === true);
  ok('enabled=0 时不主动推', d.announce === false);
  ok('enabled=0 的原因是 disabled', d.reason === 'disabled');
  ok('enabled=0 不记 last_push_at', d.markPushAt === false);
  ok('enabled=0 也算 fired', d.fireStatus === 'fired');
}

// ── 3. 安静时段：拦在进管线之前（与 cron 同语义）────────────────
{
  const d = decideEventPush({ policy: pol({ quiet_hours: '23:00-07:30' }), now: at(3) });
  ok('安静时段事件不进管线', d.ingest === false, '语义：任务根本不被创建');
  ok('安静时段不推送', d.announce === false);
  ok('安静时段原因码', d.reason === 'quiet_hours');
  ok('安静时段落 skipped_quiet', d.fireStatus === 'skipped_quiet');
  ok('安静时段不动 last_push_at', d.markPushAt === false);

  // 开关也关了，仍应报安静时段（这里先判 ②，与 shouldPush 的顺序不同是刻意的：
  // 要的结果是"不进门"，光知道"不推送"不够）
  const both = decideEventPush({
    policy: pol({ enabled: 0, quiet_hours: '23:00-07:30' }),
    now: at(3),
  });
  ok('安静时段优先于开关（要的是不进门）', both.ingest === false);

  // force 不能顶开安静时段：主人设了静音就是明确说了那段别吵
  const forced = decideEventPush({
    policy: pol({ quiet_hours: '23:00-07:30' }),
    now: at(3),
    force: true,
  });
  ok('force 不顶开安静时段', forced.ingest === false);
}

// ── 4. 节流：进管线、不推送、额度不动 ──────────────────────────
{
  const ago2h = at(12) - 2 * 3_600_000;
  const d = decideEventPush({ policy: pol({ last_push_at: ago2h }), now: at(12) });
  ok('节流窗口内仍进管线', d.ingest === true, '不推送 ≠ 不执行');
  ok('节流窗口内不推送', d.announce === false);
  ok('节流原因码', d.reason === 'throttled');
  ok('节流不更新 last_push_at', d.markPushAt === false, '否则窗口被每次拦截往后推');

  const ago7h = at(12) - 7 * 3_600_000;
  const d2 = decideEventPush({ policy: pol({ last_push_at: ago7h }), now: at(12) });
  ok('超出节流窗口放行', d2.announce === true && d2.markPushAt === true);

  const d3 = decideEventPush({ policy: pol({ throttle_hours: 0, last_push_at: at(11) }), now: at(12) });
  ok('throttle=0 不节流', d3.announce === true);
}

// ── 5. 放行路径 ────────────────────────────────────────────────
{
  const d = decideEventPush({ policy: pol(), now: at(12) });
  ok('开+非静+没推过 → 推', d.announce === true && d.markPushAt === true && d.ingest === true);
  ok('放行时 fireStatus=fired', d.fireStatus === 'fired');
  ok('放行时无原因码', d.reason === undefined);

  const nt = decideEventPush({ policy: pol(), now: at(12), hasTarget: false });
  ok('没目标时不推', nt.announce === false && nt.reason === 'no_target');
}

// ── 6. force 只顶开节流 ────────────────────────────────────────
{
  const ago2h = at(12) - 2 * 3_600_000;
  const f = decideEventPush({ policy: pol({ last_push_at: ago2h }), now: at(12), force: true });
  ok('force 顶开节流', f.announce === true && f.markPushAt === true);
  const f2 = decideEventPush({ policy: pol({ enabled: 0, last_push_at: ago2h }), now: at(12), force: true });
  ok('force 不顶开开关', f2.announce === false && f2.reason === 'disabled');
  const f3 = decideEventPush({ policy: pol(), now: at(12), hasTarget: false, force: true });
  ok('force 不顶开没目标', f3.announce === false && f3.reason === 'no_target');
}

// ── 7. 跨午夜的安静时段在事件路径同样生效 ──────────────────────
{
  const p = pol({ quiet_hours: '22:30-06:45' });
  ok('事件路径支持跨午夜(23:00)', decideEventPush({ policy: p, now: at(23, 0) }).ingest === false);
  ok('事件路径支持跨午夜(05:00)', decideEventPush({ policy: p, now: at(5, 0) }).ingest === false);
  ok('事件路径跨午夜外放行(12:00)', decideEventPush({ policy: p, now: at(12, 0) }).ingest === true);
  ok('格式错按不静音', decideEventPush({ policy: pol({ quiet_hours: 'garbage' }), now: at(12) }).ingest === true);
  ok('isInQuietHours 仍可用', isInQuietHours('23:00-07:30', at(2)) === true);
}

// ── 8. 策略读取 / 记账落到真实 DB 形状 ─────────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event_push_policy (
      source TEXT NOT NULL, actor TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours TEXT, throttle_hours INTEGER NOT NULL DEFAULT 6, last_push_at INTEGER,
      last_fire_at INTEGER, last_fire_status TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, actor))`);
  db.prepare('INSERT INTO event_push_policy(source,actor,enabled,updated_at) VALUES(?,?,?,?)')
    .run('http', 'sub_a', 1, 1);

  const got = readEventPushPolicy(db, 'http', 'sub_a');
  ok('读得到策略行', got !== null && got.enabled === 1);
  ok('读得到默认 throttle=6', got?.throttle_hours === 6);
  ok('读不到的 actor 返回 null', readEventPushPolicy(db, 'http', 'nope') === null);
  ok('表不存在时不炸（返回 null）', readEventPushPolicy(new DatabaseSync(':memory:'), 'http', 'x') === null);

  // 放行：last_push_at 被写
  recordEventFire(db, 'http', 'sub_a', decideEventPush({ policy: got, now: 5000 }), 5000);
  const r1 = polRow(db, 'sub_a');
  ok('放行写入 last_push_at', r1.last_push_at === 5000);
  ok('放行写入 fired', r1.last_fire_status === 'fired');

  // 节流命中：last_push_at 绝不能被推到新时刻
  recordEventFire(db, 'http', 'sub_a', decideEventPush({ policy: r1, now: 6000 }), 6000);
  const r2 = polRow(db, 'sub_a');
  ok('节流不动 last_push_at（防滑动窗口）', r2.last_push_at === 5000);
  ok('节流仍记 fired', r2.last_fire_status === 'fired');

  // 安静时段：不写 last_push_at，但要把"拦过"留成证据
  db.prepare('UPDATE event_push_policy SET quiet_hours=? WHERE actor=?').run('00:00-23:59', 'sub_a');
  const q = readEventPushPolicy(db, 'http', 'sub_a')!;
  recordEventFire(db, 'http', 'sub_a', decideEventPush({ policy: q, now: 9000 }), 9000);
  const r3 = polRow(db, 'sub_a');
  ok('安静时段留 skipped_quiet 证据', r3.last_fire_status === 'skipped_quiet');
  ok('安静时段不更新 last_push_at', r3.last_push_at === 5000);
  ok('安静时段仍记 last_fire_at', r3.last_fire_at === 9000);

  // 没介入时一个字都不该写
  recordEventFire(db, 'http', 'sub_a', decideEventPush({ policy: null, now: 10000 }), 10000);
  const r4 = polRow(db, 'sub_a');
  ok('不介入时不落任何账', r4.last_fire_at === 9000);
  db.close();
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);