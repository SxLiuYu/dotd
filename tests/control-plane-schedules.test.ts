/**
 * tests/control-plane-schedules.test.ts —— 用户可创建的定时任务。
 *
 * 背景（对标 OpenAI bot 的"定时任务/提醒"）：
 * `crontabs` 表早就有，调度器 `scanCrontabs` 也能扫描触发 ——
 * **但从来没有创建入口**，等于"引擎装好、没有方向盘"。模型想设个"每天 9 点提醒我"
 * 只能干瞪眼（2026-10-18 实测：这条请求直接跑到 timeout）。
 *
 * 本文件钉住创建链路的关键纪律：
 *   ① 坏 cron 必须在**进库前**被拒（否则调度器每 tick 撞同一错误只会静默停用）；
 *   ② 标题/prompt/cron 都必填（定时任务 = 到点让 bot 去做一件事）；
 *   ③ 最短间隔 1 分钟（更密会淹没对话额度）；
 *   ④ 能列出、能停用。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { createSchedule, listSchedules, removeSchedule } from '../src/control-plane/schedules.ts';

// 测试用的 cron 计算：只认标准 5 段，支持步进（星号斜杠 N）与固定分钟。
function fakeCronNext(cron: string, from: number): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('bad cron');
  const min = parts[0]!;
  if (min === '*') return from + 60_000;
  if (min.startsWith('*/')) {
    const n = Number(min.slice(2));
    if (!Number.isInteger(n) || n < 1) throw new Error('bad step');
    return from + n * 60_000;
  }
  const m = Number(min);
  if (!Number.isInteger(m) || m < 0 || m > 59) throw new Error('bad minute');
  return from + 60_000;
}

test('创建成功：落库、算出 next_fire、列出能看到', () => {
  const tmp = makeTempDataDir();
  try {
    const r = createSchedule(
      tmp.db,
      { title: '早间提醒', prompt: '看一下今天的天气', cron: '0 9 * * *' },
      fakeCronNext,
      1_000_000,
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.schedule !== undefined);
    assert.equal(r.schedule!.title, '早间提醒');
    assert.equal(r.schedule!.enabled, true);
    assert.ok(r.schedule!.nextFireAt > 1_000_000, 'next_fire 必须在未来');

    const all = listSchedules(tmp.db);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, r.schedule!.id);
  } finally {
    tmp.cleanup();
  }
});

test('坏 cron 在进库前被拒（不让调度器静默停用）', () => {
  const tmp = makeTempDataDir();
  try {
    const r = createSchedule(
      tmp.db,
      { title: 'x', prompt: 'y', cron: '不是cron' },
      fakeCronNext,
      1_000_000,
    );
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('5 段'), `错误信息应说清段数，实际：${r.error}`);
    assert.equal(listSchedules(tmp.db).length, 0, '被拒就不该落库');
  } finally {
    tmp.cleanup();
  }
});

test('段数不对 / 无法解析 都被拒', () => {
  const tmp = makeTempDataDir();
  try {
    const bad3 = createSchedule(tmp.db, { title: 'x', prompt: 'y', cron: '* * *' }, fakeCronNext, 1);
    assert.equal(bad3.ok, false);

    const unparseable = createSchedule(
      tmp.db,
      { title: 'x', prompt: 'y', cron: '99 99 99 99 99' },
      () => {
        throw new Error('out of range');
      },
      1,
    );
    assert.equal(unparseable.ok, false);
    assert.ok(String(unparseable.error).includes('无法解析'));
  } finally {
    tmp.cleanup();
  }
});

test('间隔太密被拒（最短 1 分钟）', () => {
  const tmp = makeTempDataDir();
  try {
    // 让 cron 算出 30 秒后
    const r = createSchedule(
      tmp.db,
      { title: 'x', prompt: 'y', cron: '* * * * *' },
      (_c, from) => from + 30_000,
      1_000_000,
    );
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('1 分钟'));
  } finally {
    tmp.cleanup();
  }
});

test('title / prompt 必填', () => {
  const tmp = makeTempDataDir();
  try {
    assert.equal(
      createSchedule(tmp.db, { title: '', prompt: 'y', cron: '0 9 * * *' }, fakeCronNext, 1).ok,
      false,
    );
    assert.equal(
      createSchedule(tmp.db, { title: 'x', prompt: '   ', cron: '0 9 * * *' }, fakeCronNext, 1).ok,
      false,
    );
  } finally {
    tmp.cleanup();
  }
});

test('停用后不再出现在默认列表里，但仍可带 includeDisabled 查到', () => {
  const tmp = makeTempDataDir();
  try {
    const r = createSchedule(
      tmp.db,
      { title: 't', prompt: 'p', cron: '0 9 * * *' },
      fakeCronNext,
      1_000_000,
    );
    const id = r.schedule!.id;
    assert.equal(removeSchedule(tmp.db, id).ok, true);
    assert.equal(listSchedules(tmp.db).length, 0, '停用后默认列表看不到');
    assert.equal(listSchedules(tmp.db, { includeDisabled: true }).length, 1, '带 includeDisabled 仍可见');
    // 再停用一次 → 报"没有这条"
    assert.equal(removeSchedule(tmp.db, id).ok, false);
  } finally {
    tmp.cleanup();
  }
});
