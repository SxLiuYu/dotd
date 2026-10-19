#!/usr/bin/env bash
# /usr/local/bin/dotd-watchdog.sh —— 外部健康监视 + 飞书告警（2026-10-19）
#
# 为什么要"外部"监视：daemon 自己挂了就没法自己报警。只有旁观者才能发现它死了。
#
# 检查项（任一项连续失败 N 次 → 飞书告警）：
#   ① daemon 的端口 7788 可达
#   ② docker 可用
#   ③ dotd 容器在跑
#   ④ 模型端点（relay 13065）可达
#
# 设计要点：
#   - **连续失败才告警**（单次抖动不扰民）；
#   - **恢复时也发一条**（否则你不知道什么时候好的）；
#   - 告警有冷却期（同一问题 30 分钟内不重复刷屏）；
#   - 日志与状态**严格分开**（见下方注释）。
set -uo pipefail

STATE_DIR=/var/lib/dotd-watchdog
mkdir -p "$STATE_DIR"
LOG=/var/log/dotd-watchdog.log

# 所有函数都**不写 stdout**（只写日志文件与状态文件）：
# 2026-10-19 踩过 —— 原来用 `exec >>LOG` 全局重定向，函数里的 echo 会被
# `$(...)` 捕获当作"状态值"读回来，报 [: daemon: integer expression expected。
logline() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

FAIL_THRESHOLD=3
COOLDOWN_SEC=1800

fail_count()     { cat "$STATE_DIR/$1.cnt"   2>/dev/null || echo 0; }
set_fail_count() { printf '%s' "$2" >"$STATE_DIR/$1.cnt"; }
alert_state()    { cat "$STATE_DIR/$1.state" 2>/dev/null || echo ok; }
set_alert_state(){ printf '%s' "$2" >"$STATE_DIR/$1.state"; }
last_alert_at()  { cat "$STATE_DIR/$1.last"  2>/dev/null || echo 0; }
mark_alert()     { date +%s >"$STATE_DIR/$1.last"; }

# 飞书凭据（与 daemon 同一份）
TOKENS=/root/dotd/_tokens_src.env
if [ -r "$TOKENS" ]; then
  set -a; . "$TOKENS" 2>/dev/null; set +a
fi

feishu_say() {
  local text="$1"
  if [ -z "${FEISHU_APP_ID:-}" ] || [ -z "${FEISHU_APP_SECRET:-}" ]; then
    logline "[告警-无凭据] $text"
    return 1
  fi
  local chat="${FEISHU_OWNER_CHAT_ID%%,*}"
  local tok
  tok=$(curl -s -m 15 -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
    -H 'Content-Type: application/json' \
    -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
    | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
  if [ -z "$tok" ]; then logline "[告警] 取不到飞书 token"; return 1; fi
  local body rc
  body=$(node -e 'process.stdout.write(JSON.stringify({
    receive_id: process.argv[1], msg_type: "text",
    content: JSON.stringify({ text: process.argv[2] }),
  }))' "$chat" "$text")
  rc=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
    -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    --data-binary "$body")
  case "$rc" in
    *'"code":0'*) logline "飞书告警已送达"; return 0 ;;
    *) logline "[告警] 发送失败：${rc:0:120}"; return 1 ;;
  esac
}

# check <名字> <描述> <检查命令...>
check() {
  local name="$1" desc="$2"; shift 2
  local now; now=$(date +%s)

  if "$@" >/dev/null 2>&1; then
    local cnt; cnt=$(fail_count "$name")
    if [ "$(alert_state "$name")" = "alerting" ]; then
      feishu_say "✅ dotd 恢复了：${desc}
（此前连续失败 ${cnt} 次，现已正常）
时间：$(date '+%F %T')"
      set_alert_state "$name" ok
      set_fail_count "$name" 0
      logline "$name 恢复"
    else
      set_fail_count "$name" 0
    fi
    return 0
  fi

  local cnt; cnt=$(( $(fail_count "$name") + 1 ))
  set_fail_count "$name" "$cnt"
  local last; last=$(last_alert_at "$name")
  if [ "$cnt" -ge "$FAIL_THRESHOLD" ] && [ $(( now - last )) -ge "$COOLDOWN_SEC" ]; then
    feishu_say "⚠️ dotd 异常：${desc}
（已连续失败 ${cnt} 次，约 $(( cnt * 5 )) 分钟）
时间：$(date '+%F %T')
若持续不通，请检查 Windows 侧的 agent2api / win-relay 是否在运行。"
    set_alert_state "$name" alerting
    mark_alert "$name"
    logline "$name 告警（第 $cnt 次）"
  else
    logline "$name 失败（第 $cnt 次，未达告警条件或被冷却）"
  fi
}


# ───────────────────────────────────────────────────────────────────────────
# 自愈（2026-10-19）：检查失败时**先尝试修**，修不好再告警。
#
# 为什么需要：原来 watchdog 只发飞书通知，主人半夜收到"模型端点不可达"，
# 还得自己起床重启 —— 而这类故障（relay 进程没了）一条命令就能修好。
#
# 所有修复动作都**尽力而为**：失败只记日志，不中断后续检查。
# ───────────────────────────────────────────────────────────────────────────

repair_daemon() {
  logline "自愈:尝试重启 daemon"
  cd /root/dotd || return 1
  DOTD_MAX_RUNNING=1 setsid bash scripts/dotd-daemon-start.sh </dev/null >/dev/null 2>&1 &
  local i
  for i in $(seq 1 30); do
    sleep 2
    timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null && { logline "自愈:daemon 已恢复($((i*2))s)"; return 0; }
  done
  logline "自愈:daemon 重启失败"
  return 1
}

repair_docker() {
  logline "自愈:尝试 systemctl start docker"
  systemctl reset-failed docker.service 2>/dev/null || true
  systemctl start docker.service 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    sleep 2
    docker info >/dev/null 2>&1 && { logline "自愈:docker 已恢复($((i*2))s)"; return 0; }
  done
  logline "自愈:docker 启动失败"
  return 1
}

repair_relay() {
  # relay 在 Windows 侧，用 powershell.exe 调过去
  if ! command -v powershell.exe >/dev/null 2>&1; then
    logline "自愈:没有 powershell.exe,无法重启 Windows 侧 relay"
    return 1
  fi
  logline "自愈:尝试在 Windows 侧重启 relay"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\$env:RELAY_TTL_MS='0'; Start-Process -FilePath 'node' -ArgumentList '--import','tsx','scripts/win-relay.mts' -WorkingDirectory 'D:\toagi\dotd' -WindowStyle Hidden" >/dev/null 2>&1
  local gw i
  gw=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
  for i in $(seq 1 15); do
    sleep 2
    timeout 3 bash -c "exec 3<>/dev/tcp/$gw/13065" 2>/dev/null && { logline "自愈:relay 已恢复($((i*2))s)"; return 0; }
  done
  logline "自愈:relay 重启失败(可能 agent2api 也挂了,需人工处理)"
  return 1
}

c_daemon()    { timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; }
c_docker()    { docker info >/dev/null 2>&1; }
c_container() { docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -q 'Up'; }
c_relay() {
  local gw; gw=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
  [ -n "$gw" ] && timeout 5 bash -c "exec 3<>/dev/tcp/$gw/13065" 2>/dev/null
}

if ! c_daemon; then repair_daemon || true; fi
check daemon    "dotd daemon 不可达（127.0.0.1:7788）"                        c_daemon
if ! c_docker; then repair_docker || true; fi
check docker    "docker 守护进程不可用"                                        c_docker
check container "dotd 容器不在运行"                                            c_container
if ! c_relay; then repair_relay || true; fi
check relay     "模型端点不可达（win-relay 13065）—— agent2api/relay 可能没起"  c_relay
