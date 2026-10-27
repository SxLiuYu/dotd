-- 214：指标明细多一维「失败原因」（2026-10-27）
--
-- 为什么
--   213 的明细只能按工具名拆，得出的是「net.get 失败率 86%」。这个结论会把人
--   带错方向：查下去发现 net.get 和 shell.run 的失败**同一个根因**——
--   容器状态 quarantined 不可派发（86 次）。按工具名看是"某个工具坏了"，
--   按原因看才知道是"执行容器坏了，所有依赖容器的工具一起挂"。
--   两种拆法要并存，缺一个就说不清该修哪里。
--
-- 为什么重建表而不是 ALTER
--   dim 上有 CHECK 约束，SQLite 不能直接改 CHECK，只能换表。

PRAGMA foreign_keys = OFF;

CREATE TABLE metric_series_new (
  sample_id INTEGER NOT NULL,
  dim       TEXT NOT NULL CHECK (dim IN ('tool','model_track','task_channel','stop_reason','tool_error')),
  key       TEXT NOT NULL,
  n         INTEGER NOT NULL,
  bad       INTEGER NOT NULL DEFAULT 0,
  avg_ms    INTEGER,
  PRIMARY KEY (sample_id, dim, key)
);

INSERT INTO metric_series_new (sample_id, dim, key, n, bad, avg_ms)
  SELECT sample_id, dim, key, n, bad, avg_ms FROM metric_series;

DROP TABLE metric_series;
ALTER TABLE metric_series_new RENAME TO metric_series;

PRAGMA foreign_keys = ON;
