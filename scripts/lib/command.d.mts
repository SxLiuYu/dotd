export type EnvLike = Record<string, string | undefined>;

export function looksLikePath(arg: string): boolean;

export function resolveCommand(
  command: string,
  opts: { env: EnvLike; repoRoot: string },
): string | null;
