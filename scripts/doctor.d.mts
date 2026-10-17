/**
 * scripts/doctor.d.mts —— `scripts/doctor.mjs` 的类型面（只给类型检查用，零运行期成本）。
 *
 * 为什么要有它：doctor.mjs 是 `.mjs`（零依赖、任何人 `node scripts/doctor.mjs` 就能跑），
 * 而 tsconfig 开了 `checkJs: false` —— 没有声明文件时 `import { … } from '../scripts/doctor.mjs'`
 * 会报 TS7016 ("implicitly has an 'any' type")。这里把**导出的**形状写清楚，
 * 让 tests/scripts-doctor.test.ts 拿到真类型，而不是靠 `as` 断言糊过去
 * （那种断言正是仓库里踩过的坑：类型骗过了 tsc，运行期字段却对不上）。
 *
 * 纪律：本文件的形状必须与 doctor.mjs 实际导出逐项一致；不一致由
 * tests/scripts-doctor.test.ts 的调用点直接暴露（tsc 会红）。
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorResult {
  /** 体检项 id（CHECKS 里的字符串）。 */
  name: string;
  status: CheckStatus;
  /** 人话标题（一行）。 */
  title: string;
  /** 补充说明（可为空串）。 */
  detail: string;
  /** 下一步该做什么（可为 null）。 */
  next: string | null;
}

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
  latencyMs: number;
}

export interface RunChecksOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  repoRoot?: string;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
}

export const REPO_ROOT: string;
export const MIN_NODE_MAJOR: number;
export const STATUS: Readonly<{ OK: 'ok'; WARN: 'warn'; FAIL: 'fail'; SKIP: 'skip' }>;
export const CHECKS: readonly string[];
export const STRICT_ENV_KEYS: ReadonlySet<string>;

export function runChecks(opts?: RunChecksOptions): Promise<DoctorResult[]>;
export function expectedUserVersion(repoRoot: string): number | null;
export function resolveFleet(raw: string | undefined | null): {
  effective: 'stub' | 'docker';
  raw: string;
  warn: string | null;
};
export function resolveModelTransport(raw: string | undefined | null): {
  effective: 'stub' | 'real-http';
  raw: string;
};
export interface Tier1Endpoint {
  id: string;
  tier: number | null;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  enabled: boolean;
  primaryModel: string | null;
}
export function parseTier1Endpoint(text: string): Tier1Endpoint[];

/** P2-1：mcp-servers.yml 的最小只读解析结果（doctor 只需要 name/command/args）。 */
export interface McpServerSummary {
  name: string;
  command: string;
  args: string[];
}

/**
 * 解析 mcp-servers.yml（与 `src/exec/mcp-config.ts` 同口径的只读子集）。
 *
 * 解析失败**不抛**，改为 `error` 带回原因（doctor 要能把"配置写错了"报成人话）。
 */
export function parseMcpServers(text: string): {
  servers: McpServerSummary[];
  error: string | null;
};

/**
 * 把 `command` 解析成绝对路径；找不到返回 null。
 *
 * 与 spawn 的语义对齐：含分隔符的按路径（相对路径以 repoRoot 为基准），
 * 否则查 PATH（Windows 还要试 PATHEXT 里的 .exe/.cmd/.bat）。
 */
export function resolveCommand(
  command: string,
  ctx: { env: Record<string, string | undefined>; repoRoot: string },
): string | null;

export function expandWithDefault(
  value: string,
  env: Record<string, string | undefined>,
): { value: string; resolved: boolean; missing?: string };
export function formatReport(results: DoctorResult[]): string;
export function exitCodeFor(results: DoctorResult[]): number;
