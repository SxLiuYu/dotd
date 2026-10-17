-- 060：mem_threads.channel 扩 'feishu'（2026-10-16 主人指定飞书机器人取代 Telegram）。
-- 契约 D2「改表结构必须走迁移包」：040 的 CHECK 里没有 feishu，SQLite 不能 ALTER CHECK，
-- 标准四步重建（新表→拷贝→删旧→改名）。列结构逐字复制 040_memory.sql，只在 CHECK 多一项。
-- 索引随表删除自动消失，重建逐字照抄 040。
-- mem_messages 的 REFERENCES mem_threads(id)：全库 foreign_keys 不启用（D2），改名后引用
-- 目标名复原为 mem_threads，无需处理。
CREATE TABLE mem_threads_new (
  id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL DEFAULT 'dot1',
  channel TEXT NOT NULL CHECK (channel IN ('web','telegram','feishu','cli','email','event','heartbeat')),
  external_ref TEXT,
  title TEXT,
  origin_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','sealed','purged')),
  pinned INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT, context_summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL,
  last_task_finished_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO mem_threads_new SELECT * FROM mem_threads;
DROP TABLE mem_threads;
ALTER TABLE mem_threads_new RENAME TO mem_threads;
CREATE INDEX idx_mem_threads_dot  ON mem_threads(dot_id, last_active_at DESC);
CREATE INDEX idx_mem_threads_task ON mem_threads(origin_task_id) WHERE origin_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mem_threads_ext ON mem_threads(channel, external_ref)
  WHERE external_ref IS NOT NULL;
