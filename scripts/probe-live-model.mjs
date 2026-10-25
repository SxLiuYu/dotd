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
 *   1. 用 loadModelsConfig 读 `<DOTD_CONFIG_DIR>/models.yml`（缺省仓库 config/），
 *      取 tier1 且 enabled 的首个端点；
 *   2. 从端点声明的 api_key_env 取 key，按 daemon 的眼光找（2026-10-26 修）：
 *      进程环境 → `<home>/tokens.env` → 运行中 daemon 的进程环境。**只用于这一次
 *      请求，绝不打印**，并把"从哪找到的"写进结论。原来的纪律是"只读环境变量"，
 *      于是 live 上 key 明明在 tokens.env 与 daemon 里、模型正正常出字，本脚本
 *      却报"未验证"——检查器看错地方，结论却指向被检查对象；
 *   3. 三处都没有 → 打印清晰结论并 exit 0（"没配凭据"不是失败，是未验证）；
 *   4. 找到 → 经真 HttpTransport 发一次带 tool_calls 的最小请求，打印 4 行结论。
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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const out = (s = '') => process.stdout.write(`${s}\n`);

async function main() {
  const { loadModelsConfig } = await import('../src/router/config.ts');
  const { HttpTransport } = await import('../src/router/transport.ts');

  // ── 0. 先把「运行期环境」拉进来（2026-10-26）────────────────────────
  //
  // 这是同一缺陷的**第六例**，也是最隐蔽的一例：§18.14 已经让本脚本去
  // tokens.env / 运行中 daemon 里找 **key**，但 `models.yml` 里的
  // `${DOTD_MODEL_HOST:-http://127.0.0.1:3065}` 是在 `loadModelsConfig()` 里
  // 用 `process.env` 展开的（src/router/config.ts:expandEnvText）。于是 live 上
  // 出现这个组合：
  //
  //   doctor  ✅ openrouter-main http://172.17.48.1:13065/v1  TCP 可连（4ms）
  //   probe   ✗ connect ECONNREFUSED 127.0.0.1:3065
  //
  // 同一个 daemon、同一份 models.yml、同一个 key —— 差别只在"谁展开这个占位符"。
  // 端点地址、配置目录、db 路径这些**运行期旋钮**必须按 daemon 的值来，
  // 否则本脚本验的是另一台设备上的另一个网关，结论与线上无关。
  //
  // 白名单覆盖（`RUNTIME_KNOBS`）不含任何 key/token，所以第 2 步的凭据查找语义
  // 不变：key 仍然走 进程环境 → tokens.env → daemon。
  const { layeredEnv, resolveConfigDir } = await import('./lib/env.mjs');
  const { liveDaemon, RUNTIME_KNOBS } = await import('./lib/live-daemon.mjs');
  // `procRoot` 的默认值仍是 `/proc`；这个口子给两类场景：
  //   ① 非标准挂载（容器里 hidepid/只读 /proc 的镜像）；
  //   ② 测试要造一个"运行中的 daemon"，总不能在测试机上真起一个 dotd。
  // 它只影响"去哪个目录读进程信息"，不改变任何判据。
  const live = liveDaemon({
    shellEnv: process.env,
    ...(process.env.DOTD_PROC_ROOT ? { procRoot: process.env.DOTD_PROC_ROOT } : {}),
  });

  /** 这份环境是"运行中期许值"的来源说明，写进输出，避免又一个"实际生效"式误读。 */
  let runtimeNote;
  if (live === null) {
    runtimeNote = '（没找到运行中的 daemon，按当前 shell 展开）';
  } else if ('ambiguous' in live) {
    runtimeNote = `（发现 ${live.ambiguous.length} 个 daemon 进程，无法确定哪个在服务，按当前 shell 展开）`;
  } else {
    runtimeNote = `（取值来自运行中的 daemon pid ${live.pid}）`;
    // 只覆盖旋钮键；空串不覆盖（daemon 里空值等于没设）。
    for (const k of RUNTIME_KNOBS) {
      const v = live.env[k];
      if (v !== undefined && v !== '') process.env[k] = v;
    }
  }

  // home 与 tokens 必须在覆盖**之后**算：`DOTD_HOME` 本身就是旋钮之一，
  // 先算再用就还是这个 shell 的 home（§18.14 的同一个错法）。
  const home =
    process.env.CHARLIE_HOME ?? process.env.DOTD_HOME ?? join(homedir(), '.dotd');
  const tokens = layeredEnv({ home, homedir: homedir() });

  // ── 1. 读真配置，选端点 ─────────────────────────────────────────────
  //
  // 路径顺序与 daemon 一致（2026-10-26）：`DOTD_CONFIG_DIR` 优先，否则仓库 config/。
  // 托管部署里 daemon 读的是 `~/.dotd/models.yml`（且热加载），原来这里写死仓库那份：
  // 主人改过运行时配置后，这个"上线前体检"验的是另一份端点 —— 结论与线上无关。
  // 判据与 doctor / onboard 共用 `scripts/lib/env.mjs`。
  //
  // 注意 `home` 也要按运行期取：上面已把 daemon 的 `DOTD_HOME` / `DOTD_CONFIG_DIR`
  // 叠进 `process.env`，这里的 `home` 因此与 daemon 一致。
  const configDir = resolveConfigDir({ repoRoot: REPO_ROOT, home: homedir() });
  const cfgPath = join(configDir, 'models.yml');
  let cfg;
  try {
    cfg = loadModelsConfig(cfgPath);
  } catch (cause) {
    out(`[probe] 环境错误：读不出 ${cfgPath}`);
    out(`        ${cause instanceof Error ? cause.message : String(cause)}`);
    const repoCfg = join(REPO_ROOT, 'config', 'models.yml');
    if (cfgPath !== repoCfg && existsSync(repoCfg)) {
      out(`        注意：仓库模板 ${repoCfg} 存在，但 daemon 不读它（改的是另一份）。`);
    }
    return 2;
  }

  const wanted = process.argv
    .slice(2)
    .map((a) => /^--endpoint=(.+)$/.exec(a)?.[1])
    .find((v) => typeof v === 'string');

  const candidates = (cfg.endpoints ?? []).filter((e) => e.enabled !== false && e.tier === 1);
  if (candidates.length === 0) {
    out(`[probe] 环境错误：${cfgPath} 里没有 enabled 的 tier1 端点`);
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
  // 端点地址是 `${DOTD_MODEL_HOST}` 展开出来的：必须交代替换值来自哪个进程，
  // 否则「同一份 models.yml，doctor 说通、这里说不通」没法解释（见第 0 步注释）。
  out(`运行期    ${runtimeNote}`);
  out('');

  // ── 2. 凭据检查（与 daemon 同眼光；缺就如实说缺，不失败）──────────────
  //
  // 顺序与 daemon 启动时一致：进程环境 → `<home>/tokens.env` → 运行中 daemon 的
  // 进程环境。**最后一条是 2026-10-26 加的**：live 上 key 都在 tokens.env 里，
  // 一键启动会 source 它，daemon 里也有；而人手动跑本脚本时那个 shell 里没有，
  // 于是"模型正正常出字"和"本脚本说未验证"同时成立 —— 检查器看错地方。
  //
  // 值只用于这一次请求，**任何分支都不打印**；打印的只是"从哪儿找到的"。
  let key = null;
  let keySource = '';
  if (keyEnv !== null) {
    if (process.env[keyEnv] !== undefined && process.env[keyEnv] !== '') {
      key = process.env[keyEnv];
      keySource = '当前 shell 的环境变量';
    } else if (tokens.has(keyEnv)) {
      key = tokens.get(keyEnv);
      keySource = `${tokens.sources[keyEnv] ?? 'tokens.env'}（值不打印）`;
    } else if (live !== null && !('ambiguous' in live) && (live.env[keyEnv] ?? '') !== '') {
      key = live.env[keyEnv];
      keySource = `运行中的 daemon pid ${live.pid} 的环境（值不打印）`;
    }
  }
  if (keyEnv !== null && keySource !== '') {
    out(`凭据来源  ${keySource}`);
    out('');
  }
  if (keyEnv !== null && key === null) {
    out(`connect:  未验证 — ${keyEnv} 在 shell / tokens.env / 运行中 daemon 里都没有`);
    // 这条提示很关键：主人已经把 key 写进 ~/.dotd/tokens.env 之后，裸 shell 里跑本脚本
    // 仍然会看到"未验证"——现在脚本会自己去找 tokens.env 与运行中的 daemon，
    // 三处都没有才是真的没有。
    out(`           已经查过：当前 shell 环境变量、${home}/tokens.env、运行中 daemon 的进程环境。`);
    out(`           要让本脚本也带上，先 source 它：`);
    out(`           bash -lc 'set -a; . ${home}/tokens.env; set +a; node --import tsx scripts/probe-live-model.mjs'`);
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
  //
  // 凭据必须落进 process.env 才有效：`HttpTransport` 在发请求时才调 `apiKeyFor()`，
  // 它只读 `process.env[apiKeyEnv]`（见 src/router/transport.ts:545）。上面那三处
  // 查找只是"把这个 key 找出来"，真正用它得放回环境里。这是本进程内的临时赋值，
  // 不写文件、不打印，进程退出即消失。
  if (keyEnv !== null && key !== null) process.env[keyEnv] = key;

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
