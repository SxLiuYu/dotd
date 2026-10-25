/**
 * tests/router-config.test.ts —— models.yml 真实形状解析回归（MR §2.1）。
 *
 * 背景（审码员反馈的三个实锤问题）：旧 parseModelsYaml 只认行内映射，仓库自带的
 * dotd/config/models.yml 恰好用了续行写法，导致：
 *   1. `models:` 续行（openrouter-main:19-21）被丢弃 → models={} →
 *      validateModelsConfig 抛「未声明任何 models」→ daemon 一启动就拒启（阻塞级）；
 *   2. `light_events` 续行列表（:59-66）落到死代码分支 → 恒为 [] →
 *      trackForEvent 对任何事件都走 primary，契约 M7 前缀表失效（阻塞级）；
 *   3. `warm_check.json_eq` 嵌套花括号（colibri-olmoe:43）被 split(',') 切碎 →
 *      二次解析得空对象 → matchesJsonEq 对空 eq 恒真，warm 闸被静默作废（高）。
 * 旧测试 101 例全部用行内形状，故发现不了——本文件用**真实配置文件本身**回归。
 *
 * 2026-10-17 追加回归（全方位测试高危"tier2 双断点"）：
 *   4. warm 判据指向 turns[] 里的 expert_disk_s，旧 matchesJsonEq 只比顶层键 →
 *      宽限期外永远判不 warm，tier2 降级链实际是断的；现在判据写点分路径
 *      `turns.last.expert_disk_s` + json_max 阈值分界（冷 0.47s vs 驻留 0.02s）。
 *   5. tier2 三个 URL 走 `${DOTD_TIER2_HOST:-默认网关}`（WSL 网关 IP 会漂移）。
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { loadModelsConfig, parseModelsYaml } from '../src/router/config.ts';
import { localGate, matchesJsonEq, matchesJsonMax, matchesWarmCheck } from '../src/router/candidates.ts';
import { StubTransport } from '../src/router/transport.ts';

let tmp: TempDataDir;

beforeEach(() => {
  tmp = makeTempDataDir();
});

afterEach(() => {
  tmp.cleanup();
});

/** 仓库真实 models.yml 的绝对路径（由本文件位置推导，不依赖 cwd）。 */
const REAL_MODELS_YML = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'models.yml');

// ═══════════════════════════════════════════════════════════════════
// 1. 真实配置：续行 models 映射（阻塞级回归）
// ═══════════════════════════════════════════════════════════════════

describe('真实 models.yml：续行 models 映射（MR §2.1）', () => {
  it('openrouter-main 的续行 primary/light 被解析出来（旧实现得 {}，daemon 拒启）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const ep = cfg.endpoints.find((e) => e.id === 'openrouter-main');
    assert.ok(ep !== undefined, 'openrouter-main 端点应存在');
    // 本用例测的是"续行 models 映射被解析出非空值"这一解析器契约；
    // 具体模型选型随区域可用性变动（2026-10-16：本 key 仅 :free 可用）。
    assert.ok(typeof ep.models.primary === 'string' && ep.models.primary.length > 0);
    assert.ok(typeof ep.models.light === 'string' && ep.models.light.length > 0);
  });

  it('loadModelsConfig(真实文件) 不抛 ConfigError（整份配置通过启动期校验）', () => {
    // 旧实现在这里抛：端点 openrouter-main 未声明任何 models（primary/light 至少一个）
    assert.doesNotThrow(() => loadModelsConfig(REAL_MODELS_YML));
  });

  it('行内映射形状仍然可用（backup-openai-compatible:30）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const ep = cfg.endpoints.find((e) => e.id === 'backup-openai-compatible');
    assert.ok(ep !== undefined);
    assert.equal(ep.models.primary, 'some/model');
    assert.equal(ep.models.light, 'some/model-mini');
    assert.equal(ep.enabled, false);
  });

  it('续行 timeouts/local 块与行内 local 两种形状都解析（colibri-olmoe vs ollama）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const colibri = cfg.endpoints.find((e) => e.id === 'colibri-olmoe');
    assert.ok(colibri !== undefined);
    assert.equal(colibri.tier, 2);
    // health_url 走 DOTD_TIER2_HOST 环境变量；仓库默认值是**本机**回环地址
    // （2026-10-25 起不再写死 WSL 网关，见 tests/config-no-env-leaks.test.ts）。
    assert.equal(colibri.local?.health_url, 'http://127.0.0.1:18001/health');
    assert.equal(colibri.local?.max_concurrency, 1);
    assert.equal(colibri.local?.queue_reject_ms, 8000);
    assert.equal(colibri.local?.warm_grace_ms, 150000);
    const ollama = cfg.endpoints.find((e) => e.id === 'ollama');
    assert.ok(ollama !== undefined);
    assert.equal(ollama.local?.max_concurrency, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 真实配置：light_events 续行列表（阻塞级回归）
// ═══════════════════════════════════════════════════════════════════

describe('真实 models.yml：light_events 续行列表（MR §2.1）', () => {
  it('七条事件全收全（旧实现得 []，任何事件都走 primary）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    assert.deepEqual(cfg.routing.light_events, [
      'event.classify',
      'event.route',
      'event.match',
      'memory.summarize',
      'heartbeat.triage',
      'queue.dedupe',
      'digest',
    ]);
  });

  it('行内数组形状仍然可用（light_events: [a, b]）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://x.example/v1
    models: { primary: m }
routing:
  default_track: primary
  light_events: [event.classify, memory.summarize]
alerts:
  channel_order: [outbox]
`,
    );
    assert.deepEqual(cfg.routing.light_events, ['event.classify', 'memory.summarize']);
  });

  it('light_events 块结束后同级的 default_track 仍被解析（缩进退出块）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://x.example/v1
    models: { primary: m }
routing:
  light_events:
    - event.classify
  default_track: light
alerts:
  channel_order: [outbox]
`,
    );
    assert.equal(cfg.routing.default_track, 'light');
    assert.deepEqual(cfg.routing.light_events, ['event.classify']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. 真实配置：warm_check 嵌套路径判据（2026-10-17 高危回归）
// ═══════════════════════════════════════════════════════════════════

describe('真实 models.yml：warm_check 嵌套路径判据（MR §2.1）', () => {
  it('colibri-olmoe 判据 = turns.last.expert_disk_s ≤ 0.1（旧实现只比顶层键，恒不 warm）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const ep = cfg.endpoints.find((e) => e.id === 'colibri-olmoe');
    assert.ok(ep !== undefined);
    assert.deepEqual(ep.local?.warm_check, {
      url: 'http://127.0.0.1:18001/profile',
      json_max: { 'turns.last.expert_disk_s': 0.1 },
    });
  });

  it('判据非空 → warm 闸不再恒真：冷启动序列判负、驻留后判正', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const wc = cfg.endpoints.find((e) => e.id === 'colibri-olmoe')?.local?.warm_check;
    assert.ok(wc !== undefined);
    assert.ok(Object.keys(wc.json_max ?? {}).length > 0, '判据必须有键（空判据 = 闸恒过）');
    // Colibrì /profile 真实形状：冷启动序列 10.0/1.0/0.9/0.47 → 驻留后 0.02/0.0
    const cold = { seq: 8, turns: [{ expert_disk_s: 10.013544 }, { expert_disk_s: 0.47142 }] };
    const warm = { seq: 8, turns: [{ expert_disk_s: 10.013544 }, { expert_disk_s: 0.0 }] };
    assert.equal(matchesWarmCheck(cold, wc), false, '末条 turn 0.47s（冷）应不过');
    assert.equal(matchesWarmCheck(warm, wc), true, '末条 turn 0.0s（驻留）应过');
  });

  // 2026-10-26：stub 的 /profile 形状必须**能过真配置的判据**。
  //
  // 现场：`scripts/router-chain-probe.mts` 按真 models.yml 跑降级演练，一直报
  // 「light 轨降级演练：抛错 全部模型端点均不可用」——看着像 tier2 降级链断了。
  // 实际是 StubTransport.get() 还在返回顶层的 `{expert_disk_s: 0}`，而真判据是
  // `turns.last.expert_disk_s ≤ 0.1`（2026-10-17 改的）。测试替身自己过时，
  // 结论却指向被检查的链 —— 与 §18.11–18.14 同一类。
  //
  // 这条测试把两侧对接上：stub 的 warm=true 与 warm=false 分别喂给**真配置里的
  // 那道闸**，必须一个过一个不过。以后任何一侧改形状都会红。
  it('StubTransport 的 /profile 形状能过真配置的 warm 闸（否则探针会假报"链路断"）', async () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const ep = cfg.endpoints.find((e) => e.id === 'colibri-olmoe');
    assert.ok(ep !== undefined);
    assert.ok(ep.local?.warm_check !== undefined);

    const warmStub = new StubTransport({ local: { 'colibri-olmoe': { health: true, warm: true } } });
    const warmGate = await localGate(warmStub, ep, { healthOkSince: null, graceUntil: null, lastWarmOkAt: null }, () => Date.now());
    assert.equal(warmGate.ok, true, `warm=true 应过闸，实际：${warmGate.reason}`);

    const coldStub = new StubTransport({ local: { 'colibri-olmoe': { health: true, warm: false } } });
    const coldGate = await localGate(coldStub, ep, { healthOkSince: null, graceUntil: null, lastWarmOkAt: null }, () => Date.now());
    assert.equal(coldGate.ok, false, 'warm=false 必须判不过（否则这道闸等于不存在）');
    // 真配置里 colibri 的 warm_grace_ms = 150000：刚起来那会儿不过闸属于"加载中"，
    // 不入熔断窗口。这条同时证明**宽限期真的被读进来了**（不是 0）。
    assert.equal(coldGate.warming, true, '首次判负应在宽限期内 → 判加载中，不算故障');
    assert.match(coldGate.reason, /宽限期内/);
  });

  it('matchesJsonMax：末元素语义 + 空历史放行 + 键不存在判负', () => {
    const max = { 'turns.last.expert_disk_s': 0.1 };
    assert.equal(matchesJsonMax({ turns: [{ expert_disk_s: 0.05 }] }, max), true, '0.05 ≤ 0.1 应过');
    assert.equal(matchesJsonMax({ turns: [{ expert_disk_s: 0.2 }] }, max), false, '0.2 > 0.1 应不过');
    assert.equal(matchesJsonMax({ turns: [] }, max), true, '空历史 = 无磁盘 I/O 样本，放行');
    assert.equal(matchesJsonMax({ turns: [{ other: 1 }] }, max), false, '键不存在必须判负（防判据被静默作废）');
    assert.equal(matchesJsonMax({ turns: 'x' }, max), false, '段类型不符判负');
    assert.equal(matchesJsonMax(null, max), false, '非对象判负');
    // 数字下标同样可用（取第 0 条）
    assert.equal(matchesJsonMax({ turns: [{ expert_disk_s: 5 }, { expert_disk_s: 0 }] }, { 'turns.0.expert_disk_s': 0.1 }), false);
    assert.equal(matchesJsonMax({ turns: [{ expert_disk_s: 5 }, { expert_disk_s: 0 }] }, { 'turns.1.expert_disk_s': 0.1 }), true);
  });

  it('matchesJsonEq 仍支持点分路径（顶层键旧形状不回退）', () => {
    const eq = { 'turns.last.expert_disk_s': 0 };
    assert.equal(matchesJsonEq({ turns: [{ expert_disk_s: 0 }] }, eq), true);
    assert.equal(matchesJsonEq({ turns: [{ expert_disk_s: 0.5 }] }, eq), false);
    assert.equal(matchesJsonEq({ turns: [] }, eq), false, '空历史无值可相等，判负');
    assert.equal(matchesJsonEq({ turns: [{ expert_disk_s: 0 }] }, { expert_disk_s: 0 }), false, '顶层无此键');
  });

  it('local 行内嵌套 warm_check + json_max（ollama 无 warm_check → 字段缺省）', () => {
    const cfg = loadModelsConfig(REAL_MODELS_YML);
    const ollama = cfg.endpoints.find((e) => e.id === 'ollama');
    assert.ok(ollama !== undefined);
    assert.equal(ollama.local?.warm_check, undefined, 'ollama 未声明 warm_check');
  });

  it('续行块内的 warm_check 行内值同样解析（与 local 整行内等价）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: http://127.0.0.1:8001/v1
    models: { light: m }
    local:
      health_url: http://127.0.0.1:8001/health
      warm_check: { url: http://127.0.0.1:8001/profile, json_max: { 'turns.last.expert_disk_s': 0.1 } }
      warm_grace_ms: 150000
      max_concurrency: 1
      queue_reject_ms: 8000
alerts:
  channel_order: [outbox]
`,
    );
    const ep = cfg.endpoints[0];
    assert.ok(ep !== undefined);
    assert.deepEqual(ep.local?.warm_check, {
      url: 'http://127.0.0.1:8001/profile',
      json_max: { 'turns.last.expert_disk_s': 0.1 },
    });
  });

  it('warm_check 空判据（json_eq/json_max 都空）→ 启动期校验拒启动', () => {
    const text = `endpoints:
  - id: e1
    base_url: http://127.0.0.1:8001/v1
    models: { light: m }
    local:
      health_url: http://127.0.0.1:8001/health
      warm_check: { url: http://127.0.0.1:8001/profile, json_eq: {} }
alerts:
  channel_order: [outbox]
`;
    // 解析层：空判据固化成"只有 url"的 warm_check（不静默补默认）
    const cfg = parseModelsYaml(text);
    assert.deepEqual(cfg.endpoints[0]?.local?.warm_check, { url: 'http://127.0.0.1:8001/profile' });
    // 校验层：loadModelsConfig 必须拒启动（空判据 = 闸恒过，等同作废 warm）
    const p = join(tmp.root, 'models-empty-wc.yml');
    writeFileSync(p, text, 'utf8');
    assert.throws(() => loadModelsConfig(p), /warm_check 无有效判据/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3b. 环境变量展开（tier2 通路：WSL 网关 IP 漂移的口子）
// ═══════════════════════════════════════════════════════════════════

describe('models.yml 环境变量展开（expandEnvText）', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  /** 把一段 models.yml 文本写进临时目录再加载（绕开 readFileSync 的真实路径）。 */
  function loadText(text: string): ReturnType<typeof loadModelsConfig> {
    const p = join(tmp.root, 'models.yml');
    writeFileSync(p, text, 'utf8');
    return loadModelsConfig(p);
  }

  const YML = `endpoints:
  - id: e1
    base_url: \${TIER2:-http://172.17.48.1:18001}/v1
    models: { light: m }
    local:
      health_url: \${TIER2:-http://172.17.48.1:18001}/health
alerts:
  channel_order: [outbox]
`;

  it('未设置时用默认值（gateway 兜底）', () => {
    delete process.env.TIER2;
    const cfg = loadText(YML);
    assert.equal(cfg.endpoints[0]?.baseUrl, 'http://172.17.48.1:18001/v1');
    assert.equal(cfg.endpoints[0]?.local?.health_url, 'http://172.17.48.1:18001/health');
  });

  it('已设置时整体覆盖（主人换网关/端口只改 tokens.env）', () => {
    process.env.TIER2 = 'http://10.0.0.9:9999';
    const cfg = loadText(YML);
    assert.equal(cfg.endpoints[0]?.baseUrl, 'http://10.0.0.9:9999/v1');
    assert.equal(cfg.endpoints[0]?.local?.health_url, 'http://10.0.0.9:9999/health');
  });

  it('无默认值且未设置 → ConfigError 拒启动（不静默变空串）', () => {
    delete process.env.MUST_SET;
    assert.throws(() => loadText(YML.replace('${TIER2:-http://172.17.48.1:18001}', '${MUST_SET}')), /MUST_SET/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 解析健壮性：续行块边界
// ═══════════════════════════════════════════════════════════════════

describe('续行块边界（缩进驱动的块开关）', () => {
  it('两个端点的续行块互不串味（块在新 `- id:` 处关闭）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://a.example/v1
    models:
      primary: a-main
      light: a-mini
  - id: e2
    base_url: https://b.example/v1
    models:
      primary: b-main
alerts:
  channel_order: [outbox]
`,
    );
    assert.equal(cfg.endpoints.length, 2);
    assert.equal(cfg.endpoints[0]?.models.primary, 'a-main');
    assert.equal(cfg.endpoints[0]?.models.light, 'a-mini');
    assert.equal(cfg.endpoints[1]?.models.primary, 'b-main');
    assert.equal(cfg.endpoints[1]?.models.light, undefined);
  });

  it('续行 models 块里的行注释被剥掉（# 后是注释不是值）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://a.example/v1
    models:
      primary: a-main   # 主循环
      light:   a-mini   # 低智能分流
alerts:
  channel_order: [outbox]
`,
    );
    assert.equal(cfg.endpoints[0]?.models.primary, 'a-main');
    assert.equal(cfg.endpoints[0]?.models.light, 'a-mini');
  });

  it('顶层键（routing:）出现时端点续行块被强制关闭', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://a.example/v1
    models:
      primary: a-main
routing:
  default_track: primary
alerts:
  channel_order: [outbox]
`,
    );
    assert.equal(cfg.endpoints[0]?.models.primary, 'a-main');
    assert.equal(cfg.routing.default_track, 'primary');
  });

  it('空 models 块仍触发启动期校验失败（不静默放行）', () => {
    const cfg = parseModelsYaml(
      `endpoints:
  - id: e1
    base_url: https://a.example/v1
    models:
alerts:
  channel_order: [outbox]
`,
    );
    assert.deepEqual(cfg.endpoints[0]?.models, {});
  });

  it('recon.sources 续行条目与其余节不受影响（真实文件全节回归）', () => {
    const text = readFileSync(REAL_MODELS_YML, 'utf8');
    const cfg = parseModelsYaml(text);
    assert.equal(cfg.recon.sources.length, 2);
    assert.equal(cfg.recon.sources[0]?.type, 'openrouter_models');
    assert.equal(cfg.recon.sources[0]?.filter, ':free');
    assert.equal(cfg.recon.sources[1]?.type, 'github_curated');
    assert.equal(cfg.recon.sources[1]?.raw_via, 'base64');
    assert.equal(cfg.alerts.channel_order.includes('outbox'), true);
    assert.equal(cfg.breaker.consec_failures, 3);
    assert.equal(cfg.version, 1);
  });

  // 2026-10-22 回归：Windows 工作区（core.autocrlf=true）检出的配置文件是 CRLF。
  // 曾经的实现 `text.split('\n')` 把 `\r` 留在每行末尾 → 缩进判断/注释剥离/取值全部失真，
  // 真实 models.yml 被解析成 0 个端点，daemon 直接报「models.yml 未定义任何端点」拒启动。
  // 这里用**同一份真实文件**的两种行尾各解析一遍，断言结果必须一致。
  it('CRLF 与 LF 解析结果一致（Windows 检出不会让整份配置解析成 0 个端点）', () => {
    const crlfText = readFileSync(REAL_MODELS_YML, 'utf8').replace(/\r?\n/g, '\r\n');
    assert.ok(crlfText.includes('\r\n'), '样本必须是 CRLF，否则这条测试没在测东西');
    const fromCrlf = parseModelsYaml(crlfText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    const fromLf = parseModelsYaml(crlfText.replace(/\r\n/g, '\n'));
    assert.deepEqual(fromCrlf, fromLf, 'CRLF 与 LF 必须解析出完全相同的配置');
    // 硬断言几个"被 \r 污染就必然错"的字段，防 deepEqual 两边一起错
    assert.ok(fromCrlf.endpoints.length > 0, '端点不能是 0 个');
    // 不写死 key 名（配置会换凭据），只断言"取到的值干净"：非空、无 \r、无尾随空白。
    const env = fromCrlf.endpoints[0]?.apiKeyEnv;
    assert.equal(typeof env, 'string', 'api_key_env 必须被解析出来');
    assert.ok((env as string).length > 0, 'api_key_env 不能是空串');
    assert.ok(!(env as string).includes('\r'), '值里不能残留 \r');
    assert.equal((env as string), (env as string).trim(), '值不能带尾随空白');
    assert.ok(fromCrlf.routing.light_events.length > 0, '续行列表不能被 CRLF 吞掉');
  });
});
// ═══════════════════════════════════════════════════════════════════
// extra_body：端点级额外请求字段（2026-10-23，语音首句延迟）
// ═══════════════════════════════════════════════════════════════════

describe('extra_body：行内嵌套映射与字面量还原', () => {
  it('解析 chat_template_kwargs.enable_thinking=false 为真布尔（"false" 字符串会骗过 Jinja）', () => {
    const cfg = parseModelsYaml(
      [
        'version: 1',
        'endpoints:',
        '  - id: qwen-fast',
        '    tier: 1',
        '    base_url: http://127.0.0.1:9999/v1',
        '    api_key_env: none',
        '    models: { primary: Qwen3.8-Flash, light: Qwen3.8-Flash }',
        '    extra_body: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 }',
        '',
      ].join('\n'),
    );
    const ep = cfg.endpoints.find((e) => e.id === 'qwen-fast');
    assert.ok(ep !== undefined, '端点应被解析');
    assert.deepEqual(ep.extraBody, { chat_template_kwargs: { enable_thinking: false }, top_k: 20 });
    assert.equal(
      (ep.extraBody as { chat_template_kwargs: { enable_thinking: unknown } }).chat_template_kwargs
        .enable_thinking,
      false,
      '必须是 boolean false，不能是字符串 "false"',
    );
    assert.equal((ep.extraBody as { top_k: unknown }).top_k, 20, '数字要还原成 number');
  });

  it('没写 extra_body 的端点不带这个键（老配置逐字不变）', () => {
    const cfg = parseModelsYaml(
      [
        'version: 1',
        'endpoints:',
        '  - id: plain',
        '    tier: 1',
        '    base_url: http://127.0.0.1:9999/v1',
        '    api_key_env: none',
        '    models: { primary: m, light: m }',
        '',
      ].join('\n'),
    );
    const ep = cfg.endpoints.find((e) => e.id === 'plain');
    assert.ok(ep !== undefined);
    assert.equal(ep.extraBody, undefined);
  });
});
