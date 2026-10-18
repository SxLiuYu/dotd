/**
 * tests/runner-repeat-result-normalize.test.ts —— "结果有没有变化"要先剔掉易变字段。
 *
 * 现场（2026-10-18）：模型对同一文件、同一内容连续 `fs.write` 4 次，护栏全程不动。
 * 查下来：`fs.write` 返回 `{path, size_bytes, written_at}`，**written_at 每次都不同**
 * → 两次结果字符串永不相等 → `sameResultCount` 停在 1 → "同结果重复"判据形同虚设。
 *
 * 修法：比较前先归一化，剔掉时间戳/耗时这类"每次都不一样、但不代表进展"的字段。
 * 这类字段只说明"什么时候做的"，不改变"做成了什么"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeResultForRepeatForTest } from '../src/runner/dot.ts';

test('只有时间戳不同 → 视为同一结果（护栏才会介入）', () => {
  const a = { path: 'n1.txt', size_bytes: 1, written_at: '2026-10-18T11:48:02.304Z' };
  const b = { path: 'n1.txt', size_bytes: 1, written_at: '2026-10-18T11:49:13.232Z' };
  assert.equal(
    normalizeResultForRepeatForTest(a),
    normalizeResultForRepeatForTest(b),
    'written_at 不同不该算"结果变了"',
  );
});

test('实质内容不同 → 仍视为不同结果（不能过度归一）', () => {
  const a = { path: 'n1.txt', size_bytes: 1, written_at: 'x' };
  const b = { path: 'n1.txt', size_bytes: 2, written_at: 'x' };
  assert.notEqual(normalizeResultForRepeatForTest(a), normalizeResultForRepeatForTest(b));
});

test('键顺序不影响归一化结果', () => {
  const a = { path: 'a', size_bytes: 1, written_at: 'x' };
  const b = { written_at: 'x', size_bytes: 1, path: 'a' };
  assert.equal(normalizeResultForRepeatForTest(a), normalizeResultForRepeatForTest(b));
});

test('执行类结果的耗时字段也被剔除', () => {
  const a = { exit_code: 0, stdout: 'ok\n', wall_ms: 12, peak_mem_mb: 8 };
  const b = { exit_code: 0, stdout: 'ok\n', wall_ms: 31, peak_mem_mb: 9 };
  assert.equal(normalizeResultForRepeatForTest(a), normalizeResultForRepeatForTest(b));
});

test('非对象输入原样序列化（不崩、不过度处理）', () => {
  assert.equal(normalizeResultForRepeatForTest('hello'), JSON.stringify('hello'));
  assert.equal(normalizeResultForRepeatForTest(42), JSON.stringify(42));
  assert.equal(normalizeResultForRepeatForTest(null), 'null');
});

test('签名里的 path 归一化：g1.txt 与 /dot/home/g1.txt 视为同一调用', async () => {
  // 现场（2026-10-18）：同一文件被写了 8 次，写法在 g1.txt 与 /dot/home/g1.txt 之间来回换，
  // 字符串不同 → 护栏数不到重复。
  const { repeatSignatureForTest } = await import('../src/runner/dot.ts');
  const a = JSON.stringify({ content: '3', path: 'g1.txt' });
  const b = JSON.stringify({ content: '3', path: '/dot/home/g1.txt' });
  assert.equal(repeatSignatureForTest(a), repeatSignatureForTest(b), '同一文件的两种写法必须同签名');
  // 不同文件仍然是不同签名
  const c = JSON.stringify({ content: '3', path: 'g2.txt' });
  assert.notEqual(repeatSignatureForTest(a), repeatSignatureForTest(c));
});
