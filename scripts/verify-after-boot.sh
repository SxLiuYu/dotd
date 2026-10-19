#!/usr/bin/env bash
# 开机自启后的端到端验证
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

echo "=== 服务状态 ==="
echo -n "  docker: "; docker info --format '{{.ServerVersion}}' 2>&1 | head -1
echo -n "  daemon: "; timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null && echo OK || echo FAIL
echo -n "  容器: "; docker ps --filter name=dotd --format '{{.Status}}' 2>&1 | head -1

echo
echo "=== 提交任务 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "开机自启验证：请只回复 OK 两个字母")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TID"

for i in $(seq 1 90); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  状态=$ST（$((i*2))s）"

echo
echo "=== 回答 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log(m ? String(m.content).replace(/\s+/g," ").slice(0,200) : "(无)");
db.close();' "$TID" 2>&1
