# dotd 竞品对标矩阵（OpenAI / Grok vs dotd）

> 调研日期：2026-10-17。dotd 基线 commit：`fb575f4`（「baseline: dotd 阶段一快照」）。
> 本文只解决一个问题：**把 dotd 的 agent 能力逐项摊开，与 OpenAI、xAI Grok 摆在同一张表上，看清"差在哪、差多少、哪些是故意不追"**。
> 具体怎么补 → 见 [`roadmap-to-parity.md`](./roadmap-to-parity.md)。

---

## 0. 证据规则（先读这一节，否则整张表不可信）

### 0.1 dotd 列：全部实读仓库，带 `path:line`

dotd 列的每一个格子都是我在本机仓库里逐文件读出来的，**行号对应 commit `fb575f4`**。
**凡是「代码里找不到实现」的，一律写成 `缺失` 或 `未接线`，不拿 README/设计文档的口径顶替代码。**
本次阅读中抓到 4 处"文档说有、代码没有"，已单独列在 §12「文档与代码的偏差」——这几条恰好会决定路线图的优先级。

> **行号会漂移。** 撰写期间 `src/runner/dot.ts`、`src/router/transport.ts`、`src/control-plane/*` 正在被并行修改，`dot.ts` 的行号已整体下移（例如 `while (!ctx.done)` 从 `:505` 漂到 `:627`）。
> 所以：**引用 `src/runner/dot.ts` 的行号请以 `fb575f4` 为准**（`git show fb575f4:src/runner/dot.ts | sed -n '242,249p'` 可验），其余文件的引用我已在收尾时对着工作区重新核对过一遍。
> 被并行修改影响的结论集中列在 §14。

### 0.2 OpenAI / Grok 列：每条标 `[公开资料]` 或 `[推断]`

- `[公开资料]` = 厂商已公开发布的产品/API 能力，属常识性公开事实。
- `[推断]` = 我根据产品行为反推的实现方式，厂商未公开细节。
- **本次无法核实**：2026-10-17 尝试访问 `openai.com`、`platform.openai.com`、`api.x.ai` 官方文档，均被拒绝（前两者返回 Cloudflare 403，后者 fetch failed）。因此本文件**不写任何具体版本号、日期、模型代数、定价数字**。查不到的写「未知」。

> **⚠️ 关于时间线的声明**：我的训练知识有明确截止点。这张表里 OpenAI / Grok 的条目代表的是"我确信存在的能力面"，**若厂商在此之后已更新，本表可能落后，请以官方文档为准**。我没有能力核实 2026 年当下的最新状态，也不会假装能核实。

---

## 1. 总览：一张表看差距

| 维度 | OpenAI | Grok (xAI) | dotd | 差距评级 |
|---|---|---|---|---|
| 工具面·数量 | 十余个内置托管工具 + 自定义 function calling | 自定义 function calling + 若干内置 | **11 个声明 / 9 个可用**，封闭词表 | **大** |
| 工具面·扩展 | MCP 连接器（远程） | 支持 MCP（未知细节） | **零**：无 MCP、无插件、加工具要改 3 处源码 | **致命** |
| 记忆·长期 | 跨会话记忆（产品级） | X 账号上下文（产品级） | 文件记忆 + 2800 token 注入上限 | **中** |
| 记忆·检索 | 托管检索（企业内部） | 未知 | **无 FTS、无向量**；LIKE 全表扫 + 逐文件读 | **大** |
| 多步执行·计划 | 有隐含计划/任务分解 | 有 | **无显式 plan**，纯 ReAct 循环 | 中 |
| 多步执行·观测回喂 | 完整 tool result 回喂 | 完整回喂 | **只回喂 200 字预览** | **致命** |
| 交互面 | Web/移动/桌面/语音/Email/IM | X 原生 + 语音 | Web + 飞书 + CLI；无语音/移动/邮件 | **大** |
| 安全·审批 | 高风险动作确认点 | 有限 | **五档 + 八态审批机 + 审计**（超出对标） | **反向领先** |
| 运行时·并发 | 多会话并行 | 多会话 | **maxRunningTasks=1**（单任务串行） | **致命** |
| 运行时·流式 | token 级流式 | token 级流式 | transport 层已实现，Runner 不消费；`chat.delta` 有总线无生产者 | **大** |
| 运行时·恢复 | 服务端托管 | 服务端托管 | **步骤级崩溃恢复 + 幂等 ledger**（超出对标） | **反向领先** |
| 可观测·成本 | 用量计费面板 | 订阅制 | **有 token 数，无任何成本口径** | 中 |
| 部署 | 零安装 SaaS | 零安装 SaaS | **Node24 + 生成配置 + WSL/Docker 5 步脚本** | **致命** |
| 生态·对外 API | 完整开放 API + AgentKit | API（未知细节） | 22 条内部 REST 路由，**非对话式 API** | **大** |

**评级口径**：`致命` = 真实用户第一天就会撞上、撞上就放弃；`大` = 能用但明显笨；`中` = 能用但不够好；`反向领先` = dotd 更强，不该盲目对标。

---

## 2. 工具面

### 2.1 数量与构成

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 内置工具 | 托管工具集（网页搜索、代码执行、检索等）+ 自定义 function calling，且新增托管工具的速度很快 `[公开资料]` | 自定义 function calling + 一部分内置（实时信息类）`[公开资料]`；内置清单细节 `未知` | **11 个**：`fs.read/fs.write/fs.list/fs.stat/shell.run/browser.open/browser.act/browser.snapshot/browser.close/net.get/net.post`（`src/exec/protocol.ts:96-193`，词表定义 `:196`） |
| 其中真正能用的 | 全部 | 全部 | **9 个**。`net.get` / `net.post` 在容器内直接返回 `not_implemented`（`agent-runtime/server.ts:609-612`） |
| 浏览器能力 | 有云端浏览器工具 `[公开资料]` | 有浏览能力 `[公开资料]` | Playwright + 持久化 profile（`agent-runtime/browser.ts:228-252`） |
| 代码执行 | 有沙箱代码解释器 `[公开资料]` | 有 `[推断]` | `shell.run`，30 分钟上限（`src/exec/protocol.ts:130-142`） |

**dotd 的真实可用工具集只有 9 个，且全部是"原始积木"**。没有：
`read_file` 之外的结构化编辑（无 diff/patch）、无 web 搜索工具（`net.get` 未实现，只能靠 `browser.open` 自己抓页面）、无 `todo`/计划工具、无 `task` 子 agent 工具、无 `ask_user` 反向提问工具。

### 2.2 扩展方式（这一项是最大差距）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| MCP | 支持远程 MCP 连接器 `[公开资料]`；AgentKit 有 connector registry `[公开资料]` | 支持，细节 `未知` | **零**。全仓库 `grep -i "mcp\|plugin"` 在 `src/` 下 0 命中（本次实测） |
| 加一个自定义工具要动几处 | 声明一个 schema 即可 | 声明 schema | **至少 3 处源码 + 1 份配置**：<br>① `src/exec/protocol.ts` `CAPABILITY_CATALOG`<br>② `agent-runtime/protocol.ts` `CAPABILITIES`（镜像内副本，必须逐字同形）<br>③ `agent-runtime/server.ts:591-616` 的 `execute()` switch<br>④ `config/tools.yml` 治理档位登记<br>另有测试 `tests/agent-runtime-protocol.test.ts` 做双向漂移断言 |
| 未登记工具的态度 | 报错 | 报错 | **一律 deny**（`src/exec/protocol.ts:258-264`） |

> **这是 dotd 最硬的架构性差距。** 11 个工具的封闭词表是"安全默认"的合理设计，但它同时把"生态"这个维度焊死了：用户永远无法在不 fork 内核的情况下接入自己的工具。OpenAI/Grok 的工具面是可扩张的，dotd 的工具面是常量。详见 §11「生态」。

### 2.3 参数 schema 质量

| | OpenAI | Grok | dotd |
|---|---|---|---|
| schema 机制 | JSON Schema `[公开资料]` | JSON Schema `[公开资料]` | JSON Schema 手写（`src/exec/protocol.ts:82-88` 的 `str()/obj()` 小工具） |
| 参数描述 | 厂商打磨过的自然语言描述 | 同 | **极简**。例：`fs.read` 的 `path` 描述是"绝对路径，必须位于 `/dot/home/` 下"（`src/exec/protocol.ts:101`） |
| 枚举约束 | 有 | 有 | **缺**。`browser.act.action` 的合法值是 `click\|type\|submit\|wait\|select\|scroll`，但 schema 里只是一个 `type: 'string'` + 描述文本（`:156`），**没有 `enum`**——模型完全可能输出非法值，只能等容器侧运行时报错 |
| 工具级描述 | 精心撰写 | 同 | **模板生成**：`工具 ${c.name}（mode=${c.mode}，sideEffect=${c.sideEffect}）`（`src/runner/dot.ts:629`）。这等于告诉模型 `工具 fs.read（mode=sync，sideEffect=safe）`——**对模型几乎没有指导价值，反而泄露了内部术语** |

**结论**：dotd 的 schema 是"够跑通"级别，不是"模型能猜对"级别。`mode/sideEffect` 这类内部概念出现在面向模型的描述里，是典型的"实现泄漏到 prompt"。

### 2.4 失败返回的可读性（致命）

这是我在读 Runner 时发现的最严重问题之一：

```ts
// src/runner/dot.ts:200-203
feed(res: { ok: boolean; callId: string; value: unknown }): void {
  if (res.ok) this.pendingResults.set(res.callId, JSON.stringify(res.value ?? null));
  else this.notes.push(`工具调用失败：${digestPreview(res.value)}`);
}
```

- 失败时，工具的错误对象先被 `JSON.stringify` 再被 `digestPreview` 截成 **200 字**（`src/runner/dot.ts:124`，`digestPreview(value, limit = 200)`）。
- 也就是说模型看到的错误是 `工具调用失败：{"code":"bad_args","message":"…"…` 这样一段被腰斩的 JSON 字符串前缀，**而且被塞进了一条 `role:'system'` 的注记**（`:294-305`），不是一个合法的 `role:'tool'` 消息。
- 对比 OpenAI / Grok：`[公开资料]` 的 function calling 协议里，工具失败会以结构化的 `role:tool` 消息回喂，模型能据此修正参数重试。dotd 的模型会看到一条文风突变的 system 提示，**很难可靠地形成"我刚哪个参数错了"的因果链**。

---

## 3. 记忆

### 3.1 短期会话记忆

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 载体 | 会话线程 | 会话线程 | `mem_threads` / `mem_messages` 表（`db/migrations/040_memory.sql:3,21`） |
| 重建入口 | 自动 | 自动 | `buildSessionReplay(threadId, taskId, budget)`（`src/memory/MemoryService.ts:380-391`） |
| 会话预算 | 上下文窗口级 | 上下文窗口级 | **4000 tokens**（`src/memory/limits.ts:59`），超了按"manuals 片段 → 消息条数 → summary"砍（`src/memory/inject.ts:13`） |
| 摘要压缩 | 自动，长会话无损感 | 自动 | **有接口无实现**：`updateContextSummary()` 定义在 `src/memory/MemoryService.ts:288-299`，但**全仓库没有任何调用方**（本次 grep 实测：只有 `src/memory/types.ts:281` 的接口声明和 `MemoryService.ts:288` 的定义本身）。`needsSummarize()`（`:1271`）同样无调用方 |

> **会话摘要从未生成过。** 结果是：dotd 的会话历史一旦超过 4000 token，就是**硬截断**——更早的内容直接消失，没有摘要兜底。`buildContextBundle` 里读的 `context_summary`（`:337-338`）永远是 `NULL`。这是一个静默失效：不报错、不告警，只是"越聊越忘"。

### 3.2 长期文件记忆

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 载体 | 产品级"记忆" | X 个人资料/历史 `[推断]` | `/dot/home` 文件卷（`exec-image/Dockerfile:35,42`）：`MEMORY.md` + `notes/` + `manuals/` |
| 注入预算 | 自动 | 自动 | 文件记忆 ≤ **2500 tokens**（`src/memory/limits.ts:57`），其中 `MEMORY.md` 硬上限 **4 KB**（`:31`），`manuals` 取 top-2、每篇截 **1024 字符**（`:61-62`） |
| 注入时机 | 每轮相关 | 每轮 | **每个任务只注入一次**，整个任务生命周期内复用同一份快照（`src/runner/dot.ts:444-449`、`:598-622` 的 `cachedBundle`） |
| 写入策略 | 自动抽取 | `[推断]` 自动 | **WRITE-SEAL**：任务结束若没写过记忆文件，往 thread 里追加一句「若本次有可复用经验，现在写 notes/ 或更新 manuals/，否则回复 SKIP」（`src/memory/seal.ts:37-38,91-100`）。**但这只是往会话里追加一条消息，不会触发新一轮模型调用**——见 §6 偏差 ② |

**dotd 的记忆设计在"价值观"上是领先的**（文件即记忆、可 git 管理、可人工编辑、无 vendor lock-in），但在"工程完成度"上是落后的（没检索、没摘要、注入量小得可怜、注入时机僵死）。

### 3.3 检索（FTS / 向量）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 向量检索 | 有托管向量库 + 文件检索工具 `[公开资料]` | 未知 | **无** |
| 全文检索 | 托管 `[公开资料]` | 未知 | **无 FTS5**。代码注释自己写着：「无向量库、无 FTS5——§6.4 默认不启用」（`src/memory/MemoryService.ts:508`） |
| 现有检索手段 | — | — | 两条，都很粗：<br>① 文件：`searchHome()` 遍历全部 `mem_files_index`，**逐文件读全文**再 `indexOf` 子串匹配（`src/memory/MemoryService.ts:502-525`）<br>② 消息：`searchMessages()` 用 `content LIKE '%q%'`（`:603-635`）<br>**两者都没有进模型工具面**——「维护用检索，不进模型工具面（避免双轨检索）」（`:507`） |

> **模型没有检索能力。** 这是最重要的一条：agent 干活时无法"查一下我以前记过什么"，只能靠每次任务开头注入的那 2500 token。记忆越多，被注入命中的概率越低——**记忆量和可召回率成反比**，这是一个会随使用时间恶化的设计缺陷。

**可修复性**：我已实测本机 Node v24.13.0 内置 SQLite 版本 **3.50.4**，FTS5 与 `bm25()` 排序均可用（建虚表 + 插入 + MATCH 查询实测通过）。所以"给 dotd 加全文检索"**不需要任何新依赖**，纯 SQL 迁移即可。这一点直接支撑了路线图 P1 的 #1 项。

### 3.4 记忆写入策略

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 触发 | 自动判断 | 自动 | 任务终态钩子（`Queue.finish` 内部调 `sealTask`，`src/daemon.ts:547-550`） |
| 权限 | 无用户感知 | 无 | 写前过限额检查 `beforeWrite()`（`src/memory/MemoryService.ts:429-436`）：违规直接拒（`HARD_LIMIT`），逼近软限给 warning 但放行（`src/runner/dot.ts:698-716`） |
| 去重/冲突 | 自动 | `未知` | **无**。同一事实可以写进好几个 note，没有任何冲突检测 |
| 老化 | 自动衰减 | `未知` | 有保留策略 `runRetention` + `compactionTriggers`（`src/memory/retention.ts:445-470`），但**触发器无调用方**（`daemon.ts` 中零命中，见 §6 偏差 ③） |

---

## 4. 多步执行

### 4.1 计划（plan）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 显式计划 | 任务分解 + 执行轨迹 `[公开资料]` | 有 `[推断]` | **无**。主循环是纯 ReAct：`while (!ctx.done) { stepLlm(); for (call of toolCalls) stepTool(); }`（`src/runner/dot.ts:506-525`） |
| 计划持久化 | 托管 | 托管 | **无**。计划不落库、不注入、不更新 |

dotd 的"计划"完全在模型的单次响应里，而**每次 LLM 请求都会重建 messages**（`buildMessages`，`src/runner/dot.ts:257-317`），且只带最近一段。模型没有任何地方可以写下"我的计划是 1/2/3"，于是：

- 长任务里模型会在第 15 步忘记第 2 步的目标；
- 崩溃恢复后（`resumeFromSeq`），模型只能从 journal 的 tool_result 摘要 + 最后一轮对话重建上下文，**计划彻底丢失**。

### 4.2 中间观测回喂（致命）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 工具结果回喂 | **全文**回喂 | **全文**回喂 | **只回喂 200 字**（`src/runner/dot.ts:242-249` → `drainResults()` 对每条 pending result 调 `digestPreview(json)`，默认 `limit=200`，`:124`） |

```ts
// src/runner/dot.ts:242-249
drainResults(): Array<{ callId: string; text: string }> {
  for (const [callId, json] of this.pendingResults) {
    out.push({ callId, text: digestPreview(json) });   // ← 200 字上限
  }
```

**这是我认为 dotd 最致命的一个设计缺陷。** 后果链：

1. `fs.read` 一个 5 KB 的文件 → 模型只看到前 200 字；
2. `browser.snapshot()` 返回的页面快照（`agent-runtime/server.ts:669-670`，快照本身就是整页文本）→ 模型只看到前 200 字；
3. `shell.run` 的输出 → 前 200 字；
4. 模型据此决定下一步 → **它在盲操作**。

代码注释说这是"双写禁令（S6）：tool 参数/结果全文只在 steps；这里只放 digest+预览"（`src/runner/dot.ts:253-256`）。这是把**存储层**的去重原则错误地施加到了**模型上下文层**。存储层只存预览是对的（省空间），但发给模型的那一份必须是全文——全文本来就在 `steps.result_json` 里，Runner 在 `runTask` 里甚至已经知道怎么按 `callId` 取全文（`src/runner/dot.ts:461-464`），只是取完又用 `feedToolResult` 存进 `pendingResults` 后又走了一次 `digestPreview`。

> 所以这不是"设计取舍"，而是**同一份全文在代码里已经拿得到、却在最后一米被截断**。修复成本极低（路线图 P0-1）。

### 4.3 自我纠错

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 失败重试 | 模型自行修正 | 同 | 模型看到 truncation 后的错误（§2.4），纠错质量受影响 |
| 步数上限 | 有 | 有 | 软限 **500**、硬限 **2000** 步（`src/control-plane/types.ts:194-195`）。硬限越线抛 `StepLimitError` → 任务 `failed`，不重试（`src/runner/dot.ts:411-422`）——设计合理 |
| 工具失败策略 | 模型决定 | 模型决定 | 治理 deny → 步标 `skipped` + 结果回喂，任务改道不失败（`src/runner/dot.ts:676-681`）——设计合理 |

### 4.4 长任务不跑偏

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 目标漂移防护 | 隐含 | 隐含 | **没有显式机制**。`goalDigest` 只在治理 precheck 时截 800B 用（`src/runner/dot.ts:148-160`），不用于主循环对齐 |
| 看门狗 | 托管 | 托管 | 心跳超时 **180s**（`src/control-plane/types.ts:189`）。但 heartbeat 只在每步之后写（`src/runner/dot.ts:839-851`），单步若是 30 分钟的 `shell.run`（`src/exec/protocol.ts:133`）→ **在途期间心跳静止 → 必然误回收**。README 已记为 high 级已知限制（`README.md:355`） |

---

## 5. 交互面

| 通道 | OpenAI | Grok | dotd |
|---|---|---|---|
| Web | ✔ 主力 `[公开资料]` | ✔ `[公开资料]` | ✔ 六个视图（Chat/Queue/Approvals/Events/Models/Logs），静态托管 `src/surfaces/web.ts:95` |
| 桌面客户端 | ✔ `[公开资料]` | ✔（X 站内） `[公开资料]` | ✘ |
| 移动端 | ✔ `[公开资料]` | ✔（X App 内） `[公开资料]` | ✘（无响应式保证，未验证） |
| 语音 | ✔ 实时语音 `[公开资料]` | ✔ 语音模式 `[公开资料]` | ✘（README 明确"语音最后做"，`README.md:404`） |
| IM | 未作为主通道 `[推断]` | X 原生私信/提及 `[公开资料]` | ✔ 飞书 WS 长连接（`src/surfaces/feishu-ws.ts`）+ 出站纯文本（`src/surfaces/feishu-outbound.ts:79-107`） |
| 邮件 | ✔ `[公开资料]` | `未知` | ✘（设计在阶段二，`README.md:391`） |
| CLI | ✘ | ✘ | ✔ **14 个子命令**（`src/surfaces/cli.ts:197-458`） |
| HTTP webhook 入站 | ✔ | ✔ | ✔ `POST /hooks/:source`，当前只登记 `grafana` 一个源（`config/dotd.yml:56-60`） |
| 心跳/定时 | ✔ 定时任务 `[公开资料]` | `未知` | ✔ crontabs 表 + `quiet_hours` + `skip_if_busy` + `catchup=latest`（`src/control-plane/scheduler.ts:234-260`） |

**dotd 的交互面特点是"深度 > 广度"**：飞书/CLI/心跳这三条做得比商业产品更深（因为是自己用的），但缺语音、移动、邮件、桌面。按"个人自托管"的定位，**广度的缺失不是致命伤，深度才是**——而飞书出站的短板很明显（只发纯文本、不推审批卡片、心跳触发的结果不回推，见 `src/surfaces/feishu-outbound.ts:79-107` 只订阅 `task.state` 的 done/failed）。

---

## 6. 安全与审批（dotd 反向领先）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 权限分级 | 粗粒度用户确认 `[公开资料]` | 有限 `[推断]` | **五档**：read / write_file / browser / spend / dangerous（`config/tools.yml:18-22`） |
| 默认策略 | 逐动作确认 | — | read/write_file→allow；browser→review（小模型前审）；spend→一律人工；dangerous→人工 + Web 勾选（`config/tools.yml:18-22`） |
| 提档规则 | — | — | 子串命中提档：`shell.run` 命中 `rm ` / `sudo ` / `docker ` / `> /dev/` → dangerous（`config/tools.yml:38-40`） |
| 审批状态机 | — | — | **八态**（`src/governance/status.ts`），双通道先到先得用一条 `BEGIN IMMEDIATE` SQL 实现（`src/governance/gate.ts:10-14`） |
| 审批 TTL | — | — | **24 小时**，可 `DOTD_APPROVAL_TTL_H` 覆盖（`src/governance/config.ts:44-45`） |
| 审计 | 有 | `未知` | `audit_log` 只追加表（`db/migrations/020_governance.sql:85`）+ `audit_archive` 归档（`:97`）+ 入站拒绝审计 `surf_ingress_rejects`（`src/surfaces/ingress.ts:41-51`） |
| 沙箱 | 云端隔离 `[推断]` | 云端 `[推断]` | **Docker 多层**：`ReadonlyRootfs`、`CapDrop:ALL` + 仅 `SETUID/SETGID`、`no-new-privileges`、`PidsLimit 512`、内存+swap 锁死 1536MB（`src/exec/protocol.ts:492-509`）；出站 netguard iptables（`src/exec/netguard.ts:5-18`） |
| 凭据隔离 | — | — | 容器 token 只读 bind，不进 env（`src/exec/protocol.ts:511-519`） |
| 执行身份隔离 | — | — | runtime(uid 1000) spawn shell(uid 1001)（`exec-image/Dockerfile:31-37`） |

**这一列 dotd 完胜，而且胜得不小。** OpenAI/Grok 作为商业 SaaS，"沙箱 + 审批 + 审计"是他们必须向监管和用户证明的东西，dotd 则把它写进了代码结构里。

> 但有一个**没被验证**的风险：netguard 的真实 iptables 路径在 stub 下完全不执行（`src/exec/netguard.ts:21-23` 自述「本模块在 stub 模式下完全不执行子进程」），`setuid` 秘密隔离「未实测」（`README.md:354`）。**安全设计领先，但安全性本身尚未被证明。**

### 6.1 一个具体的审批体验缺陷

审批有 24h TTL 是合理的，但**没有任何主动推送**：
- 飞书出站只订阅 `task.state` 的 `done`/`failed`（`src/surfaces/feishu-outbound.ts:79-107`），**不订阅 `approval:created`**；
- 也就是说任务卡在审批时，飞书那头**完全静默**，必须主动打开 Web 或跑 `dotd approvals`。

对"常驻 daemon、人不在旁边"这个定位来说，这是一个会让人以为"它死了"的体验断点。

---

## 7. 运行时

### 7.1 并发（致命）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 多会话并行 | ✔ 多线程/多任务 `[公开资料]` | ✔ `[公开资料]` | **`maxRunningTasks: 1`**（`src/control-plane/types.ts:187`），pop 时 `runningCount(dot) >= maxRunningTasks → return null`（`src/control-plane/queue.ts:247`） |
| 多 agent | AgentKit 多 agent 编排 `[公开资料]` | `未知` | ✘ 阶段三才做多 Dot（`README.md:400-403`） |
| 效果 | 可以边问边跑别的 | 同 | **一个 30 分钟的 `shell.run` 会把所有交互任务堵在后面**。`dotd ask` 进去后你会看到它排队，而你和 ChatGPT 说话从来不会排队 |

> 单 dot1 + 单任务串行，在"演示"场景完全够用；一旦你真的把它当常驻助理用，"我在问它话，它正在跑昨天的爬虫"就会立刻变成阻塞。这是 P1 的必做项。

### 7.2 流式

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 模型侧流式 | ✔ `[公开资料]` | ✔ `[公开资料]` | **两层都有实现**：transport `stream()` 走 `/chat/completions` + `stream:true` + SSE 解析（`src/router/transport.ts:626-630`）；router 也暴露了 `stream(req)` 带候选降级（`src/router/ModelRouter.ts:605-701`），并已接进 Runner 的端口面 `stream: (req) => router.stream(req)`（`src/daemon.ts:368`） |
| 主循环是否用流式 | ✔ | ✔ | **不用**。Runner 只调 `router.complete(req)`（`src/runner/dot.ts:556`），一次性拿完整响应。**注意：链路上唯一缺的是"Runner 消费"这一环两端都已就绪**（`daemon.ts:368` 已把 `stream` 递给 Runner 的依赖面，只是 `dot.ts` 里没有调用） |
| 前端流式 | ✔ | ✔ | **前端已就绪，但永不触发**：Web 端订阅 `chat.delta` 并做增量拼装（`web-ui/src/views/ChatView.tsx:54-95`），SSE 总线也定义了 `chat.delta`（`src/shared/bus.ts:78`），但**全仓库没有任何代码 `publish('chat.delta')`**（本次 grep 实测：`sse.ts:181` 只做消费判断，`http.ts:946` 只做下发优化注释） |

> 这是典型的"三件套缺一根线"：**SSE 通道有、前端渲染有、transport 流式有，唯一缺的是 Runner 里把流式 chunk 转发到总线的那几行**。所以现在你在 Web UI 里看到的是"发出去 → 转圈 → 整段答案突然出现"。

### 7.3 中断与恢复

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 用户中断 | ✔ 停止生成 | ✔ | **`cp.cancel(id,'user')`**（`src/surfaces/http.ts:552`）→ 状态终态；但对**在跑的工具调用**只做 `cancelled` 标记，`ExecService.pollJob` 每轮检查 `this.cancelled.has(call_id)` 才真正 remote cancel（`src/exec/ExecService.ts:378-387`）——**轮询间隔内不可中断** |
| 协作式取消 | — | — | `POST /jobs/{job_id}/cancel`（`agent-runtime/server.ts` 头注端点表） |
| 审批中断续跑 | — | — | ✔ 干净：`resume_from_seq` → `resumeStep(同 callId)` → `claim()` 固化参数（`src/runner/dot.ts:740-780`） |

### 7.4 崩溃恢复（dotd 反向领先）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 服务端崩溃恢复 | 托管，用户不可见 `[推断]` | 同 | **步骤级 + 幂等三重**：<br>① `beginTool` 先落 `started`（`synchronous=FULL`），`endTool` 才落 `succeeded`<br>② 容器内 ledger 按 `call_id` 幂等：`done`→重放、`doing`→返回 running、`aborted`→`interrupted`（`agent-runtime/server.ts:20-27`）<br>③ 重启时对 `running` 任务逐 `started` 步 `reconcileAndResolve` 三分流（`src/control-plane/recovery.ts:92-107`） |
| 幂等语义 | 未知 | 未知 | 「已落盘的结果绝不重放，未知副作用绝不自动重执行」——`unknown` 类工具崩溃后**宁可报错也不重跑**（`src/control-plane/recovery.ts:22-24` 的矩阵表） |

**这一项 dotd 的设计水平高于绝大多数自研 agent**。商业产品的崩溃恢复用户看不见，所以无法对比"谁的更强"；但从可审计性看，dotd 每一代的 `run_epoch` 围栏、每一步的 `side_effect` 分类、每个 `call_id` 的 ledger 记录，都是可查的。

---

## 8. 可观测性

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 结构化日志 | 有 | 有 | **只到 stdout**：`process.stdout.write('[dotd] …')`（`src/daemon.ts:410`），全仓库 `console.log/info/warn/error` **零使用**（实测），无日志级别、无 JSON 结构化、无轮转 |
| Trace | 有请求级追踪 `[公开资料]` | `未知` | **无 trace_id / span**（全仓库零命中）。可用的关联键是 `task_id` / `call_id` / `attempt_id` / `run_epoch`——**可以拿这些当现成的 trace 轴，只是没有把它呈现出来** |
| 每步执行轨迹 | ✔ | ✔ | ✔ `steps` 表是一等公民（`db/migrations/000_control_plane.sql:75-95`：llm/tool 两类、六种状态、`side_effect`、`approval_id`） |
| 模型调用记账 | ✔ | ✔ | ✔ `model_call_log`：endpoint / model / track / outcome / latency / prompt_tokens / completion_tokens / cached_prompt_tokens（`db/migrations/010_model_router.sql:74-84`，入表点 `src/router/ModelRouter.ts:1003-1038`） |
| 成本统计 | ✔ 用量+计费 | 订阅制 | **完全没有**。`model_call_log` 只有 token 数，没有单价、没有货币、没有聚合视图；`GET /api/models/rank` 给的是路由排序不是花费（`src/surfaces/http.ts:695`） |
| 实时事件流 | — | — | ✔ SSE 总览，27 个 topic（`src/shared/bus.ts:46-82`） |
| 外部可观测性对接 | — | — | ✘（无 OTel / Prometheus；有出一个到 Grafana 的 webhook **入站**，但没有出站指标） |

**一句话**：dotd 的数据面已经足够好了（每一步、每次调用都落了库），缺的是**把它读出来的那一层**——一个 `GET /api/usage` 和 `dotd cost` 就够拉开差距。

---

## 9. 部署与分发（致命）

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 安装 | 打开网页 | 登录 X | **见下方清单** |
| 零配置程度 | 完全零配置 | 完全零配置 | **需要手写 `~/.dotd/config.yml`，不写就拒启动**（`src/surfaces/config.ts:359,363`） |
| 更新 | 自动 | 自动 | `git pull` + 可能改 `expectedVersion`（`src/daemon.ts:413`） |
| 真实门槛 | 0 步 | 0 步 | **12 步，其中 3 步有已知陷阱** |

### 9.1 dotd 的真实安装路径（逐条核实）

1. 装 **Node ≥ 24**（`package.json:7-9`；README 说硬要求三个原因，`README.md:107-109`）。
2. `npm install`。
3. `npm run init-config` 生成 `~/.dotd/tokens.env` + `~/.dotd/config.yml`（`package.json:13`）。
4. `source ~/.dotd/tokens.env`。
5. **手写模型 API key**：`.env.example` 明文写着「dotd 的代码**不读取 .env 文件**」（`.env.example:4-7`），必须 `export` 进启动 daemon 的那个 shell。
6. 起 daemon。注意两个 stub 开关的缺省值**不一致**：`DOTD_MODEL_TRANSPORT` 未设 = 真打网络；`DOTD_FLEET` 未设 = **仍走 stub**，且拼错（`Docker`/`DOCKER`）会静默回落 stub（`src/exec/types.ts:189`、`README.md:236`）。
7. 想用真容器 → `daemon 必须在 WSL 里`（`src/exec/types.ts:154` 硬编码 `/var/run/docker.sock`；`src/daemon.ts:587-589` 注释原文）。
8. WSL 里 `bash scripts/wsl-pull-image.sh`（拉 ~2GB Playwright 镜像）。
9. `bash scripts/wsl-install-node24.sh`。
10. `bash scripts/wsl-fleet-prep.sh`（rsync + npm install）。
11. `npx tsx scripts/wsl-build-image.mts` 构建镜像。
12. WSL 里够不着 Windows 的 loopback 模型服务 → 还要补 `scripts/win-relay.mts` 的转发规则（README 明确指出现役 tier1 端口 `:7863` **没有**被转发，`README.md:288`）。

**三个已知陷阱**（都会让人以为"项目坏了"）：
- `config/dotd.yml` 是**同名陷阱**：仓库里这个文件没有任何代码加载，真正被读的是 `~/.dotd/config.yml`（`README.md:173,362`）。
- `.env.example` 与 `setup-dev-env.sh` 会**互相覆盖**，照做会把真 token 冲成占位符（`README.md:351`）。
- 中文路径下 CLI 入口守卫曾经恒假，导致所有 `dotd xxx` 都是空操作（**已修**，`README.md:348`）——但这类"路径假设"的脆弱性本身是分发的敌人。

> **判断**：一个愿意折腾的人能在 1-2 小时里跑通 stub 模式；**要跑通真实容器 + 真实模型，我判断多数人在第 7-12 步会放弃**。这直接决定了 P0 的范围。

### 9.2 一个更底层的问题：真实链路从未被验证

`README.md:99` 原文：**「门禁全绿是在 stub 模型 + stub fleet 下取得的，对真实模型和真实容器零证明力。第一次真跑时会撞到什么，没有人知道。」**
`README.md:345` 把「真实链路一次都没验证过」列为高优先级已知限制。

结合 §5 的发现——`puppeteer-extra-plugin-stealth` 在 `agent-runtime/package.json:15-17` 里被声明为 **optionalDependencies**，但 `agent-runtime/server.ts:182-208` 的 `requireBrowserFactory()` **只动态 import 了 `playwright`，从未加载 `playwright-extra` 或 stealth 插件**，`stealth` 实际取到的是 `noopStealth`（`agent-runtime/browser.ts:100-103`，`:174` 的 `?? noopStealth`）——
**「stealth 反检测」在当前代码里是不存在的，而 README 把它当作已有能力在描述。** 这是最需要被证伪的一条，我把它给了路线图 P0-4。

---

## 10. 生态

| | OpenAI | Grok | dotd |
|---|---|---|---|
| 插件市场 | ✔ AgentKit / GPTs / connectors `[公开资料]` | `未知` | **无，且架构上不支持**（见 §2.2） |
| MCP | ✔ `[公开资料]` | 支持 `[公开资料]` | ✘ |
| 对外 API | ✔ 完整 REST/Responses API `[公开资料]` | ✔ `[公开资料]` | **22 条内部 REST 路由**（`src/surfaces/http.ts:105-126`，清单 `:492-496`），是**控制面 API 不是对话 API**：没有"给个 goal 拿到多轮执行过程与工具调用"的对话式端点 |
| SDK | ✔ 多语言 `[公开资料]` | `未知` | ✘（`dotd` CLI 是唯一客户端，`package.json:10-11`） |
| 可嵌入 | ✔ | ✔ | ✘ |
| 许可 | 闭源 | 闭源 | **Apache-2.0**（`LICENSE`）——这是 dotd 唯一在生态维度上结构性领先的东西 |

**dotd 的生态策略是"不建生态"**。这不完全是坏事（见路线图 P3），但当前状态是"既没对外 API，也没 MCP，也没工具扩展点"——**连自用扩展都做不了**，这才是问题。

---

## 11. 我认为最大的三个差距

> 判据：不是"能力清单数量差"，而是"**一个真实用户第一次用它干真活，会在哪里卡住**"。

### 差距 ①：工具结果只回喂 200 字——agent 在盲操作
`src/runner/dot.ts:242-249`。模型看不到自己刚读到的文件、刚抓到的网页、刚跑出的命令输出。这不是功能缺失，是**信息通道被自己截断**。它让其他所有工具（即便是那 9 个可用的）的效用折损到接近零。修复成本：一个函数改动 + 上下文预算保护。

### 差距 ②：工具面封闭 + 无 MCP——用户永远接不进自己的东西
`src/exec/protocol.ts:96-193` 的 11 名封闭词表 + 三处源码同形 + 一处 YAML 登记。对比之下 OpenAI/Grok 的工具面是可扩张的。dotd 当前的扩展成本相当于"fork 内核"，这在一个标榜自托管的项目里是自相矛盾的——**自托管的价值恰恰在于"接得上我自己的东西"**。

### 差距 ③：单任务串行 + 安装 12 步——它不像一个能常驻的工具
`src/control-plane/types.ts:187` 的 `maxRunningTasks:1` 让它一忙就堵；§9.1 的 12 步安装让它进不来门。两者叠加的后果是：**它更像一个"跑测试用的框架"，而不是一个"能装在自己机器上天天用的助理"**。

> 如果要我把这三条压成一句：**OpenAI/Grok 的 agent 是"能看见、能接上、随时可用"，dotd 现在是"看不见（200 字）、接不上（封闭词表）、排不上（串行 + 装不起来）"。**

---

## 12. 文档与代码的偏差（本次阅读的额外产出）

这四条都不是"文档写错了"，而是**文档描述的是设计意图，代码停在了实现的上一站**。路线图的优先级直接由它们决定。

| # | 文档口径 | 代码实况 | 证据 |
|---|---|---|---|
| ① | 「`updateContextSummary` 维护会话摘要」 | **从未被调用**。会话摘要恒为 NULL，长会话硬截断 | 定义 `src/memory/MemoryService.ts:288-299`；调用方 grep 零命中（仅 `types.ts:281` 接口声明） |
| ② | 「WRITE-SEAL：任务结束若未写记忆，Runner 会被提醒补写一轮」 | **只是往 thread 追加一条 system 消息，不会触发新的一轮 LLM 调用**——任务此刻已经 finish 了 | `src/memory/seal.ts:91-100`；`sealTask` 在 `Queue.finish` 内部调用（`src/daemon.ts:547-550`），此时 Runner 已退出该任务的循环 |
| ③ | 「memory-compaction / memory-retention 挂在 scheduler」 | `compactionTriggers()` 有实现（`src/memory/retention.ts:445-470`），但**没有任何 `registerInternalJob` 注册它**；CP 只注册了 `queue.gc` 与 `heartbeat.tick`（`src/control-plane/index.ts:168-193`） | `daemon.ts` 中 `compactionTriggers\|runRetention` 零命中 |
| ④ | 「stealth 注入，反检测」 | `requireBrowserFactory()` 只 import `playwright`；`playwright-extra` / `puppeteer-extra-plugin-stealth` 声明为 optionalDependencies 但**从未被加载**，实际生效的是 `noopStealth` | `agent-runtime/server.ts:182-208`；`agent-runtime/browser.ts:100-103,174`；`agent-runtime/package.json:15-17` |

另有两条已知但值得在对标语境下强调：
- **`chat.delta` 无生产者，但缺口比看上去小得多**：前端已订阅并做增量拼装（`web-ui/src/views/ChatView.tsx:54-95`），SSE 总线已定义 `chat.delta`（`src/shared/bus.ts:78`），transport 与 router 两层流式都实现了（`src/router/transport.ts:626-630`、`src/router/ModelRouter.ts:605-701`），**而且 `daemon.ts:368` 已经把 `stream()` 递进了 Runner 的端口面**。唯一缺的是 `src/runner/dot.ts` 里把 chunk 转发到总线的那几行。这是全仓库投入产出比最高的一个补丁。
- **`net.get`/`net.post` 未实现**：目录里有、路由里有、容器里直接 `not_implemented`（`agent-runtime/server.ts:609-612`）。所以 agent **没有 web 搜索能力**，也没有便捷的 HTTP 抓取能力，只有完整浏览器这一条重路径。
- **FTS5 可零依赖落地**（实测）：本机 Node v24.13.0 内置 SQLite 版本 **3.50.4**，`CREATE VIRTUAL TABLE … USING fts5` 与 `bm25()` 排序实测通过。给 dotd 加全文检索不需要任何新依赖，只需一个迁移包 + 一个检索函数 + 一个工具入口。

---

## 13. 对标参照总表（一览）

| # | 维度 | OpenAI | Grok | dotd | 评级 |
|---|---|---|---|---|---|
| 1 | 工具数量 | 十余个托管 + 自定义 | 自定义 + 部分内置 | 11 声明 / 9 可用 / `net.*` 未实现 | 大 |
| 2 | 工具扩展 | MCP + connectors | MCP | 零（改 4 处源码） | **致命** |
| 3 | schema 质量 | 打磨过 | 打磨过 | 无 enum、描述为内部术语模板 | 大 |
| 4 | 失败可读性 | 结构化 tool 消息 | 同 | 200 字 JSON 前缀塞进 system 注记 | 大 |
| 5 | 短期记忆 | 自动摘要 | 自动摘要 | 重建入口有、摘要**无实现** | 大 |
| 6 | 长期记忆 | 产品级 | 产品级 | 文件卷 + 4 KB MEMORY.md + 2800 token 注入 | 中（价值观领先） |
| 7 | 检索 | 向量 + 全文 | 未知 | **无 FTS、无向量**、检索不进工具面 | 大 |
| 8 | 记忆写入 | 自动 | 自动 | 限额检查 + WRITE-SEAL（但提醒轮不落地） | 中 |
| 9 | plan | 有 | 有 | 无显式 plan | 中 |
| 10 | 观测回喂 | 全文 | 全文 | **200 字预览** | **致命** |
| 11 | 自我纠错 | 有 | 有 | 机制有，但被 §10 拖累 | 中 |
| 12 | 长任务不跑偏 | — | — | 无 goal 锚定 + 180s 看门狗误回收 | 大 |
| 13 | Web/IM/CLI | ✔/—/✘ | ✔/✔/✘ | ✔/飞书/✔ | 中（深度够、广度缺） |
| 14 | 语音/移动/邮件 | ✔✔✔ | ✔✔/未知 | ✘✘✘ | 大 |
| 15 | 权限分级 | 粗 | 有限 | **五档 + 八态审批 + 审计** | **反向领先** |
| 16 | 沙箱 | 云端 | 云端 | Docker 多层收紧（未实测） | 反向领先（未证实） |
| 17 | 并发 | 多会话 | 多会话 | **maxRunningTasks=1** | **致命** |
| 18 | 流式 | ✔ | ✔ | transport 有，Runner 不用，前端干等 | 大 |
| 19 | 崩溃恢复 | 托管 | 托管 | **步骤级 + ledger 幂等** | **反向领先** |
| 20 | 中断 | ✔ | ✔ | 取消有，在跑工具需等轮询周期 | 中 |
| 21 | 日志 | 结构化 | 有 | stdout 文本，无级别无轮转 | 大 |
| 22 | trace | ✔ | 未知 | 无 trace_id（但 task/call/epoch 可当轴） | 中 |
| 23 | 成本 | ✔ | 订阅制 | token 有、**钱没有** | 中 |
| 24 | 安装 | 0 步 | 0 步 | 12 步 / 3 个陷阱 / 真实链路未验证 | **致命** |
| 25 | 生态/API | ✔✔ | ✔/未知 | 内部 REST、无对话 API、无 SDK | 大 |

**统计**：25 项里 dotd **反向领先 3 项**（15/16/19，全是安全与可靠性）、**持平或接近 5 项**、**明显落后 12 项**、**致命 5 项**（2/10/17/24 + 12 的边缘）。

> 值得注意的是：**dotd 领先的 3 项全部集中在"可靠性与安全"，落后的全部集中在"能被模型高效使用"**。这很像一个工程很扎实但还没被真实使用打磨过的系统——它的骨架比 OpenAI 硬，但它的"体感"还停在开发者自测阶段。

---

## 14. 并行进行中的修复（本表结论的时效性说明）

写这份矩阵期间，仓库 `fb575f4` 之上已经有**未提交的改动**正在进行。下表说明哪些矩阵结论**即将/已经过时**，以免读者拿着过期结论去重复劳动。

| 矩阵条目 | 进行中的改动 | 对结论的影响 |
|---|---|---|
| §2.4 失败可读性、§4.2 观测回喂（200 字） | `src/runner/dot.ts` 未提交改动：`drainResults()`（现 `:289`）改为**全文回喂**；`feed()`（现 `:222-247`）让失败也走 JSON 结构化回喂，并按 OpenAI 兼容协议补回 `assistant.tool_calls` 声明（裸 `role:tool` 会被网关拒） | **这两项的"致命"评级即将解除**。本矩阵的描述对 `fb575f4` 成立，对改动后的代码不成立 |
| §2.3 schema/描述质量 | 新增 `src/runner/tool-catalog.ts` + `src/runner/system-prompt.ts`，`toolSpecs()`（现 `:733-736`）改为 `buildToolSpecs(caps)`，描述按"何时用/参数怎么填/返回什么/失败怎么读"撰写，且**参数行与真实 schema 求交**（防编造）；`buildMessages`（现 `:321`）把 system prompt 放进 `messages[0]` | **§2.3 的"模板描述 / 无 enum"结论即将过时**。注意：`CAPABILITY_CATALOG` 的 JSON Schema 本身（如 `browser.act.action` 仍无 `enum`）未变，改善在 description 层不在 schema 层 |
| §7.2 流式 | **仍无进展**：`drainResults` 与 prompt 改了，但 `stepLlm()` 仍只调 `router.complete()` | 结论仍成立 |
| §7.1 并发 | **未变**：`maxRunningTasks: 1`（`src/control-plane/types.ts:187`）、`queue.ts:247` | 结论仍成立 |
| §4.4 看门狗 | **未变**：`heartbeatTimeoutMs: 180_000`（`src/control-plane/types.ts:189`） | 结论仍成立 |
| §7.2 附带的 HTTP 超时 bug | `src/router/transport.ts` 修了一处真实缺陷：原来超时只 `res.destroy()`，请求 socket 仍挂着，三档超时形同虚设；现补 `req.destroy(err)` | 与本矩阵无冲突，但说明**"真实 HTTP 路径"确实存在未验证的缺陷**，佐证 §9.2 的判断 |

**因此**：本矩阵应被当作**"基线差距快照"**读取，而不是当前代码的实时描述。`roadmap-to-parity.md` 里各 P0 项已按"是否已在做"标注。重新核实的方法：`git diff --stat`，再对本表里每条引用的 `path:line` 重跑一次 grep。

---

## 附：本次未能核实的事项（诚实清单）

1. **OpenAI / Grok 的当前版本、模型代际、定价、具体工具清单** —— 官方文档在 2026-10-17 全部不可访问（403 / fetch failed），且我的知识有截止点。本表所有 OpenAI/Grok 条目均按"能力面"描述，不写版本号。
2. **Grok 的工具面细节**（内置工具清单、MCP 实现方式、记忆机制）—— 未找到可访问的一手资料，多处标 `未知`。
3. **OpenAI/Grok 的崩溃恢复实现**——厂商不公开，只能标 `[推断]`。
4. **dotd 真实容器路径的每一项行为**——netguard iptables 实装、setuid 秘密隔离、真实 chromium 启动、真实模型 tool_calls 解析，全部**只有 stub 证据**。本文对 dotd 的描述是"代码写了什么"，不是"代码证明了什么"。
