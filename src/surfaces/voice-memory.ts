/**
 * src/surfaces/voice-memory.ts —— 语音侧的「单一记忆源」与「单一主动推送决策」
 *
 * 合并计划的最后三件事里，前两件（记忆源、主动推送）都落在这里：
 *
 * ① 记忆源：dotd 是唯一事实源
 *    语音轮次本来就已经写进 mem_messages（/api/device/turn）；
 *    这里补上两条缺口：
 *      - 反射/本地场景回复不走 dotd，过去只在 Charlie 的
 *        conversation_history.json 里，Web 看不见。现在提供 `mirrorDeviceTurn`
 *        把整轮（user + assistant）补写进同一条 voice thread。
 *      - 偏好（preferences.json）是 Charlie 的私有配置。`device_prefs`
 *        让「语音里说过的偏好」在 Web 侧可读，Charlie 本地降级为缓存。
 *
 * ② 主动推送：dotd 决定「该不该说」，Charlie 只负责「怎么说」
 *    `decideDevicePush` 复用 src/surfaces/proactive.ts 的三道闸
 *    （总开关 / 安静时段 / 节流），再补两道语音特有的闸：
 *      - 每日总量上限（避免多个规则各推一次，合起来仍然很吵）；
 *      - 同文去重（TTS/网络重试不应让主人听两遍）。
 *    每次决策都写 `device_push_log`（允许与拒绝都记），拒绝原因可回放。
 *
 * 为什么状态要落库而不是放在 Charlie 进程里：
 *    重启不该让节流账本清零——否则「重启一次就多推一轮」会成为绕过防骚扰的漏洞。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryPort, Message } from '../shared/contracts.ts';
import { shouldPush } from './proactive.ts';

/** 设备的最小投影（与 http.ts 的 DeviceAuth 对齐，避免循环依赖）。 */
export interface VoiceDevice {
  id: string;
  dotId: string;
  name: string;
}

export interface DevicePref {
  key: string;
  value: string;
  updatedAt: number;
}

export interface VoiceMemorySnapshot {
  deviceId: string;
  threadId: string | null;
  messages: Message[];
  prefs: DevicePref[];
}

export type VoicePushReason =
  | 'disabled'
  | 'quiet_hours'
  | 'throttled'
  | 'no_target'
  | 'daily_cap'
  | 'duplicate';

export interface VoicePushDecision {
  allow: boolean;
  reason?: VoicePushReason;
  detail?: string;
  /** 允许时的下一次最早可推时间（节流窗口结束点，epoch ms）。 */
  nextAllowedAt?: number;
}

export interface VoicePushPolicy {
  proactive: boolean;
  quietHours: string | null;
  throttleHours: number;
  dailyCap: number;
  dedupeMinutes: number;
}

function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 语音主动推送的默认口径。
 *
 * `DOTD_VOICE_PROACTIVE=0` 是总开关。安静时段默认 23:00–07:30（与 dotd 简报的
 * 默认一致），每类最多 4 小时一次，全天最多 12 条，同文 30 分钟内不重发。
 * 这些都是「主人第二天不会想关掉通知」的量级；嫌吵就调小，不想要就设 0。
 */
export function voicePushPolicy(env: NodeJS.ProcessEnv = process.env): VoicePushPolicy {
  const quietRaw = env.DOTD_VOICE_QUIET_HOURS;
  return {
    proactive: env.DOTD_VOICE_PROACTIVE !== '0',
    quietHours: quietRaw === undefined ? '23:00-07:30' : quietRaw.trim() === '' ? null : quietRaw.trim(),
    throttleHours: envInt(env.DOTD_VOICE_PUSH_THROTTLE_HOURS, 4),
    dailyCap: envInt(env.DOTD_VOICE_PUSH_DAILY_CAP, 12),
    dedupeMinutes: envInt(env.DOTD_VOICE_PUSH_DEDUPE_MIN, 30),
  };
}

/** 设备的 voice thread（每设备一条，external_ref = deviceId）。 */
export function findVoiceThreadId(db: DatabaseSync, deviceId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM mem_threads
        WHERE channel = 'voice' AND external_ref = ?
        ORDER BY last_active_at DESC LIMIT 1`,
    )
    .get(deviceId) as { id?: string } | undefined;
  return row?.id ?? null;
}

/** 取或建设备的 voice thread（与 /api/device/turn 的复用规则一致）。 */
export async function ensureVoiceThread(
  db: DatabaseSync,
  mem: MemoryPort,
  device: VoiceDevice,
): Promise<string> {
  const existing = findVoiceThreadId(db, device.id);
  if (existing !== null) return existing;
  return mem.openThread(device.dotId, 'voice', { externalRef: device.id, title: device.name });
}

export function listDevicePrefs(db: DatabaseSync, deviceId: string): DevicePref[] {
  const rows = db
    .prepare(
      `SELECT key, value, updated_at AS updatedAt FROM device_prefs
        WHERE device_id = ? ORDER BY updated_at DESC, key ASC`,
    )
    .all(deviceId) as Array<{ key: string; value: string; updatedAt: number }>;
  return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt }));
}

export function setDevicePref(
  db: DatabaseSync,
  deviceId: string,
  key: string,
  value: string,
  nowMs: number,
): DevicePref {
  db.prepare(
    `INSERT INTO device_prefs (device_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(device_id, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at`,
  ).run(deviceId, key, value, nowMs);
  return { key, value, updatedAt: nowMs };
}

export function deleteDevicePref(db: DatabaseSync, deviceId: string, key: string): boolean {
  const r = db.prepare('DELETE FROM device_prefs WHERE device_id = ? AND key = ?').run(deviceId, key);
  return Number(r.changes) > 0;
}

/** 语音侧可读的一整份记忆：会话消息 + 偏好。 */
export async function snapshotDeviceMemory(
  db: DatabaseSync,
  mem: MemoryPort,
  deviceId: string,
  opts: { limit?: number; beforeSeq?: number } = {},
): Promise<VoiceMemorySnapshot> {
  const threadId = findVoiceThreadId(db, deviceId);
  const limit = opts.limit ?? 50;
  const messages =
    threadId === null
      ? []
      : await mem.listMessages(threadId, { limit, beforeSeq: opts.beforeSeq });
  return { deviceId, threadId, messages, prefs: listDevicePrefs(db, deviceId) };
}

export interface MirrorTurnInput {
  userText: string;
  reply: string;
  /** 幂等键：同一轮重试（网络重试 / 进程重启补传）只写一次。 */
  dedupeKey?: string;
  nowMs: number;
}

/**
 * 把一轮没经过 dotd 的对话（反射/本地场景）补写进设备的 voice thread。
 *
 * 幂等：给了 `dedupeKey` 就在 surf_kv 留一条 `voice_turn:<deviceId>:<hash>`，
 * 重复调用直接返回 `{ written: false }`。dotd 自己跑出来的轮次不要调这里——
 * /api/device/turn 已经把 user 写进 mem_messages，Runner 会补 assistant。
 */
export async function mirrorDeviceTurn(
  db: DatabaseSync,
  mem: MemoryPort,
  device: VoiceDevice,
  input: MirrorTurnInput,
): Promise<{ written: boolean; threadId: string; duplicate?: boolean }> {
  const threadId = await ensureVoiceThread(db, mem, device);
  if (input.dedupeKey !== undefined && input.dedupeKey !== '') {
    const key = `voice_turn:${device.id}:${createHash('sha256').update(input.dedupeKey, 'utf8').digest('hex').slice(0, 32)}`;
    const seen = db.prepare('SELECT value FROM surf_kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    if (seen !== undefined) return { written: false, threadId, duplicate: true };
    db.prepare('INSERT INTO surf_kv (key, value, updated_at) VALUES (?,?,?)').run(
      key,
      String(input.nowMs),
      input.nowMs,
    );
  }
  if (input.userText.trim() !== '') {
    await mem.appendMessage(threadId, { role: 'user', kind: 'text', content: input.userText });
  }
  if (input.reply.trim() !== '') {
    await mem.appendMessage(threadId, { role: 'assistant', kind: 'text', content: input.reply });
  }
  return { written: true, threadId };
}

interface PushStateRow {
  last_push_at: number;
  day: string;
  day_count: number;
}

function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function logPush(
  db: DatabaseSync,
  deviceId: string,
  kind: string,
  at: number,
  allowed: boolean,
  reason: string | undefined,
  text: string,
): void {
  db.prepare(
    'INSERT INTO device_push_log (device_id, kind, at, allowed, reason, text_hash) VALUES (?,?,?,?,?,?)',
  ).run(deviceId, kind, at, allowed ? 1 : 0, reason ?? null, textHash(text));
}

/**
 * 语音主动推送的唯一决策入口。
 *
 * 顺序刻意是「便宜的先判」：总开关 → 安静时段 → 每日总量 → 同文去重 → 节流。
 * （节流与去重撞在一起时优先报 duplicate：更具体、也更好排查。）
 * 拒绝也记账，但**不推进节流状态**——被安静时段拦下的那条，不该让
 * 7:30 之后的第一条也一起被误伤。
 */
export function decideDevicePush(
  db: DatabaseSync,
  deviceId: string,
  kind: string,
  text: string,
  nowMs: number,
  day: string,
  policy: VoicePushPolicy = voicePushPolicy(),
): VoicePushDecision {
  const state = db
    .prepare(
      'SELECT last_push_at, day, day_count FROM device_push_state WHERE device_id = ? AND kind = ?',
    )
    .get(deviceId, kind) as PushStateRow | undefined;
  const lastPushAt = state?.last_push_at ?? null;

  /** 同文去重：只在「已经允许说过」的日志里找，拒绝记录不构成重复。 */
  const recentDuplicate = (): boolean => {
    if (policy.dedupeMinutes <= 0 || text.trim() === '') return false;
    const since = nowMs - policy.dedupeMinutes * 60_000;
    const dup = db
      .prepare(
        `SELECT 1 AS x FROM device_push_log
          WHERE device_id = ? AND text_hash = ? AND allowed = 1 AND at >= ? LIMIT 1`,
      )
      .get(deviceId, textHash(text), since) as { x?: number } | undefined;
    return dup !== undefined;
  };

  const base = shouldPush({
    proactive: policy.proactive,
    quietHours: policy.quietHours,
    throttleHours: policy.throttleHours,
    lastPushAt,
    now: nowMs,
    hasTarget: true,
  });
  if (!base.allowed) {
    // 同一句话被节流时，报「重复」比报「节流」更准确——主人看到的日志要说清
    // 到底是「刚才说过」还是「这一类太频繁」。
    if (base.reason === 'throttled' && recentDuplicate()) {
      const detail = `${policy.dedupeMinutes} 分钟内已经说过同样的话，不重复`;
      logPush(db, deviceId, kind, nowMs, false, 'duplicate', text);
      return { allow: false, reason: 'duplicate', detail };
    }
    const reason = (base.reason ?? 'disabled') as VoicePushReason;
    logPush(db, deviceId, kind, nowMs, false, reason, text);
    return { allow: false, reason, detail: base.detail };
  }

  if (policy.dailyCap > 0) {
    const usedToday = db
      .prepare(
        'SELECT COALESCE(SUM(day_count), 0) AS n FROM device_push_state WHERE device_id = ? AND day = ?',
      )
      .get(deviceId, day) as { n: number };
    if (usedToday.n >= policy.dailyCap) {
      const detail = `今天这台设备的主动推送已达上限（${usedToday.n}/${policy.dailyCap}）；明天再说`;
      logPush(db, deviceId, kind, nowMs, false, 'daily_cap', text);
      return { allow: false, reason: 'daily_cap', detail };
    }
  }

  if (recentDuplicate()) {
    const detail = `${policy.dedupeMinutes} 分钟内已经说过同样的话，不重复`;
    logPush(db, deviceId, kind, nowMs, false, 'duplicate', text);
    return { allow: false, reason: 'duplicate', detail };
  }

  db.prepare(
    `INSERT INTO device_push_state (device_id, kind, last_push_at, day, day_count)
     VALUES (?,?,?,?,1)
     ON CONFLICT(device_id, kind) DO UPDATE SET
       last_push_at = excluded.last_push_at,
       day = excluded.day,
       day_count = CASE WHEN device_push_state.day = excluded.day
                        THEN device_push_state.day_count + 1
                        ELSE 1 END`,
  ).run(deviceId, kind, nowMs, day);
  logPush(db, deviceId, kind, nowMs, true, undefined, text);
  return {
    allow: true,
    nextAllowedAt: policy.throttleHours > 0 ? nowMs + policy.throttleHours * 3_600_000 : undefined,
  };
}

/** 回放用：某设备最近的主动推送决策（主人问「昨天为什么没说话」时给证据）。 */
export function listDevicePushLog(
  db: DatabaseSync,
  deviceId: string,
  limit = 50,
): Array<{ kind: string; at: number; allowed: boolean; reason: string | null; textHash: string }> {
  const rows = db
    .prepare(
      `SELECT kind, at, allowed, reason, text_hash AS textHash FROM device_push_log
        WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(deviceId, limit) as Array<{
    kind: string;
    at: number;
    allowed: number;
    reason: string | null;
    textHash: string;
  }>;
  return rows.map((r) => ({
    kind: r.kind,
    at: r.at,
    allowed: r.allowed === 1,
    reason: r.reason,
    textHash: r.textHash,
  }));
}
