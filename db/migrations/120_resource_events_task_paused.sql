-- 120: resource_events.kind 增加 'task_paused'
--
-- 2026-10-18：pauseByReason（熔断/水位/预算/工具风险）原来只改 tasks.stop_reason，
-- resource_events 里查不到任何记录 —— 事后想回答"昨晚为什么任务都停了"只能翻日志文本。
-- 补一条可追溯事件，但 kind 有 CHECK 约束，'task_paused' 不在白名单里，写入被拒。
--
-- SQLite 不支持直接改 CHECK，只能重建表。resource_events 是纯审计表（无外键引用），
-- 重建安全：建新表 → 拷数据 → 删旧表 → 改名。
CREATE TABLE resource_events_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('normal','guarded','throttled','halted')),
  kind   TEXT NOT NULL CHECK (kind IN
           ('watermark','container_pause','container_unpause','container_kill',
            'queue_evict','disk_gc','stale_writer','watchdog','budget','task_paused')),
  detail TEXT NOT NULL
);

INSERT INTO resource_events_new (id, ts, level, kind, detail)
  SELECT id, ts, level, kind, detail FROM resource_events;

DROP TABLE resource_events;
ALTER TABLE resource_events_new RENAME TO resource_events;
