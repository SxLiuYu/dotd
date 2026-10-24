# 模型延迟实测与选型（2026-10-24）

## 结论

**`deepseek-v4.1-flash` 是本机 agent2api 网关上延迟最低、且工具调用可靠的模型。**
`config/models.yml` 的 primary 与 light 已从 `deepseek-v4-1-flash-1017` 换成它。

同一个 daemon、同一台机器、同一天、同一句"3+5 等于几"，各跑 5 轮：

| 指标 | 新 primary `deepseek-v4.1-flash` | 旧 primary `deepseek-v4-1-flash-1017` | 变化 |
|---|---|---|---|
| 首条增量 P50 | **2.02 s** | 25.71 s | **−92 %** |
| 端到端 P50 | **3.63 s** | 50.24 s | **−93 %** |
| 端到端 P95 | **4.33 s** | 55.33 s | −92 % |
| 通过轮次 | 5/5 | 5/5 | — |
| 单次模型调用（`model_call_log`） | 1.16 – 2.49 s | 9.06 – 39.09 s | — |

方案 §7.1 的「简单问答首条 < 2.5 s」在 5 轮里有 4 轮达标（2.02 s P50）；
旧配置 25.7 s，差了一个数量级。

## 方法

四类请求形状，对应 daemon 实际会打的四种调用。全部 `temperature=0`、
socket 超时 45 s、每条样本即时落盘：

| 形状 | 命令 | 量的东西 |
|---|---|---|
| `ttft` | `bench.py ttft` | 流式首 token（**回答**首字，不是思维链首字）与总耗时 |
| `loop` | `bench.py loop` | 两轮真主循环：工具调用 → 喂回结果收尾 |
| `multi` | `bench.py multi` | 最多 5 轮：工具结果里明说"还有文件没看"，逼它继续调 |
| `light` | `bench.py light` | light 轨形状：无工具单轮短答（事件匹配） |

端到端那一列不是脚本测的，是**真 daemon**：临时 home + 端口 7799（不碰主人在跑的
7788），`DOTD_FLEET=stub`，用 `scripts/fake-device.mjs` 走完整语音设备协议。

```bash
# 1) 纯网关基准
export HY3_API_KEY=...          # 或 source ~/.dotd/tokens.env
python docs/acceptance/model-latency/bench.py ttft  --runs 3 --models <ids...>
python docs/acceptance/model-latency/bench.py loop  --runs 4 --models <ids...>
python docs/acceptance/model-latency/bench.py multi --runs 3 --models <ids...>
python docs/acceptance/model-latency/bench.py light --runs 5 --models <ids...>

# 2) 真 daemon 端到端（A/B 换模型只改临时 cfg，不动仓库配置）
DOTD_HOME=$PWD/.tmp-lat node scripts/init-config.mjs
# 把 .tmp-lat/config.yml 的 port 改成 7799
DOTD_HOME=$PWD/.tmp-lat DOTD_CONFIG=$PWD/.tmp-lat/config.yml \
DOTD_DB_PATH=$PWD/.tmp-lat/dotd.db DOTD_FLEET=stub DOTD_GUARD_BASE_MB=1024 \
HY3_API_KEY=... node --import tsx src/daemon.ts
DOTD_BASE_URL=http://127.0.0.1:7799 DOTD_MASTER_TOKEN=... \
  node scripts/fake-device.mjs --create --runs 5 \
  --text "用一句话回答：3+5 等于几？" --timeout 120000 --json
```

原始样本都在本目录：

- `ttft-runs.jsonl`（33 条，11 个模型 × 3）
- `loop-runs.jsonl`（20 条，5 个模型 × 4）
- `multi-runs.jsonl`（12 条，4 个模型 × 3）
- `light-runs.jsonl`（20 条，4 个模型 × 5）
- `e2e-deepseek-v4.1-flash.json` / `e2e-deepseek-v4-1-flash-1017.json`（各 5 轮真 daemon）

## 结果

### 单轮首 token（流式，带 tools）

| 模型 | 回答首字 P50 | 范围 | 通过 | 备注 |
|---|---|---|---|---|
| **deepseek-v4.1-flash** | **1 349 ms** | 1 219 – 1 849 | 3/3 | 思维链很短，几乎不拖 |
| hy3 | 1 895 ms | 1 708 – 3 189 | 3/3 | **带 tools 时不返回 tool_calls**（只出文本），primary 不可用 |
| deepseek-v4-1-flash-1017 | 1 997 ms | 1 659 – 2 052 | 3/3 | 旧 primary；单轮看着还行，两轮就露 |
| DeepSeek-Flash | 2 312 ms | 1 160 – 3 464 | 2/3 | 抖动大，偶发无回答 |
| space-bunny | 2 384 ms | 2 272 – 2 906 | 3/3 | 稳，但两轮基准里 1/3 超时 |
| auto | 2 486 ms | 1 607 – 2 637 | 3/3 | 网关自己路由，不可控 |
| GLM-5.3-Flash | 3 415 ms | 3 052 – 3 779 | 2/3 | 有明显尾延迟 |
| glm-5.3 | 3 863 ms | 3 110 – 4 162 | 3/3 | 非 flash，更贵更慢 |
| step-5-preview | 4 700 ms | 4 259 – 5 159 | 3/3 | — |
| Qwen3.8-Flash | 6 683 ms | 5 884 – 7 482 | 2/3 | 单轮 TTFT 与两轮结论不一致，尾延迟差 |
| minimax-m3.1-flash | 19 597 ms | 4 246 – 34 948 | 2/3 | 双峰：要么 4 s 要么 35 s |
| gpt-6-luna | — | — | 0/3 | 网关拒绝：`not allowed for user type [personal_free_user]` |

### 两轮真主循环（工具调用 → 收尾）

| 模型 | 总耗时 P50 | 范围 | 通过 | 答案用到工具结果 |
|---|---|---|---|---|
| **deepseek-v4.1-flash** | **3 656 ms** | 2 899 – 3 960 | 4/4 | 4/4 |
| GLM-5.3-Flash | 5 064 ms | 4 700 – 5 428 | 2/4 | 2/2 |
| DeepSeek-Flash | 6 348 ms | 4 614 – 7 168 | 3/4 | 3/3 |
| deepseek-v4-1-flash-1017 | 14 129 ms | 8 131 – 23 154 | 4/4 | 3/4 |
| Qwen3.8-Flash | 21 351 ms | 4 259 – 38 444 | 2/4 | 2/2 |

### 多步（最多 5 轮，测步数控制）

| 模型 | 总耗时 P50 | 通过 | 实际轮数 |
|---|---|---|---|
| **deepseek-v4.1-flash** | **7 466 ms** | 3/3 | 2 / 4 / 4 |
| GLM-5.3-Flash | 11 480 ms | 1/3 | 2 |
| DeepSeek-Flash | 46 809 ms | 1/3 | 4 |
| deepseek-v4-1-flash-1017 | — | 0/3 | 全部超时或空答 |

这一项推翻了 2026-10-18 的旧结论（"deepseek-v4.1-flash 要 14 步、glm 只要 8 步"）：
今天 deepseek 在两步内就收工，glm 反而经常卡到超时。**旧结论不能直接复用，网关行为会变。**

### light 轨（无工具单轮短答）

| 模型 | P50 | 范围 | 分类正确 |
|---|---|---|---|
| **deepseek-v4.1-flash** | **1 462 ms** | 1 273 – 1 688 | 5/5 |
| GLM-5.3-Flash | 1 920 ms | 1 399 – 31 966 | 5/5 |
| Qwen3.8-Flash | 2 042 ms | 1 242 – 32 280 | 4/5 |
| DeepSeek-Flash | 2 440 ms | 1 827 – 32 085 | 5/5 |

light 也给了 deepseek-v4.1-flash：它不只中位数低，**没有尾延迟**——其余三个都在
32 s 附近出现过一次卡死。事件匹配卡 32 s 会把主动推送拖垮。

## 选型与配置改动

```yaml
models:
  primary: deepseek-v4.1-flash
  light:   deepseek-v4.1-flash
fallback_models: { primary: [DeepSeek-Flash, GLM-5.3-Flash], light: [DeepSeek-Flash] }
```

fallback 顺序按"第二/第三快且通过率高"排：DeepSeek-Flash 一号，GLM-5.3-Flash 二号
（尾延迟差但正确率高，适合最后兜底）。**没有把 `hy3` 放进链**——它带 tools 时不出
tool_calls，等于任务"看起来做完了"。`minimax-m3.1-flash` 也没进：双峰 1.3 s / 61.8 s。

改动后的验证：

```
node --import tsx scripts/probe-live-model.mjs
  → tool_calls: 是（1 个，name=fs.read 已还原为契约名，arguments=合法 JSON）
  → latency: 1716ms，结论：通过
npm run typecheck   → 通过
npm test            → 1991 / 1991
```

## 顺带发现并修掉的四个真问题

1. **推理模型的思维链把 token 预算吃光。** 本网关会先流 `reasoning_content` 再流
   `content`。把 `max_tokens` 设成 48 时，模型把预算全烧在思维链上，`finish_reason=length`
   且 `content` 为空——看起来像"模型没响应"。基准脚本已改成先大预算再判定；
   daemon 主循环本来就是 4096，不受影响，但**以后调小池探测的 `maxTokens`（64）
   要想到这一条**。
2. **点分工具名会被网关 400。** 直接拿 `fs.read` 调 `deepseek-v4.1-flash` 会返回
   `the tool name is invalid or duplicated`。daemon 侧 transport 已经把点分名消毒成
   `fs_read`（MR §3.1 编解码归 transport），所以线上没事；**手写脚本/curl 必须自己消毒**，
   否则会误判成"这个模型不能用"（这次差点误杀）。
3. **网关目录会变，旧注释会骗人。** 2026-10-22 记录的"`deepseek-v4.1-flash` /
   `Qwen3.8-Flash` 不在目录"今天已不成立：`GET /v1/models` 现有 12 个 id，两者都在，
   而 `sn-deepseek-v4-1-flash-1017` 已经消失。换模型前先拉目录。
4. **Windows 上 opuslib 找不到 libopus 会在 import 阶段崩进程。** 这是装真音频依赖
   之后暴露的：`opuslib` 抛的是 `Exception` 而不是 `ImportError`，上游的
   `except ImportError` 兜不住，`npm test` 里的合成音频链路跟着红。
   已加 `voice/integration/opus_runtime.py`：`OPUS_LIB` → PyAV 自带
   `av.libs/libopus-*.dll` → `ctypes.util.find_library` 三级查找，
   且**只拦 "opus" 开头的名字**（全量替换会毒到 PortAudio，实测
   `symbol 'Pa_Initialize' not found in ... opus.dll`）。回归测试：
   `voice/integration/test_opus_runtime.py` + `tests/voice-opus-runtime.test.ts`。

## 边界（这些没验）

- **只有一个网关、一个出口。** 所有数字都来自 `172.17.48.1:13065`（agent2api）。
  换供应商、换 key、换网络路径都要重测。
- **数字随网关负载漂移。** 同一模型 2026-10-22 测是 23.7 s、今天 2.0 s；旧 primary
  今天 25.7 s（早前报告里是 4.8 s）。所以这里给的是**同日同批对比**，不是模型绝对性能。
- **端到端用 fake-device，不是 ESP32。** 覆盖了 HTTP 设备协议、任务排队、模型调用、
  流式回包；不覆盖 ESP32 固件、真麦克风、真人语速。
- **没测并发。** daemon 多任务并行时的排队延迟不在本次范围内。
- **gpt-6-luna 没法验**：网关按用户类型拒绝，不是模型问题。
