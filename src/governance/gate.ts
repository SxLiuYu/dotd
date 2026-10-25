/**
 * src/governance/gate.ts —— 治理判定与审批状态机（GOV §3，模块主文件）。
 *
 * 逐字来源：governance.md §3.1 evaluate 伪码、§3.2 状态机、§3.3 裁决接口与先到先得冲突规则、
 * §3.6 forceApproval、§5.3 decisions 落库、§8.1 导出面。
 *
 * 幂等三件套（S1）：`uniq_open_step` 部分索引 + `gov_seq` 同事务生成 seq +
 * 重入先查活动单/终态单。一次调用同 callId 至多一张活动审批单。
 *
 * 双通道冲突规则（§3.3 核心设计决策，一条 SQL 实现）：
 *   BEGIN IMMEDIATE;
 *   UPDATE approvals SET status=@to … WHERE id=@id AND status='pending';
 *   -- changes()==0 ⇒ 已被其他通道/超时裁决，本次为 late decision（只记账，不回滚）
 *   COMMIT;
 *
 * 提交后联动（§3.3.4 + 契约 J6）：裁决/超时/撤销成功落库后，**在调用栈内**调
 * `onApprovalSettled(taskId, approvalId, ok, meta)`；`setAwaitingApproval` 由 **Runner**
 * 调（治理不持 epoch）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { newCallId } from '../shared/ids.ts';
import type {
  ApprovalKind,
  ApprovalStatus,
  Decision,
  GovCtx,
  PrecheckBrief,
  SyntheticSubject,
  ToolTier,
  Verdict,
} from '../shared/contracts.ts';
import { isLoginSensitive } from '../shared/contracts.ts';
import { ConfigError } from '../shared/errors.ts';
import { describeOperation, operationSummary } from '../shared/operation.ts';
import { sanitizeText } from './config.ts';
import { govDefaults } from './config.ts';
import type { GovDefaults } from './config.ts';
import { baseDecisionFor, stricterOrEqual } from './policy.ts';
import type { Decision0 } from './policy.ts';
import { hostOfUrl, lookupTool, spendContractOk } from './catalog.ts';
import type { Catalog, ToolDefT } from './catalog.ts';
import { appendAudit } from './audit.ts';
import { matchMemory, persistMemory, deriveRule } from './memory-rules.ts';
import type { MemoryHit } from './memory-rules.ts';
import {
  newBreaker,
  noteFail,
  noteSuccess,
  isDegraded,
  precheckModel,
  postReview,
  postReviewTriggered,
} from './review.ts';
import type { ReviewBreaker, PostReviewResult } from './review.ts';
import { quarantineDot } from './quarantine.ts';
import { assertTransition, isTerminal, OPEN_STATUSES } from './status.ts';
import { subjectKeyOf } from './types.ts';
import type {
  ApprovalRow,
  DecideResult,
  ForceApprovalReq,
  ForceApprovalResult,
  ToolCall,
} from './types.ts';
import type { GovDeps } from './types.ts';

// ── 模块级状态（装配层 initGovernance 注入；测试可经 createGovernance 独立构造）────

export interface GovernanceRuntime {
  db: DatabaseSync;
  catalog: Catalog;
  deps: GovDeps | null;
  defaults: GovDefaults;
  breaker: ReviewBreaker;
}

let runtime: GovernanceRuntime | null = null;

/** GOV §8.2 initGovernance(deps)：装配层调用一次，之后各导出面读模块级单例。 */
export function initGovernance(
  db: DatabaseSync,
  catalog: Catalog,
  deps: GovDeps,
  opts: { defaults?: GovDefaults } = {},
): GovernanceRuntime {
  runtime = createGovernance(db, catalog, deps, opts);
  return runtime;
}

/** 取模块级单例（未初始化即抛，装配顺序错误应立刻暴露而不是静默 allow）。 */
export function gov(): GovernanceRuntime {
  if (runtime === null) {
    throw new ConfigError('治理未初始化：装配层必须先调 initGovernance', null);
  }
  return runtime;
}

/**
 * GOV §8.1 `initSeq`：预置 `gov_seq` 行（幂等）。
 *
 * 'approval' 计数不随 90 天清理删除 ⇒ seq 跨清理单调（§3.1 评审缺口#7）。
 * `insertApproval` 的 `UPDATE gov_seq … RETURNING value` 依赖这一行存在；
 * 装配层在 initGovernance 之前单独调用亦可（控制面统一调度器注册点，§8.2）。
 */
export function initSeq(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO gov_seq (name, value) VALUES ('approval', 0)
     ON CONFLICT(name) DO NOTHING`,
  ).run();
}

/** 测试/多实例专用：显式构造独立运行态（不碰模块单例）。 */
export function createGovernance(
  db: DatabaseSync,
  catalog: Catalog,
  deps: GovDeps | null = null,
  opts: { defaults?: GovDefaults } = {},
): GovernanceRuntime {
  // gov_seq 行预置（幂等；'approval' 计数不随 90 天清理删除，seq 跨清理单调）。
  initSeq(db);
  return { db, catalog, deps, defaults: opts.defaults ?? govDefaults(), breaker: newBreaker() };
}

/** 热加载（catalog_reloaded 审计的触发点）。 */
export function reloadCatalog(rt: GovernanceRuntime, catalog: Catalog): void {
  rt.catalog = catalog;
  appendAudit(rt.db, { actor: 'system', channel: 'system', action: 'catalog_reloaded' });
}

// ── 行投影 ────────────────────────────────────────────────────────────────────

function toRow(r: Record<string, unknown>): ApprovalRow {
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    kind: String(r.kind) as ApprovalKind,
    subjectKey: (r.subject_key as string | null) ?? null,
    subjectJson: (r.subject_json as string | null) ?? null,
    dotId: String(r.dot_id),
    taskId: String(r.task_id),
    eventId: (r.event_id as string | null) ?? null,
    journalStep: (r.journal_step as string | null) ?? null,
    tool: (r.tool as string | null) ?? null,
    tier: (r.tier as ToolTier | null) ?? null,
    paramsJson: String(r.params_json),
    summary: String(r.summary),
    reason: String(r.reason),
    riskBrief: (r.risk_brief as string | null) ?? null,
    status: String(r.status) as ApprovalStatus,
    createdAt: String(r.created_at),
    pendingUntil: String(r.pending_until),
    remindedAt: (r.reminded_at as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    tgMessageId:
      r.tg_message_id === null || r.tg_message_id === undefined ? null : Number(r.tg_message_id),
    batchRef: (r.batch_ref as string | null) ?? null,
    finalParamsJson: (r.final_params_json as string | null) ?? null,
  };
}

function getRow(db: DatabaseSync, id: number): ApprovalRow | null {
  const r = db.prepare('SELECT * FROM approvals WHERE id=$id').get({ id }) as
    | Record<string, unknown>
    | undefined;
  return r === undefined ? null : toRow(r);
}

function findOpenByStep(db: DatabaseSync, callId: string): ApprovalRow | null {
  const marks = OPEN_STATUSES.map((_, i) => `?${i + 2}`).join(',');
  const r = db
    .prepare(
      `SELECT * FROM approvals WHERE journal_step=?1 AND kind='tool_call'
        AND status IN (${marks}) LIMIT 1`,
    )
    .get(callId, ...OPEN_STATUSES) as Record<string, unknown> | undefined;
  return r === undefined ? null : toRow(r);
}

function findTerminalByStep(db: DatabaseSync, callId: string): ApprovalRow | null {
  const r = db
    .prepare(
      `SELECT * FROM approvals WHERE journal_step=$callId AND kind='tool_call'
        AND status IN ('rejected','expired','revoked') ORDER BY id DESC LIMIT 1`,
    )
    .get({ callId }) as Record<string, unknown> | undefined;
  return r === undefined ? null : toRow(r);
}

// ── decisions 落库（§5.3：每次 evaluate 出口先落库）─────────────────────────────

function newDecisionId(): string {
  return `dec_${newCallId()}`;
}

interface DecisionInsert {
  decisionId: string;
  dotId: string;
  taskId: string;
  journalStep: string;
  kind: Decision['kind'];
  tier: ToolTier | null;
  tool: string | null;
  paramsJson: string | null;
  reason: string | null;
  approvalId?: number | null;
  precheck?: PrecheckBrief | null;
  fromMemory?: number | null;
  reviewSkipped?: boolean;
  /** §5.2 第 5 步：提示注入嗅探命中（postReview 后回写，默认 0）。 */
  injectionSuspect?: boolean;
  /** §5.2 第 3 步：后审结论回写（postReview 完成后）。 */
  postreview?: PostReviewResult | null;
  /** §5.2 第 3 步：后审原始输出（postreview_json）。 */
  postreviewJson?: string | null;
}

function insertDecision(db: DatabaseSync, d: DecisionInsert): string {
  db.prepare(
    `INSERT INTO decisions (id, dot_id, task_id, journal_step, call_id, kind, tier, tool,
                            params_json, reason, review_skipped, from_memory, approval_id, precheck_json,
                            postreview, postreview_json, injection_suspect)
     VALUES ($id, $dotId, $taskId, $journalStep, $callId, $kind, $tier, $tool,
             $paramsJson, $reason, $reviewSkipped, $fromMemory, $approvalId, $precheckJson,
             $postreview, $postreviewJson, $injectionSuspect)`,
  ).run({
    id: d.decisionId,
    dotId: d.dotId,
    taskId: d.taskId,
    journalStep: d.journalStep,
    callId: d.journalStep,
    kind: d.kind,
    tier: d.tier,
    tool: d.tool,
    paramsJson: d.paramsJson,
    reason: d.reason,
    reviewSkipped: d.reviewSkipped === true ? 1 : 0,
    fromMemory: d.fromMemory ?? null,
    approvalId: d.approvalId ?? null,
    precheckJson: d.precheck === undefined || d.precheck === null ? null : JSON.stringify(d.precheck),
    postreview: d.postreview ?? null,
    postreviewJson: d.postreviewJson ?? null,
    injectionSuspect: d.injectionSuspect === true ? 1 : 0,
  });
  return d.decisionId;
}

/**
 * §5.2 第 5 步：后审结论回写 decisions（`postreview`/`postreview_json`/
 * `injection_suspect`）。§5.3 逐字「postReview 以 decision_id 回写后审结论」。
 *
 * 注入嗅探命中 ⇒ `injection_suspect=1`（持久列，阶段三 invisible_playwright 数据源）。
 */
function writePostReview(
  db: DatabaseSync,
  decisionId: string,
  r: { result: PostReviewResult; reason: string; injectionSuspect: boolean; raw: string },
): void {
  db.prepare(
    `UPDATE decisions SET postreview=$result, postreview_json=$json, injection_suspect=$inj
      WHERE id=$id`,
  ).run({
    id: decisionId,
    result: r.result,
    json: JSON.stringify({ reason: r.reason, raw: r.raw }),
    inj: r.injectionSuspect ? 1 : 0,
  });
}

// ── §3.1 evaluate ─────────────────────────────────────────────────────────────

export interface EvaluateOpts {
  /** S7：任务开始时由记忆模块提供；§5.1.1 要求 ≤800B。 */
  goalDigest?: string;
}

/**
 * GOV §3.1 evaluate(ctx, call)：控制面唯一入口。
 *
 * 顺序逐字照伪码：
 *   未登记 → deny ⇒ spend 契约 → tier 取 max ⇒ 幂等重入（活动单/终态单）⇒
 *   dangerous+emergency deny ⇒ 登录态恒 approve ⇒ read 快速路径 ⇒ 规则/记忆 ⇒
 *   base 策略（allow/review→precheck/approve/deny）。
 */
export async function evaluate(
  ctx: GovCtx,
  call: ToolCall,
  opts: EvaluateOpts = {},
  rt: GovernanceRuntime = gov(),
): Promise<Decision> {
  const { db, catalog, deps } = rt;
  const defaults = rt.defaults;
  const goalDigest = opts.goalDigest ?? '';
  const paramsJson = sanitizeText(safeJson(call.params));

  const deny = (reason: string): Decision => {
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'deny',
      tier: null,
      tool: call.tool,
      paramsJson,
      reason,
    });
    appendAudit(db, {
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      decisionId,
      actor: 'agent',
      channel: 'system',
      action: 'decision',
      tier: null,
      tool: call.tool,
      decision: 'deny',
      reason,
    });
    return { kind: 'deny', decisionId, reason };
  };

  // —— 1. 白名单制（§2.3：未登记 ⇒ deny）——
  const def = lookupTool(catalog, call.tool);
  if (def === undefined) return deny('工具未登记');

  // —— 1.5 提问（`ask`）：签发 question 单，挂起等主人回答 ——
  //
  // 为什么要在档位裁决**之前**单独拦：`ask` 不是"要不要执行这个动作"，
  // 它本身就是"我在等你回答"。走档位只会落到 read 快速路径（直接放行、无回答），
  // 或者落到 approve（签发 tool_call 单，语义仍是"准不准做"）。
  // 两者都答非所问 —— 这正是文档里那个假 ✅ 的病根（§2.5）。
  //
  // question 单走同一状态机、同一张卡片、同一双通道（契约 §3.6 早就给了 kind 取值，
  // 一直没人接线）。主人的回答经 `/answer N <文本>` 落到 approvals.note，
  // decide() 把它并进 final_params_json.ownerNote，恢复时 claim() 带回来。
  if (call.tool === 'ask') {
    const question = typeof call.params.question === 'string' ? call.params.question.trim() : '';
    if (question === '') return deny('ask：question 不能为空（要问什么，一句话）');
    const optionsRaw = typeof call.params.options === 'string' ? call.params.options : '';
    const options = optionsRaw.split('|').map((s) => s.trim()).filter((s) => s !== '');
    const a = insertApproval(rt, ctx, call, {
      kind: 'question',
      tier: null,
      reason: question,
      paramsJson,
      subjectKey: `ask:${call.callId}`,
      subject: { kind: 'question', prompt: question, ...(options.length > 0 ? { options } : {}) },
    });
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'approve',
      tier: null,
      tool: call.tool,
      paramsJson,
      reason: question,
      approvalId: a.id,
    });
    appendAudit(db, auditOf(ctx, call, decisionId, 'approve', null, `ask:${question}`));
    return { kind: 'approve', approvalId: a.id };
  }

  // —— 2. spend 参数契约（§2.5：钱都算不清的事不进审批）——
  if (def.tier === 'spend') {
    const chk = spendContractOk(def, call.params);
    if (!chk.ok) return deny(`spend 参数契约不满足：缺 ${chk.missing.join(',')}`);
  }

  // —— 3. 档位取 max（§2.6：upgrade 子串命中即提档；tierHint 只可提档）——
  const tier = maxTier(def, call);

  // —— 4. 幂等重入（§3.1 评审缺口#11）——
  const open = findOpenByStep(db, call.callId);
  if (open !== null) {
    if (open.status === 'pending') {
      // §3.1 末行：每个出口都 INSERT decisions 并 audit('decision')。
      // 重入复用同一张 pending 单 ⇒ decision 也落一条（approve，关联原单），供回放对账。
      const reentryDecisionId = insertDecision(db, {
        decisionId: newDecisionId(),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        journalStep: call.callId,
        kind: 'approve',
        tier: open.tier,
        tool: call.tool,
        paramsJson,
        reason: '幂等重入：pending 单原样返回',
        approvalId: open.id,
      });
      appendAudit(
        db,
        auditOf(
          ctx,
          call,
          reentryDecisionId,
          'approve',
          open.tier,
          '幂等重入：pending 单原样返回',
        ),
      );
      return { kind: 'approve', approvalId: open.id };
    }
    if (open.status === 'approved') {
      return claimAndAllow(rt, ctx, open); // 已批未执行：认领后放行
    }
    return deny('execution in flight'); // executing：竞态防御
  }
  const terminal = findTerminalByStep(db, call.callId);
  if (terminal !== null) {
    appendAudit(db, {
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      approvalId: terminal.id,
      actor: 'agent',
      channel: 'system',
      action: 'reentry_after_terminal',
      tool: call.tool,
      reason: `step already terminal: ${terminal.status}`,
      details: { oldApprovalId: terminal.id, oldStatus: terminal.status },
    });
    return deny(`step already terminal: ${terminal.status}`);
  }

  // —— 5. emergency 冻结危险操作（§2.1 EMERGENCY_POLICY.dangerous = deny）——
  if (tier === 'dangerous' && ctx.emergency) return deny('应急模式冻结危险操作');

  // —— 6. 登录态恒人工审批（契约 G1：谓词见 contracts.ts isLoginSensitive）——
  // 契约 G1 的 fail-closed 补充（2026-10-18 真实踩到）：
  // browser.* 缺 identity 时**不要走审批**——那是个配置问题，主人点"批准"也解决不了，
  // 执行面照样会以 identity_required 拒绝。走审批只会白弹一张卡片、白等一轮。
  // 直接 deny 并说清"缺什么、怎么补"，让模型立刻换路（或如实告诉主人）。
  if (isIdentityMissing(call)) {
    const reason = 'identity_missing：该动作需要登录身份，当前没有可用的身份配置';
    const decisionId = newDecisionId();
    insertDecision(db, {
      decisionId,
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'deny',
      tier,
      tool: call.tool,
      paramsJson,
      reason,
      approvalId: null,
    });
    appendAudit(db, auditOf(ctx, call, decisionId, 'deny', tier, reason));
    return { kind: 'deny', decisionId, reason };
  }

  // 2026-10-21（主人要求"浏览器控制不需要审批，重大决定才需要"）：
  // 「带登录身份浏览」本身不是决策点。契约 G1 的 isLoginSensitive 是"这个调用触碰
  // 了登录态"的**标记**，不是"必须人工批"的**结论** —— 原实现把标记直接当结论，
  // 于是 browser.open/browser.snapshot（tier=read、无副作用）每调一次都弹卡，
  // 网页能力事实上不可用。这里改成：只读且 catalog 判无副作用的调用，即便带身份
  // 也走下面的快速路径；真正会改外部状态的（browser.act/submit、危险工具）仍然
  // 需要人批。identity 本身照旧进 decision 记录，审计不失真。
  // 只读浏览动作显式点名，而不是靠推断：这份清单之外的 browser.* 一律仍按登录态
  // 审批（browser.act 会点/填/提交，可能下单、改设置、发消息 —— 必须人看）。
  const READ_ONLY_BROWSER = new Set([
    'browser.open',
    'browser.snapshot',
    'browser.screenshot',
    'browser.close',
  ]);
  const readOnlyBrowser = tier === 'read' && READ_ONLY_BROWSER.has(call.tool);
  const loginSensitive = isLoginSensitive(call) && !readOnlyBrowser;
  if (loginSensitive) {
    const loginReason = 'login-sensitive';
    const a = insertApproval(rt, ctx, call, {
      kind: 'tool_call',
      tier,
      reason: loginReason,
      paramsJson,
    });
    // §3.1 末行：每个出口都 INSERT decisions 并 audit('decision')。
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'approve',
      tier,
      tool: call.tool,
      paramsJson,
      reason: loginReason,
      approvalId: a.id,
    });
    appendAudit(db, auditOf(ctx, call, decisionId, 'approve', tier, loginReason));
    return { kind: 'approve', approvalId: a.id };
  }

  // —— 7. read 快速路径（§3.1：tier == "read" && !needsReview ⇒ allow(brief=none)）——
  if (tier === 'read' && !needsReview(catalog, call)) {
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'allow',
      tier,
      tool: call.tool,
      paramsJson,
      reason: 'read 快速路径',
      precheck: null,
    });
    appendAudit(db, auditOf(ctx, call, decisionId, 'allow', tier, 'read 快速路径'));
    return { kind: 'allow', decisionId, brief: null };
  }

  // —— 8. 规则与记忆（§4：rules.yml + endpoint_grants + approval_rules）——
  const ruleHit = matchRules(catalog, call);
  if (ruleHit !== null) {
    if (ruleHit.decision === 'allow') {
      const decisionId = insertDecision(db, {
        decisionId: newDecisionId(),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        journalStep: call.callId,
        kind: 'allow',
        tier,
        tool: call.tool,
        paramsJson,
        reason: `rules.yml 放行：${ruleHit.reason}`,
      });
      appendAudit(db, auditOf(ctx, call, decisionId, 'allow', tier, `rules.yml 放行：${ruleHit.reason}`));
      return { kind: 'allow', decisionId, brief: null };
    }
    // rules.yml 收紧（deny / approve）：按条目处理，绝不被记忆推翻（§4.4）。
    if (ruleHit.decision === 'deny') return deny(`rules.yml 拒绝：${ruleHit.reason}`);
    const a = insertApproval(rt, ctx, call, {
      kind: 'tool_call',
      tier,
      reason: `rules.yml:${ruleHit.reason}`,
      paramsJson,
    });
    // §3.1 末行：每个出口都 INSERT decisions 并 audit('decision')。
    const ruleDecisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'approve',
      tier,
      tool: call.tool,
      paramsJson,
      reason: `rules.yml:${ruleHit.reason}`,
      approvalId: a.id,
    });
    appendAudit(db, auditOf(ctx, call, ruleDecisionId, 'approve', tier, `rules.yml:${ruleHit.reason}`));
    return { kind: 'approve', approvalId: a.id };
  }

  const memHit = matchMemory(db, ctx.dotId, tier, call, { emergency: ctx.emergency });
  if (memHit !== null) {
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'allow',
      tier,
      tool: call.tool,
      paramsJson,
      reason: `记忆放行（${memHit.source}#${memHit.refId}）`,
      fromMemory: memHit.refId,
    });
    appendAudit(db, {
      ...auditOf(ctx, call, decisionId, 'allow', tier, `记忆放行（${memHit.source}#${memHit.refId}）`),
      details: { source: memHit.source, refId: memHit.refId, text: memHit.text },
    });
    return { kind: 'allow', decisionId, brief: null };
  }

  // —— 9. base 策略（emergency 覆盖只严不宽）——
  const base: Decision0 = baseDecisionFor(tier, ctx.emergency);
  // 重复审批收敛（2026-10-25）：同一任务把同一个动作再发一次时，不要重复打扰主人。
  //   ① 同参数已有 pending 单 → 复用同一张（不再开票、不再发卡）；
  //   ② 同参数 30 分钟内批过但执行因**基础设施**失败（容器未就绪/传输错误）→ 直接放行。
  // 只作用于需要人工的出口（review/approve），read/allow 不经过这里。
  const reuse =
    base === 'review' || base === 'approve'
      ? findReusableApproval(db, ctx.taskRef.taskId, call.tool, paramsJson)
      : null;
  if (reuse !== null && base === 'approve') {
    return reuseDecision(db, ctx, call, tier, paramsJson, reuse);
  }
  switch (base) {
    case 'allow': {
      const decisionId = insertDecision(db, {
        decisionId: newDecisionId(),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        journalStep: call.callId,
        kind: 'allow',
        tier,
        tool: call.tool,
        paramsJson,
        reason: `默认策略 ${tier}=allow`,
      });
      appendAudit(db, auditOf(ctx, call, decisionId, 'allow', tier, `默认策略 ${tier}=allow`));
      return { kind: 'allow', decisionId, brief: null };
    }
    case 'review': {
      // 同参数已批过/仍在待批：不重复打扰，也不重复跑审查模型。
      if (reuse !== null) return reuseDecision(db, ctx, call, tier, paramsJson, reuse);
      const pre = await precheckModel(
        rt.deps!.router,
        rt.breaker,
        call,
        tier,
        goalDigest,
        ctx,
        { defaults },
      );
      if (pre.degraded === 'degraded') {
        // §5.1.2：write_file 审查器缺席 ⇒ allow + reviewSkipped=degraded（可逆档 fail-open）。
        const decisionId = insertDecision(db, {
          decisionId: newDecisionId(),
          dotId: ctx.dotId,
          taskId: ctx.taskRef.taskId,
          journalStep: call.callId,
          kind: 'allow',
          tier,
          tool: call.tool,
          paramsJson,
          reason: '审查器降级，可逆档放行',
          precheck: { verdict: 'safe', kind: 'degraded', reason: pre.reason },
          reviewSkipped: true,
        });
        appendAudit(db, {
          ...auditOf(ctx, call, decisionId, 'allow', tier, '审查器降级，可逆档放行'),
          action: 'precheck_degraded',
          details: { reason: pre.reason },
        });
        return { kind: 'allow', decisionId, brief: { verdict: 'safe', kind: 'degraded', reason: pre.reason } };
      }
      if (pre.verdict === 'safe') {
        const decisionId = insertDecision(db, {
          decisionId: newDecisionId(),
          dotId: ctx.dotId,
          taskId: ctx.taskRef.taskId,
          journalStep: call.callId,
          kind: 'review_pass',
          tier,
          tool: call.tool,
          paramsJson,
          reason: `precheck:safe（${pre.reason}）`,
          precheck: { verdict: 'safe', reason: pre.reason },
        });
        appendAudit(db, {
          ...auditOf(ctx, call, decisionId, 'review_pass', tier, `precheck:safe（${pre.reason}）`),
          action: 'precheck',
          details: { verdict: 'safe', reason: pre.reason },
        });
        return {
          kind: 'review_pass',
          decisionId,
          brief: { verdict: 'safe', reason: pre.reason },
        };
      }
      // pre.kind=="degraded_write" 之外的一切 risky ⇒ 转人工（§5.1.2 browser 降级即 approve）。
      const a = insertApproval(rt, ctx, call, {
        kind: 'tool_call',
        tier,
        reason: `precheck:risky（${pre.reason}）`,
        paramsJson,
        precheck: { verdict: 'risky', reason: pre.reason },
      });
      // §3.1 末行：每个出口都 INSERT decisions 并 audit('decision')。
      const reviewDecisionId = insertDecision(db, {
        decisionId: newDecisionId(),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        journalStep: call.callId,
        kind: 'approve',
        tier,
        tool: call.tool,
        paramsJson,
        reason: `precheck:risky（${pre.reason}）`,
        approvalId: a.id,
        precheck: { verdict: 'risky', reason: pre.reason },
      });
      appendAudit(
        db,
        auditOf(ctx, call, reviewDecisionId, 'approve', tier, `precheck:risky（${pre.reason}）`),
      );
      return { kind: 'review_approve', approvalId: a.id };
    }
    case 'approve': {
      const a = insertApproval(rt, ctx, call, {
        kind: 'tool_call',
        tier,
        reason: `policy:${tier}`,
        paramsJson,
      });
      // §3.1 伪码末行逐字："每个出口都 INSERT decisions(...) 并 audit('decision')"
      // ——approve 出口同样要落一条 kind='approve' 的 decision（关联 approval_id）。
      const decisionId = insertDecision(db, {
        decisionId: newDecisionId(),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        journalStep: call.callId,
        kind: 'approve',
        tier,
        tool: call.tool,
        paramsJson,
        reason: `policy:${tier}`,
        approvalId: a.id,
      });
      appendAudit(db, auditOf(ctx, call, decisionId, 'approve', tier, `policy:${tier}`));
      return { kind: 'approve', approvalId: a.id };
    }
    default:
      return deny(`默认策略 ${tier}=deny`);
  }
}

/**
 * 基础设施类执行失败：动作**根本没跑起来**，不是业务结果不理想。
 * 同参数重试这类失败不需要再问主人一次（2026-10-25 现场：容器 quarantined 时
 * 主人连点两次同意，每次都被 `container_not_ready` 打回，任务再开一张新单 ——
 * 主人看到的就是"批了又重置"）。
 */
const INFRA_RETRY_CODES = new Set([
  'container_not_ready',
  'container_busy',
  'container_unreachable',
  'transport_error',
]);

const REUSE_WINDOW_MS = 30 * 60_000;

interface ReuseHit {
  approvalId: number;
  kind: 'pending_same' | 'after_infra_failure';
  code?: string;
}

/**
 * 找可以复用的既有审批单（同任务 + 同工具 + **逐字相同**的参数）。
 *
 * 只做两件事：
 *   ① 同参数还有 pending 单 → 复用它（不重复开票/发卡）；
 *   ② 同参数在 30 分钟内批过、但执行因基础设施失败 → 视为"上一次同意仍然有效"。
 *
 * 刻意不做的：spend 档不复用（花钱必须每次点头）、参数不同不复用、
 * 业务失败（模型自己写错命令）不复用 —— 那些应该让主人重新判断。
 */
function findReusableApproval(
  db: DatabaseSync,
  taskId: string,
  tool: string,
  paramsJson: string,
): ReuseHit | null {
  const pending = db
    .prepare(
      `SELECT id FROM approvals
        WHERE task_id=$taskId AND tool=$tool AND params_json=$params
          AND kind='tool_call' AND status='pending'
        ORDER BY id DESC LIMIT 1`,
    )
    .get({ taskId, tool, params: paramsJson }) as { id: number } | undefined;
  if (pending !== undefined) return { approvalId: Number(pending.id), kind: 'pending_same' };

  const cutoff = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
  const last = db
    .prepare(
      `SELECT id, journal_step FROM approvals
        WHERE task_id=$taskId AND tool=$tool AND params_json=$params
          AND kind='tool_call' AND status='failed' AND tier!='spend'
          AND decided_at IS NOT NULL AND decided_at > $cutoff
        ORDER BY id DESC LIMIT 1`,
    )
    .get({ taskId, tool, params: paramsJson, cutoff }) as
    | { id: number; journal_step: string | null }
    | undefined;
  if (last === undefined || last.journal_step === null) return null;

  const step = db
    .prepare('SELECT result_json FROM steps WHERE task_id=$taskId AND call_id=$callId')
    .get({ taskId, callId: last.journal_step }) as { result_json: string | null } | undefined;
  if (step?.result_json === null || step?.result_json === undefined) return null;
  let code = '';
  try {
    const parsed = JSON.parse(step.result_json) as { code?: unknown; retryable?: unknown };
    if (parsed.retryable === false) return null;
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    return null;
  }
  if (!INFRA_RETRY_CODES.has(code)) return null;
  return { approvalId: Number(last.id), kind: 'after_infra_failure', code };
}

/** 复用既有单时的出口：pending 单 → approve 指向同一张；基础设施重试 → allow。 */
function reuseDecision(
  db: DatabaseSync,
  ctx: GovCtx,
  call: ToolCall,
  tier: ToolTier,
  paramsJson: string,
  reuse: ReuseHit,
): Decision {
  const reason =
    reuse.kind === 'pending_same'
      ? `复用待批单 #${reuse.approvalId}（同参数，不重复开票）`
      : `复用已批单 #${reuse.approvalId}（同参数，上次执行仅因 ${reuse.code ?? '基础设施'} 失败）`;

  if (reuse.kind === 'pending_same') {
    const decisionId = insertDecision(db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: call.callId,
      kind: 'approve',
      tier,
      tool: call.tool,
      paramsJson,
      reason,
      approvalId: reuse.approvalId,
    });
    appendAudit(db, {
      ...auditOf(ctx, call, decisionId, 'approve', tier, reason),
      action: 'approval_reused',
      details: { approvalId: reuse.approvalId, mode: reuse.kind },
    });
    return { kind: 'approve', approvalId: reuse.approvalId };
  }

  const decisionId = insertDecision(db, {
    decisionId: newDecisionId(),
    dotId: ctx.dotId,
    taskId: ctx.taskRef.taskId,
    journalStep: call.callId,
    kind: 'allow',
    tier,
    tool: call.tool,
    paramsJson,
    reason,
  });
  appendAudit(db, {
    ...auditOf(ctx, call, decisionId, 'allow', tier, reason),
    action: 'approval_reused',
    details: { approvalId: reuse.approvalId, mode: reuse.kind, code: reuse.code },
  });
  return { kind: 'allow', decisionId, brief: { verdict: 'safe', reason } };
}

function auditOf(
  ctx: GovCtx,
  call: ToolCall,
  decisionId: string,
  decision: string,
  tier: ToolTier | null,
  reason: string,
) {
  return {
    dotId: ctx.dotId,
    taskId: ctx.taskRef.taskId,
    journalStep: call.callId,
    decisionId,
    actor: 'agent' as const,
    channel: 'system' as const,
    action: 'decision' as const,
    tier,
    tool: call.tool,
    decision,
    reason,
  };
}

/** 契约 G1：identity 缺失（undefined）且工具为 browser.* ⇒ fail-closed 记 identity_missing。 */
function isIdentityMissing(call: ToolCall): boolean {
  return call.tool.startsWith('browser.') && call.identity === undefined;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

/** params_json 反解析（后审重构 ToolCall 用；坏行按空对象，不抛）。 */
function safeJsonParams(paramsJson: string): Record<string, unknown> {
  try {
    const p = JSON.parse(paramsJson) as unknown;
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** §3.1 tier = max(def.tier, upgradeHit ? upgrade.tier : def.tier, tierHint)。 */
export function maxTier(def: ToolDefT, call: ToolCall): ToolTier {
  const order: ToolTier[] = ['read', 'write_file', 'browser', 'spend', 'dangerous'];
  let tier = def.tier;
  if (def.upgrade !== undefined && upgradeHit(def, call.params)) tier = def.upgrade.tier;
  if (call.tierHint !== undefined && order.indexOf(call.tierHint) > order.indexOf(tier)) {
    tier = call.tierHint;
  }
  return tier;
}

/** §2.6 upgrade 解析：`JSON.stringify(call.params)` 小写后任一子串命中 ⇒ true。 */
export function upgradeHit(def: ToolDefT, params: Record<string, unknown>): boolean {
  if (def.upgrade === undefined) return false;
  let lc: string;
  try {
    lc = JSON.stringify(params).toLowerCase();
  } catch {
    lc = '';
  }
  return def.upgrade.whenContains.some((w) => lc.includes(w.toLowerCase()));
}

/**
 * §3.1 快速路径的 needsReview：出现"可能需要人看一眼"的参数形态 ⇒ 不走快速路径。
 *
 * 2026-10-21 调整（主人明确要求"浏览器控制不需要审批，重大决定才需要"）：
 * URL 本身不再是 review 信号。原判据是"params 里含 http:// 或 https:// 就 review"，
 * 而 browser.open / browser.act 的正常参数就是 URL —— 这条等于让每一次网页操作都
 * 弹审批卡，browser.* 全系列事实上不可用（实测 tier=read 的 browser.open 照样被拦）。
 * 导航到某个地址不是决策，点进去之后做什么才是；后者由 tier 与下面的凭据类信号把关。
 *
 * 仍然保留的信号：password / token / cookie 字样 —— 它们出现在参数里意味着模型
 * 正在摆弄凭据，值得人看一眼（真正的凭据本该走 $vault: 占位符，不进 args）。
 */
function needsReview(catalog: Catalog, call: ToolCall): boolean {
  const s = safeJson(call.params).toLowerCase();
  if (s.includes('password') || s.includes('token') || s.includes('cookie')) return true;
  return false;
}

// ── rules.yml 匹配（§2.6/§4.4）────────────────────────────────────────────────

interface RuleHit {
  decision: Decision0;
  reason: string;
}

/** 人工收紧规则匹配：tool 精确 + urlHost 通配 + pathPrefix 前缀。 */
function matchRules(catalog: Catalog, call: ToolCall): RuleHit | null {
  for (const rule of catalog.rules) {
    const m = rule.match;
    if (m.tool !== undefined && m.tool !== call.tool) continue;
    if (m.urlHost !== undefined) {
      const url = paramStr(call.params, ['url', 'target', 'link', 'href']);
      const host = url !== null ? hostOfUrl(url) : null;
      if (host === null || !globHost(m.urlHost, host)) continue;
    }
    if (m.pathPrefix !== undefined) {
      const p = paramStr(call.params, ['path', 'filePath', 'file', 'target', 'dest', 'outputPath']);
      if (p === null || !p.startsWith(m.pathPrefix)) continue;
    }
    if (m.amountAtLeast !== undefined) {
      // Muse B3 (2026-10-21): amount threshold predicate, in CENTS.
      // Uses the same key set as the spend contract (governance.md 2.5) so a rule
      // cannot accidentally read a different field than the ledger writes.
      const amt = paramNum(call.params, ['amountCents', 'amount_cents']);
      // Fail closed: no numeric amount means the rule does NOT match. If the caller
      // wanted "any spend call", they should omit the predicate instead.
      if (amt === null || amt < m.amountAtLeast) continue;
    }
    return { decision: rule.decision as Decision0, reason: rule.reason };
  }
  return null;
}

function paramStr(params: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * 取 params 里第一个数值型金额（Muse B3 金额阈值谓词，2026-10-21）。
 *
 * 只认 number：模型常把金额写成字符串 "50000"，那种情况按「没给」处理（返回 null）→
 * 规则不匹配，调用照常走 spend 档审批。宁可多问一次，也不因为解析不到就放行。
 * 单位是**分**，与 spend 契约、feishu-card.ts 的 formatMoney 同一口径。
 * 不做容错解析：把 "5万"、"" 误读成某个数字，比读不出来更危险。
 * 注释原文在提交 10001f0 入库时已损坏成 ???（写入环节丢了字符），
 * 此处按 paramNum 的实际行为重建，语义与代码一致。
 */
function paramNum(params: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** urlHost 通配（`*.github.com` 匹配 `api.github.com`，也匹配自身）。 */
function globHost(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) || h === p.slice(2);
  return h === p;
}

// ── insertApproval（§3.1：seq 与 INSERT 同一事务）───────────────────────────────

interface InsertApprovalOpts {
  kind: ApprovalKind;
  tier: ToolTier | null;
  reason: string;
  paramsJson: string;
  precheck?: PrecheckBrief | null;
  subject?: SyntheticSubject;
  subjectKey?: string | null;
  ttlMs?: number;
}

/** 生成 ≤120 字审批摘要（§7 approvals.summary）：业务动作｜具体操作。 */
function makeSummary(
  db: DatabaseSync,
  taskId: string,
  call: ToolCall,
  tier: ToolTier | null,
  reason: string,
): string {
  const op = describeOperation({
    taskTitle: taskTitleOf(db, taskId),
    tool: call.tool,
    tier,
    params: call.params,
    reason,
  });
  return operationSummary(op);
}

/** 任务标题（卡片/摘要的业务上下文）。查不到就返回 null，不编。 */
function taskTitleOf(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare('SELECT title FROM tasks WHERE id=$id').get({ id: taskId }) as
    | { title: string | null }
    | undefined;
  const t = row?.title ?? '';
  return t.trim() === '' ? null : t;
}

/**
 * 开单。seq 生成（§3.1 评审缺口#7）：与 INSERT 同一 `BEGIN IMMEDIATE` 事务内
 * `UPDATE gov_seq SET value=value+1 WHERE name='approval' RETURNING value`——
 * `gov_seq` 不随 90 天清理删除，seq 跨清理单调。
 */
export function insertApproval(
  rt: GovernanceRuntime,
  ctx: GovCtx,
  call: ToolCall,
  o: InsertApprovalOpts,
): ApprovalRow {
  const { db, deps, defaults } = rt;
  const ttlMs = o.ttlMs ?? defaults.approvalTtlMs;
  const pendingUntil = new Date(Date.now() + ttlMs).toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const seqRow = db
      .prepare(`UPDATE gov_seq SET value=value+1 WHERE name='approval' RETURNING value`)
      .get() as { value: number } | undefined;
    if (seqRow === undefined) {
      throw new ConfigError("gov_seq 缺 'approval' 行：装配层必须先调 initGovernance", null);
    }
    const seq = Number(seqRow.value);

    // batch_ref（§5.1.2）：同任务 5 分钟内第 2 张起 pending 单复用同一批量卡片。
    const batchRef = deriveBatchRef(db, ctx.taskRef.taskId);

    const res = db
      .prepare(
        `INSERT INTO approvals
           (seq, kind, subject_key, subject_json, dot_id, task_id, event_id, journal_step,
            tool, tier, params_json, summary, reason, risk_brief, status, pending_until, batch_ref)
         VALUES ($seq, $kind, $subjectKey, $subjectJson, $dotId, $taskId, $eventId, $journalStep,
                 $tool, $tier, $paramsJson, $summary, $reason, $riskBrief, 'pending', $pendingUntil, $batchRef)`,
      )
      .run({
        seq,
        kind: o.kind,
        subjectKey: o.subjectKey ?? null,
        subjectJson: o.subject === undefined ? null : JSON.stringify(o.subject),
        dotId: ctx.dotId,
        taskId: ctx.taskRef.taskId,
        eventId: ctx.taskRef.eventId ?? null,
        journalStep: o.kind === 'tool_call' ? call.callId : null,
        tool: o.kind === 'tool_call' ? call.tool : null,
        tier: o.tier,
        paramsJson: o.paramsJson,
        summary: makeSummary(db, ctx.taskRef.taskId, call, o.tier, o.reason),
        reason: o.reason,
        riskBrief: o.precheck === undefined || o.precheck === null ? null : JSON.stringify(o.precheck),
        pendingUntil,
        batchRef,
      }) as unknown as { lastInsertRowid: number | bigint };
    const id = Number(res.lastInsertRowid);

    appendAudit(db, {
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: o.kind === 'tool_call' ? call.callId : null,
      approvalId: id,
      actor: 'agent',
      channel: 'system',
      action: 'approval_created',
      tier: o.tier,
      tool: o.kind === 'tool_call' ? call.tool : null,
      decision: 'approve',
      reason: o.reason,
      details: { seq, kind: o.kind, ttlMs },
    });

    db.exec('COMMIT');
    const row = getRow(db, id)!;

    // 事件（§8 表）：approval:created 载荷 = ApprovalView（Web UI、Telegram 通知）。
    // 带上任务标题：飞书卡片据此把"shell.run"翻译成业务动作（2026-10-25）。
    deps?.bus.publish('approval:created', toView(row, db), { dotId: ctx.dotId });
    return row;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }
}

/**
 * §5.1.2 批量合并：同 taskId 5 分钟内已有 pending 单 ⇒ 复用同一批量卡片。
 *
 * 语义（§5.1.2 逐字「同任务连续 browser 审批合并：同一 taskId 5 分钟内第 2 张起
 * pending 单复用同一 TG 消息批量卡片（batch_ref 列）」）：
 * - 第一张单：5 分钟窗口内没有别的 pending 单 ⇒ 生成新 batch_ref（自己是组长）；
 * - 第二张起：沿用最近一张 pending 单的 batch_ref（null 也要沿用 —— 窗口内只有
 *   自己时不可能发生，因为本张就在窗口内；因此这里查 **不带** batch_ref IS NOT NULL，
 *   否则首张必为 null ⇒ 后续永远取不到 ⇒ 批量合并死逻辑）。
 *
 * 时间窗口用 SQL 侧 `datetime('now','-5 minutes')` 而不是 JS 侧 ISO 串：
 * DDL 的 `created_at TEXT DEFAULT (datetime('now'))` 产出 `'YYYY-MM-DD HH:MM:SS'`
 * （空格分隔、秒级、UTC），JS 的 `toISOString()` 是 `'…THH:MM:SS.mmmZ'`（T 分隔、
 * 毫秒、带 Z）——两种格式按字符串比较永远不等，窗口会恒空。
 */
function deriveBatchRef(db: DatabaseSync, taskId: string): string | null {
  const row = db
    .prepare(
      `SELECT id, batch_ref FROM approvals
        WHERE task_id=$taskId AND status='pending'
              AND created_at > datetime('now', '-5 minutes')
        ORDER BY id DESC LIMIT 1`,
    )
    .get({ taskId }) as { id: number; batch_ref: string | null } | undefined;
  if (row === undefined) {
    // 窗口内无待批单：本张是第一批，自己生成批量卡片引用。
    return newBatchRef();
  }
  // 窗口内已有待批单：沿用其 batch_ref；若其为空（历史行）则本张生成一个。
  return row.batch_ref ?? newBatchRef();
}

/** 批量卡片引用（任务内唯一；不是审批单 id，可读性优先）。 */
function newBatchRef(): string {
  return `batch_${newCallId()}`;
}

// ── ApprovalView（§3.5：Web/TG 卡片唯一数据源）────────────────────────────────

export function toView(
  row: ApprovalRow,
  db?: DatabaseSync,
): import('../shared/contracts.ts').ApprovalView {
  let fullParams: unknown = null;
  try {
    fullParams = JSON.parse(row.paramsJson);
  } catch {
    fullParams = { unparsed: row.paramsJson };
  }
  let subject: SyntheticSubject | undefined;
  if (row.subjectJson !== null) {
    try {
      subject = JSON.parse(row.subjectJson) as SyntheticSubject;
    } catch {
      subject = undefined;
    }
  }
  let riskBrief: PrecheckBrief | undefined;
  if (row.riskBrief !== null) {
    try {
      riskBrief = JSON.parse(row.riskBrief) as PrecheckBrief;
    } catch {
      riskBrief = undefined;
    }
  }
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    tier: row.tier,
    status: row.status,
    summary: row.summary,
    fullParams,
    reason: row.reason,
    riskBrief,
    expiresAt: row.pendingUntil,
    remindedAt: row.remindedAt ?? undefined,
    taskRef: {
      taskId: row.taskId,
      eventId: row.eventId ?? undefined,
      journalStepId: row.journalStep ?? row.taskId,
    },
    subject,
    ...(db !== undefined ? withTaskTitle(db, row.taskId) : {}),
  };
}

/** 卡片要的"业务上下文"：任务标题。查不到就不加键（老调用方逐字不变）。 */
function withTaskTitle(db: DatabaseSync, taskId: string): { taskTitle?: string } {
  const t = taskTitleOf(db, taskId);
  return t === null ? {} : { taskTitle: t };
}

/** §3.5 listPending(limit=50)。 */
export function listPending(
  limit = 50,
  rt: GovernanceRuntime = gov(),
): import('../shared/contracts.ts').ApprovalView[] {
  const rows = rt.db
    .prepare(
      `SELECT * FROM approvals WHERE status='pending' ORDER BY seq ASC LIMIT $limit`,
    )
    .all({ limit: Math.max(1, Math.floor(limit)) }) as unknown as Record<string, unknown>[];
  return rows.map((r) => toView(toRow(r), rt.db));
}

/** §3.5 getApproval(idOrSeq)：id 命中优先，其次 seq（`AP-#<seq>` 反查）。 */
export async function getApproval(
  idOrSeq: number,
  rt: GovernanceRuntime = gov(),
): Promise<import('../shared/contracts.ts').ApprovalView | null> {
  const byId = getRow(rt.db, idOrSeq);
  if (byId !== null) return toView(byId, rt.db);
  const r = rt.db
    .prepare('SELECT * FROM approvals WHERE seq=$seq ORDER BY id DESC LIMIT 1')
    .get({ seq: idOrSeq }) as Record<string, unknown> | undefined;
  return r === undefined ? null : toView(toRow(r), rt.db);
}

// ── §3.3 decide：先到先得 ─────────────────────────────────────────────────────

/**
 * GOV §3.3 decide(approvalId, channel, verdict, actor, note?)。
 *
 * 冲突规则（§3.3 逐字，一条 SQL 实现）：
 *   BEGIN IMMEDIATE; UPDATE approvals SET … WHERE id=@id AND status='pending'; COMMIT;
 *   changes()==0 ⇒ 已被其他通道/超时裁决 ⇒ late decision（记账，不报错，不回滚）。
 *
 * TG 通道禁用 `approve_remember`（§3.4：规则授权须在 Web 点，防手机误触形成持久授权）。
 */
export async function decide(
  approvalId: number,
  channel: 'web' | 'telegram' | 'cli',
  verdict: Verdict,
  actor: string,
  note?: string,
  rt: GovernanceRuntime = gov(),
): Promise<DecideResult> {
  const { db, deps } = rt;
  const current = getRow(db, approvalId);
  if (current === null) return { ok: false, reason: `审批单 #${approvalId} 不存在` };

  if (channel === 'telegram' && verdict === 'approve_remember') {
    appendAudit(db, {
      dotId: current.dotId,
      taskId: current.taskId,
      approvalId,
      actor: 'owner',
      channel,
      action: 'late_decision',
      decision: verdict,
      reason: 'TG 通道禁用 approve_remember',
    });
    return { ok: false, finalStatus: current.status, reason: 'TG 通道禁用 approve_remember' };
  }

  const to: ApprovalStatus = verdict === 'reject' ? 'rejected' : 'approved';
  const noteTrim = note === undefined ? null : sanitizeText(note).slice(0, 500);
  const nowIso = new Date().toISOString();
  // **主人说的话必须随审批单回到执行方**（2026-10-22 第 7 轮修）。
  //
  // 原来这里原样回传 `current.paramsJson` —— 也就是**发单时的参数**。
  // 于是 `note`（契约 §3.4：主人对这张单子的补充指令／回答）虽然写进了库、
  // 也进了 audit，却**永远到不了模型**：claim() 读的就是 final_params_json，
  // 而它等于原参数。`/answer N <文本>` 这条命令于是等于空转。
  //
  // 这个洞在 `ask` 之前不明显（工具调用类审批，"再补充一句"多半是锦上添花），
  // 但 `ask` 的全部语义就是**主人的回答**：不带 note 回来，模型问了个寂寞。
  //
  // 合并而不是覆盖：note 是附加信息，不能顶掉工具本来要的参数。
  // 键名用 `ownerNote` 而不是 `note`，避免和真把 note 当参数的工具撞名。
  const finalParams = ((): string | null => {
    if (verdict === 'reject') return null;
    if (noteTrim === null || noteTrim === '') return current.paramsJson;
    let base: Record<string, unknown> = {};
    try {
      const p = JSON.parse(current.paramsJson) as unknown;
      if (typeof p === 'object' && p !== null) base = p as Record<string, unknown>;
    } catch {
      // 参数不是合法 JSON：仍要把回答带回去，宁可少参数也不能丢话
    }
    return JSON.stringify({ ...base, ownerNote: noteTrim });
  })();

  let changes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db
      .prepare(
        `UPDATE approvals
            SET status=$to, decided_by=$channel, decided_at=$now, note=$note, final_params_json=$params
          WHERE id=$id AND status='pending'`,
      )
      .run({
        to,
        channel,
        now: nowIso,
        note: noteTrim,
        params: finalParams,
        id: approvalId,
      }) as unknown as { changes: number };
    changes = Number(res.changes);
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }

  const after = getRow(db, approvalId)!;

  if (changes === 0) {
    // §3.3.3 迟到裁决不报错、只记账：绝不二次执行或状态回滚。
    // 文案描述"赢家做了什么"（由最终状态反推），而不是本次迟到方的意图。
    const winner = after.decidedBy ?? '其他通道';
    const winnerAct =
      after.status === 'rejected' ? '拒绝' : after.status === 'approved' ? '批准' : `置为 ${after.status}`;
    appendAudit(db, {
      dotId: after.dotId,
      taskId: after.taskId,
      approvalId,
      actor: 'owner',
      channel,
      action: 'late_decision',
      decision: verdict,
      reason: `已被 ${winner} 通道抢先${winnerAct}`,
      details: { finalStatus: after.status, decidedBy: after.decidedBy, lateVerdict: verdict },
    });
    deps?.bus.publish('approval:decided', {
      id: after.id,
      seq: after.seq,
      kind: after.kind,
      subject: after.subjectJson === null ? undefined : safeParse(after.subjectJson),
      verdict,
      status: after.status,
      channel,
      late: true,
    }, { dotId: after.dotId });
    return {
      ok: false,
      finalStatus: after.status,
      reason: `已被 ${winner} 通道抢先${winnerAct}`,
      decidedBy: after.decidedBy ?? undefined,
    };
  }

  appendAudit(db, {
    dotId: after.dotId,
    taskId: after.taskId,
    approvalId,
    actor: 'owner',
    channel,
    action: 'approval_decided',
    tier: after.tier,
    tool: after.tool,
    decision: verdict,
    reason: `主人（${actor}）经 ${channel} ${verdict}`,
    details: { verdict, note: noteTrim, finalStatus: after.status },
  });

  // §4：approve_remember ⇒ 派生并落库记忆（Web 确认框预览后由控制面调 persistMemory，
  // 这里在 decide 内一并完成——单入口语义更稳，派生失败退化为 approve_once）。
  if (verdict === 'approve_remember' && after.kind === 'tool_call' && after.tier !== null) {
    rememberFromApproval(rt, after);
  }

  const ok = to === 'approved';
  // §3.3.4 / 契约 J6：提交后立即在调用栈内联动，无悬空事件。
  deps?.controlPlane.onApprovalSettled(after.taskId, after.id, ok, {
    note: noteTrim ?? undefined,
  });
  deps?.bus.publish('approval:decided', {
    id: after.id,
    seq: after.seq,
    kind: after.kind,
    subject: after.subjectJson === null ? undefined : safeParse(after.subjectJson),
    verdict,
    status: after.status,
    channel,
  }, { dotId: after.dotId });

  return { ok: true, finalStatus: after.status, decidedBy: channel };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * §4.2/§4.3：approve_remember 派生记忆。登录态/派生失败 ⇒ 静默退化为 approve_once
 * （不炸裁决路径；审计记 memory_created 供追溯）。
 *
 * 契约 G1 连锁：`approvals` 表**没有** identity 列（DDL 一字不改），登录态判定结果
 * 只能从 `approvals.reason` 反推（`isIdentityMissing(call)` 落 `identity_missing`，
 * 否则 `login-sensitive`）。这里据此把 identity 补回重建的 ToolCall——
 * 否则 browser.* + identity 缺失会 fail-closed 判登录态，**每一次** approve_remember
 * 都被误挡成"不可派生"，记忆永远落不了库。
 */
function rememberFromApproval(rt: GovernanceRuntime, row: ApprovalRow): void {
  if (row.tier === null) return;
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.paramsJson) as Record<string, unknown>;
  } catch {
    return;
  }
  // reason 反推：identity_missing ⇒ 缺失（fail-closed 登录态）；login-sensitive ⇒ 有身份。
  // 两者都是登录态 ⇒ 派生必然返回 null（deriveRule 内 isLoginSensitive 先挡）。
  // 注意 GovToolCall.identity 是 `string | null | undefined`：缺失即 undefined，这里显式标注。
  const identityFromReason: string | null | undefined =
    row.reason === 'identity_missing' ? undefined : row.reason === 'login-sensitive' ? 'owner' : 'anon';
  const call: ToolCall = {
    callId: row.journalStep ?? `approval:${row.id}`,
    tool: row.tool ?? '',
    params,
    identity: identityFromReason,
  };
  const derived = deriveRule(row.tier, call);
  if (derived === null) {
    appendAudit(rt.db, {
      dotId: row.dotId,
      taskId: row.taskId,
      approvalId: row.id,
      actor: 'owner',
      channel: 'system',
      action: 'memory_created',
      tier: row.tier,
      tool: row.tool,
      reason: 'approve_remember 但不可派生（登录态/档位不符），退化为 approve_once',
    });
    return;
  }
  const res = persistMemory(rt.db, row.dotId, row.id, derived, { defaults: rt.defaults });
  appendAudit(rt.db, {
    dotId: row.dotId,
    taskId: row.taskId,
    approvalId: row.id,
    actor: 'owner',
    channel: 'system',
    action: 'memory_created',
    tier: row.tier,
    tool: row.tool,
    decision: 'allow',
    reason: derived.text,
    details: { memoryId: res.id, source: res.source, reused: res.reused, ruleKey: derived.ruleKey },
  });
}

// ── §3.3.6 claim：执行前原子认领 ──────────────────────────────────────────────

export interface ClaimResult {
  ok: boolean;
  /** ok 时固化的执行参数（§S2：执行只认 claim() 后落库的 final_params_json）。 */
  finalParams?: Record<string, unknown>;
  reason?: string;
  status?: ApprovalStatus;
}

/**
 * 执行前认领（接缝 S1）：条件 UPDATE `WHERE status='approved'` 原子认领；
 * revoke 与 claim 竞态同一模式——**谁先提交谁赢**。
 * 认领成功即把 `final_params_json` 固化（S2：执行不复用内存旧参）。
 */
export async function claim(
  approvalId: number,
  rt: GovernanceRuntime = gov(),
): Promise<ClaimResult> {
  const { db, deps } = rt;
  const current = getRow(db, approvalId);
  if (current === null) return { ok: false, reason: `审批单 #${approvalId} 不存在` };
  // 非 approved 一律不认领（含 revoked/executing/终态）：状态机防御走返回值而非抛错，
  // 让调用方（evaluate 的 claimAndAllow / 执行面）能按普通竞态失败处理。
  if (current.status !== 'approved') {
    return { ok: false, status: current.status, reason: `认领失败：当前状态 ${current.status}` };
  }

  const finalParamsJson = current.finalParamsJson ?? current.paramsJson;
  let changes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db
      .prepare(
        `UPDATE approvals SET status='executing', final_params_json=$params
          WHERE id=$id AND status='approved'`,
      )
      .run({ params: finalParamsJson, id: approvalId }) as unknown as { changes: number };
    changes = Number(res.changes);
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }

  if (changes === 0) {
    const after = getRow(db, approvalId)!;
    return { ok: false, status: after.status, reason: `认领失败：当前状态 ${after.status}` };
  }

  const after = getRow(db, approvalId)!;
  appendAudit(db, {
    dotId: after.dotId,
    taskId: after.taskId,
    approvalId,
    actor: 'agent',
    channel: 'system',
    action: 'approval_claimed',
    tier: after.tier,
    tool: after.tool,
    decision: 'executing',
    reason: '执行前原子认领',
  });
  deps?.bus.publish('approval:claimed', { id: after.id, seq: after.seq }, { dotId: after.dotId });

  let finalParams: Record<string, unknown> = {};
  try {
    finalParams = JSON.parse(after.finalParamsJson ?? after.paramsJson) as Record<string, unknown>;
  } catch {
    finalParams = {};
  }
  return { ok: true, finalParams, status: 'executing' };
}

/** evaluate 的 approved 重入分支：认领后放行（§3.1 `claimAndAllow`）。 */
async function claimAndAllow(
  rt: GovernanceRuntime,
  ctx: GovCtx,
  row: ApprovalRow,
): Promise<Decision> {
  const res = await claim(row.id, rt);
  if (!res.ok) {
    // 认领竞态输给 revoke：视同拒绝，控制面 skipStep。
    const decisionId = insertDecision(rt.db, {
      decisionId: newDecisionId(),
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      journalStep: row.journalStep ?? '',
      kind: 'deny',
      tier: row.tier,
      tool: row.tool,
      paramsJson: row.paramsJson,
      reason: `已批单被撤销：${res.reason ?? res.status ?? 'unknown'}`,
      approvalId: row.id,
    });
    appendAudit(rt.db, {
      dotId: ctx.dotId,
      taskId: ctx.taskRef.taskId,
      approvalId: row.id,
      decisionId,
      actor: 'agent',
      channel: 'system',
      action: 'decision',
      tier: row.tier,
      tool: row.tool,
      decision: 'deny',
      reason: `已批单被撤销：${res.reason ?? res.status ?? 'unknown'}`,
    });
    return { kind: 'deny', decisionId, reason: `已批单被撤销：${res.reason ?? res.status ?? 'unknown'}` };
  }
  const decisionId = insertDecision(rt.db, {
    decisionId: newDecisionId(),
    dotId: ctx.dotId,
    taskId: ctx.taskRef.taskId,
    journalStep: row.journalStep ?? '',
    kind: 'allow',
    tier: row.tier,
    tool: row.tool,
    paramsJson: row.paramsJson,
    reason: '重入：已批单认领放行',
    approvalId: row.id,
    fromMemory: null,
  });
  // §3.1 末行：每个出口都 INSERT decisions 并 audit('decision')——
  // allow 出口与 deny 出口对称（此前 allow 分支漏了审计）。
  appendAudit(rt.db, {
    dotId: ctx.dotId,
    taskId: ctx.taskRef.taskId,
    approvalId: row.id,
    decisionId,
    actor: 'agent',
    channel: 'system',
    action: 'decision',
    tier: row.tier,
    tool: row.tool,
    decision: 'allow',
    reason: '重入：已批单认领放行',
  });
  return { kind: 'allow', decisionId, brief: null };
}

// ── §3.3.6 revoke：仅 approved 未认领时 ────────────────────────────────────────

export interface RevokeResult {
  ok: boolean;
  reason?: string;
  /** 抢在 claim 之前成功撤销（控制面据此标 skipped_by_revocation）。 */
  revoked?: boolean;
}

/**
 * §3.2/§3.3.6：approved → revoked（仅未认领时；executing 之后不可逆，不接受 revoke）。
 * revoke 抢先则 `onApprovalSettled(taskId, id, false, {revoke:'pre-claim'})`，
 * 控制面将 journal 步标 `skipped_by_revocation`（S1）。
 */
export async function revoke(
  approvalId: number,
  actor: string,
  reason: string,
  rt: GovernanceRuntime = gov(),
): Promise<RevokeResult> {
  const { db, deps } = rt;
  const current = getRow(db, approvalId);
  if (current === null) return { ok: false, reason: `审批单 #${approvalId} 不存在` };
  if (current.status !== 'approved') {
    appendAudit(db, {
      dotId: current.dotId,
      taskId: current.taskId,
      approvalId,
      actor: 'owner',
      channel: 'cli',
      action: 'illegal_transition',
      decision: 'revoked',
      reason: `拒绝撤销：当前状态 ${current.status}`,
      details: { from: current.status, to: 'revoked' },
    });
    return { ok: false, reason: `撤销失败：当前状态 ${current.status}（仅 approved 可撤销）` };
  }

  let changes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db
      .prepare(
        `UPDATE approvals SET status='revoked', decided_by='cli', decided_at=$now, note=$note
          WHERE id=$id AND status='approved'`,
      )
      .run({ now: new Date().toISOString(), note: sanitizeText(reason).slice(0, 500), id: approvalId }) as unknown as {
        changes: number;
      };
    changes = Number(res.changes);
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }

  if (changes === 0) {
    const after = getRow(db, approvalId)!;
    return { ok: false, reason: `撤销失败：已被认领或状态已变（${after.status}）` };
  }

  const after = getRow(db, approvalId)!;
  appendAudit(db, {
    dotId: after.dotId,
    taskId: after.taskId,
    approvalId,
    actor: 'owner',
    channel: 'cli',
    action: 'approval_revoked',
    tier: after.tier,
    tool: after.tool,
    decision: 'revoked',
    reason: `主人（${actor}）撤销：${reason}`,
  });
  deps?.bus.publish(
    'approval:revoked',
    { id: after.id, seq: after.seq, reason },
    { dotId: after.dotId },
  );
  // §3.3.6：revoke 抢先 ⇒ settle(false, {revoke:'pre-claim'}) ⇒ 控制面标 skipped_by_revocation。
  deps?.controlPlane.onApprovalSettled(after.taskId, after.id, false, { revoke: 'pre-claim' });
  return { ok: true, revoked: true };
}

// ── §3.3.6 resolveExecution：executing → executed / failed ─────────────────────

export interface ResolveExecResult {
  ok: boolean;
  status?: 'executed' | 'failed';
  reason?: string;
}

/**
 * §2.5/§3.2：执行收口。
 * - 执行成功 ⇒ status=executed；tier=spend ⇒ 插 `kind='charge'` 台账行（正数）；
 * - 执行失败 ⇒ status=failed；tier=spend ⇒ 插 `kind='void'` 冲账行（负数金额），
 *   供人工核账（failed 不回退状态，只记审计+台账冲账）。
 *
 * §5.2 后审接线（原缺口：postReview 无生产调用方）：`resultDigest` 非空且满足
 * §5.2 触发条件时，本函数即后审入口——结论回写 decisions
 * （`postreview`/`postreview_json`/`injection_suspect`）、落 `postreview` 审计，
 * quarantine 判成立则走 §5.4 `quarantineDot`。后审**不阻断任务流**（告警定位）。
 */
export async function resolveExecution(
  approvalId: number,
  outcome: { ok: boolean; resultDigest?: string; errorText?: string },
  rt: GovernanceRuntime = gov(),
): Promise<ResolveExecResult> {
  const { db, deps } = rt;
  const current = getRow(db, approvalId);
  if (current === null) return { ok: false, reason: `审批单 #${approvalId} 不存在` };
  if (current.status !== 'executing') {
    return { ok: false, reason: `resolveExecution 失败：当前状态 ${current.status}` };
  }
  const to: ApprovalStatus = outcome.ok ? 'executed' : 'failed';
  assertTransition('executing', to);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE approvals SET status=$to WHERE id=$id AND status='executing'`).run({
      to,
      id: approvalId,
    });
    // §2.5：台账写入者是治理自己。
    if (current.tier === 'spend' && current.kind === 'tool_call') {
      const spend = readSpend(current.paramsJson);
      if (spend !== null) {
        const charge = outcome.ok;
        db.prepare(
          `INSERT INTO spend_ledger (dot_id, approval_id, decision_id, category,
                                     amount_cents, currency, kind, note)
           VALUES ($dotId, $approvalId, NULL, $category, $amount, $currency, $kind, $note)`,
        ).run({
          dotId: current.dotId,
          approvalId: current.id,
          category: spend.category,
          amount: charge ? spend.amountCents : -spend.amountCents,
          currency: spend.currency,
          kind: charge ? 'charge' : 'void',
          note: charge ? '执行成功扣账' : '审批通过但执行失败，冲账',
        });
        appendAudit(db, {
          dotId: current.dotId,
          taskId: current.taskId,
          approvalId: current.id,
          actor: 'system',
          channel: 'system',
          action: charge ? 'spend_recorded' : 'spend_voided',
          tier: current.tier,
          tool: current.tool,
          decision: charge ? 'charge' : 'void',
          reason: charge ? 'spend 执行成功' : 'spend 执行失败冲账',
          details: { ...spend, signedAmount: charge ? spend.amountCents : -spend.amountCents },
        });
      }
    }
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已回滚
    }
    throw cause;
  }

  const after = getRow(db, approvalId)!;
  appendAudit(db, {
    dotId: after.dotId,
    taskId: after.taskId,
    approvalId,
    actor: 'agent',
    channel: 'system',
    action: 'approval_decided',
    tier: after.tier,
    tool: after.tool,
    decision: to,
    reason: outcome.ok
      ? '执行成功'
      : `执行失败：${outcome.errorText !== undefined && outcome.errorText !== '' ? outcome.errorText.slice(0, 200) : '执行面未给出原因'}`,
  });

  // §5.2 执行后审查：触发条件满足才跑（非每步全审，吞吐现实）。
  // 后审定位是告警与隔离，不阻断任务流 ⇒ 放在状态收口之后。
  if (outcome.ok && outcome.resultDigest !== undefined && current.kind === 'tool_call') {
    const digest = outcome.resultDigest;
    if (postReviewTriggered(current.tier ?? 'read', { callId: current.journalStep ?? '', tool: current.tool ?? '', params: safeJsonParams(current.paramsJson) }, digest)) {
      await runPostReview(rt, current, digest);
    }
  }
  return { ok: true, status: to };
}

/**
 * §5.2 后审执行体（resolveExecution 的接线点）：
 * 1. `postReview()` 三分类（审查器不可用 ⇒ suspicious，永不 fail-open 为 ok）；
 * 2. 回写 decisions：`postreview`/`postreview_json`/`injection_suspect`（§5.2 第 5 步）；
 * 3. 落 `postreview` 审计（§6 唯一落点；suspicious ⇒ Web 黄标数据源）；
 * 4. quarantine ⇒ §5.4 `quarantineDot`（先 INSERT 成功才发事件）。
 *
 * decisionId 取本审批单对应的最后一条 decisions 行（§5.3：journal 重放可反查）。
 */
async function runPostReview(
  rt: GovernanceRuntime,
  row: ApprovalRow,
  resultDigest: string,
): Promise<void> {
  const { db, deps, defaults } = rt;
  const call: ToolCall = {
    callId: row.journalStep ?? `ap_${row.id}`,
    tool: row.tool ?? '',
    params: safeJsonParams(row.paramsJson),
  };
  const r = await postReview(rt.deps!.router, call, row.tier ?? 'read', resultDigest, { defaults });

  const dec = db
    .prepare(
      `SELECT id FROM decisions WHERE approval_id=$id ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get({ id: row.id }) as { id: string } | undefined;
  if (dec !== undefined) {
    writePostReview(db, dec.id, r);
  }

  appendAudit(db, {
    dotId: row.dotId,
    taskId: row.taskId,
    journalStep: row.journalStep,
    decisionId: dec?.id ?? null,
    approvalId: row.id,
    actor: 'system',
    channel: 'system',
    action: 'postreview',
    tier: row.tier,
    tool: row.tool,
    decision: r.result,
    reason: r.reason,
    details: { injectionSuspect: r.injectionSuspect, decisionId: dec?.id ?? null },
  });

  if (r.result === 'quarantine') {
    quarantineDot(db, deps, {
      dotId: row.dotId,
      decisionId: dec?.id ?? `dec_unknown_ap_${row.id}`,
      approvalId: row.id,
      reason: `后审判隔离：${r.reason}`,
    });
  }
}

interface SpendParams {
  amountCents: number;
  currency: string;
  category: string;
}

function readSpend(paramsJson: string): SpendParams | null {
  try {
    const p = JSON.parse(paramsJson) as Record<string, unknown>;
    const amountCents = p.amountCents;
    const currency = p.currency;
    const category = p.category;
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
      return null;
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
    if (typeof category !== 'string' || category.length === 0) return null;
    return { amountCents, currency, category };
  } catch {
    return null;
  }
}

/** §2.5 recordSpendAdjustment：Web 人工补录（"执行成功但实际未扣款/部分扣款"的修正）。 */
export function recordSpendAdjustment(
  approvalId: number,
  input: { category: string; amountCents: number; currency: string; note?: string; decisionId?: string },
  actor: string,
  rt: GovernanceRuntime = gov(),
): { ok: boolean; ledgerId?: number; reason?: string } {
  const { db } = rt;
  const current = getRow(db, approvalId);
  if (current === null) return { ok: false, reason: `审批单 #${approvalId} 不存在` };
  if (!/^[A-Z]{3}$/.test(input.currency)) return { ok: false, reason: 'currency 需 ISO4217 三字母' };
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    return { ok: false, reason: 'amountCents 需为非零整数（补录可正可负）' };
  }
  const res = db
    .prepare(
      `INSERT INTO spend_ledger (dot_id, approval_id, decision_id, category,
                                 amount_cents, currency, kind, note)
       VALUES ($dotId, $approvalId, $decisionId, $category, $amount, $currency, 'adjust', $note)`,
    )
    .run({
      dotId: current.dotId,
      approvalId,
      decisionId: input.decisionId ?? null,
      category: input.category,
      amount: input.amountCents,
      currency: input.currency,
      note: input.note ?? null,
    }) as unknown as { lastInsertRowid: number | bigint };
  const ledgerId = Number(res.lastInsertRowid);
  appendAudit(db, {
    dotId: current.dotId,
    taskId: current.taskId,
    approvalId,
    actor: 'owner',
    channel: 'web',
    action: 'spend_recorded',
    tier: current.tier,
    tool: current.tool,
    decision: 'adjust',
    reason: `人工补录（${actor}）`,
    details: { ledgerId, ...input },
  });
  return { ok: true, ledgerId };
}

// ── §3.6 forceApproval：非工具审批单 ───────────────────────────────────────────

/**
 * §3.6/§8.1 forceApproval(taskId, req)：同步签发 pending 单，走同一状态机、同一双通道、
 * 同一先到先得规则——治理不为非工具主语造第二套流程。
 *
 * 幂等：命中 `uniq_open_subject`（同 subject_key 已有活动单）⇒ 复用既有单
 * （侦察候选按模型名去重、副作用未知按 callId）。
 */
export async function forceApproval(
  taskId: string,
  req: ForceApprovalReq,
  rt: GovernanceRuntime = gov(),
): Promise<ForceApprovalResult> {
  const { db } = rt;
  const subject: SyntheticSubject = { kind: req.kind, ...req.subject } as unknown as SyntheticSubject;
  const subjectKey = subjectKeyOf(req.kind, req.subject);

  const existing = db
    .prepare(
      `SELECT * FROM approvals WHERE subject_key=$key AND kind!='tool_call'
        AND status IN ('pending','approved','executing') ORDER BY id DESC LIMIT 1`,
    )
    .get({ key: subjectKey }) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    return { approvalId: Number(existing.id), reused: true };
  }

  const dotId = DEFAULT_DOT(rt);
  const row = insertApproval(
    rt,
    { dotId, taskRef: { taskId, journalStepId: `synthetic:${subjectKey}` }, emergency: false },
    { callId: `synthetic:${subjectKey}`, tool: '', params: {} },
    {
      // §3.6：recon_candidate/side_effect_unknown 归 synthetic 单，question 归 question 单。
      kind: req.kind === 'question' ? 'question' : 'synthetic',
      tier: null,
      reason: req.reason,
      paramsJson: JSON.stringify({ subject: req.subject }),
      subject,
      subjectKey,
      ttlMs: req.ttlMs,
    },
  );
  return { approvalId: row.id, reused: false };
}

function DEFAULT_DOT(rt: GovernanceRuntime): string {
  const row = rt.db
    .prepare('SELECT dot_id FROM approvals ORDER BY id DESC LIMIT 1')
    .get() as { dot_id: string } | undefined;
  return row?.dot_id ?? 'dot1';
}

// ── §3.4 expirePending / 提醒扫描 ─────────────────────────────────────────────

export interface ExpireResult {
  expired: number;
  reminded: number;
  expiredIds: number[];
}

/**
 * §3.4 超时与提醒（cron 每 5 分钟）：
 * 1. `status='pending' AND pending_until < now` → expired（随后逐条 hooks.settle）；
 * 2. `reminded_at IS NULL AND pending_until < now+1h` → 重发一次并回填 `reminded_at=now`，
 *    **不刷新 pending_until**（防刷屏续命）。
 */
export async function expirePending(
  rt: GovernanceRuntime = gov(),
  now: number = Date.now(),
): Promise<ExpireResult> {
  const { db, deps } = rt;
  const nowIso = new Date(now).toISOString();
  const soonIso = new Date(now + 3_600_000).toISOString();
  const expiredIds: number[] = [];

  // 1. 超时转 expired（逐条条件更新，语义等同批量命令逐条生效，§3.3.7）。
  const due = db
    .prepare(`SELECT * FROM approvals WHERE status='pending' AND pending_until < $now`)
    .all({ now: nowIso }) as unknown as Record<string, unknown>[];
  for (const r of due) {
    const row = toRow(r);
    const res = db
      .prepare(
        `UPDATE approvals SET status='expired', decided_at=$now, decided_by=NULL
          WHERE id=$id AND status='pending'`,
      )
      .run({ now: nowIso, id: row.id }) as unknown as { changes: number };
    if (Number(res.changes) === 0) continue;
    expiredIds.push(row.id);
    appendAudit(db, {
      dotId: row.dotId,
      taskId: row.taskId,
      approvalId: row.id,
      actor: 'system',
      channel: 'system',
      action: 'approval_expired',
      tier: row.tier,
      tool: row.tool,
      decision: 'expired',
      reason: `pending_until=${row.pendingUntil} 已过`,
    });
    deps?.bus.publish(
      'approval:expired',
      { id: row.id, seq: row.seq, status: 'expired' as ApprovalStatus },
      { dotId: row.dotId },
    );
    // §3.3.4：扫描事务提交后逐条调 hooks.settle（提交后立即联动，无悬空事件）。
    deps?.controlPlane.onApprovalSettled(row.taskId, row.id, false, { revoke: 'expired' });
  }

  // 2. 过期前 1h 提醒一次（回填 reminded_at，不刷新 pending_until）。
  const remind = db
    .prepare(
      `SELECT * FROM approvals
        WHERE status='pending' AND reminded_at IS NULL AND pending_until < $soon`,
    )
    .all({ soon: soonIso }) as unknown as Record<string, unknown>[];
  let reminded = 0;
  for (const r of remind) {
    const row = toRow(r);
    const res = db
      .prepare(
        `UPDATE approvals SET reminded_at=$now
          WHERE id=$id AND status='pending' AND reminded_at IS NULL`,
      )
      .run({ now: nowIso, id: row.id }) as unknown as { changes: number };
    if (Number(res.changes) === 0) continue;
    reminded++;
  }

  return { expired: expiredIds.length, reminded, expiredIds };
}

// ── TG 侧回填（§3.4：tg_message_id/batch_ref 由治理回填、交互面消费）───────────

/** §S4：交互面发出 TG 通知后回填消息 id（回调反查与 editMessage 用）。 */
export function recordTgMessage(
  approvalId: number,
  tgMessageId: number,
  rt: GovernanceRuntime = gov(),
): void {
  rt.db
    .prepare(`UPDATE approvals SET tg_message_id=$mid WHERE id=$id`)
    .run({ mid: tgMessageId, id: approvalId });
}

/** §S4：callbackData `g:<approvalId>:<y|d>` 解析（结构化，最稳）。 */
export function parseTgCallback(
  data: string,
): { approvalId: number; verdict: Verdict } | null {
  const m = /^g:(\d+):(y|d)$/.exec(data.trim());
  if (m === null) return null;
  return { approvalId: Number(m[1]), verdict: m[2] === 'y' ? 'approve_once' : 'reject' };
}

/**
 * §3.4 别名表（两模块语法统一，评审缺口#2）。
 *
 * 逐字来源（governance.md §3.4）：
 * `y|yes|a|approve|/yes N`→approve_once；`d|no|deny|/no N`→reject；
 * `q|info|/info N`→详情；`l|list`；`all`；`/answer N <文本>`→question 单的 approve_once+note。
 *
 * 解析优先级（§3.4）：callbackData → reply 反查 → 文本指令。本函数只管后两者：
 * `approvalId` 优先取文本里的 N，其次取 `replyToMsgId` 经 `byMessageId` 反查的结果。
 * 竖线后文本一律作为 note（"y 12 | 只跑 dry-run"）。
 *
 * 返回形状分三种：裁决（approvalId+verdict）、动作（list/all/info/unknown）。
 * `approve_remember` 在 TG **禁用**（规则授权须在 Web 点"批准并记住"）⇒
 * `remember`/`m` 一律 unknown。
 */
export function parseTgText(
  text: string,
  replyToMsgId?: number,
  byMessageId?: (msgId: number) => number | null,
):
  | { approvalId: number; verdict: Verdict; note?: string }
  | { action: 'list' | 'all' | 'info'; approvalId?: number }
  | { action: 'unknown' } {
  const t = text.trim();
  if (t === '') return { action: 'unknown' };

  // —— 全局动作（不带 id）——
  if (t === 'l' || t === 'list') return { action: 'list' };
  if (t === 'all') return { action: 'all' };

  // "y 12 | 只跑dry-run" —— 竖线后文本作为 note 传达给 Agent（§3.4）。
  const bar = t.indexOf('|');
  const body = bar === -1 ? t : t.slice(0, bar).trim();
  const note = bar === -1 ? undefined : t.slice(bar + 1).trim();

  /** id 定位：文本 N 优先，否则 reply 反查；都拿不到 ⇒ null。 */
  const locate = (num: string | undefined): number | null => {
    if (num !== undefined) return Number(num);
    if (replyToMsgId !== undefined) return byMessageId?.(replyToMsgId) ?? null;
    return null;
  };

  // —— 斜杠形（/yes N / /no N / /info N / /answer N <文本>）——
  const slash = /^\/([a-z]+)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/i.exec(body);
  if (slash !== null) {
    const cmd = slash[1]!.toLowerCase();
    const num = slash[2];
    if (cmd === 'yes' || cmd === 'y' || cmd === 'a' || cmd === 'approve') {
      const approvalId = locate(num);
      return approvalId === null
        ? { action: 'unknown' }
        : { approvalId, verdict: 'approve_once', note };
    }
    if (cmd === 'no' || cmd === 'd' || cmd === 'deny') {
      const approvalId = locate(num);
      return approvalId === null
        ? { action: 'unknown' }
        : { approvalId, verdict: 'reject', note };
    }
    if (cmd === 'info' || cmd === 'q') {
      const approvalId = locate(num);
      return approvalId === null ? { action: 'info' } : { action: 'info', approvalId };
    }
    if (cmd === 'answer') {
      // §3.4：`/answer N <文本>` → question 单的 approve_once+note。
      const approvalId = num === undefined ? null : Number(num);
      const answerText = (slash[3] ?? '').trim();
      if (approvalId === null) return { action: 'unknown' };
      return { approvalId, verdict: 'approve_once', note: answerText === '' ? note : answerText };
    }
    return { action: 'unknown' };
  }

  // —— 裸词形（y / yes / a / approve / d / no / deny / q / info）——
  const bare = /^([a-z]+)(?:\s+(\d+))?$/i.exec(body);
  if (bare !== null) {
    const cmd = bare[1]!.toLowerCase();
    const num = bare[2];
    if (/^(?:y|yes|a|approve)$/.test(cmd)) {
      const approvalId = locate(num);
      return approvalId === null
        ? { action: 'unknown' }
        : { approvalId, verdict: 'approve_once', note };
    }
    if (/^(?:d|no|deny)$/.test(cmd)) {
      const approvalId = locate(num);
      return approvalId === null
        ? { action: 'unknown' }
        : { approvalId, verdict: 'reject', note };
    }
    if (cmd === 'q' || cmd === 'info') {
      const approvalId = locate(num);
      return approvalId === null ? { action: 'info' } : { action: 'info', approvalId };
    }
  }
  return { action: 'unknown' };
}

/**
 * GOV §8.1 `resolveTelegram(text, replyToMsgId?, callbackData?)`：
 * 交互面 TG 处理器的**唯一解析入口**（接缝契约 S-1「审批回复→`gov.decide()/
 * resolveTelegram()` 不进事件流」）。
 *
 * 解析优先级（§3.4 逐字）：callbackData（结构化，最稳）→ reply 到审批通知
 * （tg_message_id 反查 approvalId）→ 文本指令。
 *
 * 只解析、**不裁决**：裁决写路径唯一是 `decide()`（S-2）。调用方拿到裁决意图后
 * 自行决定调 `decide()` 还是回"未识别的审批指令"+pending 列表。
 */
export function resolveTelegram(
  text: string,
  replyToMsgId?: number,
  callbackData?: string,
  byMessageId?: (msgId: number) => number | null,
):
  | { approvalId: number; verdict: Verdict; note?: string }
  | { action: 'list' | 'all' | 'info'; approvalId?: number }
  | { action: 'unknown' } {
  // 1) callbackData（结构化，最稳）
  if (callbackData !== undefined && callbackData !== '') {
    const cb = parseTgCallback(callbackData);
    if (cb !== null) return cb;
  }
  // 2) reply 反查 + 3) 文本指令（parseTgText 内部按此顺序）
  return parseTgText(text, replyToMsgId, byMessageId);
}

/** §3.4 通知文案（交互面发送；治理只负责生成文本）。 */
export function renderTgNotice(row: ApprovalRow): string {
  const tierTag = row.tier === null ? '—' : row.tier;
  const lines = [
    `⚠ 审批 AP-#${row.seq} 档位:${tierTag}`,
    `理由: ${row.reason}`,
    row.kind === 'tool_call' ? `工具: ${row.tool ?? ''} ${row.paramsJson}` : `主语: ${row.subjectJson ?? ''}`,
    `摘要: ${row.summary}`,
    `回复: y ${row.id} 批一次 · d ${row.id} 拒 · q ${row.id} 详情（也可直接回复本消息）`,
  ];
  if (row.tier === 'spend' || row.tier === 'dangerous') {
    lines.push('批量: l 待批列表（spend/dangerous 不参与 all）');
  } else {
    lines.push('批量: l 待批列表 · all 全部批准（仅 tier≤browser）');
  }
  return lines.join('\n');
}

// ── 应急模式刷新（契约 S5：订阅 router.mode_changed，读 snapshot().emergencyActive）──

export interface EmergencyWatcher {
  stop(): void;
}

/**
 * 契约 S5 修订：GOV 不订阅作废的 `governance:emergency` 事件，改为订阅
 * `router.mode_changed`（bus.ts TOPICS 已登记），emergency 由 ctx.emergency 传入；
 * 这里只维护"策略缓存失效 + 审计 emergency_on/off"。
 */
export function watchEmergency(
  rt: GovernanceRuntime,
  bus: { on<E>(topic: string, handler: (event: { payload: E; dotId: string }) => void): () => void },
): EmergencyWatcher {
  let last: boolean | null = null;
  const off = bus.on<{ from: string; to: string }>('router.mode_changed', (ev) => {
    const on = ev.payload.to === 'EMERGENCY';
    if (last === on) return;
    last = on;
    appendAudit(rt.db, {
      actor: 'system',
      channel: 'system',
      action: on ? 'emergency_on' : 'emergency_off',
      reason: `router.mode_changed → ${ev.payload.to}`,
    });
    // 应急切换清审查熔断窗口：旧窗口的失败样本对新策略无意义。
    noteSuccess(rt.breaker);
  });
  return { stop: off };
}

/** 终态/开放态再导出（S3：交互面徽章与按钮用同名联合）。 */
export { isTerminal, OPEN_STATUSES, assertTransition };
export type { DecideResult, ForceApprovalResult, ToolCall };
export { stricterOrEqual };
export { newBreaker, noteFail, isDegraded };
