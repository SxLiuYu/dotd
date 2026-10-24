#!/usr/bin/env node
/**
 * scripts/setup-all.mjs —— 一个入口装好两边（阶段 5，2026-10-24）。
 *
 * 合并后仍然有两个运行时（Node 内核 + Python 语音），但陌生人只该记一条命令：
 *
 *   npm run setup:all     # 装依赖 + 体检
 *   npm run up            # 装依赖 + 体检 + 启动 Charlie（它托管 dotd）
 *
 * 它做的事：
 *   1. Node 依赖：node_modules 不存在才跑 `npm install`；
 *   2. Python 依赖：建 `.venv` 并装 `voice/requirements-integration.txt`
 *      （只装集成层必需的包；opuslib/torch 这类音频可选项在 quickstart 里单列）；
 *   3. 体检：调 `npm run onboard`，必需项不过就以非零退出。
 *
 * 它不写任何密钥、不动 ~/.dotd 的配置、不改系统 Python。
 *
 * 用法：
 *   node scripts/setup-all.mjs --check          # 只体检（等同 npm run onboard）
 *   node scripts/setup-all.mjs --install        # 装依赖 + 体检
 *   node scripts/setup-all.mjs --install --start
 *   node scripts/setup-all.mjs --install --dry-run
 *
 * 退出码：0 = 就绪；1 = 有必需项/安装步骤失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ARGS = new Set(process.argv.slice(2));
const INSTALL = ARGS.has('--install');
const START = ARGS.has('--start');
const CHECK_ONLY = ARGS.has('--check');
const DRY = ARGS.has('--dry-run');
const JSON_OUT = ARGS.has('--json');

const steps = [];

function record(id, ok, detail, hint) {
  steps.push({ id, ok, detail, ...(hint ? { hint } : {}) });
}

function run(bin, args, opts = {}) {
  if (DRY) return { ok: true, status: 0, out: `[dry-run] ${bin} ${args.join(' ')}`, raw: '' };
  const r = spawnSync(bin, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    timeout: opts.timeout ?? 600_000,
    // Windows 上 npm 是 .cmd：Node 的新 spawn 规则要求显式 shell。
    shell: opts.shell ?? false,
    env: process.env,
  });
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    out: raw.trim().split('\n').slice(-6).join('\n'),
    raw,
  };
}

// ── 0. 基础工具 ─────────────────────────────────────────────────────

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pythonCandidates = process.env.DOTD_PYTHON ? [process.env.DOTD_PYTHON] : ['python', 'python3'];
const python = pythonCandidates.find((bin) => run(bin, ['--version']).ok) ?? null;
record('python', python !== null, python ?? '未找到 python', python ? undefined : '装 Python 3.10+');

const nodeMajor = Number(process.versions.node.split('.')[0]);
record('node', nodeMajor >= 22, `v${process.versions.node}`, nodeMajor >= 22 ? undefined : '升级 Node 到 22+');

// ── 1. Node 依赖 ────────────────────────────────────────────────────

const nodeModules = join(REPO, 'node_modules');
if (!existsSync(nodeModules)) {
  if (CHECK_ONLY) {
    record('node-deps', false, 'node_modules 不存在', 'npm install（或 npm run setup:all）');
  } else {
    const r = run(npmBin, ['install', '--no-audit', '--no-fund'], { shell: process.platform === 'win32' });
    record('node-deps', r.ok, r.ok ? 'npm install 完成' : r.out, r.ok ? undefined : '检查网络/代理后重跑');
  }
} else {
  record('node-deps', true, 'node_modules 已存在');
}

// ── 2. Python venv + 集成层依赖 ─────────────────────────────────────

function venvPython() {
  const win = join(REPO, '.venv', 'Scripts', 'python.exe');
  const posix = join(REPO, '.venv', 'bin', 'python');
  return existsSync(win) ? win : existsSync(posix) ? posix : null;
}

if (CHECK_ONLY) {
  const vp = venvPython();
  const pyForDeps = vp ?? python;
  const depsOk =
    pyForDeps !== null && run(pyForDeps, ['-c', 'import fastapi, uvicorn, requests, httpx, mcp']).ok;
  record(
    'python-deps',
    depsOk,
    vp ?? (depsOk ? '系统 Python 已装集成依赖（无 .venv）' : '没有 .venv，系统 Python 也缺依赖'),
    depsOk ? undefined : 'npm run setup:all',
  );
} else {
  let vp = venvPython();
  if (vp === null) {
    if (!DRY) mkdirSync(join(REPO, '.venv'), { recursive: true });
    const r = run(python ?? 'python', ['-m', 'venv', join(REPO, '.venv')]);
    if (!r.ok) {
      record('python-venv', false, r.out, '确认 python -m venv 可用（Debian 需要 python3-venv）');
    } else {
      vp = venvPython();
      record('python-venv', DRY || vp !== null, vp ?? '[dry-run] .venv 将创建');
    }
  } else {
    record('python-venv', true, '.venv 已存在');
  }

  if (vp !== null || DRY) {
    const target = vp ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python');
    const req = join(REPO, 'voice', 'requirements-integration.txt');
    const r = run(target, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req]);
    record('python-deps', r.ok, r.ok ? '集成层依赖已就绪' : r.out, r.ok ? undefined : '看 pip 输出；国内可加 -i https://pypi.tuna.tsinghua.edu.cn/simple');
  }
}

// ── 3. 体检 ─────────────────────────────────────────────────────────

if (!DRY) {
  const r = run(process.execPath, [join(REPO, 'scripts', 'onboard.mjs'), '--json']);
  let report = null;
  try {
    const raw = r.raw;
    report = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    report = null;
  }
  const failed = report?.checks?.filter((c) => c.level === 'required' && !c.ok) ?? [];
  record(
    'onboard',
    r.ok,
    report === null ? r.out || 'onboard 输出无法解析' : failed.length === 0 ? '必需项全过' : `缺：${failed.map((c) => c.label).join('、')}`,
  );
}

// ── 输出 ────────────────────────────────────────────────────────────

const ok = steps.every((s) => s.ok);
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok, steps }, null, 2)}\n`);
} else {
  console.log('dotd × Charlie 安装/体检\n');
  for (const s of steps) {
    console.log(`${s.ok ? '✅' : '❌'} ${s.id}: ${s.detail}`);
    if (!s.ok && s.hint) console.log(`   → ${s.hint}`);
  }
  console.log('');
  if (ok) {
    console.log(INSTALL ? '两边都装好了。下一步：npm run up' : '就绪。');
  } else {
    console.log('按上面的 → 逐条补齐后重跑：npm run setup:all');
  }
}

if (!ok) process.exit(1);

// ── 4. 启动 ─────────────────────────────────────────────────────────

if (START) {
  const vp = venvPython();
  const py = vp ?? python ?? 'python';
  if (!JSON_OUT) console.log(`\n启动 Charlie（会托管 dotd）：${py} -m voice.integration.one_system\n`);
  const r = DRY
    ? { ok: true }
    : spawnSync(py, ['-m', 'voice.integration.one_system'], {
        cwd: REPO,
        stdio: 'inherit',
        env: process.env,
      });
  process.exit(r.ok ? 0 : 1);
}
