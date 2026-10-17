/**
 * src/surfaces/feishu-outbound.ts —— 任务完成后把回复发回飞书会话（出站回路）。
 *
 * 链路（全部为既有事实的只读拼接，不改任何上游）：
 *   CP queue 在状态迁移时 publish('task.state', {taskId, from, to, epoch})
 *   → 本模块订阅，命中 to ∈ {done, failed}
 *   → tasks.thread_id 弱引用 mem_threads；external_ref='feishu:oc_…' 即入站时
 *     openThread 写下的主人会话（feishu-inbound.ts 消息链）
 *   → mem_messages 取该任务在本 thread 内 seq 最大的 assistant 全文（接缝 ⑩ 落的），
 *     gateway.sendText 发回原会话。
 *
 * 纪律：
 * - 尽力而为：发送失败只落日志，绝不抛出炸总线处理器（与 runner report* 软线同款）。
 * - 防环：发送目标恒为 external_ref 解出的会话 id（= 入站来源会话），
 *   且入站侧对 bot 回声有 ignore(bot_echo) 闸门——出站消息不会被再建任务。
 * - 幂等：内存 Map 记录已发的 taskId（ daemon 重启即失，重启后已完结任务不会
 *   再迁移状态，天然不复读）；仅 24h 内条目，超时剪枝防泄漏。
 * - 只认 feishu 渠道线程；web/cli 任务的完成不外发到飞书。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';

/** 只需要 sendText 的能力面（真 FeishuGateway 满足；测试注 fake）。 */
export interface FeishuSendPort {
  sendText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface FeishuOutboundDeps {
  db: DatabaseSync;
  bus: EventBus;
  gateway: FeishuSendPort;
  log(msg: string): void;
}

/** 飞书纯文本消息实际上限很宽，但长报告截到这里，避免整篇刷屏。 */
const MAX_REPLY_CHARS = 3800;

/** 幂等表剪枝窗口：24h 前的已发记录清掉。 */
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

interface TaskStatePayload {
  taskId: string;
  from: string | null;
  to: string;
}

/** 从 mem_threads 解析飞书回复目标；非 feishu 渠道/无 external_ref → null。 */
export function feishuChatIdForThread(db: DatabaseSync, threadId: string): string | null {
  const row = db
    .prepare("SELECT channel, external_ref FROM mem_threads WHERE id = ?")
    .get(threadId) as { channel: string; external_ref: string | null } | undefined;
  if (!row || row.channel !== 'feishu') return null;
  const ref = row.external_ref ?? '';
  return ref.startsWith('feishu:') && ref.length > 'feishu:'.length ? ref.slice('feishu:'.length) : null;
}

/** 该任务在本 thread 内最后一条 assistant 正文（无则 null）。 */
export function lastAssistantText(db: DatabaseSync, threadId: string, taskId: string): string | null {
  const row = db
    .prepare(
      "SELECT content FROM mem_messages WHERE thread_id = ? AND task_id = ? AND role = 'assistant' AND kind = 'text' ORDER BY seq DESC LIMIT 1",
    )
    .get(threadId, taskId) as { content: string } | undefined;
  return row && row.content.length > 0 ? row.content : null;
}

/**
 * 装配出站订阅，返回 stop（解订）。done 发回复全文；failed 无 assistant 正文时
 * 发一行状态通知；其余终态（cancelled 由主人自己操作，知道结果）不外发。
 */
export function startFeishuOutbound(deps: FeishuOutboundDeps): () => void {
  const sent = new Map<string, number>(); // taskId -> 发送时刻
  const prune = (): void => {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const [id, ts] of sent) if (ts < cutoff) sent.delete(id);
  };

  const unsubscribe = deps.bus.on<TaskStatePayload>('task.state', (ev) => {
    const p = ev.payload;
    void (async () => {
      if (p.to !== 'done' && p.to !== 'failed') return;
      if (sent.has(p.taskId)) return;

      const task = deps.db.prepare('SELECT title, thread_id FROM tasks WHERE id = ?').get(p.taskId) as
        | { title: string; thread_id: string | null }
        | undefined;
      if (!task || task.thread_id === null) return;

      const chatId = feishuChatIdForThread(deps.db, task.thread_id);
      if (chatId === null) return; // 非飞书来源任务

      const body = lastAssistantText(deps.db, task.thread_id, p.taskId);
      const text =
        p.to === 'done'
          ? body === null
            ? null // 没有正文可回（理论不该发生）：不发空消息，留日志
            : body.length > MAX_REPLY_CHARS
              ? `${body.slice(0, MAX_REPLY_CHARS)}\n…（已截断）`
              : body
          : `任务未完成（${task.title.slice(0, 40)}）`;
      if (text === null) {
        deps.log(`飞书出站跳过：${p.taskId} 完成但无 assistant 正文`);
        return;
      }

      const res = await deps.gateway.sendText(chatId, text);
      if (res.ok) {
        sent.set(p.taskId, Date.now());
        prune();
        deps.log(`飞书出站：已回复 ${p.taskId} → ${chatId}`);
      } else {
        deps.log(`飞书出站失败：${p.taskId} ${res.error ?? '?'}`);
      }
    })().catch((cause) => deps.log(`飞书出站异常：${String(cause)}`));
  });

  return unsubscribe;
}
