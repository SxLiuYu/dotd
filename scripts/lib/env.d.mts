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
