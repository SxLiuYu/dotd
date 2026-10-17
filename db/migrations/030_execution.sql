-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
CREATE TABLE exec_dots (
  dot_id TEXT PRIMARY KEY,                   -- 阶段一恒 'dot1'；无 dots 表（契约 D2 裁定）
  runtime_ver TEXT NOT NULL,                 -- 参与镜像 tag；增删工具 bump
  limits_json TEXT NOT NULL,                 -- 配额唯一事实源 {memMb:1536,cpuMillis:2000,…}（契约 J5）
  idle_timeout_s INTEGER NOT NULL DEFAULT 900,
  deep_stop_after_s INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE image_builds (                  -- 镜像全局唯一，无 dot 维度
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL, digest TEXT, pw_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','ready','failed','superseded')),
  log_tail TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id TEXT NOT NULL REFERENCES exec_dots(dot_id),   -- 同属主 FK
  docker_container_id TEXT,
  state TEXT NOT NULL CHECK (state IN
   ('absent','image_ready','created','booting','ready','busy','idle',
    'suspended','idle_stop_requested','stopped','quarantined',
    'unhealthy','create_failed','build_failed','removed','lost')),
  endpoint TEXT,                             -- http://IP:9223
  token_hash TEXT,                           -- 明文 token 只存 ro-bind 文件，不落库
  last_health_at TEXT, last_busy_at TEXT,
  recreate_count INTEGER NOT NULL DEFAULT 0, -- >3/24h → quarantined
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_containers_state ON containers(state);
CREATE UNIQUE INDEX ux_containers_active_dot ON containers(dot_id)
  WHERE state NOT IN ('removed','lost');     -- 挡双活跃行（NULL≠NULL 教训的修正版）
CREATE TABLE exec_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id TEXT NOT NULL REFERENCES exec_dots(dot_id),
  identity_key TEXT NOT NULL,                -- 语义身份名；登录态审计落此
  profile_hash TEXT NOT NULL,                -- sha256(identity_key)[0:16]，目录名用 hash
  last_used_at TEXT,
  UNIQUE (dot_id, identity_key)
);
CREATE TABLE exec_volumes (                  -- DiskGardener 防误删白名单
  name TEXT PRIMARY KEY,                     -- dot-<id>-home / -profiles / -state
  dot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home','profiles','state')),
  quota_mb INTEGER NOT NULL, usage_mb INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE exec_calls (                    -- journal 步的协议层投影（call_id 对齐，无跨模块 FK）
  call_id TEXT PRIMARY KEY,
  job_id TEXT,                               -- async 回执：对账续轮询与 cancel 的键
  task_id TEXT NOT NULL, dot_id TEXT NOT NULL, tool TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sync','async')),
  args_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sent','running','done','error','cancelled','interrupted')),
  result_hash TEXT, error_code TEXT,
  sent_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX idx_exec_calls_task ON exec_calls(task_id);
CREATE INDEX idx_exec_calls_open ON exec_calls(state) WHERE state IN ('sent','running');
CREATE INDEX idx_exec_calls_job ON exec_calls(job_id) WHERE job_id IS NOT NULL;
CREATE TABLE exec_disk_policy (
  key TEXT PRIMARY KEY, value_mb INTEGER NOT NULL, updated_at TEXT NOT NULL
);
