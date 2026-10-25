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
import { join } from 'node:path';

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
