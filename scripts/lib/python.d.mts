/**
 * scripts/lib/python.d.mts —— `scripts/lib/python.mjs` 的类型面（只给类型检查用）。
 *
 * 与 doctor.d.mts / setup.d.mts 同样的理由：`.mjs` + `checkJs: false` ⇒ 没有声明文件
 * 时 `import … from '../scripts/lib/python.mjs'` 报 TS7016。
 *
 * 纪律：形状必须与 python.mjs 实际导出一致；不一致由 tests/scripts-python-resolve.test.ts
 * 的调用点暴露（tsc 会红）。
 */

export interface VersionRun {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

export interface CandidateOptions {
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  /** 只用于单测注入"哪些路径存在"。 */
  exists?: (path: string) => boolean;
  /** 只用于单测注入平台（默认 process.platform）。 */
  platform?: NodeJS.Platform | string;
}

export interface ResolveOptions extends CandidateOptions {
  run: (bin: string, args: string[]) => VersionRun;
}

/** 仓库内 venv 的解释器绝对路径；当前平台没有 venv 时为 null（不跨平台借用）。 */
export function venvPython(
  repoRoot: string,
  opts?: { exists?: (path: string) => boolean; platform?: NodeJS.Platform | string },
): string | null;

/** 候选解释器列表，按优先级（显式 → .venv → python3 → python）。 */
export function pythonCandidates(opts?: CandidateOptions): string[];

/** 第一个 `--version` 能跑通的解释器；一个都没有时返回 null。 */
export function resolvePython(opts: ResolveOptions): { bin: string; out: string } | null;

/** "Python 3.12.3" → [3, 12]；解析不出时 null。 */
export function majorMinor(text?: string | null): [number, number] | null;

/** 版本是否 ≥ wantMajor.wantMinor。 */
export function pythonAtLeast(
  text?: string | null,
  wantMajor?: number,
  wantMinor?: number,
): boolean;
