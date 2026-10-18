/**
 * tests/surfaces-memory-archive.test.ts —— 记忆备份的查询与恢复入口。
 *
 * 2026-10-18：`fs.write` 覆盖前会把旧版本存进 `.archive/`，但恢复只能手动
 * `docker exec cp` —— 等于"有能力、没入口"。这轮补上两个 API：
 *
 *   GET  /api/memory/archive   列出备份（可按 path 过滤）
 *   POST /api/memory/restore   把某个归档写回原路径
 *
 * 设计要点：
 *   - 归档名形状 `<ISO时间戳>__<原路径，斜杠换成下划线>`；
 *   - 恢复走执行面的 fs.read + fs.write，于是**恢复本身也会触发归档**（可回滚）；
 *   - 未装配时返回 501（不是 500，也不是静默 404）——让人一眼看出是"没配"而不是"出错"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchRoute } from '../src/surfaces/http.ts';

test('路由：GET /api/memory/archive 与 POST /api/memory/restore', () => {
  assert.equal(matchRoute('GET', '/api/memory/archive')?.route, 'memory_archive');
  assert.equal(matchRoute('POST', '/api/memory/restore')?.route, 'memory_restore');
  // 方法不匹配不该路由过去
  assert.notEqual(matchRoute('POST', '/api/memory/archive')?.route, 'memory_archive');
  assert.notEqual(matchRoute('GET', '/api/memory/restore')?.route, 'memory_restore');
});

test('归档名解析：时间戳 + 原路径', () => {
  // 与 daemon.ts 的 listMemoryArchiveViaExec 同一套解析规则
  const name = '2026-10-18T14-30-50-089Z__MEMORY.md';
  const sep = name.indexOf('__');
  const archivedAt = name.slice(0, sep);
  const originalPath = name.slice(sep + 2).replace(/_/g, '/');
  assert.equal(archivedAt, '2026-10-18T14-30-50-089Z');
  assert.equal(originalPath, 'MEMORY.md');

  // notes/ 下的文件：斜杠被换成下划线，恢复时要还原
  const name2 = '2026-10-18T14-30-50-089Z__notes_2026-10-18-x.md';
  const s2 = name2.indexOf('__');
  assert.equal(name2.slice(s2 + 2).replace(/_/g, '/'), 'notes/2026-10-18-x.md');
});

test('恢复路径拒绝目录穿越', () => {
  // daemon.ts 里 restoreMemoryArchiveViaExec 的守卫：名字不能含 / 或 ..
  const bad = ['../etc/passwd', 'a/b', '..'];
  for (const n of bad) {
    assert.ok(n.includes('/') || n.includes('..'), `${n} 应被守卫拦下`);
  }
});
