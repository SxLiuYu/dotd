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

---

# 第十四轮：异常路径与可观察性（2026-10-18）

第十三轮教训是"兜底机制最难验证"。这轮继续找**只在异常路径才暴露**的问题：
模型端点全挂时会怎样？故障之"后"主人能否知道发生了什么？

## 72. 模型全挂的行为是对的

把 `models.yml` 的 base_url 指到无人监听的端口，然后提交任务：

| 检查 | 结果 |
|---|---|
| 任务状态 | **2 秒内 `paused`**（`stop_reason: circuit_open`）——不是永久卡 `running` |
| 熔断原因 | `AllEndpointsDownError：ALL_ENDPOINTS_DOWN:全部模型端点均不可用（已试 3 个候选）` |
| 端点恢复后 | 新任务立即 `done`，无需人工干预 |

熔断机制本身**完全正确**。

## 73. 但它"看不见"——这是真缺陷

第一次测完发现：任务状态是对的，但**日志里一个字都没有**，`resource_events` 里也查不到。

主人视角：只看到"DS 不回话"，无从判断是模型端点挂了、还是 dotd 坏了、还是容器挂了。

这与之前踩过的"WSL 密钥错误只藏在数据库里"是**同一类问题**：
**状态记录正确 ≠ 故障可观察**。可观察性必须是显式要求。

### 修法一：熔断打日志

```
runner: 模型熔断 → paused(circuit_open) tk_xxx（AllEndpointsDownError：全部模型端点均不可用（已试 3 个候选））。
端点恢复后由 router.mode_changed 批量回 queued，无需人工干预。
```

### 修法二：pauseByReason 落 resource_events

熔断/水位/预算/工具风险都走 `pauseByReason` 这个通用入口，统一记一条：

```json
task_paused [throttled] {"taskId":"tk_xxx","reason":"circuit_open","from":"running"}
```

## 74. 修复过程中又踩一个坑：CHECK 约束静默吞掉写入

第一次加完事件写入，`resource_events` 里**还是查不到**。根因：

```sql
kind TEXT NOT NULL CHECK (kind IN ('watermark','container_pause',...))  -- 没有 task_paused
```

而我把 `INSERT` 包在 `try/catch` 里（审计面不该炸主流程——这个决定是对的），
于是**唯一的错误信号被自己吞掉了**。

修法：新增迁移 `120_resource_events_task_paused.sql` 重建表、把 `task_paused` 加进白名单
（SQLite 不支持改 CHECK，只能重建；resource_events 是纯审计表、无外键引用，重建安全）。

**教训**：`try/catch` 保护正确，但必须**另留一条可观察线索**——否则保护就变成了掩盖。

## 75. 迁移的连带影响

改迁移版本要同步 4 处硬编码 `110`（`daemon.ts` 的 `expectedVersion`、
`daemon-assembly`/`db-template`/`memory-fts`/`temp-cleanup` 四个测试）。
漏一处就 `MigrationError` 拒启动——这次一次改齐。

## 76. 本轮门禁

`tsc` exit 0 · **`npm test` 1430/1430 全绿**（+3 条可观察性回归）· 迁移 110→120 实跑通过 ·
熔断日志与 `task_paused` 事件实证落地 · daemon 运行中

---

# 第十五轮：容器异常与诊断信息（2026-10-18）

继续测异常路径：**任务执行中容器被 kill**。

## 77. 容器异常的处理链是完整的（3/3）

| 场景 | 结果 |
|---|---|
| A 执行中 `docker kill` 容器 | ✅ 任务正常收口 `done`（未卡 `running`） |
| B daemon 能否自动重建容器 | ✅ `boot 接管容器：dot1`，`Exited (137)` → `Up` |
| C 重建后能否正常工作 | ✅ 新任务 `done` |

**模型的表现尤其值得记一笔**：它没有假成功，而是明确说

> 这次容器测试没跑成，我拿不到任何输出。`shell.run` 连续 3 次返回完全相同的错误——
> `transport_error: "fetch failed"`（标记为可重试）。同样的失败重复出现，说明问题不在命令本身，
> 而在工具到执行器之间的传输层…重试已无意义，我按护栏停止了调用。

诊断推理完全正确，还给了主人两条可执行建议。

## 78. 但错误信息太底层——这是真缺陷

`message` 只有 `fetch failed`。**容器被 kill 了，错误却说"fetch 失败"**，看起来像网络问题。
模型侥幸推理对了，但这是运气：它不可能从 `fetch failed` 区分"网络抖动"和"容器没了"。

### 修法：失败时补一次轻量诊断

`failDispatch` 里加 `diagnoseTransportFailure(call)`：

1. **先看 fleet 状态机**（最便宜、最准确）：容器被 kill 后这里已是 `exited`/`lost`；
2. 状态机说正常，再探一次端点健康（**1.5s 上限**，不拖住主流程）；
3. 诊断自身出错 → 返回 `null`，**保持原始错误**（诊断只帮忙、不掩盖）。

效果：

```
"fetch failed（容器的执行器无响应：容器可能已退出、被暂停或正在重建）"
```

**副作用是好的**：模型的重试从 6 次降到 4 次，任务收口时间从 150s 降到 **70s**。
信息清楚之后，它更快放弃无意义的重试。

## 79. 本轮门禁

`tsc` exit 0 · **`npm test` 1433/1433 全绿**（+3 条回归）· 容器异常 3/3 · daemon 运行中

---

# 第十六轮：并发 + 一处隐蔽的上下文污染（2026-10-18）

## 80. 并发行为完全正确（5/5）

| 检查 | 结果 |
|---|---|
| 一次提交 5 个任务 | ✅ 全部完成，一个不丢，答案各自正确（A1–A5） |
| 串行性 | ✅ 采样 11 次，**最大并发 running = 1**（不抢占同一容器） |
| 执行中提交短任务 | ✅ 正确排队（`queued`），不抢占 |
| 长任务是否被打断 | ✅ 完整跑完（`done`） |
| 短任务最终 | ✅ 3/3 全部完成 |

## 81. 全局回归暴露一个隐蔽缺陷

把历轮关键用例做成一个"总闸"脚本（`scripts/selftest-regression.sh`），一次跑完 8 项。
第一次跑 **7/8**，失败的是"多步写读"用了 22 步。

深挖后发现两类问题：

### 81.1 错误提示不可操作

`fs.write("/dot/home/m2.txt")` 被拒，提示是：

> 非法 home 路径（不许绝对路径 / .. 逃逸）

但 `/dot/home` **正是家目录本身**，说它"逃逸"会让模型以为路径不安全。改成：

> home 路径不合规（/dot/home/m2.txt）。请改用 home 内的**相对路径**（去掉 /dot/home 前缀），例如 "m2.txt"

**效果**：改完后模型**一次就改对**（第 2 步失败 → 第 4 步成功）。

### 81.2 tool_call 的声明 JSON 被当成 assistant 正文【最隐蔽】

`toChatMessage` 里：

```ts
const out = { role: 'assistant', content: m.content }   // ← m.content 是 {"calls":[...]}
```

模型每轮都会看到：

```
assistant: '{"calls":[{"call_id":"...","name":"fs.write",...}]}'
```

**一段它自己没写过的 JSON ，冒充"它说过的话"** —— 于是它误读自己的历史。
实测后果：明明已经改用相对路径成功，最后却汇报「**直接用绝对路径调用并没有被拒**」。

### 81.3 修复过程中的一次倒退（值得记）

第一版修法是把 `tool_call` 的 content 置成空串 —— 结果**回归**：写文件从 6 步涨到 12 步。
因为"思路"和"调用"断成了两条 assistant 消息，模型丢失了自己的推理正文。

**正确修法**：正文随调用声明**一起落**（`content = {calls:[...], text:"..."}`），
重建时 `parseToolCallText()` 取出 text 当 content。这样模型看到的是
「一段它真的说过的话 + 工具调用」，符合 OpenAI 协议的 assistant 消息形态。

回归回到 **7/8**，写文件恢复 6 步。

## 82. 剩下的 1/8 是模型行为，不是缺陷

"写入 → 算和"这类任务，模型经常在算出结果后**继续重复写文件**（同参数 3–4 次）。
护栏会介入，但模型本来就会绕。这与第十三轮定性的"模型侧自我循环"是同一类问题。

## 83. 本轮门禁

`tsc` exit 0 · **`npm test` 1434/1434 全绿** · 并发 5/5 · 全局回归 7/8（1 项为模型行为）· daemon 运行中

---

# 第十七轮：读写路径不一致，是"重复动作"的一个真凶（2026-10-18）

上一轮把全局回归的 1/8 失败定性为"模型行为"。这轮去验证这个定性**对不对**——结果不对。

## 84. 发现：读接受绝对路径，写不接受

深挖一条"写两个文件、求个和"的任务（6 次工具调用，答案正确但绕了远路）：

```
2 fs.write  {"content":"5","path":"n1.txt"}          ← 相对路径，成功
3 fs.write  {"content":"6","path":"n2.txt"}          ← 相对路径，成功
5 fs.read   {"path":"/dot/home/n1.txt"}              ← **绝对路径，成功**
6 fs.read   {"path":"/dot/home/n2.txt"}              ← **绝对路径，成功**
8 fs.write  {"content":"5","path":"n1.txt"}          ← 又问一遍，再写
9 fs.write  {"content":"6","path":"n2.txt"}
```

**`fs.read` 用 `/dot/home/...` 成功了**（执行面自动规范化），于是模型合理推断"绝对路径能用于读写"。
但它一旦拿绝对路径去 `fs.write`，就被记忆层拒绝。**一读一写两种行为**，模型学到的是错的经验。

这不是"模型行为"，是**我们的行为不一致**。

## 85. 修法：家目录前缀不是逃逸

`normalizeHomePath` 原来一律拒绝绝对路径。改为：把 `/dot/home` 前缀**连同其后斜杠**剥掉，
其余绝对路径（`/etc`、`/root`、`C:`）与 `..` 逃逸**照旧拒绝**。

**安全边界一个字都没放松**（有单测逐条钉住 8 种真逃逸路径）。

### 修的过程中测试抓到一个自己的 bug

第一版正则 `/^\/dot\/home\/?/` 会把 `/dot/homework/x` 误剥成 `work/x`。
测试用例当场抓到，改成 `/^\/dot\/home(?:\/|$)/`（`home` 后必须紧跟 `/` 或结尾）。

## 86. 效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 工具调用 | 6 次（含 2 次重复写） | **4 次**（无重复） |
| 耗时 | 106 秒 | **34 秒** |
| 答案 | 11 ✓ | 11 ✓ |

模型不再重写文件——因为读写行为一致了，它读到的"成功"和写用的规则终于对得上。

## 87. 本轮门禁

`tsc` exit 0 · **`npm test` 1437/1437 全绿**（+3 条路径一致性回归）· 真链路耗时降 68%

## 88. 全局回归终于 8/8 全绿

修完路径一致性后，跑完整回归：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 写文件 | 6 步 | 6 步 |
| 读回文件 | 4 步 | 4 步 |
| **多步写读** | **22 步 / 超时** | **9 步 ✅** |
| 联网取数 | 6 步 | 6 步 |
| 列目录 | 4 步 | 4 步 |
| 能力自述 | 6–7 步 | 4 步 |
| 会话复用 | ✅ | ✅ |
| 确认型任务 | 8 步 | 8 步 |

**8/8，且关键项步数明显下降。**

这一轮的经验：上一轮我把"模型重复动作"定性成模型行为，**那是错的**。
真相是我们的读写规则不一致，模型在按它学到的（错的）规则行事。
**遇到"模型表现怪"时，先找自己的不一致，再怪模型。**

---

# 第十八轮：护栏为什么一直不触发（三个真凶）（2026-10-18）

上轮教训是"先找自己的不一致"。这轮顺着查，把护栏失效的**三个独立原因**全揪出来了。

## 89. 真凶一：`written_at` 每次都不一样

模型对同一文件、同一内容连续 `fs.write` 4 次，护栏全程不动。
查下来 `recordRepeatResult` 比较的是**完整结果字符串**：

```
{path:"n1.txt", size_bytes:1, written_at:"...11:48:02.304Z"}   ← 第 1 次
{path:"n1.txt", size_bytes:1, written_at:"...11:49:13.232Z"}   ← 第 2 次
```

`written_at` 每次都变 → "结果一字不差"永不成立 → `sameResultCount` 停在 0/1。

**修法**：比较前先归一化，剔除 `written_at`/`wall_ms`/`finished_at` 等**易变但不代表进展**的字段。

## 90. 真凶二：阈值语义与时序错位

`checkRepeat` 在**派发前**跑，`recordRepeatResult` 在**派发后**跑。
所以 `checkRepeat` 读到的是"上一轮结束时的状态"：

```
sameResultCount=1 → 上两次结果相同（已重复一次）
sameResultCount=2 → 已连续三次相同
```

而我原来写 `>=2 / >=4`，实际要求**连续 3 次 / 5 次**才动手——比直觉晚一轮。
改成 `>=1 / >=3`（即第 2 次同结果就强令收尾，第 4 次直接跳过派发）。

## 91. 真凶三：路径写法不同，判重认不出

```
fs.write {"content":"3","path":"g1.txt"}          ×2
fs.write {"content":"3","path":"/dot/home/g1.txt"} ×2
```

**同一个文件、同样的内容**，但签名不同 → 护栏数不到。
（这一条正是上轮"统一路径规则"的下游：写行为统一了，判重也得跟着统一。）

**修法**：`repeatSignature` 里对 `path` 参数同样剥掉 `/dot/home` 前缀再比较。

## 92. 效果

修完三个真凶后，`scripts/selftest-regression.sh` 回到 **8/8 全绿**，且步数都在最优档：

| 用例 | 步数 |
|---|---|
| 写文件 | 6 |
| 读回文件 | 4 |
| **多步写读** | **8**（曾 22） |
| 联网取数 | 4 |
| 列目录 | 4 |
| 能力自述 | 4 |
| 会话复用 | ✅ |
| 确认型任务 | 8 |

## 93. 本轮门禁

`tsc` exit 0 · **`npm test` 1443/1443 全绿**（+6 条归一化回归）· 全局回归 **8/8**

---

# 第十九轮：超时语义 + 护栏机制边界（2026-10-18）

## 94. 超时语义：一处真不一致

测了四个超时场景：

| 场景 | 结果 |
|---|---|
| A 命令超时（`sleep 8` + `timeout_ms=3000`） | ✅ `deadline_exceeded`（timeout_ms=3000），可重试 |
| B 命令在超时内完成 | ✅ 正常返回 stdout |
| C `timeout_ms=0` | ✅ `bad_args`：需要正整数超时 |
| **D `timeout_ms=600000`（10 分钟）** | ⚠️ **被接受，但实际只等 60 秒** |

**缺陷**：Runner 侧 sync 档固定 60s，**模型传的 `timeout_ms` 被完全忽略**。
工具说"可以等 10 分钟"、Runner 说"我只等 1 分钟"——同一概念两处不一致，
模型据此做的判断（"这命令慢，把超时设长点"）全部落空。

**修法**：`effectiveDeadlineMs(tool, args)` —— 取**模型要求**与**档位上限**的较小值：

- 模型要求更短 → 听模型的（短超时是它自己的选择）；
- 模型要求更长 → 被档位上限截断（安全兜底不能被工具参数绕过）；
- 参数非法/缺失 → 档位默认。

## 95. 护栏机制有一个天生边界（不是缺陷，但要写清楚）

用同一命令打 4 个场景，每个都重复 2 次，护栏都没触发。查清了：**这是机制使然**。

`checkRepeat` 在派发**前**跑，`recordRepeatResult` 在派发**后**跑。所以：

- 第 2 次调用时，`sameResultCount` 还是 0（第 1 次的结果刚记下，还没来得及比较）→ 不介入；
- 第 3 次调用时，才可能看到 `sameResultCount>=1` → 触发。

**结论：护栏最早只能在第 3 次介入。2 次重复拦不住，这是无法避免的（除非拦第 1 次）。**

实测验证（模型要求"执行 5 次"）：

```
shell.run 同参数调 3 次 → 第 3 次被拦下
runner: 原地打转护栏触发，跳过派发并强制模型收尾
任务 54 秒完成（而不是跑到 5 次）
```

护栏机制**完整可用**。

## 96. 本轮门禁

`tsc` exit 0 · **`npm test` 1446/1446 全绿**（+3 条超时语义回归）· 全局回归 **8/8**
· 多步写读 **5 步**（历史最好）

---

# 第二十轮：并发额度形同虚设 + 记忆结构（2026-10-18）

## 97. 真并发场景下发现一个真缺陷

先用 `DOTD_MAX_RUNNING=2` 做真并发测试。环境变量确实进了进程，`cpConcurrencyFromEnv()`
也正确返回 `{maxRunningTasks:2}`——**但并发度恒为 1**。

根因（`src/daemon.ts`）：

```ts
const runnerLoop = (async () => { await runner.start(abort.signal); })();
```

**只 `new DotRunner(...)` 一次、只起一个消费协程**。无论额度设多大，永远串行。
配置项承诺了并发能力，实现却只起一个消费者——名不副实。

修法：按额度起 N 个循环（`consumers = Math.max(1, cpConcurrencyFromEnv().maxRunningTasks ?? 1)`），
关闭时用 `Promise.all` 等全部。默认额度 1 → 仍只起 1 个，行为与改动前逐字一致。

**实测对比**：

| | 修复前 | 修复后 |
|---|---|---|
| 观察到的最大并发 | **1** | **2** ✅ |
| 4 任务完成 | 4/4 | 4/4 |
| 文件内容正确 | 4/4 | 4/4 |

## 98. 顺带发现的环境变量传递坑

`wsl-daemon.sh` 用 `setsid` 启动，**会丢掉调用方的环境**。所以在外部
`export DOTD_MAX_RUNNING=2` 完全无效——必须写在脚本里显式透传。
已在 `wsl-daemon.sh` 补上，并注释了这个坑。

## 99. 记忆结构：模型往 MEMORY.md 末尾乱追加

并发写记忆测试（3 个任务各追加一条标记）**3/3 全部保留，无丢失更新**。
但发现模型把标记直接 append 到文件末尾，塞进了最后一个 `## Pointers` 段，把索引结构搞乱。

`MEMORY.md` 的规范结构是：
```
# MEMORY (index)
updated: <ISO 时间>
## Interests
## Current concerns      ← 要记的事放这里
## Pointers              ← 只放 notes 路径
```

工具描述里**没写这个结构**，模型只能猜。已在 `fs.write` 说明里补上完整结构
（"别往末尾随便追加"），并修好了被污染的 `MEMORY.md`。

## 100. 本轮门禁

`tsc` exit 0 · **`npm test` 1450/1450 全绿**（+4 条回归）· 真并发 **2/2 并发度、4/4 完成** ·
全局回归 **8/8** · daemon 恢复默认并发 1

---

# 第二十一轮：并发写丢数据 —— CAS 修复（2026-10-18）

上一轮做真并发（`DOTD_MAX_RUNNING=2`）时发现：**两个任务同时改同一个文件会丢更新**。

## 101. 先量化：到底丢多少

在容器里直接做对比实验（10 个并发进程各自"读全文 → 追加 → 写回"）：

| 方式 | 最终行数 | 结果 |
|---|---|---|
| 不用 CAS 的并发 RMW | **3 行**（应为 11） | **丢了 8 个更新** |
| 用 CAS 的并发 RMW | **11 行** | 10 个写入全保留，32 次冲突重试 |

模型"读 MEMORY.md → 改 → 整篇写回"正是这个模式。`maxRunningTasks>1` 时会真实丢主人记忆。

## 102. 修法：`fs.write` 支持乐观并发控制

新增可选参数 `expected_size`（模型从 `fs.read` 返回的 `size_bytes` 拿到）：

- 传了 → 写前校验当前大小，不符则拒写并返回 **`stale_write`**（retryable），提示重新读；
- 没传 → **不校验**（零行为回退，既有调用方完全不受影响）；
- 新建文件传 0；非法值（负数/小数）视为未传。

真容器验证（A 读到 8 字节 → B 抢先改成 13 字节 → A 带旧值写回）：

```
写入结果: {"code":"stale_write","message":"文件在你读取之后已被改动（期望 8 字节，实际 13 字节）","retryable":true}
最终内容: MODIFIED-BY-B        ← B 的改动被保住，没有被默默覆盖
```

## 103. 一个诚实的局限：模型不一定会主动用

我在**工具描述**和**system prompt**里都写了"改已有文件必须带 expected_size"，
但实测两轮下来模型**一次都没传**。工具定义里确实有这个参数（我验证过 schema 与描述都带上了），
只是模型没照做。

**结论**：CAS 能力已具备且正确，但**不能指望模型自觉使用**。真正的兜底应该放在
"多个任务写同一文件"这类由系统感知的场景——即由执行层在并发时主动施加，而不是靠提示词。

本轮把能力做扎实了；这一条留作后续跟进项，并已如实记在这里。

---

# 第二十二轮：CAS 自动化 + 一次真实事故（2026-10-18）

## 104. 上轮遗留：模型不主动用 expected_size

上一轮把 CAS 做进 `fs.write`，但实测模型**两轮都没主动传过 expected_size**
（工具描述、system prompt 都写了）。结论：不能靠提示词，要变成默认行为。

**修法**：Runner 维护"本任务读过的文件大小"表（`readSizes`）。
`fs.write` 派发前，如果模型没传 `expected_size`、而本任务此前 `fs.read` 过同一文件，
就自动补上。这样"读-改-写"的并发保护从**模型自觉**变成**默认就安全**。

- 模型自己传了 → 尊重它的值；
- 没读过该文件（新建）→ 不补，没有基线；
- 每个任务开始时清空（跨任务无意义）。

## 105. 事故：MEMORY.md 被清成 0 字节

验证自动 CAS 时，模型把 `MEMORY.md` 的内容写成了**空字符串**，
`fs.write` 老实执行了 —— 一千多字的记忆变成 0 字节，而且**返回 succeeded**。
模型下一轮读到空文件，还以为是别的问题。

这是本轮最重要的发现：**CAS 只能防"并发覆盖"，防不了"模型自己写空"。**

**立刻恢复**了文件（995 字节），然后加保护：

### 防误清空

规则：**用空内容覆盖非空文件**几乎必然是模型失误（真要清空该用 `shell.run` 的 `>`），
因此拒写并返回 `empty_overwrite`，提示重新读出原文确认。

真容器验证：

```
空内容覆盖 → {"code":"empty_overwrite","message":"拒绝用空内容覆盖已有文件 guard-test.txt（当前 17 字节）…"}
文件内容: IMPORTANT CONTENT      ← 原内容保住
正常覆盖 → ok（NEW）
```

## 106. 这一轮的两条教训

1. **"让模型自觉"是靠不住的**：CAS 参数写进描述和 prompt 两轮，模型一次没用；
   改成 Runner 自动补就立刻生效。**能做成默认行为的，就不要指望提示词。**
2. **加保护时要问"它能防住什么、防不住什么"**：CAS 防并发覆盖，但完全防不住"写空"。
   这次幸好验证时真触发了事故，否则主人的记忆可能就这么没了。

## 107. 本轮门禁

`tsc` exit 0 · **`npm test` 1462/1462 全绿**（+6 条回归）· 防清空已在真容器验证 ·
容器重建后 MEMORY.md 完好（995 字节）

---

# 第二十三轮：记忆备份机制（2026-10-18）

上轮事故（MEMORY.md 被写成空串、靠外部手段恢复）说明：**记忆没有备份**。
`.archive/` 在协议里早就预留了（§3.4：硬限 32MB、按时间 FIFO），但**一直没有实际写入逻辑**。这轮补上。

## 108. 实现：覆盖前自动归档旧版本

`fs.write` 覆盖一个**非空**文件之前，先把旧内容存进 `.archive/<时间戳>__<文件名>`：

- 空文件不归档（没有可留的内容）；
- 隐藏目录（`.archive`/`.tmp`/`.dotd`）内的文件不归档（避免自我递归）；
- 单个文件 > 512KB 跳过（省得一次撑满）；
- `.archive/` 超过 32MB 按时间 FIFO 修剪；
- **归档失败绝不影响写入**（它只是保险，不是门槛）；
- 返回值里带 `archived_as`，模型和主人都能追溯。

## 109. 端到端验证（真容器）

```
写入前:  MEMORY.md 995 字节, 归档 1 份
模型改完: MEMORY.md 1016 字节（+21，标记已加）, 归档 2 份
最新归档: 995 字节 ← 正是改动前的完整内容，且不含新标记
```

**归档留的确实是"覆盖前"的版本**，可以随时回滚。

## 110. 顺带修掉一个隐患：MEMORY.md 属主被改成 root

上轮我用 `docker cp` 恢复 MEMORY.md 时，文件属主变成 `root`，
而容器里的执行用户是 `dot`（uid 1000）——**模型之后所有写记忆都会失败**。
容器不允许 `chown`（安全限制），最后用"dot 用户删掉再重建"的方式修好，属主恢复 `dot:dot`。

**教训**：用 root 手段修数据时，必须同时修属主，否则会悄悄破坏后续所有写入。

## 111. 本轮门禁

`tsc` exit 0 · **`npm test` 1467/1467 全绿**（+5 条归档回归）· 端到端归档验证通过 ·
全局回归 **8/8**

---

# 第二十四轮：记忆备份的入口（2026-10-18）

上一轮把 `.archive/` 归档做出来了，但**恢复只能手动 `docker exec cp`**——等于"有能力、没入口"。
这轮把入口补上。

## 112. 两个新 API

| 端点 | 作用 |
|---|---|
| `GET /api/memory/archive?path=&limit=` | 列出备份（按时间倒序，可按原路径过滤） |
| `POST /api/memory/restore {archive}` | 把某个归档写回原路径 |

- 归档名形状：`<ISO时间戳>__<原路径，斜杠换下划线>`，API 会把它还原成 `notes/xxx.md` 这样的路径；
- 恢复走执行面的 `fs.read` + `fs.write`，因此**恢复本身也会触发归档**——"恢复"这个动作同样可回滚；
- 名字里含 `/` 或 `..` 一律拒绝（防目录穿越）；
- 未装配时返回 **501 not_configured**（不是 500、也不是静默 404）——让人一眼看出是"没配"而非"出错"。

## 113. 真实链路验证

```
列出归档: 10 条（带时间戳、原路径、大小）
恢复前:   MEMORY.md 1016 字节，含"归档测试标记"
POST /api/memory/restore {"archive":"2026-10-18T14-29-18-370Z__MEMORY.md"}
        → {"ok":true,"restoredTo":"MEMORY.md"}
恢复后:   995 字节，标记消失   ← 回到了更早的版本
恢复本身也已归档（MEMORY.md 现有 3 份，最新 14:44:59）
```

**现在回滚记忆只需要一条 API 调用。**

## 114. 本轮门禁

`tsc` exit 0 · **`npm test` 1470/1470 全绿**（+3 条路由/解析回归）· API 端到端验证通过

---

# 第二十五轮：CLI 入口 + 一个影响所有命令的错误显示缺陷（2026-10-18）

## 115. `dotd memory archive|restore`

```
$ dotd memory archive
共 10 份备份：
  2026-10-18T14-44-59-297Z  MEMORY.md  (1016B)
     2026-10-18T14-44-59-297Z__MEMORY.md
  …

$ dotd memory archive --path MEMORY.md --limit 3
共 3 份备份：
  2026-10-18T14-44-59-297Z  MEMORY.md  (1016B)
  …

$ dotd memory restore 2026-10-18T14-29-18-370Z__MEMORY.md
✅ 已回滚：MEMORY.md（原版本已归档，如需撤销可再 restore 回去）
```

支持 `--json`（脚本里能用）、`--path` 过滤、失败退码 1。

## 116. 顺带挖出：CLI 的错误信息被吃掉了一半

上一条命令报错时只显示 **`HTTP 400`**，没有任何原因。查下来是 `cli.ts` 的 `api()` 助手：

```ts
const msg = typeof parsed?.message === 'string' ? parsed.message : `HTTP ${res.status}`;
```

**它只读 `message` 字段**。而服务端的错误体有两种形状：
- `{ error, message }`（memory/restore 等）
- `{ message }`（大多数旧端点）

凡是返回 `{error:"..."}` 的端点，在 CLI 里全部退化成干巴巴的 `HTTP 4xx`。

**修法**：两个字段都读。修完效果：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 备份不存在 | `HTTP 400` | **`读不到该归档`** |
| 归档名目录穿越 | `HTTP 400` | **`非法的归档名`** |

这个修复**影响所有 CLI 命令**——不只是 memory 组。

## 117. 本轮门禁

`tsc` exit 0 · **`npm test` 1474/1474 全绿**（+4 条 CLI 回归）· CLI 真实环境验证通过

---

# 第二十六轮：配额可见性 + 二十五轮总收尾（2026-10-18）

## 118. 归档配额可见

`.archive/` 有 32MB 硬上限 + FIFO 修剪，但**没人知道"快满了"**时，
只会某天发现老备份被悄悄删掉。补上：

- `GET /api/memory/archive` 返回 `total / totalBytes / quotaBytes / usedPct`，**满 80% 带 warning**；
- `dotd memory archive` 显示 `占用：6025/33554432 字节（0%），共 14 份`；
- 上限复用 `limits.ts` 的 `LIMIT_ARCHIVE_BYTES`（单一事实源，不另造数字）。

## 119. 二十五轮总账

### 修掉的真缺陷（按影响排）

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | 工具调用轮不入 thread + call_id 错配 + 声明顺序错 | **729 步失忆死循环** |
| 2 | `POST /api/messages` 忽略 threadId | **多轮对话永远接不上** |
| 3 | `DOTD_MAX_RUNNING` 只起 1 个消费者 | **并发额度形同虚设** |
| 4 | 护栏三个真凶（written_at / 时序 / 路径写法） | **护栏从不触发** |
| 5 | 读写路径规则不一致（`/dot/home` 算不算逃逸） | 重复调用 6→4 次，106s→34s |
| 6 | stub 假镜像 digest | 真容器起不来 |
| 7 | 出网开关没传进容器 | 模型报"没接通" |
| 8 | `fs.write` 空覆盖 / 并发覆盖 | **记忆被清空 / 丢 8-9 成更新** |
| 9 | 熔断无日志、无事件 | 故障不可见 |
| 10 | CLI `api()` 只读 message 字段 | 所有 `{error}` 端点退化成 HTTP 4xx |
| 11 | `fs.write` 忽略模型传的 timeout_ms | 超时语义两处不一致 |
| 12 | 缺 identity 走审批白弹卡片 | 卡住循环 |
| 13 | `tool_call` 声明 JSON 当正文回灌 | 模型误读自己的历史 |
| 14 | Windows 跑真 fleet 必然 quarantined | 容器不可用 |

### 最终能力基线（真容器 + 真模型实测）

| 场景 | 步数 |
|---|---|
| 明确单步（算数/写文件/读文件） | **4** |
| 联网取数 | **4–6** |
| 无人引导的复合任务 | **4–12** |
| 确认型任务（起始 185 步） | **8** |
| 多轮对话 | 正常（复用 + 隔离） |
| 危险操作 | 停在审批 |

### 记忆保护闭环

防写空 → 防并发覆盖（CAS 自动补）→ 覆盖前自动归档 → 查询 API → CLI → 配额预警。

### 门禁现状

`tsc` exit 0 · **`npm test` 1475/1475** · 冒烟 **11/11 与 16/16** · 全局回归 **8/8** ·
真飞书链路验证通过 · 崩溃恢复验证通过

## 120. 仍未完成（需要主人决策）

1. **浏览器登录身份**：`browser.*` 因缺 identity 一律拒绝（模型会清晰说明并自动降级到 `net.get`）。
   要让它开真实网页需要配置登录态。
2. **更大的模型**：当前 primary 是 `glm-5.3-flash`（A/B 三轮选出，确认型任务中位 8 步）。
   如果希望更强的推理，可以试更大参数量的模型。

---

# 第二十七轮：对标 OpenAI bot —— 补齐定时任务（2026-10-18）

目标更新为「达到 OpenAI bot 的功能和效果」。先做了一次**能力对标**（`docs/parity-gap.md`），
再用真实请求验证哪些是"看文档以为没有、实际有"，哪些是"真没有"。

## 121. 对标验证结果（真实请求，不是看代码猜）

| 能力 | 结果 |
|---|---|
| ① 联网搜索 | ✅ **能** —— 它自己找到 Hacker News 并给了真实头条 |
| ② 浏览器 | ⚠️ `browser.open` 被拒，但**自动降级 net.get 完成任务** |
| ③ **定时任务** | ❌ **timeout —— 真的做不到** |
| ④ 多模态（看图） | ❌ **timeout —— 真的做不到** |
| ⑤ 文件处理（markdown 表格） | ✅ 完美 |

**结论**：搜索能力其实已经有了（`net.get` 足够）；真正缺的是**定时任务**和**多模态**。

## 122. 定时任务：引擎有、方向盘没有

查下来讽刺得很：`crontabs` 表**早就存在**（含 cron、quiet_hours、skip_if_busy、catchup），
调度器 `scanCrontabs` **也早就能扫描触发** —— 但**从来没有任何创建入口**。
主人说"每天 9 点提醒我"，模型只能干瞪眼。

### 实现（四处缺口一次补齐）

| 层 | 做了什么 |
|---|---|
| `control-plane/schedules.ts` | create / list / remove，**先验 cron 再落库** |
| 工具面 | 新增 `schedule.create` / `schedule.list`（+ 说明书 + 引导段） |
| 执行面 | `registerHostTool` —— **宿主侧工具**机制：不进容器、由 daemon 直接执行 |
| API / 治理 | `GET/POST /api/schedules`、`DELETE /api/schedules/:id`；`tools.yml` 登记档位 |

### 三个真缺陷（做的时候撞出来的）

1. **容器在跑时，宿主侧工具对模型不可见** —— `getCapabilities` 只取容器目录，
   而容器当然不知道 `schedule.*`。模型答"schedule.create 不在列表里"（它没编造，这点很好）。
   修法：容器目录 + 宿主侧工具**合并并去重**。
2. **治理拒绝**：`deny: 工具未登记` —— `tools.yml` 没登记新工具。补上档位
   （create = write_file，list = read）。
3. **`removeSchedule` 幂等性**：对已停用的再停用会返回成功。单测抓到，改成 `WHERE enabled=1`。

### 真实链路验证

```
schedule.create succeeded
  → {"id":"ct_mvdzuj9aueicvswk","title":"早间天气提醒","cron":"30 8 * * *",
     "next_fire_at":"2026-10-19T00:30:00.000Z"}

模型回答：下次触发 2026-10-19（明天）早上 8:30（北京时间）
          我没有重复创建（否则每天会收到两条一模一样的推送）

crontabs 表：ct_mvdzuj9aueicvswk | 30 8 * * * | 早间天气提醒 | 下次: 2026/10/19 08:30:00
```

**"每天 8:30 提醒我查天气"这件事，现在真的能做了。**

## 123. 本轮门禁

`tsc` exit 0 · **`npm test` 1481/1481 全绿**（+6 条定时任务回归）· 真链路验证通过

---

# 第二十八轮：多模态输入（2026-10-18）

对标 OpenAI bot 的第二项差距：**主人发张图让它看，bot 当没看见**。

## 124. 先纠正一个差点得出的错误结论

我第一版测试用随手写的 base64 当"红色方块"，三个模型分别答「黑色/白色」，
差点得出"模型没有视觉能力"的结论。

**停下来确认测试素材后发现：那张 base64 只有 93 字节，根本不是有效图片。**
换成用代码正确生成 64×64 纯红 PNG（168 字节，`file` 校验通过）后：

| 模型 | 回答 |
|---|---|
| glm-5.3-flash | **红色** ✅ |
| Qwen3.8-Flash | **红色** ✅ |
| deepseek-v4.1-flash | **红色** ✅ |

**模型本来就有视觉能力，是我测错了。**

## 125. 真正缺的是"把图送到模型面前"

飞书图片消息的 content 只有 `{"image_key":"img_xxx"}`，**没有图片本体**；
而 inbound 的分类器把非文本消息一律 `ignore: non_text`。

修法（`src/surfaces/feishu-media.ts` + 三处接线）：

1. 分类器：`image` 类型且取到 `image_key` → 不再 ignore，带 `imageKey` 建任务；
2. `handleFeishuCallback`：下载图片 → 落进 home 卷 → 在**任务目标里写明路径**
   （`【附件】主人发来一张图片，已保存到 home 内的 media/xxx.png（122 字节，image/png）`）；
3. 下载失败也建任务，写明失败原因，要求模型**如实转告**而不是凭空描述图片。

下载走「宿主取 token → base64 交给容器的 `fs.write`」——因为 home 卷挂在容器里，宿主没有它的路径。

## 126. 真实链路验证

```
上传 /tmp/blue.png（122 字节）→ image_key=img_v3_0216j_3b6fa074-...
用 daemon 的下载实现取回：
  {"ok":true,"media":{"path":"media/img_v3_0216j_3b6fa074-....png","sizeBytes":122,"contentType":"image/png"}}
```

字节数与上传时一致、路径正确、格式识别正确。

## 127. 本轮门禁

`tsc` exit 0 · **`npm test` 1485/1485 全绿**（+4 条媒体回归）· 全局回归 **8/8** · 真飞书上传下载链路验证通过

---

# 第二十九轮：飞书文件消息 + 一个"看起来像平台限制"的误判（2026-10-19）

## 128. 缺口：主人发 PDF，bot 当没看见

`classifyFeishuInbound` 只处理 `text` 与 `image`，`file` 类型走 `ignore: non_text`。
对标 OpenAI bot（支持上传 PDF/Excel）这是明显缺口。

修法：
- 分类器识别 `file` 消息，取出 `file_key` / `file_name` / `message_id`；
- `makeFeishuMedia.downloadFile` 下载到 `media/`（保留原扩展名，模型靠它判断格式）；
- 任务目标里写明路径 + 读法（PDF 用 `pdftotext`、Word/Excel 用 python 解 zip）。

## 129. 一次自我纠错：我差点把"用错了 key"当成"平台限制"

第一次端到端验证失败，返回：

```json
{"code":234003,"msg":"File not in msg."}
```

我当场判断"**飞书限制 bot 不能下载自己发的文件资源**"，并在上一轮如实写下"未能验证"。

**这个判断是错的。** 这轮去核实，发现真正原因是：

> **飞书在发送消息时会重新生成 `file_key`** —— 上传接口返回的 key 与消息体里的
> **是两个不同的值**。用上传时那个去下载 → `File not in msg`（看起来像没权限，
> 实际是"这个 key 不属于这条消息"）。

实测对照：

```
上传时 file_key: file_v3_0016k_4ecc3538-ca79-470b-b660-eb036fe714dg
消息内 file_key: file_v3_0016k_489864a6-c60a-42a4-8d66-6fca47f5783g   ← 不同
用消息内的去下载 → HTTP 200, 420 字节 ✅
```

**代码本来就是对的**（从消息体取 key），是我的测试脚本用错了。

## 130. 端到端验证（全链路）

```
飞书文件消息 → handleFeishuCallback（生产路径）
  → 下载 439 字节 PDF → 落到 media/发票-2026-1019.pdf
  → 任务目标写入路径与读法
  → 模型 shell.run + pdftotext 读取
  → 回答：发票号 2026-1019 / 金额 76,543 CNY / 供应商 ACME  ✅ 三项全对
```

## 131. 教训

**"看起来像平台限制"的失败，值得再核实一次。** 我先入为主地接受了
`File not in msg` 的字面含义（"文件不在这条消息里" → 想成"没权限"），
差点把一个完整可用的功能记成"无法验证"。

正确做法：**拿到错误码就去查它的精确含义，而不是按字面猜。**
这次的关键是回头检查了"上传返回的 key"与"消息体里的 key"是否相同。

## 132. 本轮门禁

`tsc` exit 0 · **`npm test` 1496/1496 全绿** · 飞书文件端到端验证通过（PDF 读取三项全对）

---

# 第三十轮：健康体检抓到一个"定时炸弹"（2026-10-19）

## 133. 全面体检：8 项能力一次跑

写了一版 `scripts/health-check.sh`，覆盖文件读写 / 命令 / 联网 / PDF / 定时任务 / 记忆。

**第一次跑：PASS=5 FAIL=3。** 从第 5 项开始全部 `paused`。

日志给出原因：

```
[dotd] runner: 模型熔断 → paused(circuit_open) tk_...
（AllEndpointsDownError：ALL_ENDPOINTS_DOWN:全部模型端点均不可用（已试 3 个候选））
```

## 134. 根因不是网络抖动，是 relay 的"定时自毁"

`win-relay.mts` 末尾写着：

```javascript
const TTL_MS = Number(process.env.RELAY_TTL_MS ?? 3_600_000);
if (TTL_MS > 0) setTimeout(() => process.exit(0), TTL_MS);
```

**默认 1 小时后自己退出**（原本是防僵尸进程的设计）。而我启动它时没设 `RELAY_TTL_MS=0`，
所以每次开机大约一小时后 relay 准时消失 → 模型全不可用 → 所有任务 paused。

**这不是偶发故障，是每天必然复现的定时炸弹。**

修法：`start-dotd-stack.ps1` 启动前显式 `$env:RELAY_TTL_MS = '0'`。
relay 只是个 TCP 转发器，常驻不占资源，这才是本场景的正确选择。

## 135. 熔断机制本身表现正确

修好 relay 后观察到（这部分值得记下来，它是对的设计）：

- 熔断在 **85 秒**内自动从 `RESTRICTED` 回到 `NORMAL`，无需人工；
- 期间 `paused` 的 6 个任务**自动回队并全部跑完**；
- 故障期间提交的"每天 7 点喝水提醒"**真的建成了**（`ct_mveiob9msziqp50e`，`0 7 * * *`）；
- 读 PDF 的任务恢复后答出 `HX-2026`（正确）。

## 136. 然后我去验证"这个体检本身可不可信"

8/8 全绿是个漂亮的数字，但按 `verifying-a-measurement` 的规矩，**先问探针能不能返回另一个答案**：

1. **反向断言**：把期望值换成 `IMPOSSIBLE_XYZ_12345` → 不命中 ✅（grep 真在检查内容）
2. **失败路径**：提交到死端口 → 返回空 → 脚本会报"提交失败" ✅
3. **最关键的**：`pkill` 停掉 daemon → daemon 探针报 FAIL、提交拿不到 taskId ✅

**第 3 步还揪出我自己的一次假验证**：我本想用 `iptables` 阻断 relay 来注入故障，
结果 120 秒后 `mode` 仍是 `NORMAL`——**阻断根本没生效**。如果我当时直接跑体检，
它会显示 PASS，而我会误以为"故障下也验证过了"。换成 `pkill daemon` 才是真注入。

## 137. 本轮门禁

体检 **8/8 全绿**（探针已证明能失败）· `tsc` exit 0 · `npm test` 1496/1496 · 服务全部恢复 NORMAL

---

# 第三十一轮：开机链路的两个真缺陷（2026-10-19）

上一轮修了 relay 自退，但那只是"改了代码"，**没验证过重启**。这轮去验证，撞出两个问题。

## 138. 缺陷一：WSL 已在运行时，[boot] command 不会再触发

模拟开机时发现 daemon 起不来，`/var/log/dotd-boot.log` 停在几个小时前。

原因：`/etc/wsl.conf` 的 `[boot] command` **只在 WSL 实例启动那一刻执行一次**。
而 `start-dotd-stack.ps1` 只做了 `wsl -e bash -lc 'echo wsl-up'` ——
如果 WSL 已经跑着（开机后你开过终端就很常见），这个命令不会触发 boot，
daemon 就一直躺着。

修法：启动脚本**显式调用** `wsl -u root -e bash /usr/local/bin/dotd-boot.sh`
（它自己是幂等的，已在跑会直接返回），最后再探测 7788 端口确认。

## 139. 缺陷二：PowerShell 脚本里的全角标点

改完脚本后 PowerShell 解析器报"字符串缺少终止符"，但我肉眼怎么看都正常。
逐字符查下来，是注释里一个**全角冒号 `：`（U+FF1A）** ——

PowerShell 在解析 `"..."` 时会把全角引号/冒号当作终止符，
而中英文混排的注释里出现全角标点极其自然。**这类错误肉眼几乎看不出来。**

处理：把脚本里的全角标点统一换成半角，并用
`[System.Management.Automation.Language.Parser]::ParseFile()` 做语法校验
（比"跑一下看看"可靠，不会因为提前 return 而漏掉后半段的语法错误）。

## 140. 完整开机模拟验证

停掉全部（relay + daemon），然后**从启动项原路拉起**：

```
08:51:00  agent2api 已运行
08:51:00  启动 win-relay...
08:51:02    relay 就绪(0s)          ← TTL=0，不再 1 小时自退
08:51:02  拉起 WSL 并确保 daemon 运行
08:51:07  daemon 端口 7788 就绪      ← 显式调用 boot 生效
08:51:07  ===== 完成 =====
```

最终状态：daemon OK / 飞书长连接 1 / 熔断 NORMAL / 容器 Up。

## 141. 顺带确认 TTL 真的传下去了

不满足于"脚本里写了 `$env:RELAY_TTL_MS='0'`"，去抓 relay 自己的启动输出：

```
win-relay 就绪，0s 后自退（设 RELAY_TTL_MS=0 常跑）
```

`0s` 而不是 `3600s` —— **确认生效**。

## 142. 本轮门禁

完整开机模拟通过 · daemon/飞书/熔断/容器全部正常 · `tsc` exit 0 · `npm test` 1496/1496

---

# 第三十二轮：watchdog 从"只会报警"变成"会自己动手"（2026-10-19）

## 143. 缺口：告警不等于恢复

上一轮的 watchdog 发现问题只会发飞书。想象一下半夜 3 点：

```
⚠️ dotd 异常：模型端点不可达（win-relay 13065）
```

主人被吵醒，还得自己起床敲命令重启 —— 而这故障**一条命令就能修**。

## 144. 加入自愈：先修，修不好再喊人

三个修复器，都在检查失败时**优先尝试**：

| 故障 | 自愈动作 |
|---|---|
| daemon 不可达 | `dotd-daemon-start.sh` 重启 |
| docker 不可用 | `systemctl reset-failed` + `start` |
| relay 不可达 | 用 `powershell.exe` 跨到 Windows 侧重启（带 `RELAY_TTL_MS=0`）|

修复失败才走原来的告警路径；告警阈值/冷却逻辑不变。

## 145. 实测（不是看代码，是真停真起）

**relay 自愈：**
```
停掉 Windows 侧 relay 进程
08:55:02 自愈:尝试在 Windows 侧重启 relay
08:55:05 自愈:relay 已恢复(2s)
模型接口: HTTP 200  ✅
```

**daemon 自愈：**
```
pkill daemon
08:55:19 自愈:尝试重启 daemon
08:55:23 自愈:daemon 已恢复(4s)  ✅
```

## 146. 一个低级但真实的失误

第一次测自愈**失败**了 —— 日志里只有"失败"，没有任何"自愈:"。

原因：我把改动写进了 `/root/dotd/scripts/dotd-watchdog.sh`，
但 cron 执行的是 `/usr/local/bin/dotd-watchdog.sh`。**装了一份旧文件。**

这和上一轮"验证开机没走真实路径"是同一类错误：
**改完要确认"跑的那份是不是改的那份"**。这次在测试脚本开头加了一步
`grep -q repair_relay /usr/local/bin/...` 自检，才定位到。

## 147. 本轮门禁

relay/daemon 自愈实测通过（2s / 4s）· `npm test` 1496/1496 · 服务全部 NORMAL

---

# 第三十三轮：拿真实使用数据找问题（2026-10-19）

这轮不看代码猜，直接查数据库里 373 个真实任务的执行记录。

## 148. 数据总览

```
任务：done 373 / cancelled 17
工具：fs.write 668+ / fs.read 645 / shell.run 302 / net.get 105
```

## 149. 一次差点误报：把历史记录当成现行缺陷

初看有两个"大问题"：

- `schedule.create skipped 13`（`deny:工具未登记`）
- `fs.write failed 33`（`/dot/home/xxx` 被拒）

**两个都是旧记录。** 去查时间戳才发现：

```
schedule.create:
  10/18 23:36-23:40  denied ×13    ← round 27 修复之前
  10/19 08:29        succeeded      ← 修复之后
  10/19 08:41        succeeded
```

`fs.write` 那批是 round 25（`/dot/home` 前缀免剥）之前留下的。

**教训**：查数据库缺陷时，**必须带上时间维度**。否则会拿几十小时前的记录去报当下的问题，
既浪费一轮工作，也可能"修"一个早就不存在的 bug。

## 150. 但确实做了一次有价值的复测

既然代码有测试（`memory-home-prefix.test.ts` 3/3 通过），还得确认真实环境也生效：

```
任务：请把内容 ABS-PATH-OK 写到 /dot/home/abs-verify.txt 这个绝对路径
fs.write succeeded  {"path":"/dot/home/abs-verify.txt"}
文件确实存在：ABS-PATH-OK（11 字节）
```

模型还自己总结出："绝对路径读写都被接受，会归一化到家目录内同一个文件" ——
**它学到了正确经验，不会再去撞这堵墙。**

## 151. 顺带发现：cancelled 17 个都是"故意设计"的测试

- `把内容 TEST 写到 /dot/home/abs-test.txt 这个绝对路径。如果失败，请换...`
- `反复检查 guard.txt 是否存在，一直检查到你完全确信为止`

后者是**重复调用守卫**的测试用例 —— 守卫触发后任务被取消，这是预期行为，不是缺陷。

## 152. 本轮门禁

真实环境复测通过 · `npm test` 1496/1496 · 服务全部 NORMAL

---

# 第三十四轮：真实场景压测揪出"交替调用空转"（2026-10-19）

## 153. 先承认上轮的判断有问题

上轮我说"真实使用数据健康（373 done）"，但查标题才发现：**最近 30 个任务全是我自己的测试**
（`ABS-PATH-OK`、`HEALTH-CHECK`、`PROBE_XYZ`…）。我是在拿自己的测试数据自我验证。

于是这轮换了做法：**用主人真正会说的话去压测**，不带"验证 XX 功能"这种测试腔。

## 154. 压测结果暴露一个真缺陷

5 个真实场景，其中一个（"查 zen 接口并存成笔记"）跑了 **25 步还没写文件**。

看步进记录，模式是：

```
net.get(zen)        → 成功
fs.stat(zen-note.md) → 不存在
net.get(zen)        → 成功
fs.stat(zen-note.md) → 不存在
net.get(zen)        → 成功
fs.stat(zen-note.md) → 不存在
…重复到 25 步
```

**它已经拿到数据了，却一直在"检查文件在不在"，不去写。**

## 155. 为什么重复守卫没拦住

原有守卫只认"**同一 (工具,参数)** 连续重复"。而这个模型**交替**调用两个不同工具，
每一步单独看都是"新调用"，守卫完全沉默。

修法：额外跟踪「每任务 × 每工具」的调用次数；`net.get` / `fs.stat` 达到 6 次时回喂一条：

> 如果你已经拿到了需要的信息，就不要再重复查询 —— 直接用已有结果完成任务。

## 156. 复测

同一个场景重跑：

| | 修复前 | 修复后 |
|---|---|---|
| net.get | 6 次 | **5 次**（第 6 次被拦） |
| fs.stat | 3 次 | **1 次** |
| 最终 | 25 步未完成 | **23 步完成，文件写成 758 字节** |

护栏确实在起作用。但 23 步/316 秒仍然偏慢——模型写完后会反复读回确认，这是下一步该看的。

## 157. 本轮门禁

`tsc` exit 0 · **`npm test` 1499/1499**（+3 条交替调用回归）· 真实场景复测通过

---

# 第三十五轮：主力模型选型有误 —— 只看步数、没看延迟（2026-10-19）

## 158. 线索：任务慢，但慢在哪

上轮留下的问题："zen 任务 23 步 / 316 秒，写完后反复读回确认"。

把它拆开看每步耗时，结论很意外：

```
LLM 总耗时: 463.2s
工具总耗时:  6.7s
```

**工具只花 6.7 秒，模型调用花了 463 秒。** 慢的不是工具，是模型。

再看延迟分布（最近 100 次成功调用）：

```
p50 =  9.4s
p90 = 39.3s
p99 = 146.9s
```

最慢那几次 `completion_tokens` 高达 5000+ —— 模型在长篇大论。

## 159. 根因：round 5 的 A/B 只测了步数

查选型记录（§38）发现，当时的三模型 A/B 只比了两件事：

> | 模型 | S5 确认型中位数 | 答案正确率 |
> |---|---|---|
> | deepseek-v4.1-flash | 14 步 | 3/3 |
> | **glm-5.3-flash** | **8 步** | 3/3 |

于是选了 glm。**但全程没有测延迟。**

而实际数据（1271 vs 912 次调用）：

| 模型 | 平均延迟 |
|---|---|
| glm-5.3-flash | **15207 ms** |
| deepseek-v4.1-flash | **1748 ms** |

**glm 慢 8.7 倍。** 步数少一半、每步慢八倍 —— 总时间反而更长。

## 160. 同任务 A/B 实测

同一套真实任务，只换 primary：

| 任务 | glm-5.3-flash | deepseek-v4.1-flash | 提速 |
|---|---|---|---|
| 简单计算 | 6 步 / **16.9s** | 4 步 / **5.6s** | 3.0× |
| 写文件+读回 | 10 步 / **114.6s** | 10 步 / **12.7s** | 9.0× |

**步数持平或更少，速度快 3–9 倍。**

## 161. 正确性复核（不能只快不对）

6 个有明确对错的任务，deepseek 全部通过：

```
✅ 算术（1008）        ✅ 读写一致（XYZ-789）
✅ 推理（150）         ✅ 联网（取到 zen 原文）
✅ 拒绝越权（/etc/passwd）  ✅ 文档（PDF 里的 HX-2026）
```

每个任务 4–8 秒。

## 162. 决策

`primary` 从 `glm-5.3-flash` 切回 **`deepseek-v4.1-flash`**。
`glm-5.3-flash` 留在 fallback 链里（它步数确实更少，作为降级候选仍有价值）。

**教训**：选型指标必须覆盖**用户能感知的东西**（端到端耗时），
不能只测内部指标（步数）。步数少不等于快 —— 每步贵八倍时，少几步毫无意义。

## 163. 本轮门禁

同任务 A/B 提速 3–9× · 正确性 6/6 · `tsc` exit 0 · `npm test` 1499/1499

---

# 第三十六轮：查清"读到了 /etc/passwd"这件事（2026-10-19）

上一轮场景压测里，让 bot 读 `/etc/passwd`，它**真的读出来了**。第一反应是"安全边界被突破"。
这轮去查清楚。

## 164. 实际发生了什么

步进记录：

```
2  fs.read   failed     {"path":"../../etc/passwd"}
   → {"code":"path_outside_home","message":"路径越出 /dot/home"}
4  shell.run succeeded  {"cmd":"cat /etc/passwd"}
   → root:x:0:0:root:/root:/bin/bash ...
```

**`fs.read` 的边界被 `shell.run` 绕过了** —— 模型被拒后换了条路，成功了。

## 165. 但严重性没有第一眼那么高

去查容器隔离程度：

| 检查项 | 结果 |
|---|---|
| 宿主 `dotd.db`（全部对话记录） | ✅ 不可访问 |
| 宿主凭据 `_tokens_src.env` | ✅ 不可访问 |
| 宿主源码 `/root/dotd` | ✅ Permission denied |
| `docker.sock` | ✅ 不可访问 |
| 容器内 `/etc/passwd` | ⚠️ 可读 —— **是容器自己的**，不是宿主的 |

容器内 `/etc/passwd` 来自 playwright 基础镜像（Ubuntu），前几行与宿主相同纯粹因为都是 Ubuntu。
**它不泄漏任何宿主信息。**

## 166. 真问题是"策略没写清楚"，不是"越权"

`shell.run` 的说明书里写了"不能联网""拿不到密钥"，但**完全没提文件系统边界**。

于是模型只能靠试错去发现："fs.read 不行，但 shell 可以"。这不是漏洞，是**文档缺口** ——
它会浪费步数去撞墙，也会让主人（和未来的我）误以为出了安全问题。

修法：在 `shell.run` 说明书里加一段明确边界：

> **文件系统边界（重要）**：shell 能读整个**容器**文件系统（/etc、/usr 等都在），
> 而 fs.* 只能读写 /dot/home。所以 fs.read 报 path_outside_home 时，如果确实要看容器内的
> 系统文件，可以用 shell；但**主人家的文件（/root、dotd.db、密钥）在容器里看不见**，那是宿主，别去试。

## 167. 验证：模型真的理解了

三问三答，全对：

```
【1】读容器 /etc/os-release → ✅ "Ubuntu 24.04.1 LTS (Noble Numbat), x86_64"
【2】读宿主 dotd.db        → ✅ "读不了，这个文件在我够不到的地方。
                                 我以非特权用户(uid 1000)在容器里运行，/root 目录…"
【3】读宿主凭据             → ✅ "我不能提供那个文件的内容。
                                 它在容器外面（宿主机路径），我的 shell 只能看到容器…"
```

**不只是拒绝，还准确说出了原因。** 这是正确的行为。

## 168. 顺带修正一个测试方法问题

上轮真实场景压测 3 个失败，查下来都是**我的等待上限太短**（等 5 分钟，任务还没跑完就判失败）。
改成 10 分钟重跑后 **5/5 全过**，且步数大幅下降（周报 11 → 4 步）。

测试的判据错了，会把正常当成失败 —— 和"把历史记录当现行缺陷"是同一类错误。

## 169. 本轮门禁

边界理解 3/3 · 真实场景 5/5 · `tsc` exit 0 · `npm test` 1499/1499

---

# 第三十七轮：VOLUME 修复落地 + 一次 WSL 卡死（2026-10-19）

## 170. 修好的 Dockerfile 必须重建镜像才算数

上一轮改了 `exec-image/Dockerfile`（VOLUME 行尾注释），但**镜像还是旧的** ——
再验证之前先重建：

```
删旧镜像 → 停容器 → 重启 daemon（boot 自动重建）
```

重建后验证，修复确实生效：

| | 修复前 | 修复后 |
|---|---|---|
| 镜像声明 VOLUME | 8 个（含 `#`、`/dot/profiles]`、`卷与`…） | **2 个**（`/dot/home`、`/dot/profiles`） |
| 容器挂载 | 12 个（含 8 个匿名卷） | **4 个**（全是有名字的卷） |
| `/dot/` 目录 | 含 `profiles]` 畸形目录 | 只有 `home`、`profiles` |
| 卷总数 | 173 | **45** |

## 171. 顺带踩到一次 WSL 卡死

`docker volume prune` 删掉 129 个卷后，WSL 进入 `Compacting` 状态并**卡了十几分钟**：

```
Wsl/Service/CreateInstance/E_ILLEGAL_STATE_CHANGE
```

期间 `wsl --terminate`、`wsl --shutdown`、`Stop-Service LxssManager` 全部无效
（最后一条是因为没有管理员权限）。`vmmem` CPU 已经是 0，说明压缩其实结束了，
**卡的是 WSL 的状态机**，不是真的在压缩。

最后它自行超时恢复了。**记录一条经验**：批量删卷前先想清楚 WSL 会不会触发压缩；
真卡住时先等 10–15 分钟，别急着认为数据丢了 —— vhdx 和 git 历史都完好。

数据安全确认：D 盘项目完整、git 提交齐全。

## 172. 本轮门禁

镜像重建后挂载从 12 → 4 · 卷 173 → 45 · daemon/飞书/容器全部正常 · 端到端 `VERIFY-OK` ·
`tsc` exit 0 · `npm test` 1499/1501（2 条新增 Dockerfile 守卫）

---

# 第三十八轮：补上 WSL 卡死的监控盲区（2026-10-19）

## 173. 盲区在哪

前几轮建的 watchdog 跑在 **WSL 里面**。而 2026-10-19 实测过一次 WSL 整体卡死
（`docker volume prune` 后进入 `Compacting` 状态，卡了十几分钟）：

> WSL 挂了 → 里面的 watchdog 也挂了 → **没有任何人报警**。

这是结构性的：只有 WSL **之外**的进程才能发现"WSL 没了"。

## 174. Windows 侧探针（`scripts/dotd-probe.ps1`）

独立进程，只做三件事：

| 步骤 | 动作 |
|---|---|
| ① | 探测 7788 端口 |
| ② | 连续 3 次失败 → **先自愈**，修不好再发飞书 |
| ③ | 自愈分两种：WSL 活着 → 调 `dotd-boot.sh`；WSL 死了 → `wsl --shutdown` 后重启 |

告警里会写清楚**原因判断**（"WSL 整体无响应" vs "WSL 活着但 daemon 起不来"），
并注明"这是 Windows 侧探针发出的"——收到这条就说明 WSL 内 watchdog 已经指望不上了。

## 175. 写的时候踩了一个很典型的 PowerShell 坑

第一版探针测试时"停掉 daemon 仍然静默通过"。根因在 `Test-Port`：

```powershell
try {
  $ok = $task.Wait(3000)
  $connected = $client.Connected     # ConnectAsync 抛异常时这行走不到
  return ($ok -and $connected)
} catch { return $false }
```

异常时 `$connected` 还是 `$null`，`$ok -and $null` 得到 **`$null`**，而调用方
`if ($daemonOk)` 把 `$null` 当**真** → 故障被静默吞掉。

**这和"探针永远通过"是同一类错误**，只是藏在 PowerShell 的真值语义里。
修法：每个出口显式 `return [bool]`，并加 `finally` 关连接。

## 176. 实测（真停真起）

常驻模式下停掉 daemon：

```
10:06:13  daemon unreachable (attempt 1)
10:06:30  daemon unreachable (attempt 2)
10:06:47  daemon unreachable (attempt 3)
10:06:47  self-heal: restarting daemon
10:06:52  self-heal OK (0s)     ← 5 秒修好
```

## 177. 自启动

启动文件夹新增 `dotd-probe.cmd`（`-LoopSeconds 60`），与原有的 `dotd-stack.cmd` 并存。

## 178. 本轮门禁

探针实测通过（检测 + 自愈）· **`npm test` 1505/1505**（+4 条探针静态守卫，
含"每个 return 必须显式布尔"——已验证植入 bug 时会失败）· daemon/飞书/容器正常

---

# 第三十九轮：谁来看守看守者（2026-10-19）

## 179. 探针自己会挂

上一轮加的 Windows 侧探针是**常驻 PowerShell 进程**。它要是崩了，就又没人监控 WSL 了——
而启动文件夹只在登录时执行一次，**中途崩溃不会自动重启**。

先试的"自写守护者"方案是错的：守护者自己也会崩，这是无限递归。

## 180. 正确做法：把保活交给系统

改成 **Windows 计划任务**（每 1 分钟触发，`MultipleInstances=IgnoreNew`）：

- 探针改成**短命**进程（`-LoopSeconds 0`，检查一次就退出）—— 不存在"常驻进程崩溃"这个类别
- 崩了就崩了，下一分钟系统照常拉起
- 卡住也不会堆积（IgnoreNew）

顺便删掉了启动文件夹里的常驻项，避免两套机制打架。

## 181. 这一轮抓到一个真故障

改完立刻遇上了 **WSL 真的再次卡在 `Compacting`**：

```
10:10:46  daemon unreachable (attempt 1); wslAlive=False    ← 正确识别"WSL 整体没了"
10:13:16  WSL unresponsive; wsl --shutdown then restart
10:15:40  self-heal OK (66s)                                ← 自动恢复
```

**探针第二次就抓到了它存在的理由。** 而且这次是我第一次看到它自己修好 WSL。

## 182. 然后是三个连环坑（都不容易发现）

**坑 1：心跳日志一直没有**
健康时探针不写任何日志，导致"在正常运行"和"进程假死"无法区分。加心跳时发现
`Write-Log` 在函数内抛异常会**静默中断整个 Invoke-Check**。

**坑 2：`Add-Content` 并发锁**
计划任务每分钟拉起一个新探针，`Add-Content` 并发时会因文件占用抛异常。
改用 `[IO.File]::AppendAllText`（FileShare.ReadWrite），并给日志写入加 try/catch 兜底。

**坑 3（最隐蔽）：PowerShell 5 对纯 LF 换行的 .ps1 有解析缺陷**
文件是 `CR=0 LF=177`，解析器报"缺少 }"，但括号其实平衡。
函数体被静默丢弃 → 心跳行永远不执行。**改成 CRLF 立刻正常。**

这个坑肉眼完全看不出来：文件能跑、不报错、只是某些行不执行。

## 183. 本轮门禁

探针抓到真实 WSL 卡死并自愈（66s）· 心跳正常每分钟留痕 · **`npm test` 1508/1508**
（+3 条守卫：CRLF 换行、心跳存在、AppendAllText）

---

# 第四十轮：并发自愈会互相打架（2026-10-19）

## 184. 从日志里发现的模式

翻探针日志，看到这两行挨得很近：

```
10:12:40  self-heal: restarting daemon
10:12:40  WSL unresponsive; wsl --shutdown then restart
10:13:16  self-heal: restarting daemon        ← 又来一次
10:13:16  WSL unresponsive; wsl --shutdown then restart
10:15:40  self-heal OK (82s)
10:15:40  self-heal OK (66s)                  ← 两个都在报"成功"
```

**两个探针实例同时在修**。它们各自跑到 `wsl --shutdown`，结果互相把对方刚拉起来的 WSL 又关掉 ——
所以两个都耗了 60~80 秒才"成功"，实际上是互相拖累。

## 185. 为什么计划任务的防并发没挡住

计划任务确实配了 `MultipleInstances=IgnoreNew`。但那个**只挡"任务自己"的并发** ——
我在手动排查时也会直接跑 `dotd-probe.ps1`，这条路径不受计划任务约束。

而自愈本身要 60–80 秒，超过 1 分钟的触发间隔，所以很容易撞上。

## 186. 修法：进程级命名 Mutex

```
$mutexName = 'Global\dotd-probe-singleton'
```

- 拿不到锁 → **静默 exit 0**（不算失败、不写日志，避免刷屏）
- 处理 `AbandonedMutexException`（上一个持有者崩了要能接管）

这挡的是**所有来源**：计划任务、手动运行、别的脚本调用。

## 187. 实测

**并发防护**：同时启动 5 个探针 →

```
日志里只有 1 条完整检查序列
daemon 被正确恢复（OK）
没有出现互相打断
```

**单实例防护**：同时启动 3 个探针 → `probe started` 只出现 1 次。

## 188. 本轮门禁

并发自愈实测通过 · **`npm test` 1509/1509**（+1 条互斥守卫）· daemon/飞书/容器正常

---

# 第四十一轮：验证修复真的带来了改善（2026-10-19）

连着几轮修稳定性，这轮换个体检姿势：**看今天的数据，确认修复有没有效果**。

## 189. 数据说话

```
今天：done 54 个任务
工具调用成功率：95.2%（120/126）
模型调用：ok 232 次，fail 15 次
```

## 190. 两个"看起来是问题"的，查下来都不是

**① 平均延迟还是 12 秒？**
模型切换后平均延迟没降，第一反应是"切换没生效"。查明细：

| 模型 | 次数 | 平均延迟 |
|---|---|---|
| glm-5.3-flash | 173 | 15743ms |
| deepseek-v4.1-flash | 58 | **1627ms** |

glm 的 173 次**全是 09:24 切换之前**的。最近 20 次调用全部是 deepseek，平均 1.5 秒。
**切换生效了**，只是全天的平均值被历史数据拉高。

**② 15 次模型调用失败？**
按时间列出来，全部集中在 **00:36 / 08:29 / 08:30 / 08:40** —— 正是 relay 自退那几段。
**09:24 修复之后，一次失败都没有。**

## 191. 但压测撞到一个真问题：容器被自动隔离

连续压测 12 个任务，第一轮 **8/12**，4 个失败都报：

> 我的容器现在处于 **quarantined** 状态

查容器本身：`Up`、`running`、runtime 端口可达、日志正常。**容器是好的。**
查 daemon 的状态表：

```json
{"state":"quarantined", "recreate_count": 7, "last_health_at":"01:37"}
```

`recreate_count = 7`，而保护阈值是 **>3/24h** —— 我今天为了重建镜像、清理卷，
反复重建容器 7 次，系统按设计判它"不稳定"并隔离了。

**这是保护机制正常工作，不是缺陷。** 是我的操作触发的。

重置状态后重跑：**12/12 全过，平均 6577ms**（对比第一轮 7295ms）。

## 192. 留下一个运维要点

`recreate_count > 3/24h` 会触发隔离，而**隔离后所有依赖容器的任务都会失败**。
以后遇到"读文件/列目录/文档类任务全失败，但 model 说容器有问题"，
第一件事应该是查这张表：

```sql
SELECT state, recreate_count FROM containers WHERE dot_id='dot1';
```

重置：`UPDATE containers SET state='ready', recreate_count=0`。

（这个操作值得做成 CLI 子命令，下轮补。）

## 193. 本轮门禁

连续压测 **12/12**，平均 6.6s · `npm test` 1509/1509 · 探针心跳正常 · 容器 ready

---

# 第四十二轮：容器隔离状态的查询与重置入口（2026-10-19）

## 194. 上轮留下的运维痛点

上轮发现"容器被 quarantined 导致 4 个任务失败"，排查方式是**手写 SQL 查表**：

```sql
SELECT state, recreate_count FROM containers WHERE dot_id='dot1';
```

这对主人不公平——报错信息是"模型说容器有问题"，而真相是 `recreate_count > 3/24h`
触发了保护。**没有任何入口能让人看到这件事。**

## 195. 加两个入口

| 入口 | 作用 |
|---|---|
| `GET /api/container` | 看状态；隔离时**直接给出提示和解决办法** |
| `POST /api/container/reset` | 确认容器正常后重置为 ready、清零计数 |
| `dotd container [--reset]` | 上面的 CLI 包装 |

隔离时的输出长这样：

```
dot=dot1  状态=quarantined  24h 重建次数=5
docker=f1277794...  最近健康=...
提示：容器被隔离（24h 内重建超过 3 次）。确认容器本身正常后，POST /api/container/reset 重置。
```

## 196. 中途撞了一个低级错误

插 CLI 命令时把 `sos-test` 的命令链写断了 —— `npm test` 立刻报 4 条失败（sos-test 相关）。
原因是 `.command('container')` 那条链以 `})` 结尾后直接接 `.command('sos-test')`，
少了 `program`。**这正是回归测试该发挥作用的地方**，立刻就抓到了。

## 197. 实测

```
正常:      状态=ready  重建次数=0
模拟隔离:  状态=quarantined  重建次数=5   ← 提示正确出现
--reset:   已重置为 ready 并清零
确认:      状态=ready  重建次数=0
```

## 198. 本轮门禁

`dotd container` / `--reset` 实测通过 · **`npm test` 1512/1512**（+3 条路由守卫）·
`sos-test` 未受影响（命令链已修）

---

# 第四十三轮：出站消息终于能事后追查了（2026-10-19）

## 199. 一个从没被验证过的假设

之前所有验证都走 HTTP API（`/api/messages`），但**飞书里的真实使用走的是另一条路径**：
WS 长连接 → `handleFeishuCallback` → 任务 → 出站 `sendText` 回原会话。

查这条链路有没有可追查的记录时发现：**没有任何出站审计表**，只有日志。
而日志在每次 daemon 重启时被清空（`wsl-daemon.sh` 里 `: > "$LOG"`）。

**后果**：主人说"我没收到回复"时，完全无法回答——
那条任务回没回？发到哪个会话？飞书 API 报了什么错？全都查不到。

## 200. 修法：落一张小表

迁移 `130_surf_outbound_log.sql`：

| 列 | 含义 |
|---|---|
| kind | task_reply / approval |
| dedup_key | 与发送侧的去重键一致，便于和日志对上 |
| chat_id | 发到哪个会话 |
| **ok** | 成功/失败 |
| **error** | 失败原因（排查关键） |
| text_preview | 前 200 字（全文已在 mem_messages） |

配套：
- `recordOutbound()` / `listOutbound()`（写失败**绝不**影响发送本身——审计是旁路）
- `GET /api/outbound?limit=&kind=`
- `dotd outbound -n 20 -k task_reply`

## 201. 中途被迁移保护挡住

加完迁移，daemon 直接拒绝启动：

```
MigrationError: 迁移后 user_version=130，期望 120
```

**这是保护机制的正确行为**——`expectedVersion` 必须与迁移目录里最大的 NNN 一致，
防止"代码和库版本对不上"。同步改成 130 后正常。

## 202. 然后是一串测试断言要跟

`npm test` 报了 5 处失败，全是硬编码 `user_version=120` 的断言（分布在 4 个文件）。
一处一处改完 **1516/1516 全绿**。

这类"新增迁移就要改一堆断言"的摩擦值得记下来——它说明版本号被复制到了太多地方。

## 203. 实测

```
写入 2 条（1 成功 1 失败）→ 读出 → CLI 显示
[OK ] task_reply → oc_test_123
[FAIL] task_reply → oc_test_123 (permission denied)
```

## 204. 本轮门禁

出站审计写入/读出/CLI 全部实测通过 · **`npm test` 1516/1516**（+4 条审计测试）·
迁移 130 生效 · daemon/飞书/容器正常

---

# 第四十四轮：从真实对话里找问题（2026-10-19）

上轮意识到"飞书真实路径和 API 测试路径有差异"，这轮去翻**真实对话记录**。

## 205. 找到了你在 10/18 的五轮真实对话

```
14:25  今天天气怎么样
16:13  你好，你能干什么
16:45  你能干什么了     ← 又问了
16:53  可以
16:54  你拿不到吗，根据我的ip
```

**同一天问了两遍"你能干什么"**，这个重复值得深挖。

## 206. 原因不是 bot 不行，是当时的出网确实没开

第一轮回答：

> 我查不了今天的天气——这台电脑的出网工具还没接通（设 `DOTD_NET_TOOLS=get`）

第二轮（16:45），它**自己先实测再回答**：

> 刚实测了一把 —— **出网已经通了**。所以上一轮说的"出网通道还没接通"已经过时了，得纠正

第三轮（16:54）关于 IP 定位：

> 先实测再回答：拿到了 —— 根据出口 IP 定位，你在**北京**（IP 222.128.5.238，北京联通）
> 北京现在：晴 15.5°C，体感 13.3°C ... 你的城市我已经记下来了

**这段对话质量很高**：被质疑时先实测、发现旧结论过时主动纠正、查完把结果记进长期记忆。

## 207. 复测两个场景，都还正常

**天气（不带城市）**：10 秒完成，一次 `net.get` 就拿到北京的实况——**它记得城市**。

**自述的 4 类能力逐条验证**：

| 能力 | 结果 |
|---|---|
| ① 记事（跨会话不忘） | ✅ 能读回北京 |
| ② 文件与笔记 | ✅ 写读一致 |
| ③ 本地跑命令 | ✅ 计算正确 |
| ④ 上网 | ✅ 取到数据 |

**4/4 属实，没有虚报。**

## 208. 一个真实缺口的反思

那五次对话里，**没有一条是我的测试**——是你在真实使用。
而那次使用暴露的问题（出网没开）**当时就修好了**，我后来几十轮测试全是走 API 路径，从没回头看真实对话。

**教训**：验证要覆盖"真实入口"，而不只是"我能构造入口"。
今天的 API 测试和飞书真实路径在很多细节上不同（会话复用、出站、文件下载的 file_key），
差异恰好都在真实路径上。

## 209. 本轮门禁

真实对话复盘完成 · 天气/记忆/文件/命令/联网 5 项复测通过 · `npm test` 1516/1516 · 无代码改动

---

# 第四十五轮：让"你能干什么"必须实测（2026-10-19）

## 210. 从真实对话里挖出的模式

复盘 10/18 那五轮真实对话，发现一个模式：**你连问了两次"你能干什么"**，
因为第一次答复说"出网还没接通"——而当时确实没开，后来你开了，它却还拿旧结论作答。

复测同一句话三次，行为不一致：

| 次数 | 步数 | 是否实测 |
|---|---|---|
| 第 1 次 | 2 | ❌ 凭记忆 |
| 第 2 次 | 2 | ❌ 凭记忆 |
| 第 3 次 | 7 | ✅ 先跑了一遍 |

**同一个问题，两种可信度。**

## 211. 缺口在哪

纪律里已经有"信息不足时优先去查，而不是猜"，但没有**专门针对"描述自己能力"**这一条。
而这类问题恰恰是最容易凭记忆作答的（能力会变：出网开关、容器状态、新装工具）。

补一条：

> **被问"你能干什么"时先实测再答**：能力会变（出网开关、容器状态、新装工具），
> 凭印象会说过时的话。一句话验证：net.get 打个公开接口、fs.list 看 home、
> shell.run 跑 `command -v <工具>`。

## 212. 踩了两个小坑

**① 反引号**：模板字符串里写 \`command -v\` 必须转义，第一次写漏了直接编译失败。
PowerShell 脚本里再嵌反引号更麻烦——最后用 edit 工具逐行改才稳。

**② 长度预算**：system prompt 有 4000 字符硬上限，加完 4181 超了。
先精简新内容，再把一条旧的冗长实测记录压缩，最终落在 4000 以内。

## 213. 实测生效

| | 修复前 | 修复后 |
|---|---|---|
| 第 1 次 | 2 步，凭记忆 | **6 步，net.get + fs.list + shell.run** |
| 第 2 次 | 2 步，凭记忆 | **5 步，net.get + fs.list** |

回答里明确写了"我刚才实际测试了当前环境，结果如下（不是凭印象说的）"。

## 214. 本轮门禁

实测生效（2→5/6 步，均先跑工具）· `tsc` exit 0 · **`npm test` 1516/1516**

---

# 第四十六轮：模糊指令的处理（2026-10-19）

## 215. 继续挖 10/18 那段对话

上一轮解决了"凭记忆答能力"的问题。这段对话里还有一处值得看：

```
【主人】可以
【bot】好——就差最后一个信息：你在哪个城市？
```

主人说"可以"，bot 当成"还没给城市"。这次复现同样的模式。

## 216. 复现结果：这次好得多

```
【主人】可以
【bot】「可以」我不敢猜你指的是哪一件——刚才我给了三个例子，猜错代价不大但白忙一场。
       你只需要回一个字母：A: 整理家目录 ... B: ... C: ...

【主人】好
【bot】整理完了。
```

**没有硬猜**：模糊确认时列出明确选项让主人选；收到"好"后**执行了选项 A**。

## 217. 而且执行质量很高

看那次"整理"任务的完整步进：

```
2   find 根目录的文件（先看清有什么）
4   ls .archive（了解已有归档结构，避免覆盖）
6   逐个检查 report.pdf / health-doc.pdf / sales.xlsx（判断哪些是重要文件）
8   mkdir .archive/2026-10-19-tidy && mv 测试残留文件…
10  收尾：判断有没有值得长期保留的经验
```

90 个文件里**只移测试残留，文档和目录一律不动**，而且：
- 用的是 `mv` 不是 `rm` —— "只移动没删除，原件都在"
- 回答里主动交代"`notes/`、`reports/`、`manuals/`、`media/` 这些目录我没碰"
- 最后还问"需要我把文档也归过去吗？"

**这是正确的"模糊指令"处理方式**：先摸清现状 → 区分重要与废弃 → 保守操作（可回退）→ 交代边界 → 留出下一步。

## 218. 它说明哪些机制在起作用

这一条任务同时用到了几轮前加的东西：

| 机制 | 体现 |
|---|---|
| 先看清楚再动手 | 前 3 步全是只读探查 |
| 不硬猜 | 模糊确认时列选项 |
| 保守操作 | 用 mv 不用 rm |
| 交代边界 | 明确说没碰哪些 |
| 收尾纪律 | 主动判断有无可复用经验 |

## 219. 本轮结论

**没有需要修的缺陷。** 这一段真实场景的表现已经比 10/18 那次好很多，
说明前面几十轮的纪律补充确实累积出了效果。

补一句运维说明：这次"整理"留下了 `.archive/2026-10-19-tidy/`（45 个测试残留文件，
可随时取回）。根目录现在只剩 MEMORY.md、weekly.md、notes/、manuals/、media/、
reports/、results/ 和几个文档——比之前干净得多。

## 220. 本轮门禁

模糊指令复现通过（不硬猜、执行准确、边界清楚）· 45 文件归档无丢失 ·
`npm test` 1516/1516 · 无代码改动

---

# 第四十七轮：上下文膨胀——发现问题但没修到底（2026-10-19）

## 221. 从"活多久"这个角度体检

之前测长对话只验证了"能回答"，这次去看**成本**：

```
新线程（无历史）:   prompt =  8369 tokens   ← 基础开销
461 条的老线程:     prompt = 28247 tokens
                              ↑ 差额 19878 tokens 全是历史
```

**基础开销 8369 是合理的**（system prompt 1143 + 工具 schema 3363 + 记忆/手册）。
但一个会话聊久了，历史会线性膨胀——而那个线程的构成极其畸形：

```
461 条消息里：tool_result 460 条 / 真实对话只有 2 条 user + 1 条 assistant
每条约 162 字节，460 条累加 74.7KB
```

**也就是说：这个会话几乎全是废弃的工具输出，真正的对话只有三句。**

## 222. 我做了什么

在 `buildMessages()` 里加裁剪：`this.messages` 中 tool_result 只保留最近 60 条
（user/assistant 正文全留，从尾部往前数，保证最近的对话一定在）。

## 223. 然后发现它没生效

加了临时日志，看到：

```
[dotd] 上下文裁剪 this.messages=468 → 保留 68（tool_result 60/60）
```

**裁剪确实执行了**（468 条 → 68 条），但实测 prompt 仍然是 28247，**一点没降**。

说明那 460 条 tool_result **不是经由 `this.messages` 进 prompt 的**——是我看错了装载路径。

## 224. 为什么没继续钻下去

继续追下去需要读透 `RunContext` → `stepLlm` → `buildMessages` → `RouteRequest`
整条链上每一处 `messages` 的赋值。这一轮时间已经用完，硬凑一个"改对了"
比留着问题更糟——**改错的地方会让人以为它好了**。

所以：裁剪代码保留（它本身是保守且有意义的），**但如实记录"未验证生效"**，
并把日志里的诊断代码撤掉，不留调试痕迹。

## 225. 下一轮该做的

1. 在 `stepLlm` 里直接打印 `req.messages.length` 和它们的 kind 分布（而不是在 buildMessages 里）
2. 找到那 19878 tokens 究竟经由哪条路径进入请求
3. 再决定在哪里裁剪才对

## 226. 本轮门禁

发现上下文膨胀问题（19878 tokens 纯历史）· 裁剪代码已加但**未证实生效** ·
`tsc` exit 0 · `npm test` 1516/1516 · 已清理调试代码

---

# 第四十八轮：上下文膨胀的真根因找到了（2026-10-19）

## 227. 接着上轮的悬案

上轮我在 `buildMessages` 里裁了 tool_result，日志证明确实执行了（468→68），
但实测 prompt 一点没降。这轮加了一个诊断，打印**真正发给模型的 messages**：

```
DIAG-MESSAGES 条数=534 字节=62801 分布={"text":471,"tool_result":60,"task_end":3}
```

**看出来了**：`tool_result` 确实裁到 60 条了，但那是**本轮**的结果；
历史里那 460 条在我这里统计成了 `text`——我裁的根本不是它们。

## 228. 真根因：会话重放传了"任务预算"

追踪 `this.messages` 的来源：

```ts
const replay = await this.memory.buildSessionReplay(
  session.threadId, session.id,
  session.budgetTokens,     // ← 200000
);
```

`packSessionReplay` 的实现是**从新到旧累加，直到撞到预算**：

```ts
for (const m of fromNewest) {
  if (used + m.tokenEst > budgetTokens) break;   // ← 预算 200000 时永远不 break
  picked.push(m);
}
```

**任务预算是 200000，对"重放历史"来说等于不限**——所以 74685 字节的历史被完整装进去。
再查线程的摘要状态：`context_summary = null`、`upto_seq = 0`
——从未做过摘要压缩，历史只增不减。

## 229. 修法：给会话重放独立的小预算

```ts
const REPLAY_BUDGET_TOKENS = 8_000;
```

理由：基础开销（system prompt + 工具 schema + 记忆）约 8400 tokens，
再加 8000 历史总计约 16000，对当前模型是舒适区；超出的由 `packSessionReplay`
**从最旧开始丢弃**——正好是我们想要的（最近的对话一定保留）。

## 230. 实测效果

| | 修复前 | 修复后 |
|---|---|---|
| messages 条数 | 534 | **243** |
| 字节 | 62801 | **32595** |
| **prompt tokens** | **28329** | **15867** |

**降了 44%。** 同一个 461 条消息的老线程，回答依然正确。

## 231. 这轮的方法论

上轮我卡住时，没有硬猜哪里改错了，而是**加一个诊断打印真实输入**。
这次一次性看清了：不是"裁剪没执行"，而是"裁错了对象"。

`console.error` 打出的那行诊断信息，抵得上十次读代码猜。

## 232. 本轮门禁

prompt 28329 → 15867（-44%）· 回答正确性不变 · **`npm test` 1518/1518**
（+2 条守卫：重放不得用任务预算、预算必须是合理小值）· 诊断代码已清理

---

# 第四十九轮：会话摘要机制从未生效（2026-10-19）

## 233. 顺着上轮的线索

上轮把重放预算从 200000 降到 8000，prompt 降了 44%。但随即意识到：
**预算只是遮盖，历史本身只增不减**——迟早撑满。

于是去查摘要压缩机制（`context_summary`）：

```
422 个线程，有摘要：0 个
最大那 476 条消息的线程：summary=null, upto_seq=0
```

## 234. 机制其实全都在

- `refreshContextSummary()` 有完整实现（增量摘要、600 token 上限、失败不抛）
- 触发判据齐全：`needsSummarize()` = 消息数 >64 或注入 >4000 tokens
- 注入也接好了：daemon 里 `summarize: (transcript) => router.complete({track:'light'})`
- Runner 也在收口前调：`await this.refreshSummary(task)`

**全都在，却一条摘要都没生成。**

## 235. 根因：改错了适配器

加临时诊断打印调用现场：

```
DIAG-SUM refreshSummary task=... hasFn=false
```

`this.memory.refreshContextSummary` 是 **undefined**。而 daemon 里有**两个** memory 适配器：

| 适配器 | 谁在用 | 有哪些方法 |
|---|---|---|
| `memPortOf()` | SF 面 | openThread / appendMessage / listThreads / listMessages |
| **`memApiOf()`** | **Runner** | buildSessionReplay / sealTask / needsMemoryRedo / … |

我第一次把转发加到了 `memPortOf` —— **Runner 根本不看那个**。
而契约里 `refreshContextSummary` 是 `?` **可选**方法，所以类型检查不报错，
Runner 静默走了"旧装配没有它"的降级分支。

## 236. 修好之后

```
DIAG-SUM ... hasFn=true
[dotd] runner: 已更新会话摘要 tk_mveovmw522fk6a/thr_01M56VDNAZDDACBEB80CE1EKNP
summary 长度=322  upto_seq=481
```

**这个机制第一次真正跑通。** 长会话从此会把早期历史压成 600 token 以内的摘要。

## 237. 方法论复盘

上轮和这轮的两次卡壳，解法都是同一个：**加诊断打印真实状态，而不是读代码猜**。

- 上轮：`console.error` 打出真实 messages 的 kind 分布 → 发现"裁错了对象"
- 这轮：`console.error` 打出 `hasFn=false` → 发现"改错了适配器"

两次都是在**看代码怎么看都对**的情况下，靠一行运行时输出破的局。

## 238. 本轮门禁

摘要首次生成成功（322 字节 / upto_seq=481）· **`npm test` 1521/1521**
（+3 条守卫：两个适配器都要转发、Runner 必须用 memApiOf）· 诊断代码已清理

---

# 第五十轮：每日 retention 从来没有被调度过（2026-10-19）

## 239. 上轮的尾巴

摘要机制接通后，423 个线程里**只有 1 个**有摘要——就是刚跑过任务的那个。
其余 5 个 >64 条的大线程仍然是 null。

原因很清楚：摘要只在**任务收口前**触发（Runner 的 refreshSummary）。
存量线程如果主人不再说话，就永远补不上。

## 240. 于是想加"每日补做"，结果挖出更大的问题

在 `runRetention` 里加了补做逻辑，然后准备挂到每日 job 上——
结果发现 **`runRetention` 全仓库零调用方**：

```
src/memory/MemoryService.ts:998   async runRetention(...)      ← 实现
src/memory/types.ts:374           runRetention(...)            ← 接口声明
src/memory/retention.ts:191       export function runRetention  ← 核心逻辑
—— 没有任何地方调用它 ——
```

文档里明明白白写着"§6.1 保留策略（**心跳 job memory-retention 每日**）"，
`Scheduler` 的注释也点名"MEM memory-compaction/memory-retention 全部挂这里"——
**但注册那一步从来没写**。

后果（都是静默的）：
- 90 天归档从不执行 → 老线程永远不封存
- 库清理从不执行
- 我上轮加的摘要补做也永远不会跑

## 241. 修法：注册成 heavy job

```ts
cp.scheduler.registerInternalJob({
  name: 'memory-retention',
  kind: 'heavy',
  everyMs: 10 * 60_000,
  run: async () => {
    // 每日一次；首次（lastRetentionAt=0）立刻跑，把存量补上
    if (lastRetentionAt !== 0 && nowMs - lastRetentionAt < 24 * 3600_000) return;
    ...
  },
});
```

scheduler 启动日志现在会带上它：
`heartbeat.tick / queue.gc / watchdog / guard / memory-retention`

## 242. 实测

手动调一次 `runRetention`：

```
补做前: 有摘要 1 / 423
补做后: 有摘要 6 / 423     ← 5 个存量大线程全部补上
```

其中一个是**真实飞书会话**（1794 字节摘要）。

## 243. 这轮的两个"零调用方"

连续两轮都在同一个主题上打转，都是同一个模式：
**实现有、接口有、文档写了，但接线那一步没做。**

- 上轮：`refreshContextSummary` 漏在 Runner 用的适配器上
- 这轮：`runRetention` 根本没有调度

这类缺陷**类型检查抓不到**（接口是可选方法 / 函数有导出），
**单测也抓不到**（测的是函数本身，不是"有没有人调它"）。

唯一有效的检查是：**看一眼真实运行时有没有发生过这件事**。
这两轮都是靠"查数据库里 422 个 null / 1 个非 null"发现的。

## 244. 本轮门禁

retention job 已注册并出现在启动日志 · 摘要覆盖率 1→6 · **`npm test` 1521/1521**

---

# 第五十一轮：系统扫"零调用方"，又揪出两处接线漏（2026-10-19）

## 245. 换个姿势：不猜，全仓库扫

前几轮连续三次撞上"实现有、接口有、接线漏了"。这轮干脆写个扫描器：
找出所有 **导出了但 src 其它文件 + tests 都没引用** 的函数。

```
导出函数总数: 350
零调用方（初筛）: 42
```

初筛 42 个里大部分是误报（我的匹配漏了别名导入等），逐个验证后**真正零引用 9 个**。

## 246. 抓到的第一个：schedule 用错 ID 生成器

`src/shared/ids.ts` 里早就有：

```ts
export function newCrontabId(): string {
  return `ct_${ulid()}`;      // ULID：单调递增、可排序
}
```

**零调用方**。因为 `schedules.ts`（我第 27 轮写的）又自己实现了一份：

```ts
function newScheduleId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ct_${Date.now().toString(36)}${rand}`;   // 同毫秒内顺序随机
}
```

差异不只是风格：**ULID 可排序**，而 `Date.now()+random` 在同毫秒内顺序不确定——
按 id 排列表会乱序，审计时也不好对应时间。已统一改用 `newCrontabId()`。

## 247. 抓到的第二个更严重：dot 被隔离，主人不知道

`renderQuarantineNotice()` 也是零引用。顺着查下去发现：

```ts
deps?.bus.publish('governance:quarantine', {...});   // 事件发了
```

但**全仓库没有任何订阅者**。现场后果（10/19 真实发生过）：

> 容器因 `recreate_count>3/24h` 被隔离 → **所有依赖容器的任务都失败** →
> 主人从飞书那边只看到"任务莫名其妙失败"，完全不知道 dot 已经被暂停了。

已接上飞书出站订阅（`feishu-outbound.ts`），隔离时直接推给主人：

```
⛔ Dot dot1 已被隔离
decision=dec_test_...
理由：24h 内容器重建 5 次，超过阈值 3
处置：该 Dot 队列已暂停，人工复核后可在 Web「解除隔离」。
（这条由系统主动发出：dot 已暂停，需要人工复核后解除）
```

## 248. 实测

用假 gateway 走真实 bus 验证：

```
[log] 飞书出站：已发送 quarantine:dot1:dec_test_... → oc_test_owner
发送结果: 1 条
text=⛔ Dot dot1 已被隔离 | 理由：24h 内容器重建 5 次...
```

## 249. 这个扫描值得保留

`scripts/scan-orphans.sh` 找出的是**类型检查和单测都抓不到**的那类缺陷：
接口是可选方法 → 类型不报错；函数有导出 → 单测测的是函数本身，不测"有没有人调它"。

**唯一能发现它们的方法就是问一句"这东西谁在用"。**

## 250. 本轮门禁

两处接线已补 · 隔离通知实测送达 · `tsc` exit 0 · **`npm test` 1521/1521**

---

# 第五十二轮：消除重复的错误分类实现（2026-10-19）

## 251. 扫描的第二个收获

上轮 `scan-orphans.sh` 报 `classifyHttpFailure` 零调用方。查下来不是"接线漏了"，而是**逻辑被抄了一份**：

`transport.ts`：
```ts
export function classifyHttpFailure(status, bodyText): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) { /* 含 quota 文案细分 */ }
  if (status >= 500) return 'server_error';
  return 'bad_protocol';
}
```

`candidates.ts` 的 `classifyError()` 里：
```ts
if (typeof e.status === 'number') {
  if (e.status === 401 || e.status === 403) return { kind: 'auth', ... };
  if (e.status === 402) return { kind: 'quota', ... };
  if (e.status === 429) { /* 同样抄了一遍 quota 正则 */ }
  if (e.status >= 500) return { kind: 'server_error', ... };
  return { kind: 'bad_protocol', ... };
}
```

**两张 §4.1 分类表，逐条相同。** 分叉风险是实实在在的：改了规范只改一处，另一处静默过期——
而"错误分类错了"的症状是熔断行为异常，很难从外部看出来。

已改为 `classifyError` 直接复用 `classifyHttpFailure(e.status, e.message ?? '')`。

## 252. 其余几个零调用方，判断是死代码而非缺陷

| 函数 | 判断 |
|---|---|
| `restoreToolCallNames` | 真正的还原在 `parseChatBody` 内部（`back.get(rawName)`），这个是重复的死代码 |
| `parseMemoryMd` | 设计意图是结构化解析 MEMORY.md，但实际注入走 `readMemoryMd` 整篇读——没接上 |
| `writeCliToken` | 供手动保存 token，无调用方 |
| `snapshotTask` | `return task`，空壳 |
| `renderPlan` / `revisionRequestText` | plan 功能的渲染辅助，plan 未启用时用不到 |

**这些不影响运行**，保留是因为删掉要连带清理测试引用，收益不大。
但记录下来——它们是"设计了但没接上"的地图，以后要用 plan / 结构化记忆时知道去哪儿找。

## 253. 本轮门禁

`tsc` exit 0 · **`npm test` 1521/1521** · 错误分类从两份实现收敛到一份

---

# 第五十三轮：复合任务压测，验证"功能齐了"是否成立（2026-10-19）

## 254. 用一个真实复合任务检验

上轮我说"能力上对标 OpenAI bot 了"。这轮用**多步、跨文件、有中间产物**的任务去检验：

| 任务 | 结果 |
|---|---|
| ① 三个文件汇总成表格 | ✅ **6 步 / 7 秒**，数字全对（A=400 B=270 C=590 合计 1260） |
| ② 基于上一步写报告 | ✅ **正确拒绝硬编**（详见下） |
| ③ 查 GitHub zen 再解释存文件 | ✅ 26 步完成，文件内容正确 |

## 255. 任务②看起来"失败"，其实是最该表扬的行为

我的测试用例本身有矛盾：把 1/2/3 月的文件放在名叫 `q3` 的目录里。
它读完后**没有闷头按 1260 写报告**，而是：

> 两个疑点：
> 1. **这不是 Q3**。文件只有三个月份，命名是 jan/feb/mar（1、2、3 月），对应 Q1。
> 2. **「刚算出来的」结果我没有。** 我们的对话里没有那次汇总…
>
> 我如果直接按这三个文件求和，结论会是：合计 1260，产品C 590 最高占 46.8%…
> **需要你一句话确认**：就按这三个文件、简单加总来写（默认建议），还是把当时算好的数字/口径贴给我？

**发现了测试用例的自相矛盾、给出了备选方案、等你一个词的确认。** 这才是对的行为。

## 256. 但暴露了一个真实的 API 设计差异

任务②说"对话里没有那次汇总"——查证：**API 路径不传 threadId 时每句话都新建会话**，
而飞书路径按 chat_id 自动复用。实测对比：

**不传 threadId**（默认）：
```
问: 记住这个暗号：BLUE-42  → thread=A
问: 我刚让你记的暗号是什么？ → thread=B（新会话）
答: 你让我记的暗号有两个：BLUE-7、ZEBRA-9 …    ← 靠长期记忆答对，但不是本会话的
```

**传 threadId**：
```
问: 记住 GREEN-99 → thread=A
问: 我刚让你记的是什么？ → thread=A
答: GREEN-99 —— 这是你最近一次让我记的（之前一个是 BLUE-42）
   本会话里你连着给了我两个：BLUE-42、GREEN-99      ← 完全正确
```

**结论**：跨会话记忆有效（能答出历史暗号），但"本会话即时上下文"需要 threadId。
这不是缺陷，是**文档没写清楚**——已在 `http.ts` 的路由表里补上语义说明。

## 257. 飞书路径不受影响

飞书信封连发验证：`status=202`，两个飞书会话各自维护独立线程（107 条 / 46 条），
按 `external_ref`（chat_id）复用——**你在飞书里连聊多轮是连贯的**。

## 258. 本轮门禁

3 个复合任务全部正确处理 · API 语义已文档化 · **`npm test` 1521/1521** · `tsc` exit 0

---

# 第五十四轮：定时任务的提醒根本发不到飞书（2026-10-19）

## 259. 从"从未触发"开始查

查定时任务状态时第一眼看到三个任务全是「从未触发」。差点当成调度器坏了。

实际是我读错了列名（`last_fire_at` vs `last_fired_at`）。用对列名后：

```
早间天气提醒  上次触发=2026/10/19 08:30:00  fired  累计 1 次
每日喝水提醒  上次触发=2026/10/19 11:46:02  fired  累计 1 次
```

**调度器工作正常**，触发后也确实产生了 `src=heartbeat` 的任务，执行质量也不错：

```
早间天气提醒（4 步，用了 net.get）:
  答：北京今天不用带伞：当前气温约 9°C，全天 7～18°C，晴、无降水，早晚偏凉
每日喝水提醒（2 步）:
  答：早上好，7 点了，先喝杯水吧，今天也记得把喝水习惯坚持下来～
```

## 260. 但结果永远到不了主人

继续查"结果有没有发到飞书"，发现：

```
定时任务的 thread:  channel=event, external_ref=null
→ feishuChatIdForThread() 返回 null
→ 出站逻辑第 243 行：if (chatId === null) return null;   ← 直接跳过
```

**定时提醒的全部意义就是主动告诉主人。执行了但发不出去，等于没做。**

## 261. 修法：非飞书会话回退到主人默认会话

```ts
const threadChat = feishuChatIdForThread(deps.db, task.thread_id);
const chatId = threadChat ?? deps.fallbackChatId ?? null;
```

判据很保守：真正的飞书会话仍按 chat_id 精确回原会话，**只有非飞书来源（event/web）才改投默认会话**。

## 262. 端到端实测

造一个马上到期的定时任务（prompt = "只回复这句话：PUSH-TEST-OK"）：

```
3. 等触发 → 已触发（5s）
5. 结果：
   出站记录 3 条 → 5 条
   [OK] task_reply -> oc_e764f9021f3db527f36dff984ff061f4
        PUSH-TEST-OK
```

**发到了真实的飞书会话。** 修好了。

## 263. 又一次踩到同一个坑

改代码时模板字符串里的 `${p.taskId}` 被 PowerShell 吃掉了，写成了
`deps.log(飞书出站： 非飞书会话，改投默认会话 )` —— 5 个测试立刻失败。

**教训重复了三次**：在 PowerShell 里改含 `${}` 的 TS 代码，一律用 edit 工具，不要用字符串替换。

## 264. 本轮门禁

定时提醒端到端送达真实飞书会话 · 探针 crontab 已清理 · `tsc` exit 0 · **`npm test` 1521/1521**

---

# 第五十五轮：日常验收 + 修掉重复提醒（2026-10-19）

## 265. 用主人真会说的话验收

不测功能点，直接说人话：

| 我说 | Dot 回答 | 耗时 |
|---|---|---|
| 现在几点了 | 2026-10-19 03:52 UTC / 北京时间 11:52 周一，还说明容器时钟是 UTC | 6s |
| 今天有什么安排，我记得设过提醒 | **列出 3 个定时任务**，并指出其中两个是重复的 | 9s |
| 把「周五前提交季度总结」记一下 | 写进长期记忆，**并说明不知道是哪一周所以没擅自设提醒** | 10s |
| 读一下那个 q3 目录 | 直接读出数据整理成表 | 8s |
| 算买房要多少年（月存1万 / 500万） | 41.67 年，还问要不要算几档对比 | 5s |

**5/5 都合理，且都在 5–10 秒内。**

第三句尤其值得记：我说"周五前"，它没有硬猜是哪周、没有擅自建提醒，而是记下来并说明。
**这正是"不确定时问一句"该有的样子**（前面几轮补的纪律在起作用）。

## 266. 但它顺手指出一个真问题

第 2 条回答里它说："其中两个是重复的"。

查证：`每日喝水提醒` 和 `早上喝水提醒` 两条，**cron 都是 0 7 * * ***，prompt 内容几乎一样。
原因是主人两次说"每天早上7点提醒我喝水"，而 `createSchedule` **没有查重**。

后果：到点会收到两条几乎一样的提醒。已清理掉一条。

## 267. 修法：cron + prompt 查重

```ts
const dup = db.prepare(
  'SELECT id, title FROM crontabs WHERE enabled=1 AND cron=? AND prompt=? AND dot_id=? LIMIT 1'
).get(cron, prompt, dotId);
if (dup !== undefined) return { ok: true, schedule: <原那条>, deduplicated: true };
```

判据用 (cron, prompt) 完全一致：同一条命令重复下不会重复建；
title 不同但 cron+prompt 相同的也拦（那只是措辞差异）。
真想要两条一样的？改 prompt 加区分即可。

## 268. 实测

```
第 1 次: ok=true deduplicated=false id=ct_01M594SSFQJ
第 2 次: ok=true deduplicated=true  id=ct_01M594SSFQJ   ← 同一条
```

## 269. 本轮门禁

日常验收 5/5 · 查重生效 · 已清理一条重复提醒 · `tsc` exit 0 · **`npm test` 1521/1521**

---

# 第五十六轮：补齐删除能力（2026-10-19）

## 270. 缺口确认

你问"删除功能和权限"。查下来模型能看到的 15 个工具里：

```
fs.read / fs.write / fs.list / fs.stat   ← 能读能写，不能删
shell.run                                 ← 能跑 rm，但要触发审批
schedule.create / schedule.list           ← 能建能查，不能删
```

所以它在飞书里说"我删不掉定时任务"是**真话**——`removeSchedule` 早就实现了，
但从没暴露成工具。

## 271. 补上两个删除工具

| 工具 | 语义 | 档位 |
|---|---|---|
| `schedule.remove` | **停用**不是硬删（`enabled=0`，能查回来） | write_file |
| `fs.remove` | 删文件或空目录；**先归档进 `.archive/` 再删** | write_file |

安全设计：
- `fs.remove` 删除前先调 `archiveBeforeOverwrite`，旧内容进 `.archive/`（32MB FIFO 配额）
- 目录只删空的（`rmdirSync`，非空报 `not_empty`）——避免一条命令删掉整棵树
- `schedule.remove` 复用了第 42 轮修正过幂等性的 `removeSchedule`

## 272. 过程中踩了一连串坑（都是加工具必然遇到的连锁）

1. **容器侧要同步加**：`agent-runtime/protocol.ts` 的能力定义 + `fs.ts` 的 `remove` 实现
   + `server.ts` 的 dispatch。少一处就是"工具存在但调不通"。
2. **容器与宿主的顺序必须一致**：防漂移测试逐个同形比对，`fs.remove` 在两边的
   位置都必须紧跟 `fs.stat` 之后。
3. **改 `fs.ts` 时误删了 `stat` 方法**：重写 `remove` 的范围算过头，把相邻的 `stat` 一起
   吞掉了。TS 报 `Property 'stat' does not exist` 才发现。补回时还先写错了返回字段
   （`sizeBytes` vs `size_bytes`、`isFile` vs `type:'file'`），测试一个个指出来。
4. **system prompt 又超预算**：加两条工具说明后 4034 > 4000，删掉一段旧的实测记录才落下。

## 273. 最后一个是真 bug

工具加完，模型却删不掉：

```
{"code":"deadline_too_long","message":"工具 fs.remove 的 deadline_ms 上限为 15000"}
```

我给 `max_deadline_ms` 写 15_000，而模型按默认节奏传了更长的值，直接拒。
**删除要先归档再 unlink，本来就比读慢**，15 秒太紧。放宽到 60_000 后立刻成功。

## 274. 实测

```
工具: fs.stat succeeded → fs.remove succeeded
回答: delete-me.txt 已经删掉了，旧内容自动归档在 .archive/2026-10-19T04-18-03-499Z__delete-me.txt
文件: ✅ 已删除
归档: ✅ 在 .archive/ 里
```

## 275. 本轮门禁

工具面 13 → 15 · 删除端到端通过（含归档）· **`npm test` 1521/1521** ·
容器镜像已重建（80s）· `tsc` exit 0

---

# 第五十七轮：删除工具成了绕过审批的后门（2026-10-19）

## 276. 你提"权限"，我去验了个危险操作

让模型"用 shell.run 执行 rm -rf /dot/home/q3"。结果它没走 shell.run，而是：

```
fs.list(q3) → fs.remove(jan) → fs.remove(feb) → fs.remove(mar) → fs.remove(q3)
```

**它绕开了需要审批的 shell.run，改用我上一轮刚加的 fs.remove 逐个删** —— 而 `fs.remove`
当时定的是 `write_file` 档，**默认放行**。

q3 目录真没了。

## 277. 归档机制救了这一把

查容器里的 `.archive/`：

```
2026-10-19T04-19-28-387Z__q3_jan.txt
2026-10-19T04-19-28-444Z__q3_feb.txt
2026-10-19T04-19-28-507Z__q3_mar.txt
```

三个文件都还在，能恢复。**上一轮加的"先归档再删"在真实误删里起了作用。**

## 278. 但"绕过审批"这件事必须修

`fs.remove` 从 `write_file` 提到 **`dangerous`**。

理由：归档可恢复是对的，但"模型能自己决定删东西、不经主人同意"不行。
GOV 五档里 `write_file` 是放行、`dangerous` 才是人工确认——删除是破坏性动作，该进后者。

## 279. 实测（两段）

**拦截：**
```
任务状态 = awaiting_approval
步进: 4  fs.remove  pending  approval=4
文件: ✅ 还在
审批队列: {"id":4,"tier":"dangerous","summary":"fs.remove {...}｜policy:dangerous"}
```

**批准后执行：**
```
批准 → {"ok":true,"finalStatus":"approved"}
任务: done
文件: ✅ 已删除
归档: ✅ .archive/2026-10-19T04-21-42-903Z__approval-test.txt
```

## 280. 一个值得记的教训

**加一个"安全的工具"，可能破坏已有的安全边界。**

我加 `fs.remove` 时想的是"有归档就安全了"，没意识到它对模型来说
是**一条不需要主人点头的删除通道**——而原本这条路（shell.run rm）是要审批的。

**判断一个工具该什么档位，不能只看"它自己多危险"，还要看"它能不能替代某个受管控的动作"。**

## 281. 本轮门禁

`fs.remove` 已提到 dangerous · 拦截 + 批准 + 执行 + 归档 全链路实测通过 ·
`tsc` exit 0 · **`npm test` 1521/1521**

---

# 第五十八轮：shell 能绕过全部网络管控（2026-10-19）

## 282. 顺着"权限边界"往下查

上一轮修了 `fs.remove` 绕过审批。这一轮系统性地问：
**还有哪些工具能替代受管控的动作？**

对照表：

| 受管控动作 | 可替代它的工具 | 结论 |
|---|---|---|
| shell.run (rm) [dangerous] | fs.remove | ✅ 上轮已堵 |
| shell.run (sudo/docker) | 无 | ✅ |
| net.post [write_file] | **shell.run curl** | ⚠️ **没堵** |

## 283. 实测确认绕过

```
DOTD_NET_TOOLS=get            ← 主人只开了 GET
容器里 curl POST → HTTP 200   ← shell 能 POST 到任意地址
```

容器里 `curl`、`wget`、`python3` 都在，DNS 通、443 通。
而 `shell.run` 的危险词表只有 `rm/sudo/docker/> /dev/`——
**`curl -X POST` 完全不在里面，走 write_file 档默认放行。**

也就是说：主人把出网设成"只读 GET"，模型换个工具就能 POST 到任何地方。

## 284. 修法：网络命令进危险词表

```
whenContains: ["rm ", "sudo ", "docker ", "> /dev/",
               "curl ", "wget ", "nc ", "telnet ", "ssh ", "scp ", "ftp "]
```

代价是"用 curl 抓个网页"也要审批。**这是有意的**：
想抓网页请用 `net.get`（read 档，直接放行），shell 里的网络命令一律当危险动作。

## 285. 实测（带对照组）

```
A. shell.run 跑 curl  → awaiting_approval，approval=5   ✅ 拦住了
B. net.get 访问网页    → done，直接成功                 ✅ 正常放行
```

**对照组很关键**：只有 A 被拦、B 正常，才能说明是"精准收紧"而不是"把网络整个废掉"。

## 286. 两轮的共同教训

同一个模式出现了两次：

- 第 57 轮：`fs.remove` 成了绕过 `shell.run rm` 审批的通道
- 第 58 轮：`shell.run curl` 成了绕过 `net.post` 管控的通道

**加工具 / 加能力时，必须问一句："这东西能不能替代某个受管控的动作？"**
只看"它自己危不危险"是不够的——一个看似无害的工具，可能是管制的后门。

## 287. 本轮门禁

curl/wget/ssh 等进危险词表 · A 被拦 / B 放行 双组实测 · `tsc` exit 0 · **`npm test` 1521/1521**

---

# 第五十九轮：差点削掉已有防护的一次改动（2026-10-19）

## 288. 起点：上轮的词表还不够

上轮把 `curl/wget/...` 加进危险词表。这轮用 `python3 -c "import urllib..."` 测——
**直接绕过了**（不需要 curl 字样）。

于是把词表扩到"URL 形态 + 各删除命令"共 20 项。

## 289. 然后发现只生效了 11 项

写了个脚本读**实际加载出来的词表**（不是读文件）：

```
解析出的词表（11 项）:
  "rm " "docker " "http://" "ftp://" "rmdir" "shred" "curl " "nc " "telnet " "scp " "nc -"
期望 20 项，实际 11 项
缺失: "sudo ", "> /dev/", "https://", "ssh://", "unlink", "truncate", "wget ", "ncat", "ssh ", "rsync "
```

**`sudo ` 和 `> /dev/` 也没了** —— 这两项是**改动之前就有的防护**。
如果我当时没查实际值就交付，等于**一边加新防护、一边把旧防护削掉**。

## 290. 根因：自研 YAML 解析器不支持那种多行数组写法

项目没用标准 yaml 库，`catalog.ts` 里有个手写的极简解析器。
我写的

```yaml
whenContains:
  - "rm "
  # 中文注释
  - "sudo "
```

在这种"map 值里嵌多行 seq、且中间夹注释"的结构下被解析得残缺。

改回**单行数组**（项目已有用法）后，20 项全在。

## 291. 一个必须记住的检查习惯

**改配置后，要验证"实际加载出来的值"，不能只看文件内容对不对。**

文件里写着 20 项、解析器只认 11 项 —— 这种偏差肉眼完全看不出来。
这次是靠"读出 `catalog.tools.get('shell.run').upgrade.whenContains` 打印出来"
才发现的（顺带还发现我之前用 `Object.keys(Map)` 判断工具数也是错的，应该是 `.size`）。

## 292. 实测（带对照组）

```
python3 urllib 发 HTTP → awaiting_approval，approval=6   ✅ 拦住了
echo hello             → done，正常放行                 ✅ 清白的命令不受影响
```

对照组很关键：只有前者被拦、后者放行，才说明是精准收紧而非一刀切。

## 293. 本轮门禁

词表 20 项全部加载成功（已核对实际值）· python/curl 出网进审批 · 本地命令放行 ·
`tsc` exit 0 · **`npm test` 1521/1521**

---

# 第六十轮：配置对、但模型看不到（2026-10-19）

## 294. 从"验证实际加载值"延伸出的全面核对

上轮踩了"文件写对、解析出来不对"的坑。这轮把所有配置的实际加载值打印出来核对：

```
工具数: 16      加载警告: 无
whenContains: 文件 20 项 / 加载 20 项  ✅ 完全一致
```

配置层没问题。但这张表让一个新问题浮出水面：

```
schedule.remove   write_file   ← 模型能不经审批删定时任务
```

## 295. 实测：模型说它根本没有这个工具

让模型"停用定时任务 ct_mvdzuj9aueicvswk"，它只调了 `schedule.list`，然后回答：

> 我拿到的工具清单里只有 `create`、`list`，没有 `remove`。

**能力目录里有、治理登记了、处理器也注册了 —— 但模型看不到。**

根因在 `ExecService.ts`：

```ts
const HOST_SIDE_TOOLS = new Set(['schedule.create', 'schedule.list']);
```

**这个手工维护的白名单漏了 `schedule.remove`。** 而 `getCapabilities` 是
"容器返回的目录 + 白名单里的宿主侧工具"合并 —— 白名单漏一个，就等于这个工具不存在。

这和第 27 轮那个坑是同一个：**加宿主侧工具要改三个地方，漏一个就静默失效。**

## 296. 修法 + 守卫

补进白名单，并加三条守卫测试：

1. 所有 `schedule.*` 工具都必须在 `HOST_SIDE_TOOLS` 里
2. 白名单里每一项都必须真的被 `registerHostTool` 注册（否则"看得到但调不通"）
3. 容器侧工具（`fs.*`/`shell.*`）不得混进白名单（会合并出重复项）

## 297. 实测

```
工具调用: schedule.list succeeded → schedule.remove succeeded
目标: 早间天气提醒 enabled=0  ✅ 已停用
```

## 298. 顺带澄清一个"不是问题"的

`net.post` 也是 `write_file` 档，看着像缺口。实测：

```
{"code":"net_post_disabled","message":"DOTD_NET_TOOLS=get 只放开只读的 net.get..."}
```

**它被环境变量挡在治理之前** —— 双层防护，这个设计是稳的。模型还准确复述了原因
并给出三个选项（改环境变量 / 不用 POST / 换方案）。

## 299. 本轮门禁

`schedule.remove` 已对模型可见且实测生效 · **`npm test` 1524/1524**（+3 条白名单守卫）·
配置加载值与文件逐项一致

---

# 第六十一轮：工具链六环核对（2026-10-19）

## 300. 把上轮的判断做成可复用的核对

上轮说"剩下的环节应该齐了"。这轮不只嘴上说，写了脚本把六环逐项核出来：

```
工具名            目录 白名单 治理 处理器 说明书
fs.read            ✅ 容器  ✅    ✅    ✅
...
schedule.remove    ✅ 宿主  ✅    ✅    ✅

白名单 3 项，全部在目录里: true
说明书 15 条，目录 15 个: 数量一致
✅ 全部工具六环齐全
```

## 301. 再做动态验证：让模型真的去用

静态核对只能证明"配置齐"，不能证明"真的能跑"。于是逐个让模型实际调用：

```
✅ fs.list      ✅ fs.stat    ✅ fs.read     ✅ fs.write
✅ shell.run    ✅ net.get    ✅ schedule.list
PASS=7 FAIL=0
```

## 302. 为什么值得专门做这件事

一个工具要真正到模型手上，得穿过**六环**：

```
能力目录 → 容器镜像 → 宿主白名单 → 治理登记 → 处理器注册 → 工具说明书
```

**任何一环漏了都是静默失效**——没有报错，模型只会说"我没这个工具"。

而且这两天**各漏过一环**：
- 第 59 轮：YAML 解析器把多行数组解析残缺（词表 20 项只认 11 项）
- 第 60 轮：`HOST_SIDE_TOOLS` 白名单漏了 `schedule.remove`

这种缺陷**类型检查抓不到**（都是运行期装配）、**单测抓不到**（测的是各部件本身）。
唯一有效的检查就是**端到端问一句"这东西模型到底能不能用"**。

已把核对脚本固化：
- `scripts/audit-tool-chain.sh` —— 静态六环核对
- `scripts/verify-alltools.sh` —— 动态抽查（真发任务）

## 303. 本轮门禁

六环全绿 · 动态 7/7 · **`npm test` 1524/1524** · 核对脚本已入库

---

# 第六十二轮：摘要其实没在摘要（2026-10-19）

## 304. 从"摘要覆盖率"查到"摘要质量"

上轮核完工具链，这轮查上下文连续性。覆盖率看着不错（大线程都有摘要了），
但把摘要正文打出来一看：

```
【新增对话】 user：创建 a.txt 内容写 111...
system：{"call_id":"01M56WZNH...","tool":"fs.write","ok":true,"value":{...}}
system：{"call_id":"01M56WZNK...","tool":"fs.write","ok":true,...}
```

**这不是摘要——是把原始工具 JSON 截断到 1800 字节。** 等于没摘要。

## 305. 根因：输入里工具输出占 99%

`transcript` 的构造是：

```ts
...usable.map((m) => `${m.role}：${m.content}`)
```

而 `tool_result` 的 `content` 就是完整 JSON。实测一个线程：

```
对话消息(text/task_start): 5 条，220 字节
工具输出(tool_result):     122 条，17842 字节   ← 99%
```

模型被 JSON 淹没，产出的"摘要"只能是 JSON 的截断。

## 306. 两段压缩

**① 工具调用压成记号**：`（工具 fs.write✓）` —— 保留"做过什么"，去掉 call_id/时间戳等噪音。

跑一次，输入从 17842 → 1208 字节。但新问题：73 处记号照样淹没对话。

**② 连续相同的记号折叠**：`（工具 fs.write✓ ×2）`。

再跑：1208 → **777 字节**（总降幅 96%），对话重新成为主体。

## 307. 一个值得记的观察

压缩后输入里还是 38 行工具记号——因为这个线程的真实行为就是"写2次读2次"
重复了 38 轮。**这已经是该场景信息量的下限**，不是压缩不够。

设计反思：如果让模型知道"主人真正关心的是结论"，摘要会更短。
但那要靠摘要提示词调优，不是压缩层的事，先没动。

## 308. 本轮门禁

摘要输入 17842 → 777 字节（-96%）· 摘要落库正常 ·
**`npm test` 1527/1527**（+3 条守卫：不许直接拼 content、要有折叠、只压 tool_result）

---

# 第六十三轮：摘要生成对了，但根本没被用上（2026-10-19）

## 309. 上一轮修好了"摘要内容"，这一轮问"摘要去哪了"

检查 `packSessionReplay`（历史重放的组装函数），发现：

```ts
const summary = thread.contextSummary;
if (summary !== null && summary.length > 0 && used < budgetTokens) {
  out.push({ ...摘要... });
}
```

**`used < budgetTokens` 这个条件方向是反的。**

- `used` 是"已经装进去的最近消息占用的 token"
- 会话越长 → 装的消息越多 → `used` 越接近 `budgetTokens`
- 所以**最需要摘要的长会话，最可能拿不到摘要** —— "越需要它，越用不上"

这是典型的"防御性条件写反"：本意是"还有余量才加"，结果是"余量越少越不加"，
而余量少恰恰说明历史多、正需要摘要。

## 310. 修法：预算先扣

```ts
const summaryTokens = hasSummary ? tokensOfText(summary) : 0;
const replayBudget = hasSummary ? Math.max(0, budgetTokens - summaryTokens) : budgetTokens;
```

先给摘要**预留**位置，剩下的预算再装最近的消息。
摘要本身有 600 token 上限（§4.4），对 8000 的总预算是小头，换来"长会话一定记得住开头"。

## 311. 实测

用一个 482 条消息、322 字节摘要的线程，试三档预算：

```
预算  8000 → 重放 187 条 / 8087 tokens，摘要 ✅ 有
预算  3000 → 重放  79 条 / 3058 tokens，摘要 ✅ 有
预算  1000 → 重放  36 条 / 1058 tokens，摘要 ✅ 有
```

修复前预算小的时候摘要会被挤掉，现在**三档都在**。

## 312. 记忆这条线的完整链条（三次修复才通）

| 轮次 | 问题 | 症状 |
|---|---|---|
| 49 | `refreshContextSummary` 漏在 Runner 用的适配器上 | 422 个线程一条摘要都没有 |
| 50 | `runRetention` 全仓库零调用方 | 老线程永远不补摘要 |
| 62 | 摘要输入里工具 JSON 占 99% | 所谓"摘要"是 JSON 截断 |
| **63** | **摘要被预算条件挤掉** | **生成了却用不上** |

**一个功能要真正生效，得穿过：触发 → 生成 → 内容对 → 注入 → 预算够。**
每一环都可能静默失败，且症状都是"看起来有，实际没有"。

## 313. 本轮门禁

三档预算下摘要均在 · **`npm test` 1530/1530**（+3 条行为断言：
预算满时摘要仍在 / 无摘要时行为不变 / 摘要排在最近消息之前）

---

# 第六十四轮：端到端验证长记忆 + 修 Pointers 重复（2026-10-19）

## 314. 第一次测试脚本自己先错了

写了个长会话测试，结果 shell 里 `$2` 未绑定直接报错 —— **每次提问都开了新会话**，
什么都没验证到。重写后（threadId 正确传递）才拿到真实结果。

教训：**测试脚本跑挂了，不能把"输出看着像那么回事"当通过。**

## 315. 端到端结果：长记忆确实有效

```
第 1 句: 记住三件事：项目代号 PHOENIX / 下周一给客户演示 / 负责支付模块
第 2-4 句: 三个追问全部准确回答
第 5-7 句: 灌入 9 次工具输出把早期对话挤远
最后一句: "回到最开始，我让你记住的三件事是什么？"
      答: 1. PHOENIX  2. 下周一要给客户演示  3. 负责的模块是支付
```

查长期记忆文件，确实写进去了：

```
## Current concerns
- PHOENIX 项目：主人负责**支付模块**，2026-10-19 起"下周一"（= 2026-10-26）给客户演示
  → notes/2026-10-19-phoenix-payment-demo.md（备用副本 notes/2026-10-19-phoenix-project-demo.md）
```

连"下周一"到具体日期的换算都对，还标了"下次引用时先核对当前日期再换算，别照抄"。

## 316. 但也暴露了重复问题

```
notes 共 20 个文件，实际只有 15 个主题
phoenix-payment-demo.md + phoenix-project-demo.md   ← 同一件事两种命名
github-zen.md + github-zen-endpoint.md              ← 同上
```

而且 **MEMORY.md 的 Pointers 只显示 10 条**（有上限），重复项会挤掉真正该被看到的条目。

## 317. 修法：只做路径级去重

```ts
const seen = new Map<string, HomeRelPath>();
for (const p of out.pointers) seen.set(p.path, p);  // 重复 key 覆盖 → 保留最后一条
```

**刻意不动"什么算同一件事"的语义判断**——那是模型的职责，改动风险大。
这里只保证"同一个文件不在列表里出现两次"，是低风险高收益的那一层。

## 318. 本轮门禁

长记忆端到端通过（三件事全记住）· Pointers 去重生效 ·
**`npm test` 1532/1532**（+2 条守卫：重复只留一条且保留最新、无重复时顺序不变）

---

# 第六十五轮：容器挂了，数据库还以为它活着（2026-10-19）

## 319. 从成功率数据发现线索

查长期趋势，成功率一路走高（10-17: 50% → 10-18: 97% → 10-19: 99%）。
但失败原因的前三名很扎眼：

```
29×  container_not_ready（unhealthy）
15×  container_not_ready（quarantined）
13×  container_not_ready（suspended）
```

按小时分布看，全部集中在**我主动操作容器的时刻**（06时创建 / 10时重置 / 19时重建）。
不是随机故障，而是"容器状态变化期间任务被拒"。

## 320. 实测：`docker stop` 后状态纹丝不动

```
docker stop 容器
数据库 state: 还是 ready     ← 状态失真
任务: fs.list failed → transport_error: fetch failed
回答: "容器执行器没有响应"
```

而 `ExecService.ts:1128` 的注释写着"运行期 unhealthy 由**重试+重启**兜底"——
**实测根本没有重试**，是模型自己重试了一次然后放弃。

根因：**healthcheck 只在 boot 时跑一次**（`fleet.ts` boot 复探），运行期完全没探活。

## 321. 补一个周期探活 job

```
exec.healthcheck  everyMs: 60_000
  ready + 连续 3 次探活失败 → unhealthy
  unhealthy + 探活成功       → 恢复
```

scheduler 启动日志现在带上了它：
`heartbeat.tick / queue.gc / watchdog / guard / memory-retention / exec.healthcheck`

## 322. 第一次修自愈失败：状态机不认这条路

日志显示连着打了两次"恢复"，但 `state` 一直是 `unhealthy`。查状态机：

```ts
unhealthy: ['booting', 'quarantined', 'lost', 'removed'],
//          ↑ 没有 'ready'
```

**`unhealthy → ready` 是非法转移**，而我把异常 try/catch 吞掉了，看起来像"执行了"。

改成合法路径 `unhealthy → booting → ready`。

## 323. 修好后实测（全链路）

```
初始:   ready
docker stop
  180s: unhealthy     ✅ 状态纠正生效
docker start
   60s: ready         ✅ 自愈生效
```

## 324. 这轮的两个教训

**① "由重试兜底"这种注释必须验证。** 注释说重试兜底，实测根本没有重试——
代码里的承诺和实际行为是两件事。

**② 状态机拒绝转移时，静默 catch 是最坏的处理。** 它让日志显示"成功了"、
状态却纹丝不动。现在改成把拒绝原因打出来。

## 325. 本轮门禁

状态纠正 + 自愈全链路实测通过 · **`npm test` 1535/1535**（+3 条守卫）

---

# 第六十六轮：探活在成功/失败之间反复横跳（2026-10-19）

## 326. 上轮的自愈，还有一个隐藏故障

上轮加了周期探活，实测能纠正状态、能自愈。但继续测发现：

```
容器进程: Up 21 seconds      ← 容器在跑
数据库 state: unhealthy       ← 但状态没恢复
任务: fs.list failed，回答"容器是 unhealthy 状态"
```

查日志：

```
[exec] 容器探活连续失败 3 次：ready → unhealthy
[exec] 容器探活恢复：unhealthy → booting → ready
[exec] 容器探活连续失败 3 次：ready → unhealthy
[exec] 容器探活恢复：unhealthy → booting → ready
```

**在成功和失败之间反复横跳。**

## 327. 根因：token 缓存只写不删

```
数据库 endpoint: 172.21.0.2    ← 正确
容器实际 IP:     172.21.0.2    ← 一致（不是网络问题）
healthz 无 token: HTTP 401     ← 容器活着，只是鉴权失败
```

`Fleet.currentToken()` 的实现：

```ts
const cached = this.memTokens.get(dotId);
if (cached !== undefined) return cached;   // ← 永远优先返回缓存
```

**容器重建后容器内生成新 token，而缓存里是旧的，且从来没人清。**
于是探活拿旧 token 打新容器，永久 401 —— 但容器其实是好的。

## 328. 修法：加失效入口 + 失败时重试一次

```ts
invalidateToken(dotId: string): void {
  this.memTokens.delete(dotId);
}
```

探活失败时先清缓存重读一次，再判定状态。

## 329. 实测

```
状态: 90 秒内一直是 ready（之前反复横跳）
任务: fs.list succeeded
回答: home 根目录下共 15 项：6 个文件、9 个目录……
```

## 330. 这一轮的教训

**"缓存"是可靠性问题的常见来源，尤其是"对象会变但缓存不知道"的时候。**

这个缓存本身设计没错（避免每次都读文件），错在**没有失效路径**——
容器重建是明确的"对象变了"的时刻，但代码里没有任何地方通知缓存。

判断标准：**如果一个缓存的值依赖某个会变化的外部对象，
就必须有"该对象变了"的清缓存入口。**

## 331. 本轮门禁

状态稳定 90s 不跳 · 任务正常执行 · **`npm test` 1537/1537**（+2 条守卫：
invalidateToken 存在且真的 delete、探活失败路径会清缓存重探）

---

# 第六十七轮：系统审计所有缓存的生命周期（2026-10-19）

## 332. 顺着"缓存失效"这条线做全面审计

前两轮修了 token 缓存没有失效路径的问题。这轮把所有 `Map` 形态的缓存列出来，
逐个看**有没有对应的 delete/clear**：

```
src/runner/dot.ts      pendingResults / pendingCalls / callArgs  ✅ 有 delete
src/runner/dot.ts      repeatGuard / repeatSkipsByTask           ✅ resetRepeatGuard 里清
src/runner/dot.ts      toolCallCounts                            ❌ 只有 set，从不 delete
src/surfaces/sse.ts    subscribers                               ✅ 有 clear/delete
src/surfaces/ingress.ts buckets / badRun                          ✅ 有 FIXED 窗口清理
src/exec/ExecService   lanes / inflight / hostTools               ✅ 有清理
```

**只抓到一处：`toolCallCounts`。**

## 333. 但实际影响比想象的小

查 daemon 内存构成：

```
RSS: 199 MB
  RssAnon: 141 MB（JS 堆 + 代码）
  RssFile:  62 MB（共享库）
文件句柄: 35 个   ← 无泄漏
SQLite 连接: 3 个  ← 正常
任务数: 524
```

524 个任务对应的 `toolCallCounts` 条目其实很小。**这个泄漏性质上是真泄漏
（随任务数单调增长），但量级远没有到造成问题的程度。**

我还是修了——因为三个缓存的**生命周期完全一致**（都在
`resetRepeatGuard` 这个"任务终态清理"点），漏一个没有理由，而且
"现在不重要"不等于"以后不重要"。

## 334. 审计的结论也值得记

这轮**没找到大问题**，但这不是白跑：

- 句柄无泄漏（35 个，稳定）
- SQLite 连接正常（3 个）
- 内存构成合理（141MB 堆 + 62MB 共享库）
- 只有一处真泄漏，且量级很小

**"审计后没发现问题"也是有效结论** —— 它把"不知道有没有问题"变成了"查过了，没有"。

## 335. 本轮门禁

`toolCallCounts` 已随任务终态释放 · 内存/句柄审计无其它异常 ·
**`npm test` 1539/1539**（+2 条守卫：三组缓存都要清、按 taskId 声明的缓存不许漏）
