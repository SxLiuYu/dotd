# dotd 对标 Claude Duet：功能对齐表（2026-10-22）

> **本文回答一个问题：文章里 Claude Duet 会的那 11 件事，dotd 现在会不会？**
> 每条结论都带「怎么验的」。没验的一律标**未验**，不写「应该可以」。
> 姊妹文档：`docs/muse-parity.md`（对标 Meta Muse，形态层结论更细）、
> `docs/comparison-openai-grok.md`（对标 OpenAI bot / Grok bot，逐项功能落地对比）。

---

## 0. 来源与读法

- 文章：《Claude Duet，重磅亮相》，财联社公众号，2026-10-22
  `https://mp.weixin.qq.com/s/JZ2z4SZCko6wuSRI2jRmvw`
- 抓取方式（可复现）：`Invoke-WebRequest` 带桌面 UA 取 HTML（3.47MB），
  从 `id="js_content"` 起截正文、去标签。正文约 1.1 千字，功能描述集中在第 1–7 段。
  抓取脚本与原文文本留在工作区根：`_wx_parse3.py` / `_wx_duet.txt`（一次性产物，未入库）。
- 证据级别：**实测** = 本轮真跑过命令/HTTP，附命令与输出；**读码** = 附 `file:line`；
  **未验** = 判断有依据但没跑，会明说。

---

## 1. 文章说的功能（逐条，原文口径）

| # | Duet 的能力 | 文章原话（节选） |
|---|---|---|
| U1 | 多端入口 | 「可在 iOS 和 Android 平台作为独立应用使用，也可在 claude.ai 网站上直接访问」 |
| U2 | 每日简报 | 「能够向用户发送每日简报」 |
| U3 | 监控已连接的应用 | 「监控已连接的应用程序」 |
| U4 | 构建仪表盘 | 「执行一系列任务，例如构建仪表盘」 |
| U5 | 安排会议 | 「安排会议」 |
| U6 | 制作财务预测 | 「制作财务预测」 |
| U7 | 主动推送 | 「它会主动向您推送需要关注的事项」 |
| U8 | 离机持续工作 | 「完成您交代的任务，即使您暂时离开也能持续工作」 |
| U9 | 行动前征得同意 | 「在代您采取行动前征得您的同意」 |
| U10 | 继承记忆/技能/已连接应用，配置极简 | 「可以继承用户 Claude 账户中的记忆、技能和已连接的应用，因此设置过程非常简单」 |
| U11 | 后台虚拟机 + 自己的浏览器，短消息描述任务即自动决定用哪些应用与步骤；完成或需审批时通知 | 「配备有一个带有独立浏览器的虚拟机……只需用简短的消息描述任务，它就会在后台自动计算出需要使用的应用和执行的步骤。任务完成后或需要用户审核时，用户就会收到通知」 |
| B1 | 自己的边界（诚实项） | 「主要面向职场设计，因此在处理购票等个人事务方面表现稍显逊色」；「仍处于早期阶段，因此可能会误读对话内容，或无法准确判断何为紧急事项」 |

---

## 2. 对齐总表

| # | 能力 | dotd | 一句话结论 |
|---|---|---|---|
| U1 | 多端入口 | ⚠️ 部分 | Web 控制台 + PWA（手机可装）+ 飞书；**无原生 App**（决定不做，见 §5） |
| U2 | 每日简报 | ✅ **本轮新建** | 每天到点一条，内容=日程/待批/近 24h 结果/将跑的定时任务；默认关 |
| U3 | 监控已连接的应用 | ✅ **本轮补齐** | 只读总览（六类连接）+ **看门狗**（每 15 分钟、边沿触发、安静时段、状态落库不重复报） |
| U4 | 构建仪表盘 | ✅ **本轮新建** | agent 写 `dashboards/<slug>.html`，`/d/<slug>` 托管；默认禁脚本 |
| U5 | 安排会议 | ✅ 对齐 | `calendar.*` 5 个工具，写本地 `.ics`，约时间前先查冲突 |
| U6 | 制作财务预测 | ❌ 不具备 | 无财务数据源、无会计模型；可达形态是「主人给数据 + 脚本 + 仪表盘」 |
| U7 | 主动推送 | ✅ 对齐且更克制 | 三道闸（开关/安静时段/节流），cron 与事件两条路径共用 |
| U8 | 离机持续工作 | ✅ 对齐 | daemon 常驻 + 每 Dot 一个容器（Playwright profile + `/dot/home`） |
| U9 | 行动前征得同意 | ✅ 对齐 | 治理五档：`dangerous` 一律人工审批；卡片投递全部主人会话 |
| U10 | 继承记忆/技能/连接 | ⚠️ 形态不同 | 记忆、技能（自造工具）、连接器都在本机；不继承任何云账户 |
| U11 | VM+浏览器 / 短消息→自动编排 / 完成通知 | ✅ 对齐 | 容器 + 41 个工具 + Runner 主循环 + 飞书出站（含进度推送） |
| B1 | 边界诚实 | ✅ 已写进文档与提示词 | 付款明确「不支持」；「紧急判断」靠闸门与审批而非模型自觉 |

**一句话总结**：能力层（U5/U7/U8/U9/U11）已对齐；**U2/U3/U4 是本轮补的真空白**（每日简报 / 连接看门狗 / 仪表盘）；
U1/U10 是形态差异而非能力缺失；U6 是**没有数据源**，不该假装能做。

---

## 3. 逐条证据

### U1 多端入口 —— ⚠️ 部分（Web + PWA + 飞书；无原生工程）

- **实测**：`web-ui/public/manifest.json`（`display: standalone`、192/512/maskable 图标、
  `start_url: /`）随 `vite build` 进 `web-ui/dist`，daemon 从 `GET /` 托管 → 手机浏览器
  「添加到主屏幕」即得一个独立图标的应用。
- **读码**：`src/surfaces/http.ts` 的静态托管分支（非 `/api`、非 `/hooks` 的 GET/HEAD）；
  监听地址可配（`surfaces.http.host` / `DOTD_HTTP_HOST`），非回环时 Origin 闸只收紧不放宽。
- **差异**：没有 `.swift` / `.kt` / `AndroidManifest.xml`（`find` 实测，见 `muse-parity.md` §7.1）。
  这不是「做不到」，是**决定不做**：HTTP 路由表已有 35 条（本轮新增 brief 与 connections 两条，之前 33 条），做 App 是另一个项目。
- 手机上的另一条路是飞书：所有推送（任务结果、审批卡、进度、简报）都走它。

### U2 每日简报 —— ✅ 本轮新建

- **为什么原来不算有**：dotd 早就能用 `schedule.create` 让模型每天生成一段话，
  但那是「模型每天自由发挥」，不是「确定性聚合」——日程读失败会被说成没有日程，
  待批的事可能被漏掉。简报必须是**固定口径的取数 + 固定顺序的渲染**。
- **实现（四个文件，职责单一）**：
  | 文件 | 职责 |
  |---|---|
  | `src/surfaces/daily-brief.ts:319` `buildDailyBrief()` | 纯函数：段序固定（日程→待批→近 24h→将跑→邮件）、空段省略、1200 字上限按段裁剪 |
  | `src/surfaces/insight.ts` `collectBriefInput()` | 取数：日历目录 + `approvals`/`tasks`/`crontabs`/`mail_accounts` |
  | `src/surfaces/daily-brief-push.ts:57` | 发送：一天一次（判据是 `surf_outbound_log` 里 `kind='brief'` 的成功记录）、迟到 `window_min` 后放弃 |
  | `src/daemon.ts:1784` `briefPush` | 装配：每分钟 tick 一次；目标=配置的 chat 或全部主人会话 |
- **入口三处同一份口径**：`GET /api/brief`（`http.ts:153`）、`dotd brief`、飞书每天那条推送。
- **实测（真 daemon，临时库，真插入数据）**：
  ```
  STATUS 200
  等你批的事
  · #902 删除 notes/old.md（dangerous）
  · #901 报销 380 元（发邮件）（dangerous）
  近 24 小时结果
  · 完成 1 / 失败 1 / 在跑 0 / 排队 0
  · 失败：抓取竞品价格
  今天还会跑
  · 13:06  早间日程提醒
  SECTIONS approvals,tasks,crontabs
  ```
  同一次 boot 的日志：`[dotd] [brief] 每日简报已启用：每天 08:30（迟到 180 分钟后放弃）`
- **默认关**（`surfaces.brief.enabled: false`）：会主动发消息的功能，升级后不该自己开始说话。
- **测试**：`tests/daily-brief.test.ts`（28 条）+ `tests/daily-brief-push.test.ts`（12 条）。

### U3 监控已连接的应用 —— ✅ 已对齐（总览 + 看门狗）

- **总览**：`src/surfaces/connections.ts:413` `buildConnections()` 把六类连接合成一张表：
  邮箱账号（`mail_accounts`）、日历源（`.ics` 扫描结果）、连接器（`github`/`rss`，来自
  `src/connectors/registry.ts`）、MCP server（`config/mcp-servers.yml`）、模型端点
  （`config/models.yml` 的 tier/base_url/模型名/enabled）、通知通道（飞书 + HTTP 控制台）。
  状态词表：`connected / ready / public_only / not_configured / error`，异常行带修复提示。
- **看门狗**：`src/surfaces/connection-watch.ts:155` `judgeWatch()` 判「该不该说」，
  `src/surfaces/connection-watch.ts:183` `inQuietHours()` 判安静时段，
  `src/surfaces/connection-watch-push.ts:47` `startConnectionWatch()` 是 ticker，
  装配在 `src/daemon.ts:1826` `connWatch`；状态表 `surf_kv`（迁移 `db/migrations/190_conn_watch.sql`）。
  每 `interval_min`（默认 15）取一次同一份总览，**只在变化时开口**：
  一直坏着 → 只说一次；坏法变了（detail 变了）→ 再说一次；好了 → 说一句「好了」。
- **为什么是边沿触发而不是心跳**：一条连接断了三天，每 15 分钟喊一次只会让人关掉通知。
  「说过就不再重复」的判据落在库里（`surf_kv` 的 `connwatch:dot1`），不是内存 ——
  daemon 重启不会把已经说过的话再说一遍。这与简报用 `surf_outbound_log` 判「今天发过没有」同一个理由。
- **安静时段**：`conn_watch.quiet_hours`（`'23:00-07:30'`，与 `crontabs.quiet_hours` 同语义，
  支持跨午夜）。时段内**只落状态、不推送**，出了时段也不补说。格式写错当作没设 ——
  宁可多报一句，也别因为一个笔误把所有故障静音。
- **实测**：`GET /api/connections` 200，例如
  `calendar → ready（0 个日历源 / 0 个事件）`、`github → public_only（未认证限速 60/h，hint：设 DOTD_GITHUB_TOKEN）`、
  `mcp → not_configured（没有配置任何 MCP server）`、模型端点逐条列出（禁用也列，detail 写「已禁用」）。
- **不泄露凭证**：SQL 只 SELECT 展示列（**不含 `secret_enc`**），测试里钉死
  「渲染文本不含 secret/token=/oc_」。模型端点与 MCP 只取展示字段，不含 api_key 与任何 env 值。
- **默认关**（`surfaces.conn_watch.enabled = false`）：多一个会主动发消息的通道，
  升级后不该自己开始说话。开关与安静时段都写在 `config/dotd.yml` 的注释里。
- **测试**：`tests/connection-watch.test.ts` 25 条，含「同一状态第二次跑不再发」、
  「状态先落库再推送（发送失败也不重复报）」、「安静时段只落状态不推送」、
  「恢复时说人话（GitHub 好了，不是 connector:github 好了）」、
  「取总览抛错只记日志不推送」、「enabled=false 连 rows 都不调」、「启动即跑一次」。
- **启动即查（真 daemon 上抓到的缺陷）**：原本只挂 `setInterval`，进程起来到第一个
  interval 之间是**盲的** —— 宕机期间坏掉的连接要等满 `interval_min` 才被告知，
  实测首次启动 15 分钟后 `surf_kv` 仍是空的。改成启动后 `queueMicrotask` 跑一轮
  （不 `await`，首轮异常只记日志不拖住启动；推迟一拍是为了不让「启动轮」和
  调用方拿到的初值撞车）。
- **真 daemon 端到端证据**（临时库 + stub 舰队 + 真 `Node 24`，2026-10-22）：
  ① 首次启动 → `surf_kv` 有 1 行 `connwatch:dot1`、5 条问题指纹落库、
  `[connwatch] 发往 oc_test… 失败：tenant_access_token 失败：code=10003`（假飞书凭证，推送失败是预期）、
  `surf_outbound_log` 记 1 条 `connwatch`；
  ② 用同一个库再启动一次 → 日志只剩「已启用」，`surf_outbound_log` 仍是 1 条
  —— **边沿触发在真进程上成立**，重启不重复报。

### U4 构建仪表盘 —— ✅ 本轮新建

- **为什么不做成「新工具 + 新表 + 新前端工程」**：agent 早就会 `fs.write`，
  多一条 `dashboard.write` 就要多一份治理档位、一份 prompt 说明书、一条 `HOST_SIDE_TOOLS`；
  而页面本身就是文件，文件已经是最好的接口。更新=定时任务重写这份文件，
  复用已有的调度与审批链路。
- **安全边界（刻意从严）**：
  - slug 白名单 `^[a-z0-9][a-z0-9-]{0,62}$`（`dashboard.ts`），路径穿越在进 fs 之前就被拒；
  - 只发 `text/html` + 严格 CSP：`default-src 'none'; style-src 'unsafe-inline'; img-src data:; …`，
    **不放开脚本**——页面跑在主人同一个 `127.0.0.1:7788` 源上，而 localStorage 里可能有 master token；
  - 空文件 / 非 HTML / 超 512KB → 422 并说明原因，不硬发。
- **实测**：
  ```
  /d/does-not-exist → 404 {"error":"dashboard","message":"没有这个仪表盘。让它做一份：…dashboards/does-not-exist"}
  /d/BAD..slug       → 404 {"error":"dashboard","message":"页面名不合法（只允许小写字母/数字/中划线）"}
  ```
- **边界**：容器 home 可重置（fleet reset 会清 `dashboards/`），要长期留存请同时写一份到 `notes/`；
  stub 容器下 `/d/` 恒 404（没有页面就不假装有）。
- **测试**：`tests/dashboard.test.ts`（14 条）。

### U5 安排会议 —— ✅ 对齐

- 5 个工具（`config/tools.yml`）：`calendar.list` / `calendar.conflicts` / `calendar.add` /
  `calendar.edit` / `calendar.delete`。写的是本地 `.ics`（`<dataDir>/calendar/local.ics`），
  订阅源只读；约时间前先 `calendar.conflicts` 查冲突。
- 判据：`scripts/regress/calendar-criteria.sh`（49 条，全绿）。**读码 + 既有判据**，本轮未重跑该脚本。

### U6 制作财务预测 —— ❌ 不具备（不是待办，是能力边界）

- dotd 里**没有任何财务数据源**：没有账簿、没有银行/支付接口、没有发票库。实测（2026-10-22）：
  `stripe` 0 命中、`invoice` 0 命中；`ledger` 有 112 命中，但**全部**是账本这个词的挪用 ——
  `spend_ledger` 8（治理的额度记录：工具花了几次/多少钱）、`purge_ledger` 7（记忆删除留指纹）、
  其余 97 是执行面的幂等账本（`exec_calls` ledger，EX §5.4）。**没有一条记的是主人的钱**。
- **能到哪一步（诚实版）**：主人把数据给它（`fs.write` 一段 CSV / `net.get` 拉一个公开数据集），
  它可以 `shell.run` 跑脚本做拟合、把结果写进 `dashboards/<slug>.html`。
  也就是说「预测方法」它会有，「预测所需的数据」它没有。
- **为什么不做内置**：财务预测的价值全在数据口径（谁的收入、算不算税、汇率按哪天），
  内置一套就等于替主人定义口径——比不做更危险。

### U7 主动推送 —— ✅ 对齐且更克制

- 三道闸在 `src/surfaces/proactive.ts:103` `shouldPush()`：**开关 → 安静时段 → 节流**，
  顺序刻意（日志里"为什么没推"总是最根本的那个原因）。
- 两条触发路径共用同一套闸（F7，2026-10-22）：`crontabs` 行（迁移 170）与
  事件路径 `event_push_policy`（迁移 185）；口径差别是安静时段拦在「进管线之前」还是「发送之前」。
- 设计上比 Duet 报道描述的更克制的地方：闸门放在**发送之前**而不是任务创建时 ——
  任务照跑（结果进记忆/文件），只是不打扰人。

### U8 离机持续工作 —— ✅ 对齐

- daemon 常驻：`src/daemon.ts` 装配完成后 `await new Promise<void>(() => {})` 永远挂起，
  事件循环由 Runner 的 pop 循环驱动；HTTP 与调度器各持定时器。
- 干活的是**每 Dot 一个容器**：Playwright + stealth、每个身份一份持久浏览器 profile、
  `/dot/home` 文件记忆卷（`src/exec/fleet.ts`、`src/exec/ExecService.ts`）。
  主人关机不影响它 —— 它在自己的机器/容器里跑，不是在你的浏览器标签页里跑。
- **未验**：本机 Windows 侧只跑 stub fleet；真容器在 WSL（`/root/dotd`）。这一条的证据来自
  既有文档与代码，本轮没有起真容器。

### U9 行动前征得同意 —— ✅ 对齐

- 五档治理（`config/tools.yml`）：`read`/`write_file` → allow，`browser` → review，
  `spend` → 一律人工，`dangerous` → 人工 + Web 勾选确认；未登记工具一律 deny。
- 审批卡片投递**全部主人会话**（F5，2026-10-22 修：原来硬编码只发第一个 chat）。
- 审批 TTL 24h；`executing` 卡住的 126 条是**已知遗留**（`docs/goal-2026-10-22.md` §0），
  简报会把 `executing` 数量单独报出来，不再假装「没有待办」。

### U10 记忆 / 技能 / 连接 —— ⚠️ 形态不同

| Duet 的说法 | dotd 的对应物 | 差异 |
|---|---|---|
| 继承账户里的记忆 | `mem_threads`/`mem_messages`/`mem_files_index` + FTS（迁移 110）+ `notes/`、`MEMORY.md` | 全部在**你自己的机器**（`~/.dotd/dotd.db` + 容器 home），不来自任何云账户 |
| 继承技能 | `tool.create` / `tool.list` / `tool.invoke` 自造工具（模型自己写脚本并复用） | 技能是**自己长出来的**，不是继承来的 |
| 继承已连接的应用 | 邮箱（通用 IMAP/SMTP）、日历（`.ics`）、GitHub、RSS、MCP（`mcp.call`） | 没有 OAuth 一键授权；首次要手填服务器地址（`CalendarService.ts:10` 写明理由） |
| 「设置过程非常简单」 | 复制一份 `config/dotd.yml` + 填 `master_token` + 设 1–2 个环境变量 | 比 Duet 麻烦，这是「自己拥有全部状态」的代价 |

### U11 VM + 浏览器 / 短消息→自动编排 / 完成通知 —— ✅ 对齐

- **VM + 自己的浏览器**：容器内有 Playwright（`exec-image/`），宿主侧另有 `agent-browser` 承接
  `web.*`；模型用 `browser.open/act/snapshot/screenshot` 操作页面。
- **短消息 → 自动算步骤**：`/api/messages` → `cp.submit(goal)` → Runner 主循环
  「问模型 → 调工具 → 再问模型」；**41 个工具**（`config/tools.yml` 实测计数）不是硬编码的流程，
  下一步做什么由模型在运行时定。
- **完成或需审批时通知**：飞书出站三条路——任务终态回复（`kind=task_reply`）、审批卡
  （`kind=approval`）、过程进度（含截图，`progress-push`/`screenshot-push`）；
  全部落 `surf_outbound_log`，主人问「怎么没收到」时查得到原因。

### B1 边界诚实 —— ✅

- 付款：**不支持**，是决定不是待办（`muse-parity.md` §7.6 有完整定案）。
- 「可能误读对话、误判紧急」：dotd 的应对不是「让模型更准」，而是**过程可审**
  （journal 逐步落库）、**危险动作要批**、**打扰有闸**。模型判断错时，代价被这三层挡住。

---

## 4. 本轮实做与验证

| 项 | 文件 | 判据/证据 |
|---|---|---|
| D1 每日简报 | `daily-brief.ts`（纯渲染）/ `insight.ts`（取数）/ `daily-brief-push.ts`（推送）/ daemon 装配 / `GET /api/brief` / `dotd brief` | 真 daemon + 临时库 + 真插入数据实测：`GET /api/brief` 200，`sections` 渲染出 `· #9001 删除 notes/old.md（dangerous）`、`· 完成 1 / 失败 1 / 在跑 0 / 排队 0`、`· 失败：整理周报草稿`；空库时正文恰为「今天没有需要你关注的事。」。测试：`tests/daily-brief.test.ts` 28 + `tests/daily-brief-push.test.ts` 12 |
| D2 仪表盘 | `dashboard.ts`（slug/CSP/校验）/ `http.ts` `serveDashboard` | 实测 `/d/does-not-exist` → 404 带「让它做一份…」；`/d/BAD..slug` → 404「页面名不合法」；`tests/dashboard.test.ts` 14（纯函数）+ `tests/surfaces-insight-routes.test.ts` 8（真 TCP：200/404/422/503、CSP 无 `script-src`、`cache-control: no-store`、不合法 slug 不碰读文件层） |
| D3 连接总览 | `connections.ts` / `insight.ts` / `GET /api/connections` / `dotd connections` | 实测 `dotd connections` 逐类有行：日历 `ready`、GitHub `public_only`+hint、MCP `not_configured`+hint、5 个模型端点（禁用的也在，带 `enabled → true` 的指路）、飞书 `not_configured`、HTTP 控制台 `connected`，尾行「共 11 项，connected 3 项，需处理 6 项」。测试：`tests/connections.test.ts` 31 + HTTP 层 4 |
| 附带修 | `connections.ts` 的 `endpointHost()` / `config/dotd.yml` 的 `brief:` 段 | 模型端点行原本只显示 tier（同一 tier 两个端点时两行都叫「1」，看不出哪条断了）→ 改成 `tier · host`，实测输出 `· 1 · 172.17.48.1:13065` 与 `· 1 · api.xxx.example` 可辨。`brief` 原只靠 zod 默认值生效、`config/dotd.yml` 里搜不到，主人发现不了这个开关 → 补了带注释的配置段，实测 `loadSurfacesConfig` 读回 `{"enabled":false,"time":"08:30","chatId":null,"windowMin":180,"maxChars":1200}` |
| D4 连接看门狗（本轮后半） | `connection-watch.ts`（纯判据/文案）/ `connection-watch-push.ts`（ticker）/ daemon 装配 / 迁移 `190_conn_watch.sql`（`surf_kv`） | 边沿触发：一直坏着只说一次、坏法变了（detail 变了）再说一次、好了说一句「好了」；判据落 `surf_kv` 不落内存，重启不重复报。安静时段只落状态不推送。**启动即查**（原本只挂 setInterval，头 15 分钟是盲的 —— 真 daemon 实测首启后 `surf_kv` 为空，改后首次启动即落 5 条指纹并发一轮）。测试：`tests/connection-watch.test.ts` 25（含「同一状态第二次跑不再发」「状态先落库再推送」「取总览抛错只记日志不推送」「enabled=false 连 rows 都不调」「启动即跑一次」）。真 daemon 端到端：同库重启两次，`surf_outbound_log` 恒为 1 条 |

```bash
cd D:\toagi\dotd
node node_modules/typescript/bin/tsc --noEmit -p .          # exit 0
node --disable-warning=ExperimentalWarning --import tsx --test \
  --test-concurrency=4 --test-timeout=180000 $(ls tests/*.test.ts | grep -v exec-container-concurrency)
#   1829 通过 / 0 失败 / 0 跳过，50.3s（2026-10-22 实跑，150 个测试文件）
```

- **基线对照**：本轮之前是 1630 tests（`docs/goal-2026-10-22.md` §0），本轮 1829 tests —— 新增 199 条：简报 28 + 简报推送 12 + 连接总览 31 + 仪表盘纯函数 14 + 三条路由的 HTTP 层 16 + **连接看门狗 25** + 其余来自夹具补齐与既有文件的用例增量。**既有断言的期望值一条未改**，只为 `SurfacesConfig` 新增必填字段 `brief` / `connWatch` 在 6 个测试夹具里各补了一行。

- **一处必须说清的边界**：仪表盘路由的 HTTP 层证据（`tests/surfaces-insight-routes.test.ts`，16 条）里的 `readHomeFile` 是**注入的假实现**。它证明了路由的四类响应（200/404/422/503）、CSP 无 `script-src`、以及「不合法 slug 绝不碰读文件那一层」；它**不证明**真容器里 `fs.read` 读得到文件 —— 那条由 `src/daemon.ts:1728` 的 `readHomeFileForShot` 走 exec 侧，本轮只在 Windows stub fleet 下跑，未做真 Docker 验证。
- **smoke 未跑通**：`scripts/smoke.mjs` 固定用 7788 端口，而本机已有一个 daemon 占着它（`EADDRINUSE`），所以冒烟本轮 rc=2。替代证据是上面那次**真 daemon + 临时库 + 真插入数据**的端到端 GET（见 U2/U3/U4 的实测输出）。要跑完整冒烟，先停本机 daemon。

---

## 5. 明确不做（与 Muse 文档同一口径，避免被当成待办）

| 项 | 结论 | 理由 |
|---|---|---|
| iOS / Android 原生 App | 不做 | 35 条 HTTP 路由都在（http.ts 的 Route 联合），做 App 是另一个项目；本轮用 PWA + 飞书覆盖「多端同源」最便宜那部分 |
| 付款 / 下单 | 不支持 | 真钱错误不可撤销，且本项目零支付通道（`muse-parity.md` §7.6） |
| 财务预测（内置） | 不做 | 没有数据源，且口径必须由主人定（见 U6） |
| 持续轮询式「监控」 | 不做默认 | 会变成「一直联网 + 一直打扰」；用定时任务与事件规则显式表达 |
| 可爱形象 / 起名 / 硬件眼镜 | 不做 | 纯形态层，与能力无关 |
| 继承云账户 | 不做 | 本项目立身之本是「状态全在你自己的机器上」 |

---

## 6. 与 `muse-parity.md` 的关系

- `muse-parity.md` 回答的是「**形态层**差在哪」（形象、App、硬件、付款边界），
  本文回答的是「**文章点到的功能**会不会」。两份不冲突：
  Muse 那篇里 §7 的「实现不了/不该做」在本文件 §5 被原样继承。
- 本文新增的 D1/D2/D3 三条，也补上了 `muse-parity.md` §1 总表里当时没列的
  「每日简报」「仪表盘」「连接总览」——那三项在 Muse 的报道里没被点名，所以上一轮没做。

---

## 7. 怎么自己重跑一遍

```bash
# ① 单元层
cd D:\toagi\dotd
node --disable-warning=ExperimentalWarning --import tsx --test `
  tests/daily-brief.test.ts tests/daily-brief-push.test.ts tests/dashboard.test.ts `
  tests/connections.test.ts tests/surfaces-insight-routes.test.ts `
  tests/connection-watch.test.ts   # 126 条（28+12+14+31+16+25）

# ② 接口层（需要先停掉本机 7788 上的 daemon，或用别的端口起一个临时实例）
#    临时实例的关键环境变量：DOTD_CONFIG / DOTD_DB_PATH / DOTD_HOME / DOTD_CONFIG_DIR /
#    DOTD_MODEL_TRANSPORT=stub / DOTD_FLEET=stub
curl -H "Authorization: Bearer <master_token>" http://127.0.0.1:<port>/api/brief
curl -H "Authorization: Bearer <master_token>" http://127.0.0.1:<port>/api/connections
curl -i http://127.0.0.1:<port>/d/does-not-exist        # 期望 404，文案说怎么办

# ③ tsc 与全量（Windows PowerShell 里没有 $(ls|grep)，先过滤出文件列表）
node node_modules/typescript/bin/tsc --noEmit -p .
$f = Get-ChildItem tests\*.test.ts | Where-Object { $_.Name -ne 'exec-container-concurrency.test.ts' } | ForEach-Object { "tests/$($_.Name)" }
node --disable-warning=ExperimentalWarning --import tsx --test --test-concurrency=4 --test-timeout=180000 @f
# ④ 真发一次（可选）：config.yml 里 surfaces.brief.enabled=true、time 设成 5 分钟后；
#    看门狗同理：surfaces.conn_watch.enabled=true、interval_min 设成 1，然后故意把
#    某个连接配错（例如把 DOTD_GITHUB_TOKEN 换成错的），一分钟内应收到一条，
#    之后再等一分钟不会收到第二条（边沿触发）；改回来后收到「好了」。
```
