/**
 * src/connectors/holiday.ts —— 中国法定节假日 / 调休（2026-10-22）。
 *
 * 为什么需要它：主人日常最常问「明天上不上班」「这个月还剩几天假」
 * 「哪几天适合出去」。这些只需要**日历事实**，不需要主人先维护日历源 ——
 * 靠订阅 .ics 反而要求人先有日历，顺序是反的。
 *
 * ── 多源，因为单一源不可靠 ──────────────────────────────────────
 * 实测（2026-10-22）：api.apihubs.cn 前几分钟还能返回全年 365 天，
 * 随后对任何参数都返回 `code=80006`（限额）。免费源随时会这样。
 * 所以这里按顺序试，第一个成功就用：
 *   1. api.apihubs.cn  —— 一次拿全年（省请求），可能限额；
 *   2. holiday.dreace.top —— 逐日查，但 365 次太多，只在需要时补单日。
 * 都把结果落本地缓存（年粒度 JSON），命中就不出网。
 *
 * ── 只报事实，不猜 ────────────────────────────────────────────
 * "要不要上班"只认 isHoliday/workday 布尔；节日名直接取源的 note，
 * 源没给就不给名字（宁可少说，不可说错）。
 *
 * 纪律：失败折叠成 {ok:false, error}，**永不抛**。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOLIDAY_TIMEOUT_MS = 15_000;

const SRC_A = 'https://api.apihubs.cn/holiday/get';
const SRC_B = 'https://holiday.dreace.top/api/v1/holidays';

export interface DayInfo {
  /** YYYY-MM-DD */
  date: string;
  /** true = 不用上班 */
  rest: boolean;
  /** 是否法定节假日（调休放假的周末不算 legal） */
  legal: boolean;
  /** 是否周末（注意：调休上班的周末 weekend 仍为 true，判断上班看 rest） */
  weekend: boolean;
  /** 是否补班日（周末上班） */
  makeup: boolean;
  /** 节日名 / 源给的说明；普通工作日为 null */
  holiday: string | null;
}

export interface HolidayResult {
  ok: boolean;
  year?: number;
  days?: DayInfo[];
  /** 数据来自缓存还是网络 */
  cached?: boolean;
  source?: 'apihubs' | 'dreace' | 'cache';
  error?: string;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 该日是周几（0=周日）。 */
export function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? '';
}

function ymd(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function cacheFile(cacheDir: string, year: number): string {
  return join(cacheDir, `holiday-${year}.json`);
}

function readCache(cacheDir: string, year: number): DayInfo[] | null {
  const f = cacheFile(cacheDir, year);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { days?: DayInfo[] };
    return Array.isArray(j.days) && j.days.length > 300 ? j.days : null;
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, year: number, days: DayInfo[]): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile(cacheDir, year), JSON.stringify({ year, days }, null, 0), 'utf8');
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/** 源 A：一次拿全年。 */
async function fromApihubs(year: number, timeoutMs: number): Promise<DayInfo[] | null> {
  const res = await fetch(`${SRC_A}?year=${year}`, {
    headers: { 'user-agent': 'dotd-connector' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const b = (await res.json()) as {
    code?: number;
    data?: { list?: Array<Record<string, number>> };
  };
  if (b.code !== 0 || !Array.isArray(b.data?.list)) return null;
  const raw = b.data.list;
  if (raw.length < 300) return null; // 不足一年视为不可信
  const days: DayInfo[] = [];
  for (const r of raw) {
    const d = r['date'];
    const wd = r['workday'];
    if (typeof d !== 'number' || typeof wd !== 'number') continue;
    const date = ymd(d);
    const isWeekend = (r['weekend'] ?? 0) === 1;
    const rest = wd === 2;
    const legalCode = r['holiday_legal'] ?? 2;
    const otCode = r['holiday_overtime'] ?? 10;
    // 源 A 不给节日名，只给编码；这里不翻译编码（会猜错），名字留给源 B 补
    days.push({
      date,
      rest,
      legal: legalCode === 1,
      weekend: isWeekend,
      makeup: otCode !== 10,
      holiday: null,
    });
  }
  days.sort((a, b2) => (a.date < b2.date ? -1 : 1));
  return days.length >= 300 ? days : null;
}

/** 源 B：查单日。用于补节日名，或在源 A 不可用时重建整年。 */
async function fromDreaceOne(date: string, timeoutMs: number): Promise<DayInfo | null> {
  const res = await fetch(`${SRC_B}?date=${date}`, {
    headers: { 'user-agent': 'dotd-connector' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const b = (await res.json()) as { date?: string; isHoliday?: boolean; note?: string; type?: string };
  if (b.date === undefined || b.isHoliday === undefined) return null;
  const note = b.note ?? '';
  const isWeekendDay = /周末/.test(note);
  const isMakeup = /补班/.test(note);
  // 节日名 = note 去掉"周末""补班"这类描述词后剩下的部分
  const name = note.replace(/周末|补班工作日|普通工作日|工作日/g, '').trim();
  return {
    date: b.date,
    rest: b.isHoliday,
    legal: b.isHoliday && !isWeekendDay,
    weekend: isWeekendDay || isMakeup,
    makeup: isMakeup,
    holiday: name !== '' ? name : null,
  };
}

/**
 * 取某年全部日期。
 *
 * @param cacheDir 缓存目录（传 `<dataDir>/cache`）；省略则不缓存。
 * @param enrich   true = 用源 B 逐个补节日名（慢，会发很多请求）。默认 false。
 */
export async function fetchYear(
  year?: number,
  opts: { timeoutMs?: number; cacheDir?: string; enrich?: boolean } = {},
): Promise<HolidayResult> {
  const y = year ?? new Date().getFullYear();
  const timeoutMs = opts.timeoutMs ?? HOLIDAY_TIMEOUT_MS;

  if (opts.cacheDir !== undefined) {
    const hit = readCache(opts.cacheDir, y);
    if (hit !== null) return { ok: true, year: y, days: hit, cached: true, source: 'cache' };
  }

  try {
    const a = await fromApihubs(y, timeoutMs);
    if (a !== null) {
      if (opts.cacheDir !== undefined) writeCache(opts.cacheDir, y, a);
      return { ok: true, year: y, days: a, cached: false, source: 'apihubs' };
    }
  } catch {
    /* 落到源 B */
  }

  // 源 B 只有单日接口：整年要 365 次。只在确实需要时做，且并发受限。
  // 这里的实际用途是「源 A 挂了 + 没有缓存」的兜底，宁可慢也不要给出"没有假期"的假答案。
  try {
    const dates: string[] = [];
    for (let t = Date.UTC(y, 0, 1); t <= Date.UTC(y, 11, 31); t += 86_400_000) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    const out: DayInfo[] = [];
    const BATCH = 8;
    for (let i = 0; i < dates.length; i += BATCH) {
      const chunk = dates.slice(i, i + BATCH);
      const rs = await Promise.all(chunk.map((d) => fromDreaceOne(d, timeoutMs).catch(() => null)));
      for (const r of rs) if (r !== null) out.push(r);
    }
    if (out.length >= 300) {
      if (opts.cacheDir !== undefined) writeCache(opts.cacheDir, y, out);
      return { ok: true, year: y, days: out, cached: false, source: 'dreace' };
    }
  } catch {
    /* 两个源都挂了 */
  }

  return { ok: false, error: 'all_sources_failed' };
}

/** 单日查询：先用年数据（可能命中缓存），拿不到再打源 B。 */
export async function fetchDay(
  date: string,
  opts: { timeoutMs?: number; cacheDir?: string } = {},
): Promise<{ ok: boolean; day?: DayInfo; error?: string }> {
  const y = Number(date.slice(0, 4));
  const r = await fetchYear(y, opts);
  if (r.ok) {
    const hit = r.days!.find((d) => d.date === date);
    if (hit !== undefined) return { ok: true, day: hit };
  }
  try {
    const one = await fromDreaceOne(date, opts.timeoutMs ?? HOLIDAY_TIMEOUT_MS);
    if (one !== null) return { ok: true, day: one };
  } catch {
    /* 下面统一报错 */
  }
  return { ok: false, error: 'all_sources_failed' };
}
