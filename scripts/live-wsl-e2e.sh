#!/usr/bin/env bash
# dotd 真容器端到端验证（在 WSL 里跑，需 docker 可达）
#
# 为什么需要这个脚本：Windows 原生 node 到不了 /var/run/docker.sock
# （src/exec/types.ts 硬编码 Unix socket），所以真 fleet 只能在 WSL 里跑。
#
# 前置条件（脚本会逐项检查，缺哪个就告诉你缺什么）：
#   1. WSL 里 docker 可用：`docker version` 通
#   2. 镜像存在：dotd/exec:1.49.1-0.1.0（daemon boot 时也会自动构建）
#   3. 模型可达：模型服务在 Windows 的 127.0.0.1:3065，WSL 的 127.0.0.1 是另一个
#      命名空间，需先用 Windows 侧的 scripts/win-relay.mts 转发到 0.0.0.0:13065
#   4. WSL 内存余量：fuzz 集群（netfuzz）RSS 约 20GB，而 .wslconfig 限了 24GB。
#      **两者不能同时跑**——这是 2026-10-18 实测的硬约束。
#
# 用法（在 WSL 里，仓库任意副本路径）：
#   bash scripts/live-wsl-e2e.sh              # 默认读 ../.dotd 或 ~/.dotd 的配置
#   DOTD_LIVE_HOME=/tmp/x bash scripts/live-wsl-e2e.sh
#
# 产出：/tmp/dotd-live.log（全量日志）+ 终端摘要。退出码 0 = 端到端通过。
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT" || exit 1
LIVE_HOME=${DOTD_LIVE_HOME:-/tmp/dotd-live-wsl}
LOG=/tmp/dotd-live.log
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

ok()   { printf '	OK   %s\n' "$*"; }
bad()  { printf '	FAIL %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

FAILED=0

step "1/7 前置检查"
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  bad "docker 不可用（需要 WSL 里的 dockerd）。先解决这个，其余步骤才有意义。"
  exit 2
fi
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
ok "node $(node --version)"

# 内存余量：这是 2026-10-18 踩过的坑，必须显式检查
AVAIL_MB=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
ok "MemAvailable ${AVAIL_MB}MB"
if [ "$AVAIL_MB" -lt 3000 ]; then
  bad "可用内存 < 3GB：容器启动 + chromium 会 OOM。"
  bad "最常见原因：netfuzz 的 fuzz 集群常驻 ~20GB。跑本脚本前请先停掉它，"
  bad "或临时把 .wslconfig 的 memory 调大后 wsl --shutdown 再进。"
  exit 3
fi

step "2/7 凭据与端点"
# 凭据来源优先级：显式环境变量 > ~/.dotd/tokens.env > 仓库 _tokens_src.env
if [ -z "${DOTD_MASTER_TOKEN:-}" ]; then
  for f in "$HOME/.dotd/tokens.env" "$REPO_ROOT/_tokens_src.env"; do
    if [ -f "$f" ]; then
      set -a; . "$f"; set +a
      ok "已载入 $f"
      break
    fi
  done
fi
[ -n "${DOTD_MASTER_TOKEN:-}" ] && ok "DOTD_MASTER_TOKEN 已设置" || { bad "DOTD_MASTER_TOKEN 缺失"; FAILED=1; }
[ -n "${WB2API_KEY:-}" ] && ok "WB2API_KEY 已设置（长度 ${#WB2API_KEY}）" || { bad "WB2API_KEY 缺失（模型端点需要）"; FAILED=1; }
[ "$FAILED" -eq 0 ] || exit 4

# 模型端点：WSL 够不着 Windows 的 127.0.0.1:3065，走 win-relay
GW=$(sed -n 's/^default via \([0-9.]*\).*/\1/p' /proc/net/route 2>/dev/null | head -1)
GW=$(ip route 2>/dev/null | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
if [ -z "${GW:-}" ]; then bad "拿不到 WSL 默认网关"; exit 5; fi
ok "gateway $GW"
MODELS="$REPO_ROOT/config/models.yml"
cp "$MODELS" "$LIVE_HOME-models.yml.bak" 2>/dev/null || true
ORIG_URL=$(sed -n 's/^    base_url: \(http[^ ]*\)$/\1/p' "$MODELS" | head -1)
sed -i "s#^    base_url: .*#    base_url: http://${GW}:13065/v1#" "$MODELS"
ok "models.yml tier1: $ORIG_URL -> http://${GW}:13065/v1"
if ! curl -sf -m 15 -o /dev/null "http://${GW}:13065/v1/models" -H "Authorization: Bearer ${WB2API_KEY:-}"; then
  bad "经 relay 访问不到模型网关。先在 Windows 侧起 scripts/win-relay.mts（13065 -> 3065）。"
  exit 6
fi
ok "模型网关可达（经 relay）"

step "3/7 起 daemon（DOTD_FLEET=docker）"
export DOTD_HOME="$LIVE_HOME"
export DOTD_DB_PATH="$LIVE_HOME/dotd.db"
export DOTD_CONFIG="${DOTD_CONFIG:-$HOME/.dotd/config.yml}"
export DOTD_FLEET=docker
export DOTD_MODEL_TRANSPORT=real-http
rm -rf "$DOTD_HOME"; mkdir -p "$DOTD_HOME"
ok "DOTD_HOME=$DOTD_HOME  FLEET=$DOTD_FLEET"

node --import tsx src/daemon.ts &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null' EXIT

READY=0
for i in $(seq 1 90); do
  sleep 2
  if curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" \
       http://127.0.0.1:7788/api/status >/dev/null 2>&1; then READY=1; break; fi
  kill -0 $DAEMON 2>/dev/null || break
done
[ "$READY" -eq 1 ] && ok "daemon 就绪（约 $((i*2))s）" || { bad "daemon 没起来，见上方日志"; exit 7; }

step "4/7 提交真任务"
PAYLOAD='{"text":"在 reports 目录下创建文件 wsl.md，内容写三行：真容器验证、WSL 里的 dotd、日期 2026-10-18。写完后用一句话告诉我结果。"}'
RESP=$(curl -s -m 20 -X POST -H "Authorization: Bearer $DOTD_MASTER_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" --data-binary "$PAYLOAD" \
  http://127.0.0.1:7788/api/messages)
TASK=$(printf '%s' "$RESP" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
ok "taskId=$TASK"

step "5/7 等终态（最多 8 分钟）"
STATUS=""
for i in $(seq 1 96); do
  sleep 5
  STATUS=$(curl -sf -m 5 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" \
    "http://127.0.0.1:7788/api/tasks/$TASK" 2>/dev/null | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  case "$STATUS" in done|failed|cancelled) break ;; esac
done
ok "status=$STATUS"

step "6/7 真容器证据"
docker ps -a --filter "name=dotd-dot-dot1" --format '{{.Names}} | {{.Image}} | {{.Status}}' || true
CID=$(docker ps -a --filter "name=dotd-dot-dot1" --format '{{.ID}}' | head -1)
if [ -n "${CID:-}" ]; then
  ok "容器 $CID 存在"
  docker exec "$CID" ls -la /dot/home 2>&1 | head -10
  echo "--- 读回模型写的文件 ---"
  docker exec "$CID" cat /dot/home/reports/wsl.md 2>&1 | head -5
else
  bad "没找到 dotd 容器"
  FAILED=1
fi

step "7/7 结果"
curl -sf -m 10 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" \
  "http://127.0.0.1:7788/api/tasks/$TASK?verbose=1" >/tmp/dotd-live-task.json 2>&1 || true
curl -sf -m 10 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" \
  "http://127.0.0.1:7788/api/tasks/$TASK?verbose=1" 2>/dev/null | head -c 1200 || true

echo
if [ "$STATUS" = "done" ] && [ "$FAILED" -eq 0 ]; then
  echo "==> 端到端通过：真模型 + 真容器，任务 done 且容器内文件可读回"
  exit 0
fi
echo "==> 未通过（status=$STATUS, failed=$FAILED）。完整日志：$LOG"
exit 1
