/**
 * tests/memory-home-prefix.test.ts —— 家目录前缀不是逃逸。
 *
 * 现场（2026-10-18）：模型用 `fs.read("/dot/home/n1.txt")` **成功**（执行面自动规范化），
 * 于是它合理推断"绝对路径可以用于读写"，接着 `fs.write("/dot/home/n2.txt")` 被记忆层**拒绝**。
 * 一读一写两种行为，模型学到的是错的经验，于是反复撞墙、白烧步数。
 *
 * 修法：`normalizeHomePath` 把 `/dot/home` 前缀连同其后斜杠剥掉（那是家目录自身的路径）；
 * 其余绝对路径（`/etc`、`/root`、`C:`）与 `..` 逃逸**照旧拒绝**——安全边界一个字都不放松。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeHomePath } from '../src/memory/limits.ts';

test('家目录前缀被剥掉（/dot/home/x 与 x 等价）', () => {
  assert.equal(normalizeHomePath('/dot/home/n1.txt'), 'n1.txt');
  assert.equal(normalizeHomePath('dot/home/a/b.md'), 'a/b.md');
  assert.equal(normalizeHomePath('/dot/home'), '');
  assert.equal(normalizeHomePath('n1.txt'), 'n1.txt', '相对路径不受影响');
});

test('家目录之外的真逃逸仍然一律拒绝（安全边界不放松）', () => {
  const mustReject = [
    '/etc/passwd',
    '/root/.ssh/id_rsa',
    '/dot/home/../etc/passwd',
    '/var/lib/docker',
    '../escape.txt',
    'a/../../b',
    'C:/Windows/System32',
    'D:\\\\x',
  ];
  for (const p of mustReject) {
    assert.equal(normalizeHomePath(p), null, `${p} 必须被拒`);
  }
});

test('相似但不同的前缀不被误剥', () => {
  // /dot/homework 不是 /dot/home/ 的前缀匹配
  assert.equal(normalizeHomePath('/dot/homework/x'), null, '/dot/homework 是绝对路径，必须拒');
  assert.equal(normalizeHomePath('dot/homework/x'), 'dot/homework/x', '相对路径 dot/homework 合法');
});
