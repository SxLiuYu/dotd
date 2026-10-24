/**
 * src/surfaces/device-usage.ts —— 设备用量记账（阶段 3 第 4 条「每日配额」）。
 *
 * 为什么只有 token 在这里记、分钟不在这里记：
 *   音频不进 dotd（ASR/TTS 在 Charlie 侧），dotd 看不到真实音频时长。它能精确看到的
 *   是每次设备任务消耗的模型 token；TTS 时长用「字符数」近似（迁移 210 的 chars）。
 *
 * 幂等的关键：
 *   任务会重跑/恢复，`task.state` 的终态事件不止一次；`tasks.usage_tokens` 是累计值。
 *   所以按 task_id 记一份账本（device_token_ledger），每次只把**增量**加进
 *   `device_usage.tokens` —— 同一任务无论终态事件发生几次，只计一次。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 本地日期 `YYYY-MM-DD`（额度和主人的时区一致，不用 UTC 切日）。 */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DeviceTokenAccount {
  /** 这个任务有没有找到归属设备（非语音任务 → false，属正常情况）。 */
  attributed: boolean;
  /** 任务累计 token（来自 tasks.usage_tokens）。 */
  tokens: number;
  /** 本次真正加进 device_usage 的增量。 */
  delta: number;
  deviceId: string | null;
  day: string | null;
}

/**
 * 把一个任务的模型用量计到它所属的设备上（幂等）。
 *
 * 调用时机：`task.state` 到终态（done/failed/cancelled）时。任务不是语音任务
 * （thread 没有 `external_ref`）时什么都不做。
 */
export function accountDeviceTaskTokens(
  db: DatabaseSync,
  taskId: string,
  nowMs: number = Date.now(),
): DeviceTokenAccount {
  const row = db
    .prepare(
      `SELECT t.usage_tokens AS tokens, th.external_ref AS deviceId
         FROM tasks t
         JOIN mem_threads th ON th.id = t.thread_id
        WHERE t.id = ?`,
    )
    .get(taskId) as { tokens?: number | null; deviceId?: string | null } | undefined;
  const deviceId = typeof row?.deviceId === 'string' && row.deviceId.length > 0 ? row.deviceId : null;
  if (row === undefined || deviceId === null) {
    return { attributed: false, tokens: 0, delta: 0, deviceId: null, day: null };
  }

  const tokens = Math.max(0, Math.floor(Number(row.tokens ?? 0)));
  const prevRow = db.prepare('SELECT tokens FROM device_token_ledger WHERE task_id = ?').get(taskId) as
    | { tokens?: number }
    | undefined;
  const prev = Math.max(0, Math.floor(Number(prevRow?.tokens ?? 0)));
  const delta = tokens - prev;
  const day = localDay(nowMs);
  if (delta <= 0) return { attributed: true, tokens, delta: 0, deviceId, day };

  db.prepare(
    `INSERT INTO device_token_ledger (task_id, device_id, day, tokens, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET
       device_id = excluded.device_id,
       day = excluded.day,
       tokens = excluded.tokens,
       updated_at = excluded.updated_at`,
  ).run(taskId, deviceId, day, tokens, nowMs);

  db.prepare(
    `INSERT INTO device_usage (device_id, day, tasks, chars, tokens, updated_at) VALUES (?,?,0,0,?,?)
     ON CONFLICT(device_id, day) DO UPDATE SET
       tokens = tokens + excluded.tokens,
       updated_at = excluded.updated_at`,
  ).run(deviceId, day, delta, nowMs);

  return { attributed: true, tokens, delta, deviceId, day };
}
