-- 190_conn_watch.sql —— 连接看门狗的状态（U3 的「持续在线」那一半，2026-10-22）
--
-- 要解决什么问题
--   `connections.ts` 能回答「我连了什么、现在什么状态」，但那要人去看。
--   Duet 说的「监控已连接应用」是反过来：**它自己看**，断了主动说一声。
--   看门狗每次检查完都要记住「这条连接我说过了」，否则每分钟重复同一句，
--   主人第一件事就是把它关掉。
--
-- 为什么落库而不是放内存
--   daemon 重启后内存清零 → 同一句问题会被再报一次。这与
--   170/185（proactive 的 last_push_at 落库）是同一个理由：**"说过"是长期事实**，
--   不是本次进程的临时状态。
--
-- 为什么是通用 KV 而不是照 (kind,id) 建结构化表
--   看门狗存的是「上次报告时的结论」，形态会变：
--   今天是一个指纹字符串（status|detail + 名字），明天可能要加「首次发现时间」
--   （用于「这个问题已经坏了两天」这种升级提醒）。结构化列会逼着每条想法都加迁移。
--   KV 只有一个约束：value 的格式由 src/surfaces/connection-watch.ts 的
--   encodeState/decodeState 定义 —— **格式只在那一处**，改格式只需改那一处，
--   解不出来时按「没记录过」处理（宁可多说一句，不可漏报）。
--
-- 为什么 dot_id 在 key 里而不是单独一列
--   key 的形态是 'connwatch:<dotId>'，一个 dot 自己那份状态。单个 daemon 目前
--   只跑一个 dot，但 key 里带上 dotId 让「以后多 dot」不需要改表。

SELECT 1;

CREATE TABLE IF NOT EXISTS surf_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);