/**
 * tests/calendar-ics.test.ts —— T6 日历只读的硬判据（2026-10-20）
 *
 * 重点盯 RFC 5545 里真会咬人的四条：
 *   ① 折行（长标题被 75 字节断开后续接）
 *   ② 转义（\, \; \n \\）
 *   ③ DATE vs DATE-TIME（全天事件不能跑到错误的日子）
 *   ④ 认不出的时间要如实说"未知"，不能猜
 *
 * 还有一条业务判据：**能发现冲突**，而且不把全天事件算成冲突。
 */
import {
  parseIcs,
  unfoldLines,
  unescapeText,
  parseIcsDate,
  formatWhen,
  findConflicts,
  eventsInWindow,
} from '../src/calendar/ics.ts';

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

/** 拼一份最小合法 ICS。 */
const ics = (body: string): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');

// ── 1. 折行 ────────────────────────────────────────────────────
{
  const lines = unfoldLines('SUMMARY:hello\r\n  world\r\nDTSTART:20261020T140000Z');
  ok('折行被接上', lines[0] === 'SUMMARY:hello world', JSON.stringify(lines[0]));
  ok('非折行不受影响', lines[1] === 'DTSTART:20261020T140000Z');
  ok('制表符折行也认', unfoldLines('A:x\n\ty')[0] === 'A:xy');
  ok('孤立续行被丢弃', unfoldLines('  orphan\nB:2')[0] === 'B:2');
  ok('CRLF 统一', unfoldLines('A:1\r\nB:2').length === 2);
}

// ── 2. 转义 ────────────────────────────────────────────────────
{
  ok('\\n → 换行', unescapeText('a\\nb') === 'a\nb');
  ok('\\, → 逗号', unescapeText('张三\\,李四') === '张三,李四');
  ok('\\; → 分号', unescapeText('a\\;b') === 'a;b');
  ok('\\\\ → 反斜杠', unescapeText('a\\\\b') === 'a\\b');
  ok('无转义原样', unescapeText('普通文本') === '普通文本');
  ok('尾部孤立反斜杠保留', unescapeText('a\\') === 'a\\');
  // 关键：不能二次转义
  ok('\\\\n 不是换行', unescapeText('a\\\\nb') === 'a\\nb', JSON.stringify(unescapeText('a\\\\nb')));
}

// ── 3. 日期解析 ────────────────────────────────────────────────
{
  const d = parseIcsDate('20261020');
  ok('纯日期 = 全天', d?.allDay === true);
  ok('纯日期是本地 00:00', d !== null && new Date(d.ms).getHours() === 0);
  ok('纯日期日子对', d !== null && new Date(d.ms).getDate() === 20);

  const u = parseIcsDate('20261020T140000Z');
  ok('UTC 时刻不是全天', u?.allDay === false);
  ok('UTC 时刻换算对', u !== null && new Date(u.ms).getUTCHours() === 14);

  const f = parseIcsDate('20261020T140000');
  ok('浮动时间按本地', f !== null && new Date(f.ms).getHours() === 14);

  ok('乱写返回 null', parseIcsDate('2026-10-20') === null);
  ok('月份超界返回 null', parseIcsDate('20261320') === null);
  ok('小时超界返回 null', parseIcsDate('20261020T250000') === null);
  ok('空串返回 null', parseIcsDate('') === null);
}
// ── 4. 完整解析 ────────────────────────────────────────────────
{
  const raw = ics(
    [
      'BEGIN:VEVENT',
      'UID:evt-1@example.com',
      'SUMMARY:产品评审',
      'DTSTART:20261020T140000Z',
      'DTEND:20261020T150000Z',
      'LOCATION:会议室 A',
      'DESCRIPTION:讨论 Q4 计划\\n请提前看材料',
      'ORGANIZER:mailto:boss@example.com',
      'END:VEVENT',
    ].join('\r\n'),
  );
  const r = parseIcs(raw);
  ok('解析出 1 个事件', r.events.length === 1, String(r.events.length));
  ok('无错误', r.errors.length === 0);
  const e = r.events[0];
  ok('标题对', e?.summary === '产品评审');
  ok('UID 对', e?.uid === 'evt-1@example.com');
  ok('地点对', e?.location === '会议室 A');
  ok('描述换行被还原', e?.description === '讨论 Q4 计划\n请提前看材料', JSON.stringify(e?.description));
  ok('组织者对', e?.organizer === 'mailto:boss@example.com');
  ok('不是全天', e?.allDay === false);
  ok('有时长 1 小时', e !== undefined && e.endMs !== null && e.startMs !== null && e.endMs - e.startMs === 3_600_000);
}

// ── 5. 全天事件 ────────────────────────────────────────────────
{
  const raw = ics(
    ['BEGIN:VEVENT', 'UID:allday', 'SUMMARY:出差', 'DTSTART;VALUE=DATE:20261021', 'DTEND;VALUE=DATE:20261022', 'END:VEVENT'].join('\r\n'),
  );
  const e = parseIcs(raw).events[0];
  ok('全天被识别', e?.allDay === true);
  ok('全天跨整天', e !== undefined && e.endMs !== null && e.startMs !== null && e.endMs - e.startMs === 86_400_000);
  ok('全天在正确的那天', e !== undefined && e.startMs !== null && new Date(e.startMs).getDate() === 21);
}

// ── 6. 缺字段不编 ──────────────────────────────────────────────
{
  const raw = ics(['BEGIN:VEVENT', 'DTSTART:20261020T140000Z', 'END:VEVENT'].join('\r\n'));
  const e = parseIcs(raw).events[0];
  ok('无标题说"无标题"', e?.summary === '（无标题）');
  ok('无 UID 自己合成', e !== undefined && e.uid.includes(':'));
  ok('无 DTEND 默认 1 小时', e !== undefined && e.endMs !== null && e.startMs !== null && e.endMs - e.startMs === 3_600_000);
  ok('无地点是空串', e?.location === '');

  // 缺 DTSTART 必须跳过并报错，不能编一个时间
  const bad = ics(['BEGIN:VEVENT', 'SUMMARY:没有开始时间', 'END:VEVENT'].join('\r\n'));
  const rb = parseIcs(bad);
  ok('缺开始时间被跳过', rb.events.length === 0);
  ok('缺开始时间有报错', rb.errors.length === 1, rb.errors[0] ?? '');
}

// ── 7. 重复规则明确不支持 ─────────────────────────────────────
{
  const raw = ics(
    [
      'BEGIN:VEVENT',
      'UID:recur',
      'SUMMARY:每周站会',
      'DTSTART:20261020T100000Z',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
    ].join('\r\n'),
  );
  const e = parseIcs(raw).events[0];
  ok('有 RRULE 时在描述里说明', e?.description.includes('重复规则') === true, e?.description ?? '');
}

// ── 8. 多事件 + 时间窗 ────────────────────────────────────────
{
  const raw = ics(
    [
      'BEGIN:VEVENT', 'UID:a', 'SUMMARY:今天', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'SUMMARY:三天后', 'DTSTART:20261023T100000Z', 'DTEND:20261023T110000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:c', 'SUMMARY:一个月后', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'END:VEVENT',
    ].join('\r\n'),
  );
  const r = parseIcs(raw);
  ok('解析出 3 个事件', r.events.length === 3);

  const base = Date.UTC(2026, 9, 20, 0, 0, 0);
  const wk = eventsInWindow(r.events, base, 7);
  ok('7 天窗内 2 个', wk.length === 2, String(wk.length));
  ok('按时间排序', wk[0]?.uid === 'a' && wk[1]?.uid === 'b');
}

// ── 9. 冲突检测 ────────────────────────────────────────────────
{
  const mk = (uid: string, s: string, e: string) =>
    ['BEGIN:VEVENT', 'UID:' + uid, 'SUMMARY:' + uid, 'DTSTART:' + s, 'DTEND:' + e, 'END:VEVENT'].join('\r\n');

  // 重叠：10:00-11:00 和 10:30-11:30
  const overlap = ics(mk('a', '20261020T100000Z', '20261020T110000Z') + '\r\n' + mk('b', '20261020T103000Z', '20261020T113000Z'));
  const c1 = findConflicts(parseIcs(overlap).events);
  ok('重叠被检出', c1.length === 1, String(c1.length));
  ok('检出的是这两个', c1[0]?.a.uid === 'a' && c1[0]?.b.uid === 'b');

  // 不重叠：10:00-11:00 和 11:00-12:00（首尾相接不算冲突）
  const adj = ics(mk('a', '20261020T100000Z', '20261020T110000Z') + '\r\n' + mk('b', '20261020T110000Z', '20261020T120000Z'));
  ok('首尾相接不算冲突', findConflicts(parseIcs(adj).events).length === 0);

  // 全天 + 会议不算冲突（这是判据要求的降噪）
  const allDayAndMeeting = ics(
    ['BEGIN:VEVENT', 'UID:ad', 'SUMMARY:出差', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261021', 'END:VEVENT'].join('\r\n') +
      '\r\n' +
      mk('m', '20261020T100000Z', '20261020T110000Z'),
  );
  ok('全天与会议不算冲突', findConflicts(parseIcs(allDayAndMeeting).events).length === 0);

  // 三个互相重叠 → 3 对
  const three = ics(
    mk('a', '20261020T100000Z', '20261020T120000Z') + '\r\n' +
    mk('b', '20261020T103000Z', '20261020T113000Z') + '\r\n' +
    mk('c', '20261020T110000Z', '20261020T123000Z'),
  );
  ok('三个互相重叠 → 3 对', findConflicts(parseIcs(three).events).length === 3);
}

// ── 10. formatWhen ────────────────────────────────────────────
{
  const t = new Date(2026, 9, 20, 14, 30).getTime();
  const f = formatWhen(t, false);
  ok('格式化含日期时间', f.includes('10-20') && f.includes('14:30'), f);
  ok('格式化含星期', f.includes('周二') || f.includes('周'), f);
  ok('全天说"全天"', formatWhen(t, true).includes('全天'));
  ok('无效时间说"未知"', formatWhen(Number.NaN, false) === '时刻未知');
}

// ── 11. 坏文件不静默 ─────────────────────────────────────────
{
  const r = parseIcs('完全不是 ICS');
  ok('垃圾输入返回空事件', r.events.length === 0);
  ok('垃圾输入不崩', Array.isArray(r.errors));

  const r2 = parseIcs('');
  ok('空输入返回空', r2.events.length === 0);
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);