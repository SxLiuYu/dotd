-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
CREATE TABLE mem_threads (                   -- thread ≡ session（契约 M1）
  id TEXT PRIMARY KEY,                       -- 'thr_'+ULID
  dot_id TEXT NOT NULL DEFAULT 'dot1',
  channel TEXT NOT NULL CHECK (channel IN ('web','telegram','cli','email','event','heartbeat')),
  external_ref TEXT,                         -- 幂等域：当前仅 telegram=chatId；web/cli/event NULL（MEM Q3）
  title TEXT,
  origin_task_id TEXT,                       -- event/heartbeat 幂等锚
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','sealed','purged')),
  pinned INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT, context_summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL,
  last_task_finished_at INTEGER,             -- sealTask 写入 = 封存/断点扫描锚
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mem_threads_dot  ON mem_threads(dot_id, last_active_at DESC);
CREATE INDEX idx_mem_threads_task ON mem_threads(origin_task_id) WHERE origin_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mem_threads_ext ON mem_threads(channel, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE TABLE mem_messages (
  id TEXT PRIMARY KEY,                       -- 'msg_'+ULID
  thread_id TEXT NOT NULL REFERENCES mem_threads(id) ON DELETE CASCADE,  -- 同属主，写入顺序自律
  seq INTEGER NOT NULL,                      -- 每 thread 从 1 单调，同事务 max+1
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  kind TEXT NOT NULL CHECK (kind IN
    ('text','tool_call','tool_result','approval_request','approval_verdict',
     'task_start','task_end','memory_note','system_error')),
  content TEXT NOT NULL,                     -- text=全文（恢复责任在此）；tool_*=digest+200 字预览
  task_id TEXT, event_id TEXT,               -- 弱关联，无外键（契约 S3）
  token_est INTEGER NOT NULL,                -- chars/3.5 估算
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX idx_mem_messages_thread ON mem_messages(thread_id, seq);
CREATE INDEX idx_mem_messages_task   ON mem_messages(task_id) WHERE task_id IS NOT NULL;
CREATE TABLE mem_files_index (               -- home 只读镜像；范围 MEMORY.md+notes+manuals，
                                             -- 排除 .archive/.tmp/.dotd
  dot_id TEXT NOT NULL, path TEXT NOT NULL,  -- HomeRelPath 唯一域
  area TEXT NOT NULL CHECK (area IN ('memory','notes','manuals')),
  tags TEXT, title TEXT,
  size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  PRIMARY KEY (dot_id, path)
);
CREATE TABLE mem_maintenance_state (         -- 游标/kv：compact_due:<dotId>、retention_last_run、
                                             -- index_sync_last、payload:<specId>、search_stats、purge_ledger
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
-- FTS5 预留（§6.4 信号触发再启用）：
-- CREATE VIRTUAL TABLE mem_messages_fts USING fts5(content, content='mem_messages', content_rowid='rowid');
