# dotd —— 自主 Dot 系统

常驻单进程个人 AI Agent daemon：TypeScript 单进程 + SQLite + 每 Dot 一个 Playwright 容器（`package.json:5`）。

**英文版见 [README.en.md](README.en.md)。** 细节以本文件为准。

---

## 这是什么

dotd 是一个**常驻进程**，不是一个网页应用。它在后台跑着，从四个机器入口收事件（HTTP webhook / JSONL 文件 / 心跳调度 / 飞书）——其中 JSONL 文件入口的路径约定是 `~/dots/inbox/*.jsonl`、默认 `enabled:false`、且轮询循环尚未接线（`config/dotd.yml:61-65`，见「已知限制-低」）——把事件变成任务排队，由一个 Runner 协程跑「问模型 → 调工具 → 再问模型」的主循环，真正干活的是一个 Docker 容器（Playwright + stealth，带每身份持久化的浏览器 profile 卷和 `/dot/home` 文件记忆卷）。

真入口是 daemon 装配层：

```
npm run serve   →   node --import tsx src/daemon.ts        （package.json:15）
npm run dotd    →   node --import tsx src/surfaces/cli.ts  （package.json:14，HTTP 瘦客户端 CLI）
```

`src/daemon.ts:850-856` 装配完之后 `await new Promise<void>(() => {})` 永远挂起——事件循环由 Runner 的 pop 循环（`src/runner/dot.ts:364-372`，空转等 1000ms）、HTTP server 和 scheduler 定时器共同持有。所以它是**常驻**而非按需启动。

### 给谁用

给愿意自己持有全部状态的人：会话历史、任务队列、journal、审批记录、熔断状态、文件记忆，全在一台你自己控制的机器的 `~/.dotd/` 下。设计目标里明确排除了任何商业托管服务，唯一允许的外部依赖是模型 API，且 `base_url` 改一行配置即可热切换（`config/models.yml` 的 `base_url` 字段）。如果你要的是「厂商账号 + 闭源服务换持久化」，这个项目不适合你。

### 和普通 chatbot 的区别

普通 chatbot 是「你问一句它答一句」，无状态、无队列、无权限概念。dotd 的核心单位是**任务**：任务有队列位置、有优先级、有 journal 步骤、有崩溃恢复语义、有审批门。事件可以在没有人在线的时候进来并被执行（心跳、Grafana webhook、飞书消息），执行结果通过出站回路回给原会话。

崩溃安全是**步骤级**而非「工作流步级」：`beginTool` 先把 `started` 行落库（`synchronous=FULL`，落库先于任何外部调用），`endTool` 才落 `succeeded`；已落盘的结果绝不重放，未知副作用绝不自动重执行。

### 和工作流引擎的区别

工作流引擎跑固定的 DAG，边和条件在建图时就定死了。dotd 的任务由**自然语言 goal** 驱动，下一步做什么由模型在运行时决定。事件→任务的匹配是两层：规则层（`config/event-rules.yml`，命中恒 confidence=1.0）优先，模型层（`track:'light'`，严格 JSON 一次解析）兜底；置信度 ≥0.85 直接执行、0.55–0.85 执行并推可撤销通知、<0.55 落 inbox 等主人（`src/control-plane/match.ts` 与 `config/event-rules.yml` 头注的分档表）。

### 术语速查（后文不再解释）

| 术语 | 含义 |
|---|---|
| **轨（track）** | 同一次模型调用走的两条质量档：`primary`（贵/强，交互任务）与 `light`（便宜/快，事件匹配、摘要、precheck 等内部杂活）。由 `config/models.yml` 的 `routing.light_events` 前缀匹配决定走哪条（`:83-92`），其余默认 primary。**你的 `dotd ask` 和飞书消息走 primary 轨。** |
| **tier1–4** | 端点优先级层：tier1 付费/强（hy3）、tier2 本地/免费备胎（OLMoE、Ollama、OpenRouter free）、tier3 策展免费池（`config/free-models.yml`，当前池空）、tier4 侦察候选（运行期发现）。失败单向向前降级，绝不回跳。 |
| **熔断 / half_open** | 按 endpoint×track 计的断路器：closed → open（失败率/连续失败/auth 立即）→ half_open（到期放行限量探活）→ closed（探活成功够数）。状态落库，重启不丢。primary 轨端点 open = 所有交互任务挂起。 |
| **journal 步骤** | 任务执行的动作流水，一步一行落 SQLite：`beginTool` 先落 `started`（synchronous=FULL），`endTool` 才落 `succeeded`。崩溃恢复按步骤对账，已落盘的结果不重放。 |
| **dot / Dot** | 一个持身份的工人单元：一套浏览器 profile 卷 + `/dot/home` 文件记忆卷 + 一个执行容器。阶段一只有 `dot1`；阶段三做多 Dot。 |
| **WRITE-SEAL** | 记忆封写机制：任务结束若该写文件记忆而未写，Runner 会被提醒补写一轮（`src/memory/seal.ts`），防止 agent「干完活不留痕」。 |
| **stub** | 内存假实现：`DOTD_MODEL_TRANSPORT=stub` 回放预置模型响应、`DOTD_FLEET=stub` 仿真容器行为但不起 Docker。门禁全绿是在 stub 下取得的。 |
| **netfuzz** | 常驻在 WSL 里的 libFuzzer 模糊测试负载（~20GB 内存 + 大量 CPU），是内存水位与容器限额设计的假想邻居——不是 dotd 的组件。 |

---

## 当前状态

**阶段一 MVP，但不再只是 stub 演示。** 真实的 HTTP 模型传输、daemon 全链路、流式（含工具调用通道）、长命令心跳、FTS 中文检索、会话摘要，以及七个会丢数据/丢任务的缺陷，
在这一批优化里被真测试证明过（详见 [`docs/optimization-2026-10-17.md`](docs/optimization-2026-10-17.md)）。
**2026-10-18 更新**：**真模型往返已跑通**（tier1 `127.0.0.1:3065` + `deepseek-v4.1-flash`：probe 返回合法 `tool_calls`，daemon 真跑任务 `done` 且 `fs.write succeeded`）。**2026-10-18 再更新**：**真 Docker 容器也跑通了**——`scripts/live-wsl-e2e.sh` 在 WSL 里以 `DOTD_FLEET=docker` 起 daemon，任务 `done`、`fs.write` 在**真容器**里成功、`docker exec` 读回文件内容。**只剩真实飞书的收发往返**没验（长连接已建立）。

> **关于真容器**：早期说"本机无 dockerd"是**错的**——dockerd 在 WSL 里（`29.1.3`），
> `docker ps` 能看到 `dotd-dot-dot1` 容器与 `dotd/exec:1.49.1-0.1.0` 镜像，dotd 以前真跑过。
> 现在跑不动的原因是 **WSL 内存**：`.wslconfig` 限 24GB，而 netfuzz 的 fuzz 集群常驻约 20GB，
> `MemAvailable` 只剩 4GB，连 `wsl.exe -e echo` 都会 `WSL_E_SERVICE_STOPPED`。
> 想验证真容器，先腾出内存，然后跑 `scripts/live-wsl-e2e.sh`（见下）。

### 门禁实测（三轮优化结束时实跑，Node v24.13.0 / npm 11.9.0，原生 Windows）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit -p .` | exit **0**，0 错误（约 9s） |
| 测试套件 | `npm test`（并行 4） | `tests 1399 / pass 1399 / fail 0`，exit **0**（134 suite） |
| 测试套件（串行） | `npm run test:serial` | 同样 `1399/1399`、0 失败（约 5 分钟，排查并行问题时用） |
| 端到端冒烟 | `node scripts/smoke.mjs` | **11/11 通过**，exit **0** |
| 冒烟（真 HTTP 模型链路） | `DOTD_SMOKE_FAKE_UPSTREAM=1 node scripts/smoke.mjs` | **16/16 通过**，exit **0**（daemon → ModelRouter → 真 HttpTransport → 真 TCP → 假上游） |
| 上线前体检 | `npm run doctor` | 11 项检查（含 MCP server 检查），每项给「结论 + 下一步命令」；本机当前 2 项 fail（缺 `WB2API_KEY`、严格占位符未展开） |

> 耗时是同一批改动的直接成果：全量从 **278s（改前，1032 用例）** 降到 **100–180s（1399 用例，随机器负载波动）**，路径是
> 消掉测试里的真实等待（SSE 环形缓冲 O(N²)、每用例重跑迁移、TG 重试 2s×3）、修 cwd 脆弱性、并恢复并行。
> 测试总数是**流动的**，跑之前自己数一遍更稳妥：
> `grep -hcE "^[[:space:]]*(test|it)\(" tests/*.test.ts | awk '{s+=$1} END {print s}'`。

冒烟脚本做了什么：自建临时数据目录 + 临时 `config.yml`，以 stub 模型 / stub fleet 起 daemon 子进程 → `GET /api/status` 200 → `POST /hooks/smoke` 202 → 事件匹配建任务 `tk_ev_1` 并跑到终态 `done` → journal 里有一次 `fs.write succeeded` → IPC 触发优雅退出 exitCode=0 → `shutdown_marker` 落库 → `OUTBOX.md` 留痕（`scripts/smoke.mjs:1-20` 头注）。
`DOTD_SMOKE_FAKE_UPSTREAM=1` 时额外起一个真 `node:http` 假 OpenAI 上游、把 tier1 `base_url` 指过去、
不设 `DOTD_MODEL_TRANSPORT=stub`，于是走**真 HttpTransport**；多出的 5 条断言证明请求真的过 TCP、
`tools` 线格式合法、`Authorization` 按 `api_key_env` 上送、上游回显的工具名被正确还原。

### 测试数字必须说清的一件事

~~上面的 `1004/1004` 是**在 `dotd/` 目录下**跑出来的…三个按 `process.cwd()` 拼仓库内文件路径的测试文件~~ —— **2026-10-17 已修**：那三个文件（`router-config` / `surfaces-channels-web-config` / `surfaces-cli`）已改为用 `import.meta.url` 推导仓库根，现在 `npm test` 在**任意 cwd** 下都绿。

- `tests/router-config.test.ts` — `REAL_MODELS_YML = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'models.yml')`
- `tests/surfaces-channels-web-config.test.ts` — `REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')` → `join(REPO_ROOT, 'config', 'dotd.yml')`
- `tests/surfaces-cli.test.ts` — 同上，`join(REPO_ROOT, 'src', 'surfaces', 'cli.ts')`

实测：从 `dotd/tests/` 目录单独跑这三个文件，改动前是 ENOENT 红，改动后 `22/22`、`32/32`、`28/28` 全绿。以后新增测试若要去仓库根，**一律用 `import.meta.url`**，不要用 `process.cwd()`。


### 哪些是真验证过的

- 类型系统：全量 `tsc --noEmit` 干净。
- 模块行为：1399 个用例，覆盖控制面队列/journal/恢复/事件匹配/调度、模型路由降级与熔断状态机、治理审批八态与工具目录、执行面幂等 ledger 与网络收敛、记忆注入/封写/保留、surfaces HTTP/HMAC/SSE/ingress/飞书入站出站、Runner 主循环、Runner 工具说明书与 system prompt、`dotd doctor`。
- 容器内协议一致性：`tests/agent-runtime-protocol.test.ts` 双向断言 `agent-runtime/protocol.ts`（容器侧权威）与 `src/exec/protocol.ts`（宿主侧）逐字同形——40 个用例，含 11 名工具词表逐个比对、`args_hash`/`identity_hash` 同值、fs 错误码名同码。
- **真实 HTTP 模型传输**（2026-10-17 新增）：`tests/router-http-transport.test.ts` 34 条，用真 `node:http` 假上游跑真 `HttpTransport`——非流式/SSE 流式解析、auth/rate_limit/quota/server_error 分类、**三档超时各自生效**、空壳判据、脏 JSON、断流、以及真 ModelRouter 接真 transport 的集成路由。
- **daemon 全链路（含真 HTTP 模型）**：`DOTD_SMOKE_FAKE_UPSTREAM=1 node scripts/smoke.mjs` 16/16，daemon 真的通过 TCP 打到上游并跑出任务终态。
- **流式与工具调用通道**（第二轮）：`tests/runner-stream.test.ts` 11 条 + `tests/shared-tool-stream.test.ts` 10 条。最关键的一条是「流式回合里模型返回 tool_calls → 工具确实被执行、任务不提前 done」——因为流式通道原本**没有工具调用通道**，直接切流式会造成"done 但工具从未执行"的静默假完成。
- **长命令不被误杀**（第二轮）：`tests/control-plane-watchdog-liveness.test.ts` 10 条 + 端到端 2 条，证明"工具在途 200s 而心跳持续 → 看门狗不回收"，以及"真卡死仍会在 180s 被回收"。
- **记忆闭环**（第二轮）：`tests/memory-fts.test.ts` 37 条（含中文 bigram 检索、bm25 排序、增删改同步、FTS 不可用降级留痕）、`tests/memory-context-summary.test.ts` 10 条、`tests/memory-seal-redo.test.ts` 12 条（含"补写轮发生在 finish 之前"）。
- 冒烟：daemon 真起真停，事件到任务到终态，journal 有真工具步。

### 哪些是 stub，别当成已验证

| 项 | 状态 |
|---|---|
| 模型调用（真实模型） | **2026-10-18 已跑通。** `node --import tsx scripts/probe-live-model.mjs` 对 tier1（`127.0.0.1:3065`，`deepseek-v4.1-flash`）真往返成功并返回合法 `tool_calls`；daemon 真跑一个任务也 `done` 且 `fs.write succeeded`。**注意该网关上模型能力不同**：`hy3` 带 tools 时只回 `stop`、不返回 tool_calls，所以 primary 轨必须用实测能调工具的模型。原始说明保留： 默认测试与冒烟仍用 `DOTD_MODEL_TRANSPORT=stub`；真 HTTP 代码路径已被 `tests/router-http-transport.test.ts` 与假上游冒烟证明，但**没有任何一次真实模型往返**——本机 `127.0.0.1:7863` 端口通、`GET /v1/models` 返回 **401**，环境里没有 `WB2API_KEY`。`node scripts/probe-live-model.mjs` 在有 key 时随时可跑，`npm run doctor` 会把这条判成 fail。 |
| Docker 执行面 | **全部 stub。** `DOTD_FLEET=stub`（`scripts/smoke.mjs`），`tests/helpers.ts` 的 `makeStubFleet()`。stub 运行时的 `browser.*` 只做结构仿真不起 chromium，`shell.run` 返回固定假 stdout（`src/exec/stub-runtime.ts`）。**真实容器从未 boot 过**（本机无 dockerd）。 |
| 真实飞书链路 | **未验证。** 仓库无 appId/appSecret。WS 长连接拨通与出站 `sendText` 真实往返都没测（审批卡片的推送逻辑只在 fake gateway 上验证过）。 |
| Web UI 完整构建 | **未跑** `npm run build:web`。仓库内 `web-ui/dist/` 是既有产物，冒烟里 `GET /` 与静态资源均 200。 |
| CLI 对运行中 daemon | 功能子命令的清单与选项来自读 `src/surfaces/cli.ts`，没有逐个对活 daemon 端到端调用过。 |

一句话：**门禁全绿证明的是"逻辑正确 + 真实 HTTP 线格式正确"，不证明"真模型 + 真容器能干活"。**
那需要一份模型凭据和一台有 docker 的 Linux/WSL 机器，缺的是环境，不是代码。

---

## 前置条件

### Node

`>=24.0.0` 是硬要求（`package.json:7-9`；容器内运行时同样要求，`agent-runtime/package.json:7-9`）。本机实测 `v24.13.0`，npm `11.9.0`。

必须是 Node 24 的三个原因（`CONVENTIONS.md:17-21,32,71-72`）：① 用内置 `node:sqlite` 的 `DatabaseSync`，不装 better-sqlite3；② Node 24 原生 ESM 不做 `.js`→`.ts` 映射，所有 import 必须写 `.ts` 扩展名；③ tsx 是必需的而非可选加速器。

### 原生 Windows 与 WSL 的分工（这里有一处未解决的矛盾）

- `CONVENTIONS.md:12` 写：运行环境 = 本机原生 Windows Node 24，**不在 WSL**；WSL2 只承载 Docker daemon 与 Playwright 容器。
- 但代码实际约束偏向 WSL：`src/exec/types.ts:154` 硬编码 `dockerSocketPath: '/var/run/docker.sock'`（Unix socket，Windows 原生 node 到不了），`src/daemon.ts:587-589` 注释原文「真 fleet 要求 daemon 跑在 WSL 里」。

**结论**：stub 模式原生 Windows 随便跑；要真容器，daemon 必须在 WSL 里。本机 Windows 无 dockerd。

### Docker 与 Playwright 镜像

- 基座：`mcr.microsoft.com/playwright:v1.49.1-noble`（`exec-image/Dockerfile:6-7`）。WSL 里可先 `bash scripts/wsl-pull-image.sh` 预拉。
- 构建产物 tag：`dotd/exec:1.49.1-0.1.0`（`src/exec/protocol.ts:483` `imageTag()` + `src/exec/types.ts:155-156` 默认值）。构建上下文由宿主 daemon 在**内存**里打 tar.gz，只含 `exec-image/Dockerfile` 与 `agent-runtime/**`，不落盘（`src/exec/fleet.ts` `buildContextTar`）；boot 时镜像缺失即自动构建。
- 容器网络名 `dotd`、bridge、`enable_icc=false`（`src/exec/types.ts:157`）；容器内 agent-runtime 监听 `0.0.0.0:9223`，宿主经 `http://<容器IP>:9223` + Bearer token 调用。
- 资源上限：内存+swap 1536MB、2 核、`PidsLimit:512`、`ReadonlyRootfs:true`、`CapDrop:['ALL']` + `CapAdd:['SETUID','SETGID']`、`no-new-privileges:true`、`OomScoreAdj:700`（`src/exec/protocol.ts:492-509`）。
- WSL 侧的仓库准备脚本链（都存在）：`scripts/wsl-pull-image.sh` → `scripts/wsl-install-node24.sh` → `scripts/wsl-fleet-prep.sh`（rsync 到 `~/dotd` 原生 fs + `npm install`）→ `scripts/wsl-build-image.mts` → `scripts/wsl-fleet-boot.mts`。

### 模型

读 `config/models.yml`，四层端点：

| 层 | 端点 | base_url | 模型 | key |
|---|---|---|---|---|
| tier1（primary） | `openrouter-main` | `http://127.0.0.1:7863/v1` | `hy3` | `WB2API_KEY` |
| tier2（light） | `colibri-olmoe` | `http://127.0.0.1:8001/v1` | `olmoe-colibri` | 免 key |
| tier2 | `ollama` | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 免 key，`enabled:false` |
| tier2 | `openrouter-fallback` | `https://openrouter.ai/api/v1` | `poolside/laguna-s-2.1:free` | `OPENROUTER_API_KEY`，`enabled:false` |
| tier1 | `backup-openai-compatible` | 占位 | — | `BACKUP_API_KEY`，`enabled:false` |
| tier3 | `config/free-models.yml` | — | — | `models: []` **池空** |

`:7863` 是本机一个 workbuddy2api 容器（4 账号池），上游是腾讯 CodeBuddy 账号的 OpenAI 兼容网关（开源 MIT，`github.com/Sliverkiss/workbuddy2api`）。**它的搭建方法、`WB2API_KEY` 的拿法、以及没有这个容器时怎么换端点，都写在 [`docs/tier1-endpoint.md`](docs/tier1-endpoint.md)。** 缺 key 不是启动期错误（`src/router/transport.ts:402-406` `apiKeyFor()` 未设即不发 auth 头），但运行期请求会失败并计入熔断窗口——而 tier1 是唯一能承载 primary 轨的端点，所以这条线一断所有交互任务（`dotd ask`、飞书消息）全部挂起。想临时换端点：改 `config/models.yml` 里 tier1 的 `base_url` / `api_key_env` / `models` 三行即可（热加载生效）。

`config/models.yml` 在没有任何 API key 的环境下也能加载通过——缺 key 只会在运行期暴露。

### 飞书

`config/dotd.yml` 里**已带** `feishu:` 节（2026-10-17 补上；schema 本就有 default，缺节也不拒启动，只会长连接不拨）。`~/.dotd/config.yml` 里该节六字段（`src/surfaces/config.ts:265-272`）：`app_id` / `app_secret` / `owner_chat_id` / `verification_token` / `encrypt_key` / `edit_throttle_ms`。

入站是**出站长连接（WSClient），不是公网 URL**：daemon 在 NAT 后只听 127.0.0.1，没有公网回调地址，所以由应用侧主动拨出去（`src/surfaces/feishu-ws.ts:1-10`）。装配门控：`app_id` 与 `app_secret` 都非空才建真网关，否则落 `NULL_FEISHU_GATEWAY`，`available` 恒 false（`src/daemon.ts:694-697`）。

`owner_chat_id` 未配置 = 连接照建但**一切入站消息 403 拒**（fail-closed，`src/surfaces/feishu-inbound.ts:137-140`），支持逗号分隔多会话。

环境变量名：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` / `FEISHU_OWNER_CHAT_ID`。**但只 export 它们没有任何效果**：surfaces 配置是 `~/.dotd/config.yml` 里手写的 `feishu:` 节，这些名字只有在你手写的 `${FEISHU_*}` 占位符里才被展开（`src/surfaces/config.ts:204-211`）。另外入站是 WS 长连接时**不需要 verification token**（鉴权由 app_id/app_secret 握手完成，`src/surfaces/feishu-ws.ts:1-10`）；verification_token / encrypt_key 是 HTTP webhook（`/hooks/feishu`）路径才用得上的字段。

### 数据目录

唯一库 `~/.dotd/dotd.db`（`db/conn.ts:25-29`；优先级：显式参数 > `DOTD_DB_PATH` > `~/.dotd/dotd.db`）。全进程一条连接，三条 PRAGMA 由启动者设一次：`journal_mode=WAL` + `synchronous=FULL` + `busy_timeout=5000`（`db/conn.ts:40-42`）。

`DOTD_HOME` 改变数据目录根（`src/daemon.ts:113-118`），`OUTBOX.md`、`journal-blobs/`、`exec-tokens/`、`notifications.log` 都在它下面。

### 环境变量与配置文件（第一道坎）

**代码不读 `.env` 文件。** 全仓库 `grep -rn dotenv` 在 `src/scripts/tests/db` 下零命中。仓库里现有一份 `.env.example`（11402 字节：变量清单 + 每项的拿法注释），但它**不会被任何代码加载**，只是给人看的清单；`.gitignore:21` 的 `!.env.example` 是在放行这个真实文件，不是死规则。环境变量必须 export 进 shell。

生成 `~/.dotd/tokens.env` 有两条路，**推荐第一条**（跨平台，原生 Windows 不用 Git Bash）：

```bash
npm run init-config      # scripts/init-config.mjs：生成 config.yml + 补齐 tokens.env 缺键
```

它随机生成 `DOTD_MASTER_TOKEN` / `DOTD_RO_TOKEN` / `HOOK_GRAFANA` 写进 `tokens.env`，再由仓库模板 `config/dotd.yml` 生成填好值的 `~/.dotd/config.yml`；幂等，**已存在的行一律不动**（覆盖 = 抹掉真实 token）。bash 版的 `scripts/setup-dev-env.sh` 等价但只生成前三个键 + `TG_BOT_TOKEN` 占位，**不生成 `FEISHU_*` 与 `WB2API_KEY`**——那两处是非严格展开，未设置即静默变空串，飞书和 tier1 就这样悄悄不工作。

`~/.dotd/config.yml`（surfaces 七节）**必须存在**，否则 daemon 拒启动：`loadSurfacesConfig` 读不到文件直接 `ConfigError`（`src/surfaces/config.ts:359`），`master_token` 展开后为空也 throw（`:363`，fail-closed）。三个占位符 `${DOTD_MASTER_TOKEN}` / `${DOTD_RO_TOKEN}` / `${HOOK_GRAFANA}` 是硬性必填；`TG_BOT_TOKEN` 与全部 `FEISHU_*` 是 `strict:false` 可缺省。

> **陷阱**：仓库里的 `config/dotd.yml` 不是给 surfaces 用的——全仓库没有任何代码加载它（只有注释引用）。真正被读的是 `~/.dotd/config.yml`，而且只读其中的 `surfaces:` 一节（`src/surfaces/config.ts:354`）；`data_dir` / `wslconfig_note` / `db` 那些键在本文件里只是设计注记，加载器一律不碰，真实覆盖走环境变量（`DOTD_HOME` / `DOTD_DB_PATH`）。`cp config/dotd.yml ~/.dotd/config.yml` 能起（`scripts/dev-run.sh:16` 就是这么干的，前提是三个 `${VAR}` 已在环境里），但改仓库里那个文件毫无效果。另外 `config/dotd.yml` 的 `expected_user_version` 是死值（无代码读取），daemon 实际按 `src/daemon.ts:413` 的 `expectedVersion: 70` 迁移（8 个迁移包）——模板里这个键已按 70 改正并注明。

---

## 快速开始

### 三条命令装完：`npm run setup`

```bash
node --version          # ① 唯一必须人做的前置：Node ≥ 24
npm run setup           # ② 检测 + 自动做能做的 + 最后跑 doctor（幂等，可反复跑）
npm run serve           # ③ 起来（stub 模型 + stub fleet：零网络、不起容器）
```

`setup` 做的事：检查 Node → 装依赖（`npm install`）→ 建 `~/.dotd` → 调 `init-config`
生成 `config.yml`/`tokens.env`（**已有内容一律不覆盖**）→ 探测 WSL/docker/镜像/relay →
**自动跑一遍 `doctor`** 并把结论打出来。已满足的步骤标 `⏭️ 跳过` 并说明原因；
需要你动手的标 `👉` 并给出下一条命令。跑两次结果一致（实测 `config.yml`/`tokens.env` 的 SHA256 与 mtime 均不变）。

它**不会**替你做的事（都只报告命令）：装 Node、`docker pull` 2GB 基座镜像、
覆盖已有 token、改你的 `config.yml`。用 `--fleet=docker` 声明"要真容器"，用 `--check` 只体检不动作。

> **为什么只要 3 条**（必答题①的结论）：原 12 步里真正必须人做的只有**装 Node、给模型 key、声明要哪种 fleet**。
> 其余 9 步都可检测/幂等：`npm install`、`init-config`、WSL 侧准备、镜像构建
> （`src/exec/image.ts:ensureImage()` 在 boot 时缺镜像自动构建，**根本不需要单独一步**）、
> relay 转发（只有 WSL 部署需要）。详见下面「安装流程：12 步 → 3 步」。

daemon 起来后另开一个 shell，你就能看到它"自己干活"：

```bash
source ~/.dotd/tokens.env
npm run dotd -- ask "帮我看看今天有什么事"   # 发起主人对话，任务进队
npm run dotd -- status                     # 队列 + 熔断 + 待批审批总览
npm run dotd -- task tk_ev_1               # 任务 + journal 步骤
npm run dotd -- watch                      # 实时事件流
```

浏览器开 `http://127.0.0.1:7788/`，登录页输 master token，六个视图（Chat / Queue / Approvals / Events / Models / Logs）。

下面三张是**同一台机器上真跑着的 daemon** 截的（不是设计稿、不是 mock 数据）。队列那栏只有状态卡片：历史任务属于主人隐私，没有截进去。

| 聊天（Chat） | 队列（Queue） | 模型（Models） |
| --- | --- | --- |
| ![聊天视图：侧边导航 + SSE 已连接 + 输入框](docs/img/console-chat.png) | ![队列视图：排队/在跑/待批/暂停四栏状态卡](docs/img/console-queue.png) | ![模型视图：5 个端点、tier、primary/light 熔断状态与排序结果](docs/img/console-models.png) |

模型那张是信息量最大的：`GET /api/models/rank` 的返回直接画成了表——每个端点的 tier、是否参与准入、primary 与 light 两条 track 各自的熔断状态（`closed` = 正常）、下次探测时间；下面「排序」是 `pickCandidates` 按健康度重排后的真实结果。**端点名字和地址来自本地 `config/dotd.yml`，换你自己的配置就会换一批。**

**stub 模式下任务会跑完并留下 journal 步骤**（冒烟脚本断言了 `fs.write succeeded`），但模型回答和容器执行都是假的。要真模型、真容器、真飞书回复，往下看 §前置条件 与下面「6. WSL 真容器路径」，**并且先跑一遍 `npm run doctor`**。完整细节、每个开关的坑、CLI 全量子命令，见下面各节。

---
### 0. 检查 Node

```bash
node --version     # 必须 >= 24；本机 v24.13.0
```

### 1. 生成 token 并起 daemon（stub 模式，零网络请求）

```bash
npm run init-config                    # 写 ~/.dotd/tokens.env + ~/.dotd/config.yml（幂等）
source ~/.dotd/tokens.env              # Git Bash / WSL；PowerShell 见脚本输出的提示
DOTD_MODEL_TRANSPORT=stub DOTD_FLEET=stub npm run serve
```

bash 等价写法（功能同上，但不补 `FEISHU_*` / `WB2API_KEY`）：

```bash
bash scripts/setup-dev-env.sh          # 写 ~/.dotd/tokens.env（幂等）
source ~/.dotd/tokens.env
cp config/dotd.yml ~/.dotd/config.yml  # surfaces 七节模板；三个 ${VAR} 由上一步提供
DOTD_MODEL_TRANSPORT=stub DOTD_FLEET=stub npm run serve
```

`DOTD_MODEL_TRANSPORT=stub` = 模型走内存 stub（`CONVENTIONS.md:154`），`DOTD_FLEET=stub` = fleet 走内存 stub 不起容器（`:155`）。**两个变量的缺省值不一样，别想当然**：`DOTD_MODEL_TRANSPORT` 未设 = 真实 HTTP 请求（`src/router/transport.ts:33-35`）；`DOTD_FLEET` 未设 = **仍然是 stub**——`src/exec/types.ts:149-150` 的 `DEFAULT_EXEC_CONFIG.fleet = 'stub'`，且 `execConfigFromEnv` 只对精确等于 `'stub'`/`'docker'` 的值做覆盖，拼错（`Docker`、`DOCKER`、`real`）也静默回落 stub（`:188-189`）。要真实容器必须显式 `DOTD_FLEET=docker`。（`CONVENTIONS.md:157` 写的「非 stub 值或缺省 = 真实路径」对 `DOTD_FLEET` 与代码不符，以代码为准。）

> 注意 `npm run dotd -- serve` 只打印引导提示，不是真入口（`src/surfaces/cli.ts:155-160`）。

### 2. 另开一个 shell，用 CLI 操作

```bash
source ~/.dotd/tokens.env

npm run dotd -- status              # 队列 + 熔断 + 待批审批总览
npm run dotd -- ask "帮我看看今天有什么事"   # 发起主人对话（POST /api/messages，priority=1）
npm run dotd -- approvals           # 待批审批列表
npm run dotd -- approve 42          # 批准（once|remember；deny 同理）
npm run dotd -- watch               # 实时事件流（SSE /api/stream）
npm run dotd -- events              # CP events 分页
npm run dotd -- task tk_ev_1        # 任务 + journal 步骤
npm run dotd -- cancel tk_ev_1      # 取消任务
npm run dotd -- logs                # 入站拒绝审计（经 /api/guard 旁路）
npm run dotd -- hook grafana '{"k":1}'   # 手动投递 webhook（secret 取 DOTD_HOOK_SECRET_GRAFANA，值 = setup-dev-env.sh 生成的 HOOK_GRAFANA）
npm run dotd -- hb list             # 心跳 crontabs 管理
npm run dotd -- sos-test            # 求救通道自检（阶段一 telegram 未装配，会如实报不可用）
```

token 三顺位：`--token` > `DOTD_MASTER_TOKEN` > `~/.dotd/cli_token`（`src/surfaces/cli.ts:34-45`）。base URL 三顺位：`--url` > `DOTD_URL` > `127.0.0.1:7788`（`:49-56`）。daemon 不可达退码 **7**。

> **为什么上面用 `hook grafana` 而不是 `hook smoke`**：`hook <source>` 按 `DOTD_HOOK_SECRET_<SOURCE>` 找 secret（`src/surfaces/cli.ts:336-341`），而 `smoke` 这个源两处都不通——① `DOTD_HOOK_SECRET_SMOKE` 既不被 `scripts/setup-dev-env.sh` 生成、也不在 `.env.example` 里登记，CLI 会以 exit 2「缺少 hook secret」退出；② 即便补了 secret，daemon 仍返 401「未登记的 hook source：smoke」，因为 `config/dotd.yml:56-60` 只登记了 `grafana` 一个 source（`src/surfaces/http.ts:788-792`）。要用 smoke 源，得自己在 `~/.dotd/config.yml` 的 `hooks:` 里加一项并配 secret。

### 3. 浏览器

开 `http://127.0.0.1:7788/`，登录页输 master token。六个视图：Chat / Queue / Approvals / Events / Models / Logs。HTTP 是全系统唯一监听（`src/surfaces/http.ts:4-5`），端口非 7788 只告警不拒启动，`master_token` 为空则 `ConfigError` 拒启动（`:919-929`）。

### 4. 跑门禁

```bash
npm run typecheck                  # tsc --noEmit -p .
npm test                           # 1399 个用例；并行 4，任意 cwd 都可
npm run test:serial                # 同上但不并行（约 5 分钟；排查并行相关假红时用）
npm run test:fast                  # 日常快检（同并行 4）
node scripts/smoke.mjs             # 11/11 端到端冒烟（自建临时数据目录，不碰 ~/.dotd）
DOTD_SMOKE_FAKE_UPSTREAM=1 node scripts/smoke.mjs   # 16/16：真 HTTP 模型链路（本地假上游，零外网）
npm run build:web                  # web-ui：tsc --noEmit + vite build
```

### 5. 上线前体检（强烈建议：起 daemon 之前先跑这个）

```bash
npm run doctor                     # 10 项只读检查；有 fail 时退出码 1
npm run doctor -- --json           # 机器可读（CI / 远程排查用）
```

它专抓**静默失败**——那种"daemon 起来了、看起来在跑、其实什么也没干"的情况：
`DOTD_FLEET` 拼错（`Docker`/`DOCKER` 会**静默**回落 stub，所有工具执行都是假的）、
`DOTD_MODEL_TRANSPORT` 的缺省其实是**真 HTTP**（与 fleet 的缺省正好相反）、
tier1 端点连不上、**tier1 的 key 不在环境里**（这是"daemon 正常起、交互任务全挂起"的根因）、
严格占位符没展开（`ConfigError` 拒启动）、库的 `user_version` 落后于 `db/migrations` 的期望版本。
每项都给人话结论 + 下一步命令，不打印任何密钥的值。

实跑示例（本机 2026-10-17，故意暴露两个真实缺口）：

```
❌ 环境里没有 WB2API_KEY
     缺 key 不是启动期错误，但运行期请求会失败并计入熔断；tier1 是唯一能承载 primary 的端点
     → 下一步：把 export WB2API_KEY=... 写进 ~/.dotd/tokens.env，这样 daemon 重启后不会丢
⚠️  user_version=90，期望 100
     落后：daemon 启动时会自动迁移（会先写 OUTBOX）
结论：2 项会让 daemon 起不来或干了假活，先按上面的「下一步」修。
```

### 6. WSL 真容器路径（可选）

**先按上面的三条命令装完**，再在 WSL 里补真容器需要的两步：

```bash
# 在 WSL Ubuntu-24.04 里（setup 已检测过 WSL 里有没有 Node 24）：
bash scripts/wsl-install-node24.sh   # ① 仅当 setup 报 WSL 内 Node < 24
bash scripts/wsl-fleet-prep.sh       # ② rsync 仓库到 ~/dotd + npm install
# 然后用生产代码路径验证真容器（可选，用于自检）：
npx tsx scripts/wsl-fleet-boot.mts   # 真容器 boot + fsOps 写文件 + docker exec 读回
```

**一条命令跑完整验证（推荐）**：

```bash
# Windows 侧：把模型服务暴露给 WSL（13065 -> 127.0.0.1:3065）
node --import tsx scripts/win-relay.mts

# WSL 侧
bash scripts/live-wsl-e2e.sh
```

它做七件事并**逐项检查前置条件**：docker / node → 凭据与端点（自动把 tier1 指向 relay）→
`DOTD_FLEET=docker` 起 daemon → 提交真任务 → 等终态 → **真容器证据**（`docker ps` 看容器、
`docker exec` 读回模型写的文件）→ 汇总。**内存不够会直接拒绝跑并说明原因**，不让你对着超时猜。

**不需要单独「构建镜像」一步**：`src/exec/image.ts:ensureImage()` 在 daemon boot 时发现镜像缺失就会自动构建（`fleet.ts:387-392` 的 boot 序列：ping → **ensureImage** → ensureNetwork → netguard → reconcile）。`scripts/wsl-build-image.mts` 只是"想单独预热/预检镜像"时的便捷脚本，不是安装必经步骤。

只有一件事需要你自己确认：**2GB 基座镜像要不要预拉**。`docker build` 时也会自动拉，但如果你想先把这 2GB 下完再起 daemon，跑一次 `bash scripts/wsl-pull-image.sh`（`setup` 只报告这条命令，不会替你拉）。

WSL 部署时，Windows 侧的 loopback 模型服务需要 `scripts/win-relay.mts` 转发（WSL2 NAT 下，WSL 里的 127.0.0.1 是独立命名空间，够不着 Windows 的 loopback），启动器 `scripts/start-relay.ps1`。该脚本转两条：`:13065`→`127.0.0.1:3065`、`:18001`→`127.0.0.1:8001`（`scripts/win-relay.mts`）。**当前 tier1 是 `127.0.0.1:3065`，正好被 `13065` 覆盖**，所以 WSL 里把 `config/models.yml` 的 `base_url` 改成 `http://<WSL 默认网关>:13065/v1` 即可（`scripts/live-wsl-e2e.sh` 会自动做这一步）。若你换回 `:7863` 那类未被转发的端口，需自己给 `win-relay.mts` 的 `rules` 补一条，`setup` 会检测并提示这条缺口。原生 Windows 部署不需要 relay。

---

## 安装流程：12 步 → 3 步

| # | 旧流程的 12 步 | 现在 | 为什么能省 |
|---|---|---|---|
| 1 | 装 Node ≥ 24 | **人来（①）** | 系统级前置，装它会改变整台机器运行时 |
| 2 | `npm install` | `setup` 自动 | 检测 `node_modules` 与 lock 新鲜度 |
| 3 | `init-config` | `setup` 自动 | 幂等；已存在则跳过 |
| 4 | `source tokens.env` | `setup` 自动注入 doctor | doctor 检查的是进程环境，setup 会把 tokens.env 喂给它，避免"装好了却报缺 key"的假警报 |
| 5 | 装 WSL | 人来（可选） | 只有要真容器才需要；原生 Windows 用 stub 即完整体验 |
| 6 | 拉 2GB 基座镜像 | **人来（可选）** | 昂贵动作，`setup` 只给命令 |
| 7 | rsync 仓库进 WSL | 半自动 | `wsl-fleet-prep.sh`（`setup` 检测 WSL 内 Node） |
| 8 | WSL 里 `npm install` | 同上 | 并入第 7 步那条脚本 |
| 9 | **构建 exec 镜像** | **删掉这一步** | `ensureImage()` 在 boot 时自动构建，原本就是重复劳动 |
| 10 | 补 relay 转发（`:7863`） | 人来（仅 WSL） | 转发哪个端口取决于你的模型服务，无法猜 |
| 11 | 给模型 key | **人来（②）** | 只有主人有 key；脚本只检查、不生成、不打印 |
| 12 | 确认 fleet 模式 | **人来（③）** | 这是"意图声明"（要不要真容器），不是检测得出来的东西 |

**两类用户各自的 3 步**：

- **原生 Windows（stub 模式，完整体验 daemon/队列/审批/CLI，只是模型与执行是假的）**
  1. `node --version`（≥ 24）
  2. `npm run setup`
  3. `npm run serve`
- **WSL（真容器）**
  1. `node --version` + `npm run setup`（Windows 侧；会检测 WSL 与 docker）
  2. 在 WSL 里 `bash scripts/wsl-install-node24.sh && bash scripts/wsl-fleet-prep.sh`
  3. Windows 侧填模型 key 进 `~/.dotd/tokens.env`，然后 `DOTD_FLEET=docker npm run serve`

### `setup` 与 `doctor` 的关系（必答题②）

**`doctor` 是唯一真相源，`setup` 是"把能自动做的做掉，然后调 doctor"。**

- 检查逻辑只写一份：`setup` 不复制 doctor 的 11 项诊断，而是 `import { runChecks, formatReport, exitCodeFor }`（`scripts/doctor.mjs` 早已导出这几个函数）。
- **退出码服从 doctor**：`setup` 自己出错 = 2；doctor 有 fail = 1；否则 0。所以 `npm run setup` 可以直接当 CI 门禁用。
- 两者的分工：`setup` 回答"**装到哪一步了、下一步敲什么**"（有副作用，幂等）；`doctor` 回答"**现在这份配置起 daemon 会不会出问题**"（纯只读）。
- 平时排障只需 `npm run doctor`；换机器/首次部署才需要 `npm run setup`。

---

## 出网工具（`net.get` / `net.post`）：默认关闭


## 出网工具（`net.get` / `net.post`）：默认关闭

dotd 的立身之本是**完全自托管，唯一允许的外部依赖是可换 base_url 的模型 API**。让 agent 主动出网会把主人问的内容发给第三方、也可能产生账单，所以这两个工具**默认是关的**（2026-10-18 之前更糟：容器侧直接返回 `not_implemented`，模型看得见、用了必失败）。

| 开关 | 行为 |
|---|---|
| 不设 / `DOTD_NET_TOOLS=off` | `net.get`、`net.post` 都返回 `net_tools_disabled`（可预测的失败码，模型会读成"主人没开"而不是"工具坏了"） |
| `DOTD_NET_TOOLS=get` | **只**放开 `net.get`。GET 无请求体，泄露面最小。`net.post` 返回 `net_post_disabled` |
| `DOTD_NET_TOOLS=all` | get + post。post 对外有副作用，治理按 `config/tools.yml` 的 `write_file` 档审查，必要时请主人审批 |

**拼错的值按 `off` 处理并打 warning**（例如 `ENABLED`）——绝不因为拼错意外放开出网。

打开以后还有三道独立护栏（`agent-runtime/net.ts`）：

1. **只允许 http/https**，URL 不得内嵌账号密码；
2. **SSRF 防护**：拒绝 localhost、`*.local`、127/8、10/8、172.16/12、192.168/16、169.254/16（含云元数据 169.254.169.254）、IPv6 loopback/ULA/link-local，以及 `[::ffff:127.0.0.1]` 这类 IPv4 映射（实测 `new URL()` 会把它规范化成 `::ffff:7f00:1`，第一版防护就漏在这里，已修）；
3. **不自动跟随重定向**（3xx 原样返回 `location`），响应体 **4MB 上限**（超出截断并标 `bodyTruncated`），单次超时 **30s**。
   宿主侧 `src/exec/netguard.ts` 的 DOTD-OUT 链只放行容器出外网、显式 DROP 到宿主网关/loopback，与这三条是叠加关系。

### 为什么没有内置 web 搜索

**判断：不做内置搜索工具**（2026-10-18 本机实测依据）：

| 端点 | 实测 |
|---|---|
| `html.duckduckgo.com/html/?q=…` | 连接超时 |
| `api.duckduckgo.com/?q=…&format=json` | 连接超时 |
| `www.google.com/search?q=…` | 连接超时 |
| `www.bing.com/search?q=…` | HTTP 200，但 **5/5 次返回与查询无关的结果**（查 `dotd agent harness` → 返回 "DiskGenius 数据恢复软件"；结果来自 `cn.bing`、未登录态降级）、无验证码但不可用 |

把这种结果当"搜索结果"喂给模型，**比没有搜索更糟**——模型会当真。要稳定就得接带 key 的付费搜索 API，那是新增外部依赖与账单，违反自托管的前提。

因此搜索能力表达为 **`net.get` + 一份判据手册**（`src/runner/tool-catalog.ts` 的 `NET_SEARCH_GUIDE`）：优先直连权威数据源（官方 API/文档/RSS），不要去抓搜索引擎网页；主人若能提供自己的搜索端点（自建 SearxNG、内网检索、已付费 API），模型直接 `net.get` 那个端点即可，无需内置。手册同时明确禁止"用 shell curl 绕过 `net_tools_disabled`"——那是同一个出网行为，绕过治理。

---

## 架构

`src/` 下八个模块目录 + 两个装配层根文件（`src/daemon.ts` 装配层、`src/event-rules.ts` 侧加载器）。

| 模块 | 目录 | 职责 |
|---|---|---|
| 控制面 CP | `src/control-plane/` | 持久队列、背压水位、journal 步骤、重启恢复、事件→目标匹配、**全 daemon 唯一周期任务宿主** |
| 模型路由 MR | `src/router/` | tier1→4 单向降级、熔断、mode 状态机、tier3 池、求救/侦察。唯一门面 `src/router/ModelRouter.ts` |
| 治理 GOV | `src/governance/` | 工具五档目录、审批八态机、执行前后审、隔离、审计、记忆规则 |
| 执行面 EX | `src/exec/` | 容器舰队状态机、镜像构建、HTTP RuntimeClient、stub 运行时、home 路径护栏、网络管控、磁盘回收 |
| 记忆 MEM | `src/memory/` | 会话线程、注入重建、WRITE-SEAL、保留容量、OUTBOX 守门、fsops 桥 |
| Runner | `src/runner/` | 主循环 Dot：LLM↔工具协程。自己不建 Docker、不发 HTTP、不直写 tasks/steps 表，全部经注入的四个服务面 |
| 交互面 SF | `src/surfaces/` | HTTP 路由+鉴权、入站规范化、SSE、Web UI 静态托管、出站通知通道、飞书、心跳 tick |
| 共享层 | `src/shared/` | 跨模块契约（`contracts.ts` 类型面）、事件总线、错误类、ID |

装配顺序（`src/daemon.ts:394-403` 头注逐行落实）：openDb+migrate → EventBus+SseBus → createControlPlane → ModelRouter.load → loadCatalog+initGovernance → new ExecServiceImpl+boot → createMemoryService → startHttpServer → startFeishuWs → startFeishuOutbound → new DotRunner → cp.recover → scheduler.start → runner.start（常驻）。

**环依赖用惰性 holder 打破**：CP 的 lowBrain/exec/governance/sealTask 在 CP 之后才 init，故建 memHolder/execHolder/govHolder/routerHolder，CP 侧只在运行期经闭包读，MR/GOV/EX 就位后回填（`src/daemon.ts:459-462,513-545`）。

### 那套 11 工具契约为什么存在

封闭词表共 11 名（`src/shared/contracts.ts:610-621`，与 `src/exec/protocol.ts:96` 的 `CAPABILITY_CATALOG` 逐个同形）：

```
fs.read  fs.write  fs.list  fs.stat  shell.run
browser.open  browser.act  browser.snapshot  browser.close
net.get  net.post
```

三个理由：

1. **白名单制 = 安全默认。** 未登记工具一律 deny：`validateToolCall` 对目录外工具返回 `unknown_tool`（`src/exec/protocol.ts:257-264`）。治理 `config/tools.yml` 的登记名必须 ⊆ 该集合（`:195-196`）——实测该文件确有 11 个登记名（第 21–52 行），另有一个注释示例 `shop.checkout`（第 60 行）。
2. **它是宿主与容器之间唯一的接口面。** `agent-runtime/protocol.ts`（容器侧）与 `src/exec/protocol.ts`（宿主侧）是镜像内副本关系，容器侧是监听权威（`agent-runtime/protocol.ts:11-16` 原文「本文件必须与它逐字同形」）。防漂移靠 `tests/agent-runtime-protocol.test.ts`：类型级双向赋值断言 + 运行期逐个比对 `name/mode/sideEffect`、护栏常量、`args_hash/identity_hash` 同值、fs 错误码名同码。
3. **治理要按工具分档。** 五档 read / write_file / browser / spend / dangerous，默认 read、write_file → allow，browser → review，spend → approve 一律人工，dangerous → approve + Web 勾选确认。`rules.yml` 只能收紧不能放宽。sync 工具 deadline 硬上限 60s。

### 模型路由的降级链

tier1 → tier2 → tier3 → tier4 **单向**，失败永远向前降级，绝不向上涨档重试（`src/router/ModelRouter.ts:437-440`）。同 tier 保声明顺序，tier3 内 `lastVerifiedAt` 新者先。单项预算 ≤ remaining/2；轨默认总预算 primary 300s / light 60s。

熔断每 endpoint×track 一个实例、状态持久化（重启不丢）：closed → open（窗口失败率≥0.5 且≥5 样本 / 连续失败≥3 / auth·quota 立即）→ half_open（`next_probe_at` 到期）→ closed（half_open 成功≥2）。half_open 任一失败回 open，backoff×2 上限 1h。auth 类不自动恢复，退避给到 1h 上限。

全局 mode 五档：NORMAL / LOCAL_FALLBACK / EMERGENCY / RESTRICTED / TOTAL_OUTAGE。LOCAL_FALLBACK 下 primary **默认拒绝**降格到本地 7B，除非 `models.yml` 给 tier2 显式写 `models.primary`（此时 `degraded=true` 落 `model_call_log`）。

四个定时任务挂 CP `registerInternalJob`（契约 J4）：`breaker.probe_timer` 每 60s 半开合成探活（只对 light 轨发 8-token ping）、`router.janitor` 每日、`recon.scan` 每 6h 且仅非 NORMAL、`pool.probe.<id>` 每 30min。

---

## 已知限制

按严重度排列。**high 的都是「照文档跑会在第一次真实调用时撞墙」级别的。**

### 高

- ~~**真实链路一次都没验证过。**~~ **2026-10-17 部分消除**：真实 HTTP 模型传输已由 `tests/router-http-transport.test.ts`（34 条，真 TCP）与假上游冒烟（16/16）证明；**真模型往返、真 Docker 容器、真实飞书仍是零验证**（见「哪些是 stub」）。另外三条在本批被修掉的真实缺陷值得记下来当教训：① `rawHttp` 的三档超时全建在响应回调里，而上游"接了连接回了头再卡住"时该回调永不调用——**超时一个都不生效、调用方永久钉死**；② 崩溃恢复把执行面报的 `aborted`（含 `container_lost`）当成"未落地"，导致已执行的 `rm`/`net.post` 被判可重放；③ `runNext()` 里 `cp.pop()` 在 try 外面，一次 `SQLITE_BUSY` 就能让唯一的常驻协程退出、队列永久静止而进程还活着。三条的改法见 [`docs/optimization-2026-10-17.md`](docs/optimization-2026-10-17.md)。
- **`npm test` 曾是个假绿（2026-10-17 已修）。** 原脚本写成 `--test "tests/*.test.ts"`，引号让 glob 不展开，`--test` 拿到一个字面量文件名、找不到文件也不报错——`tests 0 / pass 0 / fail 0`、exit **0**。也就是说修好之前 `npm test` 对任何人（含 CI）都是"全绿"。现已改成无引号。
- ~~**并行跑测试有 3 个假红**（`tests/router-health.test.ts` 的 3 个 429 冷却评分用例）；`npm test` 固定为串行。~~ **2026-10-17 已恢复并行（测试套件加速任务）。** 当时的根因判定（"runner 并发的共享状态污染"）没有复现；把测试里的真实等待砍掉之后实测 **`--test-concurrency=4` 连跑 3 次全量 1138/1138、0 失败**（90.4s / 112.5s / 61.7s），`router-health` 并行下 25/25。现在 `npm test` = 并行 4；要复现旧行为用 `npm run test:serial`，日常快检用 `npm run test:fast`（同并行 4）。**注意**：并行时任何"靠真定时器/墙钟等待推进"的用例都会在负载机上被饿死（本机还跑着 6 个 node 测试进程时有实例），所以新测试一律用可注入的假时钟或事件驱动等待，别写 `sleep`。
- **CLI 入口守卫在中文路径下恒假（2026-10-17 已修）。** 原判据拿 `import.meta.url` 和手拼的 `file://${argv[1]}` 比，而 `import.meta.url` 会把非 ASCII 路径段百分号编码（`%E7%A0%94%E7%A9%B6` = "研究"），手拼的不编码，两者永不相等 → 守卫恒假 → `node src/surfaces/cli.ts status` 静默退出、exit 0、零输出。**README 里每一条 `npm run dotd -- xxx` 示例因此都曾是空操作。** 已改为与 `src/daemon.ts` 同一手法（比对解析后的绝对路径），修复后 `--help` 正常列出 15 个子命令。
- **第二个 daemon 实例不消费队列。** 用 `DOTD_CONFIG` 指向另一份配置换个端口（如 `:7799`）起 daemon，`/api/status` 正常、能提交任务，但任务永远停在 `queued`——exec 层启动即把 dot1 标 `quarantined`（日志 `[exec] boot 告警：dot1 进入 quarantined`），没有消费者。看到"任务不动"先查这条。
- **tier1 的 `WB2API_KEY` 在全机没有持久来源（真缺口，非文档疏漏）。** 搭建方法已写进 [`docs/tier1-endpoint.md`](docs/tier1-endpoint.md)，但 2026-10-17 排查发现这个 key 不在 `~/.dotd/tokens.env`（逐行看过），也不在 Windows 用户/机器环境变量（`HKCU:\Environment` 与 Machine 作用域均无）——它只存在于当前跑着的 daemon 进程环境里，即启动它的 shell 临时 export 的。后果：用 `scripts/daemon-launch.sh` 重启 daemon 就会丢 key（该脚本只 `source tokens.env`），重启即 tier1 全灭，且现象是"daemon 正常起、任务全部不干活"。修法：把 `export WB2API_KEY=...` 补进 `~/.dotd/tokens.env`。**`npm run doctor` 现在会把这一条直接判 fail 并给出这句修法**——这是本批加它最主要的动机之一。
- **`.env.example` 与 `scripts/setup-dev-env.sh` 会互相覆盖，且它不覆盖全部变量。** 代码确实不读 `.env`，环境变量只能 export 进 shell；仓库现有 `.env.example` 清单（11402 字节，见「环境变量与配置文件」），但三个坑：① 它建议 `cp .env.example ~/.dotd/tokens.env`，而 `scripts/setup-dev-env.sh` 在 tokens.env 已存在时直接跳过——照快速启动先生成过真 token 的用户再 cp 一遍，真 token 就被 `__REPLACE_ME_*__` 占位符覆盖，下次启动报 `ConfigError「环境变量 DOTD_MASTER_TOKEN 未设置」`（`src/surfaces/config.ts:204-211`，未设/空即拒），且看不出是覆盖导致的；② 它没登记 `DOTD_HOOK_SECRET_SMOKE`（CLI `hook smoke` 需要，而 daemon 侧根本没登记 smoke 源，详见快速开始注记）；③ 快速启动实际用到的变量其余都在里面。**跨平台的替代入口是 `npm run init-config`**（`scripts/init-config.mjs`）：生成 `~/.dotd/config.yml` + 补齐 `tokens.env` 缺键，幂等且绝不覆盖已有行。
- **原生 Windows / WSL 两条权威说法对立。** `CONVENTIONS.md:12` 说「不在 WSL」，`docs/design/CONTEXT.md:34` 说「控制面 daemon 跑 WSL 内」（该文件现在**在库内**了，见「相关文档」）。按 CONVENTIONS 自己的仲裁规则（冲突时以 `docs/design/` 原文为准）又该照后者，而代码的实际约束也偏向后者（`src/exec/types.ts:154` 硬编码 Unix socket）。在原生 Windows 上跑真实 fleet 只会得到 `docker 不可用 —— degraded 启动`，此后每个容器动作被拒。
- **首次人工登录通道完全未设计。** 容器内无显示转发路径、surfaces 无身份/登录页。想让它用你的账号干活，得先手工把宿主已登录的 Chrome profile 复制进 docker 卷。
- **state 卷 setuid 秘密隔离方案未实测。** shell(uid 1001) 与 runtime(uid 1000) 的隔离依赖容器内 `CAP_SETUID`，而容器已 `USER=dot` 降权。文档自述「若失败，shell 与秘密隔离整体崩塌」。
- **看门狗超时盲区。** heartbeat 只在步尾写，在途期间静止，180s 阈值必然误回收（该值在 `src/control-plane/types.ts:189` `heartbeatTimeoutMs: 180_000`）；「过渡值 1860s」出自设计期讨论，**仓库内无对应常量**（全仓 grep `1860` 只命中本行），仅作背景记录。真卡死时占 `maxRunning=1`（`src/control-plane/types.ts:187`）的时长取决于该阈值的实际取值。
- **定时任务饿死窗口未仲裁。** 在审批 TTL(24h)（`src/governance/config.ts:44`）× `run_at` × `maxRunning=1`（`src/control-plane/types.ts:187`）下，一条高优先对话任务的排队可饿死每日晨报等定时，且超期后新单继续被插队——心跳静默失效。该论证出自设计期讨论，仓库内无对应的仲裁记录或回归测试。

### 中

- **`IMPLEMENTATION.md` 曾与仓库现状脱节一天以上。** 它曾说 `exec-image/Dockerfile` 不存在（实际 2626 字节在仓库里）、`scripts/` 只有 smoke.mjs（实际 15 个非临时脚本，含 `tmp-*` 探针共 28 个条目）、tests 37 个（实际 42）、test 807（实际 935）、journal-blobs 50 个（实际 93）——五项全过期。它还是**完全没提飞书通道**（grep 0 命中），而飞书是当前唯一真正端到端跑通的 IM 面。**2026-10-17 已逐条修订**（文首有修订表）；未标注 2026-10-17 的段落仍是阶段一原文。
- **`config/` 下没有 surfaces 的 `config.yml`（只有同名不同用途的 `dotd.yml`）。** `npm run serve` 第一步就崩：`loadSurfacesConfig` 只读 `~/.dotd/config.yml`（`src/surfaces/config.ts:354`），仓库里的 `config/dotd.yml` 没有任何代码自动加载。**2026-10-17 已补上生成入口** `npm run init-config`（`scripts/init-config.mjs`）：从该模板填出 `~/.dotd/config.yml` 并补齐 `tokens.env` 缺键，幂等、绝不覆盖已有行。剩下的坑是「同名」本身（下一条）。
- **`config/dotd.yml` 是个同名陷阱。** 它含 `dotdReserveMb`/`maxQueued` 与 surfaces 七节，但没有任何代码加载它；真正被读的是 `~/.dotd/config.yml`。两个同名文件并存、只有一个生效，改仓库那份不产生任何效果。
- ~~**`config/dotd.yml` 缺 `feishu:` 节。**~~ **2026-10-17 已修**：模板补上了 `feishu:` 六字段（`app_id`/`app_secret`/`owner_chat_id`/`verification_token`/`encrypt_key`/`edit_throttle_ms`），由 `init-config` 一并填出。注意 `verification_token`/`encrypt_key` 只对 HTTP webhook 路径有意义，WS 长连接入站不校验它们。
- **`config/dotd.yml` 五个顶层键没有代码读取**（`data_dir`/`maxQueued`/`node_max_old_space_mb`/`wslconfig_note`/`db.expected_user_version`），装配层只按行正则抓 `dotdReserveMb`。改了不生效，且无提示。
- ~~**三个 CLI 子命令自带「路由待补」塌陷。**~~ **2026-10-18 已修**：`/api/logs` 与 `/api/tasks/:id` 两条路由已补齐（`src/surfaces/http.ts` 的 `logs` / `task_by_id`），`dotd logs` 直接读 `surf_ingress_rejects`、`dotd task <id>` 读 CP `getTask()+getJournal()`。`dotd task <id> --verbose` 新增「花了多少 / 卡在哪 / 每一步多久」三段视图（`src/surfaces/task-view.ts`；成本口径直接取 `model_call_log.prompt_tokens/completion_tokens`，按契约 J1 用 `attempt_id = llm 步 call_id` 关联，不重造）。
- **`net.get`/`net.post` 已实现但默认关闭（2026-10-18）**：此前容器侧直接返回 `not_implemented`——模型在工具目录里看得见、调用必失败。现在见下方「出网工具」节。**没有内置 web 搜索**，理由与实测证据写在该节。
- **背压设计依赖两个未实测环境事实**：WSL2 `docker pause` 可用性（cgroup-freezer），以及 netfuzz 负载的确切位置（文档假设在 WSL 内，与 `CONTEXT.md:35` 的表述存在相反可能）。若 netfuzz 在 WSL 之外，四档水位阈值全盘错误。
- **阶段一求救只有 `~/.dotd/OUTBOX.md` 一条路**，且 daemon 崩溃时无处可写。深夜全灭时求救可能无人见。
- **免费池 key 与主通道相关性故障。** OpenRouter 挂时 groq `:free` 也要同家 key，Tier3 对 tier1 故障失效——容灾链第三级可能名存实亡。
- **OLMoE 7B 工具调用能力未实测**，而 light 轨要承接 event.match / 摘要 / precheck 三类调用。若它不能可靠输出严格 JSON，事件匹配会大量落 inbox，系统表现为「不自主」。
- **`calibrate-watermark.sh` 不存在**（水位标定是 DiskGardener 的 free<5GB 触发依据）；`wsl-bootstrap.sh` 与 `portproxy.ps1` 也没有，只有名字不同的等价物 `wsl-fleet-prep.sh` / `win-relay.mts`。
- ~~**17 个 `tmp-*` / `.tmp-*` 探针脚本现已被 `.gitignore` 覆盖**（`.gitignore:39-41` 的 `/tmp-feishu-chats.sh`、`.tmp-*`、`scripts/tmp-*` 三条，正好罩住根目录 3 个 + `scripts/` 14 个；2026-10-17 追加区块）。它们仍留在工作区里：内容没有密钥，但写死了 `/root/.dotd` 路径、WSL 内网 IP、systemd unit 全文，clone/分发前值得先删掉。误建的 `nul` 文件（cmd 重定向产物）也已由 `.gitignore` 挡下。~~ **2026-10-17 已删除**：实际是 **21 个**（根目录 4：`tmp-feishu-chats.sh`、`.tmp-net-probe.sh`、`.tmp-q.sh`、`nul`；`scripts/` 17 个 `tmp-*`）。删前逐字节备份到仓库外（`%LOCALAPPDATA%\Temp\dotd-tmp-probes-backup-20261017\`），并核实过无密钥、无测试/源码引用。`.gitignore` 的探针区块保留，作为以后新探针的命名约定（`.tmp-*` 或 `scripts/tmp-*` 即自动被挡）。
- ~~**`.zcode/` 目录（286K，16 个文件）没有根级 ignore 规则**，只靠两个嵌套 `.gitignore` 里的 `*` 挡着。防护是脆的。~~ **2026-10-17 已修**：`.gitignore` 末尾补了 `/.zcode/` 根级规则，不再依赖嵌套文件里的 `*`。
- **`tools/` 下几个诊断脚本带内网 IP 默认值，以及多处 `/root/.dotd` 绝对路径。** `172.19.0.2:9223`（`tools/probe-async.sh`、`tools/probe-sync.sh`）与 `172.17.48.1:13065`（`tools/diag-breaker.sh`）**2026-10-17 已改为可覆盖默认值**：`export RUNTIME_HOST=127.0.0.1 RUNTIME_PORT=9223` / `RELAY_HOST=<你的网关>` 即可换环境，不必改脚本。剩下三处不宜改：`src/exec/netguard.ts:89-90` 与 `src/exec/fleet.ts:1373` 的 `172.18.0.x` 是 docker bridge 网段的**功能默认值**（改错会让 netguard 挡错目标），`scripts/win-relay.mts:24` 是记录「Host header 不被允许导致 warm 闸失效」的踩坑注释。`/root/.dotd` 路径散布在多个 scripts/tools 里，这些脚本本就只在 WSL 开发机上跑，未处理。

### 低（一并记下）

- `agent-runtime/protocol.ts:16` 提到的 `assertProtocolDrift()` 全仓库无定义（只在该注释里出现），防漂移实际由测试承担。
- 设计目录树点名的四个文件不存在：`src/governance/cron.ts`、`src/governance/channels/telegram.ts`、`src/memory/compaction.ts`、`src/surfaces/telegram/`（功能已并入其它文件，照目录树找会找不到落点）。
- Web UI 的 Settings 视图无后端，hooks 在线编辑固定 501（`src/surfaces/http.ts:684-685`）；`web-ui/package.json:5` 的 description 还写「占位骨架」（内容已填实 1836 行——`find web-ui/src -type f | xargs wc -l` 实测 2026-10-17，此数随编辑增长，以实测为准）。
- `jsonl_watch` 的文件轮询循环未接线，默认 `enabled:false`（行规范化/dedup/旋转语义已在 `src/surfaces/ingress.ts` 实现）。
- `journal-blobs/` 已积累 89 个 `.json`（本次 `ls journal-blobs/*.json | wc -l` 实测，数字随每次跑测试增长）且仍在增长（已 gitignore，不入库）。
- 迁移包 `000_control_plane.sql:10` 的 `events.source` CHECK 里没有 `'feishu'`，而 `src/surfaces/feishu-inbound.ts:271` 真的写这个值——代码越过冻结 DDL 的偏离。

---

## 路线图

### 阶段二（接口在阶段一已定型，主要是接通与调优）

1. **Telegram 全量**：getUpdates 长轮询、审批双通道、批量卡片节流。
2. **邮件入口**：IMAP/SMTP 适配器 + 附件策略。
3. **低智能分流实装**：Colibrì/Ollama 承接 event.match / 摘要 / precheck，本地不可靠 → 探测 → 再降级闭环。
4. **免费池 + 侦察 + 求救闭环**：`pool.probe` 30min、tool_roundtrip 合格证、`recon.scan` 6h 只用 `api.github.com`/openrouter 元数据、候选审批卡片、TG 优先求救链路。
5. **审批规则持久化**：`approve_remember` 派生 `endpoint_grants`/`approval_rules` + 预览 + LRU + 记忆页。
6. **email 兜底通道**：SMTP 由 surfaces 认领。
7. **审查降级矩阵调参**：`reviewDegraded` 熔断阈值、批量卡片合并、postReview 嗅探正则集。
8. **JSONL 监听默认开**。
9. **scheduled turns 增强**：quiet_hours 精细、补投策略。

### 阶段三

- **多 Dot**：dots 主档表 + 配额分桶 + 跨 Dot 身份路由 + profile 卷亲和。
- **invisible_playwright 反检测增强**：stealth 注入实现替换，协议不动。
- **语音**（明确最后做）。
- 附带机制升级：merge「立刻打断」通道、note 附条件强制执行、`dotd notes backup`、web session key 启用 thread 幂等、docker.sock 最小权限代理。

---

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。

## 相关文档

- `CONVENTIONS.md` —— 全仓库约定唯一权威（模块边界、stub 变量、数据库约定）。
- `IMPLEMENTATION.md` —— 实现报告。**已部分过期**，2026-10-17 做过一轮逐条修订（文首有修订表），但未标注的段落仍是阶段一原文，数字可能已变。
- `docs/tier1-endpoint.md` —— tier1 主轨端点（`:7863` workbuddy2api）的搭建、`WB2API_KEY` 拿法、以及没有这个容器时怎么换端点。
- **设计文档已并入本仓库**（`docs/design/`，2026-10-17 从仓库上一级移入）：`CONTEXT.md`、`自主Dot系统设计方案.md`、`modules/` 下六个模块加接缝契约，共 9 个 markdown、约 541K。**「为什么这样设计」的答案现在 clone 就能看到**，本文里所有 `docs/design/...` 引用都不再悬空。原先这是最大的一条分发缺口——只拿到 `dotd/` 的人解析不了任何设计引用；现在仍是同一批文件，只是位置变了。
