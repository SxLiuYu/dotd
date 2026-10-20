-- 160_mail.sql —— 通用邮箱接入（2026-10-20，T1）
--
-- 背景：对标 Meta Muse，它的招牌场景是「跟进邮件」——读收件箱、判断时间线、
-- 起草回复。dotd 目前零邮件能力。
--
-- 为什么做通用 IMAP/SMTP 而不是 Gmail API：
--   1. 主人没说只接 Gmail；IMAP 是 1986 年的标准，163/QQ/Outlook/自建全支持
--   2. Gmail API 要过 OAuth 审核、要 7 天有效期刷新、要 HTTPS 回调域名
--   3. 容器里的 Python 标准库自带 imaplib/smtplib/email/ssl —— 零依赖
--   4. 通用方案不绑定任何一家，主人换邮箱不用我改代码
--
-- 凭证存储：**加密**。AES-256-GCM，密钥从 DOTD_MAIL_KEY 环境变量读（32 字节 base64）。
-- 为什么不放 _tokens_src.env：那是明文文件，邮箱密码泄露的后果比 token 严重
-- （邮箱能改密码、能收验证码，等于身份被盗）。
--
-- 为什么 mail.draft 也算 read 档：起草**不产生对外动作**，正文只在自己库里。
-- 只有 mail.send 会真的发出去，那条必须是 dangerous。

CREATE TABLE IF NOT EXISTS mail_accounts (
  id            TEXT PRIMARY KEY,
  dot_id        TEXT NOT NULL,
  label         TEXT NOT NULL,              -- 主人起的名，如"工作邮箱"
  email         TEXT NOT NULL,              -- 邮箱地址
  imap_host     TEXT NOT NULL,
  imap_port     INTEGER NOT NULL DEFAULT 993,
  smtp_host     TEXT NOT NULL,
  smtp_port     INTEGER NOT NULL DEFAULT 465,
  -- 凭证密文：version.nonce.tag.ciphertext（十六进制段，用 . 分隔）
  secret_enc    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  last_ok_at    TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_accounts_dot ON mail_accounts(dot_id, status);

-- 起草的邮件。发出去之前都躺在这。
-- 刻意存 account_id + 完整正文：审计时要能还原"它到底准备发什么"。
CREATE TABLE IF NOT EXISTS mail_drafts (
  id            TEXT PRIMARY KEY,
  dot_id        TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  task_id       TEXT,                       -- 哪次任务写的（可空：主人的手动草稿）
  to_json       TEXT NOT NULL,              -- JSON 数组：收件人
  cc_json       TEXT NOT NULL DEFAULT '[]',
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  in_reply_to   TEXT,                       -- 原始 Message-ID，回复时填
  attachments_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | discarded
  sent_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_drafts_dot ON mail_drafts(dot_id, status);

-- 读过的邮件缓存。为什么要缓存：
--   1. 搜索要快（IMAP SEARCH 慢且各家语法不一样）
--   2. 审批时要能引用"这封邮件的原文"
--   3. 模型多次读同一封不该重复走网络
CREATE TABLE IF NOT EXISTS mail_messages (
  id            TEXT PRIMARY KEY,           -- account_id + ':' + uid
  dot_id        TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  uid           TEXT NOT NULL,
  folder        TEXT NOT NULL DEFAULT 'INBOX',
  message_id    TEXT,                       -- RFC822 Message-ID
  from_addr     TEXT,
  to_addr       TEXT,
  subject       TEXT,
  sent_at       TEXT,
  body_text     TEXT,
  attachment_names TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，只要名字不要内容
  fetched_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_acct ON mail_messages(account_id, uid);
CREATE INDEX IF NOT EXISTS idx_mail_messages_dot ON mail_messages(dot_id, sent_at);