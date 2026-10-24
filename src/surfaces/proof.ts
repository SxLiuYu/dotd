/**
 * src/surfaces/proof.ts —— 执行凭证（2026-10-23）。
 *
 * 为什么做这个
 *   这是 dotd 与「另一个 OpenClaw」真正拉开距离的地方。内核（浏览器/文件/命令/定时/记忆）
 *   是商品化的，谁都能补；但**「这次任务到底做了什么、每一步能不能对账」**不是。
 *   Muse 和 OpenClaw 都给你一个结果；dotd 应该能给你一份可读、可校验的执行凭证。
 *
 * 它证明什么、不证明什么
 *   ✅ 证明：这份导出来自本机 journal；每一步的工具、参数哈希、结果哈希、审批、模型调用、
 *      耗时、token 都在；两次导出的 bundleHash 一致（同一个 journal 不会因为导出时间变而变）。
 *   ❌ 不证明：数据库没有被有权限的人改过。哈希是**执行面记账时的哈希**（exec_calls），
 *      不是第三方公证；文件本身也没有签名。想要更强，需要把 bundleHash 发布到外部。
 *   这条边界必须写在凭证首页，不能让人误以为它是公证。
 *
 * 默认不导出明文参数
 *   工具参数里可能有 token、地址、邮件正文。凭证默认只给 hash + 工具名 + 状态；
 *   要看明文，用 `--include-args`（会明确警告），且仍受 journal 的截断/脱敏限制。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { argsHash, resultHash, stableStringify } from '../exec/protocol.ts';
import type { Step, Task } from '../shared/contracts.ts';

export interface ProofStep {
  seq: number;
  kind: 'llm' | 'tool' | string;
  status: string;
  tool: string | null;
  callId: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  /** exec_calls 里记账时写入的哈希（权威）。 */
  argsHash: string | null;
  resultHash: string | null;
  /** 从 journal 的 args_json/result_json 重算的哈希；无法重算为 null。 */
  argsHashRecomputed: string | null;
  resultHashRecomputed: string | null;
  /** true=一致；false=不一致（要么 journal 被改过，要么明文被压缩过）；null=无从比对。 */
  hashMatch: boolean | null;
  /**
   * true = 只有把 journal 参数按执行面规则规范化后才一致（见 normalizeForExec）。
   *
   * 典型场景：模型给 `fs.list` 的 `path:"."`，Runner 在派发前补成 `/dot/home/.`
   * （`runner/dot.ts` 的 withHomeRootArgs）。两份记录都对，只是**哈希的输入不同**；
   * 旧版凭证把这种情形报成「不一致」，等于在可信凭证里制造假警报。
   */
  argsNormalized?: boolean;
  approvalId: number | null;
  errorCode: string | null;
  /** 仅在 includeArgs=true 时出现；调用方须自行承担泄露风险。 */
  argsPreview?: string;
  resultPreview?: string;
}

export interface ProofApproval {
  seq: number;
  id: number;
  kind: string;
  tool: string | null;
  tier: string | null;
  status: string;
  summary: string;
  reason: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  finalParamsHash: string | null;
}

export interface ProofModelCall {
  attemptId: string;
  attemptSeq: number;
  track: string;
  endpointId: string;
  model: string;
  outcome: string;
  degraded: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  ts: number;
}

export interface ProofAuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  tier: string | null;
  tool: string | null;
  decision: string | null;
  reason: string | null;
}

export interface ProofDevice {
  /** devices.id（dev_...）。 */
  id: string;
  name: string | null;
  /** 设备当前状态；已吊销的历史任务仍能读凭证，但这里会写 revoked。 */
  status: string | null;
  /** 会话通道（voice）。 */
  channel: string;
}

export interface ProofBundle {
  version: 1;
  generatedAt: number;
  task: {
    id: string;
    dotId: string;
    title: string;
    goal: string;
    status: string;
    priority: number;
    attempt: number;
    runEpoch: number;
    createdAt: number;
    updatedAt: number;
    stopReason: string | null;
  };
  /**
   * 阶段 2（2026-10-23）：语音任务的设备维度。
   *
   * 只有 `thread.channel='voice'` 且 `external_ref` 指向 devices 时才出现；
   * 其他任务**逐字不加这个键**，保证老凭证的 bundleHash 不变。
   */
  device?: ProofDevice;
  result: { ok: boolean | null; summary: string | null };
  steps: ProofStep[];
  approvals: ProofApproval[];
  modelCalls: ProofModelCall[];
  audit: ProofAuditRow[];
  counts: {
    steps: number;
    toolSteps: number;
    failedSteps: number;
    approvals: number;
    modelCalls: number;
    hashMismatches: number;
    hashUnverifiable: number;
  };
  /** 去掉 generatedAt 后的稳定哈希；同一 journal 两次导出一致。 */
  bundleHash: string;
}

export interface ProofInput {
  task: Task;
  steps: Step[];
  execCalls: Array<{
    callId: string;
    argsHash: string;
    resultHash: string | null;
    errorCode: string | null;
    state: string;
    sentAt: string;
    finishedAt: string | null;
  }>;
  approvals: Array<{
    id: number;
    seq: number;
    kind: string;
    tool: string | null;
    tier: string | null;
    status: string;
    summary: string;
    reason: string;
    decidedAt: string | null;
    decidedBy: string | null;
    note: string | null;
    finalParamsJson: string | null;
  }>;
  modelCalls: Array<{
    attemptId: string;
    attemptSeq: number;
    track: string;
    endpointId: string;
    model: string;
    outcome: string;
    degraded: number;
    latencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    ts: number;
  }>;
  audit: Array<{
    id: number;
    ts: string;
    actor: string;
    action: string;
    tier: string | null;
    tool: string | null;
    decision: string | null;
    reason: string | null;
  }>;
  result: { ok: number; summary: string } | null;
  generatedAt: number;
  /** 默认 false：只导出 hash，不导出明文参数。 */
  includeArgs?: boolean;
  /** 阶段 2：语音任务的设备维度（由 collectProof 查出来；buildProof 只做投影）。 */
  device?: ProofDevice | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** json 列的稳定哈希；无法解析（blob 路径/截断）返回 null。 */
function hashJson(text: string | null): string | null {
  if (text === null || text.length === 0) return null;
  try {
    return resultHash(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 执行面会改写参数的 fs 工具（runner/dot.ts:withHomeRootArgs，相对 path 补 home 根）。 */
const EXEC_PATH_TOOLS = new Set(['fs.read', 'fs.write', 'fs.list', 'fs.stat']);
const EXEC_HOME_ROOT = '/dot/home';

/**
 * 按执行面的规则规范化 journal 参数，返回规范化后的 JSON 文本；不适用时 null。
 *
 * 只覆盖已知的一处改写（相对路径补 `/dot/home/`）——凭证的哈希对账要能区分
 * "记录不同"和"真的对不上"，而不是把每一条 fs.list 都报成篡改。
 */
function normalizeForExec(tool: string | null, argsJson: string | null): string | null {
  if (tool === null || argsJson === null || argsJson.length === 0) return null;
  if (!EXEC_PATH_TOOLS.has(tool)) return null;
  let v: unknown;
  try {
    v = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const args = v as Record<string, unknown>;
  const p = args.path;
  if (typeof p !== 'string' || p.length === 0) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return null;
  return stableStringify({ ...args, path: `${EXEC_HOME_ROOT}/${p}` });
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** 纯投影：把 journal + exec_calls + 审批 + 模型调用 + 审计压成一份凭证。 */
export function buildProof(input: ProofInput): ProofBundle {
  const byCall = new Map(input.execCalls.map((c) => [c.callId, c]));
  const steps: ProofStep[] = [...input.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const exec = s.callId === null ? undefined : byCall.get(s.callId);
      const argsRe = hashJson(s.argsJson);
      const resultRe = hashJson(s.resultJson);
      const storedArgs = exec?.argsHash ?? null;
      const storedResult = exec?.resultHash ?? null;
      let match: boolean | null = null;
      let argsNormalized = false;
      if (storedArgs !== null && argsRe !== null) {
        if (storedArgs === argsRe) match = true;
        else {
          const normJson = normalizeForExec(s.toolName, s.argsJson);
          // 规范化后同值 → 一致的记录，只是执行面改写过参数（不是篡改）。
          if (normJson !== null && storedArgs === hashJson(normJson)) {
            match = true;
            argsNormalized = true;
          } else {
            match = false;
          }
        }
      } else if (storedResult !== null && resultRe !== null) match = storedResult === resultRe;
      const step: ProofStep = {
        seq: s.seq,
        kind: s.kind,
        status: s.status,
        tool: s.toolName,
        callId: s.callId,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        durationMs: s.finishedAt === null ? null : Math.max(0, s.finishedAt - s.startedAt),
        argsHash: storedArgs ?? argsRe,
        resultHash: storedResult ?? resultRe,
        argsHashRecomputed: argsRe,
        resultHashRecomputed: resultRe,
        hashMatch: match,
        ...(argsNormalized ? { argsNormalized: true } : {}),
        approvalId: s.approvalId,
        errorCode: exec?.errorCode ?? null,
      };
      if (input.includeArgs === true) {
        if (s.argsJson !== null) step.argsPreview = clip(s.argsJson, 300);
        if (s.resultJson !== null) step.resultPreview = clip(s.resultJson, 300);
      }
      return step;
    });

  const approvals: ProofApproval[] = input.approvals.map((a) => ({
    seq: a.seq,
    id: a.id,
    kind: a.kind,
    tool: a.tool,
    tier: a.tier,
    status: a.status,
    summary: a.summary,
    reason: a.reason,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy,
    note: a.note,
    finalParamsHash:
      a.finalParamsJson === null || a.finalParamsJson.length === 0
        ? null
        : sha256(stableStringify(safeParse(a.finalParamsJson))),
  }));

  const modelCalls: ProofModelCall[] = input.modelCalls.map((m) => ({
    attemptId: m.attemptId,
    attemptSeq: m.attemptSeq,
    track: m.track,
    endpointId: m.endpointId,
    model: m.model,
    outcome: m.outcome,
    degraded: m.degraded === 1,
    latencyMs: m.latencyMs,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    ts: m.ts,
  }));

  const audit: ProofAuditRow[] = input.audit.map((a) => ({
    id: a.id,
    ts: a.ts,
    actor: a.actor,
    action: a.action,
    tier: a.tier,
    tool: a.tool,
    decision: a.decision,
    reason: a.reason === null ? null : clip(a.reason, 200),
  }));

  const counts = {
    steps: steps.length,
    toolSteps: steps.filter((s) => s.kind === 'tool').length,
    failedSteps: steps.filter((s) => s.status === 'failed' || s.status === 'interrupted').length,
    approvals: approvals.length,
    modelCalls: modelCalls.length,
    hashMismatches: steps.filter((s) => s.hashMatch === false).length,
    hashUnverifiable: steps.filter((s) => s.hashMatch === null).length,
  };

  const task = {
    id: input.task.id,
    dotId: input.task.dotId,
    title: input.task.title,
    goal: input.task.goal,
    status: input.task.status,
    priority: input.task.priority,
    attempt: input.task.attempt,
    runEpoch: input.task.runEpoch,
    createdAt: input.task.createdAt,
    updatedAt: input.task.updatedAt,
    stopReason: input.task.stopReason,
  };
  const result = input.result === null ? { ok: null, summary: null } : { ok: input.result.ok === 1, summary: input.result.summary };
  const device =
    input.device === undefined || input.device === null
      ? undefined
      : {
          id: input.device.id,
          name: input.device.name,
          status: input.device.status,
          channel: input.device.channel,
        };
  // 只有语音任务才带 device 键：不加就不会改变非语音凭证的 bundleHash。
  const payload =
    device === undefined
      ? { version: 1 as const, task, result, steps, approvals, modelCalls, audit, counts }
      : { version: 1 as const, task, result, device, steps, approvals, modelCalls, audit, counts };
  const bundleHash = sha256(stableStringify(payload));
  return {
    version: 1,
    generatedAt: input.generatedAt,
    task,
    ...(device === undefined ? {} : { device }),
    result,
    steps,
    approvals,
    modelCalls,
    audit,
    counts,
    bundleHash,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 从已有属主表取数并生成凭证（daemon / HTTP 共用）。 */
export function collectProof(
  db: DatabaseSync,
  cp: { getTask(id: string): Task | null; getJournal(id: string): Step[] },
  taskId: string,
  nowMs: number,
  includeArgs = false,
): ProofBundle | null {
  const task = cp.getTask(taskId);
  if (task === null) return null;
  const steps = cp.getJournal(taskId);

  const execCalls = safeAll<ProofInput['execCalls'][number]>(
    db,
    `SELECT call_id AS callId, args_hash AS argsHash, result_hash AS resultHash,
            error_code AS errorCode, state, sent_at AS sentAt, finished_at AS finishedAt
       FROM exec_calls WHERE task_id = ? ORDER BY sent_at ASC`,
    taskId,
  );
  const approvals = safeAll<ProofInput['approvals'][number]>(
    db,
    `SELECT id, seq, kind, tool, tier, status, summary, reason,
            decided_at AS decidedAt, decided_by AS decidedBy, note,
            final_params_json AS finalParamsJson
       FROM approvals WHERE task_id = ? ORDER BY id ASC`,
    taskId,
  );
  const callIds = steps.map((s) => s.callId).filter((c): c is string => c !== null && c.length > 0);
  const modelCalls =
    callIds.length === 0
      ? []
      : safeAll<ProofInput['modelCalls'][number]>(
          db,
          `SELECT attempt_id AS attemptId, attempt_seq AS attemptSeq, track,
                  endpoint_id AS endpointId, model, outcome, degraded,
                  latency_ms AS latencyMs, prompt_tokens AS promptTokens,
                  completion_tokens AS completionTokens, ts
             FROM model_call_log
            WHERE attempt_id IN (${callIds.map(() => '?').join(',')})
            ORDER BY id ASC`,
          ...callIds,
        );
  const audit = safeAll<ProofInput['audit'][number]>(
    db,
    `SELECT id, ts, actor, action, tier, tool, decision, reason
       FROM audit_log WHERE task_id = ? ORDER BY id ASC LIMIT 500`,
    taskId,
  );
  const result =
    safeAll<{ ok: number; summary: string }>(db, 'SELECT ok, summary FROM task_results WHERE task_id = ?', taskId)[0] ?? null;

  const device = collectDevice(db, task.threadId);

  return buildProof({
    task,
    steps,
    execCalls,
    approvals,
    modelCalls,
    audit,
    result,
    generatedAt: nowMs,
    includeArgs,
    device,
  });
}

/**
 * 语音任务的设备维度：thread.channel='voice' + external_ref → devices。
 * 读不到就返回 null（绝不阻止生成凭证）。
 */
export function collectDevice(db: DatabaseSync, threadId: string | null): ProofDevice | null {
  if (threadId === null) return null;
  try {
    const row = db
      .prepare(
        `SELECT t.channel AS channel, t.external_ref AS ref,
                d.id AS id, d.name AS name, d.status AS status
           FROM mem_threads t
           LEFT JOIN devices d ON d.id = t.external_ref
          WHERE t.id = ?`,
      )
      .get(threadId) as
      | { channel: string; ref: string | null; id: string | null; name: string | null; status: string | null }
      | undefined;
    if (row === undefined || row.channel !== 'voice' || row.ref === null) return null;
    return {
      id: row.id ?? row.ref,
      name: row.name ?? null,
      status: row.status ?? null,
      channel: row.channel,
    };
  } catch {
    return null;
  }
}

function safeAll<T>(db: DatabaseSync, sql: string, ...args: Array<string | number>): T[] {
  try {
    return db.prepare(sql).all(...args) as unknown as T[];
  } catch {
    return [];
  }
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时刻未知';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 人类可读的凭证。默认不含明文参数。 */
export function renderProofMarkdown(b: ProofBundle): string {
  const lines: string[] = [];
  lines.push(`# 执行凭证：${b.task.title}`);
  lines.push('');
  lines.push(`> ${b.task.id} · 生成于 ${fmtTime(b.generatedAt)} · bundleHash \`${b.bundleHash}\``);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 状态：**${b.task.status}**${b.task.stopReason !== null ? `（${b.task.stopReason}）` : ''}`);
  lines.push(`- 结果：${b.result.ok === null ? '无终态记录' : b.result.ok ? '成功' : '失败'}`);
  if (b.result.summary !== null) lines.push(`- 摘要：${b.result.summary}`);
  lines.push(`- 目标：${b.task.goal}`);
  if (b.device !== undefined) {
    const label = b.device.name ?? b.device.id;
    const state = b.device.status === null ? '' : `（${b.device.status}）`;
    lines.push(`- 设备：${label} \`${b.device.id}\`${state} · 通道 ${b.device.channel}`);
  }
  lines.push(`- 时间：${fmtTime(b.task.createdAt)} → ${fmtTime(b.task.updatedAt)}`);
  lines.push('');
  lines.push('## 步骤');
  lines.push('');
  lines.push('| # | 类型 | 工具 | 状态 | 耗时 | 审批 | 哈希对账 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of b.steps) {
    const hash =
      s.hashMatch === true
        ? s.argsNormalized === true
          ? '一致（路径规范化）'
          : '一致'
        : s.hashMatch === false
          ? '**不一致**'
          : '无从比对';
    lines.push(
      `| ${s.seq} | ${s.kind} | ${s.tool ?? '—'} | ${s.status} | ${fmtDuration(s.durationMs)} | ${
        s.approvalId === null ? '—' : `#${s.approvalId}`
      } | ${hash} |`,
    );
  }
  if (b.steps.length === 0) lines.push('| — | — | 没有步骤记录 | — | — | — | — |');
  lines.push('');
  lines.push('## 审批');
  lines.push('');
  if (b.approvals.length === 0) {
    lines.push('这次任务没有触发审批。');
  } else {
    lines.push('| # | 类型 | 工具 | 状态 | 裁决 | 说明 |');
    lines.push('|---|---|---|---|---|---|');
    for (const a of b.approvals) {
      lines.push(`| ${a.seq} | ${a.kind} | ${a.tool ?? '—'} | ${a.status} | ${a.decidedBy ?? '—'} | ${clip(a.reason, 80)} |`);
    }
  }
  lines.push('');
  lines.push('## 模型调用');
  lines.push('');
  if (b.modelCalls.length === 0) {
    lines.push('没有模型调用记录。');
  } else {
    lines.push('| 端点 | 模型 | 结果 | 延迟 | prompt | completion | 降级 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const m of b.modelCalls) {
      lines.push(
        `| ${m.endpointId} | ${m.model} | ${m.outcome} | ${m.latencyMs ?? '—'}ms | ${m.promptTokens ?? '—'} | ${
          m.completionTokens ?? '—'
        } | ${m.degraded ? '是' : '否'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 完整性');
  lines.push('');
  lines.push(`- 步骤 ${b.counts.steps}（工具 ${b.counts.toolSteps}，失败/中断 ${b.counts.failedSteps}）`);
  lines.push(`- 哈希一致 ${b.counts.steps - b.counts.hashMismatches - b.counts.hashUnverifiable}，不一致 ${b.counts.hashMismatches}，无从比对 ${b.counts.hashUnverifiable}`);
  lines.push(`- 审批 ${b.counts.approvals}，模型调用 ${b.counts.modelCalls}`);
  lines.push('');
  lines.push('## 边界');
  lines.push('');
  lines.push(
    '这份凭证是**本机 journal 的投影**，不是第三方公证。哈希一致说明导出时 journal 与执行面 `exec_calls` 的记账一致；' +
      '它不证明数据库没有被有本机权限的人改过，也没有对外签名。要更强，请把 `bundleHash` 发布到外部（邮件、Git、时间戳服务）。',
  );
  lines.push('');
  return lines.join('\n');
}
