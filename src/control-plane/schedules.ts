/**
 * src/control-plane/schedules.ts —— 用户可创建的定时任务（2026-10-18）。
 *
 * 背景（对标 OpenAI bot 的"定时任务/提醒"）：
 * `crontabs` 表早就存在（含 cron 表达式、quiet_hours、skip_if_busy、catchup），
 * 调度器 `scanCrontabs` 也已经能扫描和触发 —— **但从来没有任何创建入口**。
 * 等于"引擎装好了，没有方向盘"。
 *
 * 本模块补三件事：
 *   ① create：校验 cron 表达式 → 算 next_fire → 落库；
 *   ② list：给 CLI / API / 模型看有哪些定时任务、下次何时触发；
 *   ③ remove：停用（不硬删，保留历史）。
 *
 * 纪律：
 *   - **cron 表达式必须能算出下一次触发时刻**，算不出来就拒（别让坏 cron 进库，
 *     调度器每 tick 撞同一错误只能停用，主人却不知道为什么）；
 *   - 标题与 prompt 都必填：定时任务是"到点让 bot 去做一件事"，prompt 就是那件事；
 *   - dot_id 默认 dot1（阶段一单 dot）。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 一条定时任务（对外形状）。 */
export interface ScheduleRow {
  id: string;
  dotId: string;
  title: string;
  prompt: string;
  /** 5 段 cron（分 时 日 月 周）。 */
  cron: string;
  enabled: boolean;
  /** 下次触发时刻（毫秒）。 */
  nextFireAt: number;
  /** 上次触发时刻（毫秒），从未触发为 null。 */
  lastFiredAt: number | null;
  /** 上次触发结果：fired / skipped_quiet / skipped_busy / error。 */
  lastFireStatus: string | null;
  /** 忙碌时是否跳过（默认 true，避免和主人对话抢额度）。 */
  skipIfBusy: boolean;
  /** 安静时段，如 '23:00-07:30'；null = 不设。 */
  quietHours: string | null;
  /** 错过多次时补投几次：latest=只补最近一次，skip=不补。 */
  catchup: 'latest' | 'skip';
}

/** 创建参数。 */
export interface CreateScheduleInput {
  title: string;
  prompt: string;
  cron: string;
  dotId?: string;
  skipIfBusy?: boolean;
  quietHours?: string | null;
  catchup?: 'latest' | 'skip';
}

export interface CreateScheduleResult {
  ok: boolean;
  schedule?: ScheduleRow;
  error?: string;
}

/** 算下一次触发时刻的注入点（调度器已有同一实现在用，测试可替换）。 */
export type CronNextFn = (cron: string, fromMs: number) => number;

function newScheduleId(): string {
  // 与 crontabs.id 约定一致：'ct_'+nanoid（这里用时间+随机，够用且无依赖）
  const rand = Math.random().toString(36).slice(2, 10);
  return `ct_${Date.now().toString(36)}${rand}`;
}

const MIN_INTERVAL_MS = 60_000; // 最快每分钟一次

/**
 * 创建一条定时任务。
 *
 * **先验 cron 再落库**：算不出 next_fire 就拒，并把原因说清楚。
 * 这一条是从第十四轮"熔断看不见"学来的：坏数据进库后，调度器只会静默停用。
 */
export function createSchedule(
  db: DatabaseSync,
  input: CreateScheduleInput,
  cronNext: CronNextFn,
  now = Date.now(),
): CreateScheduleResult {
  const title = input.title?.trim() ?? '';
  const prompt = input.prompt?.trim() ?? '';
  const cron = input.cron?.trim() ?? '';

  if (title.length === 0) return { ok: false, error: 'title 不能为空（给这条定时任务起个名字）' };
  if (prompt.length === 0) return { ok: false, error: 'prompt 不能为空（到点要让 bot 做什么）' };
  if (cron.length === 0) return { ok: false, error: 'cron 不能为空（5 段：分 时 日 月 周）' };
  if (cron.split(/\s+/).length !== 5) {
    return { ok: false, error: `cron 必须是 5 段（分 时 日 月 周），收到 ${cron.split(/\s+/).length} 段：${cron}` };
  }

  let nextFire: number;
  try {
    nextFire = cronNext(cron, now);
  } catch (cause) {
    return { ok: false, error: `cron 表达式无法解析：${cron}（${String(cause)}）` };
  }
  if (!Number.isFinite(nextFire) || nextFire <= now) {
    return { ok: false, error: `cron 算不出下一次触发时刻：${cron}` };
  }
  if (nextFire - now < MIN_INTERVAL_MS) {
    return { ok: false, error: '最短间隔 1 分钟（更密的定时任务会淹没对话）' };
  }

  const dotId = input.dotId ?? 'dot1';
  const quiet = input.quietHours ?? null;
  if (quiet !== null && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(quiet)) {
    return { ok: false, error: `quietHours 形状应为 '23:00-07:30'，收到 ${quiet}` };
  }

  const id = newScheduleId();
  db.prepare(
    `INSERT INTO crontabs
       (id, dot_id, title, prompt, cron, enabled, next_fire, skip_if_busy, quiet_hours, catchup)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    dotId,
    title,
    prompt,
    cron,
    nextFire,
    input.skipIfBusy === false ? 0 : 1,
    quiet,
    input.catchup ?? 'latest',
  );

  return { ok: true, schedule: toRow(db.prepare('SELECT * FROM crontabs WHERE id=?').get(id)) };
}

/** 列出定时任务（默认只看启用的，按下次触发时间升序）。 */
export function listSchedules(
  db: DatabaseSync,
  opts: { dotId?: string; includeDisabled?: boolean } = {},
): ScheduleRow[] {
  const where = [
    opts.dotId === undefined ? '1=1' : 'dot_id=?',
    opts.includeDisabled === true ? '1=1' : 'enabled=1',
  ].join(' AND ');
  const params = opts.dotId === undefined ? [] : [opts.dotId];
  const rows = db
    .prepare(`SELECT * FROM crontabs WHERE ${where} ORDER BY next_fire ASC`)
    .all(...params) as unknown as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/** 停用一条定时任务（不硬删，保留历史可查）。 */
export function removeSchedule(db: DatabaseSync, id: string): { ok: boolean; error?: string } {
  // 只更新"启用中"的行：对一条已经停用的再停用，应当报"没有"而不是假装成功
  // （2026-10-18 单测抓到：原写法对已停用的行也会 changes=1）。
  const r = db.prepare('UPDATE crontabs SET enabled=0 WHERE id=? AND enabled=1').run(id);
  if (Number(r.changes) === 0) return { ok: false, error: `没有启用的定时任务：${id}` };
  return { ok: true };
}

function toRow(raw: unknown): ScheduleRow {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r['id']),
    dotId: String(r['dot_id']),
    title: String(r['title']),
    prompt: String(r['prompt']),
    cron: String(r['cron']),
    enabled: Number(r['enabled']) === 1,
    nextFireAt: Number(r['next_fire']),
    lastFiredAt: r['last_fired_at'] === null || r['last_fired_at'] === undefined ? null : Number(r['last_fired_at']),
    lastFireStatus: r['last_fire_status'] === null || r['last_fire_status'] === undefined ? null : String(r['last_fire_status']),
    skipIfBusy: Number(r['skip_if_busy']) === 1,
    quietHours: r['quiet_hours'] === null || r['quiet_hours'] === undefined ? null : String(r['quiet_hours']),
    catchup: r['catchup'] === 'skip' ? 'skip' : 'latest',
  };
}
