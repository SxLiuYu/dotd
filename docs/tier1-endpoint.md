# tier1 主轨端点：`:7863` workbuddy2api 与 `WB2API_KEY`

> 本文回答一个问题：**dotd 的 primary 轨靠谁干活，怎么把它搭起来，搭不起来怎么办。**
>
> 只写实测过的事。每条给出可复核的出处（`path:line` 或实跑命令）。未验证的明确标注。

---

## 1. 为什么这件事是要命的一条线

`config/models.yml` 里四个能承载 primary 轨的端点，现状是：

| 端点 | tier | 现状 |
|---|---|---|
| `openrouter-main`（tier1） | 1 | **唯一在用的 primary 端点**，`http://127.0.0.1:7863/v1` |
| `openrouter-fallback` | 2 | `enabled: false`（免费路由实测 ~40% 返回 200 无 choices） |
| `backup-openai-compatible` | 1 | `enabled: false`，且 `base_url` 是占位的 `https://api.xxx.example/v1` |
| `colibri-olmoe` | 2 | 只挂 `light`（7B 无已证实的工具调用能力） |

所以 tier1 一挂，**所有交互式任务全部停摆**：`dotd ask`、飞书入站消息、任何需要
primary 轨的事件。light 轨还能降级到本地 OLMoE，primary 轨没有第二站。

失败链条（已逐环核实）：

1. `WB2API_KEY` 未设 → `src/router/transport.ts:402-406` `apiKeyFor()` 返回 `null`；
2. 不发 `Authorization` 头；
3. 容器回 `{"error":{"code":"invalid_api_key"}}`（实测：空 key curl `127.0.0.1:7863/v1/models`
   即得此响应，HTTP 200 但内容是错误体）；
4. 计入熔断窗口（`config/models.yml` `breaker.consec_failures: 3` 直接 open）；
5. 交互任务挂起。

注意第 1 条**不是启动期错误**——daemon 起得好好的，只是运行期全部请求失败。这是最坏的一种坏：
不报错，只是不干活。

---

## 2. 上游是什么

`:7863` 上跑的是 **WorkBuddy2API**，一个自托管的 OpenAI 兼容网关，把腾讯 CodeBuddy
（`copilot.tencent.com`）账号包装成 `/v1/chat/completions` 服务。

- 开源，MIT，`https://github.com/Sliverkiss/workbuddy2api`
- 本机源码在 WSL `/root/workbuddy2api`（`git remote -v` 实测），容器名 `workbuddy2api`，
  镜像 `workbuddy2api:latest`（本地构建，`docker ps` 实测 `0.0.0.0:7863->7863/tcp, healthy`）
- 能力：多账号池轮转、熔断与冷却、会话粘性、定时签到保活、SSE 流式

> ⚠️ **合规边界**（上游 README 原文立场，本文照录）：这是**非官方**网关，使用 CodeBuddy
> 账号作为上游，**仅限本人授权账号、本机/私有环境**。不要在多人共享或生产环境用。
> dotd 选它是因为主人已有的自建通道，不是因为推荐它。

### 容器实际暴露的模型（2026-10-17 实测 `GET /v1/models`）

`auto`、`hy3`、`hy4-preview`、`step-5-preview`、`space-bunny`、`deepseek-v4.1-flash`、
`deepseek-v4-pro`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、
`kimi-k3-1`、`kimi-k2.8-preview`、`kimi-k2.7`、`kimi-k2.6`、`minimax-m3`。

`config/models.yml:27-28` 把 primary 和 light 都指向 `hy3`，注释记录 2026-10-16 实测
hy3 支持 tool_calls（`finish_reason=tool_calls`，arguments 合法 JSON）且带
`reasoning_content`。**换模型时请确认工具调用能力**——primary 轨要靠它调 dotd 的 11 个工具。

---

## 3. 怎么搭（有 Docker 的情况）

以下在本机 WSL 里实测可复现（源码 `/root/workbuddy2api`，Dockerfile 已读）：

```bash
git clone https://github.com/Sliverkiss/workbuddy2api.git
cd workbuddy2api

# 1) 加账号：OAuth 设备授权，浏览器打开 URL 完成登录，凭证落 auths/workbuddy-<uid>.json
./login.sh

# 2) 配置：api_key 就是你后面要用的 WB2API_KEY，自己定一个
cp config.example.json config.json
#    编辑 config.json 的 "api_key" 字段（默认值是 "your-api-key-here"）

# 3) 构建并起
docker build -t workbuddy2api:latest .
docker compose up -d

# 4) 自检
curl -s http://127.0.0.1:7863/healthz          # 200
curl -s http://127.0.0.1:7863/v1/models \
  -H "Authorization: Bearer <你的 api_key>" | head -c 200
```

**关于仓库自带的 `docker-compose.yml`**：它末尾挂了一个 external network
`gpt-load_default`（为了让另一个 gpt-load 容器用服务名直达）。只跑 dotd 的话把
`networks:` 两段删掉即可，否则 `docker compose up` 会报 network not found。

**Dockerfile 的一个坑**：构建阶段写死了 `GOPROXY=https://goproxy.cn,direct`，因为
`proxy.golang.org` 在作者网络下不可达。如果你的网络能直连 Go 官方代理，这行无所谓；
不能直连又不方便走国内代理的话，改这里。

---

## 4. 怎么拿 `WB2API_KEY`

key 就是容器里 `/app/config.json` 的 `api_key` 字段（本机实测 37 位，`wb2a-` 开头）：

```bash
docker exec workbuddy2api cat /app/config.json | grep api_key
# 或 WSL 里直接：sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' config.json
```

拿到后写进 `~/.dotd/tokens.env`：

```bash
export WB2API_KEY=wb2a-...   # 37 位
```

**本机实况（这是一个待修的部署缺口，不是文档疏漏）**：2026-10-17 排查发现
`WB2API_KEY` 在**全机没有任何持久来源**——不在 `~/.dotd/tokens.env`（已逐行看过），
不在 Windows 用户/机器环境变量（`HKCU:\Environment` 与 Machine 作用域均无此键）。
它只存在于当前跑着的 daemon 进程环境里（`/proc/<pid>/environ` 实测有值），
说明是启动它的那个 shell 临时 export 的。

后果：**用 `scripts/daemon-launch.sh` 重启 daemon 就会丢 key**——该脚本只
`source ~/.dotd/tokens.env`，而 tokens.env 里没有这一行。重启即 tier1 全灭，
且现象是"daemon 正常起、任务全部不干活"。

修复就是把上面那行补进 `~/.dotd/tokens.env`（`scripts/init-config.mjs` 目前也不生成
这一键，见其头注的待办）。

---

## 5. 没有这个容器怎么办

三个选项，从省事到麻烦：

**A. 把 tier1 指向任意 OpenAI 兼容端点**（热加载生效，改完等 `reload_debounce_ms: 1500`）。
编辑 `config/models.yml` 里 `openrouter-main` 的三行：

```yaml
  - id: openrouter-main
    tier: 1
    base_url: https://你的端点/v1      # 换
    api_key_env: 你的_KEY_ENV名        # 换
    models:
      primary: 你的模型名              # 换
      light:   你的模型名
```

契约 T3 保证 `base_url` 可换：线格式的编解码在 transport 层，与端点无关。
**但先确认新端点支持 tool_calls**，否则 primary 轨跑不动 dotd 的 11 工具。

**B. 启用备胎端点** `backup-openai-compatible`：把 `enabled` 改 `true`，同时把它的
`base_url` / `api_key_env` / `models` 三行从占位值改成真值。它现在三项全是假的
（`https://api.xxx.example/v1` / `BACKUP_API_KEY` / `some/model`）。

**C. 什么都不做**：light 轨仍能降级到本地 OLMoE（`:8001`，`enabled` 视主人是否起了
Colibrì 而定），primary 轨无端点，交互任务全部挂起，求救走 `~/.dotd/OUTBOX.md`
（`config/models.yml` `alerts.outbox_path`）。

---

## 6. WSL 部署的额外一环

daemon 跑在 WSL 里时，WSL2 的 NAT 让 WSL 内的 `127.0.0.1` 是独立命名空间，够不着
Windows 侧的 loopback。`scripts/win-relay.mts` 就是干这个的，但它目前只转两条：
`:13065`→`127.0.0.1:3065`、`:18001`→`127.0.0.1:8001`。

**tier1 的 `:7863` 没有转发规则**（`grep -rn "7863" scripts/` 零命中）。在 WSL 里跑
primary 轨之前，自己给 `win-relay.mts` 补一条（如 `listen(13066, 7863)`），并把
`config/models.yml` 里 tier1 的 `base_url` 改成转发后的地址。

原生 Windows 部署不需要这一步——daemon 和模型服务同在 Windows loopback 上。
