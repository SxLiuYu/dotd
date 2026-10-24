-- 212：语音侧「单一记忆源」与「单一主动推送决策」（阶段 5）
--
-- 三件事，一张迁移里完成：
--
-- 1) device_prefs —— 语音里说过的偏好以 dotd 为事实源。
--    Charlie 的 preferences.json 从此只是缓存：Web 读 /api/memory/prefs 能看到
--    同一份值；Charlie 删掉本地文件后重连会从 dotd 拉回来。
--
-- 2) device_push_state —— 每设备、每类主动推送的最后一次与当天次数。
--    主动推送的「该不该说」归 dotd（复用 src/surfaces/proactive.ts 的三道闸），
--    Charlie 只负责「怎么说」。状态必须落库，进程重启不能把节流账本清零。
--
-- 3) device_push_log —— 每次决策都留痕（允许与拒绝都记），
--    这样「昨天为什么没说话」有据可查，而不是靠 Charlie 的日志猜。
--    正文只存 sha256 前 16 位，避免把主人的原话写进决策账本。

CREATE TABLE device_prefs (
  device_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, key)
);

CREATE TABLE device_push_state (
  device_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  last_push_at  INTEGER NOT NULL,
  day           TEXT NOT NULL,          -- 本地日期 YYYY-MM-DD（与 device_usage 同口径）
  day_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, kind)
);

CREATE TABLE device_push_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  allowed    INTEGER NOT NULL,
  reason     TEXT,
  text_hash  TEXT
);
CREATE INDEX idx_device_push_log_device ON device_push_log(device_id, at);
