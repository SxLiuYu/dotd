#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

ask() {
  local goal="$1" label="$2"
  local tid st
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$goal")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  for i in $(seq 1 200); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  echo "── [$label] $st"
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log("   " + (m ? String(m.content).replace(/\s+/g," ").slice(0,200) : "(无)"));
const ts = db.prepare("SELECT tool_name FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool").map(r=>r.tool_name);
console.log("   工具: " + (ts.join(", ") || "(无)"));
db.close();' "$tid"
  echo ""
}

echo "【验证 1】直接问它知不知道有现成工具"
ask "你上下文里有没有告诉你「已有的自造工具」？如果有，列出它们的名字。只回答，不要调用任何工具。" "认知测试"

echo "【验证 2】明确要求用工具"
ask "用 word-count 工具统计这句话：Hello 世界 test 测试" "指定使用"
