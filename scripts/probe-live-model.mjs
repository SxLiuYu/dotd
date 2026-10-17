#!/usr/bin/env node
/**
 * scripts/probe-live-model.mjs —— 上线前体检：对**真实模型**做一次最小往返。
 *
 * 为什么要有这个脚本：仓库里的自动化测试全部跑在 127.0.0.1 的假上游上（零外网、
 * 可复现），这保证了"传输层是对的"，但**证明不了模型本身会调工具**。真实链路的
 * 最后一公里只有真 key + 真网关能验。这个脚本就是那条腿，不进 `npm test`
 * （不能依赖网络/凭据，不能让日常门禁因为没 key 就红）。
 *
 * 做法（**只读真配置、打真网关、不碰真 ~/.dotd**）：
 *   1. 用 loadModelsConfig 读 config/models.yml，取 tier1 且 enabled 的首个端点；
 *   2. 从端点声明的 api_key_env 读 key（**不从别处偷**：不读 .env、不翻进程环境、
 *      不猜文件名）；
 *   3. key 缺失 → 打印清晰结论并 exit 0（"没配凭据"不是失败，是未验证）；
 *   4. key 在 → 经真 HttpTransport 发一次带 tool_calls 的最小请求，打印 4 行结论。
 *
 * 跑法：
 *   node --import tsx scripts/probe-live-model.mjs
 *   node --import tsx scripts/probe-live-model.mjs --endpoint=<id>   # 指定端点
 *
 * 退出码（区分"未验证"与"验证失败"，供 CI/体检脚本判断）：
 *   0 = key 不在环境里（未验证，不算失败）**或** 真往返成功且返回合法 tool_calls
 *   1 = key 在，但真往返失败 / 模型没返回合法 tool_calls（链路或模型有问题）
 *   2 = 环境/装配错误（配置读不出来、端点不存在等）
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const out = (s = '') => process.stdout.write(`${s}\n`);

async function main() {
  const { loadModelsConfig } = await import('../src/router/config.ts');
  const { HttpTransport } = await import('../src/router/transport.ts');

  // ── 1. 读真配置，选端点 ─────────────────────────────────────────────
  const cfgPath = join(REPO_ROOT, 'config', 'models.yml');
  let cfg;
  try {
    cfg = loadModelsConfig(cfgPath);
  } catch (cause) {
    out(`[probe] 环境错误：读不出 ${cfgPath}`);
    out(`        ${cause instanceof Error ? cause.message : String(cause)}`);
    return 2;
  }

  const wanted = process.argv
    .slice(2)
    .map((a) => /^--endpoint=(.+)$/.exec(a)?.[1])
    .find((v) => typeof v === 'string');

  const candidates = (cfg.endpoints ?? []).filter((e) => e.enabled !== false && e.tier === 1);
  if (candidates.length === 0) {
    out('[probe] 环境错误：config/models.yml 里没有 enabled 的 tier1 端点');
    return 2;
  }
  const ep =
    wanted === undefined ? candidates[0] : candidates.find((e) => e.id === wanted);
  if (ep === undefined) {
    out(`[probe] 环境错误：tier1 里找不到端点 ${wanted}`);
    out(`        可选：${candidates.map((e) => e.id).join(', ')}`);
    return 2;
  }

  const model = ep.models?.primary ?? ep.models?.light ?? '';
  const keyEnv = ep.apiKeyEnv ?? null;

  out('== dotd 上线前体检：真实模型一次往返 ==');
  out(`端点      ${ep.id}（tier${ep.tier}, style=${ep.style}）`);
  out(`base_url  ${ep.baseUrl}`);
  out(`模型      ${model}`);
  out(`凭据变量  ${keyEnv === null ? '（该端点免鉴权）' : keyEnv}`);
  out('');

  // ── 2. 凭据检查（缺就如实说缺，不失败、不偷）──────────────────────────
  const key = keyEnv === null ? null : process.env[keyEnv];
  if (keyEnv !== null && (key === undefined || key.length === 0)) {
    out(`connect:  未验证 — 环境变量 ${keyEnv} 不存在或为空`);
    out(`model:    ${model}`);
    out('tool_calls: 未验证（没有发出任何请求）');
    out('latency:  n/a');
    out('');
    out(`结论：真模型未验证。缺的只是凭据——请在运行本脚本的环境里设置 ${keyEnv} 后重跑。`);
    out('     这是"未验证"，不是"不可用"；脚本按约定以 exit 0 退出，不阻断门禁。');
    // 顺带体检网关是否活着（不带凭据的 GET /v1/models：401 说明网关在、只是没凭据）
    try {
      const res = await fetch(`${ep.baseUrl}/models`, { method: 'GET' });
      out('');
      out(`[附加] GET ${ep.baseUrl}/models → HTTP ${res.status}`);
      out(
        res.status === 401 || res.status === 403
          ? '       网关活着，只是拒绝未授权请求：这是"缺凭据"的直接证据。'
          : `       网关返回 ${res.status}（非鉴权拒绝），值得留意。`,
      );
    } catch (cause) {
      out('');
      out(`[附加] GET ${ep.baseUrl}/models 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      out('       网关可能不可达（与"缺凭据"是两回事）。');
    }
    return 0;
  }

  // ── 3. 真往返：带 tool_calls 的最小请求 ──────────────────────────────
  // 工具名用点分契约名，验证 transport 的消毒/还原在真网关上也成立。
  const TOOL_NAME = 'fs.read';
  const call = {
    endpoint: ep,
    track: 'primary',
    model,
    messages: [
      { role: 'system', content: '你是体检探针。必须调用给定工具，不要用文字回答。' },
      { role: 'user', content: '请读取 notes/probe.md 这个文件。' },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description: '读取 home 下的一个文件',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'home 下的相对路径' } },
          required: ['path'],
        },
      },
    ],
    tool_choice: 'required',
    maxTokens: 128,
    temperature: 0,
    cap: {
      connect_ms: ep.timeouts?.connect_ms ?? 5000,
      idle_ms: ep.timeouts?.idle_ms ?? 60_000,
      total_ms: Math.min(ep.timeouts?.total_ms ?? 180_000, 60_000),
    },
  };

  const t0 = Date.now();
  let outcome = null;
  let err = null;
  try {
    outcome = await new HttpTransport().chat(call);
  } catch (cause) {
    err = cause;
  }
  const latency = Date.now() - t0;

  if (err !== null) {
    out('connect:  失败');
    out(`model:    ${model}`);
    out(`tool_calls: 否（请求未成功：${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 200)}）`);
    out(`latency:  ${latency}ms`);
    out('');
    out('结论：真模型往返**失败**。这是真实故障，不是缺凭据。');
    return 1;
  }

  const toolCalls = outcome.response?.toolCalls ?? [];
  const first = toolCalls[0] ?? null;
  let argsOk = false;
  if (first !== null && typeof first.arguments === 'string' && first.arguments.length > 0) {
    try {
      const parsed = JSON.parse(first.arguments);
      argsOk = typeof parsed === 'object' && parsed !== null;
    } catch {
      argsOk = false;
    }
  }
  // 点分名必须被还原回契约名（transport 的消毒/还原在真网关上是否成立）
  const nameRestored = first !== null && first.name === TOOL_NAME;

  out(`connect:  成功（HTTP 往返完成）`);
  out(`model:    ${model}`);
  out(
    `tool_calls: ${toolCalls.length > 0 ? `是（${toolCalls.length} 个` : '否'}` +
      (toolCalls.length > 0
        ? `，name=${first?.name ?? '?'}${nameRestored ? ' 已还原为契约名' : ` **未还原**（期望 ${TOOL_NAME}）`}，arguments=${argsOk ? '合法 JSON' : '非法 JSON'}${first?.arguments ? ` ${String(first.arguments).slice(0, 120)}` : ''}）`
        : ''),
  );
  out(`latency:  ${latency}ms`);
  out('');
  if (toolCalls.length > 0 && argsOk && nameRestored) {
    out('结论：真实模型一次往返**通过**——端点可达、鉴权有效、工具调用线格式与名字还原都成立。');
    return 0;
  }
  out('结论：往返成功但**未产出合法 tool_calls**：模型的工具调用能力对该端点不可信。');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    out(`[probe] 未捕获异常：${cause instanceof Error ? cause.stack : String(cause)}`);
    process.exit(2);
  },
);
