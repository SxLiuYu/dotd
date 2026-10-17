/**
 * src/memory/step-paths.ts —— 从 journal 步还原"这一步动了哪些 home 路径"（§4.3 判据）。
 *
 * 为什么需要它（P1-4 的第二个根因，2026-10-18 实测）：
 *   装配层原先的 journalMemoryProbe 返回 `fs.write:<callId>`——**没有路径**。
 *   而 MemoryService 侧 `isMemoryWritePathLoose()` 判的是 `/dot/home/{MEMORY.md,notes/,manuals/}`
 *   这些**前缀**，`fs.write:call_x` 永远不命中 → `anyMemoryFileTouchedSince` 恒判
 *   "没写记忆" → WRITE-SEAL 对每个成功任务都误报 missed。
 *   探针契约（memory/types.ts:JournalMemoryProbe）要的是**路径**，这里负责从
 *   `steps.args_json` 里把它取出来。
 *
 * 覆盖哪两类步：
 *  - `fs.write`：path 明确（args.path）。相对路径按容器 home 根补全，与
 *    `exec/protocol.ts` 的 path 域适配同口径（模型常给 `notes/x.md`）。
 *  - `shell.run`：命令里出现 `notes/`、`manuals/`、`MEMORY.md` 的写操作。
 *    这是保守判定（宁可多算"写过"，也不少算），因为它的用途只是决定
 *    "要不要再问模型一轮"——问多了浪费一次调用，问少了才是真缺陷。
 *
 * 纯函数、零 IO、不 import 他人模块实现（MEM 分层约束）。
 */

/** 容器内 home 根（与 src/exec/protocol.ts 的 RUNTIME_PATHS.homeRoot 同值，见防漂移测试）。 */
const CONTAINER_HOME_ROOT = '/dot/home';

/** §4.3 认可的"记忆文件"路径前缀（与 MemoryService.isMemoryWritePathLoose 同一套判据）。 */
export function isMemoryWritePath(p: string): boolean {
  if (p.startsWith(`${CONTAINER_HOME_ROOT}/`)) {
    const rel = p.slice(CONTAINER_HOME_ROOT.length + 1);
    return rel === 'MEMORY.md' || rel.startsWith('notes/') || rel.startsWith('manuals/');
  }
  return p === 'MEMORY.md' || p.startsWith('notes/') || p.startsWith('manuals/');
}

/** shell.run 命令里出现这些片段就认为"可能写了记忆目录"（保守，见文件头注）。 */
const SHELL_MEMORY_HINTS = ['/dot/home/notes/', '/dot/home/manuals/', '/dot/home/MEMORY.md'];

function parseArgs(argsJson: string | null): Record<string, unknown> {
  if (argsJson === null || argsJson.length === 0) return {};
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 把模型给的路径规整到 home 域（相对路径补 /dot/home/ 前缀，与工具层同口径）。 */
function toHomeDomain(raw: string): string {
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) return raw;
  return `${CONTAINER_HOME_ROOT}/${raw}`;
}

/**
 * 一步 → 它动过的 home 路径列表（可能为空）。
 *
 * @param step 形如 contracts.Step 的最小子集（只要 toolName / argsJson / status），
 *   刻意不 import Step 类型，避免 MEM → CP 的编译期依赖方向倒置（分层约束）。
 */
export function memoryWritePathsOfStep(step: {
  toolName: string | null;
  argsJson: string | null;
  status?: string;
}): string[] {
  // 失败/跳过的步不算"写过"（工具没落地就没有副作用）
  if (step.status !== undefined && step.status !== 'succeeded') return [];
  const args = parseArgs(step.argsJson);

  if (step.toolName === 'fs.write') {
    const p = args.path;
    if (typeof p !== 'string' || p.length === 0) return [];
    const home = toHomeDomain(p);
    return isMemoryWritePath(home) ? [home] : [];
  }

  if (step.toolName === 'shell.run') {
    const cmd = args.cmd;
    if (typeof cmd !== 'string' || cmd.length === 0) return [];
    // 命令里出现的 home 记忆路径原样透出（去重），供上层判定
    const found: string[] = [];
    for (const hint of SHELL_MEMORY_HINTS) {
      if (!cmd.includes(hint)) continue;
      // 抓到 hint 之后那段路径（到空白/引号/重定向为止），已足够做前缀判定
      const re = new RegExp(`(${hint.replace(/[/.]/g, '\\$&')}[^\\s"'\`;|&>)]*)`);
      const m = re.exec(cmd);
      if (m !== null && m[1] !== undefined) found.push(m[1]);
    }
    // 只提了目录、没有具体文件（如 `ls notes/`）不算写——那没有落地
    return [...new Set(found)].filter((p) => isMemoryWritePath(p) && p !== '/dot/home/notes/' && p !== '/dot/home/manuals/');
  }

  return [];
}
