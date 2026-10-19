-- 130_surf_outbound_log.sql —— 出站消息审计（2026-10-19）
--
-- 为什么需要：飞书出站（任务终态回复、审批请求）原来**只写日志**，
-- 而 daemon 的日志在每次重启时被清空（scripts/wsl-daemon.sh 里 `: > "$LOG"`）。
--
-- 后果：主人问"我没收到回复"时，事后完全无法回答——
--   那条任务回没回？发到哪个会话？飞书 API 报了什么错？全都查不到。
--
-- 这张表只记**元信息 + 文本前 200 字**，不存全文（回复正文已经在 mem_messages 里）。
-- 保留策略：靠 surf_outbound_log.at 索引按时间清理（见 recordOutbound 的 prune）。

CREATE TABLE IF NOT EXISTS surf_outbound_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 出站类型：task_reply（任务终态回复）/ approval（审批请求）
  kind          TEXT    NOT NULL,
  -- 去重键：与发送侧 claimed 的 key 一致，便于和日志对上
  dedup_key     TEXT    NOT NULL,
  -- 目标会话
  chat_id       TEXT    NOT NULL,
  -- 1 = 飞书 API 返回成功；0 = 失败（原因见 error）
  ok            INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error         TEXT,
  -- 文本前 200 字，够判断"回的是什么"，又不至于把表撑大
  text_preview  TEXT    NOT NULL,
  at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_surf_outbound_log_at ON surf_outbound_log (at);
CREATE INDEX IF NOT EXISTS idx_surf_outbound_log_kind ON surf_outbound_log (kind, at);
