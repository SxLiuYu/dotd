/**
 * src/connectors/rest-plan.ts —— 找「下一个能出去玩的窗口」（2026-10-22）。
 *
 * 主人的原话：「读取节假日，是否调休这些，休息推荐休息去处」。
 * 这句话拆成三件事，都不需要主人先有日历：
 *   1. 哪天休息（holiday.ts 的 workday 字段）；
 *   2. 连休几天（把相邻休息日连成窗口）；
 *   3. 那个窗口天气怎么样（open-meteo，零 key）。
 *
 * 设计上的两个克制：
 *   - **不猜地点**：经纬度必须由调用方给。默认北京只是"没给就用北京"，
 *     返回里带 `assumedLocation: true`，让模型知道自己是在替主人假设。
 *   - **不编推荐**：本模块只产出「哪几天有空 + 天气数值 + 时长」。
 *     "去哪玩"交给模型结合 memory 里的主人偏好去说，不由这里硬编码景点。
 *     硬编码景点库既不准也很快过期。
 *
 * 纪律：失败折叠成 {ok:false,error}，永不抛。
 */

import { fetchYear, weekdayOf, type DayInfo } from './holiday.ts';

const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
export const REST_TIMEOUT_MS = 15_000;

/** 默认北京（主人未指定时的兜底，返回里会标 assumed）。 */
const DEFAULT_LAT = 39.9042;
const DEFAULT_LON = 116.4074;

/** WMO weather code → 中文短语。只翻常见的，其余给 null。 */
const WMO: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛雨', 53: '毛雨', 55: '大毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

export interface Window {
  /** 连休第一天 */
  start: string;
  /** 连休最后一天 */
  end: string;
  /** 含头含尾天数 */
  days: number;
  /** 窗口里出现的节日名（去重） */
  holidays: string[];
  /** 是否含调休补班（有的话提醒"这周要补班"） */
  needsMakeup: boolean;
}

export interface DayWeather {
  date: string;
  tMax: number | null;
  tMin: number | null;
  code: number | null;
  desc: string | null;
  /** 适不适合出门的粗判：雨雪/雷暴为 false */
  goodForOuting: boolean;
}

export interface MakeupDay {
  date: string;
  weekday: string;
  /** 是给哪个节补班（能查到就带，查不到就 null） */
  forHoliday: string | null;
}

export interface HolidayRun {
  name: string;
  start: string;
  end: string;
  days: number;
}

export interface RestPlanResult {
  ok: boolean;
  error?: string;
  /** 窗口列表（按开始时间升序，已过滤掉过去的日子） */
  windows?: Window[];
  /** 扫描区间内的补班日（周末但要上班）——「国庆后哪天补班」直接看这个 */
  makeupDays?: MakeupDay[];
  /** 扫描区间内的法定节假日段（含节日名）——「国庆放几天」直接看这个 */
  holidayRuns?: HolidayRun[];
  /** 只对 `focusWindow` 内的日子取天气 */
  weather?: DayWeather[];
  /** true = 用了默认坐标（北京），模型应说明这是假设 */
  assumedLocation?: boolean;
  location?: { lat: number; lon: number };
}

/** 把假期段按节日名分组（同名的连续日期算一段）。 */
export function groupHolidayRuns(days: DayInfo[], fromDate: string, toDate: string): HolidayRun[] {
  const inRange = days.filter((d) => d.date >= fromDate && d.date <= toDate && d.legal && d.holiday !== null);
  const out: HolidayRun[] = [];
  let cur: DayInfo[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    const f = cur[0]!;
    const l = cur[cur.length - 1]!;
    out.push({ name: f.holiday ?? '', start: f.date, end: l.date, days: cur.length });
    cur = [];
  };
  for (const d of inRange) {
    const prev = cur[cur.length - 1];
    if (prev === undefined) { cur.push(d); continue; }
    const gap = (Date.parse(d.date) - Date.parse(prev.date)) / 86_400_000;
    if (gap === 1 && prev.holiday === d.holiday) cur.push(d);
    else { flush(); cur.push(d); }
  }
  flush();
  return out;
}

/** 扫描区间内的补班日。forHoliday 取紧邻前后最近的法定假期名。 */
export function collectMakeupDays(days: DayInfo[], fromDate: string, toDate: string): MakeupDay[] {
  const runs = groupHolidayRuns(days, '1900-01-01', '2999-12-31');
  return days
    .filter((d) => d.makeup && !d.rest && d.date >= fromDate && d.date <= toDate)
    .map((d) => {
      // 就近找：补班日通常在假期前或后 1-2 周内
      let best: HolidayRun | null = null;
      let bestGap = Infinity;
      for (const r of runs) {
        const gap = Math.min(
          Math.abs(Date.parse(d.date) - Date.parse(r.start)),
          Math.abs(Date.parse(d.date) - Date.parse(r.end)),
        );
        if (gap < bestGap) { bestGap = gap; best = r; }
      }
      return {
        date: d.date,
        weekday: weekdayOf(d.date),
        forHoliday: best !== null && bestGap <= 15 * 86_400_000 ? best.name : null,
      };
    });
}

/** 把连续的休息日连成窗口。 */
export function groupWindows(days: DayInfo[], fromDate: string): Window[] {
  const rest = days.filter((d) => d.rest && d.date >= fromDate);
  const out: Window[] = [];
  let cur: DayInfo[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    const first = cur[0]!;
    const last = cur[cur.length - 1]!;
    const hs = [...new Set(cur.map((d) => d.holiday).filter((x): x is string => x !== null))];
    out.push({
      start: first.date,
      end: last.date,
      days: cur.length,
      holidays: hs,
      needsMakeup: cur.some((d) => d.makeup),
    });
    cur = [];
  };
  for (const d of rest) {
    const prev = cur[cur.length - 1];
    if (prev === undefined) { cur.push(d); continue; }
    // 相差一天就属于同一窗口
    const gap = (Date.parse(d.date) - Date.parse(prev.date)) / 86_400_000;
    if (gap === 1) cur.push(d); else { flush(); cur.push(d); }
  }
  flush();
  return out;
}

/** 取指定日期区间的天气。只取能覆盖到的（open-meteo 最多 16 天）。 */
export async function fetchWeather(
  dates: string[],
  loc: { lat: number; lon: number } = { lat: DEFAULT_LAT, lon: DEFAULT_LON },
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; items?: DayWeather[]; error?: string }> {
  if (dates.length === 0) return { ok: true, items: [] };
  const sorted = [...dates].sort();
  const start = sorted[0]!;
  const end = sorted[sorted.length - 1]!;
  const url =
    `${WEATHER_API}?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode` +
    `&timezone=Asia%2FShanghai&start_date=${start}&end_date=${end}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'dotd-connector' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? REST_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort|timeout/i.test(msg) ? 'timeout' : 'network' };
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  let body: unknown;
  try { body = await res.json(); } catch { return { ok: false, error: 'bad_json' }; }
  const d = (body as { daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; weathercode?: number[] } }).daily;
  if (d?.time === undefined) return { ok: false, error: 'bad_shape' };
  const want = new Set(dates);
  const items: DayWeather[] = [];
  for (let i = 0; i < d.time.length; i++) {
    const date = d.time[i]!;
    if (!want.has(date)) continue;
    const code = d.weathercode?.[i] ?? null;
    const desc = code !== null ? (WMO[code] ?? null) : null;
    // 适游判断：只看降水/雷暴类（>=51 的都是降水），雾(45/48)不算坏天气
    const bad = code !== null && ((code >= 51 && code <= 67) || (code >= 71 && code <= 77) || code >= 80);
    items.push({
      date,
      tMax: d.temperature_2m_max?.[i] ?? null,
      tMin: d.temperature_2m_min?.[i] ?? null,
      code,
      desc,
      goodForOuting: !bad,
    });
  }
  return { ok: true, items };
}

/**
 * 主入口：找出从现在起最近的休息窗口，并附上天气。
 *
 * @param opts.withinDays 只看未来几天内的窗口（默认 60 天）
 * @param opts.onlyFirst  只返回第一个窗口的天气（默认 true，省调用）
 */
export async function restPlan(
  opts: {
    withinDays?: number;
    lat?: number;
    lon?: number;
    today?: string;
    /** 可选。往回看的天数（找「已经过去的假期」如「今年国庆哪天补班」时用）。默认 0 = 只看未来。 */
    lookBackDays?: number;
    onlyFirst?: boolean;
    timeoutMs?: number;
    cacheDir?: string;
  } = {},
): Promise<RestPlanResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const within = opts.withinDays ?? 60;
  const year = Number(today.slice(0, 4));
  const r = await fetchYear(year, { timeoutMs: opts.timeoutMs, cacheDir: opts.cacheDir });
  if (!r.ok) return { ok: false, error: r.error };

  const limit = new Date(Date.parse(today) + within * 86_400_000).toISOString().slice(0, 10);
  let days = r.days!;
  // 年末窗口可能跨到下一年：顺手把明年的也拿来（失败就算了）
  const lastDay = days[days.length - 1]?.date;
  if (lastDay !== undefined && lastDay < limit) {
    const next = await fetchYear(year + 1, { timeoutMs: opts.timeoutMs, cacheDir: opts.cacheDir });
    if (next.ok) days = days.concat(next.days!);
  }

  const lookBack = opts.lookBackDays ?? 0;
  const fromDate = new Date(Date.parse(today) - lookBack * 86_400_000).toISOString().slice(0, 10);
  const windows = groupWindows(days, today).filter((w) => w.start <= limit);
  // 补班日与假期段覆盖整个扫描区间（含往回看的部分）——「国庆之后哪天补班」
  // 「国庆放几天」这类问题问的是**已公布的历史安排**，只看未来会扫不到。
  const makeupDays = collectMakeupDays(days, fromDate, limit);
  const holidayRuns = groupHolidayRuns(days, fromDate, limit);
  if (windows.length === 0) {
    return { ok: true, windows: [], weather: [], makeupDays, holidayRuns };
  }

  const assumed = opts.lat === undefined || opts.lon === undefined;
  const loc = { lat: opts.lat ?? DEFAULT_LAT, lon: opts.lon ?? DEFAULT_LON };
  const target = opts.onlyFirst === false ? windows : windows.slice(0, 1);
  const dates: string[] = [];
  for (const w of target) {
    for (let t = Date.parse(w.start); t <= Date.parse(w.end); t += 86_400_000) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  const w = await fetchWeather(dates, loc, { timeoutMs: opts.timeoutMs });
  return {
    ok: true,
    windows,
    makeupDays,
    holidayRuns,
    weather: w.ok ? (w.items ?? []) : [],
    assumedLocation: assumed,
    location: loc,
  };
}
