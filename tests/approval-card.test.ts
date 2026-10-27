/**
 * tests/approval-card.test.ts —— T3 审批卡片的硬判据（2026-10-20）
 *
 * 要回答的问题：
 *   1. 卡片 JSON 结构对不对（飞书会拒掉格式错的卡片）
 *   2. 关键信息在不在卡片上（收件人/主题/金额/风险/超时策略）
 *   3. 按钮的 value 能不能被正确解析回来（点错了会审批错单）
 *   4. 回调的鉴权是否真的生效（非主人会话必须拒）
 *   5. 审批落地后卡片能不能改成"已处理"（不改会重复点）
 *
 * 为什么不用 snapshot 测试：
 *   snapshot 会在我改文案时假红，而文案改成什么样都行。
 *   这里断言的是**语义**：有没有这个信息、解析对不对。
 */
import {
  buildApprovalCard,
  parseCardAction,
  buildResolvedCard,
  toCardCallbackResponse,
  toDecideCall,
} from '../src/surfaces/feishu-card.ts';
import { classifyFeishuInbound } from '../src/surfaces/feishu-inbound.ts';
import type { ApprovalView } from '../src/shared/contracts.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const makeView = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 42,
  seq: 7,
  kind: 'tool_call',
  tier: 'dangerous',
  status: 'pending',
  summary: 'mail.send（危险档）：给 laowang@example.com 发信',
  fullParams: {
    tool: 'mail.send',
    to: ['laowang@example.com'],
    subject: '回复：报价单',
    body: '收到了，谢谢。我们会尽快处理。',
    draftId: 'md_abc123',
    attachments: ['quote.pdf'],
  },
  reason: '对外发送邮件',
  riskBrief: { verdict: 'risky', reason: '发出去收不回来' },
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  taskRef: { taskId: 'tk_x', journalStepId: 'st_1' },
  ...over,
});

const cardText = (c: Record<string, unknown>): string => JSON.stringify(c);

// 1. 卡片结构
{
  const c = buildApprovalCard(makeView());
  ok('有 header', typeof c['header'] === 'object');
  ok('有 elements', Array.isArray(c['elements']));
  ok('危险档用红色', (c['header'] as Record<string, unknown>)['template'] === 'red');
  ok('标题带审批编号', cardText(c).includes('#42'));
  ok('宽屏 + 可更新', (c['config'] as Record<string, unknown>)['update_multi'] === true);
}

// 2. 关键信息必须在卡片上（T2 判据要求收件人/主题/正文/附件）
{
  const t = cardText(buildApprovalCard(makeView()));
  ok('显示收件人', t.includes('laowang@example.com'));
  ok('显示主题', t.includes('回复：报价单'));
  ok('显示正文摘要', t.includes('收到了'));
  ok('显示附件名', t.includes('quote.pdf'));
  ok('显示草稿编号', t.includes('md_abc123'));
  ok('显示工具名', t.includes('mail.send'));
  ok('显示风险', t.includes('收不回来'));
  ok('写明超时按拒绝', t.includes('按拒绝处理'));
  ok('写明剩余时间', /[0-9]+ 分钟/.test(t));
}

// 3. 花钱类卡片
{
  const v = makeView({
    tier: 'spend',
    fullParams: { amountCents: 50000, currency: 'CNY', tool: 'shop.checkout' },
  });
  const c = buildApprovalCard(v);
  const t = cardText(c);
  ok('spend 档用橙色', (c['header'] as Record<string, unknown>)['template'] === 'orange');
  // 2026-10-21（9.2）：amountCents 语义是**分**，卡片现在印 500.00 CNY 而不是 50000 CNY。
  // 旧断言 `t.includes('50000')` 是错的：那等于把 500 元显示成 50000 元。
  ok('显示金额（分→元）', t.includes('500.00') && t.includes('CNY'), t.match(/[\d.]+ CNY/)?.[0] ?? '未找到');
  ok('不再印裸的分值', !t.includes('50000 CNY'));
}

// 4. 按钮 value 可解析
{
  const c = buildApprovalCard(makeView());
  const els = c['elements'] as unknown[];
  const actionEl = els.find((e) => (e as Record<string, unknown>)['tag'] === 'action') as
    | Record<string, unknown>
    | undefined;
  ok('有 action 区', actionEl !== undefined);
  const buttons = (actionEl?.['actions'] ?? []) as Array<Record<string, unknown>>;
  ok('两个按钮（同意/拒绝）', buttons.length === 2);

  const pa = parseCardAction(buttons[0]?.['value']);
  const pr = parseCardAction(buttons[1]?.['value']);
  ok('同意按钮解析正确', pa?.verdict === 'approve' && pa?.approvalId === 42);
  ok('拒绝按钮解析正确', pr?.verdict === 'reject' && pr?.approvalId === 42);
  ok('同意是 primary', buttons[0]?.['type'] === 'primary');
  ok('拒绝是 danger', buttons[1]?.['type'] === 'danger');
}

// 5. 解析必须拒绝垃圾输入（点错审批错单是灾难）
{
  ok('null 拒绝', parseCardAction(null) === null);
  ok('空字符串拒绝', parseCardAction('') === null);
  ok('非 JSON 拒绝', parseCardAction('not json') === null);
  ok('缺 kind 拒绝', parseCardAction(JSON.stringify({ approvalId: 1, verdict: 'approve' })) === null);
  ok('kind 不对拒绝', parseCardAction(JSON.stringify({ kind: 'other', approvalId: 1, verdict: 'approve' })) === null);
  ok('id 非数字拒绝', parseCardAction(JSON.stringify({ kind: 'approval', approvalId: 'x', verdict: 'approve' })) === null);
  ok('id<=0 拒绝', parseCardAction(JSON.stringify({ kind: 'approval', approvalId: 0, verdict: 'approve' })) === null);
  ok('verdict 乱值拒绝', parseCardAction(JSON.stringify({ kind: 'approval', approvalId: 1, verdict: 'maybe' })) === null);
  ok('注入字符串拒绝', parseCardAction('DROP TABLE approvals') === null);
}

// 6. 落定后改卡片
{
  const approved = buildResolvedCard(makeView({ status: 'approved' }), 'feishu');
  const rejected = buildResolvedCard(makeView({ status: 'rejected' }), 'feishu');
  ok('同意后变绿', (approved['header'] as Record<string, unknown>)['template'] === 'green');
  ok('拒绝后变灰', (rejected['header'] as Record<string, unknown>)['template'] === 'grey');
  ok('同意卡片写明正在执行', cardText(approved).includes('正在执行'));
  ok('拒绝卡片写明不会执行', cardText(rejected).includes('不会执行'));
  ok('改后没有按钮了', !cardText(approved).includes('"tag":"action"'));
}

// 6.5 结果卡不能出现 undefined（2026-10-27 现场：主人收到正文写着 **undefined** 的卡）
{
  // 装配层为了省一次全表投影，只 SELECT 了 id/seq/status；extractToolName 里
  // `/^([a-z]…)/.exec(undefined)` 不会报错 —— JS 把 undefined 转成字符串
  // "undefined"，正则命中首字母 u，于是卡片正文印出 `**undefined**`。
  const sparse = {
    id: 9,
    seq: 3,
    status: 'approved',
    kind: 'tool_call',
  } as unknown as ApprovalView;
  const card = buildResolvedCard(sparse, '飞书');
  ok('缺 summary 时不印 undefined', !cardText(card).includes('undefined'), cardText(card));
  ok('缺 summary 时退回"未知操作"', cardText(card).includes('未知操作'), cardText(card));
  // summary 正常时仍取工具名，不因这次收窄退化成"未知操作"。
  const named = buildResolvedCard(makeView({ status: 'approved' }), '飞书');
  ok('有 summary 时仍取工具名', cardText(named).includes('mail.send'), cardText(named));
}

// 6.6 卡片回调的响应体结构（2026-10-27 二次修）
{
  const card = buildResolvedCard(makeView({ status: 'approved' }), '飞书');
  const resp = toCardCallbackResponse(card);
  const c = resp['card'] as Record<string, unknown>;
  ok('响应体顶层是 card 对象', typeof c === 'object' && c !== null);
  ok('card.type 是 raw', c['type'] === 'raw', String(c['type']));
  ok('card.data 就是卡片 JSON', c['data'] === card);
  // 不能把卡片字段漏在顶层 —— 飞书只认 card.data 里的内容。
  const top = resp as unknown as Record<string, unknown>;
  ok('顶层不残留 config', top['config'] === undefined);
  ok('顶层不残留 header', top['header'] === undefined);
}

// 6.7 question 单的结果卡用问题当主语（`ask` 没有工具名）
{
  const q = buildResolvedCard(
    makeView({ kind: 'question', tier: null, status: 'approved', reason: '晚上回家先做哪件事？' }),
    '飞书',
  );
  ok('question 结果卡写问题本身', cardText(q).includes('晚上回家先做哪件事'), cardText(q));
  ok('question 结果卡不写未知操作', !cardText(q).includes('未知操作'), cardText(q));
}

// 7. 入站解析：card.action.trigger 事件
{
  const cfg = { verificationToken: 'tok', ownerChatId: 'oc_owner' };
  const env = {
    schema: '2.0',
    header: { event_id: 'ev_card_1', event_type: 'card.action.trigger', token: 'tok' },
    event: {
      operator: { open_id: 'ou_owner' },
      action: {
        value: JSON.stringify({ kind: 'approval', approvalId: 42, verdict: 'approve' }),
      },
      context: { open_chat_id: 'oc_owner', open_message_id: 'om_card_1' },
    },
  };

  const d = classifyFeishuInbound(env, cfg);
  ok('卡片回调被识别为 card_action', d.kind === 'card_action', d.kind);
  if (d.kind === 'card_action') {
    ok('  审批编号对', d.approvalId === 42);
    ok('  裁决对', d.verdict === 'approve');
    ok('  带卡片 message_id', d.cardMessageId === 'om_card_1');
    ok('  带操作人', d.operatorId === 'ou_owner');
    ok('  有去重键', d.dedupKey.length > 0);
  }

  const outside = {
    ...env,
    event: { ...env.event, context: { open_chat_id: 'oc_stranger', open_message_id: 'om_x' } },
  };
  const d2 = classifyFeishuInbound(outside, cfg);
  ok('非主人会话被拒', d2.kind === 'reject', d2.kind);

  const d3 = classifyFeishuInbound(env, { verificationToken: 'tok', ownerChatId: '' });
  ok('未配主人会话时 fail-closed', d3.kind === 'reject', d3.kind);

  const notApproval = {
    ...env,
    event: { ...env.event, action: { value: JSON.stringify({ kind: 'something_else' }) } },
  };
  const d4 = classifyFeishuInbound(notApproval, cfg);
  ok('非审批按钮 ignore', d4.kind === 'ignore', d4.kind);
}

// 8. 缺字段不能编
{
  const bare = makeView({ fullParams: {}, riskBrief: undefined });
  const t = cardText(buildApprovalCard(bare));
  ok('没参数时不编造收件人', !t.includes('收件人'));
  ok('没风险时不编造风险段', !t.includes('**风险**'));
  ok('工具名取不到也有兜底', t.includes('未知操作') || t.includes('mail.send'));
}

console.log('');
console.log('  F. question 单：选项必须变成可点的按钮，且答案能解析回来（2026-10-23）');

{
  // 现场（approvals#150）：卡片只发了「同意/拒绝」两个按钮，主人点了同意，
  // 审批 approved、任务续跑，但 `ask` 收到 `{answered:false}` —— 因为
  // 按钮 value 里根本没有答案位，主人也没法在一张只有两个按钮的卡上「选」。
  const v = makeView({
    kind: 'question',
    tier: null,
    summary: 'ask 要删哪一条？',
    reason: '要删哪一条？（日历删除没有回收站，先确认一下）',
    subject: {
      kind: 'question',
      prompt: '要删哪一条？（日历删除没有回收站，先确认一下）',
      options: ['周会试跑 10-27 10:00', '诊断跑 10-28 09:00', '全部删掉'],
    },
  });
  const card = buildApprovalCard(v) as { elements: Array<Record<string, unknown>> };
  const actions = card.elements.filter((e) => e.tag === 'action');
  const buttons = actions.flatMap((a) => (a.actions ?? []) as Array<Record<string, unknown>>);
  ok('卡片上有按钮', buttons.length >= 3, String(buttons.length));
  const labels = buttons.map((b) => String((b.text as { content?: string }).content ?? ''));
  ok('每个选项各一个按钮',
     labels.includes('周会试跑 10-27 10:00') && labels.includes('诊断跑 10-28 09:00'),
     JSON.stringify(labels));
  const withAnswer = buttons.filter((b) => String(b.value).includes('answer'));
  ok('选项按钮的 value 带 answer', withAnswer.length === 3, String(withAnswer.length));

  // 解析回来：这是「主人到底答了什么」的唯一来源
  const parsed = parseCardAction(buttons[0]?.value);
  ok('解析出 approvalId', parsed?.approvalId === 42, String(parsed?.approvalId));
  ok('解析出 verdict=approve', parsed?.verdict === 'approve', String(parsed?.verdict));
  ok('解析出答案原文', parsed?.answer === '周会试跑 10-27 10:00', String(parsed?.answer));
}

{
  // 没给选项时也要有能点的按钮，否则主人只能打字（且没有 answer 字段）
  const v = makeView({
    kind: 'question',
    tier: null,
    subject: { kind: 'question', prompt: '随便说点什么' },
  });
  const card = buildApprovalCard(v) as { elements: Array<Record<string, unknown>> };
  const buttons = card.elements
    .filter((e) => e.tag === 'action')
    .flatMap((a) => (a.actions ?? []) as Array<Record<string, unknown>>);
  ok('无选项时仍有按钮', buttons.length > 0, String(buttons.length));
  ok('无选项按钮不带 answer（不能凭空造答案）',
     buttons.every((b) => !String(b.value).includes('answer')));
}

{
  // tool_call 单不受影响：仍是同意/拒绝两个按钮，且不带 answer
  const card = buildApprovalCard(makeView()) as { elements: Array<Record<string, unknown>> };
  const buttons = card.elements
    .filter((e) => e.tag === 'action')
    .flatMap((a) => (a.actions ?? []) as Array<Record<string, unknown>>);
  ok('tool_call 卡片仍是 2 个按钮', buttons.length === 2, String(buttons.length));
  ok('tool_call 按钮不带 answer', buttons.every((b) => !String(b.value).includes('answer')));
}

console.log('');
console.log('  G. toDecideCall：卡片点击 → GOV decide() 实参（answer 必须变成 note）');

{
  // 这一组存在的理由：映射原来只写在 daemon.ts 的装配闭包里，而装配闭包
  // 在测试里永远被假的 decide 顶替 —— 实测把 note 透传删掉，用例照旧全绿。
  // 抽成纯函数之后，删掉 note 这一条立刻变红（见下方注释里的验伪记录）。
  const a = toDecideCall({ kind: 'approval', approvalId: 1, verdict: 'approve', answer: '周会试跑 10-27 10:00' });
  ok('approve → approve_once', a.verdict === 'approve_once', a.verdict);
  ok('answer 变成 note（这是 ask 的全部语义）', a.note === '周会试跑 10-27 10:00', String(a.note));

  const b = toDecideCall({ kind: 'approval', approvalId: 2, verdict: 'reject' });
  ok('reject → reject', b.verdict === 'reject', b.verdict);
  ok('没有 answer 时 note 是 undefined（不能塞空串）', b.note === undefined, String(b.note));

  const c = toDecideCall({ kind: 'approval', approvalId: 3, verdict: 'approve', answer: '   ' });
  ok('空白 answer 按没答处理', c.note === undefined, JSON.stringify(c.note));

  const d = toDecideCall({ kind: 'approval', approvalId: 4, verdict: 'approve', answer: '  全部删掉  ' });
  ok('answer 两端空白去掉', d.note === '全部删掉', JSON.stringify(d.note));
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);