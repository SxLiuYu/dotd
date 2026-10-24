# 镜像构建与容器验收（2026-10-23 / 24）

对应阶段 3/4 唯一没做的两件事：**镜像能构建**、**干净数据卷能跑起来**。

## 环境

| 项 | 值 |
|---|---|
| 宿主机 | WSL2 `Ubuntu-24.04`（Windows 上执行 `wsl.exe`），仓库在 `/mnt/d/dotd` |
| Docker | `29.1.3`（server `linux/x86_64`） |
| Compose | `2.40.3+ds1-0ubuntu1~24.04.1` |
| 网络 | 直连 pypi 超时（`Errno 101`）；构建用清华源，见下 |
| 配置 | 仓库根 `.env`（gitignored）：`DOTD_FLEET=stub`、`CHARLIE_CORTEX=auto`、本机模型网关 |

不是云主机，也不是全新系统：Docker 是预先装好的，仓库已克隆。**「干净主机 30 分钟」只能部分证伪/证实**，见文末。

## 构建

```bash
# 冷构建（缓存全关）—— 本目录 cold-build.sh 就是这条
DOTD_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  docker compose -f docker/compose.voice.yml build --no-cache
```

| 场景 | 用时 | 日志 |
|---|---|---|
| **冷构建（`--no-cache`）** | **238 s（3 分 58 秒）**，`rc=0` | `cold-build.log` |
| 改 Dockerfile 后增量（复用 npm/apt 层） | 124 s | `warm-rebuild.log` |
| 只改 `src/` 后增量 | 11 s | `incremental-rebuild.log` |

产物：`charlie-dotd:latest`，**1.59 GB**（`image.txt`）。

```text
charlie-dotd:latest 89dacc35adb3 1.59GB 2026-10-24 03:01:32 +0800 CST
```

### pypi 不可达这件事

`Dockerfile.voice` 的 pip 步骤现在接受构建参数，默认仍是官方源：

```dockerfile
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /tmp/charlie-requirements.txt
```

`compose.voice.yml` 把它接到 `DOTD_PIP_INDEX_URL`。**没有把镜像源写死**：换地区部署的人不该被迫走清华。
第一次构建失败的原样证据在 `warm-rebuild.log` 前的失败日志里（pip `Network is unreachable` → 5 次重试），
那次是网络问题，不是 Dockerfile 语法问题。

## 起容器

```bash
docker compose -f docker/compose.voice.yml up -d --build
curl -sS http://127.0.0.1:8000/health
```

`compose-ps.txt`：

```text
NAME      IMAGE                 COMMAND                  SERVICE   CREATED          STATUS                    PORTS
charlie   charlie-dotd:latest   "/app/entrypoint.sh …"   charlie   15 seconds ago   Up 11 seconds (healthy)   0.0.0.0:8000->8000/tcp, ...
```

`health.json`（真实输出，只截这一份）：

```json
{"ok":true,"service":"charlie","product":"charlie+dotd","voice":"ok","kernel":"ok",
 "kernelDetail":{"state":"running","pid":9,"restarts":0,"apiVersion":1,"lastError":null,
 "health":{"ok":true,"service":"dotd","apiVersion":1,"dotId":"dot1","busSeq":268}}}
```

容器健康检查本身也是 healthy（`health-inspect.json`）。

## 空数据卷的首次启动

第一次 `up`（卷是空的）时，`container.log` 开头：

```text
[entrypoint] 首次启动：生成 /data/config.yml（master token 取自环境）
已生成 /data/config.yml
已写入 /data/tokens.env（已存在的行未改动）
[entrypoint] 已复制默认 models.yml
[entrypoint] 已复制默认 tools.yml
[entrypoint] 已复制默认 rules.yml
[entrypoint] 已复制默认 event-rules.yml
[entrypoint] 已复制默认 free-models.yml
[entrypoint] 已复制默认 mcp-servers.yml
[entrypoint] 已复制默认 mcp-servers.voice.yml
[one-system] dotd 已启动 pid=23 cmd=/usr/bin/node --import tsx /app/src/daemon.ts
[dotd] 迁移 0→210（应用 23 包）
[dotd] HTTP 监听 127.0.0.1:7788
```

第二次起（卷已有配置）：

```text
[entrypoint] 复用已有 /data/config.yml
[dotd] 库已是最新（user_version=210）
```

**这一步就是之前缺的**：compose 只挂 `/data` 一个卷，而 `one_system.py` 只“读”
`/data/config.yml`、dotd 只“读”`/data/models.yml`；没有 `docker/entrypoint.sh` 时，
空卷必然起不来（内核永远离线）。启动到 healthy 观测点：**启动后 39 s 已 healthy**（`compose-ps.txt`）。

## 设备面一轮（真跑）

容器里自动注册了一台设备（`/data/voice/device.env`，`dev_6c23f62ec3b48717`，`channel=voice`）。
用它的令牌走设备面，**令牌不出容器**（`turn_check.py` 在容器内执行，只打印非敏感字段）：

```bash
docker exec -e TURN_TEXT='用一句话说明你能做什么。' -i charlie python3 - < turn_check.py
docker exec -i charlie python3 - < turn_check.py          # 写笔记的那一轮
```

| 轮次 | 提交 | 终态 | 凭证 | 输出 |
|---|---|---|---|---|
| 一句话介绍 | `202` / 46 ms | `done` / 10.1 s | `200`，2 步，`bundleHash d7c612ef…` | `turn-simple.txt` |
| 写 `notes/2026-10-23-docker-accept.md` | `202` / 43 ms | `done` / 50.4 s | `200`，19 步，含 `fs.write` 成功，`bundleHash 324a7da9…` | `turn-write.txt` |

凭证里带设备归属：

```json
{"device":{"id":"dev_6c23f62ec3b48717","name":"50a685451241","status":"active","channel":"voice"}}
```

同一句话在同一容器里连跑两次的差异（28 s 正常收尾 vs 50 s 被“重复动作”护栏收尾、`reply=null`）
是**模型侧不稳定**，不是链路问题：两次的 `fs.write` 都成功，凭证都是 200。这条照实记，
不当成 ✅。

### 顺手修掉的一个真问题

上面的轮次最初每轮留下 **13–14 次 `unknown_tool`**：`CAPABILITY_CATALOG` 里登记了
`tool.list`，但 stub 容器只实现了 fs/shell，runner 每轮注入工具清单时都会查一次。
两处改动：

- `src/exec/stub-runtime.ts`：`tool.list` 返回 `{tools: []}`（没有 tools 目录 ≠ 工具不存在）；
- `src/runner/dot.ts`：能力目录里没有 `tool.list` 时不再白跑一次。

复验：同一轮 `exec_calls` 里 `tool.list` 从 `error/unknown_tool ×14` 变成 `done ×3`，
新增用例 `tests/exec-protocol.test.ts`（能力目录里登记的工具必须能应答）。
全量测试 `1976 / 1976`。

## 已知限制（不要当成通过）

- `DOTD_FLEET=stub`：容器里的 fs/shell 是**内存模拟**，日志自己会喊“重启即蒸发”。
  要验“真写文件/真起兄弟容器”，得 `DOTD_FLEET=docker` 且挂 `docker.sock`。
- 没配 TTS key：日志里 `no TTS available` 是预期；本轮验的是「文本进 → 执行 → 凭证」，不是「音箱出声」。
- 没有真实 ESP32 接入、没有 8000/8443 之外的端口验收（1883/8888 未测）。
- **「干净云主机 30 分钟」仍不是整段实测**：本次只测到「构建 238 s + 首启 ≈ 40 s ≈ 4.5 分钟」，
  不包含装 Docker、拉代码、配模型 key、备案/安全组。要写成 30 分钟，得在真云主机上从
  `docker --version` 不存在开始计一次；本次没有那个环境。

## 文件

| 文件 | 内容 |
|---|---|
| `cold-build.log` | `--no-cache` 全量构建日志，末行 `rc=0 elapsed=238` |
| `warm-rebuild.log` | 改 Dockerfile 后的增量构建（124 s） |
| `incremental-rebuild.log` | 只改 `src/` 的增量构建（11 s） |
| `compose-ps.txt` / `health.json` / `health-inspect.json` / `image.txt` | 运行态快照 |
| `container.log` | 容器 stdout/stderr（首启 + 两轮设备面） |
| `turn_check.py` | 容器内设备面验收脚本（文本轮 + 凭证） |
| `turn-simple.txt` / `turn-write.txt` | 两轮输出 |
| `cold-build.sh` | 冷构建计时脚本 |

已检查：以上文件不含 master token / 设备令牌 / 模型 key 明文（逐值比对，命中 0）。
