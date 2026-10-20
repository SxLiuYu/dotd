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
 */
import { buildApprovalCard, buildResolvedCard } from './feishu-card.ts';
import type { ApprovalView } from '../shared/contracts.ts';

/** 只依赖发送卡片这一个能力，方便测试时替换。 */
export interface CardSender {
  sendCard(chatId: string, card: unknown): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  updateCard?(messageId: string, card: unknown): Promise<{ ok: boolean; error?: string }>;
}

export interface ApprovalCardDeps {
  sender: CardSender;
  /** 主人的会话 ID。空 = 不推送（如实退回旧行为，不假装发了）。 */
  chatId: string;
  /** 日志出口。默认吞掉（生产由 daemon 注入）。 */
  log?: (line: string) => void;
  /** 拿审批单最新状态（落定后改卡片用）。 */
  getApprovalView?: (id: number) => ApprovalView | null;
}

/**
 * 把一张审批单推到飞书。
 * 返回 message_id 便于后续改卡片；推送失败返回 null。
 */
export async function pushApprovalCard(
  deps: ApprovalCardDeps,
  view: ApprovalView,
): Promise<string | null> {
  if (deps.chatId === '') {
    deps.log?.('[feishu-approval] 未配置 owner_chat_id，审批卡片不推送');
    return null;
  }
  const card = buildApprovalCard(view);
  const r = await deps.sender.sendCard(deps.chatId, card);
  if (!r.ok) {
    deps.log?.(`[feishu-approval] 卡片推送失败（审批 #${view.id}）：${r.error ?? '?'}`);
    return null;
  }
  deps.log?.(`[feishu-approval] 审批 #${view.id} 已推送（${view.tier ?? '?'}）`);
  return r.messageId ?? null;
}

/**
 * 审批落定后把卡片改成结果，去掉按钮。
 * 失败只记日志 —— 裁决已经落库了，卡片好看与否不影响结论。
 */
export async function resolveApprovalCard(
  deps: ApprovalCardDeps,
  cardMessageId: string,
  approvalId: number,
  by: string,
): Promise<void> {
  if (deps.sender.updateCard === undefined) return;
  let view: ApprovalView | null = null;
  if (deps.getApprovalView !== undefined) view = deps.getApprovalView(approvalId);
  if (view === null) {
    deps.log?.(`[feishu-approval] 找不到审批 #${approvalId} 的最新状态，卡片不改`);
    return;
  }
  const card = buildResolvedCard(view, by);
  const r = await deps.sender.updateCard(cardMessageId, card);
  if (!r.ok) deps.log?.(`[feishu-approval] 卡片改写失败（#${approvalId}）：${r.error ?? '?'}`);
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
 * 记账：哪个审批单对应哪张卡片。
 * 进程重启就丢 —— 这是**已知取舍**：重启后旧卡片按钮点了会走
 * gate 的"找不到审批单"路径并被如实拒绝，不会误执行。
 * 要持久化的话得加一张表，当前收益不值。
 */
export class CardRegistry {
  private readonly map = new Map<number, string>();
  set(approvalId: number, messageId: string): void {
    this.map.set(approvalId, messageId);
  }
  get(approvalId: number): string | undefined {
    return this.map.get(approvalId);
  }
  delete(approvalId: number): void {
    this.map.delete(approvalId);
  }
  size(): number {
    return this.map.size;
  }
}
