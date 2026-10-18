#!/usr/bin/env bash
# 真并发写测试：DOTD_MAX_RUNNING=2，让两个任务真正同时跑，看记忆写入是否冲突。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

echo "=== 以 DOTD_MAX_RUNNING=2 重启 daemon ==="
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do
  sleep 2
  curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break
done
echo "  daemon 已起（$((i*2))s）"
echo "  并发配置:"
curl -s -m 10 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" | head -c 250
echo

echo
echo "=== 同时提交 4 个任务，各写自己的文件 ==="
TID=()
for n in 1 2 3 4; do
  BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
    "用 shell.run 执行 sleep 3; echo RACE$n > race-$n.txt; cat race-$n.txt，把输出告诉我。")
  T=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  TID+=("$T")
  echo "  任务$n = $T"
done

echo
echo "=== 采样并发度 ==="
MAXRUN=0
for i in $(seq 1 60); do
  sleep 2
  N=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status=?").get("running");
process.stdout.write(String(r.c)); db.close();')
  [ "$N" -gt "$MAXRUN" ] && MAXRUN=$N
  D=0
  for t in "${TID[@]}"; do
    ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$t")
    case "$ST" in done|failed|cancelled) D=$((D+1)) ;; esac
  done
  [ "$D" -eq 4 ] && break
done
echo "  观察到最大并发 running = $MAXRUN"

echo
echo "=== 各任务结果 ==="
OK=0
for n in 1 2 3 4; do
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "${TID[$((n-1))]}")
  echo "  任务$n: $ST"
  [ "$ST" = "done" ] && OK=$((OK+1))
done

echo
echo "=== 容器内文件是否都在且内容正确 ==="
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
CGOOD=0
for n in 1 2 3 4; do
  C=$(timeout 60 docker exec "$CID" sh -c "cat /dot/home/race-$n.txt 2>/dev/null" 2>&1)
  if [ "$C" = "RACE$n" ]; then
    echo "  ✅ race-$n.txt = $C"
    CGOOD=$((CGOOD+1))
  else
    echo "  ❌ race-$n.txt 异常: '$C'"
  fi
done

echo
echo "======== 汇总 ========"
echo "并发度=$MAXRUN  任务完成=$OK/4  文件正确=$CGOOD/4"
