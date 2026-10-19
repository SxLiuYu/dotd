/**
 * tests/db-template.test.ts —— `db/template.ts`（测试用空库模板）的等价性守卫。
 *
 * 背景（2026-10-17 测试套件加速）：`tests/helpers.ts` 的 `makeTempDataDir()` 现在走
 * 空库模板而不是每次真跑 `migrate()`。这条加速只有在**模板库与真迁移库逐字等价**时
 * 才允许存在——本文件就是那个判据：
 *
 * 1. `sqlite_master` 全量逐行比对（表 / 索引 / 视图 / 触发器 + 它们的 SQL 文本）；
 * 2. 每张表的列名、类型、NOT NULL、默认值、主键序号（`pragma_table_info`）逐行比对；
 * 3. `PRAGMA user_version` 相同；
 * 4. 迁移包一旦改动（新增列 / 新表 / 新索引）而模板缓存没跟上，本文件会红。
 * 5. 反向守卫：故意用 `sqlite_master.sql` 重建表（被 ALTER 过的表会被改写成 user_version=0
 *    的"半成品"）会被本文件的等价性判据抓住——见第二个用例。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.ts';
import { buildSchemaScript, getDbTemplate, openMigratedTemplateDb } from '../db/template.ts';

/** 一个真跑过 migrate() 的参照库（内存）。 */
function referenceDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function masterRows(db: DatabaseSync): MasterRow[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as unknown as MasterRow[];
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnsOf(db: DatabaseSync, table: string): ColumnRow[] {
  // `notnull` 是 SQLite 关键字（pragma_table_info 的列名），必须加引号。
  return db
    .prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
    .all(table) as unknown as ColumnRow[];
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** 断言模板库与参照库在 sqlite_master / 列定义 / user_version 上完全一致。 */
function assertEquivalent(template: DatabaseSync, reference: DatabaseSync, label: string): void {
  assert.equal(userVersion(template), userVersion(reference), `${label}：user_version 必须一致`);

  const refMaster = masterRows(reference);
  const tplMaster = masterRows(template);
  assert.deepEqual(
    tplMaster.map((r) => `${r.type}:${r.name}:${r.tbl_name}`),
    refMaster.map((r) => `${r.type}:${r.name}:${r.tbl_name}`),
    `${label}：schema 对象清单（表/索引/视图/触发器）必须一致`,
  );
  assert.deepEqual(
    tplMaster.map((r) => r.sql),
    refMaster.map((r) => r.sql),
    `${label}：每个 schema 对象的 SQL 文本必须逐字一致`,
  );

  const tables = refMaster.filter((r) => r.type === 'table').map((r) => r.name);
  assert.ok(tables.length >= 40, `参照库应有 ≥40 张表，实际 ${tables.length}`);
  for (const t of tables) {
    assert.deepEqual(columnsOf(template, t), columnsOf(reference, t), `${label}：表 ${t} 的列定义必须一致`);
  }
}

test('模板库等价性：内存模板 = 真迁移库（schema/列定义/user_version 逐字一致）', () => {
  const ref = referenceDb();
  try {
    const tpl = openMigratedTemplateDb();
    try {
      assertEquivalent(tpl, ref, '内存模板');
      // 模板必须真的"空"（只是结构，没有数据行）
      for (const row of masterRows(tpl).filter((r) => r.type === 'table')) {
        // FTS5 虚表的内部影子表（<name>_data/_idx/_docsize/_config）由 SQLite 自管，
        // _config 恒有 1 行（存 version 与 segment 计数），不是业务数据，跳过。
        if (/^mem_messages_fts_/.test(row.name)) continue;
        const n = tpl.prepare(`SELECT count(*) AS c FROM "${row.name}"`).get() as { c?: number } | undefined;
        assert.equal(n?.c, 0, `模板表 ${row.name} 应为空表`);
      }
    } finally {
      tpl.close();
    }
  } finally {
    ref.close();
  }
});

test('模板库等价性：文件模板 = 真迁移库，且 PRAGMA 终态仍是 WAL/FULL/busy=5000（契约 D1）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-tpl-'));
  const ref = referenceDb();
  const tpl = openMigratedTemplateDb(join(root, 'dotd.db'));
  try {
    assertEquivalent(tpl, ref, '文件模板');
    assert.equal(tpl.prepare('PRAGMA journal_mode').get() !== undefined, true);
    const jm = tpl.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    assert.equal(jm?.journal_mode, 'wal', '契约 D1：终态 journal_mode 必须是 WAL');
    const sync = tpl.prepare('PRAGMA synchronous').get() as { synchronous?: number } | undefined;
    assert.equal(sync?.synchronous, 2, '契约 D1：终态 synchronous 必须是 FULL(2)');
    const busy = tpl.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    assert.equal(busy?.timeout, 5000, '契约 D1：busy_timeout=5000');
  } finally {
    tpl.close();
    ref.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('模板缓存：getDbTemplate() 幂等，且模板脚本必须回放 ALTER（防"用 sqlite_master.sql 重建"的坑）', () => {
  const a = getDbTemplate();
  const b = getDbTemplate();
  assert.equal(a, b, '模板只建一次（进程内缓存）');
  assert.equal(a.userVersion, 150, '迁移终态 user_version=150');
  // 090/100 两个迁移包是纯 ADD COLUMN：模板脚本必须显式带上 ALTER，否则重建出来的表缺列。
  assert.match(a.script, /ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i, '模板脚本必须回放 ADD COLUMN');
  const tpl = openMigratedTemplateDb();
  try {
    const cols = columnsOf(tpl, 'endpoint_grants').map((c) => c.name);
    assert.ok(cols.includes('last_hit_at'), `模板 endpoint_grants 必须含 090 迁移加的 last_hit_at，实际 ${cols.join(',')}`);
    const mcl = columnsOf(tpl, 'model_call_log').map((c) => c.name);
    assert.ok(
      mcl.includes('cached_prompt_tokens'),
      `模板 model_call_log 必须含 100 迁移加的 cached_prompt_tokens，实际 ${mcl.join(',')}`,
    );
  } finally {
    tpl.close();
  }
});

test('反例守卫：只看 sqlite_master.sql 重建会丢 user_version（说明模板为何必须回放 ALTER）', () => {
  // 文档化的失败模式：被 ALTER 追加过列的表，其 sqlite_master.sql 是改写后的 CREATE 文本，
  // 但没有把 user_version 带过来。按它重建的库 user_version=0 → migrate() 会重复建表。
  const ref = referenceDb();
  try {
    const script = buildSchemaScript(ref);
    assert.match(script, /^PRAGMA user_version=150;/);
    const naive = new DatabaseSync(':memory:');
    try {
      const texts = (
        ref
          // FTS5 的影子表（mem_messages_fts_data/_idx/_docsize/_config）由虚表自管：
          // 按 sqlite_master 顺序重建时会先建虚表、再撞影子表 "already exists"，所以排除。
          .prepare(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'mem_messages_fts_%' ORDER BY rowid",
          )
          .all() as Array<{ sql: string }>
      ).map((r) => r.sql);
      naive.exec(texts.join(';\n'));
      // 结构或许能建出来，但版本信息丢了：朴素重建的 user_version 与真库不同。
      assert.notEqual(userVersion(naive), userVersion(ref), '朴素重建应丢失 user_version（本用例即证据）');
    } finally {
      naive.close();
    }
  } finally {
    ref.close();
  }
});
