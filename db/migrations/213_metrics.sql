-- 213：可持久观测指标（2026-10-27）
--
-- 为什么需要这张表
--   「反应速度 / 执行质量 / 自我进化」这三件事此前全靠印象讲：翻日志、临时写 SQL、
--   猜一个数。换个人问同一句，答案不一样，也无法回答「比上周好了没有」。
--   指标必须**落库留历史**——每次采样写一行，才能算趋势、才能对得上「改完之后
--   真的变好了吗」。不落库的指标只是一次性截图。
--
-- 三张表的分工
--   metric_sample       每次采样的**汇总值**（一个窗口一行，可比较多天）
--   metric_series       需要看分布时按维度拆开的明细（工具/模型通道/任务渠道）
--   metric_baseline     人工确认过的基线（跑一次就能和「改之前」比）
--
-- 为什么窗口固定而不是「一次算全部历史」
--   全历史平均值会把 10-18 那次 924 步的失控任务和今天的一次问答混成一个数，
--   任何改动都淹没在里面。采样按窗口切，趋势才有意义。
--
-- 为什么不存原始明细
--   原始数据已经在 tasks/steps/model_call_log/exec_calls 里，重复存等于两份真相。
--   这里只存**聚合结果 + 采样参数**，可复核（带上 window_from/window_to 就能重算）。

CREATE TABLE metric_sample (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,             -- 采样时刻（epoch ms）
  window_from   INTEGER NOT NULL,             -- 统计窗口起点（含）
  window_to     INTEGER NOT NULL,             -- 统计窗口终点（不含）
  -- ── 反应速度 ──
  -- 「任务从入队到收口」的耗时。取终态任务的 updated_at-created_at。
  task_p50_ms   INTEGER,
  task_p95_ms   INTEGER,
  -- 模型单次调用耗时（outcome=ok）。这才是「它有多快」的直接读数，
  -- 任务耗时还混了工具、审批、排队。
  model_p50_ms  INTEGER,
  model_p95_ms  INTEGER,
  -- 语音反射：不经过模型的居家控制/本机操作的耗时。取 voice_events 里 reflex 路径。
  reflex_p50_ms INTEGER,
  reflex_p95_ms INTEGER,
  -- ── 执行质量 ──
  tasks_done    INTEGER NOT NULL DEFAULT 0,
  tasks_failed  INTEGER NOT NULL DEFAULT 0,
  tasks_cancel  INTEGER NOT NULL DEFAULT 0,
  -- 一次跑通的任务占比（done / 全部终态）。重试过的任务算没过——
  -- 主人要的是「一次就成」，不是「折腾三次最后成了」。
  first_try_rate REAL,
  -- 工具调用失败率。执行质量最敏感的读数：工具挂了，任务写得再好也没用。
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  tool_errors   INTEGER NOT NULL DEFAULT 0,
  tool_err_rate REAL,
  -- 模型调用失败率（超时/断流/熔断跳过都算）
  model_calls   INTEGER NOT NULL DEFAULT 0,
  model_bad     INTEGER NOT NULL DEFAULT 0,
  model_err_rate REAL,
  -- 审批相关：迟到裁决占比。高 = 主人在两个入口反复点，或答复没送达。
  approval_total INTEGER NOT NULL DEFAULT 0,
  approval_late  INTEGER NOT NULL DEFAULT 0,
  -- 空转：步数超阈值的任务数。这类任务烧钱且多半没产出。
  runaway_tasks INTEGER NOT NULL DEFAULT 0,
  -- ── 自我进化 ──
  -- 记忆库规模：能不能「记住」的直接读数。
  mem_threads   INTEGER NOT NULL DEFAULT 0,
  mem_messages  INTEGER NOT NULL DEFAULT 0,
  mem_files     INTEGER NOT NULL DEFAULT 0,
  -- 授权规则：主人一次点头之后，系统能不能不再问。hits 是「省下的提问次数」。
  rules_active  INTEGER NOT NULL DEFAULT 0,
  rules_hits    INTEGER NOT NULL DEFAULT 0,
  -- 知识沉淀：新增/更新的记忆文件（窗口内 mtime 变化）
  mem_files_new INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_metric_sample_at ON metric_sample(at);

-- 按维度拆开的明细（每个采样窗口覆盖写一批）。
-- 为什么要拆：汇总说「工具失败率 9%」，明细才知道是 net.get 的 19%。
CREATE TABLE metric_series (
  sample_id INTEGER NOT NULL,
  dim       TEXT NOT NULL CHECK (dim IN ('tool','model_track','task_channel','stop_reason')),
  key       TEXT NOT NULL,
  n         INTEGER NOT NULL,
  bad       INTEGER NOT NULL DEFAULT 0,
  avg_ms    INTEGER,
  PRIMARY KEY (sample_id, dim, key)
);

-- 人工确认的基线：改了东西之后跑一次采样，和这里比才叫「变好了」。
-- 表里最多留几行，最新的一行是当前基准（不建唯一约束，靠采样时取 at 最大）。
CREATE TABLE metric_baseline (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  label     TEXT NOT NULL,
  sample_id INTEGER NOT NULL,
  note      TEXT
);
