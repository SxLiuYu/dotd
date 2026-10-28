/**
 * src/metrics/view.ts —— `/api/metrics` 的返回形状 + 取数与渲染（2026-10-27）。
 *
 * 为什么单独一个文件：HTTP 层只该做路由与鉴权，不该长 SQL；daemon 已经够长。
 * 这里把「算（sample.ts）→ 取基线 → 渲染（report.ts）」缝在一起，
 * CLI 和 HTTP 拿到的是**同一个对象**，手机和终端不会看到两套数。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  collectSample,
  collectSeries,
  persistSample,
  windowDays,
  type MetricSample,
  type MetricSeriesRow,
} from './sample.ts';
import { headline, renderReport } from './report.ts';

export interface MetricsView {
  /** 人读的一段话（CLI 直接打，飞书直接推）。 */
  text: string;
  /** 一句话结论。 */
  headline: string;
  sample: MetricSample;
  series: MetricSeriesRow[];
  /** 本次落库的 sample_id；未落库（sample:false）时为 null。 */
  sampleId: number | null;
  /** 有没有基线可比。false 时 text 里不会出现「对比基线」。 */
  hasBaseline: boolean;
  /** 最近几条历史采样的关键数（看趋势用，最多 30 条）。 */
  history: Array<{
    at: number;
    taskP50Ms: number | null;
    modelP50Ms: number | null;
    firstTryRate: number | null;
    toolErrRate: number | null;
    runawayTasks: number;
  }>;
}

export interface MetricsDeps {
  db: DatabaseSync;
  now?: () => number;
}

/** 取最近一条基线采样（没有就是 null）。 */
function latestBaseline(db: DatabaseSync): MetricSample | null {
  try {
    const row = db
      .prepare(
        `SELECT s.* FROM metric_baseline b JOIN metric_sample s ON s.id = b.sample_id
          ORDER BY b.at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return rowToSample(row);
  } catch {
    return null;
  }
}

/** 库行 → MetricSample（history 与 baseline 共用）。 */
function rowToSample(r: Record<string, unknown>): MetricSample {
  const n = (k: string): number => Number(r[k] ?? 0);
  const nn = (k: string): number | null =>
    r[k] === null || r[k] === undefined ? null : Number(r[k]);
  return {
    at: n('at'),
    windowFrom: n('window_from'),
    windowTo: n('window_to'),
    speed: {
      taskP50Ms: nn('task_p50_ms'),
      taskP95Ms: nn('task_p95_ms'),
      modelP50Ms: nn('model_p50_ms'),
      modelP95Ms: nn('model_p95_ms'),
      reflexP50Ms: nn('reflex_p50_ms'),
      reflexP95Ms: nn('reflex_p95_ms'),
    },
    quality: {
      done: n('tasks_done'),
      failed: n('tasks_failed'),
      cancelled: n('tasks_cancel'),
      firstTryRate: nn('first_try_rate'),
      toolCalls: n('tool_calls'),
      toolErrors: n('tool_errors'),
      toolErrRate: nn('tool_err_rate'),
      modelCalls: n('model_calls'),
      modelBad: n('model_bad'),
      modelErrRate: nn('model_err_rate'),
      approvalTotal: n('approval_total'),
      approvalTool: n('approvals_tool'),
      approvalRememberable: n('approvals_rememberable'),
      approvalRememberableBefore: n('approvals_rememberable_before'),
      approvalLate: n('approval_late'),
      runawayTasks: n('runaway_tasks'),
    },
    evolution: {
      memThreads: n('mem_threads'),
      memMessages: n('mem_messages'),
      memFiles: n('mem_files'),
      memFilesNew: n('mem_files_new'),
      rulesActive: n('rules_active'),
      rulesHits: n('rules_hits'),
    },
  };
}

/** 历史采样（按时间正序，最多 30 条）。采样表缺了就返回空数组，不抛。 */
function historyOf(db: DatabaseSync): MetricsView['history'] {
  try {
    const rows = db
      .prepare(
        `SELECT at, task_p50_ms, model_p50_ms, first_try_rate, tool_err_rate, runaway_tasks
           FROM metric_sample ORDER BY at DESC LIMIT 30`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        at: Number(r['at'] ?? 0),
        taskP50Ms: r['task_p50_ms'] === null ? null : Number(r['task_p50_ms']),
        modelP50Ms: r['model_p50_ms'] === null ? null : Number(r['model_p50_ms']),
        firstTryRate: r['first_try_rate'] === null ? null : Number(r['first_try_rate']),
        toolErrRate: r['tool_err_rate'] === null ? null : Number(r['tool_err_rate']),
        runawayTasks: Number(r['runaway_tasks'] ?? 0),
      }))
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 取一份指标视图。
 *
 * `sample:true` 才写库（并把这次设成**当前基线**）。默认只读 ——
 * 「看一眼指标」不该改变指标，也不该在库里堆满同一分钟的重复采样。
 *
 * `setBaseline:false` 只落采样、不动基线。定时采样走这条路：
 * 基线是主人**刻意确认**的参照点（"改之前长这样"），不能被每天的自动采样
 * 悄悄挪走 —— 否则任何改动的效果在趋势里都会被稀释成看不出来。
 */
export function metricsView(
  deps: MetricsDeps,
  opts: { days?: number; sample?: boolean; detail?: boolean; setBaseline?: boolean } = {},
): MetricsView {
  const nowMs = (deps.now ?? Date.now)();
  const win = windowDays(opts.days ?? 7, nowMs);
  const sample = collectSample({ db: deps.db }, win, nowMs);
  const series = collectSeries(deps.db, win);

  // **先读旧基线，再写新基线**。顺序反过来就变成"拿自己跟自己比"，
  // 渲染出来滿屏「≈ 持平」，看起来像改动没生效。
  const baseline = latestBaseline(deps.db);

  let sampleId: number | null = null;
  if (opts.sample === true) {
    sampleId = persistSample(deps.db, sample, series);
    if (opts.setBaseline !== false) {
      // 新采样即新基线：主人此刻看到的这屏就是"改完之后"的参照点。
      try {
        deps.db
          .prepare('INSERT INTO metric_baseline (at, label, sample_id, note) VALUES (?,?,?,?)')
          .run(
            nowMs,
            `sample-${sampleId}`,
            sampleId,
            `窗口 ${new Date(win.from).toISOString().slice(0, 10)} → ${new Date(win.to).toISOString().slice(0, 10)}`,
          );
      } catch {
        // 基线写不进去不影响采样本身。
      }
    }
  }

  return {
    text: renderReport(sample, { baseline, withDetail: opts.detail !== false }, series),
    headline: headline(sample),
    sample,
    series,
    sampleId,
    hasBaseline: baseline !== null,
    history: historyOf(deps.db),
  };
}
