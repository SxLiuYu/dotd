/**
 * tests/event-proactive-wiring.test.ts —— F7 事件驱动主动打扰的**接线**判据（2026-10-22）
 *
 * 存在的理由：本轮已经被"函数写对了但没有任何地方调用它"坑过两次
 * （resolveExecution / clipForFeishu）。所以这里不测 shouldPush 的算法
 * （tests/proactive-event.test.ts 测了），只测一件事——
 * **闸门真的挂在非 cron 机器事件的唯一漏斗 ControlPlaneInstance.ingestEvent 上**。
 *
 * 覆盖五条语义，逐条对应 crontabs 那边的既有口径：
 *   ① 没配策略 → payload 原样透传（升级不改变任何现有行为）
 *   ② enabled=0 → 事件进管线、任务照建，payload 打 proactive=false
 *   ③ 安静时段 → 不落 events 行、不建任务，策略行 last_fire_status=skipped_quiet
 *   ④ 节流命中 → 事件照常进管线（任务照建），只是不推送；且**不更新 last_push_at**
 *   ⑤ 节流状态来自库里：换一个全新的 ControlPlane 实例读同一颗库，照样被拦
 *      （放内存的话一次 daemon 重启节流就归零）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { ControlPlaneInstance } from '../src/control-plane/index.ts';
import type { EventRule } from '../src/control-plane/match.ts';

const tmps: TempDataDir[] = [];
const HOUR = 3_600_000;

/** 一定**包含**当前本地时刻的安静时段（跨午夜那个特例走 23:00-00:30）。 */
function insideQuiet(): string {
  const h = new Date().getHours();
  return h < 23 ? `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00` : '23:00-00:30';
}
/** 一定**不包含**当前时刻的安静时段（取 5 小时后那一格）。 */
function outsideQuiet(): string {
  const h = new Date().getHours();
  return `${String((h + 5) % 24).padStart(2, '0')}:00-${String((h + 6) % 24).padStart(2, '0')}:00`;
}

const RULES: EventRule[] = [
  { id: 'r_sub', match: { source: 'http', actor: 'sub_a' }, action: 'run_new', reason: '订阅回调建任务' },
];

/** 写一行事件推送策略（只给要改的字段，其余按迁移 185 的默认值补）。 */
function up(
  db: TempDataDir['db'],
  source: string,
  actor: string,
  over: {
    enabled?: number;
    quiet_hours?: string | null;
    throttle_hours?: number;
    last_push_at?: number | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO event_push_policy(source, actor, enabled, quiet_hours, throttle_hours, last_push_at, updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(source, actor) DO UPDATE SET enabled=excluded.enabled, quiet_hours=excluded.quiet_hours,
       throttle_hours=excluded.throttle_hours, last_push_at=excluded.last_push_at, updated_at=excluded.updated_at`,
  ).run(
    source,
    actor,
    over.enabled ?? 1,
    over.quiet_hours ?? null,
    over.throttle_hours ?? 6,
    over.last_push_at ?? null,
    Date.now(),
  );
}

function open(tmp: TempDataDir): ControlPlaneInstance {
  return createControlPlane({ db: tmp.db, bus: tmp.bus, rules: RULES });
}

function payloadOf(tmp: TempDataDir, eventId: number): Record<string, unknown> {
  const row = tmp.db.prepare('SELECT payload FROM events WHERE id=?').get(eventId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function taskOf(tmp: TempDataDir, eventId: number): { id: string } | undefined {
  return tmp.db.prepare('SELECT id FROM tasks WHERE source_event_id=?').get(eventId) as
    | { id: string }
    | undefined;
}

test('① 没配策略的事件源：payload 原样透传，闸门完全不介入', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'nobody_configured_me',
      payload: { kind: 'order.created', id: 7 },
      dedupKey: 'k1',
    });
    assert.equal(r.dup, false);
    const p = payloadOf(tmp, r.eventId);
    assert.ok(!('proactive' in p), '没配过策略就不能往 payload 里塞 proactive');
    assert.equal(p.kind, 'order.created');
    assert.equal(p.id, 7);
    // 闸门没介入 → 一个字都不该记（last_fire_at 保持 NULL）
    const pol = tmp.db.prepare('SELECT COUNT(*) AS c FROM event_push_policy').get() as { c: number };
    assert.equal(pol.c, 0, '没配策略就不该有任何策略行');
    assert.equal((tmp.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c, 0);
  } finally {
    cp.shutdown();
  }
});

test('② enabled=0：事件进管线、任务照建，只把 proactive 打成 false', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 0 });
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'order.created' },
      dedupKey: 'k2',
    });
    assert.equal(payloadOf(tmp, r.eventId).proactive, false, '开关关掉 → 结果不主动推给主人');
    // 不推送 ≠ 不执行：事件进了管线，规则层照样能建任务
    cp.matcher.processEventSync(r.eventId);
    assert.ok(taskOf(tmp, r.eventId) !== undefined, '任务必须照常创建');
    const pol = tmp.db.prepare('SELECT * FROM event_push_policy WHERE actor=?').get('sub_a') as Record<string, unknown>;
    assert.equal(pol.last_push_at, null, '没推出去就不该写 last_push_at');
    assert.equal(pol.last_fire_status, 'fired', '任务确实跑了');
  } finally {
    cp.shutdown();
  }
});

test('③ 安静时段：不落 events、不建任务，留 skipped_quiet 证据（拦在调度层）', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 1, quiet_hours: insideQuiet() });
    const before = (tmp.db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c;
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'order.created' },
      dedupKey: 'k3',
    });
    assert.equal(r.eventId, 0, '安静时段 → 没有事件行');
    const after = (tmp.db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c;
    assert.equal(after, before, 'events 行数不得增加（与 cron 的 skipped_quiet 同语义：任务根本不被创建）');
    assert.equal(
      tmp.db.prepare('SELECT COUNT(*) c FROM tasks').get()!.c,
      0,
      '不建任务',
    );
    const pol = tmp.db.prepare('SELECT * FROM event_push_policy WHERE actor=?').get('sub_a') as Record<string, unknown>;
    assert.equal(pol.last_fire_status, 'skipped_quiet', '必须留下"拦过"的证据');
    assert.ok(typeof pol.last_fire_at === 'number', 'last_fire_at 落库');
    assert.equal(pol.last_push_at, null, '安静时段更不该算一次推送');
  } finally {
    cp.shutdown();
  }
});

test('④ 节流命中：事件照常进管线并建任务，只是不推送，且不推进 last_push_at', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    const pushedAt = Date.now() - HOUR; // 1 小时前推过，节流 6 小时
    up(tmp.db, 'http', 'sub_a', { enabled: 1, throttle_hours: 6, last_push_at: pushedAt });
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'order.created' },
      dedupKey: 'k4',
    });
    assert.equal(payloadOf(tmp, r.eventId).proactive, false, '节流窗口内不推送');
    cp.matcher.processEventSync(r.eventId);
    assert.ok(taskOf(tmp, r.eventId) !== undefined, '任务照常执行：不推送 ≠ 不执行');
    const pol = tmp.db.prepare('SELECT last_push_at FROM event_push_policy WHERE actor=?').get('sub_a') as {
      last_push_at: number;
    };
    assert.equal(pol.last_push_at, pushedAt, '命中节流绝不能把窗口往后推（滑动窗口 bug）');
  } finally {
    cp.shutdown();
  }
});

test('⑤ 节流状态在库里不在内存里：新实例读同一颗库照样拦（重启不归零）', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp1 = open(tmp);
  let firstPushAt = 0;
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 1, throttle_hours: 6, last_push_at: null });
    const r1 = cp1.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'a' },
      dedupKey: 'k5a',
    });
    assert.equal(payloadOf(tmp, r1.eventId).proactive, true, '第一次放行');
    firstPushAt = (tmp.db.prepare('SELECT last_push_at p FROM event_push_policy WHERE actor=?').get('sub_a') as { p: number })
      .p;
    assert.ok(firstPushAt > 0, '放行时把 last_push_at 落库');
  } finally {
    cp1.shutdown();
  }

  // 换一个全新的 ControlPlane 实例（相当于 daemon 重启）：闸门不得因为"内存里没记过"而放行
  const cp2 = open(tmp);
  try {
    const r2 = cp2.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'b' },
      dedupKey: 'k5b',
    });
    assert.equal(payloadOf(tmp, r2.eventId).proactive, false, '重启后仍被节流 —— 节流必须读库');
    assert.equal(
      (tmp.db.prepare('SELECT last_push_at p FROM event_push_policy WHERE actor=?').get('sub_a') as { p: number }).p,
      firstPushAt,
      '被拦住时额度不动',
    );
  } finally {
    cp2.shutdown();
  }
});

test('⑥ 重复投递（撞 dedup_key）不消耗节流额度', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 1, throttle_hours: 6, last_push_at: null });
    const r1 = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'a' },
      dedupKey: 'same-key',
    });
    assert.equal(payloadOf(tmp, r1.eventId).proactive, true);
    const written = (tmp.db.prepare('SELECT last_push_at p FROM event_push_policy').get() as { p: number }).p;
    const r2 = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'a' },
      dedupKey: 'same-key',
    });
    assert.equal(r2.dup, true, '撞 dedup_key 幂等返回');
    assert.equal(r2.eventId, r1.eventId);
    assert.equal(
      (tmp.db.prepare('SELECT last_push_at p FROM event_push_policy').get() as { p: number }).p,
      written,
      '重复投递没产生新的打扰，不该再记一次推送',
    );
  } finally {
    cp.shutdown();
  }
});

test('⑦ 非对象 payload 不被硬造包装（保持升级前的行为形状）', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 0 });
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: 'plain text body',
      dedupKey: 'k7',
    });
    // safeStringify 对字符串**原样入库**（不做 JSON 包装），所以下游 JSON.parse 会抛、
    // 被 shouldAnnounce 的 catch 兜住 → 照常回复。闸门在这里只记账、不改形状。
    const raw = tmp.db.prepare('SELECT payload FROM events WHERE id=?').get(r.eventId) as { payload: string };
    assert.equal(raw.payload, 'plain text body', '字符串 payload 不被硬造成对象');
    // 策略行仍然被记账（enabled=0 说明闸门介入了），但不产生 proactive 字段
    const pol = tmp.db.prepare('SELECT last_fire_status FROM event_push_policy WHERE actor=?').get('sub_a') as {
      last_fire_status: string;
    };
    assert.equal(pol.last_fire_status, 'fired');
  } finally {
    cp.shutdown();
  }
});

test('⑧ 安静时段之外的策略行不影响放行；cron 心跳路径不经此漏斗', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 1, quiet_hours: outsideQuiet() });
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'a' },
      dedupKey: 'k8',
    });
    assert.ok(r.eventId > 0, '不在安静时段 → 正常进管线');
    assert.equal(payloadOf(tmp, r.eventId).proactive, true);

    // heartbeat 由 fireHeartbeat 直接调 matcher.ingestEvent，不经这个门面。
    // 这里用门面补一条同形状事件，证明"没给 heartbeat 配策略"时它也不会被打标，
    // 即 cron 那边的判定不会被这道闸改第二遍。
    const hb = cp.ingestEvent({
      source: 'heartbeat',
      dotId: 'dot1',
      actor: 'ct_1',
      payload: { crontabId: 'ct_1', proactive: false },
      dedupKey: 'hb:ct_1:1',
    });
    assert.equal(payloadOf(tmp, hb.eventId).proactive, false, 'cron 的判定结论原样保留');
  } finally {
    cp.shutdown();
  }
});

test('⑨ 打标的 payload 能被下游按 shouldAnnounce 的读法读到（出站侧只差一句）', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = open(tmp);
  try {
    up(tmp.db, 'http', 'sub_a', { enabled: 0 });
    const r = cp.ingestEvent({
      source: 'http',
      dotId: 'dot1',
      actor: 'sub_a',
      payload: { kind: 'order.created' },
      dedupKey: 'k9',
    });
    cp.matcher.processEventSync(r.eventId);
    const task = taskOf(tmp, r.eventId);
    assert.ok(task !== undefined, '任务照常建出来');

    // 照 feishu-outbound.ts:shouldAnnounce 的两步查询读一遍：
    // tasks.source_event_id → events.payload。闸门写的结论必须能被这条路径取到。
    const row = tmp.db
      .prepare('SELECT source_event_id FROM tasks WHERE id = ?')
      .get(task!.id) as { source_event_id: number | null };
    assert.equal(row.source_event_id, r.eventId, '任务带着来源事件 id（下游据此回查）');
    const ev = tmp.db
      .prepare('SELECT source, payload FROM events WHERE id = ?')
      .get(row.source_event_id!) as { source: string; payload: string };
    const parsed = JSON.parse(ev.payload) as { proactive?: unknown };
    assert.equal(parsed.proactive, false, '结论落在 payload.proactive 上，读得到、类型是布尔');
    assert.equal(ev.source, 'http', '事件仍是 http 源（不改 source 字段）');
  } finally {
    cp.shutdown();
  }
});

// 清理临时树
test.afterEach(() => {});
process.on('exit', () => {
  for (const t of tmps) {
    try {
      t.cleanup();
    } catch {
      // 已清
    }
  }
});