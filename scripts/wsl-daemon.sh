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
cd "$HOME/dotd" || exit 1

LOG=/tmp/dotd-wsl.log
: > "$LOG"
exec >>"$LOG" 2>&1
echo "===== 启动 $(date '+%F %T') ====="

# 1. 凭据（去掉可能的 CRLF/BOM，Windows 侧写过来的文件常带）
sed -i 's/\r$//' _tokens_src.env 2>/dev/null || true
sed -i '1s/^\xEF\xBB\xBF//' _tokens_src.env 2>/dev/null || true
set -a; . ./_tokens_src.env; set +a
echo "凭据: master=${#DOTD_MASTER_TOKEN} wb2=${#WB2API_KEY} owner=${FEISHU_OWNER_CHAT_ID}"

# 2. 模型端点改走 relay
GW=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
echo "网关: $GW"
sed -i "s#base_url: http://127.0.0.1:3065/v1#base_url: http://${GW}:13065/v1#" config/models.yml
sed -i "s#base_url: http://127.0.0.1:7863/v1#base_url: http://${GW}:13065/v1#" config/models.yml
grep -n "base_url: http://" config/models.yml | head -1

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
node --import tsx src/daemon.ts
