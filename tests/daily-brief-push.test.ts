/**
 * tests/daily-brief-push.test.ts —— 简报发送侧（一天一次 / 迟到不发 / 失败留痕）
 *
 * 这些用例守的是一个很容易出错、出错又很难发现的地方：
 * 「发没发」由**库里的台账**决定，不由内存状态决定（重启后不该再发一份）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startDailyBriefPush, type BriefPushDeps } from '../src/surfaces/daily-brief-push.ts';
import type { BriefSurfaceConfig } from '../src/surfaces/types.ts';

/** 2026-10-22 08:30 本地时刻（用本地构造，避免测试机时区影响）。 */
function at(h: number, m: number): number {
  const d = new Date(2026, 9, 22, h, m, 0, 0);
  return d.getTime();
}

function cfg(over: Partial<BriefSurfaceConfig> = {}): BriefSurfaceConfig {
  return { enabled: true, time: '08:30', chatId: null, windowMin: 180, maxChars: 1200, ...over };
}

interface Ctx {
  deps: BriefPushDeps;
  sent: Array<{ chatId: string; text: string }>;
  records: Array<{ chatId: string; ok: boolean; error: string | null; text: string; at: string }>;
  logs: string[];
  setNow(ms: number): void;
  setLastDay(day: string | null): void;
  failWith(err: string | null): void;
}

function makeCtx(over: Partial<BriefPushDeps> = {}, c: BriefSurfaceConfig = cfg()): Ctx {
  let nowMs = at(8, 30);
  let lastDay: string | null = null;
  let failError: string | null = null;
  const sent: Ctx['sent'] = [];
  const records: Ctx['records'] = [];
  const logs: string[] = [];
  const deps: BriefPushDeps = {
    cfg: c,
    now: () => nowMs,
    lastSentDay: () => lastDay,
    record: (r) => {
      records.push(r);
      if (r.ok) lastDay = r.at.slice(0, 10) === '' ? lastDay : lastDay; // 由用例显式设置
    },
    buildText: () => '今日日程：09:00 周会',
    targets: () => ['oc_a'],
    sendText: (chatId, text) => {
      if (failError !== null) return Promise.reject(new Error(failError));
      sent.push({ chatId, text });
      return Promise.resolve({ ok: true });
    },
    log: (m) => logs.push(m),
    ...over,
  };
  return {
    deps,
    sent,
    records,
    logs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setLastDay: (d: string | null) => {
      lastDay = d;
    },
    failWith: (e: string | null) => {
      failError = e;
    },
  };
}

test('到点且今天没发过 → 发一条，并落一条台账', async () => {
  const ctx = makeCtx();
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0]?.chatId, 'oc_a');
  assert.equal(ctx.sent[0]?.text, '今日日程：09:00 周会');
  assert.equal(ctx.records.length, 1);
  assert.equal(ctx.records[0]?.ok, true);
  assert.ok(ctx.logs.some((l) => l.includes('成功')));
});

test('今天已发过 → 再 tick 也不发（判据来自台账，不是内存）', async () => {
  const ctx = makeCtx();
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  ctx.setLastDay('2026-10-22'); // 模拟「库里记着今天已经发过」
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 1);
});

test('没到点 → 不发，也不刷屏日志', async () => {
  const ctx = makeCtx();
  ctx.setNow(at(7, 0));
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.logs.length, 0, 'not_yet 每分钟一条会把日志刷满');
});

test('迟到超过窗口 → 不发，并且日志说清原因（中午重启不该补发早间简报）', async () => {
  const ctx = makeCtx();
  ctx.setNow(at(13, 0)); // 计划 08:30 + 窗口 180 分钟 → 11:30 之后算迟到
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.ok(ctx.logs.some((l) => l.includes('too_late')));
});

test('安静时段不参与判定：主人自己定的时间就是契约（21:00 的简报照发）', async () => {
  const ctx = makeCtx({ cfg: cfg({ time: '21:00' }) });
  ctx.setNow(at(21, 0));
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 1);
});

test('关着 → 一次都不发', async () => {
  const ctx = makeCtx({ cfg: cfg({ enabled: false }) });
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.records.length, 0);
});

test('正文为空 → 不发（避免发一条空消息）', async () => {
  const ctx = makeCtx({ buildText: () => '   ' });
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.ok(ctx.logs.some((l) => l.includes('正文为空')));
});

test('没有目标会话 → 不发，并说明是没配 owner_chat_id', async () => {
  const ctx = makeCtx({ targets: () => [] });
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.ok(ctx.logs.some((l) => l.includes('owner_chat_id')));
});

test('发送抛异常 → 台账记 ok=0 且带错误，不向上炸', async () => {
  const ctx = makeCtx();
  ctx.failWith('boom');
  const h = startDailyBriefPush(ctx.deps);
  await h.tick(); // 不抛
  h.stop();
  assert.equal(ctx.records.length, 1);
  assert.equal(ctx.records[0]?.ok, false);
  assert.ok((ctx.records[0]?.error ?? '').includes('boom'));
});

test('多会话：每个目标各发一条、各落一条台账', async () => {
  const ctx = makeCtx({ targets: () => ['oc_a', 'oc_b'] });
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.deepEqual(ctx.sent.map((s) => s.chatId), ['oc_a', 'oc_b']);
  assert.equal(ctx.records.length, 2);
});

test('坏时间格式 → 不发，日志里是 bad_time', async () => {
  const ctx = makeCtx({ cfg: cfg({ time: '8点' }) });
  const h = startDailyBriefPush(ctx.deps);
  await h.tick();
  h.stop();
  assert.equal(ctx.sent.length, 0);
  assert.ok(ctx.logs.some((l) => l.includes('bad_time')));
});

test('stop() 之后 tick 仍然是空操作', async () => {
  const ctx = makeCtx();
  const h = startDailyBriefPush(ctx.deps);
  h.stop();
  await h.tick();
  assert.equal(ctx.sent.length, 0);
});