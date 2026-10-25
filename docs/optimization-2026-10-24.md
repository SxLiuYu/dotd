# dotd 延迟与可用性优化方案（2026-10-24）

> 上一轮已经把模型换到网关最快的 `deepseek-v4.1-flash`（见
> `docs/acceptance/model-latency/REPORT.md`）。这份方案处理**换模型解决不了的那部分**。
>
> 所有数字都来自本机实测，时间线原始数据在
> `docs/acceptance/model-latency/e2e-timeline.txt`。
>
> **落地状态（2026-10-24 晚）：P0-1 / P0-2 / P1-6 已实现并本机验证，P1-3 只落地了
> 启动预热（未重测首包）；P2 三项未动，按计划需要先评审。** 每节末尾的
> 「✅ 已落地」写的是**实际做法与计划不一致的地方**，验收证据在
> `docs/acceptance/model-latency/e2e-gate-off.json` / `e2e-gate-on.json`。

---

## 0. 先把账算清楚：一轮语音到底花在哪

真 daemon（临时 home + 端口 7799 + `DOTD_FLEET=stub` + fake-device，不碰在跑的 7788）
一次"3+5 等于几"的完整时间线：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 入队 → 第一步开始 | 0.3–1.0 s | 建 session、拼上下文、取工具清单 |
| 主模型调用 | 1.9–2.6 s | prompt **18 936 tokens**，输出 8 tokens，回答这一刻已流给设备 |
| 「要不要写记忆」补写轮 | **1.5–1.9 s** | prompt 1 232 tokens，输出 2 tokens，结果每次都是 `SKIP` |
| 任务置 done | ~5 ms | 这一刻设备才解锁，能接下一句 |
| 合计（设备视角） | **4.1–5.1 s** | 首条增量 1.8–3.2 s，其余全在补写轮 |

拆开看三件事：

1. **听到第一句** ≈ ASR 0.3 s + 主模型首 token 1.4–2.6 s + TTS 首包 1.1 s。
   模型已贴近网关地板（1.2 k prompt 和 19 k prompt 的延迟几乎一样，都是 ~1.4 s 起），
   这一段的剩余空间在 TTS。
2. **连续对话的等待** ≈ 1.5–1.9 s 的补写轮。回答早就播完了，但设备还被占着。
3. **成本** ≈ 每轮 19 k 输入 tokens（延迟上几乎不值钱，配额上很值钱）。

---

## 1. 优化项总表

| # | 项目 | 优先级 | 状态 | 本机实测 | 备注 |
|---|---|---|---|---|---|
| 1 | 补写轮的零成本前置判据 + 节流 | **P0** | ✅ 已落地，默认开 | 尾段中位 **1689 ms → 57 ms**；e2e P50 3.66 → 2.19 s | `DOTD_MEMORY_REDO_GATE=0` 回退 |
| 2 | guard 基线取 p50 当门槛 | **P0** | ✅ 已落地 | 稳态不再进 throttled；顺序不变量有测试 | 告警复用 `watermark`，不加迁移 |
| 3 | TTS 首包：缓存 + 连接预热 | **P1** | 🟡 只做了启动预热 | 无实测首包数字（见 §4） | 缓存是进程内 LRU，不是磁盘 |
| 4 | 补写轮挪到 finish 之后（后台）| P2 | ⬜ 未做（需评审） | — | 动 §4.3 契约 |
| 5 | 工具清单/记忆按需裁剪 | P2 | ⬜ 未做 | — | 只影响成本，不影响延迟 |
| 6 | 分段耗时入库 + 延迟回归门禁 | **P1** | ✅ 时间线已落地；CI 门禁未加 | 示例：setup 700 / llm 1540 / tail 8 ms | 不入库的原因见 §5 |
| 7 | light 轨换本地/直连小模型 | P3 | ⬜ 未做 | — | 需新增依赖 |
| 8 | setup 段 0.3–1.0 s | P2 候选 | 🆕 被 P1-6 量出来 | 单轮 700 ms | 闸门生效后占一轮 1/3 |

---

## 1.1 当场能看到的收益（gate 关/开各 5 轮，同批）

| 指标 | gate 关（改前行为）| gate 开（默认）|
|---|---|---|
| 通过率 | 5/5 | 5/5 |
| 首增量 P50 | 2263 ms | 2003 ms |
| 端到端 P50 | 3659 ms | **2186 ms** |
| 端到端 P95 | 4749 ms | **2563 ms** |
| 尾段（e2e − 首增量）中位 | **1689 ms** | **57 ms** |

尾段才是补写轮的成本：改前每一轮都多 1.2–1.8 s，改后中位 57 ms。
验收线「`endToEnd − firstDelta < 300 ms`」按**同一任务**的差算中位，达标。


---

## 2. P0-1：让补写轮少跑

### 现状

`src/runner/dot.ts:2948-2955`：`finishTask` 在 `cp.finish` **之前** `await this.memoryWriteRedo(...)`。
`MemoryService.needsMemoryRedo`（`src/memory/MemoryService.ts:723`）的判据只有一条：

```ts
const paths = await this.journalMemoryProbe(task.id, since);
return paths.filter(isMemoryWritePathLoose).length === 0;   // 没写过记忆文件 → 补问一轮
```

也就是说：**任何没有写过 notes/manuals 的任务都会问一轮**，包括"3+5 等于几"。
实测 9 次全部回 `SKIP`，没有一次真的写记忆。

为什么不能简单挪到 finish 之后：那轮里的 `fs.write` 必须在任务仍 `running` 时发生，
才受 journal / 心跳 / epoch 围栏保护（代码注释 `dot.ts:2943-2954` 说得很清楚）。

### 改法（推荐）

**A. 零成本前置判据**（不调模型、纯本地）：

在 `memoryWriteRedo` 开头、`needsMemoryRedo` 之前加三道闸：

1. **本任务没派发过任何工具，且回答 < 120 字** → 跳过。
   没有动作就没有可长期保留的"做法"。回答长说明可能讲了经验，保留。
2. **偏好关键词命中则不跳过**：`记住 / 以后 / 今后 / 我喜欢 / 我讨厌 / 不要 / 一直 / 默认 / 叫我`。
   这一条专门防"纯口头偏好"被漏掉（不调工具也可能是值得记的）。
3. **同 thread 节流**：同一条 thread 30 分钟内最多问一次（复用现成的 `readKv/writeKv`，
   键 `memory_redo_at:<threadId>`）。语音连续对话天然落在同一条 thread 上，
   第二句以后都不会再付这 1.5 s。

**B. 补写轮改用 light 轨**（顺手）：它本质是"分类 + 也许写个文件"，
不需要 primary 的全部能力。现在是 `track: 'primary'`；切到 light 后未来 light 换成
更快的模型时自动受益（当前两者同模型，无即时收益）。

### 预期

- 简单问答：任务时长 4.1–5.1 s → **约 2.3–3.2 s**，设备立刻能接下一句。
- 有工具、有经验的任务：行为不变（照常问）。
- 成本：每轮少一次 1.2 k prompt 的调用。

### 验证

- 单测：`tests/` 加一条"无工具 + 短回答 + 无偏好词 → 不调用模型"；
  一条"含『以后都…』→ 仍然补写"；一条"同 thread 第二次 → 跳过"。
- e2e：`fake-device` 5 轮，对比 `endToEndP50Ms` 与 `firstDeltaP50Ms` 的差
  （改前差 1.5–1.9 s，改后应 < 0.3 s）。
- 反向验证：让一个任务真的写 `notes/2026-10-24-x.md`，确认不会被跳过、也不会重复写。

### ✅ 已落地（2026-10-24）：与计划不一致的四处

实现：`Runner.shouldAskMemoryRedo()`（`src/runner/dot.ts`），在
`memoryWriteRedo` 调模型之前执行；判据顺序 = 偏好词 → 零工具+短答 → 同 thread 节流。

1. **开关不在 `config/dotd.yml`，而是 `RunnerOptions.memoryRedoGate` +
   `DOTD_MEMORY_REDO_GATE=0`**。`memoryRedo` 本身就是在装配层显式声明的，闸门跟着
   同一个位置走，避免为 runner 再引一条配置读取路径。
2. **节流只作用于"零工具"任务**；派发过工具的任务永不节流。有工具的那批才是真正
   可能留经验的任务，数量又远少于闲聊；对它们节流省不了多少，却直接漏记。
3. **补写轮没有切到 light 轨**（计划 §2 改法 B）。闸门已经消掉绝大多数轮次，剩下的
   是"确实值得判断一次"的；此时换轨只改变少数调用，而当前 light 与 primary 同模型
   （零即时收益），却多一处行为差异。等 light 真换成更快模型时再做。
4. **偏好词是子串命中 goal 或 summary**，所以「不要」这类宽词会误触发补写。
   这是刻意的保守方向：宁可多花 1.5 s，也不漏记一句口头偏好。

验证：
- `tests/runner-memory-redo-gate.test.ts` 6 条：零工具短答跳过 / goal 或回复命中偏好词
  仍补写 / 同 thread 30 分钟内第二次跳过 / 有工具的任务不被节流 / 闸门关 = 老行为。
- 真 daemon A/B（临时 home + 7799 + fake-device，不碰 7788）：见 §1.1；
  gate-on 那批日志里 5 条 `补写轮跳过`，`/api/tasks/:id/proof` 的
  `timeline.memoryRedoMs` 为 `null`。
- `tests/memory-seal-redo.test.ts` / `runner-memory-redo-dsml.test.ts` 显式传
  `memoryRedoGate: false`，保证补写机制本身仍被覆盖。

### 回退

`DOTD_MEMORY_REDO_GATE=0`（或 `RunnerOptions.memoryRedoGate: false`）= 逐字回到
2026-10-24 之前的行为（每个 done 任务都问一轮）。

---

## 3. P0-2：guard 基线把门槛定在了中位数上

### 现状

`src/control-plane/guard.ts:110`：标定取 **MemAvailable 的 p50** 当 `baseMb`；
`thresholds()`（`:226`）再算：

```
normal = base + 6144MB     guarded = base + 3072MB
throttled = base           halted  < base
```

`base` 是"平常有多少空闲内存"，而 `throttled` 线**就等于这个平常值**。
结果：只要机器回到常态，就有约一半的采样落在 `< base`，连续两次就进 throttled。
`throttled` 时 `pop()` 返回 null → 任务永远停在 `queued`（2026-10-24 真机现场：
`queue {queued:1, running:0}`，只能靠 `DOTD_GUARD_BASE_MB=1024` 绕过）。

当时的三条诊断（`docs/acceptance/voice-real-latency/REPORT.md`）是对的，但修法要更彻底。

### 改法

1. **基线减去预留**：`base = max(0, p50(available) − dotdReserveMb)`。
   这样 `normal` 线正好落在"平常空闲"，`throttled` 只在比常态低 6 GB 时才触发——
   这才是"内存紧张"的本意。
2. **加不变量断言**：`0 ≤ throttled ≤ guarded ≤ normal ≤ total − reserve`。
   现在只夹了上限，没有检查三条线的顺序（配置写错时会静默取到荒谬阈值）。
3. **兜底：水位低不等于任务不能跑**。throttled 持续超过 N 分钟、且队列里有
   交互任务时，允许以 `maxRunning=1` 放行一条并记 `resource_events`（默认开，
   可用配置关）。guard 的本意是保护内存，不是让产品静默停摆。

### 验证

- `tests/control-plane-guard-scheduler.test.ts` 补：
  - 稳态（available 恒等于标定中位数）→ **不得**进 throttled；
  - available 比常态低 5 GB → guarded；低 7 GB → throttled；
  - 阈值顺序不变量（含 total 很小的机器）。
- 本机跑一天，确认 `resource_events` 里不再出现"常态即 throttled"。

### ✅ 已落地（2026-10-24）：三处与计划不一致

1. **兜底放行默认关**（计划写"默认开"）。`throttled` 时容器已按 §6.3 pause，
   硬放行会让动作型工具执行到一半失败——比排队更糟。所以默认只**告警**
   （5 分钟一条），需要放行时显式 `DOTD_INTERACTIVE_UNDER_PRESSURE=1`
   （只放行 `priority=1` 的交互任务，且 `running=0`，`halted` 不受影响）。
2. **没有新增 `resource_events.kind`**。该列有 CHECK 白名单，加值要重建表；实测重建
   会和模板库回放撞车（`table resource_events_new already exists`）。改成复用
   `kind='watermark'` + `detail.stuck=true`，筛选语义等价：
   `kind='watermark' AND detail LIKE '%"stuck":true%'`。
3. **测试按新的相对语义写，没按"低 5 GB / 低 7 GB"的字面**。阈值本来就相对 `base`，
   写死 GB 差会把 3072 的预留一起算进去。断言改为：`available = base` → throttled；
   `base+4 G` → guarded；`≥ base+6 G` → normal，且"稳态 = 标定中位数"必须 normal。

实现位置：`baseFromSamples()`（p50 − `dotdReserveMb`）、`clampThresholdsToPhysical()`
（三条线顺序 + 物理上限，兜底路径也走它）、`Guard.checkStuckQueue()`。

验证：`tests/control-plane-guard-scheduler.test.ts` —— 标定后稳态 normal、逐级降档、
倒置兜底阈值仍得出 normal、卡住 1 s 窗口内恰好 1 条告警、严格/宽松两组 DB 对比
节流放行只挑交互任务且 `halted` 不受影响。全量 `npm test` 2007/2007。

**未完成**：真机 7788 按约束没有重启，所以"跑一天不再出现常态 throttled"这条
只是单测 + 标定路径的结论，需要下次重启后看 `resource_events` 确认。

---

## 4. P1-3：TTS 首包 1.1 s

### 现状

`voice/charlie/agent/llm.py:1973` 的 `stream_voice_pipeline` **已经按句合成**：

```python
for sentence, full_reply in brain_stream_sentences(text):
    mp3 = _tts_cleaned_to_mp3(sentence)      # 首句一完成就开始合成
    yield ("sentence", sentence, mp3)
```

所以这块不是"等整段生成完再 TTS"的旧问题，剩下的 1.1 s 是 Edge TTS 本身的
建连 + 首包（`docs/acceptance/voice-real-audio/REPORT.md` 实测）。

### 改法（按收益/成本排序）

1. **固定话术缓存**：唤醒应答、"我在"、确认、"没听清"、错误提示——这些每轮都重复，
   合成一次落盘（现有 `_URL_CACHE_DIR` 那套磁盘缓存可直接复用），命中后 0 ms。
2. **连接预热**：进程启动时先合成一句丢弃，把 Edge TTS 的 TLS/WS 握手摊到启动期。
3. **首句更短**：系统提示要求"第一句 ≤ 12 字给结论，再展开"。
   需要成品味开关（会改变回答风格），默认关。
4. **本地兜底**：Windows 上 `Microsoft Huihui Desktop`（SAPI）首包 ~50 ms，
   音质差一档；做"低延迟模式"的可选项。

### 验证

- 复用 `voice/integration/test_real_audio.py` 的测法，量
  "文本出第一句 → 首个 Opus 帧"的时间；目标 < 400 ms（缓存命中）/ < 800 ms（预热后）。

### ✅ 已落地（部分，2026-10-24）

实现：`voice/integration/tts_warm.py`（启动后在守护线程里合成 3 句固定话术，
写入进程内缓存；`DOTD_TTS_WARM=0` 关，`DOTD_TTS_WARM_PHRASES="a|b"` 换话术），
由 `one_system.py` 在 `import voice_server` 之后触发。失败只打日志、不阻塞启动。
测试：`voice/integration/test_tts_warm.py`（5 条，假 `agent.asr_tts`）+
`tests/voice-tts-warm.test.ts` 包装成 `npm test` 的一部分。

三件必须说清楚的事：

1. **计划里"复用磁盘缓存"是错的**。实际缓存是**进程内 LRU**（`asr_tts.py:86`），
   不是磁盘。所以预热只在本进程生命周期内有效；重启后第一次仍要付 1.1 s。
   要做跨重启，得给上游加磁盘层（改 Charlie 的缓存实现），本次没动。
2. **没有重测"文本首句 → 首个 Opus 帧"**。真音频测量要 Whisper/SenseVoice 模型和
   真设备音频通路，临时环境只能证明预热调用成功、第二次调用命中缓存；
   所以这一项的收益**没有实测数字**，只有机制。
3. **预期收益比计划低**。`stream_voice_pipeline` 已经是按句合成，切句在第一个逗号
   就 flush，所以那 1.1 s 主要是供应商建连 + 首包；预热只能摊掉建连那一段。
   下一个数量级要换引擎（本地 SAPI / 本地 TTS），会改变音色——产品决策，没做。

---

## 5. P1-6：把分段耗时留下来

现在每次要回答"慢在哪"都得起临时 daemon、手工查 `steps` 和 `model_call_log`。
把它变成产品能力：

- 在任务收口时记一条 `resource_events`（或 `task_results` 新列）：
  `{setup_ms, llm_ms[], tool_ms[], memory_redo_ms, summary_ms, total_ms}`。
- `/api/tasks/:id/proof` 返回这条时间线；`--verbose` 直接打印。
- CI 里加**不联网**的回归门禁：stub 传输下 e2e P50 超过基线 20% 就红
  （防止以后某次改动悄悄给每轮加了 1 s）。

### ✅ 已落地（2026-10-24）：入库 → 进 proof，CI 门禁刻意没加

实现：`src/shared/timeline.ts` 的 `computeTimeline()`，`buildProof()` 把它写进
`/api/tasks/:id/proof` 的 `timeline`（**只在有 steps 时出现**，没 steps 的老任务
proof hash 逐字不变）：

```json
{"totalMs":2248,"setupMs":700,"llmMs":[1540],"toolMs":[],
 "llmTotalMs":1540,"toolTotalMs":0,"memoryRedoMs":null,"tailMs":8}
```

- **没有入库新列/新表**：`steps` 已经是事实来源，另存一份会漂移；而且迁移有模板库
  回放冲突风险（同 §3）。代价是只能查仍保留 steps 的任务，不能跨任务 SQL 聚合。
- **没有加 CI 延迟门禁**：网关延迟同一天不同时段能差 10 倍（§9），绝对阈值必然
  flaky。现在给的是"每个任务可回看时间线"；要做趋势得先有离线上报，不在本次范围。
- 补写轮的识别靠 `argsJson` 里的 `MEMORY_REDO_MARK`（`src/shared/timeline.ts`），
  和 runner 用的是同一个常量，改提示词不会悄悄让时间线失效。
- 测试：`tests/proof-timeline.test.ts` 6 条（四段拆分、redo 标记、无 steps 返回
  null、脏数据不抛、proof 与 timeline 一致、无 steps 时不出现 `timeline` 键）。

**🆕 这条时间线第一次量出的新问题**：`setupMs ≈ 700 ms`（建 session、拼上下文、
取工具清单）。闸门生效后一轮约 2.2 s，setup 已占三分之一。列成 P2 候选（#8），
本次没做。

---

## 6. P2：结构性改动（做之前先单独评审）

### 6.1 补写轮挪到 finish 之后

收益：设备在回答播完的瞬间就解锁（比 P0-1 再省 0.1–0.3 s），且"有工具的任务"也不用等。

代价：§4.3 要求补写必须在 `running` 期内完成（journal 步、心跳、epoch 围栏都依赖它）。
要么给"收尾轮"开一个合法的短生命周期（任务进 `finishing` 子态），
要么把补写改造成独立任务（`memory.redo`）由队列调度。
两条都要动契约文档和状态机，**建议先写设计再改代码**。

### 6.2 输入 token 从 19 k 降到 5–8 k

延迟上几乎不赚（实测 19 k 和 1.2 k 的调用都是 ~1.4 s 起），赚的是配额和钱。
做法：工具清单按任务类型分组下发、记忆召回 top-k 而不是全量、运行手册分层（常驻/按需）。
风险是漏召回导致多跑几轮——净收益要 A/B 后再定。

### 6.3 light 轨换更快的执行体

网关每次调用有 ~1.4 s 地板（1.2 k prompt、2 token 输出也一样）。light 轨做的都是
"分类/摘要/裁定"这类小活，本地 0.5B–3B 小模型（llama.cpp / ONNX）可以在 <300 ms 内完成，
而且不占网关配额。需要选定模型 + 落地服务，属于新增依赖。

---

## 7. 不建议做的

| 想法 | 为什么不做 |
|---|---|
| 继续换更快的模型 | 已经贴着网关地板（1.4 s/次），换谁都一样 |
| 为延迟裁 prompt | 实测 19 k vs 1.2 k 延迟无差别；裁了只在成本上有收益 |
| 提高并发 | 当前 `maxRunning=1` 不是瓶颈，瓶颈是每轮模型调用次数 |
| 把 ASR 再调快 | SenseVoice 0.3 s 已在合理区间，收益 < 0.2 s |

---

## 8. 落地顺序（含完成状态）

1. ✅ **第一批（P0）**：guard 基线修 + 补写轮闸门。
   验收：`endToEnd − firstDelta` 中位 57 ms（线 < 300 ms）✅；`npm test` 2007/2007 ✅；
   "连续 20 轮无 `queued` 卡死" ⏳ —— 真机 7788 未重启，等下次重启后观察。
2. 🟡 **第二批（P1）**：分段耗时入库 ✅（进 proof）；TTS 缓存/预热 🟡（只做启动预热，
   首包未重测）。验收"首句 < 800 ms"**未验证**。
3. ⬜ **第三批（P2，需评审）**：补写轮异步化、prompt 裁剪、light 轨本地化，
   以及新量的 #8（setup 段 700 ms）。一项都没开始。

---

## 9. 附：这次测量的边界

- 单网关单出口（`172.17.48.1:13065`）；换供应商/网络要重测。
- 端到端用 fake-device，覆盖 HTTP 设备协议，不覆盖 ESP32 固件与真麦克风。
- 网关延迟随负载漂移：同一天不同时段同一个模型能差 10 倍（见
  `voice-real-latency/REPORT.md` 的补充段）。**方案里的绝对值只在同一批测量内可比**，
  验收要以"同批 A/B 的差"为准，不要拿绝对值卡门禁。
- gate A/B 只有 5 轮、单 thread、fake-device：覆盖了 HTTP 设备协议，不覆盖 ESP32
  固件与真麦克风。
- "闸门不会漏记"只在偏好词和工具路径上做了推理与单测，没有跑一周真实语音语料。
  如果发现漏记，第一手证据是 `memory_redo` 的 `SKIP` 与后续"忘了我说过"的抱怨，
  回退开关是一条环境变量。
- TTS 预热只对固定话术有效，且只在本进程生命周期内（缓存是进程内 LRU）；
  跨重启要改上游缓存实现。
- guard 的新基线在**单测与标定路径**上验证过，真机 7788 未重启，实际水位表现待观察。
