/**
 * tests/runner-auto-expected-size.test.ts —— Runner 自动给 fs.write 补 expected_size。
 *
 * 现场（2026-10-18）：CAS 能力做好后，**模型从不主动传 expected_size**
 * ——工具描述和 system prompt 都写了两轮，实测 0 次使用。
 * 可并发丢数据是真问题（10 个并发 RMW 只留 3 行）。
 *
 * 结论：不能靠提示词，要变成**默认行为**。Runner 在本任务 fs.read 过某文件时，
 * 自动给随后的 fs.write 补上 expected_size；模型自己传了就尊重它的值。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

test('Runner 维护"本任务读过的文件大小"表', () => {
  assert.match(src, /private readonly readSizes = new Map<string, number>\(\)/, '必须有 readSizes 表');
  assert.match(src, /this\.readSizes\.clear\(\)/, '每个任务开始时必须清空（跨任务无意义还会污染）');
  assert.match(src, /if \(ok && call\.name === 'fs\.read'\) this\.noteReadSize/, 'fs.read 成功后要记大小');
});

test('fs.write 派发前自动补 expected_size', () => {
  assert.ok(src.includes('withAutoExpectedSize'), '必须有自动补值函数');
  const idx = src.indexOf('private withAutoExpectedSize(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  }', idx) + 4);
  assert.ok(body.includes("if (tool !== 'fs.write') return args;"), '只对 fs.write 生效');
  assert.ok(
    body.includes("if (args['expected_size'] !== undefined) return args;"),
    '模型自己传了就尊重它',
  );
  assert.ok(body.includes('this.readSizes.get(key)'), '没读过就不补（新建文件无基线）');
});

test('派发点传的是补过参的 argsForExec', () => {
  assert.match(src, /const argsForExec = this\.withAutoExpectedSize\(call\.name, args\)/);
  assert.match(src, /toolCall\(task, callId, call\.name, argsForExec,/);
});

test('路径键归一化：/dot/home/x 与 x 命中同一条记录', () => {
  const idx = src.indexOf('function normalizePathForReadSize');
  assert.ok(idx > 0, '必须有路径归一化');
  // 到下一个顶层注释为止（函数体里有 }，不能按第一个 } 切）
  const body = src.slice(idx, idx + 300);
  assert.ok(body.includes('dot\\/home'), '必须剥家目录前缀');
});
