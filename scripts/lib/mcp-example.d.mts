export type EnvLike = Record<string, string | undefined>;

export interface InspectMcpServer {
  name: string;
  command: string;
  args: string[];
}

export interface InspectMcpOptions {
  repoRoot: string;
  env?: EnvLike;
  exists?: (p: string) => boolean;
}

export function looksLikePath(arg: string): boolean;

export function inspectMcpServers(servers: InspectMcpServer[], opts: InspectMcpOptions): string[];
