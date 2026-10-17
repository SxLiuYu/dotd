/**
 * scripts/setup.d.mts —— `scripts/setup.mjs` 的类型面（只给类型检查用，零运行期成本）。
 *
 * 为什么要有它：setup.mjs 是 `.mjs`（零依赖、任何人 `node scripts/setup.mjs` 就能跑），
 * 而 tsconfig 开了 `checkJs: false` —— 没有声明文件时
 * `import { ... } from '../scripts/setup.mjs'` 会报 TS7016。
 * 与 scripts/doctor.d.mts 同一手法：把**导出的形状**写清楚，让测试拿到真类型，
 * 而不是靠 `as` 断言糊过去。
 *
 * 纪律：本文件的形状必须与 setup.mjs 实际导出逐项一致；不一致由 tsconfig 与
 * tests/scripts-setup.test.ts 的调用点直接暴露。
 */

export type SetupStepStatus = 'ok' | 'skip' | 'act' | 'fail';

export interface SetupResult {
  /** 步骤 id（STEPS 里的字符串）。 */
  step: string;
  /** 人话标题。 */
  title: string;
  status: SetupStepStatus;
  detail: string;
  next: string | null;
}

export interface StepCheck {
  ok: boolean;
  status: SetupStepStatus;
  detail: string;
  next: string | null;
}

export interface TokenCheckResult extends StepCheck {
  missing: string[];
}

export interface FleetCheckResult extends StepCheck {
  effective: 'stub' | 'docker';
}

export interface SummaryGroup {
  step: string;
  detail: string;
  next: string | null;
}

export interface SetupSummary {
  needHuman: SummaryGroup[];
  failed: SummaryGroup[];
  autoDone: string[];
  alreadyDone: string[];
}

export const MIN_NODE_MAJOR: number;
export const REPO_ROOT: string;
export const STEP: Readonly<Record<'OK' | 'SKIP' | 'ACT' | 'FAIL', SetupStepStatus>>;
export const STEPS: readonly string[];

export function majorOf(versionText: unknown): number | null;
export function checkNode(versionText: unknown): StepCheck;
export function checkDeps(input: {
  hasNodeModules: boolean;
  lockMtimeMs?: number | null;
  modulesMtimeMs?: number | null;
}): StepCheck;
export function checkDataDir(input: { exists: boolean }): StepCheck;
export function checkConfig(input: { exists: boolean }): StepCheck;
export function checkTokens(input: { text: string | null; required: string[] }): TokenCheckResult;
export function checkFleet(input: { raw: string | undefined | null; dockerAvailable: boolean }): FleetCheckResult;
export function checkImage(input: {
  basePresent: boolean;
  builtPresent: boolean;
  baseTag: string;
}): StepCheck;
export function checkRelay(input: {
  wslDeployment: boolean;
  relayRules: readonly string[];
  neededPorts: readonly string[];
}): StepCheck;
export function parseTokensEnv(text: string | null | undefined): Record<string, string>;
export function summarize(results: readonly SetupResult[]): SetupSummary;
export function formatSetupReport(
  results: readonly SetupResult[],
  opts: { doctorText: string | null; checkOnly: boolean },
): string;
export function relayRulesFromScript(): string[];
export function runSetup(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  now?: () => number;
}): Promise<{ results: SetupResult[]; doctorText: string | null; checkOnly: boolean; doctorExit: number }>;
