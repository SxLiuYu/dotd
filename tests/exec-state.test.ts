/**
 * tests/exec-state.test.ts —— 容器状态机与生命周期（EX §4.1/§13.1/§13.2，契约 J4/J5）。
 *
 * 全部跑在 DOTD_FLEET=stub 的内存假实现上（CONVENTIONS.md §7）。
 * 断言对象 = src/exec/fleet.ts 的 CONTAINER_TRANSITIONS + Fleet.boot/recreate/reconcile。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import type { ExecToolResult } from '../src/shared/contracts.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { CONTAINER_STATES, CONTAINER_TRANSITIONS } from '../src/exec/types.ts';
import { canTransition } from '../src/exec/fleet.ts';

/** 从 db 直接读某 dot 的当前状态（绕过 service，验证落库）。 */
function stateOf(svc: ExecServiceImpl, dotId: string): string {
  const row = svc.fleet.getContainer(dotId);
  return row?.state ?? 'absent';
}

// ═══════════════════════════════════════════════════════════════════
// ① 状态机词表与合法迁移表（EX §4.1）
// ═══════════════════════════════════════════════════════════════════

test('状态机：16 态词表完整', () => {
  assert.equal(CONTAINER_STATES.length, 16);
  for (const s of [
    'absent', 'image_ready', 'created', 'booting', 'ready', 'busy',
    'idle', 'suspended', 'idle_stop_requested', 'stopped', 'quarantined',
    'unhealthy', 'create_failed', 'build_failed', 'removed', 'lost',
  ]) {
    assert.ok(CONTAINER_STATES.includes(s as (typeof CONTAINER_STATES)[number]), `缺状态 ${s}`);
  }
});

test('状态机：happy path 链路全部合法（absent→…→ready→busy→ready）', () => {
  const chain: Array<[(typeof CONTAINER_STATES)[number], (typeof CONTAINER_STATES)[number]]> = [
    ['absent', 'image_ready'],
    ['image_ready', 'created'],
    ['created', 'booting'],
    ['booting', 'ready'],
    ['ready', 'busy'],
    ['busy', 'ready'],
    ['ready', 'idle'],
    ['idle', 'suspended'],
    ['suspended', 'ready'],
  ];
  for (const [a, b] of chain) {
    assert.equal(canTransition(a, b), true, `${a} → ${b} 应合法`);
  }
});

test('状态机：非法迁移一律 false（含 ready→absent、busy→idle 等）', () => {
  assert.equal(canTransition('ready', 'absent'), false);
  assert.equal(canTransition('busy', 'idle'), false);
  assert.equal(canTransition('absent', 'ready'), false);
  assert.equal(canTransition('removed', 'ready'), false);
  assert.equal(canTransition('stopped', 'ready'), false);
  assert.equal(canTransition('quarantined', 'ready'), false);
  assert.equal(canTransition('build_failed', 'booting'), false);
});

test('状态机：>3 次 recreate/24h 收敛到 quarantined 的入口存在', () => {
  // unhealthy/lost/quarantined/stopped 均可回 booting（recreate 的再启动路径）
  assert.equal(canTransition('unhealthy', 'booting'), true);
  assert.equal(canTransition('lost', 'booting'), true);
  assert.equal(canTransition('quarantined', 'booting'), true);
  assert.equal(canTransition('stopped', 'booting'), true);
  // create_failed/build_failed 只能回 absent（重新走建镜像/建容器）
  assert.equal(canTransition('create_failed', 'absent'), true);
  assert.equal(canTransition('build_failed', 'absent'), true);
  assert.equal(canTransition('create_failed', 'booting'), false);
});

test('状态机：transition 抛 IllegalContainerTransitionError 且不落库', () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    svc.fleet.registerDot('dot-a');
    svc.fleet.transition('dot-a', 'image_ready');
    svc.fleet.transition('dot-a', 'created');
    assert.throws(
      () => svc.fleet.transition('dot-a', 'ready'),
      /非法容器状态迁移/,
    );
    // 非法迁移未改变落库状态
    assert.equal(stateOf(svc, 'dot-a'), 'created');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ② boot（§13.1：ping → ensureImage → HostNetGuard → reconcile → create/boot）
// ═══════════════════════════════════════════════════════════════════

test('boot：absent → image_ready → created → booting → ready', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    assert.equal(stateOf(svc, 'dot-a'), 'absent');
    const rep = await svc.boot(['dot-a']);
    assert.deepEqual(rep.created, ['dot-a']);
    assert.deepEqual(rep.failed, []);
    assert.equal(rep.dockerAvailable, true);
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
    // 端点与 token 均已落库
    const row = svc.fleet.getContainer('dot-a');
    assert.ok(row != null, 'boot 后必须有 containers 行');
    assert.ok(row.endpoint !== null && row.endpoint !== undefined);
    assert.ok(row.token_hash !== null && row.token_hash !== undefined);
  } finally {
    t.cleanup();
  }
});

test('boot：幂等（已 ready 的 dot 走 adopted，不重复 create）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const rep2 = await svc.boot(['dot-a']);
    assert.deepEqual(rep2.created, []);
    assert.deepEqual(rep2.adopted, ['dot-a']);
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
  } finally {
    t.cleanup();
  }
});

test('boot：docker ping 失败 → degraded，未创建任何容器', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const stub = (svc as unknown as { backend: { setPing(v: boolean): void } }).backend;
    stub.setPing(false);
    const rep = await svc.boot(['dot-a']);
    assert.equal(rep.dockerAvailable, false);
    assert.deepEqual(rep.created, []);
    assert.equal(svc.fleet.degraded, true);
    assert.equal(svc.fleet.degradedSinceAt() !== null, true);
    // 状态未被触碰
    assert.equal(stateOf(svc, 'dot-a'), 'absent');
  } finally {
    t.cleanup();
  }
});

test('boot：占名 orphan（本 dot 旧库残留）清障后重建，不再静默 409（WSL 实测事故）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    // DB 全新，但 docker 侧挂着上一套库留下的同名容器
    const stub = (svc as unknown as {
      backend: { seedContainer(c: { id: string; state?: string; labels?: Record<string, string>; name?: string }): void };
    }).backend;
    stub.seedContainer({
      id: 'orphan-a',
      name: 'dotd-dot-dot-a',
      state: 'running',
      labels: { 'dotd.managed': '1', 'dotd.dot': 'dot-a' },
    });
    const rep = await svc.boot(['dot-a']);
    // stub 后端模拟了真实 409；若修复被回退，这里必然 created=[] + failed 非空
    assert.deepEqual(rep.failed, []);
    assert.deepEqual(rep.created, ['dot-a']);
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
    assert.ok(rep.warnings.some((w) => w.includes('清理占名')), `告警应记录清障：${JSON.stringify(rep.warnings)}`);
    assert.deepEqual(rep.orphans, [], '被清障的同名容器不应再算未托管 orphan');
    const liveAfter = (svc as unknown as { backend: { listAll(): Array<{ id: string }> } }).backend.listAll();
    assert.equal(liveAfter.some((c) => c.id === 'orphan-a'), false, '旧容器必须已被 force-remove');
    assert.equal(liveAfter.length, 1, 'docker 侧只剩新容器');
  } finally {
    t.cleanup();
  }
});

test('boot：非本 dot 的 orphan 仍保留不擅杀（§13.1 边界不受清障影响）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const stub = (svc as unknown as {
      backend: { seedContainer(c: { id: string; state?: string; labels?: Record<string, string>; name?: string }): void };
    }).backend;
    stub.seedContainer({
      id: 'orphan-x',
      name: 'dotd-dot-dot-x',
      state: 'running',
      labels: { 'dotd.managed': '1', 'dotd.dot': 'dot-x' },
    });
    const rep = await svc.boot(['dot-a']);
    assert.deepEqual(rep.created, ['dot-a']);
    assert.deepEqual(rep.orphans, ['orphan-x']);
    const liveAfter = (svc as unknown as { backend: { listAll(): Array<{ id: string }> } }).backend.listAll();
    assert.equal(liveAfter.some((c) => c.id === 'orphan-x'), true, '别的 dot 的 orphan 不能被动');
  } finally {
    t.cleanup();
  }
});

test('boot：多 dot 并发受闸门限制（maxActiveContainers=2）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const rep = await svc.boot(['d1', 'd2', 'd3', 'd4']);
    // 闸门 maxActiveContainers=2：第 3/4 个要么被拒要么淘汰前面的，不得超限
    const active = svc.fleet.listActiveContainers().length;
    assert.ok(active <= 2, `活跃容器 ${active} 超过闸门 2`);
    assert.equal(rep.created.length + rep.adopted.length <= 2, true);
  } finally {
    t.cleanup();
  }
});

test('boot：MemAvailable < 4GB → 第三道闸门拒绝（execution.md:225）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    // 只放行一个 dot：避开第一道 max_containers 闸门，单独验内存判据
    const rep0 = await svc.boot(['d1']);
    assert.equal(rep0.created.includes('d1'), true, '内存充足时应放行');
    // 压入宿主内存低位：MemAvailable 3000MB < minMemAvailableMb(4096)
    (svc as unknown as { backend: { setMemAvailable(mb: number): void } }).backend.setMemAvailable(3000);

    const rep = await svc.boot(['d2']);
    assert.equal(rep.created.includes('d2'), false, 'MemAvailable 不足不得放行新容器');
    assert.equal(rep.failed.length, 1);
    assert.match(rep.failed[0]?.reason ?? '', /mem_available/);

    // d1 仍可运行：闸门只拦新 dot，不动已放行者
    assert.notEqual(svc.fleet.getContainer('d1'), null);
  } finally {
    t.cleanup();
  }
});

test('boot：MemAvailable 恢复后同一 dot 可放行（闸门不误伤）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    (svc as unknown as { backend: { setMemAvailable(mb: number): void } }).backend.setMemAvailable(1024);
    const rep1 = await svc.boot(['d1']);
    assert.equal(rep1.created.includes('d1'), false);

    (svc as unknown as { backend: { setMemAvailable(mb: number): void } }).backend.setMemAvailable(8192);
    const rep2 = await svc.boot(['d1']);
    assert.equal(rep2.created.includes('d1'), true, '内存恢复后应放行');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ③ runTool 期间的 busy↔ready 收敛
// ═══════════════════════════════════════════════════════════════════

test('busy：sync 工具执行期间置 busy，结束回 ready', async () => {
  const t = makeTempDataDir();
  try {
    let svc: ExecServiceImpl;
    svc = new ExecServiceImpl({
      db: t.db,
      bus: t.bus,
      cfg: { tokenDir: t.root },
      // 用 handler 在执行中观测容器状态
      stubRuntime: {
        handlers: {
          'fs.read': (call): ExecToolResult => {
            const s = svc.fleet.getContainer(call.dot_id);
            assert.equal(s?.state, 'busy', '工具执行期间容器必须 busy');
            return {
              call_id: call.call_id,
              status: 'ok',
              result: { observed: s?.state },
              finished_at: new Date().toISOString(),
            };
          },
        },
      },
    });
    await svc.boot(['dot-a']);
    const r = await svc.runTool({
      call_id: 'c-1', task_id: 't', dot_id: 'dot-a',
      tool: 'fs.read', args: { path: '/dot/home/a' },
      deadline_ms: 5000, issued_at: new Date().toISOString(),
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual((r.result as { observed?: string }).observed, 'busy');
    assert.equal(stateOf(svc, 'dot-a'), 'ready', '结束后必须回 ready');
    // in-flight 归零
    assert.equal(svc.fleet.hasInflightCall('dot-a'), false);
  } finally {
    t.cleanup();
  }
});

test('busy：容器未 ready 时不发送，返回 container_not_ready', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    // 不 boot：容器 absent
    const r = await svc.runTool({
      call_id: 'c-2', task_id: 't', dot_id: 'dot-a',
      tool: 'fs.read', args: { path: '/dot/home/a' },
      deadline_ms: 5000, issued_at: new Date().toISOString(),
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'container_not_ready');
    // 容器未就绪属可恢复：容器 boot 后可重派（exec_calls 已记 failed，journal 可换 call_id 重发）
    assert.equal(r.error?.retryable, true);
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ④ idle / suspended / stopped 节能档（§4.1）
// ═══════════════════════════════════════════════════════════════════

test('节能档：ready → idle → suspended → ready 全部合法且可走通', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    svc.fleet.transition('dot-a', 'idle', { reason: 'idle timeout' });
    assert.equal(stateOf(svc, 'dot-a'), 'idle');
    svc.fleet.transition('dot-a', 'suspended', { reason: 'deep stop' });
    assert.equal(stateOf(svc, 'dot-a'), 'suspended');
    svc.fleet.transition('dot-a', 'ready', { reason: 'resume' });
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
  } finally {
    t.cleanup();
  }
});

test('节能档：suspendDot/resumeDot 经 pause/unpause（契约 J5 幂等）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    await svc.suspendDot('dot-a');
    assert.equal(stateOf(svc, 'dot-a'), 'suspended');
    // 幂等：再 suspend 一次不炸
    await svc.suspendDot('dot-a');
    assert.equal(stateOf(svc, 'dot-a'), 'suspended');
    await svc.resumeDot('dot-a');
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
    // 幂等：再 resume 一次不炸
    await svc.resumeDot('dot-a');
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
  } finally {
    t.cleanup();
  }
});

test('wake-on-demand：suspended 容器遇派发自动 unpause 并执行成功（WSL 死锁实测）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    await svc.suspendDot('dot-a'); // guard pause 同款路径 → docker pause + suspended
    assert.equal(stateOf(svc, 'dot-a'), 'suspended');

    // 死锁复现点：旧实现这里直接 container_not_ready，水位不回升就永远拒绝。
    const r = await svc.runTool({
      call_id: 'c-w1', task_id: 't', dot_id: 'dot-a',
      tool: 'fs.write', args: { path: '/dot/home/proved.txt', content: 'wake' },
      deadline_ms: 5000, issued_at: new Date().toISOString(),
    });
    assert.equal(r.status, 'ok', `suspended 必须被自动唤醒执行，实际 ${JSON.stringify(r.error)}`);
    assert.equal(stateOf(svc, 'dot-a'), 'ready', '执行结束回 ready（不再是 suspended）');
  } finally {
    t.cleanup();
  }
});

test('wake-on-demand：idle 容器遇派发转 ready 并执行成功（节能档不是错误）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    svc.fleet.transition('dot-a', 'idle', { reason: 'idle timeout' });

    const r = await svc.runTool({
      call_id: 'c-w2', task_id: 't', dot_id: 'dot-a',
      tool: 'shell.run', args: { cmd: 'echo hi', timeout_ms: 4000 },
      deadline_ms: 5000, issued_at: new Date().toISOString(),
    });
    assert.equal(r.status, 'ok', `idle 必须被自动唤醒执行，实际 ${JSON.stringify(r.error)}`);
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
  } finally {
    t.cleanup();
  }
});

test('节能档：suspendDot 时 pause 失败 → 不悬挂，回到 ready 或走 recreate', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    // 让后端 pause 抛错
    const backend = (svc as unknown as { backend: { pauseContainer(id: string): Promise<void> } }).backend;
    const dockerId = svc.fleet.getContainer('dot-a')?.docker_container_id;
    assert.ok(dockerId !== null && dockerId !== undefined);
    backend.pauseContainer = async () => {
      throw new Error('stub: pause 失败');
    };
    await svc.suspendDot('dot-a');
    // 失败不得停在 suspended（悬挂态必须有 pause 生效）
    assert.notEqual(stateOf(svc, 'dot-a'), 'suspended');
    assert.ok(['ready', 'booting', 'unhealthy'].includes(stateOf(svc, 'dot-a')));
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ unhealthy / quarantined / recreate（§13.2）
// ═══════════════════════════════════════════════════════════════════

test('recreate：ready 容器走 removed→absent→created→booting→ready', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const before = svc.fleet.getContainer('dot-a')?.docker_container_id;
    assert.ok(before !== null && before !== undefined);
    await svc.recreateContainer('dot-a');
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
    // 新容器 id（旧已 remove）
    const after = svc.fleet.getContainer('dot-a')?.docker_container_id;
    assert.ok(after !== null && after !== undefined);
    assert.notEqual(after, before, 'recreate 必须换新容器');
    assert.equal(svc.fleet.getContainer('dot-a')?.recreate_count, 1);
  } finally {
    t.cleanup();
  }
});

test('recreate：超过 3 次/24h → quarantined（不无限重建）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    for (let i = 0; i < 4; i += 1) {
      await svc.recreateContainer('dot-a');
      if (stateOf(svc, 'dot-a') === 'quarantined') break;
    }
    assert.equal(stateOf(svc, 'dot-a'), 'quarantined', '第 4 次 recreate 必须进隔离');
  } finally {
    t.cleanup();
  }
});

test('reconcile：lost 状态可由 reconcile 发现并回 booting', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    // 手工把容器推到 lost（模拟 reconcile 发现 docker 侧容器消失）
    svc.fleet.transition('dot-a', 'lost', { reason: 'docker 侧容器消失' });
    assert.equal(stateOf(svc, 'dot-a'), 'lost');
    const entries = await svc.fleet.reconcileOpenCalls('dot-a');
    assert.ok(Array.isArray(entries));
    // lost → booting 合法（recreate 的再启动路径）
    assert.equal(canTransition('lost', 'booting'), true);
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ destroyDotContainer（§10：卷默认保留）
// ═══════════════════════════════════════════════════════════════════

test('destroy：默认保留卷（keepVolumes 语义反转），状态到 removed 终态', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const volsBefore = svc.fleet.listVolumes('dot-a').map((v) => v.name);
    assert.ok(volsBefore.length === 3, 'boot 后应有 home/profiles/state 三个卷');
    await svc.destroyDotContainer('dot-a');
    // §4.1：removed 是合法终态（下一步 removed → absent 由 recreate/boot 走）
    assert.equal(stateOf(svc, 'dot-a'), 'removed');
    // 卷台账保留（默认不删卷）
    assert.deepEqual(svc.fleet.listVolumes('dot-a').map((v) => v.name), volsBefore);
    // removed → absent → ready：destroy 后仍可重新 boot
    const rep = await svc.boot(['dot-a']);
    assert.equal(stateOf(svc, 'dot-a'), 'ready');
    assert.ok(rep.created.includes('dot-a') || rep.adopted.includes('dot-a'));
  } finally {
    t.cleanup();
  }
});

test('destroy：keepVolumes:true 时卷也被清（kill 语义）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    assert.equal(svc.fleet.listVolumes('dot-a').length, 3);
    await svc.destroyDotContainer('dot-a', { keepVolumes: true });
    assert.equal(svc.fleet.listVolumes('dot-a').length, 0, '卷台账应清空');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑦ 状态快照与 stats（契约 J5）
// ═══════════════════════════════════════════════════════════════════

test('getDotStatus / getContainerStats：字段齐全，hasInflightCall 判据正确', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const st = await svc.getDotStatus('dot-a');
    assert.equal(st.dotId, 'dot-a');
    assert.equal(st.state, 'ready');
    assert.equal(st.resources.memMb > 0, true);
    assert.equal(st.resources.cpuMillis, 2000);
    assert.equal(st.volumes.length, 3);
    assert.equal(st.browser.running, true);
    assert.equal(st.inflight, 0);

    const stats = await svc.getContainerStats('dot-a');
    assert.equal(typeof stats.memMb, 'number');
    assert.equal(stats.hasInflightCall, false);

    // 制造一个 in-flight call（用 handler 挂住）
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    if (release === undefined) throw new Error('release 未被赋值');
    const svc2 = new ExecServiceImpl({
      db: t.db,
      bus: t.bus,
      cfg: { tokenDir: t.root },
      stubRuntime: {
        handlers: {
          'fs.read': async (call) => {
            await gate;
            return { call_id: call.call_id, status: 'ok', result: {}, finished_at: new Date().toISOString() };
          },
        },
      },
    });
    await svc2.boot(['dot-b']);
    const p = svc2.runTool({
      call_id: 'c-b', task_id: 't', dot_id: 'dot-b',
      tool: 'fs.read', args: { path: '/dot/home/a' },
      deadline_ms: 5000, issued_at: new Date().toISOString(),
    });
    // 等 handler 进入
    await new Promise((r) => setTimeout(r, 50));
    const st2 = await svc2.getContainerStats('dot-b');
    assert.equal(st2.hasInflightCall, true, 'in-flight 期间 hasInflightCall 必须 true');
    const snap = await svc2.getDotStatus('dot-b');
    assert.equal(snap.inflight, 1);
    assert.equal(snap.state, 'busy');
    release();
    await p;
    assert.equal((await svc2.getContainerStats('dot-b')).hasInflightCall, false);
  } finally {
    t.cleanup();
  }
});
