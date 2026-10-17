/**
 * src/governance/review.ts —— 执行前审查 / 执行后审查（GOV §5）。
 *
 * 逐字来源：governance.md §5.1 precheckModel、§5.1.1 容量核算、§5.1.2 超时降级矩阵、
 * §5.2 postReview、§7 SANITIZE_PATTERNS。
 *
 * 接缝契约修订（相对磁盘稿）：
 * - G4/T1：不走 `router.lowIntelligence.complete()`（作废），统一走
 *   `router.complete({track:'light', deadlineMs:45000, attemptId:'nonj:'+ULID})`；
 * - S5：不订阅 `governance:emergency` 事件（作废），emergency 由控制面经
 *   `router.mode_changed` 广播、治理读 `snapshot().emergencyActive` 刷新（见 gate.ts）；
 * - 单次失败即 fail-closed（precheck 不可用 ⇒ 转人工 approve），熔断只决定降级矩阵。
 */

import type { DatabaseSync } from 'node:sqlite';
import { newNonJournalAttemptId } from '../shared/ids.ts';
import type { GovCtx, PrecheckBrief } from '../shared/contracts.ts';
import { govDefaults, sanitizeText } from './config.ts';
import type { GovDefaults } from './config.ts';
import type { ToolCall } from './types.ts';
import type { ToolTier } from '../shared/contracts.ts';

// ── §7 sanitize 再导出（§8.1 导出面：precheckModel/postReview/sanitize）──────────

export { sanitizeText as sanitize };

/** precheck 行协议输出（§5.1.1：非 JSON，`S|R|理由≤20字`）。 */
export interface PrecheckVerdict {
  verdict: 'safe' | 'risky';
  reason: string;
  /** 降级放行标记（§5.1.2）：审查器缺席时 write_file 档的 allow 需带此标记。 */
  degraded?: 'degraded';
  /** 原始模型输出（审计/复核用）。 */
  raw?: string;
}

/** postReview 三分类（§5.2：永不 fail-open 为 ok）。 */
export type PostReviewResult = 'ok' | 'suspicious' | 'quarantine';

/** §5.1.2 熔断状态（治理进程内维护，落审计 `precheck_degraded`）。 */
export interface ReviewBreaker {
  /** 滚动窗口内的失败时间戳（ms）。 */
  fails: number[];
  /** 熔断打开截止时刻（ms）；0 = closed。 */
  openUntil: number;
  /** 半开探测中：一次放行用于试探是否恢复。 */
  halfOpenProbeInFlight: boolean;
}

export function newBreaker(): ReviewBreaker {
  return { fails: [], openUntil: 0, halfOpenProbeInFlight: false };
}

/** 当前是否 degraded（含半开探测语义：open 期已过且无在飞探测 ⇒ 视为 closed）。 */
export function isDegraded(b: ReviewBreaker, now = Date.now()): boolean {
  if (b.openUntil === 0) return false;
  return now < b.openUntil;
}

/** 记录一次失败；达到阈值即开熔断（返回是否本次触发开启）。 */
export function noteFail(b: ReviewBreaker, defaults: GovDefaults, now = Date.now()): boolean {
  const { windowMs, fails, openMs } = defaults.reviewFailThreshold;
  b.fails.push(now);
  b.fails = b.fails.filter((t) => t > now - windowMs);
  if (b.fails.length >= fails && b.openUntil < now) {
    b.openUntil = now + openMs;
    b.halfOpenProbeInFlight = false;
    return true;
  }
  return false;
}

/** 记录一次成功：清失败窗口并关熔断。 */
export function noteSuccess(b: ReviewBreaker): void {
  b.fails = [];
  b.openUntil = 0;
  b.halfOpenProbeInFlight = false;
}

// ── §5.1.1 容量核算 ───────────────────────────────────────────────────────────

/** goalDigest 截断（调用方义务 §5.1.1：≤800 字节）；这里兜底再切一次。 */
export function truncateGoal(goal: string, defaults: GovDefaults): string {
  const limit = defaults.precheckBudget.goalBytes;
  return goal.length <= limit ? goal : goal.slice(0, limit);
}

/** 脱敏参数截断（§5.1.1：≤1.5KB）。 */
export function truncateParams(params: unknown, defaults: GovDefaults): string {
  let raw: string;
  try {
    raw = JSON.stringify(params) ?? '';
  } catch {
    raw = '[unserializable params]';
  }
  const clean = sanitizeText(raw);
  const limit = defaults.precheckBudget.paramsBytes;
  return clean.length <= limit ? clean : clean.slice(0, limit) + '…';
}

const PRECHECK_SYSTEM =
  '你是工具调用执行前安全审查器。只输出一行：S 表示安全可放行，R 表示有风险需人工审批。' +
  '格式：S|R|理由（理由不超过20个汉字，不加解释）。';

const PRECHECK_USER_TMPL = (tool: string, tier: string, goal: string, params: string): string =>
  `目标：${goal}\n工具：${tool}（档位 ${tier}）\n参数：${params}\n判定：`;

/** 构造 precheck 消息（容量核算的三段：系统模板 ≈150 tok + 截断 goal + 截断 params）。 */
export function precheckMessages(
  call: ToolCall,
  tier: ToolTier,
  goalDigest: string,
  defaults: GovDefaults,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: PRECHECK_SYSTEM },
    {
      role: 'user',
      content: PRECHECK_USER_TMPL(
        call.tool,
        tier,
        truncateGoal(goalDigest, defaults),
        truncateParams(call.params, defaults),
      ),
    },
  ];
}

/** 解析行协议输出：`S|理由` / `R|理由`；无法解析 ⇒ risky（fail-closed）。 */
export function parsePrecheckLine(raw: string): PrecheckVerdict {
  const line = raw.trim().split('\n')[0] ?? '';
  const m = /^\s*([SR])\s*\|\s*(.*)$/.exec(line);
  if (m === null) return { verdict: 'risky', reason: '审查器输出无法解析', raw };
  const verdict = m[1] === 'S' ? 'safe' : 'risky';
  const reason = (m[2] ?? '').slice(0, 20);
  return { verdict, reason, raw };
}

// ── §5.1 precheckModel ────────────────────────────────────────────────────────

/** 治理依赖的最小模型调用面（契约 G4/T1：complete({track:'light'})）。 */
export interface ReviewRouter {
  complete(req: {
    track: 'light';
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    attemptId: string;
    deadlineMs: number;
    maxTokens?: number;
  }): Promise<{ response: { content: string } }>;
}

/**
 * GOV §5.1 precheckModel：走低智能轨审查，超时/不可用按 §5.1.2 降级矩阵处理。
 *
 * 降级矩阵（逐字）：
 * | tier | 正常 | degraded 非应急 | degraded 且 emergency |
 * | write_file | review→allow | allow + reviewSkipped=degraded | allow + reviewSkipped |
 * | browser | review→allow | approve（人工） | approve（人工） |
 * | browser+登录态 | 恒 approve | 恒 approve | 恒 approve |
 *
 * 实现口径（deviation 记录）：磁盘稿只规定"降级矩阵"，未规定**单次**失败的处理；
 * 这里取 fail-closed——单次审查器不可用 ⇒ 返回 risky（转人工 approve），
 * 只有熔断打开（10min 内 5 次失败）才进入矩阵的 degraded 分支。
 */
export async function precheckModel(
  router: ReviewRouter,
  breaker: ReviewBreaker,
  call: ToolCall,
  tier: ToolTier,
  goalDigest: string,
  ctx: GovCtx,
  opts: { defaults?: GovDefaults; now?: () => number } = {},
): Promise<PrecheckVerdict> {
  const defaults = opts.defaults ?? govDefaults();
  const now = opts.now ?? Date.now;

  // 降级期：不再涌向审查器，按矩阵处理（write_file fail-open 可逆；browser 转人工）。
  if (isDegraded(breaker, now())) {
    if (tier === 'write_file') {
      return {
        verdict: 'safe',
        reason: 'reviewSkipped=degraded',
        degraded: 'degraded',
      };
    }
    return { verdict: 'risky', reason: '审查器降级中，转人工审批' };
  }

  const attemptId = newNonJournalAttemptId();
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`precheck 超时（>${defaults.precheckTimeoutMs}ms）`)),
        defaults.precheckTimeoutMs,
      );
    });
    const res = await Promise.race([
      router.complete({
        track: 'light',
        messages: precheckMessages(call, tier, goalDigest, defaults),
        attemptId,
        deadlineMs: defaults.precheckTimeoutMs,
        maxTokens: defaults.precheckBudget.maxOutputTokens,
      }),
      timeout,
    ]);
    const parsed = parsePrecheckLine(res.response.content);
    if (parsed.verdict === 'safe') noteSuccess(breaker);
    else noteFail(breaker, defaults, now());
    return { ...parsed, raw: res.response.content };
  } catch (cause) {
    const opened = noteFail(breaker, defaults, now());
    // 单次失败即 fail-closed：转人工（browser 本来就是 approve；write_file 转人工一次）。
    return {
      verdict: 'risky',
      reason: opened ? '审查器熔断开启，转人工审批' : '审查器不可用，转人工审批',
      raw: `${String((cause as Error)?.message ?? cause)}（耗时 ${now() - startedAt}ms）`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── §5.2 postReview ───────────────────────────────────────────────────────────

/** 触发条件（§5.2）：`tier >= browser`，或 result 含 URL/金额/凭据样式，或 call 属 browser.act。 */
export function postReviewTriggered(
  tier: ToolTier,
  call: ToolCall,
  resultDigest: string,
): boolean {
  if (tier === 'browser' || tier === 'spend' || tier === 'dangerous') return true;
  if (call.tool === 'browser.act') return true;
  return sniffsSensitive(resultDigest);
}

/** URL / 金额 / 凭据样式嗅探（§5.2 触发条件第二支）。 */
export function sniffsSensitive(text: string): boolean {
  if (/https?:\/\/[^\s]+/i.test(text)) return true;
  if (/\b(?:amount|price|total|fee)\D{0,12}\d+(?:\.\d+)?/i.test(text)) return true;
  if (/\b(?:sk|pk|rk|tok)-[A-Za-z0-9]{8,}/.test(text)) return true;
  if (/\b(?:password|token|secret|cookie)\s*[:=]/i.test(text)) return true;
  return false;
}

/** 提示注入嗅探（§5.2 第 5 步）：result 含命令样文本且 verdict≠ok ⇒ injection_suspect。 */
export function injectionSuspect(resultDigest: string, verdict: PostReviewResult): boolean {
  if (verdict === 'ok') return false;
  return (
    /\b(?:ignore (?:all|previous|above) instructions|system prompt|you are now|do not tell)\b/i.test(
      resultDigest,
    ) || /(?:^|\s)(?:sudo|rm\s+-rf|curl\s[^\n]*\|\s*(?:ba)?sh|eval)\b/.test(resultDigest)
  );
}

const POST_SYSTEM =
  '你是工具调用执行后安全审查器。只输出一行：OK 表示结果正常，SUS 表示可疑（告警不阻断），' +
  'QUAR 表示必须隔离该 Dot。格式：OK|SUS|QUAR|理由（理由不超过20个汉字）。';

/** 解析后审行协议；无法解析 ⇒ suspicious（§5.2：后审永不 fail-open 为 ok）。 */
export function parsePostLine(raw: string): { result: PostReviewResult; reason: string } {
  const line = raw.trim().split('\n')[0] ?? '';
  const m = /^\s*(OK|SUS|QUAR)\s*\|\s*(.*)$/i.exec(line);
  if (m === null) return { result: 'suspicious', reason: '后审输出无法解析' };
  const tag = m[1]!.toUpperCase();
  const result: PostReviewResult =
    tag === 'OK' ? 'ok' : tag === 'SUS' ? 'suspicious' : 'quarantine';
  return { result, reason: (m[2] ?? '').slice(0, 20) };
}

/**
 * GOV §5.2 postReview：
 * 1. sanitize() 剥敏感信息 → 截断 2KB；
 * 2. 低智能轨三分类（OK|SUS|QUAR）；**审查器不可用时记 suspicious 不阻断**，
 *    且**不受降级矩阵约束，永不 fail-open 为 ok**；
 * 3. suspicious ⇒ 审计 + Web 黄标（由调用方落审计）；
 * 4. quarantine ⇒ 调用方走 §5.4 quarantineDot；
 * 5. 注入嗅探结果由调用方写 `decisions.injection_suspect`。
 */
export async function postReview(
  router: ReviewRouter,
  call: ToolCall,
  tier: ToolTier,
  resultDigest: string,
  opts: { defaults?: GovDefaults } = {},
): Promise<{ result: PostReviewResult; reason: string; injectionSuspect: boolean; raw: string }> {
  const defaults = opts.defaults ?? govDefaults();
  const clean = sanitizeText(resultDigest).slice(0, 2 * 1024);
  const attemptId = newNonJournalAttemptId();
  let raw = '';
  let parsed: { result: PostReviewResult; reason: string };
  try {
    const res = await router.complete({
      track: 'light',
      messages: [
        { role: 'system', content: POST_SYSTEM },
        {
          role: 'user',
          content: `工具：${call.tool}（档位 ${tier}）\n结果摘要：${clean}\n判定：`,
        },
      ],
      attemptId,
      deadlineMs: defaults.precheckTimeoutMs,
      maxTokens: defaults.precheckBudget.maxOutputTokens,
    });
    raw = res.response.content;
    parsed = parsePostLine(raw);
  } catch (cause) {
    // 审查器不可用 ⇒ suspicious（执行已发生，后审定位是告警不是回滚；绝不 fail-open）。
    parsed = { result: 'suspicious', reason: '后审审查器不可用' };
    raw = String((cause as Error)?.message ?? cause);
  }
  return { ...parsed, injectionSuspect: injectionSuspect(clean, parsed.result), raw };
}

/** 隔离通知正文（§5.4：隔离时经路由求救通道发 TG 通知，复用 S5 通道）。 */
export function renderQuarantineNotice(dotId: string, decisionId: string, reason: string): string {
  return `⛔ Dot ${dotId} 已被隔离\ndecision=${decisionId}\n理由：${reason}\n处置：该 Dot 队列已暂停，人工复核后可在 Web「解除隔离」。`;
}

/** 供 Web 渲染的隔离视图（§5.4 QuarantineView）。 */
export interface QuarantineView {
  dotId: string;
  decisionId: string;
  approvalId: number | null;
  reason: string;
  status: 'active' | 'lifted';
  createdAt: string;
  liftedBy?: string;
  liftedAt?: string;
}

/** 供隔离表读取的共享行投影（quarantine.ts 复用，避免两处解析逻辑漂移）。 */
export function toQuarantineView(r: Record<string, unknown>): QuarantineView {
  return {
    dotId: String(r.dot_id),
    decisionId: String(r.decision_id),
    approvalId:
      r.approval_id === null || r.approval_id === undefined ? null : Number(r.approval_id),
    reason: String(r.reason),
    status: r.status === 'lifted' ? 'lifted' : 'active',
    createdAt: String(r.created_at),
    liftedBy: r.lifted_by === null || r.lifted_by === undefined ? undefined : String(r.lifted_by),
    liftedAt: r.lifted_at === null || r.lifted_at === undefined ? undefined : String(r.lifted_at),
  };
}

/** 让 tsc 认可用到的 import（行类型只在签名里出现，运行时无需引用）。 */
export type { PrecheckBrief };
export type GovernanceDb = DatabaseSync;
