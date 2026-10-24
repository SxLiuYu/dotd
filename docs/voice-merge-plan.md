# 合并方案：Charlie（ESP32 语音端）× dotd（个人 agent 内核）

> 2026-10-23 · 评估稿 · 结论先行

## 0. 结论

**推荐方案 B：反射 + 皮层。**

- **Charlie 保留「反射层」**：唤醒/VAD、场景词、设备控制、提醒、天气/音乐快路径、ASR/TTS、ESP32 接入、OTA。
- **dotd 承担「皮层」**：任务规划、工具执行、审批、长期记忆、审计、`prove`。
- **Charlie 的 LLM 大脑降级**：默认不再当主脑，只保留为「dotd 不在线」时的离线兜底，并明确标注“未审计”。
- **一个主人、多台设备**先做；一个设备多主人后做。
- **设备只连语音服务，不直连 dotd**；dotd 继续只监听回环。

不推荐 A（Charlie 主脑）：延迟最好，但审批、多设备、审计都会塌。
不推荐 C（双主脑并存）：短期最快，长期四个冲突（记忆/工具/推送/审计）收不回来。
不推荐 D（全迁 dotd）：语音和硬件生态在 Python，重写是纯亏。

### 0.1 “一套系统”到底指什么

代码层面强行合成一种语言不划算；**一套系统 = 用户只感知到一个产品**。
因此采用 **B′：Charlie 是产品壳，dotd 是内核服务**。

| 维度 | 合并后只有一套 | 实现方式 |
|---|---|---|
| 产品名 / 入口 | **Charlie** | 用户只启动 Charlie；dotd 由 Charlie 托管启动 |
| 安装 | 一个安装包 / 一条 compose | Charlie 启动时检查并拉起 dotd；版本不匹配拒绝启动 |
| 配置 | 一个配置根（`~/.charlie/`，向后兼容 `~/.dotd/`） | dotd 读同一个根；Charlie 不再维护第二套 |
| 数据 | 一个数据根 | Charlie 写 `voice/` 子目录；dotd 写库与记忆 |
| 账号/身份 | 一个主人 + 多台设备 | dotd 的 `devices` 表是唯一设备目录 |
| 大脑 | 一个主脑 | dotd；Charlie 只留反射与离线兜底 |
| 记忆 | 一套 | dotd 唯一事实源；Charlie 只读缓存 |
| 主动推送 | 一个决策者 | dotd 决定；Charlie 只播报 |
| 控制台 | 一个 Web | Charlie 现有页面 + dotd 的动态/审批/凭证页签 |
| 日志 | 一个流 | Charlie 汇总 dotd 的 stdout/stderr，带模块标签 |
| 升级 | 一个版本号 | Charlie 版本 → 兼容的 dotd API 版本，启动时握手 |

**仍然保留两个运行时**：Python（语音/硬件）和 Node（内核）。这不是“没合并”，
而是“一个产品、两个进程”。判断标准是用户是否还需要分别启动、分别配置、分别看日志——
只要还需要，就不算一套。

### 0.2 如果代码不好合：按能力注入，而不是搬代码

| dotd 的优势 | Charlie 现在的痛点 | 注入方式 |
|---|---|---|
| 五档治理 + 审批 | 语音里“发出去/关掉”没有授权边界 | 危险动作走 dotd 审批；设备只说“需要确认” |
| 审计 + `prove` | 用户问“刚才为什么关空调”答不上来 | 每条语音任务留凭证；场景执行也记账 |
| 持久队列 + journal | 长任务重启就丢 | 交给 dotd；语音先说“我去办” |
| 模型路由/熔断 | Charlie 自己维护三级降级 | 迁到 dotd `models.yml`；Charlie 不再管模型 |
| 记忆 / IDENTITY | 语音与 Web 各记各的 | dotd 唯一事实源；Charlie 读 API |
| Feed / 主动推送 | Charlie 决策引擎与 dotd 双重打扰 | dotd 决定；Charlie 只播报 |
| MCP 宿主工具 | Charlie 的 19 个工具只服务自己 | 已接进 `mcp.call`，dotd 与其他前端共用 |

**原则**：不把 Charlie 的 Python 代码搬进 dotd，也不把 dotd 的 TS 搬进 Charlie；
只搬**能力边界**（谁决定、谁执行、谁记账）。

---

## 1. 现状评估（只列事实）

### 1.1 Charlie 侧：不可替代的资产

| 资产 | 证据 |
|---|---|
| Xiaozhi v2.1.0 兼容的 ESP32 WebSocket：16kHz Opus 上行、24kHz 下行、60ms 帧、Silero VAD | `voice/charlie/app/xiaozhi_ws.py:551`、`voice/docs/ESP32.md:9-14` |
| AP 热点配网 + OTA + 烧录向导 | `voice/docs/ESP32.md:16-60` |
| 语音闭环与实测延迟：首句 ~1.16s，端到端 ~2.23s | `voice/docs/ESP32.md` 性能段 |
| 不经过 LLM 的快路径：场景词、设备控制、音乐、天气、视觉 | `voice/charlie/voice_agent.py:415`（FastPath）、`:480`（场景）、`agent/device_control.py` |
| 19 个 MCP 工具，本身就是 FastMCP stdio server | `voice/charlie/magic-*.py` 的 `@mcp.tool()`；本轮已用 dotd `McpClient` 实测 |
| 多用户/多设备映射（device→user→room） | `voice/charlie/agent/device_users.py:325-384` |
| 自主决策与防骚扰（冷却、反馈学习、待确认） | `voice/charlie/magic-decisions.py:495-751` |
| 三级模型降级 + 429 轮换 | `voice/charlie/agent/llm.py`、`llm_state.py`；README 的 Demo/GLM/ARK 三档 |

### 1.2 dotd 侧：不可替代的资产

| 资产 | 证据 |
|---|---|
| 持久队列 + journal + 崩溃恢复 | `src/control-plane/queue.ts`、`recovery.ts` |
| 五档治理 + 审批八态机 + 审计 | `src/governance/`、`db/migrations/020_governance.sql` |
| 模型路由 tier1–4 + 熔断 | `src/router/ModelRouter.ts` |
| 记忆：thread / MEMORY.md / IDENTITY.md / FTS | `src/memory/`、`db/migrations/040_memory.sql` |
| 执行凭证 `prove`：步骤/审批/模型/哈希对账 | `src/surfaces/proof.ts`、`tests/surfaces-proof.test.ts` |
| MCP 宿主转发（不经过容器） | `src/exec/ExecService.ts:640-650`、`:782-809` |
| SSE 增量：`chat.delta` / `chat.final` | `src/surfaces/sse.ts:6-13`、`src/runner/dot.ts:1869` |

### 1.3 合并前必须知道的五个硬缺口

1. **单主人**：`dotIds: ['dot1']`（`src/daemon.ts:207`）；HTTP 只有 master/readonly 两类 token（`src/surfaces/http.ts:355-365`）。没有设备身份。
2. **没有 voice 通道**：`mem_threads.channel` 的 CHECK 只有 `web/telegram/feishu/cli/email/event/heartbeat`（`db/migrations/060_feishu_channel.sql:10`）。加 `voice` 要一次表重建迁移。
3. **SSE 没有 task/thread 过滤**：只支持 `topics` 和 `dot`（`src/surfaces/sse.ts:334-355`）。多设备会互相看到对方的增量。
4. **并发口径不一致**：`src/daemon.ts:233` 注释写默认 3，`:497` 代码默认 **1**。多设备前必须先定口径。
5. **Charlie 设备令牌默认值不安全**：`XIAOZHI_DEVICE_TOKEN` 默认就是字符串 `"device"`（`voice/charlie/app/auth.py:9-11`）。上公网前必须改。

另有许可证风险：上游 README 声称 MIT，但仓库没有 LICENSE 文件（`voice/VENDOR.md`）。

---

## 2. 方案比较

评分 1–5，越高越好；“改造量”越高代表越省事。

| 维度 | A. Charlie 主脑 | **B. 反射 + 皮层（推荐）** | C. 双主脑并存 | D. 全迁 dotd |
|---|---:|---:|---:|---:|
| 快路径延迟 | 5 | **5** | 4 | 2 |
| 离线可用 | 5 | **4** | 5 | 1 |
| 云端多设备/多主人 | 2 | **4** | 2 | 5 |
| 审计完整性 | 2 | **4** | 2 | 5 |
| 安全治理（审批/限权） | 2 | **4** | 2 | 5 |
| 长期可维护 | 2 | **4** | 1 | 3 |
| 改造量（省事） | 3 | **3** | 5 | 1 |
| **总分** | 21 | **28** | 21 | 22 |

**为什么 B 赢**：唯一同时保住「1 秒级反射」和「可审计/可多设备」的方案。代价是要做一次协议分层，而不是简单接线。

---

## 3. 目标架构

```
┌──────────────────────────────────────────────────────────┐
│ ESP32 / 小硬件（device profile）                           │
│ 唤醒词 · VAD · 16k Opus 上行 / 24k 下行 · 屏幕 · 按键 · OTA │
│ 只持设备令牌；只连语音服务                                  │
└───────────────────────┬──────────────────────────────────┘
                        │ WSS（现有 xiaozhi 协议）
┌───────────────────────▼──────────────────────────────────┐
│ Charlie 语音服务（Python，唯一公网入口）                    │
│ ASR ↔ TTS · 设备注册/鉴权 · 会话 · 配网/OTA                 │
│ 反射层：场景词 / 设备控制 / 提醒 / 天气 / 音乐              │
│ 反射记账：POST /api/device/events（低风险场景也要留痕）      │
│ 降级层：dotd 不在线时执行本地场景，并明确回复“未审计”        │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP / SSE（内网回环）
┌───────────────────────▼──────────────────────────────────┐
│ dotd 内核（Node，只监听 127.0.0.1）                         │
│ 队列 → Runner → 治理/审批 → 工具（容器 + 宿主 MCP）         │
│ 记忆（thread/MEMORY.md/IDENTITY.md）· 审计 · prove          │
│ 命令/调度 · feed · 主动推送决策（唯一决策者）                │
└──────────────────────────────────────────────────────────┘
```

### 三种部署档位

| 档位 | 跑什么 | 典型硬件 | 说明 |
|---|---|---|---|
| `cloud` | Charlie + dotd + Docker 工具容器 | 2C4G 起 | ESP32 通过 WSS 连公网入口 |
| `box` | 同上，工具可走本地/无 Docker | 树莓派 4/5、迷你主机 | 家里断网时反射层仍可用 |
| `device` | 只跑固件 | ESP32（~30 元） | 不承载任何业务逻辑 |

> ESP32 不可能跑 dotd 或 LLM。所谓“小硬件上都能用”，准确含义是：**小硬件当嘴，盒子或云当脑**。

---

## 4. 关键设计决策（默认值）

| 决策 | 默认 | 理由 / 可改点 |
|---|---|---|
| 主脑 | dotd | 云端多设备、审批、审计只有一处 |
| 反射层归属 | Charlie | 场景词/设备控制必须 <1s 且可离线 |
| 反射是否记账 | 是 | 在线时 `POST /api/device/events`，feed/proof 可见；离线时本地记，恢复后补传 |
| 人格 | `IDENTITY.md` 为主体，`VOICE.md` 只覆盖语气/称呼/播报长度 | 不对同一件事维护两份人格 |
| 记忆 | dotd 唯一事实源；Charlie 只做只读缓存 | 避免“语音说过的 Web 不记得” |
| 主动推送 | dotd 决定“该不该说”，Charlie 只负责“怎么说” | 两套防骚扰必然互相打架 |
| 危险动作审批 | v1 只允许主人在 Web/手机卡片批准；设备端只说“需要你确认” | 语音里说“同意”不能当授权 |
| v2 设备审批 | 按键 + PIN（4–6 位） | 有屏幕的板子才做 |
| ASR | 默认本地 SenseVoice；百度为显式降级 | 自托管承诺；音频不出门 |
| TTS | 百度/Finna 可配；本地 CosyVoice 可选 | 延迟与音质取舍 |
| 模型路由 | 复用 dotd `light`（快）与 `primary`（难）两轨 | 不新增 track，减少改动 |
| 设备令牌 | 每设备独立、可吊销、只存哈希 | 绝不复用 master token |
| 公网暴露 | 只暴露 Charlie 的 8000/8443；dotd 只回环 | 设备拿不到内核管理面 |
| 数据目录 | `~/.dotd/` 为根；Charlie 写 `~/.dotd/voice/` | 一个备份点 |

---

## 5. 最小数据模型与接口改动

### 5.1 新增（dotd）

```sql
-- 设备注册（owner 创建；token 只存 hash）
CREATE TABLE devices (
  id TEXT PRIMARY KEY,              -- dev_<ulid>
  dot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 迁移：mem_threads.channel 增加 'voice'
-- （SQLite 需表重建，照 060_feishu_channel.sql 的做法）
```

设备与 thread 的绑定**不新增列**：`mem_threads.external_ref = deviceId`，`channel='voice'`。
现有 `openThread` 已支持 `externalRef`（`src/memory/MemoryService.ts:176-194`）。

任务与设备的关联通过 `tasks.thread_id → mem_threads.external_ref` 得到，无需改 tasks 表。
`audit_log` / `exec_calls` / `model_call_log` 的按设备查询走这个 join。

### 5.2 新增路由（dotd）

| 路由 | 鉴权 | 作用 |
|---|---|---|
| `POST /api/devices` | master | 创建设备，返回一次性明文 token |
| `GET /api/devices` | master | 列表（不含 token） |
| `DELETE /api/devices/:id` | master | 吊销 |
| `POST /api/device/turn` | device token | 提交一轮语音文本；固定 `channel='voice'`、`external_ref=deviceId`、`priority=1` |
| `GET /api/device/tasks/:id` | device token | 只能读自己设备 thread 下的任务 |
| `GET /api/device/stream?task=` | device token | 只推该任务的 `chat.delta/final/approval` |
| `POST /api/device/events` | device token | 反射层记账（场景执行、本地拒绝、离线补传） |
| `POST /api/device/approvals/:id` | device token | v1 一律 403，明确“请到手机/Web 批准” |

`authenticate()` 增加第三种身份：`{kind:'device', deviceId, dotId}`。设备 token 不能访问任何
`/api/*` 管理路由，只能走 `/api/device/*`。

### 5.3 流式

- Charlie 提交后拿 `taskId`，订阅 `/api/device/stream?task=`；
- dotd 把 `chat.delta` 按 taskId 过滤（在 SSE 层加 `task` 参数），Charlie 按句切分送 TTS；
- 终态 `chat.final` 作为兜底，防丢增量；
- 语音端不新增 WebSocket 到 dotd：WS 只存在于 ESP32↔Charlie。

---

## 6. 分阶段路线

### 阶段 0（已完成，2026-10-23）

- `voice/` 入库、来源与许可证记录；
- `dotd_bridge.py`（5 测试）；
- Charlie MCP 工具被 dotd 调用（1 测试）；
- `voice:check` / `voice:test`；全量 1938/1938。

**出口标准**：已满足。

### 阶段 1：一套壳（1 周）

目标：用户**只启动 Charlie**，不再感知 dotd 是另一个系统。

交付：

1. **进程托管**：Charlie 启动时拉起 dotd（开发态 `node --import tsx src/daemon.ts`，生产态编译产物），
   退出时一并停；崩溃按指数退避重启（1s/2s/5s/10s，上限 5 次后停在“内核离线”状态）。
2. **一个健康检查**：Charlie 的 `/health` 聚合 dotd 的 `/api/health`，返回
   `{voice:'ok', kernel:'ok|offline', version, devices}`；任一降级都要显式。
3. **一个配置根**：`~/.charlie/`（兼容读取 `~/.dotd/`）；dotd 通过 `DOTD_HOME` 指向同一个根。
4. **一个数据根**：Charlie 写 `~/.charlie/voice/`，dotd 写库/记忆；备份只备一个目录。
5. **一个日志流**：dotd 的 stdout/stderr 由 Charlie 收集，带 `[dotd]` 前缀写同一份日志。
6. **一个 Web 入口**：Charlie 的 8000 端口反向代理 dotd 的 `/console`、`/api/feed`、`/api/approvals`、
   `/api/tasks/*/proof`；用户只记一个地址。
7. **版本握手**：Charlie 版本声明兼容的 dotd API 主版本；不匹配**拒绝启动**并说明原因。

验收：

- 只运行 Charlie，`/health` 同时显示 voice 与 kernel；
- 杀掉 dotd 子进程 → 5 秒内自动拉起，日志有一条 `[dotd] restarted`；
- 改一个配置项（如模型 key），两个进程都从同一个根读到；
- 版本不匹配时启动失败，错误信息给出两边版本与升级命令；
- 用户无需知道 7788 端口存在。

**止损线**：进程托管在目标平台（Windows / Linux）任一平台无法稳定重启，就先只做 Docker Compose
托管，不在 Windows 原生上硬撑。

**阶段 1 完成报告（2026-10-23）**

| 验收项 | 证据 | 结果 |
|---|---|---|
| 托管 + 退避重启 | `voice/integration/test_one_system.py`（假 kernel 退避 1/2/5/10/30） | 4/4 通过；重启成功后另有一行 `[one-system] dotd restarted（累计 N 次）` |
| 真 dotd 托管 | 临时 home + 7799 起真 daemon | `/health` → `kernel=ok`、`apiVersion=1` |
| `/health` 聚合 | `tests/one-system.test.ts` + 真 Charlie `--no-kernel` | `voice=ok`、`kernel=offline/ok`，`ok=false` 时 503 |
| 一个配置/数据根 | `python -m voice.integration.one_system --check` | `home=~/.dotd`（旧配置沿用）、`voiceData=<home>/voice` |
| 一个日志流 | 真 daemon 输出 | 每行 `[dotd] …` |
| 一个 Web 入口 | `/console/` + `/console/api/health` | 200；服务端注入 token；query token 被剥掉 |
| 版本握手 | 假 kernel `apiVersion=99` | `incompatible`，拒绝 ready；错误里给出两边版本与升级命令 |

未验：Windows 便携包内嵌 Node；Charlie 全量语音依赖（ffmpeg/密钥）未装。

### 阶段 2 完成报告（2026-10-23）

| 交付 | 证据 | 结果 |
|---|---|---|
| devices 表 + 一次性令牌 | `db/migrations/200_voice_channel.sql`、`POST /api/devices` | 明文只回一次；库里 `sha256`；吊销即 401 |
| voice 通道 | 同上（重建 `mem_threads.channel`） | 迁移 0→200 实测；`channel='voice'`、`external_ref=deviceId` |
| `/api/device/turn` | `src/surfaces/http.ts` | 202；同设备复用一条 voice thread（partial UNIQUE） |
| `/api/device/stream?task=` | `src/surfaces/sse.ts` 的 taskId 过滤 | 并发任务互不串台（`tests/surfaces-sse.test.ts`） |
| Charlie 非快路径 → bridge | `voice/integration/cortex_router.py` | 反射本地、皮层 dotd；12 项单测 |
| 快路径记账 / 离线兜底 | 同上 + `POST /api/device/events` | 离线写 JSONL spool，恢复后补传；回话明确「大脑不在线」 |
| 假设备脚本 | `scripts/fake-device.mjs` | 文本进→任务→正文出；打印首条增量/端到端延迟 |
| `dotd prove` 设备维度 | `src/surfaces/proof.ts` | `device{id,name,status,channel}`；非语音任务不加键（老 hash 不变） |
| feed provenance | `src/surfaces/feed.ts` | `kind='voice'`、`source='device'`、`ref='voice:<id>'` |
| 设备不能批准 | `POST /api/device/approvals/:id` | 恒 403 + `device_approval_denied` 审计 |

验收对照（2026-10-23 真模型补齐后）：

| 验收项 | 结果 |
|---|---|
| 假设备说一句 → 任务 done | ✅（stub 模型端到端 786ms；真模型 5/5） |
| 首条增量 < 2.5s（P50） | ⚠️ **链路达标、端到端未稳定达标**：确定性上游（TTFT 300ms）下 firstDelta P50 **771ms**、dotd 侧开销 P50 **471ms**；真网关（hy3 关思考）P50 2574 / 3172 / 4693ms 三次跑，波动来自网关 TTFT（1.3–17s），不是链路。见 §1.2 两把尺子 |
| 凭证 ≥3 步，能回答设备/会话/谁批准 | ✅ **11 步 / 6 个工具步**（fs.list → fs.write → fs.stat），0 失败；`device{id,name,status,channel}`；`docs/acceptance/voice-real-model/PROOF.md` |
| 场景词「晚安」不经过 dotd 也能执行 | ✅ 单测（反射命中时 bridge 0 调用） |
| 在线 feed 出现带 provenance 的记录 | ✅ 真 daemon 冒烟 11/11 |
| 杀 dotd → 明说「大脑不在线」 | ✅ 单测（`offline` / `offline-scene` 两种话术） |
| 设备令牌访问 `/api/queue` | ✅ **403** `device_scope`（有身份、无权限） |

止损线判断（2026-10-23，重跑后）：**链路层面通过**——扣掉上游固定 300ms，dotd 侧 P50 471ms / P95 1113ms，
远低于 "P95 ≤ 4s"。**端到端层面不在本机共享网关上达标**：同一任务/gateway P50 在 2.57–4.69s 摆动，
冷启 17s，属模型侧；上线前必须固定低延迟模型端点。本轮新增的 `models.yml` 端点级
`extra_body: { chat_template_kwargs: { enable_thinking: false } }` 把 hy3 首个 content 分片从 3.3s+ 压到
1.7–2.6s（实测），是给语音用的旋钮。凭证侧本轮同时修掉一个**假警报**：Runner 会把 `fs.list` 的
`path:"."` 补成 `/dot/home/.`，旧凭证把这种"执行面规范化"报成「哈希不一致」，现在显示「一致（路径规范化）」。

复现命令：

```
node scripts/.pipe-latency.mjs                      # 确定性链路（本地上游 TTFT=300ms）
DOTD_SMOKE_MODEL=hy3 node scripts/.real-model-run.mjs   # 真网关 5 轮 + 工具凭证
node scripts/fake-device.mjs --base http://127.0.0.1:7788 --master $DOTD_MASTER_TOKEN --runs 5
```

产物：`docs/acceptance/voice-pipe-latency/`、`docs/acceptance/voice-real-model/`（`run.json`、`PROOF.md`、`proof.json`、`daemon.log`）。

一处模型侧瑕疵（不是 dotd 的记账问题）：hy3 有时把 `<tool_calls:…>` 标记漏进**最终回复正文**，
于是凭证的「摘要」行会看到这段残渣；工具调用本身走的是正规 `tool_calls` 字段，执行链路没受影响。
换成不吃这套标记的模型、或在语音 TTS 前做一次清洗即可。

### 阶段 2：一台设备，一件事，一份凭证（2 周）

交付：

1. `devices` 表 + 设备令牌 + `/api/device/*` 最小面；
2. `voice` 通道迁移；
3. `/api/device/turn` 固定 voice thread；`/api/device/stream` 按 task 过滤；
4. Charlie：非快路径意图改走 bridge；快路径执行后记账；
5. 假设备脚本（WebSocket 客户端）跑通“文本进 → 任务 → 文本/音频出”；
6. `dotd prove` 能看到这条语音任务。

验收（缺一不算过）：

- 假设备说一句任务话术 → 任务 `done`，首条增量 < 2.5s（P50），端到端 < 5s（P50）；
- 凭证里至少 3 步，且能回答“哪个设备、哪次会话、谁批准的”；
- 场景词“晚安”不经过 dotd 也能执行；在线时 feed 出现一条带 provenance 的记录；
- 杀掉 dotd：Charlie 明确说“大脑不在线，只执行了本地场景”，**不能静默成功**；
- 设备令牌访问 `/api/queue` 返回 403。

**止损线**：P95 首条增量 > 4s，或凭证缺设备维度 → 不进入阶段 3，先修延迟/数据模型。

### 阶段 3 完成报告（2026-10-23 交付，2026-10-24 真机验收）

| 交付 | 证据 | 结果 |
|---|---|---|
| 设备列表 / 最后在线 | `GET /api/devices`（含今日用量） | ✅ |
| 令牌轮换 | `POST /api/devices/:id/rotate`、`dotd device rotate` | ✅ 旧令牌立即 401 |
| 每设备并发闸 | `/api/device/turn` | ✅ 同设备第二个任务 `409 device_busy`（真机复验） |
| 每日配额 | `db/migrations/210_device_quota.sql` | ✅ 200 次 / 200000 字符（0=不限），`429 device_quota` |
| 一个 dotId 多设备共享记忆、会话隔离 | `voice` thread 按 `external_ref` 隔离 + `MEMORY.md` 注入 | ✅ **真机 16/16**（见下） |
| SSE 按设备过滤 + 断线重连 + 增量去重 | `SseDeviceCursorStore`（`surf_kv` 的 `device_sse:<id>`）+ `/api/device/stream` | ✅ 重连不带头从设备游标续读、已下发的帧不重发、超窗 resync；任务级流不发全局审批快照（4 单测 + 1 HTTP 用例） |
| 吊销 1 秒内全部 `/api/device/*` 401 | `DELETE /api/devices/:id` 后逐个打 5 条路由 | ✅ 单测覆盖 turn/stream/events/tasks/approvals |
| 配额耗尽明确回话 | `cortex_router._quota()` + `DeviceQuotaError` | ✅ 说「今天这台设备的额度用完了…」，不再说「大脑不在线」；`device_busy` 有独立话术（3 Python 用例） |
| compose 一键起 | `docker/compose.voice.yml` + `docker/Dockerfile.voice` + `docker/entrypoint.sh` | ✅ 冷构建 238 s / 1.59 GB / 容器 healthy；空卷首启自动生成配置并注册设备（`docs/acceptance/voice-docker/`） |

**3 台模拟设备并发 + 跨设备共享记忆（`node scripts/.multi-device.mjs`，真模型 hy3，16/16 通过）**：

| 断言 | 结果 |
|---|---|
| 3 台设备各 `npm run voice:device -- --runs 3`，9 轮全部 done | ✅ 3/3 · 3/3 · 3/3 |
| 9 个 taskId 唯一 | ✅ |
| 3 台设备同时有在途任务（区间重叠，不是排队假装并发） | ✅ accepted 3/3 · 重叠窗口 30.5s |
| 每台设备恰好一条 voice 会话（3 轮复用），设备间不同 | ✅ 3 条 |
| 设备 A 读设备 B 的任务 → 404；设备令牌打 `/api/queue` → 403 | ✅ |
| 同设备在途再投 → `409 device_busy` | ✅ |
| A 说「我对花生过敏」→ **真的 fs.write 落盘**（不是口头答应） | ✅ `fs.write×3` |
| B 的任务上下文里注入了含「花生」的 `MEMORY.md` | ✅ 抓包证据（`prompts.jsonl`） |
| B / C 两台设备都答出「你对花生过敏」 | ✅ |
| A/B 会话不同；A 的用户原话没有跨会话泄漏 | ✅ 泄漏 0 条 |

复现：

```
DOTD_SMOKE_TRACE=1 node scripts/.multi-device.mjs
# 产物：docs/acceptance/voice-multi-device/{run.json, prompts.jsonl, daemon.log}
```

`DOTD_SMOKE_TRACE=1` 会在本机起一个只记录、不改写的代理（`127.0.0.1:7811`），
把请求原样转给真网关，用来回答"B 没答出来，是没注入还是模型看到了却装作没有"。

**验收时发现的两条模型侧事实（不是链路问题，写进已知限制）**：

1. hy3（关思考）**会只口头答应"已记住"而不调用 `fs.write`**。第一次跑就撞上：A 的会话里
   一个工具步都没有，B 自然查不到。验收脚本因此把"必须先调 `fs.write`"写进指令，并校验
   journal 里确有成功的 `fs.write` 才继续；这也给产品侧提了要求——语音说"记住…"时，
   提示词要明确要求落盘，不能只靠模型自觉。
2. 换措辞问（"我对什么东西过敏？"）时，模型自己生成的检索词会变差（`过敏 allergic`），
   `memory.search` 只命中 1 条就下结论"没有记录"。同题对照则稳定命中。
   鲁棒性属模型能力，不改链路。

未做/未验：真 ESP32 多设备（无硬件）；设备级 SSE 只在单测/HTTP 用例里验过，没在真设备断网重连里跑。

镜像已验证（2026-10-23，WSL2 Ubuntu-24.04 / Docker 29.1.3）：冷构建 238 s、镜像 1.59 GB、
空卷首启自动生成 `/data/config.yml` 并注册设备、容器 healthy、设备面一轮带凭证。
证据见 `docs/acceptance/voice-docker/`。

### 阶段 4 完成报告（2026-10-23 交付，2026-10-24 补齐导入与许可说明）

| 交付 | 证据 | 结果 |
|---|---|---|
| 一次体检 | `npm run onboard`（`scripts/onboard.mjs`） | ✅ 必需项 3 个、可选项逐条给命令 |
| 免费模型 key 指路 | 同上（GLM 永久免费额度） | ✅ 文本向导，不写密钥 |
| 本地 ASR 默认 | Charlie 上游默认（SenseVoice，缺失降级百度） | ✅ 沿用上游，不另造 |
| 一页 quickstart | `docs/voice-quickstart.md` | ✅ 云主机 / 盒子 / ESP32 / 排障 / 延迟旋钮 |
| 旧记忆导入 | `dotd import` + `POST /api/memory/import` | ✅ 交接提示词 / 16 KB / 只写 `notes/YYYY-MM-DD-import-<slug>.md` |
| 上游 LICENSE | `voice/NOTICE`（归属与许可状态） | ⚠️ **仍缺上游 LICENSE**：可自用，不得对外发布镜像 |

旧记忆导入的验收（`tests/memory-import.test.ts` 8 例 + 真 daemon 冒烟）：

| 断言 | 结果 |
|---|---|
| `dotd import --print-prompt` 打出交接提示词 | ✅（含"跳过敏感内容 / 标 `[推断]` / 2000 字以内"） |
| `POST /api/memory/import` 正常导入 | ✅ 201 · `notes/2026-10-24-import-chatgpt.md` |
| 超过 16 KB | ✅ 413 `TOO_LARGE` |
| 来源非法（中文）/ 空正文 | ✅ 400 `BAD_SOURCE` / `schema` |
| 同一天同来源重复导入 | ✅ 同一路径（幂等，不堆 -2/-3） |
| 只写 notes/，不碰 MEMORY.md | ✅ `writeNote` 拒绝 `MEMORY.md`、`manuals/`、非法文件名 |
| 导入后进 `mem_files_index`（可被检索/整理） | ✅ |

“干净云主机 30 分钟”**只测了其中最长的一段，不是整段**：2026-10-23 在 WSL2 + Docker 29.1.3 上
冷构建 238 s、空卷首启到 healthy ≈ 40 s，合计约 4.5 分钟；**不包含**装 Docker、拉代码、
配模型 key、安全组/备案。没有从「机器上还没有 docker」开始计时的环境，所以这句话仍标
**部分未验**，不冒充 30 分钟已达成。`npm run onboard` 只覆盖“装好之后能不能跑”。

“新设备扫码配网到第一次对话 < 5 分钟”**未验**：本机没有 ESP32/麦克风，
quickstart 的配网步骤只到「照着做」这一层，没有计时证据。

### 阶段 3：一个主人，多台设备（2–3 周）

交付：

1. 设备列表/吊销/最后在线；每设备令牌轮换；
2. 一个 `dotId` 下多设备共享长期记忆，会话按设备隔离；
3. SSE 按设备过滤 + 断线重连 + 增量去重；
4. 每设备并发闸（同一设备同时只允许 1 个语音任务）与每日配额（ASR/TTS 分钟、token）；
5. `docker compose` 一键起 Charlie + dotd（cloud/box 两套 env 模板）。

验收：

- 3 台模拟设备并发说话：互不串台，任务归属正确；
- 同一主人在 A 设备说“记住我对花生过敏”，B 设备问“我过敏什么”能答出；
- 设备 A 吊销后 1 秒内所有 `/api/device/*` 返回 401；
- 配额耗尽时明确回复“今天额度用完了”，不静默降级。

### 阶段 4：陌生人第一次（3–4 周）

交付：

1. `npm run onboard`：Node/Python/Docker/ffmpeg/模型 key 一次体检；
2. 免费模型 key 向导（GLM 一类永久免费额度）；
3. 本地 ASR 默认、云 ASR 显式开启；
4. 上游 LICENSE 补齐或书面许可；
5. Charlie 旧记忆导入 dotd（facts/events → notes，保留来源标记）；
6. 一页 quickstart：云主机 30 分钟、ESP32 配网 5 分钟。

验收：

- 干净云主机：30 分钟内完成安装 → 设备上线 → 说一句话 → 拿到带凭证的结果；
- 断网：本地场景仍可用，且恢复后补传记账；
- 新设备：扫码配网到第一次对话 < 5 分钟。

### 阶段 5 完成报告（2026-10-24，原「还没合的三件事」）

| 项 | 实现 | 证据 |
|---|---|---|
| 单一记忆源 | 迁移 212（`device_prefs`）+ `src/surfaces/voice-memory.ts` + `voice/integration/dotd_memory.py` | `tests/surfaces-voice-memory.test.ts` 5/5、`voice/integration/test_memory_push.py` 4 项 |
| 单一主动推送决策 | `POST /api/device/proactive/decide` + `voice/integration/push_gate.py` + `device_push_log` | 同上 5+4 项；拒绝不推进节流账本 |
| 一个入口 | `scripts/setup-all.mjs`：`npm run setup:all` / `npm run up` / `npm run setup:all:check` | 本机实跑：Node + `.venv` + 依赖 + 体检全过 |
| 许可证 | `voice/LICENSE`（MIT）+ 根 `LICENSE`（Apache-2.0）+ `THIRD_PARTY.md` | `voice/NOTICE` 记归属与双许可 |
| 真模型延迟 | `node scripts/fake-device.mjs --runs 5` | 首条 P50 4.80s / 端到端 P50 10.98s / P95 23.46s —— **未达 §7.1 的 2.5s**，瓶颈是网关 TTFT |
| 音频链路 | 合成 PCM 走真 WS；另加真实 TTS/扬声器/麦克风/Opus/SenseVoice 闭环 | `test_audio_chain.py` 2/2；`test_real_audio.py` 2/2（识别原文一致，见 `docs/acceptance/voice-real-audio/`）；ESP32 硬件仍未验 |

新增的失败语义（写进实现，不是口头约定）：

- dotd 不可达时主动推送默认 **fail-closed**（`CHARLIE_PUSH_GATE_FAIL=open` 可改）；
- 被拒绝的推送**不推进节流状态**，避免安静时段误伤下一句；
- 反射轮次补写记忆是幂等的（`dedupeKey`），dotd 已处理的轮次不再重复写。

---

## 7. 延迟 / 成本 / 容量预算

### 7.1 延迟目标（P50）

| 路径 | 目标 | 预算拆解 |
|---|---|---|
| 反射（场景词/开关空调） | **< 1.2s** | VAD 0.36–0.48s + ASR 0.03–0.33s + 本地执行 0.1s + TTS 0.12s |
| 简单问答（light 轨） | **< 2.5s** | 上述 + 模型首 token 0.3–0.8s + dotd 调度 < 0.2s |
| 复杂任务（primary 轨） | **首条 < 3s，完成不设上限** | 规划 + 工具；用 `chat.delta` 先出话 |

dotd 调度开销必须实测：在 `POST /api/device/turn` 与首次 `chat.delta` 打时间戳。

### 7.2 成本

- 本地 ASR/TTS：0 元/分钟，CPU 占用为主；
- 云 ASR/TTS：按供应商计价，必须做每设备分钟配额；
- 模型：GLM/DeepSeek flash 优先；Ollama 作为断网兜底；
- 云主机：2C4G 可跑 Charlie + dotd；要跑 Docker 工具容器建议 4C8G。

### 7.3 容量

- 单设备同一时刻 1 个语音任务；全局 `DOTD_MAX_RUNNING` 先定 3，并修掉注释/代码的口径不一致；
- 语音任务 `priority=1`，批处理 `priority=7`，保证说话不被批量任务饿死；
- 每设备每日配额：ASR/TTS 分钟、token、危险动作次数。

---

## 8. 风险与止损

| 风险 | 概率 | 影响 | 处置 |
|---|---|---|---|
| 云端往返把首句拖到 3s+ | 中 | 高 | 反射层必须本地；给 dotd 调度打点；阶段 1 止损线 |
| 两套记忆继续漂移 | 高 | 高 | dotd 唯一事实源；阶段 2 前不做“智能记忆” |
| 两套推送同时打扰 | 高 | 中 | 关掉 Charlie 决策引擎的推送出口，只留传感器 |
| 设备令牌泄露 | 中 | 高 | 只存 hash、可吊销、每设备独立、只走 `/api/device/*` |
| 语音“同意”被当授权 | 中 | 高 | v1 设备端不允许批准；危险动作只认 Web/手机 |
| Docker 在小盒子跑不动 | 中 | 中 | box 档位允许无 Docker；工具降级为宿主 MCP/只读 |
| 上游许可证缺失 | 高 | 高 | 发布前必须补 LICENSE；否则只自用 |
| 上游代码漂移 | 中 | 中 | `voice/` 只 vendor，不改上游文件；集成放 `voice/integration/` |
| 默认设备令牌 `"device"` | 高 | 高 | 合并第一周就改掉；启动时检测到默认值直接拒绝公网监听 |

---

## 9. 明确不做

- 不在 ESP32 上跑 Node/Python/模型；
- 不把 Charlie 重写成 TypeScript，或把 dotd 重写成 Python；
- 不做两套记忆、两套主动推送、两套工具目录；
- 不让设备 token 访问 dotd 管理面；
- 不用语音“确认”替代危险动作审批；
- 不在阶段 2 做多主人/家庭共享。

---

## 10. 立即可执行的前 15 个工作日

| 天 | 交付 | 验收 |
|---|---|---|
| 1–2 | Charlie 托管 dotd：启动/退出/退避重启 + 聚合 `/health` | 只启 Charlie；杀 dotd 后 5s 内拉起 |
| 3 | 一个配置/数据根 + 日志汇总 + 版本握手 | 版本不匹配拒绝启动；日志有 `[dotd]` 前缀 |
| 4 | Charlie 反向代理 dotd 控制台/动态/审批/凭证页 | 只记 8000 一个端口 |
| 5–6 | `devices` 表、token 哈希、`/api/devices` 管理面 | 创建/吊销/401 测试 |
| 7 | `voice` 通道迁移 + `/api/device/turn` | thread `channel='voice'`、`external_ref=deviceId` |
| 8 | SSE 按 task 过滤 + `/api/device/stream` | 两个任务并发，互不串台 |
| 9–10 | Charlie 接入 bridge、快路径记账、离线兜底话术 | 场景词与任务各一条端到端 |
| 11 | 假设备 WS 脚本 + 延迟打点 | P50/P95 数字进文档 |
| 12 | 危险动作：设备端 403 + Web 卡片批准 | 语音说“同意”不能过 |
| 13 | `dotd prove` 设备维度 + feed provenance | 凭证能回答“哪台设备” |
| 14 | 一页 demo + 止损复盘 | 过则进阶段 3，不过则修 |
| 15 | 文档：一套系统的启动/备份/升级 | 新人照文档能起 |

---

## 11. 需要你拍板的三件事

1. **主部署形态**：云主机为主（推荐），还是家里小盒子为主？
   - 影响：公网 WSS、证书、Docker、模型选择。
2. **设备归属**：一台设备一个主人（推荐先做），还是家庭共享一台设备？
   - 影响：`devices.dot_id` 是 1:1 还是多对多。
3. **危险动作审批**：v1 只认手机/Web 卡片（推荐），还是一开始就做按键 + PIN？
   - 影响：阶段 2 的范围与安全测试。

在你拍板前，我按推荐默认值推进**阶段 1（一套壳）**；这三项都可以在阶段 3 前调整，
不影响数据模型的主干。
