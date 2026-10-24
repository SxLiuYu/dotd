-- 200：语音端接入（2026-10-23）
--
-- 三件事：
--   1. mem_threads.channel 扩 'voice'（SQLite 不能 ALTER CHECK，标准四步重建；
--      列结构与 060_feishu_channel.sql 逐字一致，只在 CHECK 多一项）。
--   2. devices：每台 ESP32/语音终端一个身份，token 只存 sha256。
--   3. voice_events：反射层（场景词/设备控制）的记账，供 feed 与事后对账。
--
-- 为什么 device 不塞进 mem_threads：
--   设备是长期身份，thread 是一次会话；混在一起会让"吊销设备"变成"删会话"。
--   thread 侧只存 external_ref = device_id，符合 040 的幂等域设计。

CREATE TABLE mem_threads_v200 (
  id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL DEFAULT 'dot1',
  channel TEXT NOT NULL CHECK (channel IN ('web','telegram','feishu','cli','email','event','heartbeat','voice')),
  external_ref TEXT,
  title TEXT,
  origin_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','sealed','purged')),
  pinned INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT, context_summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL,
  last_task_finished_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO mem_threads_v200 SELECT * FROM mem_threads;
DROP TABLE mem_threads;
ALTER TABLE mem_threads_v200 RENAME TO mem_threads;
CREATE INDEX idx_mem_threads_dot  ON mem_threads(dot_id, last_active_at DESC);
CREATE INDEX idx_mem_threads_task ON mem_threads(origin_task_id) WHERE origin_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mem_threads_ext ON mem_threads(channel, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,                       -- 'dev_'+随机
  dot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,           -- sha256(token)，明文只在创建时返回一次
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_devices_dot ON devices(dot_id, created_at DESC);

CREATE TABLE voice_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'scene' / 'device.ac' / 'offline' / …
  detail TEXT,                               -- 人类可读的一句话（不含密钥）
  at INTEGER NOT NULL
);
CREATE INDEX idx_voice_events_dot_at ON voice_events(dot_id, at DESC);
