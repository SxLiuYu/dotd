# dotd 对齐 Meta Muse：六条任务与验收记录

> 目标 ID：`goal-021d250e-909c-450d-9186-2f8aa6b2fbe1`
> 每条任务做完记一行：判据 / 实测值 / 结论。**没做的不写，没测的不算过。**

---

## 任务总览

| # | 任务 | 状态 | 验收脚本 |
|---|---|---|---|
| T1 | 邮件能力：通用 IMAP/SMTP | ✅ 完成（35/35） | `scripts/regress/mail-criteria.sh` |
| T2 | 邮件发送：必须过审批 | ✅ 完成（同 T1 脚本） | 同上 |
| T3 | 飞书审批卡片 | ✅ 完成（21/21） | `scripts/regress/card-criteria.sh` |
| T4 | 主动发起对话 | ✅ 完成（19/19） | `scripts/regress/proactive-criteria.sh` |
| T5 | 过程可视化 | ✅ 完成（27/27）⚠️ 画面是文字摘要非位图 | `scripts/regress/progress-criteria.sh` |
| T6 | 日历：通用 ICS 只读 | ✅ 完成（21/21） | `scripts/regress/calendar-criteria.sh` |

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

---

## T5　过程可视化

**目标**：长任务执行中，主人能看见它在做什么、现在看到什么。

### ⚠️ 一条判据的偏差（如实记录）

目标原文写的是「每 N 步回传一次进度（**文字 + browser.snapshot 截图**）」。

实现出来的是 **文字 + 页面状态摘要**，不是位图。原因是事实性的：

```
agent-runtime/server.ts:739
  case 'browser.snapshot':
    return okResult(call.call_id, await page.snapshot());
```

`page.snapshot()` 是 Playwright 的 **a11y 结构文本**（`- heading "登录" [level=1]`），
不是 PNG。要拿到真截图必须改容器侧协议（新增 screenshot 调用返回 base64）
+ 飞书图片上传接口 + 体积限制，那是另一个任务，已记进 `docs/backlog.md`。

我没有为了"判据看起来过了"而把它当截图交差 —— 页面状态摘要确实回答了
"它现在看到什么"这个实际问题（"示例站 — example.com / 登录 / 提交"），
但它不是图。

### 判据 / 实测 / 结论

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| 1 | 长任务执行中有进度回传 | 订阅 `exec.call.finished`，攒够步数就推 | ✅ |
| 2 | 每 N 步一次，不刷屏 | `every_n_steps=3` + `min_interval_ms=90000` 双阈值 | ✅ |
| 3 | 只查一个阈值会出问题 | 实测：步数够但时间不够 → 不推；时间够但步数不够 → 不推 | ✅ |
| 4 | 开关关掉时一句都不推 | 喂假事件进去数发送次数 = 0 | ✅ |
| 5 | 默认关 | `DEFAULT_PROGRESS.enabled === false` | ✅ |
| 6 | 能在飞书里看到它在干什么 | 文案 `现在：读文件` / `卡在：打开网页` | ✅ |
| 7 | browser.snapshot 的画面进进度 | `screenOf()` 从 `steps.result_json` 抽出 `示例站 — example.com` | ⚠️ 文字非位图 |
| 8 | 认不出的画面不编 | 非 JSON / 未知工具 / 无内容 → 返回 null，文案里不出现「页面：」 | ✅ |
| 9 | 需要人介入时突破节流 | `needsAttention` 直接推，不等阈值 | ✅ |
| 10 | 不泄露工具参数 | 文案断言不含 `{`；画面只取 result 的标题/域名/name | ✅ |

**验收脚本**：`bash scripts/regress/progress-criteria.sh` → **27/27，exit 0**
**单元判据**：`tests/progress.test.ts` → **40/40**

### 数据一直都在，缺的是"说给人听"

这个任务没有采集任何新数据。已有的：

| 已有 | 位置 | 作用 |
|---|---|---|
| `steps` 表 | `db/migrations/000_control_plane.sql:75` | 每步的 kind / tool_name / status / **result_json** |
| `exec.call.finished` | `src/exec/ExecService.ts:597` | payload 含 taskId / tool / callId / status |
| SSE 分发 | `src/surfaces/sse.ts:199` | Web 侧早就有流 |

真正的缺口是实测确认的那一条：`grep 'step' src/surfaces/feishu-outbound.ts` → **0 次命中**。
飞书那边一句进度都没有。

### 为什么不订阅 task.state

`task.state` 只在状态**跃迁**时发（queued→running→done）。一个跑 10 分钟的任务
从 running 到 done 之间一条都没有 —— 而那正是主人最想看的时段。
`exec.call.finished` 才是"走了一步"的信号。

### 关键取舍

- **步数与时间双阈值**：只查步数会在快速小步任务上刷屏，只查时间在慢任务上从不说话。
- **未登记的工具原样吐名字**：编一个"看起来懂"的名字比露原名更糟。
- **失败的一步显式说"卡在"**：否则主人以为还在推进，比报错更误导。
- **进度状态放内存不加表**：重启最坏结果是多重推一条"正在做"，为它加迁移不值得。
- **画面取"最近一个成功的 browser.\*"**：不是每一步都有画面，也不是最新的一步就有用。
- **发失败不落账**：下一次还有机会补。落账会让"正好那条最该看的"永久丢失。

### 踩到的坑

| 坑 | 现象 | 原因 |
|---|---|---|
| `chatId` 必填 | TS2345：`string \| undefined` 不能赋给 `string` | daemon 里飞书没配时 sender 是 undefined，此时 chatId 也没意义。改成可选，两者齐备才启用 |
| 判据里读配置失败 | `ConfigError: DOTD_MASTER_TOKEN 未设置` | 配置有 9 个 `${ENV}` 占位，缺一个就 fail-closed。判据脚本给全占位值 |
| `snapshot` 断言写错 | `FAIL ... -- 登录` | 我以为结构化节点取不到 name 要退回域名，实际递归能挖到 —— 代码比我的断言更好，改断言而不是改代码 |
| `String(n)` 拼数组 | 返回 null | `tree` 是对象数组，`String({role:'heading'})` = `[object Object]`。改递归 `collectNodeNames` |

---
## T6 日历 ICS 只读

**目标**：能读日历、说清未来几天有什么、发现时间冲突。**不写**。

### 判据 / 实测 / 结论

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| 1 | 能读标准 `.ics` | 手工构造的 ICS 读出 3 个事件（含全天 + 定时混合） | ✅ |
| 2 | 长行折行能被正确接回 | RFC 5545 的「CRLF + 空格」续行实测拼回完整标题 | ✅ |
| 3 | 转义字符还原 | `\,` → 逗号、`\n` → 换行、`\\` → 反斜杠；`\\n` 不被误当换行 | ✅ |
| 4 | 全天事件不跑错日子 | `20261021` 解析成本地 00:00，日期是 21 号不是 20 号 | ✅ |
| 5 | 认不出的时间如实说未知 | 乱写的时间返回 null → 渲染成「时刻未知」，绝不猜 | ✅ |
| 6 | 能列未来 7 天 | `eventsInWindow` 7 天窗实测：3 事件里取到窗内 2 个 | ✅ |
| 7 | 能发现冲突 | 14:00-15:00 撞 14:30-15:30 → 检出 1 处 | ✅ |
| 8 | 首尾相接不算冲突 | 10:00-11:00 + 11:00-12:00 → 0 处 | ✅ |
| 9 | 全天事件不计入冲突 | 「出差」和两个会议重叠，只报会议相撞那 1 处 | ✅ |
| 10 | **没有任何写入能力** | 模块里没有 create/update/delete 函数，不 import `writeFileSync` | ✅ |
| 11 | 两个工具都是 `read` 档 | `calendar.list` / `calendar.conflicts` → `tier: read` | ✅ |
| 12 | 目录不存在要如实报错 | 返回 `errors` 非空，不当成「你没有安排」 | ✅ |

**验收脚本**：`bash scripts/regress/calendar-criteria.sh` → **21/21，exit 0**
**单元判据**：`tests/calendar-ics.test.ts` → **56/56**

### 为什么是只读

| | 读日历 | 写日历 |
|---|---|---|
| 频率 | 高（"下周有什么会"） | 低 |
| 说错的代价 | 主人立刻能纠正 | 别人的日程被打扰，且**不会有人告诉你搞错了** |
| 出错来源 | 解析 | 时区、冲突、参与人、重复规则，每一样都能错 |

Muse 的报道里记者让它"看我明天的安排"，没说让它改。所以这一版只做确定能做对的那一半 —— 能力边界诚实，比"号称能写但会搞坏你的日历"好。

想加"创建日程"必须**新开一个写档工具并走审批**，不能让读写共用同一个工具名，否则审批就被绕过去了。

### RFC 5545 里真会咬人的四条

手写解析器是因为 dotd 零运行时依赖，而 ICS 是本项目读过的最简单的格式之一。但简单不代表没有陷阱：

1. **折行**（§3.1）—— 超过 75 字节的行用「CRLF + 空格」续接。不处理的话长标题会被截断成莫名奇妙的短串。
2. **转义**（§3.3.11）—— `\n` `\,` `\;` `\\`。不处理的话「张三,李四」会变成两个字段。**顺序有讲究**：必须先处理 `\\`，否则 `\\n` 会被当成「反斜杠 + n」而不是换行。用状态机一次扫完，避免连续 replace 的二次转义。
3. **DATE vs DATE-TIME** —— `20261020` 是全天（本地 00:00），`20261020T140000Z` 是 UTC 时刻。混为一谈会让全天事件跑到错误的日子。
4. **TZID** —— 本地时区的会议引用时区定义。**明确不支持**，这时如实退回「时刻未知」，不猜。

### 刻意不做的

- **不展开 RRULE**：算错"下周三有会"比说"这个日程有重复规则我没法算"糟糕得多。遇到 RRULE 在描述里留一句说明。
- **不直接连 Google/Outlook**：那需要 OAuth、申请审核、处理 token 过期。读一个 `.ics` 文件已经能回答"下周有什么会"，先做能确定做对的。
- **不缓存**：`.ics` 通常几 KB，读一次几毫秒。缓存反而引入"文件改了但显示旧的"这种让人困惑的问题。
- **不加"创建日程"**：见上。

### 踩到的坑

| 坑 | 现象 | 原因 |
|---|---|---|
| `mkdir -p` 没生效 | `cp: cannot create regular file` | 脚本里 `mkdir -p ... \|\| exit 1` 与 `cd` 的顺序问题，`cd` 失败先退出 |
| 合并文件时中文全坏 | `Unterminated string literal`，`？` 吞掉闭合引号 | `Get-Content -Raw` 按本地编码（GBK）读 UTF-8 文件。改用 Python `io.open(encoding='utf-8')` 合并 |
| `grep -n '\[mail\]'` | 输出整个文件 | `[...]` 是正则字符类。改用 `grep -F` |
| 找不到 mail 注册标记 | `AssertionError` | 那是反引号模板串不是普通字符串，marker 里少了 `` ` `` |

---

---

## A1 浏览器登录态持久化 + A3 截图（2026-10-21，lead）

### 要解决的真问题

Muse 的演示里 agent 是"替你操作浏览器"的：登录过的网站它接着用，网页长什么样主人看得见。dotd 此前两个都缺：

- 每次开浏览器都是全新 profile，**163/GitHub 的登录态活不过一次调用**；
- 模型只能"读"页面（snapshot 文本），主人永远**看不见**网页画面——填好的表单、查到的账单，全靠模型用文字转述。

### A1 的设计：身份是宿主推导的，模型不用管 profile

- `browser.open` 的 `args.identity` 可选：不填 = 按 URL 域名自动推导 `site:<host>`（截 80 字符），每个身份一个持久 profile 目录 `/dot/profiles/<sha256(身份)前16位>`；显式 `anon` = 无痕。`browser.act/snapshot/close` 不传就**继承本任务当前身份**。
- 治理判定与真实派发共用同一个 `resolveBrowserIdentity()`——否则"审的是 A、跑的是 B"。
- 派发前把 `args.identity` 从 args 里剥掉：容器 schema 是 `additionalProperties:false`，不剥会被容器 400 拒。
- profile 卷挂载持久（docker volume），cookie 由 Chromium 自己管理；**硬重启会丢未冲刷的 cookie**—— Chromium 是批量落盘的，所以一切"要保登录态"的流程最后都要 `browser.close`（这同时释放 2 上下文/3 页面配额）。

### A3 的设计：base64 绝不进模型上下文

- 容器端 `browser.screenshot`：PNG 落 `/dot/home/screenshots/<task>-<call>.png`（持久卷），结果只带 `{path, bytes, sha256}`。base64 一旦进工具结果，就会进模型上下文（几百 KB）+ journal（永久）——两头都是灾难。
- 出站推送三段：① journal `steps` 表按 task 查 succeeded 的截图步骤（≤3 张，新的在前）→ ② 宿主经容器 `fs.read(base64)` 取回字节 → ③ `FeishuGateway.sendImage`（im/v1/images 上传拿 image_key → im/v1/messages 发 image 消息）。
- 触发点在出站层"文本回复发送成功之后"——截图是**随单附件**，不是独立消息；任何一步失败只落日志，绝不影响已发出的回复。

### 实机证据

- A1：`scripts/regress/browser-identity-e2e.sh` **6/6 PASS**（exit 0）——同一身份跨 `docker restart` cookie 存活（`CK sid=e2e123`）、`anon` 隔离干净（`CK none`）、profile 目录 `ae62613a33075f6d` 真实落盘。
- A3：`scripts/regress/browser-screenshot-e2e.sh`（daemon 重启后跑）——断言 path 形状、bytes>100、**PNG 魔数 89504E47 落盘**、容器内 sha256sum 与工具返回一致。
- 单测：runner-browser-identity 12 断言、screenshot-push/网关发图 52 绿。

### 踩到的坑

| 坑 | 现象 | 根因 |
|---|---|---|
| 批量补丁两次截断文件 | protocol.ts 769→210 行、tool-catalog.ts 同型截断，都断在插入点后一行的中间 | Python 写文件没关句柄（`io.open(...).write(s)` 一行式），缓冲没冲完进程就退了。**全部改为 with 块 + flush + 写后全文回读比对** |
| WSL 树不是 git 仓库 | 截断后在 WSL 里 `git checkout` 报 not a git repository | 权威库在 `D:\toagi\dotd`，WSL `/root/dotd` 是运行副本——恢复必须回 D 侧做 |
| 防漂移测试逮住容器侧新增 | tsc 报 contracts 类型 Exact 不满足 | 容器 `ToolName` 与契约 `ToolName` 是编译期 Exact 等价——两侧必须同步加名，这正是防漂移存在的意义 |
| 缩进连环判断错误 | 锚点命中 0 次 | 终端输出的缩进前缀是显示用的；**一律先 repr()/cat -A 看真实字节再定锚**，或用"按名字定位 + 缩进自适应" |

### 刻意不做的

- **不给模型看截图内容**（本批）：多模态回喂已有 inbound 先例（loadGoalImages），但截图回喂会让上下文爆炸，先只做"给主人看"。
- **不做截图基64直返**：见上，架构上就不允许。
- **不推送失败重试**：截图是附件不是主件，丢了可重截，不值得一套重试状态机。


## C 连接器第一批（2026-10-21，lead 集成 task-2 交付）

**范围拍板**：第一批 4 工具上目录——`github.notifications` / `github.issues` / `github.pulls` / `rss.read`（`rss.feeds` 无订阅清单数据源，随 subscribe/remove 一起推迟到第二批；详见 SPEC_BLOCK 开放点 ②③）。

**接线五层**（与 mail/calendar 同路径）：
1. `src/exec/protocol.ts` catalog 尾部 +4（全 sync / 60s / safe，注释标宿主侧）；
2. `src/exec/ExecService.ts` HOST_SIDE_TOOLS 14→18；
3. `src/daemon.ts` registerHostTool ×4 + `connectorWrap` 适配器（连接器永不抛、失败 `{ok:false,error:"前缀: 详情"}` → 宿主约定 `{ok:false,code,message,retryable:false}`，code 取前缀 no_token/timeout/network/http_403/bad_json）；
4. `src/runner/tool-catalog.ts` ToolDoc ×4 + 引导段第 9 条（造工具顺延为 10）；`SYSTEM_PROMPT_BUDGET` 4400→4600（runner-tool-catalog 预算断言同步 4600）；
5. `config/tools.yml` +4 块 tier: read（全只读 GET）。

**两个设计决定**：
- **limit 而非 per_page**：模型侧参数口径统一为 `limit`（与 mail.list 一致），处理器内映射 `perPage: min(max(limit,1),50)`。GitHub 原生 per_page ≤100，我们收口到 50 防炸上下文。
- **failure code 前缀透传**：连接器 error 串形如 `no_token：...`，wrap 层按 `：/:` 切前缀当 code，模型能据此决定"提示主人配 token"还是"稍后重试"。

**守卫同步**：`tests/agent-runtime-protocol.test.ts` HOST_SIDE_ONLY +4（容器↔宿主防漂移）；`tests/exec-protocol.test.ts` 计数 30→34 ×2 + expect 4 行；`tests/runner-tool-catalog.test.ts` 顺序数组 +4；`scripts/regress/calendar-criteria.sh` 双向镜像守卫改为前缀匹配 `/^(schedule|mail|calendar|github|rss)\./`（不再是写死 14），tools.yml 下界 ≥35，目录尾部收口判据改为 rss.read 收尾。

**未配 token 的降级路径**（connector 实现）：`github.notifications` → 结构化 `no_token` 错误（提示主人去配，不重试）；`github.issues/pulls` 公开仓照常可用（60 请求/时限速）。`DOTD_GITHUB_TOKEN` 未装钥匙，属 backlog。


### A3/C 实机验收记录（2026-10-21，lead）

**结果**：`browser-identity-e2e.sh` PASS、`browser-screenshot-e2e.sh` PASS 3/3（path 白名单 / bytes>100 / sha256 对上容器内文件魔数 89504e47）；ask 冒烟任务 tk_mvhcse7dq0lnyl 全链 done：browser.open → browser.screenshot（PNG 落 `/dot/home/screenshots/`，5388B）→ `FeishuGateway.sendImage` 返回 `{"ok":true}`，截图真实送达主人飞书。

**实机抓到的三个坑（单测全绿也拦不住，都是 e2e 的功劳）**：
1. **外层 dispatch switch 漏 case**：A3 把 `case 'browser.screenshot'` 加进了 `browserCall()` 的内层 switch，但外层工具分发 switch（server.ts 664-667）没加 → 运行时永远 `unknown_tool`。单测直接调 browserCall 所以绿。教训：加工具必须五层全查（catalog/union/name 列表/CAPABILITIES/外层 dispatch case）。
2. **runtime 词表是容器内 dist**：改了 /root/dotd 源码不等于容器生效——必须 `scripts/rebuild-image.sh`（删镜像→删容器→daemon 重建镜像拉新容器，卷都外挂不丢）。诊断信号：宿主侧 `/capabilities` 是新的、容器 runtime 报 unknown_tool。
3. **undici FormData 被飞书拒**：`FormData+Blob` 上传 `/im/v1/images` 报 230001 invalid parameter，同一 PNG 用 `curl -F` 成功 → channels.ts 改为手工拼 RFC2046 边界体（与 curl 逐字节对齐），live 通过。

**顺带发现（backlog 候选）**：browser.snapshot 在容器 playwright 上 `page.snapshot is not a function`（新版 API 是 ariaSnapshot）；gov 对每个 browser.* 步骤都发审批卡（一台本地测试页也要批一次）——后续考虑给 safe 档 browser.* 记忆式放行。


## A2 密码保险库 + C 收尾（2026-10-21，lead）

**A2 设计取舍**：
- 静止即密文：AES-256-GCM，钥匙**复用 DOTD_MAIL_KEY**（不引入第二把钥匙的托管问题）；
  `~/.dotd/vault.json` 落盘 mode 600，tmp+rename 原子写。文件里搜不到任何明文（实机 grep 验证）。
- **模型永远只见占位符**：`$vault:<site>:<user>`；替换点在 `ExecService.runTool` 顶部，
  这一刀的位置是关键——journal 的 `startStep` 在 runTool **之前**落原始 args，
  所以落库的必然是占位符原文；容器/宿主工具拿到的是明文；回包再按本次用到的明文清洗
  （`$vault:redacted`），结果不进 journal 明文、不进模型上下文。原始 args 对象不做原地改。
- fail-closed 三态：有占位符但没配钥匙 → `vault_unconfigured`；条目不存在 → `vault_missing`
  （绝不为"猜一个"而把占位符原样发给目标网站）；钥匙不对 → 解密抛错（GCM 认证标签兜住）。
- 写路径单点：只有 daemon 写 vault.json（D2 单写者精神）；`/api/vault` 三个端点 +
  CLI `dotd vault add|list|rm`（交互不回显，TTY raw mode；非交互整行读）。
- `vault.sites` 只回 site/user，值不进模型可见面（第五层接线照旧全套）。

**C 收尾**：daemon 启动时从保险库读 `site=github.com, user=token` 注入
`process.env.DOTD_GITHUB_TOKEN`——装好真 PAT 后重启即从 public-only 升级到完整模式，
不装就维持降级、不报错。保险库本身成为"所有站点凭证"的统一入口，不只是 GitHub。

**验证**：
- `scripts/regress/vault-criteria.sh` 6/6 PASS（往返 / 静止无明文 / list 形状 / 替换+清洗 /
  缺条目 / 五层接线）。
- `tests/vault.test.ts` 7 项 + `tests/exec-vault.test.ts` 3 项（真 ExecServiceImpl +
  宿主探针：明文到手、回包已洗、原始 args 未改、vault_missing、vault_unconfigured）。
- 实机：POST 写入 → GET 清单 → 文件 grep 无明文（-rw-------）→ node 侧同钥匙解密成功
  → CLI add/list/rm 全链 → DELETE 清理。
- 判据同步：`calendar-criteria.sh` 镜像守卫前缀加 `vault`，`OK 19/19`，tools.yml 下界 36。

**踩坑记录**：`scrubSecrets` 最初只依赖调用方传入"长在前"的列表——测试直接传乱序就暴露了，
改为函数内部防御式排序（短串是长串子串时，先洗短串会把长串洗剩一半）。
