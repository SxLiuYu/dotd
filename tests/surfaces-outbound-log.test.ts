/**
 * tests/surfaces-outbound-log.test.ts —— 出站消息审计。
 *
 * 现场（2026-10-19）：飞书出站（任务终态回复、审批请求）原来**只写日志**，
 * 而 daemon 日志每次重启都被清空（scripts/wsl-daemon.sh 里 `: > "$LOG"`）。
 *
 * 后果：主人说"我没收到回复"时，事后完全无法回答——
 * 那条任务回没回？发到哪个会话？飞书 API 报了什么错？全都查不到。
 *
 * 修法：落 surf_outbound_log 表（迁移 130），recordOutbound/listOutbound 读写，
 * GET /api/outbound + `dotd outbound` 查看。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { listOutbound, recordOutbound } from '../src/surfaces/feishu-outbound.ts';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE surf_outbound_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
      error TEXT,
      text_preview TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  return db;
}

test('recordOutbound 记录成功与失败两种结果', () => {
  const db = makeDb();
  recordOutbound(db, {
    kind: 'task_reply',
    dedupKey: 'k1',
    chatId: 'oc_a',
    ok: true,
    error: null,
    textPreview: '完成了',
    at: '2026-10-19T02:00:00.000Z',
  });
  recordOutbound(db, {
    kind: 'task_reply',
    dedupKey: 'k2',
    chatId: 'oc_a',
    ok: false,
    error: 'permission denied',
    textPreview: '没发出去',
    at: '2026-10-19T02:01:00.000Z',
  });

  const rows = listOutbound(db, { limit: 10 });
  assert.equal(rows.length, 2);
  const fail = rows.find((r) => !r.ok);
  assert.ok(fail !== undefined, '应能读到失败的记录');
  assert.equal(fail!.error, 'permission denied', '失败原因必须落库 —— 这是排查的关键信息');
  assert.equal(fail!.chatId, 'oc_a');
  db.close();
});

test('listOutbound 按时间倒序（最近的在最前）', () => {
  const db = makeDb();
  recordOutbound(db, { kind: 'task_reply', dedupKey: 'a', chatId: 'c', ok: true, error: null, textPreview: 'first', at: '2026-10-19T01:00:00.000Z' });
  recordOutbound(db, { kind: 'task_reply', dedupKey: 'b', chatId: 'c', ok: true, error: null, textPreview: 'second', at: '2026-10-19T02:00:00.000Z' });
  const rows = listOutbound(db, { limit: 10 });
  assert.equal(rows[0]!.textPreview, 'second', '最新的应排在最前');
  db.close();
});

test('listOutbound 支持按 kind 过滤', () => {
  const db = makeDb();
  recordOutbound(db, { kind: 'task_reply', dedupKey: 'a', chatId: 'c', ok: true, error: null, textPreview: 'x', at: '2026-10-19T01:00:00.000Z' });
  recordOutbound(db, { kind: 'approval', dedupKey: 'b', chatId: 'c', ok: true, error: null, textPreview: 'y', at: '2026-10-19T02:00:00.000Z' });
  assert.equal(listOutbound(db, { limit: 10, kind: 'approval' }).length, 1);
  assert.equal(listOutbound(db, { limit: 10, kind: 'task_reply' }).length, 1);
  db.close();
});

test('recordOutbound 在 db 为 undefined 或表缺失时静默失败（不影响发送）', () => {
  // 审计是旁路：写不进去绝不能让"回复主人"这件事失败
  assert.doesNotThrow(() => {
    recordOutbound(undefined, {
      kind: 'task_reply',
      dedupKey: 'k',
      chatId: 'c',
      ok: true,
      error: null,
      textPreview: 'x',
      at: '2026-10-19T00:00:00.000Z',
    });
  });
  const noTable = new DatabaseSync(':memory:');
  assert.doesNotThrow(() => {
    recordOutbound(noTable, {
      kind: 'task_reply',
      dedupKey: 'k',
      chatId: 'c',
      ok: true,
      error: null,
      textPreview: 'x',
      at: '2026-10-19T00:00:00.000Z',
    });
  });
  noTable.close();
});
