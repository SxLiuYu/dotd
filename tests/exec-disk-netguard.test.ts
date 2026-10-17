/**
 * tests/exec-disk-netguard.test.ts —— DiskGardener 与 HostNetGuard（EX §8 / §2.1-2，契约 S6）。
 *
 * 全部跑在 DOTD_FLEET=stub 的内存假实现上（CONVENTIONS.md §7）：
 *  - DiskGardener：df free 水位、exec_disk_policy 覆盖、profile 缓存清理让路、超配额告警事件；
 *  - HostNetGuard：白名单端口规则构造顺序、deriveSubnet、stub 下不起 iptables 子进程。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import { makeTempDataDir } from './helpers.ts';
import type { EventBus } from '../src/shared/bus.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { deriveSubnet } from '../src/exec/netguard.ts';
import type { NetRule } from '../src/exec/netguard.ts';
import type { ExecVolumeRow } from '../src/exec/types.ts';

/** stub 后端的测试专用句柄（不进 ContainerBackend 接口）。 */
interface StubHandle {
  seedVolume(name: string, usageMb: number): void;
  setDiskFree(mb: number): void;
  setMemAvailable(mb: number): void;
  listVolumeNames(): Promise<string[]>;
  dropVolume(name: string): void;
}

function stubOf(svc: ExecServiceImpl): StubHandle {
  return (svc as unknown as { backend: StubHandle }).backend;
}

/** 从 db 直接读卷台账（绕过 service，验证落库）。deps 为 private，测试经断言取用。 */
function dbOf(svc: ExecServiceImpl): DatabaseSync {
  return (svc as unknown as { deps: { db: DatabaseSync } }).deps.db;
}

function volumesOf(svc: ExecServiceImpl, dotId: string): ExecVolumeRow[] {
  return (
    dbOf(svc).prepare('SELECT * FROM exec_volumes WHERE dot_id = ? ORDER BY name').all(dotId) as unknown as ExecVolumeRow[]
  );
}

/** 记录某主题的所有事件 payload。 */
function recorder(svc: ExecServiceImpl, topic: string): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  (svc as unknown as { deps: { bus: EventBus } }).deps.bus.on(topic, (e) => {
    seen.push((e as { payload: Record<string, unknown> }).payload);
  });
  return seen;
}

// ═══════════════════════════════════════════════════════════════════
// ① DiskGardener：水位与不动作路径（EX §8）
// ═══════════════════════════════════════════════════════════════════

test('disk：水位充足（64GB）时 runOnce 不回收、不发事件', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    stubOf(svc).seedVolume('dot-dot-a-home', 10);

    const pressure = recorder(svc, 'exec.disk.pressure');
    const gardened = recorder(svc, 'exec.disk.gardened');

    const rep = await svc.disk.runOnce();
    assert.equal(rep.freedMb, 0);
    assert.deepEqual(rep.steps, []);
    assert.deepEqual(rep.alerts, []);
    assert.equal(pressure.length, 0);
    assert.equal(gardened.length, 0);
  } finally {
    t.cleanup();
  }
});

test('disk：free < 5GB 触发 prune dangling 镜像并发 exec.disk.gardened', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const gardened = recorder(svc, 'exec.disk.gardened');

    stubOf(svc).setDiskFree(3000); // < disk_free_min_mb(5120)，>= critical(2048)
    const rep = await svc.disk.runOnce();

    assert.deepEqual(rep.steps, ['image_prune_dangling', 'builder_prune:0']);
    assert.equal(gardened.length, 1, '必须发 exec.disk.gardened');
    assert.equal(gardened[0]?.['freedMb'], 0);
    // 非 critical 水位：不产生 quota 告警
    assert.deepEqual(rep.alerts, []);
  } finally {
    t.cleanup();
  }
});

test('disk：exec_disk_policy 覆盖 disk_free_min_mb 后按新阈值动作', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    svc.disk.setPolicy('disk_free_min_mb', 102400); // 64GB 阈值 > stub 默认 64GB free
    const rep = await svc.disk.runOnce();
    assert.deepEqual(rep.steps, ['image_prune_dangling', 'builder_prune:0'], '覆盖后应触发系统级回收');

    // 阈值调回低于实际 free：不再动作
    svc.disk.setPolicy('disk_free_min_mb', 100);
    const rep2 = await svc.disk.runOnce();
    assert.deepEqual(rep2.steps, []);
    assert.equal(svc.disk.policy('disk_free_min_mb'), 100);
  } finally {
    t.cleanup();
  }
});

test('disk：卷用量采集落库 exec_volumes.usage_mb', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const vols = volumesOf(svc, 'dot-a');
    for (const v of vols) {
      // stub 建卷时 docker 侧用量即为 0（命名卷自动创建）→ 采集后先落 0
      assert.equal(v.usage_mb, 0, '建卷即已知用量 0');
      stubOf(svc).seedVolume(v.name, 128);
    }

    await svc.disk.refreshVolumeUsage();
    for (const v of volumesOf(svc, 'dot-a')) {
      assert.equal(v.usage_mb, 128);
    }
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ② DiskGardener：配额告警与 profile 缓存清理（EX §8 / S6）
// ═══════════════════════════════════════════════════════════════════

test('disk：home 卷达到配额 → exec.disk.pressure（critical=false，不自动删）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const vols = volumesOf(svc, 'dot-a');
    const home = vols.find((v) => v.kind === 'home');
    assert.ok(home !== undefined);
    stubOf(svc).seedVolume(home.name, home.quota_mb); // 恰好达配额

    const pressure = recorder(svc, 'exec.disk.pressure');
    await svc.disk.runOnce(); // 水位充足：只做用量刷新 + 配额告警

    assert.equal(pressure.length, 1);
    assert.equal(pressure[0]?.['volume'], home.name);
    assert.equal(pressure[0]?.['usedMb'], home.quota_mb);
    assert.equal(pressure[0]?.['critical'], false, '§8：超配额只是告警，不是 critical');
    // 卷仍在册（不自动删）
    assert.equal(volumesOf(svc, 'dot-a').some((v) => v.name === home.name), true);
  } finally {
    t.cleanup();
  }
});

test('disk：free < 2GB 且卷满配额 → critical 告警 + 卷仍保留', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const profiles = volumesOf(svc, 'dot-a').find((v) => v.kind === 'profiles');
    assert.ok(profiles !== undefined);
    stubOf(svc).seedVolume(profiles.name, profiles.quota_mb + 10);

    stubOf(svc).setDiskFree(1024); // < disk_critical_free_mb(2048)
    const pressure = recorder(svc, 'exec.disk.pressure');
    const rep = await svc.disk.runOnce();

    assert.equal(rep.alerts.length, 1);
    assert.equal(rep.alerts[0]?.critical, true);
    const critical = pressure.filter((p) => p['critical'] === true);
    assert.equal(critical.length, 1, 'S6：critical 必须发出');
    assert.equal(critical[0]?.['volume'], profiles.name);
    assert.equal(volumesOf(svc, 'dot-a').some((v) => v.name === profiles.name), true, '告警不等于删除');
  } finally {
    t.cleanup();
  }
});

test('disk：profile 卷用量 ≥ 80% 配额 → 清缓存并计入 freedMb', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const profiles = volumesOf(svc, 'dot-a').find((v) => v.kind === 'profiles');
    assert.ok(profiles !== undefined);
    // 容器侧 /dot/profiles 下放两个条目 → 宿主侧清理近似 freed = 条目数
    const runtime = (svc as unknown as {
      runtime: { fsOps(ep: string, tk: string, req: Record<string, unknown>): Promise<unknown> };
    }).runtime;
    assert.ok(runtime !== null, 'stub 下 runtime 必须已装配');
    const origFsOps = runtime.fsOps.bind(runtime);
    runtime.fsOps = async (_ep: string, _tk: string, req: Record<string, unknown>) => {
      if (req['path'] === '/dot/profiles' && req['op'] === 'list') {
        return { op: 'list', ok: true, entries: [{ name: 'default', type: 'file', size: 1 }] };
      }
      return await origFsOps(_ep, _tk, req as never);
    };

    stubOf(svc).seedVolume(profiles.name, Math.ceil(profiles.quota_mb * 0.9));
    stubOf(svc).setDiskFree(3000); // 进入系统级回收分支

    const rep = await svc.disk.runOnce();
    assert.equal(rep.freedMb, 1);
    assert.deepEqual(rep.steps, ['image_prune_dangling', 'builder_prune:0', 'profile_cache_clean:dot-a:1']);
  } finally {
    t.cleanup();
  }
});

test('disk：busy 容器让路——profile 缓存清理跳过并记 skippedBusy', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const profiles = volumesOf(svc, 'dot-a').find((v) => v.kind === 'profiles');
    assert.ok(profiles !== undefined);
    stubOf(svc).seedVolume(profiles.name, Math.ceil(profiles.quota_mb * 0.95));
    stubOf(svc).setDiskFree(3000);

    // hasInflightCall 判据 = exec_calls.state IN ('sent','running')（fleet.ts:987-993）
    // 直接写一条 in-flight 行模拟"调用进行中"，不用永不 resolve 的 handler（会让进程挂起）
    dbOf(svc)
      .prepare(
        `INSERT INTO exec_calls (call_id, dot_id, task_id, tool, mode, args_hash, state, sent_at)
         VALUES (?, ?, ?, ?, 'async', 'h', 'sent', ?)`,
      )
      .run('busy-1', 'dot-a', 't-1', 'fs.read', new Date().toISOString());

    const rep = await svc.disk.runOnce();
    assert.deepEqual(rep.skippedBusy, ['dot-a']);
    assert.equal(rep.steps.includes('profile_cache_clean:dot-a:1'), false, 'busy 容器不得清缓存');
    assert.equal(rep.freedMb, 0);
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ③ HostNetGuard：规则构造（§2.1-2）
// ═══════════════════════════════════════════════════════════════════

test('netguard：白名单端口规则在 DROP 之前；末尾允许外网', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.netguard.setEgressWhitelist([11434, 8080]);
    assert.deepEqual(svc.netguard.getEgressWhitelist(), [11434, 8080]);

    const rep = await svc.netguard.install('172.18.0.1');
    assert.equal(rep.applied, false, 'stub 模式不起 iptables');
    assert.equal(rep.gateway, '172.18.0.1');
    assert.equal(rep.subnet, '172.18.0.0/16');

    assert.equal(rep.rules.length, 4);
    const first = rep.rules[0] as NetRule;
    assert.equal(first.target, 'ACCEPT');
    assert.deepEqual(first.spec.dports, [11434, 8080]);
    assert.equal(first.spec.proto, 'tcp');
    assert.equal(first.spec.dest, '172.18.0.1');
    // 顺序：ACCEPT 白名单 → DROP 网关 → DROP loopback → ACCEPT 外网
    assert.equal(rep.rules[1]?.target, 'DROP');
    assert.equal(rep.rules[1]?.spec.dest, '172.18.0.1');
    assert.equal(rep.rules[2]?.target, 'DROP');
    assert.equal(rep.rules[2]?.spec.dest, '127.0.0.0/8');
    assert.equal(rep.rules[3]?.target, 'ACCEPT');
    assert.equal(rep.rules[3]?.spec.dest, '0.0.0.0/0');
    for (const r of rep.rules) assert.equal(r.chain, 'DOTD-OUT');
    assert.deepEqual(svc.netguard.lastInstall()?.rules, rep.rules);
  } finally {
    t.cleanup();
  }
});

test('netguard：白名单为空 → 只保留三条默认规则', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const rep = await svc.netguard.install();
    assert.equal(rep.rules.length, 3);
    assert.equal(rep.rules.every((r) => r.spec.dports === undefined), true);
    // 端口过滤：非法/越界端口被丢弃
    await svc.netguard.setEgressWhitelist([0, -1, 70000, 1.5, 443]);
    assert.deepEqual(svc.netguard.getEgressWhitelist(), [443]);
    const rep2 = await svc.netguard.install();
    assert.deepEqual(rep2.rules[0]?.spec.dports, [443]);
  } finally {
    t.cleanup();
  }
});

test('netguard：经 ExecService.setEgressWhitelist 下发并重装', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.setEgressWhitelist([11434]);
    const last = svc.netguard.lastInstall();
    assert.ok(last !== null);
    assert.deepEqual(last.rules[0]?.spec.dports, [11434]);
    assert.equal(last.applied, false);
  } finally {
    t.cleanup();
  }
});

test('netguard：deriveSubnet 由网关推导 /16 网段', () => {
  assert.equal(deriveSubnet('172.18.0.1'), '172.18.0.0/16');
  assert.equal(deriveSubnet('172.17.0.5'), '172.17.0.0/16');
  assert.equal(deriveSubnet('10.0.0.1'), '10.0.0.0/16');
  assert.equal(deriveSubnet('bad'), '172.18.0.0/16');
});

test('netguard：boot 流程安装 netguard（真实路径不起子进程）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const rep = await svc.boot(['dot-a']);
    assert.equal(rep.dockerAvailable, true);
    const last = svc.netguard.lastInstall();
    assert.ok(last !== null, 'boot 第 3 步应安装 netguard');
    assert.equal(last.applied, false);
    assert.equal(last.gateway, '172.18.0.1', '网关来自 stub 网络信息');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ④ §8 步骤②：builder prune + 无主卷回收（execution.md:404）
// ═══════════════════════════════════════════════════════════════════

test('disk：步骤② builder prune 计入 steps 与 freedMb（execution.md:404）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    // 进入低水位分支（free 3000 < disk_free_min_mb 5120，>= critical 2048）
    stubOf(svc).setDiskFree(3000);
    // stub 的 builderPrune 恒 0：步骤必须出现（证明走到了 §8 步骤②），freedMb 为 0
    const rep = await svc.disk.runOnce();
    assert.equal(rep.steps.includes('builder_prune:0'), true, '§8 步骤②必须执行 builder prune');
    assert.equal(rep.steps[0], 'image_prune_dangling', '步骤①在步骤②之前');
  } finally {
    t.cleanup();
  }
});

test('disk：无主卷（宿主有卷但 exec_volumes 未登记）被 removeVolume 回收', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const stub = stubOf(svc);
    // 已登记卷：不得被当无主卷删
    const registered = volumesOf(svc, 'dot-a')[0];
    assert.ok(registered !== undefined);
    // 无主卷：宿主上有、exec_volumes 里没有
    stub.seedVolume('dot-orphan-home', 777);
    stubOf(svc).setDiskFree(3000); // 低水位才走步骤②

    const rep = await svc.disk.runOnce();
    assert.deepEqual(
      rep.steps.filter((s) => s.startsWith('volume_prune_unregistered:')),
      ['volume_prune_unregistered:dot-orphan-home:777'],
    );
    // 无主卷已从宿主删除；已登记卷仍在
    const names = await stub.listVolumeNames();
    assert.deepEqual(names.includes('dot-orphan-home'), false);
    assert.deepEqual(names.includes(registered.name), true);
    // 台账未被误改（只删宿主侧，不动 exec_volumes 行）
    assert.equal(volumesOf(svc, 'dot-a').length >= 1, true);
  } finally {
    t.cleanup();
  }
});

test('disk：已登记卷不会被当作无主卷回收', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const stub = stubOf(svc);
    const before = (await stub.listVolumeNames()).sort();
    stub.seedVolume(before[0] ?? 'x', 42); // 重新 seed 已登记卷，改用量
    stubOf(svc).setDiskFree(3000);

    const rep = await svc.disk.runOnce();
    assert.equal(
      rep.steps.some((s) => s.startsWith('volume_prune_unregistered:')),
      false,
      'exec_volumes 白名单内的卷不得删',
    );
    assert.deepEqual((await stub.listVolumeNames()).sort(), before);
  } finally {
    t.cleanup();
  }
});
