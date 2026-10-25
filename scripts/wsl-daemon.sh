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
export DOTD_REPO_ROOT="$PWD"
PY="$PWD/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
echo "supervisor: $PY -m voice.integration.one_system --port 8000"
exec "$PY" -m voice.integration.one_system --port 8000
