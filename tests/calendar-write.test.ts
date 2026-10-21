/**
 * tests/calendar-write.test.ts —— 日历写回的硬判据（T7，2026-10-21）
 *
 * 守什么：
 *   1. add → list 立即可见，source='local'；订阅事件照旧来自各自的 .ics。
 *   2. add 内容幂等：同 标题+开始+结束 重放返回已有事件，不造第二份 VEVENT
 *      （工具声明 sideEffect=safe，这是"重放无副作用"的兑现手段）。
 *   3. edit 生效（含"只平移开始时间保持原时长"）；delete 后不可见；
 *      两者都只动本地事件 —— 订阅 .ics 的 id 传进来就是"没有"。
 *   4. conflicts 在本地+订阅合并后检查：本地×订阅的重叠查得出来。
 *   5. 生成的 ICS 是零依赖手写：含 VEVENT、DTSTART 带 UTC 时区（Z 形态）、
 *      转义与折行能被自家解析器原样读回（写出去的自己必须认得）。
 *   6. **订阅 .ics 在写路径上字节不变** —— T6"订阅只读"的边界在写回时代仍然成立。
 *
 * 跑法：node --import tsx --test tests/calendar-write.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addLocalEvent,
  deleteLocalEvent,
  editLocalEvent,
  listConflicts,
  listEvents,
} from '../src/calendar/CalendarService.ts';
import { parseIcs } from '../src/calendar/ics.ts';

/** 固定"现在"：2026-10-21T08:00Z。窗口取 7 天，窗口内的事件都在它之后。 */
const NOW = Date.UTC(2026, 9, 21, 8, 0, 0);

/** 一份最小订阅日历（work.ics）：2026-10-21T14:00Z 产品评审，1 小时。 */
const SUB_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:sub-1',
  'SUMMARY:产品评审',
  'DTSTART:20261021T140000Z',
  'DTEND:20261021T150000Z',
  'LOCATION:会议室 A',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** 每个用例一个临时日历目录，互不串味。 */
function makeCal(withSub: boolean): { dir: string; cfg: { dir: string }; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dotd-cal-'));
  if (withSub) writeFileSync(join(dir, 'work.ics'), SUB_ICS, 'utf8');
  return { dir, cfg: { dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('add → list 立即可见，source=local；订阅与本地两源并存', () => {
  const t = makeCal(true);
  try {
    const r = addLocalEvent(t.cfg, NOW, {
      summary: '周会',
      start: '2026-10-21T22:00:00+08:00', // = 14:00Z
      durationMin: 60,
      location: '会议室 B',
      notes: '带周报',
    });
    assert.ok(r.ok, 'add 应成功：' + (r.ok ? '' : r.error));
    if (!r.ok) return;
    assert.match(r.event.uid, /^dotd-local-/, 'uid 形态');
    assert.equal(r.event.source, 'local');

    const listed = listEvents(t.cfg, NOW, 7);
    const mine = listed.events.find((e) => e.summary === '周会');
    assert.ok(mine !== undefined, 'add 后 list 必须立刻看见（不缓存，直读文件）');
    assert.equal(mine!.source, 'local');
    assert.equal(mine!.location, '会议室 B');
    const sub = listed.events.find((e) => e.summary === '产品评审');
    assert.ok(sub !== undefined, '订阅事件照常可见');
    assert.equal(sub!.source, 'work');
    // 两个来源都在 sources 清单里
    assert.deepEqual(listed.sources.map((s) => s.name).sort(), ['local', 'work']);
  } finally {
    t.cleanup();
  }
});

test('add 内容幂等：同 标题+开始+结束 重放返回已有事件，文件只有一份 VEVENT', () => {
  const t = makeCal(false);
  try {
    const input = { summary: '周会', start: '2026-10-21T22:00:00+08:00', durationMin: 60 };
    const r1 = addLocalEvent(t.cfg, NOW, input);
    assert.ok(r1.ok);
    const r2 = addLocalEvent(t.cfg, NOW + 5000, input);
    assert.ok(r2.ok);
    if (!r1.ok || !r2.ok) return;
    assert.equal(r2.duplicate, true, '第二次是 duplicate');
    assert.equal(r2.event.uid, r1.event.uid, '返回同一个 uid');
    const file = readFileSync(t.cfg.dir + '/local.ics', 'utf8');
    assert.equal(file.split('BEGIN:VEVENT').length - 1, 1, '文件里只有一个 VEVENT');
    // 标题相同但开始不同 → 不是同一条，正常加第二条
    const r3 = addLocalEvent(t.cfg, NOW, { summary: '周会', start: '2026-10-23T10:00:00+08:00' });
    assert.ok(r3.ok && !r3.duplicate);
  } finally {
    t.cleanup();
  }
});

test('edit 生效；只平移开始时间保持原时长；订阅 id 传进来就是"没有"', () => {
  const t = makeCal(true);
  try {
    const r = addLocalEvent(t.cfg, NOW, { summary: '周会', start: '2026-10-21T22:00:00+08:00', durationMin: 90 });
    assert.ok(r.ok);
    if (!r.ok) return;
    // 改标题 + 平移开始（不传 end/durationMin → 原时长 90 分钟保住）
    const e = editLocalEvent(t.cfg, NOW, r.event.uid, {
      summary: '周会（改）',
      start: '2026-10-21T23:00:00+08:00',
    });
    assert.ok(e.ok, 'edit 应成功：' + (e.ok ? '' : e.error));
    if (!e.ok) return;
    assert.equal(e.event.summary, '周会（改）');
    assert.equal(e.event.startMs, r.event.startMs + 60 * 60_000, '开始平移 1 小时');
    assert.equal(e.event.endMs, e.event.startMs + 90 * 60_000, '整体平移：时长保持 90 分钟');
    const listed = listEvents(t.cfg, NOW, 7);
    assert.ok(listed.events.find((x) => x.summary === '周会（改）') !== undefined);
    assert.ok(listed.events.find((x) => x.summary === '周会' && x.source === 'local') === undefined);

    // 订阅事件的 uid 不是本地的：改/删都拿不到
    const wrong = editLocalEvent(t.cfg, NOW, 'sub-1', { summary: '篡改订阅' });
    assert.ok(!wrong.ok, '订阅事件改不了');
    const gone = deleteLocalEvent(t.cfg, NOW, 'sub-1');
    assert.ok(gone.ok && !gone.removed, '订阅事件删不了（removed=false，不是报错）');
    // 本地没有的 id
    const miss = editLocalEvent(t.cfg, NOW, 'dotd-local-none', { summary: 'x' });
    assert.ok(!miss.ok);
  } finally {
    t.cleanup();
  }
});

test('delete 后不可见；再删一次 removed=false', () => {
  const t = makeCal(false);
  try {
    const r = addLocalEvent(t.cfg, NOW, { summary: '看牙', start: '2026-10-23 10:00', durationMin: 30 });
    assert.ok(r.ok);
    if (!r.ok) return;
    const d = deleteLocalEvent(t.cfg, NOW, r.event.uid);
    assert.ok(d.ok && d.removed);
    const listed = listEvents(t.cfg, NOW, 7);
    assert.equal(listed.events.length, 0, '删完窗口里没有日程');
    const again = deleteLocalEvent(t.cfg, NOW, r.event.uid);
    assert.ok(again.ok && !again.removed, '再删是 removed=false');
  } finally {
    t.cleanup();
  }
});

test('conflicts 在合并后检查：本地×订阅的重叠查得出来', () => {
  const t = makeCal(true); // 订阅：14:00Z-15:00Z 产品评审
  try {
    const r = addLocalEvent(t.cfg, NOW, { summary: '临时对齐', start: '2026-10-21T22:30:00+08:00', durationMin: 30 });
    assert.ok(r.ok);
    if (!r.ok) return; // = 14:30Z-15:00Z，与产品评审重叠
    const c = listConflicts(t.cfg, NOW, 7);
    assert.equal(c.conflicts.length, 1, '查出一处冲突');
    const pair = c.conflicts[0]!;
    const sources = new Set([pair.a.source, pair.b.source]);
    assert.ok(sources.has('local') && sources.has('work'), '冲突双方来自两个来源');
  } finally {
    t.cleanup();
  }
});

test('全天事件：写 DATE 形态、不参与冲突配对', () => {
  const t = makeCal(false);
  try {
    const r = addLocalEvent(t.cfg, NOW, { summary: '出差', start: '2026-10-22' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.event.allDay, true);
    const file = readFileSync(t.cfg.dir + '/local.ics', 'utf8');
    assert.ok(file.includes('DTSTART;VALUE=DATE:'), '全天用 VALUE=DATE');
    assert.ok(!file.includes('DTSTART:2026'), '全天不写时刻形态');
    // 同一天的定时事件与全天事件"重叠"，但全天不进冲突
    const r2 = addLocalEvent(t.cfg, NOW, { summary: '站会', start: '2026-10-22 10:00', durationMin: 15 });
    assert.ok(r2.ok);
    const c = listConflicts(t.cfg, NOW, 7);
    assert.equal(c.conflicts.length, 0, '全天事件不计入冲突');
  } finally {
    t.cleanup();
  }
});

test('生成的 ICS：VEVENT、DTSTART 带 UTC Z、转义与折行往返自洽', () => {
  const t = makeCal(false);
  try {
    const longSummary = '这条标题特别长'.repeat(12); // 84 个汉字 = 252 字节，必然触发 75 字节折行
    const summary = '评审, 周会; ' + longSummary;
    const notes = '第一行\n第二行, 带逗号; 和分号';
    const r = addLocalEvent(t.cfg, NOW, {
      summary,
      start: '2026-10-21T22:00:00+08:00',
      durationMin: 60,
      notes,
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    const raw = readFileSync(t.cfg.dir + '/local.ics', 'utf8');
    assert.ok(raw.includes('BEGIN:VEVENT'), '含 VEVENT');
    assert.match(raw, /DTSTART:\d{8}T\d{6}Z/, 'DTSTART 是带时区（Z）的时刻形态');
    assert.ok(raw.includes('\r\n '), '长行按 RFC 5545 折行（CRLF + 空格续行）');
    // 往返：自家解析器读回来必须一字不差
    const back = parseIcs(raw);
    assert.equal(back.errors.length, 0, '自家文件自家读不出错：' + back.errors.join('; '));
    assert.equal(back.events.length, 1);
    assert.equal(back.events[0]!.summary, summary, '转义+折行往返无损');
    assert.equal(back.events[0]!.description, notes, '\\n 与 \\, \\; 往返无损');
    assert.equal(back.events[0]!.startMs, r.event.startMs, 'UTC 时刻往返不变');
  } finally {
    t.cleanup();
  }
});

test('非法输入一律 ok:false 且不写文件；订阅 .ics 在写路径上字节不变', () => {
  const t = makeCal(true);
  try {
    const subPath = t.dir + '/work.ics';
    const before = readFileSync(subPath);
    // 时间认不出
    const bad1 = addLocalEvent(t.cfg, NOW, { summary: 'x', start: '下周三下午' });
    assert.ok(!bad1.ok, '认不出的时间不猜');
    // durationMin 非法
    const bad2 = addLocalEvent(t.cfg, NOW, { summary: 'x', start: '2026-10-23 10:00', durationMin: 0 });
    assert.ok(!bad2.ok, 'durationMin 必须正整数');
    // 结束早于开始
    const bad3 = addLocalEvent(t.cfg, NOW, {
      summary: 'x',
      start: '2026-10-23T10:00:00+08:00',
      end: '2026-10-23T09:00:00+08:00',
    });
    assert.ok(!bad3.ok, '结束必须晚于开始');
    // summary 为空
    const bad4 = addLocalEvent(t.cfg, NOW, { summary: '  ', start: '2026-10-23 10:00' });
    assert.ok(!bad4.ok, 'summary 不能为空');
    // 一路失败下来：本地日历文件根本没被创建
    assert.equal(existsSync(t.dir + '/local.ics'), false, '失败路径不写文件');
    // 成功的 add/edit/delete 之后，订阅文件字节不变
    const r = addLocalEvent(t.cfg, NOW, { summary: '周会', start: '2026-10-23 10:00' });
    assert.ok(r.ok);
    const e = editLocalEvent(t.cfg, NOW, r.ok ? r.event.uid : '', { summary: '周会改' });
    assert.ok(e.ok);
    const d = deleteLocalEvent(t.cfg, NOW, r.ok ? r.event.uid : '');
    assert.ok(d.ok && d.removed);
    assert.ok(before.equals(readFileSync(subPath)), '订阅 .ics 字节不变（订阅只读的硬边界）');
  } finally {
    t.cleanup();
  }
});