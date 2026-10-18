/**
 * tests/exec-fs-write-cas.test.ts —— fs.write 的乐观并发控制（expected_size）。
 *
 * 现场（2026-10-18）：10 个并发进程做"读全文 → 追加 → 写回"，最终只剩 2 行（**丢了 9 行**）——
 * 后写的直接覆盖先写的。模型"读 MEMORY.md → 改 → 写回"正是这个模式，
 * `DOTD_MAX_RUNNING>1` 时会真实丢数据。
 *
 * 修法：`fs.write` 支持可选的 `expected_size`（模型从 fs.read 的 size_bytes 拿到）。
 * 文件在读取之后被别人改过 → 拒写并返回 `stale_write`（retryable），
 * 模型重读一遍再改即可。**不传则不校验**（保持既有行为，零行为回退）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsTools } from '../agent-runtime/fs.ts';

/** 造一个只认 root 的 FsTools（沙箱判定用不到真实 /dot/home）。 */
function makeFs(root: string): FsTools {
  // FsToolsDeps 的键是 homeRoot（不是 root）——写错会让沙箱根落到默认 /dot/home，
  // 导致 statSync 读到不存在的文件、实际大小恒为 0（2026-10-18 单测踩到）。
  return new FsTools({ homeRoot: root } as unknown as ConstructorParameters<typeof FsTools>[0]);
}

test('expected_size 与实际一致 → 写入成功', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cas-'));
  const fs = makeFs(root);
  const p = join(root, 'a.txt');
  writeFileSync(p, 'abc');

  const res = fs.write('c1', { path: 'a.txt', content: 'abcd', expected_size: 3 });
  assert.equal(res.status, 'ok', `应成功，实际 ${JSON.stringify(res)}`);
  assert.equal(readFileSync(p, 'utf8'), 'abcd');
});

test('expected_size 不一致 → 拒写并返回 stale_write（retryable）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cas-'));
  const fs = makeFs(root);
  const p = join(root, 'b.txt');
  writeFileSync(p, 'xyz');

  // 模拟"别人在我读取之后改了文件"：我以为是 3 字节，实际已被改成 5 字节
  const res = fs.write('c2', { path: 'b.txt', content: 'new', expected_size: 999 });
  assert.notEqual(res.status, 'ok', '必须拒绝');
  const err = (res as unknown as { error?: { code?: string; retryable?: boolean } }).error;
  assert.equal(err?.code, 'stale_write', '错误码必须是 stale_write');
  assert.equal(err?.retryable, true, '必须可重试（模型重读后再写）');
  assert.equal(readFileSync(p, 'utf8'), 'xyz', '原文件内容不能被改动');
});

test('不传 expected_size → 不校验（零行为回退）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cas-'));
  const fs = makeFs(root);
  const p = join(root, 'c.txt');
  writeFileSync(p, 'old');

  const res = fs.write('c3', { path: 'c.txt', content: 'replaced' });
  assert.equal(res.status, 'ok');
  assert.equal(readFileSync(p, 'utf8'), 'replaced');
});

test('新建文件：expected_size=0 允许，非 0 拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cas-'));
  const fs = makeFs(root);

  const ok = fs.write('c4', { path: 'fresh.txt', content: 'hi', expected_size: 0 });
  assert.equal(ok.status, 'ok', '新建文件传 0 应允许');
  assert.ok(existsSync(join(root, 'fresh.txt')));

  const bad = fs.write('c5', { path: 'fresh2.txt', content: 'hi', expected_size: 10 });
  assert.notEqual(bad.status, 'ok', '文件不存在却期望 10 字节 → 必须拒');
  assert.equal(existsSync(join(root, 'fresh2.txt')), false, '被拒时不能留下文件');
});

test('非法 expected_size（负数/小数）不当作校验条件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cas-'));
  const fs = makeFs(root);
  writeFileSync(join(root, 'd.txt'), 'abc');

  // -1 不是非负整数 → 视为"没传"，不校验
  const neg = fs.write('c6', { path: 'd.txt', content: 'ok', expected_size: -1 });
  assert.equal(neg.status, 'ok', '非法值应视为未传，不阻断');
});
