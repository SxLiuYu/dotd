# 真模型语音延迟实测（2026-10-24）

## 结论（先说不好的）

**没有达到方案 §7.1 的「简单问答 < 2.5s」目标。** 本机实测：

| 指标 | 实测 | 方案目标 | 判定 |
|---|---|---|---|
| 首条增量 P50 | **4.80 s** | < 2.5 s（简单问答） | ❌ 未达标 |
| 首条增量范围 | 3.72 – 18.49 s | — | 波动很大 |
| 端到端 P50 | **10.98 s** | 完成不设上限（复杂任务） | 可接受 |
| 端到端 P95 | **23.46 s** | — | 偏慢 |
| dotd 调度开销（submit → 第一步开始） | **45 – 1005 ms**，中位 299 ms | < 200 ms | ⚠️ 略超 |

**原因不在 dotd 的调度，而在模型端到端首 token。** 调度开销中位 299 ms；
剩下 4.5 s 以上全是模型网关的 TTFT。这批测试走的是
`deepseek-v4-1-flash-1017`（本机 Agent2API 网关），不是方案里推荐的
GLM/DeepSeek flash 直连；换更快的 light 轨模型能明显改观。

## 环境与命令（可复现）

```bash
# 临时 home + 7799，不碰主人在跑的 7788
DOTD_HOME=.tmp-latency node scripts/init-config.mjs
# 把 config.yml 的 port 改成 7799
DOTD_HOME=$PWD/.tmp-latency \
DOTD_CONFIG=$PWD/.tmp-latency/config.yml \
DOTD_DB_PATH=$PWD/.tmp-latency/dotd.db \
DOTD_FLEET=stub DOTD_GUARD_BASE_MB=1024 \
HY3_API_KEY=... node --import tsx src/daemon.ts

DOTD_BASE_URL=http://127.0.0.1:7799 DOTD_MASTER_TOKEN=... \
  node scripts/fake-device.mjs --create --runs 5 \
  --text "用一句话回答：3+5 等于几？" --timeout 120000 --json
```

- 模型：`deepseek-v4-1-flash-1017`，端点 `http://172.17.48.1:13065/v1`
- 5/5 全部 `done`，回复均为「3+5 等于 8。」
- 同一设备 5 轮复用同一条 voice thread（`thr_01M5P0QQMPN0Z960V2TT6NMM7A`）
- 证据：`runs.json`（每轮 taskId / firstDelta / endToEnd / proof）

## 实测中发现的一个真问题（已绕过，未改代码）

本机内存水位把 guard 钉在 `throttled`，`pop()` 直接返回 null，任务永远停在
`queued`（现场 `queue {queued:1, running:0}`）。根因是标定把
`baseMb` 取成 MemAvailable 的 p50（本机 35.4 GB），而当时可用内存 35.7 GB
只比门槛高一点点，水位抖动就落回 throttled。

- 本轮用 `DOTD_GUARD_BASE_MB=1024` 钉死基线跑完，属于**绕过**而不是修复。
- 这是 `src/control-plane/guard.ts` 的阈值语义问题（p50 可用内存当基线），
  建议单独修：把基线改为「总内存 − 标定时的可用内存」或直接默认
  `fallbackThresholds`，并加一条「阈值不得高于物理总量 80%」的断言。
- 记在这里，避免下次又把它误判成「模型慢」。

## 结论怎么用

- 「语音端到端 < 2.5 s」在**当前网关 + 当前模型**下不成立，不能写进验收。
- dotd 侧不是瓶颈（调度中位 299 ms）。要压低首句延迟，优先换 light 轨模型
  （GLM flash / 直连 DeepSeek），而不是再优化队列。
- 复杂任务的端到端 11 s / P95 23 s 属于模型推理时间，方案本身不设上限。

---

## 2026-10-24 补充：瓶颈已按上面的建议换掉，目标达成

上面说的「优先换 light 轨模型」已经做了，而且连同 primary 一起换：

- `primary` / `light`：`deepseek-v4-1-flash-1017` → **`deepseek-v4.1-flash`**
- 同日同机同 prompt（"3+5 等于几"）各 5 轮真 daemon：
  - 新模型：首条增量 P50 **2.02 s**、端到端 P50 **3.63 s**、P95 4.33 s，5/5 通过
  - 旧模型：首条增量 P50 **25.71 s**、端到端 P50 **50.24 s**，5/5 通过
- 「简单问答首条 < 2.5 s」在 5 轮里 4 轮达标。

注意：同一旧模型在上面的 2026-10-24 早间测是 4.8 s，晚上再测变成 25.7 s——
**网关负载会把这个数字改写一个数量级**。本文档的绝对值只在"同一批测量"内可比。

方法与原始样本：`docs/acceptance/model-latency/REPORT.md`。
上面那条 guard 阈值问题仍未修（本轮继续用 `DOTD_GUARD_BASE_MB=1024` 绕过）。
