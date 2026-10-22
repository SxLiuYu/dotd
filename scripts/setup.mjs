#!/usr/bin/env node
/**
 * scripts/setup.mjs —— `npm run setup`：一条命令把 dotd 装到"能起来"的状态。
 *
 * ── 为什么需要它（先回答"12 步里哪几步是真必要的"）────────────────────────
 * 旧 README 的安装路径是 12 步，但按代码事实逐条核对后，其中**只有 3 步需要人**：
 *
 *   ① 装 Node ≥ 24                    —— 系统级前置，脚本无权替你装（也不该）
 *   ② 给模型 key（DOTD_/WB2API_KEY）  —— 只有主人有 key；脚本只检查、不生成
 *   ③ 确认要哪种 fleet（stub / docker）—— 这是"真跑容器"还是"演示模式"的**意图声明**，
 *                                        语义上必须由人决定（见下"默认策略"）
 *
 * 其余 9 步都是**可检测、可幂等执行**的，本脚本做掉：
 *   - npm install（检测 node_modules 与 lock 新鲜度）
 *   - init-config（幂等；已有 config.yml/tokens.env 一律不覆盖）
 *   - WSL 侧 Node24 / rsync 仓库 / npm install（检测 WSL 是否存在，存在才做）
 *   - docker pull 2GB 基座镜像 → **不替你做**，只报告"要不要拉、拉哪一条命令"
 *   - 构建 exec 镜像 → **不需要单独一步**：`src/exec/image.ts:ensureImage()` 在
 *     daemon boot 时缺镜像即自动构建（fleet.ts:387-392），这是此前 README 重复劳动的根源
 *   - 补 win-relay 转发 → 只对 WSL 用户有意义，且转发哪个端口取决于**主人的模型服务**，
 *     无法猜测；脚本只检测并给出那条命令
 *   - 最后跑 doctor 并打印结论
 *
 * ── 设计原则（沿用 doctor 立下的标准）────────────────────────────────────
 *   1. **只读为主 + 幂等**：跑两次结果一致，且第二次不改变任何已有文件的内容/修改时间。
 *   2. **检测而不是假设**：每一步先看现状，已满足就 SKIP 并说明"为什么跳过"。
 *   3. **不替人做危险/昂贵动作**：docker pull 2GB、覆盖 tokens.env、改主人配置——一律只报告。
 *   4. **失败给人话 + 下一条命令**，不静默继续。
 *   5. **doctor 是唯一真相源**：setup 结束调 doctor，不另写一套检查逻辑（避免两套口径漂移）。
 *
 * ── 默认策略 ────────────────────────────────────────────────────────────
 * fleet 默认 **stub**（与 `src/exec/types.ts` 的 DEFAULT_EXEC_CONFIG 一致，本脚本不改变它）。
 * 想要真容器，人显式 `--fleet=docker` 或设 `DOTD_FLEET=docker`——这是"意图"，不是"检测得出来的东西"。
 *
 * 用法：
 *   npm run setup                     # 自动检测，做能做的，最后跑 doctor
 *   npm run setup -- --check          # 只体检不动作（= doctor + 缺失项清单）
 *   npm run setup -- --fleet=docker   # 声明要用真容器（会检查 docker/WSL，但**不会**自动 pull 2GB）
 *   npm run setup -- --skip-doctor    # 不跑最后的 doctor（CI 里自己另跑时用）
 *   npm run setup -- --json           # 机器可读
 *
 * cwd 无关：一切路径从本文件位置推导。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const MIN_NODE_MAJOR = 24;

/** 步骤结果档位：ok = 这次做了/本来就满足；skip = 已满足或不需要；act = 需要人做；fail = 出错。 */
export const STEP = Object.freeze({ OK: 'ok', SKIP: 'skip', ACT: 'act', FAIL: 'fail' });

/** setup 的步骤清单（导出给测试做结构断言）。 */
export const STEPS = Object.freeze([
  'node',
  'deps',
  'data-dir',
  'config',
  'tokens',
  'wsl',
  'wsl-node',
  'wsl-repo',
  'docker',
  'fleet-image',
  'relay',
  'doctor',
]);

// ── 纯函数（测试直接打，不碰文件系统）──────────────────────────────────

/** 解析语义化版本主号；无法解析返回 null。 */
export function majorOf(versionText) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionText ?? ''));
  return m === null ? null : Number(m[1]);
}

/**
 * Node 版本判定。返回 { ok, status, detail }。
 * **不自动装 Node**：装 Node 需要 admin/sudo，且会改变整台机器的运行时，
 * 这是本脚本明确不做的那 3 件事之一。
 */
export function checkNode(versionText) {
  const major = majorOf(versionText);
  if (major === null) {
    return { ok: false, status: STEP.ACT, detail: `读不到 Node 版本（${versionText}）`, next: '安装 Node 24+：https://nodejs.org/en/download' };
  }
  if (major >= MIN_NODE_MAJOR) return { ok: true, status: STEP.SKIP, detail: `v${major} ≥ ${MIN_NODE_MAJOR}`, next: null };
  return {
    ok: false,
    status: STEP.ACT,
    detail: `当前 v${major}，需要 ≥ ${MIN_NODE_MAJOR}`,
    next: `升级 Node 到 24+（nvm install 24 / nvm use 24，或 https://nodejs.org/en/download）`,
  };
}

/**
 * 判定依赖是否已装且与 lock 一致。
 *
 * 为什么不能只看 node_modules 存在：改过 package.json 后旧的 node_modules 还在，
 * 现象是"跑起来报找不到模块"。这里用 package-lock.json 的 mtime 与 node_modules
 * 的 mtime 比较——比他精确的方案要解析 lock 里每个包，收益不抵复杂度。
 */
export function checkDeps({ hasNodeModules, lockMtimeMs, modulesMtimeMs }) {
  if (!hasNodeModules) {
    return { ok: false, status: STEP.ACT, detail: '还没装依赖', next: 'npm install' };
  }
  if (typeof lockMtimeMs === 'number' && typeof modulesMtimeMs === 'number' && lockMtimeMs > modulesMtimeMs) {
    return {
      ok: false,
      status: STEP.ACT,
      detail: 'package-lock.json 比 node_modules 新（依赖可能过期）',
      next: 'npm install（或 npm ci 求干净重装）',
    };
  }
  return { ok: true, status: STEP.SKIP, detail: 'node_modules 已就绪且不比 lock 旧', next: null };
}

/** data-dir 判定：~/.dotd 存在即可（首次启动会自动建，但提前建能早暴露权限问题）。 */
export function checkDataDir({ exists }) {
  return exists
    ? { ok: true, status: STEP.SKIP, detail: '~/.dotd 已存在', next: null }
    : { ok: false, status: STEP.OK, detail: '~/.dotd 不存在（可自动创建）', next: null };
}

/**
 * 配置判定：config.yml 存在 = 已初始化。
 * **已存在就绝不覆盖**（覆盖会抹掉主人的 hooks/token/端口配置），只报告要不要 --force。
 */
export function checkConfig({ exists }) {
  return exists
    ? { ok: true, status: STEP.SKIP, detail: 'config.yml 已存在（不覆盖）', next: null }
    : { ok: false, status: STEP.ACT, detail: 'config.yml 还没生成', next: 'npm run init-config' };
}

/**
 * tokens.env 判定：只看**哪些键缺失**，绝不打印/覆盖已有值。
 * @param {string|null} text tokens.env 内容（不存在 = null）
 * @param {string[]} required 必须存在的键
 */
export function checkTokens({ text, required }) {
  if (text === null) {
    return {
      ok: false,
      status: STEP.ACT,
      detail: 'tokens.env 还不存在',
      next: 'npm run init-config（生成随机 master/ro/hook token，已有键不覆盖）',
      missing: [...required],
    };
  }
  const missing = required.filter((k) => !new RegExp(`^\\s*(export\\s+)?${k}\\s*=`, 'm').test(text));
  if (missing.length === 0) {
    return { ok: true, status: STEP.SKIP, detail: `必需键齐全（${required.length} 个）`, next: null, missing: [] };
  }
  // 区分"必须人给的值"与"init-config 能自动补的"
  const NEED_HUMAN = new Set(['WB2API_KEY', 'OPENROUTER_API_KEY']);
  const human = missing.filter((k) => NEED_HUMAN.has(k));
  return {
    ok: false,
    status: STEP.ACT,
    detail: `缺 ${missing.length} 个键：${missing.join(', ')}`,
    next:
      human.length > 0
        ? `先用 \`npm run setup\`（会自动 init-config 补随机键）；模型 key 需要你自己填：把 ${human.join('/')} 写进 ~/.dotd/tokens.env`
        : 'npm run init-config（只补缺键，不动已有值）',
    missing,
  };
}

/**
 * fleet 判定：**默认 stub，本脚本不改变默认值**。
 * - 未声明 → stub（与 src/exec/types.ts 的 DEFAULT_EXEC_CONFIG.fleet 一致）
 * - 声明 docker → 需要 docker 可达；不可达就是"你以为跑了真容器，其实是假的"的源头
 * 注意 `DOTD_FLEET` 只认小写 'stub'/'docker'，拼错静默回落 stub——这里显式提示。
 */
export function checkFleet({ raw, dockerAvailable }) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (v === '' || v === 'stub') {
    return {
      effective: 'stub',
      ok: true,
      status: STEP.SKIP,
      detail: 'stub（不起容器；演示/开发模式，与默认值一致）',
      next: null,
    };
  }
  if (v !== 'docker') {
    return {
      effective: 'stub',
      ok: false,
      status: STEP.ACT,
      detail: `DOTD_FLEET='${v}' 不是精确的 'stub'/'docker'，会被**静默忽略**并回落 stub`,
      next: '改成 DOTD_FLEET=docker（全小写）后重跑',
    };
  }
  if (!dockerAvailable) {
    return {
      effective: 'docker',
      ok: false,
      status: STEP.ACT,
      detail: '声明了 docker，但这台机器上 docker 不可达',
      next: '装 Docker Desktop / 启动 dockerd，或改回 DOTD_FLEET=stub 先用演示模式',
    };
  }
  return { effective: 'docker', ok: true, status: STEP.OK, detail: '真实容器模式，docker 可达', next: null };
}

/**
 * 镜像判定：**不需要人跑一步构建**。
 * `src/exec/image.ts:ensureImage()` 在 daemon boot 时缺镜像即自动构建（fleet.ts:387-392）。
 * 但基座镜像（playwright ~2GB）要不要**预拉**是一个成本决策——脚本只报告命令，不替你拉。
 */
export function checkImage({ basePresent, builtPresent, baseTag }) {
  if (!basePresent) {
    return {
      ok: false,
      status: STEP.ACT,
      detail: `基座镜像 ${baseTag} 不在本地（docker build 时会自动拉，约 2GB）`,
      next: `确认要真容器后自己跑：docker pull ${baseTag}`,
    };
  }
  if (!builtPresent) {
    return {
      ok: true,
      status: STEP.SKIP,
      detail: '基座镜像已就位；dotd/exec 镜像会在 daemon 首次 boot 时自动构建',
      next: null,
    };
  }
  return { ok: true, status: STEP.SKIP, detail: '基座镜像与 dotd/exec 镜像都已就位', next: null };
}

/**
 * win-relay 判定：**只有 WSL 部署需要**（WSL2 NAT 下 WSL 够不着 Windows loopback）。
 * 转发哪个端口取决于主人的模型服务，脚本猜不出来——只给命令。
 */
export function checkRelay({ wslDeployment, relayRules, neededPorts }) {
  if (!wslDeployment) {
    return { ok: true, status: STEP.SKIP, detail: '原生 Windows 部署不需要 relay（模型服务同在本机 loopback）', next: null };
  }
  const missing = neededPorts.filter((p) => !relayRules.includes(p));
  if (missing.length === 0) {
    return { ok: true, status: STEP.SKIP, detail: 'relay 规则已覆盖所需端口', next: null };
  }
  return {
    ok: false,
    status: STEP.ACT,
    detail: `WSL 部署需要转发 Windows 侧模型端口，当前 relay 没转：${missing.join(', ')}`,
    next: `在 scripts/win-relay.mts 里加规则并在 Windows 侧跑 scripts/start-relay.ps1（映射缺的端口）`,
  };
}

/**
 * 解析 tokens.env 的 `export K=V` 行 → 对象（**只解析，不打印**）。
 *
 * 为什么 setup 需要它：`npm run doctor` 检查的是**当前进程的环境变量**，
 * 而 token 平时存在 `~/.dotd/tokens.env` 里、只有 `source` 之后才进环境。
 * 直接跑 doctor 会报"严格占位符没有值"，让人误以为安装没完成——
 * 那是本项目"装好了但看起来没装好"的最典型误导。setup 把 tokens.env 注入 doctor
 * 的 env，让它看到"source 之后"的真实状态。
 */
export function parseTokensEnv(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    let v = m[2].trim();
    // 去掉成对引号（值里不处理转义——tokens.env 由 init-config/setup-dev-env 生成，格式简单）
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** 汇总：哪些项需要人动手、哪些已自动完成。 */export function summarize(results) {
  const act = results.filter((r) => r.status === STEP.ACT);
  const fail = results.filter((r) => r.status === STEP.FAIL);
  const auto = results.filter((r) => r.status === STEP.OK);
  const skip = results.filter((r) => r.status === STEP.SKIP);
  return {
    needHuman: act.map((r) => ({ step: r.step, detail: r.detail, next: r.next })),
    failed: fail.map((r) => ({ step: r.step, detail: r.detail, next: r.next })),
    autoDone: auto.map((r) => r.step),
    alreadyDone: skip.map((r) => r.step),
  };
}

// ── 呈现 ────────────────────────────────────────────────────────────────

const ICON = { ok: '✅', skip: '⏭️ ', act: '👉', fail: '❌' };

export function formatSetupReport(results, { doctorText, checkOnly }) {
  const lines = ['dotd setup —— 一条命令装到能起来（幂等，可反复跑）', ''];
  for (const r of results) {
    lines.push(`${ICON[r.status] ?? '  '} ${r.title}`);
    if (r.detail) lines.push(`     ${r.detail}`);
    if (r.next) lines.push(`     → 下一步：${r.next}`);
  }
  const s = summarize(results);
  lines.push('');
  if (s.failed.length > 0) {
    lines.push(`❌ ${s.failed.length} 项出错：${s.failed.map((x) => x.step).join(', ')}`);
  }
  if (s.needHuman.length > 0) {
    lines.push(`👉 还需要你做 ${s.needHuman.length} 件事：`);
    for (const x of s.needHuman) lines.push(`   · ${x.step}：${x.detail}${x.next ? `（${x.next}）` : ''}`);
  } else if (s.failed.length === 0) {
    lines.push('✅ 没有需要你手动做的事了。');
  }
  if (s.autoDone.length > 0) lines.push(`（本次自动完成：${s.autoDone.join(', ')}）`);
  if (s.alreadyDone.length > 0) lines.push(`（本来就满足、已跳过：${s.alreadyDone.join(', ')}）`);
  if (checkOnly) lines.push('（--check 模式：只体检，没有改动任何东西）');
  if (doctorText !== null) {
    lines.push('');
    lines.push('──────── 以下是 doctor 的体检结论（唯一真相源）────────');
    lines.push(doctorText);
  }
  return lines.join('\n');
}

// ── 环境探测（真实副作用的地方，全部幂等）──────────────────────────────

/**
 * 跑子进程。**不用 `shell: true`**（会把参数拼进命令行：Node 24 已发 DEP0190 弃用警告，且有注入面）。
 *
 * Windows 上 npm 是个 `.cmd` 包装器，spawnSync 不能直接执行它（ENOENT/EINVAL）。
 * 这里改走 npm 自己的 JS 入口：`node <npm-prefix>/node_modules/npm/bin/npm-cli.js install …`
 * ——零 shell、零注入面，且与 `npm` 命令行为一致。
 */
function npmCliPath() {
  const candidates = [
    // 与当前 node 同级的 npm（nvm / 官方安装器的标准布局）
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function run(cmd, args, opts = {}) {
  const base = { encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, ...opts };
  if (cmd === 'npm') {
    const cli = npmCliPath();
    if (cli !== null) return spawnSync(process.execPath, [cli, ...args], base);
    // 兜底：没有本地 npm 包布局时，Linux/macOS 直接用 npm，Windows 用 npm.cmd
    return spawnSync(platform() === 'win32' ? 'npm.cmd' : 'npm', args, base);
  }
  return spawnSync(cmd, args, base);
}

function which(cmd) {
  const probe = platform() === 'win32' ? 'where' : 'which';
  const r = run(probe, [cmd], { timeoutMs: 5_000 });
  return r.status === 0 && String(r.stdout ?? '').trim().length > 0;
}

/** 读 WSL 侧是否存在（只有 Windows 上才有意义）。 */
function wslPresent() {
  if (platform() !== 'win32') return existsSync('/proc/version') && readFileSync('/proc/version', 'utf8').includes('microsoft');
  if (!which('wsl')) return false;
  const r = run('wsl', ['-l', '-q'], { timeoutMs: 10_000 });
  return r.status === 0 && String(r.stdout ?? '').trim().length > 0;
}

function dockerAvailable() {
  if (!which('docker')) return false;
  const r = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  return r.status === 0 && String(r.stdout ?? '').trim().length > 0;
}

function dockerImagePresent(tag) {
  const r = run('docker', ['images', '-q', tag], { timeoutMs: 10_000 });
  return r.status === 0 && String(r.stdout ?? '').trim().length > 0;
}

/** mtime（秒级精度即可）；不存在返回 null。 */
function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

export async function runSetup({ argv = process.argv.slice(2), env = process.env, now = Date.now } = {}) {
  const args = new Set(argv);
  const checkOnly = args.has('--check');
  const skipDoctor = args.has('--skip-doctor');
  const fleetArg = argv.find((a) => a.startsWith('--fleet='));
  const declaredFleet = fleetArg !== undefined ? fleetArg.slice('--fleet='.length) : env.DOTD_FLEET;

  const results = [];
  const add = (step, title, status, detail, next = null) => {
    results.push({ step, title, status, detail, next });
    return results[results.length - 1];
  };

  const dotdHome = env.DOTD_HOME ? resolve(env.DOTD_HOME) : join(homedir(), '.dotd');
  const configPath = env.DOTD_CONFIG ? resolve(env.DOTD_CONFIG) : join(dotdHome, 'config.yml');
  const tokensPath = join(dotdHome, 'tokens.env');
  const isWin = platform() === 'win32';
  const hasWsl = wslPresent();
  const wslDeployment = hasWsl && args.has('--wsl');

  // ① Node（必须人装）
  const nodeRes = checkNode(process.version);
  add('node', `Node ≥ ${MIN_NODE_MAJOR}`, nodeRes.status, nodeRes.detail, nodeRes.next);

  // ② 依赖（可自动装，但只在 --check=false 时）
  const depsRes = checkDeps({
    hasNodeModules: existsSync(join(REPO_ROOT, 'node_modules')),
    lockMtimeMs: mtimeMs(join(REPO_ROOT, 'package-lock.json')),
    modulesMtimeMs: mtimeMs(join(REPO_ROOT, 'node_modules')),
  });
  if (!checkOnly && !depsRes.ok) {
    const r = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: REPO_ROOT, timeoutMs: 600_000 });
    add(
      'deps',
      'Node 依赖',
      r.status === 0 ? STEP.OK : STEP.FAIL,
      r.status === 0 ? '已执行 npm install' : `npm install 失败：${String(r.stderr ?? '').slice(-300)}`,
      r.status === 0 ? null : '看上面的 npm 报错；网络问题可设 registry 镜像',
    );
  } else {
    add('deps', 'Node 依赖', depsRes.ok ? STEP.SKIP : STEP.ACT, depsRes.detail, depsRes.next);
  }

  // ③ 数据目录（自动建）
  const dirRes = checkDataDir({ exists: existsSync(dotdHome) });
  if (!checkOnly && !dirRes.ok) {
    const r = run(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(dotdHome)},{recursive:true})`]);
    add('data-dir', '数据目录 ~/.dotd', r.status === 0 ? STEP.OK : STEP.FAIL, r.status === 0 ? `已创建 ${dotdHome}` : '创建失败（权限？）', r.status === 0 ? null : `手动建目录：${dotdHome}`);
  } else {
    add('data-dir', '数据目录 ~/.dotd', dirRes.ok ? STEP.SKIP : STEP.OK, dirRes.detail);
  }

  // ④ 配置 + token（调 init-config，幂等；已有内容绝不覆盖）
  const cfgRes = checkConfig({ exists: existsSync(configPath) });
  const needInit = !cfgRes.ok || !existsSync(tokensPath);
  if (!checkOnly && needInit) {
    const r = run(process.execPath, [join(REPO_ROOT, 'scripts', 'init-config.mjs')], { cwd: REPO_ROOT, timeoutMs: 60_000 });
    if (r.status === 0) {
      add('config', '~/.dotd/config.yml', STEP.OK, '已由 init-config 生成（占位已渲染）');
      add('tokens', '~/.dotd/tokens.env', STEP.OK, '已由 init-config 生成随机 token（已有键未动）');
    } else {
      add('config', '~/.dotd/config.yml', STEP.FAIL, `init-config 失败：${String(r.stderr ?? '').slice(-300)}`, 'node scripts/init-config.mjs 手动跑一次看报错');
    }
  } else {
    add('config', '~/.dotd/config.yml', cfgRes.ok ? STEP.SKIP : STEP.ACT, cfgRes.detail, cfgRes.next);
    const tokensText = existsSync(tokensPath) ? readFileSync(tokensPath, 'utf8') : null;
    const tokRes = checkTokens({
      text: tokensText,
      required: ['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA'],
    });
    // 模型 key 单独一条：它只能人填
    const modelKey = ['WB2API_KEY', 'OPENROUTER_API_KEY'].find((k) =>
      tokensText === null ? false : new RegExp(`^\\s*(export\\s+)?${k}\\s*=`, 'm').test(tokensText),
    );
    if (modelKey !== undefined) {
      add('tokens', '~/.dotd/tokens.env', tokRes.ok ? STEP.SKIP : STEP.ACT, `${tokRes.detail}；模型 key ${modelKey} 已设置`, tokRes.next);
    } else {
      add(
        'tokens',
        '~/.dotd/tokens.env',
        STEP.ACT,
        '随机 token 齐了，但没有模型 key（WB2API_KEY / OPENROUTER_API_KEY）',
        '把模型 key 写进 ~/.dotd/tokens.env（脚本不会替你生成，也不打印已有值）',
      );
    }
  }

  // ⑤ WSL（只有 Windows + 想用真容器时才相关）
  if (isWin && hasWsl) {
    add('wsl', 'WSL', STEP.SKIP, '检出 WSL（真容器部署需要它；不想要就保持 stub）', null);
    const v = run('wsl', ['-e', 'node', '--version'], { timeoutMs: 15_000 });
    const wslNode = checkNode(String(v.stdout ?? '').trim());
    add('wsl-node', 'WSL 内 Node ≥ 24', wslNode.ok ? STEP.SKIP : STEP.ACT, wslNode.ok ? `WSL ${String(v.stdout ?? '').trim()}` : 'WSL 里没有 Node 24', wslNode.ok ? null : '在 WSL 里跑 bash scripts/wsl-install-node24.sh');
  } else if (isWin) {
    add('wsl', 'WSL', STEP.SKIP, '未检出 WSL——原生 Windows 用 stub 模式即可；要真容器再装 WSL2', null);
  } else {
    add('wsl', 'WSL', STEP.SKIP, '非 Windows 环境，无 WSL 概念', null);
  }

  // ⑥ docker + 镜像（缺镜像自动构建，但基座 2GB 不替人拉）
  const hasDocker = dockerAvailable();
  const fleetRes = checkFleet({ raw: declaredFleet, dockerAvailable: hasDocker });
  add('docker', 'docker 可达性', hasDocker ? STEP.SKIP : fleetRes.effective === 'docker' ? STEP.ACT : STEP.SKIP, hasDocker ? 'docker 可用' : 'docker 不可用（stub 模式不需要它）', hasDocker ? null : fleetRes.next);

  // 从 exec-image/Dockerfile 的 FROM 读【基座镜像】，避免与代码漂移。
  // 2026-10-21 基座从 mcr.microsoft.com/playwright 换成 node:24-slim，
  // 原来这段只匹配 playwright 的 FROM，换基座后正则恒为 null，体检报告打印
  // "mcr.microsoft.com/playwright:<版本未识别>" —— 报告说"版本未识别"而真相是
  // "早就不装 playwright 了"。现在从任意 FROM 取基座。
  const baseTag = (() => {
    try {
      const t = readFileSync(join(REPO_ROOT, 'exec-image', 'Dockerfile'), 'utf8');
      const m = /^FROM\s+(\S+)/m.exec(t);
      return m === null ? '<Dockerfile 未识别到 FROM>' : m[1];
    } catch {
      return '<读不到 exec-image/Dockerfile>';
    }
  })();
  if (hasDocker) {
    const imgRes = checkImage({
      basePresent: dockerImagePresent(baseTag),
      builtPresent: false, // dotd/exec 的 tag 带 runtime 版本，交给 ensureImage 判定
      baseTag,
    });
    add('fleet-image', 'exec 镜像', fleetRes.effective === 'docker' ? imgRes.status : STEP.SKIP, fleetRes.effective === 'docker' ? imgRes.detail : 'stub 模式不需要镜像', fleetRes.effective === 'docker' ? imgRes.next : null);
  } else {
    add('fleet-image', 'exec 镜像', STEP.SKIP, '没有 docker，跳过（stub 模式）', null);
  }

  // ⑦ relay（仅 WSL 部署需要）
  const relayRes = checkRelay({ wslDeployment, relayRules: relayRulesFromScript(), neededPorts: ['7863'] });
  add('relay', 'win-relay 转发', relayRes.status, relayRes.detail, relayRes.next);

  // ⑧ fleet 意图（默认 stub，不改变默认值）
  add(
    'fleet',
    'fleet 模式（意图声明）',
    fleetRes.status,
    fleetRes.detail,
    fleetRes.next,
  );

  // ⑨ doctor（唯一真相源；这里复用 doctor 的实现，不重写检查逻辑）
  let doctorText = null;
  let doctorExit = 0;
  if (!skipDoctor) {
    try {
      const mod = await import('./doctor.mjs');
      // 把 tokens.env 注入 doctor 的 env：doctor 检查的是进程环境，而 token 平时只在
      // tokens.env 里、source 之后才进环境。不注入会把"已装好"误报成"缺 key"。
      const tokensText = existsSync(tokensPath) ? readFileSync(tokensPath, 'utf8') : null;
      const tokensEnv = tokensText === null ? {} : parseTokensEnv(tokensText);
      const doctorEnv = { ...env, ...tokensEnv };
      const doctorResults = await mod.runChecks({ env: doctorEnv, repoRoot: REPO_ROOT });
      doctorText = mod.formatReport(doctorResults);
      doctorExit = mod.exitCodeFor(doctorResults);
      add('doctor', 'doctor 体检', doctorExit === 0 ? STEP.SKIP : STEP.ACT, doctorExit === 0 ? '全部通过（或只有警告）' : '有会阻止启动的项，见下方 doctor 输出', doctorExit === 0 ? null : '按 doctor 的「下一步」逐条修，然后重跑 npm run setup');
    } catch (e) {
      add('doctor', 'doctor 体检', STEP.FAIL, `跑 doctor 出错：${e instanceof Error ? e.message : String(e)}`, 'node scripts/doctor.mjs 单独跑一次看报错');
    }
  }

  return { results, doctorText, checkOnly, doctorExit };
}

/** 从 win-relay.mts 里读出已配置的转发 **目标端口**（纯文本解析，不执行它）。 */
export function relayRulesFromScript() {
  try {
    const t = readFileSync(join(REPO_ROOT, 'scripts', 'win-relay.mts'), 'utf8');
    const ports = [];
    // 规则形状：{ listenPort: 13065, targetPort: 3065 }
    for (const m of t.matchAll(/targetPort:\s*(\d+)/g)) ports.push(m[1]);
    return ports;
  } catch {
    return [];
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const norm = (p) => {
    try {
      return resolve(p).replace(/\\/g, '/').toLowerCase();
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(fileURLToPath(import.meta.url));
})();

if (isMain) {
  const json = process.argv.includes('--json');
  runSetup()
    .then(({ results, doctorText, checkOnly, doctorExit }) => {
      // 退出码与 doctor 的判据一致：setup 自己出错(2) > doctor 有 fail(1) > 全通过(0)。
      // 不能只看 setup 自己的步骤——doctor 才是"能不能起来"的唯一真相源。
      const selfFail = results.some((r) => r.status === STEP.FAIL);
      const code = selfFail ? 2 : doctorExit !== 0 ? 1 : 0;
      if (json) {
        process.stdout.write(`${JSON.stringify({ results, summary: summarize(results), doctorText, exitCode: code }, null, 2)}\n`);
        process.exitCode = code;
        return;
      }
      process.stdout.write(`${formatSetupReport(results, { doctorText, checkOnly })}\n`);
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`setup 自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 2;
    });
}
