-- 来源：docs/design/自主Dot系统设计方案.md §9.2「SQLite 全量 DDL」分段
-- 约束：表结构一字不改（契约 D2/D4）；仅拆分到各迁移包，行尾归一为 LF
CREATE TABLE surf_jsonl_offset (
  path TEXT PRIMARY KEY, inode INTEGER NOT NULL,
  gen INTEGER NOT NULL DEFAULT 0,            -- 旋转代数，参与 dedup_key
  byte_off INTEGER NOT NULL,                 -- 只停完整行边界
  updated_at TEXT NOT NULL
);
CREATE TABLE surf_tg_card_state (            -- 通道侧事实；无 REFERENCES（契约 D2 去跨模块 FK，
                                             -- surf_heartbeat_state 已整表作废并入 crontabs）
  approval_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  reminded_at TEXT
);
CREATE TABLE surf_ingress_rejects (          -- 从未抵达 CP 的入站失败审计
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  source TEXT NOT NULL, actor TEXT,
  reason TEXT NOT NULL CHECK (reason IN
    ('auth','origin','rate','schema','size','allowlist','parse')),
  detail TEXT
);
CREATE TABLE surf_sse_cursor (
  k INTEGER PRIMARY KEY CHECK (k = 1), seq INTEGER NOT NULL
);
