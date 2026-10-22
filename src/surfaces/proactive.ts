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
 *
 * 现在这个文件服务**两条**主动路径，共用上面同一套闸（F7，2026-10-22）：
 *   cron  路径：crontabs 行的 proactive/quiet_hours/throttle_hours/last_push_at，
 *         调用点 src/control-plane/index.ts 的 fireHeartbeat（迁移 170）。
 *   事件 路径：event_push_policy(source, actor) 一行，
 *         调用点 src/control-plane/index.ts 的 ingestEvent 门面（迁移 185）。
 *   唯一口径差别：事件路径的安静时段拦在**进管线之前**（不建任务），
 *   cron 路径的安静时段本来就拦在 fireHeartbeat 里，语义一致。
 */

import type { DatabaseSync } from 'node:sqlite';

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
// ─────────────────────────────────────────────────────────────────────────
// F7（2026-10-22）：事件驱动的主动打扰
//
// 上面三道闸今天只有 cron 一条路径在用（唯一调用点 = scheduler.fireHeartbeat）。
// 于是 dotd 会"到点说话"，不会"出事说话"。这一段把同一套闸接到机器事件上。
//
// 刻意**不另写一套判定**：三道闸的算法只有 shouldPush() 一份，这里只是把
// event_push_policy 一行读成 PushGateInput。以后改安静时段/节流口径，
// cron 和事件路径必然同步，不会再出现"函数对但没人调用"那类漂移。
//
// 两条必须分开的语义（照抄 crontabs，别"为了省事统一成一种"）：
//   ① 开关 + 节流 → 拦在**发送层**：事件照常进管线、任务照常跑、结果照常进
//      记忆，只是不主动推给主人。不推送 ≠ 不执行。
//   ② 安静时段 → 拦在**调度层**：事件根本不进管线（不建任务），
//      只在策略行上留 last_fire_status='skipped_quiet'。
//      理由和 cron 一样：半夜来的事件不该换来半夜的一次任务执行。
// ─────────────────────────────────────────────────────────────────────────

/** event_push_policy 一行。列名与 crontabs 的 170 三字段一一对应。 */
export interface EventPushPolicy {
  source: string;
  actor: string;
  /** 0 = 结果不主动推给主人（默认关）。 */
  enabled: number;
  /** 'HH:MM-HH:MM'，可跨午夜；null = 无安静时段。 */
  quiet_hours: string | null;
  /** 0 = 不节流。 */
  throttle_hours: number;
  /** epoch ms；null = 从没推过。**来自库里**，重启不失效。 */
  last_push_at: number | null;
  last_fire_at: number | null;
  /** 'fired' | 'skipped_quiet'，词表同 crontabs.last_fire_status。 */
  last_fire_status: string | null;
}

/** 一次事件进门的多层判定结果。 */
export interface EventPushDecision {
  /**
   * 闸门是否介入这次事件。
   * false = (source, actor) 从没配过策略行 → **payload 原样透传**，
   * 保持升级前的行为。宁可按今天这样（不主动变化），也不要让"没配过"
   * 变成"突然变哑"：吞掉主人已经在收的东西比少发一条糟得多。
   */
  intervenes: boolean;
  /** 事件该不该进管线（= 会不会建任务）。只有安静时段是 false。 */
  ingest: boolean;
  /** 结果该不该主动推给主人。写进 payload.proactive 给下游 shouldAnnounce 读。 */
  announce: boolean;
  /** 要不要把 last_push_at 更新到本时刻（只有真放行才更新）。 */
  markPushAt: boolean;
  /** 记到 last_fire_status：进管线 = fired，安静时段 = skipped_quiet。 */
  fireStatus: 'fired' | 'skipped_quiet';
  /** 拒绝原因码；放行时为空。 */
  reason?: PushDecision['reason'];
  /** 人话解释，写日志用。 */
  detail?: string;
}

/**
 * 纯函数：给定策略行 + 当前时刻，判这次事件怎么处置。
 *
 * 三闸的顺序、口径全部委托 shouldPush() —— 包括"先查开关再查安静时段再查节流"
 * 这条日志可读性约定。唯一的差别在这里的安静时段是**拦进管线**（ingest=false），
 * 而 shouldPush 只能答"推不推"。
 */
export function decideEventPush(input: {
  policy: EventPushPolicy | null;
  now: number;
  /** 有没有可发的目标会话。与 cron 路径同口径：那里拿不到 surfaces 配置，恒真不误拒。 */
  hasTarget?: boolean;
  /** 主人显式要求这次必须说话（例如事件由主人的请求派生）。越过①③，不越过②。 */
  force?: boolean;
}): EventPushDecision {
  const { policy, now } = input;
  if (policy === null) {
    return { intervenes: false, ingest: true, announce: true, markPushAt: false, fireStatus: 'fired' };
  }
  // ② 安静时段：拦在调度层。这里**先判**而不是交给 shouldPush，
  // 因为要的结果不是"不推送"而是"不进门"。安静时段优先于 force：
  // 主人设了安静时段就是明确说了那段时间别吵，任何事件都不该例外。
  if (isInQuietHours(policy.quiet_hours, now)) {
    return {
      intervenes: true,
      ingest: false,
      announce: false,
      markPushAt: false,
      fireStatus: 'skipped_quiet',
      reason: 'quiet_hours',
      detail: `事件落在安静时段 ${policy.quiet_hours ?? ''} 内，不进管线`,
    };
  }
  const gate = shouldPush({
    proactive: policy.enabled === 1,
    quietHours: policy.quiet_hours, // 已判过 false，这里只是复用同一份实现
    throttleHours: policy.throttle_hours,
    lastPushAt: policy.last_push_at,
    now,
    hasTarget: input.hasTarget ?? true,
  });
  if (gate.allowed || (input.force === true && gate.reason === 'throttled')) {
    // force 只顶开节流，不顶开"没开开关"和"没目标"：
    // 前者是主人的设置，后者是发不出去，强行放行只会留一条注定失败的推送。
    return { intervenes: true, ingest: true, announce: true, markPushAt: true, fireStatus: 'fired' };
  }
  // ①③ 开关与节流：事件**照常进管线**（任务照跑、结果进记忆），只是不推送。
  return {
    intervenes: true,
    ingest: true,
    announce: false,
    markPushAt: false,
    fireStatus: 'fired',
    reason: gate.reason,
    detail: gate.detail,
  };
}

/** 读策略行。表还没建（老库/半途迁移）时当"没配过"处理，不能让闸门把整条链路搞崩。 */
export function readEventPushPolicy(
  db: DatabaseSync,
  source: string,
  actor: string,
): EventPushPolicy | null {
  try {
    const row = db
      .prepare('SELECT * FROM event_push_policy WHERE source = ? AND actor = ?')
      .get(source, actor) as EventPushPolicy | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * 落库这轮事件的两类账：
 *   last_fire_at / last_fire_status —— 每次进门都写（安静时段也要留下"拦过"的证据）
 *   last_push_at —— **只在真放行时写**，节流命中绝不能更新它，
 *     否则每次被拦住都把窗口往后推，低频事件永远推不出去（滑动窗口 bug）。
 * 表不存在/写失败一律吞掉：记账失败不该让一条事件进不来。
 */
export function recordEventFire(
  db: DatabaseSync,
  source: string,
  actor: string,
  d: EventPushDecision,
  now: number,
): void {
  if (!d.intervenes) return;
  try {
    if (d.markPushAt) {
      db.prepare(
        `UPDATE event_push_policy
            SET last_push_at = ?, last_fire_at = ?, last_fire_status = ?, updated_at = ?
          WHERE source = ? AND actor = ?`,
      ).run(now, now, d.fireStatus, now, source, actor);
    } else {
      db.prepare(
        `UPDATE event_push_policy
            SET last_fire_at = ?, last_fire_status = ?, updated_at = ?
          WHERE source = ? AND actor = ?`,
      ).run(now, d.fireStatus, now, source, actor);
    }
  } catch {
    // 记不上不影响事件本身
  }
}