#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a

CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "=== 1. 容器内代码含 tool.create 吗 ==="
docker exec "$CID" sh -c 'grep -c "tool.create" /app/protocol.ts 2>/dev/null || echo "0"'

echo ""
echo "=== 2. 容器 /capabilities 返回的工具数 ==="
TOKEN=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT token_hash FROM containers WHERE dot_id=?").get("dot1");
process.stdout.write("");
db.close();')
# 直接看容器是否列出了 tool.*
docker exec "$CID" sh -c 'ls /app/*.ts | head -5'

echo ""
echo "=== 3. 模型侧：发一条消息看它认不认得 tool.create ==="
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"text":"你现在有哪些工具可以用来造新工具？只说工具名，不要执行任何操作"}' "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TID"
for i in $(seq 1 120); do
  sleep 0.5
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  状态: $ST"
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log("  回答: " + (m ? String(m.content).replace(/\s+/g," ").slice(0,300) : "(无)"));
db.close();' "$TID"
