-- 150_crontab_once.sql —— 支持一次性定时任务（2026-10-19）
--
-- 背景：主人说"今天下午3点提醒我开组会"，这是**最常见的提醒需求**，
-- 但 crontabs 只有 cron 表达式（重复触发），没有"执行一次就结束"的概念。
-- 现场：模型只能建一条"每天 15:00"，然后主动说明"没法限定只在今天一次"并给出替代方案 ——
-- 回答本身是诚实且得体的，但对标 OpenAI bot（能设一次性提醒）这是硬缺口。
--
-- 方案：加 `once INTEGER NOT NULL DEFAULT 0`。
--   once=1 表示"触发成功后就停用"（advance 里判断，不删记录 —— 保留历史可查）。
--
-- 为什么不复用 catchup/next_fire：
--   cron 表达式本身没有"只执行一次"的语义，next_fire 只是缓存的下次时刻。
--   加一个显式标记最不容易和既有逻辑冲突。

ALTER TABLE crontabs ADD COLUMN once INTEGER NOT NULL DEFAULT 0;
