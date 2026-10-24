/**
 * tests/surfaces-feed.test.ts —— 动态投影（M1，2026-10-23）。
 *
 * 只测纯函数 buildFeed：输入是五类事实的行投影，输出是时间线。
 * 取数（collectFeedInput）不在这里测——它只是 SQL，端到端由 HTTP 路由测试覆盖。
 *
 * 重点守三条语义：
 *   1. 同一件事只出现一次（awaiting_approval 的任务不再单独出一条任务项）；
 *   2. 时间倒序 + since/limit 真的生效；
 *   3. 每条都带 provenance（能回答"为什么在这里"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeed,
  collectFeed,
  parseSqliteTs,
  type FeedInput,
} from '../src/surfaces/feed.ts';
import { makeTempDataDir } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');

function input(over: Partial<FeedInput> = {}): FeedInput {
  return {
    nowMs: NOW,
    tasks: [],
    approvals: [],
    crontabs: [],
    events: [],
    calendar: [],
    calendarErrors: [],
    ...over,
  };
}

test('时间倒序：最新的在最前', () => {
  const items = buildFeed(
    input({
      tasks: [
        { id: 'tk_a', title: 'A', status: 'done', createdAt: 1, updatedAt: 1000, sourceEventId: null, lastHeartbeatAt: null },
        { id: 'tk_b', title: 'B', status: 'failed', createdAt: 2, updatedAt: 3000, sourceEventId: null, lastHeartbeatAt: null },
        { id: 'tk_c', title: 'C', status: 'running', createdAt: 3, updatedAt: 2000, sourceEventId: null, lastHeartbeatAt: null },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ['task:tk_b', 'task:tk_c', 'task:tk_a'],
  );
});

test('同一件事只出现一次：awaiting_approval 的任务不单独出任务项', () => {
  const items = buildFeed(
    input({
      tasks: [
        {
          id: 'tk_wait',
          title: '发邮件',
          status: 'awaiting_approval',
          createdAt: 1,
          updatedAt: 1000,
          sourceEventId: null,
          lastHeartbeatAt: null,
        },
      ],
      approvals: [
        {
          id: 7,
          seq: 12,
          kind: 'tool_call',
          summary: 'mail.send → 张三',
          status: 'pending',
          createdAt: '2026-10-23 11:00:00',
          pendingUntil: '2026-10-24 11:00:00',
          taskId: 'tk_wait',
        },
      ],
    }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, 'approval:12');
  assert.equal(items[0]!.taskId, 'tk_wait');
  assert.equal(items[0]!.attention, 'high');
});

test('审批：24 小时内过期会写进正文；问题单给「去回答」', () => {
  const items = buildFeed(
    input({
      approvals: [
        {
          id: 1,
          seq: 1,
          kind: 'question',
          summary: '收件地址是哪里？',
          status: 'pending',
          createdAt: '2026-10-23 11:00:00',
          pendingUntil: '2026-10-23 18:00:00',
          taskId: 'tk_1',
        },
      ],
    }),
  );
  assert.equal(items[0]!.action?.label, '去回答');
  assert.match(items[0]!.body ?? '', /小时内会过期/);
  assert.equal(items[0]!.provenance.note, 'Dot 在等你回答');
});

test('inbox 事件：高优先级 + 可一键派任务 + 带事件 id', () => {
  const items = buildFeed(
    input({
      events: [{ id: 9, source: 'http', actor: 'grafana', payload: '{"alert":"disk"}', receivedAt: NOW - 1000 }],
    }),
  );
  assert.equal(items[0]!.attention, 'high');
  assert.equal(items[0]!.provenance.ref, 'event:9');
  assert.equal(items[0]!.action?.kind, 'submit_goal');
  assert.match(items[0]!.action?.goal ?? '', /disk/);
});

test('定时任务：只有 error 才进动态；skipped_quiet 不进', () => {
  const items = buildFeed(
    input({
      crontabs: [
        { id: 'ct_err', title: '早间简报', lastFiredAt: NOW - 1000, lastFireStatus: 'error', nextFire: NOW + 1000 },
        { id: 'ct_quiet', title: '夜间巡检', lastFiredAt: NOW - 1000, lastFireStatus: 'skipped_quiet', nextFire: NOW + 1000 },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ['cron:ct_err'],
  );
});

test('今日日程进时间线；日历读失败单独成条（不假装今天没事）', () => {
  const items = buildFeed(
    input({
      calendar: [{ startMs: NOW + 3_600_000, allDay: false, summary: '评审', location: '会议室' }],
      calendarErrors: ['/root/.dotd/calendar: EACCES'],
    }),
  );
  assert.equal(items.length, 2);
  const cal = items.find((i) => i.kind === 'calendar')!;
  assert.match(cal.title, /评审/);
  const err = items.find((i) => i.kind === 'system')!;
  assert.equal(err.attention, 'high');
  assert.match(err.body ?? '', /EACCES/);
});

test('since 过滤 + limit 截断', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    id: `tk_${n}`,
    title: `t${n}`,
    status: 'done',
    createdAt: n,
    updatedAt: n * 1000,
    sourceEventId: null,
    lastHeartbeatAt: null,
  }));
  const items = buildFeed(input({ tasks: rows }), { since: 2000, limit: 2 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['task:tk_5', 'task:tk_4'],
  );
});

test('坏时间戳的审批被跳过，不产生 NaN 排序', () => {
  const items = buildFeed(
    input({
      approvals: [
        {
          id: 1,
          seq: 1,
          kind: 'tool_call',
          summary: '坏时间',
          status: 'pending',
          createdAt: 'not-a-time',
          pendingUntil: 'also-bad',
          taskId: 'tk_1',
        },
      ],
    }),
  );
  assert.equal(items.length, 0);
});

test('parseSqliteTs：SQLite UTC 文本按 UTC 解释', () => {
  assert.equal(parseSqliteTs('2026-10-23 12:00:00'), Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(parseSqliteTs('2026-10-23T12:00:00Z'), Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(parseSqliteTs(''), null);
});

test('collectFeed：从真实表读，一条时间线里五类事实都在', () => {
  const tmp = makeTempDataDir();
  try {
    const db = tmp.db;
    db.prepare(
      `INSERT INTO tasks (id, dot_id, title, goal, status, priority, created_at, updated_at)
       VALUES ('tk_feed', 'dot1', '整理邮件', '整理邮件', 'failed', 1, ?, ?)`,
    ).run(NOW - 5000, NOW - 1000);
    db.prepare(
      `INSERT INTO approvals (seq, kind, dot_id, task_id, tool, tier, journal_step, params_json, summary, reason, pending_until)
       VALUES (1, 'tool_call', 'dot1', 'tk_feed', 'mail.send', 'dangerous', 'c1', '{}', 'mail.send → 张三', '要发信', '2026-10-23 18:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO crontabs (id, dot_id, title, prompt, cron, next_fire, last_fired_at, last_fire_status)
       VALUES ('ct_feed', 'dot1', '早间提醒', '提醒', '0 8 * * *', ?, ?, 'error')`,
    ).run(NOW + 1000, NOW - 2000);
    db.prepare(
      `INSERT INTO events (source, dot_id, actor, payload, status, received_at)
       VALUES ('http', 'dot1', 'grafana', '{"alert":"disk"}', 'inbox', ?)`,
    ).run(NOW - 3000);

    const snap = collectFeed({ db, calendarDir: tmp.root + '/calendar' }, NOW);
    const kinds = new Set(snap.items.map((i) => i.kind));
    assert.ok(kinds.has('task'));
    assert.ok(kinds.has('approval'));
    assert.ok(kinds.has('schedule'));
    assert.ok(kinds.has('event'));
    assert.equal(snap.items.find((i) => i.kind === 'event')?.provenance.ref, 'event:1');
    assert.equal(snap.items.find((i) => i.kind === 'schedule')?.provenance.ref, 'cron:ct_feed');
  } finally {
    tmp.cleanup();
  }
});

// ── 阶段 2：语音反射记账进动态（2026-10-23）────────────────────────

test('buildFeed：语音记账各出一条，带 device provenance；离线那条 attention=high', () => {
  const items = buildFeed(
    input({
      voice: [
        { id: 1, deviceId: 'dev_aaa', deviceName: '客厅屏', kind: 'scene', detail: '晚安', at: 3000 },
        { id: 2, deviceId: 'dev_aaa', deviceName: '客厅屏', kind: 'fast_path.role_switch', detail: '切换到贾维斯', at: 2000 },
        { id: 3, deviceId: 'dev_bbb', deviceName: null, kind: 'offline', detail: '帮我订票', at: 1000 },
      ],
    }),
  );
  assert.deepEqual(items.map((i) => i.id), ['voice:1', 'voice:2', 'voice:3']);
  assert.deepEqual(items.map((i) => i.kind), ['voice', 'voice', 'voice']);
  assert.equal(items[0]!.provenance.source, 'device');
  assert.equal(items[0]!.provenance.ref, 'voice:1');
  assert.match(items[0]!.provenance.note ?? '', /客厅屏/);
  assert.match(items[0]!.title, /晚安/);
  assert.equal(items[1]!.attention, 'low');
  assert.equal(items[2]!.attention, 'high');
  assert.match(items[2]!.provenance.note ?? '', /dev_bbb/, '没有设备名也要能追溯 id');
});

test('collectFeed：voice_events 真的从表里读出来（LEFT JOIN devices 拿名字）', () => {
  const tmp = makeTempDataDir();
  try {
    tmp.db
      .prepare(
        `INSERT INTO devices (id, dot_id, name, token_hash, status, created_at)
         VALUES ('dev_feed', 'dot1', '厨房屏', 'hash', 'active', ?)`,
      )
      .run(NOW);
    tmp.db
      .prepare('INSERT INTO voice_events (dot_id, device_id, kind, detail, at) VALUES (?,?,?,?,?)')
      .run('dot1', 'dev_feed', 'scene', '晚安', NOW - 1000);

    const snap = collectFeed({ db: tmp.db, calendarDir: tmp.root + '/calendar' }, NOW);
    const v = snap.items.find((i) => i.kind === 'voice');
    assert.ok(v !== undefined);
    assert.equal(v.id, 'voice:1');
    assert.equal(v.provenance.note, '来自设备 厨房屏');
  } finally {
    tmp.cleanup();
  }
});
