#!/usr/bin/env node
/**
 * scripts/init-config.mjs —— 生成「能直接加载」的 ~/.dotd 配置（跨平台）。
 *
 * 要解决的问题：
 *   daemon 只从 ~/.dotd/config.yml（或 DOTD_CONFIG 指定路径）读 surfaces 配置
 *   （src/surfaces/config.ts:354），而仓库里的 config/dotd.yml 是模板：里面
 *   ${DOTD_MASTER_TOKEN} / ${DOTD_RO_TOKEN} / ${HOOK_GRAFANA} 三个占位走
 *   expandEnv 严格模式，未设置即 ConfigError 拒启动。所以新人 clone 完直接
 *   `npm run serve` 必崩，报的还是「读不到配置文件 / 环境变量未设置」这种
 *   指不回病因的话。
 *   已有的 bash 版（scripts/setup-dev-env.sh）只能在 WSL 里跑，且它管的是
 *   tokens.env（2026-10-17 起已补齐 FEISHU_ 系列与 WB2API_KEY 等全部键）；本脚本是
 *   跨平台的那一半：把仓库模板渲染成一份能直接加载的 config.yml。
 *   （模板里的 telegram 段已于 2026-10-16 退役，故本脚本不再写 TG_BOT_TOKEN。）
 *
 * 本脚本做三件事：
 *   1. 生成/补齐 ~/.dotd/tokens.env（密钥随机生成；已存在的行一律不动，只补缺键）
 *   2. 由仓库模板 config/dotd.yml 生成 ~/.dotd/config.yml（占位全部替换成真值）
 *   3. 打印下一步
 *
 * 安全性：
 *   - 绝不覆盖已存在的 tokens.env 行（覆盖 = 抹掉真实 token，.env.example 已警告过）
 *   - 已存在的 config.yml 不加 --force 不动
 *   - tokens.env / config.yml 尽量 chmod 600
 *
 * cwd 无关：一切路径从本文件位置推导，不读 process.cwd()。
 *
 * 用法：
 *   node scripts/init-config.mjs            # 生成（幂等）
 *   node scripts/init-config.mjs --force    # 允许覆盖已存在的 config.yml
 *   node scripts/init-config.mjs --print    # 只把生成的 config.yml 打到 stdout，不落盘
 *
 * 退出码：0 = 成功；1 = 失败（含 fail-closed 自检未过）；2 = 用法/环境错误。
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const TEMPLATE = join(REPO_ROOT, 'config', 'dotd.yml');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const PRINT_ONLY = args.has('--print');
if (args.size > (FORCE ? 1 : 0) + (PRINT_ONLY ? 1 : 0)) {
  process.stderr.write('用法：node scripts/init-config.mjs [--force] [--print]\n');
  process.exit(2);
}

const DOTD_HOME = resolve(expandHome(process.env.DOTD_HOME ?? '~/.dotd'));
const CONFIG_PATH = process.env.DOTD_CONFIG
  ? resolve(expandHome(process.env.DOTD_CONFIG))
  : join(DOTD_HOME, 'config.yml');
const TOKENS_PATH = join(DOTD_HOME, 'tokens.env');

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
}

function die(msg) {
  process.stderr.write(`init-config: ${msg}\n`);
  process.exit(1);
}

// ── 1. 读模板 ────────────────────────────────────────────────────────────

let template;
try {
  template = readFileSync(TEMPLATE, 'utf8');
} catch (cause) {
  die(`读不到模板 ${TEMPLATE}（${cause.code ?? cause.message}）`);
}

// ── 2. 定占位符的取值 ────────────────────────────────────────────────────

/**
 * 三类占位，与 src/surfaces/config.ts 的展开语义一一对应：
 *  - secret  ：严格展开，未设置 → ConfigError 拒启动。这里随机生成。
 *  - optional：非严格展开，未设置 → 空串（不拒启动，但对应功能静默不工作）。
 *             生成时同样留空，并在 tokens.env 里注明去哪拿。
 *  - DOTD_DB_PATH：本文件里的 db.path 键不被 surfaces 加载器读取，纯设计注记；
 *              真实覆盖走环境变量。生成时把该行改成注释，免得看着像个待填项。
 */
const SECRET_VARS = ['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA'];
// telegram 已退役（2026-10-16 主人拍板飞书取代），TG_BOT_TOKEN 不再出现：
// 模板里没有 telegram 段，tokens.env 里也不该留一个看着像待填项的键。
const OPTIONAL_VARS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_VERIFICATION_TOKEN',
  'FEISHU_ENCRYPT_KEY',
  'FEISHU_OWNER_CHAT_ID',
];

const values = new Map();
for (const name of SECRET_VARS) {
  const fromEnv = process.env[name];
  values.set(name, fromEnv && fromEnv.length > 0 ? fromEnv : genSecret());
}

const existingTokens = readEnvFile(TOKENS_PATH);
for (const name of [...SECRET_VARS, ...OPTIONAL_VARS]) {
  const prior = existingTokens.get(name);
  if (prior !== undefined && prior.length > 0) values.set(name, prior);
}
for (const name of OPTIONAL_VARS) {
  if (!values.has(name)) values.set(name, process.env[name] ?? '');
}

function genSecret() {
  return randomBytes(24).toString('base64url');
}

function readEnvFile(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

// ── 3. 由模板生成 config.yml ─────────────────────────────────────────────

let out = template;

// db.path 这一行：键本身不被 surfaces 加载器读取，替换成注释，避免误导。
out = out.replace(
  /^([ \t]*)path:[ \t]*\$\{DOTD_DB_PATH\}[ \t]*$/m,
  '$1# path 不走本文件：surfaces 加载器只读 surfaces: 节，库路径用环境变量 DOTD_DB_PATH 覆盖',
);

for (const [name, value] of values) {
  out = out.split(`\${${name}}`).join(value);
}

// fail-closed 自检：与加载器同一标准——一个占位都不许剩。
// 只扫非注释行：模板头注里为讲解语法而写的 ${VAR} 之类字面量不是待填项。
const leftover = out
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
  .match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g);
if (leftover) {
  die(`模板里有没有取值规则的占位：${[...new Set(leftover)].join(', ')}（拒绝生成半份配置）`);
}

// 只读 token 为空串时不能留 [""]（schema 不收空串进数组当合法值，语义上也怪）。
if ((values.get('DOTD_RO_TOKEN') ?? '').length === 0) {
  out = out.replace(/^([ \t]*)readonly_tokens:[ \t]*\[[ \t]*""[ \t]*\][ \t]*$/m, '$1readonly_tokens: []');
}

// ── 4. 落盘 ─────────────────────────────────────────────────────────────

if (PRINT_ONLY) {
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  process.exit(0);
}

mkdirSync(DOTD_HOME, { recursive: true });

if (existsSync(CONFIG_PATH) && !FORCE) {
  process.stdout.write(`${CONFIG_PATH} 已存在，不动（要覆盖加 --force）\n`);
} else {
  writeFileSync(CONFIG_PATH, out.endsWith('\n') ? out : out + '\n', 'utf8');
  chmodQuiet(CONFIG_PATH);
  process.stdout.write(`已生成 ${CONFIG_PATH}\n`);
}

const tokensOut = mergeTokensFile(existingTokens, TOKENS_PATH);
writeFileSync(TOKENS_PATH, tokensOut, 'utf8');
chmodQuiet(TOKENS_PATH);

// ── 5. 下一步 ───────────────────────────────────────────────────────────

const missing = OPTIONAL_VARS.filter((n) => (values.get(n) ?? '').length === 0);
process.stdout.write(`已写入 ${TOKENS_PATH}（已存在的行未改动）\n`);
if (missing.length > 0) {
  process.stdout.write(`\n以下键留空（对应功能不工作，需要时再填，拿法见 .env.example）：\n`);
  for (const n of missing) process.stdout.write(`  ${n}\n`);
}
process.stdout.write(`
下一步：
  source ${TOKENS_PATH}          # Git Bash / WSL
  # PowerShell: Get-Content ${TOKENS_PATH} | ForEach-Object { ... } 或直接在 .env 里设
  npm run serve                  # 起 daemon（读 ${CONFIG_PATH}）
  npm run init-config -- --force # 想重新生成 config.yml 时
`);
process.exit(0);

// ── 工具 ────────────────────────────────────────────────────────────────

/** 追加缺失的 export 行；已有行原样保留（覆盖 = 抹掉真实 token）。 */
function mergeTokensFile(existing, path) {
  const note = {
    FEISHU_APP_ID: '飞书自建应用 App ID（cli_ 开头）',
    FEISHU_APP_SECRET: '飞书 App Secret',
    FEISHU_VERIFICATION_TOKEN: '飞书 Verification Token（事件订阅用，可空）',
    FEISHU_ENCRYPT_KEY: '飞书 Encrypt Key（可空）',
    FEISHU_OWNER_CHAT_ID: '出站目标群 id（oc_ 开头；留空 = 只入站不出站）',
  };
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const tail = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const appended = [];
  for (const name of [...SECRET_VARS, ...OPTIONAL_VARS]) {
    if (existing.has(name)) continue;
    appended.push(`export ${name}=${values.get(name) ?? ''}${note[name] ? `  # ${note[name]}` : ''}`);
  }
  if (appended.length === 0) return lines.join('\n');
  return [...tail, '', '# ── 以下由 scripts/init-config.mjs 于本次运行补齐 ──', ...appended, ''].join('\n');
}

function chmodQuiet(path) {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上 chmod 基本是空操作，忽略即可。
  }
}
