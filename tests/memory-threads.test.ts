/**
 * tests/memory-threads.test.ts —— 线程/会话生命周期与消息 seq（MEM §4.1）。
 *
 * 依据（行号指 docs/design/modules/memory.md）：
 * - §4.1 thread ≡ session（契约 M1）：openThread/create/load/get 的调用形与
 *   control-plane.md:447/555 对齐（契约 M2：回写通道唯一 = ControlPlane.bindSession，
 *   本测试只验 MEM 自己的表，不碰 tasks）。
 * - §5.3 external_ref 域规则：UNIQUE 仅对非空 external_ref 生效（部分索引），
 *   即当前只有 telegram=chatId 幂等；web/cli external_ref=NULL；event/heartbeat
 *   恒 NULL，幂等靠 origin_task_id 唯一 + 调用方 event_id 判重。
 * - §5.3 mem_messages.seq：每 thread 从 1 单调，同事务 max+1。
 * - §4.3 sealThread/§4.4 updateContextSummary。
 *
 * 测试绝不碰真实 ~/.dotd：用 tests/helpers.ts 的 makeTempDataDir()（契约 D1）。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';

let tmp: TempDataDir;
let mem: MemoryServiceImpl;

beforeEach(() => {
  tmp = makeTempDataDir();
  mem = new MemoryServiceImpl({ db: tmp.db, bridge: makeStubFsOpsBridge(), outboxPath: tmp.outboxPath });
});

afterEach(() => {
  tmp.cleanup();
});

describe('openThread：channel/external_ref 域规则（§5.3）', () => {
  it('telegram + externalRef 命中部分唯一索引 → 幂等返回同一 id', async () => {
    const a = await mem.openThread('dot1', 'telegram', { externalRef: 'chat:42', title: 'TG 42' });
    const b = await mem.openThread('dot1', 'telegram', { externalRef: 'chat:42', title: 'TG 42 改名' });
    assert.equal(a, b);
    // 幂等命中不改 title（title 只在首建时落）
    const row = tmp.db.prepare('SELECT title FROM mem_threads WHERE id = ?').get(a) as
      | { title?: string }
      | undefined;
    assert.equal(row?.title, 'TG 42');
  });

  it('web/cli 的 external_ref 为 NULL → 不撞唯一索引，每次新建', async () => {
    const a = await mem.openThread('dot1', 'web');
    const b = await mem.openThread('dot1', 'web');
    assert.notEqual(a, b);
    const rows = tmp.db
      .prepare('SELECT external_ref FROM mem_threads WHERE channel = ?')
      .all('web') as Array<{ external_ref?: unknown }>;
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.external_ref, null);
  });

  it('不同 channel 可用同一 externalRef（唯一索引是 (channel, external_ref) 复合）', async () => {
    const tg = await mem.openThread('dot1', 'telegram', { externalRef: 'u1' });
    const cli = await mem.openThread('dot1', 'cli', { externalRef: 'u1' });
    assert.notEqual(tg, cli);
  });

  it('event/heartbeat 幂等靠 origin_task_id', async () => {
    const a = await mem.openThread('dot1', 'event', { originTaskId: 'task_1' });
    const b = await mem.openThread('dot1', 'event', { originTaskId: 'task_1' });
    assert.equal(a, b);
    const c = await mem.openThread('dot1', 'event', { originTaskId: 'task_2' });
    assert.notEqual(a, c);
  });

  it('origin_task_id 只对 event/heartbeat 生效（web/cli 不按它幂等）', async () => {
    const a = await mem.openThread('dot1', 'web', { originTaskId: 'task_1' });
    const b = await mem.openThread('dot1', 'web', { originTaskId: 'task_1' });
    assert.notEqual(a, b);
  });
});

describe('create / load / get（§4.1，control-plane.md:555 调用形）', () => {
  it('create() = openThread("dot1","event")', async () => {
    const id = await mem.create();
    const row = tmp.db.prepare('SELECT channel, dot_id, status FROM mem_threads WHERE id = ?').get(id) as
      | { channel?: string; dot_id?: string; status?: string }
      | undefined;
    assert.equal(row?.channel, 'event');
    assert.equal(row?.dot_id, 'dot1');
    assert.equal(row?.status, 'active');
  });

  it('load() 返回 thread + summary + 全部消息（按 seq 升序）', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '第一句' });
    await mem.appendMessage(t, { role: 'assistant', kind: 'text', content: '第二句' });
    const loaded = await mem.load(t);
    assert.ok(loaded !== null);
    assert.equal(loaded.thread.id, t);
    assert.equal(loaded.summary, null);
    assert.equal(loaded.messages.length, 2);
    assert.deepEqual(
      loaded.messages.map((m) => m.content),
      ['第一句', '第二句'],
    );
  });

  it('get() 是 load() 的别名（sessions.get）', async () => {
    const t = await mem.create();
    const viaGet = await mem.get(t);
    const viaLoad = await mem.load(t);
    assert.deepEqual(viaGet, viaLoad);
  });

  it('不存在的 id → null（不抛）', async () => {
    assert.equal(await mem.load('thr_nope'), null);
    assert.equal(await mem.get('thr_nope'), null);
  });

  it('load() 带出 updateContextSummary 回写的 summary（§4.4）', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'x' });
    await mem.updateContextSummary(t, '这是摘要', 1);
    const loaded = await mem.load(t);
    assert.equal(loaded?.summary, '这是摘要');
    assert.equal(loaded?.thread.contextSummaryUptoSeq, 1);
  });

  it('updateContextSummary 超 600 tokens 会被截断（防写入失控）', async () => {
    const t = await mem.create();
    const huge = '啊'.repeat(5000); // 5000/3.5 ≈ 1429 tokens
    await mem.updateContextSummary(t, huge, 3);
    const loaded = await mem.load(t);
    const len = loaded?.summary?.length ?? 0;
    assert.ok(len < huge.length, `应被截断（实际 ${len}）`);
    assert.ok(len <= Math.ceil(600 * 3.5), `截断后 ≤600 tokens（实际 ${len} 字符）`);
  });
});

describe('appendMessage：seq 分配与 last_active_at（§5.3）', () => {
  it('seq 从 1 单调递增', async () => {
    const t = await mem.create();
    const r1 = await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'a' });
    const r2 = await mem.appendMessage(t, { role: 'assistant', kind: 'text', content: 'b' });
    const r3 = await mem.appendMessage(t, { role: 'system', kind: 'task_end', content: 'c' });
    assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2);
    assert.equal(r3.seq, 3);
  });

  it('不同 thread 的 seq 互不干扰（各自从 1 起）', async () => {
    const t1 = await mem.create();
    const t2 = await mem.create();
    assert.equal((await mem.appendMessage(t1, { role: 'user', kind: 'text', content: 'x' })).seq, 1);
    assert.equal((await mem.appendMessage(t2, { role: 'user', kind: 'text', content: 'x' })).seq, 1);
    assert.equal((await mem.appendMessage(t1, { role: 'user', kind: 'text', content: 'x' })).seq, 2);
  });

  it('token_est 按 chars/3.5 落库', async () => {
    const t = await mem.create();
    const content = 'a'.repeat(350); // 350/3.5 = 100 tokens
    await mem.appendMessage(t, { role: 'user', kind: 'text', content });
    const row = tmp.db.prepare('SELECT token_est FROM mem_messages WHERE thread_id = ?').get(t) as
      | { token_est?: number }
      | undefined;
    assert.equal(row?.token_est, 100);
  });

  it('追加消息会刷新 last_active_at（§5.3 封存锚点之一）', async () => {
    const t = await mem.openThread('dot1', 'event', { originTaskId: 'task_x' });
    const before = (
      tmp.db.prepare('SELECT last_active_at FROM mem_threads WHERE id = ?').get(t) as
        | { last_active_at?: number }
        | undefined
    )?.last_active_at;
    // 用注入时钟把时间推后 10s 再写
    const later = new MemoryServiceImpl({
      db: tmp.db,
      bridge: makeStubFsOpsBridge(),
      now: () => (before ?? 0) + 10_000,
    });
    await later.appendMessage(t, { role: 'user', kind: 'text', content: 'hi' });
    const after = (
      tmp.db.prepare('SELECT last_active_at FROM mem_threads WHERE id = ?').get(t) as
        | { last_active_at?: number }
        | undefined
    )?.last_active_at;
    assert.equal(after, (before ?? 0) + 10_000);
  });

  it('appendSystemMessage 落 role=system（S7 审批结果入线用）', async () => {
    const t = await mem.create();
    await mem.appendSystemMessage(t, { kind: 'approval_verdict', content: '{"approved":true}' });
    const row = tmp.db.prepare('SELECT role, kind FROM mem_messages WHERE thread_id = ?').get(t) as
      | { role?: string; kind?: string }
      | undefined;
    assert.equal(row?.role, 'system');
    assert.equal(row?.kind, 'approval_verdict');
  });
});

describe('sealThread（§4.3 / §6.1 封存锚点）', () => {
  it('置 status=sealed 并写 last_task_finished_at', async () => {
    const t = await mem.create();
    await mem.sealThread(t);
    const row = tmp.db.prepare('SELECT status, last_task_finished_at FROM mem_threads WHERE id = ?').get(t) as
      | { status?: string; last_task_finished_at?: number | null }
      | undefined;
    assert.equal(row?.status, 'sealed');
    assert.equal(typeof row?.last_task_finished_at, 'number');
  });
});

describe('查询面（§8 listThreads / listMessages，交互面唯一入口 S11）', () => {
  it('listThreads 按 last_active_at DESC 分页，cursor 是 id 上界', async () => {
    const t1 = await mem.openThread('dot1', 'web', { title: 'T1' });
    await mem.appendMessage(t1, { role: 'user', kind: 'text', content: 'a' });
    const t2 = await mem.openThread('dot1', 'web', { title: 'T2' });
    await mem.appendMessage(t2, { role: 'user', kind: 'text', content: 'a' });
    await mem.appendMessage(t2, { role: 'user', kind: 'text', content: 'b' });

    const page1 = await mem.listThreads('dot1', { limit: 1 });
    assert.equal(page1.length, 1);
    assert.equal(page1[0]!.id, t2, '最新活跃的排最前');
    assert.equal(page1[0]!.messageCount, 2);
    assert.equal(page1[0]!.title, 'T2');

    const page2 = await mem.listThreads('dot1', { limit: 1, cursor: t2 });
    assert.equal(page2[0]!.id, t1);
    assert.equal(page2[0]!.messageCount, 1);
  });

  it('listThreads 可按 status 过滤', async () => {
    const t1 = await mem.create();
    const t2 = await mem.create();
    await mem.sealThread(t2);
    const active = await mem.listThreads('dot1', { status: 'active', limit: 50 });
    const sealed = await mem.listThreads('dot1', { status: 'sealed', limit: 50 });
    assert.deepEqual(active.map((t) => t.id), [t1]);
    assert.deepEqual(sealed.map((t) => t.id), [t2]);
  });

  it('listThreads 只返回该 dotId 的 thread', async () => {
    const mine = await mem.openThread('dot1', 'web');
    await mem.openThread('dot2', 'web');
    const rows = await mem.listThreads('dot1', { limit: 50 });
    assert.deepEqual(rows.map((r) => r.id), [mine]);
  });

  it('listMessages 输出从旧到新；beforeSeq 是下界（不含自身）', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'm1' });
    await mem.appendMessage(t, { role: 'assistant', kind: 'text', content: 'm2' });
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'm3' });

    const all = await mem.listMessages(t, { limit: 10 });
    assert.deepEqual(all.map((m) => m.content), ['m1', 'm2', 'm3']);

    const before = await mem.listMessages(t, { beforeSeq: 3, limit: 10 });
    assert.deepEqual(before.map((m) => m.content), ['m1', 'm2'], 'beforeSeq=3 → 不含 seq 3');
  });

  it('listMessages limit 生效', async () => {
    const t = await mem.create();
    for (let i = 0; i < 5; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: `m${i}` });
    }
    const last2 = await mem.listMessages(t, { limit: 2 });
    assert.deepEqual(last2.map((m) => m.content), ['m3', 'm4']);
  });

  it('searchMessages 命中内容并附片段；无命中返回空', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '部署 dotd 到 WSL' });
    await mem.appendMessage(t, { role: 'assistant', kind: 'text', content: '好的，先跑 typecheck' });

    const hit = await mem.searchMessages('WSL', { limit: 10 });
    assert.equal(hit.length, 1);
    assert.equal(hit[0]!.message.threadId, t);
    assert.ok(hit[0]!.snippet.includes('WSL'));

    const miss = await mem.searchMessages('不存在的词', { limit: 10 });
    assert.equal(miss.length, 0);
  });

  it('searchMessages 的 sinceDays 时间窗生效', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '老消息' });
    const hit = await mem.searchMessages('老消息', { sinceDays: 1, limit: 10 });
    assert.equal(hit.length, 1);
    const tooOld = await mem.searchMessages('老消息', { sinceDays: 0, limit: 10 });
    assert.equal(tooOld.length, 0, 'sinceDays=0 → 窗口起点 = now，已写入消息在其后');
  });

  it('searchMessages 可按 dotId 过滤', async () => {
    const t1 = await mem.openThread('dot1', 'web');
    await mem.appendMessage(t1, { role: 'user', kind: 'text', content: 'dot1 的秘密' });
    const t2 = await mem.openThread('dot2', 'web');
    await mem.appendMessage(t2, { role: 'user', kind: 'text', content: 'dot2 的秘密' });

    const only2 = await mem.searchMessages('秘密', { dotId: 'dot2', limit: 10 });
    assert.equal(only2.length, 1);
    assert.equal(only2[0]!.message.threadId, t2);
  });
});

describe('searchMessages 埋点（§6.4 search_stats）', () => {
  it('每次调用都计入 queries，空结果计入 zeroHits', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '有内容' });
    await mem.searchMessages('有内容', { limit: 5 }); // queries=1 zeroHits=0
    await mem.searchMessages('没有', { limit: 5 }); // queries=2 zeroHits=1
    const signal = mem.searchSignal();
    assert.equal(signal.stats.queries, 2);
    assert.equal(signal.stats.zeroHits, 1);
    assert.equal(signal.zeroHitRate, 0.5);
  });
});
