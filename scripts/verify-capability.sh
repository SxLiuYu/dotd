#!/usr/bin/env bash
# 验证 prompt 修复效果：问"你能干什么"，看模型是否还会复述过时的"出网没接通"。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

BODY=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' \
  "你好，报一下你现在能做什么")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"

for i in $(seq 1 60); do
  sleep 2
  ST=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$TID" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST" in done|succeeded|failed|cancelled|paused) break ;; esac
done
echo "status=$ST"

node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const tid = process.argv[1];
const tools = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=?").all(tid, "tool");
console.log("工具调用:", tools.map(t => t.tool_name + "=" + t.status).join(", ") || "（无，纯回答）");
const a = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(tid, "assistant", "text");
console.log("\n=== 回答 ===");
console.log(a ? String(a.content) : "(无)");
db.close();' "$TID"
