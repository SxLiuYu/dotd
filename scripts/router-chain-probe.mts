/**
 * scripts/router-chain-probe.mts —— 用**真实 config/models.yml** 验证路由降级链。
 *
 * 为什么要有这个脚本：dotd 的 tier1（OpenRouter 免费路由）在本机既会返空壳也会超时，
 * 熔断器早上已被打飞（consec=8 / open）。要回答"tier2 到底接没接上"，不能只靠 807 条
 * 单测里那份手写的最小 models.yml，得拿真配置跑一遍。
 *
 * 做法（不发真实网络请求、不碰真实 ~/.dotd）：
 *   1. loadModelsConfig 读真 config/models.yml，pickCandidates 直接打印两条轨的真实候选序；
 *   2. ModelRouter.load 配 StubTransport，脚本演"tier1 挂、tier2 好"，看 complete 落到哪。
 *
 * 跑法：node --import tsx scripts/router-chain-probe.mts
 * 退出码 0 = 降级链按预期落到 tier2；1 = 链路断在配置层。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsConfig } from '../src/router/config.ts';
import { pickCandidates } from '../src/router/candidates.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { createModelTransport, StubTransport } from '../src/router/transport.ts';
import { EventBus } from '../src/shared/bus.ts';
import { openDb } from '../db/conn.ts';
import { migrate } from '../db/migrate.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const configDir = join(repoRoot, 'config');

// ── 1. 真配置的候选序 ────────────────────────────────────────────────

const cfg = loadModelsConfig(join(configDir, 'models.yml'));
console.log('== 真 config/models.yml 的候选序（NORMAL 档）==');
for (const track of ['primary', 'light'] as const) {
  const chain = pickCandidates(cfg.endpoints, 'NORMAL', track);
  console.log(
    `  ${track}: ` +
      (chain.length === 0
        ? '（空）'
        : chain.map((e) => `${e.id}(tier${e.tier}${e.enabled ? '' : ',disabled'})`).join(' → ')),
  );
}

// ── 2. 降级演练：tier1 挂、tier2 好 ─────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'dotd-chain-'));
const db = openDb(join(root, 'probe.db'));
migrate(db);
const bus = new EventBus();

const transport = new StubTransport({
  script: [
    // tier1 light 挂（模拟 OpenRouter 空壳/超时），primary 也挂
    { endpointId: 'openrouter-main', track: 'light', fail: new Error('模拟 tier1 不可用') },
    { endpointId: 'openrouter-main', track: 'primary', fail: new Error('模拟 tier1 不可用') },
    // tier2 light 好
    { endpointId: 'colibri-olmoe', track: 'light', content: 'olmoe 应答' },
  ],
  // tier2 本地闸门两道在这里是**强制置真**，不是实测：warm_check 的 json_eq 要求
  // /profile 顶层返回 expert_disk_s，而 Colibrì 把它藏在 turns[] 里，所以这道闸门
  // 在真链路里目前是过不去的（见 candidates.ts 的 matchesJsonEq）。
  local: { 'colibri-olmoe': { health: true, warm: true } },
});

const router = ModelRouter.load({
  db,
  configDir,
  scheduler: { registerInternalJob: () => {} },
  channels: null,
  bus,
  transport,
});

let ok = true;

// ── 3. --live：真 transport 打一次 light 轨，看端到端落到谁 ──────────
//
// 与 2a 的区别：2a 是脚本回放，只证明"配置层面的候选序 + 降级分支"；
// 这里发真实请求（tier1 走 OpenRouter，失败则过本地闸门落到 :8001 的 OLMoE）。
// 用临时库，熔断状态不污染真实 ~/.dotd。代价是一次 8-token 的请求。
if (process.argv.includes('--live')) {
  const liveTransport = createModelTransport();
  const liveRouter = ModelRouter.load({
    db,
    configDir,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus,
    transport: liveTransport,
  });
  try {
    const r = await liveRouter.complete({
      track: 'light',
      messages: [{ role: 'user', content: 'ping' }],
      attemptId: 'probe:light-live',
    });
    const text =
      'content' in r.response && typeof r.response.content === 'string'
        ? r.response.content.slice(0, 40)
        : '(流式)';
    console.log(
      `== light 轨真请求：落到 ${r.meta.endpointId}（tier${r.meta.tier} / ${r.meta.model}）应答「${text}」==`,
    );
    console.log(`   tried: ${r.meta.tried.map((t) => `${t.endpointId}:${t.outcome}`).join(' → ')}`);
  } catch (err) {
    const tried = (err as { tried?: readonly string[] }).tried;
    console.log(`== light 轨真请求：抛错 ${(err as Error).name}: ${(err as Error).message} ==`);
    if (tried !== undefined) console.log(`   tried: ${tried.join(' → ')}`);
    ok = false;
  }
  db.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

// 2a. light 轨：tier1 挂 → 应落到 tier2 的 colibri-olmoe
try {
  const r = await router.complete({
    track: 'light',
    messages: [{ role: 'user', content: 'ping' }],
    attemptId: 'probe:light',
  });
  const served = r.meta.endpointId;
  console.log(`== light 轨降级演练：落到 ${served}（tier${r.meta.tier} / ${r.meta.model}）==`);
  console.log(`   tried: ${r.meta.tried.map((t) => `${t.endpointId}:${t.outcome}`).join(' → ')}`);
  if (served !== 'colibri-olmoe') {
    console.log(`   ✗ 预期落到 colibri-olmoe，实际 ${served}`);
    ok = false;
  }
} catch (err) {
  console.log(`== light 轨降级演练：抛错 ${(err as Error).message} ==`);
  ok = false;
}

// 2b. primary 轨：tier1 挂 → 真实配置里没有任何其它 primary 候选
try {
  const r = await router.complete({
    track: 'primary',
    messages: [{ role: 'user', content: 'ping' }],
    attemptId: 'probe:primary',
  });
  console.log(`== primary 轨降级演练：落到 ${r.meta.endpointId}（tier${r.meta.tier}）==`);
} catch (err) {
  console.log(`== primary 轨降级演练：抛错 ${(err as Error).name}: ${(err as Error).message} ==`);
  console.log('   （真实配置里 primary 只有 openrouter-main 一个候选，熔断即无路可走）');
}

db.close();
rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
