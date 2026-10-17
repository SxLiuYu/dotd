-- 070：surf_inbound_seen —— SF 属主的入站幂等表（feishu 主人消息路径，2026-10-16）。
-- 背景：feishu 消息此前走 cp.ingestEvent 做去重，但 ingestEvent 会进 CP §6 事件匹配
-- 管线（规则/LLM），对"SF 已直接 cp.submit 的聊天消息"再建第二个任务（实测 tk_ev_2
-- 重复）。聊天消息的任务属主是 SF 本身（与 POST /api/messages 同契约 S-1），去重
-- 因此归 SF 私有表；机器事件（已读/撤回等非消息类）仍走 ingestEvent 的事件管线。
-- UNIQUE(dedup_key) INSERT OR IGNORE = 幂等锚；重启不丢（飞书对失败投递会跨进程重投）。
CREATE TABLE surf_inbound_seen (
  dedup_key TEXT PRIMARY KEY,                -- 'fs:<event_id>'（types.feishuDedupKey）
  source TEXT NOT NULL,                      -- 'feishu'（预留：未来其它 IM 通道）
  actor TEXT NOT NULL,
  ts INTEGER NOT NULL                        -- epoch ms
);
