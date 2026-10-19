#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1

echo "=== 1. 删旧镜像 ==="
docker rmi -f dotd/exec:1.49.1-0.1.0 >/dev/null 2>&1 && echo "  已删" || echo "  无需删除"

echo "=== 2. 停 daemon + 删容器 ==="
pkill -f 'daemon.ts' 2>/dev/null || true
sleep 3
CID=$(docker ps -aq --filter name=dotd-dot-dot1 | head -1)
if [ -n "$CID" ]; then docker rm -f "$CID" >/dev/null 2>&1 && echo "  已删容器"; fi

echo "=== 3. 重启（会重建镜像，约 2-3 分钟）==="
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &

for i in $(seq 1 60); do
  sleep 5
  if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then
    echo "  daemon 就绪（$((i*5))s）"
    break
  fi
done

echo ""
echo "=== 4. 结果 ==="
docker images --format '{{.Repository}}:{{.Tag}}  {{.CreatedSince}}' | grep dotd | head -2
curl -s -m 3 -o /dev/null -w '  daemon HTTP %{http_code}\n' http://127.0.0.1:7788/api/health

CID2=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "  容器: $CID2"
docker exec "$CID2" sh -c 'grep -l "tool.create" /app/*.ts 2>/dev/null | head -2 || echo "  (容器内仍无 tool.create)"'
