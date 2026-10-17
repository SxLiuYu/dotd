/**
 * tests/exec-network-converge.test.ts —— ensureNetwork 状态收敛（§2.1，HIGH 遗留修复）。
 *
 * 旧实现缺陷：inspectNetwork 成功即 early-return，从不校验 Options——
 * 同名但不合规的网络（手工 `docker network create dotd` 建的默认 ICC 版本）
 * 会让 enable_icc=false 隔离承诺静默失效。
 * 本文件对纯函数 convergeNetwork 用假 client 覆盖三条收敛路径 + 挂靠拒绝路径。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convergeNetwork } from '../src/exec/fleet.ts';

interface FakeNet {
  Driver: string;
  Options: Record<string, string>;
}

function fakeClient(state: { net: FakeNet | null; attached: number }) {
  const calls: string[] = [];
  const client = {
    calls,
    async inspectNetwork(_name: string): Promise<unknown> {
      calls.push('inspect');
      if (state.net === null) throw new Error('404 not found');
      return state.net;
    },
    async createNetwork(opts: unknown): Promise<unknown> {
      calls.push('create');
      const o = opts as { Name: string; Driver: string; Options: Record<string, string> };
      state.net = { Driver: o.Driver, Options: { ...o.Options } };
      return { name: o.Name };
    },
    async removeNetwork(_name: string): Promise<unknown> {
      calls.push('remove');
      // docker 语义：有容器挂靠 → 403 Conflict，网络保留
      if (state.attached > 0) throw new Error('403 Conflict: network has active endpoints');
      state.net = null;
      return {};
    },
  };
  return client;
}

const REQ = { Driver: 'bridge', Options: { 'com.docker.network.bridge.enable_icc': 'false' } };

test('convergeNetwork：网络不存在 → 直接创建，返回 created', async () => {
  const state = { net: null as FakeNet | null, attached: 0 };
  const c = fakeClient(state);
  const r = await convergeNetwork(c, 'dotd', REQ);
  assert.equal(r, 'created');
  assert.deepEqual(c.calls, ['inspect', 'create']);
  assert.deepEqual(state.net, { Driver: 'bridge', Options: { 'com.docker.network.bridge.enable_icc': 'false' } });
});

test('convergeNetwork：已存在且配置相符 → unchanged，不动它（幂等，网关不漂移）', async () => {
  const state = {
    net: { Driver: 'bridge', Options: { 'com.docker.network.bridge.enable_icc': 'false', 'user.tag': 'keep' } } as FakeNet | null,
    attached: 3,
  };
  const c = fakeClient(state);
  const r = await convergeNetwork(c, 'dotd', REQ);
  assert.equal(r, 'unchanged', '必需项满足即合规；额外 Options 不算漂移');
  assert.deepEqual(c.calls, ['inspect']);
});

test('convergeNetwork：同名但不合规（手工建的默认 ICC 网络）→ 移除重建，返回 converged', async () => {
  const state = {
    net: { Driver: 'bridge', Options: {} } as FakeNet | null, // 缺 enable_icc=false
    attached: 0,
  };
  const c = fakeClient(state);
  const r = await convergeNetwork(c, 'dotd', REQ);
  assert.equal(r, 'converged');
  assert.deepEqual(c.calls, ['inspect', 'remove', 'create']);
  assert.deepEqual(state.net, REQ);
});

test('convergeNetwork：Driver 不符（overlay）同样收敛', async () => {
  const state = {
    net: { Driver: 'overlay', Options: { 'com.docker.network.bridge.enable_icc': 'false' } } as FakeNet | null,
    attached: 0,
  };
  const r = await convergeNetwork(fakeClient(state), 'dotd', REQ);
  assert.equal(r, 'converged');
});

test('convergeNetwork：有容器挂靠时 remove 被拒 → 抛出，绝不静默放行不合规网络', async () => {
  const state = {
    net: { Driver: 'bridge', Options: {} } as FakeNet | null,
    attached: 2, // 网络上有活跃 endpoint
  };
  const c = fakeClient(state);
  await assert.rejects(() => convergeNetwork(c, 'dotd', REQ), /Conflict/);
  assert.deepEqual(c.calls, ['inspect', 'remove']);
  assert.ok(state.net !== null, 'remove 失败时 docker 保留原网络——错误必须上抛让 boot 记 warning/degraded');
});

test('convergeNetwork：后端不支持 remove 时不假装收敛，报错上抛', async () => {
  const state = { net: { Driver: 'bridge', Options: {} } as FakeNet | null, attached: 0 };
  const c = fakeClient(state);
  delete (c as { removeNetwork?: unknown }).removeNetwork;
  await assert.rejects(() => convergeNetwork(c, 'dotd', REQ), /不支持 remove/);
});
