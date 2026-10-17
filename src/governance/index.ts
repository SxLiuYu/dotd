/**
 * src/governance/index.ts —— 治理模块导出面（GOV §8.1）。
 *
 * 逐字来源：governance.md §8.1「治理导出给其他模块」。磁盘稿的 `.js` 后缀与
 * 仓库 ESM/NodeNext 约定（`verbatimModuleSyntax` + 显式 `.ts` 扩展名）不一致，
 * 这里按 CONVENTIONS §6 的 import 规则改为 `.ts`（文件清单与命名不变）。
 *
 * 相对磁盘稿的落点调整（记入 deviations）：
 * - `catalog.ts(policy.ts)`：磁盘稿 §2.3 把加载器写在 catalog.ts，策略常量在 policy.ts；
 *   本仓库按任务要求拆成两个文件，`loadCatalog/loadRules` 留在 catalog.ts。
 * - `cron.ts` / `ledger.ts` / `channels/telegram.ts` / `queries.ts` / `memory.ts`
 *   五个磁盘稿文件并入现有文件（expirePending/compactAudit → gate.ts/audit.ts；
 *   recordSpendAdjustment → gate.ts；resolveTelegram/renderTgNotice → gate.ts；
 *   listPending/getApproval → gate.ts；matchMemory/deriveRule → memory-rules.ts）。
 *   任务书点名要求的六个文件一个不少，只是没为每个函数单开文件。
 */

// ── §8.1 逐条导出 ─────────────────────────────────────────────────────────────

export {
  evaluate,
  decide,
  claim,
  resolveExecution,
  revoke,
  forceApproval,
  initGovernance,
  createGovernance,
  gov,
  reloadCatalog,
  expirePending,
  recordSpendAdjustment,
  recordTgMessage,
  parseTgCallback,
  parseTgText,
  resolveTelegram,
  renderTgNotice,
  watchEmergency,
  listPending,
  getApproval,
  insertApproval,
  maxTier,
  upgradeHit,
  toView,
  // §8.1 `initSeq`：cron.ts 的 gov_seq 种子职责面（装配层/调度器注册点）。
  initSeq,
} from './gate.ts';

export {
  loadCatalog,
  loadCatalogFile,
  loadRulesFile,
  lookupTool,
  spendContractOk,
  hostOfUrl,
  ToolDef,
  CatalogFile,
  RuleDef,
  RulesFile,
} from './catalog.ts';
export type { Catalog, CatalogLoadResult, CatalogWarning, ToolDefT, RuleDefT } from './catalog.ts';

export {
  precheckModel,
  postReview,
  sanitize,
  precheckMessages,
  parsePrecheckLine,
  parsePostLine,
  newBreaker,
  noteFail,
  noteSuccess,
  isDegraded,
  postReviewTriggered,
  injectionSuspect,
  truncateGoal,
  truncateParams,
} from './review.ts';
export type {
  PrecheckVerdict,
  PostReviewResult,
  ReviewBreaker,
  ReviewRouter,
  QuarantineView,
} from './review.ts';

export {
  matchMemory,
  deriveRule,
  persistMemory,
  revokeMemory,
  listMemory,
  expireMemory,
  enforceTierCap,
  globToRegExp,
  globMatch,
  MEMORY_TIERS,
  memoryEligible,
} from './memory-rules.ts';
export type { MemoryHit, DerivedMemory, PersistMemoryResult } from './memory-rules.ts';

export { isQuarantined, quarantineDot, liftQuarantine, activeQuarantine, listQuarantines } from './quarantine.ts';
export type { QuarantineInput, QuarantineOutcome } from './quarantine.ts';

export {
  appendAudit,
  tailAudit,
  replayAudit,
  compactAudit,
  enforceArchiveCap,
  purgeTerminal,
  purgeMemoryTerminal,
  verifyArchiveFile,
  archiveSizeMb,
  defaultArchiveDir,
  encodeDetails,
  DETAILS_LIMIT,
} from './audit.ts';
export type {
  AuditAction,
  AuditActor,
  AuditEntry,
  AuditRow,
  ArchiveSegment,
  CompactOptions,
  CompactResult,
  PurgeResult,
} from './audit.ts';

export {
  TRANSITIONS,
  isLegalTransition,
  assertTransition,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  OPEN_STATUSES,
  isTerminal,
  isOpen,
} from './status.ts';

export {
  DEFAULT_POLICY,
  EMERGENCY_POLICY,
  baseDecisionFor,
  stricterOrEqual,
  SEVERITY_OF,
} from './policy.ts';
export type { Decision0 } from './policy.ts';

export { govDefaults, sanitizeText, SANITIZE_PATTERNS } from './config.ts';
export type { GovDefaults } from './config.ts';

// ── 类型导出面（§8.1 逐字）────────────────────────────────────────────────────

export type {
  GovCtx,
  Decision,
  Verdict,
  ApprovalView,
  ApprovalStatus,
  ApprovalKind,
  SyntheticSubject,
  PrecheckBrief,
  ToolTier,
} from '../shared/contracts.ts';

export type {
  ApprovalRow,
  DecideResult,
  ForceApprovalReq,
  ForceApprovalResult,
  GovDeps,
  ToolCall,
  subjectKeyOf,
} from './types.ts';

export type { GovernanceRuntime } from './gate.ts';
export type { EvaluateOpts, ClaimResult, RevokeResult, ResolveExecResult, ExpireResult } from './gate.ts';
