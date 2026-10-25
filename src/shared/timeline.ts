/**
 * src/shared/timeline.ts —— 任务分段时间线（纯函数，零依赖）。
 *
 * 为什么要有：回答"这轮为什么慢"以前只能起临时 daemon、手工查 `steps` 和
 * `model_call_log`（2026-10-24 就这么干了三次）。同样的结论应该能从
 * `/api/tasks/:id/proof` 直接读出来，并且以后进 CI 做延迟门禁。
 *
 * 口径（全部来自 journal 的 `started_at/finished_at`，不引入新写入）：
 *   setupMs      任务创建 → 第一步开始（建会话、拼上下文、取工具清单）
 *   llmMs[]      每个 llm 步的时长（按 seq）
 *   toolMs[]     每个 tool 步的时长（按 seq）
 *   memoryRedoMs 补写轮那一步的时长（同一轮还会占住设备，见 2026-10-24 实测）
 *   tailMs       最后一个步结束 → 任务终态（finish/seal 落库）
 *
 * 兼容性：`timeline` 是 proof 的**可选**字段，没有步骤时整个键不出现，
 * 老凭证的形状与哈希口径不受影响（有步骤时哈希里会多这份派生数据）。
 */

/** 补写轮 system prompt 的固定开头；runner 与 proof 共用同一个常量，避免两处各写一遍。 */
export const MEMORY_REDO_MARK = '任务已经结束。现在做最后一件收尾动作';

export interface TimelineStep {
  seq: number;
  kind: string;
  argsJson: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ProofTimeline {
  totalMs: number;
  setupMs: number;
  llmMs: number[];
  toolMs: number[];
  llmTotalMs: number;
  toolTotalMs: number;
  memoryRedoMs: number | null;
  tailMs: number;
}

/**
 * 计算时间线。步骤缺失/时间戳异常时该字段取 0（**不抛**）：
 * 观测面不能因为一条脏数据把整个凭证打不出来。
 */
export function computeTimeline(input: {
  createdAt: number;
  updatedAt: number;
  steps: readonly TimelineStep[];
}): ProofTimeline | null {
  const steps = [...input.steps].sort((a, b) => a.seq - b.seq);
  if (steps.length === 0) return null;

  const llmMs: number[] = [];
  const toolMs: number[] = [];
  let memoryRedoMs: number | null = null;

  for (const s of steps) {
    if (s.finishedAt === null) continue;
    const dur = Math.max(0, s.finishedAt - s.startedAt);
    if (s.kind === 'llm') {
      llmMs.push(dur);
      // 补写轮是 kind='llm' 里唯一带这个标记的（args 存的是 prompt 原文）
      if (memoryRedoMs === null && (s.argsJson ?? '').includes(MEMORY_REDO_MARK)) {
        memoryRedoMs = dur;
      }
    } else if (s.kind === 'tool') {
      toolMs.push(dur);
    }
  }

  const firstStart = steps[0]!.startedAt;
  const lastEnd = steps.reduce((max, s) => Math.max(max, s.finishedAt ?? s.startedAt), firstStart);
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

  return {
    totalMs: Math.max(0, input.updatedAt - input.createdAt),
    setupMs: Math.max(0, firstStart - input.createdAt),
    llmMs,
    toolMs,
    llmTotalMs: sum(llmMs),
    toolTotalMs: sum(toolMs),
    memoryRedoMs,
    tailMs: Math.max(0, input.updatedAt - lastEnd),
  };
}
