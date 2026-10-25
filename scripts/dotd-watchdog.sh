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

# cron 的 PATH 极简，**不含 /mnt/c/...** —— 于是 `command -v powershell.exe` 失败，
# repair_relay 直接放弃"自愈:没有 powershell.exe"。2026-10-19 实测就是这样：
# 手工跑能修 relay，cron 跑永远修不了，只剩发告警。
# 这里显式把 WSL 互操作路径补进 PATH（幂等）。
case ":$PATH:" in
  *":/mnt/c/Windows/System32:"*) ;;
  *) PATH="$PATH:/mnt/c/Windows/System32:/mnt/c/Windows:/mnt/c/Windows/System32/WindowsPowerShell/v1.0" ;;
esac
export PATH

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
# 部署窗口闸门（2026-10-26）
#
# 现场：`scripts/wsl-deploy.sh` 的重启段是「SIGTERM 旧 supervisor → 等它退干净 →
# 起新的」，中间有若干秒 7788 是**故意不通**的。cron 每 2 分钟跑本脚本，正好落进
# 这个空档就会判定 daemon 死了并 `repair_daemon` —— 于是**第二份 supervisor** 被
# 拉起，和部署脚本即将启动的那份抢 8000/7788。日志里同一秒两条 `===== 启动`、
# 部署侧报 `30s 还没退，SIGKILL`，剩下的孤儿进程跑的还是重启前的旧代码。
#
# 修法：部署开始时写一个时间戳锁，本脚本在锁新鲜时**不做自愈**（检测/告警照旧 ——
# 部署真挂了仍然会告警，只是不抢着起进程）。锁是文件+时间戳而不是 flock，因为
# 部署脚本可能在 `set -e` 中途退出，残留的时间戳会在 LOCK_TTL 秒后自动失效，
# 不会把自愈永久关掉。
LOCK_FILE="${HOME:-/root}/.dotd/deploy.lock"
LOCK_TTL=300

deploy_in_progress() {
  [ -f "$LOCK_FILE" ] || return 1
  local t age
  t=$(cat "$LOCK_FILE" 2>/dev/null || echo 0)
  case "$t" in ''|*[!0-9]*) return 1 ;; esac
  age=$(( $(date +%s) - t ))
  [ "$age" -ge 0 ] && [ "$age" -lt "$LOCK_TTL" ]
}

# 自愈前的统一入口：部署中就直说跳过，别静默（下次看日志要能解释"为什么没修"）。
may_repair() {
  if deploy_in_progress; then
    logline "自愈:部署进行中（$LOCK_FILE，$(( $(date +%s) - $(cat "$LOCK_FILE") ))s 前），跳过修复"
    return 1
  fi
  return 0
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
  # 工作目录必须是 `D:\dotd`（2026-10-26 对齐）：仓库里这份一直写着旧的
  # `D:\toagi\dotd`，而 live 的 /usr/local/bin 副本早已改成 `D:\dotd` ——
  # 两边不一致意味着"重新按仓库装一次 watchdog"会把 relay 自愈改回坏的。
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\$env:RELAY_TTL_MS='0'; Start-Process -FilePath 'node' -ArgumentList '--import','tsx','scripts/win-relay.mts' -WorkingDirectory 'D:\dotd' -WindowStyle Hidden" >/dev/null 2>&1
  local gw i
  gw=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
  for i in $(seq 1 15); do
    sleep 2
    timeout 3 bash -c "exec 3<>/dev/tcp/$gw/13065" 2>/dev/null && { logline "自愈:relay 已恢复($((i*2))s)"; return 0; }
  done
  logline "自愈:relay 重启失败(可能 agent2api 也挂了,需人工处理)"
  return 1
}

# 容器自愈（2026-10-19 补）：原来只**检测**容器不在跑，没有任何修复动作 ——
# 实测 docker stop 之后 watchdog 连续报"container 失败"却始终不动手，
# 因为它只会修 daemon / docker / relay。容器是任务的执行环境，它没了等于全瘫。
#
# 为什么不能只靠 --restart 策略：`docker stop` 是**人工停止**，语义上
# restart=unless-stopped 会尊重这个"故意停"，不会拉起。所以必须显式 start。
repair_container() {
  local name=dotd-dot-dot1
  logline "自愈:尝试启动容器 $name"
  if ! docker start "$name" >/dev/null 2>&1; then
    # 容器可能已不存在（被 rm 掉），退回 fleet 重建
    logline "自愈:docker start 失败，尝试 fleet 重建"
    cd /root/dotd 2>/dev/null || return 1
    # 2026-10-26 修：这里原来调 `scripts/wsl-daemon-start.sh` —— **该文件不存在**
    # （仓库和部署副本里都没有），于是"重建"这一步永远 exit 127，容器自愈的第二条
    # 路径从来没生效过，只是日志里看着像试过。真正的启动器是 dotd-daemon-start.sh。
    DOTD_FLEET=docker DOTD_MAX_RUNNING=1 timeout 180 bash scripts/dotd-daemon-start.sh >/dev/null 2>&1 || true
  fi
  local i
  for i in $(seq 1 30); do
    sleep 2
    if docker ps --filter name="$name" --format '{{.Status}}' 2>/dev/null | grep -q 'Up' \
       && docker exec "$name" sh -c 'echo ok' >/dev/null 2>&1; then
      logline "自愈:容器已恢复($((i*2))s)"
      return 0
    fi
  done
  logline "自愈:容器启动失败"
  return 1
}
c_daemon()    { timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; }
c_docker()    { docker info >/dev/null 2>&1; }
c_container() { docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -q 'Up'; }
c_relay() {
  local gw; gw=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
  [ -n "$gw" ] && timeout 5 bash -c "exec 3<>/dev/tcp/$gw/13065" 2>/dev/null
}

if ! c_daemon; then may_repair && { repair_daemon || true; }; fi
check daemon    "dotd daemon 不可达（127.0.0.1:7788）"                        c_daemon
if ! c_docker; then may_repair && { repair_docker || true; }; fi
check docker    "docker 守护进程不可用"                                        c_docker
# 容器是执行环境：没了就全瘫，检测到立刻修（不等告警阈值）
if ! c_container; then may_repair && { repair_container || true; }; fi
check container "dotd 容器不在运行"                                            c_container
if ! c_relay; then may_repair && { repair_relay || true; }; fi
check relay     "模型端点不可达（win-relay 13065）—— agent2api/relay 可能没起"  c_relay
