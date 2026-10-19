-- 140_stop_reason_extend.sql —— 扩展 tasks.stop_reason 的 CHECK 约束（2026-10-19）
--
-- 背景：原来只有 (’user’,’tool_risk’,’circuit_open’,’watermark’,’budget’,’shutdown’)。
-- 但"模型不可用"实际有三种完全不同的成因，共用 ’circuit_open’ 会导致
-- **恢复逻辑判断错对象**：
--   - circuit_open          breaker 打开（端点级故障，backoff 后自愈）
--   - no_qualified_primary  没有合格主端点（配置问题，改配置才好）
--   - endpoints_unreachable 全部端点连不上（网关/网络问题，网关恢复即好）
--
-- 实测症状：网关端口没起来 → 任务标成 circuit_open → 但 router.mode_changed 不触发
-- （mode 一直是 NORMAL）→ 任务永远卡在 paused，只有主人手动 resume。
--
-- SQLite 不能 ALTER 一个已存在的 CHECK 约束，只能重建表。
--
-- 三个必须注意的点（2026-10-19 逐个踩过）：
--  ① 迁移框架自己开事务，**文件里不能写 BEGIN/COMMIT**（会报 "cannot start a
--     transaction within a transaction"）。
--  ② `PRAGMA foreign_keys=OFF` 必须在事务**外**执行才有效 —— 框架只把
--     "以 PRAGMA 开头的语句"提到事务外执行。
--     **结尾绝对不能写 `PRAGMA foreign_keys=ON`**：框架会把文件里所有 PRAGMA
--     在 DDL **之前**一次性全跑掉，ON 会把 OFF 覆盖回去，于是 DROP TABLE
--     又因 task_results 的引用报 "FOREIGN KEY constraint failed"（2026-10-19 实测）。
--     关掉后无需恢复：foreign_keys 是**连接级**设置，下次新连接默认就是 ON。
--  ③ tasks 上有**三个**索引（idx_tasks_pop / idx_tasks_live / idx_tasks_done），
--     重建表后要全部补回。

PRAGMA foreign_keys=OFF;

CREATE TABLE tasks_new (
  id            TEXT PRIMARY KEY,
  dot_id        TEXT NOT NULL DEFAULT 'dot1',
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  payload_json  TEXT,
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','awaiting_approval','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 5,
  run_at        INTEGER,
  source_event_id INTEGER,
  session_id    TEXT,
  thread_id     TEXT,
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_epoch     INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER,
  resume_from_seq   INTEGER,
  -- 唯一改动：新增 no_qualified_primary / endpoints_unreachable
  stop_reason   TEXT CHECK (stop_reason IN
                  ('user','tool_risk','circuit_open','watermark','budget','shutdown',
                   'no_qualified_primary','endpoints_unreachable')
                  OR stop_reason IS NULL),
  budget_tokens INTEGER NOT NULL DEFAULT 200000,
  usage_tokens  INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO tasks_new (
  id, dot_id, title, goal, payload_json, status, priority, run_at,
  source_event_id, session_id, thread_id, attempt, max_attempts, run_epoch,
  last_heartbeat_at, resume_from_seq, stop_reason, budget_tokens, usage_tokens,
  budget_exhausted, created_at, updated_at
)
SELECT
  id, dot_id, title, goal, payload_json, status, priority, run_at,
  source_event_id, session_id, thread_id, attempt, max_attempts, run_epoch,
  last_heartbeat_at, resume_from_seq, stop_reason, budget_tokens, usage_tokens,
  budget_exhausted, created_at, updated_at
FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_pop  ON tasks(dot_id, status, priority, run_at);

CREATE INDEX idx_tasks_live ON tasks(dot_id, status)
  WHERE status IN ('running','awaiting_approval','paused');

CREATE INDEX idx_tasks_done ON tasks(status, updated_at)
  WHERE status IN ('done','failed','cancelled');

