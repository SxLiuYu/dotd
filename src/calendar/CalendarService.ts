/**
 * src/calendar/CalendarService.ts —— 日历工具的实现
 * （T6 只读订阅，2026-10-20；T7 本地日历写回，2026-10-21）
 *
 * 数据从哪来（两个来源，边界不同）：
 *   ① 订阅 .ics —— 主人把文件放在 `<dataDir>/calendar/` 下（任何日历客户端都能导出）。
 *      **永远只读**：它们是别人系统的投影，写坏等于替别人改日程。
 *   ② 本地日历 `<dir>/local.ics` —— **我们自己的文件**，add/edit/delete 只动它。
 *      幂等可重建：删掉文件重新 add 就回来（几 KB 文本，毫秒级）。
 *   不直接连 Google/Outlook —— 那需要 OAuth、审核、token 过期，而
 *   "读/写一个 .ics 文件"已经能回答"下周有什么会、帮我记个会"。
 *   先做能确定做对的。
 *
 * 为什么不缓存
 *   .ics 文件通常只有几 KB，读一次几毫秒。缓存反而引入"文件改了但显示旧的"
 *   这种让人困惑的问题。每次读最新的，简单且不会错。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  eventsInWindow,
  findConflicts,
  formatWhen,
  parseIcs,
  serializeIcs,
  type CalendarEvent,
  type IcsEventDraft,
} from './ics.ts';

/** 一个日历源（一个 .ics 文件）。 */
export interface CalendarSource {
  /** 显示名（文件名去掉扩展名）。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 文件里的事件数。 */
  eventCount: number;
  /** 文件本身有问题时的错误（不是"没事件"，是"文件坏了"）。 */
  errors: string[];
}

export interface ListResult {
  /** 窗口内的事件，按开始时间排序。 */
  events: Array<CalendarEvent & { source: string }>;
  /** 扫到了哪些文件。 */
  sources: CalendarSource[];
  /** 窗口天数。 */
  windowDays: number;
  /** 汇总错误（文件读不了、解析失败）。调用方要如实转告，不能当"没有日程"。 */
  errors: string[];
}

export interface CalendarConfig {
  /** 放订阅 .ics 的目录（只读）。 */
  dir: string;
  /**
   * 本地日历文件（可写）的路径，缺省 = `<dir>/local.ics`。
   * 与订阅放同一个目录是刻意的：主人备份/迁移时只看一个地方。
   */
  localPath?: string;
}

/** 本地日历文件路径（缺省 <dir>/local.ics）。 */
function localPathOf(cfg: CalendarConfig): string {
  return cfg.localPath !== undefined && cfg.localPath !== '' ? cfg.localPath : join(cfg.dir, 'local.ics');
}

/**
 * 列窗口内的日程（订阅 + 本地两个来源合并）。
 *
 * 一律返回**结构化结果 + 错误数组**，不抛异常：
 * 日历读失败不该让任务崩掉 —— 主人问"下周有什么会"，
 * 答案应该是"文件 X 读不了，其余 3 个日程如下"，不是整个任务失败。
 */
export function listEvents(
  cfg: CalendarConfig,
  nowMs: number,
  windowDays: number,
  sourceFilter?: string,
): ListResult {
  const errors: string[] = [];
  const sources: CalendarSource[] = [];
  const all: Array<CalendarEvent & { source: string }> = [];
  const localPath = localPathOf(cfg);

  let files: string[];
  try {
    files = readdirSync(cfg.dir).filter((f) => f.toLowerCase().endsWith('.ics'));
  } catch (cause) {
    // 目录不存在是**正常情况**（还没配日历），报出来让主人知道怎么配。
    return {
      events: [],
      sources: [],
      windowDays,
      errors: ['日历目录不存在或读不了：' + cfg.dir + '（' + String(cause) + '）'],
    };
  }

  for (const f of files) {
    const path = join(cfg.dir, f);
    // 本地日历文件不按订阅源扫 —— 它由下面的本地分支负责，source 恒为 'local'。
    if (resolve(path) === resolve(localPath)) continue;
    const name = basename(f, f.slice(f.lastIndexOf('.')));
    if (sourceFilter !== undefined && sourceFilter !== '' && name !== sourceFilter) continue;
    try {
      const st = statSync(path);
      // 明显太大的文件跳过：正常 .ics 不会超过几 MB，超了多半是选错文件
      if (st.size > 8 * 1024 * 1024) {
        errors.push(name + '：文件过大（' + Math.round(st.size / 1024) + ' KB），已跳过');
        continue;
      }
      const raw = readFileSync(path, 'utf8');
      const r = parseIcs(raw);
      sources.push({ name, path, eventCount: r.events.length, errors: r.errors });
      for (const e of r.events) all.push({ ...e, source: name });
      for (const err of r.errors) errors.push(name + '：' + err);
    } catch (cause) {
      errors.push(name + '：读文件失败（' + String(cause) + '）');
    }
  }

  // 本地日历（可写的那份）合并进来，source 恒为 'local'（T7，2026-10-21）。
  const wantLocal = sourceFilter === undefined || sourceFilter === '' || sourceFilter === 'local';
  if (wantLocal) {
    const localErrors: string[] = [];
    const localEvents = readLocalEvents(cfg, localErrors);
    for (const e of localErrors) errors.push(e);
    if (localEvents.length > 0) {
      sources.push({ name: 'local', path: localPath, eventCount: localEvents.length, errors: [] });
      for (const e of localEvents) all.push({ ...e, source: 'local' });
    } else if (sourceFilter === 'local') {
      // 明确点名要看本地日历而文件还没有：如实说，别让主人以为"日程是空的"。
      errors.push('local：本地日历还没有任何事件（' + localPath + ' 在首次 calendar.add 后自动创建）');
    }
  }

  const inWindow = eventsInWindow(all, nowMs, windowDays) as Array<CalendarEvent & { source: string }>;
  return { events: inWindow, sources, windowDays, errors };
}
/** 读本地日历。文件不存在 = 空（还没写过，正常）；坏了如实进 errors，不当"没事件"。 */
function readLocalEvents(cfg: CalendarConfig, errors: string[]): CalendarEvent[] {
  let raw: string;
  try {
    raw = readFileSync(localPathOf(cfg), 'utf8');
  } catch {
    return [];
  }
  const r = parseIcs(raw);
  for (const e of r.errors) errors.push('local：' + e);
  return r.events;
}

/** 全量写本地日历。返回 null = 成功；否则是给人看的错误句。 */
function writeLocalEvents(cfg: CalendarConfig, drafts: IcsEventDraft[]): string | null {
  const path = localPathOf(cfg);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeIcs(drafts), 'utf8');
    return null;
  } catch (cause) {
    return '写本地日历失败（' + path + '）：' + String(cause);
  }
}

/** 解析侧事件 → 生成侧草稿（重写文件时原样带回）。 */
function eventToDraft(e: CalendarEvent, dtstampMs: number): IcsEventDraft {
  return {
    uid: e.uid,
    startMs: e.startMs ?? 0,
    endMs: e.endMs ?? e.startMs ?? 0,
    allDay: e.allDay,
    summary: e.summary,
    location: e.location,
    description: e.description,
    dtstampMs,
  };
}

/** 冲突检查结果。 */
export interface ConflictResult {
  conflicts: Array<{ a: CalendarEvent & { source: string }; b: CalendarEvent & { source: string } }>;
  windowDays: number;
  /** 参与比较的事件数（让主人知道"查了几个"）。 */
  checkedCount: number;
  errors: string[];
}

/**
 * 找窗口内的时间冲突。
 *
 * 本地 + 订阅**合并后**再查（T7）：新加的本地事件和订阅里的会撞在一起，
 * 这里必须看得见 —— 这正是"加日程前先查冲突"能工作的前提。
 */
export function listConflicts(
  cfg: CalendarConfig,
  nowMs: number,
  windowDays: number,
): ConflictResult {
  const r = listEvents(cfg, nowMs, windowDays);
  const conflicts = findConflicts(r.events) as ConflictResult['conflicts'];
  return {
    conflicts,
    windowDays,
    checkedCount: r.events.filter((e) => !e.allDay).length,
    errors: r.errors,
  };
}

// ═════════════════════════════════════════════════════════════════
// 本地日历写回（T7，2026-10-21）
// ═════════════════════════════════════════════════════════════════
//
// 边界（写回时代的规则，替代 T6 的"整体只读"）：
//   订阅 .ics 永远只读；add/edit/delete 只动 local.ics 这**一个**文件。
// 为什么全量重写：.ics 是「行式 + 折行」文本，原地改字节是坏文件之源；
// 读全量 → 内存改 → serializeIcs 全量写，幂等且可重建。

/**
 * 本地事件（写回工具的返回形态）：与 CalendarEvent 同形，但 startMs/endMs
 * 一定是 number —— 这两条刚写进文件，不存在"时刻未知"。
 */
export type LocalEvent = Omit<CalendarEvent, 'startMs' | 'endMs'> & {
  startMs: number;
  endMs: number;
  source: 'local';
};

/** 写/改的结果。ok=false 时 error 是给人看的一句中文，如实转告主人。 */
export type CalendarWriteResult =
  | { ok: true; event: LocalEvent; duplicate?: boolean }
  | { ok: false; error: string };

/** 删除的结果（没有事件体；removed=false = 本地日历里没有这个 id）。 */
export type CalendarDeleteResult = { ok: true; removed: boolean } | { ok: false; error: string };

/** add/edit 的输入。start 必填；end 与 durationMin 给一个，都不给按 1 小时。 */
export interface LocalEventInput {
  /** 标题（SUMMARY）。 */
  summary: string;
  /**
   * 开始时间，认三种写法（认不出就报错，**不猜**）：
   *   `2026-10-25T09:00:00+08:00`（带时区的 ISO，最稳）
   *   `2026-10-25 09:00[:30]`（本机时区的时刻）
   *   `2026-10-25`（全天）
   */
  start: string;
  /** 结束时间。与 durationMin 二选一；全天事件忽略它。 */
  end?: string;
  /** 时长（分钟，正整数）。 */
  durationMin?: number;
  location?: string;
  notes?: string;
}

/**
 * 解析用户给的时间字符串。返回 null = 认不出，不猜。
 *
 * 刻意不用裸 Date.parse 兜底：它对 `2026-10-25` 这种**纯日期**串按 UTC 零点算
 * （语言规范的历史坑），对无时区的 date-time 各引擎行为不一 ——
 * 三种写法各走各的明确分支，谁也别猜。
 */
export function parseUserDate(value: string): { ms: number; allDay: boolean } | null {
  const v = value.trim();
  // ① 带时区/Z 的 ISO —— Date.parse 对带偏移的串是可靠的
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : { ms: t, allDay: false };
  }
  // ② 纯日期 → 全天（按本地零点；按 UTC 会错一天）
  const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dOnly !== null) {
    const t = new Date(Number(dOnly[1]), Number(dOnly[2]) - 1, Number(dOnly[3]));
    return Number.isNaN(t.getTime()) ? null : { ms: t.getTime(), allDay: true };
  }
  // ③ 本地时刻
  const dt = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (dt !== null) {
    const t = new Date(
      Number(dt[1]),
      Number(dt[2]) - 1,
      Number(dt[3]),
      Number(dt[4]),
      Number(dt[5]),
      dt[6] === undefined ? 0 : Number(dt[6]),
    );
    return Number.isNaN(t.getTime()) ? null : { ms: t.getTime(), allDay: false };
  }
  return null;
}

/** 从"已解析的开始"出发定出结束。end 与 durationMin 都缺省 = 1 小时（解析侧同款惯例）。 */
function finishTimes(
  start: { ms: number; allDay: boolean },
  end: unknown,
  durationMin: unknown,
): { ok: true; startMs: number; endMs: number; allDay: boolean } | { ok: false; error: string } {
  if (start.allDay) {
    // 全天：结束 = 当天本地零点 + 24h（解析侧同款默认）。
    // 传了 end/durationMin 也忽略 —— 全天事件没有"几小时"的语义。
    return { ok: true, startMs: start.ms, endMs: start.ms + 24 * 60 * 60_000, allDay: true };
  }
  if (typeof durationMin === 'number' && Number.isFinite(durationMin)) {
    if (!Number.isInteger(durationMin) || durationMin <= 0) {
      return { ok: false, error: 'durationMin 必须是正整数（分钟）' };
    }
    return { ok: true, startMs: start.ms, endMs: start.ms + durationMin * 60_000, allDay: false };
  }
  if (typeof end === 'string' && end.trim() !== '') {
    const e = parseUserDate(end);
    if (e === null) return { ok: false, error: '结束时间认不出：' + JSON.stringify(end) };
    if (e.ms <= start.ms) return { ok: false, error: '结束时间必须晚于开始时间' };
    return { ok: true, startMs: start.ms, endMs: e.ms, allDay: false };
  }
  return { ok: true, startMs: start.ms, endMs: start.ms + 60 * 60_000, allDay: false };
}
/**
 * 往本地日历加一条事件。
 *
 * **内容幂等**（工具声明 sideEffect=safe 的兑现）：同 标题+开始+结束 的事件
 * 已存在时直接返回已有那条（duplicate: true），不写文件 —— 崩溃恢复/模型重试
 * 都不会造出第二份 VEVENT。
 */
export function addLocalEvent(cfg: CalendarConfig, nowMs: number, input: LocalEventInput): CalendarWriteResult {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary === '') return { ok: false, error: 'summary 不能为空' };
  const start = parseUserDate(typeof input.start === 'string' ? input.start : '');
  if (start === null) {
    return {
      ok: false,
      error:
        '开始时间认不出：' + JSON.stringify(input.start ?? '') +
        '（认三种写法：2026-10-25T09:00:00+08:00 / 2026-10-25 09:00 / 2026-10-25）',
    };
  }
  const t = finishTimes(start, input.end, input.durationMin);
  if (!t.ok) return t;
  const errors: string[] = [];
  const existing = readLocalEvents(cfg, errors);
  const dup = existing.find((e) => e.summary === summary && e.startMs === t.startMs && e.endMs === t.endMs);
  if (dup !== undefined && dup.startMs !== null && dup.endMs !== null) {
    // 内容幂等命中：不写文件，把已有那条原样还给调用方
    return {
      ok: true,
      event: { ...dup, startMs: dup.startMs, endMs: dup.endMs, source: 'local' },
      duplicate: true,
    };
  }
  const uid = 'dotd-local-' + nowMs.toString(36) + '-' + randomBytes(3).toString('hex');
  const draft: IcsEventDraft = {
    uid,
    startMs: t.startMs,
    endMs: t.endMs,
    allDay: t.allDay,
    summary,
    location: (typeof input.location === 'string' ? input.location : '').trim().slice(0, 200),
    description: (typeof input.notes === 'string' ? input.notes : '').trim().slice(0, 1000),
    dtstampMs: nowMs,
  };
  const err = writeLocalEvents(cfg, [...existing.map((e) => eventToDraft(e, nowMs)), draft]);
  if (err !== null) return { ok: false, error: err };
  const event: LocalEvent = {
    uid,
    summary,
    startMs: t.startMs,
    endMs: t.endMs,
    allDay: t.allDay,
    location: draft.location,
    description: draft.description,
    organizer: '',
    source: 'local',
  };
  return { ok: true, event };
}

/**
 * 改一条**本地**日历事件（给哪个字段改哪个，没给的不动）。
 * 只改得动 source=local 的事件 —— 订阅 .ics 是别人系统的投影，id 传进来只会
 * 得到"没有这个 id"。
 */
export function editLocalEvent(
  cfg: CalendarConfig,
  nowMs: number,
  id: string,
  patch: Partial<LocalEventInput>,
): CalendarWriteResult {
  const key = typeof id === 'string' ? id.trim() : '';
  if (key === '') return { ok: false, error: 'id 不能为空（calendar.add 的返回或 calendar.list 里的 uid）' };
  const errors: string[] = [];
  const existing = readLocalEvents(cfg, errors);
  const drafts = existing.map((e) => eventToDraft(e, nowMs));
  const idx = drafts.findIndex((d) => d.uid === key);
  const target = drafts[idx];
  if (target === undefined) {
    return {
      ok: false,
      error: '本地日历里没有 id=' + key + '。只能改 source=local 的事件 —— 订阅 .ics 只读',
    };
  }
  if (typeof patch.summary === 'string' && patch.summary.trim() !== '') target.summary = patch.summary.trim();
  if (patch.location !== undefined) {
    target.location = (typeof patch.location === 'string' ? patch.location : '').trim().slice(0, 200);
  }
  if (patch.notes !== undefined) {
    target.description = (typeof patch.notes === 'string' ? patch.notes : '').trim().slice(0, 1000);
  }
  if (patch.start !== undefined || patch.end !== undefined || patch.durationMin !== undefined) {
    const start =
      patch.start !== undefined
        ? parseUserDate(typeof patch.start === 'string' ? patch.start : '')
        : { ms: target.startMs, allDay: target.allDay };
    if (start === null) {
      return { ok: false, error: '开始时间认不出：' + JSON.stringify(patch.start ?? '') };
    }
    if (patch.end === undefined && patch.durationMin === undefined && !start.allDay && !target.allDay) {
      // 只平移开始、结束不动：保持**原时长** —— "把周会改到 4 点"是平移，
      // 不是把它缩成默认的 1 小时。
      const dur = target.endMs > target.startMs ? target.endMs - target.startMs : 60 * 60_000;
      target.startMs = start.ms;
      target.endMs = start.ms + dur;
      target.allDay = false;
    } else {
      const t = finishTimes(start, patch.end, patch.durationMin);
      if (!t.ok) return t;
      target.startMs = t.startMs;
      target.endMs = t.endMs;
      target.allDay = t.allDay;
    }
  }
  const err = writeLocalEvents(cfg, drafts);
  if (err !== null) return { ok: false, error: err };
  const event: LocalEvent = {
    uid: target.uid,
    summary: target.summary,
    startMs: target.startMs,
    endMs: target.endMs,
    allDay: target.allDay,
    location: target.location,
    description: target.description,
    organizer: '',
    source: 'local',
  };
  return { ok: true, event };
}

/**
 * 删一条**本地**日历事件。本地日历里没有这个 id 时返回 removed:false（不是错误）：
 * "删一个不存在的东西"结果上就是"没有东西被删"，如实转告即可。
 */
export function deleteLocalEvent(cfg: CalendarConfig, nowMs: number, id: string): CalendarDeleteResult {
  const key = typeof id === 'string' ? id.trim() : '';
  if (key === '') return { ok: false, error: 'id 不能为空（calendar.add 的返回或 calendar.list 里的 uid）' };
  const errors: string[] = [];
  const existing = readLocalEvents(cfg, errors);
  const drafts = existing.map((e) => eventToDraft(e, nowMs));
  const idx = drafts.findIndex((d) => d.uid === key);
  if (idx < 0 || drafts[idx] === undefined) return { ok: true, removed: false };
  drafts.splice(idx, 1);
  const err = writeLocalEvents(cfg, drafts);
  if (err !== null) return { ok: false, error: err };
  return { ok: true, removed: true };
}

/**
 * 把 listEvents 的结果渲染成给人看的文字。
 *
 * 格式选择：每条一行，时间在前。理由是主人在手机上扫一眼时，
 * 先看"什么时候"比先看"什么会"更实用 —— 他通常已经知道要开什么会，
 * 想知道的是几点。
 */
export function renderList(r: ListResult): string {
  const lines: string[] = [];
  if (r.events.length === 0) {
    lines.push('未来 ' + r.windowDays + ' 天没有日程。');
  } else {
    lines.push('未来 ' + r.windowDays + ' 天有 ' + r.events.length + ' 个日程：');
    lines.push('');
    for (const e of r.events) {
      const when = e.startMs === null ? '时刻未知' : formatWhen(e.startMs, e.allDay);
      let line = '· ' + when + '  ' + e.summary;
      if (e.location !== '') line += '（' + e.location + '）';
      // 多日历时标来源，单日历不标（省噪音）
      if (r.sources.length > 1) line += ' [' + e.source + ']';
      lines.push(line);
    }
  }
  if (r.errors.length > 0) {
    lines.push('');
    lines.push('有 ' + r.errors.length + ' 个问题：');
    for (const err of r.errors.slice(0, 5)) lines.push('· ' + err);
  }
  return lines.join('\n');
}

/** 把冲突结果渲染成文字。 */
export function renderConflicts(r: ConflictResult): string {
  if (r.conflicts.length === 0) {
    return '未来 ' + r.windowDays + ' 天没有时间冲突（比对了 ' + r.checkedCount + ' 个定时日程）。';
  }
  const lines = ['未来 ' + r.windowDays + ' 天有 ' + r.conflicts.length + ' 处冲突：', ''];
  for (const c of r.conflicts) {
    const aw = c.a.startMs === null ? '?' : formatWhen(c.a.startMs, c.a.allDay);
    const bw = c.b.startMs === null ? '?' : formatWhen(c.b.startMs, c.b.allDay);
    lines.push('· ' + c.a.summary + '（' + aw + '）撞上 ' + c.b.summary + '（' + bw + '）');
  }
  return lines.join('\n');
}