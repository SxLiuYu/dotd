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
import { buildApprovalCard, parseCardAction, buildResolvedCard } from '../src/surfaces/feishu-card.ts';
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

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);