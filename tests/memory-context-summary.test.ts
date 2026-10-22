/**
 * tests/memory-context-summary.test.ts —— P1-2「会话摘要接通」验收。
 *
 * ## 缺陷（一句话）
 * `updateContextSummary()` 有实现、`MemoryService` 接口有声明，**全仓库零调用方**
 * （`needsSummarize()` 同样零调用）→ `mem_threads.context_summary` 永远是 NULL →
 * `buildContextBundle` 只能用"最近 N 条消息"，会话一长就硬截断：越聊越忘，而且静默。
 *
 * ## 接法
 * - 生成走**注入的 `summarize` seam**（装配层接 `router.complete({track:'light'})`），
 *   MEM 模块绝不自己发 HTTP；
 * - 触发点：Runner 在 `cp.finish()` **之前**调 `refreshContextSummary(threadId)`
 *   （与 P1-4 同理：finish 之后主循环已退出；且"任务仍 running 时写记忆"更容易与恢复路径对账）；
 * - 只摘要 `context_summary_upto_seq` **之后**的增量，upto_seq 取被覆盖的最后一条消息 seq；
 * - 失败软降级：不写、不抛、下次再试。
 *
 * ## 三条验收
 * ① 任务结束后 `mem_threads.context_summary` 非 NULL；
 * ② `buildContextBundle` 在有摘要时用摘要替代早期消息，且 `upto_seq` 之后的消息仍完整注入；
 * ③ 摘要生成失败 → 不写、不抛、后续轮次仍可重试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import { SUMMARIZE_MESSAGE_THRESHOLD, SUMMARY_TOKEN_LIMIT } from '../src/memory/limits.ts';

const tmps: TempDataDir[] = [];
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

interface Rig {
  tmp: TempDataDir;
  memory: MemoryServiceImpl;
  /** summarize seam 收到的调用（threadId + transcript）。 */
  calls: Array<{ threadId: string; transcript: string }>;
  /** 让下一次 summarize 抛错。 */
  failNext: (err?: Error) => void;
  /** 让下一次 summarize 返回空串。 */
  emptyNext: (v?: boolean) => void;
}

function makeRig(): Rig {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const calls: Array<{ threadId: string; transcript: string }> = [];
  let failErr: Error | null = null;
  let empty = false;
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    bridge: makeStubFsOpsBridge(),
    summarize: async (threadId, transcript, opts) => {
      calls.push({ threadId, transcript });
      assert.ok(opts.maxTokens > 0, 'summarize 必须被告知 maxTokens（≤600 tokens 上限）');
      if (failErr !== null) {
        const e = failErr;
        failErr = null;
        throw e;
      }
      if (empty) {
        empty = false;
        return '';
      }
      return `摘要#${calls.length}：会话要点若干`;
    },
  });
  return {
    tmp,
    memory,
    calls,
    failNext: (err) => {
      failErr = err ?? new Error('light 轨全灭');
    },
    emptyNext: (v = true) => {
      empty = v;
    },
  };
}

/** 往一个 thread 里灌 n 条用户消息（seq 从 1 递增）。 */
async function seedMessages(rig: Rig, threadId: string, n: number, prefix = '消息'): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await rig.memory.appendMessage(threadId, { role: 'user', kind: 'text', content: `${prefix}${i}` });
  }
}

function threadRow(rig: Rig, threadId: string): Record<string, unknown> {
  return rig.tmp.db.prepare('SELECT * FROM mem_threads WHERE id=?').get(threadId) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════
// ① 任务结束后 context_summary 非 NULL
// ═══════════════════════════════════════════════════════════════════

test('① 消息数超过阈值 → refreshContextSummary 生成摘要并写回（context_summary 非 NULL）', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);

  assert.equal(threadRow(rig, threadId)['context_summary'], null, '触发前必须是 NULL（这就是原缺陷的现状）');
  const updated = await rig.memory.refreshContextSummary(threadId);
  assert.equal(updated, true, '够阈值就必须真的摘要一次');
  assert.equal(rig.calls.length, 1, '只调一次生成 seam');

  const row = threadRow(rig, threadId);
  assert.equal(typeof row['context_summary'], 'string', 'context_summary 必须非 NULL');
  assert.match(String(row['context_summary']), /摘要#1/);
  assert.equal(
    Number(row['context_summary_upto_seq']),
    SUMMARIZE_MESSAGE_THRESHOLD + 5,
    'upto_seq = 被覆盖的最后一条消息 seq（精确值，不是条数凑数）',
  );
});

test('①b 消息量不够 → 不摘要、不花模型调用（零打扰）', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, 5);

  assert.equal(await rig.memory.refreshContextSummary(threadId), false);
  assert.equal(rig.calls.length, 0, '没到阈值不许调用模型');
  assert.equal(threadRow(rig, threadId)['context_summary'], null);
});

test('①c 增量摘要：第二次只把 upto_seq 之后的新消息喂给模型（不重复整段会话）', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);
  await rig.memory.refreshContextSummary(threadId);
  const firstUpto = Number(threadRow(rig, threadId)['context_summary_upto_seq']);

  // 再加一批超过阈值的新消息 → 第二次摘要
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5, '追加');
  assert.equal(await rig.memory.refreshContextSummary(threadId), true);
  assert.equal(rig.calls.length, 2);

  const second = rig.calls[1]!;
  // 2026-10-22 改：原来这里断言字符串 `【已有摘要】`，而那块内容会被摘要器
  // 当成待压缩材料再压一遍（摘要的摘要），实测把 385 条历史压成一段
  // 「你发来的是摘要，请给路径」的废话。现在它被明确标成「已知背景」并
  // 附带"不要在摘要里复述它"——旧摘要仍会带上（供模型避免重复），
  // 但不再是被压缩的对象。断言跟着改语义，不是放宽。
  assert.ok(second.transcript.includes('【已知背景'), '第二次要把旧摘要作为背景带上');
  assert.ok(
    second.transcript.includes('不要在摘要里复述'),
    '必须显式禁止把旧摘要再描述一遍（否则摘要会退化成"我在摘要一段摘要"）',
  );
  assert.ok(second.transcript.includes('追加1'), '新消息要在里面');
  assert.ok(!second.transcript.includes('消息1\n'), '已经摘要过的旧消息不得重复进入 transcript（增量）');
  assert.ok(
    Number(threadRow(rig, threadId)['context_summary_upto_seq']) > firstUpto,
    'upto_seq 必须前进',
  );
});

// ═══════════════════════════════════════════════════════════════════
// ② 有摘要时用摘要替代早期消息，upto_seq 之后的仍完整注入
// ═══════════════════════════════════════════════════════════════════

test('② buildContextBundle：早期消息被摘要替代，upto_seq 之后的消息仍完整注入', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);
  await rig.memory.refreshContextSummary(threadId);
  const upto = Number(threadRow(rig, threadId)['context_summary_upto_seq']);

  // upto_seq 之后再来两条"新"消息
  await rig.memory.appendMessage(threadId, { role: 'user', kind: 'text', content: '新消息甲' });
  await rig.memory.appendMessage(threadId, { role: 'user', kind: 'text', content: '新消息乙' });

  const bundle = await rig.memory.buildContextBundle('dot1', '继续干活', 8000, { threadId });

  // 摘要被注入
  assert.equal(typeof bundle.summary, 'string');
  assert.match(String(bundle.summary), /摘要#1/, '摘要作为独立 system 段注入');

  // 早期消息不再逐条注入（被摘要替代）
  const injected = bundle.recentMessages.map((m) => m.content).join('\n');
  assert.ok(!injected.includes('消息1\n'), '已摘要的早期消息不应再逐条注入');
  assert.ok(!injected.includes('消息1'), '已摘要的早期消息不应再逐条注入（含子串判定）');

  // upto_seq 之后的消息仍完整
  assert.ok(injected.includes('新消息甲'), 'upto_seq 之后的消息必须完整注入');
  assert.ok(injected.includes('新消息乙'));
  assert.equal(bundle.recentMessages.length, 2, '只注入 upto_seq 之后的 2 条');
  assert.ok(upto > 0);
});

test('②b buildSessionReplay 同口径：只重放 upto_seq 之后，摘要排最前', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);
  await rig.memory.refreshContextSummary(threadId);
  await rig.memory.appendMessage(threadId, { role: 'assistant', kind: 'text', content: '收尾一句' });

  const replay = await rig.memory.buildSessionReplay(threadId, 't1', 8000);
  const all = replay.map((m) => m.content).join('\n');
  assert.ok(all.includes('摘要#1'), '重建的 messages[0] 应是摘要（保证 prompt 顺序 = 摘要→旧→新）');
  assert.equal(replay[0]!.content.includes('摘要#1'), true, '摘要必须排在最前');
  assert.ok(all.includes('收尾一句'), 'upto_seq 之后的消息照样重放');
  assert.ok(!all.includes('消息1'), '已摘要的旧消息不重复');
});

test('②c 无摘要时行为逐字不变：全部消息照旧逐条注入', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, 3);

  const bundle = await rig.memory.buildContextBundle('dot1', '干活', 8000, { threadId });
  assert.equal(bundle.summary, null, '没摘要就是 null');
  assert.equal(bundle.recentMessages.length, 3, '三条全在');
});

// ═══════════════════════════════════════════════════════════════════
// ③ 生成失败 → 不写、不抛、下次可重试
// ═══════════════════════════════════════════════════════════════════

test('③ summarize 抛错 → 不写、不抛，原摘要保持不动', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);

  rig.failNext();
  const ok = await rig.memory.refreshContextSummary(threadId);
  assert.equal(ok, false, '失败返回 false（不抛）');
  assert.equal(threadRow(rig, threadId)['context_summary'], null, '失败不得写入半成品');

  // 重试成功
  assert.equal(await rig.memory.refreshContextSummary(threadId), true, '后续轮次仍可重试');
  assert.match(String(threadRow(rig, threadId)['context_summary']), /摘要#/);
});

test('③b summarize 返回空串 → 视为失败，不覆盖已有摘要', async () => {
  const rig = makeRig();
  const threadId = await rig.memory.create();
  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5);
  await rig.memory.refreshContextSummary(threadId);
  const before = threadRow(rig, threadId)['context_summary'];

  await seedMessages(rig, threadId, SUMMARIZE_MESSAGE_THRESHOLD + 5, '第二轮');
  rig.emptyNext();
  assert.equal(await rig.memory.refreshContextSummary(threadId), false);
  assert.equal(threadRow(rig, threadId)['context_summary'], before, '空摘要不得覆盖已有摘要');
});

test('③c 未注入 summarize（旧装配）→ 摘要功能关闭，不抛', async () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    bridge: makeStubFsOpsBridge(),
  });
  const threadId = await memory.create();
  for (let i = 1; i <= SUMMARIZE_MESSAGE_THRESHOLD + 3; i++) {
    await memory.appendMessage(threadId, { role: 'user', kind: 'text', content: `m${i}` });
  }
  assert.equal(await memory.refreshContextSummary(threadId), false, '没有 seam 就不摘要');
  const row = tmp.db.prepare('SELECT context_summary FROM mem_threads WHERE id=?').get(threadId) as {
    context_summary: string | null;
  };
  assert.equal(row.context_summary, null);
});

test('③d 摘要超长 → 按 SUMMARY_TOKEN_LIMIT 截断（不撑爆上下文）', async () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    bridge: makeStubFsOpsBridge(),
    summarize: async () => '很长的摘要'.repeat(5000),
  });
  const threadId = await memory.create();
  for (let i = 1; i <= SUMMARIZE_MESSAGE_THRESHOLD + 3; i++) {
    await memory.appendMessage(threadId, { role: 'user', kind: 'text', content: `m${i}` });
  }
  assert.equal(await memory.refreshContextSummary(threadId), true);
  const row = tmp.db.prepare('SELECT context_summary FROM mem_threads WHERE id=?').get(threadId) as {
    context_summary: string;
  };
  const chars = [...row.context_summary].length;
  assert.ok(
    chars <= SUMMARY_TOKEN_LIMIT * 3.5 * 1.05,
    `摘要必须被截到 ≤${SUMMARY_TOKEN_LIMIT} tokens 量级，实际 ${chars} 字符`,
  );
});
