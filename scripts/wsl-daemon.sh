#!/usr/bin/env bash
# 在 WSL 里常驻运行 dotd（真 Docker 容器 + 真模型 + 真飞书）。
#
# 为什么 daemon 要跑在 WSL：Windows 原生 node 到不了 /var/run/docker.sock
# （src/exec/types.ts 硬编码 Unix socket），在 Windows 上起真 fleet 必然 quarantined。
#
# 三个环境要点：
#   1. 模型服务在 Windows 的 127.0.0.1:3065，WSL 经 win-relay 的 <网关>:13065 过去；
#   2. 数据目录用 ~/.dotd（与 Windows 侧同一套 config/tokens 语义）；
#   3. netfuzz 的 fuzz 集群会吃掉 20GB 内存，与容器争资源——启动前必须确认 MemAvailable。
set -uo pipefail
# 部署目录可用 DOTD_REPO_DIR 覆盖（wsl-deploy.sh 会传 /root/dotd）；默认仍是 ~/dotd。
cd "${DOTD_REPO_DIR:-$HOME/dotd}" || exit 1

# 单实例闸门（2026-10-26）。
#
# 现场：外部看门狗（cron `*/2`，/usr/local/bin/dotd-watchdog.sh）在部署的空档里
# 看到 7788 不通就 `setsid bash scripts/dotd-daemon-start.sh`，而部署脚本自己也
# 正要起一份 —— 两边都起，结果是**两个 supervisor 同时抢 8000/7788**：
# 后绑定的那个 bind 失败退出，先抢到的那个在部署脚本的 SIGTERM 里被杀，
# 剩下孤儿进程继续跑旧代码。日志里能看到同一秒两条 `===== 启动`。
#
# 用 flock 而不是 pidfile：pidfile 要考虑进程自杀/陈旧 pid 的清理，flock 在内核里
# 跟着 fd 走，进程一死锁自动释放，没有"残留 pidfile 导致永远起不来"的坑。
# fd 会跨 exec 保留（bash → python supervisor），所以锁的生命期就是进程的生命期。
#
# 没有 flock 时**不能拦**（2026-10-26 补）：老镜像/裁剪系统可能没有 util-linux，
# 那样 `flock` 命令不存在 → 判断为"拿不到锁" → 永远 exit 0、daemon 再也不起来。
# 宁可少一层保护也要能启动，所以先探存在性。
LOCK=/tmp/dotd-one-system.lock
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "[wsl-daemon] 已有实例持锁（$LOCK），本次不启动" >&2
    exit 0
  fi
else
  echo "[wsl-daemon] 没有 flock，跳过单实例闸门（同时起两份的风险自负）" >&2
fi

LOG=/tmp/dotd-wsl.log
# 启动时把上一份日志**归档**而不是直接丢掉（2026-10-19）：
# 崩溃重启后最想看的就是"上一次是怎么死的"，`: > $LOG` 会把它抹掉。
# 只留最近一份，避免长期运行时无限堆积。
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.prev" 2>/dev/null || true
: > "$LOG"
exec >>"$LOG" 2>&1
echo "===== 启动 $(date '+%F %T') ====="

# 1. 凭据（去掉可能的 CRLF/BOM，Windows 侧写过来的文件常带）
sed -i 's/\r$//' _tokens_src.env 2>/dev/null || true
sed -i '1s/^\xEF\xBB\xBF//' _tokens_src.env 2>/dev/null || true
set -a; . ./_tokens_src.env; set +a
echo "凭据: master=${#DOTD_MASTER_TOKEN} wb2=${#WB2API_KEY} owner=${FEISHU_OWNER_CHAT_ID}"

# 2. 模型端点改走 relay
#
# 2026-10-25 改：以前是 sed 直接改写 config/models.yml 的 base_url —— 那会把
# **部署环境**（网关 IP）写进磁盘上的仓库文件，一次 cp 回 Windows 就提交进 git了
# （config/models.yml 里的 172.17.48.1 就是这么来的）。
# 现在 models.yml 用 `${DOTD_MODEL_HOST:-http://127.0.0.1:3065}` 占位，这里只导出
# 环境变量：同一份仓库文件，在 Windows 原生跑用默认值，在 WSL 跑用网关地址，
# 文件本身永远不含环境事实。
GW=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
echo "网关: $GW"
export DOTD_MODEL_HOST="http://${GW}:13065"
# Colibrì 的 tier2 通路同理（win-relay 在 Windows 侧 0.0.0.0:18001）。
export DOTD_TIER2_HOST="${DOTD_TIER2_HOST:-http://${GW}:18001}"
echo "模型端点: ${DOTD_MODEL_HOST}/v1（tier2: ${DOTD_TIER2_HOST}）"

# 3. surfaces 配置（Windows 侧那份，含 feishu 节与 owner 占位）
cp _config_src.yml "$HOME/.dotd/config.yml"

# 3.5 配置目录对齐到 ~/.dotd（2026-10-25 one_system 托管后必须）
#
# one_system 的 _spawn 会给子进程设 DOTD_CONFIG_DIR=$HOME/.dotd（init-config 的
# 标准布局：config.yml / models.yml / tools.yml … 全在 home）。以前直接 node 起
# daemon 时没人设这个变量，configDir 落在仓库 config/，所以这里从没拷过这些文件 ——
# 切到托管后第一次启动就 `ConfigError: 读不到 models.yml：/root/.dotd/models.yml`。
# 每次启动都照仓库刷新（这些文件本就是 ${ENV} 占位驱动，不含环境事实）。
#
# **但 `mcp-servers.yml` 是例外：只在缺失时播种**（2026-10-26 修）。
# 上面那句"不含环境事实"对它不成立：MCP 声明写的是**主人决定接哪些外部程序**，
# 不是 `${VAR}` 占位。而文档教人的启用方式正是"把 voice 示例放到
# `~/.dotd/mcp-servers.yml`" —— 无脑 `cp -f` 会在下一次重启把这份决定**静默改回
# `servers: []`**：用户配好了、发现 MCP 又没了、日志里一个字都没有。
# 与模板不同就**说一声**（不覆盖，但别让漂移隐形）。
for f in config/*.yml; do
  base="$(basename "$f")"
  case "$base" in
    dotd.yml) continue ;;   # init-config 模板，运行期用不到
    mcp-servers.yml)
      if [ ! -f "$HOME/.dotd/$base" ]; then
        cp -f "$f" "$HOME/.dotd/$base"
        echo "MCP: 首次播种 $HOME/.dotd/$base（来自仓库模板）"
      elif ! cmp -s "$f" "$HOME/.dotd/$base"; then
        echo "MCP: 保留运行期 $HOME/.dotd/$base（与仓库模板不同 —— 这是主人的声明，不覆盖）"
      fi
      continue
      ;;
  esac
  cp -f "$f" "$HOME/.dotd/$base"
done

# 4. 内存门槛：容器 + chromium 需要余量，否则水位 guard 会把容器 pause
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
echo "MemAvailable: ${AVAIL}MB"
if [ "$AVAIL" -lt 6000 ]; then
  echo "!!! 内存不足 6GB：容器会被水位 guard pause。先停掉 netfuzz 的 fuzz 集群再启动。"
  echo "    （脚本：bash _stopall.sh）"
  exit 3
fi

# 5. 真容器 + 真模型
export DOTD_HOME="$HOME/.dotd"
export DOTD_DB_PATH="$HOME/.dotd/dotd.db"
export DOTD_CONFIG="$HOME/.dotd/config.yml"
# DOTD_CONFIG_DIR 必须在这里导出（2026-10-26 修）。
#
# 它原本只由 one_system._spawn 注入给 dotd 子进程 —— 那只是"daemon 自己看对了"。
# 人手动跑 `npm run doctor` / onboard / probe-live-model 时，这个 shell 里没有该变量，
# 于是 resolveConfigDir() 回落到仓库 config/：体检去读**模板**，而 daemon 读的是
# `~/.dotd/`。实测 doctor 打出 `MCP 未启用 — /root/dotd/config/mcp-servers.yml`，
# 而运行期那份是 `/root/.dotd/mcp-servers.yml` —— 审计看的文件没人读。
# 注意 config.yml 是特例：它按 `DOTD_CONFIG`（home 路径）读，不看 configDir。
export DOTD_CONFIG_DIR="$HOME/.dotd"
export DOTD_FLEET=docker
export DOTD_MODEL_TRANSPORT=real-http

# 出网工具（net.get / net.post）策略。缺省 off，这里显式开 **get**：
#   - 只放行只读 GET；net.post 仍需 DOTD_NET_TOOLS=all 且治理按 write_file 档审查；
#   - 这个变量会被 containerEnvAndLabels 透传进容器（否则容器侧永远 off；
#     2026-10-18 就是这个缺陷让模型报"出网工具没接通"）。
# 主人要关：把下面这行注释掉，或改成 off。
export DOTD_NET_TOOLS="${DOTD_NET_TOOLS:-get}"

# 并发额度：默认 3（2026-10-19 从 1 提到 3）。
# 为什么改：默认 1 = 完全串行 —— 主人连发两条消息，第二条要等第一条全做完；
# 冷启动时队列里积压的旧任务会把新消息挤到后面（实测排到第 4 位，多等 13 秒）。
# 实测 3 并发安全：两个任务各 3.9 秒、时间区间有重叠，无冲突。
# 资源约束：每任务一份上下文（约 15867 tokens），3 份仍在模型限额内；
# 容器内工具并发另有闸门（cpConcurrencyFromEnv 只在 >1 时生效）。
# 注意：setsid 会丢掉调用方的环境，所以这里必须显式透传（2026-10-18 踩过：
# 在外部 export 了 DOTD_MAX_RUNNING=2 却始终串行，因为变量没进来）。
export DOTD_MAX_RUNNING="${DOTD_MAX_RUNNING:-3}"

echo "FLEET=$DOTD_FLEET HOME=$DOTD_HOME"

# 6. 一套系统：one_system 托管 dotd（2026-10-25 与 Charlie 合并启动）
#
# 以前这里直接 `node src/daemon.ts`，Charlie 另有一个容器自带一份 stub 版 dotd ——
# 一台机器两套实例、两份库。现在交给 voice/integration/one_system.py：
#   - 它把**这份真 dotd**（docker 执行面 / 真库 / 飞书）拉成子进程，退出自动退避重启；
#   - 8000 成为统一入口（Charlie 语音 + /console 控制台 + /api 反代），7788 仍归 dotd；
#   - 子进程 cwd=REPO_ROOT、env 继承本脚本全部导出（模型网关/FLEET/NET_TOOLS/
#     MAX_RUNNING 都会传下去），日志统一进本文件的 /tmp/dotd-wsl.log，dotd 行带 [dotd] 前缀。
# 重启本服务时必须 TERM 这个 supervisor（uvicorn 收到信号 → sup.stop() 带走子进程），
# 只杀 node 子进程会被它自动重启 —— wsl-deploy.sh / rebuild-image.sh 已同步改。
# Python 依赖：repo 根 .venv（voice/charlie/requirements-core.txt）；没有则回退系统 python3。
#
# 回退也找不到时**说清楚并退出**（2026-10-26）。原来 `PY="$(command -v python3)"`
# 在 python3 也不存在时得到空串，下一行就变成 `exec "" …`，报一句
# `: not found` —— 看着像脚本坏了，真相是"这台机器没装 python3"。
export DOTD_REPO_ROOT="$PWD"
PY="$PWD/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ] || [ ! -x "$PY" ]; then
  echo "[wsl-daemon] 找不到 Python：$PWD/.venv/bin/python 不可执行，系统也没有 python3。" >&2
  echo "[wsl-daemon] 装：apt install python3 python3-venv，然后 npm run setup:all（建 .venv 并装依赖）" >&2
  exit 1
fi
echo "supervisor: $PY -m voice.integration.one_system --port 8000"
exec "$PY" -m voice.integration.one_system --port 8000
