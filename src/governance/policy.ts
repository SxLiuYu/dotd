/**
 * src/governance/policy.ts —— 默认策略与 EMERGENCY_POLICY（GOV §2.1）。
 *
 * 逐字来源：governance.md §2.1「默认策略」表与 EMERGENCY_POLICY 常量。
 * 契约 G2/§9.3：read/write_file→allow；browser→review；spend/dangerous→approve。
 * 总设计方案 §4-1：dangerous = approve + Web 卡片勾选确认；TG 通道禁用 all。
 *
 * emergency 只严不宽：write_file 降为 review；browser 全档人工（登录态恒 approve）；
 * dangerous 直接 deny（冻结，不受理审批）。
 */

import type { ToolTier } from '../shared/contracts.ts';

/** 基础裁决档位（GOV §2.1 默认策略表的 TS 化）。 */
export type Decision0 = 'allow' | 'review' | 'approve' | 'deny';

/** GOV §2.1：默认策略（可被 rules.yml 收紧、可被持久化记忆放宽至免审批直通）。 */
export const DEFAULT_POLICY: Record<ToolTier, Decision0> = {
  read: 'allow', // 无副作用；应急模式下仍直通
  write_file: 'allow', // 写被限制在 /dot/home 卷内（执行面保证），失败可回滚
  browser: 'review', // 低智能模型执行前审查后放行，异常转审批
  spend: 'approve', // 一律人工审批；记忆规则对其永不生效（GOV §4.1/§4.5）
  dangerous: 'approve', // 一律人工 + 二次确认（Web 勾选框；TG 禁 all）
};

/**
 * GOV §2.1 EMERGENCY_POLICY（逐字）：覆盖默认策略，只严不宽。
 * - write_file 降为审查档；审查器不可用时按 §5.1.2 降级矩阵处理。
 * - browser 全档人工；其中"登录态操作"恒为 approve（应急解除也不变）。
 * - dangerous 冻结：不受理审批，直接拒绝。
 */
export const EMERGENCY_POLICY: Partial<Record<ToolTier, Decision0>> = {
  write_file: 'review',
  browser: 'approve',
  dangerous: 'deny',
};

/** 档位严重度排序（用于"只可提档"校验：rules.yml/tierHint/记忆都不得降档）。 */
const SEVERITY: Record<Decision0, number> = { allow: 0, review: 1, approve: 2, deny: 3 };

/** 判定 b 是否比 a 更严（相等也算不更宽）。 */
export function stricterOrEqual(a: Decision0, b: Decision0): boolean {
  return SEVERITY[b]! >= SEVERITY[a]!;
}

/** 档位严重度序值（Web/CLI 展示与测试断言用；不参与策略计算）。 */
export const SEVERITY_OF: Record<Decision0, number> = SEVERITY;

/**
 * 合并 emergency 覆盖：emergency 为真时用 EMERGENCY_POLICY 覆盖 DEFAULT_POLICY 对应档位
 * （GOV §3.1 伪码 `base = (emergency ? merge(EMERGENCY_POLICY, policy)[tier] : policy[tier])`）。
 */
export function baseDecisionFor(tier: ToolTier, emergency: boolean): Decision0 {
  const base = DEFAULT_POLICY[tier];
  if (!emergency) return base;
  return EMERGENCY_POLICY[tier] ?? base;
}

/** 记忆化授权适用的档位（GOV §4.1：spend/dangerous 永不入记忆）。 */
export const MEMORY_TIERS: readonly ToolTier[] = ['read', 'write_file', 'browser'];

export function memoryEligible(tier: ToolTier): boolean {
  return MEMORY_TIERS.includes(tier);
}

/**
 * 审批总开关（2026-10-26，主人要求「dotd 的审批去掉」，选定「加一个总开关，默认全关」）。
 *
 *     DOTD_APPROVALS=off（默认）  所有档位直通 allow，不再弹审批卡、不再等主人点头。
 *     DOTD_APPROVALS=on           恢复原五档裁决：browser→review，spend/dangerous→人工审批
 *                                 + Web 二次确认。
 *
 * 默认 off 是主人明确定的口径：家居控制全是 dangerous/write 档，逐个点卡片等于不可用。
 *
 * ## 关掉审批之后**仍然生效**的三件事（不是审批，别一起关掉）
 *
 * 1. **白名单制**：未登记工具照样 deny —— 那是"这个工具不存在"，不是"要不要你批"；
 * 2. **spend 参数契约**：金额算不清的调用照样 deny（§2.5）；开关不能替代算钱；
 * 3. **应急模式冻结 dangerous**：EMERGENCY 是硬冻结（`deny`），不是"等人批"。
 *
 * 审计一条不少：每次直通都照旧写 `decisions` + `audit`，reason 带
 * `approvals=off 直通`，事后能一眼看出"这次没有经过人"。
 */
export function approvalsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['DOTD_APPROVALS'] ?? '').trim().toLowerCase();
  // 只有显式写 on/1/true/yes 才恢复审批；空值、未知值一律按主人的新口径直通。
  return !(raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes');
}
