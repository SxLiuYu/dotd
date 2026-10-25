#!/usr/bin/env node
/**
 * scripts/doctor.mjs —— `npm run doctor`：上线前体检。
 *
 * 为什么要有它：README「已知限制」里最贵的一类坑都是**静默失败**——
 *   - `DOTD_FLEET=Docker`（大小写错）或 `docker`（想开真容器但拼错）会**静默回落 stub**，
 *     daemon 正常起、任务正常跑完，只是所有工具执行都是假的（src/exec/types.ts 的
 *     execConfigFromEnv 只认精确的 'stub'/'docker'）。
 *   - `DOTD_MODEL_TRANSPORT` 未设 = **真实 HTTP**（与 DOTD_FLEET 的缺省正好相反）。
 *   - tier1 的 key 只存在于启动它的那个 shell 里，daemon 重启即 tier1 全灭，
 *     现象是"daemon 正常起、所有交互任务挂起"。
 *   - 字面量 `${VAR}` 没展开、路径写错、DB 版本落后——全都是"看起来跑起来了"。
 *
 * 设计原则：
 *   1. **只读**。不写配置、不改库、不起容器、不发模型请求（连续性探测只做 TCP 连接）。
 *   2. 每一项都给「人话结论 + 下一步命令」，而不是抛异常。
 *   3. 退出码：0 = 全部通过或只有 warn；1 = 有 fail（照这份配置起 daemon 会出问题）。
 *
 * 用法：
 *   npm run doctor
 *   node scripts/doctor.mjs            # 同上
 *   node scripts/doctor.mjs --json     # 机器可读（CI / 诊断脚本用）
 *
 * cwd 无关：一切仓库内路径从本文件位置推导。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { layeredEnv, resolveConfigDir as resolveConfigDirShared } from './lib/env.mjs';
import { looksLikePath, resolveCommand as resolveCommandShared } from './lib/command.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const MIN_NODE_MAJOR = 24;

/** 结果档位：ok / warn / fail / skip。fail 才会让退出码变 1。 */
export const STATUS = Object.freeze({ OK: 'ok', WARN: 'warn', FAIL: 'fail', SKIP: 'skip' });

/**
 * **严格展开**的环境变量（缺席即 ConfigError 拒启动）。
 * 出处：src/surfaces/config.ts 的 expandEnv 调用点——master_token / readonly_tokens /
 * hooks[].secret 三处走 strict:true；memory 展开恒严格。
 * 其余（TG_BOT_TOKEN、FEISHU_* 六字段等）是 strict:false，未设置 → 空串 → daemon 照常起。
 * 这张表就是 doctor 判"缺 key 会拒启动"的唯一依据，**与实现同源**，不要凭印象加项。
 *
 * `DOTD_DB_PATH` **不在**这张表里（2026-10-26 改正）。它曾经在，理由是
 * config.yml 的 `db.path: ${DOTD_DB_PATH}`。但那一行**根本没人读**：
 * `loadSurfacesConfig` 只解析 `surfaces:` 节，`db:` 节连解析入口都没有；
 * 真正的库路径由 `db/conn.ts` 的 `resolveDbPath()` 直接读 `process.env`，
 * 缺了就回落到 `~/.dotd/dotd.db`——不是 fail-closed。
 * 实测（live）：`env -u DOTD_DB_PATH` + 三个令牌齐全 → `loaded OK port=7788`。
 * 把它留在表里等于声称"缺了会拒启动"，于是每台正常机器上都挂着一条假 ❌。
 */
export const STRICT_ENV_KEYS = Object.freeze(
  new Set(['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA']),
);

/**
 * 配置目录：与 `src/daemon.ts` 的 `resolveConfigDir()` **同一判据**。
 *
 * ```ts
 * export function resolveConfigDir(): string {
 *   const env = process.env.DOTD_CONFIG_DIR;
 *   if (env !== undefined && env.length > 0) return resolve(expandHome(env));
 *   return join(REPO_ROOT, 'config');
 * }
 * ```
 *
 * 这个函数存在的理由（2026-10-26）：doctor 原来写死 `repoRoot/config`，
 * 而托管部署（one_system）会把 `DOTD_CONFIG_DIR` 设成 `~/.dotd` ——
 * 两边看的不是同一个文件，doctor 的结论与 daemon 的行为无关。
 * 显式传 env / repoRoot 是为了测试能造世界；生产调用不传即取 process.env。
 *
 * 实现已挪到 `scripts/lib/env.mjs`（`onboard` / `probe-live-model` 也要用同一判据，
 * 三份各写一遍必然漂移）。这里保留同名导出，老调用方与测试不用改。
 */
export function resolveConfigDir(env = process.env, repoRoot = REPO_ROOT) {
  return resolveConfigDirShared({ env, repoRoot, home: homedir() });
}

/**
 * 体检项清单（导出给 tests/scripts-doctor.test.ts 做结构断言：
 * 名字/顺序/必查项都是契约的一部分，删一项就该有测试红）。
 */
export const CHECKS = Object.freeze([
  'node',
  'repo',
  'surfaces-config',
  'placeholders',
  'fleet',
  'model-transport',
  'tier1-endpoint',
  'tier1-key',
  'db',
  'home-dir',
  'mcp',
]);

// ── 工具 ────────────────────────────────────────────────────────────────

/**
 * 把 `DOTD_FLEET` 的原始值判成"实际生效值"。
 *
 * 与 src/exec/types.ts 的 `execConfigFromEnv` 必须**逐字同义**：
 * 只有精确等于 'stub' / 'docker' 才覆盖，其余（含未设）一律回落 'stub'。
 * 刻意拼成一个纯函数，好让测试直接把真值表跑一遍。
 */
export function resolveFleet(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw);
  if (v === 'stub') return { effective: 'stub', raw: v, warn: null };
  if (v === 'docker') return { effective: 'docker', raw: v, warn: null };
  if (v === '') {
    return {
      effective: 'stub',
      raw: '',
      warn:
        'DOTD_FLEET 未设置 → 实际生效 stub（不起容器）。想跑真容器必须显式设 DOTD_FLEET=docker。' +
        '这是本项目最容易误解的一处：模型传输的缺省是"真"，fleet 的缺省是"假"。',
    };
  }
  return {
    effective: 'stub',
    raw: v,
    warn:
      `DOTD_FLEET='${v}' 不是精确的 'stub'/'docker'，已被**静默忽略**并回落 stub。` +
      '拼写（大小写）错了就白配了：改成 DOTD_FLEET=docker 并重启。',
  };
}

/** 同理：`DOTD_MODEL_TRANSPORT` 只有 'stub' 走内存 stub，其余（含未设）= 真实 HTTP。 */
export function resolveModelTransport(raw) {
  const v = raw === undefined || raw === null ? '' : String(raw);
  if (v === 'stub') return { effective: 'stub', raw: v };
  return { effective: 'real-http', raw: v };
}

/**
 * 去掉 YAML 标量两端的引号。
 *
 * 与 `src/router/config.ts` 的 `scalar()` 同口径（2026-10-26）。doctor 原来直接拿
 * 正则抓到的原文当值：`base_url: "http://…/v1"` 会被判成「不是合法 URL」，
 * 而 router 解析同一行时早就把引号去掉了 —— 配置完全合法，红的是体检。
 * 这类「体检和真正的解析器读法不一致」与本节其它几条是同一个形状。
 */
function unquote(v) {
  const t = String(v).trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 从极简 YAML 文本里抠出 tier1 端点（不引第三方 YAML：doctor 必须零依赖可跑）。 */
export function parseTier1Endpoint(text) {
  const lines = String(text).split(/\r?\n/);
  let inEndpoints = false;
  let cur = null;
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (/^endpoints:\s*$/.test(line)) {
      inEndpoints = true;
      continue;
    }
    if (inEndpoints && /^\S/.test(line)) break; // 顶层键结束 endpoints 段
    if (!inEndpoints) continue;
    const idM = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idM !== null) {
      if (cur !== null) out.push(cur);
      cur = {
        id: unquote(idM[1]),
        tier: null,
        baseUrl: null,
        apiKeyEnv: null,
        enabled: true,
        primaryModel: null,
      };
      continue;
    }
    if (cur === null) continue;
    const kv = (k) => {
      const m = new RegExp(`^\\s+${k}:\\s*(.+?)\\s*$`).exec(line);
      return m === null ? null : unquote(m[1]);
    };
    const tier = kv('tier');
    if (tier !== null) cur.tier = Number(tier);
    const burl = kv('base_url');
    if (burl !== null) cur.baseUrl = burl;
    const keyEnv = kv('api_key_env');
    if (keyEnv !== null) cur.apiKeyEnv = keyEnv;
    const en = kv('enabled');
    if (en !== null) cur.enabled = en !== 'false';
    const prim = /^\s+primary:\s*(\S+)\s*$/.exec(line);
    if (prim !== null && cur.primaryModel === null) cur.primaryModel = unquote(prim[1]);
  }
  if (cur !== null) out.push(cur);
  return out.filter((e) => e.tier === 1);
}

/**
 * 展开 `${VAR}` / `${VAR:-默认}`。**占位符可以嵌在值中间**（2026-10-25 修）：
 * models.yml 现在写的是 `${DOTD_MODEL_HOST:-http://127.0.0.1:3065}/v1`，
 * 旧实现只认"整个值恰好是一个占位符"，于是把带后缀的合法写法判成"不是合法 URL"，
 * 体检直接红 —— 那是体检脚本没跟上配置写法，不是配置有问题。
 * 与 src/router/config.ts 的 expandEnvText 同语义（同一份文件，两边都得认）。
 *
 * 返回值里的 `usedFallback` 是 2026-10-26 加的：**用了默认值**这件事必须让调用方
 * 知道，否则又是"体检看错地方"。
 *   live 上 `wsl-daemon.sh` 导出 `DOTD_MODEL_HOST=http://172.17.48.1:13065` 给
 *   daemon（网关 relay）；而 doctor 在裸 shell 里跑，那里没有这个变量，于是按
 *   默认值 `127.0.0.1:3065` 去探测——不通，报「网关没起」。而同一时刻 daemon
 *   正用 relay 正常出字。默认值是"猜测"，猜出来的红不能当结论。
 */
export function expandWithDefault(value, env) {
  const raw = String(value);
  if (!raw.includes('${')) return { value, resolved: true, usedFallback: false };
  const missing = [];
  let usedFallback = false;
  const out = raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}\n]*))?\}/g,
    (_whole, name, fallback) => {
      const actual = env[name];
      if (actual !== undefined && actual !== '') return actual;
      if (fallback !== undefined) {
        usedFallback = true;
        return fallback;
      }
      missing.push(name);
      return '';
    },
  );
  if (missing.length > 0) {
    return { value: out, resolved: false, missing: missing.join(', '), usedFallback };
  }
  return { value: out, resolved: true, usedFallback };
}

/** TCP 连通性探测（不握手、不发请求）：连上即通。 */
function probeTcp(host, port, timeoutMs = 1_500) {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    const sock = connect({ host, port });
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolveProbe({ ok, detail, latencyMs: Date.now() - started });
    };
    sock.setTimeout(timeoutMs, () => done(false, `${timeoutMs}ms 内连不上`));
    sock.once('connect', () => done(true, 'TCP 可连'));
    sock.once('error', (e) => done(false, e.code ?? e.message));
  });
}

// ── 体检主体 ────────────────────────────────────────────────────────────

/**
 * 跑全部体检项。**纯只读**；依赖全部显式传入，便于测试。
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]  环境变量（缺省 process.env）
 * @param {string} [opts.home]                          用户 home（缺省 os.homedir()）
 * @param {string} [opts.repoRoot]                      仓库根
 * @param {(host:string, port:number, ms:number)=>Promise<{ok:boolean,detail:string,latencyMs:number}>} [opts.probe]
 * @returns {Promise<Array<{name:string,status:string,title:string,detail:string,next:string|null}>>}
 */
export async function runChecks(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const probe = opts.probe ?? probeTcp;
  const results = [];
  const add = (name, status, title, detail, next = null) => {
    results.push({ name, status, title, detail, next });
  };

  // 1. Node 版本（Node 24 的 node:sqlite / 原生 ESM 是硬要求，见 CONVENTIONS §1）
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    add('node', STATUS.OK, `Node v${process.versions.node}`, `满足 >= ${MIN_NODE_MAJOR}`);
  } else {
    add(
      'node',
      STATUS.FAIL,
      `Node v${process.versions.node} 太旧`,
      `本项目用内置 node:sqlite 与原生 ESM type-stripping，硬要求 >= ${MIN_NODE_MAJOR}`,
      '升级 Node 24（scripts/wsl-install-node24.sh 或 nodejs.org）后重跑',
    );
  }

  // 2. 仓库完整性：入口与模板是否都在（clone 不全时最常见的报错源）
  const required = [
    'package.json',
    'tsconfig.json',
    'src/daemon.ts',
    'src/surfaces/cli.ts',
    'config/dotd.yml',
    'config/models.yml',
    'db/migrations',
    'agent-runtime',
    'exec-image/Dockerfile',
  ];
  const missing = required.filter((p) => !existsSync(join(repoRoot, p)));
  if (missing.length === 0) {
    add('repo', STATUS.OK, '仓库文件齐全', `${required.length} 项必需路径都在`);
  } else {
    add(
      'repo',
      STATUS.FAIL,
      `仓库缺 ${missing.length} 项`,
      missing.join(', '),
      '重新 clone 或检查是否在子目录里跑（doctor 会自己推导仓库根，不用 cd）',
    );
  }

  // 3. surfaces 配置：daemon 只读 ~/.dotd/config.yml，仓库里的 config/dotd.yml 只是模板
  const cfgPath = env.DOTD_CONFIG !== undefined && env.DOTD_CONFIG !== ''
    ? env.DOTD_CONFIG
    : join(home, '.dotd', 'config.yml');
  // tokens.env 的 key 集合（只看键名/有没有值，不打印值）。用途见第 4 项：
  // 一键启动（charlie:start / wsl-daemon.sh）会 source 它，裸 `npm run serve` 不会。
  const tokens = layeredEnv({
    home: env.DOTD_HOME !== undefined && env.DOTD_HOME !== '' ? env.DOTD_HOME : join(home, '.dotd'),
    homedir: home,
    processEnv: {},
  });
  let cfgText = '';
  if (!existsSync(cfgPath)) {
    add(
      'surfaces-config',
      STATUS.FAIL,
      `读不到 ${cfgPath}`,
      'daemon 只从这份文件读 surfaces 七节；仓库里的 config/dotd.yml 是模板，不会被自动加载',
      'npm run init-config（幂等，不会覆盖已有的真 token）',
    );
  } else {
    cfgText = readFileSync(cfgPath, 'utf8');
    add('surfaces-config', STATUS.OK, `${cfgPath}`, `${cfgText.length} 字节，存在`);
  }

  // 4. 占位符展开：master_token 这类走严格展开，未设置即 ConfigError 拒启动
  if (cfgText !== '') {
    // 只看**没有默认值**的占位符：`${VAR:-默认}` 在变量缺席时会用默认值，不算缺。
    // 另外被整行 `#` 注释掉的说明文字不算（init-config 生成的配置里带注释块，
    // 注释里常出现 `${VAR}` 作为示例，数进来会误报）。
    // 非严格展开的键（tg_text / feishu 六字段 / data_dir 一类）**未设置是合法的**：
    // src/surfaces/config.ts 里它们用 strict:false，缺席即空串，daemon 照常启动。
    // 所以判"缺"要两个条件同时成立：没有默认值 **且** 在严格展开清单里。
    const codeLines = cfgText
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const placeholders = [...codeLines.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)];
    const strict = placeholders.filter((m) => m[2] === undefined && STRICT_ENV_KEYS.has(m[1]));
    // 判定分三档，不能只问"进程环境里有没有"（2026-10-26 现场）：
    //
    //   live 上 3 个严格占位符（MASTER/RO/HOOK）都在 `~/.dotd/tokens.env` 里，
    //   daemon 由 `charlie:start` / `wsl-daemon.sh` 拉起时**会 source 它**、跑得好好的；
    //   而 `npm run doctor` 在裸 shell 里跑，`process.env` 是空的，于是报
    //   「4 个严格占位符在环境里没有值」——**体检看错了地方**。
    //
    //   但反过来直接"文件里有就算有"也是错的：`npm run serve` 直接起 daemon 时
    //   **没有人 source tokens.env**，那时它真的会 fail-closed 拒启动。
    //
    // 所以：环境里有 → OK；只在文件里 → WARN（当前 shell 起不来，但一键启动没问题）；
    // 两处都没有 → FAIL（怎么办都不行）。
    const fromEnv = (n) => env[n] !== undefined && env[n] !== '';
    const missingHere = strict.map((m) => m[1]).filter((n) => !fromEnv(n));
    const uniqueMissing = [...new Set(missingHere)];
    const onlyInFile = uniqueMissing.filter((n) => tokens.has(n));
    const nowhere = uniqueMissing.filter((n) => !tokens.has(n));
    if (uniqueMissing.length === 0) {
      add(
        'placeholders',
        STATUS.OK,
        '配置里的严格占位符都能展开',
        `共 ${placeholders.length} 处占位符，其中 ${strict.length} 处严格（无默认值且不可缺省）`,
      );
    } else if (nowhere.length === 0) {
      add(
        'placeholders',
        STATUS.WARN,
        `${onlyInFile.length} 个严格占位符只在 tokens.env 里（当前 shell 里没有）`,
        `${onlyInFile.join(', ')} ← ${tokens.files.filter((p) => existsSync(p)).join(' / ')}`,
        `直接 \`npm run serve\` 会拒启动（它不 source tokens.env）；用 \`npm run charlie:start\` 或先 \`set -a; . ~/.dotd/tokens.env; set +a\``,
      );
    } else {
      add(
        'placeholders',
        STATUS.FAIL,
        `${nowhere.length} 个严格占位符在环境里和 tokens.env 里都没有值`,
        nowhere.join(', '),
        `写进 ~/.dotd/tokens.env（set -a; . ~/.dotd/tokens.env; set +a 后再起 daemon），或对一次性启动用环境变量`,
      );
    }
  } else {
    add('placeholders', STATUS.SKIP, '跳过占位符检查', '没有可读的 config.yml');
  }

  // 5. DOTD_FLEET：最容易静默出错的一项
  const fleet = resolveFleet(env.DOTD_FLEET);
  if (fleet.warn === null) {
    add('fleet', STATUS.OK, `DOTD_FLEET=${fleet.raw} → ${fleet.effective}`, fleet.effective === 'docker' ? '真容器路径（需要 docker daemon 可达）' : '不起容器');
  } else {
    add('fleet', STATUS.WARN, 'DOTD_FLEET 实际生效值让人意外', fleet.warn, 'export DOTD_FLEET=docker（或明确留空表示就用 stub）后再起 daemon');
  }

  // 6. DOTD_MODEL_TRANSPORT：缺省是"真 HTTP"，与 fleet 相反
  const mt = resolveModelTransport(env.DOTD_MODEL_TRANSPORT);
  add(
    'model-transport',
    STATUS.OK,
    `DOTD_MODEL_TRANSPORT=${mt.raw === '' ? '（未设）' : mt.raw} → ${mt.effective}`,
    mt.effective === 'stub' ? '模型走内存 stub，零网络请求（门禁/演示用）' : '真 HTTP（会打 models.yml 里的端点）',
  );

  // 7/8. tier1 端点：这是唯一能承载 primary 轨的端点，断了所有交互任务都挂起
  //
  // 路径必须与 daemon 同源（2026-10-26，与上面 MCP 那条是同一个缺陷）：
  // ModelRouter 读的是 `join(cfg.configDir, 'models.yml')`，而 configDir 就是
  // `resolveConfigDir()`。托管部署里那是 `~/.dotd/models.yml`。doctor 原来写死
  // 仓库那份 —— 而 models.yml 从 2026-10-25 起是**热加载**的：主人改的是
  // `~/.dotd/models.yml`（改完不用重启就生效），doctor 却去看仓库模板。
  // 于是「端点被改坏 / enabled 被关」这种事，daemon 那边已经在用坏配置，
  // doctor 这边还报 ok —— 体检看的是一份没人读的文件。
  let tier1 = null;
  let tier1Disabled = null;
  const modelsPath = join(resolveConfigDir(env, repoRoot), 'models.yml');
  const repoModels = join(repoRoot, 'config', 'models.yml');
  if (existsSync(modelsPath)) {
    const endpoints = parseTier1Endpoint(readFileSync(modelsPath, 'utf8'));
    // **不要** `?? endpoints[0]` 兜底（2026-10-26 去掉）：tier1 全被 `enabled: false`
    // 时，路由器的 `pickCandidates` 过滤后一个候选都没有 —— primary 轨真的无处可去。
    // 原来兜底到第一个（被禁用的）端点去探测，探通了就报 ok：「配置里唯一的主端点
    // 被关掉了」这件最该拦住的事，被一个"反正有个地址能连"掩盖了。
    tier1 = endpoints.find((e) => e.enabled) ?? null;
    if (tier1 === null && endpoints.length > 0) tier1Disabled = endpoints[0];
  }
  if (tier1 === null && tier1Disabled !== null) {
    add(
      'tier1-endpoint',
      STATUS.FAIL,
      `${modelsPath} 的 tier1 端点全部 enabled: false`,
      `${tier1Disabled.id} 存在但被关着 —— 路由器选候选时会把它过滤掉，primary 轨没有任何端点可用，` +
        '所有交互任务都会挂起',
      `把 ${modelsPath} 里该端点的 enabled 改成 true`,
    );
  } else if (tier1 === null || tier1.baseUrl === null) {
    const extra =
      modelsPath !== repoModels && existsSync(repoModels)
        ? `（仓库模板 ${repoModels} 存在，但 daemon 不读它）`
        : '';
    add(
      'tier1-endpoint',
      STATUS.FAIL,
      `${modelsPath} 里没有可用的 tier1 端点`,
      `primary 轨无处可去，所有交互任务都会挂起${extra}`,
      `检查 ${modelsPath} 的 endpoints[].tier: 1`,
    );
  } else {
    const expanded = expandWithDefault(tier1.baseUrl, env);
    if (!expanded.resolved) {
      add('tier1-endpoint', STATUS.FAIL, `tier1 base_url 的占位符 ${expanded.missing} 没有值`, tier1.baseUrl, `export ${expanded.missing}=...`);
    } else {
      let url = null;
      try {
        url = new URL(expanded.value);
      } catch {
        url = null;
      }
      if (url === null) {
        add('tier1-endpoint', STATUS.FAIL, `tier1 base_url 不是合法 URL：${expanded.value}`, '解析失败', '改成 http(s)://host:port/v1 形式');
      } else {
        const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
        const host = url.hostname;
        const r = await probe(host, port, 1_500);
        if (r.ok) {
          add('tier1-endpoint', STATUS.OK, `${tier1.id} ${expanded.value}`, `${r.detail}（${r.latencyMs}ms）`);
        } else if (expanded.usedFallback) {
          // 探的是 models.yml 的**默认值**，不是这个 shell 里配的地址 —— 探不通
          // 说明不了"网关没起"（live 上真网关在 relay 的 13065，daemon 一直通着）。
          // 判 WARN 并说清楚"我探的是哪个值、它从哪来"。
          add(
            'tier1-endpoint',
            STATUS.WARN,
            `${tier1.id} 的默认地址 ${host}:${port} 连不上（本次用的是默认值）`,
            `${tier1.baseUrl} 展开为 ${expanded.value}；${r.detail}。如果你用一键启动（wsl-daemon.sh / charlie:start），它可能导出过别的地址，daemon 用的不是这个。`,
            `设 DOTD_MODEL_HOST/对应变量后再跑本项，或确认网关确实起在 ${host}:${port}（docs/tier1-endpoint.md）`,
          );
        } else {
          add(
            'tier1-endpoint',
            STATUS.FAIL,
            `${tier1.id} 连不上 ${host}:${port}`,
            r.detail,
            '先把网关起起来（docs/tier1-endpoint.md 有搭建步骤），或改 models.yml 换端点',
          );
        }
      }
    }

    // 8. key：有端点却没凭据 = 每次请求都失败、计入熔断，现象是"daemon 正常起、任务全不干活"
    const keyEnv = tier1.apiKeyEnv;
    if (keyEnv === null || keyEnv === undefined) {
      add('tier1-key', STATUS.OK, 'tier1 端点未声明 api_key_env', '免 key 端点（本地引擎）');
    } else if (env[keyEnv] !== undefined && env[keyEnv] !== '') {
      add('tier1-key', STATUS.OK, `${keyEnv} 已设置`, `长度 ${String(env[keyEnv]).length}（值不打印）`);
    } else if (tokens.has(keyEnv)) {
      // 同一类"看错地方"（2026-10-26）：live 上 HY3_API_KEY 在 tokens.env 里，
      // 一键启动会 source 它，模型一路正常；裸 shell 里跑 doctor 却说"环境里没有"。
      // 但只报 WARN 不报 OK：`npm run serve` 直接起时确实拿不到这个 key。
      add(
        'tier1-key',
        STATUS.WARN,
        `${keyEnv} 只在 tokens.env 里（当前 shell 里没有）`,
        `来源 ${tokens.sources[keyEnv] ?? 'tokens.env'}（值不打印）`,
        '一键启动（npm run charlie:start / wsl-daemon.sh）没问题；要让裸 `npm run serve` 也带上，先 set -a; . ~/.dotd/tokens.env; set +a',
      );
    } else {
      add(
        'tier1-key',
        STATUS.FAIL,
        `环境里没有 ${keyEnv}`,
        '缺 key 不是启动期错误，但运行期请求会失败并计入熔断；tier1 是唯一能承载 primary 的端点',
        `把 export ${keyEnv}=... 写进 ~/.dotd/tokens.env，这样 daemon 重启后不会丢`,
      );
    }
  }

  // 9. 数据库：迁移版本是否跟上（落后 → daemon 拒启动；这是 fail-closed，但报错很难懂）
  const dbPath = env.DOTD_DB_PATH !== undefined && env.DOTD_DB_PATH !== ''
    ? env.DOTD_DB_PATH
    : join(home, '.dotd', 'dotd.db');
  if (!existsSync(dbPath)) {
    add('db', STATUS.WARN, `库文件还不存在：${dbPath}`, '首次启动会自动建库并迁移', '直接 npm run serve 即可');
  } else {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('PRAGMA user_version').get();
      db.close();
      const version = row?.user_version ?? 0;
      const expected = expectedUserVersion(repoRoot);
      if (expected === null) {
        add('db', STATUS.WARN, `user_version=${version}`, '算不出期望版本（db/migrations 缺失？）');
      } else if (version === expected) {
        add('db', STATUS.OK, `user_version=${version}`, `与 db/migrations 最高版本一致（${expected}）`);
      } else {
        add(
          'db',
          STATUS.WARN,
          `user_version=${version}，期望 ${expected}`,
          version < expected ? '落后：daemon 启动时会自动迁移（会先写 OUTBOX）' : '超前：这份代码比库旧',
          version < expected ? '直接 npm run serve 触发迁移' : '更新代码，或换回旧库',
        );
      }
    } catch (e) {
      add('db', STATUS.WARN, `读库失败：${dbPath}`, e instanceof Error ? e.message : String(e), '确认没有别的 daemon 正占着这个库');
    }
  }

  // 10. 数据目录可写性（不写，只看权限位/存在性）
  const dotdHome = env.DOTD_HOME !== undefined && env.DOTD_HOME !== '' ? env.DOTD_HOME : join(home, '.dotd');
  if (existsSync(dotdHome)) {
    add('home-dir', STATUS.OK, dotdHome, '数据目录存在（OUTBOX/journal-blobs/tokens 都在这下面）');
  } else {
    add('home-dir', STATUS.WARN, `${dotdHome} 还不存在`, '首次启动会创建', 'npm run serve');
  }

  // 11. MCP 外部工具（P2-1）：声明了 server 但 command 找不到 = 每次调用都失败，
  //     而失败只在"任务跑到那一步"时才暴露——正是 doctor 该提前拦下的那类坑。
  //     未声明任何 server 时显示"未启用"，**不制造噪音**（默认配置下用户不该被提醒）。
  //
  //     路径必须与 daemon 同源（2026-10-26 修）。daemon 读的是
  //     `process.env.DOTD_MCP_CONFIG ?? join(cfg.configDir, 'mcp-servers.yml')`，
  //     而 `resolveConfigDir()` = `DOTD_CONFIG_DIR` 或 `repoRoot/config`。
  //     原来 doctor 写死 `repoRoot/config/mcp-servers.yml`：在托管部署里
  //     supervisor 会把 `DOTD_CONFIG_DIR` 设成 `~/.dotd`，**真正生效的是那一份**，
  //     于是 doctor 检查的是仓库模板 —— 用户在 `~/.dotd` 里配好了 server，
  //     doctor 说"未启用"；用户把仓库模板改坏了，doctor 报 fail 而那文件没人读。
  //     两份都在时以 daemon 会读的那份为准，并顺带提示另一份是模板。
  const mcpPath =
    env.DOTD_MCP_CONFIG !== undefined && env.DOTD_MCP_CONFIG !== ''
      ? env.DOTD_MCP_CONFIG
      : join(resolveConfigDir(env, repoRoot), 'mcp-servers.yml');
  const repoMcp = join(repoRoot, 'config', 'mcp-servers.yml');
  if (!existsSync(mcpPath)) {
    const extra =
      mcpPath !== repoMcp && existsSync(repoMcp)
        ? `（仓库模板 ${repoMcp} 存在，但 daemon 不读它）`
        : '';
    add('mcp', STATUS.SKIP, '未启用', `没有 ${mcpPath}（MCP 外部工具默认关闭）${extra}`);
  } else {
    const parsed = parseMcpServers(readFileSync(mcpPath, 'utf8'));
    // 顺序要紧：**先判错误**再判"有没有声明"。写错的配置在解析失败时 servers 也是空的，
    // 若先看 length===0 就会把"配置写错了"误报成"未启用"——那正是最该拦下的情况。
    if (parsed.error !== null) {
      add(
        'mcp',
        STATUS.FAIL,
        `MCP 配置写错了：${parsed.error}`,
        mcpPath,
        `照仓库 config/mcp-servers.yml 顶部的模板改 ${mcpPath}：每个 server 必填 name 与 command`,
      );
    } else if (parsed.servers.length === 0) {
      add('mcp', STATUS.SKIP, '未启用', `${mcpPath} 里没有声明任何 server（servers: []）`);
    } else {
      // 逐个核对：command 能否解析到 + args 里的脚本路径是否存在
      const bad = [];
      for (const s of parsed.servers) {
        const cmd = resolveCommand(s.command, { env, repoRoot });
        if (cmd === null) {
          bad.push({ server: s.name, why: `command 找不到：${s.command}` });
          continue;
        }
        const missingArg = s.args.find((a) => looksLikePath(a) && !existsSync(resolve(repoRoot, a)));
        if (missingArg !== undefined) {
          bad.push({ server: s.name, why: `args 里的文件不存在：${missingArg}` });
        }
      }
      if (bad.length === 0) {
        add(
          'mcp',
          STATUS.WARN,
          `已声明 ${parsed.servers.length} 个 MCP server`,
          `${parsed.servers.map((s) => s.name).join(', ')}——**每次调用都会走 dangerous 档人工审批**，` +
            'server 是宿主上运行的任意程序，只声明你信任的',
          '不需要时把该文件改回 servers: []',
        );
      } else {
        add(
          'mcp',
          STATUS.FAIL,
          `${bad.length} 个 MCP server 起不来`,
          bad.map((b) => `${b.server}：${b.why}`).join('; '),
          `改 ${mcpPath} 的 command/args（用绝对路径或确保在 PATH 里），然后重跑 npm run doctor`,
        );
      }
    }
  }

  return results;
}

/**
 * 极简解析 mcp-servers.yml（与 src/exec/mcp-config.ts 同口径的**只读**版本）。
 *
 * 为什么不 import 那个 TS 模块：doctor 是 `.mjs`，跑在**没有 tsx 的裸 node** 下
 * （这正是它存在的意义——装不起来的时候也能诊断）。所以这里独立实现一份最小的，
 * 只取 doctor 需要的 name/command/args；解析失败不抛，改为回报 error 字符串。
 *
 * @returns {{servers: Array<{name:string,command:string,args:string[]}>, error: string|null}}
 */
export function parseMcpServers(text) {
  const servers = [];
  let cur = null;
  /** `args:` / `allow_tools:` 后换行写块列表时，记下键与 `:` 所在行的缩进。 */
  let listKey = null;
  let listIndent = -1;
  const resetBlocks = () => {
    listKey = null;
    listIndent = -1;
  };
  const clean = (raw) => {
    let v = String(raw).trim();
    if (!(v.startsWith('"') || v.startsWith("'"))) {
      const hash = v.indexOf(' #');
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  };
  const inlineList = (raw) => {
    const v = clean(raw);
    if (!v.startsWith('[') || !v.endsWith(']')) return [];
    const inner = v.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(',').map(clean).filter((x) => x.length > 0);
  };
  const flush = () => {
    if (cur === null) return;
    if (cur.name.length === 0) throw new Error('某个 server 缺 name');
    if (cur.command.length === 0) throw new Error(`server ${cur.name} 缺 command`);
    servers.push(cur);
    cur = null;
  };
  try {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\t/g, '  ');
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) continue; // 顶层键（servers:）

      // 块列表项：**先于**"新 server"判断（2026-10-26 修）。
      //
      // 仓库自带的 config/mcp-servers.voice.yml 把 allow_tools 写成换行块列表，
      // 而文档让人 `cp` 它过来启用。旧实现把 `- goodnight` 当成**下一个 server**，
      // 于是 name 为空 → 「某个 server 缺 name」→ doctor 报"配置写错"，
      // 真正的 daemon 更是**拒启动**。两份解析器必须同口径。
      if (listKey !== null && cur !== null) {
        if (indent > listIndent && trimmed.startsWith('-')) {
          const item = clean(trimmed.slice(1).trim());
          if (item.length > 0) {
            if (listKey === 'args') cur.args.push(item);
            // allow_tools：doctor 不检查工具名，但必须**吃掉**这些行，不能当成新 server
          }
          continue;
        }
        resetBlocks();
      }

      if (trimmed.startsWith('- ')) {
        flush();
        cur = { name: '', command: '', args: [] };
        resetBlocks();
        applyMcpField(cur, trimmed.slice(2).trim(), clean, inlineList, (k) => {
          listKey = k;
          listIndent = indent;
        });
        continue;
      }
      if (cur === null) continue;
      applyMcpField(cur, trimmed, clean, inlineList, (k) => {
        listKey = k;
        listIndent = indent;
      });
    }
    flush();
    return { servers, error: null };
  } catch (e) {
    return { servers: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 应用一个 `key: value`。遇到"键后面是空值"（`args:` / `allow_tools:`）时调用
 * `openList(key)`，告诉调用方接下来更深缩进的 `- item` 属于这个键。
 */
function applyMcpField(spec, line, clean, inlineList, openList) {
  const colon = line.indexOf(':');
  if (colon <= 0) return;
  const key = line.slice(0, colon).trim();
  const val = line.slice(colon + 1).trim();
  if (key === 'name') spec.name = clean(val);
  else if (key === 'command') spec.command = clean(val);
  else if (key === 'args' || key === 'allow_tools') {
    // 其余（timeout_ms / env）doctor 不需要，忽略；这两个必须认，因为它们的
    // 块列表写法会把行喂进循环，认不出来就会把 `- xxx` 当成新 server。
    if (val.length === 0) {
      if (key === 'args') spec.args = [];
      openList(key);
      return;
    }
    if (key === 'args') spec.args = inlineList(val);
  }
}

/**
 * 解析 command 到绝对路径；找不到返回 null。实现见 `scripts/lib/command.mjs`
 * （voice-check 也用同一份：同一条判据不许有两套答案）。
 */
export function resolveCommand(command, opts) {
  return resolveCommandShared(command, opts);
}

/** 从 db/migrations 的 NNN_ 前缀算期望 user_version；目录缺失返回 null。 */
export function expectedUserVersion(repoRoot) {
  const dir = join(repoRoot, 'db', 'migrations');
  if (!existsSync(dir)) return null;
  const nums = [];
  for (const f of readdirSyncSafe(dir)) {
    const m = /^(\d{3})_.*\.sql$/.exec(f);
    if (m !== null) nums.push(Number(m[1]));
  }
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── 呈现 ────────────────────────────────────────────────────────────────

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

export function formatReport(results) {
  const lines = ['dotd doctor —— 上线前体检（只读，不改任何东西）', ''];
  for (const r of results) {
    lines.push(`${ICON[r.status] ?? '  '} ${r.title}`);
    if (r.detail !== '' && r.detail !== null) lines.push(`     ${r.detail}`);
    if (r.next !== null && r.next !== undefined) lines.push(`     → 下一步：${r.next}`);
  }
  const fail = results.filter((r) => r.status === STATUS.FAIL).length;
  const warn = results.filter((r) => r.status === STATUS.WARN).length;
  lines.push('');
  lines.push(
    fail === 0
      ? `结论：${results.length} 项检查，0 项阻止启动${warn > 0 ? `，${warn} 项警告（能起，但行为可能不是你以为的那样）` : ''}。`
      : `结论：${fail} 项会让 daemon 起不来或干了假活，先按上面的「下一步」修。`,
  );
  return lines.join('\n');
}

/** 是否应当以非零退出（CI 用）。只有 fail 才算。 */
export function exitCodeFor(results) {
  return results.some((r) => r.status === STATUS.FAIL) ? 1 : 0;
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
  runChecks()
    .then((results) => {
      if (json) process.stdout.write(`${JSON.stringify({ results, exitCode: exitCodeFor(results) }, null, 2)}\n`);
      else process.stdout.write(`${formatReport(results)}\n`);
      process.exitCode = exitCodeFor(results);
    })
    .catch((e) => {
      process.stderr.write(`doctor 自身出错：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exitCode = 2;
    });
}

