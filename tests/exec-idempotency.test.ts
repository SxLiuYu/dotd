/**
 * tests/exec-idempotency.test.ts —— 幂等 ledger、reconcile、degraded 闸门（EX §5.4/§2.2）。
 *
 * 全部跑在 DOTD_FLEET=stub 上（CONVENTIONS.md §7）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import type { ExecToolCall } from '../src/shared/contracts.ts';

function c(o: Partial<ExecToolCall> & { call_id: string; tool: ExecToolCall['tool'] }): ExecToolCall {
  return {
    task_id: 't-1',
    dot_id: 'dot-a',
    args: {},
    deadline_ms: 5000,
    issued_at: new Date().toISOString(),
    ...o,
  };
}

/** 计数型 handler：记录每个 call_id 被执行了几次。 */
function countingHandler(counter: Map<string, number>) {
  return {
    'fs.write': (call: ExecToolCall) => {
      counter.set(call.call_id, (counter.get(call.call_id) ?? 0) + 1);
      return {
        call_id: call.call_id,
        status: 'ok' as const,
        result: { n: counter.get(call.call_id) ?? 0 },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// ① 幂等：同 call_id 至多执行一次（EX §5.4 / S1）
// ═══════════════════════════════════════════════════════════════════

test('幂等：同 call_id 第二次进入直接重放，不再执行 handler', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    await svc.boot(['dot-a']);

    const call = c({ call_id: 'idem-1', tool: 'fs.write', args: { path: '/dot/home/a', content: 'x' } });
    const r1 = await svc.runTool(call);
    assert.equal(r1.status, 'ok');
    assert.equal((r1.result as { n?: number }).n, 1);
    assert.equal(counter.get('idem-1'), 1, 'handler 必须只执行一次');

    const r2 = await svc.runTool(call);
    assert.equal(r2.status, 'ok');
    assert.equal(counter.get('idem-1'), 1, '第二次不得再执行 handler');
    // 重放结果带 result_hash（宿主侧不存明文结果，EX §5.4）
    const hash = (r2.result as { result_hash?: string }).result_hash;
    assert.match(hash ?? '', /^[0-9a-f]{64}$/);

    // 第三次同样
    const r3 = await svc.runTool(call);
    assert.equal(counter.get('idem-1'), 1);
    assert.equal(r3.status, 'ok');
  } finally {
    t.cleanup();
  }
});

test('幂等：不同 call_id 各自执行一次（call_id 是唯一幂等键）', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    await svc.boot(['dot-a']);
    await svc.runTool(c({ call_id: 'a', tool: 'fs.write', args: { path: '/dot/home/a', content: '1' } }));
    await svc.runTool(c({ call_id: 'b', tool: 'fs.write', args: { path: '/dot/home/a', content: '2' } }));
    assert.equal(counter.get('a'), 1);
    assert.equal(counter.get('b'), 1);
    // exec_calls 两行
    assert.equal(svc.fleet.openCalls('dot-a').length, 0); // 都终态了
    const rowA = svc.fleet.getCall('a');
    const rowB = svc.fleet.getCall('b');
    assert.equal(rowA?.state, 'done');
    assert.equal(rowB?.state, 'done');
  } finally {
    t.cleanup();
  }
});

test('幂等：失败结果也被记录并重放（不再执行）', async () => {
  const t = makeTempDataDir();
  try {
    let n = 0;
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          'fs.read': (call) => {
            n += 1;
            return {
              call_id: call.call_id,
              status: 'error',
              error: { code: 'boom', message: 'stub 失败', retryable: false },
              finished_at: new Date().toISOString(),
            };
          },
        },
      },
    });
    await svc.boot(['dot-a']);
    const call = c({ call_id: 'err-1', tool: 'fs.read', args: { path: '/dot/home/x' } });
    const r1 = await svc.runTool(call);
    assert.equal(r1.status, 'error');
    assert.equal(r1.error?.code, 'boom');
    const r2 = await svc.runTool(call);
    assert.equal(r2.status, 'error');
    assert.equal(n, 1, '失败结果同样只执行一次（幂等覆盖终态）');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ② ledger 状态流转与容器重启（EX §5.4-1）
// ═══════════════════════════════════════════════════════════════════

test('ledger：done 记录跨容器 recreate 仍可重放（结果不因换容器丢失）', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    await svc.boot(['dot-a']);
    const call = c({ call_id: 'keep-1', tool: 'fs.write', args: { path: '/dot/home/k', content: 'v' } });
    await svc.runTool(call);
    assert.equal(counter.get('keep-1'), 1);

    // recreate 后（容器换了），同 call_id 仍然重放 done
    await svc.recreateContainer('dot-a');
    const r = await svc.runTool(call);
    assert.equal(r.status, 'ok');
    assert.equal(counter.get('keep-1'), 1, 'recreate 不得导致重执行');
  } finally {
    t.cleanup();
  }
});

test('ledger：simulateRestart 后 doing → aborted；reconcile 报 interrupted', async () => {
  const t = makeTempDataDir();
  try {
    // 造一个挂住的 async 调用：handler 永不 resolve，制造 'sent'/'running' 的 open call
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    if (release === undefined) throw new Error('release 未被赋值');
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          'net.get': async (call) => {
            await gate;
            return { call_id: call.call_id, status: 'ok', result: { ok: 1 }, finished_at: new Date().toISOString() };
          },
        },
      },
    });
    await svc.boot(['dot-a']);
    const p = svc.runTool(c({ call_id: 'open-1', tool: 'net.get', args: { url: 'https://x' }, deadline_ms: 30_000 }));
    await new Promise((r) => setTimeout(r, 60));
    // 此刻 exec_calls 里应是 sent/running（open call）
    const open = svc.fleet.openCalls('dot-a');
    assert.equal(open.length, 1);
    assert.equal(open[0]?.call_id, 'open-1');
    assert.ok(['sent', 'running'].includes(open[0]?.state ?? ''));

    // 模拟容器进程重启：ledger 里 doing → aborted
    const stub = (svc as unknown as { stub: { ledger: Map<string, { state: string }>; simulateRestart(): void } }).stub;
    stub.simulateRestart();

    // reconcile：容器可达 → 查 /calls/{id} 得 aborted → interrupted
    const entries = await svc.fleet.reconcileOpenCalls('dot-a');
    const hit = entries.find((e) => e.callId === 'open-1');
    assert.ok(hit !== undefined, 'reconcile 必须覆盖该 open call');
    assert.equal(hit?.outcome, 'interrupted');
    assert.equal(hit?.reason, 'aborted');
    // exec_calls 已标 interrupted
    assert.equal(svc.fleet.getCall('open-1')?.state, 'interrupted');
    // open 集合已清空
    assert.equal(svc.fleet.openCalls('dot-a').length, 0);

    release();
    await p;
  } finally {
    t.cleanup();
  }
});

test('ledger：容器不可达时 reconcile 全部报 interrupted（container_lost）', async () => {
  const t = makeTempDataDir();
  try {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    if (release === undefined) throw new Error('release 未被赋值');
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          'net.get': async (call) => {
            await gate;
            return { call_id: call.call_id, status: 'ok', result: {}, finished_at: new Date().toISOString() };
          },
        },
      },
    });
    await svc.boot(['dot-a']);
    const p = svc.runTool(c({ call_id: 'lost-1', tool: 'net.get', args: { url: 'https://x' }, deadline_ms: 30_000 }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(svc.fleet.openCalls('dot-a').length, 1);

    // 销毁容器（不可达）后 reconcile
    await svc.destroyDotContainer('dot-a');
    const entries = await svc.fleet.reconcileOpenCalls('dot-a');
    const hit = entries.find((e) => e.callId === 'lost-1');
    assert.equal(hit?.outcome, 'interrupted');
    assert.equal(hit?.reason, 'container_lost');
    assert.equal(svc.fleet.getCall('lost-1')?.state, 'interrupted');

    release();
    await p;
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ②-b 运行期守卫：容器转 unhealthy 后轮询立刻收手（2026-10-17 修）
// ═══════════════════════════════════════════════════════════════════

test('运行期守卫：容器被判 unhealthy 后调用立刻中止，不烧到 deadline', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          // 一直 running：让 runTool 停在轮询循环里（stub 的 startJob 会等 handler
          // 收尾，所以不能用"挂着不返回"的 handler——那根本进不到 pollJob）。
          'shell.run': async (call) => ({ call_id: call.call_id, status: 'running' as const }),
        },
      },
    });
    await svc.boot(['dot-a']);
    const startedAt = Date.now();
    const p = svc.runTool(c({ call_id: 'uh-1', tool: 'shell.run', args: { cmd: 'sleep 1', timeout_ms: 1000 }, deadline_ms: 60_000 }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(svc.fleet.openCalls('dot-a').length, 1, '调用应在途');

    // 容器被别处（健康检查连败 / guard 拆除）判成 unhealthy
    svc.fleet.transition('dot-a', 'unhealthy', { reason: '测试：运行期失康' });

    const r = await p;
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'container_unhealthy');
    assert.equal(r.error?.retryable, true, '必须可重派');
    assert.ok(Date.now() - startedAt < 10_000, `必须远早于 deadline 收手，实际 ${Date.now() - startedAt}ms`);
    assert.equal(svc.fleet.getCall('uh-1')?.state, 'error', 'ledger 必须落 error + 原因');
    assert.equal(svc.fleet.getCall('uh-1')?.error_code, 'container_unhealthy');
  } finally {
    t.cleanup();
  }
});

test('运行期守卫：healthy 期间轮询不受影响（不误杀在途调用）', async () => {
  const t = makeTempDataDir();
  try {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    if (release === undefined) throw new Error('release 未被赋值');
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          // 首轮 running，放开 gate 后转终态：跨多次轮询仍能正常收尾
          'shell.run': async (call) => {
            await gate;
            return { call_id: call.call_id, status: 'ok', result: { ok: 1 }, finished_at: new Date().toISOString() };
          },
        },
      },
    });
    await svc.boot(['dot-a']);
    const p = svc.runTool(c({ call_id: 'uh-2', tool: 'shell.run', args: { cmd: 'sleep 1', timeout_ms: 1000 }, deadline_ms: 60_000 }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(svc.fleet.getContainer('dot-a')?.state, 'busy', '在途调用期间容器仍是 busy');
    assert.equal(svc.fleet.openCalls('dot-a').length, 1);
    release();
    const r = await p;
    assert.equal(r.status, 'ok');
    assert.equal(svc.fleet.getCall('uh-2')?.state, 'done');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ③ §5.4-4 压缩语义：确认 → 瘦身 → 重放 result_compacted（execution.md:298）
// ═══════════════════════════════════════════════════════════════════

test('ledger：压缩后重放 → result_compacted（journal 视同 done-但-降级）', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    await svc.boot(['dot-a']);
    const call = c({ call_id: 'cmp-1', tool: 'fs.write', args: { path: '/dot/home/k', content: 'v' } });
    const first = await svc.runTool(call);
    assert.equal(first.status, 'ok');
    assert.equal(counter.get('cmp-1'), 1);

    // ① 控制平面确认（execution.md:298 的压缩准入条件）
    assert.equal(await svc.confirmCallResult('dot-a', 'cmp-1'), true, 'done 记录才可确认');
    // ② 触发压缩（stub 按 LEDGER_COMPACT_THRESHOLD 门控；未达阈值时不压缩）
    const stub = (svc as unknown as {
      stub: { ledger: Map<string, unknown> };
    }).stub;
    assert.equal(stub.ledger.size < 5000, true, 'stub 单条调用远低于阈值');

    // 直接在容器侧标记压缩，模拟跨阈值瘦身后的状态（避免造 5000 条记录）
    const rec = stub.ledger.get('cmp-1') as Record<string, unknown> | undefined;
    assert.ok(rec !== undefined);
    stub.ledger.set('cmp-1', {
      ...rec,
      state: 'compacted',
      result_hash: 'a'.repeat(64),
      result_json: undefined,
    });

    // ③ 重放：必须走 runTool → settle 的 result_compacted 分支
    const r = await svc.runTool(call);
    assert.equal(counter.get('cmp-1'), 1, '压缩后重放不得二次执行');
    // journal 语义：视同 done（不是 error 也不是重试）
    assert.equal(svc.fleet.getCall('cmp-1')?.state, 'done');
    // result_hash 必须回填（容器侧算的 sha256，值本身不硬编码，只要求 64 位十六进制）
    const hash = svc.fleet.getCall('cmp-1')?.result_hash;
    assert.match(hash ?? '', /^[0-9a-f]{64}$/, 'result_hash 必须回填为 sha256');
    // 状态仍是"已发送完成"而非失败/中断
    assert.equal(r.status !== 'error' || r.error?.code === 'result_compacted', true);
  } finally {
    t.cleanup();
  }
});

test('ledger：未确认的 done 记录不得被压缩（先确认、后瘦身）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    await svc.runTool(c({ call_id: 'nc-1', tool: 'fs.write', args: { path: '/dot/home/k', content: 'v' } }));

    const stub = (svc as unknown as {
      stub: {
        ledger: Map<string, Record<string, unknown>>;
        confirmCall(ep: string, tk: string, id: string): Promise<boolean>;
        compactLedger(ep: string, tk: string): Promise<string[]>;
      };
    }).stub;
    // 绕过阈值门控：把 ledger 灌到 >= 阈值，模拟"达到压缩条件"的环境
    for (let i = 0; i < 5000; i += 1) {
      stub.ledger.set(`pad-${i}`, { call_id: `pad-${i}`, state: 'doing', tool: 'fs.read', args_hash: 'h', started_at: 't' });
    }
    const compressed = await stub.compactLedger('ep', 'tk');
    assert.deepEqual(compressed, [], '未确认的 done 不得进压缩名单');
    assert.equal(stub.ledger.get('nc-1')?.['state'], 'done', '原记录保持 done 可重放');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ④ degraded 闸门（§2.2：未发送即返回，不重复执行）
// ═══════════════════════════════════════════════════════════════════

test('degraded：docker ping 失败后 runTool 未发送即返回 docker_unavailable(retryable)', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    // 先正常 boot 一个容器
    await svc.boot(['dot-a']);
    const first = await svc.runTool(c({ call_id: 'dg-0', tool: 'fs.write', args: { path: '/dot/home/a', content: 'x' } }));
    assert.equal(first.status, 'ok');
    assert.equal(counter.get('dg-0'), 1);

    // 把 docker 打到不可用
    (svc as unknown as { backend: { setPing(v: boolean): void } }).backend.setPing(false);
    // 触发一次 boot 让 fleet 进入 degraded（boot 里 ping 失败即 markDegraded）
    await svc.boot(['dot-a']);
    assert.equal(svc.fleet.degraded, true);

    const r = await svc.runTool(c({ call_id: 'dg-1', tool: 'fs.write', args: { path: '/dot/home/a', content: 'y' } }));
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'docker_unavailable');
    assert.equal(r.error?.retryable, true, 'retryable：journal 保持 call_sent，可稍后重派');
    // 关键：handler 未被调用（未发送）
    assert.equal(counter.has('dg-1'), false, 'degraded 下不得执行工具体');
    // exec_calls 里留下 error 记录供对账
    assert.equal(svc.fleet.getCall('dg-1')?.state, 'error');
  } finally {
    t.cleanup();
  }
});

test('degraded：clearDegraded 后恢复派发', async () => {
  const t = makeTempDataDir();
  try {
    const counter = new Map<string, number>();
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { handlers: countingHandler(counter) },
    });
    await svc.boot(['dot-a']);
    (svc as unknown as { backend: { setPing(v: boolean): void } }).backend.setPing(false);
    await svc.boot(['dot-a']);
    assert.equal(svc.fleet.degraded, true);

    // 恢复 docker，再 boot 一次清除 degraded
    (svc as unknown as { backend: { setPing(v: boolean): void } }).backend.setPing(true);
    await svc.boot(['dot-a']);
    assert.equal(svc.fleet.degraded, false);
    assert.equal(svc.fleet.degradedSinceAt(), null);

    const r = await svc.runTool(c({ call_id: 'dg-2', tool: 'fs.write', args: { path: '/dot/home/a', content: 'z' } }));
    assert.equal(r.status, 'ok');
    assert.equal(counter.get('dg-2'), 1);
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ④ cancelTool（§5.5：幂等；sync 只标本地，async 走 job cancel）
// ═══════════════════════════════════════════════════════════════════

test('cancelTool：幂等；对终态 call 调用无副作用', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    await svc.runTool(c({ call_id: 'cx-1', tool: 'fs.write', args: { path: '/dot/home/a', content: 'x' } }));
    assert.equal(svc.fleet.getCall('cx-1')?.state, 'done');
    // 对 done 的 call 取消：无变化、不抛错
    await svc.cancelTool('cx-1', '用户取消');
    assert.equal(svc.fleet.getCall('cx-1')?.state, 'done');
    // 不存在的 call：不抛
    await svc.cancelTool('nope', 'x');
  } finally {
    t.cleanup();
  }
});

test('cancelTool：未 boot 的 dot 上调 runTool 之后 cancel 不炸', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.runTool(c({ call_id: 'cx-2', tool: 'fs.read', args: { path: '/dot/home/a' } }));
    await svc.cancelTool('cx-2', '取消');
    const row = svc.fleet.getCall('cx-2');
    // container_not_ready 已置 error；cancel 幂等不改
    assert.equal(row?.state, 'error');
  } finally {
    t.cleanup();
  }
});

test('取消标志随调用终态销户（否则 cancelled Set 无界增长）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          // 一直 running：让调用停在轮询循环里，才有"在途被取消"这条路
          'shell.run': async (call) => ({ call_id: call.call_id, status: 'running' as const }),
        },
      },
    });
    await svc.boot(['dot-a']);
    const p = svc.runTool(c({ call_id: 'cx-3', tool: 'shell.run', args: { cmd: 'sleep 5', timeout_ms: 5000 }, deadline_ms: 60_000 }));
    await new Promise((r) => setTimeout(r, 60));
    await svc.cancelTool('cx-3', '治理取消');
    const r = await p;
    assert.equal(r.status, 'cancelled');
    const inner = svc as unknown as { cancelled: Set<string> };
    assert.equal(inner.cancelled.size, 0, '终态后 cancelled 必须清空');
    assert.equal(svc.fleet.getCall('cx-3')?.state, 'cancelled');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ fsOps 桥（契约 S4'/M4：宿主侧硬护栏）
// ═══════════════════════════════════════════════════════════════════

test('fsOps：read/list/stat/rename 走容器桥；越界路径宿主侧即拒', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({
      db: t.db, bus: t.bus, cfg: { tokenDir: t.root },
      stubRuntime: { seedFiles: { '/dot/home/a.txt': 'hello', '/dot/home/b.txt': 'world' } },
    });
    await svc.boot(['dot-a']);

    const rd = await svc.fsOps('dot-a', { op: 'read', path: '/dot/home/a.txt' });
    assert.equal(rd.ok, true);
    assert.equal(rd.content, 'hello');

    const ls = await svc.fsOps('dot-a', { op: 'list', path: '/dot/home' });
    assert.equal(ls.ok, true);
    assert.ok((ls.entries ?? []).length >= 2);

    const st = await svc.fsOps('dot-a', { op: 'stat', path: '/dot/home/a.txt' });
    assert.equal(st.ok, true);

    // rename：home 内合法
    const mv = await svc.fsOps('dot-a', { op: 'rename', path: '/dot/home/a.txt', target: '/dot/home/c.txt' });
    assert.equal(mv.ok, true);
    // 改名后读到新路径
    const rd2 = await svc.fsOps('dot-a', { op: 'read', path: '/dot/home/c.txt' });
    assert.equal(rd2.content, 'hello');

    // 宿主侧护栏：越界路径在宿主即被拒（不发容器）
    const bad = await svc.fsOps('dot-a', { op: 'read', path: '/etc/passwd' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, 'path_outside_home');

    // 隐藏前缀
    const hid = await svc.fsOps('dot-a', { op: 'read', path: '/dot/home/.dotd/x' });
    assert.equal(hid.error?.code, 'path_hidden');

    // rename 的 target 也必须在 home 内
    const badTarget = await svc.fsOps('dot-a', { op: 'rename', path: '/dot/home/c.txt', target: '/tmp/x' });
    assert.equal(badTarget.ok, false);
    assert.equal(badTarget.error?.code, 'path_outside_home');

    // rename 缺 target
    const noTarget = await svc.fsOps('dot-a', { op: 'rename', path: '/dot/home/c.txt' });
    assert.equal(noTarget.error?.code, 'bad_target');
  } finally {
    t.cleanup();
  }
});

test('fsOps：容器未 ready → container_not_ready（MEM 侧降级记 memory_missed）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    // 不 boot
    const r = await svc.fsOps('dot-a', { op: 'read', path: '/dot/home/a.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'container_not_ready');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ setIdentityProfile（契约 S5/G1）
// ═══════════════════════════════════════════════════════════════════

test('setIdentityProfile：返回 sha256 前 16 位 hash；幂等 upsert', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const r1 = await svc.setIdentityProfile('dot-a', 'alice@example.com');
    assert.match(r1.profileHash, /^[0-9a-f]{16}$/);
    const r2 = await svc.setIdentityProfile('dot-a', 'alice@example.com');
    assert.equal(r2.profileHash, r1.profileHash, '同 identity 必须得到同 hash（幂等）');
    // 台账只有一行
    assert.equal(svc.fleet.listIdentities('dot-a').length, 1);
    const r3 = await svc.setIdentityProfile('dot-a', 'bob@example.com');
    assert.notEqual(r3.profileHash, r1.profileHash);
    assert.equal(svc.fleet.listIdentities('dot-a').length, 2);
  } finally {
    t.cleanup();
  }
});
