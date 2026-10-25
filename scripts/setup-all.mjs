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
 *   2. Python 依赖：建 `.venv` 并装 `voice/requirements-voice.txt`
 *      （集成层 + 语音层：edge-tts 兜底 TTS、lark-oapi 飞书 SDK；
 *       opuslib/torch 这类真音频验收依赖仍在 quickstart 里单列）；
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
import { resolvePython, venvPython as venvPythonPath } from './lib/python.mjs';

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
// Python 解释器：解析顺序交给 scripts/lib/python.mjs（显式 → 当前平台 .venv →
// python3 → python）。原来写死 ['python', 'python3'] —— Debian/Ubuntu/WSL 上
// `python` 根本不存在（靠 python3 兜着），但 `.venv` 里的解释器永远排不上，
// 于是"依赖已经装进 .venv"判成没装。顺序反过来还会在 /mnt 部署里跑到 Windows
// 的 python.exe（DrvFs 能看见 .venv/Scripts），见 lib/python.mjs 文件头。
const python =
  resolvePython({ repoRoot: REPO, run: (bin, args) => run(bin, args) })?.bin ?? null;
record('python', python !== null, python ?? '未找到 Python', python ? undefined : '装 Python 3.10+');

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

// 本文件自己的 `venvPython()` 原来也是"先 Scripts 再 bin"，即 /mnt 部署里
// 会挑到 Windows 的解释器。直接用 lib 里那份（只认当前平台布局）。
const venvPython = () => venvPythonPath(REPO);

if (CHECK_ONLY) {
  const vp = venvPython();
  const pyForDeps = vp ?? python;
  // 体检也要查"能出声"这一层：只查 fastapi/httpx 的话，缺 edge-tts 照样报绿，
  // 然后启动时 TTS 预热 0/3 —— 这正是 2026-10-25 新机器上的表现。
  const depsOk =
    pyForDeps !== null &&
    run(pyForDeps, ['-c', 'import fastapi, uvicorn, requests, httpx, mcp, edge_tts, lark_oapi']).ok;
  record(
    'python-deps',
    depsOk,
    vp ?? (depsOk ? '系统 Python 已装语音层依赖（无 .venv）' : '没有 .venv，系统 Python 也缺依赖'),
    depsOk ? undefined : 'npm run setup:all',
  );
} else {
  let vp = venvPython();
  if (vp === null && python === null) {
    // 一个解释器都没找到时不要再硬跑 `python -m venv`：Debian 上那句会回
    // `python: not found`，看着像"venv 建不了"，其实是"根本没有 python"。
    record('python-venv', false, '没有可用的 Python 解释器', '装 Python 3.10+（Debian/Ubuntu：apt install python3 python3-venv）');
  } else if (vp === null) {
    if (!DRY) mkdirSync(join(REPO, '.venv'), { recursive: true });
    const r = run(python, ['-m', 'venv', join(REPO, '.venv')]);
    if (!r.ok) {
      record('python-venv', false, r.out, `确认 ${python} -m venv 可用（Debian 需要 python3-venv）`);
    } else {
      vp = venvPython();
      record('python-venv', DRY || vp !== null, vp ?? '[dry-run] .venv 将创建');
    }
  } else {
    record('python-venv', true, '.venv 已存在');
  }

  if (vp !== null || DRY) {
    const target = vp ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python');
    // 装 voice 层，而不是只装集成层（2026-10-25）：
    // requirements-integration.txt 只保证"进程能起"，不保证"能出声" —— 里面的
    // TTS 链路 audio8/baidu/stepfun/finna 全要额外 key 或本地服务，而免费免 key 的
    // edge-tts 和飞书 SDK（lark-oapi）此前没有任何 requirements 文件声明过。
    // 现场表现：装完就绪、启动 `[tts-warm] 完成 0/3 条`、`No module named 'lark_oapi'`。
    // requirements-voice.txt 用 `-r` 引集成层那份，所以这里只装一份。
    const req = join(REPO, 'voice', 'requirements-voice.txt');
    const r = run(target, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req]);
    record(
      'python-deps',
      r.ok,
      r.ok ? '语音层依赖已就绪（含 edge-tts / lark-oapi）' : r.out,
      r.ok ? undefined : '看 pip 输出；国内可加 -i https://pypi.tuna.tsinghua.edu.cn/simple',
    );
  }
}

// ── 3. 体检 ─────────────────────────────────────────────────────────

// 推荐项（例如"没有 ASR 模型 → 设备听不见"）不阻塞退出码 —— CI 的干净机器上
// 本来就没有 237MB 模型。但如果一声不响，"装完就绪、设备聋了"就会再次发生
// （2026-10-25 就是这么发生的）。所以收下来，在末尾单独提示。
const warnings = [];

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
  for (const c of report?.checks ?? []) {
    if (c.level !== 'required' && !c.ok) warnings.push(c);
  }
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
  if (warnings.length > 0) {
    // 不阻塞，但必须说出来 —— 这些项不会让进程起不来，却会让功能静默残缺。
    console.log('还需要你知道（不阻塞启动）：');
    for (const w of warnings) {
      console.log(`  ⚠️  ${w.label}: ${w.detail}`);
      if (w.fix) console.log(`     → ${w.fix.split('\n').join('\n       ')}`);
    }
    console.log('');
  }
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
  const py = vp ?? python;
  if (py === null) {
    // 走到这里说明前面 `ok` 为真但没解释器（理论上不可能），仍然别撒谎说
    // "正在启动"——直接报清楚。
    console.error('\n找不到 Python 解释器，无法启动 Charlie。先跑 npm run setup:all。');
    process.exit(1);
  }
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
