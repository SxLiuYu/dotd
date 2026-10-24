-- 211：设备 token 配额（阶段 3 第 4 条「每日配额（ASR/TTS 分钟、token）」的 token 部分）
--
-- 为什么 token 在 dotd 记、分钟不在：
--   音频不进 dotd —— ASR/TTS 在 Charlie 侧完成，dotd 看不到真实音频时长。
--   折中：字符数（`device_usage.chars`，迁移 210）约束 TTS 时长（约 3.5 字/秒），
--        token 数（本迁移）约束模型成本，这两件都是 dotd 能精确看到的事实。
--
-- 为什么单独一张账本表：
--   任务会重跑/恢复，终态事件不止一次；`usage_tokens` 又是累计值。
--   按 task_id 记「已经计入多少」，每次只把增量加进 device_usage，才不会重复计费。
--
-- 默认值：800000 tokens/天（0 = 不限）。按 200 次/天的任务量，单次约 4000 tokens，
-- 留了提示词与推理的余量；不够就调大，不想限就设 0。

ALTER TABLE devices ADD COLUMN daily_tokens INTEGER NOT NULL DEFAULT 800000;
ALTER TABLE device_usage ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;

CREATE TABLE device_token_ledger (
  task_id    TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  day        TEXT NOT NULL,          -- 本地日期 YYYY-MM-DD（与 device_usage 同一口径）
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_device_token_ledger_device ON device_token_ledger(device_id, day);
