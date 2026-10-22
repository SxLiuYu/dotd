/**
 * src/surfaces/daily-brief-push.ts —— 每天到点把简报发出去（D1 的发送侧）
 *
 * 为什么与 `daily-brief.ts` 分开
 *   `daily-brief.ts` 只回答「今天该说什么」，是纯函数、可单测。
 *   这个文件回答「现在该不该发、发去哪、发没发成功」，需要时钟、库与网络。
 *   混在一起会让「文案规则」被 IO 牵制（改一句话要 mock 一个数据库）。
 *
 * 三条刻意的克制（都是踩过坑的同类问题的预防）
 *   ① **一天只发一次**：判据是库里 `surf_outbound_log` 里最近一条成功简报的本地日期，
 *      不是内存变量 —— daemon 重启后不该再发一份。
 *   ② **迟到太久就不发**：`window_min`（默认 180）之外放弃。中午重启的进程
 *      在 13:00 补发一份「早间简报」，内容里的日程已经过时，是噪音不是服务。
 *   ③ **失败不静默**：每个目标会话的成败都落 `surf_outbound_log`（kind='brief'），
 *      主人问「今天怎么没收到」时查得到原因，而不是只剩一行被重启截断的日志。
 *
 * 与主动打扰三道闸的关系
 *   简报本身就是主人**显式打开**的定时打扰，所以不再套 `crontabs.proactive` 那三道闸
 *   （那是给「任务结果要不要主动说」用的）。安静时段同理：主人自己把时间定在 08:30，
 *   就不该再被一套默认安静时段改掉。这里唯一的时间约束是 `window_min`。
 */

import { briefDayKey, shouldSendBrief } from './daily-brief.ts';
import type { BriefSurfaceConfig } from './types.ts';

/** 一次发送的可注入依赖（全为函数/值，便于单测：不读库、不联网）。 */
export interface BriefPushDeps {
  cfg: BriefSurfaceConfig;
  now(): number;
  /** 库里最近一条**成功**简报是哪个本地日（'YYYY-MM-DD'）；没有则 null。 */
  lastSentDay(): string | null;
  /** 落台账（daemon 侧接 `recordOutbound`，kind='brief'）。 */
  record(r: { chatId: string; ok: boolean; error: string | null; text: string; at: string }): void;
  /** 生成正文（daemon 侧接 `buildBrief(...).text`）。 */
  buildText(nowMs: number): string;
  /** 目标会话（`chat_id` 配了就一个；否则全部主人会话）。 */
  targets(): string[];
  sendText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  log(msg: string): void;
}

/** 触发器句柄：`stop()` 停表；`tick()` 手动跑一次（测试与 `dotd brief --send` 用）。 */
export interface BriefPushHandle {
  stop(): void;
  tick(): Promise<void>;
}

/** 检查间隔：一分钟一次足够（时间是 HH:MM 粒度）。 */
export const BRIEF_TICK_MS = 60_000;

/**
 * 起一个每分钟判定一次的定时器。返回句柄由装配层在退出时 `stop()`。
 *
 * 刻意不 `unref()`：daemon 本来就常驻，`unref` 只会让「只有它在等」的场景提前退出，
 * 而那正是简报该发的时候。
 */
export function startDailyBriefPush(deps: BriefPushDeps): BriefPushHandle {
  let stopped = false;
  let running = false;

  /** 一次判定 + 发送。并发保护：上一轮还没发完就跳过（飞书慢的时候会撞）。 */
  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const nowMs = deps.now();
      const cfg = deps.cfg;
      const day = briefDayKey(nowMs);
      const decision = shouldSendBrief({
        enabled: cfg.enabled,
        time: cfg.time,
        lastSentDay: deps.lastSentDay(),
        nowMs,
        windowMin: cfg.windowMin,
      });
      if (!decision.send) {
        // 只把「主人可能想知道的」原因写日志：not_yet / already_sent 每分钟一条会刷屏
        if (decision.reason === 'too_late' || decision.reason === 'bad_time') {
          deps.log(`[brief] 今天不发：${decision.reason}（计划 ${cfg.time}，窗口 ${cfg.windowMin} 分钟）`);
        }
        return;
      }
      const text = deps.buildText(nowMs);
      if (text.trim() === '') {
        deps.log('[brief] 正文为空，跳过（不发明文等于没发）');
        return;
      }
      const targets = deps.targets();
      if (targets.length === 0) {
        deps.log('[brief] 没有可发的会话（owner_chat_id 没配）');
        return;
      }
      for (const chatId of targets) {
        let ok = false;
        let error: string | null = null;
        try {
          const r = await deps.sendText(chatId, text);
          ok = r.ok;
          error = r.ok ? null : (r.error ?? 'send_failed');
        } catch (cause) {
          ok = false;
          error = String(cause);
        }
        deps.record({ chatId, ok, error, text, at: new Date(nowMs).toISOString() });
        deps.log(`[brief] ${day} 发往 ${chatId.slice(0, 12)}… ${ok ? '成功' : '失败：' + String(error)}`);
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, BRIEF_TICK_MS);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}