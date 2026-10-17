-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;

-- 事件表（契约 E1：全系统唯一事件表；id INTEGER 自增，业务扩展进 payload 不加列）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('http','file','heartbeat','telegram','email')),
  dot_id TEXT NOT NULL,
  actor  TEXT NOT NULL,
  dedup_key TEXT UNIQUE,                    -- NULL 允许：多条 NULL 互不冲突
  payload   TEXT NOT NULL,                  -- JSON
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','matched','ignored','inbox')),
  received_at INTEGER NOT NULL
);

-- 心跳定时（契约 H1：单表归 CP，原 surf_heartbeat_state 行为扩展列已并入）
CREATE TABLE crontabs (
  id TEXT PRIMARY KEY,                      -- 'ct_'+nanoid
  dot_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
  cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  next_fire INTEGER NOT NULL,               -- 入表即由 cron-parser 算好
  last_fired_at INTEGER,
  last_fire_seq INTEGER NOT NULL DEFAULT 0,
  last_fire_status TEXT,                    -- fired|skipped_quiet|skipped_busy|error
  skip_if_busy INTEGER NOT NULL DEFAULT 1,
  quiet_hours TEXT,                         -- '23:00-07:30' 本地时区
  catchup TEXT NOT NULL DEFAULT 'latest' CHECK (catchup IN ('latest','skip'))
);

-- 任务队列
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,           -- 'tk_'+base36 时间序+rand；事件任务='tk_ev_'+events.id
  dot_id        TEXT NOT NULL DEFAULT 'dot1',
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  payload_json  TEXT,                       -- 契约 E2：mem 维护任务等结构化载荷（CP 原稿缺列，已补）
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','awaiting_approval','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 5, -- 0 最高；1=主人 interactive，7=bulk
  run_at        INTEGER,
  source_event_id INTEGER,                  -- 弱引用 events.id（契约 E1 由 source_event_log_id 改名）
  session_id    TEXT,                       -- ≡ thread_id，弱引用 mem_threads.id
  thread_id     TEXT,                       -- 弱引用 mem_threads.id
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_epoch     INTEGER NOT NULL DEFAULT 0, -- 围栏：转 running +1（CP §2.2）
  last_heartbeat_at INTEGER,
  resume_from_seq   INTEGER,                -- 审批放行后从第 N 步续
  stop_reason   TEXT CHECK (stop_reason IN
                  ('user','tool_risk','circuit_open','watermark','budget','shutdown')
                  OR stop_reason IS NULL),
  budget_tokens INTEGER NOT NULL DEFAULT 200000,
  usage_tokens  INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_pop  ON tasks(dot_id, status, priority, run_at);
CREATE INDEX idx_tasks_live ON tasks(dot_id, status)
  WHERE status IN ('running','awaiting_approval','paused');
CREATE INDEX idx_tasks_done ON tasks(status, updated_at)
  WHERE status IN ('done','failed','cancelled');

CREATE TABLE task_results (                 -- 同属主 FK 允许（契约 D2）
  task_id  TEXT PRIMARY KEY REFERENCES tasks(id),
  summary  TEXT NOT NULL,
  ok       INTEGER NOT NULL
);

-- 步骤级 journal（崩溃安全核心）
CREATE TABLE steps (
  task_id     TEXT NOT NULL,                -- 同属主应用层约束，不建 FK 以免 VACUUM 摩擦
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('llm','tool')),
  status      TEXT NOT NULL CHECK (status IN
                 ('pending','started','succeeded','failed','interrupted','skipped')),
  call_id     TEXT,                         -- ULID；llm 步同样填写（契约 J1）
  tool_name   TEXT,
  args_json   TEXT,                         -- >32KB 走 journal-blobs/ 文件
  result_json TEXT,
  side_effect TEXT CHECK (side_effect IN ('safe','replayable','unknown')),
  run_epoch   INTEGER NOT NULL,             -- 写该步时的 epoch，审计可辨哪代 Runner
  approval_id INTEGER,                      -- 弱引用治理 approvals.id（仅 pending 步）
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (task_id, seq)                -- (task_id,seq) 内部排序键，不外泄为审批引用
);
CREATE UNIQUE INDEX uq_steps_call ON steps(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX idx_steps_open  ON steps(task_id, status) WHERE status IN ('started','pending');

-- 事件匹配决策（PK=events.id 天然幂等；契约 E1 列名 event_log_id→event_id）
CREATE TABLE event_decisions (
  event_id     INTEGER PRIMARY KEY,
  action       TEXT NOT NULL CHECK (action IN ('run_new','merge','ignore')),
  task_id      TEXT,
  confidence   REAL NOT NULL,
  reason       TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('rule','llm','manual')),
  decided_at   INTEGER NOT NULL
);

-- 背压/围栏/资源事件
CREATE TABLE resource_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('normal','guarded','throttled','halted')),
  kind   TEXT NOT NULL CHECK (kind IN
           ('watermark','container_pause','container_unpause','container_kill',
            'queue_evict','disk_gc','stale_writer','watchdog','budget')),
  detail TEXT NOT NULL
);
