/**
 * tests/memory-seal.test.ts —— 任务结束写入收口（WRITE-SEAL，§4.3）。
 *
 * 依据（行号指 docs/design/modules/memory.md）：
 * ```ts
 * async function sealTask(task: Task, outcome: 'done'|'failed'|'cancelled', reason?: string) {
 *   insertSystemMessage(task.threadId, { kind: 'task_end', outcome, stopReason: reason });
 *   UPDATE mem_threads SET last_task_finished_at = now() WHERE id = task.threadId;  // §6.1 锚点
 *   if (outcome === 'done') touchManualsLastUsed(task.newManualIds);
 *   const wroteMemory = await anyMemoryFileTouchedSince(task.startedAt);
 *   if (!wroteMemory) {
 *     if (outcome === 'done') injectOnce(task, "若本次有可复用经验，现在写 notes/ 或更新 manuals/，否则回复 SKIP");
 *     markMemoryMissed(task.id);
 *   }
 * }
 * ```
 * - §4.3 头注：三种终态全走（rev2）。
 * - §4.3 下半：对控制面的硬要求 S2'——finish()/watchdog 失联回收/背压 kill/优雅关停等
 *   所有使任务进入 failed/cancelled 的收口点都必须调 sealTask（接缝契约 M3 裁定：接受）。
 * - §4.3 尾注：failed/cancelled 不追加提醒轮（止损优先），只记 memory_missed=1 供复盘。
 * - §8 错误约定：任何分支都不抛（记忆问题不炸主循环）；唯一失败是 threadId 缺失。
 *
 * `anyMemoryFileTouchedSince` 的真源是控制面 journal（steps 表，契约 D4 别人表只读
 * 服务接口），测试经 deps.journalMemoryProbe 注入假探针。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { SEAL_REMINDER_TEXT } from '../src/memory/seal.ts';
import { reconcileIndex } from '../src/memory/retention.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import type { StubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import type { SealTaskInput } from '../src/memory/types.ts';
import type { Task } from '../src/shared/contracts.ts';

let tmp: TempDataDir;
let bridge: StubFsOpsBridge;
let mem: MemoryServiceImpl;
/** journal 探针的返回值队列（每次调用取一帧）。 */
let journalReturns: string[][];

function makeTask(overrides: Partial<SealTaskInput> = {}): SealTaskInput {
  const base: Task = {
    id: 'task_1',
    dotId: 'dot1',
    title: 't',
    goal: 'g',
    status: 'running',
    priority: 1,
    runAt: null,
    sourceEventId: null,
    sessionId: null,
    threadId: null,
    attempt: 1,
    maxAttempts: 3,
    runEpoch: 1,
    lastHeartbeatAt: null,
    budgetTokens: 1000,
    usageTokens: 0,
    resumeFromSeq: null,
    stopReason: null,
    createdAt: 1000,
    updatedAt: 2000,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  tmp = makeTempDataDir();
  bridge = makeStubFsOpsBridge();
  journalReturns = [];
  mem = new MemoryServiceImpl({
    db: tmp.db,
    bridge,
    outboxPath: tmp.outboxPath,
    journalMemoryProbe: async (_taskId, _sinceMs) => journalReturns.shift() ?? [],
  });
});

afterEach(() => {
  tmp.cleanup();
});

describe('sealTask：done 且未写记忆 → 一轮提醒 + memory_missed（§4.3）', () => {
  it('落 task_end + 刷新 last_task_finished_at + 提醒文案 + missed 计数', async () => {
    const t = await mem.create();
    journalReturns = [[]]; // 没写任何记忆文件
    await mem.sealTask(makeTask({ threadId: t }), 'done');

    const loaded = await mem.load(t);
    const end = loaded?.messages.find((m) => m.kind === 'task_end');
    assert.ok(end !== undefined, '应落 task_end');
    assert.ok(end!.content.includes('"outcome":"done"'));
    assert.equal(loaded?.thread.lastTaskFinishedAt, 2000, '用 task.updatedAt 作锚点');

    const remind = loaded?.messages.find((m) => m.kind === 'text');
    assert.equal(remind?.content, SEAL_REMINDER_TEXT);

    const st = await mem.status();
    assert.equal(st.seal.missed, 1);
    assert.equal(st.seal.violations, 0, '正常收口不算 violation');
  });

  it('done 且写了记忆 → 不提醒、不记 missed', async () => {
    const t = await mem.create();
    journalReturns = [['notes/2026-01-01-x.md']];
    await mem.sealTask(makeTask({ threadId: t }), 'done');

    const loaded = await mem.load(t);
    assert.equal(loaded?.messages.find((m) => m.kind === 'task_end') !== undefined, true);
    assert.equal(loaded?.messages.find((m) => m.kind === 'text'), undefined, '不应提醒');
    const st = await mem.status();
    assert.equal(st.seal.missed, 0);
  });

  it('提醒只注入一轮（同 task 二次 sealTask 不再提醒，但 missed 幂等只记一次）', async () => {
    const t = await mem.create();
    journalReturns = [[], []];
    await mem.sealTask(makeTask({ threadId: t }), 'done');
    await mem.sealTask(makeTask({ threadId: t }), 'done');

    const loaded = await mem.load(t);
    const reminds = loaded?.messages.filter((m) => m.kind === 'text') ?? [];
    assert.equal(reminds.length, 1, '一轮提醒，只出现一次');
    const st = await mem.status();
    assert.equal(st.seal.missed, 1, 'missed 幂等：同 task 只计一次');
  });
});

describe('sealTask：failed/cancelled 只记 missed（§4.3 止损优先）', () => {
  it('failed：落 task_end（含 stopReason）+ missed，不追加提醒轮', async () => {
    const t = await mem.create();
    journalReturns = [[]];
    await mem.sealTask(makeTask({ threadId: t }), 'failed', 'budget');

    const loaded = await mem.load(t);
    const end = loaded?.messages.find((m) => m.kind === 'task_end');
    assert.ok(end!.content.includes('"outcome":"failed"'));
    assert.ok(end!.content.includes('"stopReason":"budget"'));
    assert.equal(loaded?.messages.find((m) => m.kind === 'text'), undefined, 'failed 不提醒');
    const st = await mem.status();
    assert.equal(st.seal.missed, 1);
  });

  it('cancelled：同上', async () => {
    const t = await mem.create();
    journalReturns = [[]];
    await mem.sealTask(makeTask({ threadId: t }), 'cancelled', 'user');
    const loaded = await mem.load(t);
    assert.ok(loaded?.messages.find((m) => m.kind === 'task_end')!.content.includes('"outcome":"cancelled"'));
    assert.equal(loaded?.messages.find((m) => m.kind === 'text'), undefined);
    const st = await mem.status();
    assert.equal(st.seal.missed, 1);
  });

  it('failed/cancelled 即使写了记忆也不提醒，但也谈不上 missed（没漏）', async () => {
    const t = await mem.create();
    journalReturns = [['MEMORY.md']];
    await mem.sealTask(makeTask({ threadId: t }), 'failed', 'tool_risk');
    const st = await mem.status();
    assert.equal(st.seal.missed, 0, '写了记忆 → 未漏');
  });
});

describe('sealTask：threadId 缺失（§4.3 唯一允许的失败路径）', () => {
  it('记 no_thread violation 并返回，不抛', async () => {
    await mem.sealTask(makeTask({ threadId: null }), 'done');
    const st = await mem.status();
    assert.equal(st.seal.missed, 1);
    assert.equal(st.seal.violations, 1, '控制面没建/绑 thread 算 violation');
  });

  it('no_thread 的 updated_at 用真实时间，不写 0（污染观测字段）', async () => {
    // 此前 markMissed(..., 0) 让 mem_maintenance_state.updated_at = 0，
    // §6.3 复盘的「最近一次漏调」永远看起来发生在 1970 年。
    await mem.sealTask(makeTask({ threadId: null, updatedAt: 555_000 }), 'cancelled');
    const rows = tmp.db
      .prepare('SELECT key, value, updated_at FROM mem_maintenance_state')
      .all() as Array<{ key?: string; value?: string; updated_at?: number }>;
    // markMissedRaw 落 missed:<taskId>（幂等键）+ seal_missed_count + seal_violations
    const detail = rows.find((r) => r.key === 'missed:task_1');
    assert.ok(detail !== undefined, 'missed 已落 kv');
    assert.equal(detail.value, 'no_thread:cancelled', 'violation 原因留痕');
    assert.ok(
      typeof detail.updated_at === 'number' && detail.updated_at > 0,
      `updated_at 必须是正时间戳，实测 ${String(detail.updated_at)}`,
    );
    assert.equal(detail.updated_at, 555_000, '取 task.updatedAt（任务自身时间，比墙钟更准）');
    for (const k of ['seal_missed_count', 'seal_violations']) {
      const r = rows.find((x) => x.key === k);
      assert.ok(r !== undefined && (r.updated_at ?? 0) > 0, `${k} 的 updated_at 也不为 0`);
    }
  });

  it('no_thread 且 updatedAt=0 时退回 Date.now()，仍不为 0', async () => {
    const before = Date.now();
    await mem.sealTask(makeTask({ threadId: null, updatedAt: 0 }), 'failed');
    const row = tmp.db
      .prepare('SELECT updated_at FROM mem_maintenance_state WHERE key = ?')
      .get('missed:task_1') as { updated_at?: number } | undefined;
    assert.ok(
      (row?.updated_at ?? 0) >= before,
      `应为当前墙钟（>= ${before}），实测 ${String(row?.updated_at)}`,
    );
  });

  it('sessionId 兜底（契约 M1：thread ≡ session，两字段同值）', async () => {
    const t = await mem.create();
    journalReturns = [[]];
    await mem.sealTask(makeTask({ threadId: null, sessionId: t }), 'done');
    const loaded = await mem.load(t);
    assert.ok(loaded?.messages.find((m) => m.kind === 'task_end') !== undefined);
  });
});

describe('sealTask：touchManualsLastUsed（§4.3 done 分支）', () => {
  it('done 时把 newManualIds 的 mtime_ms 刷新为当前时钟', async () => {
    bridge.put('manuals/deploy/wsl.md', 'old content', 1000);
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'manuals/deploy/wsl.md', 'manuals', NULL, NULL, 11, 1000)`,
      )
      .run();
    const t = await mem.create();
    journalReturns = [['manuals/deploy/wsl.md']];
    const clocked = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      journalMemoryProbe: async () => ['manuals/deploy/wsl.md'],
      now: () => 777_000,
    });
    await clocked.sealTask(
      makeTask({ threadId: t, updatedAt: 777_000, newManualIds: ['manuals/deploy/wsl.md'] }),
      'done',
    );
    const row = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/deploy/wsl.md') as { mtime_ms?: number } | undefined;
    assert.equal(row?.mtime_ms, 777_000, '§4.3 touchManualsLastUsed 生效');
  });

  it('非 manuals 路径不被 touch（touchManualsLastUsed 只刷新 manuals）', async () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'notes/2026-01-01-a.md', 'notes', NULL, NULL, 5, 1000)`,
      )
      .run();
    await mem.touchManualsLastUsed('dot1', ['notes/2026-01-01-a.md']);
    const row = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('notes/2026-01-01-a.md') as { mtime_ms?: number } | undefined;
    assert.equal(row?.mtime_ms, 1000, 'notes 不被 manuals 刷新逻辑动');
  });

  it('failed 不 touch manuals（只有 done 分支调）', async () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'manuals/a.md', 'manuals', NULL, NULL, 5, 1000)`,
      )
      .run();
    const t = await mem.create();
    journalReturns = [[]];
    await mem.sealTask(makeTask({ threadId: t, newManualIds: ['manuals/a.md'] }), 'failed', 'budget');
    const row = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/a.md') as { mtime_ms?: number } | undefined;
    assert.equal(row?.mtime_ms, 1000);
  });

  it('touch 过的 manuals 不被索引对账回退（§3.5 老化判据的前提）', async () => {
    // 桥真实 mtime 是文件改动时间，touch 是"人为推进的最近使用"。
    // 若对账直接覆盖 mtime_ms，§3.5 的 90/180 天老化判据在真实节奏下永不成立。
    bridge.put('manuals/deploy/wsl.md', 'old content', 1000);
    // 先把文件扫进索引（touchManualsLastUsed 是 UPDATE，行不存在则无效）
    reconcileIndex(
      tmp.db,
      'dot1',
      new Map([
        [
          'manuals/deploy/wsl.md',
          {
            area: 'manuals' as const,
            tags: [] as string[],
            title: null,
            sizeBytes: 11,
            mtimeMs: 1000,
          },
        ],
      ]),
    );
    const clocked = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      now: () => 777_000,
    });
    await clocked.touchManualsLastUsed('dot1', ['manuals/deploy/wsl.md']);
    const before = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/deploy/wsl.md') as { mtime_ms?: number } | undefined;
    assert.equal(before?.mtime_ms, 777_000, 'touch 生效');

    // 对账：桥仍报 mtime=1000（文件本身没被改过）
    const seen = new Map([
      [
        'manuals/deploy/wsl.md',
        {
          area: 'manuals' as const,
          tags: [] as string[],
          title: null,
          sizeBytes: 11,
          mtimeMs: 1000,
        },
      ],
    ]);
    reconcileIndex(tmp.db, 'dot1', seen);
    const after = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/deploy/wsl.md') as { mtime_ms?: number } | undefined;
    assert.equal(after?.mtime_ms, 777_000, 'touch 值不被真实 mtime 回退');
  });

  it('对账仍会更新 manuals 的 size/tags/area（只是不回退 mtime）', async () => {
    bridge.put('manuals/deploy/wsl.md', 'new longer content', 1000);
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'manuals/deploy/wsl.md', 'manuals', NULL, NULL, 5, 9000)`,
      )
      .run();
    const seen = new Map([
      [
        'manuals/deploy/wsl.md',
        {
          area: 'manuals' as const,
          tags: ['deploy'],
          title: null,
          sizeBytes: 18,
          mtimeMs: 1000,
        },
      ],
    ]);
    reconcileIndex(tmp.db, 'dot1', seen);
    const row = tmp.db
      .prepare('SELECT tags, size_bytes, mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/deploy/wsl.md') as
      | { tags?: string; size_bytes?: number; mtime_ms?: number }
      | undefined;
    assert.equal(row?.tags, '["deploy"]', 'tags 仍被刷新');
    assert.equal(row?.size_bytes, 18, 'size 仍被刷新');
    assert.equal(row?.mtime_ms, 9000, '已记录的更晚值保留（max）');
  });

  it('notes 区没有 max 语义，对账直接取桥 mtime', async () => {
    bridge.put('notes/2026-01-01-a.md', 'x', 1000);
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'notes/2026-01-01-a.md', 'notes', NULL, NULL, 5, 9000)`,
      )
      .run();
    const seen = new Map([
      [
        'notes/2026-01-01-a.md',
        {
          area: 'notes' as const,
          tags: [] as string[],
          title: null,
          sizeBytes: 1,
          mtimeMs: 1000,
        },
      ],
    ]);
    reconcileIndex(tmp.db, 'dot1', seen);
    const row = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('notes/2026-01-01-a.md') as { mtime_ms?: number } | undefined;
    assert.equal(row?.mtime_ms, 1000, 'notes 的 mtime 就是文件改动时间');
  });
});

describe('sealTask：journal 探针的路径判据（§4.3 anyMemoryFileTouchedSince）', () => {
  it('认 /dot/home/ 容器绝对路径与 home 相对路径两种形态', async () => {
    const t1 = await mem.create();
    journalReturns = [['/dot/home/manuals/x.md']];
    await mem.sealTask(makeTask({ threadId: t1 }), 'done');
    assert.equal((await mem.status()).seal.missed, 0, '容器绝对路径算写了');

    const t2 = await mem.create();
    journalReturns = [['MEMORY.md']];
    await mem.sealTask(makeTask({ threadId: t2 }), 'done');
    assert.equal((await mem.status()).seal.missed, 0, 'MEMORY.md 算写了');
  });

  it('非记忆域路径不算（如 /dot/work/x、tmp/foo）', async () => {
    const t = await mem.create();
    journalReturns = [['/dot/work/x.txt']];
    await mem.sealTask(makeTask({ threadId: t }), 'done');
    const st = await mem.status();
    assert.equal(st.seal.missed, 1, '写了非记忆文件 → 视为未写记忆');
  });

  it('无 journal 探针 → 查不到 = 未写（软线语义，宁可多提醒一轮也不谎报已写）', async () => {
    const noProbe = new MemoryServiceImpl({ db: tmp.db, bridge, outboxPath: tmp.outboxPath });
    const t = await noProbe.create();
    await noProbe.sealTask(makeTask({ threadId: t }), 'done');
    const loaded = await noProbe.load(t);
    assert.ok(loaded?.messages.find((m) => m.kind === 'text') !== undefined, '应提醒');
  });
});

describe('appendFeedbackNote（§6.4 人工纠错 → thr_feedback）', () => {
  it('落到 channel=cli、title=thr_feedback 的专属 thread，kind=memory_note', async () => {
    const r = await mem.appendFeedbackNote('上下文里有但你没答出来');
    const loaded = await mem.load(
      (tmp.db.prepare('SELECT id FROM mem_threads WHERE title = ?').get('thr_feedback') as
        | { id?: string }
        | undefined)!.id!,
    );
    assert.equal(loaded?.messages.length, 1);
    assert.equal(loaded?.messages[0]!.kind, 'memory_note');
    assert.equal(loaded?.messages[0]!.role, 'user');
    assert.equal(r.seq, 1);
  });

  it('cli 通道 external_ref 必须是 NULL（DDL 域规则：cli : external_ref = NULL）', async () => {
    await mem.appendFeedbackNote('纠错一条');
    const row = tmp.db
      .prepare('SELECT channel, title, external_ref FROM mem_threads WHERE title = ?')
      .get('thr_feedback') as { channel?: string; title?: string; external_ref?: unknown };
    assert.equal(row.channel, 'cli');
    assert.equal(row.title, 'thr_feedback');
    assert.equal(row.external_ref, null, 'cli 通道不得占 external_ref');
  });

  it('默认不带 tag：普通反馈不计入信号② recall-miss', async () => {
    // §6.4 信号②的区分度：只有显式标 recall-miss 的才算「上下文明明有但答不出」。
    // 此前实现恒带 tag，导致按 tag 过滤等价于全量计数，信号失去意义。
    await mem.appendFeedbackNote('这个结论不对，应该是 X');
    const st = await mem.status();
    assert.equal(st.feedback.notes, 1, '普通反馈仍进 thr_feedback');
    assert.equal(st.feedback.recallMiss, 0, '但不计入 recall-miss');
    assert.equal(mem.searchSignal().recallMissNotes, 0);
  });

  it('显式 tag=recall-miss 才计入信号②', async () => {
    await mem.appendFeedbackNote('上下文里有但你没答出来', { tag: 'recall-miss' });
    const st = await mem.status();
    assert.equal(st.feedback.notes, 1);
    assert.equal(st.feedback.recallMiss, 1);
    assert.equal(mem.searchSignal().recallMissNotes, 1);
  });

  it('正文里出现 recall-miss 字样不算命中（必须匹配 "tag":"recall-miss"）', async () => {
    await mem.appendFeedbackNote('你上次说的 recall-miss 是什么我没听懂');
    const st = await mem.status();
    assert.equal(st.feedback.recallMiss, 0, '正文字样不得误命中');
  });

  it('多条纠错复用同一 thread（title 定位幂等，external_ref 为 NULL 也能对上）', async () => {
    await mem.appendFeedbackNote('a');
    await mem.appendFeedbackNote('b');
    const rows = tmp.db.prepare('SELECT id FROM mem_threads WHERE title = ?').all('thr_feedback');
    assert.equal(rows.length, 1);
    const st = await mem.status();
    assert.equal(st.feedback.notes, 2);
    assert.equal(st.feedback.recallMiss, 0);
  });
});
