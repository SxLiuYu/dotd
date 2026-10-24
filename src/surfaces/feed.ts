/**
 * src/surfaces/feed.ts —— 「动态」：把已经发生和正等着做的事，压成一条可扫读的时间线。
 *
 * 为什么要有这一层（2026-10-23，对标 Muse 的相处层）
 *   能力面和形态面在 `docs/muse-parity.md` 已经对齐；真正缺的是**选择与监看的成本**。
 *   现在主人打开 Web 看到的是七个各管一段的视图：Chat 只有对话，Queue 只有在途，
 *   Activity 只有终态，Approvals 只有待批，Events 只有原始事件。要知道"今天发生了什么、
 *   有什么在等我"，得自己把这几个视图拼起来。Muse 的动态页做对的就是这一件事：
 *   把资讯和通知合成一条时间线。
 *
 * 为什么是**投影**而不是新功能
 *   这里不采集任何新事实、不新建表、不发消息。输入全部来自已有属主：
 *   `tasks` / `approvals` / `crontabs` / `events(status='inbox')` / 今日日历。
 *   所以它天然不会和 brief / progress / proactive 抢"谁说了算"——那三条管的是
 *   **什么时候打扰**，本文件只回答**发生过什么**。
 *
 * 为什么每条都带 provenance
 *   Muse 的动态页是黑箱；dotd 的差异应该是"每条都能点开看它为什么在这里"。
 *   provenance 里的 ref 直接指向规则/定时/事件/任务，排查时不用再猜。
 *
 * 边界（刻意不做）
 *   - 只读：不写库、不推送、不改任务状态。
 *   - 不排序"兴趣"：顺序就是时间倒序，没有推荐算法。
 *   - 不合并审批与任务成一条：审批是"要你动手"，任务是"已经发生"，两者语义不同；
 *     但同一任务在 awaiting_approval 时不再单独出一条任务项（避免同件事出现两遍）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { listEvents } from '../calendar/CalendarService.ts';

export type FeedItemKind = 'task' | 'approval' | 'event' | 'schedule' | 'calendar' | 'voice' | 'system';
export type FeedAttention = 'low' | 'normal' | 'high';

/** 这一条为什么出现在这里（可点开追溯）。 */
export interface FeedProvenance {
  source: 'cron' | 'event' | 'owner' | 'device' | 'system';
  /** 稳定引用：`task:<id>` / `approval:<seq>` / `cron:<id>` / `event:<id>` / `voice:<id>`。 */
  ref: string;
  /** 人话补充（如"规则命中"、"第 3 次失败"）。 */
  note?: string;
}

export interface FeedAction {
  kind: 'open_task' | 'open_approval' | 'submit_goal';
  label: string;
  /** kind='submit_goal' 时必填：点一下就以这段文字建任务。 */
  goal?: string;
}

export interface FeedItem {
  /** 稳定 id（同一事实重复采集不会长出第二条）。 */
  id: string;
  kind: FeedItemKind;
  /** epoch 毫秒。 */
  at: number;
  title: string;
  body: string | null;
  attention: FeedAttention;
  taskId: string | null;
  approvalId: number | null;
  provenance: FeedProvenance;
  action: FeedAction | null;
}

export interface FeedTaskRow {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  sourceEventId: number | null;
  lastHeartbeatAt: number | null;
}

export interface FeedApprovalRow {
  id: number;
  seq: number;
  kind: string;
  summary: string;
  status: string;
  /** SQLite 文本（UTC，`YYYY-MM-DD HH:MM:SS`）。 */
  createdAt: string;
  pendingUntil: string;
  taskId: string;
}

export interface FeedCrontabRow {
  id: string;
  title: string;
  lastFiredAt: number | null;
  lastFireStatus: string | null;
  nextFire: number;
}

export interface FeedEventRow {
  id: number;
  source: string;
  actor: string;
  payload: string;
  receivedAt: number;
}

export interface FeedCalendarRow {
  startMs: number | null;
  allDay: boolean;
  summary: string;
  location?: string;
}

export interface FeedVoiceRow {
  id: number;
  deviceId: string;
  deviceName: string | null;
  kind: string;
  detail: string | null;
  at: number;
}

export interface FeedInput {
  nowMs: number;
  tasks: FeedTaskRow[];
  approvals: FeedApprovalRow[];
  crontabs: FeedCrontabRow[];
  /** 已经落到 inbox 的未识别事件。 */
  events: FeedEventRow[];
  calendar: FeedCalendarRow[];
  calendarErrors: string[];
  /** 语音反射层记账（阶段 2）：场景/快路径/离线兜底。缺省 = 空。 */
  voice?: FeedVoiceRow[];
}

export interface FeedOptions {
  limit?: number;
  /** 只保留 at >= since 的条目（epoch ms）。 */
  since?: number;
}

export interface FeedSnapshot {
  items: FeedItem[];
  generatedAt: number;
}

export const FEED_DEFAULT_LIMIT = 100;
export const FEED_MAX_LIMIT = 200;
/** 正文截断长度：卡片上读得完，不把整段 payload 倒给主人。 */
export const FEED_BODY_MAX = 200;

/** 取数依赖：只收「数据在哪」，不依赖任何能力对象（便于纯测）。 */
export interface FeedDeps {
  db: DatabaseSync;
  calendarDir: string;
}

function clip(text: string, max: number = FEED_BODY_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** SQLite 的 `datetime('now')` 是 UTC 文本；`Date.parse` 对无时区串按本地解释，必须补 Z。 */
export function parseSqliteTs(v: string): number | null {
  const s = v.trim();
  if (s.length === 0) return null;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时刻未知';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 任务状态 → 一行人话。返回 null = 这个状态不单独出现在动态里（由审批项代表）。 */
function taskLine(t: FeedTaskRow): { title: string; attention: FeedAttention } | null {
  switch (t.status) {
    case 'awaiting_approval':
      // 审批项会单独出现，这里不再重复；同一件事在时间线上出现两遍比漏掉更烦人。
      return null;
    case 'running':
      return { title: `正在跑：${t.title}`, attention: 'normal' };
    case 'queued':
      return { title: `排队中：${t.title}`, attention: 'low' };
    case 'paused':
      return { title: `暂停了：${t.title}`, attention: 'normal' };
    case 'done':
      return { title: `办完了：${t.title}`, attention: 'low' };
    case 'failed':
      return { title: `没办成：${t.title}`, attention: 'high' };
    case 'cancelled':
      return { title: `取消了：${t.title}`, attention: 'low' };
    default:
      return { title: `${t.title}（${t.status}）`, attention: 'normal' };
  }
}

function approvalLine(a: FeedApprovalRow, nowMs: number): { title: string; attention: FeedAttention; body: string | null } {
  const until = parseSqliteTs(a.pendingUntil);
  const remainingMs = until === null ? null : until - nowMs;
  if (a.status === 'expired') {
    return { title: `审批过期了：${a.summary}`, attention: 'high', body: '过期后不会自动执行，需要重新发起。' };
  }
  if (a.status === 'failed') {
    return { title: `审批后执行失败：${a.summary}`, attention: 'high', body: '详情见任务记录。' };
  }
  if (remainingMs !== null && remainingMs > 0) {
    const hours = Math.ceil(remainingMs / 3_600_000);
    return {
      title: `等你确认：${a.summary}`,
      attention: 'high',
      body: hours <= 24 ? `${hours} 小时内会过期。` : null,
    };
  }
  return { title: `等你确认：${a.summary}`, attention: 'high', body: null };
}

function voiceLine(v: FeedVoiceRow): { title: string; body: string | null; attention: FeedAttention } {
  // 语音反射层不经过 dotd 的任务队列，但"发生过"必须能在动态里看到。
  if (v.kind === 'offline') {
    return { title: `大脑离线：${clip(v.detail ?? '未处理')}`, body: '这条没有经过内核，恢复后不会自动补做。', attention: 'high' };
  }
  if (v.kind === 'scene' || v.kind.startsWith('scene.')) {
    return { title: `语音场景：${clip(v.detail ?? v.kind)}`, body: null, attention: 'low' };
  }
  if (v.kind.startsWith('fast_path.')) {
    return { title: `本地快路径：${v.kind.slice('fast_path.'.length)}`, body: v.detail === null ? null : clip(v.detail), attention: 'low' };
  }
  return { title: `语音：${v.kind}`, body: v.detail === null ? null : clip(v.detail), attention: 'normal' };
}

/**
 * 纯投影：把五类事实压成一条时间线。
 *
 * 去重口径：按 `id` 去重（同一任务、同一审批、同一事件只出一条）。
 * 排序口径：`at` 倒序；同一时刻按 id 倒序，保证输出稳定。
 */
export function buildFeed(input: FeedInput, opts: FeedOptions = {}): FeedItem[] {
  const limitRaw = opts.limit ?? FEED_DEFAULT_LIMIT;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), FEED_MAX_LIMIT)) : FEED_DEFAULT_LIMIT;
  const since = opts.since ?? null;
  const items: FeedItem[] = [];

  for (const t of input.tasks) {
    const line = taskLine(t);
    if (line === null) continue;
    items.push({
      id: `task:${t.id}`,
      kind: 'task',
      at: t.updatedAt,
      title: line.title,
      body: null,
      attention: line.attention,
      taskId: t.id,
      approvalId: null,
      provenance: {
        source: t.sourceEventId !== null ? 'event' : 'owner',
        ref: `task:${t.id}`,
        ...(t.sourceEventId !== null ? { note: `来自事件 #${t.sourceEventId}` } : {}),
      },
      action: { kind: 'open_task', label: '看任务' },
    });
  }

  for (const a of input.approvals) {
    const at = parseSqliteTs(a.createdAt);
    if (at === null) continue;
    const line = approvalLine(a, input.nowMs);
    items.push({
      id: `approval:${a.seq}`,
      kind: 'approval',
      at,
      title: line.title,
      body: line.body,
      attention: line.attention,
      taskId: a.taskId,
      approvalId: a.id,
      provenance: { source: 'system', ref: `approval:${a.seq}`, note: a.kind === 'question' ? 'Dot 在等你回答' : '需要你点头' },
      action: { kind: 'open_approval', label: a.kind === 'question' ? '去回答' : '去审批' },
    });
  }

  for (const e of input.events) {
    items.push({
      id: `event:${e.id}`,
      kind: 'event',
      at: e.receivedAt,
      title: `没认出来的事件：${e.source} / ${e.actor}`,
      body: clip(e.payload),
      attention: 'high',
      taskId: null,
      approvalId: null,
      provenance: { source: 'event', ref: `event:${e.id}`, note: '低于执行阈值，落 inbox 等你' },
      action: { kind: 'submit_goal', label: '让 Dot 处理', goal: `处理这条事件：${clip(e.payload, 120)}` },
    });
  }

  for (const v of input.voice ?? []) {
    const line = voiceLine(v);
    const who = v.deviceName ?? v.deviceId;
    items.push({
      id: `voice:${v.id}`,
      kind: 'voice',
      at: v.at,
      title: line.title,
      body: line.body,
      attention: line.attention,
      taskId: null,
      approvalId: null,
      provenance: { source: 'device', ref: `voice:${v.id}`, note: `来自设备 ${who}` },
      action: null,
    });
  }

  for (const c of input.crontabs) {
    if (c.lastFireStatus !== 'error' || c.lastFiredAt === null) continue;
    items.push({
      id: `cron:${c.id}`,
      kind: 'schedule',
      at: c.lastFiredAt,
      title: `定时任务出错：${c.title}`,
      body: `上次触发 ${hhmm(c.lastFiredAt)}；下次 ${hhmm(c.nextFire)}。`,
      attention: 'high',
      taskId: null,
      approvalId: null,
      provenance: { source: 'cron', ref: `cron:${c.id}` },
      action: null,
    });
  }

  for (const e of input.calendar) {
    if (e.startMs === null) continue;
    const loc = e.location === undefined || e.location.trim() === '' ? '' : `（${e.location.trim()}）`;
    items.push({
      id: `calendar:${e.startMs}:${e.summary}`,
      kind: 'calendar',
      at: e.startMs,
      title: e.allDay ? `全天：${e.summary}` : `${hhmm(e.startMs)} ${e.summary}${loc}`,
      body: null,
      attention: 'normal',
      taskId: null,
      approvalId: null,
      provenance: { source: 'system', ref: 'calendar', note: '今天的日程' },
      action: null,
    });
  }

  for (const err of input.calendarErrors) {
    items.push({
      id: `system:calendar:${err}`,
      kind: 'system',
      at: input.nowMs,
      title: '日历读不出来',
      body: clip(err),
      attention: 'high',
      taskId: null,
      approvalId: null,
      provenance: { source: 'system', ref: 'calendar', note: '读失败不等于今天没有日程' },
      action: null,
    });
  }

  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
  const filtered = since === null ? deduped : deduped.filter((it) => it.at >= since);
  filtered.sort((a, b) => (b.at - a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return filtered.slice(0, limit);
}

/** 从已有属主表取数（不写库、不发消息）。 */
export function collectFeedInput(deps: FeedDeps, nowMs: number): FeedInput {
  const { db } = deps;

  const tasks = safeAll<FeedTaskRow>(
    db,
    `SELECT id, title, status, created_at AS createdAt, updated_at AS updatedAt,
            source_event_id AS sourceEventId, last_heartbeat_at AS lastHeartbeatAt
       FROM tasks
      ORDER BY updated_at DESC
      LIMIT 200`,
  );

  const approvals = safeAll<FeedApprovalRow>(
    db,
    `SELECT id, seq, kind, summary, status, created_at AS createdAt,
            pending_until AS pendingUntil, task_id AS taskId
       FROM approvals
      WHERE status IN ('pending', 'expired', 'failed')
         OR (decided_at IS NOT NULL AND decided_at >= datetime('now', '-2 days'))
      ORDER BY id DESC
      LIMIT 100`,
  );

  const crontabs = safeAll<FeedCrontabRow>(
    db,
    `SELECT id, title, last_fired_at AS lastFiredAt, last_fire_status AS lastFireStatus,
            next_fire AS nextFire
       FROM crontabs WHERE enabled = 1
      ORDER BY next_fire ASC LIMIT 50`,
  );

  const events = safeAll<FeedEventRow>(
    db,
    `SELECT id, source, actor, payload, received_at AS receivedAt
       FROM events WHERE status = 'inbox'
      ORDER BY received_at DESC LIMIT 20`,
  );

  const voice = safeAll<FeedVoiceRow>(
    db,
    `SELECT v.id AS id, v.device_id AS deviceId, d.name AS deviceName,
            v.kind AS kind, v.detail AS detail, v.at AS at
       FROM voice_events v
       LEFT JOIN devices d ON d.id = v.device_id
      ORDER BY v.at DESC LIMIT 50`,
  );

  const cal = listEvents({ dir: deps.calendarDir }, nowMs, 1);  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const start = dayStart.getTime();
  const end = start + 24 * 3_600_000;
  const calendar = cal.events
    .filter((e) => e.startMs !== null && e.startMs >= start && e.startMs < end)
    .map((e) => ({
      startMs: e.startMs,
      allDay: e.allDay,
      summary: e.summary,
      ...(e.location !== '' ? { location: e.location } : {}),
    }));

  return { nowMs, tasks, approvals, crontabs, events, calendar, calendarErrors: cal.errors, voice };
}

/** 取数 + 投影（daemon / CLI 共用的唯一入口）。 */
export function collectFeed(deps: FeedDeps, nowMs: number, opts: FeedOptions = {}): FeedSnapshot {
  return { items: buildFeed(collectFeedInput(deps, nowMs), opts), generatedAt: nowMs };
}

/** 表缺/查询失败一律空数组：动态不该因为一张表没建就整条 500。 */
function safeAll<T>(db: DatabaseSync, sql: string): T[] {
  try {
    return db.prepare(sql).all() as unknown as T[];
  } catch {
    return [];
  }
}
