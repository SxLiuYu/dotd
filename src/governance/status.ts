/**
 * src/governance/status.ts —— 审批单八态与合法迁移表（GOV §3.2 + 契约 G2 定稿）。
 *
 * 权威来源（逐字）：
 * - governance.md §3.2：`approvals.status` 八态 + `TRANSITIONS: Record<Status, Status[]>`
 *   （非法迁移抛错并记审计 `illegal_transition`）。
 * - 接缝契约 G2：`ApprovalStatus` 八态、`TRANSITIONS`、`Verdict`、`ApprovalKind`、五档
 *   `ToolTier` 全部由 GOV 导出——所以本文件是**再导出层**，真源在 src/shared/contracts.ts
 *   （跨模块唯一权威），此处补齐 GOV 私有的判定函数与错误类。
 * - db/migrations/020_governance.sql:21 的 CHECK 约束与本表逐字一致（八态一个不多一个不少）。
 *
 * 状态机（总设计方案 §9.3 实施图）：
 *   pending → approved / rejected / expired
 *   approved → executing（执行面 CAS claim）/ revoked（仅未认领时）
 *   executing → executed / failed
 *   其余均为终态（不可翻案、不可复活；"重做" = 新调用产生新审批单）
 */

import { APPROVAL_TRANSITIONS } from '../shared/contracts.ts';
import type { ApprovalStatus } from '../shared/contracts.ts';
import { DotdError } from '../shared/errors.ts';

/** 契约 G2：八态词汇表由 contracts 定义，此处按 GOV §3.2 再导出（SF 徽章/按钮的数据源）。 */
export type { ApprovalStatus } from '../shared/contracts.ts';

/** GOV §3.2：合法迁移表（代码内 `TRANSITIONS`，与 DDL CHECK 逐字一致）。 */
export const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = APPROVAL_TRANSITIONS;

/** 判断一次状态迁移是否合法（非法迁移由 assertTransition 抛 IllegalTransitionError）。 */
export function isLegalTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * GOV §3.2：非法迁移错误。模块内私有（不跨模块传递），但按 CONVENTIONS §6
 * "错误类一律从 src/shared/errors.ts 取"继承 DotdError，便于 daemon 统一 catch。
 */
export class IllegalTransitionError extends DotdError {
  readonly from: ApprovalStatus;
  readonly to: ApprovalStatus;
  constructor(from: ApprovalStatus, to: ApprovalStatus) {
    super(`非法审批状态迁移：${from} → ${to}`, 'ILLEGAL_TRANSITION');
    this.from = from;
    this.to = to;
  }
}

/** 断言合法迁移，非法即抛（调用方负责记 `illegal_transition` 审计）。 */
export function assertTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** 终态集合（裁决即终局：rejected/expired 不可翻案；executed/failed/revoked 同为终态）。 */
export const TERMINAL_STATUSES: readonly ApprovalStatus[] = [
  'rejected',
  'expired',
  'executed',
  'failed',
  'revoked',
];

/** 活动态集合（`uniq_open_step` / `uniq_open_subject` 部分索引的状态集，逐字一致）。 */
export const OPEN_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'executing'];

export function isTerminal(status: ApprovalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isOpen(status: ApprovalStatus): boolean {
  return OPEN_STATUSES.includes(status);
}
