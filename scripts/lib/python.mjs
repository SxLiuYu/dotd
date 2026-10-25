/**
 * scripts/lib/python.mjs —— 找解释器：`python` 不是 `python3`。
 *
 * 2026-10-26 现场：live 机上 `node scripts/voice-check.mjs` 报了两条红——
 *
 *     ❌ Python — 找不到 python
 *     ❌ 一套系统配置 — --check 失败
 *          next: 设置 DOTD_MASTER_TOKEN，或把 tokens.env / config.yml 放到 ~/.dotd
 *
 * 而同一台机器上 `one_system`（由 .venv 的 python 托管）**正在正常服务**，
 * 8443 / ASR / dotd 全绿。两条红都是假的：
 *
 *   1. Debian/Ubuntu/WSL 的默认安装**只提供 `python3`**，没有 `python`。
 *      脚本里 `${DOTD_PYTHON ?? 'python'}` 于是必然失败；
 *   2. 第二条是第一条的连锁反应：解释器都找不到，`--check` 当然跑不起来，
 *      而报错文案把它归因到「缺 token」——**把工具自己的 bug 说成用户的配置问题**。
 *
 * 这正是本项目反复出现的那一类：**检查器坏了，结论却指向被检查对象**。
 * 所以解析顺序写死成：显式指定 → 仓库 .venv → python3 → python。
 *
 * `.venv` 放在 `python3` 之前，因为集成层依赖（fastapi/uvicorn/edge_tts/lark_oapi）
 * 只装在 .venv 里；先找到系统 python3 会得出"依赖没装"的结论，而那种红是**误导**。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 仓库内 venv 的解释器路径（Windows / POSIX 两种布局）。
 *
 * **只认当前平台的布局**，不回退到另一种（2026-10-26 踩到）：
 * 仓库放在 `/mnt/d/dotd` 时，Windows 建的 `.venv/Scripts/python.exe` 在 Linux 侧
 * 也**看得见**（DrvFs）。第一版写成"先看 Scripts 再看 bin"，于是在 WSL 里跑起了
 * Windows 的 python.exe：报告显示 `Python 3.11.9`、`home=C:\Users\1\.dotd` ——
 * **能跑，但查的是另一台机器**。体检最怕这种"绿得毫无意义"。
 *
 * 少了匹配的平台 venv 就返回 null，让调用方退到系统 `python3`（诚实地报
 * "依赖没装"，而不是拿 Windows 环境冒充）。
 */
export function venvPython(repoRoot, { exists = existsSync, platform = process.platform } = {}) {
  const p =
    platform === 'win32'
      ? join(repoRoot, '.venv', 'Scripts', 'python.exe')
      : join(repoRoot, '.venv', 'bin', 'python');
  return exists(p) ? p : null;
}

/**
 * 按优先级列出候选解释器（**含命令名和绝对路径**，调用方直接 spawn）。
 *
 * - `DOTD_PYTHON` 一旦设置就**只用它**：用户显式指定时不该被后面的候选悄悄顶替
 *   （否则"我明明指定了却跑了别的"这类问题最难查）。
 * - 其余顺序见文件头。
 */
export function pythonCandidates({ env = process.env, repoRoot, exists = existsSync, platform = process.platform } = {}) {
  const explicit = (env.DOTD_PYTHON ?? '').trim();
  if (explicit) return [explicit];
  const vp = repoRoot ? venvPython(repoRoot, { exists, platform }) : null;
  // python3 在 python 之前：前者是 Debian 系的**唯一**安装，后者常常不装或指向 py2。
  return [...(vp ? [vp] : []), 'python3', 'python'];
}

/**
 * 找第一个真的能跑的（`run(bin, ['--version'])` 返回 0）。
 *
 * 返回 `{ bin, out }` 或 `null`。**不抛异常**：体检脚本不该因为工具缺失而崩。
 */
export function resolvePython({
  env = process.env,
  repoRoot,
  exists = existsSync,
  platform = process.platform,
  run,
} = {}) {
  for (const bin of pythonCandidates({ env, repoRoot, exists, platform })) {
    const r = run(bin, ['--version']);
    if (r && r.status === 0) {
      return { bin, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    }
  }
  return null;
}

/**
 * 版本够不够（默认 3.10：集成层用了 `dict[str, Any]` 这类 3.9+ 注解，
 * 但 sherpa-onnx / opuslib 的 wheel 从 3.10 起才齐）。
 */
export function majorMinor(text) {
  const m = /(\d+)\.(\d+)/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function pythonAtLeast(text, wantMajor = 3, wantMinor = 10) {
  const v = majorMinor(text);
  if (!v) return false;
  const [a, b] = v;
  return a > wantMajor || (a === wantMajor && b >= wantMinor);
}
