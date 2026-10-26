/**
 * scripts/lib/env.mjs —— "这台机器上到底有什么 key"，要按 daemon 的眼光看。
 *
 * 2026-10-26 现场：live 机上 `node scripts/onboard.mjs` 报
 *
 *     ⚠️  模型端点: 缺模型 key：HY3_API_KEY / OPENROUTER_API_KEY / BACKUP_API_KEY
 *
 * 但那三个 key **都在** `~/.dotd/tokens.env` 里，daemon 启动时 source 的就是它
 * （`scripts/wsl-daemon.sh` → `_tokens_src.env` → 子进程 env），模型一路正常响应。
 * 错的不是机器，是体检：它只读 `process.env`，而**交互式 shell 并不会 source
 * tokens.env**，所以人一敲 `npm run onboard` 就看见"缺 key"。
 *
 * 同一类错误的另一个样本（同一轮修掉的）：`voice-check.mjs` 写死 `python` 而
 * Debian 只有 `python3`，于是"找不到 Python → --check 失败 → 提示你配 token"。
 * 共同点：**检查器看错了地方，结论却指向被检查对象。**
 *
 * 所以这里把"配置真相"的定义写清楚：`process.env` 与 `<home>/tokens.env` 分层合并，
 * **进程环境优先**（显式覆盖文件，与 shell 的 source 语义一致）。
 *
 * 只解析 `NAME=value` 形状，**不执行**文件内容（tokens.env 是数据不是脚本）；
 * 也不打印任何值，调用方只该拿它做"有没有"的判断。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** `~/x` → `home/x`（与 daemon 的 expandHome 同语义）。 */
function expandHomePath(raw, home) {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2));
  return raw;
}

/**
 * 「daemon 到底会读哪个配置目录」——脚本侧的唯一实现（2026-10-26）。
 *
 * 判据按顺序（先命中先用）：
 *   1. `DOTD_CONFIG_DIR` —— 与 `src/daemon.ts::resolveConfigDir()` 逐字一致；
 *   2. `DOTD_CONFIG` 所在目录 —— `one_system.resolve_paths()` 里
 *      `config_dir = DOTD_CONFIG_DIR or config_file.parent`，同一判据；
 *   3. `<home>/.dotd/models.yml` 存在 → `<home>/.dotd` —— **托管布局的记号**；
 *   4. 都没有 → `repoRoot/config`（仓库模板，裸 `npm run serve` 时的形态）。
 *
 * 为什么需要 2/3（2026-10-26 live 现场）：
 * 只有 1 时，人手动跑 `npm run doctor` 会去看仓库 `config/mcp-servers.yml`，
 * 而 daemon（由 one_system 托管）读的是 `~/.dotd/mcp-servers.yml`。实测 doctor 打
 * `MCP 未启用 — /root/dotd/config/mcp-servers.yml`，运行期那份没人读。
 *
 * 为什么用「models.yml 存在」当记号：启动器 `wsl-daemon.sh` 的 §3.5 每次启动都把
 * 仓库 `config/*.yml` 刷新进 `~/.dotd`，所以只要这台机器托管跑过，就一定有它；
 * 而纯开发机（裸 `npm run serve`）只有 `~/.dotd/config.yml`（init-config 写的），
 * 没有 models.yml —— 两种布局可区分，不需要额外状态文件。
 *
 * 为什么会话里的 1 和 3 可能给不同答案：裸 `npm run serve` 在托管机上会读仓库模板。
 * 那只说明"托管机不要绕过启动器起 daemon"；启动器本身也导出 `DOTD_CONFIG_DIR`，
 * 两条路径在正常部署下必须指向同一处（`tests/scripts-deploy-lock.test.ts` ④e 钉住）。
 *
 * **不读 `process.env` 之外的环境事实，也不猜"哪份更新"**：只按布局记号判断，
 * 并在 doctor 的明细里显示实际路径，所以看错地方时人能一眼发现。
 *
 * `home` 只影响 `~` 展开与第 3 条；`exists` 供测试注入。
 */
export function resolveConfigDir({
  env = process.env,
  repoRoot,
  home = osHomedir(),
  exists = existsSync,
} = {}) {
  const raw = (env.DOTD_CONFIG_DIR ?? '').trim();
  if (raw.length > 0) return resolve(expandHomePath(raw, home));

  const cfg = (env.DOTD_CONFIG ?? '').trim();
  if (cfg.length > 0) return resolve(dirname(expandHomePath(cfg, home)));

  // 托管布局的目录：`DOTD_HOME` 说了就以它为准（数据目录与配置目录在托管布局里同处），
  // 否则 `~/.dotd`。用 `models.yml` 当记号的理由见上面的长注释。
  const homeEnv = (env.DOTD_HOME ?? '').trim();
  const hosted = homeEnv.length > 0 ? resolve(expandHomePath(homeEnv, home)) : join(home, '.dotd');
  if (exists(join(hosted, 'models.yml'))) return resolve(hosted);

  return join(repoRoot, 'config');
}

/** 托管布局检查要看的那个目录（`DOTD_HOME` 优先，否则 `~/.dotd`）。 */
function hostedDir({ env = process.env, home = osHomedir() } = {}) {
  const homeEnv = (env.DOTD_HOME ?? '').trim();
  return homeEnv.length > 0 ? resolve(expandHomePath(homeEnv, home)) : join(home, '.dotd');
}

/**
 * 第 3 条（托管布局记号）是否命中 —— 仅供体检文案说明"我为什么看这份"。
 * 显式设了环境变量时返回 false（那不是推断，是配置）。
 */
export function configDirIsHostedGuess({
  env = process.env,
  home = osHomedir(),
  exists = existsSync,
} = {}) {
  if ((env.DOTD_CONFIG_DIR ?? '').trim().length > 0) return false;
  if ((env.DOTD_CONFIG ?? '').trim().length > 0) return false;
  return exists(join(hostedDir({ env, home }), 'models.yml'));
}

/**
 * `config.yml` 到底在哪 —— 脚本侧的唯一实现，与
 * `src/surfaces/config.ts::resolveConfigFile` **逐字一致**。
 *
 * 顺序：`DOTD_CONFIG` > `<DOTD_HOME>/config.yml`（**存在才用**）> `~/.dotd/config.yml`。
 * "存在才用"是保守选择：`DOTD_HOME` 指到别处、配置仍在 `~/.dotd` 的老布局照样能起
 * （那时两处读的都是 `~/.dotd` 那份，同判据）。不并进 `<configDir>`：
 * 18.13 已定 config.yml 身份不同（它是指向某一份文件的路径，不是跟随目录的一类文件）。
 *
 * 为什么不能只看 `DOTD_CONFIG` 和 `~/.dotd`（2026-10-26 第十五例）：
 * 那份文件在同一个 daemon 进程里被两处读，而两处判据不同 ——
 * `loadSurfacesConfig()` 原来只认 `DOTD_CONFIG ?? ~/.dotd/config.yml`，
 * `cpReserveMbFromEnvOrConfig()` 读 `<DOTD_HOME>/config.yml`。`DOTD_HOME` 一挪，
 * 端口/token 来自 HOME，水位/其余键来自数据目录，实测就是这样分叉的。
 * 写配置的有 `init-config.mjs` / `setup.mjs` / `one_system.py`，三者都用
 * `<DOTD_HOME>/config.yml`，所以**写哪儿就该读哪儿**。
 */
export function resolveConfigFile({
  env = process.env,
  home = osHomedir(),
  exists = existsSync,
} = {}) {
  const explicit = (env.DOTD_CONFIG ?? '').trim();
  if (explicit.length > 0) return resolve(expandHomePath(explicit, home));
  const homeEnv = (env.DOTD_HOME ?? '').trim();
  if (homeEnv.length > 0) {
    const hosted = join(resolve(expandHomePath(homeEnv, home)), 'config.yml');
    if (exists(hosted)) return hosted;
  }
  return join(home, '.dotd', 'config.yml');
}

/**
 * 解析 `tokens.env` 文本为对象。
 *
 * 容忍：`export ` 前缀、单双引号、CRLF、BOM、注释、空行、`NAME = value` 空格。
 * 与 `scripts/setup.mjs` 的 `parseTokensEnv` 同语义（两边都必须能读同一份文件）。
 */
export function parseEnvFile(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (m === null) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * daemon 会读的 tokens 文件，按优先级（先读到的为准）。
 *
 * - `<home>/tokens.env`：init-config / setup 生成的标准位置；
 * - `~/.dotd/tokens.env`：home 被 CHARLIE_HOME 指到别处时的兜底（老部署形态）。
 *
 * 去重后返回，避免 home 恰好就是 ~/.dotd 时读两遍。
 */
export function tokenFiles(home, homedir) {
  const list = [join(home, 'tokens.env'), join(homedir, '.dotd', 'tokens.env')];
  return [...new Set(list)];
}

/**
 * 合并后的 key 查询器。
 *
 * 返回 `{ get(name), has(name), sources }`：
 *   - `get` 永远返回字符串（缺失时 `''`），省得调用方到处写 `?? ''`；
 *   - `has` = 非空；
 *   - `sources` 记录每个 key 来自哪个文件（**只记路径，不记值**），
 *     报错时可以说清"我看的是哪儿"。
 *
 * `processEnv` 优先：显式 `HY3_API_KEY=... npm run onboard` 应该覆盖文件里的旧值。
 */
export function layeredEnv({
  home,
  homedir,
  processEnv = process.env,
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const fromFiles = {};
  const sources = {};
  for (const p of tokenFiles(home, homedir)) {
    if (!exists(p)) continue;
    let parsed = {};
    try {
      parsed = parseEnvFile(read(p));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (fromFiles[k] !== undefined) continue; // 先读到的文件优先
      fromFiles[k] = v;
      sources[k] = p;
    }
  }
  const get = (name) => {
    const fromEnv = processEnv[name];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
    return fromFiles[name] ?? '';
  };
  const has = (name) => get(name).length > 0;
  return { get, has, sources, files: tokenFiles(home, homedir) };
}

/**
 * 这串东西是不是"引用"而不是"值"。
 *
 * `init-config` 生成的 config.yml 里写的是 `master_token: "${DOTD_MASTER_TOKEN}"`，
 * 真值在环境里。**未展开的引用不是令牌**，但它长度 20、又不含 `change-me`，
 * 于是"长度 ≥16 且不是占位符"这种最朴素的判据会把**它**判成真令牌。
 *
 * 2026-10-26 的两个后果（同一个日子的两次现场）：
 *   - `onboard` 报「主人令牌 ✅ config.yml 的 surfaces.http.master_token」——假绿；
 *   - `findToken()` 拿这个字面量去请求 `/api/devices`，得到 401，被 `catch {}`
 *     吞掉，于是「语音设备」这一科**从来没真查过**。
 */
export function isEnvRef(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-.*)?\}$/.test(String(value ?? '').trim());
}

/**
 * 从 config.yml 的一行值里判断"这算不算一个可用的令牌"。
 *
 * 返回规范化后的令牌，或 `null`（太短 / 是引用 / 仍是 change-me 占位）。
 * 长度阈值 16 与 `onboard` / `doctor` 保持一致。
 */
export function usableToken(value) {
  const v = String(value ?? '').trim();
  if (v.length < 16) return null;
  if (isEnvRef(v)) return null;
  if (/change-me/i.test(v)) return null;
  return v;
}
