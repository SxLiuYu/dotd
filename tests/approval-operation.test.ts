/**
 * tests/approval-operation.test.ts —— 审批的「业务操作」翻译（2026-10-25）。
 *
 * 主人的原话："审批操作不能是 shell.run，得是具体操作，比如点外卖支付这种操作。"
 * 这组用例锁住四件事：
 *   ① 有任务标题时，标题就是业务动作（不是工具名）；
 *   ② shell 的 heredoc 正文不当作"操作"展示，只报解释器与规模；
 *   ③ 金额/收款方/地址/支付动词必须被读出来并给出风险提示；
 *   ④ 原始参数完整保留（脱敏、截断）——审计要能对得上，不能藏。
 *
 * 纯函数，不碰库、不联网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeOperation, operationSummary, redact } from '../src/shared/operation.ts';

const PAY_CMD = [
  "python3 - <<'EOF'",
  'import requests',
  "resp = requests.post('https://api.pay.example.com/v1/charge', json={'amount': 35, 'currency': 'CNY'})",
  'print(resp.text)',
  'EOF',
].join('\n');

test('有任务标题：标题是业务动作，shell 脚本只报规模与目标', () => {
  const op = describeOperation({
    taskTitle: '帮我点一份外卖并支付',
    tool: 'shell.run',
    tier: 'dangerous',
    params: { cmd: PAY_CMD },
  });
  assert.equal(op.title, '帮我点一份外卖并支付');
  assert.match(op.action, /运行 python3 脚本（4 行）/);
  assert.ok(!op.action.includes('requests.post'), '不能把脚本正文当操作描述');
  const addr = op.details.find((d) => d.label === '目标地址');
  assert.ok(addr !== undefined && addr.value.includes('api.pay.example.com'));
});

test('支付动词 + 金额：必须有金额与"核对收款方"的风险提示', () => {
  const op = describeOperation({
    taskTitle: '点外卖',
    tool: 'shell.run',
    tier: 'dangerous',
    params: { cmd: PAY_CMD },
  });
  const amount = op.details.find((d) => d.label === '金额');
  assert.ok(amount !== undefined, '金额没读出来');
  assert.match(amount!.value, /35/);
  assert.ok(
    op.risks.some((r) => /支付|下单/.test(r)),
    `缺少支付风险提示：${JSON.stringify(op.risks)}`,
  );
});

test('spend 契约的 amountCents 按"分→元"显示（不印裸分值）', () => {
  const op = describeOperation({
    tool: 'shop.checkout',
    tier: 'spend',
    params: { amountCents: 3550, currency: 'CNY', merchant: '美团' },
  });
  const amount = op.details.find((d) => d.label === '金额');
  assert.ok(amount !== undefined);
  assert.equal(amount!.value, 'CNY 35.50');
  assert.ok(!op.rawParams.includes('35.50') || op.rawParams.includes('3550'));
});

test('关闭 TLS 校验与长脚本会给风险提示', () => {
  const longScript = ['python3 - <<EOF', ...Array.from({ length: 80 }, (_, i) => `print(${i})`), 'EOF'].join('\n');
  const op = describeOperation({
    tool: 'shell.run',
    tier: 'dangerous',
    params: { cmd: longScript.replace('python3 - <<EOF', 'python3 - <<EOF\n') + '\nimport ssl\nssl._create_unverified_context()' },
  });
  assert.ok(op.risks.some((r) => /证书/.test(r)), '未提示关闭证书校验');
  assert.ok(op.risks.some((r) => /脚本较长/.test(r)), '未提示脚本过长');
});

test('browser 提交/确认类动作要提示可能直接下单', () => {
  const op = describeOperation({
    taskTitle: '下单买咖啡',
    tool: 'browser.act',
    tier: 'browser',
    params: { action: 'click', text: '确认支付', url: 'https://order.example.com/checkout' },
  });
  assert.match(op.action, /浏览器：click/);
  assert.ok(op.details.some((d) => d.label === '目标地址' && d.value.includes('order.example.com')));
  assert.ok(op.risks.some((r) => /提交|下单|付款/.test(r)));
});

test('mail.send 显示收件人/主题/正文，静态事实不冒充"风险"', () => {
  const op = describeOperation({
    tool: 'mail.send',
    tier: 'dangerous',
    params: { to: 'a@b.com', subject: '报价单', body: '收到了' },
  });
  assert.ok(op.details.some((d) => d.label === '收件人' && d.value === 'a@b.com'));
  assert.ok(op.details.some((d) => d.label === '主题'));
  // 没有参数派生的风险时 risks 为空（"邮件发出去收不回来"属于档位说明，不是风险发现）
  assert.deepEqual(op.risks, []);
});

test('params.intent 作为"这一步"补充说明，但不顶掉任务标题', () => {
  const op = describeOperation({
    taskTitle: '给手机充 50 元',
    tool: 'shell.run',
    tier: 'dangerous',
    params: { cmd: 'curl -s https://pay.example.com/topup', intent: '调用充值接口' },
  });
  assert.equal(op.title, '给手机充 50 元');
  assert.ok(op.details.some((d) => d.label === '这一步' && d.value === '调用充值接口'));
});

test('原始参数完整保留，但凭证要脱敏', () => {
  const op = describeOperation({
    tool: 'net.post',
    tier: 'dangerous',
    params: { url: 'https://x.example.com', body: '{"key":"sk-abcdefgh12345678"}' },
  });
  assert.ok(op.rawParams.includes('x.example.com'));
  assert.ok(!op.rawParams.includes('sk-abcdefgh12345678'));
  assert.ok(op.rawParams.includes('<已隐去>'));
  assert.match(redact('a'.repeat(500), 100), /…$/);
});

test('没有任务标题时，标题退回具体操作；summary ≤120 字', () => {
  const op = describeOperation({
    tool: 'shell.run',
    tier: 'dangerous',
    params: { cmd: "TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M %Z'" },
  });
  assert.match(op.title, /运行命令/);
  const s = operationSummary(op);
  assert.ok(s.length <= 120, `summary 超长：${s.length}`);
});
