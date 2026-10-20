-- 170_proactive.sql —— 主动发起对话（T4，2026-10-20）
--
-- 要解决什么问题
--   定时任务的结果能不能主动发到飞书，取决于线程是不是"飞书来源"。
--   2026-10-19 已经加了 fallbackChatId 兜底（非飞书会话改投主人默认会话），
--   所以"发不出去"这条已经修了。真正没解决的是**发太多**：
--   一个 15 分钟跑一次的定时任务，如果每次都推一条，主人一天收 96 条，
--   然后就会把所有通知静音 —— 那主动能力等于废了。
--
-- 为什么加在 crontabs 表而不是新表
--   "这个定时任务要不要主动说话" 是定时任务自己的属性，不是另一个实体的属性。
--   单开一张表意味着每次触发都要多一次 join，而且删除定时任务时容易漏删。
--
-- 三个字段各自解决什么
--   proactive       0 = 只记日志不推送（默认关，安全）；1 = 结果推给主人。
--                   **默认 0 是刻意的**：升级后已有的定时任务不会突然开始给主人
--                   发消息。开启是显式动作。
--   throttle_hours  同一个任务在这个窗口内最多主动推一次。0 = 每次都推。
--                   默认 6 —— 一天最多 4 条，不会让人静音。
--   last_push_at    上次真推出去的时刻。NULL = 从没推过。
--                   落库而不是放内存：daemon 重启不该让节流失效。
--
-- ⚠️ 这个文件的排版不是随意的（实测踩了三小时，别改）
--
--   db/migrate.ts 的 splitStatements() 按分号切分，**注释会粘在它后面那条
--   语句前面**。而 db/template.ts 的 buildSchemaScript() 用 /^\s*ALTER\s+TABLE/
--   匹配语句首部来给建表语句归组 —— 一旦语句以 "--" 开头就匹配不上，
--   整段被当成"其他"排到最后。这里"最后"意味着**在建表之前**（因为
--   CREATE TABLE 全被提前了），于是 ALTER 撞上不存在的表：
--     Error: no such table: crontabs
--   整个模板库建不出来，所有用模板的测试一起红。
--
--   所以本文件的硬约束是：
--     ① 注释块末尾必须接一条无害语句（这里用 `SELECT 1;`）把注释"吸走"，
--        否则注释会粘到第一条 ALTER 上，那条 ALTER 就再也匹配不到了
--     ② 所有注释集中放在文件开头（就是这块）
--     ③ 语句之间空一行（让切分结果里注释和语句彻底分开）
--
--   150_crontab_once.sql 只有一条 ALTER 且排在最后，撞巧躲过了这个坑
--   （注释粘上去后整段进"其他"，追加在末尾，表已存在所以能跑）。
--   一旦有多条 ALTER 就会踩中。新增迁移时请照本文件的排版来。

SELECT 1;

ALTER TABLE crontabs ADD COLUMN proactive INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crontabs ADD COLUMN throttle_hours INTEGER NOT NULL DEFAULT 6;

ALTER TABLE crontabs ADD COLUMN last_push_at INTEGER;

CREATE INDEX idx_crontabs_proactive ON crontabs(proactive) WHERE proactive = 1;