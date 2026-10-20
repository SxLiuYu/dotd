/**
 * src/calendar/CalendarService.ts —— 日历工具的实现（T6，2026-10-20）
 *
 * **只读**。没有任何写入方法，这是刻意的能力边界（理由见 ics.ts 文件头）。
 *
 * 数据从哪来
 *   主人把 .ics 文件放在 `<dataDir>/calendar/` 下（任何日历客户端都能导出），
 *   或者给出一个本地路径。我们不直接连 Google/Outlook —— 那需要 OAuth、
 *   要申请审核、要处理 token 过期，而"读一个 .ics 文件"已经能回答
 *   "下周有什么会"。先做能确定做对的。
 *
 * 为什么不缓存
 *   .ics 文件通常只有几 KB，读一次几毫秒。缓存反而引入"文件改了但显示旧的"
 *   这种让人困惑的问题。每次读最新的，简单且不会错。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  eventsInWindow,
  findConflicts,
  formatWhen,
  parseIcs,
  type CalendarEvent,
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
  /** 放 .ics 的目录。 */
  dir: string;
}

/**
 * 列窗口内的日程。
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
    const name = basename(f, f.slice(f.lastIndexOf('.')));
    if (sourceFilter !== undefined && sourceFilter !== '' && name !== sourceFilter) continue;
    const path = join(cfg.dir, f);
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

  const inWindow = eventsInWindow(all, nowMs, windowDays) as Array<CalendarEvent & { source: string }>;
  return { events: inWindow, sources, windowDays, errors };
}

/** 冲突检查结果。 */
export interface ConflictResult {
  conflicts: Array<{ a: CalendarEvent & { source: string }; b: CalendarEvent & { source: string } }>;
  windowDays: number;
  /** 参与比较的事件数（让主人知道"查了几个"）。 */
  checkedCount: number;
  errors: string[];
}

/** 找窗口内的时间冲突。 */
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