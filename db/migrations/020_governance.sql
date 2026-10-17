-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
CREATE TABLE gov_seq (
  name TEXT PRIMARY KEY,                     -- 'approval'
  value INTEGER NOT NULL DEFAULT 0           -- INSERT 同事务 UPDATE+RETURNING；豁免 90d 清理
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,                    -- rowid 可复用；展示与 TG 寻址一律用 seq（AP-#<seq>）
  seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'tool_call' CHECK (kind IN ('tool_call','synthetic','question')),
  subject_key TEXT,                          -- 非工具单幂等键（'recon:…'/'unk:'+callId）
  subject_json TEXT,
  dot_id TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT,
  journal_step TEXT,                         -- == ToolCall.callId == steps.call_id（契约 J1）
  tool TEXT,
  tier TEXT CHECK (tier IN ('read','write_file','browser','spend','dangerous')),
  params_json TEXT NOT NULL,                 -- sanitize 后
  summary TEXT NOT NULL,                     -- ≤120 字卡片文案
  reason TEXT NOT NULL,
  risk_brief TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','executing','executed','failed','revoked')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  pending_until TEXT NOT NULL,               -- created_at + TTL=24h（契约 G2 定稿）
  reminded_at   TEXT,                        -- 过期前 1h 提醒一次后回填
  decided_at TEXT,
  decided_by TEXT CHECK (decided_by IN ('web','telegram','cli') OR decided_by IS NULL),
  note TEXT,                                 -- 主人补充指令 ≤500 字符
  tg_message_id INTEGER, batch_ref TEXT,     -- 同任务批量卡片合并
  final_params_json TEXT,                    -- 认领时固化
  CHECK (kind != 'tool_call' OR (tool IS NOT NULL AND tier IS NOT NULL AND journal_step IS NOT NULL))
);
CREATE INDEX idx_approvals_pending ON approvals(status, pending_until) WHERE status='pending';
CREATE INDEX idx_approvals_step    ON approvals(journal_step);
CREATE UNIQUE INDEX uniq_open_step ON approvals(journal_step)
  WHERE kind='tool_call' AND journal_step IS NOT NULL
        AND status IN ('pending','approved','executing');   -- 同一步至多一张活动单
CREATE UNIQUE INDEX uniq_open_subject ON approvals(subject_key)
  WHERE subject_key IS NOT NULL AND status IN ('pending','approved','executing');
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,                       -- 'dec_'+ULID，每次 evaluate 出口先落库
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT NOT NULL, task_id TEXT NOT NULL,
  journal_step TEXT, call_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('allow','review_pass','approve','deny')),
  tier TEXT, tool TEXT, params_json TEXT, reason TEXT,
  review_skipped INTEGER NOT NULL DEFAULT 0, -- §5.1.2 降级放行标记
  from_memory INTEGER,
  approval_id INTEGER REFERENCES approvals(id),   -- 同属主 FK 允许
  precheck_json TEXT,
  postreview TEXT CHECK (postreview IN ('ok','suspicious','quarantine') OR postreview IS NULL),
  postreview_json TEXT,
  injection_suspect INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_decisions_step ON decisions(journal_step, ts);
CREATE TABLE approval_rules (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('read','write_file','browser')),  -- spend/dangerous 禁入
  rule_key TEXT NOT NULL, matcher TEXT NOT NULL, text TEXT NOT NULL,
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT
);
CREATE UNIQUE INDEX uniq_rule ON approval_rules(dot_id, tier, rule_key) WHERE status='active';
CREATE TABLE endpoint_grants (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL,
  origin TEXT NOT NULL, path_glob TEXT NOT NULL DEFAULT '/*',
  tier_ceiling TEXT NOT NULL CHECK (tier_ceiling IN ('read','write_file','browser')),
  source_approval INTEGER NOT NULL REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dot_id, origin, path_glob, tier_ceiling)
);
CREATE TABLE quarantines (
  id INTEGER PRIMARY KEY, dot_id TEXT NOT NULL, reason TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  approval_id INTEGER REFERENCES approvals(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  lifted_by TEXT, lifted_at TEXT
);
CREATE UNIQUE INDEX uniq_quarantine ON quarantines(dot_id) WHERE status='active';
CREATE TABLE audit_log (                     -- 只追加；action 枚举不加 CHECK（增枚举免迁移）
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT, task_id TEXT, journal_step TEXT, decision_id TEXT, approval_id INTEGER,
  actor TEXT NOT NULL,                       -- 'agent'|'owner'|'system'
  channel TEXT CHECK (channel IN ('web','telegram','cli','system') OR channel IS NULL),
  action TEXT NOT NULL, tier TEXT, tool TEXT, decision TEXT, reason TEXT,
  details_json TEXT, details_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_ts   ON audit_log(ts);
CREATE INDEX idx_audit_task ON audit_log(task_id, ts);
CREATE INDEX idx_audit_step ON audit_log(journal_step);
CREATE INDEX idx_audit_dec  ON audit_log(decision_id);
CREATE TABLE audit_archive (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL,
  min_id INTEGER NOT NULL, max_id INTEGER NOT NULL,
  min_ts TEXT NOT NULL, max_ts TEXT NOT NULL,
  rows INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  dot_id TEXT NOT NULL,
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  decision_id TEXT REFERENCES decisions(id),
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,             -- charge 正 / void 负
  currency TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charge','void','adjust')),
  note TEXT
);
