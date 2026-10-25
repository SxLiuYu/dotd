/**
 * scripts/lib/mcp-example.mjs —— 「照着这份声明配，到底能不能起来」。
 *
 * 2026-10-26：`voice-check.mjs` 对 `config/mcp-servers.voice.yml` 只判 `existsSync`。
 * 于是那份文件里同时存在两个致命问题，体检却一路 ✅：
 *
 *   1. `allow_tools` 写成换行块列表，旧解析器把 `- goodnight` 当成**下一个 server**
 *      → 「某个 server 缺 name」→ daemon **拒启动**；
 *   2. `command: python` —— Debian/Ubuntu/WSL 上根本没有 `python`（只有 `python3`），
 *      而且系统 `python3` 里通常没有 `mcp` 包（依赖只装在仓库 `.venv`）。
 *
 * 这两个都不是"文件缺了"，`existsSync` 永远看不见。判据得下沉到
 * "解析 → 解析出可执行文件 → args 里的文件在不在"。
 *
 * 单独成模块是为了**只写一遍**：doctor 与 voice-check 都要这条判据，
 * 而本项目已经因为"同一条判据抄三份"栽过好几次（见 docs/status-2026-10-25.md §18.11）。
 * 「command 存不存在」那一层在 `./command.mjs` —— 两个体检脚本共用，别再各写一份。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { looksLikePath, resolveCommand } from './command.mjs';

export { looksLikePath };

/**
 * 逐条核对一份已解析的声明能不能真的起来。
 *
 * @param {Array<{name: string, command: string, args: string[]}>} servers
 * @param {{repoRoot: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean}} opts
 *   `env` 决定用哪套 PATH（默认 process.env）；`exists` 可注入，便于测试。
 * @returns {string[]} 人类可读的问题；空数组 = 都能起来。
 */
export function inspectMcpServers(servers, { repoRoot, env = process.env, exists = existsSync }) {
  const broken = [];
  for (const s of servers) {
    if (resolveCommand(s.command, { env, repoRoot }) === null) {
      broken.push(`${s.name}：command 找不到「${s.command}」`);
      // 命令都不在，再报 args 只是噪音 —— 先修这个。
      continue;
    }
    const missing = s.args.find((a) => looksLikePath(a) && !exists(resolve(repoRoot, a)));
    if (missing !== undefined) {
      broken.push(`${s.name}：args 里的文件不存在「${missing}」`);
    }
  }
  return broken;
}
