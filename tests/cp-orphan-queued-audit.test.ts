/**
 * tests/cp-orphan-queued-audit.test.ts —— 排队但永远不会被派发的任务必须可见。
 *
 * 现场（2026-10-25）：线上一条 `dot_id='default'` 的 queued 任务从 10-24 起一直
 * 排着，而 Runner 只认 `dot1`（`pop(dotId)` 按 dot 过滤）。没有报错、没有事件、
 * 面板上也看不出异常 —— 只是"主人让它干的事永远没人干"。
 *
 * repair 的选择：**只审计不改**。dot_id 决定任务落到哪个容器/身份，猜错比卡住更糟
 * （可能拿另一个 dot 的登录态去执行）。启动时记 watchdog/guarded 事件 + 打日志，
 * 由主人确认归属后再改。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditOrphanQueuedTasks } from '../src/control-plane/recovery.ts';
import { openMigratedTemplateDb } from '../db/template.ts';

function fixture(): {
  db: ReturnType<typeof openMigratedTemplateDb>;
  events: Array<{ kind: string; level: string; detail: string }>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dotd-orphan-'));
  const db = openMigratedTemplateDb(join(dir, 't.db'));
  const events: Array<{ kind: string; level: string; detail: string }> = [];
  return { db, events };
}

function insertTask(db: ReturnType<typeof openMigratedTemplateDb>, id: string, dotId: string, status = 'queued'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, dot_id, title, goal, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, dotId, id, 'g', status, now, now);
}

const record = (events: Array<{ kind: string; level: string; detail: string }>) =>
  (kind: string, level: string, detail: string): void => {
    events.push({ kind, level, detail });
  };

test('只报落在未注册 dot 上的 queued 任务（running/done 不算）', () => {
  const { db, events } = fixture();
  try {
    insertTask(db, 'ok1', 'dot1');
    insertTask(db, 'orphan1', 'default');
    insertTask(db, 'running-other', 'other', 'running');
    insertTask(db, 'done-other', 'other', 'done');

    const ids = auditOrphanQueuedTasks(db, ['dot1'], record(events));
    assert.deepEqual(ids, ['orphan1'], '只有 queued + 未注册 dot 才算孤儿');
  } finally {
    db.close();
  }
});

test('审计结果落一条 watchdog/guarded 事件（重启后仍可追溯）', () => {
  const { db, events } = fixture();
  try {
    insertTask(db, 'orphan1', 'default');
    auditOrphanQueuedTasks(db, ['dot1'], record(events));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'watchdog');
    assert.equal(events[0]!.level, 'guarded');
    const detail = JSON.parse(events[0]!.detail) as { orphanQueued: number; tasks: Array<{ id: string }> };
    assert.equal(detail.orphanQueued, 1);
    assert.equal(detail.tasks[0]!.id, 'orphan1');
  } finally {
    db.close();
  }
});

test('没有孤儿时不留事件（正常启动日志保持干净）', () => {
  const { db, events } = fixture();
  try {
    insertTask(db, 'ok1', 'dot1');
    assert.deepEqual(auditOrphanQueuedTasks(db, ['dot1'], record(events)), []);
    assert.equal(events.length, 0);
  } finally {
    db.close();
  }
});

test('未知 dot 清单为空 → 不做判断也不报（测试/无容器场景）', () => {
  const { db, events } = fixture();
  try {
    insertTask(db, 'any', 'whatever');
    assert.deepEqual(auditOrphanQueuedTasks(db, [], record(events)), []);
    assert.equal(events.length, 0);
  } finally {
    db.close();
  }
});
