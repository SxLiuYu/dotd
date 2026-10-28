-- 218：指标区分「工具审批单」与「其他审批单」（2026-10-27）
--
-- 为什么
--   213 只存了 approval_total。用它判断"为什么授权规则是 0 条"会得出错误结论：
--   实测本库 44 条审批里绝大部分是 question（模型在问主人问题），
--   工具类 tool_call 审批一条都没有（审批总开关 DOTD_APPROVALS 默认 off，所有档位直通）。
--
--   这两种 0 条完全不同：
--     · 有 tool_call 审批但没人点「以后都这样」 → 是沉淀失败，该修入口；
--     · 没有 tool_call 审批（开关关着）        → 本来就不问，不是短板。
--   混在一起看，就会催着人去修一个没坏的东西。
--
-- 只加列，不改表结构语义：旧行该列为 0，历史采样不受影响。

ALTER TABLE metric_sample ADD COLUMN approvals_tool INTEGER NOT NULL DEFAULT 0;
