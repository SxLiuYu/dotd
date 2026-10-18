#!/usr/bin/env bash
# 验证：模型现在到底能不能用出网工具（让它真去查一次）。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" i st
  for ((i = 0; i < 100; i++)); do
    sleep 2
    st=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo timeout
}

T=$(submit "现在立刻用 net.get 访问 https://api.github.com/zen，把返回的那句话原样贴给我。不要说'没接通'，先试了再回答。")
echo "task=$T"
ST=$(wait_task "$T")
echo "status=$ST"

node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const tid = process.argv[1];
const tools = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=?").all(tid, "tool");
console.log("工具调用:", tools.map(t => t.tool_name + "=" + t.status).join(", ") || "（无）");
const ans = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(tid, "assistant", "text");
console.log("回答:", ans ? String(ans.content).replace(/\s+/g, " ").slice(0, 200) : "(无)");
db.close();' "$T"
