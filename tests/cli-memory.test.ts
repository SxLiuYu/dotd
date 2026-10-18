/**
 * tests/cli-memory.test.ts —— `dotd memory archive|restore` 命令。
 *
 * 2026-10-18：记忆备份有了 `.archive/` 和 API，但恢复还得记两个端点加 JSON body。
 * 这两条 CLI 把它变成一句话：
 *   dotd memory archive [--path MEMORY.md]
 *   dotd memory restore <归档文件名>
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'surfaces', 'cli.ts'), 'utf8');

test('CLI 有 memory archive / memory restore 两条命令', () => {
  assert.match(src, /program\.command\('memory'\)/, '必须有 memory 命令组');
  assert.match(src, /\.command\('archive'\)/, '必须有 archive 子命令');
  assert.match(src, /\.command\('restore <archive>'\)/, '必须有 restore 子命令');
});

test('archive 支持 --path 与 --limit', () => {
  assert.match(src, /\.option\('-p, --path <path>'/, '必须支持按文件过滤');
  assert.match(src, /\.option\('-l, --limit <n>'/, '必须支持条数上限');
});

test('两条命令都走对应 API 端点（CLI 不直连库，契约 D2/H2）', () => {
  assert.ok(src.includes('/api/memory/archive?'), 'archive 走 GET /api/memory/archive');
  assert.ok(src.includes("'/api/memory/restore'"), 'restore 走 POST /api/memory/restore');
  // 不得出现直连 SQLite 的迹象
  assert.equal(/new DatabaseSync/.test(src), false, 'CLI 不得直连 SQLite');
});

test('restore 失败时设置非零退出码', () => {
  const idx = src.indexOf(".command('restore <archive>')");
  assert.ok(idx > 0);
  const body = src.slice(idx, idx + 1200);
  assert.ok(body.includes('process.exitCode = 1'), '失败必须非零退码（脚本里能判）');
});
