/**
 * scripts/lib/env.d.mts —— `scripts/lib/env.mjs` 的类型面。
 */

export type ParsedEnv = Record<string, string>;

export interface LayeredEnvOptions {
  home: string;
  homedir: string;
  processEnv?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

export interface LayeredEnv {
  /** 值；缺失时是空串（不是 undefined）。 */
  get(name: string): string;
  /** 非空即 true。 */
  has(name: string): boolean;
  /** key → 来源文件（只记路径，不记值）。 */
  sources: Record<string, string>;
  /** 会去看的候选文件（存在与否都在）。 */
  files: string[];
}

export function parseEnvFile(text?: string | null): ParsedEnv;

export function tokenFiles(home: string, homedir: string): string[];

export function layeredEnv(opts: LayeredEnvOptions): LayeredEnv;

/** `${VAR}` / `${VAR:-默认}` 这种**引用**（不是值）。 */
export function isEnvRef(value?: string | null): boolean;

/** 可用的令牌值；太短 / 是引用 / 仍是 change-me 占位 → null。 */
export function usableToken(value?: string | null): string | null;

export interface ResolveConfigDirOptions {
  env?: Record<string, string | undefined>;
  /** 仓库根；两个环境变量都缺席且不是托管布局时回落到 `<repoRoot>/config`。 */
  repoRoot: string;
  /** 用于展开 `~` 与托管布局记号（测试注入）。 */
  home?: string;
  /** 「这个文件在不在」——测试注入，缺省 `existsSync`。 */
  exists?: (path: string) => boolean;
}

/**
 * daemon 真正会读的配置目录。
 *
 * 顺序：`DOTD_CONFIG_DIR` → `DOTD_CONFIG` 所在目录 →
 * `<home>/.dotd/models.yml` 存在时的 `<home>/.dotd`（托管布局）→ `<repoRoot>/config`。
 * 与 `src/daemon.ts::resolveConfigDir()` 同判据（2026-10-26 把两边对齐）。
 */
export function resolveConfigDir(opts: ResolveConfigDirOptions): string;

/**
 * 上一条的"托管布局"分支是否被用上了（两个环境变量都没设、只是推断）。
 * 体检文案用它说明"这个路径是推出来的"，避免把推断当配置。
 */
export function configDirIsHostedGuess(opts?: {
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
}): boolean;
