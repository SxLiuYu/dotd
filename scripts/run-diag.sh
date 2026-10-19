#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
export DOTD_DIAG_INV=1

echo "=== 重启（带诊断开关）==="
pkill -f 'daemon.ts' 2>/dev/null || true
sleep 4
DOTD_DIAG_INV=1 nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do
  sleep 3
  if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then echo "  就绪"; break; fi
done

BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"text":"打个招呼就行"}' "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"
for i in $(seq 1 120); do
  sleep 0.5
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
done
echo "状态: $ST"
echo ""
echo "=== DIAG-INV 输出 ==="
grep 'DIAG-INV' /tmp/dotd-wsl.log | tail -5 || echo "(无输出 —— buildMessages 没走到诊断点)"
