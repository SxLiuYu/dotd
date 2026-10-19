/**
 * tests/memory-replay-summary-budget.test.ts —— 摘要必须占用预算，而不是"剩下才加"。
 *
 * 现场（2026-10-19）：`packSessionReplay` 里原来写的是
 *
 *   if (summary !== null && summary.length > 0 && used < budgetTokens) { 加摘要 }
 *
 * 这个条件方向是反的：**会话越长，used 越接近 budgetTokens**，
 * 于是最需要摘要的长会话最可能拿不到摘要 —— "越需要它，越用不上"。
 *
 * 修法：先给摘要留出位置（`replayBudget = budgetTokens - summaryTokens`），
 * 剩下来的预算再装最近的消息。
 *
 * 行为断言（不是源码匹配）：构造一个塞满预算的线程，验证摘要仍然在。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packSessionReplay } from '../src/memory/inject.ts';
import type { Message, Thread } from '../src/shared/contracts.ts';

function mkThread(summary: string | null): Thread {
  return {
    id: 'thr_test',
    dotId: 'dot1',
    channel: 'web',
    status: 'active',
    title: null,
    externalRef: null,
    contextSummary: summary,
    contextSummaryUptoSeq: 10,
    lastActiveAt: Date.now(),
    lastTaskFinishedAt: null,
    createdAt: Date.now(),
  } as unknown as Thread;
}

function mkMsg(seq: number, content: string, tokenEst: number): Message {
  return {
    id: `m${seq}`,
    threadId: 'thr_test',
    seq,
    role: 'user',
    kind: 'text',
    content,
    tokenEst,
    createdAt: Date.now(),
  } as unknown as Message;
}

test('预算被最近消息占满时，摘要仍然保留（而不是被挤掉）', () => {
  // 摘要约 200 token；最近消息塞满 1000 预算
  const summary = 'S'.repeat(700); // 约 200 token（按 3.5 字节/token 估）
  const msgs: Message[] = [];
  for (let i = 0; i < 20; i += 1) msgs.push(mkMsg(i + 11, 'x'.repeat(300), 100));

  const out = packSessionReplay(mkThread(summary), msgs, 1000);
  const hasSummary = out.some((m) => m.id.startsWith('sum_'));
  assert.equal(hasSummary, true, '摘要必须出现 —— 否则长会话记不住开头');

  const total = out.reduce((n, m) => n + m.tokenEst, 0);
  assert.ok(total <= 1100, `总 token 不应超预算太多（实际 ${total}）`);
});

test('没有摘要时行为不变（全预算装最近消息）', () => {
  const msgs: Message[] = [];
  for (let i = 0; i < 20; i += 1) msgs.push(mkMsg(i + 11, 'x'.repeat(300), 100));

  const out = packSessionReplay(mkThread(null), msgs, 1000);
  assert.equal(out.some((m) => m.id.startsWith('sum_')), false, '无摘要时不该凭空造一条');
  const total = out.reduce((n, m) => n + m.tokenEst, 0);
  assert.ok(total <= 1000, `总 token 不应超预算（实际 ${total}）`);
});

test('摘要排在最近消息之前（代表更早的历史）', () => {
  const summary = '早期历史摘要';
  const msgs: Message[] = [mkMsg(11, '最近一句', 10), mkMsg(12, '最后一句', 10)];
  const out = packSessionReplay(mkThread(summary), msgs, 8000);
  assert.ok(out.length >= 3, '应有摘要 + 2 条消息');
  assert.ok(out[0]!.id.startsWith('sum_'), '第一条应是摘要');
});
