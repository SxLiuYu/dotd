/**
 * src/surfaces/connection-watch-push.ts —— 看门狗的定时器与发送侧
 *
 * 与 `connection-watch.ts` 的分工和简报那边一致：
 *   `connection-watch.ts` 是纯函数（判该说什么），本文件管「什么时候看、发去哪、存哪」。
 *
 * 状态存哪
 *   `surf_kv`（key = `connwatch:<dotId>`）。为什么不用内存：daemon 一重启，
 *   「已经报过的问题」就忘了，主人会收到同一句话第二次。库里的值用
 *   `connection-watch.ts` 的 `encodeState` 编码（指纹 + 名字），所以恢复通知
 *   也能说出人名而不是 `1/http://…` 这种 key。
 */

import {
  hhmmOf,
  inQuietHours,
  judgeWatch,
  renderProblemMessage,
  renderRecoveredMessage,
  watchSubjects,
} from './connection-watch.ts';
import type { ConnectionWatchConfig } from './connection-watch.ts';
import type { ConnectionRow } from './connections.ts';

export interface ConnectionWatchDeps {
  cfg: ConnectionWatchConfig;
  now(): number;
  /** 当前总览行（daemon 侧接 `buildConnectionsView`）。 */
  rows(): ConnectionRow[];
  /** 读上次落库的状态（key → encodeState 值）；没有则空对象。 */
  loadState(): Record<string, string>;
  /** 落库（**每次判定后都调**，哪怕没话说，否则「已说过」会丢）。 */
  saveState(state: Record<string, string>): void;
  /** 目标会话（全部主人会话）。 */
  targets(): string[];
  sendText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  record(r: { chatId: string; ok: boolean; error: string | null; text: string; at: string }): void;
  log(msg: string): void;
}

export interface ConnectionWatchHandle {
  stop(): void;
  /** 手动跑一次（测试用；也方便将来加 `dotd connections --watch`）。 */
  tick(): Promise<void>;
}

export function startConnectionWatch(deps: ConnectionWatchDeps): ConnectionWatchHandle {
  let stopped = false;
  let running = false;

  async function tick(): Promise<void> {
    if (stopped || running) return;
    if (!deps.cfg.enabled) return;
    running = true;
    try {
      const nowMs = deps.now();
      const inQuiet = inQuietHours(hhmmOf(nowMs), deps.cfg.quietHours);
      let rows: ConnectionRow[];
      try {
        rows = deps.rows();
      } catch (cause) {
        // 连「查总览」都失败了：这不是某条连接的问题，是 daemon 自己的问题。
        // 只记日志，不推送 —— 否则可能每分钟推一次同样的故障。
        deps.log(`[connwatch] 取连接总览失败，本轮跳过：${String(cause)}`);
        return;
      }
      const verdict = judgeWatch(watchSubjects(rows), deps.loadState());
      // 先落库再推送：推送慢/失败时也不能把「已报告」丢掉，否则下一轮重复报。
      deps.saveState(verdict.next);
      if (inQuiet) {
        if (verdict.problem.length > 0 || verdict.recovered.length > 0) {
          deps.log(`[connwatch] 安静时段（${deps.cfg.quietHours?.start}-${deps.cfg.quietHours?.end}），本轮不推`);
        }
        return;
      }
      const pieces: string[] = [];
      const problemMsg = renderProblemMessage(verdict.problem, nowMs);
      if (problemMsg !== '') pieces.push(problemMsg);
      const recoveredMsg = renderRecoveredMessage(verdict.recovered, nowMs);
      if (recoveredMsg !== '') pieces.push(recoveredMsg);
      if (pieces.length === 0) return;
      const text = pieces.join('\n\n');
      const targets = deps.targets();
      if (targets.length === 0) {
        deps.log('[connwatch] 没有可发的会话（owner_chat_id 没配）');
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
        deps.log(
          `[connwatch] 发往 ${chatId.slice(0, 12)}… ${ok ? '成功' : '失败：' + String(error)}` +
            `（问题 ${verdict.problem.length} / 恢复 ${verdict.recovered.length}）`,
        );
      }
    } finally {
      running = false;
    }
  }

  // interval_min 下限 1 分钟：配 0 会变成 busy loop。
  const everyMs = Math.max(1, deps.cfg.intervalMin) * 60_000;
  const timer = setInterval(() => {
    void tick();
  }, everyMs);

  // 启动即跑一次：不然进程刚起来的那 `interval_min` 分钟是盲的 —— 上一次宕机
  // 期间坏掉的连接要等满 15 分钟才被告知。
  //
  // 用 queueMicrotask 而不是直接 void tick()：tick 的第一步就是同步落库，
  // 直接调会让 startConnectionWatch **返回时**状态已经变了，调用方（含测试）
  // 拿到的初值就不是它以为的那个。推迟一拍既保住「启动即查」，也不改动
  // 同步返回的语义。不 await：首轮异常只该记日志，不该拖住启动。
  queueMicrotask(() => { void tick(); });

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}