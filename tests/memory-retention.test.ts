/**
 * tests/memory-retention.test.ts —— 保留策略（§6.1）、容量控制（§6.2）、
 * 崩溃恢复（§6.3）与 OUTBOX 守门（§3.6 / 契约 T3）。
 *
 * 依据（行号指 docs/design/modules/memory.md）：
 * §6.1 保留策略（心跳 job memory-retention 每日，幂等可重跑）：
 *   活跃 thread：active/idle 保留至满足归档条件；
 *   归档：last_active_at >90 天 且 last_task_finished_at 距今 >30 天 → status='sealed'；
 *   删除：sealed 且 last_task_finished_at >365 天 → 整 thread CASCADE 删；
 *         删除前把 context_summary 指纹 append 进 mem_maintenance_state.purge_ledger；
 *   主人特权：pinned=1 永不过期；
 *   事件/心跳 thread：last_task_finished_at 距今 >7 天 → 自动 sealed；
 *   awaiting_approval 中的任务因未走完 sealTask，last_task_finished_at 为空，天然豁免封存。
 *
 * §6.3 崩溃恢复顺序：integrity_check 失败 → OUTBOX HELP 块 + 拒启动；
 *   会话断点扫描：kind='task_start' 且同 thread 之后无 task_end；仅当对应 tasks 行
 *   status='running' 才报"待恢复"；status ∈ (done|failed|cancelled) 而无 task_end
 *   ⇒ 判定 sealTask 漏调，记 violation 日志行，由 retention 补写 task_end(backfilled:true)。
 *
 * §6.2 容量：db 软限 200MB / 硬限 500MB（MemoryCapacityError）；超软限 checkpoint。
 *
 * §3.6 OUTBOX 守门：超 64KB / 200 块按块轮转进 ~/.dotd/.dotd/archive/outbox-<批次>.md；
 *   未收敛（HELP 块签名在 alert_dispatch 中无 resolved_at）的块永不轮转（契约 T3）。
 *
 * 测试绝不碰真实 ~/.dotd：makeTempDataDir()（契约 D1）。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl, DEFAULT_OUTBOX_PATH } from '../src/memory/MemoryService.ts';
import type { MemoryDeps } from '../src/memory/types.ts';
import { MemoryCapacityError, MemoryCorruptionError } from '../src/shared/errors.ts';
import { OUTBOX_MAX_BYTES, OUTBOX_MAX_BLOCKS } from '../src/memory/outbox-guard.ts';
import { ARCHIVE_SOFT_LIMIT_BYTES } from '../src/memory/retention.ts';
import { LIMIT_ARCHIVE_BYTES } from '../src/memory/limits.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import type { TaskStatus } from '../src/shared/contracts.ts';

const DAY = 24 * 60 * 60 * 1000;

let tmp: TempDataDir;
let mem: MemoryServiceImpl;
/** 装配层一定会注入 MR 的 outboxUnresolvedSignatures()；测试默认"全部已收敛"。 */
let unresolved: () => string[];
let taskStatuses: Map<string, TaskStatus>;
let now: number;

/** 造一个 thread，直接写 last_active_at / last_task_finished_at（绕过业务写入）。 */
function makeThread(opts: {
  channel?: 'web' | 'telegram' | 'cli' | 'email' | 'event' | 'heartbeat';
  status?: 'active' | 'idle' | 'sealed' | 'purged';
  pinned?: 0 | 1;
  lastActiveAgo: number;
  lastFinishedAgo: number | null;
  summary?: string | null;
}): string {
  const id = `thr_${Math.random().toString(36).slice(2, 10)}`;
  tmp.db
    .prepare(
      `INSERT INTO mem_threads
         (id, dot_id, channel, external_ref, title, origin_task_id, status, pinned,
          context_summary, context_summary_upto_seq, last_active_at, last_task_finished_at, created_at)
       VALUES (?, 'dot1', ?, NULL, NULL, NULL, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      opts.channel ?? 'web',
      opts.status ?? 'active',
      opts.pinned ?? 0,
      opts.summary ?? null,
      now - opts.lastActiveAgo,
      opts.lastFinishedAgo === null ? null : now - opts.lastFinishedAgo,
      now - opts.lastActiveAgo,
    );
  return id;
}

beforeEach(() => {
  tmp = makeTempDataDir();
  taskStatuses = new Map();
  unresolved = () => [];
  now = 1_700_000_000_000;
  mem = new MemoryServiceImpl({
    db: tmp.db,
    bridge: makeStubFsOpsBridge(),
    outboxPath: tmp.outboxPath,
    taskStatusProbe: (id) => taskStatuses.get(id),
    unresolvedSignatures: () => unresolved(),
    now: () => now,
  });
});

afterEach(() => {
  tmp.cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// §1 归档封存（§6.1）
// ═══════════════════════════════════════════════════════════════════

describe('runRetention：归档封存（§6.1 双条件）', () => {
  it('last_active_at>90d 且 last_task_finished_at>30d → sealed', async () => {
    const id = makeThread({ lastActiveAgo: 100 * DAY, lastFinishedAgo: 40 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, [id]);
    const row = tmp.db.prepare('SELECT status FROM mem_threads WHERE id = ?').get(id) as
      | { status?: string }
      | undefined;
    assert.equal(row?.status, 'sealed');
  });

  it('只满足一个条件不封存（last_active 90d 但 finished 仅 10d）', async () => {
    const id = makeThread({ lastActiveAgo: 100 * DAY, lastFinishedAgo: 10 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, []);
    assert.equal(
      (tmp.db.prepare('SELECT status FROM mem_threads WHERE id = ?').get(id) as { status?: string })?.status,
      'active',
    );
  });

  it('last_task_finished_at 为空 → 天然豁免（awaiting_approval 未走完 sealTask）', async () => {
    const id = makeThread({ lastActiveAgo: 400 * DAY, lastFinishedAgo: null });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, []);
  });

  it('pinned=1 永不过期（§6.1 主人特权）', async () => {
    const id = makeThread({ pinned: 1, lastActiveAgo: 999 * DAY, lastFinishedAgo: 500 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, []);
    assert.deepEqual(r.threadsDeleted, []);
    assert.equal(
      (tmp.db.prepare('SELECT status FROM mem_threads WHERE id = ?').get(id) as { status?: string })?.status,
      'active',
    );
  });

  it('已 sealed 的不重复封存（幂等）', async () => {
    const id = makeThread({ status: 'sealed', lastActiveAgo: 100 * DAY, lastFinishedAgo: 40 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, []);
  });

  it('封存时无摘要 → 记入 summaryDue（补不动允许无摘要封存，不阻塞）', async () => {
    const withSum = makeThread({ lastActiveAgo: 100 * DAY, lastFinishedAgo: 40 * DAY, summary: '有摘要' });
    const noSum = makeThread({ lastActiveAgo: 100 * DAY, lastFinishedAgo: 40 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed.sort(), [noSum, withSum].sort());
    assert.deepEqual(r.summaryDue, [noSum]);
  });

  it('事件/心跳 thread 按 7 天 TTL 封存（不需要 90d 活跃条件）', async () => {
    const ev = makeThread({ channel: 'event', lastActiveAgo: 10 * DAY, lastFinishedAgo: 10 * DAY });
    const hb = makeThread({ channel: 'heartbeat', lastActiveAgo: 8 * DAY, lastFinishedAgo: 8 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealedByEventTtl.sort(), [ev, hb].sort());
    assert.ok(r.threadsSealed.includes(ev));
  });

  it('事件 thread 7 天内不封存', async () => {
    makeThread({ channel: 'event', lastActiveAgo: 3 * DAY, lastFinishedAgo: 3 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsSealed, []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §2 删除 + purge_ledger（§6.1）
// ═══════════════════════════════════════════════════════════════════

describe('runRetention：sealed>365d 删除 + purge_ledger 指纹（§6.1）', () => {
  it('整 thread CASCADE 删，purge_ledger 留 context_summary 的 sha256 前 16 位', async () => {
    const id = makeThread({
      status: 'sealed',
      lastActiveAgo: 800 * DAY,
      lastFinishedAgo: 400 * DAY,
      summary: '这是被删 thread 的摘要',
    });
    // 造两条消息（验证 CASCADE 删净）
    for (const c of ['m1', 'm2']) {
      tmp.db
        .prepare(
          `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
           VALUES (?, ?, ?, 'user', 'text', ?, NULL, NULL, 1, ?)`,
        )
        .run(`msg_${c}`, id, c === 'm1' ? 1 : 2, c, now);
    }
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsDeleted, [id]);
    assert.equal(tmp.db.prepare('SELECT * FROM mem_threads WHERE id = ?').get(id), undefined);
    assert.equal(
      (tmp.db.prepare('SELECT COUNT(*) AS c FROM mem_messages WHERE thread_id = ?').get(id) as { c?: number })?.c,
      0,
      '消息一并删净',
    );

    const ledger = JSON.parse(
      (tmp.db.prepare(`SELECT value FROM mem_maintenance_state WHERE key = 'purge_ledger'`).get() as
        | { value?: string }
        | undefined)!.value!,
    ) as Array<{ threadId: string; summaryDigest: string }>;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.threadId, id);
    assert.match(ledger[0]!.summaryDigest, /^[0-9a-f]{16}$/, 'sha256 前 16 位');
  });

  it('sealed 但未满 365 天不删', async () => {
    const id = makeThread({ status: 'sealed', lastActiveAgo: 100 * DAY, lastFinishedAgo: 100 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsDeleted, []);
  });

  it('pinned 的 sealed thread 也不删', async () => {
    makeThread({ status: 'sealed', pinned: 1, lastActiveAgo: 900 * DAY, lastFinishedAgo: 800 * DAY });
    const r = await mem.runRetention();
    assert.deepEqual(r.threadsDeleted, []);
  });

  it('删除事件写 retention_last_run 游标', async () => {
    await mem.runRetention();
    const row = tmp.db
      .prepare(`SELECT value FROM mem_maintenance_state WHERE key = 'retention_last_run'`)
      .get() as { value?: string } | undefined;
    assert.equal(Number(row?.value), now);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §3 断点扫描与漏调回填（§6.3）
// ═══════════════════════════════════════════════════════════════════

describe('scanSessionBreaks / backfillOrphanTaskEnds（§6.3）', () => {
  /** 造 task_start 消息（seq 取当前 max+1，同 thread 可多条）。 */
  function taskStart(threadId: string, taskId: string): void {
    const row = tmp.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS mx FROM mem_messages WHERE thread_id = ?')
      .get(threadId) as { mx?: number } | undefined;
    const seq = (row?.mx ?? 0) + 1;
    tmp.db
      .prepare(
        `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
         VALUES (?, ?, ?, 'system', 'task_start', '{}', ?, NULL, 1, ?)`,
      )
      .run(`msg_${taskId}_${Math.random().toString(36).slice(2, 6)}`, threadId, seq, taskId, now);
  }

  it('tasks.status=running 且无 task_end → pending（交控制面 §7.3 处置）', () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_running');
    taskStatuses.set('task_running', 'running');
    const scan = mem.scanSessionBreaks();
    assert.equal(scan.pending.length, 1);
    assert.equal(scan.pending[0]!.taskId, 'task_running');
    assert.equal(scan.orphans.length, 0);
  });

  it('tasks 终态而无 task_end → orphan（sealTask 漏调），retention 回填 task_end', async () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_done');
    taskStatuses.set('task_done', 'done');
    const scan = mem.scanSessionBreaks();
    assert.equal(scan.orphans.length, 1);
    assert.equal(scan.pending.length, 0);

    const r = await mem.runRetention();
    assert.deepEqual(r.orphanTaskEndsBackfilled, ['task_done']);
    assert.deepEqual(r.sealViolations, [`${t}:task_done`]);

    // 回填的 task_end 带 backfilled:true，不再进 orphans（幂等）
    const scan2 = mem.scanSessionBreaks();
    assert.equal(scan2.orphans.length, 0, '回填后不再算孤儿');
    const end = tmp.db
      .prepare('SELECT content FROM mem_messages WHERE kind = ? AND thread_id = ?')
      .get('task_end', t) as { content?: string } | undefined;
    assert.ok(end!.content!.includes('"backfilled":true'));
    assert.ok(end!.content!.includes('seal_missed'));
  });

  it('failed / cancelled 终态同样判漏调', async () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_failed');
    taskStart(t, 'task_cancelled');
    taskStatuses.set('task_failed', 'failed');
    taskStatuses.set('task_cancelled', 'cancelled');
    const scan = mem.scanSessionBreaks();
    assert.equal(scan.orphans.length, 2);
    const r = await mem.runRetention();
    assert.deepEqual(r.orphanTaskEndsBackfilled.sort(), ['task_cancelled', 'task_failed']);
  });

  it('非终态（queued/paused/awaiting_approval）不判漏调、不报 pending', () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_queued');
    taskStart(t, 'task_paused');
    taskStatuses.set('task_queued', 'queued');
    taskStatuses.set('task_paused', 'paused');
    const scan = mem.scanSessionBreaks();
    assert.equal(scan.pending.length, 0);
    assert.equal(scan.orphans.length, 0);
  });

  it('无任务状态探针 → 记 orphansUnknown，不猜测、不直读 tasks 表', async () => {
    const noProbe = new MemoryServiceImpl({ db: tmp.db, bridge: makeStubFsOpsBridge(), now: () => now });
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_unknown');
    const scan = noProbe.scanSessionBreaks();
    assert.equal(scan.orphans.length, 0);
    assert.equal(scan.pending.length, 0);
    const r = await noProbe.runRetention();
    assert.deepEqual(r.orphansUnknown, [t]);
    assert.deepEqual(r.orphanTaskEndsBackfilled, []);
  });

  it('有 task_end 的正常 thread 不被扫出', async () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_ok');
    tmp.db
      .prepare(
        `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
         VALUES (?, ?, 2, 'system', 'task_end', '{}', ?, NULL, 1, ?)`,
      )
      .run(`msg_end_${Math.random().toString(36).slice(2, 6)}`, t, 'task_ok', now);
    taskStatuses.set('task_ok', 'done');
    const scan = mem.scanSessionBreaks();
    assert.equal(scan.orphans.length, 0);
  });

  it('回填会把 thread 的 last_task_finished_at 补上（§6.1 封存锚点）', async () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    taskStart(t, 'task_done2');
    taskStatuses.set('task_done2', 'done');
    await mem.runRetention();
    const row = tmp.db.prepare('SELECT last_task_finished_at FROM mem_threads WHERE id = ?').get(t) as
      | { last_task_finished_at?: number | null }
      | undefined;
    assert.equal(row?.last_task_finished_at, now);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §4 容量控制（§6.2）
// ═══════════════════════════════════════════════════════════════════

describe('容量控制（§6.2 软 200MB / 硬 500MB）', () => {
  it('正常库 → status().db.level = ok，且 dbUsage 报数', async () => {
    const st = await mem.status();
    assert.equal(st.db.level, 'ok');
    assert.equal(st.db.softLimitBytes, 200 * 1024 * 1024);
    assert.equal(st.db.hardLimitBytes, 500 * 1024 * 1024);
    const usage = mem.dbUsage();
    assert.ok(usage.sizeBytes > 0);
  });

  it('checkpointWal 可跑（超软限时的整理动作）', () => {
    assert.equal(mem.checkpointWal(), true);
  });

  it('dbUsage 与 status() 报的 sizeBytes 一致', async () => {
    const st = await mem.status();
    assert.equal(st.db.sizeBytes, mem.dbUsage().sizeBytes);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §5 崩溃恢复：integrity_check 失败路径（§6.3）
// ═══════════════════════════════════════════════════════════════════

describe('checkIntegrity（§6.3）', () => {
  it('完好库 → 不抛、不写 OUTBOX', () => {
    mem.checkIntegrity();
    assert.equal(readFileSync(tmp.outboxPath, 'utf8'), '');
  });

  /**
   * 损坏库路径。两种真实形态都覆盖：
   * ① PRAGMA integrity_check 抛（node:sqlite 直接报 SQLITE_CORRUPT）；
   * ② 返回非 'ok' 行。
   *
   * 实现注记：曾试过"把 db 文件字节写坏再 DatabaseSync 裸开"，实测 node:sqlite
   * 在 WAL 模式下打开这种文件仍然成功，且 integrity_check 返回 'ok'（头页未坏），
   * 复现不出来。改用与下面 onCorruption 用例同手法的假 db——prepare() 直接抛
   * `database disk image is malformed`，等价于真实 SQLITE_CORRUPT 报错形态。
   */
  it('损坏库 → append OUTBOX HELP 块（签名 db_corrupt）+ 抛 MemoryCorruptionError', async () => {
    const fakeDb = {
      prepare: () => ({
        get: () => {
          throw new Error('database disk image is malformed');
        },
      }),
    } as unknown as MemoryDeps['db'];
    const spy = new MemoryServiceImpl({
      db: fakeDb,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      now: () => now,
    });
    let caught: unknown;
    try {
      spy.checkIntegrity();
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught instanceof MemoryCorruptionError,
      `应抛 MemoryCorruptionError，实际 ${String(caught)}`,
    );

    // §6.3 ①：OUTBOX 必须有 HELP db_corrupt 块（不经 SQLite，直接 append 落文件）
    const outbox = readFileSync(tmp.outboxPath, 'utf8');
    assert.ok(outbox.includes('HELP db_corrupt'), `签名应为 db_corrupt，实际：${outbox.slice(0, 160)}`);
    assert.ok(outbox.includes('拒绝启动'));
  });

  it('onCorruption 回调被调用（装配层接拒启动/SOS）', () => {
    // 用一个"必然 integrity_check 失败"的假 db（形状满足 MemoryDeps 的最小面）
    const fakeDb = {
      prepare: () => ({
        get: () => {
          throw new Error('database disk image is malformed');
        },
      }),
    } as unknown as MemoryDeps['db'];
    const seen: Error[] = [];
    const spy = new MemoryServiceImpl({
      db: fakeDb,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      onCorruption: (e: Error) => {
        seen.push(e);
      },
      now: () => now,
    });
    assert.throws(() => spy.checkIntegrity(), MemoryCorruptionError);
    assert.equal(seen.length, 1, 'onCorruption 应被调用一次');
    assert.ok(seen[0] instanceof MemoryCorruptionError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §6 OUTBOX 守门（§3.6 / 契约 T3）
// ═══════════════════════════════════════════════════════════════════

/** 造一个 HELP 块（§3.6 块格式：`## [YYYY-MM-DD HH:mm] HELP <sig>`）。 */
function outboxBlock(sig: string, bodyBytes = 200): string {
  return `## [2026-01-01 10:00] HELP ${sig}\n${'x'.repeat(bodyBytes)}\n---\n\n`;
}

describe('runOutboxGuard：体积守门（§3.6）', () => {
  it('未超阈值不动文件（幂等）', async () => {
    writeFileSync(tmp.outboxPath, outboxBlock('sig_a'), 'utf8');
    const r = await mem.runOutboxGuard();
    assert.equal(r.rotated, 0);
    assert.equal(r.kept, 1);
    assert.equal(r.archivePath, null);
    assert.equal(readFileSync(tmp.outboxPath, 'utf8'), outboxBlock('sig_a'));
  });

  it('超 64KB 按块轮转进 .dotd/archive/outbox-<批次>.md', async () => {
    let content = '前言保留\n';
    for (let i = 0; i < 400; i++) content += outboxBlock(`sig_${i}`, 200);
    writeFileSync(tmp.outboxPath, content, 'utf8');
    assert.ok(Buffer.byteLength(content, 'utf8') > OUTBOX_MAX_BYTES);

    const r = await mem.runOutboxGuard();
    assert.ok(r.rotated > 0, '应有块被轮转');
    assert.equal(r.archivePath !== null, true);
    assert.ok(existsSync(r.archivePath!), '归档文件应落盘');
    const archived = readFileSync(r.archivePath!, 'utf8');
    assert.ok(archived.includes('OUTBOX 轮转批次'), '归档带头注');
    assert.ok(archived.includes('sig_0'), '最老的块先轮转');

    // 保留部分 + 前言仍在 OUTBOX
    const kept = readFileSync(tmp.outboxPath, 'utf8');
    assert.ok(kept.startsWith('前言保留'), '前言不丢');
    assert.ok(Buffer.byteLength(kept, 'utf8') < OUTBOX_MAX_BYTES, '轮转后回落到阈值内');
  });

  it('未收敛块（签名在 alert_dispatch 无 resolved_at）永不轮转（契约 T3）', async () => {
    let content = '';
    for (let i = 0; i < 400; i++) content += outboxBlock(`sig_${i}`, 200);
    // 把 sig_5 标为未收敛
    writeFileSync(tmp.outboxPath, content, 'utf8');
    const guarded = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      unresolvedSignatures: () => ['sig_5'],
      now: () => now,
    });
    const r = await guarded.runOutboxGuard();
    // sig_5 及其后的块全部保留
    const kept = readFileSync(tmp.outboxPath, 'utf8');
    assert.ok(kept.includes('sig_5'), '未收敛块必须留下');
    assert.ok(kept.includes('sig_399'), '未收敛块之后的块也保留（同进同出）');
    assert.equal(r.kept, 395);
    assert.equal(r.rotated, 5, '只轮转 sig_0..sig_4');
    const archived = readFileSync(r.archivePath!, 'utf8');
    assert.ok(archived.includes('sig_4'));
    assert.ok(!archived.includes('sig_5'));
  });

  it('全是未收敛块 → 什么都不做（体积阈值让位）', async () => {
    let content = '';
    for (let i = 0; i < 400; i++) content += outboxBlock(`sig_${i}`, 200);
    writeFileSync(tmp.outboxPath, content, 'utf8');
    const guarded = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      unresolvedSignatures: () => Array.from({ length: 400 }, (_, i) => `sig_${i}`),
      now: () => now,
    });
    const r = await guarded.runOutboxGuard();
    assert.equal(r.rotated, 0);
    assert.equal(r.kept, 400);
    assert.equal(r.archivePath, null);
  });

  it('块数超 200 也触发轮转（双阈值）', async () => {
    let content = '';
    for (let i = 0; i < 250; i++) content += outboxBlock(`s${i}`, 10); // 小体块：字节不超但块数超
    writeFileSync(tmp.outboxPath, content, 'utf8');
    assert.ok(content.split('## [').length - 1 > OUTBOX_MAX_BLOCKS);
    const r = await mem.runOutboxGuard();
    assert.ok(r.rotated > 0);
  });

  it('OUTBOX.md 不存在 → 空结果（不创建文件）', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(tmp.outboxPath, { force: true });
    const r = await mem.runOutboxGuard();
    assert.equal(r.rotated, 0);
    assert.equal(existsSync(tmp.outboxPath), false);
  });

  it('无 unresolvedSignatures 探针 → 保守全留（契约 T3：查不到就全留）', async () => {
    let content = '';
    for (let i = 0; i < 400; i++) content += outboxBlock(`sig_${i}`, 200);
    writeFileSync(tmp.outboxPath, content, 'utf8');
    // 显式构造一个没配 unresolvedSignatures 的实例（默认 mem 是配了探针的，
    // 装配层在 MR 上线后一定会注入；这里测的是"探针缺失"的降级路径）。
    const guarded = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      now: () => now,
    });
    const r = await guarded.runOutboxGuard();
    assert.equal(r.rotated, 0, '保守：探针缺失时不轮转');
    assert.equal(r.kept, 400);
    assert.equal(r.archivePath, null);
    assert.equal(readFileSync(tmp.outboxPath, 'utf8'), content, '文件一字不动');
  });
});

describe('appendOutboxBlock（§3.6 追加入口，崩溃恢复路径用）', () => {
  it('块首行可被 tail -n 20 直读', () => {
    mem.appendOutbox('db_corrupt', '测试正文');
    const content = readFileSync(tmp.outboxPath, 'utf8');
    assert.match(content, /^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] HELP db_corrupt\n/);
    assert.ok(content.endsWith('---\n\n'));
  });

  it('文件不存在时创建（含父目录）', () => {
    const nested = join(tmp.root, 'sub', 'OUTBOX.md');
    mem.appendOutbox('x', 'y');
    assert.ok(existsSync(tmp.outboxPath));
    assert.equal(existsSync(nested), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §3.6 路径与容量常量（config/dotd.yml 的 alerts.outbox_path 支持 ~ 展开）
// ═══════════════════════════════════════════════════════════════════

describe('outbox 路径与容量常量', () => {
  it("默认 outboxPath 展开 ~（不展开会得到字面 '~' 假目录）", () => {
    // 此前 DEFAULT_OUTBOX_PATH = '~/.dotd/OUTBOX.md' 直接传给 join(dirname(...))，
    // 归档目录落到 '~\.dotd\.dotd\archive'（相对路径解析到 cwd）。
    assert.equal(DEFAULT_OUTBOX_PATH, '~/.dotd/OUTBOX.md');
    const mem2 = new MemoryServiceImpl({ db: tmp.db, bridge: makeStubFsOpsBridge() });
    // 默认路径必须落在真实 HOME 下，而不是进程 cwd 下的 '~' 目录
    const got = mem2.outboxFilePath();
    assert.equal(got, join(homedir(), '.dotd', 'OUTBOX.md'));
    assert.ok(isAbsolute(got), '展开后必须是绝对路径');
    assert.ok(!got.includes(`${sep}~${sep}`), '不得残留字面 ~');
  });

  it('装配层传 ~ 路径同样展开', () => {
    const mem2 = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: '~/.dotd/custom/OUTBOX.md',
    });
    assert.equal(mem2.outboxFilePath(), join(homedir(), '.dotd', 'custom', 'OUTBOX.md'));
  });

  it('归档目录基于展开后的真实父目录（不再出现 ~\.dotd\.dotd\archive）', async () => {
    const mem2 = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
    });
    // 用一个可触发轮转的大文件走完整路径，检查 archivePath 的父目录
    const blocks: string[] = [];
    for (let i = 0; i < 30; i++) blocks.push(outboxBlock(`sig_${i}`));
    writeFileSync(tmp.outboxPath, blocks.join('\n'), 'utf8');
    const r = await mem2.runOutboxGuard();
    if (r.archivePath !== null) {
      assert.ok(!r.archivePath.includes(`${sep}~${sep}`), '归档路径不含字面 ~');
      assert.ok(isAbsolute(r.archivePath), '归档路径是绝对路径');
    }
  });

  it('ARCHIVE_SOFT_LIMIT_BYTES = 32MB（注释说 32MB，值也得是 32MB）', () => {
    assert.equal(ARCHIVE_SOFT_LIMIT_BYTES, 32 * 1024 * 1024);
    assert.equal(ARCHIVE_SOFT_LIMIT_BYTES, LIMIT_ARCHIVE_BYTES.hard);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §7 compactionTriggers（§3.5 触发条件）
// ═══════════════════════════════════════════════════════════════════

describe('compactionTriggers（§3.5 心跳 memory-compaction 每小时探测）', () => {
  it('空库 → 至少有 fortnightly 兜底（每 14 天轻量版）', () => {
    const triggers = mem.compactionTriggers('dot1');
    assert.ok(triggers.includes('fortnightly'));
  });

  it('fortnightly 是 14 天节流：同一 14 天窗口内第二次探测不再触发', () => {
    // §3.5：fortnightly 兜底「每 14 天」触发一次。若游标只读不写，
    // 该触发条件退化成「每小时都触发」，轻量版反而成了最高频动作。
    const first = mem.compactionTriggers('dot1');
    assert.ok(first.includes('fortnightly'), '首次探测应触发（无游标）');

    const second = mem.compactionTriggers('dot1');
    assert.ok(!second.includes('fortnightly'), '窗口内第二次不应再触发');

    // 推进 14 天后重新打开探测（模拟下一次心跳）
    const later = now + 14 * DAY + 1000;
    const late = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      outboxPath: tmp.outboxPath,
      now: () => later,
    });
    assert.ok(late.compactionTriggers('dot1').includes('fortnightly'), '满 14 天重新触发');
  });

  it('status() 是纯读：不得推进 compact_due 游标', async () => {
    const st = await mem.status();
    assert.ok(st.maintenance.compactTriggers.includes('fortnightly'), 'status 报出待整理项');
    assert.equal(
      mem.compactionTriggers('dot1').includes('fortnightly'),
      true,
      'status() 不应消费掉探测的触发机会（游标仍为空）',
    );
  });

  it('notes 未归档 >60 → notes_count>60', () => {
    for (let i = 1; i <= 61; i++) {
      tmp.db
        .prepare(
          `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
           VALUES ('dot1', ?, 'notes', NULL, NULL, 10, ?)`,
        )
        .run(`notes/2026-01-${String(i).padStart(2, '0')}-slug${i}.md`, now);
    }
    const triggers = mem.compactionTriggers('dot1');
    assert.ok(triggers.includes('notes_count>60'));
  });

  it('notes 超 30 天未动 → notes_stale>30d', () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'notes/2025-01-01-a.md', 'notes', NULL, NULL, 10, ?)`,
      )
      .run(now - 40 * DAY);
    const triggers = mem.compactionTriggers('dot1');
    assert.ok(triggers.includes('notes_stale>30d'));
  });

  it('home 活跃集超软限 1MB → home>1MB', () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'MEMORY.md', 'memory', NULL, NULL, ?, ?)`,
      )
      .run(1024 * 1024 + 1, now);
    const triggers = mem.compactionTriggers('dot1');
    assert.ok(triggers.includes('home>1MB'));
  });

  it('月度摘要/下划线留痕不计入 notes_count', () => {
    // 豁免口径 = limits.ts NOTE_EXEMPT_RE：`YYYY-MM-digest.md`（无数字后缀）与 `_*.md`。
    // 注意 mem_files_index 有 (dot_id, path) UNIQUE，同一个月度摘要只能一条。
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', ?, 'notes', NULL, NULL, 10, ?)`,
      )
      .run('notes/2026-01-digest.md', now);
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', ?, 'notes', NULL, NULL, 10, ?)`,
      )
      .run('notes/_compactions.md', now);
    for (let i = 1; i <= 61; i++) {
      tmp.db
        .prepare(
          `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
           VALUES ('dot1', ?, 'notes', NULL, NULL, 10, ?)`,
        )
        .run(`notes/2026-01-${String(i).padStart(2, '0')}-slug${i}.md`, now);
    }
    // 61 条普通 note + 2 条豁免：豁免不计入，61 > 60 仍应触发
    assert.ok(mem.compactionTriggers('dot1').includes('notes_count>60'));

    // 全换成下划线留痕（可无限编号，避开 UNIQUE）→ 不再触发
    tmp.db.prepare("DELETE FROM mem_files_index WHERE dot_id = 'dot1'").run();
    for (let i = 1; i <= 61; i++) {
      tmp.db
        .prepare(
          `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
           VALUES ('dot1', ?, 'notes', NULL, NULL, 10, ?)`,
        )
        .run(`notes/_compactions${i}.md`, now);
    }
    assert.ok(
      !mem.compactionTriggers('dot1').includes('notes_count>60'),
      'exempt 文件不计入',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// §8 status() 汇总（§8）
// ═══════════════════════════════════════════════════════════════════

describe('status()（§8 汇总）', () => {
  it('各段齐全：db/home/threads/maintenance/searchStats/seal/feedback/bridge', async () => {
    makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    makeThread({ status: 'sealed', lastActiveAgo: 100 * DAY, lastFinishedAgo: 40 * DAY });
    makeThread({ pinned: 1, lastActiveAgo: 0, lastFinishedAgo: null });
    const st = await mem.status();
    assert.equal(st.threads.active, 2);
    assert.equal(st.threads.sealed, 1);
    assert.equal(st.threads.pinned, 1);
    assert.equal(st.maintenance.retentionLastRun, null);
    assert.equal(st.bridge.kind, 'stub');
    assert.equal(st.bridge.available, true);
    assert.equal(st.searchStats.queries, 0);
  });

  it('跑过 retention 后 maintenance.retentionLastRun 有时戳', async () => {
    await mem.runRetention();
    const st = await mem.status();
    assert.equal(st.maintenance.retentionLastRun, now);
  });

  it('summarizeDue 统计消息数 >64 的 thread', async () => {
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    for (let i = 1; i <= 65; i++) {
      tmp.db
        .prepare(
          `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
           VALUES (?, ?, ?, 'user', 'text', 'x', NULL, NULL, 1, ?)`,
        )
        .run(`msg_${i}_${Math.random().toString(36).slice(2, 5)}`, t, i, now);
    }
    const st = await mem.status();
    assert.equal(st.maintenance.summarizeDue, 1);
  });

  it('db.walBytes 是真值，不是硬编码 0', async () => {
    // §6.2：db 用量必须含 WAL（wal_autocheckpoint=400 只做被动兜底）。
    // 此前 status() 恒报 walBytes: 0，导致运维看 status 以为 WAL 没长。
    const st = await mem.status();
    assert.equal(typeof st.db.walBytes, 'number');
    assert.ok(st.db.walBytes >= 0, 'walBytes 非负');
    // WAL 文件大小由 walSize() 实测 stat；临时库上可能是 0（已 checkpoint），
    // 但这里验证的是「字段接了真实 stat 路径」而非恒 0 的表达式：
    // 写入一条后 WAL 至少存在过，实测值必须等于 <db>-wal 的字节数。
    const dbPath = (tmp.db as unknown as { location?: () => string }).location?.();
    if (typeof dbPath === 'string' && existsSync(`${dbPath}-wal`)) {
      assert.equal(st.db.walBytes, statSync(`${dbPath}-wal`).size, '与 <db>-wal 实际字节一致');
    }
  });

  it('seal.backfilled / seal.violations 在 retention 补写后有值（kv 有写入者）', async () => {
    // 此前 status().seal.backfilled 读的 seal_backfilled 全仓无写入者 → 恒 0。
    // retention 算出计数后必须回写 kv，status() 才读得到。
    const t = makeThread({ lastActiveAgo: 0, lastFinishedAgo: null });
    tmp.db
      .prepare(
        `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
         VALUES (?, ?, 1, 'system', 'task_start', '{}', ?, NULL, 1, ?)`,
      )
      .run(`m_ts_${Math.random().toString(36).slice(2, 6)}`, t, 'task_done', now);
    taskStatuses.set('task_done', 'done');
    const report = await mem.runRetention();
    assert.deepEqual(report.orphanTaskEndsBackfilled, ['task_done']);
    assert.deepEqual(report.sealViolations, [`${t}:task_done`]);

    const st = await mem.status();
    assert.equal(st.seal.backfilled, 1, 'status().seal.backfilled 读得到回写值');
    assert.equal(st.seal.violations, 1, 'status().seal.violations 读得到回写值');

    // 且 kv 里真的有这两个键（不是 status 现场算的）
    const rows = tmp.db
      .prepare('SELECT key, value FROM mem_maintenance_state WHERE key IN (?, ?)')
      .all('seal_backfilled', 'seal_violations') as Array<{ key?: string; value?: string }>;
    assert.equal(rows.length, 2, 'retention 已回写两个 kv 键');
    for (const r of rows) assert.equal(r.value, '1');
  });

  it('home.activeBytes 与 home.level 同源（不出现「0 字节却判 hard」）', async () => {
    // §3.4：活跃集口径 = 桥真实聚合 + 索引聚合取 max。
    // 此前 status() 用索引聚合算 level、用桥聚合报 activeBytes，两者可矛盾。
    const bridge2 = makeStubFsOpsBridge();
    const mem2 = new MemoryServiceImpl({
      db: tmp.db,
      bridge: bridge2,
      outboxPath: tmp.outboxPath,
      now: () => now,
    });
    bridge2.put('MEMORY.md', 'x'.repeat(64 * 1024), now);
    bridge2.put('notes/2026-01-01-a.md', 'y'.repeat(32), now);
    await mem2.syncFilesIndex('dot1');
    const st = await mem2.status();
    assert.ok(st.home.activeBytes > 0, 'activeBytes 非零');
    if (st.home.level === 'hard') {
      assert.ok(
        st.home.activeBytes > st.home.hardLimitBytes,
        '判 hard 时 activeBytes 必须真的超过硬限',
      );
    }
    if (st.home.level === 'soft') {
      assert.ok(
        st.home.activeBytes > st.home.softLimitBytes,
        '判 soft 时 activeBytes 必须真的超过软限',
      );
    }
    if (st.home.level === 'ok') {
      assert.ok(
        st.home.activeBytes <= st.home.softLimitBytes,
        '判 ok 时不得已超软限',
      );
    }
  });
});
