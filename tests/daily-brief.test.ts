/**
 * tests/daily-brief.test.ts —— 每日简报的纯聚合与渲染
 *
 * 重点盯四件事：
 *   ① 段序与空段：主人扫一眼就要知道"第二段是等我点头的事"，顺序不能变；
 *      空段必须整段消失，不能写"无"（每天写"今天没有待批"等于噪音）。
 *   ② 读失败 ≠ 没有：日历报错、邮件检查失败必须出现在正文里，
 *      否则主人会把"我不知道"读成"今天没事"。
 *   ③ 字符上限是硬约束：超了从最后一段开始裁，前面的段一个字都不许动。
 *   ④ 跨午夜：23:50 的计划在次日 00:05 属于"新的一天、还没到点" ——
 *      不能因为跨了就沉默一整天，也不能把昨晚的补发出来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BRIEF_MAX_CHARS,
  briefDayKey,
  buildDailyBrief,
  renderBriefText,
  shouldSendBrief,
  type BriefInput,
  type BriefSection,
  type BriefSectionId,
  type DailyBrief,
} from '../src/surfaces/daily-brief.ts';

/** 造一个本地时间的 epoch ms，避免测试依赖跑在哪个时区。 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/** 空输入骨架。每个用例只覆盖自己要验的那几段，其余保持空。 */
const makeInput = (over: Partial<BriefInput> = {}): BriefInput => ({
  nowMs: at(2026, 10, 24, 9, 0),
  calendar: { events: [], errors: [] },
  approvals: [],
  tasks: { done: 0, failed: 0, running: 0, queued: 0, failedTitles: [] },
  ...over,
});

/** 取某一段；不存在就直接失败，省得每个用例都写一遍 find + 断言。 */
function section(b: DailyBrief, id: BriefSectionId): BriefSection {
  const s = b.sections.find((x) => x.id === id);
  if (s === undefined) throw new Error('缺少段 ' + id + '，实际文本：\n' + b.text);
  return s;
}

// ── 1. 全空与段序 ──────────────────────────────────────────────
test('全空：只说一句话，五段全进 omittedSections', () => {
  const b = buildDailyBrief(makeInput());
  assert.equal(b.text, '今天没有需要你关注的事。');
  assert.equal(b.sections.length, 0);
  assert.deepEqual(b.omittedSections, ['calendar', 'approvals', 'tasks', 'crontabs', 'mail']);
  assert.equal(renderBriefText(b), b.text);
  assert.equal(BRIEF_MAX_CHARS, 1200);
});

test('段序固定：日程在最前、邮件在最后，空段不出现也不写「无」', () => {
  const b = buildDailyBrief(
    makeInput({
      calendar: { events: [{ startMs: at(2026, 10, 24, 9, 30), allDay: false, summary: '晨会' }], errors: [] },
      mail: { unread: 2 },
    }),
  );
  assert.deepEqual(
    b.sections.map((s) => s.id),
    ['calendar', 'mail'],
    '只该有日程和邮件两段',
  );
  assert.deepEqual(b.omittedSections, ['approvals', 'tasks', 'crontabs']);
  const calAt = b.text.indexOf('晨会');
  const mailAt = b.text.indexOf('未读 2 封');
  assert.ok(calAt >= 0, '日程要出现');
  assert.ok(mailAt > calAt, '邮件必须在日程之后');
  assert.ok(!b.text.includes('无'), '空段不该写「无」：' + b.text);
});

// ── 2. 日程 ────────────────────────────────────────────────────
test('日程：全天 / 本地 HH:MM / 时刻未知 三种形态，地点跟标题', () => {
  const b = buildDailyBrief(
    makeInput({
      calendar: {
        events: [
          { startMs: at(2026, 10, 24, 9, 5), allDay: false, summary: '晨会', location: '三楼' },
          { startMs: at(2026, 10, 24, 0, 0), allDay: true, summary: '出差' },
          { startMs: null, allDay: false, summary: '待定的事' },
        ],
        errors: [],
      },
    }),
  );
  const lines = section(b, 'calendar').lines;
  assert.equal(lines[0], '· 09:05  晨会（三楼）');
  assert.ok(lines.includes('· 全天  出差'), '全天事件即使带了时间也只说全天');
  assert.ok(lines.includes('· 时刻未知  待定的事'), '读不出时刻要说不知道，不能编');
  assert.equal(section(b, 'calendar').title, '今日日程');
});

test('日程超过 8 条：只列 8 条 + 一行「…还有 N 个日程」', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    startMs: at(2026, 10, 24, 8, 0) + i * 60_000,
    allDay: false,
    summary: '会' + (i + 1),
  }));
  const lines = section(buildDailyBrief(makeInput({ calendar: { events, errors: [] } })), 'calendar').lines;
  assert.equal(lines.filter((l) => l.startsWith('· ')).length, 8);
  assert.ok(lines.includes('…还有 2 个日程'));
});

test('日历读失败要如实说，不能当成「今天没有日程」', () => {
  const b = buildDailyBrief(makeInput({ calendar: { events: [], errors: ['a.ics 解析失败'] } }));
  assert.ok(!b.omittedSections.includes('calendar'), '有错误就不能把这段省略掉');
  assert.ok(b.text.includes('日历有 1 个问题：a.ics 解析失败'), b.text);
  assert.notEqual(b.text, '今天没有需要你关注的事。');
});

test('日历错误只列前 3 条但条数报总数', () => {
  const errors = ['e1', 'e2', 'e3', 'e4', 'e5'];
  const lines = section(buildDailyBrief(makeInput({ calendar: { events: [], errors } })), 'calendar').lines;
  const errLine = lines.find((l) => l.startsWith('日历有 '));
  assert.ok(errLine !== undefined, '要有错误行');
  assert.ok(errLine.includes('日历有 5 个问题：e1；e2；e3'), errLine);
  assert.ok(errLine.includes('只列了前 3 条'), errLine);
});
// ── 3. 待批 ────────────────────────────────────────────────────
test('审批：行内带 #seq 与 summary，卡在执行中要单独说一句', () => {
  const b = buildDailyBrief(
    makeInput({
      approvals: [
        { seq: 12, summary: '报销 380 元', tier: 'auto', createdAt: '2026-10-24T01:00:00Z' },
        { seq: 13, summary: '给客户回邮件', tier: 'confirm', createdAt: '2026-10-24T02:00:00Z' },
      ],
      executingApprovals: 3,
    }),
  );
  const lines = section(b, 'approvals').lines;
  assert.equal(lines[0], '· #12 报销 380 元（auto）');
  assert.equal(lines[1], '· #13 给客户回邮件（confirm）');
  assert.ok(
    lines.includes('另有 3 条审批卡在执行中（可能卡住，需要收口）'),
    '卡在 executing 是缺陷，必须如实说：' + lines.join(' | '),
  );
  assert.equal(section(b, 'approvals').title, '等你批的事');
});

test('只有卡住的审批也要成段（不算空段）', () => {
  const b = buildDailyBrief(makeInput({ approvals: [], executingApprovals: 1 }));
  assert.ok(!b.omittedSections.includes('approvals'));
  assert.ok(section(b, 'approvals').lines.some((l) => l.includes('另有 1 条')));
  assert.equal(buildDailyBrief(makeInput({ executingApprovals: 0 })).text, '今天没有需要你关注的事。');
});

test('审批最多列 5 条，多出的用一行带过（不能让人以为批完就完事）', () => {
  const approvals = Array.from({ length: 7 }, (_, i) => ({
    seq: i + 1,
    summary: '事' + (i + 1),
    tier: 'auto',
    createdAt: '2026-10-24T00:00:00Z',
  }));
  const lines = section(buildDailyBrief(makeInput({ approvals })), 'approvals').lines;
  assert.equal(lines.filter((l) => l.startsWith('· #')).length, 5);
  assert.ok(lines.includes('…还有 2 条等你批'));
});

// ── 4. 近 24 小时结果 ──────────────────────────────────────────
test('任务：一行汇总 + 最多 3 条失败标题', () => {
  const b = buildDailyBrief(
    makeInput({
      tasks: {
        done: 3,
        failed: 2,
        running: 1,
        queued: 4,
        failedTitles: ['备份失败', '抓取超时', '发邮件失败', '第四条不该出现'],
      },
    }),
  );
  const lines = section(b, 'tasks').lines;
  assert.equal(lines[0], '· 完成 3 / 失败 2 / 在跑 1 / 排队 4');
  assert.deepEqual(
    lines.filter((l) => l.startsWith('· 失败：')),
    ['· 失败：备份失败', '· 失败：抓取超时', '· 失败：发邮件失败'],
  );
  assert.equal(section(b, 'tasks').title, '近 24 小时结果');
});

test('任务：失败但没标题时只留汇总行', () => {
  const lines = section(
    buildDailyBrief(makeInput({ tasks: { done: 0, failed: 2, running: 0, queued: 0, failedTitles: [] } })),
    'tasks',
  ).lines;
  assert.equal(lines.length, 1, '没有标题就只有汇总');
  assert.equal(lines[0], '· 完成 0 / 失败 2 / 在跑 0 / 排队 0');
});

test('任务全 0 视为空段（不写「完成 0 / 失败 0」这种噪音）', () => {
  const b = buildDailyBrief(makeInput());
  assert.ok(b.omittedSections.includes('tasks'));
  assert.ok(!b.text.includes('完成 0'));
});

// ── 5. 今天还会跑 ──────────────────────────────────────────────
test('定时任务：本地 HH:MM，时间未知照实写', () => {
  const lines = section(
    buildDailyBrief(
      makeInput({
        crontabs: [
          { name: '早间简报', nextFireAt: at(2026, 10, 24, 7, 45) },
          { name: '夜间备份', nextFireAt: null },
        ],
      }),
    ),
    'crontabs',
  ).lines;
  assert.deepEqual(lines, ['· 07:45  早间简报', '· 时间未知  夜间备份']);
});

test('定时任务最多 5 条，多出的说「…还有 N 个定时任务」', () => {
  const crontabs = Array.from({ length: 6 }, (_, i) => ({
    name: '任务' + (i + 1),
    nextFireAt: at(2026, 10, 24, 10, 0) + i * 60_000,
  }));
  const lines = section(buildDailyBrief(makeInput({ crontabs })), 'crontabs').lines;
  assert.equal(lines.filter((l) => l.startsWith('· ')).length, 5);
  assert.ok(lines.includes('…还有 1 个定时任务'));
});

// ── 6. 邮件 ────────────────────────────────────────────────────
test('邮件：未读未知 / 检查失败 / 未读 N 封 三种状态分清', () => {
  assert.deepEqual(section(buildDailyBrief(makeInput({ mail: { unread: null } })), 'mail').lines, ['· 未读未知']);

  const failed = section(
    buildDailyBrief(makeInput({ mail: { unread: null, error: 'IMAP 超时' } })),
    'mail',
  ).lines;
  assert.deepEqual(failed, ['· 邮件检查失败：IMAP 超时'], '查不到就是查不到，别混成「未读未知」');

  assert.deepEqual(section(buildDailyBrief(makeInput({ mail: { unread: 3 } })), 'mail').lines, ['· 未读 3 封']);
});

test('邮件 0 封且没报错视为空段', () => {
  const b = buildDailyBrief(makeInput({ mail: { unread: 0 } }));
  assert.ok(b.omittedSections.includes('mail'));
  assert.equal(b.text, '今天没有需要你关注的事。');
});
// ── 7. 字符上限（硬约束）──────────────────────────────────────
/** 只留"日程 + 结果"两段：这样裁剪必然落在第二段，能看清前面的段有没有被动过。 */
const twoSectionInput = (): BriefInput =>
  makeInput({
    calendar: {
      events: [
        { startMs: at(2026, 10, 24, 9, 30), allDay: false, summary: '晨会' },
        { startMs: at(2026, 10, 24, 14, 0), allDay: false, summary: '评审' },
      ],
      errors: [],
    },
    tasks: { done: 1, failed: 3, running: 0, queued: 2, failedTitles: ['备份失败', '抓取超时', '发邮件失败'] },
  });

test('不超上限就一个字不动；恰好等于上限也不加省略标记', () => {
  const full = buildDailyBrief(twoSectionInput());
  const same = buildDailyBrief(twoSectionInput(), full.text.length);
  assert.equal(same.text, full.text);
  assert.ok(!same.text.includes('被省略'), '没超就不该有标记：' + same.text);
});

test('超上限从最后一段裁：该段换成「…（还有 N 字被省略）」，前面的段完整保留', () => {
  const full = buildDailyBrief(twoSectionInput());
  const cap = full.text.length - 15;
  const cut = buildDailyBrief(twoSectionInput(), cap);
  assert.ok(cut.text.length <= cap, `cap=${cap} 实际 ${cut.text.length}`);
  assert.ok(cut.text.includes('…（还有 '), '裁过就要如实说省了多少字：' + cut.text);
  assert.ok(cut.text.includes('字被省略）'), cut.text);
  assert.ok(cut.text.startsWith('今日日程\n· 09:30  晨会\n· 14:00  评审\n近 24 小时结果'), '前一段必须完整：' + cut.text);
  assert.ok(cut.sections.some((s) => s.id === 'calendar'), '日程段还在');
  assert.equal(section(cut, 'calendar').lines.length, 2);
});

test('上限夹逼到极小也不许超（哪怕只剩首行）', () => {
  const input = makeInput({
    calendar: { events: [{ startMs: at(2026, 10, 24, 9, 30), allDay: false, summary: '晨会' }], errors: [] },
    tasks: { done: 1, failed: 3, running: 0, queued: 2, failedTitles: ['备份失败'] },
    crontabs: [{ name: '早间简报', nextFireAt: at(2026, 10, 24, 7, 45) }],
    mail: { unread: 4 },
  });
  for (const cap of [120, 60, 40, 20, 10, 5, 1]) {
    const b = buildDailyBrief(input, cap);
    assert.ok(b.text.length <= cap, `cap=${cap} 实际 ${b.text.length}：${b.text}`);
  }
  // 上限 0 只能给空串；但绝不能谎报成"今天没事"
  const zero = buildDailyBrief(input, 0);
  assert.equal(zero.text, '');
  assert.equal(zero.sections.length, 0);
  assert.notEqual(zero.text, '今天没有需要你关注的事。');
  assert.equal(buildDailyBrief(makeInput(), 0).text, '');
});

test('被上限裁掉的段要进 omittedSections（省略清单必须和正文一致）', () => {
  const input = makeInput({
    calendar: { events: [{ startMs: at(2026, 10, 24, 9, 30), allDay: false, summary: '晨会' }], errors: [] },
    mail: { unread: null, error: 'IMAP 连接超时，已重试 3 次' },
  });
  // 日程段 16 字；邮件段整段 30 字。上限 25 意味着邮件段连省略标记都放不下 ——
  // 那就整段拿掉，但必须记进 omittedSections，否则"正文没这段、账单也没这段"就对不上了。
  const cut = buildDailyBrief(input, 25);
  assert.ok(cut.text.length <= 25, cut.text);
  assert.equal(cut.text, '今日日程\n· 09:30  晨会');
  assert.ok(cut.omittedSections.includes('mail'), JSON.stringify(cut.omittedSections));
  assert.deepEqual(cut.sections.map((s) => s.id), ['calendar']);
});

// ── 8. 本地日界 ────────────────────────────────────────────────
test('briefDayKey 用本地时区并补零两位', () => {
  assert.equal(briefDayKey(at(2026, 1, 5, 0, 0)), '2026-01-05');
  assert.equal(briefDayKey(at(2026, 12, 31, 23, 59)), '2026-12-31');
  assert.equal(briefDayKey(at(2026, 10, 24, 9, 0)), '2026-10-24');
  assert.notEqual(briefDayKey(at(2026, 10, 24, 23, 59)), briefDayKey(at(2026, 10, 25, 0, 1)), '跨午夜是两天');
});

// ── 9. 发不发（shouldSendBrief）────────────────────────────────
test('闸门：关掉就是不发，闭眼先判它', () => {
  const r = shouldSendBrief({ enabled: false, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 8, 30) });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'disabled');
});

test('闸门：坏 time 格式一律 bad_time（不能当成"还没到点"）', () => {
  for (const bad of ['8', '0800', '08:60', '24:00', '-1:00', '8点', '08:5', ' 08:00:00 ', '']) {
    const r = shouldSendBrief({ enabled: true, time: bad, lastSentDay: null, nowMs: at(2026, 10, 24, 9, 0) });
    assert.equal(r.reason, 'bad_time', 'time=' + JSON.stringify(bad));
    assert.equal(r.send, false);
  }
});

test('闸门：当天发过就不再发，隔天恢复', () => {
  const same = shouldSendBrief({
    enabled: true,
    time: '08:00',
    lastSentDay: briefDayKey(at(2026, 10, 24, 8, 5)),
    nowMs: at(2026, 10, 24, 9, 0),
  });
  assert.equal(same.send, false);
  assert.equal(same.reason, 'already_sent');

  const nextDay = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: '2026-10-23', nowMs: at(2026, 10, 24, 9, 0) });
  assert.equal(nextDay.send, true);
  assert.equal(nextDay.reason, 'ok');
});

test('闸门：没到点不发，窗口内发，超窗口不发（中午重启不补发早间简报）', () => {
  const before = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 7, 59) });
  assert.equal(before.reason, 'not_yet');
  assert.equal(before.send, false);

  const exact = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 8, 0) });
  assert.equal(exact.reason, 'ok');
  assert.equal(exact.send, true);

  const inWindow = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 9, 30) });
  assert.equal(inWindow.reason, 'ok');

  // 恰好到默认窗口边界（180 分钟）仍然发：宁可迟一条，也不要因为差一分钟整天沉默
  const edge = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 11, 0) });
  assert.equal(edge.reason, 'ok');
  assert.equal(edge.send, true);

  const late = shouldSendBrief({ enabled: true, time: '08:00', lastSentDay: null, nowMs: at(2026, 10, 24, 11, 1) });
  assert.equal(late.reason, 'too_late');
  assert.equal(late.send, false);
});

test('闸门：windowMin 可配（0 表示只认准点那一分钟）', () => {
  const tight = shouldSendBrief({
    enabled: true,
    time: '08:00',
    lastSentDay: null,
    nowMs: at(2026, 10, 24, 8, 30),
    windowMin: 30,
  });
  assert.equal(tight.reason, 'ok');

  const tooTight = shouldSendBrief({
    enabled: true,
    time: '08:00',
    lastSentDay: null,
    nowMs: at(2026, 10, 24, 8, 31),
    windowMin: 30,
  });
  assert.equal(tooTight.reason, 'too_late');

  const zeroWin = shouldSendBrief({
    enabled: true,
    time: '08:00',
    lastSentDay: null,
    nowMs: at(2026, 10, 24, 8, 1),
    windowMin: 0,
  });
  assert.equal(zeroWin.reason, 'too_late');
});

test('闸门：跨午夜 —— 23:50 的计划在次日 00:05 属于「还没到点」，不是沉默也不是补发', () => {
  const afterMidnight = shouldSendBrief({
    enabled: true,
    time: '23:50',
    lastSentDay: '2026-10-23',
    nowMs: at(2026, 10, 24, 0, 5),
  });
  assert.equal(afterMidnight.send, false);
  assert.equal(afterMidnight.reason, 'not_yet');

  const midnightBefore = shouldSendBrief({
    enabled: true,
    time: '00:10',
    lastSentDay: '2026-10-23',
    nowMs: at(2026, 10, 24, 0, 5),
  });
  assert.equal(midnightBefore.reason, 'not_yet');

  const justFired = shouldSendBrief({
    enabled: true,
    time: '23:50',
    lastSentDay: '2026-10-23',
    nowMs: at(2026, 10, 24, 23, 52),
  });
  assert.equal(justFired.send, true);
  assert.equal(justFired.reason, 'ok');

  // 当晚发过之后，同一夜里再问就是 already_sent（本地日界是 10-24）
  const again = shouldSendBrief({
    enabled: true,
    time: '23:50',
    lastSentDay: '2026-10-24',
    nowMs: at(2026, 10, 24, 23, 55),
  });
  assert.equal(again.reason, 'already_sent');
});

test('一位小时的配置也能用（8:05）', () => {
  const r = shouldSendBrief({ enabled: true, time: '8:05', lastSentDay: null, nowMs: at(2026, 10, 24, 8, 10) });
  assert.equal(r.reason, 'ok');
  assert.equal(r.send, true);
});