/**
 * tests/router-bad-protocol-detail.test.ts —— bad_protocol 要能诊断。
 *
 * 现场（2026-10-25）：primary 模型在 10 分钟内连撞 9 次 `bad_protocol`
 * （HTTP 200，tool_call 的 arguments 不是合法 JSON），而 `model_call_log`
 * 只记一个 kind、日志只有一句"参数不是合法 JSON" —— 不知道是哪个工具、
 * 参数多长，分不清"模型胡说"和"输出被 max_tokens 截断"。
 *
 * 修法：`badProtocolDetail()` 给出一行说明（工具名 + arguments 长度 + JSON
 * 解析错误），**绝不含参数内容**——参数里可能有地址、金额、邮件正文。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { badProtocolDetail, isToolCallBadProtocol } from '../src/router/candidates.ts';
import type { ChatResponse } from '../src/shared/contracts.ts';

const withCalls = (calls: NonNullable<ChatResponse['toolCalls']>): ChatResponse => ({
  content: '',
  toolCalls: calls,
});

test('合法 JSON → 没有诊断信息', () => {
  const resp = withCalls([{ id: 'c1', name: 'fs.read', arguments: '{"path":"MEMORY.md"}' }]);
  assert.equal(badProtocolDetail(resp), null);
  assert.equal(isToolCallBadProtocol(resp), false);
});

test('没有工具调用 → 不是 bad_protocol（纯文本回复合法）', () => {
  assert.equal(badProtocolDetail({ content: '好的' }), null);
  assert.equal(isToolCallBadProtocol({ content: '好的' }), false);
});

test('截断的 arguments → 报工具名与长度，方便判断是不是 max_tokens 截断', () => {
  const truncated = '{"path":"notes/a.md","content":"' + 'x'.repeat(500);
  const resp = withCalls([{ id: 'c1', name: 'fs.write', arguments: truncated }]);
  const detail = badProtocolDetail(resp);
  assert.ok(detail !== null);
  assert.match(detail, /fs\.write/, '要报工具名');
  assert.match(detail, new RegExp(String(truncated.length)), '要报参数长度');
  assert.equal(isToolCallBadProtocol(resp), true);
});

test('诊断信息绝不带参数内容（防把主人的数据写进日志）', () => {
  const secret = '13800138000';
  const resp = withCalls([
    { id: 'c1', name: 'pay.charge', arguments: `{"amountCents":5000,"payee":"王小明","phone":"${secret}"` },
  ]);
  const detail = badProtocolDetail(resp);
  assert.ok(detail !== null);
  assert.equal(detail.includes(secret), false, '不得包含参数里的手机号');
  assert.equal(detail.includes('王小明'), false, '不得包含参数里的收款方');
});

test('缺工具名也算 bad_protocol，并明说原因', () => {
  const resp = withCalls([{ id: 'c1', name: '', arguments: '{}' }]);
  assert.match(String(badProtocolDetail(resp)), /缺少工具名/);
});
