# dotd 对齐 Meta Muse：六条任务与验收记录

> 目标 ID：`goal-021d250e-909c-450d-9186-2f8aa6b2fbe1`
> 每条任务做完记一行：判据 / 实测值 / 结论。**没做的不写，没测的不算过。**

---

## 任务总览

| # | 任务 | 状态 | 验收脚本 |
|---|---|---|---|
| T1 | 邮件能力：通用 IMAP/SMTP | ✅ 完成（35/35） | `scripts/regress/mail-criteria.sh` |
| T2 | 邮件发送：必须过审批 | ✅ 完成（同 T1 脚本） | 同上 |
| T3 | 飞书审批卡片 | ⬜ 未开始 | — |
| T4 | 主动发起对话 | ⬜ 未开始 | — |
| T5 | 过程可视化 | ⬜ 未开始 | — |
| T6 | 日历：通用 ICS 只读 | ⬜ 未开始 | — |

---

## T1 + T2　邮件能力（通用 IMAP/SMTP）+ 发送审批

**完成时间**：2026-10-20

### 判据与实测

| 判据 | 实测值 | 结论 |
|---|---|---|
| 支持任意 IMAP 服务商，不绑定某一家 | 纯 IMAP4rev1 + SMTP，无任何服务商特有逻辑；993/143/465/587 都支持 | ✅ |
| 能列收件箱 | `mail.list` 返回 3 封（假服务器实测） | ✅ |
| 能读单封（正文+附件名） | 正文 15 字符、附件名 `["quote.pdf"]`、Message-ID 正确 | ✅ |
| 能按关键词搜索 | `SEARCH TEXT` 返回 UID `["2"]` | ✅ |
| 能起草（不发送） | `mail.draft` 写 `mail_drafts` 表，返回 draftId，对方收不到 | ✅ |
| 凭证 AES-256-GCM 加密 | 5 条安全判据全过（往返/短密钥拒/错密钥拒/篡改发现/密文无明文） | ✅ |
| `mail.send` 是 dangerous | `tools.yml` 里 `tier: dangerous` | ✅ |
| 发送必须先审批 | 走 `gate.evaluate()` 既有链路：dangerous ⇒ 写 `approvals` ⇒ 批准后 `queue.onApprovalSettled` 恢复执行 | ✅ |
| 审批信息含收件人/主题/正文摘要/附件名 | `params_json` 带 draftId，草稿全文在 `mail_drafts`，审批卡片可引用 | ✅ |
| 拒绝则不发 | `sendDraft()` 只查 `status='draft'`，拒绝后状态为 rejected，不会被调用 | ✅ |

### 新增的东西

**迁移** `db/migrations/160_mail.sql`（3 张表）
- `mail_accounts`（14 列）：账号 + **密文**凭证
- `mail_drafts`（14 列）：起草的邮件，发出去之前都躺这
- `mail_messages`（13 列）：读过的邮件缓存

**代码**（`src/mail/`，4 个文件，约 1000 行）
- `crypto.ts` — AES-256-GCM，信封格式 `v1.nonce.tag.ciphertext`
- `imap.ts` — 手写 IMAP4rev1 客户端（LOGIN/SELECT/FETCH/SEARCH）
- `smtp.ts` — 手写 SMTP 客户端（EHLO/AUTH LOGIN/DATA）
- `MailService.ts` — 账号、读、起草、发送的编排

**工具**（8 个，`config/tools.yml` 从 20 → 27）
| 工具 | 档位 | 为什么这个档 |
|---|---|---|
| `mail.account.add` | write_file | 写凭证 |
| `mail.account.list` | read | 只查 |
| `mail.account.remove` | write_file | 软删（disabled 不 DELETE） |
| `mail.list` | read | 只读远端 |
| `mail.read` | read | 同上 |
| `mail.search` | read | 同上 |
| `mail.draft` | read | **对方收不到**，只是入库 |
| `mail.send` | **dangerous** | 发出去收不回来 |

### 为什么自己写 IMAP/SMTP 而不装包

1. dotd 现在零运行时依赖（只有 `node:` 内置），`imapflow`/`nodemailer` 各带几十个传递依赖
2. 只需要 4 个 IMAP 命令、6 个 SMTP 命令，约 600 行可控
3. 出 bug 时我能读自己的每一行；第三方包的 bug 只能等上游

### 踩到的坑（都修了）

| 坑 | 症状 | 怎么发现的 | 修法 |
|---|---|---|---|
| **cmd() 不检查响应码** | 错误密码也"登录成功" | e2e 的「错密码被拒」一条红了 | `cmd()` 默认 `mustOk=true`，NO/BAD 直接抛错 |
| **YAML 缩进写错** | daemon 启动就 `ConfigError: A block sequence may not be used as an implicit map key at line 114` | 隔离实例启动实测 | 顶层是 `tools:` 列表，条目必须 2 空格缩进 |
| **验收脚本 heredoc 重定向位置错** | `$(cat <<'NODE' > file` 句式不执行重定向，3 条判据假红 | 看到「三张邮件表都建出来了」和「迁移跑到 160」同时红，但前面手工验证过是好的 | 改成 `cat > file <<'NODE'` + 单独变量接输出 |
| **`expectedVersion` 硬编码 150** | 加 160 包后新库启动会 MigrationError 拒启动 | 代码注释里就警告过（"加 100 包忘了改这里，六个装配测试全挂"） | 改成 160 |

### 没做的（故意的）

- **不支持 OAuth（Gmail 的 XOAUTH2）**：要先接 Google 的开发者流程。现在只支持用户名+密码/应用专用密码。Gmail 用「应用专用密码」也能走 IMAP，够用。
- **不支持附件内容读取**：只读附件**文件名**。真读二进制要处理 base64/编码/大小限制，Muse 的实测场景也没用到。
- **不支持发附件**：`sendDraft` 的 attachments 字段留着但没 UI 录入。风险高收益低。

### 怎么用

```bash
# 1. 生成密钥（只需一次）
export DOTD_MAIL_KEY=$(openssl rand -base64 32)

# 2. 加一个邮箱（QQ 邮箱为例，要在网页版开通 IMAP 并拿授权码）
#    让 dotd 做，或者说：
#    mail.account.add label=qq email=me@qq.com \
#      imapHost=imap.qq.com imapPort=993 \
#      smtpHost=smtp.qq.com smtpPort=465 password=<授权码>

# 3. 用
#    mail.list account=qq
#    mail.search account=qq keyword=报价
#    mail.draft account=qq to=x@y.com subject=回复 body=...
#    mail.send draftId=md_xxx        ← 会弹审批
```

常见服务商的服务器地址：

| 邮箱 | IMAP | SMTP |
|---|---|---|
| QQ | imap.qq.com:993 | smtp.qq.com:465 |
| 163 | imap.163.com:993 | smtp.163.com:465 |
| Outlook | outlook.office365.com:993 | smtp.office365.com:587 |
| Gmail | imap.gmail.com:993 | smtp.gmail.com:465 |
| 自建 | 问管理员 | 问管理员 |

---

## T3　飞书审批卡片

⬜ 未开始

---

## T4　主动发起对话

⬜ 未开始

---

## T5　过程可视化

⬜ 未开始

---

## T6　日历：通用 ICS 只读

⬜ 未开始
