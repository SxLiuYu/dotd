#!/usr/bin/env bash
# /usr/local/bin/dotd-boot.sh —— WSL 开机引导（2026-10-19）
#
# 由 /etc/wsl.conf 的 [boot] command= 调用，每次 WSL 实例启动时执行。
#
# 职责：
#   ① 等 docker 可用（**由 systemd 管**，这里只等）
#   ② 拉起 dotd daemon（飞书长连接 + 任务调度）
#
# 踩过的坑（都在这一个文件里修掉了）：
#   - `[boot] command` 环境下 **HOME 未定义**，`set -u` 会让脚本当场退出；
#   - 自己 `nohup dockerd` 会和 systemd 的 docker.service **抢 /var/run/docker.pid**，
#     两边都启动失败 —— 所以 docker 一律交给 systemd；
#   - `pgrep -f 'src/daemon.ts'` 会匹配到执行本脚本的 shell 自己，
#     误判"已在跑" → 改用 **HTTP 端口探测**；
#   - daemon 必须 `setsid` 脱离会话，否则 [boot] 退出时被一起回收。
set -uo pipefail

# [boot] 环境下 HOME/PATH 可能缺失 —— 显式兜底
export HOME="${HOME:-/root}"
export PATH="${PATH:-/usr/local/sbin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

LOG=/var/log/dotd-boot.log
# **每行都要带时间戳**（2026-10-20 修，真缺陷）。
# 现场：soak.sh 的 parseLog 只认 `YYYY-MM-DD HH:MM:SS <正文>` 这个形状，
# 而这里原来只在开头打一行带时间的 `===== ... WSL 启动 =====`，正文全裸。
# 结果 parseLog 解析出 0 行 —— **boot 自愈证据在评估时根本不存在**。
# 后果很严重：7 天窗口里只要 Windows 更新导致 WSL 重启一次，
# soak 就找不到"这次重启是谁拉起来的"，判成「疑似人工干预」直接把验收打红，
# 而实际上 dotd-boot.sh 4 秒就把它拉起来了（我实测过）。
# 这是第⑥类（样本没测它声称测的东西）反过来：**证据存在，但格式让它不可读**。
# 用 gawk 的 strftime 给 stdout/stderr 每一行前面加时间戳，输出形状与 watchdog 日志对齐。
exec > >(gawk '{ print strftime("%Y-%m-%d %H:%M:%S"), $0; fflush() }' >>"$LOG") 2>&1
echo "===== WSL 启动 ====="

wait_until() {  # wait_until <秒> <命令...>
  local max="$1"; shift
  local i
  for ((i = 0; i < max; i += 2)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

docker_ok() { docker info >/dev/null 2>&1; }
daemon_up() { timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; }

# ① docker：交给 systemd（永远不自己起 dockerd）
echo "等待 docker（systemd）…"
# 可能上一次是 failed 状态，reset 一下再 start；失败不致命
systemctl reset-failed docker.service 2>/dev/null || true
systemctl start docker.service 2>/dev/null || true
if wait_until 60 docker_ok; then
  echo "  docker 就绪"
else
  echo "  !! docker 60s 未就绪，容器类工具将不可用："
  systemctl status docker.service --no-pager -n 3 2>&1 | tail -4 | sed 's/^/    /'
fi

# ② dotd daemon
if daemon_up; then
  echo "dotd daemon 已在运行"
  exit 0
fi

cd /root/dotd || { echo "!! /root/dotd 不存在"; exit 1; }

# 等 Windows 侧 relay（daemon 一起来就要用模型，太早会熔断）
GW=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
echo "网关 $GW，等 relay 13065…"
if wait_until 60 bash -c "exec 3<>/dev/tcp/$GW/13065"; then
  echo "  relay 就绪"
else
  echo "  !! relay 60s 未就绪（daemon 仍启动，模型不可用时熔断、relay 起来后自愈）"
fi

echo "启动 dotd daemon…"
# **不要在这里 rm 日志**（2026-10-19 修，真缺陷）：
# daemon 已经在运行时，这行会把**正在被写入的**日志删掉 ——
# 进程的 fd 仍指向它，文件变成 "(deleted)"，后续日志全进黑洞，
# 磁盘空间也不释放。现场实测：daemon pid=1303 的 stdout 是
# "/tmp/dotd-wsl.log (deleted)"，7 天 soak 期间将完全无法事后排查。
# 日志轮转交给 wsl-daemon.sh 自己在**启动那一刻**做（那时确实该新建）。
# setsid：脱离 [boot] 的会话，否则脚本退出时 daemon 被一起回收
DOTD_MAX_RUNNING="${DOTD_MAX_RUNNING:-3}" bash scripts/dotd-daemon-start.sh
echo "  已交由 dotd-daemon-start.sh（它自己等端口并打印结果）"
