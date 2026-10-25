/**
 * scripts/lib/command.mjs —— 「这条 command 在这台机器上到底存不存在」。
 *
 * 原来这份判据只住在 `doctor.mjs` 里。2026-10-26 想让它也能给 `voice-check.mjs`
 * 用（去核对 `config/mcp-servers.voice.yml` 里的 `command: python` 在这台机器上
 * 根本不存在），第一版直接从 doctor import —— 而 doctor 又要 import voice-check
 * 那边的 `looksLikePath`，两个模块**互相 import**。ESM 能跑（函数声明会被提升），
 * 但这是靠加载顺序兜着的运气，不是设计。判据本身与 MCP、与体检都无关，单独一层。
 *
 * 语义与 `child_process.spawn` 对齐：带分隔符的按路径查（相对路径按 repoRoot
 * 解析），否则在 PATH 里找；Windows 还要按 PATHEXT 试 `.exe/.cmd/.bat`
 * （npm 全局装的命令常是 `.cmd`）。
 */

import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** args 里一项看起来像文件路径吗？（含分隔符或已知脚本扩展名） */
export function looksLikePath(arg) {
  return /[\\/]/.test(arg) || /\.(mjs|cjs|js|ts|py|sh)$/i.test(arg);
}

/**
 * 解析 command 到绝对路径；找不到返回 null。
 *
 * @param {string} command
 * @param {{env: Record<string, string | undefined>, repoRoot: string}} opts
 * @returns {string | null}
 */
export function resolveCommand(command, { env, repoRoot }) {
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((x) => x.length > 0)
      : [''];
  const hasSep = /[\\/]/.test(command);
  if (hasSep) {
    const abs = isAbsolute(command) ? command : resolve(repoRoot, command);
    if (existsSync(abs)) return abs;
    // 无扩展名时按 PATHEXT 再试一遍（Windows）
    for (const ext of exts) if (existsSync(abs + ext)) return abs + ext;
    return null;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter).filter((d) => d.length > 0)) {
    const base = join(dir, command);
    if (existsSync(base)) return base;
    for (const ext of exts) if (existsSync(base + ext)) return base + ext;
  }
  // 兜底：本进程的 node（node 通常总在 PATH 里，但体检可能跑在裁剪过的环境里）
  if (command === 'node' && existsSync(process.execPath)) return process.execPath;
  return null;
}
