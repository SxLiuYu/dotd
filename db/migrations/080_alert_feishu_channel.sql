-- 080：alert_dispatch.delivered_via 扩 'feishu'（2026-10-17 修"SOS 未接飞书"）。
-- 契约 D2「改表结构必须走迁移包」：010 的 CHECK 里没有 feishu，SQLite 不能 ALTER CHECK，
-- 标准四步重建（新表→拷贝→删旧→改名）。列结构逐字复制 010_model_router.sql，只在 CHECK
-- 多一项 'feishu'。索引随表删除自动消失，重建逐字照抄 010。
-- 通道扩容背景：主人 2026-10-16 拍板飞书机器人取代 Telegram；MR 的 channel_order 与
-- SF 的 NotificationChannels 都已认 feishu（契约 T4 / SF §5.7），只剩库约束没跟上——
-- 不迁的话求救一投飞书就 CHECK 失败整条落 OUTBOX，等于白接。
CREATE TABLE alert_dispatch_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,                   -- sha256(newMode|失败指纹|tier)
  kind TEXT NOT NULL CHECK (kind IN ('help','recovery','recon_proposal')),
  mode TEXT NOT NULL,
  failing_json TEXT NOT NULL,
  served_by TEXT,
  task_impact TEXT,                          -- {queued_primary,running,held}（契约 T2 snake_case）
  channels_tried TEXT NOT NULL,
  delivered_via TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivered_via IN ('pending','feishu','telegram','email','outbox','none','lost')),
  sent_at INTEGER NOT NULL, delivered_at INTEGER, resolved_at INTEGER
);
INSERT INTO alert_dispatch_new SELECT * FROM alert_dispatch;
DROP TABLE alert_dispatch;
ALTER TABLE alert_dispatch_new RENAME TO alert_dispatch;
CREATE INDEX idx_alert_sig ON alert_dispatch(signature, resolved_at);
