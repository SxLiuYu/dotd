/**
 * src/surfaces/feishu-outbound.ts —— 把重要进展发回飞书会话（出站回路）。
 *
 * 链路（全部为既有事实的只读拼接，不改任何上游）：
 *   ① 任务终态：CP queue 在状态迁移时 publish('task.state', {taskId, from, to, epoch})
 *      → 本模块订阅，命中 to ∈ {done, failed}
 *      → tasks.thread_id 弱引用 mem_threads；external_ref='feishu:oc_…' 即入站时
 *        openThread 写下的主人会话（feishu-inbound.ts 消息链）
 *      → mem_messages 取该任务在本 thread 内 seq 最大的 assistant 全文（接缝 ⑩ 落的），
 *        gateway.sendText 发回原会话。
 *   ② 需要主人裁决：GOV gate 在落 approval 行后 publish('approval:created', ApprovalView)
 *      → 本模块订阅，解析该审批所属任务的 thread → 发一条**可直接照着回**的审批卡片。
 *
 * 为什么一定要有 ②：审批的 TTL 是 24h，而任务在 awaiting_approval 时 Runner 让位、
 * 整个任务就这么停着。原先出站只订阅 task.state 的 done/failed，于是"要你批准"
 * 这件事在飞书里完全静默——主人在手机上看不到任何东西，24 小时后审批过期、任务作废。
 * 这正是"自主"看起来不自主的头号原因（对标 OpenAI/Grok 的 agent 都会主动追问）。
 *
 * 纪律：
 * - 尽力而为：发送失败只落日志，绝不抛出炸总线处理器（与 runner report* 软线同款）。
 * - 防环：发送目标恒为 external_ref 解出的会话 id（= 入站来源会话），
 *   且入站侧对 bot 回声有 ignore(bot_echo) 闸门——出站消息不会被再建任务。
 * - 幂等：内存 Map 记录已发的键（taskId / approval:<id>），daemon 重启即失；
 *   重启后已完结任务不会再迁移状态、已创建的审批不会再 publish，天然不复读。
 *   仅 24h 内条目，超时剪枝防泄漏。
 * - 只认 feishu 渠道线程；web/cli 任务的进展不外发到飞书。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalView } from '../shared/contracts.ts';
import type { EventBus } from '../shared/bus.ts';
import { renderQuarantineNotice } from '../governance/review.ts';

/** 只需要 sendText 的能力面（真 FeishuGateway 满足；测试注 fake）。 */
export interface FeishuSendPort {
  sendText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface FeishuOutboundDeps {
  db: DatabaseSync;
  bus: EventBus;
  gateway: FeishuSendPort;
  log(msg: string): void;
  /**
   * 不绑定 thread 的系统级通知（隔离、异常）发到哪（2026-10-19）。
   * 取 surfaces.feishu.owner_chat_id 的第一个；未配置则跳过这类通知。
   */
  fallbackChatId?: string | null;
}

/** 飞书纯文本消息实际上限很宽，但长报告截到这里，避免整篇刷屏。 */
const MAX_REPLY_CHARS = 3800;

/** 幂等表剪枝窗口：24h 前的已发记录清掉（与审批 TTL 同量级）。 */
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
 * 审批卡片文案（导出给测试断言，也让"措辞"变成可评审的契约）。
 *
 * 写法原则（对标 OpenAI/Grok 的追问式交互）：
 *   1. 第一行说清"要你决定什么"，不先说内部术语；
 *   2. 第二段说"批准后会发生什么"——主人真正在怕的是这个；
 *   3. 最后给出**可以原样回复的命令**，不要让人去翻文档找语法。
 */
export function renderApprovalCard(view: ApprovalView, taskTitle: string | null): string {
  const what = view.summary.length > 0 ? view.summary : String(view.kind);
  const expiry = formatExpiry(view.expiresAt);
  const head = taskTitle !== null && taskTitle.length > 0 ? `需要你批准一件事（任务：${taskTitle.slice(0, 40)}）` : '需要你批准一件事';
  const lines = [head, '', `要做的操作：${what}`];
  if (view.tier !== null) lines.push(`风险档位：${view.tier}`);
  if (view.reason.length > 0) lines.push(`为什么被拦下：${view.reason.slice(0, 300)}`);
  lines.push(`最晚决定时间：${expiry}（过期自动作废，任务要重来）`);
  lines.push('');
  lines.push(`回复「批准 ${view.id}」放行一次；回复「记住 ${view.id}」以后同类操作不再问；回复「拒绝 ${view.id}」放弃。`);
  lines.push('（也可以直接在电脑上 `npm run dotd -- approve ' + String(view.id) + '`）');
  return lines.join('\n');
}

/** ISO 时间 → "还有 X 小时" 之类的可读说法；解析失败原样返回。 */
export function formatExpiry(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const left = t - Date.now();
  if (left <= 0) return '已过期';
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  return hours > 0 ? `还有约 ${hours} 小时 ${minutes} 分` : `还有约 ${minutes} 分钟`;
}

/** 该审批属于哪个任务（approvals 表有 taskId；拿它的标题用于卡片）。 */
function taskTitleOf(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as
    | { title: string | null }
    | undefined;
  return row?.title ?? null;
}

/** 审批所属任务的 thread（用于解析飞书会话）。 */
function threadIdOfTask(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare('SELECT thread_id FROM tasks WHERE id = ?').get(taskId) as
    | { thread_id: string | null }
    | undefined;
  return row?.thread_id ?? null;
}

/**
 * 装配出站订阅，返回 stop（解订）。三路：
 * - task.state done：发回复全文；
 * - task.state failed：无 assistant 正文时发一行状态通知；
 * - approval:created：发审批卡片（这是"卡住时有人叫醒你"的唯一通道）。
 * 其余终态（cancelled 由主人自己操作，知道结果）不外发。
 */
export function startFeishuOutbound(deps: FeishuOutboundDeps): () => void {
  const sent = new Map<string, number>(); // 去重键 -> 发送时刻
  /**
   * 正在发但还没落 entry 的键。
   *
   * 为什么必需：bus 的 handler 是 **fire-and-forget**（bus.ts:37「总线不等待异步 handler」），
   * 同一 tick 内连投两次 approval:created 会起两个并发发送协程，两边都还没走到
   * `sent.set`（都在 await sendText）→ 两条都发出去。只靠 sent Map 防不住。
   */
  const inflight = new Set<string>();
  const prune = (): void => {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const [id, ts] of sent) if (ts < cutoff) sent.delete(id);
  };

  /**
   * 认领 + 发送 + 落键。三条纪律在这里一次性落实：
   * - 去重：已发的键、正在发的键都直接返回（同 tick 重投会起并发协程，只靠 sent 防不住）；
   * - 尽力而为：发送失败只落日志、**不落键**，让下一次同态事件还有机会补发；
   * - 不炸总线：任何异常都吞成日志（handler 是 fire-and-forget，抛出去没人接）。
   */
  async function claimAndSend(
    key: string,
    build: () => Promise<{ chatId: string; text: string } | null>,
  ): Promise<void> {
    if (sent.has(key) || inflight.has(key)) return;
    inflight.add(key);
    let claimed = false;
    try {
      const out = await build();
      if (out === null) return;
      const res = await deps.gateway.sendText(out.chatId, out.text);
      // **落库**（2026-10-19）：原来出站只写日志，而日志在 daemon 重启时会被清空
      // （wsl-daemon.sh 用 `: > "$LOG"`）。结果"这条任务到底回没回主人、发到哪个会话"
      // 事后完全查不到 —— 主人问"我没收到回复"时无从回答。
      // 落一张小表，成功失败都记。
      recordOutbound(deps.db, {
        kind: 'task_reply',
        dedupKey: key,
        chatId: out.chatId,
        ok: res.ok,
        error: res.error ?? null,
        textPreview: out.text.slice(0, 200),
        at: new Date().toISOString(),
      });
      if (res.ok) {
        sent.set(key, Date.now());
        claimed = true;
        prune();
        deps.log(`飞书出站：已发送 ${key} → ${out.chatId}`);
      } else {
        deps.log(`飞书出站失败：${key} ${res.error ?? '?'}`);
      }
    } catch (cause) {
      deps.log(`飞书出站异常：${key} ${String(cause)}`);
    } finally {
      if (!claimed) inflight.delete(key);
    }
  }

  const unsubscribeTask = deps.bus.on<TaskStatePayload>('task.state', (ev) => {
    const p = ev.payload;
    if (p.to !== 'done' && p.to !== 'failed') return;
    void claimAndSend(p.taskId, () => taskStateText(p));
  });

  const unsubscribeApproval = deps.bus.on<ApprovalView>('approval:created', (ev) => {
    const view = ev.payload;
    void claimAndSend(`approval:${view.id}`, () => approvalText(view));
  });

  /**
   * **Dot 被隔离时通知主人**（2026-10-19 实测发现：这个事件一个订阅者都没有）。
   *
   * 现场：容器因 recreate_count>3/24h 被隔离后，**所有依赖容器的任务都失败**，
   * 而主人从飞书那边只会看到"任务莫名其妙失败"，完全不知道发生了什么。
   * 事件 governance:quarantine 早就发了，但没有任何人订阅——典型的"接线漏了"。
   */
  const unsubscribeQuarantine = deps.bus.on<{
    dotId: string;
    decisionId: string;
    approvalId: number | null;
    reason: string;
  }>('governance:quarantine', (ev) => {
    const q = ev.payload;
    void claimAndSend(`quarantine:${q.dotId}:${q.decisionId}`, async () => {
      // 隔离通知发给主人默认会话（它不绑定某个 thread，走配置里的 owner chat）
      const chatId = deps.fallbackChatId ?? null;
      if (chatId === null) {
        deps.log(`隔离通知跳过：未配置 fallback chat（dot=${q.dotId}）`);
        return null;
      }
      const text = renderQuarantineNotice(q.dotId, q.decisionId, q.reason);
      return { chatId, text: `${text}\n\n（这条由系统主动发出：dot 已暂停，需要人工复核后解除）` };
    });
  });

  /** task.state 的文案（含发送目标解析）；不需要发时返回 null。 */
  async function taskStateText(p: TaskStatePayload): Promise<{ chatId: string; text: string } | null> {
    const task = deps.db.prepare('SELECT title, thread_id FROM tasks WHERE id = ?').get(p.taskId) as
      | { title: string; thread_id: string | null }
      | undefined;
    if (!task || task.thread_id === null) return null;
// **回退到主人默认会话**（2026-10-19 实测发现的定时任务缺口）：
    // 定时触发的任务挂在 channel='event' 的线程上（external_ref=null），
    // feishuChatIdForThread 返回 null → 出站直接跳过 → **主人永远收不到定时任务的结果**。
    // 而"定时提醒"的全部意义就是主动告诉主人，发不出去等于没做。
    //
    // 判据：线程不是飞书来源（event/web）时，回退到 surfaces.feishu.owner_chat_id 的第一个。
    // 这不会误伤：真正的飞书会话仍按 chat_id 精确回原会话。
    const threadChat = feishuChatIdForThread(deps.db, task.thread_id);
    const chatId = threadChat ?? deps.fallbackChatId ?? null;
    if (chatId === null) return null;
    if (threadChat === null) {
      deps.log(`飞书出站：${p.taskId} 非飞书会话，改投默认会话 ${chatId}`);
    }
    const body = lastAssistantText(deps.db, task.thread_id, p.taskId);
    if (p.to === 'done') {
      if (body === null) {
        deps.log(`飞书出站跳过：${p.taskId} 完成但无 assistant 正文`);
        return null;
      }
      return {
        chatId,
        text: body.length > MAX_REPLY_CHARS ? `${body.slice(0, MAX_REPLY_CHARS)}\n…（已截断）` : body,
      };
    }
    return { chatId, text: `任务未完成（${task.title.slice(0, 40)}）` };
  }

  /** approval:created 的文案（审批属于哪个任务 → 该任务的会话）。 */
  async function approvalText(view: ApprovalView): Promise<{ chatId: string; text: string } | null> {
    const taskId = view.taskRef?.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) return null; // 合成审批（无任务）不外发
    const threadId = threadIdOfTask(deps.db, taskId);
    if (threadId === null) return null;
    const chatId = feishuChatIdForThread(deps.db, threadId);
    if (chatId === null) return null; // 非飞书来源任务：主人就在电脑前，Web UI 会亮
    return { chatId, text: renderApprovalCard(view, taskTitleOf(deps.db, taskId)) };
  }

  return () => {
    unsubscribeTask();
    unsubscribeApproval();
  };
}

/**
 * 记录一条出站消息（2026-10-19）。
 *
 * **为什么不落库不行**：出站原来只写日志，而日志在 daemon 重启时被清空。
 * 主人说"我没收到回复"时，需要能回答：这条回没回、发到哪个会话、失败原因是什么。
 *
 * 尽力而为：写库失败不能影响发送本身（它只是审计，不是关键路径）。
 */
export function recordOutbound(
  db: DatabaseSync | undefined,
  row: {
    kind: string;
    dedupKey: string;
    chatId: string;
    ok: boolean;
    error: string | null;
    textPreview: string;
    at: string;
  },
): void {
  if (db === undefined) return;
  try {
    db.prepare(
      `INSERT INTO surf_outbound_log (kind, dedup_key, chat_id, ok, error, text_preview, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.kind,
      row.dedupKey,
      row.chatId,
      row.ok ? 1 : 0,
      row.error,
      row.textPreview,
      row.at,
    );
    // 只留最近 2000 条（约一周量级），防无限增长
    db.prepare(
      `DELETE FROM surf_outbound_log WHERE id <= (SELECT MAX(id) FROM surf_outbound_log) - 2000`,
    ).run();
  } catch {
    // 审计写失败不影响发送
  }
}

/** 读出站审计（最近的 N 条，可按 kind 过滤）。 */
export function listOutbound(
  db: DatabaseSync,
  opts: { limit?: number; kind?: string } = {},
): Array<{
  id: number;
  kind: string;
  chatId: string;
  ok: boolean;
  error: string | null;
  textPreview: string;
  at: string;
}> {
  const limit = opts.limit ?? 20;
  const rows = (
    opts.kind === undefined
      ? db.prepare(
          `SELECT id, kind, chat_id, ok, error, text_preview, at FROM surf_outbound_log ORDER BY id DESC LIMIT ?`,
        ).all(limit)
      : db.prepare(
          `SELECT id, kind, chat_id, ok, error, text_preview, at FROM surf_outbound_log WHERE kind = ? ORDER BY id DESC LIMIT ?`,
        ).all(opts.kind, limit)
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r['id']),
    kind: String(r['kind']),
    chatId: String(r['chat_id']),
    ok: Number(r['ok']) === 1,
    error: r['error'] === null ? null : String(r['error']),
    textPreview: String(r['text_preview']),
    at: String(r['at']),
  }));
}
