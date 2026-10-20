/**
 * src/surfaces/proactive.ts —— 主动发起对话的闸门（T4，2026-10-20）
 *
 * 要解决什么问题
 *   dotd 早就能在主人没说话时发起任务（定时任务、心跳、事件规则），
 *   结果也能发回飞书（feishu-outbound 的 fallbackChatId 兜底）。
 *   真正缺的是**克制**：一个 15 分钟跑一次的定时任务，如果每次都推一条，
 *   主人一天收 96 条，然后就会把所有通知静音 —— 主动能力就废了。
 *
 *   Muse 的报道里有个反复出现的细节：记者喜欢它主动提醒，但如果太吵就会关掉。
 *   所以"能主动说话"和"该不该现在说话"是两件事，这个文件管后者。
 *
 * 三道闸，按成本从低到高：
 *   ① 开关      proactive = 0 → 不推。默认关，升级后不会突然开始发消息。
 *   ② 安静时段  quiet_hours 内 → 不推（crontabs 表早就有这个字段，这里是复用）。
 *   ③ 节流      同一任务 throttle_hours 内最多推一次。
 *
 * 为什么闸门放在"发送之前"而不是"任务创建时"
 *   任务本身该跑就跑（它的结果可能仍然有用，比如写进记忆、更新文件）。
 *   只是**不打扰主人**。把不推送做成"不执行任务"会让沉默变成功能缺失。
 */

/** 一次发送决策的结果。reason 是给日志看的，不是给主人看的。 */
export interface PushDecision {
  allowed: boolean;
  /** 不允许时的原因码。允许时为空。 */
  reason?: 'disabled' | 'quiet_hours' | 'throttled' | 'no_target';
  /** 人话解释，写日志/回放用。 */
  detail?: string;
}

/** 判定需要的输入。全部来自 crontabs 一行 + 当前时间。 */
export interface PushGateInput {
  /** crontabs.proactive */
  proactive: boolean;
  /** crontabs.quiet_hours，如 '23:00-07:30'。null = 无安静时段。 */
  quietHours: string | null;
  /** crontabs.throttle_hours。0 = 不节流。 */
  throttleHours: number;
  /** crontabs.last_push_at（epoch ms）。null = 从没推过。 */
  lastPushAt: number | null;
  /** 当前时刻（epoch ms）。传进来而不是内部取，为了可测。 */
  now: number;
  /** 有没有可发的目标会话。 */
  hasTarget: boolean;
}

/**
 * 解析 'HH:MM-HH:MM' 为分钟数区间。
 *
 * 支持跨午夜（'23:00-07:30' 是**跨天**的，不是无效区间）。
 * 这是安静时段最常见的形态 —— 主人睡觉时间就是跨午夜的。
 * 返回 null 表示格式不对；调用方按"没有安静时段"处理并记日志。
 */
export function parseQuietHours(spec: string): { startMin: number; endMin: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (m === null) return null;
  const h1 = Number(m[1]);
  const m1 = Number(m[2]);
  const h2 = Number(m[3]);
  const m2 = Number(m[4]);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { startMin: h1 * 60 + m1, endMin: h2 * 60 + m2 };
}

/**
 * 当前时刻是否落在安静时段内。
 *
 * 跨午夜的处理：start > end 时区间是 [start, 24:00) ∪ [00:00, end]。
 * 写错这里会让安静时段完全失效或整天都在安静 —— 所以单测盯得比较紧。
 */
export function isInQuietHours(spec: string | null, nowMs: number): boolean {
  if (spec === null || spec.trim() === '') return false;
  const range = parseQuietHours(spec);
  if (range === null) return false;
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  const { startMin, endMin } = range;
  if (startMin === endMin) return false; // 空区间，不静音
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  // 跨午夜
  return cur >= startMin || cur < endMin;
}

/**
 * 三道闸的合流判定。
 *
 * 顺序是有讲究的：**先查开关**（最便宜、也是最常见的拒绝理由），
 * 再查安静时段，最后查节流。这样日志里出现"为什么没推"时，
 * 原因总是最根本的那个 —— 一个没开主动推送的任务，
 * 不该在日志里留下"被节流"这种让人误会的话。
 */
export function shouldPush(input: PushGateInput): PushDecision {
  if (!input.hasTarget) {
    return { allowed: false, reason: 'no_target', detail: '没有可发的会话（owner_chat_id 没配）' };
  }
  if (!input.proactive) {
    return { allowed: false, reason: 'disabled', detail: '该定时任务未开启主动推送' };
  }
  if (isInQuietHours(input.quietHours, input.now)) {
    return {
      allowed: false,
      reason: 'quiet_hours',
      detail: `落在安静时段 ${input.quietHours ?? ''} 内`,
    };
  }
  if (input.throttleHours > 0 && input.lastPushAt !== null) {
    const elapsedH = (input.now - input.lastPushAt) / 3_600_000;
    if (elapsedH < input.throttleHours) {
      const left = (input.throttleHours - elapsedH).toFixed(1);
      return {
        allowed: false,
        reason: 'throttled',
        detail: `距上次推送 ${elapsedH.toFixed(1)} 小时，还需等 ${left} 小时`,
      };
    }
  }
  return { allowed: true };
}