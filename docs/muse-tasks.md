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

---

## T3 飞书审批卡片

**目标**：危险工具被拦下时，主人能在飞书里**点一下**做出决定，而不是自己去 `/approvals` 看。

### 判据 / 实测 / 结论

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| 1 | 卡片 JSON 结构合法（飞书会拒格式错的卡片） | header + elements + config 齐全，宽屏可更新 | ✅ |
| 2 | 卡片上有关键信息（收件人/主题/正文/附件/金额） | 6 个字段全在，`tests/approval-card.test.ts` 逐条断言 | ✅ |
| 3 | 卡片上写明风险与超时策略 | 有「风险」段 + 「按拒绝处理（不会偷偷执行）」 | ✅ |
| 4 | 按钮 value 能被正确解析回 approvalId + verdict | 两个按钮解析正确，48 条判据里 9 条专门测垃圾输入 | ✅ |
| 5 | 点击回调**不进任务事件流** | 走独立的 `card_action` 类型，不落 `im.message.receive_v1` | ✅ |
| 6 | 回调也要过主人闸门（卡片能被转发） | 非主人会话 → reject；未配 owner_chat_id → fail-closed | ✅ |
| 7 | 落定后卡片改写成结果、去掉按钮 | `buildResolvedCard` + PATCH `im/v1/messages/:id` | ✅ |
| 8 | 卡片真的发到 HTTP 层 | 假飞书服务器实测 `msg_type=interactive`，两个 verdict 都在 | ✅ |
| 9 | **同一条审批只推一次** | `approval:created` 订阅者数 = 1，验收脚本锁定这条 | ✅ |

**验收脚本**：`bash scripts/regress/card-criteria.sh` → **21/21，exit 0**

### 做了什么

| 文件 | 内容 |
|---|---|
| `src/surfaces/feishu-card.ts`（新增 246 行） | 卡片渲染 + 按钮 value 解析 + 落定卡片 |
| `src/surfaces/feishu-approval.ts`（新增 122 行） | 推卡片 / 改卡片的编排（**刻意不含订阅**，见下） |
| `src/surfaces/channels.ts` | `sendCard` / `updateCard` + `apiBase` 可注入 |
| `src/surfaces/feishu-inbound.ts` | `card.action.trigger` 分支 → `card_action` |
| `src/surfaces/feishu-outbound.ts` | 卡片优先、文本兜底，复用 `claimAndSend` 去重 |
| `src/daemon.ts` | 把卡片能力注入 outbound |
| `tests/approval-card.test.ts`（新增 187 行） | 48 条单元判据 |

### 接入点为什么选"旁听"

`gate.insertApproval()` 结尾早就有 `bus.publish('approval:created')`，所以只订阅那个事件，**治理代码一行没改**。治理是安全边界，动它的风险最大；旁听它是零风险的。

### 一个必须记录的设计错误

第一版我在 `daemon.ts` 里订阅了 `approval:created` 推卡片。但 `feishu-outbound.ts` **早就订阅了同一事件**发纯文本审批通知 —— 同一条审批会推两次。

`grep approval:created` 命中两个订阅者就是证据。修法是**二选一**：把卡片能力注入 outbound，由它判断"能发卡片就发卡片，发不出去才退回纯文本"，复用已有的 `claimAndSend` 去重。`feishu-approval.ts` 里那个会引入第二个订阅者的 `wireApprovalCards` 删掉了，并在原地留了注释说明为什么刻意不封装订阅。

验收脚本里加了一条 `approval:created 只有 1 个订阅者`，锁定这个约束防复发。

### 写测试时撞出来的两个可测试性缺陷

| 缺陷 | 后果 | 修法 |
|---|---|---|
| 飞书 API 地址硬编码在 `fetch()` 里 | 要验"卡片真的发出去长什么样"就得连真飞书，不可能自动化 | 加 `FeishuConfig.apiBase`（生产不传，默认官方地址） |
| 只改了 `messages` 端点、漏了 `tenant_access_token` 端点 | token 还是发去真飞书，8 条断言全红 | 两个端点都走 `apiBase` |

### 三个踩到的坑

| 坑 | 现象 | 原因 |
|---|---|---|
| 猜错 `ApprovalView` 字段名 | tsc 报 `Property 'params' does not exist` | 实际是 `fullParams` / `expiresAt`，而且**没有 `tool` 字段**，要从 `fullParams.tool` 或 `summary` 首段提取 |
| `taskRef` 缺字段 | tsc 报 `journalStepId is missing` | 不是可选字段 |
| 按钮 value 是字符串化 JSON | 断言 `'"approvalId":99'` 永远找不到 | 嵌进卡片 JSON 时引号被转义成 `\"`，得按语义匹配 |

### 刻意不做的

- **不做"记住这个审批"按钮**：`approval_rules` 表早就有，但把"永久放行"做成卡片上一个按钮太轻率了。它该是一个需要说明理由的动作，不是顺手一点。
- **卡片不显示完整命令**：只显示前 150 字符。完整参数在 `/approvals` 里能看，卡片上塞长文本会被折叠掉，反而看不到重点。
- **不持久化"审批单 ↔ 卡片 message_id"**：进程重启就丢。重启后旧卡片按钮点了会走 gate 的"找不到审批单"路径并被如实拒绝，不会误执行。要持久化得加一张表，当前收益不值。

---

---

## T4 主动发起对话

**目标**：dotd 能在主人没说话时主动发起对话，但**不烦人**。

### 判据 / 实测 / 结论

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| 1 | 定时任务的结果能主动发到飞书 | 2026-10-19 的 `fallbackChatId` 已覆盖（非飞书会话改投主人默认会话） | ✅ 既有 |
| 2 | 有**开/关**，且升级后不会突然开始发消息 | `proactive` 默认 0，验收脚本实测新插入的行默认关 | ✅ |
| 3 | 安静时段内不推 | `'23:00-07:30'` 跨午夜实测：23:30 在内、03:00 在内、07:29 在内、07:30 出界 | ✅ |
| 4 | 同话题不在 N 小时内重复推 | `last_push_at` + `throttle_hours`（默认 6h），实测 2h 前推过 → 拒；7h 前 → 放行 | ✅ |
| 5 | 节流重启后不失效 | `last_push_at` 落库不是放内存 | ✅ |
| 6 | 格式错的安静时段不误伤 | `parseQuietHours` 返回 null → 按"没有安静时段"处理 | ✅ |
| 7 | 拒绝时给人话解释 | 四种拒绝理由都有 `detail`，验收脚本断言 | ✅ |

**验收脚本**：`bash scripts/regress/proactive-criteria.sh` → **19/19，exit 0**
**单元判据**：`tests/proactive.test.ts` → **30/30**

### 关键设计：不推送 ≠ 不执行

这是 T4 最容易做错的地方。

| 情形 | 任务执行 | 结果推送 |
|---|---|---|
| `quiet_hours` 命中 | ❌ 不执行（`advance` 掉，标 `skipped_quiet`，既有行为） | ❌ |
| `proactive = 0` | ✅ **照常执行** | ❌ 不推 |
| `throttle_hours` 内已推过 | ✅ **照常执行** | ❌ 不推 |

为什么必须区分：定时任务的价值常常在**副作用**（写文件、更新记忆、刷新缓存），结果本身不值得打扰主人。如果把"不推送"实现成"不执行"，沉默就变成了功能缺失 —— 主人关掉推送后发现事情也没做。

### 三道闸的顺序

```
① 有没有目标会话  → no_target
② 开关开没开      → disabled
③ 在不在安静时段  → quiet_hours
④ 节流窗口过没过  → throttled
```

顺序是刻意的：先查最便宜、最常见的拒绝理由。这样日志里"为什么没推"总是指向**最根本**的原因 —— 一个没开主动推送的任务，不该留下"被节流"这种让人误会的话。

### 做了什么

| 文件 | 内容 |
|---|---|
| `db/migrations/170_proactive.sql` | `crontabs` 加 `proactive`（默认 0）/ `throttle_hours`（默认 6）/ `last_push_at`，加部分索引 |
| `src/surfaces/proactive.ts`（新增 140 行） | 三道闸的纯函数，`now` 传参所以可测 |
| `src/control-plane/types.ts` | `CrontabRow` 加 3 字段 + 语义注释 |
| `src/control-plane/index.ts` | `fireHeartbeat` 里判定并落 `last_push_at`，结论随 payload 传给下游 |
| `src/daemon.ts` | `expectedVersion` 160 → 170 |
| `tests/proactive.test.ts`（新增 165 行） | 30 条，重点盯跨午夜 |
| `scripts/regress/proactive-criteria.sh`（新增 19 条） | 含"迁移从 0 跑到 170 且字段齐"、"默认关"两条端到端 |

### 顺手修的一个既有 bug（花了三小时）

`db/template.ts` 的 `buildSchemaScript()` 用 `/^\s*ALTER\s+TABLE/` 匹配语句来给建表语句归组，但 `db/migrate.ts` 的 `splitStatements()` 按分号切分、**注释会粘在它后面那条语句前面**。

于是带注释的 `ALTER` 匹配不上 → 整段落进 `others` → 排到所有 `CREATE TABLE` 之前执行 → `Error: no such table: crontabs` → 模板库建不出来 → **所有用模板的测试一起红**，而报错只指向"表不存在"，完全看不出是注释的锅。

`150_crontab_once.sql` 撞巧躲过：它只有一条 `ALTER`，落进 `others` 后被追加在末尾，那时表已经建好。170 有三条 `ALTER` 就必踩。

修法：`buildSchemaScript()` 先用 `leadingComment()` 剥掉前导注释，再匹配和取表名。这个 helper 也加了注释解释为什么需要它。

### 踩到的坑

| 坑 | 现象 | 原因 |
|---|---|---|
| 注释粘语句 | `no such table: crontabs`，26 张表后再也建不出来 | `splitStatements` 保留注释，`buildSchemaScript` 的正则锚定在语句首部 |
| `SELECT 1;` 占位没用 | 注释仍粘到第一条 ALTER | 切分点是分号，注释跨过分号就跟到下一段 |
| `record()` 签名 | `Expected 3 arguments, but got 1` | 是 `record(kind, level, detail)`，且 `kind` 是资源治理词表，不适合放普通日志 |
| 猜错 `record` 用途 | 想把"没推送"记进 `resource_events` | 那张表是水位/GC/看门狗专用，塞进去污染语义。改用 `bus.publish('log', ...)` |
| 改 `expectedVersion` 漏了测试 | 3 个测试文件硬编码 150 | `daemon-assembly` / `db-template` / `memory-fts` |

### 刻意不做的

- **不做"每天都推一条早安"这种默认行为**：默认关，主人显式开。
- **不做按话题聚合去重**："同话题"需要语义判断，误判代价是把真正重要的消息当重复吞掉。用任务级节流（同一个定时任务）是明确无歧义的。
- **不把 `proactive` 做成全局开关**：主人可能希望"提醒吃药"每次都推、"检查磁盘"一天一次。粒度放任务级。
- **不做退订链接**：飞书卡片里加"以后别推了"按钮听起来贴心，但那会让"关掉"变成一次误触就能做到的事。关推送应该在配置里改。

---
