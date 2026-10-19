/**
 * tests/db-migration-tasks-rebuild.test.ts —— 迁移 140 的三个坑。
 *
 * 背景：`tasks.stop_reason` 的 CHECK 约束里没有 `endpoints_unreachable` /
 * `no_qualified_primary`，导致「模型网关不可达」被标成 `circuit_open`，
 * 而恢复逻辑只在 mode/breaker 变化时唤醒 —— 网关修好后任务永远卡在 paused。
 *
 * SQLite 不能 ALTER CHECK 约束，只能重建表。重建过程踩了三个坑，这个测试全部钉住：
 *
 *  ① **迁移文件里不能写 BEGIN/COMMIT**（框架自己开事务）→ 报
 *     "cannot start a transaction within a transaction"。
 *  ② **不能有 `PRAGMA foreign_keys=ON`** → 框架把文件里所有 PRAGMA 在 DDL **之前**
 *     一次性跑掉，ON 会覆盖 OFF，DROP TABLE 又报 "FOREIGN KEY constraint failed"。
 *  ③ **注释里不能出现单引号** → `splitStatements` 会把它当成字符串起始，
 *     一路吞到下一个单引号，语句边界全乱（PRAGMA 和最后一个索引凭空消失）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { splitStatements } from '../db/migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIG = join(here, '..', 'db', 'migrations', '140_stop_reason_extend.sql');
const sql = readFileSync(MIG, 'utf8');

test('① 文件里不能有 BEGIN / COMMIT（框架自己开事务）', () => {
  const stmts = splitStatements(sql).map((s) => s.replace(/^\s*(--[^\n]*\n\s*)*/g, '').trim());
  for (const s of stmts) {
    assert.ok(!/^BEGIN\b/i.test(s), '迁移文件不得写 BEGIN —— 框架已开事务');
    assert.ok(!/^COMMIT\b/i.test(s), '迁移文件不得写 COMMIT —— 框架负责提交');
  }
});

test('② 只能有 foreign_keys=OFF，不能有 =ON（ON 会覆盖 OFF）', () => {
  const pragmas = splitStatements(sql)
    .map((s) => s.replace(/^\s*(--[^\n]*\n\s*)*/g, '').trim())
    .filter((s) => /^PRAGMA\b/i.test(s));
  const fk = pragmas.filter((p) => /foreign_keys/i.test(p));
  assert.ok(
    fk.some((p) => /foreign_keys\s*=\s*OFF/i.test(p)),
    '必须有 PRAGMA foreign_keys=OFF（否则 DROP TABLE 被 task_results 的外键挡住）',
  );
  assert.ok(
    !fk.some((p) => /foreign_keys\s*=\s*ON/i.test(p)),
    '不能有 PRAGMA foreign_keys=ON —— 框架会把所有 PRAGMA 在 DDL 前一次跑完，ON 覆盖 OFF',
  );
});

test('③ 注释里不能有单引号（会破坏 splitStatements）', () => {
  const commentLines = sql.split('\n').filter((l) => l.trimStart().startsWith('--'));
  const bad = commentLines.filter((l) => l.includes("'"));
  assert.deepEqual(bad, [], '注释行里出现单引号会让分词器吞掉后续语句');
});

test('语句拆分结果完整：PRAGMA + 建表 + 搬数据 + 换名 + 三个索引', () => {
  const stmts = splitStatements(sql)
    .map((s) => s.replace(/^\s*(--[^\n]*\n\s*)*/g, '').trim())
    .filter((s) => s.length > 0);
  const kinds = stmts.map((s) => {
    if (/^PRAGMA/i.test(s)) return 'pragma';
    if (/^CREATE TABLE tasks_new/i.test(s)) return 'create';
    if (/^INSERT INTO tasks_new/i.test(s)) return 'insert';
    if (/^DROP TABLE tasks/i.test(s)) return 'drop';
    if (/^ALTER TABLE tasks_new RENAME/i.test(s)) return 'rename';
    if (/^CREATE INDEX idx_tasks_pop/i.test(s)) return 'idx_pop';
    if (/^CREATE INDEX idx_tasks_live/i.test(s)) return 'idx_live';
    if (/^CREATE INDEX idx_tasks_done/i.test(s)) return 'idx_done';
    return 'other:' + s.slice(0, 20);
  });
  for (const want of ['pragma', 'create', 'insert', 'drop', 'rename', 'idx_pop', 'idx_live', 'idx_done']) {
    assert.ok(kinds.includes(want), `拆分结果里应有 ${want}，实际：${kinds.join(', ')}`);
  }
});
