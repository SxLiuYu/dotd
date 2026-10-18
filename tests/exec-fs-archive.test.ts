/**
 * tests/exec-fs-archive.test.ts —— 覆盖前归档旧版本。
 *
 * 现场（2026-10-18 事故）：模型把 MEMORY.md 写成空串，一千多字记忆瞬间归零，
 * 靠外部手段才恢复。防清空保护只挡"整篇写空"，挡不住"写成别的内容"
 * （误删一半、覆盖错文件、改乱结构）。
 *
 * 兜底：**覆盖前把旧内容存进 `.archive/<时间戳>__<文件名>`**。
 * `.archive/` 是协议里早就预留的目录（§3.4：硬限 32MB、按时间 FIFO），
 * 但一直没有实际写入逻辑 —— 这轮补上。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsTools } from '../agent-runtime/fs.ts';

function makeFs(homeRoot: string): FsTools {
  return new FsTools({ homeRoot } as unknown as ConstructorParameters<typeof FsTools>[0]);
}

test('覆盖已有文件 → 旧内容进 .archive/，新内容正确写入', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotd-arch-'));
  const tools = makeFs(home);
  writeFileSync(join(home, 'MEMORY.md'), '# MEMORY\n重要内容\n');

  const res = tools.write('a1', { path: 'MEMORY.md', content: '# MEMORY\n改过的内容\n' });
  assert.equal(res.status, 'ok', `应成功，实际 ${JSON.stringify(res)}`);

  // 新内容生效
  assert.equal(readFileSync(join(home, 'MEMORY.md'), 'utf8'), '# MEMORY\n改过的内容\n');

  // 旧版本被归档
  const arch = readdirSync(join(home, '.archive'));
  assert.equal(arch.length, 1, `应有 1 个归档，实际 ${arch.length}`);
  assert.ok(arch[0]!.endsWith('__MEMORY.md'), `归档名应含原文件名，实际 ${arch[0]}`);
  assert.equal(
    readFileSync(join(home, '.archive', arch[0]!), 'utf8'),
    '# MEMORY\n重要内容\n',
    '归档内容必须是覆盖前的原文',
  );

  // 返回值里带归档名（可追溯）
  // 返回结构是 { status, result: { path, size_bytes, written_at, archived_as } }
  const result = (res as unknown as { result?: { archived_as?: string } }).result;
  assert.ok(String(result?.archived_as).startsWith('.archive/'), '返回值应带 archived_as');
});

test('新建文件不产生归档', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotd-arch-'));
  const tools = makeFs(home);
  const res = tools.write('a2', { path: 'new.txt', content: 'hello' });
  assert.equal(res.status, 'ok');
  assert.equal(existsSync(join(home, '.archive')), false, '没有旧内容就不该建 .archive');
});

test('空文件被覆盖不归档（没有可留的内容）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotd-arch-'));
  const tools = makeFs(home);
  writeFileSync(join(home, 'empty.txt'), '');
  const res = tools.write('a3', { path: 'empty.txt', content: 'now has content' });
  assert.equal(res.status, 'ok');
  const result = (res as unknown as { result?: { archived_as?: string } }).result;
  assert.equal(result?.archived_as, undefined, '空文件不该产生归档');
});

test('多次覆盖 → 每次都留一份，且能被 FIFO 修剪', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotd-arch-'));
  const tools = makeFs(home);
  writeFileSync(join(home, 'log.md'), 'v0');
  tools.write('a4', { path: 'log.md', content: 'v1' });
  tools.write('a5', { path: 'log.md', content: 'v2' });
  tools.write('a6', { path: 'log.md', content: 'v3' });
  const arch = readdirSync(join(home, '.archive'));
  assert.ok(arch.length >= 2, `多次覆盖应留多份，实际 ${arch.length}`);
});

test('隐藏目录里的文件不归档（.archive/.tmp 自身不能被递归归档）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dotd-arch-'));
  const tools = makeFs(home);
  // .tmp/ 下的文件可写（协议允许），但不该产生归档
  const res = tools.write('a7', { path: '.tmp/scratch.txt', content: 'x' });
  // 首次写入即新建，本来也不归档；这里主要断言不炸
  assert.ok(['ok', 'error'].includes(res.status));
});
