# 模块详设：执行面容器（execution）

> 契约来源：`dotd-design/CONTEXT.md`（下称 CONTEXT）。本文不推翻 CONTEXT 任何决策：
> TypeScript + SQLite + Docker、控制面 daemon 跑 WSL 内、每 Dot 一个容器、
> Playwright+stealth、每身份持久浏览器 profile 卷、/dot/home 文件记忆卷（CONTEXT.md:20、31-37）。
>
> 版本说明：本文已经过一轮评审修订，修订记录见文末「评审响应」。
> 关键实测事实：WSL 内 dockerd 29.1.3 的 API 版本为 1.52（min 1.44），
> 验证命令 `wsl.exe -d Ubuntu-24.04 -- docker version --format '{{.Server.APIVersion}}'` → `1.52`。

---

## 1. 模块职责与边界

### 1.1 职责（本模块 owns）

| # | 职责 | 说明 |
|---|------|------|
| E1 | 容器编排 | 每 Dot 一个容器的镜像构建、创建、启动、健康检查、暂停/恢复、销毁；经 WSL 内 `/var/run/docker.sock` 操作 Docker 29.1.3（CONTEXT.md:34） |
| E2 | 工具执行协议 | 宿主 daemon ↔ 容器内 agent-runtime 的 HTTP/JSON 调用协议；幂等 ledger，保证"工具调用被打断绝不重复执行"（CONTEXT.md:44 invisible_dots 借鉴项） |
| E3 | 浏览器进程管理 | 容器内 Playwright chromium 生命周期：并发上限、内存上限、崩溃重启、stealth 注入 |
| E4 | 身份 profile 卷 | 每身份一个持久 `userDataDir`（CONTEXT.md:44"每身份独立持久浏览器 profile"），卷的创建、挂载、配额、清理 |
| E5 | /dot/home 文件与 shell 工具 | 文件记忆的物理载体（CONTEXT.md:21"文件记忆 = /dot/home 笔记与操作手册"）；语义归记忆模块，物理归本模块 |
| E6 | 资源治理 | CPU/内存上限与预留，与 WSL 内 netfuzz 负载共存（CONTEXT.md:35）；全局并发容器闸门 |
| E7 | 磁盘治理 | 镜像、卷、容器可写层、日志的占用上限与回收（CONTEXT.md:37"C:/D: 盘都不大"） |

### 1.2 边界（明确不做）

- **不决定"该不该执行"**：审批状态机、工具权限分级、执行前后审查全在治理模块；本模块只执行已放行的调用，并提供硬护栏（路径约束、资源上限）作为最后防线。
- **不碰任务队列/journal 写入**：journal 是控制面的表；本模块只提供 `call_id` 幂等回执供 journal 对账。
- **不做模型路由、事件入口、会话历史**。
- **不实现反检测增强细节**（阶段三，CONTEXT.md:53）：本模块只预留 stealth 注入点与 profile 隔离结构。

---

## 2. 部署拓扑与 docker.sock 访问路径

### 2.1 拓扑

```
Windows 10 宿主
 └─ WSL Ubuntu-24.04
     ├─ dockerd 29.1.3（socket: /var/run/docker.sock，unix）
     ├─ dotd daemon（Node 24，控制面）…┐ 同在 WSL 内 → 直连 unix socket，
     │    · dockerode 客户端连 unix:///var/run/docker.sock   │ 无需 TCP、无需 Windows 侧 docker
     │    · HTTP 客户端连容器（bridge 网内 IP:9223）         │
     └─ docker network "dotd"（bridge, com.docker.network.bridge.enable_icc=false）
          ├─ 容器 dot-<dot_id>（agent-runtime + Playwright，:9223）
          └─ 容器 dot-<dot_id2>…（阶段三多 Dot）
```

关键决策与理由：

1. **daemon 与 dockerd 同在 WSL**（CONTEXT.md:34 已定），所以宿↔Docker 通道 = 进程内 unix socket，不走 `docker` CLI 子进程、不暴露 TCP 2375/2376。Windows 侧 Web UI 只经 localhost 端口转发访问 daemon 的 REST，永远碰不到 docker.sock。
2. **容器→宿主方向的出站管控（机制明确）**。`enable_icc=false` 只限制容器↔容器互访，**管不到容器→宿主**，因此本模块在 WSL 宿主 netfilter 上落地隔离，执行者与下发时机如下：
   - **执行者**：daemon 进程启动时（boot 序列第 2 步，ping docker 之后）调用 iptables 管理例程 `HostNetGuard`，操作 WSL 内核的 `filter` 表；WSL 默认即有 root/sudo 可达 iptables（部署预检项，失败 fail-fast）。
   - **规则**：为自定义 bridge 网络 `dotd`（网关 IP 由 daemon 在创建网络后从 `GET /networks/{id}` 读取 `IPAM.Config[0].Gateway`，**不写死 172.17.0.1**——那是默认 docker0 的网关）建立一条链 `DOTD-OUT`：
     ```
     iptables -N DOTD-OUT
     iptables -A FORWARD -s <dotd网段> -d <dotd网关IP> -p tcp -m multiport --dports <白名单端口> -j ACCEPT   # 仅放行宿主侧本地模型 base_url 等
     iptables -A FORWARD -s <dotd网段> -d <dotd网关IP> -j DROP     # 阻断访问宿主 loopback 转发进来的所有服务
     iptables -A FORWARD -s <dotd网段> -d 127.0.0.0/8 -j DROP      # 防宿主服务经 DNAT 混入
     iptables -A FORWARD -s <dotd网段> -d <外网> -j ACCEPT         # 浏览器任务需出外网
     ```
   - **下发时机**：boot 时一次性安装（幂等：先 `-F DOTD-OUT` 再重写）；网络重建/网关变更（daemon 重启后 WSL IP 会变）时随 `docker_unavailable` 恢复流程重装；白名单端口集合由治理模块经 `setEgressWhitelist(ports)` 下发，默认空 = 只允许出外网、禁止一切宿主侧访问（含本地模型——本地模型双轨路由是阶段二项，届时由治理开启）。
   - 容器互访已由 ICC=false 禁止；`DOTD-OUT` 管容器→宿主方向。
3. **daemon → 容器方向**：HTTP over bridge 网容器 IP:9223，带 bearer token（容器启动时生成，见 §5.1）。不复用 docker.sock 做 exec-stream 协议，因为 HTTP+幂等 ledger 更可控、可断线重放。
4. **token 的宿主可读性（修订）**：token **不放 home 卷**（见 §5.1/§7——home 卷文件属主是镜像内 `dot` uid，宿主侧 daemon 若无 root 读 `/var/lib/docker/volumes` 会失败；且 Agent 可读 home 全部内容）。改为：daemon 在 **WSL 本地文件系统**（非 docker 卷）创建 `/var/lib/dotd/tokens/<dot_id>.token`（daemon 自己 `mkdir` 0700、属主为 daemon 用户），以 **bind mount 只读**方式挂进容器 `/run/dotd/token`（bind 属主冲突不存在——只读挂载，容器只读取）。这样宿主可读、Agent 可读但不可写、且不落 SQLite 明文。

### 2.2 docker.sock 访问的故障模式

| 故障 | 探测 | 处置 |
|------|------|------|
| WSL 未启动 / dockerd 挂 | 启动时与每 60s `GET /_ping`（dockerode ping） | 执行面进入 `docker_unavailable`（containers 表不改行状态，以模块级 `ExecFleet.degraded=true` 标志 + 事件表达），向控制面上报熔断事件；队列任务暂缓派发，不判失败；`runTool` 在此标志下**立即返回 `error{code:'docker_unavailable', retryable:true}` 不发送**——journal 侧保持 `call_sent` 未回执即可，无重复执行风险 |
| socket 权限（daemon 用户不在 docker 组） | 启动预检 | 启动失败并输出修复指引（`usermod -aG docker $USER`），fail-fast |
| docker API 版本漂移 | 固定 `DOCKER_API_VERSION=1.52`（实测 dockerd 29.1.3 即 API 1.52，min 1.44） | 版本不在 [1.44,1.52+] 区间时告警；`degraded` 下 runTool 行为同上（不再有单独的"只读模式"说法，统一为 degraded 闸门语义，§12 事件词表不变） |

---

## 3. 镜像构建

### 3.1 Dockerfile（模板，落库路径 `dotd-design/exec-image/Dockerfile`）

```dockerfile
# 基座：Playwright 官方镜像（浏览器+依赖已就绪），版本双固定
ARG PW_VERSION=1.49.1-noble          # 与 package.json 的 playwright 严格同版本
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-noble

# headed 模式所需：官方镜像不自带 Xvfb，显式安装（apt 层在 root 阶段做）
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb bash \
    && rm -rf /var/lib/apt/lists/*

# 构建参数注入 agent-runtime 源码（构建上下文由宿主 daemon 打 tar 流式传入，不落镜像仓库）
COPY agent-runtime/ /opt/agent-runtime/
# tsc 属 devDependency，--omit=dev 会导致 npx tsc 失败；用两阶段装依赖或显式安装构建工具：
RUN cd /opt/agent-runtime \
    && npm ci --include=dev \
    && ./node_modules/.bin/tsc -p . \
    && npm prune --omit=dev

# 非 root 运行；**显式创建挂载点目录并 chown**：useradd -m 只建 /home/dot，
# 若不预建 /dot/home、/dot/profiles、/opt/agent-state，Docker 挂载 named volume 时会以 root
# 创建挂载点，新卷属主继承 root → 容器内 USER dot 无法写 home/profile/state（token、ledger、笔记全失败）。
# shell 用户（uid 1001，§7.1）在此预建；state 卷 0700 属主 1000，跨 uid 挡住 shell。
RUN useradd -m -u 1000 dot \
    && useradd -M -u 1001 shell \
    && mkdir -p /dot/home /dot/profiles /opt/agent-state /run/dotd \
    && chown dot:dot /dot /opt/agent-state /run/dotd && chmod 700 /opt/agent-state \
    && chown -R dot:dot /opt/agent-runtime
USER dot
ENV HOME=/dot/home PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    DISPLAY=:99
VOLUME ["/dot/home", "/dot/profiles"]
EXPOSE 9223
ENTRYPOINT ["node", "/opt/agent-runtime/dist/server.js"]
```

镜像内容 = agent-runtime（工具协议服务器）+ 浏览器二进制 + Xvfb。**每 Dot 不定制镜像**——身份差异全在卷里，镜像全局唯一、可缓存复用（磁盘约束 CONTEXT.md:37 的决定性设计）。

> Xvfb 由 agent-runtime 启动时自行拉起（`xvfb-run` 或 spawn `Xvfb :99`，见 §6.1），非 Docker init 进程。

### 3.2 构建流程（`ImageManager`）

```
ensureImage():
  tag = "dotd/exec:{PW_VERSION}-{runtimeVer}"
  if docker images 已含 tag 且 image_builds 有该 tag 的 status='ready' 行 → return (digest)
     # 镜像全局唯一，image_builds 无 dot_id 列（修订：不再有 dot_id='*' 的说法）
  acquire build lock（进程内互斥，防并发双建）
  ctxTar = tar(Dockerfile, agent-runtime/)           # 内存流，不写盘
  buildStream = docker.buildImage(ctxTar, {t: tag, buildargs: {PW_VERSION}})
  逐行日志写 journal 事件（控制面 EventBus.emit('exec.image.build', line)）
  成功: INSERT image_builds(..., status='ready', digest); 触发 §8 镜像回收（删旧 tag）
  失败: UPDATE image_builds status='failed'，容器生命周期状态机进 build_failed
```

---

## 4. 容器生命周期状态机

### 4.1 状态定义（`containers.state`，每 Dot 至多一行活跃记录，由 DDL 的部分唯一索引强制——见 §9）

```
absent ──ensureImage──▶ image_ready ──create──▶ created ──start──▶ booting
   ▲                                                │                  │healthcheck OK
   │destroy/reap                                    │create fail       ▼
   │                                              ▼                ready ◀──▶ busy
   │                                          create_failed    (空闲)   │  │
   │                                                                   │  ▼
   └────── removed ◀──stop──── idle_stop_requested ◀──suspend_timeout── idle
                │                    (SIGTERM→KILL 10s)      │
                └─ unhealthy / lost（reconcile 发现 docker 侧已消失）
                                               unhealthy ──recreate──▶ booting
                                               unhealthy(再失败) ──▶ quarantined（终态，人工解）
```

| 状态 | 含义 | 进入条件 | 出口 |
|------|------|---------|------|
| `absent` | 无容器记录或已 removed | 初始 / 销毁后 | ensureImage |
| `image_ready` | 镜像就绪 | 构建成功 | create |
| `created` | 容器已创建未启动 | docker create 成功 | start |
| `booting` | 已启动，等 token+healthcheck | start 成功 | 30s 内 healthcheck 通过→ready；超时→unhealthy |
| `ready` | 可接工具调用 | healthcheck OK | 领取调用→busy；空闲超时→idle |
| `busy` | 至少一个工具调用 in-flight | 派发调用 | 全部完成→ready |
| `idle` | 空闲计时中（默认 15 min） | ready 无流量 | 新调用→ready；超时→suspend |
| `suspended` | 容器 `docker pause`（冻结进程，保留内存页与挂载） | idle 超时 | resume→ready；resume 失败→recreate |
| `idle_stop_requested` | 阶段二"深度节能"：pause 之外再 stop（释放内存配额），卷保留 | suspend 后再超配置阈值（默认关闭） | 新调用→booting（start） |
| `stopped` | `docker stop`，等待 30s 内被同参数重建复用 | 显式停止 / 资源驱逐 | recreate→booting |
| `unhealthy` | healthcheck 连续 3 次失败 / booting 超时 | 监视器 | 一次自动 recreate；再失败→quarantined |
| `quarantined` | 熔断隔离：不再自动拉起（recreate>3 次/24h 或 recreate 后仍 unhealthy） | §13.2 | 人工 resume / 主人决策（发 S6 求救事件） |
| `create_failed/build_failed` | 终态（本轮），上报控制面 | — | 人工或重试策略驱动回 absent |
| `lost` | reconcile 发现 docker 侧容器消失（人工 `docker rm`） | §13.1 | 视为 removed，走 recreate |

**`suspended` 与 `idle_stop_requested` 的取舍（修订：消除图中/表中矛盾）**：默认路径是 `idle → suspended（docker pause）`——pause 冻结进程、内存仍计入 cgroup 但 CPU 归零，恢复最快（毫秒级）；`idle_stop_requested → stopped` 是**可选的第二档节能**（pause 后仍空闲超时才 stop，释放内存给闸门，恢复要重跑 booting）。两者不冲突：状态机里 idle 的直接后继是 suspended，`idle_stop_requested` 仅在 `deep_stop_after_s`（默认 0=关闭）启用时由 suspended 进入。§4.3 闸门驱逐用的是 stop 路径（要真正释放内存预算）。

**崩溃安全（daemon 重启不丢队列，CONTEXT.md:49）**：daemon 启动时执行 reconcile（§5.4），以 `docker ps -a` 过滤 `label.dotd.managed=1` 为准，把 SQLite `containers` 表与 docker 实况对齐，不重复 create。

### 4.2 容器创建参数（伪码，全部常量集中 `execConfig`）

```ts
const spec = {
  Image: image.digest,
  name: `dotd-dot-${dotId}`,
  Hostname: `dot-${dotId}`,
  Env: [`DOTD_TOKEN_PATH=/run/dotd/token`, `DOTD_MEM_BUDGET_MB=${lim.memMb}`, ...],
  Labels: { 'dotd.managed': '1', 'dotd.dot': dotId, 'dotd.runtime': runtimeVer },
  HostConfig: {
    NetworkMode: 'dotd',
    Memory: lim.memMb * 1048576,          // 硬上限，默认 1536MB（§6）
    MemorySwap: lim.memMb * 1048576,      // swap=mem ⇒ 禁 swap，防把 WSL 内存拖垮
    NanoCpus: lim.cpuMillis * 100_000,    // 修订：1 mCPU = 100,000 nanoCPU；2000m → 2e8 nano = 2 核
                                          // 默认 2000m；72 核双 group，容器由 dockerd 调度，
                                          // 亲和性问题（CONTEXT.md:33）留给 dockerd；若需锁定组，
                                          // 运维层用 taskset 包 dockerd，本模块不处理
    PidsLimit: 512,
    Binds: [`dot-${dotId}-home:/dot/home`,
            `dot-${dotId}-profiles:/dot/profiles`,
            `dot-${dotId}-state:/opt/agent-state`,          // ledger 独立卷（§7.1），属主 1000/0700
            `/var/lib/dotd/tokens/${dotId}.token:/run/dotd/token:ro`], // token 只读 bind，§2.1-4
    Tmpfs: { '/tmp': 'size=256m,exec' },  // 下载/缓存临时区有硬顶
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } }, // 日志≤20MB/容器
    RestartPolicy: { Name: 'no' },        // 由本模块监督重启，防 docker 自动拉起绕过状态机
    OomScoreAdj: 700,                     // 与 netfuzz 共存：内存压力时我们先被 OOM，
                                          // 保护现有负载（CONTEXT.md:35）
    Privileged: false, ReadonlyRootfs: true,
    CapDrop: ['ALL'], CapAdd: ['SETUID','SETGID'],  // 修订：runtime(1000) spawn shell(1001) 所需（§7.1）
    SecurityOpt: ['no-new-privileges:true'],
  },
  NetworkAttach: { 'dotd': { Aliases: [`dot-${dotId}.exec`] } },
};
```

`ReadonlyRootfs: true` + 仅 `/dot/*`、`/tmp` 可写：浏览器 profile 全在卷上，可写层永远近零 → 从根上消灭"容器层吃盘"问题。npm 运行时需写的目录（如 `~/.npm`）通过额外 tmpfs 或预打进镜像解决。

### 4.3 资源闸门（与 netfuzz 共存策略）

```
GlobalScheduler（宿主 daemon 内单例）:
  maxActiveContainers   = 2        # MVP 单 Dot，配置上限留余量
  maxMemBudgetTotalMb   = 4096     # 全系统容器内存硬预算；WSL 64G 减 netfuzz~20G 减 daemon 后仍宽裕
  admit(containerSpec):
    if activeCount >= maxActiveContainers → 排队（任务留在队列，状态 pending_exec，不算失败）
    if memCommitted + spec.mem > maxMemBudgetTotalMb → 排队
    每次放行前读 /proc/meminfo（WSL 宿主可见）: MemAvailable < 4GB → 拒绝新容器并触发驱逐最老 idle 容器
```

驱逐顺序：`idle/suspended(超预算)` → `stop`（进 stopped，卷保留；若 deep stop 已 stop 则 `docker rm` 记录保留参数）→ 绝不杀 `busy` 容器（等在跑调用完成或超时）。

---

## 5. 宿主 ↔ 容器工具调用协议

### 5.1 认证

token 由**宿主 daemon 生成**（修订，取代原"容器生成写 home 卷"方案）：`ensureContainer` 前 daemon 在 `/var/lib/dotd/tokens/<dot_id>.token` 写入 32 字节随机 token（属主 daemon 用户、0600），以只读 bind 挂入容器 `/run/dotd/token`。agent-runtime 启动时读取；healthcheck 响应不回显 token。daemon 同时把 SHA-256 存 `containers.token_hash`（明文只存该 bind 文件，不落 SQLite）。所有请求带 `Authorization: Bearer <token>`。容器 recreate 时 daemon **重新生成并轮换** token，旧 token 调用一律视为中断（§5.5）。

### 5.2 端点总表（agent-runtime 监听 0.0.0.0:9223）

| 方法 | 路径 | 语义 |
|------|------|------|
| GET | `/healthz` | `{state:'ok', version, uptime, mem_used_mb, token_epoch}` |
| POST | `/tools/call` | 同步短调用（**能力目录 `mode='sync'` 的工具**：fs.*、browser.snapshot 等），HTTP 响应即终态 |
| POST | `/jobs/start` | 异步长调用（`mode='async'` 的工具：shell.run、browser.open/act 序列），返回 `job_id` |
| GET | `/jobs/{job_id}` | 轮询 `{state, call_id, events[], result?, error?}` |
| GET | `/calls/{call_id}` | **按 call_id 取回任意调用（含同步）的终态**——读 ledger 的 done 项重放 result（§5.4 reconcile 用，修订新增） |
| POST | `/jobs/{job_id}/cancel` | 协作式取消（进程 SIGTERM / 页面 close） |
| DELETE | `/jobs` | 清理已结束 job 记录 |
| GET | `/capabilities` | 工具目录：每项 `{name, mode:'sync'|'async', max_deadline_ms, args_schema}`（供治理做权限映射、供 ExecService 决定派发端点） |

同步/异步的判据：**工具属性决定，不由时长猜测**。`CapabilityCatalog`（§10）中每个工具声明 `mode`；agent-runtime 对 sync 工具强制 `deadline_ms ≤ 60_000`，超限在 `/tools/call` 直接返回 `error{code:'deadline_too_long_for_sync'}`；ExecService 严格按 catalog 选端点。fs 工具 catalog 里 mode='sync'（fs.read ≤4MB 本地读，60s 足够），shell/browser 为 'async'。

### 5.3 请求/响应类型（`types/protocol.ts`，宿主与容器共用）

```ts
export type ToolCall = {
  call_id: string;        // ULID，调用方(控制面 journal)生成，全局唯一，幂等键
  task_id: string;        // 对账/审计透传，容器不理解
  dot_id: string;
  identity?: string;      // 浏览器类工具必填：profile 身份键（顶层字段，S5 契约以此为准）
  tool: ToolName;         // 'fs.read'|'fs.write'|'fs.list'|'fs.stat'|'shell.run'
                          // |'browser.open'|'browser.act'|'browser.snapshot'|'browser.close'
  args: Record<string, unknown>;
  deadline_ms: number;    // 硬超时，容器端强制
  issued_at: string;      // ISO8601
};
export type ToolResult = {
  call_id: string;
  job_id?: string;        // async 调用回执携带，ExecService 落 exec_calls.job_id（对账/取消键）
  status: 'ok' | 'error' | 'cancelled' | 'running';   // running 仅 /jobs/{id}
  result?: unknown;        // 工具自定义 JSON（fs.read 含 content_base64 上限 4MB）
  error?: { code: string; message: string; retryable: boolean };
  usage?: { wall_ms: number; peak_mem_mb: number };
  finished_at?: string;
};
```

### 5.4 幂等 ledger 与中断语义（协议核心，修订版）

agent-runtime 在 **state 卷**维护 append-only JSONL：`/opt/agent-state/ledger.jsonl`（卷挂载见 §4.2 Binds；ledger 与 token 均已移出 Agent shell 可达写路径，防护见 §7.1）。

```
handleCall(call):
  rec = ledger.get(call.call_id)
  if rec 存在:
     if rec.state == 'done'  → 直接重放 rec.result（/jobs/{id} 与 /calls/{call_id} 同语义）
     if rec.state == 'doing' → 返回 status='running' + 现有 job_id（调用方继续轮询）
     if rec.state == 'aborted'(启动时清理所得) → 返回 error{code:'interrupted', retryable:true}
  ledger.append({call_id, state:'doing', started_at, tool, args_hash: sha256(args)})
  dispatch → 完成时 append {call_id, state:'done', result_json}
```

**关键修订——中断（interrupted）只对"未完成"的调用成立，绝不覆盖已完成**：

1. 容器进程重启（含 recreate）时，agent-runtime 启动扫描 ledger：`state=='doing'` 的项改标 `aborted`；**`state=='done'` 的项原样保留**。home 卷跨 recreate 持久，因此 recreate 后 daemon 用旧 `call_id` 查 `GET /calls/{call_id}`，done 项**重放 result**，journal 得到确认 → **不会重派 → 不会二次执行**。这是"绝不重复执行"（CONTEXT.md:44）在 recreate 场景的闭环。
2. recreate 换 token 后 daemon 仍可查询 `/calls/*`（新 token 授权同一 ledger，ledger 属于 dot 不属于某代容器）。仅当 ledger 本身丢失（home 卷被清/换机）才落入"done 无从证明"的兜底：按 `exec_calls.state ∈ ('sent','running')` 且无回执报 `interrupted`，journal 决定是否重派——这是不可消除的最坏情形，文档如实声明。
3. **reconcile（daemon 侧）**：容器 booting→ready 后，对该 dot `exec_calls` 中 `state IN ('sent','running')` 的行逐个查 `GET /calls/{call_id}`：done→取回 result 落库回报 journal；doing→取 job_id 续轮询；aborted/404→标 `interrupted` 回报控制面。**重派决策（换新 call_id）属于 journal，不属于 exec；exec 永不自动重试。**
4. **ledger 压缩与重放的冲突消解（修订）**：超 5000 行时只压缩"**已被控制面确认的 done 项**"——压缩 = 将 `result_json` 替换为 `result_hash` + 标记 `compacted:true`，call_id/state 保留。重放路径对 compacted 项返回 `error{code:'result_compacted', retryable:false, hash}`；ExecService 收到即回报控制面"该调用确认幂等成功但结果不可取回"，journal 视同 done-但-降级（能确认"没有二次执行"这条底线，结果丢失由任务语义层处理）。未确认的 done 项**永不压缩**——先确认、后瘦身，保证重放窗口。

### 5.5 关键调用时序（shell.run）

```
控制面 journal: INSERT call_sent(call_id) ─▶ ExecService.runTool(call)
  ExecService: 状态机 ready→busy；查 catalog: shell.run.mode='async' → POST /jobs/start
               (Bearer token, idempotency-key=call_id) → 回执 job_id → UPDATE exec_calls
  agent-runtime: bash -c args.cmd, cwd=/dot/home, env 剥离 DOTD_* 且 /run/dotd、/dot/home/.dotd
                 对 shell 不可见（§7），独立进程组, 输出流式截尾(各 1MB)，args.timeout_ms≤deadline
  ExecService: 轮询 /jobs/{id} 至 done/error/deadline；deadline 到→cancel→标 timeout
  journal: UPDATE call_done(call_id, result_hash) ─▶ 状态机 busy→ready
  失败路径: 连接拒绝/5xx → healthcheck 探测 → 连续3败 标 unhealthy → recreate →
            进行中的调用按 §5.4 reconcile：done 取回、aborted 报 interrupted
```

---

## 6. Playwright + stealth 浏览器管理

### 6.1 结构

- Xvfb 由 agent-runtime 启动时 spawn（`Xvfb :99`，`DISPLAY=:99`），随进程存活，崩溃视同 runtime 崩溃（healthcheck 失败→recreate）。
- 浏览器由 agent-runtime 内的 `BrowserHolder` 单例持有（**进程级复用**，跨调用不重开 chromium）。
- stealth 注入：`playwright-extra` + `puppeteer-extra-plugin-stealth/evasions/*`（版本锁进 package-lock），在 `newContext/launchPersistentContext` 时启用；阶段三增强只替换注入实现，不改协议。
- **每身份一个 persistent context**：`chromium.launchPersistentContext('/dot/profiles/<identity>/', { ... })`——profile 目录即卷内子目录，天然持久（登录态、cookie、storage 全落卷）。

```ts
// BrowserHolder（agent-runtime 内）
const MAX_CONTEXTS = 2;          // 每容器并发身份上限
const MAX_PAGES_PER_CTX = 3;     // 每 profile 并发页面上限
async acquire(identity: string): Promise<Context> {
  const key = identityHash(identity);            // sha256(identity).slice(0,16)，防目录名注入
  if (this.ctxs.has(key)) return touch(key);
  if (this.ctxs.size >= MAX_CONTEXTS) await this.evictLRU();      // 关最久未用 context
  if (memUsedMb() > budgetMB * 0.8) await this.hardReset('mem_highwater'); // 全关重开 chromium
  const ctx = await chromium.launchPersistentContext(
    `/dot/profiles/${key}`, {
      headless: false,                            // headed，经 §6.1 自拉的 Xvfb :99
      args: ['--disable-dev-shm-usage',           // /dev/shm 小，必关
             `--js-flags=--max-old-space-size=${perCtxJsHeapMB}`,
             '--no-sandbox=false', ...stealthArgs],
      viewport: { width: 1280, height: 900 },
    });
  this.ctxs.set(key, wrap(ctx)); return ctx;
}
```

### 6.2 内存上限的三层防线

| 层 | 机制 | 数值（默认，`execConfig.limits`） |
|----|------|------|
| 容器 | docker `Memory`+禁 swap，OOM 即整容器重启，状态机 recover | 1536 MB |
| chromium | `BrowserHolder` 高水位 80% 触发 `hardReset`（关所有 context→关浏览器→重开）；profile 卷内数据不丢 | budget×0.8 |
| 进程/信号 | 每个 context 记 RSS 采样（每 5s），单 context 存活 >30 min 且非 busy → 强制回收 | — |

浏览器崩溃（chromium process exit）：context 标脏，下一次 `browser.*` 调用前自动重开；当前调用返回 `error{code:'browser_crashed', retryable:true}`。

### 6.3 生命周期约束

- `browser.close(identity)`：关 context，profile 留卷上。
- 容器进入 `idle→suspended` 时 `docker pause` 会冻结 chromium 进程，安全；恢复后 healthcheck 先验浏览器。
- 容器被删（recreate/驱逐）时所有 context 随进程消失，profile 卷无损。

---

## 7. /dot/home 文件与 shell 工具

工具语义（读时/写时契约）由记忆模块定义，本模块提供实现：

| 工具 | 行为 | 护栏（本模块强制） |
|------|------|------|
| `fs.read` | 返回 UTF-8 文本或 base64 | 路径解析后必须 `startsWith('/dot/home/')`；拒绝 symlink 逃逸（`realpath` 双查）；单文件 ≤4MB |
| `fs.write` | 覆盖写，自动建父目录 | 同上；写 home 卷；单文件 ≤8MB |
| `fs.list` / `fs.stat` | 目录枚举/mtime/size | 同上，深度 ≤4 |
| `shell.run` | `bash -c`（修订：不再是 `bash -lc`），cwd=/dot/home | 超时必填；输出各截 1MB；**env 白名单**（`PATH,HOME,LANG,DISPLAY`+注入的模型 base_url 变量，`DOTD_*` 全剥）；**秘密防护见下**；进程组隔离可 kill；无 tty |

### 7.1 秘密与 ledger 对容器内 shell 的等效防护（修订）

`.dotd/` 只对 `fs.*` 工具隐藏是**不够的**——shell 是 `bash -c`，同 uid 可直接读写 home 卷任意文件。修订为"移出 Agent 可写路径"而非"目录名隐藏"：

| 秘密 | 位置与防护 | shell 可否触及 |
|------|-----------|----------------|
| **token** | 已移出 home 卷：bind `/run/dotd/token:ro`（§5.1），文件 0400 属主 dot(1000)；agent-runtime 启动时读入内存。shell 子进程 uid=1001 → **POSIX 权限即挡住读**。即便被读到，token 也仅能冒用本容器自己的 HTTP——不授予任何容器外权限（宿主侧 REST 不用它，docker.sock 不暴露），且冒用发调用仍受幂等 ledger 保护，不会二次执行工具体。爆炸半径声明于此，作为接受的设计 | 不可读（0400 跨 uid）；不可写（ro bind） |
| **ledger** | 已移出 home 卷：agent-runtime 写 `/opt/agent-state/ledger.jsonl`——ReadonlyRootfs 下不能写镜像层，故用**独立 named volume `dot-<id>-state` 挂载于 `/opt/agent-state`（rw，属主 uid 1000 runtime，0700）**，与 home 卷分离。shell 子进程 uid=1001 → 跨 uid 权限挡住读写（0700 dot）。`docker exec` 类通道不存在，HTTP 是唯一入口。setuid 能力：agent-runtime 需 `CapAdd:['SETUID','SETGID']`（非 ALL，仅这两项；§4.2 CapDrop 的唯一例外），spawn shell 时 setuid(1001)。**依赖实测，见开放问题 Q7** | 不可读不可写（0700 跨 uid） |
| **`.dotd/` 历史遗留** | fs.* 工具的隐藏规则保留为纵深防御（即便迁移后 home 内不再有秘密，仍隐藏 `/dot/home/.dotd` 前缀） | — |

> 本节结论：**shell 与 runtime 不同 uid**（shell=1001，runtime=1000），秘密文件 0700/0400 + ro bind，配合 `CapAdd:[SETUID,SETGID]`（替代原 `CapDrop:[ALL]` 全量，其余 cap 仍全 drop）。§4.2 的 HostConfig 相应改为 `CapDrop:['ALL'], CapAdd:['SETUID','SETGID']`。fs.* 工具由 runtime 进程（uid 1000）直接执行，不经 shell，路径约束不变。

home 卷同时承载：主人的笔记与 Agent 工作文件。state 卷（`dot-<id>-state:/opt/agent-state`，含 ledger）与 home 分离，DiskGardener 白名单同样登记（§8/§9 `exec_volumes.kind` 增 `'state'`）。`.dotd/` 前缀保留给 exec 的语义改为"state 卷"。

---

## 8. 磁盘占用上限与回收

预算默认值（全部进 SQLite `exec_disk_policy`，可被 Web UI 配置覆盖）：

| 对象 | 上限 | 回收机制 |
|------|------|---------|
| 镜像 | 2 个 tag（当前+上一版） | 构建成功后 `docker image prune` 旧 `dotd/exec:*`（保留 digest 引用中的除外） |
| home 卷 | 2 GB/Dot | 超限告警事件 `exec.disk.pressure{volume}`；**不自动删**（记忆数据主权归记忆模块+主人），由清理流程（记忆模块）处理 |
| profile 卷 | 2 GB/Dot | 自动可清理项：`*/Default/{Cache,Code Cache,GPU Cache,Service Worker}` + `*/Crashpad` → 水位 80% 时 `BrowserHolder` 空闲期调用容器内 `cleanProfileCaches()`（unlink，context 关闭时才清）；清完仍超 → 告警 |
| state 卷（ledger） | 64 MB | ledger 压缩（§5.4-4）；超限仅告警 |
| /tmp（tmpfs） | 256 MB | 随容器重启自动清，无需回收 |
| 可写层 | ≈0 | `ReadonlyRootfs` 结构性保证 |
| 容器 json 日志 | 20 MB | `max-size/max-file` 滚动，docker 自管 |
| 系统级 | `df` 检查 WSL 数据盘 free < 5 GB 触发 `DiskGardener` | 顺序：prune dangling 镜像 → `docker builder prune -f` → prune 无主卷（**排除**在册 home/profile/state 卷，白名单来自 `exec_volumes` 表）→ 清 profile 缓存；每步发事件 |

`DiskGardener` 每 6h cron + 每次镜像构建后各跑一次；全程串行、可被 busy 容器让路（只动非 busy 对象）。

---

## 9. 核心数据结构（SQLite DDL，控制面库内本模块所有表）

```sql
-- 每个 Dot 的执行面档案（dot 主档归控制面，此处仅执行视角扩展行）
CREATE TABLE IF NOT EXISTS exec_dots (
  dot_id        TEXT PRIMARY KEY,              -- 与控制面 dots 表 FK 同键
  runtime_ver   TEXT NOT NULL,                 -- agent-runtime 版本，参与 tag 计算
  limits_json   TEXT NOT NULL,                 -- {memMb,cpuMillis,homeQuotaMb,profileQuotaMb}
  idle_timeout_s INTEGER NOT NULL DEFAULT 900,
  deep_stop_after_s INTEGER NOT NULL DEFAULT 0,     -- 0=关闭二级节能（§4.1）
  enabled       INTEGER NOT NULL DEFAULT 1
);

-- 镜像构建记录（镜像全局唯一，无 dot 维度）；当前生效 = status='ready' 的最新行
CREATE TABLE IF NOT EXISTS image_builds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tag         TEXT NOT NULL,
  digest      TEXT,                            -- sha256:...
  pw_version  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('building','ready','failed','superseded')),
  log_tail    TEXT,
  started_at  TEXT NOT NULL, finished_at TEXT
);

-- 容器生命周期实例（状态机 §4.1 的持久化；reconcile 的对账单据）
CREATE TABLE IF NOT EXISTS containers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id             TEXT NOT NULL REFERENCES exec_dots(dot_id),
  docker_container_id TEXT,                    -- docker 侧 64 位 id，NULL=尚未 create
  state              TEXT NOT NULL CHECK (state IN
   ('absent','image_ready','created','booting','ready','busy','idle',
    'suspended','idle_stop_requested','stopped','quarantined',
    'unhealthy','create_failed','build_failed','removed','lost')),
  endpoint           TEXT,                     -- http://IP:9223
  token_hash         TEXT,                     -- sha256(Bearer)，明文只存 bind 文件，不落库
  last_health_at     TEXT, last_busy_at TEXT,
  recreate_count     INTEGER NOT NULL DEFAULT 0,   -- 超 3 次/24h → quarantined 并求救
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_containers_state ON containers(state);
-- 「每 Dot 至多一行活跃」由部分唯一索引强制（修订）：
-- 活跃 = 非 removed/lost；create 前 docker_container_id 为 NULL，原 UNIQUE(dot_id, docker_container_id)
-- 因 SQLite NULL≠NULL 不互斥，无法挡双活跃行。
CREATE UNIQUE INDEX ux_containers_active_dot ON containers(dot_id)
  WHERE state NOT IN ('removed','lost');

-- 身份 → profile 映射（identity 明文只存 hash，目录名用 hash）
CREATE TABLE IF NOT EXISTS exec_identities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dot_id       TEXT NOT NULL REFERENCES exec_dots(dot_id),
  identity_key TEXT NOT NULL,                  -- 语义身份名（如 'main'/'work'），控制面/治理引用
  profile_hash TEXT NOT NULL,                  -- sha256(identity_key)[0:16]
  last_used_at TEXT,
  UNIQUE (dot_id, identity_key)
);

-- 卷台账（DiskGardener 的白名单依据；防误删）
CREATE TABLE IF NOT EXISTS exec_volumes (
  name        TEXT PRIMARY KEY,                -- dot-<id>-home / dot-<id>-profiles / dot-<id>-state
  dot_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('home','profiles','state')),
  quota_mb    INTEGER NOT NULL,
  usage_mb    INTEGER,                         -- 最近一次 du
  created_at  TEXT NOT NULL
);

-- 幂等对账的宿主侧镜像（容器 ledger 的投影，journal 模块可 JOIN）
CREATE TABLE IF NOT EXISTS exec_calls (
  call_id    TEXT PRIMARY KEY,                 -- 控制面 journal 生成的 ULID
  job_id     TEXT,                             -- 修订：async 回执，对账续轮询与 cancel 的键
                                               -- （GET /jobs/{job_id}、POST /jobs/{job_id}/cancel、
                                               --   reconcile 都经 call_id→job_id 映射到达）
  task_id    TEXT NOT NULL,
  dot_id     TEXT NOT NULL,
  tool       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('sync','async')),
  args_hash  TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN
              ('sent','running','done','error','cancelled','interrupted')),
  result_hash TEXT, error_code TEXT,
  sent_at    TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX idx_exec_calls_task ON exec_calls(task_id);
CREATE INDEX idx_exec_calls_open ON exec_calls(state)
  WHERE state IN ('sent','running');
CREATE INDEX idx_exec_calls_job ON exec_calls(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exec_disk_policy (
  key TEXT PRIMARY KEY, value_mb INTEGER NOT NULL, updated_at TEXT NOT NULL
);
```

> `exec_calls` 与任务 journal 的关系是**接缝**（§11），不是重复记账：journal 记"任务步骤语义"，exec_calls 记"协议层发送/回执"，以 `call_id` 外键对齐；journal 对 `interrupted` 的处置（重派新 call_id）由控制面决定。

---

## 10. 对外接口（TypeScript 签名，控制面同进程内调用 + 对 Web UI 的 REST 映射）

```ts
// ── ExecService：控制面唯一入口（daemon 进程内） ─────────────────
export type Capability = {
  name: string;
  mode: 'sync' | 'async';        // 派发端点判据（§5.2）
  max_deadline_ms: number;       // sync: 60_000；async: 全局 deadline 上限
  args_schema: object;           // JSON Schema，治理建权限映射、审批卡片渲染用
};

export interface ExecService {
  /** daemon 启动（修订：顺序统一为 §13.1 —— ping → ensureImage → HostNetGuard → reconcile →
   *  对缺失容器 create/boot。ensureImage 先行，reconcile 的 recreate 分支才能在 boot 内闭环，
   *  否则 lost 容器要等第二次 tick 才有镜像可用） */
  boot(dotIds: string[]): Promise<BootReport>;

  /** 派发一个已放行调用；非阻塞，resolve 于终态 ToolResult 或 deadline。
   *  端点选择：catalog[call.tool].mode，不看时长。 */
  runTool(call: ToolCall): Promise<ToolResult>;

  /** 取消进行中调用（治理/任务超时驱动）；幂等。
   *  sync 工具无 job_id → 只标本地 timeout，不强杀（fs 秒级，不值得）；
   *  async 工具查 exec_calls.job_id → POST /jobs/{job_id}/cancel */
  cancelTool(callId: string, reason: string): Promise<void>;

  getCapabilities(dotId: string): Promise<Capability[]>;

  /** 治理下发宿主侧出站白名单端口（§2.1-2）；boot 时重装同样走这里缓存的策略 */
  setEgressWhitelist(ports: number[]): Promise<void>;

  // 生命周期手动控制（Web UI/CLI）
  suspendDot(dotId: string): Promise<void>;
  resumeDot(dotId: string): Promise<void>;
  destroyDotContainer(dotId: string, opts: { keepVolumes: boolean }): Promise<void>; // 卷默认保留
  getDotStatus(dotId: string): Promise<DotExecStatus>;   // state/资源/浏览器/磁盘 快照
  setIdentityProfile(dotId: string, identityKey: string): Promise<{profileHash: string}>;

  // 事件流（实现 = 直接调控制面 EventBus）
  // 发出：exec.container.{state_change,unhealthy,quarantined}
  //       exec.call.{started,finished,interrupted}
  //       exec.browser.{crashed,reset}
  //       exec.disk.{pressure,gardened}  exec.docker.unavailable
}
```

容器 agent-runtime 内部接口 = §5.2 端点表，无对外 TS 依赖共享以外的耦合。

---

## 11. 与其他模块的接缝（契约，供仲裁）

| # | 接缝 | 约定 |
|---|------|------|
| S1 | 控制面 journal | journal 生成 `call_id`（ULID）并先写本地 `call_sent`，再调 `runTool`。exec 保证：同 `call_id` 至多执行一次工具体；done 结果跨 recreate 可经 `GET /calls/{call_id}` 重放，journal 确认前 exec 不压缩其 result（§5.4-4）。`runTool` 的返回必须被 journal 落库后才可派发下一步。exec 重启/容器 recreate 后**先 reconcile 取回 done，取不到的才报 `interrupted`**，exec 永不自动重试 |
| S2 | 治理/审批 | 治理在 `runTool` 前完成放行；exec 无条件强制的硬护栏清单（不受审批影响）：home 路径约束、shell 独立 uid 隔离秘密（§7.1）、资源上限、deadline 上限。`getCapabilities` 的工具名 + mode 是权限分级与派发路由的唯一词表，exec 增删工具必须版本化（`runtime_ver` 变更） |
| S3 | 记忆模块 | 物理契约：`/dot/home` 在容器重建后路径与内容不变；**exec 的秘密与 ledger 已迁至独立 state 卷 `/opt/agent-state`，不再占用 home 内 `.dotd/`**（fs 工具仍默认隐藏该前缀作纵深防御，但 home 内无 exec 秘密）；`fs.write` 是记忆"任务结束时写笔记"的实现体；home 卷 2GB 超限后 exec 只告警不删除，删除动作属于记忆模块的流程 |
| S4 | 交互面（Web UI/CLI） | daemon REST 暴露 `GET /api/exec/dots/:id`、`POST .../suspend|resume`、`GET /api/exec/capabilities`、`GET /api/exec/disk`；数据源全为 `containers/exec_volumes/exec_disk_policy` 表，UI 不直连容器 |
| S5 | 模型路由/治理 | 应急模式"浏览器登录态操作强制转审批"（CONTEXT.md:30）的判定谓词（**修订，仲裁统一**）：`tool.startsWith('browser.') && ToolCall.identity != null` ——身份是 **ToolCall 顶层字段 `identity`**（§5.3），**不存在 `args.with_identity`**；治理必须按此字段判定。exec 保证 identity 透传并在审计中落 `exec_identities.identity_key` 名 |
| S6 | 求救通道 | 熔断语义：`recreate_count > 3/24h → quarantined`、`docker_unavailable` 持续 >5min、磁盘 free <2GB → exec 发 `exec.quarantined / exec.docker.unavailable / exec.disk.pressure{critical}` 事件，由控制面求救模块按"同故障 24h 一次"限频（CONTEXT.md:28） |
| S7 | 事件入口/心跳 | 无直接依赖；容器内进程心跳不外出，宿主侧 healthcheck 轮询即心跳 |

---

## 12. 遵守的 CONTEXT 约束清单

| CONTEXT 出处 | 落实 |
|---|---|
| 每 Dot 一个 Docker 容器（md:20） | §4，一 Dot 一 container 记录，部分唯一索引强制单活跃行 |
| Playwright+stealth（md:20） | §6.1 playwright-extra+stealth，注入点版本锁 |
| 每身份持久浏览器 profile 卷（md:20,44） | §4.2 binds + §6.1 persistentContext per identity |
| /dot/home 文件记忆卷（md:20,21） | §7 路径/配额/持久性契约（秘密已迁出，S3） |
| daemon 跑 WSL 内、宿主无 docker（md:34） | §2.1 unix socket 直连，Windows 侧零 docker 暴露 |
| 与 netfuzz ~20GB 负载共存、不可假设独占（md:35） | §4.3 全局内存预算闸门、MemAvailable 探测、OomScoreAdj=700 让位策略、§2.1-2 iptables 隔离宿主侧端口 |
| 72 核 processor group（md:33） | §4.2 注释：容器 CPU 调度交 dockerd，亲和性属运维层（列开放问题 Q4）；NanoCpus=cpuMillis×100000 换算已修正 |
| C:/D: 盘小（md:37） | §8 全链路配额 + ReadonlyRootfs + tmpfs + Gardener |
| 崩溃安全步骤级 journal、绝不重复执行（md:44） | §5.4 幂等 ledger（done 跨 recreate 可重放）+ reconcile，S1 |
| 重启不丢队列/serve 常驻（md:49） | §4.1 末 + §13.1 reconcile 设计 |
| 应急模式登录态转审批（md:30） | S5：`ToolCall.identity` 顶层字段，谓词统一 |
| 求救限频（md:28） | S6 事件词表 |
| 不上 QEMU/VM（md:44） | 全容器路线，零 VM 代码 |
| 阶段划分（md:51,53） | MVP 用 §6 数值与单容器闸门；多容器/增强反检测仅留接口位 |

---

## 13. 关键伪码补充

### 13.1 daemon boot 序列（幂等，可反复执行；修订顺序：ensureImage 先于 reconcile）

```
boot():
  docker.ping() 失败 → 状态 docker_unavailable(§2.2 degraded 闸门), 发事件, 5s 退避重试, return
  img = ensureImage()                        # §3.2，已 ready 则秒回；后续 recreate 依赖它
  HostNetGuard.install(gatewayOf('dotd'), whitelist)    # §2.1-2，幂等重装
  live = docker.listContainers(all, filter label dotd.managed=1)
  for row in containers where state not in ('removed','lost'):
    match = live.find(c.id == row.docker_container_id)
    switch (row.state, match?.status):
      (ready/busy/idle,  running) → probe /healthz: OK→接管(重读 bind token 文件刷 token_hash), 败→unhealthy
      (suspended,        paused)  → 保持
      (busy,              exited) → 标记待 reconcile 的 calls 走 §5.4，转 recreate
      (*,                 exited) → docker start 一次, 失败→recreate
      (*,                 missing)→ row.state='lost' → recreate（此时镜像已由上面 ensureImage 保证）
  未匹配的 live 容器（SQLite 无账）→ 只标记 orphan 发事件，不擅杀，人工/治理决定
  for dot in 活跃行缺失的 dotIds: create+start（§4.2 参数），booting
  booting→ready 后: reconcileOpenCalls(dot)   # §5.4-3，逐 open call 查 /calls/{call_id}
```

### 13.2 recreate

```
recreate(dotId):
  docker rm -f old （home/profiles/state 三个 named volume 保留——独立生命周期；done ledger 在 state 卷上存活）
  token 轮换：重写 /var/lib/dotd/tokens/<dot>.token，重建 bind
  create+start(§4.2 spec) → booting → healthcheck OK → reconcileOpenCalls (§5.4-3)：
      done→重放取回（不重派！）；doing→续轮询；aborted/404→报 interrupted
  row.recreate_count++；>3/24h 或 recreate 后仍 unhealthy → state='quarantined'（不再自动拉起）+ S6 事件
```

---

## 14. 开放问题

- **Q1（docker.sock 最小权限）**：daemon 进程当前用 docker 组权限全量访问 socket。是否引入只建/管 `dotd-*` 前缀的最小权限代理？MVP 不做，留审计。需主人/治理模块拍板。
- **Q2（headed vs headless）**：§6.1 headed+Xvfb 已把 xvfb 打进镜像（+~20MB 镜像层、+~50MB 常驻）；stealth 更强。若 MVP 内存优先可先 headless。待定。
- **Q3（profile 卷多 Dot 共享身份）**：契约先钉死"profile 只被一个运行中容器持有"（named volume 不能双挂读写）。阶段三若需共享身份，另行设计复制/亲和调度。
- **Q4（processor group 亲和性）**：dockerd 在 WSL2 内的 CPU 落组由 WSL 虚拟 CPU 拓扑决定，常规不感知 Windows 双 group 问题；若实测 dockerd 落在 8 核组（CONTEXT.md:33 历史教训），需 WSL `.wslconfig` 层面处理。列观测项：boot 时记录容器实际 CPU 数。
- **Q5（长任务与 suspend 竞争）**：suspend/stop 定时器只作用于 idle，busy 容器天然避让；"25 分钟调用被 deadline 杀"与"浏览器登录等待"冲突；deadline 上限值（30min）需与交互面审批超时对齐。
- **Q6（多身份并发 >2 的配额）**：`MAX_CONTEXTS=2` 为拍脑袋值，无实测。上线前用双站并开做基准，回填 limits_json。
- **Q7（新增：state 卷 uid 权限实测）**：§7.1 的 shell-uid-1001 方案依赖容器内 `CapAdd:[SETUID,SETGID]` + runtime 进程 rootless setuid——Node 进程以 uid 1000 无法直接 setuid 到 1001（需 CAP_SETUID），而容器 USER=dot 已降权。**施工前必须实测**：以 dot 启动、cap add SETUID 后 `process.binding`/`child_process.spawn` 能否 setuid 子进程；若不可行，退路 = shell.run 经 `setpriv`（文件 cap 授予 setpriv 二进制）或 runtime 保留 uid=0 启动后立即降权 fork shell。此条若失败需回到评审重定方案。

---

## 15. 评审响应（逐条）

| # | 评审发现 | 处置 |
|---|---------|------|
| 1 | **崩溃恢复自相矛盾**：recreate 把 done 调用标 interrupted → 重派 → 二次执行；且同步调用无取回端点 | 修订 §5.4：interrupted 仅适用于 `state=='doing'` 的项；done 项跨 recreate 在 state 卷上保留并可重放。新增 `GET /calls/{call_id}` 端点（§5.2）覆盖同步与异步；§13.2 recreate 明确"done→重放取回，不重派"；S1 增补"journal 确认前不压缩 result"。§2.1-189 旧句"旧调用一律视为中断"改写为"token 轮换后**未完成**调用按 §5.4 reconcile 判定，done 一律取回"。home 卷最坏情形（state 卷同丢）如实声明为不可消除兜底（§5.4-2） |
| 2 | **shell.run 绕过硬护栏**（bash -lc 可读写 token/ledger） | 修订 §7.1：token 移出 home 卷改 ro bind（§5.1，兼治第 7 条的宿主可读问题）；ledger 迁独立 state 卷；shell.run 改 `bash -c` 且以 uid 1001 运行（CapAdd SETUID/SETGID），秘密文件 0700/0400 挡跨 uid；`.dotd/` 隐藏降级为纵深防御。诚实标注依赖实测 → 新增开放问题 Q7 |
| 3 | **Dockerfile 无法启动**：挂载点未建/未 chown；`--omit=dev` 后 npx tsc 失败；Playwright 官方镜像无 xvfb | 修订 §3.1：`mkdir -p /dot/home /dot/profiles /run/dotd && chown -R dot:dot /dot`；`npm ci --include=dev && ./node_modules/.bin/tsc && npm prune --omit=dev`；`apt-get install xvfb` 显式装入镜像并声明由 runtime spawn（§6.1） |
| 4 | **NanoCpus 差 4 个数量级** | 修订 §4.2：`NanoCpus: lim.cpuMillis * 100_000`（1m=100,000 nanoCPU，2000m→2e8=2 核），注释写明换算 |
| 5 | **DDL 四处冲突** | (a) 新增部分唯一索引 `ux_containers_active_dot ... WHERE state NOT IN ('removed','lost')`（§9），废弃 UNIQUE(dot_id, docker_container_id)；(b) 删去"dot_id='*'"说法，image_builds 注释改"镜像全局唯一，无 dot 维度"（§3.2/§9）；(c) exec_calls 增 `job_id` 列 + 索引，reconcile/cancel 经 call_id→job_id 映射（§5.4/§9/§10 cancelTool 注释）；(d) CHECK 枚举补 `quarantined`、`idle_stop_requested`（§9），§4.1 图中 `idle` 直接后继统一为 `suspended`，`idle_stop_requested/stopped` 定位为可选二级节能（`deep_stop_after_s`，默认关），闸门驱逐走 stop 并注明 |
| 6 | **S5 谓词 `args.with_identity` 与协议顶层 `identity` 矛盾** | 修订 S5：仲裁统一为 **`ToolCall.identity` 顶层字段**（§5.3 不变），判定谓词写作 `tool.startsWith('browser.') && identity != null`，并显式声明"不存在 args.with_identity"。列入 seam 供治理模块对齐 |
| 7 | **ICC 挡不住容器→宿主；172.17.0.1 写死错；token 宿主读不到卷文件** | 修订 §2.1-2：明确 `enable_icc=false` 只管容器互访；容器→宿主由 `HostNetGuard` iptables 规则阻断，执行者=daemon boot 时、时机=boot 与 docker_unavailable 恢复，网关从 `GET /networks/{id}` 动态读取；默认全拒宿主侧端口、白名单由治理经 `setEgressWhitelist` 下发。token 改宿主生成 + WSL 本地文件 + ro bind（§2.1-4、§5.1），彻底绕开"daemon 无 root 读不到 named volume"问题 |
| 8 | **同步/异步派发判据缺失** | 修订 §5.2/§10：`Capability.mode: 'sync'|'async'` 进能力目录，ExecService 按 catalog 选端点；sync 工具容器端强制 deadline≤60s，超限返回 `deadline_too_long_for_sync`。60s 界限由工具属性声明而非时长猜测 |
| 9 | **ledger 压缩删 result vs done 重放** | 修订 §5.4-4：只压缩"已被控制面确认"的 done 项；compacted 重放返回 `result_compacted`（幂等成功但结果降级，底线=确认未二次执行）；未确认 done 永不压缩 |
| 10 | **DOCKER_API_VERSION=1.47 错误、"只读模式"无状态机对应** | 实测（本会话命令 `wsl.exe -d Ubuntu-24.04 -- docker version --format ...`，输出 `Server=29.1.3 API=1.52 MinAPI=1.44`）：改为固定 1.52，区间校验 [1.44,1.52]；删除"降级为只读"表述，统一为 §2.2 `degraded` 闸门：runTool 未发送即返回 `docker_unavailable(retryable)`，journal 不产生重复执行风险 |
| 11 | **boot 顺序文档内自相矛盾** | 统一为 §13.1 顺序：ping → **ensureImage** → HostNetGuard → reconcile → create/boot（ensureImage 先行使 lost→recreate 分支在 boot 内闭环）；§10 boot 注释同步改写并标注修订原因 |
