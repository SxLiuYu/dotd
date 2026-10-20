# OpenMuse 功能全清单（挖来的原始材料）

> 挖于 2026-10-20。来源：**直接读 `github.com/CopilotKit/openmuse` 的源码**
> （VPS `43.134.39.26:/home/ubuntu/openmuse`，commit `34b15bc`）。
>
> **这份文档只陈述事实，不做 dotd 对比** —— 对比放在下一份。
> 凡是源码里读到的，标「源码」；凡是只在文档里写的，标「文档」。
> 两处都不支持的，不写。

---

## 0. 它到底是什么

> **A personal agent with a browser, terminal, files, and work that keeps going.**
> Compatible with any agent harness.
> —— README 第 5 行

- 作者：**CopilotKit**（做 React 端 AI 组件的那家）
- 许可：MIT（可自己改、自己托管）
- 形态：monorepo，`apps/{server,worker,computer,mobile}` + `packages/{domain,integrations,backends}`
- 技术栈：Node + PGlite（WASM 版 Postgres）+ CopilotKit React Native
- 状态：**Alpha，自托管**

**一句话定位**：给你一个「有浏览器、有终端、有文件、还能持续干活」的个人智能体，
用手机 App 或网页操控，**每个动作你都能看见、能审批**。

---

## 1. 四个进程（源码：apps/）

| 进程 | 干什么 | 关键源码 |
|---|---|---|
| **server** | 唯一的 API 与状态持有者；任务、动作审批、PDF、Gmail/Calendar | `apps/server/src/app.ts`（351 行，全部路由）|
| **worker** | **浏览器执行器** —— 真的开 Chromium、导航、截图、下载 | `apps/worker/src/browser.ts`、`downloads.ts` |
| **computer** | **Linux 容器** —— 跑 bash/Python/Node/git，管 `/workspace` 文件 | `apps/server/src/computer.ts`（823 行）|
| **mobile** | iOS / Android / Web **同一个代码库** | `apps/mobile/src/*.tsx`（29 个文件）|

> **这是和 dotd 最大的架构差异**：OpenMuse 把「浏览器」和「终端」拆成**两个独立的远端进程**，
> server 只做编排。dotd 是 daemon 单进程 + 一个 Docker 容器，浏览器在容器里。

---

## 2. 工具（源码：apps/server/src/computer-tools.ts）

**只有 10 个**，全部围绕「那台 Linux 电脑」：

```
computer_status          查看容器状态
start_computer           启动
stop_computer            停止
run_computer_command     跑命令（bash/Python/Node/git，有边界）
list_computer_files      列 /workspace 文件
read_computer_file       读文件
write_computer_file      写文件
mkdir_computer           建目录
import_computer_pdf      把 App 里的 PDF 送进电脑
export_computer_pdf      把电脑里的 PDF 拿回 App
```

**这一点很关键**：OpenMuse 的 agent **不是靠「20 个细粒度工具」干活的**，
它主要靠 `run_computer_command` 一条命令解决大部分事，
浏览器操作走的是另一套（AG-UI 事件 + `/api/browsers/*` 路由，不是工具）。

> dotd 有 20 个细粒度工具（`fs.read`/`fs.write`/`browser.open`/`net.get`…）。
> **这是两种不同哲学**：OpenMuse 给 agent 一把瑞士军刀，dotd 给它一套餐具。

---

## 3. HTTP 接口全表（源码：apps/server/src/app.ts）

```
GET  /api/health                      健康检查
GET  /api/session                     会话
GET  /api/main-thread                 主对话
POST /api/conversation                对话（AG-UI 流式）

# 浏览器（worker）
GET  /api/browsers                    列表
POST /api/browsers/:id/navigate       导航
GET  /api/browsers/:id/read           读页面
GET  /api/browsers/:id/preview        预览/截图
GET  /api/browsers/:id/console        接管控制台
POST /api/browsers/:id/reopen         重开
POST /api/browsers/:id/close          关闭
POST /api/browsers/:id/import-downloads  把下载的文件拿回来

# 任务
GET  /api/tasks                       列表
GET  /api/tasks/:id                   详情
POST /api/tasks/:id/control           暂停/恢复/取消/重试
POST /api/tasks/:id/input             补充给 agent 的信息

# 动作审批（Gmail/Calendar 写操作）
GET  /api/actions                     待审列表
POST /api/actions/:id/decide          同意/拒绝

# 文件与 PDF
GET  /api/files                       列表
GET  /api/files/:id/content           内容
POST /api/files/:id/fill              填表
GET  /api/workspace                   工作区

# Google
GET  /api/google/connect              OAuth 开始
GET  /api/google/callback             回调
POST /api/google/disconnect           断开
GET  /api/mail/threads/:id            完整邮件线程
POST /api/mail/import-attachment      把附件导进来
GET  /api/calendars                   日历列表
GET  /api/calendars/events            事件列表
POST /api/drafts                      草稿

# 个人上下文
POST /api/identity                    名字/语气/头像
GET  /api/memories                    记忆
POST /api/memories/:id/forget         忘记
GET  /api/notifications               通知
POST /api/notifications/:id/read      标记已读
GET  /api/ideas/:id                   想法
POST /api/ideas/refresh               刷新想法
GET  /goals  POST /goals  GET /goals/:id
GET  /monitors  POST /monitors/:id/control
```

**数一下：约 40 个端点。** dotd 没有 HTTP 开放接口层（只有内部 `/api/messages`）。

---

## 4. 数据模型（源码：packages/domain/src/）

```
agent.ts（164 行）
  AgentTask / TaskStep / TaskStatus      任务与步骤
  AgentArtifact                           产物
  AgentIdentity                           名字+语气+头像
  AgentMemory                             记忆
  AgentNotification                       通知
  AgentWorkspace                          工作区
  Goal / Idea / Monitor                   目标 / 想法 / 监控
  Evidence                                证据（每条都带）
  RunEvent                                运行事件

index.ts（197 行）
  ActionProposal / ProposalInput          带审批的提案
  Mail / EmailDraft                       邮件与草稿
  CalendarEvent / EventDraft              日历事件与草稿
  BrowserSession                          浏览器会话
  Workspace / WorkspaceMode               工作区
  Artifact / Section / ActivityEntry      产物 / 分节 / 活动
  ExecutionBackend                        执行后端
```

---

## 5. 已实现的功能（文档：docs/FEATURES.md，逐条）

| 区域 | 已实现 | 还没做 |
|---|---|---|
| **对话 / 派活** | CopilotKit 原生聊天、服务端工具、持久任务、确认过的结果 | 真实模型验收测试 |
| **想法 / 个人上下文** | 有来源的邮件/目标规则、接受/编辑/忽略、身份、可编辑可遗忘的记忆 | 跨连接器的模型推断 |
| **目标 / 追踪** | 里程碑、周期性监控、观测、重试退避、暂停取消 | 自适应长期规划、日历驱动提醒 |
| **浏览器** | 持久 Chromium、公开页读取、快照、控制台接管、PDF 下载 | 自主交互式预订、每人一台 VM |
| **Linux 电脑** | 非 root Docker、受限 bash/Python/Node/git、输出与退出码存证、持久 `/workspace`、文本编辑、PDF 进出 | 交互式终端、桌面应用、受控出网、磁盘配额、更强隔离 |
| **Gmail / Calendar** | Google OAuth、完整线程、保存草稿、日历/事件增删改（带审核版本）| 真实 Google 验收、重复事件编辑、其他连接器 |
| **PDF 任务** | 持久导入、带类型的输入请求、填写预览、审核过的回复、回执 | OCR/扫描件、更多字段类型 |
| **生成结果** | 计划/报告/对比、财务 CSV 指标、私有工作区里的脚本 | 工具安装与版本管理、图片/音频生成 |
| **通知** | 持久站内收件箱、来源链接的变更告警、重启对账 | APNs/FCM 设备推送 |
| **连接器** | 可搜的能力/状态目录、Google 连接、浏览器 worker | Plaid、健康、Instagram、WhatsApp |
| **OpenBot** | 已禁用的适配器（有协议/身份测试）| 真实会话桥接 |

---

## 6. 交互设计（文档：docs/EXPERIENCE.md，这是精华）

这些是**产品级的细节**，比「有没有某个功能」更难抄：

- **一个主对话**是默认。开着 Rich Threads 时，它的 ID 存在 workspace 里；侧聊有独立上下文。
- **发送箭头在回复期间原地变成停止方块**，回复结束变回来。**停止会保留草稿。**
- **追问出现在可见队列里**，按顺序跑。停止回复只暂停队列，**不会取消已派出去的任务**。
  队列存在**打开的 App 里**（不是服务端收件箱）—— App 关了就没了。
- **已打开的聊天和草稿在导航时保持挂载。**
- 读旧消息**不会强制滚到最新**，有个「回到最新」的按钮。
- **点头像**看活动、审核、回执。状态栏直接写「现在在干什么」或「需要你补什么信息」。
- **后台更新**只推「真正完成了」或「需要你输入」，链接到保存的任务，可忽略。
- **结构化审核屏保留确切的收件人、动作、同意/拒绝**。读公开页面不需要额外审核。
- 视觉：天空蓝/灰气泡、大触控目标、圆角输入胶囊、克制的产物框。
  **头像是一只原创的暖棕色水豚（capybara）**，本地打包。

> 这一节值得单独说：**它全是在解决「Agent 在干活时，人怎么不焦虑」**。
> 停止按钮变方块、草稿不丢、队列可见、旧消息不跳、头像显示当前状态 ——
> 每一条都是「让用户知道它在干什么、并且随时能踩刹车」。

---

## 7. 明确还没做的（文档：ROADMAP.md，原文勾选框）

**集成验收（都还没做）**
- [ ] 真实 Google OAuth / 邮件 / 附件 / 日历验收
- [ ] CopilotKit Intelligence Rich Threads 持久化/重放/跨设备
- [ ] 开放式派活的真实模型验收
- [ ] Android 模拟器/真机冒烟测试（包能导出，iPhone 模拟器验过）
- [ ] OpenBot 用户/会话桥接

**产品扩展（都还没做）**
- [ ] **交互式终端会话**、桌面应用、每人一台 VM、受控出网、磁盘配额
- [ ] **Agent 操作交互式网站、预订、客服、有边界的购买移交**
- [ ] Google Drive/Docs、社交/银行/健康连接器
- [ ] **设备推送、语音输入/回复、图片生成**
- [ ] OCR/扫描 PDF、更多表单类型、日历重复事件编辑
- [ ] 自适应长期规划、更广的想法来源、生成工具的托管仓库
- [ ] **多用户认证**、部署加固、数据保留/导出、运维恢复

> **划重点**：OpenMuse 现在**没有**多用户、没有语音、没有图片生成、没有交互式终端、
> 不会自动预订、不会自动付款。它把这些**明明白白写在 roadmap 里**。

---

## 8. 我读到的事实 vs 我的判断

**纯事实（源码/文档可查）**
- 10 个工具、约 40 个 HTTP 端点、4 个进程、MIT 许可
- 浏览器和终端是两个独立进程
- 有 Gmail/Calendar 的带审批写操作
- 有 PDF 填表、财务 CSV、目标监控、想法、记忆、通知
- 移动端是 React Native 一套代码出 iOS/Android/Web

**我的判断（标注出来，别当事实用）**
- 它的**产品完成度高于功能数量**。10 个工具做出来的体验，
  比 dotd 的 20 个工具更「像一个产品」——因为交互细节厚。
- 它的**能力边界比 dotd 窄**：不能 `net.post`、不能任意写本机文件、
  终端**没有网络**（明确设计，为了安全）。
- 它**不是「更强的 dotd」**，是**「更完整的手机 App」**。
  dotd 是「在飞书里干活的助手」，OpenMuse 是「给你自己的 agent 装了个 App Store 风格的壳」。

---

## 9. 补充挖掘（第二轮）

### 9.1 `packages/integrations/src/` —— 三个文件，1154 行

| 文件 | 行数 | 干什么 |
|---|---|---|
| `google.ts` | **816** | Gmail + Calendar 完整适配器 |
| `pdf.ts` | 282 | PDF 检查与填表（`inspectPdf` / `fillPdf` / `createSamplePdf`）|
| `vault.ts` | 56 | **凭据加密** |

**`vault.ts` 用的是 `AES-256-GCM` + 版本化信封**（`version.nonce.tag.ciphertext`），
密钥必须是 32 字节 base64，长度不对直接抛错。

> 这一点值得单独说：OpenMuse 把「Google 的 token 加密存」做成了独立模块，
> **密钥校验是硬失败，不是静默降级**。dotd 的 token 是明文放 `_tokens_src.env`。

**`google.ts` 覆盖到的 Calendar 字段**（从代码里读出来的，不是猜的）：
`summary / description / location / start / end / attendees / recurrence / recurring / etag / id`

注意有 **`etag`** —— 说明它做**乐观并发控制**（带版本号的更新）。
配合 `actions.ts` 里的 `targetVersion`，是「先给你看，你同意了，再拿当时的版本号去改」。

### 9.2 Agent 后端是可换的（源码：apps/server/src/agent.ts，**只有 62 行**）

```ts
config.agentBackend === "sample"      // 演示用，不需要 key
|| (config.agentBackend === "agui"    // 任意 AG-UI 协议的后端
      ? Boolean(config.agentUrl)
      : Boolean(config.model && (OPENAI_API_KEY || ANTHROPIC_API_KEY || GOOGLE_API_KEY)))
```

三种模式：
1. **sample** —— 内置演示，不要 key
2. **agui** —— 指向任意 AG-UI 协议的 agent 服务
3. **直连** —— 填 `model` + 三大厂的 key 之一

整个 `agent.ts` 62 行是因为它把活全交给了 **CopilotKit Runtime**
（`CopilotRuntime` / `createCopilotHonoHandler` / `AgentsFactory`）。

> **这是 OpenMuse 最狠的一招，也是最容易误解的一招**：
> 它自己**几乎没有 agent 逻辑**。真正的思考在外面（模型或另一个 AG-UI 服务），
> 它提供的是**壳**：UI + 任务持久化 + 审批 + 浏览器/终端执行器。
>
> 所以「OpenMuse 聪不聪明」这个问题没有答案 —— 取决于你接什么。

### 9.3 `packages/backends/src/` —— 只有 1 个文件

`openbot.ts`（343 行）。对应 README 里那句
「OpenBot：**Disabled adapter** with pinned protocol/identity tests」。
**是禁用的**，有协议和身份的契约测试，但没有真实连接。

文档里把它列在「已实现」是准确的，因为**它确实写了**，
只是没打开 —— 这个诚实的写法值得学。

---

## 10. 全部文件规模（我实际拉下来数的）

```
apps/server/src     27 个 .ts    5555 行（含 test）
apps/worker/src      8 个 .ts
apps/computer/       （Dockerfile 与脚本）
apps/mobile/src     29 个 .tsx/.ts
packages/domain/src  3 个 .ts     386 行
packages/integrations/src  3 个 .ts  1154 行
packages/backends/src      1 个 .ts   343 行
```

**server 里最大的三个**：`engine/service.ts`（1099）、`computer.ts`（823）、`workspace.ts`（449）。

---

## 11. 还没挖到的

- **`engine/model.ts`（366 行）的系统提示词**没逐行读
- **PGlite 的 schema/迁移**没看
- **`apps/mobile` 的页面树**只拿到字符串，没还原成导航结构
- **CI 配置与测试覆盖**没统计

要往下挖哪一块，说一声。
