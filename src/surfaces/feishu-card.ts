/**
 * src/surfaces/feishu-card.ts —— 飞书交互卡片（T3，2026-10-20）
 *
 * 解决什么问题：
 *   现在危险工具被拦下时会往 approvals 写一条 pending，**但没人收到通知**。
 *   任务就那么卡着，主人得自己去 /approvals 看 —— 而 Muse 的做法是
 *   "弹出来给你，你点同意或拒绝"。
 *
 * 为什么用交互卡片而不是文本 + "回复 1"：
 *   1. 文本方案要求主人记住命令格式，还要求消息路由把回复正确关联回审批单
 *      （ingress.ts 那套 a1/d1 的解析很脆，错一个字符就变成普通聊天）
 *   2. 卡片按钮点一下就是一次结构化回调，带 approvalId，不可能指错
 *   3. Muse 的实测报道里，记者说"我按了同意" —— 是按钮，不是打字
 *
 * 飞书卡片协议要点（v2 schema）：
 *   - msg_type: 'interactive'，content 是卡片 JSON 的字符串
 *   - 按钮的 value 会原样回传，这是我们把 approvalId 带过去的方式
 *   - 回调走 card.action.trigger 事件（长连接或 webhook 都会收到）
 *   - **必须 3 秒内响应**，否则飞书会重试 —— 所以先回 200 再干活
 */
import type { ApprovalView } from '../shared/contracts.ts';

/** 卡片按钮的 value 结构。用驼峰是为了和飞书示例一致，减少对接摩擦。 */
export interface CardAction {
  kind: 'approval';
  approvalId: number;
  verdict: 'approve' | 'reject';
}

/**
 * 把一张审批单渲染成飞书卡片。
 *
 * 设计原则：**主人要在不看任务详情的情况下就能判断**。
 * 所以卡片里必须有：谁要干什么（tool）、花多少钱/发给谁（关键参数）、
 * 风险是什么（riskBrief）、以及"不点是会怎样的"（超时策略）。
 */
export function buildApprovalCard(v: ApprovalView): Record<string, unknown> {
  const risk = extractRisk(v);
  const keyParams = extractKeyParams(v);
  const toolName = extractToolName(v);

  // 头部颜色：dangerous 红、spend 橙、其他蓝。视觉上先分级。
  const template = v.tier === 'dangerous' ? 'red' : v.tier === 'spend' ? 'orange' : 'blue';
  const tierLabel =
    v.tier === 'dangerous' ? '危险操作' : v.tier === 'spend' ? '花钱' : String(v.tier);

  const elements: unknown[] = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: '**操作**\n' + toolName } },
        { is_short: true, text: { tag: 'lark_md', content: '**档位**\n' + tierLabel } },
      ],
    },
  ];

  if (keyParams.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          '**要做什么**\n' +
          keyParams.map(([k, val]) => '· ' + k + '：' + val).join('\n'),
      },
    });
  }

  if (risk !== null) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**风险**\n' + risk },
    });
  }

  // 超时策略必须写明。主人有权知道"我不理它会怎样"。
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '⏱ 若 ' + formatDeadline(v.expiresAt) + ' 内没有回应，**按拒绝处理**（不会偷偷执行）',
    },
  });

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '同意' },
        type: 'primary',
        value: JSON.stringify({
          kind: 'approval',
          approvalId: v.id,
          verdict: 'approve',
        } satisfies CardAction),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '拒绝' },
        type: 'danger',
        value: JSON.stringify({
          kind: 'approval',
          approvalId: v.id,
          verdict: 'reject',
        } satisfies CardAction),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: '需要你决定 · 审批 #' + v.id },
    },
    elements,
  };
}

/**
 * 取工具名。ApprovalView 没有独立的 tool 字段 —— 名字在 fullParams 里，
 * 也可能只体现在 summary 的第一段。取不到就如实说"未知操作"，不猜。
 */
function extractToolName(v: ApprovalView): string {
  const p = v.fullParams as unknown;
  if (p !== null && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    if (typeof o['tool'] === 'string' && (o['tool'] as string) !== '') return o['tool'] as string;
    if (typeof o['toolName'] === 'string' && (o['toolName'] as string) !== '') return o['toolName'] as string;
  }
  // summary 形如「mail.send（危险档）：给 a@b.com 发信」，取到第一个分隔符前
  const m = /^([a-z][a-zA-Z0-9_.]*)/.exec(v.summary);
  if (m !== null && m[1] !== undefined) return m[1];
  return '未知操作';
}

/** 从 riskBrief 里取可读的风险描述。取不到就返回 null，不编。 */
function extractRisk(v: ApprovalView): string | null {
  const brief = v.riskBrief as unknown;
  if (brief === null || brief === undefined) return null;
  if (typeof brief === 'string') return brief.slice(0, 300);
  if (typeof brief === 'object') {
    const o = brief as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.summary === 'string') parts.push(o.summary);
    if (typeof o.reason === 'string') parts.push(o.reason);
    if (Array.isArray(o.warnings)) {
      for (const w of o.warnings.slice(0, 5)) parts.push('· ' + String(w));
    }
    return parts.length > 0 ? parts.join('\n').slice(0, 300) : null;
  }
  return null;
}

/**
 * 从 params 里挑出"主人做决定必须知道的"字段。
 * 刻意只挑有限的几个：卡片上信息太多等于没信息。
 */
function extractKeyParams(v: ApprovalView): Array<[string, string]> {
  const p = v.fullParams as unknown;
  if (p === null || typeof p !== 'object') return [];
  const o = p as Record<string, unknown>;
  const out: Array<[string, string]> = [];

  // 邮件发送：收件人、主题、正文摘要、附件 —— T2 的判据要求的正是这四个
  const pick = (key: string, label: string, max = 120) => {
    const val = o[key];
    if (val === undefined || val === null) return;
    const s = Array.isArray(val) ? val.join(', ') : String(val);
    if (s === '') return;
    out.push([label, s.slice(0, max) + (s.length > max ? '…' : '')]);
  };

  pick('to', '收件人');
  pick('cc', '抄送');
  pick('subject', '主题');
  pick('body', '正文摘要', 200);
  pick('attachments', '附件');
  pick('draftId', '草稿编号');

  // 花钱类
  const amt = o.amountCents ?? o.amount;
  if (amt !== undefined) {
    const cur = typeof o.currency === 'string' ? o.currency : '';
    out.push(['金额', String(amt) + ' ' + cur]);
  }
  pick('url', '目标地址', 100);
  pick('command', '要执行的命令', 150);

  return out;
}

/** 把 ISO 时间变成"还剩多久"。算不出来就说"稍后"。 */
function formatDeadline(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '稍后';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '稍后';
  const ms = t - Date.now();
  if (ms <= 0) return '已经超时';
  const min = Math.round(ms / 60_000);
  if (min < 60) return min + ' 分钟';
  const h = Math.round(min / 60);
  return h + ' 小时';
}

/**
 * 解析飞书回调里的按钮 value。
 * 返回 null 表示"这不是审批按钮"（可能是别的卡片），调用方要当普通事件处理。
 */
export function parseCardAction(raw: unknown): CardAction | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.kind !== 'approval') return null;
  const id = typeof o.approvalId === 'number' ? o.approvalId : Number(o.approvalId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const verdict = o.verdict === 'approve' ? 'approve' : o.verdict === 'reject' ? 'reject' : null;
  if (verdict === null) return null;
  return { kind: 'approval', approvalId: id, verdict };
}

/**
 * 决策后把卡片替换成"已处理"，避免主人对着旧卡片反复点。
 * 不换的话，飞书会显示原按钮，而且重复点击会被 gate 判成"迟到裁决"。
 */
export function buildResolvedCard(
  v: ApprovalView,
  by: string,
): Record<string, unknown> {
  const approved = v.status === 'approved';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: approved ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content: (approved ? '已同意' : '已拒绝') + ' · 审批 #' + v.id,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            '**' + extractToolName(v) + '**\n' +
            (approved ? '已同意，正在执行。' : '已拒绝，不会执行。') +
            '\n处理人：' + by,
        },
      },
    ],
  };
}
