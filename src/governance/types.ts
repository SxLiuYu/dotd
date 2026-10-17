/**
 * src/governance/types.ts —— 治理模块私有类型（GOV §3.1/§3.3/§8.1）。
 *
 * 边界规则（CONVENTIONS §6）：跨模块可见的类型一律从 src/shared/contracts.ts 导出
 * （GovCtx/Decision/ToolCall/Verdict/ApprovalView/ApprovalStatus/ApprovalKind/
 * SyntheticSubject/PrecheckBrief/ToolTier 已在 contracts.ts §4 定义），本文件只放
 * **模块私有**的形状（钩子依赖、cron 返回、内部行投影等）。
 */

import type {
  ApprovalKind,
  ApprovalStatus,
  ApprovalView,
  Decision,
  GovCtx,
  GovToolCall,
  PrecheckBrief,
  SyntheticSubject,
  ToolTier,
  Verdict,
} from '../shared/contracts.ts';

// 跨模块类型再导出（GOV §8.1 index.ts 的 type 导出面）。
export type {
  ApprovalKind,
  ApprovalStatus,
  ApprovalView,
  Decision,
  GovCtx,
  PrecheckBrief,
  SyntheticSubject,
  ToolTier,
  Verdict,
} from '../shared/contracts.ts';

/**
 * GOV §3.1 ToolCall —— 治理判定入参（注意与 contracts.ts 的 ExecToolCall 是两份形状：
 * 那份是发给容器的执行协议 args/identity；本份是治理判定面 params/identity）。
 *
 * 契约 G1（登录态谓词唯一落点）：`identity` 是**顶层**字段（'anon'/null = 非登录态；
 * 缺失 = fail-closed 按登录态）。params.withIdentity 已作废。
 *
 * 与 contracts.ts 的 GovToolCall 是同一形状（追加 identity 后逐字对齐），
 * 这里再导出一份别名，让模块内代码与跨模块代码说同一个名字。
 */
export type ToolCall = GovToolCall;

/** GOV §3.3 decide 的返回（迟到裁决不报错、只记账）。 */
export interface DecideResult {
  ok: boolean;
  finalStatus?: ApprovalStatus;
  reason?: string;
  /** late 时为抢先通道名（审计与 UX 文案用）。 */
  decidedBy?: string;
}

/** GOV §8.1 forceApproval 的返回。 */
export interface ForceApprovalResult {
  approvalId: number;
  /** true = 命中 uniq_open_subject，复用既有活动单（幂等）。 */
  reused: boolean;
}

/** GOV §3.6 forceApproval 的请求（subject 形状按 SyntheticSubject 三 kind）。 */
export interface ForceApprovalReq {
  kind: SyntheticSubject['kind'];
  subject: Record<string, unknown>;
  reason: string;
  ttlMs?: number;
}

/** 非工具单的幂等键派生（GOV §3.6：侦察候选按模型名去重；副作用未知按 callId）。 */
export function subjectKeyOf(kind: SyntheticSubject['kind'], subject: Record<string, unknown>): string {
  switch (kind) {
    case 'recon_candidate':
      return `recon:${String(subject.model ?? '')}`;
    case 'side_effect_unknown':
      return `unk:${String(subject.journalStep ?? subject.step ?? '')}`;
    case 'question':
      return `q:${String(subject.prompt ?? '').slice(0, 64)}`;
    default:
      return 'unknown';
  }
}

/** approvals 行的内部投影（DB 行是 null-prototype 对象，这里转成可挂方法的普通对象）。 */
export interface ApprovalRow {
  id: number;
  seq: number;
  kind: ApprovalKind;
  subjectKey: string | null;
  subjectJson: string | null;
  dotId: string;
  taskId: string;
  eventId: string | null;
  journalStep: string | null;
  tool: string | null;
  tier: ToolTier | null;
  paramsJson: string;
  summary: string;
  reason: string;
  riskBrief: string | null;
  status: ApprovalStatus;
  createdAt: string;
  pendingUntil: string;
  remindedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  tgMessageId: number | null;
  batchRef: string | null;
  finalParamsJson: string | null;
}

/** GOV §8.2：治理依赖（由 daemon 装配层 initGovernance 注入）。 */
export interface GovDeps {
  controlPlane: {
    /** 契约 J6：由 Runner 调（治理不持有 epoch）——此处仅为依赖声明完整起见登记。 */
    setAwaitingApproval(taskId: string, epoch: number, approvalId: number): void;
    /**
     * 契约 J6 定案签名：decide 提交、expirePending 提交、revoke 抢先 claim 失败——
     * 三条异步路径**全部在调用栈内触发**（GOV §3.3.4）。
     */
    onApprovalSettled(
      taskId: string,
      approvalId: number,
      ok: boolean,
      meta?: { note?: string; revoke?: string },
    ): void;
    /** 契约 G3：liftQuarantine 后调用（CP per-dot 队列恢复）。 */
    resumeDotQueue(dotId: string): void;
  };
  journal: {
    /** 只读：重入核对用；治理绝不写 journal（GOV §1.2）。 */
    stepExists(callId: string): boolean;
  };
  router: {
    /**
     * 契约 G4/T1：统一走 complete({track:'light', deadlineMs:45000, attemptId:'nonj:…'})
     * ——GOV 磁盘稿的 lowIntelligence.complete() 已作废。45s 超时由治理控制。
     */
    complete(req: {
      track: 'light';
      messages: Array<{ role: 'system' | 'user'; content: string }>;
      attemptId: string;
      deadlineMs: number;
      maxTokens?: number;
    }): Promise<{ response: { content: string } }>;
  };
  /** daemon 内事件总线（GOV §8：approval:created / approval:decided / governance:quarantine…）。 */
  bus: {
    publish<E>(topic: string, payload: E, opts?: { dotId?: string; at?: string }): unknown;
    on<E>(topic: string, handler: (event: { payload: E; dotId: string }) => void): () => void;
  };
}
