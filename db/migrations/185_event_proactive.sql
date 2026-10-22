-- 185_event_proactive.sql —— 事件驱动的主动打扰（F7，2026-10-22）
--
-- 要解决什么问题
--   170 让**定时任务**能主动说话，但 dotd 的主动能力至今只有一条路径：cron。
--   shouldPush() 的唯一调用点在 scheduler.fireHeartbeat 里 —— "到点了一条条 ping 主人"
--   会，"事情发生了立刻 ping 主人"不会。而 Muse 的核心体验恰恰是后者
--   （docs/meta-muse.md §1.3：它上周一直在 ping 我）。
--
--   非 cron 的机器事件全部走 ControlPlaneInstance.ingestEvent 这一个漏斗
--   （http/file/telegram/email 都从这里进）。今天这条路**一道闸都没有**：事件一旦被
--   匹配成任务，结果就无条件推给主人（feishu-outbound 的 shouldAnnounce 对
--   source != 'heartbeat' 直接返回 true）。缺的不是发送能力，是克制。
--
-- 为什么是新表而不是往 crontabs 加列
--   170 加在 crontabs 上，因为"要不要主动说"是那一行定时任务自己的属性。
--   事件不是定时任务：一条 http 事件没有 crontab 行可挂。它的身份是
--   (source, actor) —— 渠道 + 渠道里的具体发起者（同属 http 渠道，飞书的已读回执
--   和订阅回调应该能分开开关）。所以按 (source, actor) 主键建表。
--
-- 为什么**不是**再造一套闸门
--   列名与 170 逐字对齐（enabled↔proactive / quiet_hours / throttle_hours /
--   last_push_at / last_fire_status），判定复用 src/surfaces/proactive.ts 的
--   shouldPush()，本表只是把它的输入换一种读法。三道闸只有一份实现，
--   两条路径共享，不会出现"cron 改了、事件路径没跟着改"的漂移。
--
-- 各字段解决什么
--   enabled           0 = 事件照常进管线、任务照常跑，只是结果不主动推给主人。
--                     **默认 0 是刻意的**：升级后已有的事件源不会突然开始给主人
--                     发消息 —— 与 170 的 proactive 默认 0 同一个原则。
--                     查不到策略行时闸门**完全不介入**（payload 原样透传），所以
--                     "从没配过"等于"保持今天的行为"，既不会变吵也不会变哑。
--   quiet_hours       安静时段内事件**不进管线**（与 cron 同语义：拦在调度层，
--                     任务根本不被创建，last_fire_status='skipped_quiet'）。
--   throttle_hours    同一 (source, actor) 在这个窗口内最多主动推一次。0 = 不节流。
--                     命中节流时事件**照常进管线**，只是不推送（拦在发送层）。
--   last_push_at      上次真推出去的时刻，NULL = 从没推过。
--                     **落库而不是放内存**：daemon 重启不该让节流失效（同 170）。
--   last_fire_at      上次事件到达的时刻。NULL = 从没来过。
--   last_fire_status  与 crontabs.last_fire_status 同一套词表：fired / skipped_quiet。
--                     节流不改这里（任务确实跑了），保持"没推送 ≠ 没执行"这条线。
--
-- ⚠️ 排版照 db/migrations/170_proactive.sql，别改
--   db/migrate.ts 的 splitStatements() 按分号切，注释会粘在它后面那条语句前面。
--   虽然 db/template.ts 的 buildSchemaScript() 现在会先剥前导注释再匹配，但
--   "注释块 + SELECT 1; 吸走 + 注释集中在文件头 + 语句间空一行"这套排版是
--   170 用三小时实测换来的，新增迁移照抄比自创更安全。

SELECT 1;

CREATE TABLE event_push_policy (
  source           TEXT NOT NULL CHECK (source IN ('http','file','heartbeat','telegram','email')),
  actor            TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  quiet_hours      TEXT,
  throttle_hours   INTEGER NOT NULL DEFAULT 6,
  last_push_at     INTEGER,
  last_fire_at     INTEGER,
  last_fire_status TEXT CHECK (last_fire_status IN ('fired','skipped_quiet')),
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (source, actor)
);