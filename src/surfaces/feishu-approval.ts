/**
 * src/surfaces/feishu-approval.ts —— 审批单 → 飞书卡片（T3，2026-10-20）
 *
 * 解决什么问题：
 *   在加这个文件之前，危险工具被拦下会往 approvals 写一条 pending，
 *   然后**任务就那么卡着，没有任何通知**。主人得自己去 /approvals 看。
 *   Muse 的做法是弹出来给你点 —— 这就是差距。
 *
 * 接入点选在哪：
 *   gate.insertApproval() 结尾已经 `bus.publish('approval:created', ...)` 了。
 *   所以这里只需要**订阅那个事件**，不用改治理代码一行。
 *   为什么这么选：治理是安全边界，改它的风险最大；旁听它是零风险的。
 *
 * 失败怎么办：
 *   卡片发不出去（网络/凭据/群 ID 错）**不能影响审批本身**。
 *   审批单已经在库里，主人还能从 /approvals 处理。
 *   所以这里所有错误都只记日志，不抛。
 *
 * B1（2026-10-22，修 F5）：主人可以配**多个**会话（owner_chat_id 逗号分隔）。
 *   入站闸门早就放行全部（feishu-inbound.ts:164/214 用 Set），但出站两处硬编码
 *   `.split(',')[0]` → 第二个会话永远收不到审批，任务卡在 awaiting_approval。
 *   本文件是「多主人会话」这件事的**唯一切换点**：
 *     - `parseOwnerChatIds` —— 配置串 → 会话列表（去空/去重/保序）
 *     - `CardRegistry` —— 一个 approvalId 现在对应**多张**卡片（见类注释）
 *     - `resolveApprovalCards` —— 落定后遍历全部卡片，逐条 catch
 */
import { buildApprovalCard, buildResolvedCard } from './feishu-card.ts';
import type { ApprovalView } from '../shared/contracts.ts';

/** 只依赖发送卡片这一个能力，方便测试时替换。 */
export interface CardSender {
  sendCard(chatId: string, card: unknown): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  updateCard?(messageId: string, card: unknown): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 会话列表去空/去重/保序。
 * 入站闸门用的是 Set（只问「在不在名单里」），出站要**逐个投递**，
 * 所以必须是有顺序的数组 —— 同一个 id 被写两遍只投一次，
 * 否则主人会在同一个群里收到两张一模一样的卡片（那是重复打扰，不是广播）。
 */
export function dedupeChatIds(ids: Iterable<string> | null | undefined): string[] {
  const out: string[] = [];
  if (ids === null || ids === undefined) return out;
  for (const raw of ids) {
    const s = raw.trim();
    if (s.length > 0 && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * `surfaces.feishu.owner_chat_id` → 主人会话列表（B1/F5）。
 *
 * 为什么单独一个函数：这串切法此前在 daemon.ts 里**抄了两遍**（948 与 1678），
 * 每一遍都手滑写了 `[0]`。抄一遍一处，缺陷就只能修一处 —— 收敛到这里，
 * 装配层拿到的永远是完整列表，「只取第一个」这件事再也没有藏身处。
 */
export function parseOwnerChatIds(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return dedupeChatIds(raw.split(','));
}

export interface ApprovalCardDeps {
  sender: CardSender;
  /**
   * 主人的会话列表。空 = 不推送（如实退回旧行为，不假装发了）。
   * B1：原来这里是单个 `chatId`（装配层已经 `.split(',')[0]` 掉过）。
   * 故意留**必填**：整条 F5 的教训就是「某处少传了一段配置」，
   * 编译器逼装配层显式表态比运行时打一行日志可靠。
   * 改卡片路径用不到它（只按 message_id 打），传 [] 即可。
   */
  chatIds: string[];
  /** 日志出口。默认吞掉（生产由 daemon 注入）。 */
  log?: (line: string) => void;
  /** 拿审批单最新状态（落定后改卡片用）。 */
  getApprovalView?: (id: number) => ApprovalView | null;
}

/**
 * 把一张审批单推到**每一个**主人会话。
 * 返回成功的那些 message_id（顺序与入参 chatIds 一致，失败的不在里面）。
 *
 * 为什么是广播而不是只投第一个：Muse 那条「人保留最后一击」的前提是
 * **主人在任何一端都能看到待批事项**。少一个会话看到，就多一个任务卡死的地方。
 * 广播不会导致重复裁决：裁决写路径是 gate.decide()，它对非 pending 的单
 * 一律走「迟到裁决」分支（gate.ts:1106-1150：changes==0 ⇒ 记账、不二次执行），
 * 所以两个会话各点一次 = 一次执行 + 一条 late_decision 审计。
 *
 * 逐个会话串行发（不并发）：飞书对同一 app 有速率限制，并发投多群容易被限流，
 * 而限流会让「广播」退化成「随机丢一个」。串行慢一点，但每一条要么成要么在日志里。
 */
export async function pushApprovalCards(
  deps: ApprovalCardDeps,
  view: ApprovalView,
): Promise<string[]> {
  const ids = dedupeChatIds(deps.chatIds);
  if (ids.length === 0) {
    deps.log?.('[feishu-approval] 未配置 owner_chat_id，审批卡片不推送');
    return [];
  }
  const card = buildApprovalCard(view);
  const messageIds: string[] = [];
  for (const chatId of ids) {
    try {
      const r = await deps.sender.sendCard(chatId, card);
      if (!r.ok) {
          deps.log?.(`[feishu-approval] 卡片推送失败（审批 #${view.id} → ${chatId}）：${r.error ?? '?'}`);
        continue;
      }
      if (r.messageId !== undefined) messageIds.push(r.messageId);
      deps.log?.(`[feishu-approval] 审批 #${view.id} 已推送到 ${chatId}（${view.tier ?? '?'}）`);
    } catch (cause) {
      // 一个会话炸了不能连累其它会话 —— 主人至少要在**某个**端看到待批事项。
      deps.log?.(`[feishu-approval] 卡片推送异常（审批 #${view.id} → ${chatId}）：${String(cause)}`);
    }
  }
  return messageIds;
}


/**
 * 审批落定后把**所有**卡片改成结果，去掉按钮。
 * 失败只记日志 —— 裁决已经落库了，卡片好看与否不影响结论。
 *
 * B1（F5）的代价就在这儿：广播之后，一个 approvalId 在 N 个会话里有 N 张卡片。
 * 主人点了其中一张，另外 N-1 张**也必须改**，否则旧卡片挂着按钮，
 * 主人换个会话又点一次 —— 那是 late_decision 审计里一堆「已被抢先批准」的噪音，
 * 而且看起来像「我到底批了没有」。所以这里遍历，绝不 `for` 到第一个就 return。
 * 每条单独 catch：一条改不动（message_id 过期/被撤回）不影响其余。
 */
export async function resolveApprovalCards(
  deps: ApprovalCardDeps,
  cardMessageIds: readonly string[],
  approvalId: number,
  by: string,
): Promise<{ updated: number; failed: number }> {
  if (deps.sender.updateCard === undefined) return { updated: 0, failed: 0 };
  let view: ApprovalView | null = null;
  if (deps.getApprovalView !== undefined) view = deps.getApprovalView(approvalId);
  if (view === null) {
    deps.log?.(`[feishu-approval] 找不到审批 #${approvalId} 的最新状态，卡片不改`);
    return { updated: 0, failed: cardMessageIds.length };
  }
  const card = buildResolvedCard(view, by);
  let updated = 0;
  let failed = 0;
  for (const messageId of dedupeChatIds(cardMessageIds)) {
    try {
      const r = await deps.sender.updateCard(messageId, card);
      if (r.ok) {
        updated += 1;
      } else {
        failed += 1;
        deps.log?.(`[feishu-approval] 卡片改写失败（#${approvalId} ${messageId}）：${r.error ?? '?'}`);
      }
    } catch (cause) {
      failed += 1;
      deps.log?.(`[feishu-approval] 卡片改写异常（#${approvalId} ${messageId}）：${String(cause)}`);
    }
  }
  if (cardMessageIds.length > 1) {
    deps.log?.(`[feishu-approval] 审批 #${approvalId} 落定，已改 ${updated}/${cardMessageIds.length} 张卡片`);
  }
  return { updated, failed };
}

/** 单张卡片的旧签名（装配层若只有一张时可用；内部就是遍历长度为 1 的列表）。 */
export async function resolveApprovalCard(
  deps: ApprovalCardDeps,
  cardMessageId: string,
  approvalId: number,
  by: string,
): Promise<void> {
  await resolveApprovalCards(deps, [cardMessageId], approvalId, by);
}

/**
 * ⚠️ 这里**刻意没有**「订阅 approval:created」的封装。
 *
 * 原因（实测踩过）：feishu-outbound.ts 已经订阅了同一个事件发纯文本审批通知。
 * 我第一版在这里又开了一个订阅，结果同一条审批推两次 ——
 * grep approval:created 命中两个订阅者就是证据。
 *
 * 正确做法：卡片能力**注入**给 feishu-outbound，由它二选一（卡片优先，文本兜底），
 * 复用它已有的 claimAndSend 去重。见 daemon.ts 的 approvalCardSender。
 */

/**
 * 记账：哪个审批单对应**哪些**卡片。
 * 进程重启就丢 —— 这是**已知取舍**：重启后旧卡片按钮点了会走
 * gate 的"找不到审批单"路径并被如实拒绝，不会误执行。
 * 要持久化的话得加一张表，当前收益不值。
 *
 * B1（F5，2026-10-22）：一个 approvalId 现在对应**多张**卡片（每个主人会话一张），
 * 所以内部是 `Map<number, string[]>`。
 * - `set()` 签名不变，语义改成**幂等追加**：同一审批第二次 set 是「又多一张卡片」，
 *   同一个 message_id 重复 set 不会记两遍。装配层那行 `cardRegistry.set(view.id, r.messageId)`
 *   因此不用改一行就能收集齐 N 张卡片（广播时它对每个会话各调一次 send）。
 * - 旧的 `get()`（返回单个 message_id）**已删除**，不是留着兼容：
 *   在广播语义下「返回第一个」就是 F5 这个缺陷本身，留着它等于给漏改留个入口。
 *   要遍历请用 `getMany()`。编译期就会把任何残留调用顶回来 —— 这是刻意的。
 */
export class CardRegistry {
  private readonly map = new Map<number, string[]>();

  /** 幂等追加：登记某审批的一张卡片。 */
  set(approvalId: number, messageId: string): void {
    const list = this.map.get(approvalId);
    if (list === undefined) {
      this.map.set(approvalId, [messageId]);
      return;
    }
    if (!list.includes(messageId)) list.push(messageId);
  }

  /** 该审批的全部卡片（无则空数组）。副本，调用方改不动内部。 */
  getMany(approvalId: number): string[] {
    const list = this.map.get(approvalId);
    return list === undefined ? [] : [...list];
  }

  delete(approvalId: number): void {
    this.map.delete(approvalId);
  }

  /** 记了几条审批（不是卡片张数，卡片张数用 totalCards()）。 */
  size(): number {
    return this.map.size;
  }

  totalCards(): number {
    let n = 0;
    for (const list of this.map.values()) n += list.length;
    return n;
  }
}