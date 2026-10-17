# dotd 通往「对标水准」的分阶段路线图

> 配套文档：[`benchmark-agent-capabilities.md`](./benchmark-agent-capabilities.md)（对标矩阵与证据）。
> 基线：commit `fb575f4`，2026-10-17。**注意：撰写期间仓库已有并行未提交改动**（见 `benchmark-agent-capabilities.md` §14 与本文 §0.1）。
> 目标不是"变成 OpenAI"，而是：**让 dotd 成为一个真的能天天用的自托管个人 Agent**——保留它已经领先的安全与可靠性，把"模型用不动它"这一侧补齐。

---

## 0. 怎么读这份路线图

### 0.1 先看这一条：哪些 P0 已经在被别人做了

写这份路线图时（2026-10-17），`fb575f4` 之上已有未提交改动。下表是**开工前必须核对的"已被认领"清单**——否则会做重复劳动：

| 本路线图条目 | 状态（以 `git diff` 为准） | 核对命令 |
|---|---|---|
| **P0-1 全文回喂** | **已在做**：`src/runner/dot.ts` 的 `drainResults()` 已改为全文回喂、失败走结构化 JSON、并按 OpenAI 兼容协议补 `assistant.tool_calls` 声明 | `git diff src/runner/dot.ts` 搜 `drainResults` |
| §2.3 工具描述质量（非本路线图条目） | **已在做**：新增 `src/runner/tool-catalog.ts` + `system-prompt.ts` | `ls src/runner/tool-catalog.ts` |
| 真实模型链路取证（P0 完成判据第 3 条的前置） | **已在做**：`tests/router-http-transport.test.ts` + `scripts/probe-live-model.*` + 冒烟升级 | `ls tests/router-http-transport.test.ts` |
| 崩溃恢复/健壮性审计（P0-3 的邻居） | **已在做**：`queue.ts` 的 `writeResultSafely`、`recovery.ts` 的对账兜底 | `git diff src/control-plane/` |
| **P0-2 流式** | **未动** | — |
| **P0-3 看门狗误回收** | **未动**（`heartbeatTimeoutMs` 仍是 `180_000`，`src/control-plane/types.ts:189`） | `git diff src/control-plane/scheduler.ts` |
| **P0-4 `dotd doctor`** | **未动** | `ls src/surfaces/` 无 doctor |
| **P0-5 审批推送** | **未动**（飞书出站仍只订阅 `task.state`） | `git diff src/surfaces/feishu-outbound.ts` |
| **P1-1 并发** | **未动**（`maxRunningTasks: 1`，`src/control-plane/types.ts:187`） | `grep maxRunningTasks` |
| **P1-2 会话摘要** | **未动**（`updateContextSummary` 仍零调用） | `grep -rn "updateContextSummary(" src/` |
| **P1-3 FTS 检索** | **未动** | `ls db/migrations/` 无 110 |

> 结论：**开工顺序建议 P0-3 → P0-4 → P0-5 → P0-2**（P0-1 让给已在做的同学，本文只提供它的验收标准，供其核对）。**P1-1 必须等 P0-3 合入后再动**（见 §2 依赖图）。

### 0.2 本文的约定

- **四档**：P0（1 周内，靠现有代码）/ P1（2–4 周）/ P2（1–2 月）/ P3（更远，或**故意不做**）。
- **排序依据是投入产出比**，不是"重要性"。一个改动 3 行就能让 9 个工具从"摆设"变"可用"的活，排在"重写并发模型"前面。
- 每项固定四段：**为什么做 / 怎么做 / 验收标准 / 风险与回退**。验收标准一律写成**可实测的判据**（命令 + 期望输出），不写"体验更好"。
- **凡涉及"真实链路"的项，都必须在 `DOTD_FLEET=docker` + 真模型下验收**。这是本仓库目前的根本短板：现有测试与冒烟全部在 stub 下取得（`README.md:99`），对真实模型和真实容器**零证明力**。路线图里凡是标 `[真链路]` 的验收项，都不能用 stub 通过。

---

## 1. 一页纸总览

| 档 | 主题 | 项数 | 要解决的一句话问题 | 其中已在做 |
|---|---|---|---|---|
| **P0** | 让已有的东西真的能用 | 5 | 它现在跑起来了，但模型是瞎的、答案是憋出来的 | **5/5 已完成** |
| **P1** | 从"演示级"到"日常可用级" | 6 | 它一次只能干一件事，且不会查自己记过什么 | **3/6 已完成**（P1-2/3/4） |
| **P2** | 差距最大的三板斧 | 3 | 工具面封闭、没有计划、装不进来 | 0/3 |
| **P3** | 长线 + 故意不做 | 4 + 7 | 哪些对标项是**价值观上拒绝**的 | — |

**P0 已全部完成（5/5）**，P1 已完成 3/6（会话摘要、FTS 检索、WRITE-SEAL 闭环）。剩 P1-1（并发）、P1-5（net.* 落地 + 搜索工具）、P1-6（可观测性）与整个 P2。P1 做完，我判断 dotd 就能"一个人用一周不卸载"。P2 做完，差距从矩阵里的"12 项落后"收缩到"3–4 项"，剩下的基本都是刻意选择。

---

# P0 — 1 周内，靠现有代码堵住"第一天就放弃"

> **判据**：这 5 项全部只改现有文件，**不引入任何新依赖**，不新增迁移包（P0-5 除外），不改协议词表。
> 做完之后，`dotd ask "读一下 ~/notes 里最新的那篇，总结三条" ` 应该能真的完成——而不是"看起来完成了"。

## P0-1 工具结果全文回喂模型（最高 ROI）—— ⚠️ 已在做，本文提供验收标准

> **状态**：`src/runner/dot.ts` 已有未提交改动，`drainResults()` 已改为全文回喂、失败走结构化 JSON、并补回 `assistant.tool_calls` 声明。**本节保留完整背景与验收标准，用于核对已做的工作是否达标**，不要重复实现。

**为什么做**
`src/runner/dot.ts:242-249` 的 `drainResults()` 对每条工具结果调 `digestPreview(json)`，默认上限 **200 字**（`:124-133`）。于是模型读文件只看到前 200 字、看网页只看到前 200 字、看命令输出只看到前 200 字——**它在盲操作**。这是矩阵里"观测回喂"一行评为致命的直接原因。
讽刺的是全文一直在手边：`steps.result_json` 存了全文，`runTask` 也已经写过按 `callId` 取全文的代码（`:459-465`），只是在最后一米又被截回 200 字。

**怎么做**
1. `src/runner/dot.ts` `drainResults()`：改为输出**全文**。保留 `digestPreview` 只用于**写库/日志**（`reportTool` 里的 digest 逻辑 `:791-812` 不动，那是"存储层只存预览"的正确做法）。
2. 在 `RunContext` 里加**单步/单任务上下文预算**：
   - 单条工具结果超过 `TOOL_RESULT_MAX_CHARS`（建议 32 KB，对应 `README.md` 里 `args_json > 32KB 走 journal-blobs/` 的既有阈值）时，**中段截断并留下明确标记**：`…[已截断 N 字节，原文在 steps.result_json#<call_id>]…`——让模型知道"还有更多"，而不是以为内容就这些。
   - 任务累计回喂超过预算（建议 `budgetTokens`，`tasks` 表已有该列，`db/migrations/000_control_plane.sql:56`）时，对**较早的**工具结果做滚动压缩（保留最近 3 条全文，其余降级为预览 + 路径指针）。
3. 失败路径（`:200-203`）同时修：错误对象不再走 `digestPreview` 塞进 `role:'system'` 注记，改为**结构化 `role:'tool'` 消息**，带 `code` / `message` / `retryable` 三个字段（这三个字段容器侧本来就有，`src/exec/protocol.ts` 的 `ExecToolResult.error`）。

**验收标准**
- 单测：构造一个 `fs.read` 返回 10 KB 文本的 stub 工具调用，断言**发给模型的 `ChatMessage[]` 里那条 tool 消息的 `content` 长度 ≥ 10 KB**，且包含原文尾部的一个唯一标记串。现有 `src/runner/dot.ts:257-317` 的 `buildMessages` 是纯函数，可直接断言。
- 单测：构造 40 条各 40 KB 的连续工具结果，断言总回喂 token 估算 **不超过 `budgetTokens`**，且最后 3 条仍是全文。
- 单测：工具失败时，模型侧收到的消息 `role === 'tool'` 且 `content` 能被 `JSON.parse` 出 `{code,message,retryable}`。
- `[真链路]` 端到端：`DOTD_FLEET=docker` 下列一个明确的验证任务——「用 `fs.list` 找 `/dot/home/notes` 下最新的 .md，用 `fs.read` 读它，回答它的第三行是什么」。**断言答案确实等于该文件第三行**（不是"看起来像"）。这条不通过，说明其它一切都没意义。

**风险与回退**
- 上下文爆炸：由 (2) 的预算与滚动压缩兜住；如果发现模型质量下降，回退开关走环境变量 `DOTD_TOOL_RESULT_MODE=full|preview`，默认为 `full`。

---

## P0-2 把流式接到 Runner（三处已就绪，缺一根线）

> **状态：✅ 已完成（2026-10-17，commit `0f692b2`）。** 下面保留原始分析，末尾补"实际做完后发现的两件事"。

> **实际做完后发现的第一件事（原计划没想到的）**：这条线**不是"缺一根线"那么简单**。`ChatChunk` 当时只有 `delta`/`done`，`HttpTransport.stream()` 的 SSE 解析**只读 `delta.content`，把工具调用分片静默丢弃**。而主循环每轮都带 `tools` + `tool_choice:'auto'`——用真 HTTP + 假 SSE 上游实测：只回 tool_calls 的流产出 **0 个 chunk**，Runner 会把工具轮当成"纯文本完结轮" → **任务 done，但工具从未执行**。这不是"没有流式"，是**静默假完成**。
> 所以真正的修法是先补契约：`ChatChunk.toolCalls?`（增量）+ `src/shared/tool-stream.ts` 的 `StreamToolCallAccumulator`（6 条容错：index 缺失/跳号/整段下发/名字拆片/id 缺失/同 index 重发）+ `stream().toolCalls()`（成品，等流读完再取）。
>
> **第二件事**：`RunContext.feed()` 登记结果时把调用声明一起删了，导致三重退化——`dispatched` 恒 false（结果不进 tool 通道、降级成 system 注记）、`assistant.tool_calls` 声明消失（`role:tool` 变无主消息被网关拒）、参数退化成 `{}`（模型看不到自己传过什么）。因 `noteToolCalls` 按模型给的 id 登记、`stepTool` 用 journal call_id 派发，两者真实链路上不相等，所以长期没暴露。
>
> **验收实测**：`tests/runner-stream.test.ts` 11 条 + `tests/shared-tool-stream.test.ts` 10 条全绿，其中最关键的是「流式回合里模型返回 tool_calls → 工具确实被执行，任务不提前 done」。回退开关 `DOTD_STREAM_CHAT=off` 与"未注入总线"两条路径都逐字退回 `complete()`。

**为什么做**
矩阵 §7.2 与 §12 附条：SSE 总线定义了 `chat.delta`（`src/shared/bus.ts:78`），前端已经做了增量拼装（`web-ui/src/views/ChatView.tsx:54-95`），transport 与 router 两层流式都实现了（`src/router/transport.ts:626-630`、`src/router/ModelRouter.ts:605-701`），**而且 `daemon.ts:368` 已经把 `stream()` 递进了 Runner 的端口面**。唯一缺的是 `src/runner/dot.ts` 里的消费。
现在的体感是：发出问题 → 转圈 → 整段答案突然出现。这是"演示级 vs 日常级"最直观的分界线之一。

**怎么做**
1. `src/runner/dot.ts` `stepLlm()`（`:535-596`）：当 `router.stream` 可用时改走流式；每收到 content chunk 就 `bus.publish('chat.delta', {threadId, taskId, text: chunk})`。
2. SSE 帧要**节流**：`src/surfaces/sse.ts` 已有每订阅者 200 条 delta 上限与溢出丢 delta 的逻辑（`:12`），转发侧按 ~50ms 或 ~32 字符节流即可，别把每条 token 都推上去。
3. 流结束后依旧走 `reportAssistant()`（`:815-829`）落全文，`chat.final` 覆盖 delta（前端已实现该覆盖逻辑）。
4. tool_call 的增量（若有）不进总线，只在流结束时一次性处理——避免半截参数引发歧义。

**验收标准**
- 单测：stub transport 产出 5 个 chunk，断言 `bus.publish` 收到 ≥1 次 `chat.delta`，且拼接全部 delta 后与最终 `chat.final` 文本一致。
- 单测：一次 500 chunk 的流，断言 SSE 下发的帧数 **≤ 50**（节流生效），且 `chat.final` 完整。
- 手测：浏览器开 `http://127.0.0.1:7788/`，`dotd ask "写一首 8 行的诗"`，**首字在 1 秒内出现**，且全文与最终消息一致。
- 断线重连：中途 `Ctrl-C` 掉 SSE（DevTools 断网 3 秒），恢复后文本不重不漏（`Last-Event-ID` 游标逻辑 `src/surfaces/sse.ts:8-13` 已有）。

**风险与回退**
- 流式下 tool_call 分片不完整是已知坑。回退：`DOTD_STREAM_CHAT=off` 退回 `complete()`，前端行为自动退回"憋完整段"。

---

## P0-3 修看门狗误回收（心跳在途静止）

> **状态：✅ 已完成（2026-10-17，commit `0f692b2`）。**
> 选了**轮询驱动（a）**而不是 Runner 定时器（b）：只有每轮 `GET /jobs` **成功且报 running** 才续一次心跳，因此"工具在跑"与"协程卡死"被区分开——`getJob` 抛错 / 容器被判 unhealthy·lost·removed / 本地 deadline 到达 / 读到终态，**四种情况一律不续**，心跳自然停、看门狗按 180s 照收。注入缝是 `ExecServiceDeps.liveness`（EX 不 import CP、不直写 tasks）。
> **顺带修掉第二个真缺陷**：`pollJob` 用的是 Runner 传来的 `toolDeadlineMs`（缺省 **60s**），所以"允许跑 30 分钟"以前只是文档里的话——3 分钟以上的工具根本轮不到看门狗，本地 deadline 先标 timeout 然后重跑。现在按 catalog 的 `mode` 选档：async 用目录声明的 `max_deadline_ms`（1800000），sync 仍是 60s，未登记工具保守按 sync。
> **A/B 证据**（同一套测试、同一虚拟时钟，不 sleep 200s）：HEAD = `aborted/stale_writer, attempt=1, deadlineMs=60000`（工具已成功返回、副作用已落地却被回收 → 重跑）；FIXED = `done, attempt=0, execCount=1, deadlineMs=1800000`。
> **真卡死仍回收**（阴性用例）：最后一次上游推进后 +180s 不回收、+180001ms 必回 queued + attempt+1。

**为什么做**
`heartbeatTimeoutMs` = **180 秒**（`src/control-plane/types.ts:189`），但心跳只在每步之后写（`src/runner/dot.ts:839-851` 的 `afterStep`）。而单个 `shell.run` 的 deadline 上限是 **30 分钟**（`src/exec/protocol.ts:130-142`）。**任何超过 180 秒的工具调用都会被看门狗判成"卡死"并回收**。
后果不是报错，是**更坏的东西**：任务被 `reclaimInFlight` 打回 queued，然后重跑；而那个 30 分钟的 shell 可能还在容器里跑着。这正是 README 列为 high 级的已知限制（`README.md:355`）。

**怎么做**
1. **在途心跳**：`ExecService.pollJob()`（`src/exec/ExecService.ts:369-441`）每轮轮询（`pollIntervalMs`）时回调一个 `onCallHeartbeat(callId)`，由装配层转给 CP 的 `journal` → `tasks.last_heartbeat_at`。这是"最小改动、最贴合现状"的解法，因为轮询循环本来就在跑。
2. **按在途调用放宽阈值**：`scheduler` 的看门狗判定（`src/control-plane/scheduler.ts:343` 附近的 `cutoff`）改为 `max(heartbeatTimeoutMs, 当前在途工具 deadline 剩余)`。
3. 同时把 `README.md:355` 里提到的「过渡值 1860s」落实成一个**真实常量**（当前仓库内 grep 不到，见矩阵 §12）。

**验收标准**
- 单测：模拟一个 `shell.run` 挂 400 秒（stub 时钟推进），断言该任务**不被** reclaim，且 `last_heartbeat_at` 至少被刷新 5 次。
- 单测：模拟一个**真卡死**（无任何心跳），断言 180 秒 + 宽限后仍被回收（不能因为放宽而漏判）。
- 单测：断言 `heartbeatTimeoutMs` 与 `asyncDeadlineMs` 的关系有显式断言（防止未来改一个忘另一个）。
- `[真链路]`：`DOTD_FLEET=docker` 跑一次 `shell.run "sleep 300; echo done"` 的任务，断言任务**最终成功**且 journal 里只有一次该工具的 `succeeded` 记录（不是两次）。

**风险与回退**
- 放宽阈值可能让真卡死占住 `maxRunningTasks=1` 更久——这被 P1-1（并发）自然缓解；在此之前，保留一个 `DOTD_WATCHDOG_STRICT=1` 的严格模式开关。

---

## P0-4 首次启动自检 + 一键体检（`dotd doctor`）

**为什么做**
矩阵 §9.1 数出来 **12 步安装、3 个已知陷阱**，而且真实链路**从未验证**（`README.md:345`）。新人第一天最可能的退出点是"我照文档做了，它起了，但什么都不干，也没有报错"。仓库里已经有 `tools/status-check.sh`、`tools/diag-*.sh` 等散装脚本，但它们要求你知道该跑哪个。
另外矩阵 §12 偏差 ④ 指出：**stealth 反检测实际没生效**（`requireBrowserFactory()` 只 import `playwright`，`playwright-extra` / `puppeteer-extra-plugin-stealth` 从未加载，实际是 `noopStealth`，`agent-runtime/server.ts:182-208`、`agent-runtime/browser.ts:100-103,174`）。自检必须能把这类"文档说有你实际没有"的东西暴露出来。

**怎么做**
1. **`dotd doctor` 子命令**（加在 `src/surfaces/cli.ts` 现有 14 个子命令旁，`:197-458`）：逐项体检并给**可执行的修复建议**，每项输出 `PASS / WARN / FAIL`：
   - Node 版本 ≥ 24
   - `~/.dotd/config.yml` 存在且三个 `${VAR}` 已展开（`src/surfaces/config.ts:353-366`）
   - `DOTD_FLEET` 的**实际生效值**（注意 `Docker`/`DOCKER` 拼错会静默回落 stub，`src/exec/types.ts:189`）
   - `DOTD_MODEL_TRANSPORT` 实际生效值
   - tier1 端点 `base_url` 可达性（一次 8-token 的 ping，复用 `src/router/breaker.ts` 的半开探活逻辑，别新写）
   - 模型 key 是否存在（`apiKeyFor()` 未设即不发 auth 头，`src/router/transport.ts:402-406`——这会被一句话讲清楚）
   - Docker socket 可达 / 镜像是否存在 / 容器状态
   - 飞书六字段是否齐、`owner_chat_id` 是否为空（为空 = 一切入站 403，`src/surfaces/feishu-inbound.ts:137-140`）
   - **stealth 实况**：上报 `stealthInjector.constructor.name`，若为 `noopStealth` 直接 WARN 并说明"反检测未生效"
2. **daemon 启动自检**：`src/daemon.ts` 装配完成后，把上面结果写进 `GET /api/status` 的 `checks` 字段（该路由已存在，`src/surfaces/http.ts:461-484`），Web UI 首页失败项标红。
3. 顺手把 `README.md` 的"已知限制"里已修的项同步删掉——**文档撒谎比没文档更伤人**。

**验收标准**
- `npm run dotd -- doctor` 在**全新机器**（未跑过 init-config）上：exit code 非 0，且**第一条 FAIL 就是"先跑 `npm run init-config`"**，不需要用户读 README。
- 在**已跑通 stub 模式**的机器上：全部 PASS，exit 0。
- 在**故意把 `DOTD_FLEET` 写成 `Docker`** 的环境里：**必须**给出 WARN"值非法，已静默回落 stub"（这是当前最隐蔽的坑）。
- 在 tier1 key 缺失时：给出 FAIL + 一句"所有交互任务会挂起，因为 tier1 是唯一能承载 primary 轨的端点"。
- 单测：`doctor` 的各项判据函数独立可测（每项一个纯函数，输入环境快照，输出 PASS/WARN/FAIL）。

**风险与回退**
- 自检本身可能因环境差异误报。处理：所有 FAIL 都必须附带"如何自行验证"的命令，让用户能反驳自检。

---

## P0-5 审批主动推送（飞书 + Web 通知）

**为什么做**
矩阵 §6.1：审批 TTL 24 小时（`src/governance/config.ts:44-45`），但**飞书出站只订阅 `task.state` 的 done/failed**（`src/surfaces/feishu-outbound.ts:79-107`），**不订阅 `approval:created`**。任务卡在审批时，飞书那头完全静默。
对一个"常驻、人不在电脑旁"的 daemon 来说，这是最伤信任的体验：**你以为它在干活，其实它在等你，而你不知道**。24 小时后超时，任务作废。

**怎么做**
1. `src/surfaces/feishu-outbound.ts`：增加 `bus.on('approval:created')` 订阅（该 topic 已存在，`src/shared/bus.ts:46`）。消息内容 = 任务标题 + 工具名 + **参数摘要**（不是全文）+ 建议裁决 + 两条可选命令 `dotd approve <id>` / `dotd deny <id>`。
2. **Web 侧**：`GET /api/status` 已有 `approvalsPending` 计数（`src/surfaces/http.ts:481`）；在浏览器 tab title 上显示 `(3) dotd`，并把 `approval` 通道的 SSE 帧接成桌面通知（`Notification` API，需用户首次授权）。
3. **超时预警**：TTL 剩 2 小时时再推一次（复用同一个 `alert_dispatch` 的出站机制，`db/migrations/010_model_router.sql:59` 已有该表与幂等签名索引）。
4. **不要**在飞书里做交互式按钮审批——那要引入卡片协议，超出 P0 范围。P1 再做。

**验收标准**
- 单测：`bus.publish('approval:created', …)` 后，stub gateway 的 `sendText` 被调用一次，且文本包含 approval id。
- 单测：同一 approval 重复 publish 不重复发送（幂等，复用 `feishu-outbound.ts:73-77` 现有的 `sent` Map 思路）。
- 单测：TTL 剩余 2h 时预警只发一次（用 `alert_dispatch` 的 signature 去重）。
- `[真链路]`：真实飞书 App 下，构造一个 `dangerous` 档工具调用（如 `shell.run "rm -rf /tmp/x"`），**断言飞书在两分钟内收到审批请求**，且回复 `dotd approve <id>` 后任务继续执行。

**风险与回退**
- 审批推送刷屏。处理：同一任务同一会话内合并成一条（"3 个待批"），并遵守已有的 `edit_throttle_ms`（`config/dotd.yml` 的 feishu 节）。

---

## P0 完成判据（"一周内"的 Definition of Done）

全部满足才算 P0 收工：

1. `npm run typecheck` exit 0；`npm test` 全绿且**新增 ≥ 25 个用例**（P0-1 至少 10 个）。
2. `node scripts/smoke.mjs` 11/11 通过（不回归）。
3. **`DOTD_FLEET=docker` + 真模型下跑通 3 个真实任务**：读文件并准确回答内容细节 / 30 分钟长命令不被误杀 / 审批经飞书往返一次。**这是本仓库第一次拥有真链路证据。**
4. `dotd doctor` 在全新环境与已配置环境下的行为符合 P0-4 验收标准。
5. README 的"已知限制"里被本轮修复的条目已被删除或标注已修（禁止留着过期限制）。

---

# P1 — 2–4 周：把 agent 干活能力从"演示级"到"日常可用级"

## P1-1 并发：从单任务串行到"交互优先 + 后台让路"

**为什么做**
矩阵 §7.1：`maxRunningTasks: 1`（`src/control-plane/types.ts:187`），pop 时 `runningCount(dot) >= maxRunningTasks → return null`（`src/control-plane/queue.ts:247`）。一个 30 分钟的 `shell.run` 会把你的 `dotd ask` 堵在后面。**这是我判断"一个人用一周会不会卸载"的第二关键因素**（第一是 P0-1）。

**怎么做**
1. **先做最小可用的双跑道**，不要上多 Dot：
   - `ControlPlaneConfig.maxRunningTasks` 由常量改为可配置（环境变量 `DOTD_MAX_RUNNING`，默认 2）。
   - 公平性：`Queue.pop` 已经有 `(dot_id, status, priority, run_at)` 索引（`db/migrations/000_control_plane.sql:62`）与优先级语义（`priority=1` 是主人交互，`:41`）。pop 时**先看 priority ≤ 1 的 queued，再看其余**，即可实现"交互插队、后台让路"。
2. **交互任务抢占**：当 `priority=1` 的新任务到来且唯一在跑的槽位被 `priority≥5` 的后台任务占用时，**不杀后台任务**，而是给它投一条 `system.note`（`feedSystemNote`，`src/runner/dot.ts:194-197` 已有）要求它在**下一个安全步边界**收尾并让出，同时给 `priority=1` 立即开一个新槽。
3. **每个 dot 的容器仍只有一个**——并发是"任务级并发"，工具调用由 `ExecService` 串行化到同一容器（`agent-runtime` 的 ledger 已按 `call_id` 幂等，天然支持交错）。**不要**为了并发就起多容器，那是阶段三多 Dot 的活。
4. 顺带修矩阵 §12 里"心跳只在步尾写"带来的并发争用：`last_heartbeat_at` 改成按 `(task_id, run_epoch)` 隔离（DDL 已经是这个粒度，无需迁移）。

**验收标准**
- 单测：塞 1 个 `priority=5` 的 30 分钟任务后再塞 1 个 `priority=1`，断言后者**在 1 秒内**进入 `running`（stub 时钟）。
- 单测：3 个并发任务，断言**任一时刻 running 数 ≤ `maxRunningTasks`**，且没有任务饿死（最老的 queued 的等待步数有上界）。
- 单测：`maxRunningTasks=1` 时行为与今天完全一致（防止改变默认语义）。
- 压测：`scripts/` 下加一个并发冒烟脚本，100 个任务混优先级，断言全部到达终态、无死锁、`journal` 无孤儿 `started` 步。

**风险**：并发会把原本被串行掩盖的 SQLite 写争用暴露出来。`synchronous=FULL` + `busy_timeout=5000`（`db/conn.ts:40-42`）面对并发写可能超时。**对策**：先跑压测看错误率，如果 `SQLITE_BUSY` 超过 1%，再考虑把 `journal` 的 `beginTool` 合批。

---

## P1-2 会话摘要真的生成（当前 `updateContextSummary` 零调用）

> **状态：✅ 已完成（2026-10-18，commit `783d119`）。** 摘要走**注入的 `summarize` seam**（MEM 模块零 HTTP），daemon 接 `router.complete({track:'light'})`；触发点在 Runner 收口前（补写轮之后、finish 之前）；`upto_seq` 取被覆盖的最后一条消息 seq（精确值）；增量摘要只喂 `upto_seq` 之后的新消息 + 旧摘要。验收 `tests/memory-context-summary.test.ts` 10/10。

**为什么做**
矩阵 §3.1 偏差 ①：`updateContextSummary()` 定义在 `src/memory/MemoryService.ts:288-299`，**全仓库没有调用方**；`needsSummarize()`（`:1271`）同样无人调用。于是 `context_summary` 恒为 NULL，会话超过 4000 token（`src/memory/limits.ts:59`）后**硬截断**，越聊越忘。

**怎么做**
1. 在 `registerInternalJob` 注册一个 `memory.summarize` 定时任务（`src/control-plane/index.ts:168-193` 已有 `queue.gc` / `heartbeat.tick` 两个范例）。
2. 判据直接用现成的 `needsSummarize(messageCount, injectTokens)`（阈值 64 条 / 4000 tokens，`src/memory/limits.ts:65-66`）。
3. 摘要走 **`track:'light'`**（便宜模型），把"上次摘要 + 上次摘要之后的消息"压成 ≤600 tokens（`SUMMARY_TOKEN_LIMIT`，`:68`）。
4. 写回 `context_summary` + 推进 `context_summary_upto_seq`，让 `buildContextBundle`（`src/memory/MemoryService.ts:337-338`）能读到。
5. **摘要失败必须可见**：light 轨挂了不能静默——落一条 `memory_missed`（`markMissedRaw` 已有），并在 `status()` 里暴露。

**验收标准**
- 单测：往同一 thread 灌 100 条消息，触发 `memory.summarize`，断言 `mem_threads.context_summary` 非空且 ≤600 tokens，`context_summary_upto_seq` 等于最后一个被压缩的 seq。
- 单测：摘要摘要（递归压缩）两次后，信息不丢关键事实（构造一个含唯一标记 "XJ-4711" 的会话，两次压缩后仍能在注入里找到它）。
- 单测：light 轨全挂时，任务照常跑完（记忆问题不炸主循环，`src/memory/seal.ts:59` 的既有语义），但 `status()` 里 `memory_missed` 计数 +1。
- `[真链路]`：一段 200 轮的真实对话后，问"我们第一轮讨论的是哪个项目"，答对。

---

## P1-3 记忆检索进工具面（FTS5，零依赖）

> **状态：✅ 已完成（2026-10-18，commit `783d119`）。** 实测 SQLite 3.50.4 的 `unicode61` 把整段中文当一个 token（"会议记录"查"会议" = 0 条），故用 **bigram 纯函数**（写入与查询共用同一实现，防漂移）。**没有**用原设想的外部内容表 + 触发器：触发器调不了 JS，必然出现两套切分实现；且 `snippet()` 会读回未切分原文、把优势抵消。改 **contentless FTS + 代码侧双写**，原文仍以 `mem_messages` 为唯一真相。降级：表被 DROP/老库/索引损坏 → 回落 LIKE（结果不丢），并写 `fts_degraded_count`/`fts_degraded_last` 留痕。`rankManuals` 加 TF-IDF，反例：「旧算法把噪声手册排第一、真实相关手册排第三；新算法纠正」。验收 `tests/memory-fts.test.ts` 37/37。

**为什么做**
矩阵 §3.3：`searchHome()` 是**遍历全部索引文件逐个读全文再做 `indexOf`**（`src/memory/MemoryService.ts:502-525`），而且「维护用检索，不进模型工具面」（`:507`）。**模型完全不能检索自己的记忆**——只能靠任务开头注入的 2500 tokens（`src/memory/limits.ts:57`）。记忆越多，召回率越低，这是一个**会随使用时间恶化的缺陷**。
我已实测本机 Node v24.13.0 内置 SQLite **3.50.4**，FTS5 与 `bm25()` 可用，**不需要任何新依赖**。

**怎么做**
1. 新迁移包 `db/migrations/110_memory_fts.sql`：
   ```sql
   CREATE VIRTUAL TABLE mem_files_fts USING fts5(
     path UNINDEXED, body, dot_id UNINDEXED, tokenize='unicode61'
   );
   ```
   `unicode61` 对中文只能按字切分，够用；如果效果差，P2 再上 `trigram`（SQLite 3.34+ 支持）。
2. 索引维护：挂在现有的 `syncFilesIndex()`（`src/memory/MemoryService.ts:691`）里同步写 FTS（新增/更新/删除三路）。
3. 新增工具 `memory.search`，**这是矩阵 §2.2 里"工具面封闭"的第一次开缝，必须同时做 P2-1 的最小版本**——否则等于第 12 个硬编码工具。若 P2-1 未就绪，先用"从能力目录读取、在 `CAPABILITY_CATALOG` 追加一项"的常规路径落地。
4. 返回结构：`[{path, snippet, score}]`，`snippet` 用 FTS5 的 `snippet()` 函数（±40 字），**top-5**，每条 ≤500 字。
5. 同时把 `searchHome` 的朴素实现替换为 FTS 查询（保留旧实现做回退开关）。

**验收标准**
- 单测：写入 1000 个 note，`memory.search("报销 流程")` 在 **50ms 内**返回 top-5，且第一条 snippet 含关键词。
- 单测：文件删除后 FTS 不再命中（索引一致性）。
- 单测：中文、英文、中英混排三种 query 都能命中（`unicode61` 的已知弱点要有断言兜底）。
- `[真链路]`：让 agent 完成一个**必须检索**的任务——「我上个月记过一次关于 Docker 端口冲突的笔记，找出来并告诉我解决步骤是什么」，**断言它调用了 `memory.search` 而不是 `fs.list` 遍历**（查 journal 的 `tool_name`）。

---

## P1-4 记忆写入策略闭环（修 WRITE-SEAL 的"假提醒"）

> **状态：✅ 已完成（2026-10-18，commit `783d119`）。** 难点在于"终态之后无法再跑 LLM"：`sealTask` 由 CP 钩子在 `queue.finish()` **内部**调用，那时主循环已退出。解法是把判定提前——`needsMemoryRedo()` 只判定不写库，Runner 在 `cp.finish()` **之前**调用，该补就跑一轮**只给一次机会**的受控回合（请求不带 tools + `tool_choice:'none'`），然后才 finish，因此补写轮的 `fs.write` 落在任务仍 running 的时间窗内。`memoryRedo` 默认 **false**（= 既有行为不变），`daemon.ts` 显式传 true，并由静态守卫防止改回。
> **顺带修掉的真缺陷**：daemon 的 `journalMemoryProbe` 返回 `fs.write:<callId>`（无路径），而 MEM 侧按 `/dot/home/{MEMORY.md,notes/,manuals/}` 前缀判定 → **永远判不出"写过"**，每个成功任务都被误报 missed。新增 `src/memory/step-paths.ts` 从 `args_json` 还原真实路径。验收 `tests/memory-seal-redo.test.ts` 12/12。

**为什么做**
矩阵 §12 偏差 ②：`src/memory/seal.ts:91-100` 在任务结束时往 thread 追加一句「若本次有可复用经验，现在写 notes/…」——**但这只是一条静态 `role:'system'` 消息，不会触发新的一轮 LLM 调用**。任务此刻已经 `finish`，Runner 已退出该任务的循环（`sealTask` 在 `Queue.finish` 内部被调，`src/daemon.ts:547-550`）。所以**"提醒补写一轮"从来没发生过**，模型的记忆写入完全取决于它在主任务里恰好想到了。

**怎么做（两条路，选一）**
- **路 A（推荐，简单）**：把"写记忆"变成一个**独立的 memory-task**。`sealTask` 检测到"没写记忆"时，**投递一个 `priority=7` 的新任务**（`tasks` 表已有 priority 语义与 `payload_json`，`db/migrations/000_control_plane.sql:41,39`），goal = "本次任务做了 X，总结可复用经验写入 notes/ 或回复 SKIP"。这样它就是一个正常任务，有 journal、有审批、可审计。
- **路 B（体感更好）**：在 Runner 主循环里，任务判定 `done` 之前先插一轮"记忆收尾"LLM 调用。改动在 `src/runner/dot.ts:505-531` 的 while 出口处。

**验收标准**
- 单测：一个"读完文件就答完"的任务结束后，断言**新增了一条 `priority=7` 的 memory-task**（路 A）或**多了一轮 LLM 调用**（路 B）。
- 单测：模型回复 `SKIP` 时不写文件，且不产生无限循环（memory-task 自己不再触发 memory-task —— 必须有显式防递归，建议在 `payload_json` 打 `kind:'memory'` 标记）。
- 单测：memory-task 写入的 note 通过了 `beforeWrite` 限额（`src/memory/MemoryService.ts:429-436`），超限时降级而不是失败。
- `[真链路]`：连续做 5 个同主题任务（比如都涉及同一个网站），**断言第 4、5 次任务的 journal 里出现了 `fs.read` 读取 `manuals/` 里那条被写下的经验**——即记忆真的被复用了。

**风险**：memory-task 会消耗额度。对策：给 memory-task 单独的、很小的 `budget_tokens`（建议 8000），并在 `status` 里单独统计。

---

## P1-5 `net.get` / `net.post` 落地 + Web 搜索工具

**为什么做**
矩阵 §12 附条：`net.get`/`net.post` 在能力目录里有、路由里有，但容器内直接返回 `not_implemented`（`agent-runtime/server.ts:609-612`）。后果是 agent **没有轻量的 HTTP 能力**，也没有 web 搜索——所有网络访问都得走完整浏览器（重、慢、且未验证）。
dotd 是"唯一外部依赖是可换 base_url 的模型 API"的自托管项目，那么"上网查资料"就必须是**成本低、可控、可审计**的一等能力。

**怎么做**
1. `agent-runtime/server.ts` 的 `net.*` 分支：实现 HTTP 客户端（Node 24 内置 `fetch`，零依赖）。
   - **必须过 netguard**：出站目标受 `HostNetGuard` 白名单约束（`src/exec/netguard.ts:18-19`，"默认空 = 只允许出外网、禁止一切宿主侧访问"）。
   - 硬上限：响应体 ≤ 2 MB、超时 ≤ 30s、只允许 `http/https`、禁止 `file:`（SSRF 防护：拒绝 `127.0.0.0/8`、`169.254.0.0/16`、RFC1918——netguard 已在这些网段上有规则，但**工具层也要自己挡**，纵深防御）。
   - 返回正文抽文本（去 HTML 标签），别把整页 HTML 塞给模型（会撞 P0-1 的上下文预算）。
2. **web 搜索**：不引入搜索 API 依赖（会违反"唯一外部依赖是模型 API"的定位）。两条路：
   - 路 A：`web.search` = 用浏览器打开一个搜索引擎页面并 `browser.snapshot()`（复用现有浏览器，零新依赖，但重）。
   - 路 B：接一个可选的搜索端点（SearXNG 自托管），写在 `config/models.yml` 同级的配置里，**默认关闭**。
   - **推荐路 A 先上**——它完全符合自托管价值观。

**验收标准**
- 单测：`net.get` 对 `file:///etc/passwd` 返回 `bad_args`；对 `http://127.0.0.1:7788` 返回 `blocked_by_policy`；对 `https://example.com` 在 stub 网络下返回结构化错误、无副作用。
- 单测：2 MB 响应被截断并标注 `truncated: true`。
- 单测：`net.get` 的 `sideEffect` 分类正确（`safe`），`net.post` 是 `unknown`（目录里已是如此，`src/exec/protocol.ts:184,191`）——保证崩溃恢复语义不变。
- `[真链路]`：`DOTD_FLEET=docker` 下，一个"告诉我 example.com 的标题"的任务，**用 `net.get` 在 5 秒内完成**（不是 60 秒的浏览器启动）。

---

## P1-6 可观测性补齐：结构化日志 + 成本口径

**为什么做**
矩阵 §8：日志只有 `process.stdout.write('['dotd'] …')`（`src/daemon.ts:410`），**无级别、无结构、无轮转**；`model_call_log` 有 token 但**没有一分钱的成本口径**（`db/migrations/010_model_router.sql:74-84`）；无 trace_id。
但 dotd 的**数据面已经很好**：`steps` 表每一步都落（`db/migrations/000_control_plane.sql:75-95`），`model_call_log` 每次调用都落。缺的只是**读出来的那一层**。

**怎么做**
1. **日志**：`src/daemon.ts:410` 的 `log()` 改成 JSON 行 `{ts, level, msg, taskId?, callId?, epoch?}`，写 `~/.dotd/logs/dotd-YYYY-MM-DD.log`（按天轮转，保留 14 天，复用 `src/memory/retention.ts` 的清理思路）。stdout 保留人读格式。
2. **trace 轴**：不引入 OTel。直接用现成的 `task_id` / `call_id` / `attempt_id` / `run_epoch` 做关联，`dotd task <id> --trace` 把 llm 步 + tool 步 + exec call + model call 按时间轴拼成一条线。
3. **成本**：`config/models.yml` 的每个端点加可选 `price: {input_per_mtok, output_per_mtok, currency}`；`model_call_log` 已有 token 列，**不迁移**——在查询时算。新增 `GET /api/usage?since=&group_by=endpoint|model|task` 与 `dotd cost --since 7d`。自托管/免费端点标 `price: 0`，让用户看到"这周花了 0.37 元"或"0 元（全本地）"。

**验收标准**
- 单测：`log()` 输出可被 `JSON.parse`，含 `ts/level/msg` 三键；日志文件按天切分，14 天前的被删。
- 单测：`GET /api/usage` 对一个含 3 次调用的 fixture 返回正确的 token 和金额（金额精度到 1e-6）。
- 单测：端点没配 `price` 时，金额字段为 `null` 而不是 `0`（**"不知道"不是"免费"**——这个区分 `model_call_log` 对 `cached_prompt_tokens` 已经做过一次正确的示范，`:1033-1035`）。
- 手测：`dotd task <id> --trace` 输出一条从"领任务"到"finished"的完整时间线，**每一行都有耗时**。

---

# P2 — 1–2 月：对标项里差距最大的三个

> 到 P1 结束，矩阵里 25 项中致命的 5 项应该已经消掉 4 项（只剩工具面封闭）。P2 处理的就是那剩下的、**必须动结构**的三项。

## P2-1 工具扩展点（第一优先：MCP 客户端）

**为什么做**
矩阵 §2.2 / §11 差距 ②：**11 名封闭词表 + 三处源码同形 + 一处 YAML 登记**（`src/exec/protocol.ts:96-196`、`agent-runtime/protocol.ts`、`agent-runtime/server.ts:591-616`、`config/tools.yml`）。加一个工具约等于 fork 内核。而这恰恰**违背了自托管的根本价值**——自托管就是为了"接得上我自己的东西"。
OpenAI/Grok 的工具面可扩张（MCP + connectors），dotd 是常量。这是矩阵里唯一被评为"致命"且**靠加参数修不掉**的一项。

**怎么做（分三步，每步独立可交付）**
1. **解耦能力目录与词表**：`CAPABILITY_CATALOG` 从常量改为**运行期加载 + 编译期默认集**。`TOOL_NAMES` 由"封闭词表"改为"治理登记表"——`src/exec/protocol.ts:258-264` 的 `unknown_tool` 判据从"不在 11 名里"改为"不在治理目录里"。**同时保留白名单默认拒绝语义**（安全不降级）。
2. **MCP 客户端**（只做客户端，不做服务端）：MCP 工具以 `mcp.<server>.<tool>` 命名注入能力目录，`sideEffect` **默认 `unknown`**（fail-safe，符合 `recovery.ts:22-24` 的既有哲学），治理档位默认 `review`。
3. **容器外执行**：MCP server 跑在**宿主侧**（daemon 进程），不经容器。理由：MCP server 常有宿主凭据，进容器会让你不得不把凭据塞进容器，**破坏现在"token 只读 bind、不进 env"的隔离**（`src/exec/protocol.ts:511-519`）。代价是 MCP 工具不受 netguard 约束——所以它必须走和 `shell.run` 一样的治理档位。

**验收标准**
- 单测：注册一个假的 MCP server（3 个工具），断言 `getCapabilities()` 返回 11+3 项，`toolSpecs()` 把它们暴露给模型。
- 单测：未治理登记的 MCP 工具一律 deny（`unknown_tool` 语义不破）。
- 单测：MCP 工具 `sideEffect='unknown'`，崩溃后**不被自动重放**（与 `recovery.ts` 矩阵一致）。
- 单测：MCP server 断开时，任务**不崩**，该工具调用返回结构化错误，模型能改道。
- `[真链路]`：接一个真实的公开 MCP server（如 filesystem 或 fetch），让 agent 完成一个**必须用该工具**的任务，全流程成功。
- 回归：**11 个原有工具的协议双向同形测试必须继续全绿**（`tests/agent-runtime-protocol.test.ts`，40 个用例）。

**风险与回退**：这是本文档里**唯一可能破协议同形的改动**。必须在迁移前先把 `tests/agent-runtime-protocol.test.ts` 从"词表逐字比对"改成"协议形状比对 + 默认集比对"，否则会改一处红一片。

## P2-2 显式计划与目标锚定（治"长任务跑偏"）

**为什么做**
矩阵 §4.1 / §4.4：dotd 主循环是纯 ReAct（`src/runner/dot.ts:506-525`），**没有 plan 落库、没有 plan 注入、没有 goal 锚定**。`goalDigest` 只在治理 precheck 时截 800B 用（`:148-160`），不参与主循环对齐。长任务里模型会忘记第 2 步目标；崩溃恢复后计划彻底丢失。

**怎么做**
1. **计划是一等公民**：新增 `tasks.plan_json`（迁移包 110+）或者在 `journal` 里加一个 `kind='plan'` 的步类型（推荐后者，避免改 tasks 表）。计划形态：`[{id, text, status: 'todo'|'doing'|'done'|'blocked'}]`。
2. **首步强制出计划**：任务前 3 步内若模型没产出计划，注入一次 `feedSystemNote`（`src/runner/dot.ts:194-197` 已有）要求它先列计划再动手。**只提醒一次**，避免变死循环（参考 `seal.ts` 的 `hasReminded` 模式，`:53-55`）。
3. **每 N 步回放计划**：每 5 步把「当前计划 + 已完成项 + 目标原文（不超过 800B）」作为一个 system 消息插到 messages 最前面。这就是"目标锚定"，成本极低。
4. **崩溃恢复后计划自动重放**：`runTask` 从 journal 的最后一个 plan 步恢复计划（`:444-483` 的注记重建处已有接入点）。
5. **给用户可见**：Web UI 的 Queue 视图展示每个 running 任务的计划进度条。

**验收标准**
- 单测：一个 20 步的 stub 任务，断言 journal 里有 ≥1 个 plan 步，且每 5 步注入一次计划回放（统计 messages 里含"计划"前缀的 system 消息数）。
- 单测：任务执行中 `kill -9` 后重启，断言恢复后的第一轮 LLM 请求**包含崩溃前的计划**。
- **A/B 可测的判据**：构造一个 15 步、目标容易漂移的任务（"先把 A 网站的三篇文章各自摘要，再对比它们的观点差异"），**未开计划 vs 开计划各跑 10 次，断言开计划版本的"最终答案里同时提到了三篇文章"的比率 ≥ 8/10，未开版本 < 5/10**。这是唯一能证明这项"有用"的实验，别省。
- 单测：计划注入不会导致 token 预算超限（沿用 P0-1 的预算检查）。

**风险**：强制出计划会增加首步延迟与 token 消耗。对策：仅对 `goalTokens > 200` 的任务强制（简单问答不强制）。

## P2-3 部署与分发：从 12 步降到 3 步

**为什么做**
矩阵 §9.1：12 步安装、3 个已知陷阱、真实链路未验证。这是"第一天放弃"的**第一名原因**（比 P0-1 的盲操作更靠前，因为盲操作是"用起来才发现"，装不上是"根本用不上"）。

**怎么做（按风险从低到高做，每步都能独立发布）**
1. **干掉同名陷阱**：`config/dotd.yml` 改名 `config/surfaces.yml.template`，加载器找不到时给出**指名道姓的报错**（当前 `src/surfaces/config.ts:359` 只说读不到文件）。
2. **.env 真正可用**：使 daemon 启动时读取 `~/.dotd/tokens.env`（Node 24 有内置 `process.loadEnvFile()`，**零依赖**）。这一条直接消掉"代码不读 .env"带来的最大困惑（`.env.example:4-7`）。**注意顺序**：文件里的值不得覆盖已 export 的环境变量（env 优先级更高），避免覆盖陷阱（`README.md:351`）。
3. **一键引导**：`dotd init` —— 交互式问答（模型端点 / key / 是否要飞书），生成 config + tokens，**最后自动跑 `doctor`**。`npm run init-config` 已是雏形（`scripts/init-config.mjs`），把它升级成能问问题的版本。
4. **原生 Windows 不再被 WSL 卡住**：`src/exec/types.ts:154` 硬编码 `/var/run/docker.sock`，改为支持 `npipe:////./pipe/docker_engine`（Docker Desktop on Windows 的默认 socket）。同时 `src/daemon.ts:587-589` 的"必须跑在 WSL 里"注释一并作废。**Windows 用户占自托管人群的相当大比例，这一条的分发价值极高。**
5. **单文件发布**：Node 24 支持 `--experimental-sea`（单可执行文件）。做一个 `npm run bundle` 产出 `dotd.exe` / `dotd`，用户不用装 Node。这一步风险最高，放最后，做不成也不阻塞前四步。

**验收标准**
- **全新机器计时测试**：从 `git clone` 到"daemon 起来且 `dotd doctor` 全 PASS"，**墙钟时间 ≤ 10 分钟，且不需要读 README 以外的东西**。（现状我估计 1–2 小时且有 3 处会卡住。）
- 单测：`config/surfaces.yml.template` 缺失时的报错文本包含文件名与"请运行 `dotd init`"。
- 单测：`tokens.env` 里有一项、环境变量里也有同名值时，**环境变量生效**（防止覆盖陷阱）。
- `[真链路]`：原生 Windows（Docker Desktop）下跑通真实容器 + 真模型，全程不启 WSL。
- 分发：`dotd.exe` 在干净 Windows 上双击可运行（若第 5 步做了）。

---

# P3 — 更远，且必须与「完全自托管」价值观一致

## 3.1 值得做（但排在这些之后）

| 项 | 为什么做 | 门槛 / 判据 |
|---|---|---|
| **审批卡片交互式审批** | P0-5 只做了"通知"，用户还得切终端敲命令。飞书卡片按钮能把审批闭环在手机里完成 | 做完 P0-5 后观察一周，如果"收到通知但 1 小时内没处理"的比例 > 30% 再做 |
| **多 Dot** | 真正隔离多条身份线（个人 / 工作 / 测试账号），每条线独立浏览器 profile 与文件记忆卷 | **必须在 P1-1 并发之后**，因为多 Dot 的本质是"并发 + 隔离"，先有并发才谈隔离。且需要先有"dot 配额与资源水位"（`src/control-plane/guard.ts:273` 已有基础） |
| **stealth 真落地** | 矩阵 §12 偏差 ④：`playwright-extra` / `puppeteer-extra-plugin-stealth` 声明了却从未加载（`agent-runtime/server.ts:182-208`），实际是 `noopStealth` | **先做验证再做实现**：跑一个公开的反爬检测页（如 `bot.sannysoft.com`），记录当前失败率，再决定值不值得引入。若 P2-1 的 MCP 已经能接外部抓取工具，这项可能直接不做 |
| **语音** | README 已明确"语音最后做"（`README.md:404`）；自托管场景下语音需要本地 STT/TTS，成本高收益小 | 只有当本地模型能跑 whisper 级别的 STT 时才启动 |

## 3.2 **dotd 故意不做的对标项**（与价值观的显式切割）

> 这一节比 3.1 重要。**一个自托管项目的力量来自它敢于说不。** 下面对标矩阵里确实存在、但我判断 dotd 应当**明确拒绝**的项，逐条给理由。

| 不做的项 | 为什么不做 | 如果做了会失去什么 |
|---|---|---|
| **商业托管 / SaaS 版** | 项目的根本定位是"给愿意自己持有全部状态的人"（`README.md:24`）。托管 = 状态离开你的机器 = 定位消失。OpenAI/Grok 的全部体验优势都建立在他们替你托管上——**这正是 dotd 想逃离的东西** | 会变成一个二流的 ChatGPT 克隆，且失去唯一的结构性优势（数据主权） |
| **云端持久化 / 跨设备记忆同步** | 与上一条同源。文件记忆存在 `/dot/home` 卷里是**有意为之**（`exec-image/Dockerfile:42`）：可备份、可 git、可人工编辑 | 记忆变成黑盒，用户再也无法"打开文件看一眼它记住了什么"——而这恰恰是 dotd 记忆设计最优雅的地方 |
| **对话式对外 API + SDK** | 矩阵 §10 指出的"没有对话 API" **不是缺陷，是选择**。一旦对外暴露"给 goal 拿执行过程"的 API，dotd 就成了一个可被第三方嵌入的 agent 平台，随之而来的是配额、多租户、计费、滥用防护——一整套 SaaS 负担 | 现在这套"22 条内部 REST 路由 + 一个主人 token"（`src/surfaces/http.ts:105-126`）是对的：**一个主人的控制面，不是公共 API**。要对外，用 webhook 入站（已有）就够 |
| **插件市场 / 内置工具商店** | 市场的前提是有大量用户与审核能力。dotd 的所有者是"你"，工具应当由你按需接入（P2-1 的 MCP 就是"按需接入"的正确形态） | 市场会引入供应链风险，而 dotd 的最大资产恰恰是"依赖面极小"（`package.json` 只有 5 个运行时依赖） |
| **厂商托管模型（默认绑定某家）** | 定位是"唯一外部依赖是可换 base_url 的模型 API"（`README.md:24`）。已有的四层降级链 + 熔断（`src/router/ModelRouter.ts`）正是为"任何一家都能挂"设计的 | 绑定 = 放弃可换性 = 再次把命运交给单一厂商 |
| **遥测 / 使用数据回传** | 不言自明 | 遥测一上，自托管就名存实亡 |
| **移动端原生 App** | 成本极高、与"常驻在你自己机器上"的形态不匹配。IM（飞书/Telegram）已经提供了移动可达性（`src/surfaces/feishu-ws.ts`） | 手机看通知用 IM 就够；做 App 是纯消耗 |

**一句话**：矩阵里 OpenAI/Grok 领先的 12 项中，**有 5 项（托管、云同步、公共 API、市场、移动端）dotd 应当永远不做**。真正要追的其实只有 7 项——而 P0/P1/P2 恰好覆盖了其中 6 项（剩下一项是语音，见 3.1）。

---

## 4. 执行顺序与依赖关系

```
P0-1 全文回喂（⚠️ 已在做）───┐
P0-2 流式          ───────┐  │
P0-3 看门狗（未动→先做）┐  │  │
P0-4 doctor（未动）  ──┐  │  │  │
P0-5 审批推送（未动）──┘  │  │  │
                        ▼  ▼  ▼
                P1-1 并发（依赖 P0-3：并发放大看门狗问题）
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   P1-2 摘要     P1-3 检索 ──▶ P1-4 记忆闭环（检索让记忆写入更有价值）
        │            │            │
        └────────────┴────────────┘
                     ▼
                P1-5 net.*   P1-6 可观测
                     │
                     ▼
                P2-1 MCP（依赖 P1-3 的"第一次开缝"）
                P2-2 计划
                P2-3 分发（可与 P2-1/2 并行）
```

**唯一的硬依赖**：P1-1 并发**必须**在 P0-3 看门狗之后做（并发会把"心跳在途静止"从偶发变成常态）。
**建议的开工顺序**（考虑到 P0-1 已在做）：**P0-3 → P0-4 → P0-5 → P0-2**。其中 P0-3 与 P0-4 可以并行（一个改 control-plane，一个加 surfaces 子命令），P0-5 只碰 `feishu-outbound.ts` + `http.ts`，也能并行。
其余项基本正交，可按人/按兴趣并行。

**唯一的冲突面**：`src/runner/dot.ts` 是最热的文件（本轮已被提示词工程 + 正文回喂改过），P0-2（流式）也要改它。**建议等该文件的外部改动先落定再动**，否则合并成本高于实现成本。

---

## 5. 怎么判断"到对标水准了"

不设"完成度百分比"，只设 5 个**可观测的行为判据**。任意时刻跑一遍就知道走到哪了：

| # | 判据 | 基线 `fb575f4` | P0 后 | P1 后 | P2 后 |
|---|---|---|---|---|---|
| 1 | **装起来**：全新机器从 clone 到 `doctor` 全绿 | 1–2 小时，3 处会卡 | ≤10 分钟 | ≤5 分钟 | ≤10 分钟（含真实容器） |
| 2 | **看得见**：ask 一个问题的首字延迟 | 整段憋出 | < 2 秒 | < 1 秒 | < 1 秒 |
| 3 | **干得成**：3 个"读文件 + 回答细节"的任务，答案正确率 | **0%（模型看不到全文）** | ≥ 2/3 | ≥ 3/3 | ≥ 3/3 |
| 4 | **不堵**：后台跑 30 分钟任务时，`dotd ask` 的排队时间 | 最长 30 分钟 | 最长 30 分钟 | < 2 秒 | < 2 秒 |
| 5 | **记得住**：一段 200 轮对话后，问第一轮讨论的内容 | 遗忘（无摘要） | 遗忘 | 答对 | 答对 |

**第 3 行是我最想强调的**：基线（`fb575f4`）的答案是 0%，因为模型只能看到工具结果的前 200 字。这不是"体验差"，这是"这个 agent 根本不可能完成需要读内容的任务"。**P0-1 是一行改动换来的从 0 到可用的跃迁**——它现在已经在做了，请务必用 P0-1 那一节的 `[真链路]` 判据去核对它**是真的跃迁了**，而不是"看起来跃迁了"。

**第 4、5 行是 P0 之后仍然刺眼的两格**：交付流式（P0-2）不解决排队，只有 P1-1 并发能解；而"记得住"在 P0 之后依然是遗忘——因为 **会话摘要从来没有生成过**（矩阵 §12 偏差 ①），这需要 P1-2。所以 P0 收工时请**如实宣告**：还有两格是红的，别让"P0 完成"被理解成"已经对标"。

---

## 6. 一句话总结

dotd 与 OpenAI/Grok 的差距，**不在安全与可靠性**（它在这两项上反而领先，见矩阵 §6/§7.4），而在于三件事：

1. **它让模型看不见**（工具结果 200 字）—— 1 小时的活，**已在做**；
2. **它让用户接不上**（11 名封闭词表，无 MCP）—— 1 个月的结构改造；
3. **它让别人装不起来**（12 步安装 + 单任务串行）—— 一系列的工程收尾。

第 1 件修完之后，最大的风险是**误以为问题解决了**：一个能看见工具结果的 agent，配上 1 的并发、没有的检索、没有的摘要、12 步的安装，仍然只是一个"能跑通的框架"。**P0 的真正价值不是那几个修复，而是它第一次让这个项目拥有"真实链路证据"——那是这份路线图最重要的产出，比任何功能都重要。**
