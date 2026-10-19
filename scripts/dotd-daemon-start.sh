#!/usr/bin/env bash
# 启动 daemon 的健壮方式（供 boot 脚本调用）
#
# 2026-10-19 踩过的坑：在 [boot] command 里用 `setsid bash x.sh &`，
# 脚本退出时子进程被一起回收（daemon 前台跑明明完全正常）。
# 这里用 nohup + 双 fork 确保真正脱离。
set -uo pipefail
cd /root/dotd || exit 1

# 已经在跑就不重复起
if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then
  echo "daemon 已在运行"
  exit 0
fi

rm -f /tmp/dotd-wsl.log

# nohup + setsid + 重定向全部三个流 + & ：标准的三重保险
nohup setsid bash scripts/wsl-daemon.sh </dev/null >/var/log/dotd-daemon-boot.log 2>&1 &
BOOT_PID=$!
disown "$BOOT_PID" 2>/dev/null || true

# 等端口真的起来（最多 60s）
for i in $(seq 1 30); do
  sleep 2
  if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then
    echo "daemon 就绪（$((i*2))s）"
    exit 0
  fi
done

echo "daemon 60s 未就绪"
tail -10 /tmp/dotd-wsl.log 2>/dev/null | sed 's/^/  /'
exit 1
