/**
 * tests/router-difficulty.test.ts —— 难度判别分流（迁移自 PilotDeck 的 difficulty judge）。
 *
 * 迁移来源：PilotDeck（AGPL-3.0）"Smart Routing" 的四级难度判定。移植的是
 * **设计与保守判据**，不是代码。
 *
 * dotd 的语境决定了它必须比 PilotDeck 保守得多：那里的双轨是"贵/便宜"，
 * 这里的双轨是**"能不能调工具"**——light 轨的本地端点（Colibrì OLMoE）实测
 * 无工具调用能力（记忆 `olmoe-tier2-live-state`），而主循环每一步都带 `tools`。
 * 判错一次的代价不是多花钱，是任务步骤拿不到工具、整个任务跑偏。
 *
 * 因此本文件的测试几乎都在守三条硬性质：
 *   1. **带 tools / tool_choice='required' → 永远 complex → 永远 primary**，
 *      无论内容多短、无论配置怎么写（`light_difficulties: [complex]` 也不认）；
 *   2. **moderate 默认留 primary**——dotd 里不带 tools 的长请求（GOV 审长 diff）
 *      有富上下文价值，本地模型的 context 与指令遵循都弱一截；
 *   3. **事件类型优先于请求形状**——命中 light_events 的调用方已显式声明
 *      "这是低智能活"，不该被形状判据拉回 primary。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import { loadModelsConfig } from '../src/router/config.ts';
import {
  DEFAULT_LIGHT_DIFFICULTIES,
  SHORT_CONTENT_CHARS,
  TRIVIAL_CONTENT_CHARS,
  contentLength,
  judgeDifficulty,
  matchesLightEvent,
  resolveTrack,
  trackFor,
  type DifficultyPolicy,
} from '../src/router/difficulty.ts';
import type { ChatMessage, ToolSpec } from '../src/shared/contracts.ts';

let tmp: TempDataDir;
let cfgDir: string;

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

const msg = (content: string): ChatMessage => ({ role: 'user', content });
const tool: ToolSpec = {
  name: 'fs.read',
  description: '读文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

const POLICY: DifficultyPolicy = {
  lightDifficulties: DEFAULT_LIGHT_DIFFICULTIES,
  defaultTrack: 'primary',
};

// ═══════════════════════════════════════════════════════════════════
// 1. 纯函数：四级判据
// ═══════════════════════════════════════════════════════════════════

describe('judgeDifficulty：只认请求形状，不猜任务语义', () => {
  it('带 tools → complex（主循环形状，一步都不让）', () => {
    assert.equal(judgeDifficulty({ tools: [tool], messages: [msg('hi')] }), 'complex');
    assert.equal(judgeDifficulty({ tools: [tool], messages: [msg('x'.repeat(10))] }), 'complex');
  });

  it('tool_choice=required → complex（显式要求工具调用）', () => {
    assert.equal(
      judgeDifficulty({ toolChoice: 'required', messages: [msg('hi')] }),
      'complex',
      'required 比 tools 非空更强——调用方明说要工具',
    );
  });

  it('tool_choice=auto 且无 tools → 按长度分档（auto 不是要求）', () => {
    assert.equal(judgeDifficulty({ toolChoice: 'auto', messages: [msg('hi')] }), 'trivial');
  });

  it('空 tools 数组 = 没带工具（不是"带了但为空"）', () => {
    assert.equal(judgeDifficulty({ tools: [], messages: [msg('hi')] }), 'trivial');
  });

  it('长度分界：trivial ≤200 < simple ≤2000 < moderate', () => {
    assert.equal(
      judgeDifficulty({ messages: [msg('x'.repeat(TRIVIAL_CONTENT_CHARS))] }),
      'trivial',
      '正好在 trivial 上界',
    );
    assert.equal(
      judgeDifficulty({ messages: [msg('x'.repeat(TRIVIAL_CONTENT_CHARS + 1))] }),
      'simple',
      '过一格就升档',
    );
    assert.equal(judgeDifficulty({ messages: [msg('x'.repeat(SHORT_CONTENT_CHARS))] }), 'simple');
    assert.equal(
      judgeDifficulty({ messages: [msg('x'.repeat(SHORT_CONTENT_CHARS + 1))] }),
      'moderate',
      '超过 short 上界 → moderate（默认仍留 primary）',
    );
  });

  it('多轮消息的长度累加（system 的长提示词会把档位推高）', () => {
    const long = 'x'.repeat(TRIVIAL_CONTENT_CHARS);
    assert.equal(judgeDifficulty({ messages: [msg(long)] }), 'trivial', '单条正好在 trivial 上界');
    assert.equal(
      judgeDifficulty({ messages: [msg(long), msg('再十个字')] }),
      'simple',
      '累加 10 个字符就过界',
    );
  });

  it('contentLength 只数字符串内容', () => {
    assert.equal(contentLength([msg('abc'), { role: 'tool', content: 'de', tool_call_id: 't1' }]), 5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. resolveTrack：complex 永不被下放（本迁移最重要的一条）
// ═══════════════════════════════════════════════════════════════════

describe('resolveTrack：complex 硬挡，配置写错也不放行', () => {
  it('默认策略：trivial/simple → light，moderate → primary', () => {
    assert.equal(resolveTrack('trivial', POLICY), 'light');
    assert.equal(resolveTrack('simple', POLICY), 'light');
    assert.equal(resolveTrack('moderate', POLICY), 'primary', '长文本审查有富上下文价值');
  });

  it('complex → primary，即使配置把 complex 列进 light_difficulties', () => {
    const bad: DifficultyPolicy = {
      lightDifficulties: ['complex', 'trivial'],
      defaultTrack: 'primary',
    };
    assert.equal(
      resolveTrack('complex', bad),
      'primary',
      'light 轨端点没有工具能力，静默照做会让主循环每步空手干活',
    );
    // 其余档仍按配置走（挡的是 complex 一条，不是整个策略作废）
    assert.equal(resolveTrack('trivial', bad), 'light');
  });

  it('default_track=light 时 moderate 也落 light（主人显式授权）', () => {
    const policy: DifficultyPolicy = { lightDifficulties: ['moderate'], defaultTrack: 'light' };
    assert.equal(resolveTrack('moderate', policy), 'light');
  });

  it('空 light_difficulties → 什么都不降级', () => {
    const policy: DifficultyPolicy = { lightDifficulties: [], defaultTrack: 'primary' };
    assert.equal(resolveTrack('trivial', policy), 'primary');
    assert.equal(resolveTrack('simple', policy), 'primary');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. trackFor：事件类型优先于请求形状
// ═══════════════════════════════════════════════════════════════════

describe('trackFor：事件类型优先', () => {
  const lightEvents = ['event.classify', 'memory.summarize'];

  it('命中 light_events → light，哪怕请求带 tools', () => {
    assert.equal(
      trackFor('event.classify', { tools: [tool], messages: [msg('hi')] }, lightEvents, POLICY),
      'light',
      '调用方显式声明"这是低智能活"，优先于形状判据',
    );
  });

  it('子事件同样命中（前缀匹配）', () => {
    assert.equal(trackFor('memory.summarize.thread', { messages: [] }, lightEvents, POLICY), 'light');
  });

  it('未命中 → 走形状判据', () => {
    assert.equal(
      trackFor('task.run', { tools: [tool], messages: [msg('hi')] }, lightEvents, POLICY),
      'primary',
      '主循环事件 + 带 tools → primary',
    );
    assert.equal(trackFor('task.run', { messages: [msg('hi')] }, lightEvents, POLICY), 'light');
  });

  it('eventType 缺省 = 纯形状判据', () => {
    assert.equal(trackFor(undefined, { messages: [msg('hi')] }, lightEvents, POLICY), 'light');
  });
});

describe('matchesLightEvent：与 ModelRouter.trackForEvent 同款判据', () => {
  it('全等 / 点号子级 / 裸前缀三种都算命中', () => {
    const ps = ['event.classify', 'digest'];
    assert.equal(matchesLightEvent('event.classify', ps), true);
    assert.equal(matchesLightEvent('event.classify.child', ps), true);
    assert.equal(matchesLightEvent('digest.daily', ps), true);
  });

  it('不相关的前缀不误伤（classif 不是 classify）', () => {
    assert.equal(matchesLightEvent('event.classif', ['event.classify']), false);
  });

  it('空前缀表 → 恒 false', () => {
    assert.equal(matchesLightEvent('anything', []), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 配置解析：routing.light_difficulties
// ═══════════════════════════════════════════════════════════════════

describe('配置：routing.light_difficulties', () => {
  function writeConfig(routingExtra: string): string {
    const p = join(cfgDir, 'models.yml');
    writeFileSync(
      p,
      `version: 1
endpoints:
  - id: e1
    base_url: https://x.example/v1
    models: { primary: m, light: m2 }
routing:
  default_track: primary
${routingExtra}
alerts:
  channel_order: [outbox]
`,
      'utf8',
    );
    return p;
  }

  it('缺省 = [trivial, simple]', () => {
    const cfg = loadModelsConfig(writeConfig(''));
    assert.deepEqual(cfg.routing.light_difficulties, ['trivial', 'simple']);
  });

  it('行内数组可覆盖', () => {
    const cfg = loadModelsConfig(writeConfig('  light_difficulties: [moderate]'));
    assert.deepEqual(cfg.routing.light_difficulties, ['moderate']);
  });

  it('空数组 = 关掉难度降级（显式清空）', () => {
    const cfg = loadModelsConfig(writeConfig('  light_difficulties: []'));
    assert.deepEqual(cfg.routing.light_difficulties, []);
  });

  it('与 light_events 并存，互不干扰', () => {
    const cfg = loadModelsConfig(
      writeConfig(`  light_events: [event.classify]
  light_difficulties: [trivial]`),
    );
    assert.deepEqual(cfg.routing.light_events, ['event.classify']);
    assert.deepEqual(cfg.routing.light_difficulties, ['trivial']);
  });

  it('非法值原样收下（过滤在 ModelRouter.difficultyPolicy，不在解析层）', () => {
    const cfg = loadModelsConfig(writeConfig('  light_difficulties: [complex, bogus, simple]'));
    assert.deepEqual(cfg.routing.light_difficulties, ['complex', 'bogus', 'simple']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. ModelRouter 集成
// ═══════════════════════════════════════════════════════════════════

describe('ModelRouter.trackForRequest / difficultyPolicy 过滤', () => {
  function writeRouterConfig(routingExtra: string): void {
    writeFileSync(
      join(cfgDir, 'models.yml'),
      `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://x.example/v1
    api_key_env: KEY
    models: { primary: m, light: m2 }
    style: openai
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }
routing:
  default_track: primary
${routingExtra}
alerts:
  channel_order: [outbox]
  outbox_path: ${join(tmp.root, 'OUTBOX.md').replace(/\\/g, '/')}
  channel_timeout_ms: 10000
  dedup_window_ms: 86400000
recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources:
    - type: openrouter_models
      filter: ":free"
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3
`,
      'utf8',
    );
    writeFileSync(join(cfgDir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
  }

  function makeRouter(routingExtra = ''): ModelRouter {
    writeRouterConfig(routingExtra);
    return ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: undefined as unknown as never, // 本文件只测 track 判据，不发请求
    });
  }

  it('主循环形状（带 tools）→ primary，永不降级', () => {
    const r = makeRouter();
    assert.equal(r.trackForRequest({ tools: [tool], messages: [msg('hi')] }), 'primary');
    r.dispose();
  });

  it('GOV/CP 形状（不带 tools、短内容）→ light', () => {
    const r = makeRouter();
    assert.equal(r.trackForRequest({ messages: [msg('审查这段 diff')] }), 'light');
    r.dispose();
  });

  it('配置写 complex 也被挡住（difficultyPolicy 过滤 + resolveTrack 硬挡双保险）', () => {
    const r = makeRouter('  light_difficulties: [complex, trivial]');
    assert.equal(r.trackForRequest({ messages: [msg('hi')] }), 'light', 'trivial 仍生效');
    assert.equal(r.trackForRequest({ tools: [tool], messages: [msg('hi')] }), 'primary');
    r.dispose();
  });

  it('配置里的非法档位被滤掉，不当成真档位', () => {
    const r = makeRouter('  light_difficulties: [bogus, simple]');
    // "短内容" 只有 3 个字符 → trivial；trivial 不在列表里 → 走 default_track
    assert.equal(r.trackForRequest({ messages: [msg('短内容')] }), 'primary', 'trivial 被 bogus 挤掉后无效');
    assert.equal(
      r.trackForRequest({ messages: [msg('这是一段说明文字'.repeat(40))] }),
      'light',
      'simple 生效（320 字）',
    );
    r.dispose();
  });

  it('trackForEvent 行为不变（事件类型判据，与迁移前逐字等价）', () => {
    const r = makeRouter('  light_events: [event.classify, digest]');
    assert.equal(r.trackForEvent('event.classify'), 'light');
    assert.equal(r.trackForEvent('memory.summarize.child'), 'primary');
    assert.equal(r.trackForEvent('digest.daily'), 'light');
    r.dispose();
  });
});
