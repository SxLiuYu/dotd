/**
 * tests/approval-card-operation.test.ts —— 飞书卡片按「业务操作」渲染（2026-10-25）。
 *
 * 主人原话："审批操作不能是 shell.run，得是具体操作，比如点外卖支付这种操作。"
 *
 * 这里断言卡片上：
 *   ① 标题是任务里的业务动作，不是工具名；
 *   ② 有「具体操作」的人话描述，且不把 heredoc 正文倒到卡片上；
 *   ③ 金额/目标地址/支付风险都在；
 *   ④ 原始参数仍然保留（脱敏、截断）——审计要能对得上；
 *   ⑤ question 单不受影响（问答题不是许可题）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApprovalCard } from '../src/surfaces/feishu-card.ts';
import type { ApprovalView } from '../src/shared/contracts.ts';

const PAY_CMD = [
  "python3 - <<'EOF'",
  'import requests',
  "resp = requests.post('https://pay.example.com/v1/charge', json={'amount': 50})",
  'print(resp.text)',
  'EOF',
].join('\n');

function view(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 42,
    seq: 7,
    kind: 'tool_call',
    tier: 'dangerous',
    status: 'pending',
    summary: 'shell.run {"cmd":"python3 ..."}｜policy:dangerous',
    fullParams: { tool: 'shell.run', cmd: PAY_CMD },
    reason: 'policy:dangerous',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    taskRef: { taskId: 'tk_x', journalStepId: 'st_1' },
    taskTitle: '给王小明充 50 块话费',
    ...over,
  };
}

const text = (c: Record<string, unknown>): string => JSON.stringify(c);

test('标题用任务里的业务动作，不用工具名', () => {
  const t = text(buildApprovalCard(view()));
  assert.ok(t.includes('需要你决定 · 给王小明充 50 块话费'), '标题必须是业务动作');
});

test('有「具体操作」，脚本正文不上卡片', () => {
  const c = buildApprovalCard(view());
  const t = text(c);
  assert.ok(t.includes('具体操作'), '缺少具体操作字段');

  // 只看「具体操作」这一格：原始参数区仍然保留正文（审计需要），
  // 但操作描述必须是"运行 python3 脚本（3 行）"这种可判断的话。
  const fields = ((c['elements'] as Array<Record<string, unknown>>)
    .find((e) => Array.isArray(e['fields']))?.['fields'] ?? []) as Array<Record<string, unknown>>;
  const opLine = JSON.stringify(fields.find((f) => JSON.stringify(f).includes('具体操作')));
  assert.match(opLine, /运行 python3 脚本/);
  assert.ok(!opLine.includes('requests.post'), '脚本正文不应出现在操作描述里');
});

test('金额 / 目标地址 / 支付风险 三项都在', () => {
  const t = text(buildApprovalCard(view()));
  assert.ok(t.includes('pay.example.com'), '缺目标地址');
  assert.match(t, /金额/, '缺金额');
  assert.match(t, /支付\/下单动作/, '缺支付类风险提示');
});

test('原始参数仍保留，但凭证脱敏', () => {
  const c = buildApprovalCard(
    view({ fullParams: { tool: 'net.post', url: 'https://x.example.com', body: '{"key":"sk-abcdefgh12345678"}' } }),
  );
  const t = text(c);
  assert.ok(t.includes('原始参数'), '缺少原始参数段');
  assert.ok(t.includes('x.example.com'));
  assert.ok(!t.includes('sk-abcdefgh12345678'), '凭证必须脱敏');
});

test('工程字段降级：工具名只作一行小字，不再当主字段', () => {
  const t = text(buildApprovalCard(view()));
  assert.ok(t.includes('工具：`shell.run`'), '工具名应保留（审计事实）');
  assert.ok(!t.includes('**操作**\nshell.run'), '旧的主字段写法必须消失');
});

test('question 单仍然是问答题（不受业务渲染影响）', () => {
  const t = text(
    buildApprovalCard(
      view({
        kind: 'question',
        tier: null,
        subject: { kind: 'question', prompt: '要删哪一条？', options: ['A', 'B'] },
        fullParams: {},
      }),
    ),
  );
  assert.ok(t.includes('问你一件事'));
  assert.ok(t.includes('要删哪一条'));
});
