/**
 * tests/observability-faults.test.ts —— 关键故障必须"看得见"。
 *
 * 现场（2026-10-18）：模型端点全挂时，任务正确进入 `paused(circuit_open)`，
 * 但**日志里没有任何记录**，`resource_events` 里也查不到。主人只看到"DS 不回话"，
 * 无从判断是模型挂了还是 dotd 坏了。
 *
 * 这与之前踩过的"WSL 密钥错误只藏在数据库里"是同一类问题：
 * **状态记录正确 ≠ 故障可观察**。可观察性必须是显式要求，不能靠碰巧。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');
const queue = readFileSync(join(here, '..', 'src', 'control-plane', 'queue.ts'), 'utf8');

test('模型熔断时必须打日志（不能只写 stop_reason）', () => {
  const idx = runner.indexOf('pauseByReason(task.id,');
  assert.ok(idx > 0, '必须有熔断暂停路径');
  // 往前看这段上下文里有没有 this.log
  const around = runner.slice(Math.max(0, idx - 900), idx);
  assert.ok(
    around.includes('this.log(') && around.includes('circuit_open'),
    '熔断前必须先打一条日志（说明是模型端点挂了、恢复后自动回队）',
  );
});

test('pauseByReason 必须落 resource_events（可事后查证）', () => {
  const idx = queue.indexOf('pauseByReason(');
  assert.ok(idx > 0);
  const end = queue.indexOf('\n  }', idx);
  const body = queue.slice(idx, end);
  assert.ok(
    body.includes("'task_paused'") || body.includes('task_paused'),
    '暂停必须记一条 resource_events（kind=task_paused），否则事后无从追查',
  );
  assert.ok(body.includes('resource_events'), '必须写 resource_events 表');
});

test('事件写入失败不得影响暂停本身（审计面不能炸主流程）', () => {
  const idx = queue.indexOf('task_paused');
  const around = queue.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(around.includes('try'), '事件写入必须包 try/catch');
  assert.ok(
    around.includes('绝不能影响暂停') || around.includes('审计面'),
    '要有说明：审计写入失败不影响暂停',
  );
});
