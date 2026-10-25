/**
 * scripts/lib/live-daemon.d.mts —— `scripts/lib/live-daemon.mjs` 的类型面。
 */

export interface LiveDaemonInfo {
  pid: number;
  cmdline: string[];
  env: Record<string, string>;
}

export interface ScanOptions {
  procRoot?: string;
  readdir?: (dir: string) => string[];
  read?: (path: string) => string;
  selfPid?: number;
}

export function parseProcEnv(text: string): Record<string, string>;

/** 扫描 `/proc` 找运行中的 `src/daemon.ts`（非 Linux 返回空数组）。 */
export function scanDaemons(opts?: ScanOptions): LiveDaemonInfo[];

/** 会从运行期环境覆盖到体检环境的键（决定行为、不决定身份）。 */
export const RUNTIME_KNOBS: readonly string[];

export function overlayRuntimeEnv(opts?: {
  shellEnv?: Record<string, string | undefined>;
  liveEnv?: Record<string, string>;
  knobs?: readonly string[];
}): { env: Record<string, string | undefined>; overlaid: string[] };

export interface LiveDaemonRuntime {
  pid: number;
  env: Record<string, string | undefined>;
  overlaid: string[];
}

export interface LiveDaemonAmbiguous {
  ambiguous: LiveDaemonInfo[];
}

/**
 * 唯一的运行中 daemon → `{ pid, env, overlaid }`；
 * 看不见 → `null`；有多个 → `{ ambiguous }`。
 *
 * 两个成员的字段名不重叠（`pid` vs `ambiguous`），`in` 收窄才成立：
 * `if ('ambiguous' in got)` 之后 tsc 只留下歧义那一支。若给对面补一个
 * `ambiguous?: never`，属性"存在但可选"会让收窄失效，测试里每个字段访问
 * 都得再断言一次 —— 那些断言正是仓库里骗过 tsc 的常客。
 */
export function liveDaemon(opts?: {
  procRoot?: string;
  shellEnv?: Record<string, string | undefined>;
  scan?: (opts?: ScanOptions) => LiveDaemonInfo[];
  knobs?: readonly string[];
}): LiveDaemonRuntime | LiveDaemonAmbiguous | null;
