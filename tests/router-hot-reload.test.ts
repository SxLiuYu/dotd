/**
 * tests/router-hot-reload.test.ts —— models.yml 改了要真的生效（2026-10-25）。
 *
 * 背景：`reloadConfig()` 一直只有测试在调；`reload_debounce_ms` 是死配置项，
 * 而注释/文档写着"改一行配置热切换"。实际行为是"保存了但没生效，必须重启"。
 *
 * 这个测试钉三件事：
 *  ① 文件变化 → 防抖后端点表更新（不是等下一次进程启动）；
 *  ② 文件写坏（半个 YAML）→ **保住旧配置**，进程不崩，并留一条
 *     `config.models_reload_failed` 事件；
 *  ③ dispose 后不再重载（关停过程中保存文件不该触发任何动作）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { StubTransport } from '../src/router/transport.ts';

let tmp: TempDataDir;
let cfgDir: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function modelsYaml(o: { second?: boolean; broken?: boolean } = {}): string {
  const head = `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true
`;
  const second = o.second
    ? `
  - id: cloud-backup
    tier: 1
    base_url: https://backup.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-z, light: vendor/model-z-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true
`
    : '';
  return head + second;
}

function write(o: { second?: boolean; broken?: boolean } = {}): void {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'models.yml'), o.broken ? 'version: 1\nendpoints: [ { id: ' : modelsYaml(o), 'utf8');
}

function makeRouter(): { router: ModelRouter; bus: TempDataDir['bus'] } {
  const stub = new StubTransport({ script: [], local: {} });
  const router = ModelRouter.load({
    db: tmp.db,
    configDir: cfgDir,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport: stub,
  });
  return { router, bus: tmp.bus };
}

/** 轮询等待条件成立（防抖 1500ms + fs.watch 延迟，给到 6s）。 */
async function waitFor(pred: () => boolean, ms = 6_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

beforeEach(() => {
  tmp = makeTempDataDir({ pool: true });
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
});
afterEach(() => {
  tmp.cleanup();
});

test('改 models.yml 后端点表在运行期更新（不需要重启）', async () => {
  write();
  const { router } = makeRouter();
  try {
    assert.deepEqual(router.listEndpoints().map((e) => e.id), ['cloud-main']);
    router.startWatching();

    write({ second: true });
    const ok = await waitFor(() => router.listEndpoints().some((e) => e.id === 'cloud-backup'));
    assert.equal(ok, true, `热加载未生效，当前端点：${router.listEndpoints().map((e) => e.id).join(',')}`);
  } finally {
    router.dispose();
  }
});

test('配置写坏 → 保留旧配置、进程不崩、留一条失败事件', async () => {
  write({ second: true });
  const { router, bus } = makeRouter();
  const failed: unknown[] = [];
  const off = bus.on('config.models_reload_failed', (e) => {
    failed.push(e.payload);
  });
  try {
    const before = router.listEndpoints().map((e) => e.id).sort();
    router.startWatching();

    write({ broken: true });
    const got = await waitFor(() => failed.length > 0);
    assert.equal(got, true, '坏配置没有产生 config.models_reload_failed 事件');
    // 旧配置仍在（端点没被清空/改坏）
    assert.deepEqual(router.listEndpoints().map((e) => e.id).sort(), before);
  } finally {
    off();
    router.dispose();
  }
});

test('dispose 后不再重载（关停中保存文件不触发动作）', async () => {
  write();
  const { router } = makeRouter();
  router.startWatching();
  router.dispose();

  write({ second: true });
  await sleep(2_000);
  assert.deepEqual(router.listEndpoints().map((e) => e.id), ['cloud-main'], 'dispose 后不该再重载');
});
