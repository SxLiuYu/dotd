#!/usr/bin/env node
/**
 * scripts/onboard.mjs —— 陌生人第一次：一次体检 + 下一步做什么（阶段 4，2026-10-23）。
 *
 * 它不安装任何东西、不写任何密钥、不打印密钥值。只回答三个问题：
 *   1. 这台机器现在能不能跑（Node / Python / ffmpeg / Docker / 配置 / 模型 key）；
 *   2. 缺的那一项**具体**怎么补（命令或文件路径）；
 *   3. 补完之后第一条能验证成功的命令是什么。
 *
 * 用法：
 *   npm run onboard
 *   npm run onboard -- --json
 *
 * 退出码：0 = 必需项全过；1 = 有必需项缺失（按输出逐条补）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const JSON_OUT = process.argv.includes('--json');

/** @type {Array<{id:string, label:string, level:'required'|'recommended'|'optional', ok:boolean, detail:string, fix?:string}>} */
const checks = [];

function add(id, label, level, ok, detail, fix) {
  checks.push({ id, label, level, ok, detail, ...(fix ? { fix } : {}) });
}

function run(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
    return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

function firstVersion(bin, args) {
  for (const b of process.env.DOTD_NODE ? [process.env.DOTD_NODE] : [bin]) {
    const r = run(b, args);
    if (r.ok) return { bin: b, out: r.out };
  }
  return null;
}

// ── 1. Node / Python ────────────────────────────────────────────────

const nodeMajor = Number(process.versions.node.split('.')[0]);
add(
  'node',
  'Node.js ≥ 22',
  'required',
  nodeMajor >= 22,
  `v${process.versions.node}`,
  nodeMajor >= 22 ? undefined : '升级 Node 到 22+：https://nodejs.org/（node:sqlite 需要）',
);

const py =
  firstVersion(process.env.DOTD_PYTHON ?? 'python', ['--version']) ??
  firstVersion('python3', ['--version']);
add(
  'python',
  'Python ≥ 3.10',
  'required',
  py !== null,
  py?.out ?? '未找到 python',
  py !== null ? undefined : '装 Python 3.10+（apt install python3 / brew install python）',
);

// ── 2. 外部二进制 ───────────────────────────────────────────────────

const ff = run('ffmpeg', ['-version']);
add(
  'ffmpeg',
  'ffmpeg（语音编解码）',
  'recommended',
  ff.ok,
  ff.ok ? (ff.out.split('\n')[0] ?? 'ok') : '未找到',
  ff.ok ? undefined : 'apt install ffmpeg / brew install ffmpeg（纯文本任务可以先不装）',
);

const docker = run('docker', ['--version']);
add(
  'docker',
  'Docker（数字工具容器）',
  'optional',
  docker.ok,
  docker.ok ? (docker.out.split('\n')[0] ?? 'ok') : '未找到（box 档位可只用宿主 MCP）',
  docker.ok ? undefined : '需要可跑容器时：https://docs.docker.com/engine/install/',
);

// ── 3. 配置根与主人令牌（只看键名，不打印值）─────────────────────────

const home = process.env.CHARLIE_HOME ?? process.env.DOTD_HOME ?? join(homedir(), '.dotd');
const cfgPath =
  process.env.DOTD_CONFIG ??
  [
    join(home, 'config.yml'),
    join(homedir(), '.charlie', 'config.yml'),
    join(homedir(), '.dotd', 'config.yml'),
  ].find((p) => existsSync(p)) ??
  join(home, 'config.yml');

const cfgExists = existsSync(cfgPath);
add('config', 'dotd 配置', 'required', cfgExists, cfgExists ? cfgPath : `未找到 ${cfgPath}`, cfgExists ? undefined : 'npm run init-config');

let tokenOk = false;
let tokenSource = '';
if (cfgExists) {
  try {
    const text = readFileSync(cfgPath, 'utf8');
    const m = /master_token:\s*"?([^"\n]+)"?/.exec(text);
    tokenOk = m !== null && m[1].trim().length >= 16 && !/change-me/i.test(m[1]);
    tokenSource = tokenOk ? `${cfgPath} 的 surfaces.http.master_token` : '';
  } catch {
    tokenOk = false;
  }
}
if (!tokenOk) {
  for (const p of [join(home, 'tokens.env'), join(homedir(), '.dotd', 'tokens.env')]) {
    if (!existsSync(p)) continue;
    try {
      const m = /(?:export\s+)?DOTD_MASTER_TOKEN\s*=\s*"?([^"\n]+)"?/.exec(readFileSync(p, 'utf8'));
      if (m && m[1].trim().length >= 16) {
        tokenOk = true;
        tokenSource = `${p} 的 DOTD_MASTER_TOKEN`;
        break;
      }
    } catch {
      /* ignore */
    }
  }
}
add(
  'token',
  '主人令牌',
  'required',
  tokenOk,
  tokenOk ? tokenSource : '未配置或仍是占位值',
  tokenOk ? undefined : '在 config.yml 的 surfaces.http.master_token 填 openssl rand -hex 32 的输出',
);

// ── 4. 模型 key（只报端点名，不报 key）─────────────────────────────

const modelCfg = join(REPO, 'config', 'models.yml');
let modelOk = false;
let modelDetail = '未找到 config/models.yml';
if (existsSync(modelCfg)) {
  const text = readFileSync(modelCfg, 'utf8');
  const envNames = [...text.matchAll(/api_key_env:\s*(\S+)/g)].map((m) => m[1]).filter((v) => v && v !== 'none');
  const present = envNames.filter((name) => (process.env[name] ?? '').length > 0);
  modelOk = present.length > 0;
  modelDetail = modelOk
    ? `已配置 ${present.join(', ')}`
    : `缺模型 key：${[...new Set(envNames)].join(' / ') || '（models.yml 未声明）'}`;
}
add(
  'model',
  '模型端点',
  'recommended',
  modelOk,
  modelDetail,
  modelOk
    ? undefined
    : [
        '免费额度：注册智谱 GLM（https://open.bigmodel.cn/）拿一个永久免费 key；',
        `写进 ${join(home, 'tokens.env')}：`,
        '  HY3_API_KEY=<你的 key>',
        '  （只配了这一个 key 时，先只跑反射层也能用：点灯/场景词/提醒）',
      ].join('\n'),
);

// ── 5. dotd 是否在跑 / 有没有设备 ──────────────────────────────────

const base = (process.env.DOTD_BASE_URL ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
let health = null;
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
  if (res.ok) health = await res.json();
} catch {
  health = null;
}
add(
  'daemon',
  'dotd 内核',
  'optional',
  health !== null,
  health === null ? `未运行（${base}）` : `apiVersion=${health.apiVersion ?? '?'} kernel=ok`,
  health === null ? 'npm run charlie:start（Charlie 会托管它）或 npm run serve' : undefined,
);

if (health !== null) {
  const token = findToken(cfgPath);
  if (token) {
    try {
      const res = await fetch(`${base}/api/devices`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const body = await res.json();
        const n = Array.isArray(body.devices) ? body.devices.length : 0;
        add(
          'device',
          '语音设备',
          'optional',
          n > 0,
          n > 0 ? `${n} 台已注册` : '还没有设备',
          n > 0 ? undefined : 'dotd device add 客厅小屏（然后把两行环境变量给 Charlie）',
        );
      }
    } catch {
      /* 忽略：设备检查是加分项 */
    }
  }
}

function findToken(path) {
  try {
    const m = /master_token:\s*"?([^"\n]+)"?/.exec(readFileSync(path, 'utf8'));
    if (m && m[1].trim().length >= 16 && !/change-me/i.test(m[1])) return m[1].trim();
  } catch {
    /* ignore */
  }
  for (const p of [join(home, 'tokens.env'), join(homedir(), '.dotd', 'tokens.env')]) {
    try {
      const m = /(?:export\s+)?DOTD_MASTER_TOKEN\s*=\s*"?([^"\n]+)"?/.exec(readFileSync(p, 'utf8'));
      if (m && m[1].trim().length >= 16) return m[1].trim();
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ── 输出 ────────────────────────────────────────────────────────────

const requiredFailed = checks.filter((c) => c.level === 'required' && !c.ok);
const ok = requiredFailed.length === 0;

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok, home, checks }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

const mark = (c) => (c.ok ? '✅' : c.level === 'required' ? '❌' : '⚠️ ');
console.log('dotd × Charlie 上手体检\n');
for (const c of checks) {
  console.log(`${mark(c)} ${c.label}: ${c.detail}`);
  if (!c.ok && c.fix) console.log(`   → ${c.fix.split('\n').join('\n     ')}`);
}

console.log('');
if (ok) {
  console.log('必需项已齐。下一步：');
  console.log('  1. npm run charlie:start        # 只启动 Charlie，它会托管 dotd');
  console.log('  2. 打开 http://127.0.0.1:8000/health   # voice + kernel 都应为 ok');
  console.log('  3. 浏览器打开 http://127.0.0.1:8000/console/');
  console.log('  4. 说一句话，或先跑假设备：');
  console.log('     DOTD_MASTER_TOKEN=<master> npm run voice:device -- --create');
} else {
  console.log(`还有 ${requiredFailed.length} 个必需项没过：${requiredFailed.map((c) => c.label).join('、')}`);
  console.log('按上面的 → 逐条补齐后重跑：npm run onboard');
}
process.exit(ok ? 0 : 1);
