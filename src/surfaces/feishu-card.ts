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
import { LARGE_SPEND_WARN_CENTS, formatMoney, isLargeSpend } from '../shared/money.ts';
import { describeOperation, redact } from '../shared/operation.ts';

// 金额格式化/大额判定已上移到 shared/money.ts（审批摘要与卡片共用同一实现）。
// 这里保留再导出：既有调用方与测试从本模块导入，行为不变。
export { LARGE_SPEND_WARN_CENTS, formatMoney, isLargeSpend };


/** 卡片按钮的 value 结构。用驼峰是为了和飞书示例一致，减少对接摩擦。 */
export interface CardAction {
  kind: 'approval';
  approvalId: number;
  verdict: 'approve' | 'reject';
  /**
   * 主人选的答案（只有 question 类审批才有）。
   *
   * 为什么必须走 value 而不是让主人打字：`ask` 的全部语义就是「主人的回答」，
   * 而批准一张 question 单时如果 note 为空，gate.decide() 会把 final_params_json
   * 原样回传，claim() 带回来的 ownerNote 就是 undefined —— 实测 daemon.ts 的 ask
   * 处理器于是返回 `{answered:false, text:'主人没有回答这个问题…'}`。
   * 结果是主人明明点了同意，模型却被告知没人回答（2026-10-23 现场：
   * 任务 tk_mvk9uj7vedr2fx 的 #150 就是这么废掉的，模型只好自己编一条日程）。
   */
  answer?: string;
}

/**
 * 把卡片 JSON 包成**卡片回调的响应体**。
 *
 * 为什么必须包：飞书 v2 回调（我们的载荷里 `schema: "2.0"`）的响应体格式是
 *   `{ "toast"?: {...}, "card": { "type": "raw" | "template", "data": <卡片JSON> } }`
 * 顶层直接放卡片 JSON 是**无效结构**：飞书解析不到卡片，就按「用户点击那一刻」
 * 的版本落定这张卡 —— 服务端 PATCH 改好的结果卡被冲掉，客户端闪一下"已同意"
 * 又变回按钮（主人报的正是这个）。
 *
 * 2026-10-27 的实测链：日志「审批 #167 落定，已改 2/2 张卡片」，回包里也确实带了
 * 结果卡，客户端先显示"已同意"，随后刷新回选项卡 —— 因为回包的 `card` 不是
 * `{type,data}` 而是裸卡片，飞书不认。旧版回调（v1）才允许 `card` 直接放卡片 JSON，
 * 我们收的是 v2 事件。
 *
 * 我们发出去的是 1.0 结构卡片（顶层 config/header/elements），所以 `data` 里
 * 原样放 1.0 JSON，不塞 `schema: "2.0"` —— 飞书要求 data 的版本与发卡时一致。
 */
export function toCardCallbackResponse(
  card: Record<string, unknown>,
  toast?: { type: 'info' | 'success' | 'error' | 'warning'; content: string },
): {
  toast?: { type: string; content: string; i18n: { zh_cn: string; en_us: string } };
  card: { type: 'raw'; data: Record<string, unknown> };
} {
  return {
    ...(toast === undefined
      ? {}
      : { toast: { type: toast.type, content: toast.content, i18n: { zh_cn: toast.content, en_us: toast.content } } }),
    card: { type: 'raw', data: card },
  };
}

/**
 * 把一张审批单渲染成飞书卡片。
 *
 * 设计原则：**主人要在不看任务详情的情况下就能判断**。
 * 所以卡片里必须有：谁要干什么（tool）、花多少钱/发给谁（关键参数）、
 * 风险是什么（riskBrief）、以及"不点是会怎样的"（超时策略）。
 */
/**
 * question 类审批（`ask`）：把每个选项做成一个按钮，答案随回调带回。
 *
 * 与 tool_call 分支的区别不是样式，是**语义**：tool_call 问「准不准做」，
 * question 问「选哪个」。前者『同意』就够了，后者不带回答案等于没回答。
 */
function buildQuestionCard(v: ApprovalView): Record<string, unknown> {
  const subj = v.subject;
  const prompt = subj !== undefined && subj.kind === 'question' ? subj.prompt : v.reason;
  const options = subj !== undefined && subj.kind === 'question' ? (subj.options ?? []) : [];
  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: '**要问你**\n' + prompt.slice(0, 600) } },
  ];
  if (options.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**点一个回答**（点完就带回去了）' } });
    // 每个选项一个按钮。飞书 action 块横向排布，超过 4 个会换行，可接受。
    elements.push({
      tag: 'action',
      actions: options.slice(0, 10).map((opt, idx) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.slice(0, 40) },
        type: idx === 0 ? 'primary' : 'default',
        value: JSON.stringify({
          kind: 'approval',
          approvalId: v.id,
          verdict: 'approve',
          answer: opt,
        } satisfies CardAction),
      })),
    });
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        '想答别的就回「回答 ' + String(v.id) + ' 你的答案」。⏱ 若 ' + formatDeadline(v.expiresAt) + ' 内没有回应，按没回答处理。',
    },
  });
  // 没有选项时也必须有一个可点的按钮，否则主人只能打字
  if (options.length === 0) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '知道了' },
          type: 'primary',
          value: JSON.stringify({ kind: 'approval', approvalId: v.id, verdict: 'approve' } satisfies CardAction),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '拒绝' },
          type: 'danger',
          value: JSON.stringify({ kind: 'approval', approvalId: v.id, verdict: 'reject' } satisfies CardAction),
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '问你一件事 · 审批 #' + v.id } },
    elements,
  };
}

export function buildApprovalCard(v: ApprovalView): Record<string, unknown> {
  // question 是**问答题**，不是许可题：单独渲染，否则选项无处可点。
  if (v.kind === 'question') return buildQuestionCard(v);

  const rawRisk = extractRisk(v);
  const keyParams = extractKeyParams(v);
  const toolName = extractToolName(v);
  // 业务级解读（2026-10-25）：主人批的是"给王小明充 50 块话费"，
  // 不是 "shell.run + 42 行 heredoc"。这层只改呈现，不改许可语义。
  const op = describeOperation({
    taskTitle: v.taskTitle ?? null,
    tool: toolName,
    tier: v.tier,
    params: v.fullParams,
    reason: v.reason,
  });

  // 头部颜色：dangerous 红、spend 橙、其他蓝。视觉上先分级。
  const template = v.tier === 'dangerous' ? 'red' : v.tier === 'spend' ? 'orange' : 'blue';
  const tierLabel =
    v.tier === 'dangerous' ? '危险操作' : v.tier === 'spend' ? '花钱' : String(v.tier);

  const fields: unknown[] = [];
  if (op.title !== op.action) {
    fields.push({ is_short: false, text: { tag: 'lark_md', content: '**业务动作**\n' + op.title } });
  }
  fields.push({ is_short: true, text: { tag: 'lark_md', content: '**具体操作**\n' + op.action } });
  fields.push({ is_short: true, text: { tag: 'lark_md', content: '**档位**\n' + tierLabel } });
  // 工具名降级成一行小字：它仍然是审计事实，但不是主人做决定的主要依据。
  fields.push({ is_short: false, text: { tag: 'lark_md', content: '工具：`' + toolName + '`' } });

  const elements: unknown[] = [{ tag: 'div', fields }];

  // 业务解读没覆盖到的关键参数（邮件四字段、spend 金额）仍补在下面。
  const detailLines = op.details.map((d) => '· ' + d.label + '：' + d.value);
  const extra = keyParams.filter(
    ([k]) => !op.details.some((d) => d.label === k) && !['要执行的命令', '目标地址', '金额'].includes(k),
  );
  for (const [k, val] of extra.slice(0, 3)) detailLines.push('· ' + k + '：' + val);
  if (detailLines.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**要做什么**\n' + detailLines.join('\n') },
    });
  }

  const risks = [...op.risks];
  if (rawRisk !== null) risks.push(rawRisk);
  if (risks.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**风险**\n' + risks.map((r) => '· ' + r).slice(0, 4).join('\n') },
    });
  }

  // 原始参数：完整保留、脱敏、截断。审计要能对得上，主人也应该能看到原文。
  if (op.rawParams !== '' && op.rawParams !== '{}') {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**原始参数**\n<font color=\'grey\'>' + redact(op.rawParams, 320) + '</font>',
      },
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
      title: { tag: 'plain_text', content: '需要你决定 · ' + op.title + '（审批 #' + v.id + '）' },
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
  //
  // 2026-10-27：必须先判类型。装配层为了省一次全表投影，只 SELECT 了
  // id/seq/status 三列喂给结果卡，`summary` 于是是 undefined；旧实现直接
  // `/^([a-z][a-zA-Z0-9_.]*)/.exec(undefined)`，JS 把它转成字符串 "undefined"，
  // 正则命中 → 卡片上就印着 `**undefined**`（主人实际看到的那张）。
  const summary = typeof v.summary === 'string' ? v.summary : '';
  const m = /^([a-z][a-zA-Z0-9_.]*)/.exec(summary);
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
 *
 * 2026-10-25：主路径改为 shared/operation.ts 的业务解读（金额/对象/地址/风险）；
 * 这里保留为**补充**——它认得 spend 契约的 amountCents 与邮件四字段，
 * 业务解读没覆盖到的工具仍能显示关键参数。
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
    // 关键参数同样要脱敏：net.post 的 body 里常带 API key（2026-10-25 加）。
    out.push([label, redact(s, max)]);
  };

  pick('to', '收件人');
  pick('cc', '抄送');
  pick('subject', '主题');
  pick('body', '正文摘要', 200);
  pick('attachments', '附件');
  pick('draftId', '草稿编号');

  // 花钱类。amountCents 是**分**，必须换算后再显示（见 formatMoney 注释里的 100 倍事故）。
  // amount 是裸值（旧形态），单位不明 —— 原样显示并标注，不猜。
  const cents = o.amountCents;
  const cur = typeof o.currency === 'string' ? o.currency : '';
  if (typeof cents === 'number') {
    const shown = formatMoney(cents, cur);
    out.push([
      '金额',
      isLargeSpend(cents, LARGE_SPEND_WARN_CENTS) ? shown + '  ⚠️ 金额较大，请确认' : shown,
    ]);
  } else if (o.amount !== undefined) {
    out.push(['金额', String(o.amount) + ' ' + cur + '（未标明单位）']);
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
 * 卡片点击 → GOV decide() 的实参。
 *
 * 为什么要单独一个函数：这段映射原来**只**写在 daemon.ts 的装配闭包里，
 * 而装配闭包在测试里永远被假的 decide 顶替 —— 于是「answer 有没有被搬过去」
 * 这件事没有任何护栏。实测验伪：把 `note ?? undefined` 从 daemon 里删掉，
 * 全部用例照旧全绿（测试注入的假 decide 自己很乖）。
 * 抽到这里之后，映射本身可被单测钉死，装配层只剩「调用它」这一句。
 *
 * 三条语义：
 * 1. 卡片只有「一次」和「拒绝」两个语义 ⇒ approve 一律 approve_once，
 *    不擅自替主人"记住"（记住是主人的决定，不该由一次点击代劳）；
 * 2. 通道声明为 'web'（卡片是 web 形态的交互，与 /api/approvals 同权）；
 * 3. **answer 必须原样变成 note** —— 对 question 单这不是补充说明，
 *    而是回答本身；丢了它，gate 会原样回传参数，claim() 拿不到 ownerNote，
 *    `ask` 只能报「主人没有回答」。
 */
export function toDecideCall(action: CardAction): {
  verdict: 'approve_once' | 'reject';
  note: string | undefined;
} {
  const verdict = action.verdict === 'approve' ? 'approve_once' : 'reject';
  // 空串按「没答」处理：绝不能把空话当成主人的话塞进 ownerNote。
  const note = action.answer !== undefined && action.answer.trim() !== '' ? action.answer.trim() : undefined;
  return { verdict, note };
}

/**
 * 解析飞书回调里的按钮 value。
 * 返回 null 表示"这不是审批按钮"（可能是别的卡片），调用方要当普通事件处理。
 */
export function parseCardAction(raw: unknown): CardAction | null {
  let obj: unknown = raw;
  // 2026-10-21 真实点击抓到的载荷：`action.value` **被编码了两层**。
  //
  //   飞书推来：  "{\"kind\":\"approval\",\"approvalId\":134,\"verdict\":\"approve\"}"
  //   解一层得到：'{"kind":"approval",...}'  ← 还是字符串
  //
  // 旧实现只解一层，于是 obj 仍是 string，`typeof obj !== 'object'` → return null
  // → 判别成 ignore → **点同意毫无反应**（主人报的就是这个）。
  // 现在最多解三层（防御未来再套一层），每层都必须解出字符串才继续。
  for (let depth = 0; depth < 3 && typeof obj === 'string'; depth++) {
    try {
      obj = JSON.parse(obj);
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
  // question 单的答案是随按钮回来的额外字段。空串按「没答」处理，不塞空话。
  const answerRaw = typeof o.answer === 'string' ? o.answer.trim() : '';
  return {
    kind: 'approval',
    approvalId: id,
    verdict,
    ...(answerRaw !== '' ? { answer: answerRaw.slice(0, 500) } : {}),
  };
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
  // 这张卡是"结论回执"，主语要能让人认出是哪件事。
  // question 单（`ask`）没有工具名，用问题本身当主语；tool_call 单用工具名。
  const subject =
    v.kind === 'question' && typeof v.reason === 'string' && v.reason.trim() !== ''
      ? v.reason.trim().slice(0, 200)
      : extractToolName(v);
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
            '**' + subject + '**\n' +
            (approved ? '已同意，正在执行。' : '已拒绝，不会执行。') +
            '\n处理人：' + by,
        },
      },
    ],
  };
}
