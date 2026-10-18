# 2026-10-17/18 优化批次：做了什么、凭什么说它成立

> 本文是这一批优化的**举证材料**。配套阅读：
> - [`benchmark-agent-capabilities.md`](./benchmark-agent-capabilities.md) —— 与 OpenAI / Grok 的能力对标矩阵（开工前的差距分析）
> - [`roadmap-to-parity.md`](./roadmap-to-parity.md) —— 往后怎么走（本轮之后还剩什么）
>
> 基线 commit：`fb575f4`（优化前快照）。本批分两轮：第一轮 `fb575f4 → b7e7ee5`（§1–§7），
> 第二轮执行路线图 P0/P1：`b7e7ee5 → 783d119`（§8–§13）。
> 写法约定：**每条改动都要能回答"改之前会发生什么"。** 只写"做了什么"而不写"原来的失效形态"的条目，
> 说明我还没搞清它为什么值得改，那种条目不该出现在这里。

---

## 0. 一句话结论

这一批不是加功能，是**把"看起来能用"变成"真的能用"**。八条主线：

1. **模型第一次能看懂这套系统**（工具说明书 + system prompt + 工具结果全文回喂）；
2. **真实链路第一次被证明**（真 TCP 的 HttpTransport 测试 + 假上游冒烟 + 真实缺陷修复）；
3. **四个会让人丢数据/丢任务的缺陷被修掉**（崩溃恢复重复执行、daemon 起不来、runner 协程停摆、任务卡审批无提醒）；
4. **新人第一天不再踩静默坑**（`dotd doctor`）；
5. **流式真的流起来，而且没有制造"假完成"**（§8：补上契约里缺失的工具调用通道）；
6. **长命令不再被看门狗误杀**（§9：心跳与"容器真的在推进"同源）；
7. **会话摘要与文件索引真的在工作**（§10/§11：摘要不再是 NULL，中文检索可用了）；
8. **记忆写入闭环真的闭环**（§12：WRITE-SEAL 的"补写一轮"从假动作变成真调用）。

门禁总账（两轮结束时实测）：`tsc` exit 0；全量 **1231/1231 通过、0 失败**；冒烟 **11/11** 与 **16/16**。

---

## 1. 让模型看得懂：指令质量（对标 OpenAI/Grok 的"指令面"）

### 1.1 问题：工具描述是模板串

改之前，`src/runner/dot.ts` 的 `toolSpecs()` 给每个工具的描述是：

```
工具 fs.read（mode=sync，sideEffect=safe）
```

模型拿到这 11 个工具，只知道"有这么个名字、大概是同步的"。它不知道：
`path` 该写相对还是绝对、`fs.write` 是覆盖还是追加、失败会返回什么、
`shell.run` 的退出码非 0 算不算失败。**11 个工具里能靠猜用对的只有 `fs.read`。**

### 1.2 改法

| 文件 | 内容 |
|---|---|
| `src/runner/tool-catalog.ts`（新增） | 11 个工具各一份说明书：何时用/何时别用、每个参数一行、成功与失败返回形状、错误码该怎么处理、执行形态（mode/sideEffect/截止时间） |
| `src/runner/system-prompt.ts`（新增） | `DOT_SYSTEM_PROMPT` + 工具优先级引导段，组装后 2122 字符 |
| `src/runner/dot.ts` | system prompt 进 `messages[0]`；`toolSpecs()` 走 `buildToolSpecs()`；工具结果**全文**回喂；补 `assistant.tool_calls` 配对 |

关键设计：**说明书与 schema 求交渲染**。宿主侧（`src/exec/protocol.ts`）与容器侧
（`agent-runtime/protocol.ts`）是两份手写 schema，历来有过差异（`fs.write.content_base64`、
`browser.snapshot.selector`、`net.*.headers`、`shell.run.cwd`）。说明书按**当前传入的**
schema 过滤参数行，schema 里没有的字段**不会**被教给模型——否则模型会填一个被
`additionalProperties: false` 拒掉的字段，白烧一轮。

### 1.3 顺带修掉的三个"模型能力"缺陷

这三条不是文案问题，是**模型真的拿不到信息**：

| 缺陷 | 改之前 | 后果 | 改之后 |
|---|---|---|---|
| 工具结果被截断 | `digestPreview(value, 200)`，只回喂前 200 字符 | `fs.read` 读回来的正文模型只看到开头，**等于盲操作**；`fs.list` 的目录项看不全 | 全文回喂（历史消息仍只存预览，S6 双写禁令不变） |
| 裸 `role:tool` 消息 | 工具结果直接作为 `role:'tool'` 消息 | OpenAI 兼容网关报 `messages with role 'tool' must be a response to a preceding message with tool_calls`，**整个请求 400** | 先补一条带 `tool_calls` 的 `assistant` 消息，再跟 `tool` 消息，`tool_call_id` 精确配对 |
| 没有 system prompt | `messages` 里的 system 只有零散注记 | 模型不知道自己是常驻 agent、不知道数据在 `/dot/home`、不知道该用中文、不知道审批会拦 | 一份运行手册式 system prompt（身份/平台事实/工作循环纪律/记忆读写/输出语言/何时问人） |

### 1.4 怎么证明它成立

`tests/runner-tool-catalog.test.ts`（14 条，新增），其中关键的几条：

- **防编造**：说明书里点名的每个参数名，必须真实存在于对应 schema（双向覆盖：schema 有说明书的每个参数也必须有说明）；
- **防退化**：11 个工具的 description 都不许是模板串、长度 > 80、互不相同；
- **防走兜底**：可选参数漏写会走到兜底文案，用例直接断言兜底文案不出现；
- **运行时**：真的发一次模型请求，断言 `messages[0].role === 'system'`、末尾是 user 目标、tool 消息是 `role:'tool'` 且紧跟 `assistant.tool_calls`。

---

## 2. 真实链路：第一次有证据

### 2.1 最值钱的一个真缺陷：三档超时全部失效

`src/router/transport.ts` 的 `rawHttp()` 把 `connect/idle/total` 三档定时器和 `finish()`
**都建在 `http.request(url, cb)` 的响应回调里**。而 Node 客户端在收到响应体**第一个字节之前
不会调用这个回调**（在 v24.13.0 上单独验证过）。

于是"上游接了连接、回了响应头、随后卡住不发正文"——**恰恰是这三个超时要防的首要场景**——
三个超时一个都不生效，调用方永久钉死。而 `res.destroy()` 不 `req.destroy()` 让事更糟：
没有任何事件落到 req 上，promise 永不 settle。

| | 结果 |
|---|---|
| 修前（HEAD 基线） | `HUNG — 6000ms 内既不返回也不抛错（idle_ms=300 / total_ms=1200 两个通道均未生效）` |
| 修后 | `REJECTED after 329ms -> idle timeout（300ms 无进展）(name=TransportError, kind=timeout)` |
| 修后连跑 3 次 | 333ms / 356ms / 339ms |

修法：生命周期提到请求对象上、按 socket 活动重置 idle、`finish` 摧毁 `req`、保留原始 errno `code`
（`classifyNetworkError` 按它归类）。

### 2.2 HttpTransport 端到端测试（34 条，新增 `tests/router-http-transport.test.ts`）

用 `node:http` 在 `127.0.0.1:0` 起**假 OpenAI 兼容上游**，让**真 `HttpTransport`** 打过去，零外网。
每条用例同时断言「客户端看到什么」和「上游收到了什么」——只断言一边等于允许空链路假装通过。

覆盖：非流式解析（含 `prompt_tokens_details.cached_tokens`）、SSE 逐块 + usage 尾部块 + Anthropic 形状、
401/403 → auth、429 + Retry-After → rate_limit(7000ms) 与 quota 分家、500/502 → server_error、
三档超时各自触发、空壳判据、声称流式却回 JSON、脏 JSON、两种断流、200 带 error、
以及三个集成用例让**真 ModelRouter 接真 HttpTransport** 走完整路由。

### 2.3 冒烟升级：daemon 全链路（11 → 16 条）

`scripts/smoke.mjs` 新增 `DOTD_SMOKE_FAKE_UPSTREAM=1` 分支（默认关闭，**原 11 条断言一字未动**）：
起一个真 `node:http` 假上游，把真 `config/models.yml` 的 tier1 `base_url` 改写到它，
daemon **不设** `DOTD_MODEL_TRANSPORT=stub` → 走真 `HttpTransport`。

```
[PASS] 假上游分支：daemon 真的通过 TCP 打到了上游 — 收到 3 个 /chat/completions 请求
[PASS] 假上游分支：全部请求走 POST /v1/chat/completions
[PASS] 假上游分支：tools 线格式合法（type=function / 名字已消毒 / stream:false）
[PASS] 假上游分支：Authorization 头按 api_key_env 真的上送 — 示例="Bearer smoke-fake-key"
[PASS] 假上游分支：上游回显的消毒工具名已还原为契约名（fs_write → fs.write）
冒烟结果：16/16 通过，退出码 0
```

### 2.4 真模型：仍然没验证，原因说清楚

`scripts/probe-live-model.mjs`（新增，上线前体检用，不进 `npm test`）：

```
connect:  未验证 — 环境变量 WB2API_KEY 不存在或为空
model:    hy3
tool_calls: 未验证（没有发出任何请求）
latency:  n/a
[附加] GET http://127.0.0.1:7863/v1/models → HTTP 401
       网关活着，只是拒绝未授权请求：这是"缺凭据"的直接证据。
```

**结论必须诚实：真实模型的往返一次都没跑过。** 卡点不是代码，是环境里没有凭据
（`127.0.0.1:7863` 端口通、`/v1/models` 返回 401）。`npm run doctor` 现在会把这条
直接判成 fail 并告诉你怎么修。

---

## 3. 会让人丢数据/丢任务的四个缺陷

### 3.1 崩溃恢复把"已执行"判成"可重放"（重复执行）

链路：`daemon.ts` 把执行面的 `interrupted` 一律映射成契约里的 `'aborted'`；而执行面里
`interrupted` 的真实来源是 `container_lost` / `aborted` / `not_found`——**都是"派发过、结局不明"**。
`journal.ts` 收到 `'aborted'` 直接 `markInterrupted` 并返回 `'replayed'`。

最要命的触发条件：看门狗在 `throttled/halted` 时会把容器 **pause**，容器状态变 `suspended`
→ 此后任何对账都报 interrupted → 已经执行过的 `rm` / `net.post` 被判"可安全重放"。

修法：`journal.ts` 改为按 `side_effect` 分流——只有 `safe` / `replayable` 直接重放，
`unknown` 全部 `deferred` + 转审批。用已有字段判定，**未扩契约**。

同时补了可观测性：`RecoveryReport.inFlightDeferred`，daemon 启动时打日志 + 写 OUTBOX，
让"有东西在等审批"和"这是崩溃恢复产生的"都能被主人看见。

### 3.2 一条任务对账失败会让 daemon 起不来

`recovery.ts` 的恢复循环原来没有 per-task try：一条任务对账抛错 → `recoverOnStartup` 抛 →
`cp.recover()` 抛 → `assembleDaemon` 抛 → **daemon 根本起不来**。

修法：per-task try + 失败进 `inFlightFailed` + 记 `recovery_failed` resource_event +
兜底 `reclaimInFlight` 回 queued（不停在 running 白占额度）。`reconcileCall` / `getCallResult` /
`forceApproval` 各自包 try，异常降级为未知而不是炸整体。

### 3.3 终态收口：任务 done 但读不到结果

`queue.finish()` 先 `fenceUpdate` 改状态、再 `writeResult`；后者抛错 → 异常回到 Runner →
`onFatal` 再 finish → 因 status≠running 记一个**误导性的 stale_writer**。
净效果：任务状态是 `done`，但 `task_results` 没有行，前端/CLI 读不到结果。

修法：`writeResultSafely`（try + `record(kind='watchdog', detail: writeResult_failed)`），
三处收口点改用它。**状态是权威，结果行失败只记账。**

### 3.4 常驻协程会永久停摆（"进程半死"）

`maxRunning=1` 下 `start()` 的 while 是**唯一**的消费者。而 `runNext()` 里 `cp.pop()` 在 try **外面**：
pop 抛错（`SQLITE_BUSY`、库损坏、库被占）→ 异常直穿 `start()`；`daemon.ts` 的 `runnerLoop`
只 catch 记日志、不重启。结果：队列从此永久静止，而 daemon 进程还活着、HTTP 还回 200。

另有一条：`onFatal` 里 `cp.finish` 抛错被空 catch 吞掉，任务停在 `running` 白占
`maxRunning=1` 直到看门狗 180s 回收，日志之外对用户零可见。

修法：`start()` 的每轮包 try + 指数退避（上限 60s）；`cp.pop` 挪进 try 返回 `'none'` 让位一轮；
`onFatal` 里 finish 失败后补一次 `failTask`，两条通道都失败才放弃（留明确日志交看门狗）。

回归用例在 `tests/runner-main.test.ts` 末尾（B / B2 / C 三条），断言包含：
pop 连抛 3 次后协程必须继续转、收口通道全断时每轮仍回到循环、finish 失败必须补 failTask。

---

## 4. 新人第一天不再踩静默坑：`dotd doctor`

`npm run doctor`（`scripts/doctor.mjs`，零依赖、只读、`--json` 可机读）。10 项体检，每项给
「人话结论 + 下一步命令」，只有 fail 才非零退出。

在最容易静默出错的地方，它真的拦得住（本机实跑输出节选）：

```
⚠️  DOTD_FLEET 实际生效值让人意外
     DOTD_FLEET 未设置 → 实际生效 stub（不起容器）。想跑真容器必须显式设 DOTD_FLEET=docker。
     这是本项目最容易误解的一处：模型传输的缺省是"真"，fleet 的缺省是"假"。
✅ DOTD_MODEL_TRANSPORT=（未设） → real-http
✅ openrouter-main http://127.0.0.1:7863/v1
     TCP 可连（6ms）
❌ 环境里没有 WB2API_KEY
     缺 key 不是启动期错误，但运行期请求会失败并计入熔断；tier1 是唯一能承载 primary 的端点
     → 下一步：把 export WB2API_KEY=... 写进 ~/.dotd/tokens.env，这样 daemon 重启后不会丢
⚠️  user_version=90，期望 100
     落后：daemon 启动时会自动迁移（会先写 OUTBOX）
```

设计上的两个细节值得记：
- `STRICT_ENV_KEYS` 只有四处（`DOTD_MASTER_TOKEN` / `DOTD_RO_TOKEN` / `HOOK_GRAFANA` / `DOTD_DB_PATH`）。
  `FEISHU_*`、`TG_BOT_TOKEN` 走非严格展开，**缺席是合法的**，不能误报成 fail——否则 doctor 会变成狼来了。
- 期望迁移版本从 `db/migrations/` 现算，不硬编码常量（硬编码的那条在 2026-10-17 就曾与实际脱节）。

---

## 5. 卡审批没人叫你：审批主动推送

审批 TTL 是 24h，任务在 `awaiting_approval` 时 Runner 让位、整个任务停着。
而飞书出站原来**只订阅 `task.state` 的 done/failed** → 任务卡审批时 IM 完全静默，
24 小时后审批过期、任务作废。这是"自主"看起来不自主的头号原因。

改法：出站订阅 `approval:created`，推一张能看懂的卡片：

```
需要你批准一件事（任务：整理这周的会议记录）

要做的操作：shell.run: rm -rf /dot/home/notes/old
风险档位：dangerous
为什么被拦下：危险命令命中规则
最晚决定时间：还有约 1 小时 0 分（过期自动作废，任务要重来）

回复「批准 42」放行一次；回复「记住 42」以后同类操作不再问；回复「拒绝 42」放弃。
（也可以直接在电脑上 npm run dotd -- approve 42）
```

顺手修掉的一个并发缺陷：bus 的 handler 是 fire-and-forget，同一 tick 内连投两次
`approval:created` 会起两个并发发送协程，只靠"已发 Map"防不住（两边都还没走到 `set`）。
加了 `inflight` 认领集，测试覆盖了这条。

---

## 6. 测试基建：从"假绿"到"真红"

| 项 | 改前 | 改后 |
|---|---|---|
| `tests/router-zero-usage-cache.test.ts` | 25/28（3 条稳定失败） | 29/29，且断言更严（新增"反向声明顺序"用例） |
| B2 用例（runner 循环存活） | 每轮都喂任务 → 热循环 → 负载机饿死成随机红 | 只喂 3 个后返回 null，断言不降，14.8ms 稳定通过 |
| `tests/` 文件数 / 用例数 | 49 / 1032 | 56 / 1138+ |

`router-zero-usage-cache` 那 3 条失败的根因值得记下来，因为它是一个**会反复重犯的测试写法**：

- `StubTransport` 的脚本是**每端点一个独立 FIFO**，而排序会把请求**集中**到排第一的端点
  → 另一端的预置永远不消费 → 先耗尽的一端抛错 → 被记 network 失败 → 连开熔断 → `AllEndpointsDownError`；
- "健康度打平"在数学上不可能（`0.6*成功率 + 0.4*延迟分`，延迟不同则分必不同）；
- 空库不是"打平"而是"没分"，此时 `pickCandidates` 整段跳过缓存项——原用例**从没读到过缓存项**。

修法改成**确定性构造**：健康样本经 `breaker.settle` 灌、缓存样本直接插 `model_call_log`、
每例只发 1 次 `complete`；并新增静态守卫 `tests/router-usage-shape.guard.test.ts`
（`Usage` 再加必填字段会让它先红）。

---

## 7. 第一轮结束时明确没做的（不要当成"已验证"）

> **第二轮已把下面 P0-2 / P0-3 两项做完**，见 §8 / §9。本节保留第一轮结束时的原始快照，
> 用来对照"当时的判断"与"实际做下来发现的事"——两者差距很大，本身就是一条教训。

| 项 | 第一轮结束时状态 | 说明 |
|---|---|---|
| **真模型往返** | ❌ 未验证 | 环境无凭据；`probe-live-model.mjs` 随时可跑 |
| **真 Docker 容器** | ❌ 未验证 | 本机原生 Windows 无 dockerd；daemon 要在 WSL 里才有真 fleet |
| **真实飞书链路** | ❌ 未验证 | 无 appId/appSecret；审批推送只在 fake gateway 上验过 |
| **P0-2 流式接 Runner** | ⏳ 当时判断"三层已就绪，缺一根线" | **判断错了**：实际缺的是契约里的工具调用通道，见 §8.2 |
| **P0-3 看门狗误回收** | ⏳ 当时判断"180s 阈值必误杀长命令" | 判断对，但**漏了** deadline 分叉这第二个缺陷，见 §9.3 |
| 并发（`maxRunning=1`） | ⏳ 未做 | roadmap P1-1；**必须等 P0-3 先修**（现在已具备前提） |

**一句话：本批把"证明得了的部分"做扎实了，但没有改变"真实容器 + 真模型的端到端仍未验证"这一事实。**
那需要一台有 docker 的 Linux/WSL 环境和一份模型凭据，不是代码问题。

---

# 第二轮：执行路线图 P0 与 P1（2026-10-18）

第一轮结束时，路线图里 P0 还差 4 项、P1 一项没动。这一轮把它们推到：**P0 5/5 完成，P1 3/6 完成**。
下面每条都按同样口径写——先写"改之前会发生什么"，再写证据。

## 8. 流式：补上契约里根本没有的"工具调用通道"

### 8.1 任务原本被理解成"接一根线"

`ChatChunk` 只有 `delta`/`done`，`HttpTransport.stream()` 的 SSE 解析只读 `choices[0].delta.content`；
`ModelRouter.stream()`、`chat.delta`/`chat.final` 主题、前端增量渲染**全都就绪**，只有 `src/runner/dot.ts`
没有消费。所以原计划是："在 `stepLlm()` 里换 `router.complete()` 为 `router.stream()`，20 分钟搞定。"

### 8.2 实际是什么（这是本轮最重要的发现）

主循环每轮都带 `tools` + `tool_choice:'auto'`。而**流式通道会把工具调用分片静默丢弃**。
用真 HTTP + 假 SSE 上游实测（上游只回 `tool_calls`）：

```
产出的 chunk 数 = 0
```

于是 Runner 把这轮当成"纯文本完结轮"（`toolCalls = []`）→ `ctx.done` 置真 →
**任务标记 done，但工具从未执行。**

这不是"没有流式"，这是**静默假完成**。比不流式严重得多：主人看到"做完了"，实际什么也没做。

### 8.3 修法：先补契约，再接线

| 层次 | 改动 |
|---|---|
| `src/shared/contracts.ts` | `ChatChunk.toolCalls?: StreamToolCallDelta[]`（**只加可选字段**，旧调用方零影响）；`ModelRouterApi.stream()` 增加 `toolCalls(): 成品[]` |
| `src/shared/tool-stream.ts`（新增） | `StreamToolCallAccumulator`——聚合规则**唯一实现**，跨 transport/router/runner 三处共用 |
| `src/router/transport.ts` | SSE 解析 `delta.tool_calls` → 增量下发；**按 `mapped.back` 把消毒名还原**（`fs_write`→`fs.write`，与非流式同一张表） |
| `src/router/ModelRouter.ts` | 每次尝试新建聚合器（换候选/换模型不串账）；空壳判据加"无工具调用"条件 |
| `src/runner/dot.ts` | `stepLlm` 拆 `streamLlm`/`completeLlm`，**共用同一个 catch**；工具调用等流结束才取、照常走 `stepTool` |

聚合器的 6 条容错（逐条有单测）：`index` 缺失归到当前槽 / 跳过不要求连续 / 整段下发与增量等价 /
`name` 拆片拼接且幂等重发去重 / `id` 缺失补稳定占位 `call_<index>`（**不伪造到已有调用上**）/
同 `index` 重发新调用顺延新槽。

### 8.4 顺带修掉的真缺陷：`feed()` 三重退化

旧 `feed()` 登记工具结果时**把调用声明一起删了**，`drainResults()` 再查就永远查不到。一处遗漏，三重退化：

1. `dispatched` 恒 false → 本轮结果被当成"恢复期补跑的历史结果"，**不进 tool 通道**，降级成一条 system 注记；
2. `assistant.tool_calls` 声明整段消失 → 下一轮 `role:tool` 成了**没有前置声明的无主消息**，OpenAI 兼容网关直接拒；
3. 参数退化为 `{}` → **模型看不到自己当初传了什么**，改参重试与基于上次结果的决策全部失去依据。

为什么长期没暴露：`noteToolCalls()` 按**模型给的 id** 登记，`stepTool` 用 **journal call_id** 派发，
两者在真实链路上并不相等。修法：`feed()` 只在**缺失时**补登记（不覆盖模型原样串），并传入
`calledWith`（真正交给 exec 的那份参数，已补 `/dot/home` 前缀），所以回喂给模型的 `arguments` 与它当初的执行输入逐字一致。

### 8.5 证据

`tests/runner-stream.test.ts` 11 条 + `tests/shared-tool-stream.test.ts` 10 条，全绿。最关键的一条：

```
✔ ④ 防假完成：流式回合里模型返回 tool_calls → 工具确实被执行，任务不提前 done
  两轮都走 stream（chat 0 次）→ 工具执行恰好 1 次且 call_id 与 journal 一致 →
  第二轮请求里 role=tool 与 assistant.tool_calls 严格配对 →
  参数 JSON 由增量分片逐字拼回 {"path":"/dot/home"}
```

零回退的三条路径各有断言：无 `stream` 方法 → `complete()` 被调用（spy）；`DOTD_STREAM_CHAT=off` → 同上；
未注入总线 → 逐字退回 `complete()`、不发布任何 `chat.*`。

---

## 9. 看门狗：长命令不再被误杀

### 9.1 改之前

`heartbeatTimeoutMs = 180_000`，而心跳**只在每个工具轮结束时**写一次（`afterStep`）。
`await exec.runTool(...)` 在途期间心跳完全静止。async 工具允许跑 30 分钟——
**任何超过 3 分钟的工具调用必被看门狗判成卡死并回收**：side effect 已落地，任务回 queued、`attempt+1`、从第一步重跑。

A/B 实测（同一套测试、同一虚拟时钟，不 sleep 200s）：

```
HEAD   outs=aborted(stale_writer/abort) task=queued attempt=1 shellStep=succeeded execCount=1 watchdogReclaims=1 deadlineMs=60000
FIXED  outs=done                        task=done   attempt=0 shellStep=succeeded execCount=1 watchdogReclaims=0 deadlineMs=1800000
```

读法：HEAD 里工具**成功返回、副作用已落地**（`execCount=1, shellStep=succeeded`），但 180s 时被回收 → 重跑 = **同一件事干两遍**。

### 9.2 修法：心跳必须与"容器真的在推进"同源

否决了 Runner 侧 `setInterval`（那是无脑续命，Runner 卡死时定时器可能还在跳）。
采用**轮询驱动**：只有每轮 `GET /jobs` **成功且报 `running`** 才续一次心跳。
四种情况**一律不续** → 心跳自然停 → 看门狗按 180s 照收：

1. `getJob` 抛错（容器挂/网络断）；2. 容器被判 `unhealthy/lost/removed`；3. 本地 deadline 到达；4. 读到终态。

接缝是 `ExecServiceDeps.liveness`（EX 不 import CP、不直写 `tasks`，符合模块边界）。

### 9.3 顺带修掉的第二个真缺陷：deadline 分叉

`pollJob` 用的是 Runner 传来的 `toolDeadlineMs`（缺省 **60s**）——所以"允许跑 30 分钟"以前**只是文档里的话**：
3 分钟以上的工具根本轮不到看门狗，本地 deadline 先标 timeout 然后重跑。
`CAPABILITY_CATALOG` 里早就声明了 `shell.run.max_deadline_ms = 1800000`，`validateToolCall` 只校验、从来不替你抬。
现在按 catalog 的 `mode` 选档：async 用目录声明的上限，sync 仍是 60s（一字不改），未登记工具保守按 sync。

### 9.4 真卡死仍会被回收（阴性证据）

```
✔ 阴性：前 150s 上游在推进、之后真卡死 → 180s 后看门狗照常回收（interrupted + queued + attempt+1）
✔ 阴性：续过心跳也救不了真卡死——最后一次推进后 +181s 必回收（心跳只认上游推进）
✔ 端到端：上游卡死 → 工具步 failed、execCount=0、心跳停写 → 180s 后照收
```

### 9.5 顺带修掉的第三个真缺陷：`interrupted` 从未落库

看门狗回收里 `skipStep()` 之后那条 `UPDATE steps ... status='interrupted'` 是**空操作**（同一 call_id 已被改成 skipped）。
这不只是死语句：`skipped` 的契约语义是"治理拒绝/审批过期、从未打算执行"，而 Runner 重建上下文时
**只对 `interrupted` 步注入恢复注记**（"上一步结果未知，先观测再决定"）——`skipped` 不注入，
模型下一轮会以为没发生过、直接重做。已改为先 `started → interrupted` + `result_json='watchdog_reclaim'`，
`skipStep` 只在并发竞态下兜底。

---

## 10. 会话摘要：从"永远 NULL"到真的生成

改之前：`MemoryService.updateContextSummary()` 写好了，但**全仓库零调用方**。`buildContextBundle` 里
`thread.context_summary` 恒为 null → 会话超过预算只能硬截断——**"越聊越忘"，而且静默**。

修法两个关键决策：
- **生成走注入的 `summarize` seam**（`src/memory/types.ts`），MEM 模块**零 HTTP**；daemon 把它接到 `router.complete({ track:'light' })`；
- **触发点在 Runner 收口前**（补写轮之后、`finish` 之前），`upto_seq` 取"被覆盖的最后一条消息的 seq"（精确值），
  下一次只喂 `upto_seq` 之后的新消息 + 旧摘要（增量摘要，不重复整段会话）。

实现中修掉一个自己引入的边界 bug：`upto_seq` 覆盖到末尾时不能把消息列表清空，否则"会话部分恒空、摘要永远放得下"，
与 §4.2 的砍序自相矛盾。验收 `tests/memory-context-summary.test.ts` 10/10（含"消息量不够 → 不摘要、不花模型调用"的零打扰用例）。

---

## 11. 记忆检索：FTS5 + 中文 bigram（零依赖）

### 11.1 问题一半在 SQLite 不在我们

实测 SQLite 3.50.4：

```sql
-- unicode61 把整段连续中文当一个 token
INSERT '这是一条会议记录';  MATCH '会议'  →  0 条
```

所以"打开预留的 FTS5"这句话本身不够——**不做 CJK 切分，中文检索仍然不可用**，而主人用中文。

### 11.2 方案与取舍

用 **bigram 纯函数**（`src/memory/cjk-tokenize.ts`）：`这是一条会议记录` → `这是 是一 一条 条会 会议 议记 记录`；
拉丁/数字整词小写；单字中文保留自身（否则单字查询永远 0 命中）；查询侧逐 token 加引号（防 `AND/OR/NEAR` 被当运算符）。

**没有**采用"外部内容表 + 触发器"这一原设想，三条实测理由：
1. 外部内容表要求索引内容与 `mem_messages.content` 逐字相同，而我们写的是 bigram 文本 ≠ 原文，
   `snippet()` 会读回未切分原文并按"整段中文 = 一个 token"高亮，把优势还回去；
2. 触发器里调不了 JS → 必然出现 SQL 写/JS 查两套切分实现，**必然漂移**；
3. 代码侧双写让写入与查询**共用同一个纯函数**。

代价写进迁移包头注：绕过 `MemoryService` 直接 `INSERT mem_messages` 的调用方需同步索引，
由 `ensureMessageFts()` 数量对账 + `resyncMessageFts()` 兜底（首次探测自动对账一次）。

### 11.3 降级不静默

`ftsProbe()` 查表存在性并实测 `count(*)`；表被 DROP / 老库 / 查询抛错 → 回落**原 LIKE SQL（逐字保留）**，
结果不丢；并写 `mem_maintenance_state` 的 `fts_degraded_count`（自增）与 `fts_degraded_last`（`{reason, at}`）。
测试断言了计数递增与 reason 内容——**降级是可见事件，不是静默降级**。

### 11.4 `rankManuals` 加 TF-IDF，并给出反例

`final = Σ weight(标题/路径×2、tag×1) × (1+ln tf) × idf`，`idf = N/(1+df)`。

反例（同一组输入，旧算法 vs 新算法）：旧算法把噪声手册 `manuals/dotd misc.md` 排第一、
真实相关文档 `manuals/release.md` 排第三；新算法 `release.md` 第一（3.0 vs 2.0）。
原因：旧算法只认"命中位置数"，`dotd` 这类每篇都有的噪声词没有惩罚。

过程中抓到两个真 bug：`isCjk()` 正则带 `g` 标志导致 `lastIndex` 状态污染（`"WSL"` 第二次调用被切成 `"WS","SL"` → 英文检索 0 命中）；
`countHits` 传参语义用错导致 weighted 分量少算。都已修并加回归断言。

验收 `tests/memory-fts.test.ts` 37/37。

---

## 12. WRITE-SEAL：让"补写一轮"真的发生

### 12.1 改之前是个假动作

`sealTask` 由 CP 的钩子在 `queue.finish()` **内部**调用——那一刻任务已终态、Runner 主循环已退出。
它追加的那条 `SEAL_REMINDER_TEXT` 消息**永远不会有下一轮 LLM 去读**。所谓"补写一轮"从未发生，
消息只会在下次同 thread 的任务里当历史噪音。

叠加根因：daemon 的 `journalMemoryProbe` 返回 `fs.write:<callId>`（**没有路径**），
而 MEM 侧按 `/dot/home/{MEMORY.md,notes/,manuals/}` 前缀判定 → **永远判不出"写过"**，
于是每个成功任务都被误报 missed。

### 12.2 修法：把判定提前到 finish 之前

`needsMemoryRedo()`（只判定、不写库、不抛）由 Runner 在 `cp.finish()` **之前**调用；该补就跑一轮
**只给一次机会**的受控回合——请求体**不带 tools** + `tool_choice:'none'`；模型若仍发 tool_calls，
走**同一个 `stepTool`**（治理/幂等/journal 全照常，不绕过任何门）；一轮即止，绝不循环追问。
补写轮的 `fs.write` 因此落在任务**仍 running** 的时间窗内，journal / 心跳 / epoch 围栏全部照常成立
（测试 ①b 直接钉住"补写轮发出时任务状态仍是 running"）。

`src/memory/step-paths.ts`（新增）从 `args_json` 还原真实路径，修掉"永远判不出写过"。

### 12.3 默认值纪律

`memoryRedo` 默认 **false**（= 既有行为逐字不变），`daemon.ts` 显式传 `true`。
三条守卫钉住：默认值不得变、传 true 时补写轮真的发生、静态守卫禁止改回 `?? true` 或装配漏传。
这条默认值裁决是有代价的：它一度让两条老用例（"两次 LLM 步"）变红——正确做法是改默认值，
而**不是**去改老用例的断言。

验收 `tests/memory-seal-redo.test.ts` 12/12。

---

## 13. 第二轮的门禁总账

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p .` | exit 0 |
| `npm test` | **1231 / 1231 通过，0 失败** |
| `node scripts/smoke.mjs` | 11/11 |
| `DOTD_SMOKE_FAKE_UPSTREAM=1 node scripts/smoke.mjs` | 16/16 |
| `tests/runner-main.test.ts` 三连跑（并行 4） | 245/245 × 3（含记忆用例） |

对比第一轮结束：1172 → **1231** 用例（+59），失败 0 保持。

一条诚实的记录：全量并行跑过一次 `1230/1231`，失败项是 `memory-inject` 的
「summary 放不下时整段丢」（纯 `buildContextBundle` 预算判定，无墙钟/IO 依赖）。
分诊结果：单跑 3 次全绿、与含真定时器的文件并行 2 次全绿、复跑全量全绿——
判定为全体 1231 用例并行时的偶发调度抖动，**不是逻辑缺陷**；保留记录以便日后若复现再追。

---

## 14. 仍然没做 / 没验证的（不要当成已完成）

| 项 | 状态 |
|---|---|
| **真模型往返** | ❌ 仍未验证。环境无 `WB2API_KEY`（:7863 返回 401）。`npm run doctor` 会直接判 fail |
| **真 Docker 容器** | ❌ 仍未验证。本机无 dockerd，daemon 需在 WSL 里才有真 fleet |
| **真实飞书链路** | ❌ 仍未验证。审批卡片只在 fake gateway 上验过 |
| **P1-1 并发**（`maxRunningTasks=1`） | ⏳ 未做。**依赖已就绪**：P0-3 修完后"心跳在途静止"不再是常态，可以安全开并发 |
| **P1-5 `net.get/net.post` 落地 + 搜索工具** | ⏳ 未做 |
| **P1-6 可观测性**（结构化日志 + 成本口径） | ⏳ 未做 |
| **P2**（MCP 客户端 / 显式计划 / 部署 3 步） | ⏳ 未做 |

---

# 第三轮：P1 剩余三项 + P2 全部三项（2026-10-18）

第一轮结束时 P1 3/6、P2 0/3；第二轮补到 P1 6/6；这一轮把 **P2 3/3** 做完。
至此路线图 P0/P1/P2 共 14 项**全部完成**，矩阵里"12 项落后"收缩到只剩刻意选择与需要环境才能验证的部分。

## 15. 并发：饿死是结构性的，调大数字没用

`pop()` 第一行就判额度——**额度一满，连看 `ORDER BY priority` 的机会都没有**。
所以 `maxRunningTasks` 调多大都治不了：后台只要再次占满，对话又被饿死。

两条互补通道：① `interactiveReserve` 预留格（有界，用完不再突破）；② `preemptiblePriority` 抢占
（把最晚开始的后台任务退回 queued，**attempt 不变、不记失败**）。

顺带补上两处**原本没有的闸**：
- **端点生产并发**：`ModelRouter` 唯一的闸只对 `local` 端点生效、且只在 tier2 分支调用——
  **Tier1 主路径完全没有闸**，单并发端点下并发必然失败（实测修复前峰值 2/3，修复后严格 1）。
- **容器内工具闸**：`browser.*` 每容器 1 / `shell.run` 2 / `fs.*` 不限，超限排队、超时降级为
  `container_busy`。挂在校验通过、`call_sent` 之前——排队期间 `exec_calls` 无记录，
  幂等/ledger/对账语义**完全不变**（`ExecService.ts` 相对 HEAD 零删除行）。

抢占后接既有 `journal.reconcileAndResolve` 对账，不留 `started` 孤儿步——否则"抢占"就等价于"制造 unknowns"。

**默认值全不变**：`maxRunningTasks=1`、两个新键默认 0、`containerJail` 全 0；显式开，非法值拒启动。

## 16. `net.*` 曾经是"看得见、调不动"，搜索判断为不做

容器侧 `agent-runtime/server.ts` 原文直接 `return errorResult(..., not_implemented, "阶段二实现")`——
工具目录里有 `net.get`、说明书写着能用，**实际永远失败**。现已在 `agent-runtime/net.ts` 实现。

**默认关闭**（`DOTD_NET_TOOLS` 不设 = off；`get` = 只读；`all` = 含 POST；**拼错按 off 处理 + 告警**，
绝不因拼错意外放开出网）。三道护栏：仅 http/https、SSRF 拒内网与云元数据、不跟随重定向 + 4MB + 30s。

SSRF 防护第一版就踩了个真坑：`new URL('http://[::ffff:127.0.0.1]/').hostname` 返回的是
**`[::ffff:7f00:1]`**——URL 解析器把 IPv4 映射地址规范化成了十六进制，只按点分正则判会漏掉整个映射面。
测试抓到了它。

**Web 搜索：判断为不做。** 本机实测 DuckDuckGo / Google 全部连接超时；唯一能通的 Bing 连发 5 次返回
**与查询无关**的结果（查 `dotd agent harness` → 返回"DiskGenius 数据恢复软件"）。把这种结果喂给模型
**比没有搜索更糟**；要做稳就得接付费 API，违反"唯一外部依赖是可换 base_url 的模型 API"。
替代方案：`net.get` + 一份判据手册（优先直连权威数据源、禁止抓搜索引擎网页、**明令禁止用 shell curl 绕过开关**）。

## 17. 可观测性：`task --verbose` 回答主人的三个问题

补上 README 明写"路由待补"的两条路由，`dotd task <id> --verbose` 现在直接给出：

```
花了多少：从第一步到最后一步共 6.1s（其中模型调用 5.8s、工具执行 350ms）
  token：输入 2020 + 输出 215 = 2235，模型调用 2 次（其中 1 次走了降级端点）
卡在哪：第 4 步（net.get）失败——net_blocked_host: 拒绝访问 127.0.0.1
每一步：
   1. 模型调用              3.2s  succeeded  820+120 tok
   4. net.get          200ms  failed  ✗ net_blocked_host: 拒绝访问 127.0.0.1
```

成本全部取自 `model_call_log` 现成字段、按契约 J1（`attempt_id = llm 步 call_id`）关联，未重造口径。

## 18. MCP：从"加一个工具等于 fork 内核"到"接得上"

**三个判断**（按重要性）：

1. **MCP server 跑宿主**。容器是 ReadonlyRootfs + 无包管理器，装不了任意 server；而"接上我的东西"
   本来就是指跑在主人自己机器上的脚本。隔离不靠容器靠治理——代价是 server 拥有宿主权限，
   由"默认关闭 + 白名单 + 每次审批"承担。这是**有意的取舍**，不是偷懒。
2. **一个网关工具 `mcp.call`，不做动态展开**。最硬的理由是安全：动态工具名会让工具词表变成
   运行时可变的，而治理靠 `tools.yml` **预先登记**做默认拒绝——展开后模型能调到没登记过的名字，
   **默认拒绝就破了**。
3. **档位 `dangerous` 而不是 `spend`**。spend 要求固定字段，MCP 参数是任意的、写不出来；
   dangerous 才是一律人工审批、不参与批量批准、应急模式冻结。

**默认关闭有结构保证**：`visibleCaps()` 是唯一出口，未启用时把 `mcp.call` 过滤掉，不靠调用方自觉。

端到端取证（真 stdio server、真治理、真审批）：

```
✔ 模型看到 mcp.call → 派发 → 治理拦截 → 审批 → 真打到 server → 结果回模型
  （审批单 tier=dangerous；第二轮模型请求里真的带着 {"sum":42}）
```

顺带修掉一个会让 **daemon 优雅关停卡死**的真缺陷：MCP 子进程钉住事件循环（测试进程卡住 5 分钟+）。

## 19. 显式计划：可观测的产物，不是控制流

dotd 的卖点就是"不是固定 DAG、由模型在运行时决定下一步"。所以计划**不能变成强制驱动执行的流程**——
做成那样等于把最值钱的东西换掉。

计划只做三件事：① 每轮作为 system 注记进上下文（抗跑偏）；② 落 thread 供 `--verbose` 展示；
③ 由模型自发修订（版本 +1、历史保留）。有一条专门用例钉住边界：

```
✔ 不是控制流：模型完全不照计划走，任务照样正常收尾
```

落点选 **thread 消息**：`mem_messages.kind` 的 CHECK 白名单写死在已发布迁移（契约 D2 不许改），
而 `steps.kind` 会计入步数上限、被孤儿步对账当成在途步——**计划不是执行步**。

成本实测**每轮 +50 tokens**，真正成本是一次额外调用写计划 → **默认关闭**（`DOTD_PLAN=on`）。

## 20. 部署：最值钱的发现是"有一步根本不需要"

原流程被描述为 12 步。逐个核对后发现：**「构建镜像」这一步根本不需要**——
`fleet.ts` 在 boot 时缺镜像即自动构建（`ensureImage`），`wsl-build-image.mts` 只是可选预热。

12 步里只有 **3 步必须人做**：装 Node ≥24、给模型 key、声明 fleet 意图（"要不要真容器"是**意图**不是检测结果）。

`npm run setup`：幂等、可重入、每步**检测而非假设**，**不替你 `docker pull`、不覆盖 `tokens.env`**；
`doctor` 是**唯一真相源**（setup 直接 import 它的检查函数，退出码服从它）。
真跑三次，`config.yml` 与 `tokens.env` 的 SHA256 与 mtime 完全未变。

过程中修掉三个真 bug：`npm install` 在 Windows 上被误判失败（`npm` 是 `.cmd`）、
**setup 的退出码不服从 doctor**（doctor 明明 fail 却回 0）、
**doctor 看不到 `tokens.env` 里的值**造成"装好了却报缺 key"的假警报（我第一遍真跑就出现 4 个假警报）。

**明确不做二进制 / npm 发布**：差的不是工具而是"人要知道下一步敲什么"。单文件二进制**一步都省不掉**
那 3 个人工步骤，而 dotd 真正的重量在 2GB exec 镜像和 WSL——一个 60MB 单文件对此近乎零帮助，
却要把 `node:sqlite` 实验特性、动态 import、跨平台签名全变成打包风险。

## 21. 第三轮门禁总账

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p .` | exit 0 |
| `npm test` | **1394 / 1394 通过，0 失败**（134 suite） |
| `node scripts/smoke.mjs` | 11/11 |
| `DOTD_SMOKE_FAKE_UPSTREAM=1` | 16/16 |
| `npm run setup` | 真跑三次幂等；退出码 1（= 环境里 2 个真实缺口，与 doctor 一致） |

用例数三轮轨迹：1032（基线）→ 1138 → 1231 → 1313 → 1334 → 1394，**失败数全程 0**（除基线那 3 条假红外）。

---

## 22. 路线图终态与剩余项

| 档 | 完成 | 说明 |
|---|---|---|
| **P0** | **5/5** | 让已有的东西真的能用 |
| **P1** | **6/6** | 从"演示级"到"日常可用级" |
| **P2** | **3/3** | 差距最大的三板斧（MCP / 计划 / 部署） |
| P3 | 未做 | 长线项 + **刻意不做**的清单（商业托管、云端持久化等，见 roadmap §3.2） |

**这轮之后仍然没变的唯一短板**：真模型往返、真 Docker 容器、真实飞书，**三样一次都没跑过**。
不是代码问题——本机没有 `WB2API_KEY`（`:7863` 返回 401），原生 Windows 没有 dockerd。
`npm run setup` 与 `npm run doctor` 已经把这两个缺口变成**可执行的下一步**，一有环境就能验证。


---

# 第四轮：接上真实模型，端到端第一次跑通（2026-10-18）

前三轮结束时，**真模型往返、真 Docker 容器、真实飞书**三样一次都没跑过——那是唯一没变的短板。
主人给了可用的模型接口（`http://127.0.0.1:3065/v1` + key），这一轮把它接上并**真的跑通了任务**。

## 23. 接上的过程（每一步都是实测，不是推测）

### 23.1 先说一个只有实测才会发现的事：这个网关上各模型的工具调用能力不同

`GET /v1/models` 返回 10 个模型。逐个带 `tools` 打一次最小请求：

| 模型 | `finish_reason` | 是否返回 `tool_calls` |
|---|---|---|
| `hy3` | `stop` | **否**——只出文本，工具调用被吞掉 |
| `deepseek-v4.1-flash` | `tool_calls` | **是**，`arguments` 是合法 JSON |

这一条直接决定配置怎么写：主循环每轮都带 `tools` + `tool_choice:'auto'`，
**primary 轨必须是真能调工具的模型**——否则工具永远不执行，任务看起来"做完"了但什么都没干。

所以 `config/models.yml` 的 tier1 改成 `base_url: http://127.0.0.1:3065/v1`、
`primary: deepseek-v4.1-flash`，并把 `glm-5.3-flash` / `Qwen3.8-Flash` 放进模型级 fallback 链。

### 23.2 真模型往返：从"未验证"变成"通过"

`node --import tsx scripts/probe-live-model.mjs`（key 在环境里）：

```
端点      openrouter-main（tier1, style=openai）
base_url  http://127.0.0.1:3065/v1
模型      deepseek-v4.1-flash

connect:  成功（HTTP 往返完成）
model:    deepseek-v4.1-flash
tool_calls: 是（1 个，name=fs.read 已还原为契约名，arguments=合法 JSON {"path": "notes/probe.md"}）
latency:  1845ms
```

## 24. 端到端真跑：一个任务，35 步，暴露了两个真缺陷

起 daemon（临时 `DOTD_HOME`，不碰真 `~/.dotd`），通过 `POST /api/messages` 提交中文任务。
**模型真的在工作**：`model_call_log` 里 8 次真实调用，`endpoint_id=openrouter-main`、
`model=deepseek-v4.1-flash`、`prompt_tokens` 6147 量级、延迟 1–4.5s——这条链路是真通的。

但任务跑了 **35 步**、`fs.write` 连试 3 次全失败，模型最后放弃并反问主人。查下来是两个真缺陷。

### 24.1 缺陷一（严重）：记忆层写检查点拦下了所有 home 路径

`MemoryService.beforeWrite` 对任意 `fs.write` 都跑记忆规则，而记忆规范只管
`MEMORY.md` / `notes/*.md` / `manuals/**` 三处。写其余路径时 `classifyHomeArea` 返回 null
→ 直接 `HARD_LIMIT`，错误信息还是"路径不在记忆规范内"。

实测的两个失败形态：

```
fs.write {"path":"notes/hello.md"}           -> HARD_LIMIT「note 命名须为 YYYY-MM-DD-<slug>.md」
fs.write {"path":"/dot/home/notes/hello.md"} -> HARD_LIMIT「非法 home 相对路径」
```

第一件其实是对的（notes 确实有命名规范），但**模型不知道**；
第二件暴露的是**说明书与真实护栏矛盾**：工具描述写着"可写相对路径或 `/dot/home/...` 绝对路径"，
而真护栏只认相对路径。更要命的是普通工作文件（`reports/weekly.md`）也会被拒——这是纯粹的误拦。

修法分两层，**安全边界一步不让**：
- 记忆层只在自己管辖范围内施加规则（新增 `isMemoryPath`，判据只维护一份）；
- 形状非法（绝对路径、`..` 逃逸、盘符）**仍然拒**——这是安全边界，执行面同样会拒，两层都守；
- 工具说明书改成与真实护栏一致，并**把 notes 的命名规范写进 description**，让模型第一次就知道。

### 24.2 缺陷二：冒烟脚本把端点地址写死了

`scripts/smoke.mjs` 的假上游分支用正则匹配 `http://127.0.0.1:7863/v1` 来改写 `base_url`。
主人换一次端点，这条分支就**静默失效**（exit 2），而它恰恰是"真 HTTP 链路"唯一的端到端证据。
改成按 YAML **结构**定位（`endpoints` 段里第一条 `tier: 1` 且 `enabled` 的端点）。

## 25. 修复前后的决定性对比（同一类任务）

| | 修复前 | 修复后 |
|---|---|---|
| 步数 | **35 步** | **4 步** |
| `fs.write` | 3 次全失败 | **succeeded，59 字节** |
| 结尾 | 模型放弃并反问主人 | `已创建 reports/weekly.md，内容就是你要的三行` |

修复后的实测：

```
steps: 1:llm=succeeded | 2:tool:fs.write=succeeded | 3:llm=succeeded | 4:llm=succeeded
[last fs.write] succeeded -> {"path":"/dot/home/reports/weekly.md","size":59}
[reply] 已创建 reports/weekly.md，内容就是你要的三行（周报 / 真实模型端到端验证通过 / 日期 2026-10-18）。
```

**另一个值得记下的现场**：第一次提交任务时我自己的 UTF-8 编码出错，中文变成问号发给模型。
模型没有瞎猜，而是**停下来反问**"你的消息里出现了乱码，我只能看到一个大概的意思……
麻烦你确认两点"。这正好验证了 system prompt 里"目标有歧义且猜错代价大时要停下来问"那一条是有效的。

## 26. 第四轮的门禁总账

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p .` | exit 0 |
| `npm test` | **1399 / 1399 通过，0 失败**（连跑 4 次全绿） |
| `node scripts/smoke.mjs` | 11/11 |
| `DOTD_SMOKE_FAKE_UPSTREAM=1` | 16/16 |
| `probe-live-model.mjs` | **真模型往返通过**（tool_calls 合法） |
| daemon 真跑 | **任务 done，fs.write succeeded** |

## 27. 现在的真实状态

**真模型往返：✅ 已验证。** 这一条从"零证明力"变成了"真跑通过"。

**真 Docker 容器：❌ 仍未验证。** 本机原生 Windows 无 dockerd；`doctor` 会如实报
`DOTD_FLEET 未设置 → 实际生效 stub`。任务里看到的 `fs.list` / `shell.run` 成功都来自 stub 容器
（所以 `date` 返回的是 `(stub) ok`，不是真实日期）——这一条必须说清楚，不能因为任务 done 就当成容器也通了。

**真实飞书：🟡 半验证。** daemon 启动日志显示"飞书凭证校验通过""飞书长连接已建立"，
但**没有做一次真实的收发往返**（那需要主人那边确认收到了消息）。

**下一步就一件事**：在一台有 docker 的 Linux/WSL 机器上 `DOTD_FLEET=docker` 起一次。

### 27.1 我为什么当时没能启动真容器（现场记录，2026-10-18 上午）

我先前的判断"本机无 dockerd"是**错的**——我只看了原生 Windows，没查 WSL。实际：

```
wsl -l -v          → Ubuntu-24.04  Running
wsl docker version → 29.1.3          ← dockerd 活着
wsl docker ps -a   → dotd-dot-dot1   Exited (255) 12 hours ago
                     probe-x         dotd/exec:1.49.1-0.1.0
```

也就是说 **dotd 的容器以前真的在 WSL 里跑过**，镜像 `dotd/exec:1.49.1-0.1.0` 也在。

但这次跑不动，根因是**内存**，不是配置：

| 观测 | 值 |
|---|---|
| WSL 内存上限（`.wslconfig`） | `memory=24GB` |
| netfuzz fuzz 集群 RSS | ~20GB（十几个 libFuzzer，各 `-rss_limit_mb=2048`、`-max_total_time=43200` 即 12 小时） |
| WSL 内 `MemAvailable` | **4GB** |
| `vmmem` 进程占用 | **23.7GB** |

在这个状态下，连 `wsl.exe -e echo ok` 都要 **54 秒**然后报 `WSL_E_SERVICE_STOPPED`。
`.wslconfig` 的注释自己记着这台机器历史上多次因内存耗尽被 Windows 杀掉 vmmem——
"each time wiping the whole fleet"。**fuzz 集群与 dotd 容器不能同时跑，这是硬约束。**

按主人指示把 fuzz 进程 `renice 19` + `ionice -c3` 之后，CPU 优先级问题解决了，
但**内存问题解决不了**（nice 不释放 RSS），所以真容器验证仍然跑不动。

### 27.2 为此交付的东西：`scripts/live-wsl-e2e.sh`

一条命令在 WSL 里跑完整验证，**前置条件逐项检查并给出可执行的下一步**（不满足就明确告诉你缺什么）：

```bash
# 在 Windows 侧先起 relay（WSL 的 127.0.0.1 够不着 Windows 的模型服务）
node --import tsx scripts/win-relay.mts     # 13065 -> 127.0.0.1:3065

# 在 WSL 里
bash scripts/live-wsl-e2e.sh
```

七步：前置检查（docker / node / **MemAvailable ≥ 3GB**）→ 凭据与端点（自动把 tier1 指向 relay）
→ `DOTD_FLEET=docker` 起 daemon → 提交真任务 → 等终态 → **真容器证据**（`docker ps` 看容器、
`docker exec` 读回模型写的文件）→ 汇总。退出码 0 = 端到端通过。

特别地，它会在内存不足时**直接拒绝跑并说明原因**，而不是让你对着一个超时去猜——
这正是这轮踩的坑。

### 27.3 ✅ 真容器端到端跑通了（2026-10-18 11:08）

主人授权停掉 netfuzz 之后，真容器验证**一次通过**：

```
==> 1/7 前置检查
	OK   docker 29.1.3
	OK   node v24.22.0
	OK   MemAvailable 21007MB
==> 2/7 凭据与端点
	OK   WB2API_KEY 已设置（长度 39，形态 sk-a2a…）
	OK   鉴权通过：模型真的回了一次（chat/completions 200）
==> 3/7 起 daemon（DOTD_FLEET=docker）
	OK   daemon 就绪（约 9s）
==> 5/7 等终态
	OK   status=succeeded
==> 6/7 真容器证据
	OK   容器 ba445a9bc564 存在
	真容器验证
	WSL 里的 dotd
	日期 2026-10-18
==> 端到端通过：真模型 + 真容器，任务 done 且容器内文件可读回
```

数据库里对应的两条真步骤：

```json
{"seq":1,"kind":"llm","status":"succeeded","sideEffect":"safe"}
{"seq":2,"kind":"tool","toolName":"fs.write","status":"succeeded",
 "resultJson":"{\"path\":\"reports/wsl.md\",\"size_bytes\":50,\"written_at\":\"2026-10-18T03:08:21.635Z\"}"}
```

**这意味着 `docs/roadmap-to-parity.md` §0.3 里"真 Docker 容器 ❌ 仍未验证"这一条可以划掉了。**
现在三条真链路的状态是：真模型 ✅ / 真容器 ✅ / 真飞书 🟡（长连接已建立，收发往返未验）。

### 27.4 过程中暴露并修掉的三个真问题

这一轮不是"跑一下就完事"，每一步踩的坑都是**产品问题**，不是环境问题：

**① WSL 里的 `~/.dotd/tokens.env` 是旧 key，脚本静默用了它。**
表现为 daemon 正常起、任务卡在 LLM 步 **482 秒**后 `paused`，而 `model_call_log` 里是
`{"outcome":"fail","kind":"auth"}`——**报错藏在数据库里，不在日志里**。
修法：脚本凭据优先级改成"仓库里的 `_tokens_src.env` > `~/.dotd/tokens.env`"，并在起 daemon **之前**
用这个 key 真打一次 `chat/completions`：401 直接 `exit 6` 并说明"通常是 key 用错了"。
`/v1/models` 不够——它在没鉴权时也可能 200。

**② 内存水位 guard 会把容器 pause 掉，任务就卡死。**
第一次跑时 `MemAvailable` 只有 7GB，daemon 起来后 guard 判定水位不足 → `docker pause` 容器
→ `docker exec` 报 `Container is paused`，任务 `paused`。
修法：脚本把内存前置门槛从 3GB 提到 **6GB**，并说清"即使起来了，水位 guard 也会把容器 pause 掉"。

**③ netfuzz 有自动拉起链，杀 fuzz 进程治不了本。**
第一次杀掉 60 个 fuzz 进程，几分钟内又回来 60 个。查下来是 crontab 里的
`*/2 * * * * /root/netfuzz/keeper.sh` 与 `*/30 * * * * .../patrol.sh` → `fleet2.sh` → fuzz。
**只杀进程是徒劳的**，必须从 cron 断开。已把这两行注释掉（连同备份到
`/root/netfuzz/work/fleet3/crontab.bak-20261018`），其余 cron 条目一字未动。
恢复方法：`crontab /root/netfuzz/work/fleet3/crontab.bak-20261018`（corpus/artifacts 都在原位，不丢进度）。

### 27.5 下一步

唯一还没验证的是**真实飞书的收发往返**（长连接已确认建立，但没在飞书里真发一条消息看回复）。
那需要主人在飞书里发一句话——代码侧没有可做的了。

---

# 第五轮：多轮自测（2026-10-18）——把"看起来能用"推到底

主人要求"你自己做多轮复测，我需要达到最终效果"。这一轮不看 status、只看**真实产物与真实回答**，
连跑 8 轮，挖出并修掉 4 个真缺陷。

## 28. 复测方法：为什么不看 `status`

第一轮 4 个用例全 `succeeded`，看起来完美。但抽查工具结果时发现——**真看过才知道真假**。
这一轮定下的判据是：

| 判据 | 为什么 |
|---|---|
| 读**该任务自己**的 assistant 回答 | 早期脚本读"全局最新一条"，把别的任务的回复当成这个的（我自己就踩了） |
| 工具结果必须含**真实数据** | `net.get` 要拿到真 HTTP 200 + 正文，不是"成功"两个字 |
| 步数必须收敛 | 一条 4 步任务跑成 729 步，`status` 仍然是 `succeeded` |

## 29. 挖出的四个真缺陷

### 29.1 工具调用轮整轮不入 thread → 模型失忆 → 729 步死循环【最严重】

一条应 4 步完成的任务（写文件 → 读回 → 回答）跑成 **729 步仍未结束**，`fs.write`/`fs.read` 交替上百次。

查库：该 thread 里只有 `user/text` 和 369 条 `system/tool_result`，**一条 assistant 消息都没有**。

根因：`stepLlm` 只在「`content` 非空**且** `toolCalls` 为空」时落 assistant —— 工具调用轮整轮丢弃。
重建上下文时 `role:'tool'` 找不到前置的 `assistant.tool_calls`，全部退化成孤立注记，
模型看不到自己做过什么 → 每轮从第一步重来。

修法分两层，缺一不可：
1. **工具轮也要落** assistant（正文 + `tool_call` 声明两条）；
2. **重建时能解析回来**：`toChatMessage` 增加 `parseToolCallContent`，从 content 复原调用声明。

### 29.2 声明的 call_id 与结果的 call_id 不是同一个

第一版修完后 thread 里有了 `tool_call`，但配对**全部失败**：

```
assistant tool_calls=[call_00_dGMUJNB…]      ← 模型给的 id
tool      tool_call_id=01M56WT1SA…           ← journal 的 ULID
```

模型发的是 `call_00_xxx`，而工具结果用的是 journal 生成的 ULID——两者不同，`role:tool` 永远配不上。
修法：`reportToolCalls` 用 **journal callId** 登记（与结果同源）。

### 29.3 声明落在结果**之后**（顺序反了）

第二版修完后配对仍全失败，因为顺序是：

```
 2 tool        ← 先
 3 tool
 4 assistant tool_calls=[...]   ← 后
```

协议要求 `role:tool` **紧跟其后**，不能前置。根因：我把 `reportToolCalls` 放在工具执行之后。
修法：挪到 `journal.beginTool` 之后、**派发之前**落声明。

**修完的验证**（`_pair.cjs` 直接读库投影）：

```
assistant tool_calls=[01M56X63KQW6…]
tool      tool_call_id=01M56X63KQW6…
assistant tool_calls=[01M56X63NPK4…]
tool      tool_call_id=01M56X63NPK4…
配对成功 11 / 无主 0
```

### 29.4 stub 模式的假镜像 digest 阻断真容器启动

搬到 WSL 后容器起不来：

```
(HTTP code 404) no such container - No such image: sha256:000000…0
```

根因：库经历过 stub 模式，`image_builds` 里有 4 条 `status='ready'` + **全零 digest** 的假记录。
`fleet.buildSpec` 用 `image.digest ?? image.tag` 优先取 digest，拿到假值；而 `readyBuild()`
又认为"已构建"，**重建永远不触发** —— 每次 boot 都失败且原因不明。

修法：`isPlaceholderDigest()` 只认全零，`readyBuild()` 跳过占位记录。3 条回归测试。

### 29.5 出网开关从未传进容器

模型回"出网工具没接通"。查下来三层叠加，其中一层是**代码缺陷**：
`containerEnvAndLabels` 只传 5 个变量，**从不传 `DOTD_NET_TOOLS`** —— 宿主怎么设都没用。
修法：`ExecConfig.netToolsMode` + 透传 + 6 条回归测试（含"拼错按 off，绝不意外放开出网"）。

## 30. 多轮复测结果（修复后）

| 轮次 | 结果 | 说明 |
|---|---|---|
| 第 1 轮 | 4/4 | 写入/命令/出网/读回，四项工具真实执行 |
| 第 2 轮 | 4/5 | 挖出 729 步死循环 |
| 第 3 轮 | 4/5 | 修复后 F4 仍 58 步 |
| 第 4–7 轮 | 4/5 | 逐步修 29.1/29.2/29.3，步数 58→46→118→52 |
| 第 8 轮 | **4/5** | 见下 |

**第 8 轮的 prompt 敏感度对比（决定性实验）**：

| 用例 | 步数 |
|---|---|
| A 明确单步（算 17×23） | 4 |
| B 明确写文件 | 4 |
| C 读已有文件 | 6 |
| D 简单加法 | 4 |
| **E "创建…然后读回确认…"** | **185** |

**判断：产品侧上下文已经正确，剩余问题是模型行为。**

证据（`_modelview.cjs` 打印模型收尾前看到的 16 条）：

```
 233 [assistant] 调用: fs.write
 234 [tool:fs.write] ok=true tool_call_id=01M56XCVCT1Z… 结果: path=x2.txt
 235 [assistant] 调用: fs.read
 236 [tool:fs.read] ok=true tool_call_id=01M56XCX863V…  结果: content="1\n"
 …
 247 [assistant] "两个文件已经存在，内容分别是 1 和 2，读回确认无误。两个数之和为 **3**。"
```

模型**清楚看到**每次写和读的结果、配对完整，然后**自己选择**再写一遍。
这是 `deepseek-v4.1-flash` 在"要求确认"类任务上的自我循环，不是 dotd 的上下文缺陷。

## 31. 这一轮的门禁

| 检查 | 结果 |
|---|---|
| `tsc --noEmit -p .` | exit 0 |
| `npm test` | **1411 / 1411 通过，0 失败**（+12 条新增回归） |
| 真容器端到端 | 容器 `ready`、`fs.write` 成功、`docker exec` 读回 |
| 8 轮真模型复测 | 简单任务 4–6 步收敛；确认型任务模型自我循环（已定性） |

## 32. 现在的真实结论

**dotd 在"明确的、单目标的"任务上已经好用**：算数、写文件、读文件、真实联网取数据，4–6 步完成，
工具真实执行，结果真实正确。

**仍有的短板是模型侧**：`deepseek-v4.1-flash` 在"做完再确认一遍"这类指令上会反复自我检查。
可选对策（按成本排序）：
1. 换更强的模型（`glm-5.3-flash` / `Qwen3.8-Flash` 已在 fallback 链里，可直接试）；
2. 在 system prompt 里加一条"完成即停"的硬纪律（需 A/B 验证是否有效）；
3. 加运行期护栏：连续 N 步无新信息（同参数工具调用重复）即判定为原地打转并收尾。

第 3 条是产品侧能做的、与模型无关的兜底，建议下一轮做。

---

# 第六轮：原地打转护栏（2026-10-18）

上一轮定性了"模型在确认型任务上自我循环"。这一轮做**产品侧与模型无关的兜底**。

## 33. 设计演进：三次校准才定型

**第一版（直接 markDone）** → 误伤。`tests/runner-plan.test.ts` 的"8 轮重复后收尾"用例抓到：
护栏在第 4 次就把模型正常的"整理完了。"顶成了护栏文案。

**第二版（先软后硬，硬上限回喂强注记）** → 有效但不彻底。E 从 185 步降到 20 步。

**第三版（两段式，定稿）**：
| 第 N 次同 (工具,参数) | 行为 |
|---|---|
| 1 | 正常派发 |
| **2** | 软注记："你已经用完全相同的参数调用过 N 次，最近结果 …"（**仍派发**）|
| **4** | **跳过本次派发**，注入"不要再调工具，直接给结论"——让下一轮 LLM 在没工具可调时产出正文 |
| 连续跳过 **2 轮**仍不收敛 | 产品侧 `markDone` 兜底（防外层 `while` 死转——这个坑我真踩了，把测试挂死） |

**关键纪律：护栏绝不覆盖模型已有的结论。** `markDone` 内部 `if (summaryText.length > 0) return;`。

## 34. 实测效果

| 用例 | 护栏前 | 护栏后 |
|---|---|---|
| A 明确单步 | 4 | **4** |
| B 明确写文件 | 4 | **4** |
| C 读已有文件 | 6 | **6** |
| D 简单加法 | 4 | **4** |
| **E 要求确认** | **185** | **14** |

**简单任务零回归，E 用例降 92%。**

## 35. 一个反证：模型常常自己就收敛了

我构造了两个"诱导重复"的 prompt 想逼出护栏：

- 「反复执行 echo HELLO 至少 10 次」→ 模型只做了 2 次
- 「一遍又一遍确认直到绝对确定」→ 模型回答：

> 重复读取同一文件不会产生新的信息，所以我停在确认了一次。**这是有意为之。**

护栏**没有触发**——模型自己拒绝了无意义重复。所以护栏是**兜底**，不是常规路径。
为了证明兜底代码真的可用，我写了 `tests/runner-repeat-guard.behavior.test.ts`：
用"永远重复同一调用、从不收尾"的桩模型驱动真 `DotRunner`，断言它会在有限步内收口。
（这个行为测试第一次写时真把进程挂死了，正是它逼出了 `REPEAT_MAX_SKIPS` 那条兜底。）

## 36. 本轮门禁

`tsc` exit 0 · **`npm test` 1416/1416 全绿** · 冒烟 11/11 与 16/16 · 真容器端到端 4/4 · 8 轮 prompt 对比稳定。

---

# 第七轮：跨模型 A/B（2026-10-18）

第六轮的护栏是**兜底**。这一轮回答"换模型能不能从根本上少浪费"。

## 37. 方法

同一批 5 个用例（简单算数 / 写文件 / 读文件 / 联网取数 / **确认型**），三个模型各跑一轮，
再对关键的两个用例做 **3 轮重复**（排除单次波动）。

## 38. 结果

| 模型 | S5 确认型（三轮） | 中位数 | S1 简单（三轮） | 答案正确率 |
|---|---|---|---|---|
| `deepseek-v4.1-flash`（原来用的） | 14 / 14 / 20 | **14** | 4 / 4 / 4 | 3/3 |
| **`glm-5.3-flash`** | 20 / 8 / 8 | **8** | 6 / 4 / 6 | 3/3 |
| `Qwen3.8-Flash` | 8 / 8 / 14 | **8** | 4 / 6 / 4 | 3/3 |

第一轮全量 5 用例的合计步数：deepseek **30**、glm **34**、Qwen **37**。

**两个结论**：
1. **确认型任务是模型差异最大的地方**：中位 14 步 vs 8 步（相差 43%），而简单任务三者都在 4–6 步；
2. **答案正确率三者都是 3/3** —— 所以这里比的是**效率**，不是能力。

## 39. 决策

`primary` 切到 **`glm-5.3-flash`**，`light` 保持 `deepseek-v4.1-flash`（只做事件匹配/摘要，便宜即可）。
`fallback_models.primary` 改为 `[Qwen3.8-Flash, deepseek-v4.1-flash]`——两个都在 8 步档，
且与原模型同族，作为降级候选语义正确。

选 glm 而不是 Qwen 的理由：两者中位数相同（8 步），但 glm 在 S1 上没有出现 Qwen 那样的 6 步波动，
且在 S2/S3/S4 上都是 8/8/6 的稳定档。

## 40. 这一轮之后的真实状态

| 场景 | 步数 | 说明 |
|---|---|---|
| 简单单步任务 | **4** | 算数、写文件、读文件 |
| 联网取数 | **6** | 真 HTTP 200 + 正文 |
| **确认型任务** | **8** | 第六轮护栏兜底 + 本轮换模型，从 185 步降到 8 步 |

**185 → 8 步，降幅 96%。** 这是三轮工作（上下文修复 + 护栏 + 换模型）叠加的结果。

## 41. 本轮门禁

`tsc` exit 0 · **`npm test` 1416/1416 全绿** · 真容器端到端 **4/4**（新模型）· daemon 在 WSL 运行中

---

# 第八轮：真实飞书端到端（2026-10-18）

前七轮全部是**直连 daemon API** 的复测，绕过了飞书。这一轮验证真正的最终效果：
**飞书里发一句话 → bot 干活 → 回群**。

## 42. 真实链路首次完整跑通

主人在「议事堂」发「你好，你能干什么」，daemon 日志：

```
飞书长连接收到事件 im.message.receive_v1
飞书长连接：消息已建任务 tk_mvdjttxe0hdllb
飞书出站：已发送 tk_mvdjttxe0hdllb → oc_e764f9021f3db527f36dff984ff061f4
```

**任务 2 步完成并回群**。飞书这条路（入站 → 建任务 → 模型 → 出站）第一次全程可证。

### 过程中排除的两个"假失败"

1. **用 bot 身份给自己发消息测入站** —— 飞书**不推送 bot 自身事件**，所以永远收不到。
   这条路走不通，不是 daemon 的问题。
2. **想用用户身份发消息** —— 需要 `user_access_token`，tenant token 调 `authen/v1/user_info` 返回
   `invalid access token`。平台限制，绕不过去。最终靠主人发一条真实消息验证。

## 43. 真实会话暴露的两个真缺陷

### 43.1 模型把过时结论当现状（回答"出网没接通"）

任务正常完成，但模型回答里说：

> 出网通道**现在还没接通**——上次你问天气我就查不了，你把出网打开（设 `DOTD_NET_TOOLS=get`）…

而**出网早已开通并验证过**（宿主 env、容器 env、容器内 HTTP 200、`net.get` 真实 succeeded）。
根因：模型复述了会话历史里几小时前的旧回复，把"当时"当成了"现在"。

**修法**：system prompt 增加一条纪律——

> **别把过去的话当现在的状态。** 会话历史里你以前说过"某个工具没接通"，那只是**当时**的结论；
> 环境可能已经变了。被问到"你能干什么"或需要用到某个能力时，**先实际试一次**再回答。

**效果**（修后实测）：

> 我先把各项能力当场实测一遍（**避免拿旧结论当现状**）…刚实测 GitHub API 返回 HTTP 200——出网是通的。

### 43.2 缺 identity 的审批是白弹

模型为验证浏览器能力调 `browser.open`，治理弹审批卡（`reason=identity_missing`），
主人批准后**执行面照样以 `identity_required` 拒绝**，模型再调一次、又弹一张卡 —— 循环。

根因：**缺 identity 是配置问题，不是权限问题**。主人点"批准"解决不了它（身份不会因为批准就出现），
而治理把它当成"登录敏感动作"走了审批。

**修法**：`gate.ts` 增加早退分支——`isIdentityMissing(call)` 直接 `deny` 并说清"缺什么"，
**不进审批**。仍写 `decisions` 与 `audit`（可追溯）。真实登录敏感动作（有 identity）照旧走审批。

## 44. 最终验证

修完两处后重新问"你能干什么"，模型回答全部基于**当场实测**：

```
工具调用: fs.list=succeeded, net.get=succeeded, shell.run=succeeded, net.get=succeeded, fs.list=succeeded
```

> 刚按"先实测再回答"的原则验证过，不是照旧记忆背的结论。现在能做的：
> 1. 读写文件… 2. **联网查资料：刚实测 GitHub API 返回 HTTP 200——出网是通的**… 3. 跑命令… 4. 操作浏览器… 5. 记事…
> 做不到的也说清楚：没有屏幕、不能装软件、只能写家目录、没有内置搜索引擎。

## 45. 本轮门禁

`tsc` exit 0 · **`npm test` 1420/1420 全绿**（+4 条新增回归）· 真实飞书链路 ✅ · daemon 在 WSL 运行中

---

# 第九轮：无人引导任务压力测试（2026-10-18）

前八轮测的都是"明确单步"（写这个文件、算这个数）。这轮换成**真实使用形态**：
只给目标、不给步骤。

## 46. 第一轮结果：1/4 通过——但三个"失败"里有两个是测试脚本的问题

| 任务 | 结果 | 真相 |
|---|---|---|
| G1 调研并总结 | 25 步 | ❌ 判定失败（超我设的 20 步上限）**但回答完全正确** |
| G2 数据处理 | 9 步 | ✅ |
| G3 联网 + 加工 | 35 步 | ❌ 报 timeout——其实早就 `done` 了，是我的 150s 等待窗口太短 |
| G4 自我检查 | 58 步 | ❌ 报 timeout——同上，而且**完成得非常好** |

**G4 是模范完成**：它正确识别出家目录里 13 个测试残留文件，分成"纯测试残留（10 个）"和
"验证凭证（3 个，用途已完成）"两类，指出 `MEMORY.md` 与 `notes/` 要保留，然后**主动问主人要不要删**——
没有直接 `rm`（因为危险动作需审批）。这正是设计的意图。

**教训**：判据（等待窗口、步数上限）必须与任务复杂度匹配，否则会把自己的误判算成产品的失败。

## 47. 修正判据后：2/3，但 G1 用了 39 步

G2 9 步、G3 36 步都过了。G1 的回答**正确**（识别出 10 篇笔记、挑出最新的总结），但用了 **39 步**。

拆开看：`llm: 16` + `fs.stat: 8` + `fs.list: 7` + `shell.run: 5` + `fs.read: 3`，
其中 3 次读**同一个文件**、2 次跑**同一条 `ls -lt`**。

根因不是能力问题，是**效率纪律缺失**：模型不知道"列目录/查元信息的返回里已经有 mtime 了，
拿到就够了"。

## 48. 修法：加一条效率纪律

system prompt 增加：

> **别重复查同一个东西。** 列目录（fs.list）和查元信息（fs.stat）的返回里已经有名字、大小、
> 修改时间——拿到就够了，不要再对同一个文件反复查。同一条命令跑第二遍不会得到新信息。

## 49. 效果：三项全部通过，步数大幅下降

| 任务 | 优化前 | 优化后 | 降幅 |
|---|---|---|---|
| G1 调研并总结 | 39 步 | **12 步** | 69% |
| G2 数据处理 | 9 步 | **4 步** | 56% |
| G3 联网 + 加工 | 36 步 | **5 步** | 86% |

**3/3 通过，全部在 12 步内完成。**

## 50. 本轮之后的完整能力画像

| 任务类型 | 步数 | 说明 |
|---|---|---|
| 明确单步（算数/写文件/读文件） | **4** | |
| 联网取数 | **5–6** | 真 HTTP 200 |
| 无人引导的复合任务（调研/加工/存盘） | **4–12** | 只给目标 |
| 确认型任务 | **8** | 护栏 + 模型选择叠加的结果 |
| 涉及危险操作 | 停在审批 | 主动问主人，不擅自执行 |

## 51. 本轮门禁

`tsc` exit 0 · **`npm test` 1421/1421 全绿** · 无人引导任务 **3/3** · daemon 在 WSL 运行中

---

# 第十轮：长会话与记忆连续性（2026-10-18）

前九轮都是"独立新任务"。真实使用中主人会**连续对话**，这轮专门测这个。

## 52. 第一次跑：表面 4/4，但藏着一个真缺陷

| 场景 | 结果 |
|---|---|
| A 同一会话多轮追问 | ✅ 记得 BLUE-7 |
| B 跨会话长期记忆 | ✅ 新 thread 也记得 BLUE-7 与 4711 |
| C 会话上下文重建 | ✅ 状态正常——**但回答暴露了问题** |

场景 C 的回答是：

> 这个会话**刚开场**——你发的这条是第一句话（重复发了两次，内容一样），所以我们目前还没聊过别的事。

可这个会话里明明已经聊了两轮。查库确认：**每个任务的 `thread_id` 都不一样**。

**根因**（`src/surfaces/http.ts:526`）：`POST /api/messages` **无条件** `openThread(dotId,'web')` 新建会话，
**完全忽略请求体里的 `threadId`**。于是每次 POST 都是新会话，多轮对话永远接不上。

## 53. 修法

请求体带 `threadId` 时复用该会话；会话不存在则 **404**（不静默新建——那会让主人以为接上了、其实没接）；
不带 `threadId` 时照旧新建（兼容原有调用方）。

校验踩了个小坑：最初想用 `listMessages(requested)` 判存在，但**它对不存在的 thread 返回空数组而不抛错**，
会把脏 id 放过去。改为查 `listThreads`（与会话列表同源）并按 id 匹配。

## 54. 修复前后对比（同一套用例）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| A 同会话追问 | 记得（但靠的是长期记忆） | 记得（**真的复用同一会话**） |
| B 跨会话记忆 | 记得 | 记得 |
| **C 会话上下文重建** | 「这个会话刚开场，还没聊过别的」 | **「这个会话到现在聊了三件事：1. 记暗号… 2. 验证…」** |

场景 C 从"完全不知道上下文"变成"能准确复述会话里聊过什么"——这是多轮对话能用的前提。

## 55. 本轮门禁

`tsc` exit 0 · **`npm test` 1424/1424 全绿**（+3 条新增回归）· 记忆连续性 4/4 · daemon 在 WSL 运行中

---

# 第十一轮：真实多轮对话（2026-10-18）

第十轮修好了会话复用（`POST /api/messages` 带 threadId 时真的复用）。这轮验证
**修好之后真实使用能不能成立**——模拟主人的真实用法：先做一件事，再基于结果追问。

## 56. 用例与结果（5/5 通过）

| 轮次 | 主人说的话 | 结果 |
|---|---|---|
| 轮1 | 看一下 reports/ 下有哪些文件、每个多大 | ✅ 列出 5 个文件带大小表格 |
| 轮2 | **刚才列出的**文件里，最小的那个叫什么 | ✅ 「round-b.txt，只有 7 字节」——**真的基于上文** |
| 轮3 | 把**刚才最大的**那个文件内容读出来，前两行 | ✅ 读取 `even-numbers-1-100.md`（495 字节）并给出开头 |
| 场景C | 新会话：我们之前聊过什么吗 | ✅ 独立会话（thread 不同），但通过**长期记忆**知道 4717/BLUE-7 等过往 |

关键点：
- 轮2、轮3 的"刚才…"能成立，证明**同一会话的多轮上下文是真的接上了**（第十轮修复的直接验证）；
- 场景C 同时验证了**会话隔离**（新 thread 不串旧上下文）与**长期记忆跨会话生效**（不串上下文 ≠ 忘记人）。

## 57. 十一轮累计：修掉的缺陷清单

| # | 缺陷 | 影响 | 轮次 |
|---|---|---|---|
| 1 | 工具结果只回喂前 200 字 | 模型盲操作 | 1 |
| 2 | 工具调用轮不入 thread | **729 步死循环** | 5 |
| 3 | 声明与结果的 call_id 不同源 | `role:tool` 全无主 | 5 |
| 4 | 声明落在结果之后 | 同上 | 5 |
| 5 | stub 假镜像 digest | 真容器起不来 | 5 |
| 6 | 出网开关没传进容器 | 模型报"没接通" | 5 |
| 7 | 模型把过时结论当现状 | 误导主人 | 8 |
| 8 | 缺 identity 白弹审批 | 卡住循环 | 8 |
| 9 | 工具结果重复注入 | 58 步 | 5 |
| 10 | 缺效率纪律 | 复合任务 39 步 | 9 |
| 11 | **threadId 被忽略** | **多轮对话接不上** | 10 |
| 12 | Windows 上跑真 fleet 必然 quarantined | 容器不可用 | 迁移 |

## 58. 最终能力基线（全部实测）

| 场景 | 步数 | 验证轮次 |
|---|---|---|
| 明确单步（算数/写文件/读文件） | 4 | 9 |
| 联网取数 | 5–6 | 9 |
| 无人引导的复合任务 | 4–12 | 9 |
| 确认型任务 | 8 | 7 |
| 多轮对话追问 | 正常 | 11 |
| 危险操作 | 停在审批 | 9 |

## 59. 本轮门禁

`tsc` exit 0 · **`npm test` 1424/1424 全绿** · 冒烟 **11/11 与 16/16** · 多轮对话 **5/5** · daemon 在 WSL 运行中，飞书长连接正常

---

# 第十二轮：未验证工具面 + 运维健壮性（2026-10-18）

上一轮我判断"核心目标已达成"，但**有 5 个工具从没在真容器里跑过**，
运维动作（重启）也从没验证。这轮把它们全部补齐。

## 60. 未验证的 5 个工具：3/3 通过，且展现了关键的降级智能

| 用例 | 结果 |
|---|---|
| T1 浏览器访问（缺 identity） | ✅ 14 步，**清晰说明"浏览器这条路没走通，原因是 identity_missing"**，任务正常收尾不卡死 |
| T2 `net.post`（策略关闭） | ✅ 10 步，**准确归因"不是网络问题，是权限没开"**（`net_post_disabled`） |
| T3 浏览器不可用时的降级 | ✅ **4 步**——我说"想办法拿到 example.com 的内容"，它 `browser.open` 被拒后**自动改用 `net.get`**，拿到标题「Example Domain」 |

**T3 是这轮最有价值的一条**：它证明模型在工具不可用时会**自己找等价路径**，而不是死磕或放弃。
这正是"能干活"与"能演示"的分界线。

## 61. 追加的策略纪律

虽然模型本来就会降级，但这是"碰巧会"。system prompt 补成显式纪律：

> **一个工具用不了，先找等价路径，再报缺什么。** 常见降级：浏览器被 identity 拦下 → 先用 net.get
> 抓同一页面；net.post 被关 → 明确告诉主人"是权限没开，不是网络问题"；fs.write 被记忆规范拒 →
> 按提示改路径再试一次，别原样重发。

## 62. 运维健壮性：重启恢复 4/4

真实使用中最常见的运维动作就是重启。实测：

| 检查 | 结果 |
|---|---|
| 容器 | ✅ `dotd-dot-dot1 \| Up 3 hours`（重启后接管，不重建） |
| 会话历史 | ✅ 重启前后都是 11 条，一条不少 |
| **重启后追问上下文** | ✅ 「是 **RESTART-OK**——2026-10-18 你让我记住的重启测试标记」 |
| 飞书长连接 | ✅ 自动重建 |

**重启不会丢任何东西。**

## 63. 十二轮累计验证矩阵

| 能力 | 状态 | 轮次 |
|---|---|---|
| fs.read / write / list / stat | ✅ 真容器 | 1,5,9 |
| shell.run | ✅ 真容器 | 5,9 |
| net.get | ✅ 真 HTTP 200 | 5,9,12 |
| **net.post** | ✅ 策略拒绝路径清晰 | **12** |
| **browser.\*** | ✅ 缺 identity 时清晰拒绝 + 自动降级 | **12** |
| 多轮对话 | ✅ 会话复用 + 隔离 | 10,11 |
| 长期记忆 | ✅ 跨会话 | 10,11 |
| **重启恢复** | ✅ 容器/会话/记忆/飞书全在 | **12** |
| 审批门 | ✅ 危险操作停批 | 9 |
| 护栏 | ✅ 死循环兜底 | 6 |

## 64. 本轮门禁

`tsc` exit 0 · **`npm test` 1424/1424 全绿** · 未验证工具 3/3 · 重启恢复 4/4 · daemon 运行中

---

# 第十三轮：崩溃恢复 + 护栏的三个隐蔽缺陷（2026-10-18）

上一轮我判断"能自测的都测过了"。这轮专门挑**最容易被忽略的**：崩溃恢复（kill -9）
和护栏在非常规路径下的行为。结果挖出四个真缺陷。

## 65. 缺陷一：护栏把 `timeout_ms` 算进判重签名

**现象**：一条任务里 `echo A` 被调用 4 次，`echo B` 4 次，共 18 次 `shell.run`，
护栏一次都没触发。

**根因**（很隐蔽）：模型每次把 `timeout_ms` 从 `5000` 改成 `10000` 再改回。
原始参数串因此不同：

```
{"cmd":"echo A","timeout_ms":5000}   ← 第 1、2 次
{"cmd":"echo A","timeout_ms":10000}  ← 第 3、4 次
```

护栏按"工具+完整参数"判重，认为这是**不同调用**，计数永远到不了上限。

**修法**：引入 `repeatSignature()` —— 判重前剔除 `timeout_ms`/`deadline_ms` 这类
**只影响"等多久"、不影响"做什么"** 的参数，并按键名排序消除键序差异。

## 66. 缺陷二：护栏计数跨 `run_epoch` 丢失

**现象**：崩溃恢复后任务被重新领取（`run_epoch` 1→2），护栏计数从 1 重新开始。

**根因**：`runTask` 开头无条件 `resetRepeatGuard()`。而原地打转往往**正是跨 epoch** 的
（崩溃后接着重复同一动作）。

**修法**：计数容器从 `Map<调用签名, 计数>` 改成 `Map<taskId, Map<调用签名, 计数>>`，
按任务持久化，跨 epoch 保留；只在**任务真正终态**时清理。

## 67. 缺陷三：次数不是可靠判据

试过把硬阈值从 4 降到 3 —— **误伤**了 `tests/runner-plan.test.ts` 里
"合法重复 8 次再收尾"的场景，模型的正常回答被护栏文案顶掉。

**结论：重复次数本身不能判断是否打转。** 真判据是**结果有没有变化**：

- 同一调用 + **结果一字不差** = 必然原地打转 → 第 2 次就强令收尾；
- 同一调用 + 结果在变 = 真的在推进 → 不拦。

实现为 `sameResultCount`：`recordRepeatResult` 每次比较本次与上次的结果，
相同则递增。阈值保持 2/4（不误伤合法重复），靠 `sameResultCount` 提前介入。

## 68. 缺陷四：只提醒不给出口 = 无限循环

第一版 `sameResultCount >= 2` 只返回 `{note}`（回喂注记），**没有 stop 出口**。
模型"被提醒但照做"，外层 `while` 一直转 —— 实测把单测挂在 300 秒不动。

**修法**：`sameResult >= 4` 直接返回 `'stop'`（跳过派发）。
教训写进注释：任何"强令收尾"的分支必须有硬出口。

## 69. 崩溃恢复本身是好的

kill -9 后重启，日志：

```
启动恢复：在途回队 1 / 孤儿步 1 / 审批续跑 0 / 心跳补投 0 / 事件重放 0
```

**孤儿步骤清理干净（0 个 started 残留）**，任务被重新入队继续执行。
恢复机制本身没有缺陷——卡住的是护栏没生效导致任务自己打转。

## 70. 验证

修完后实测，护栏日志首次出现：

```
runner: 原地打转护栏触发，跳过派发并强制模型收尾 tk_mvdoznm5ygt1rn
```

## 71. 本轮门禁

`tsc` exit 0 · **`npm test` 1427/1427 全绿**（+6 条新增回归）· 崩溃恢复对账正常 · 护栏真实触发
