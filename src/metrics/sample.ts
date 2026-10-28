/**
 * src/metrics/sample.ts —— 可持久观测指标（2026-10-27）。
 *
 * 为什么需要这个文件
 *   「反应速度 / 执行质量 / 自我进化」一直靠印象讲：翻日志、临时拼 SQL、估一个数。
 *   换个人问同一句，答案不一样；也没法回答「改完之后真的变好了吗」。
 *   指标要可持久观测，必须满足三条：
 *     1. **口径只有一处** —— CLI、HTTP、飞书推送都调这里，不各写一份 SQL；
 *     2. **落库留历史** —— 每次采样写一行，趋势才有意义（metric_sample）；
 *     3. **可复核** —— 存下窗口边界，任何人都能按同样参数重算。
 *
 * 三条刻意的边界
 *
 * 1. **不把「历史全量平均」当指标。** 10-18 那次 924 步的失控任务会永远拉着均值，
 *    之后任何改进都淹没在里面。采样按窗口切（默认最近 7 天），趋势才说得清。
 *
 * 2. **不猜没有的数据。** 语音反射延迟目前**没有落库**：voice_events 只有
 *    (dot_id, device_id, kind, detail, at)，没有耗时列。所以 reflex_p50/p95 是 null，
 *    并在报告里写明「缺观测点」，而不是拿别的数凑一个好看的值。
 *
 * 3. **不把「任务 done」等同「做对了」。** tasks.status='done' 只说明 Runner 正常收口。
 *    真正接近「做对了」的读数是：一次跑通率（不靠重试）+ 工具失败率 + 空转任务数。
 *    三个一起看才有意义，单看任何一个都会被误导。
 *
 * 空转（runaway）阈值：单任务步数 ≥ 200。依据是本库的实际分布——1457 个任务里
 * 只有 4 个到过 200 步，其中 2 个超过 500（最高 924）。200 步之外的正常任务
 * 极少，落在那里基本就是打转。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 单任务步数超过它就算空转（见文件头注释：本库 1457 个任务里只有 4 个到过）。 */
export const RUNAWAY_STEP_THRESHOLD = 200;

/**
 * 审批卡片上「以后都这样」按钮的上线时刻（2026-10-27，本机时区 UTC+8 的 09:50 前后）。
 *
 * 为什么要这个东西：8 张可记忆档的审批单全是 10-22 发的，那时卡片上只有
 * 「同意 / 拒绝」两个按钮 —— 主人想记也点不到。把它们算进"该记没记"，
 * 等于拿新规矩判旧账，还会催人去修一个刚修好的东西。
 *
 * 取一个宽松的整数时刻（部署完成之后的分钟），早于它的一律按"当时没有这个选项"算。
 */
export const REMEMBER_BUTTON_SINCE_MS = Date.UTC(2026, 9, 27, 1, 50, 0);

export interface MetricWindow {
  /** 窗口起点（epoch ms，含）。 */
  from: number;
  /** 窗口终点（epoch ms，不含）。 */
  to: number;
}

export interface MetricSample {
  at: number;
  windowFrom: number;
  windowTo: number;
  speed: {
    /** 终态任务耗时（updated_at-created_at），毫秒。样本不足为 null。 */
    taskP50Ms: number | null;
    taskP95Ms: number | null;
    /** 模型单次调用耗时（outcome=ok）。 */
    modelP50Ms: number | null;
    modelP95Ms: number | null;
    /**
     * 语音反射耗时（唤醒词结束 → 动作执行完），设备上报。
     * 没有上报就是 null —— 不是 0（0ms 会被读成"极快"）。见 migrations/219。
     */
    reflexP50Ms: number | null;
    reflexP95Ms: number | null;
  };
  quality: {
    done: number;
    failed: number;
    cancelled: number;
    /** 一次跑通率：done 且 attempt=0 / 全部终态。重试过的不算一次跑通。 */
    firstTryRate: number | null;
    toolCalls: number;
    toolErrors: number;
    toolErrRate: number | null;
    modelCalls: number;
    modelBad: number;
    modelErrRate: number | null;
    approvalTotal: number;
    /**
     * 其中**工具类**审批单数（kind='tool_call'）。
     *
     * 为什么要单独一个数（2026-10-27）：判断「授权规则 0 条」是短板还是正常，
     * 要看有没有工具审批单。审批总开关关着时全是 question 单，本来就不问，
     * 自然沉淀不下规则 —— 那不是失败。混在一起就会让人去修没坏的东西。
     */
    approvalTool: number;
    /**
     * 其中**可记忆档位**的审批单数（tier ∈ read/write_file/browser）。
     *
     * 为什么还要再分一层（2026-10-27）：窗口里 19 条工具审批单全是 `dangerous`
     * 档的 shell.run —— 那个档按 GOV §4.1 永不入记忆。只看 approvalTool 会说
     * 「有单子但没人点记住」，暗示主人漏点了；实际是这批单子**根本没有可记的选项**。
     * 要分清"该记没记"和"压根不可记"，否则又会催人去修没坏的东西。
     *
     * 只数**「以后都这样」按钮上线之后**的单子（见 REMEMBER_BUTTON_SINCE_MS）。
     * 按钮上线前发出去的卡上没有这个选项，那批单子没记是必然的，
     * 算进"该记没记"等于拿新规矩判旧账。
     */
    approvalRememberable: number;
    /**
     * 按钮上线前、本可记忆但注定记不下的单子数（单独列，避免被误读成"没记"）。
     * 一并说明：这些不是短板，只是时间早于按钮。
     */
    approvalRememberableBefore: number;
    approvalLate: number;
    /** 步数超阈值的任务数（烧钱且多半没产出）。 */
    runawayTasks: number;
  };
  evolution: {
    memThreads: number;
    memMessages: number;
    memFiles: number;
    /** 窗口内 mtime 落在窗口里的记忆文件数（新写或改过的）。 */
    memFilesNew: number;
    rulesActive: number;
    rulesHits: number;
  };
}

export interface MetricSeriesRow {
  dim: 'tool' | 'model_track' | 'task_channel' | 'stop_reason' | 'tool_error';
  key: string;
  n: number;
  bad: number;
  avgMs: number | null;
}

/** 采样依赖。只收一个库句柄 —— 采样绝不写库以外的任何东西（除了自己那张表）。 */
export interface SampleDeps {
  db: DatabaseSync;
}

/** 读一个数；表缺 / 查询失败一律 null（指标不该把整个采样搞崩）。 */
function num(sql: string, db: DatabaseSync, ...args: Array<string | number>): number | null {
  try {
    const row = db.prepare(sql).get(...args) as { v?: unknown } | undefined;
    const v = row?.v;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 取分位数。SQLite 没有 percentile 函数，用 `ORDER BY … LIMIT 1 OFFSET n`。
 * 样本为 0 时返回 null（**不返回 0**：0ms 会被读成「极快」，而事实是没数据）。
 */
function percentile(
  db: DatabaseSync,
  sql: string,
  pct: number,
  args: Array<string | number>,
): number | null {
  const total = num(`SELECT COUNT(*) AS v FROM (${sql})`, db, ...args);
  if (total === null || total === 0) return null;
  // 最近秩法：offset 向下取整，样本少时自然退化为最小值，不会越界。
  const offset = Math.min(total - 1, Math.max(0, Math.floor((total * pct) / 100)));
  return num(`SELECT v FROM (${sql}) ORDER BY v LIMIT 1 OFFSET ?`, db, ...args, offset);
}

function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * 采一次样（纯读，不写库）。
 *
 * 窗口内没有数据时各项为 0 / null —— 这本就是事实（「这段时间没跑任务」），
 * 不编一个数出来。
 */
export function collectSample(deps: SampleDeps, win: MetricWindow, nowMs: number): MetricSample {
  const { db } = deps;
  const from = win.from;
  const to = win.to;

  // ── 反应速度 ──
  const taskDurSql = `SELECT (updated_at - created_at) AS v FROM tasks
                       WHERE status IN ('done','failed','cancelled')
                         AND updated_at >= ? AND updated_at < ?
                         AND updated_at > created_at`;
  const modelDurSql = `SELECT latency_ms AS v FROM model_call_log
                        WHERE outcome='ok' AND latency_ms IS NOT NULL
                          AND ts >= ? AND ts < ?`;
  // 语音反射耗时（2026-10-27 起有观测点，见 migrations/219）。
  // 只取设备真的报了 latency_ms 的行：不是每次事件都是一次反射
  // （离线告警、状态上报没有"响应"这个动作），把 NULL 当 0 会被读成"极快"。
  const reflexDurSql = `SELECT latency_ms AS v FROM voice_events
                        WHERE latency_ms IS NOT NULL
                          AND at >= ? AND at < ?`;

  // ── 执行质量 ──
  const done = num(
    `SELECT COUNT(*) AS v FROM tasks WHERE status='done' AND updated_at >= ? AND updated_at < ?`,
    db, from, to,
  ) ?? 0;
  const failed = num(
    `SELECT COUNT(*) AS v FROM tasks WHERE status='failed' AND updated_at >= ? AND updated_at < ?`,
    db, from, to,
  ) ?? 0;
  const cancelled = num(
    `SELECT COUNT(*) AS v FROM tasks WHERE status='cancelled' AND updated_at >= ? AND updated_at < ?`,
    db, from, to,
  ) ?? 0;
  const terminal = done + failed + cancelled;

  // 一次跑通：done 且没重试过（attempt=0）。
  const doneFirstTry = num(
    `SELECT COUNT(*) AS v FROM tasks
      WHERE status='done' AND attempt=0 AND updated_at >= ? AND updated_at < ?`,
    db, from, to,
  ) ?? 0;

  // 工具调用：以 steps 为准（它是 Runner 的真实记账点）。
  // 只用 exec_calls 会漏掉被治理 deny 的调用——那些恰恰是最能说明问题的。
  const toolCalls = num(
    `SELECT COUNT(*) AS v FROM steps WHERE kind='tool' AND started_at >= ? AND started_at < ?`,
    db, from, to,
  ) ?? 0;
  const toolErrors = num(
    `SELECT COUNT(*) AS v FROM steps
      WHERE kind='tool' AND status='failed' AND started_at >= ? AND started_at < ?`,
    db, from, to,
  ) ?? 0;

  const modelCalls = num(
    `SELECT COUNT(*) AS v FROM model_call_log WHERE ts >= ? AND ts < ?`,
    db, from, to,
  ) ?? 0;
  const modelBad = num(
    `SELECT COUNT(*) AS v FROM model_call_log WHERE outcome!='ok' AND ts >= ? AND ts < ?`,
    db, from, to,
  ) ?? 0;

  // 审批：total = 落定 + 迟到（late_decision 是「已落定后又被点」的记账，
  // 它和 approval_decided 是同一件事的两种结局，所以分开数）。
  const approvalTotal = num(
    `SELECT COUNT(*) AS v FROM approvals WHERE created_at >= ? AND created_at < ?`,
    db, new Date(from).toISOString().slice(0, 19).replace('T', ' '),
    new Date(to).toISOString().slice(0, 19).replace('T', ' '),
  ) ?? 0;
  const approvalTool = num(
    `SELECT COUNT(*) AS v FROM approvals
      WHERE kind='tool_call' AND created_at >= ? AND created_at < ?`,
    db, new Date(from).toISOString().slice(0, 19).replace('T', ' '),
    new Date(to).toISOString().slice(0, 19).replace('T', ' '),
  ) ?? 0;
  const approvalRememberable = num(
    `SELECT COUNT(*) AS v FROM approvals
      WHERE kind='tool_call' AND tier IN ('read','write_file','browser')
        AND created_at >= ? AND created_at < ?`,
    db, new Date(Math.max(from, REMEMBER_BUTTON_SINCE_MS)).toISOString().slice(0, 19).replace('T', ' '),
    new Date(to).toISOString().slice(0, 19).replace('T', ' '),
  ) ?? 0;
  // 按钮上线之前发的卡上没有这个选项，那批单子记不下来是必然的。
  // 单独数出来，说明"不是漏点"，而不是把它们混进上面那个数里让人误判。
  const approvalRememberableBefore = num(
    `SELECT COUNT(*) AS v FROM approvals
      WHERE kind='tool_call' AND tier IN ('read','write_file','browser')
        AND created_at >= ? AND created_at < ?`,
    db, new Date(from).toISOString().slice(0, 19).replace('T', ' '),
    new Date(Math.min(to, REMEMBER_BUTTON_SINCE_MS)).toISOString().slice(0, 19).replace('T', ' '),
  ) ?? 0;
  const approvalLate = num(
    `SELECT COUNT(*) AS v FROM audit_log
      WHERE action='late_decision' AND ts >= ? AND ts < ?`,
    db, new Date(from).toISOString().slice(0, 19).replace('T', ' '),
    new Date(to).toISOString().slice(0, 19).replace('T', ' '),
  ) ?? 0;

  // 空转任务：窗口内跑过、且总步数超阈值的任务。
  const runawayTasks = num(
    `SELECT COUNT(*) AS v FROM (
       SELECT task_id FROM steps
        WHERE started_at >= ? AND started_at < ?
        GROUP BY task_id HAVING COUNT(*) >= ?)`,
    db, from, to, RUNAWAY_STEP_THRESHOLD,
  ) ?? 0;

  // ── 自我进化 ──
  // 存量是「当前时点」的，不按窗口切（库里有几条记忆就是几条）。
  const memThreads = num('SELECT COUNT(*) AS v FROM mem_threads', db) ?? 0;
  const memMessages = num('SELECT COUNT(*) AS v FROM mem_messages', db) ?? 0;
  const memFiles = num('SELECT COUNT(*) AS v FROM mem_files_index', db) ?? 0;
  // 增量按窗口算：mtime 落在窗口内 = 这段时间新写或改过。
  const memFilesNew = num(
    'SELECT COUNT(*) AS v FROM mem_files_index WHERE mtime_ms >= ? AND mtime_ms < ?',
    db, from, to,
  ) ?? 0;
  const rulesActive = num(
    `SELECT COUNT(*) AS v FROM approval_rules WHERE status='active'`,
    db,
  ) ?? 0;
  const rulesHits = num(
    `SELECT COALESCE(SUM(hits),0) AS v FROM approval_rules WHERE status='active'`,
    db,
  ) ?? 0;

  return {
    at: nowMs,
    windowFrom: from,
    windowTo: to,
    speed: {
      taskP50Ms: percentile(db, taskDurSql, 50, [from, to]),
      taskP95Ms: percentile(db, taskDurSql, 95, [from, to]),
      modelP50Ms: percentile(db, modelDurSql, 50, [from, to]),
      modelP95Ms: percentile(db, modelDurSql, 95, [from, to]),
      // 见文件头 + migrations/219：设备上报才作数，没报就是 null（不是 0）。
      reflexP50Ms: percentile(db, reflexDurSql, 50, [from, to]),
      reflexP95Ms: percentile(db, reflexDurSql, 95, [from, to]),
    },
    quality: {
      done,
      failed,
      cancelled,
      firstTryRate: rate(doneFirstTry, terminal),
      toolCalls,
      toolErrors,
      toolErrRate: rate(toolErrors, toolCalls),
      modelCalls,
      modelBad,
      modelErrRate: rate(modelBad, modelCalls),
      approvalTotal,
      approvalTool,
      approvalRememberable,
      approvalRememberableBefore,
      approvalLate,
      runawayTasks,
    },
    evolution: {
      memThreads,
      memMessages,
      memFiles,
      memFilesNew,
      rulesActive,
      rulesHits,
    },
  };
}

/**
 * 按维度拆明细（汇总说不清「哪里坏」，明细才说得清）。
 *
 * 五个维度各有各的用途：
 *   tool          —— 哪个工具在拖后腿（net.get 19% 失败就是从这里看出来的）
 *   tool_error    —— **为什么**失败。同一个根因（容器 quarantined）会让一批工具
 *                    一起挂；按工具名看像"某个工具坏了"，按原因看才知道该修哪。
 *                    两维必须并存，只有一维会把人带错方向。
 *   model_track   —— primary 和 light 谁更慢
 *   task_channel  —— web / feishu / event 谁的任务更长
 *   stop_reason   —— 任务为什么停（预算是烧完了，还是撞到熔断）
 */
export function collectSeries(db: DatabaseSync, win: MetricWindow): MetricSeriesRow[] {
  const out: MetricSeriesRow[] = [];
  const push = (
    rows: Array<{ k: unknown; n: unknown; bad?: unknown; avg?: unknown }>,
    dim: MetricSeriesRow['dim'],
  ): void => {
    for (const r of rows) {
      out.push({
        dim,
        key: String(r.k ?? ''),
        n: Number(r.n ?? 0),
        bad: Number(r.bad ?? 0),
        avgMs: typeof r.avg === 'number' && Number.isFinite(r.avg) ? Math.round(r.avg) : null,
      });
    }
  };

  try {
    push(
      db
        .prepare(
          `SELECT tool_name AS k, COUNT(*) AS n,
                  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS bad
             FROM steps
            WHERE kind='tool' AND started_at >= ? AND started_at < ?
            GROUP BY tool_name ORDER BY n DESC LIMIT 40`,
        )
        .all(win.from, win.to) as never,
      'tool',
    );
  } catch { /* 表缺就跳过这一维 */ }

  try {
    push(
      db
        .prepare(
          `SELECT COALESCE(json_extract(result_json,'$.code'),'(无 code)') AS k, COUNT(*) AS n,
                  COUNT(*) AS bad
             FROM steps
            WHERE kind='tool' AND status='failed'
              AND started_at >= ? AND started_at < ?
            GROUP BY k ORDER BY n DESC LIMIT 20`,
        )
        .all(win.from, win.to) as never,
      'tool_error',
    );
  } catch { /* json1 扩展缺失就跳过这一维 */ }

  try {
    push(
      db
        .prepare(
          `SELECT track AS k, COUNT(*) AS n,
                  SUM(CASE WHEN outcome!='ok' THEN 1 ELSE 0 END) AS bad,
                  AVG(latency_ms) AS avg
             FROM model_call_log WHERE ts >= ? AND ts < ?
            GROUP BY track ORDER BY n DESC`,
        )
        .all(win.from, win.to) as never,
      'model_track',
    );
  } catch { /* 同上 */ }

  try {
    push(
      db
        .prepare(
          `SELECT COALESCE(th.channel,'(无线程)') AS k, COUNT(*) AS n,
                  AVG(t.updated_at - t.created_at) AS avg
             FROM tasks t LEFT JOIN mem_threads th ON th.id = t.thread_id
            WHERE t.status IN ('done','failed','cancelled')
              AND t.updated_at >= ? AND t.updated_at < ?
            GROUP BY k ORDER BY n DESC`,
        )
        .all(win.from, win.to) as never,
      'task_channel',
    );
  } catch { /* 同上 */ }

  try {
    push(
      db
        .prepare(
          `SELECT COALESCE(stop_reason,'(正常收口)') AS k, COUNT(*) AS n
             FROM tasks
            WHERE status IN ('done','failed','cancelled')
              AND updated_at >= ? AND updated_at < ?
            GROUP BY k ORDER BY n DESC`,
        )
        .all(win.from, win.to) as never,
      'stop_reason',
    );
  } catch { /* 同上 */ }

  return out;
}

/** 把一次采样写进库（汇总 + 明细），返回 sample_id。 */
export function persistSample(
  db: DatabaseSync,
  sample: MetricSample,
  series: readonly MetricSeriesRow[],
): number {
  const res = db
    .prepare(
      `INSERT INTO metric_sample (
         at, window_from, window_to,
         task_p50_ms, task_p95_ms, model_p50_ms, model_p95_ms, reflex_p50_ms, reflex_p95_ms,
         tasks_done, tasks_failed, tasks_cancel, first_try_rate,
         tool_calls, tool_errors, tool_err_rate,
         model_calls, model_bad, model_err_rate,
         approval_total, approvals_tool, approvals_rememberable, approvals_rememberable_before,
         approval_late, runaway_tasks,
         mem_threads, mem_messages, mem_files, mem_files_new, rules_active, rules_hits
       ) VALUES (?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)`,
    )
    .run(
      sample.at, sample.windowFrom, sample.windowTo,
      sample.speed.taskP50Ms, sample.speed.taskP95Ms,
      sample.speed.modelP50Ms, sample.speed.modelP95Ms,
      sample.speed.reflexP50Ms, sample.speed.reflexP95Ms,
      sample.quality.done, sample.quality.failed, sample.quality.cancelled,
      sample.quality.firstTryRate,
      sample.quality.toolCalls, sample.quality.toolErrors, sample.quality.toolErrRate,
      sample.quality.modelCalls, sample.quality.modelBad, sample.quality.modelErrRate,
      sample.quality.approvalTotal, sample.quality.approvalTool,
      sample.quality.approvalRememberable, sample.quality.approvalRememberableBefore,
      sample.quality.approvalLate, sample.quality.runawayTasks,
      sample.evolution.memThreads, sample.evolution.memMessages, sample.evolution.memFiles,
      sample.evolution.memFilesNew, sample.evolution.rulesActive, sample.evolution.rulesHits,
    ) as unknown as { lastInsertRowid: number | bigint };
  const sampleId = Number(res.lastInsertRowid);

  const ins = db.prepare(
    `INSERT INTO metric_series (sample_id, dim, key, n, bad, avg_ms) VALUES (?,?,?,?,?,?)
     ON CONFLICT(sample_id, dim, key) DO UPDATE SET n=excluded.n, bad=excluded.bad, avg_ms=excluded.avg_ms`,
  );
  for (const r of series) {
    try {
      ins.run(sampleId, r.dim, r.key, r.n, r.bad, r.avgMs);
    } catch {
      // 明细写不进去不影响汇总；汇总才是「指标」，明细是辅助。
    }
  }
  return sampleId;
}

/** 采样 + 落库一步到位（CLI/HTTP 的常用入口）。 */
export function sampleNow(
  deps: SampleDeps,
  win: MetricWindow,
  nowMs: number,
): { sample: MetricSample; sampleId: number; series: MetricSeriesRow[] } {
  const sample = collectSample(deps, win, nowMs);
  const series = collectSeries(deps.db, win);
  const sampleId = persistSample(deps.db, sample, series);
  return { sample, sampleId, series };
}

/** 默认窗口：最近 N 天。 */
export function windowDays(days: number, nowMs: number): MetricWindow {
  const d = Math.max(1, Math.floor(days));
  return { from: nowMs - d * 86_400_000, to: nowMs };
}
