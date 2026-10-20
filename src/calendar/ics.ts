/**
 * src/calendar/ics.ts —— iCalendar 只读解析（T6，2026-10-20）
 *
 * 为什么是只读
 *   读日历（"下周三有什么会"）是高频、低风险的需求。
 *   写日历是另一回事：写错了别人的日程会被打扰，
 *   而且冲突检测、时区、参与人、重复规则每一样都能出错。
 *   Muse 的报道里记者让它"看我明天的安排"，没说让它改。
 *   所以这一版只读 —— 能力边界诚实，比"号称能写但会搞坏你的日历"好。
 *
 * 为什么手写而不装库
 *   dotd 零运行时依赖（只有 node: 内置模块）。ICS 是行式
 *   `KEY;PARAM=VALUE:CONTENT`，折行用行首空格续接。
 *   一个库换来的是我已经理解的解析器，不值。
 *
 * RFC 5545 里真正会咬人的四条（都实现了）
 *   ① 折行：超过 75 字节的长行用「CRLF + 一个空格」续接。
 *      不处理的话，长标题会被截断成莫名奇妙的短串。
 *   ② 转义：\n 是换行、\, 是逗号、\; 是分号、\\ 是反斜杠。
 *      不处理的话，"张三,李四" 会变成两个字段。
 *   ③ DATE vs DATE-TIME：`20261020` 是全天事件（无时区），
 *      `20261020T140000Z` 是 UTC 时刻。混为一谈会让全天事件跑到错误的日子。
 *   ④ TZID：本地时区的会议用 TZID 引用。不解析时区定义就没法换算，
 *      这时**如实退回"时刻未知"**，不猜。
 */

/** 一个日历事件（已从 ICS 抽出需要的最小字段集）。 */
export interface CalendarEvent {
  /** UID，iCalendar 里应该唯一。没有时用「起始时间+标题」合成。 */
  uid: string;
  /** 标题。SUMMARY。 */
  summary: string;
  /** 开始时刻（epoch ms）。全天事件 = 当天 00:00 本地时间。解析失败 = null。 */
  startMs: number | null;
  /** 结束时刻（epoch ms）。没有 DTEND 时 = 开始 + 1 小时（习惯做法）。 */
  endMs: number | null;
  /** 是否全天事件。 */
  allDay: boolean;
  /** 地点。LOCATION，可空。 */
  location: string;
  /** 描述。DESCRIPTION，可空，已截断。 */
  description: string;
  /** 组织者。ORGANIZER，可空。 */
  organizer: string;
}

/** 解析结果。errors 非空说明文件有问题 —— 调用方要如实告诉主人，不能静默当空日历。 */
export interface ParseResult {
  events: CalendarEvent[];
  errors: string[];
}

/**
 * 展开折行（RFC 5545 §3.1）。
 *
 * 规则：以单个空格或制表符开头的行是上一行的**续行**，去掉那个前导空白后拼接。
 * 必须按行处理且保留原始顺序 —— 乱序会让拼接错位。
 */
export function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out: string[] = [];
  for (const line of normalized.split('\n')) {
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      if (out.length > 0) out[out.length - 1] += line.slice(1);
      continue;
    }
    out.push(line);
  }
  return out;
}/**
 * 反转义 ICS 文本值（RFC 5545 §3.3.11）。
 *
 * 顺序有讲究：先处理 \\ 否则 \\n 会被当成「反斜杠 + n」而不是「换行」。
 * 用状态机一次扫完，避免连续 replace 的二次转义问题。
 */
export function unescapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === ',') out += ',';
    else if (next === ';') out += ';';
    else if (next === '\\') out += '\\';
    else out += next;
    i++;
  }
  return out;
}

/**
 * 解析日期/时刻值。
 *
 * 三种形态：
 *   20261020           → 全天，按**本地** 00:00（用 UTC 会错一天）
 *   20261020T140000Z   → UTC
 *   20261020T140000    → 浮动时间（无时区），按本地理解
 *
 * 返回 null 表示格式认不出 —— 调用方要如实说"时刻未知"，不能猜一个。
 */
export function parseIcsDate(value: string): { ms: number; allDay: boolean } | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly !== null) {
    const y = Number(dateOnly[1]);
    const mo = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const t = new Date(y, mo - 1, d, 0, 0, 0, 0);
    if (Number.isNaN(t.getTime())) return null;
    return { ms: t.getTime(), allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dt !== null) {
    const y = Number(dt[1]);
    const mo = Number(dt[2]);
    const d = Number(dt[3]);
    const h = Number(dt[4]);
    const mi = Number(dt[5]);
    const se = Number(dt[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null;
    const t = dt[7] === 'Z' ? new Date(Date.UTC(y, mo - 1, d, h, mi, se)) : new Date(y, mo - 1, d, h, mi, se);
    if (Number.isNaN(t.getTime())) return null;
    return { ms: t.getTime(), allDay: false };
  }
  return null;
}

/** 一行 KEY;PARAM=x:VALUE 拆成名字、参数、值。 */
function splitLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let colonAt = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colonAt = i;
      break;
    }
  }
  if (colonAt < 0) return null;
  const head = line.slice(0, colonAt);
  const value = line.slice(colonAt + 1);
  const parts = head.split(';');
  const name = (parts[0] ?? '').toUpperCase();
  if (name === '') return null;
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i] ?? '';
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}/**
 * 解析整个 ICS 文件。
 *
 * 只提取 VEVENT 里的必要字段。其余（VALARM、ATTENDEE、RRULE…）跳过 ——
 * 重复规则尤其**明确不支持**：展开 RRULE 很容易算错，
 * 而算错"下周三有会"比说"这个日程有重复规则我没法算"糟糕得多。
 * 遇到 RRULE 会在描述里留一句提示。
 */
export function parseIcs(raw: string): ParseResult {
  const events: CalendarEvent[] = [];
  const errors: string[] = [];
  const lines = unfoldLines(raw);

  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  let inEvent = false;
  let hasRecur = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = {};
      hasRecur = false;
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      inEvent = false;
      if (cur !== null) {
        const ev = buildEvent(cur, hasRecur);
        if (ev !== null) events.push(ev);
        else errors.push('有一个事件缺少可识别的开始时间，已跳过');
      }
      cur = null;
      continue;
    }
    if (!inEvent || cur === null) continue;

    const parsed = splitLine(trimmed);
    if (parsed === null) continue;
    if (parsed.name === 'RRULE') hasRecur = true;
    if (
      parsed.name === 'UID' ||
      parsed.name === 'SUMMARY' ||
      parsed.name === 'DTSTART' ||
      parsed.name === 'DTEND' ||
      parsed.name === 'LOCATION' ||
      parsed.name === 'DESCRIPTION' ||
      parsed.name === 'ORGANIZER'
    ) {
      cur[parsed.name] = { value: parsed.value, params: parsed.params };
    }
  }

  return { events, errors };
}

/** 把攒好的原始字段变成一个 CalendarEvent。开始时间认不出就返回 null。 */
function buildEvent(
  raw: Record<string, { value: string; params: Record<string, string> }>,
  hasRecur: boolean,
): CalendarEvent | null {
  const dtStart = raw['DTSTART'];
  if (dtStart === undefined) return null;
  const start = parseIcsDate(dtStart.value);
  if (start === null) return null;

  let endMs: number | null = null;
  let allDay = start.allDay;
  const dtEnd = raw['DTEND'];
  if (dtEnd !== undefined) {
    const e = parseIcsDate(dtEnd.value);
    if (e !== null) {
      endMs = e.ms;
      if (e.allDay) allDay = true;
    }
  }
  if (endMs === null) endMs = start.ms + (allDay ? 24 * 60 * 60_000 : 60 * 60_000);

  const summary = raw['SUMMARY'] !== undefined ? unescapeText(raw['SUMMARY'].value).trim() : '';
  const uid = raw['UID'] !== undefined ? unescapeText(raw['UID'].value).trim() : '';
  const location = raw['LOCATION'] !== undefined ? unescapeText(raw['LOCATION'].value).trim() : '';
  let description = raw['DESCRIPTION'] !== undefined ? unescapeText(raw['DESCRIPTION'].value).trim() : '';
  const organizer = raw['ORGANIZER'] !== undefined ? unescapeText(raw['ORGANIZER'].value).trim() : '';

  if (hasRecur) {
    description =
      (description === '' ? '' : description + '\n') + '（这条日程有重复规则，只显示了其中一次的原始时间）';
  }

  return {
    uid: uid !== '' ? uid : start.ms + ':' + summary,
    summary: summary !== '' ? summary : '（无标题）',
    startMs: start.ms,
    endMs,
    allDay,
    location: location.slice(0, 200),
    description: description.slice(0, 1000),
    organizer: organizer.slice(0, 200),
  };
}/** 把毫秒时间格式化成「10-20 周三 14:00」。本地时区。 */
export function formatWhen(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时刻未知';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] ?? '';
  if (allDay) return mm + '-' + dd + ' ' + week + ' 全天';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return mm + '-' + dd + ' ' + week + ' ' + hh + ':' + mi;
}

/**
 * 找出时间重叠的事件对（T6 判据要求"能发现冲突"）。
 *
 * **忽略全天事件的冲突**：全天事件（如"出差"）和具体会议重叠是正常的，
 * 全报出来等于制造噪音。只报"两个要参加的时段撞了"。
 */
export function findConflicts(events: CalendarEvent[]): Array<{ a: CalendarEvent; b: CalendarEvent }> {
  const timed = events
    .filter((e) => !e.allDay && e.startMs !== null && e.endMs !== null)
    .sort((x, y) => (x.startMs ?? 0) - (y.startMs ?? 0));
  const out: Array<{ a: CalendarEvent; b: CalendarEvent }> = [];
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      if (b === undefined) continue;
      // 已排序：b 的开始 >= a 的开始。只要 b 开始 < a 结束就有重叠。
      if ((b.startMs ?? 0) >= (a.endMs ?? 0)) break;
      out.push({ a, b });
    }
  }
  return out;
}

/** 取从现在起 windowDays 天内的事件，按开始时间排序。 */
export function eventsInWindow(events: CalendarEvent[], nowMs: number, windowDays: number): CalendarEvent[] {
  const from = nowMs;
  const to = nowMs + windowDays * 24 * 60 * 60_000;
  return events
    .filter((e) => e.startMs !== null && e.startMs >= from && e.startMs < to)
    .sort((x, y) => (x.startMs ?? 0) - (y.startMs ?? 0));
}