# 语音端合并：dotd × Charlie（2026-10-23）

## 一句话

**Charlie 是嘴和手，dotd 是大脑和账本。** 物理上已经合到一个仓库；运行时仍是两个进程，
靠 HTTP + MCP 接——这不是妥协，是刻意的边界（见 §4）。

## 1. 现在合并到什么程度

| 项 | 状态 | 证据 |
|---|---|---|
| Charlie 源码进入本仓库 `voice/` | ✅ 已 vendor（上游 `710d2c4`） | `voice/VENDOR.md` |
| Charlie → dotd 单轮桥 | ✅ `voice/integration/dotd_bridge.py` | `tests/voice-bridge.test.ts` 5/5 |
| Charlie 工具面接进 dotd | ✅ 直接复用其 FastMCP server | `tests/voice-mcp-seam.test.ts` 1/1 |
| MCP 声明示例 | ✅ `config/mcp-servers.voice.yml` | 默认不生效，显式启用 |
| 体检 | ✅ `npm run voice:check` | 本机：必需项全过，ffmpeg 缺（标 skip） |
| **一套壳：托管/健康/配置/日志/控制台/版本** | ✅ 阶段 1（2026-10-23） | 见 §1.1 |
| **一台设备、一件事、一份凭证** | ✅ 阶段 2（2026-10-23） | 见 §1.2 |
| **一主多设备：轮换/并发/配额** | ✅ 阶段 3（2026-10-23） | 见 §1.3 |
| **一次体检 + 一页 quickstart** | ✅ 阶段 4（2026-10-23） | `npm run onboard`、`docs/voice-quickstart.md` |
| 单一记忆源 | ✅ 阶段 5（2026-10-24） | `db/migrations/212_voice_memory_push.sql`、`src/surfaces/voice-memory.ts`、`voice/integration/dotd_memory.py`；`tests/surfaces-voice-memory.test.ts` 5/5、`voice/integration/test_memory_push.py` 4 项 |
| 单一主动推送决策 | ✅ 阶段 5（2026-10-24） | `POST /api/device/proactive/decide` + `voice/integration/push_gate.py`；允许/拒绝都写 `device_push_log` |
| 一个安装包 / 一个入口 | ✅ 阶段 5（2026-10-24） | `npm run setup:all`（Node + Python venv + 体检）、`npm run up`（再启动）；`scripts/setup-all.mjs` |

**没有做的，不写成做了。** 真音频闭环（TTS → 扬声器 → 空气 → 麦克风 → Opus →
SenseVoice）已在 2026-10-24 跑通，识别原文一致；ESP32 硬件、真人/远场/噪声语音
仍未验证。真模型首条延迟未达方案目标（见 §7）。

### 1.1 阶段 1 的证据（一套壳）

| 验收项 | 命令/证据 | 结果 |
|---|---|---|
| 只启 Charlie，托管 dotd | `python -m voice.integration.one_system`；假 kernel 退避重启单测 | 4/4 通过；真 dotd 在 7799 起停一次，`/health` 显示 `kernel=ok` |
| 一个 `/health` | `GET /health`（Charlie） | `product=charlie+dotd`、`voice=ok`、`kernel=ok|offline|incompatible` |
| 一个配置/数据根 | `--check` | `home=~/.dotd`（有旧配置自动沿用）、`voiceData=<home>/voice` |
| 一个日志流 | 真 dotd 冒烟输出 | 每行都是 `[dotd] …` |
| 一个 Web 入口 | `GET /console/`、`GET /console/api/health` | 200；反代注入 master token；浏览器 `?token=` 被剥掉 |
| 版本握手 | 假 kernel 返回 `apiVersion=99` | `kernel=incompatible`、`/health` 503，不冒充健康 |
| 口子不暴露 | 设备/浏览器不需要知道 7788 | 控制台与 API 都经 Charlie 的 8000 |

**未验**：Windows 便携包内嵌 Node；`charlie:start` 的全量 Charlie 依赖（本机只跑过
`--no-kernel` 的壳与真 dotd 子进程，TTS/ASR 因缺 ffmpeg/密钥会告警）。

### 1.2 阶段 2 的证据（设备 / 任务 / 凭证）

| 验收项 | 命令/证据 | 结果 |
|---|---|---|
| `devices` 表 + 一次性令牌 | `POST /api/devices` | 201；明文只回一次，库里只有 `sha256`（`tests/surfaces-device.test.ts`） |
| `voice` 通道 | `db/migrations/200_voice_channel.sql` | `mem_threads.channel` 重建后含 `voice`；迁移 0→200 实测 |
| 设备只能读自己的任务 | `GET /api/device/tasks/:id` | 跨设备 404；`/api/queue` → **403 `device_scope`** |
| 流按 task 过滤 | `/api/device/stream?task=` | 两个任务并发互不串台（`tests/surfaces-sse.test.ts` 新增用例） |
| Charlie 反射/皮层分流 | `voice/integration/cortex_router.py` | 12/12（`tests/cortex-router.test.ts`）；反射记账、离线兜底话术 |
| 假设备端到端 | `node scripts/fake-device.mjs --create` | 文本进 → 任务 `done` → 正文出；stub 786ms，真网关 5/5（见下方延迟小节） |
| 凭证带设备维度 | `GET /api/tasks/:id/proof` | `device{id,name,status,channel}`；非语音任务不加这个键；真模型 11 步 / 6 工具步、0 失败（`docs/acceptance/voice-real-model/PROOF.md`） |
| 哈希对账不误报 | `src/surfaces/proof.ts` | 执行面把 `path:"."` 补成 `/dot/home/.` → 显示「一致（路径规范化）」，不再报「不一致」 |
| 语音延迟旋钮 | `config/models.yml` 的 `extra_body` | 端到端并入请求体；hy3 关思考后首个 content 1.7–2.6s（`tests/router-config.test.ts`、`tests/router-http-transport.test.ts`） |
| feed 带 provenance | `GET /api/feed` | 语音记账一条：`source=device, ref=voice:<id>, note=来自设备 <name>` |
| 设备不能批准 | `POST /api/device/approvals/:id` | 恒 403，且写 `device_approval_denied` 审计 |

真机冒烟（临时 home + 7799，`DOTD_FLEET=stub`、`DOTD_MODEL_TRANSPORT=stub`）11/11：
创建设备、403、记账、feed、turn、任务 done、凭证设备维度、至少 2 步、设备批准 403、
吊销、吊销后 401。

#### 首条增量延迟（2026-10-23 实测，两把尺子分开量）

语音的"首句"由两段构成：**dotd 链路**（派发 → 组 prompt → 模型首 token → SSE 扇出 → 设备收到）
和**上游模型 TTFT**。共享网关的 TTFT 在 1.3–17s 之间抖，直接拿它当尺子量不出链路本身有多慢，
所以分成两组：

| 测法 | 上游 | firstDelta P50 | firstDelta P95 | 端到端 P50 / P95 | 产物 |
|---|---|---|---|---|---|
| 确定性链路 | 本地 OpenAI 兼容上游，固定 TTFT 300ms | **771ms** | 1413ms | 1102 / 1480ms | `docs/acceptance/voice-pipe-latency/run.json` |
| 扣掉上游固定 300ms 后的 dotd 开销 | — | **471ms** | 1113ms | — | 同上（`overhead`） |
| 真网关（hy3，思考关闭，n=8） | `172.17.48.1:13065` | 2574ms | 4531ms（含冷启；稳态 2831ms） | 5850 / 8765ms | `docs/acceptance/voice-real-model/run-8samples-thinking-off.json` |
| 真网关（hy3，思考关闭，n=5，含工具任务） | 同上 | 3172ms | 4254ms | 6213 / 6515ms | `docs/acceptance/voice-real-model/run.json` |

结论**分开说，不合并**：

- **链路达标**：dotd 侧开销 P50 0.47s、P95 1.11s，远低于"首条增量 P50 < 2.5s / P95 ≤ 4s"。
  复现：`node scripts/.pipe-latency.mjs`（5 轮，本地上游固定 300ms）。
- **总延迟不达标，原因在网关**：同一份代码、同一个任务，仅因网关负载波动，P50 就在 2.57s–4.69s 之间摆
  （三次独立跑的 P50：2574 / 3172 / 4693ms，冷启首轮最慢 17s）。这不是合并链路的问题，是**模型选型/网关**的问题。
  可供选择的旋钮（本轮新增）：`models.yml` 端点级 `extra_body`，把
  `chat_template_kwargs: { enable_thinking: false }` 原样并入请求体；
  hy3 关思考后首个 content 分片实测 1.7–2.6s（默认 3.3s+）。
- 阶段 2 的止损线因此判为：**链路层面通过；端到端层面"未在共享网关上稳定达标"**，
  上线前必须固定一个低延迟模型端点，不能拿共享中继做语音首句。

`firstDeltaMs` 的测量口径（`scripts/fake-device.mjs`）：订阅 `/api/device/stream?task=`，
首个 `chat.delta`/`chat.final` 帧到达时刻减 turn 发起时刻；事件名是 `<channel>.<kind>`
（`chat.chat.delta`），解析时只取 kind 部分，且 `taskId` 在内层 `payload` 里——
这两点都曾让 `firstDeltaMs` 恒为空，已修。

**未验**：真 ESP32 硬件（本机没有设备）。**已验**：扬声器→空气→麦克风→Opus→
SenseVoice 的声学闭环（2026-10-24，见 `docs/acceptance/voice-real-audio/`）。

### 1.3 阶段 3/4 的证据

| 验收项 | 命令/证据 | 结果 |
|---|---|---|
| 设备列表含用量 | `GET /api/devices` | `dailyTasks/dailyChars/usedTasks/usedChars` |
| 令牌轮换 | `POST /api/devices/:id/rotate` | 旧令牌当场 401（单测） |
| 同设备单并发 | `/api/device/turn` | `409 device_busy` + 在途 taskId |
| 每日配额 | `db/migrations/210_device_quota.sql` | `429 device_quota`（tasks/chars 两种），被拒不计量 |
| 配额耗尽怎么说 | `cortex_router._quota()` | ✅ 说「今天这台设备的额度用完了」；不再误报「大脑不在线」 |
| 吊销即 401 | `DELETE /api/devices/:id` 后打 5 条设备路由 | ✅ turn/stream/events/tasks/approvals 全 401（单测） |
| 设备级 SSE 断线续读 | `SseDeviceCursorStore`（`surf_kv`）+ `/api/device/stream` | ✅ 重连不带头从游标续读、已下发不重发、超窗 resync |
| 3 台设备并发 | `node scripts/.multi-device.mjs` | ✅ 9 轮全 done、9 个 taskId 唯一、并发区间重叠 30.5s、跨设备读任务 404 |
| 跨设备共享记忆 | 同脚本 A/B | ✅ A 说「花生过敏」→ `fs.write` 落盘 → B 的 prompt 里注入 → B/C 都答出 |
| 旧记忆导入 | `dotd import` / `POST /api/memory/import` | ✅ 提示词 + 16 KB 上限 + 只写 `notes/YYYY-MM-DD-import-<slug>.md` |
| 上游许可 | `voice/NOTICE` | ⚠️ 上游 README 称 MIT 但无 LICENSE 文件；自用可以，对外发布前必须补齐 |
| 一键起 | `docker/compose.voice.yml` | ✅ 冷构建 238 s、镜像 1.59 GB、容器 healthy、设备面一轮带凭证（`docs/acceptance/voice-docker/`） |
| 上手体检 | `npm run onboard` | 必需项全绿；缺项逐条给命令 |
| 一页上手 | `docs/voice-quickstart.md` | 云主机 / 盒子 / ESP32 / 排障 / 延迟旋钮 |

阶段 3 的两条**模型侧**限制（不是链路问题，验收时实测）：

1. hy3 关思考后仍会「只口头答应记住」而不调用 `fs.write`。语音说「记住…」时，
   提示词必须明确要求先落盘再确认；验收脚本因此校验 journal 里确实有成功的 `fs.write`。
2. 换措辞提问时，模型生成的检索词会变差（`过敏 allergic`），`memory.search` 命中不足就
   回答「没有记录」。同题对照稳定；这属模型能力，链路不改。

## 2. 数据流（当前已跑通的路径）

```
用户说话
  │
  ▼
Charlie（Python，宿主）
  ASR → cortex_router.reply()
  ├─ 反射：FastPath / 场景协议 / 缓存 / 摄像头 / 低意图
  │     → 本地立即答 + POST /api/device/events（离线写 spool，恢复后补传）
  └─ 皮层 → voice/integration/dotd_bridge.py（DeviceBridge）
                │ POST /api/device/turn        （设备令牌）
                ▼
            dotd（Node）
              Runner → 治理/审批 → 工具
                ├─ mcp.call → charlie-scenes / charlie-reminders（宿主 MCP server）
                ├─ fs/browser/mail/...（容器）
                └─ voice thread（external_ref=device）/ journal / audit / task_results
                │
                ◀── GET /api/device/tasks/:id（reply + summary）
                ◀── GET /api/device/stream?task=（SSE 首条增量）
              DeviceBridge 取 assistant 正文；`dotd prove` 带设备维度
                │
                ▼
            Charlie TTS → 播报
```

桥的失败语义（已测）：

| 情况 | 行为 |
|---|---|
| dotd 不可达 | `status=unreachable`，退出码 1，不假装成功 |
| 缺 token | `status=config`，退出码 2 |
| 401 | 原样报 `HTTP 401` |
| 任务需要审批 | `needsOwner=true`，语音端**不代替**主人点批准 |
| 等待超时 | `status=timeout`，任务**不取消**（Web 上还能继续） |
| 终态但没有 assistant 正文 | `ok=false` + reason，不编一句回复 |

## 3. 怎么跑

```bash
# 1) 体检（不安装、不写配置）
npm run voice:check

# 2) 文本单轮（不需要麦克风/ffmpeg）
DOTD_BASE_URL=http://127.0.0.1:7788 \
DOTD_TOKEN=<master> \
npm run voice:bridge -- "把今天的报价单核对一下"

# 3) 把 Charlie 的宿主工具接进 dotd
cp config/mcp-servers.voice.yml config/mcp-servers.yml   # 或 DOTD_MCP_CONFIG=...
# 重启 daemon 后，模型工具面出现 mcp.call（dangerous 档，每次审批）

# 4) 跑接缝测试
npm run voice:test
```

## 4. 刻意的边界

1. **不合并语言**：Python 的语音/红外/ESP32 生态和 Node 的内核各干各的。
   重写任何一边都是纯亏。
2. **物理工具跑宿主，数字工具跑容器**：红外/涂鸦/ESP32 不能进容器；dotd 的
   `mcp.call` 本来就由宿主侧转发（`src/exec/ExecService.ts:640`、`:782`），正好对齐。
3. **一个大脑**：Charlie 的 `voice_agent.py` 里那套 LLM/MCP 循环不再作为产品路径；
   需要规划的任务一律交给 dotd。本地只剩"场景词/提醒"这种确定性快路径。
4. **工具目录去重**：Charlie 只保留宿主/硬件工具；文件、浏览器、邮件、日历这些
   数字工具归 dotd。两边都注册同一件事，必然漂移。
5. **默认安全**：`mcp.call` 是 dangerous 档；语音端不能点审批，危险动作必须回
   Web/飞书卡片或语音二次确认 + PIN（后者未做）。

## 5. 最后三件事（阶段 5，2026-10-24 已合并）

### 5.1 记忆源（已合并）

**dotd 是唯一事实源。** 实现分两半：

| 侧 | 文件 | 行为 |
|---|---|---|
| dotd | `src/surfaces/voice-memory.ts`、迁移 212 | `GET /api/device/memory`（消息 + 偏好）、`POST /api/device/memory/turn`（幂等补写）、`PUT/DELETE /api/device/prefs`、管理面 `GET /api/memory/prefs` |
| Charlie | `voice/integration/dotd_memory.py` | 启动时从 dotd 拉历史；本地 `conversation_history.json` / `preferences.json` 只当缓存；反射轮次补写；dotd 已处理的轮次不重复写 |

- 反射/本地场景以前只在 Charlie 的本地文件里，现在会补写进同一条 voice thread，
  Web `/api/conversations?thread=` 能读到。
- dotd 离线：读回落本地缓存（明确是缓存），写尽力而为，不打断对话。

证据：`tests/surfaces-voice-memory.test.ts`（5 条）、
`voice/integration/test_memory_push.py`（4 条）、`tests/voice-memory-push.test.ts`。

### 5.2 主动推送（已合并）

**dotd 决定「该不该说」，Charlie 只负责「怎么说」。**

- 唯一决策入口 `POST /api/device/proactive/decide`：复用 `src/surfaces/proactive.ts`
  的三道闸（总开关 / 安静时段 / 节流），再补每日总量与同文去重；每次决策写
  `device_push_log`（允许与拒绝都记）。
- Charlie 侧 `voice/integration/push_gate.py` 替换 `app.notifications.add_notification`、
  `app.schedulers.add_notification`、`voice_server._add_notification` 与个性化推荐发送口。
- 豁免：`reminder`（主人显式设置）、`wake`（对话转录）、`health`（系统自监控）。
- dotd 不可达默认 **fail-closed**（`CHARLIE_PUSH_GATE_FAIL=open` 可改）；
  `CHARLIE_PUSH_DECIDER=local` 可退回上游行为。
- 被拒绝的决策**不推进节流账本**：安静时段拦下的那条，不会让 7:30 之后的第一条也被误伤。

证据：`tests/surfaces-voice-memory.test.ts`（5 条，含「拒绝不推进节流」）、
`voice/integration/test_memory_push.py`（4 条）。

### 5.3 一个入口（已合并）

```bash
npm run setup:all     # node_modules + .venv + integration 依赖 + 体检
npm run up            # setup:all + 启动 Charlie（托管 dotd）
npm run setup:all:check   # 只体检（CI 用）
```

`scripts/setup-all.mjs` 是幂等的：已存在的 `node_modules` / `.venv` 不重建；
`--dry-run` 只打印计划；不写密钥、不动系统 Python。

仍**未做**：把 Node/Python 内嵌成单个便携包（成本最高，放到发布之后）。

## 6. 许可证

已解决（2026-10-24）：

- `voice/` 补入 `voice/LICENSE`（MIT）。本仓库维护者即上游作者
  （GitHub `SxLiuYu`，上游提交者 `yujinze`），与上游 README 的 MIT 声明一致；
- 仓库根目录 `LICENSE` 为 Apache-2.0，覆盖 `src/`、`scripts/`、`db/`、`web-ui/` 等；
- `voice/integration/` 为双许可（Apache-2.0 或 MIT，取更宽松的）；
- 第三方来源登记在 `THIRD_PARTY.md`，上游归属与改动边界在 `voice/NOTICE`。

## 7. 本轮证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 桥接缝 | `node --import tsx --test tests/voice-bridge.test.ts` | **5 / 5** |
| MCP 接缝 | `node --import tsx --test tests/voice-mcp-seam.test.ts` | **1 / 1** |
| 反射/皮层 | `tests/cortex-router.test.ts`（Python unittest 17 项） | **17 / 17** |
| 设备面 | `node --import tsx --test tests/surfaces-device.test.ts` | **18 / 18** |
| 记忆源 / 推送决策（HTTP） | `node --import tsx --test tests/surfaces-voice-memory.test.ts` | **5 / 5** |
| 记忆源 / 推送决策（Python） | `python -m unittest voice.integration.test_memory_push` | **8 / 8** |
| 记忆源 / 推送决策（真进程） | 真 dotd + 真 `DeviceBridge`，见 `docs/acceptance/voice-memory-single-source/` | 补写/幂等/偏好/四类决策/留痕 **全对** |
| 音频链路（合成 PCM） | `python -m unittest voice.integration.test_audio_chain` | **2 / 2** |
| 全套 | `npm test` | **1990 / 1990**（阶段 5 新增 5 条 HTTP 用例 + 2 条 Python 包装） |
| 类型检查 | `npx tsc --noEmit -p .` | 0 错误 |
| 体检 | `npm run voice:check` | 必需 6 项全过；ffmpeg 标 skip（本机未装） |
| 真模型延迟 | `node scripts/fake-device.mjs --runs 5` | 首条 P50 **4.80 s** / 端到端 P50 **10.98 s** / P95 **23.46 s**；**未达 2.5 s 目标** |
| 真音频闭环 | `DOTD_REAL_AUDIO=1 DOTD_REAL_MIC=1 python -m unittest voice.integration.test_real_audio` | **2 / 2**：TTS → 扬声器 → 空气 → 麦克风 → Opus → SenseVoice，识别原文一致 |
| 安装入口 | `npm run setup:all` | Node + `.venv` + 依赖 + 体检全过 |

**未验**：ESP32 硬件、真人/远场/噪声语音、云 ASR/TTS 厂商（无 key）、真红外控空调。
真模型延迟报告：`docs/acceptance/voice-real-latency/REPORT.md`；
音频自测边界：`docs/acceptance/voice-audio-sim/REPORT.md`；
真音频证据：`docs/acceptance/voice-real-audio/REPORT.md`。

Charlie FastAPI 全量启动已在容器里跑通（2026-10-23）：`/health` 返回
`voice:"ok"` + `kernel:"ok"`，`dotd` 作为子进程由 `one_system.py` 管理，设备自动注册，
设备面一轮有凭证（`docs/acceptance/voice-docker/`）。但容器只装了
`requirements-core.txt`：VAD 退化成 RMS 端点、TTS 因无 key 报 `no TTS available`
（日志里明写，不影响文本链路）。真 ESP32 硬件仍未验；本机声学闭环已验
（`docs/acceptance/voice-real-audio/`）。
