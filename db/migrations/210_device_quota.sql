-- 210：设备配额与轮换（阶段 3，2026-10-23）
--
-- 为什么加在 devices 上而不是新表：
--   - `daily_tasks` / `daily_chars` 是**设备属性**（这台的额度），与设备同生命周期，
--     吊销即一起消失；
--   - 用量是每天一行的计数，单独 device_usage，按 (device_id, day) 唯一，
--     跨天自动换行，不做定时清理（行很小，100 台设备 × 365 天 = 3.6 万行）。
--
-- 默认值取"够用但不无限"：
--   200 次/天、200000 字符/天。0 = 不限额（显式关闭，不靠魔法值）。

ALTER TABLE devices ADD COLUMN daily_tasks INTEGER NOT NULL DEFAULT 200;
ALTER TABLE devices ADD COLUMN daily_chars INTEGER NOT NULL DEFAULT 200000;

CREATE TABLE device_usage (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,                 -- 本地日期 YYYY-MM-DD
  tasks INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX idx_device_usage_day ON device_usage(day);
