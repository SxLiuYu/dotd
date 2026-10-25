#!/usr/bin/env node
/**
 * scripts/py.mjs —— 把参数交给"这台机器上真的存在的那个 Python"。
 *
 * 2026-10-26 现场：live 机上 `npm run charlie:check` 报
 *
 *     > python -m voice.integration.one_system --check
 *     sh: 1: python: not found
 *
 * Debian/Ubuntu/WSL 的默认安装**只有 `python3`**，没有 `python`。而 `package.json`
 * 里三条入口（`charlie:start` / `charlie:check` / `voice:bridge`）都写死了
 * `python` —— 更糟的是 `onboard` 把 `npm run charlie:start` 当成"下一步"教给用户，
 * 所以新手的第一条命令就是**必然失败**的。
 *
 * 修法不是把三条都改成 `python3`（Windows 上反过来常常只有 `python`），而是
 * 让 npm 脚本先把解释器**解析出来**再 exec：解析顺序与其余脚本完全一致
 * （见 scripts/lib/python.mjs：显式指定 → 当前平台 .venv → python3 → python）。
 *
 * 用 `spawn` 而不是 `spawnSync`：`charlie:start` 是长驻进程，Ctrl-C / `kill`
 * 必须原样传到 Python 那一层（supervisor 收到 TERM 才会带走 dotd 子进程）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from './lib/python.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/py.mjs <python 参数…>（例如 -m voice.integration.one_system --check）');
  process.exit(2);
}

const py = resolvePython({
  repoRoot: REPO,
  run: (bin, argv) => spawnSync(bin, argv, { encoding: 'utf8' }),
});

if (py === null) {
  console.error(
    '找不到可用的 Python 解释器（试过：显式 DOTD_PYTHON、仓库 .venv、python3、python）。\n' +
      '装 Python 3.10+（Debian/Ubuntu：apt install python3 python3-venv），或设 DOTD_PYTHON 指向解释器。',
  );
  process.exit(127);
}

if (process.env.DOTD_PY_VERBOSE === '1') {
  console.error(`[py] ${py.bin} ${args.join(' ')}`);
}

const child = spawn(py.bin, args, { stdio: 'inherit', cwd: REPO });

// 信号原样转发：不转发的话 `kill <node>` 会留下一个没人管的 Python 长驻进程
// （它在听 8000，下次启动就会撞端口）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('exit', (code, signal) => {
  if (signal !== null) {
    // 被信号杀死时按 shell 惯例返回 128+n，让 `npm run` 的退出码有意义。
    const n = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 0;
    process.exit(128 + n);
  }
  process.exit(code ?? 0);
});
