# 语音端一页上手：Charlie（壳）+ dotd（内核）

> 2026-10-23 · 阶段 3/4 的落地说明。命令都在仓库根执行。
> 只讲一条路径：装好 → 设备上线 → 说一句话 → 拿到带凭证的结果。

## 0. 先体检

```bash
npm run onboard
```

它会告诉你缺什么、具体怎么补。必需项只有三个：Node ≥ 22、Python ≥ 3.10、主人令牌。
ffmpeg 和 Docker 缺了也能先跑文本链路（会明确标 ⚠️，不假装通过）。

## 1. 云主机（2C4G，约 30 分钟）

```bash
git clone <repo> && cd dotd
npm ci
npm run init-config            # 生成 ~/.dotd/config.yml
npm run build:web              # 控制台静态文件

# 主人令牌（只写一次，别提交）
openssl rand -hex 32           # 写进 config.yml 的 surfaces.http.master_token

# 模型 key（任选其一；没有 key 也能先跑反射层）
#   ~/.dotd/tokens.env:
#   HY3_API_KEY=...
# 或 OPENROUTER_API_KEY=...

npm run onboard                # 必需项应全绿
npm run charlie:start          # Charlie 托管 dotd；Ctrl-C 一起停
```

验证：

```bash
curl http://127.0.0.1:8000/health
# {"ok":true,"product":"charlie+dotd","voice":"ok","kernel":"ok","apiVersion":1}

curl -s http://127.0.0.1:8000/console/ -o /dev/null -w '%{http_code}\n'   # 200
```

第一次启动会自动在 `/api/devices` 里注册本机（名字取 hostname），令牌写在`<home>/voice/device.env`（0600）。之后 Charlie 的每条语音任务都带设备归属。

### 1.1 语音要快：把模型的隐式思考关掉（强烈建议）

语音的第一句慢，九成是模型的"先想后说"。在 `config/models.yml` 的端点下加一行，原样并入请求体：

```yaml
  - id: local-hy3
    tier: 1
    base_url: http://你的网关/v1
    api_key_env: HY3_API_KEY
    models: { primary: hy3, light: hy3 }
    extra_body: { chat_template_kwargs: { enable_thinking: false } }
```

实测（2026-10-23）：hy3 首个 content 分片 3.3s+ → 1.7–2.6s；Qwen3.8-Flash 若只写顶层
`enable_thinking: false` 会被网关忽略（仍 31s），必须放进 `chat_template_kwargs`。

量一下自己的链路（不烧真模型额度）：

```bash
node scripts/.pipe-latency.mjs     # 本地上游固定 300ms，输出 firstDelta 与"扣掉上游后的 dotd 开销"
```

## 2. Docker（可选，一条 compose）

```bash
cp docker/voice.cloud.env.example .env     # 云主机
# 或 cp docker/voice.box.env.example .env  # 树莓派/迷你主机：不起容器工具
docker compose -f docker/compose.voice.yml up -d --build
curl http://127.0.0.1:8000/health
```

- 只暴露 8000/8443；dotd 只在容器内回环，设备拿不到管理面。
- 数据只有一个卷 `/data`：dotd 的库/记忆 + Charlie 的 `voice/`。
- **一个进程**：`one_system` 当 PID 1，自己 spawn dotd（7788）。8443 是同一进程里的
  HTTPS sidecar（证书自动生成在 `/data/voice/cert/`，`lifespan` 关掉所以后台定时器
  不重复）。手机浏览器只在 HTTPS 下给麦克风权限，所以 8443 不是可选项。
- **首次启动会后台下 237MB 的 SenseVoice 模型**到 `/data/voice/models/sense-voice`。
  `/health` 变绿 ≠ 能听：模型下完之前 ASR 整条链返回空。看进度：
  `docker logs charlie | grep -E 'SenseVoice|asr-model'`。离线环境自备模型或设
  `DOTD_DOWNLOAD_ASR_MODEL=0` 关掉下载。
- `cloud` 档位要用 docker 工具时，取消 compose 里 `docker.sock` 那行注释；
  `box` 档位保持 `DOTD_FLEET=stub`，工具走宿主 MCP。

**已验证**（2026-10-23，WSL2 + Docker 29.1.3）：冷构建 238 s、镜像 1.59 GB、空卷首启
自动生成 `/data/config.yml` 并注册本机设备、容器 healthy（证据：
`docs/acceptance/voice-docker/`）。

**但 2026-10-25 复查发现镜像又聋又哑**：Dockerfile 只装了 `requirements-core.txt`，
`edge_tts / sherpa_onnx / lark_oapi / opuslib / av / soundfile` 六个**全部缺席**
（`docker run --rm --entrypoint python charlie-dotd:latest -c 'import …'` 实测）。
healthcheck 只看 `/health`，所以"容器 healthy"这个结论当时是假的。现在改为再装
`voice/requirements-container.txt`、apt 补 `libopus0`、entrypoint 后台下模型。

修完后的实测（同一天，重建镜像 **1.96 GB**）：空卷首启 40 s healthy → 后台从
hf-mirror 下 226 MB（约 3 分钟）→ `/health.asr.mode` 自动从 `none` 变 `local` →
`POST /api/asr` 返回正确文本，**全程不用重启容器**。门禁：
`tests/voice-container-image.test.ts`（装了哪些包 / 模型下到哪 / 必须先判文件存在）、
`tests/voice-asr-model.test.ts`（多源下载、原子落盘、"后到即接管"）。

一个必须知道的坑：**上游 `scripts/download-models.py` 只有 GitHub release 一个源**，
在国内网络 20 s 超时 0 字节（hf-mirror 有 1.2 MB/s）。所以 entrypoint 用的是
`voice/integration/asr_model.py`（三源）。要自建镜像源就设 `SENSE_VOICE_MIRROR`
指向一个含 `model.int8.onnx` 与 `tokens.txt` 的目录 URL。

构建失败优先看两件事：

1. **Node 版本**（Dockerfile 用 `node:22-bookworm-slim` + `setup_22.x`）；
2. **pypi 拉不到包**。直连报 `Network is unreachable` / 超时时换源，不要改 Dockerfile：

```bash
DOTD_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  docker compose -f docker/compose.voice.yml up -d --build
```

## 3. ESP32（约 5 分钟）

1. 设备连上 Charlie 的 Wi-Fi 配网热点，填入 Wi-Fi 与服务器地址（`<host>:8000`）。
2. **先把上游默认设备令牌 `device` 改掉**：Charlie 的 `XIAOZHI_DEVICE_TOKEN`
   与环境变量一致，再重新配网。
3. 设备上线后：`dotd device list` 应出现该设备，`lastSeenAt` 会更新。
4. 说一句需要规划的话（"帮我把今天的报价单核对一下"）——它会走 dotd；
   说"晚安"——本地场景直接执行，动态页出现一条 `source=device` 的记录。

## 4. 验收一条完整链路

```bash
# 假设备：文本进 → 任务 → 正文出，并打印首条增量/端到端延迟
DOTD_MASTER_TOKEN=<master> npm run voice:device -- --base http://127.0.0.1:7788 --create

# 凭证：步骤、审批、模型调用、哈希对账，以及设备维度
dotd prove <taskId>
dotd prove <taskId> --json | jq '.device'

# 动态：语音反射记账也在里面
dotd feed | grep 语音
```

## 5. 设备管理

```bash
dotd device list                 # 状态 / 最后在线 / 今日用量 / 配额
dotd device add 厨房屏           # 一次性令牌（只显示一次）
dotd device rotate <id>          # 旧令牌立即失效
dotd device rm <id>              # 吊销
npm run voice:device -- --create # 假设备跑一轮
```

单设备规则（阶段 3）：同一设备同时只允许 1 个语音任务（`409 device_busy`），
每日 200 次 / 200000 字符（`429 device_quota`，0 = 不限）。额度按本地日期切。

## 5.1 家居控制（空调 / 灯 / 插座）

说一句「开客厅灯」「空调制冷 26 度」就该动，不能等模型。这条链路是
`cortex_router` 的家居反射，毫秒级，不经过 dotd：

1. 写设备清单到 `<数据目录>/home-devices.yml`（模板 `config/home-devices.yml`）；
2. 填凭证进 `~/.dotd/tokens.env`：红外空调要 `TUYA_CLIENT_ID` + `TUYA_ACCESS_KEY`，
   涂鸦灯/插座要 `TUYA_API_KEY`，MQTT 设备要 `MQTT_BROKER`；
3. `npm run voice:check` 会多出一行「家居设备清单」，告诉你登记了几台、缺哪个凭证。

没写清单也能用：设了 `TUYA_IR_DEVICE_ID` + `TUYA_AC_DEVICE_ID` 会自动注册一台「空调」。
门锁/摄像头这类安全设备写了也拒绝登记。

先干跑（不碰真设备）：

```bash
HOME_DEVICES_FILE=config/home-devices.yml HOME_AC_DRY_RUN=1 \
  npm run voice:test
```

字段、DP 码、MQTT topic、以及模型侧 `magic-home` 工具的关系见
[`docs/home-control.md`](home-control.md)。

## 6. 排障

| 现象 | 先看什么 |
|---|---|
| `/health` 503、`kernel=offline` | Charlie 日志里 `[dotd]` 开头的最后 20 行；再 `npm run charlie:check` |
| `kernel=incompatible` | Charlie 与 dotd 的 `apiVersion` 不一致：升级 dotd 或回退 Charlie |
| 语音说"大脑不在线" | dotd 没起来，或 `DOTD_TOKEN`/`DOTD_DEVICE_TOKEN` 不对；此时只执行本地场景 |
| `409 device_busy` | 这台设备还有在途任务，等它结束（Web 队列里能看到） |
| `429 device_quota` | 今天的额度用完了；调整 `devices.daily_tasks` / `daily_chars`（0 = 不限） |
| 设备 401 | 令牌被轮换/吊销；`dotd device rotate` 或重新 `add` |
| `dotd prove` 没有 `device` | 这个任务不是从语音设备来的（Web/CLI 任务不带设备维度） |

## 7. 已知限制（不粉饰）

1. **首条增量延迟取决于网关**：dotd 链路本身 P50 0.47s（`node scripts/.pipe-latency.mjs` 可复现），
   但真网关的 TTFT 在 1.3–17s 之间抖，实测语音首句 P50 2.6–4.7s。要稳定，必须固定低延迟模型端点，
   并按 §1.1 关掉隐式思考。
2. **模型会"口头答应"而没落盘**：实测 hy3 关思考后仍可能回复"已记住"却不调用 `fs.write`。
   所以语音里说"记住…"时，提示词要明确要求先写工具再确认；`npm run charlie:test` 覆盖了这条分流。
3. **许可证**：上游 Charlie 仓库没有 LICENSE 文件（README 声称 MIT）。对外分发前必须
   补齐，详见 `voice/NOTICE` 与 `voice/VENDOR.md`。此前只用于自用/内部部署。
4. **一个安装包未做**：目前仍需 Node + Python 两套运行时；`npm run onboard` 只做体检
   与指路，不做安装。"干净云主机 30 分钟"未在干净环境实测。
5. **设备端不能批准危险动作**：语音说"同意"不算授权，必须到 Web/手机卡片上点。
   按键 + PIN 的设备内审批是 v2，未做。

## 8. 从旧助手搬记忆

```bash
dotd import --print-prompt          # 复制这段给 ChatGPT / 旧 Charlie
# 把它的回答存成 memory.md，然后：
dotd import memory.md --source chatgpt
# → notes/2026-10-24-import-chatgpt.md（16 KB 上限；同一天同来源重复导入会覆盖同一条）
```

导入的只是**原始快照**，不会自动改进 `MEMORY.md`；整理交给一次正常任务（比如对 dotd 说
"把 notes 里那份导入整理进 MEMORY.md，敏感内容略过"）。
