# dotd 延迟与可用性优化方案（2026-10-24）

> 上一轮已经把模型换到网关最快的 `deepseek-v4.1-flash`（见
> `docs/acceptance/model-latency/REPORT.md`）。这份方案处理**换模型解决不了的那部分**。
>
> 所有数字都来自本机实测，时间线原始数据在
> `docs/acceptance/model-latency/e2e-timeline.txt`。

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

| # | 项目 | 收益 | 工作量 | 风险 | 优先级 |
|---|---|---|---|---|---|
| 1 | 补写轮的零成本前置判据 + 节流 | 每轮 −1.5~1.9 s（连续对话），−40% 任务时长 | 0.5 天 | 中（可能漏记口头偏好）| **P0** |
| 2 | guard 基线取 p50 当门槛 | 消除"任务永久停在 queued" | 0.5 天 | 低（有测试）| **P0** |
| 3 | TTS 首包：缓存 + 连接预热 | 首句 −0.6~1.0 s | 0.5–1 天 | 低 | **P1** |
| 4 | 补写轮挪到 finish 之后（后台）| 设备立即解锁，再省 0.1–0.3 s | 1–2 天 | 高（动 §4.3 契约）| P2 |
| 5 | 工具清单/记忆按需裁剪 | 每轮少 10–14 k 输入 tokens（成本，不是延迟）| 1–2 天 | 中（漏召回）| P2 |
| 6 | 分段耗时入库 + 延迟回归门禁 | 以后不用再手工拆 | 0.5 天 | 低 | **P1** |
| 7 | light 轨换本地/直连小模型 | light 调用 1.4 s → <0.3 s | 需外部条件 | 中 | P3 |

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

### 回退

判据全部走一个配置开关（`config/dotd.yml` 的 memory 段，默认开）；
关掉即逐字回到当前行为。

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

---

## 5. P1-6：把分段耗时留下来

现在每次要回答"慢在哪"都得起临时 daemon、手工查 `steps` 和 `model_call_log`。
把它变成产品能力：

- 在任务收口时记一条 `resource_events`（或 `task_results` 新列）：
  `{setup_ms, llm_ms[], tool_ms[], memory_redo_ms, summary_ms, total_ms}`。
- `/api/tasks/:id/proof` 返回这条时间线；`--verbose` 直接打印。
- CI 里加**不联网**的回归门禁：stub 传输下 e2e P50 超过基线 20% 就红
  （防止以后某次改动悄悄给每轮加了 1 s）。

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

## 8. 落地顺序

1. **第一批（P0，1 天）**：guard 基线修 + 补写轮闸门。
   验收：本机连续跑 20 轮语音，无 `queued` 卡死；`endToEnd − firstDelta < 300 ms`；
   `npm test` 全绿。
2. **第二批（P1，1–2 天）**：TTS 缓存/预热 + 分段耗时入库。
   验收：首句 < 800 ms；`/api/tasks/:id/proof` 能看到分段。
3. **第三批（P2，需评审）**：补写轮异步化、prompt 裁剪、light 轨本地化。

---

## 9. 附：这次测量的边界

- 单网关单出口（`172.17.48.1:13065`）；换供应商/网络要重测。
- 端到端用 fake-device，覆盖 HTTP 设备协议，不覆盖 ESP32 固件与真麦克风。
- 网关延迟随负载漂移：同一天不同时段同一个模型能差 10 倍（见
  `voice-real-latency/REPORT.md` 的补充段）。**方案里的绝对值只在同一批测量内可比**，
  验收要以"同批 A/B 的差"为准，不要拿绝对值卡门禁。
