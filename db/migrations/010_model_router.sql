-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
CREATE TABLE breaker_state (
  endpoint_id     TEXT NOT NULL,
  track           TEXT NOT NULL CHECK (track IN ('primary','light')),
  state           TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  opened_at       INTEGER,
  next_probe_at   INTEGER,
  backoff_ms      INTEGER NOT NULL DEFAULT 60000,
  consec_failures INTEGER NOT NULL DEFAULT 0,
  half_open_ok    INTEGER NOT NULL DEFAULT 0,
  throttled_until INTEGER,
  last_kind       TEXT,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (endpoint_id, track)
);
CREATE TABLE breaker_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL, track TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  kind TEXT, latency_ms INTEGER, ts INTEGER NOT NULL
);
CREATE INDEX idx_bsample ON breaker_sample(endpoint_id, track, ts);
CREATE TABLE breaker_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL, track TEXT NOT NULL,
  from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  reason TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_bevent_ts ON breaker_event(ts);
CREATE TABLE router_state (
  key TEXT PRIMARY KEY CHECK (key IN ('mode','emergency_active','primary_endpoint_id','mode_since')),
  value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE pool_probe_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('health','tool_roundtrip')),
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  detail TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_probe_ep ON pool_probe_result(endpoint_id, ts);
-- Tier4 侦察候选状态机：needs_approval→approved|rejected；approved→live|expired；
-- live→retired；expired/retired→needs_approval（复活）；rejected 30d 冷却
CREATE TABLE recon_candidate (
  id TEXT PRIMARY KEY,                       -- 'recon:'+sha1(source|base_url|model)[0:12]
  source TEXT NOT NULL,
  base_url TEXT NOT NULL, model TEXT NOT NULL,
  api_key_note TEXT,                         -- 需要什么凭证，绝不存 key 本身
  rate_note TEXT, evidence TEXT,
  state TEXT NOT NULL DEFAULT 'needs_approval'
    CHECK (state IN ('needs_approval','approved','rejected','live','expired','retired')),
  decided_by TEXT, decided_at INTEGER, reject_reason TEXT,
  found_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(base_url, model)
);
-- 求救去重账本（账本先行协议：投递前 INSERT pending）
CREATE TABLE alert_dispatch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,                   -- sha256(newMode|失败指纹|tier)
  kind TEXT NOT NULL CHECK (kind IN ('help','recovery','recon_proposal')),
  mode TEXT NOT NULL,
  failing_json TEXT NOT NULL,
  served_by TEXT,
  task_impact TEXT,                          -- {queued_primary,running,held}（契约 T2 snake_case）
  channels_tried TEXT NOT NULL,
  delivered_via TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivered_via IN ('pending','telegram','email','outbox','none','lost')),
  sent_at INTEGER NOT NULL, delivered_at INTEGER, resolved_at INTEGER
);
CREATE INDEX idx_alert_sig ON alert_dispatch(signature, resolved_at);
-- 路由调用记账（attempt_id='nonj:'+ULID 为非 journal 调用，契约 J1）
CREATE TABLE model_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL, attempt_seq INTEGER NOT NULL,
  event_id TEXT, track TEXT NOT NULL,
  endpoint_id TEXT NOT NULL, model TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('ok','fail','breaker_skip','throttle_skip','half_open_busy_skip','stream_broken')),
  kind TEXT, latency_ms INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, ts INTEGER NOT NULL
);
CREATE INDEX idx_call_attempt ON model_call_log(attempt_id);
CREATE INDEX idx_call_ts ON model_call_log(ts);
