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
import { pushTaskScreenshots, type ScreenshotPushDeps } from './screenshot-push.ts';

/** 只需要 sendText 的能力面（真 FeishuGateway 满足；测试注 fake）。 */
export interface FeishuSendPort {
  sendText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface FeishuOutboundDeps {
  /**
   * T3（2026-10-20）：发审批卡片的能力。
   * 注入 = 审批用带按钮的卡片；不注入 = 退回纯文本（旧行为）。
   *
   * **为什么二选一而不是都发**：
   * 本文件已经订阅 approval:created 发纯文本。如果卡片另开一个订阅，
   * 同一条审批会推两次 —— 实测确认过（grep approval:created 命中 daemon 和本文件）。
   * 所以把卡片能力**注入进来**，在这里做一次判断：能发卡片就发卡片。
   */
  approvalCards?: {
    chatId: string;
    send(view: ApprovalView): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  };
  db: DatabaseSync;
  bus: EventBus;
  gateway: FeishuSendPort;
  log(msg: string): void;
  /**
   * Web 发起的任务结果要不要也推到飞书。默认 false（见 config.ts 同名说明）。
   * 不传 = false：宁可少发，也不要重复打扰 —— 漏发能在 Web 看到，重复发只能忍。
   */
  mirrorWebToFeishu?: boolean;
  /**
   * 不绑定 thread 的系统级通知（隔离、异常）发到哪（2026-10-19）。
   * 取 surfaces.feishu.owner_chat_id 的第一个；未配置则跳过这类通知。
   */
  fallbackChatId?: string | null;
  /**
   * A3（2026-10-21）：任务回复发出后，把该任务的 browser.screenshot 截图推给主人。
   * 不注入 = 不推（CLI/测试场景）。注入体见 screenshot-push.ts（daemon 装配）。
   */
  screenshotPush?: ScreenshotPushDeps;
}

/** 幂等表剪枝窗口：24h 前的已发记录清掉（与审批 TTL 同量级）。 */
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

interface TaskStatePayload {
  taskId: string;
  from: string | null;
  to: string;
}

/**
 * 这个任务的结果该不该主动说给主人（2026-10-21）。
 *
 * 数据源：tasks.source_event_id → events.payload.proactive。
 * 调度器在 fireHeartbeat 里已用 shouldPush() 判过三闸（开关/安静时段/节流），
 * 这里只是**读回那个结论**，不重算 —— 重算会因 last_push_at 已被更新而得出不同答案。
 *
 * 三种情况返回 true（照常回复）：
 *   ① 不是定时任务触发的（source_event_id 为空）—— 主人在对话，回复是应答不是打扰；
 *   ② 事件读不出来（老数据/已被清理）—— 宁可多说一句，也不要吞掉主人的回答；
 *   ③ payload 里没有 proactive 字段（老版本事件）—— 同上，向后兼容。
 *
 * 只有明确 proactive === false 才返回 false（静默）。
 */
/**
 * 飞书一条回复最多带多少字。
 *
 * 2026-10-21 实测：24 小时 44 条回复里 28 条顶到 200 字上限，
 * 库里的 assistant 正文最长 1364 字、111 条超 500 字。
 * 而这里原本是 3800 —— 等于把整篇长文原样塞进飞书。
 * 主人原话是「推送的太多了」。
 *
 * 取 600：够说完结论 + 一两条理由，再长就该去 Web 看。
 * 完整正文一个字都不丢，存在 mem_messages 里，`dotd task <id> --verbose` 可看。
 */
export const FEISHU_REPLY_MAX_CHARS = 600;

/**
 * 判断这条回复是不是「没有信息量的自我否定」。
 *
 * 现场（24h 实测）：飞书里堆着一串
 *   「I don't have `browser.open` …」
 *   「我无法执行这个请求：我的工具里没有 browser.open」
 *   「你的消息里中文变成了问号」
 * 这些**不是回答，是报错**。主人在手机上读到它们只会更困惑，
 * 而且同一件事会反复出现（同一个配置缺陷，每次触发都说一遍）。
 *
 * 判据刻意保守：只认"整条回复就是一句否认/无法执行"的开头句式。
 * **不含**任何实际结论 —— 宁可漏静音，不可吞掉真回答。
 * 宁可多发一条，也不要把有用的东西埋掉：这是这个函数的设计红线。
 */
const NOISE_PATTERNS: RegExp[] = [
  /^I (?:don't|do not|can't|cannot) (?:do|have|access|perform|execute)/i,
  /^I'm (?:not able|unable)/i,
  /^(?:我|本人)(?:没法|无法|不能|做不了|做不到|没有)/,
  /^我(?:这边)?(?:看不到|读不出|没有)/,
  /^(?:抱歉|对不起)[，,]?\s*我(?:没法|无法|不能)/,
];

export function isLowValueReply(text: string): boolean {
  const raw = text.trim();
  if (raw.length === 0) return true;
  // 长回复一定不静音：能写 400 字说明有内容，哪怕开头是否认句
  if (raw.length > 200) return false;

  // 转折词 = 模型在否认之后还是补了东西。
  // 这条判据是测试逼出来的：第一版只看「开头是否认句」，
  // 把「我无法连接那个站点，**但**我查了缓存，标题是 Example」也吞了 ——
  // 那是漏杀：人有用的信息被静音掉，比多发一条糟得多。
  const CONTRAST = /但|不过|然而|可是| nonetheless | however | but /i;
  if (CONTRAST.test(raw)) return false;

  return NOISE_PATTERNS.some((re) => re.test(raw));
}

/**
 * 把正文压到飞书能舒服读下的长度，并告诉主人全文在哪。
 *
 * 切点选在段落/句子边界，不硬切半个词：飞书里一句断在词中间比截断更难受。
 * 找不到合适的边界才退回硬切。
 */
export function clipForFeishu(text: string, maxChars = FEISHU_REPLY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  // 优先在段落处断，其次句号/问号/叹号，最后换行
  let cut = -1;
  for (const sep of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ']) {
    const i = head.lastIndexOf(sep);
    if (i > maxChars * 0.5) {
      cut = i + sep.length;
      break;
    }
  }
  const kept = cut > 0 ? text.slice(0, cut).trimEnd() : head.trimEnd();
  const left = text.length - kept.length;
  return `${kept}\n\n…（还有 ${left} 字，完整内容见 Web 会话，或用 dotd task <id> --verbose 查看）`;
}

export function shouldAnnounce(db: DatabaseSync, taskId: string): boolean {
  try {
    const row = db
      .prepare('SELECT source_event_id FROM tasks WHERE id = ?')
      .get(taskId) as { source_event_id: number | null } | undefined;
    if (row === undefined || row.source_event_id === null) return true;

    const ev = db
      .prepare("SELECT source, payload FROM events WHERE id = ?")
      .get(row.source_event_id) as { source: string; payload: string } | undefined;
    if (ev === undefined || ev.source !== 'heartbeat') return true;

    const parsed = JSON.parse(ev.payload) as { proactive?: unknown };
    // 字段缺失 → 老事件，按"该说"处理（兼容优先，不静默主人）
    if (!('proactive' in parsed)) return true;
    return parsed.proactive !== false;
  } catch {
    // 读不出来就照常回复：吞掉回答比多发一条糟糕得多
    return true;
  }
}

/** 线程渠道；读不到返回 null。 */
function threadChannel(db: DatabaseSync, threadId: string): string | null {
  try {
    const row = db.prepare('SELECT channel FROM mem_threads WHERE id = ?').get(threadId) as
      | { channel?: string }
      | undefined;
    return typeof row?.channel === 'string' ? row.channel : null;
  } catch {
    return null;
  }
}

/**
 * 这个线程的结果要不要镜像到飞书？
 *
 * web 线程 + mirror=false → 不镜像（人在 Web 看着，手机上不该再收一遍）。
 * 其余一律 true：飞书里说的要回、定时任务的走 shouldAnnounce、读不到渠道时要回
 * —— 「读不到」绝不能当成「不用发」，那会静默掉主人的回答。
 */
export function shouldMirrorToFeishu(
  db: DatabaseSync,
  threadId: string,
  mirrorWebToFeishu: boolean,
): boolean {
  if (mirrorWebToFeishu) return true;
  return threadChannel(db, threadId) !== 'web';
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
    /**
     * T3：如果给了审批单且装配层提供了卡片能力，就先试卡片。
     * 卡片带同意/拒绝按钮 —— 这是 Muse 那种"点一下就办"的体验。
     * 卡片失败才走 build() 的纯文本路径（退路必须留着）。
     */
    cardView?: ApprovalView,
    onSent?: (chatId: string) => void,
  ): Promise<void> {
    if (sent.has(key) || inflight.has(key)) return;
    inflight.add(key);
    let claimed = false;
    try {
      const cards = deps.approvalCards;
      if (cardView !== undefined && cards !== undefined) {
        const cr = await cards.send(cardView);
        if (cr.ok) {
          sent.set(key, Date.now());
          claimed = true;
          prune();
          recordOutbound(deps.db, {
            kind: 'approval_card',
            dedupKey: key,
            chatId: cards.chatId,
            ok: true,
            error: null,
            textPreview: `审批 #${cardView.id} 卡片`,
            at: new Date().toISOString(),
          });
          deps.log(`[feishu-outbound] 审批 #${cardView.id} 已发卡片`);
          return;
        }
        deps.log(`[feishu-outbound] 审批 #${cardView.id} 卡片失败（${cr.error ?? '?'}），改发纯文本`);
      }
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
          onSent?.(out.chatId);
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
    void claimAndSend(
        p.taskId,
        () => taskStateText(p),
        undefined,
        // A3：文本回复发出成功后，随单推该任务的截图（无注入则不推）。
        deps.screenshotPush === undefined
          ? undefined
          : (chatId) => {
              void pushTaskScreenshots(p.taskId, chatId, deps.screenshotPush!).catch((cause) =>
                deps.log(`[screenshot-push] 异常：${String(cause)}`),
              );
            },
      );
  });

  const unsubscribeApproval = deps.bus.on<ApprovalView>('approval:created', (ev) => {
    const view = ev.payload;
    // 优先发卡片（带同意/拒绝按钮）。发不出去才退回纯文本 —— 退路必须留着：
    // 卡片接口变更、飞书限流、群 ID 变了，都可能让卡片失败，
    // 但审批单已经在库里，主人得能通过某种方式知道"有东西要你决定"。
    void claimAndSend(`approval:${view.id}`, () => approvalText(view), view);
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

    // ── 2026-10-21：主动推送判定的**消费端**（此前判定了但没人用）──
    //
    // 现场：crontabs 的 proactive / quiet_hours / throttle_hours 三闸，
    // 在 fireHeartbeat 里由 shouldPush() 算成 payload.proactive 写进事件，
    // 然后……没有任何地方读它。实测建一条 proactive=0 和一条 proactive=1
    // 同一时刻触发，**两条都推给了主人**（surf_outbound_log 811/812）。
    // 也就是说"主动推送开关"此前完全不生效，关着的任务照样天天打扰。
    //
    // 判据：只有"定时任务触发 + 它自己判定为不推送"这一种情况才静默。
    // 其余（主人在飞书里说的话、Web 发起的、手动跑的都算）照常回 ——
    // 那些是**应答**，不是打扰，静默掉才是 bug。
    if (!shouldAnnounce(deps.db, p.taskId)) {
      deps.log(`飞书出站跳过：${p.taskId} 来自 proactive=0 的定时任务（结果只记日志）`);
      return null;
    }

    // ── 2026-10-21：Web 发起的任务不再镜像到飞书 ──
    //
    // 实测：24 小时 50 个任务里 32 个来自 Web，但 44 条回复全推了飞书。
    // 人在 Web 上看着结果，手机又收一遍 —— 这是重复，不是通知。
    // 飞书里说的（channel=feishu）照常回，那是应答。
    // 定时任务（channel=event）走上面的 shouldAnnounce 判定，不受这里影响。
    if (shouldMirrorToFeishu(deps.db, task.thread_id, deps.mirrorWebToFeishu ?? false) === false) {
      deps.log(`飞书出站跳过：${p.taskId} 来自 Web 会话（结果在 Web 看，不镜像到飞书）`);
      return null;
    }
    if (threadChat === null) {
      deps.log(`飞书出站：${p.taskId} 非飞书会话，改投默认会话 ${chatId}`);
    }
    const body = lastAssistantText(deps.db, task.thread_id, p.taskId);
    if (p.to === 'done') {
      if (body === null) {
        // 2026-10-20 修真缺陷：护栏"产品侧收口"的任务没有 assistant 正文（产品
        // 刻意不替模型写结论），此前这里直接静默跳过 —— 主人在飞书说话后收不到
        // 任何回应（163 接入当天实测连坑两次：tk_mvgn9pz1evilmd / tk_mvgp3nylxfznit）。
        // 回退：用收口 stopReason 发一条，并明确标注这是系统收口、不是模型的回答。
        const row = deps.db
          .prepare(
            "SELECT content FROM mem_messages WHERE thread_id = ? AND task_id = ? AND role = 'system' " +
              "AND content LIKE '%\"outcome\"%' ORDER BY rowid DESC LIMIT 1",
          )
          .get(task.thread_id, p.taskId) as { content: string } | undefined;
        let stop = '';
        if (row !== undefined) {
          try {
            stop = String((JSON.parse(row.content) as { stopReason?: unknown }).stopReason ?? '');
          } catch {
            // JSON 坏了就当没有，走下面的静默跳过
          }
        }
        if (stop === '') {
          deps.log(`飞书出站跳过：${p.taskId} 完成但无 assistant 正文也无收口说明`);
          return null;
        }
        return {
          chatId,
          text: `${stop}\n\n（系统收口说明：模型收尾前反复调用同一个工具、没有产出正式回复；以上面已完成的动作结果为准。可以让它再试一次。）`,
        };
      }
      // 2026-10-21：长文折叠 + 无信息量回复静音。
      // 此前 MAX_REPLY_CHARS=3800 等于原样全发（实测 28/31 条顶格），
      // 而「我没有 xx 工具」这类自我否定占了不少份额 —— 它们不是回答，是报错。
      if (isLowValueReply(body)) {
        deps.log(`飞书出站跳过：${p.taskId} 回复无信息量（只落库，可用 dotd task ${p.taskId} --verbose 看）`);
        return null;
      }
      return { chatId, text: clipForFeishu(body) };
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
