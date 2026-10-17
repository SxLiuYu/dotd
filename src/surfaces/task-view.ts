/**
 * src/surfaces/task-view.ts —— P1-6 可观测性：`dotd task <id> --verbose` 的数据投影。
 *
 * 主人问的三个问题（本文件就是为它们存在的）：
 *   1. **花了多少**（token / 时间）
 *   2. **每一步多久**
 *   3. **卡在哪一步**
 *
 * 数据来源全部是**已有事实源**，不新增表、不重造口径：
 * - 任务状态：CP `getTask()`（`tasks` 表投影）
 * - 每步耗时：CP `getJournal()` → `steps.started_at` / `finished_at`
 * - token 成本：`model_call_log.prompt_tokens` / `completion_tokens`（按 `attempt_id`
 *   关联到 llm 步的 `call_id`——契约 J1 规定 attemptId = journal 步 callId）
 *
 * 为什么做成纯函数：投影口径要能被测试逐字段断言（而不是"起个 daemon 看输出像不像"），
 * 也需要在同一份数据上回答 JSON 与人类可读两种形态。
 */

import type { Step, Task } from '../shared/contracts.ts';

/** `model_call_log` 里与本任务 LLM 步相关的行（只取投影需要的列）。 */
export interface CallLogRow {
  attemptId: string;
  outcome: string;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  endpointId: string;
  model: string;
  degraded: number;
}

/** 单步的耗时与成本视图。 */
export interface StepView {
  seq: number;
  kind: 'llm' | 'tool';
  status: string;
  toolName: string | null;
  callId: string | null;
  /** 毫秒；未结束的步 = `started_at` 到"现在"（`durationOngoing=true`）。 */
  durationMs: number;
  durationOngoing: boolean;
  runEpoch: number;
  /** 该步对应的模型调用（llm 步按 call_id=attempt_id 关联）。 */
  model: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    /** 端到端延迟之和（毫秒）。 */
    latencyMs: number;
    endpoints: string[];
    degraded: boolean;
  } | null;
  /** 失败/中断时的原因摘要（工具步取 result_json 里的 error.code/message）。 */
  error: string | null;
}

/** 任务级汇总。 */
export interface TaskView {
  task: {
    id: string;
    title: string;
    status: string;
    priority: number;
    dotId: string;
    attempt: number;
    createdAt: number;
    updatedAt: number;
  };
  /** ① 花了多少。 */
  cost: {
    /** LLM 步总耗时（毫秒）。 */
    llmMs: number;
    /** 工具步总耗时（毫秒）。 */
    toolMs: number;
    /** 从第一步开始到最后一步结束的墙钟跨度（毫秒）。 */
    wallMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    modelCalls: number;
    /** 有降级的调用数（degraded=1）。 */
    degradedCalls: number;
    /** 用到的端点 id（去重）。 */
    endpoints: string[];
  };
  /** ② 每一步多久（按 seq 升序）。 */
  steps: StepView[];
  /** ③ 卡在哪一步：最慢的一步 + 未完成的步 + 失败步。 */
  bottleneck: {
    /** 耗时最长的一步（含在途）。 */
    slowest: { seq: number; kind: 'llm' | 'tool'; toolName: string | null; durationMs: number } | null;
    /** 仍未结束的步（started/pending）——"现在还卡在这"的直接答案。 */
    open: Array<{ seq: number; kind: 'llm' | 'tool'; toolName: string | null; durationMs: number; status: string }>;
    /** 失败/中断的步。 */
    failed: Array<{ seq: number; kind: 'llm' | 'tool'; toolName: string | null; error: string | null }>;
  };
}

/** 输入投影的三份事实（全部来自已有属主投影）。 */
export interface TaskViewInput {
  task: Task;
  steps: Step[];
  /** 与这些 steps 相关的 model_call_log 行（按 call_id/attempt_id 过滤）。 */
  callLogs: CallLogRow[];
  /** 当前时间（毫秒），用于"在途步已耗时"。 */
  now: number;
}

/** 从工具步的 result_json 里抽错误摘要（不打印整段结果，避免把上下文撑爆）。 */
export function summarizeStepError(resultJson: string | null): string | null {
  if (resultJson === null || resultJson.length === 0) return null;
  try {
    const parsed = JSON.parse(resultJson) as { error?: { code?: string; message?: string } };
    const e = parsed.error;
    if (e === undefined) return null;
    const code = typeof e.code === 'string' ? e.code : 'error';
    const msg = typeof e.message === 'string' ? e.message : '';
    return msg.length > 0 ? `${code}: ${msg}` : code;
  } catch {
    return null;
  }
}

/**
 * 把三份事实投影成 `TaskView`（纯函数；不读库、不看时钟）。
 */
export function buildTaskView(input: TaskViewInput): TaskView {
  const { task, steps, callLogs, now } = input;
  const byAttempt = new Map<string, CallLogRow[]>();
  for (const row of callLogs) {
    const list = byAttempt.get(row.attemptId) ?? [];
    list.push(row);
    byAttempt.set(row.attemptId, list);
  }

  const stepViews: StepView[] = [];
  let llmMs = 0;
  let toolMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let modelCalls = 0;
  let degradedCalls = 0;
  const endpoints = new Set<string>();
  const open: TaskView['bottleneck']['open'] = [];
  const failed: TaskView['bottleneck']['failed'] = [];

  for (const st of [...steps].sort((a, b) => a.seq - b.seq)) {
    const ongoing = st.finishedAt === null;
    const durationMs = Math.max(0, (ongoing ? now : st.finishedAt!) - st.startedAt);
    if (st.kind === 'llm') llmMs += durationMs;
    else toolMs += durationMs;

    let model: StepView['model'] = null;
    if (st.kind === 'llm' && st.callId !== null) {
      const rows = byAttempt.get(st.callId) ?? [];
      if (rows.length > 0) {
        let p = 0;
        let c = 0;
        let lat = 0;
        const eps = new Set<string>();
        let deg = false;
        for (const r of rows) {
          p += r.promptTokens ?? 0;
          c += r.completionTokens ?? 0;
          lat += r.latencyMs ?? 0;
          eps.add(r.endpointId);
          if (r.degraded === 1) deg = true;
        }
        model = { calls: rows.length, promptTokens: p, completionTokens: c, latencyMs: lat, endpoints: [...eps], degraded: deg };
        promptTokens += p;
        completionTokens += c;
        modelCalls += rows.length;
        for (const e of eps) endpoints.add(e);
        if (deg) degradedCalls += rows.filter((r) => r.degraded === 1).length;
      } else {
        model = { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0, endpoints: [], degraded: false };
      }
    }

    const error = summarizeStepError(st.resultJson);
    const view: StepView = {
      seq: st.seq,
      kind: st.kind,
      status: st.status,
      toolName: st.toolName,
      callId: st.callId,
      durationMs,
      durationOngoing: ongoing,
      runEpoch: st.runEpoch,
      model,
      error,
    };
    stepViews.push(view);

    if (ongoing) {
      open.push({ seq: st.seq, kind: st.kind, toolName: st.toolName, durationMs, status: st.status });
    }
    if (st.status === 'failed' || st.status === 'interrupted') {
      failed.push({ seq: st.seq, kind: st.kind, toolName: st.toolName, error });
    }
  }

  // 墙钟跨度：第一步开始 → 最后一步结束（未结束则到 now）
  let wallMs = 0;
  if (stepViews.length > 0) {
    const firstStart = Math.min(...steps.map((s) => s.startedAt));
    const lastEnd = Math.max(...steps.map((s) => (s.finishedAt === null ? now : s.finishedAt)));
    wallMs = Math.max(0, lastEnd - firstStart);
  }

  const slowestStep = stepViews.reduce<StepView | null>(
    (best, cur) => (best === null || cur.durationMs > best.durationMs ? cur : best),
    null,
  );

  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dotId: task.dotId,
      attempt: task.attempt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    cost: {
      llmMs,
      toolMs,
      wallMs,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      modelCalls,
      degradedCalls,
      endpoints: [...endpoints],
    },
    steps: stepViews,
    bottleneck: {
      slowest:
        slowestStep === null
          ? null
          : {
              seq: slowestStep.seq,
              kind: slowestStep.kind,
              toolName: slowestStep.toolName,
              durationMs: slowestStep.durationMs,
            },
      open,
      failed,
    },
  };
}

/** 毫秒 → 人类可读（`1.2s` / `3m04s` / `45ms`）。 */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${String(rest).padStart(2, '0')}s`;
}

/**
 * 渲染成给主人看的文本（结论先行、中文、不堆术语）。
 * 三块依次回答：花了多少 / 卡在哪 / 每一步多久。
 */
export function renderTaskView(v: TaskView): string {
  const lines: string[] = [];
  lines.push(`任务 ${v.task.id}「${v.task.title}」`);
  lines.push(`状态：${v.task.status}（attempt ${v.task.attempt}）`);

  // ① 花了多少
  const c = v.cost;
  lines.push('');
  lines.push(
    `花了多少：从第一步到最后一步共 ${humanMs(c.wallMs)}（其中模型调用 ${humanMs(c.llmMs)}、工具执行 ${humanMs(c.toolMs)}）`,
  );
  lines.push(
    `  token：输入 ${c.promptTokens} + 输出 ${c.completionTokens} = ${c.totalTokens}，模型调用 ${c.modelCalls} 次` +
      (c.degradedCalls > 0 ? `（其中 ${c.degradedCalls} 次走了降级端点）` : ''),
  );
  if (c.endpoints.length > 0) lines.push(`  端点：${c.endpoints.join(', ')}`);

  // ② 卡在哪
  lines.push('');
  if (v.bottleneck.open.length > 0) {
    const cur = v.bottleneck.open[0]!;
    lines.push(
      `卡在哪：第 ${cur.seq} 步（${cur.kind === 'llm' ? '模型调用' : cur.toolName ?? '工具'}）仍在进行，` +
        `已 ${humanMs(cur.durationMs)}`,
    );
  } else if (v.bottleneck.failed.length > 0) {
    const f = v.bottleneck.failed[0]!;
    lines.push(
      `卡在哪：第 ${f.seq} 步（${f.kind === 'llm' ? '模型调用' : f.toolName ?? '工具'}）${f.error !== null ? `失败——${f.error}` : '失败'}`,
    );
  } else if (v.bottleneck.slowest !== null) {
    const s = v.bottleneck.slowest;
    lines.push(
      `最慢一步：第 ${s.seq} 步（${s.kind === 'llm' ? '模型调用' : s.toolName ?? '工具'}）用了 ${humanMs(s.durationMs)}`,
    );
  } else {
    lines.push('还没有任何步骤记录（任务可能刚入队）');
  }

  // ③ 每一步多久
  if (v.steps.length > 0) {
    lines.push('');
    lines.push('每一步：');
    for (const s of v.steps) {
      const what = s.kind === 'llm' ? '模型调用' : (s.toolName ?? '工具');
      const cost =
        s.model !== null && s.model.calls > 0
          ? `  ${s.model.promptTokens}+${s.model.completionTokens} tok`
          : '';
      const err = s.error !== null ? `  ✗ ${s.error}` : '';
      const ongoing = s.durationOngoing ? '（进行中）' : '';
      lines.push(`  ${String(s.seq).padStart(2)}. ${what.padEnd(14)} ${humanMs(s.durationMs).padStart(7)}${ongoing}  ${s.status}${cost}${err}`);
    }
  }
  return lines.join('\n');
}
