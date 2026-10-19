/**
 * tests/runner-replay-budget.test.ts —— 会话重放必须有独立预算。
 *
 * 现场（2026-10-19）：一个 461 条消息的线程，prompt 高达 28329 tokens，
 * 其中 19878 是历史，而历史里 **460 条是早已作废的工具输出**（只有 2 句真实对话）。
 *
 * 根因两处叠加：
 *   ① `buildSessionReplay(threadId, taskId, budgetTokens)` 传的是
 *      `session.budgetTokens`（= 200000），对"重放历史"来说等于不限；
 *   ② `packSessionReplay` 从新到旧累加到预算为止——预算无限，就是全量装入。
 *
 * 修法：给会话重放一个**独立的小预算**（REPLAY_BUDGET_TOKENS = 8000），
 * 超出的从最旧开始丢弃（packSessionReplay 天然如此）。
 *
 * 这个测试做源码守卫：确保重放调用不再直接用 session.budgetTokens。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

test('会话重放不得直接使用 session.budgetTokens（那是任务预算，200000 等于不限）', () => {
  const idx = src.indexOf('buildSessionReplay(');
  assert.ok(idx > 0, 'dot.ts 里应有 buildSessionReplay 调用');
  const call = src.slice(idx, idx + 900);
  // 只看**代码行**（去掉注释）：注释里提到 session.budgetTokens 是解释"为什么不能这么做"
  const codeLines = call
    .split('\n')
    .filter((l) => !/^\s*\//.test(l) && !/^\s*\*/.test(l))
    .join('\n');
  assert.ok(
    !/session\.budgetTokens/.test(codeLines),
    'buildSessionReplay 的第三个参数不能是 session.budgetTokens —— 那会让长会话全量重放',
  );
  assert.ok(
    /REPLAY_BUDGET_TOKENS/.test(call),
    '应传入专门的 REPLAY_BUDGET_TOKENS 常量',
  );
});

test('REPLAY_BUDGET_TOKENS 常量存在且是个合理的小值', () => {
  const m = /const REPLAY_BUDGET_TOKENS = ([\d_]+);/.exec(src);
  assert.ok(m !== null, '应有 REPLAY_BUDGET_TOKENS 常量定义');
  const v = Number(m![1]!.replace(/_/g, ''));
  assert.ok(v > 0, '预算必须为正');
  assert.ok(v <= 20000, `重放预算不应超过 20000 tokens（实际 ${v}）——否则起不到限制作用`);
});
