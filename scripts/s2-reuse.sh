#!/usr/bin/env bash
# S2 判据：下次同类任务直接复用，不应再造新工具
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

submit() {
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local st
  for i in $(seq 1 300); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  echo "$st"
}
approve_all() {
  for aid in $(curl -s -m 10 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[])){if(String(a.summary||"").includes("tool."))console.log(a.id)}}catch{}});'); do
    curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
    echo "    批准 $aid"
  done
}

echo "【任务 2】同类需求 —— 应该直接复用 word-count"
T=$(submit "统计一下这句话：Hello 世界，this is a test 测试。中文字和英文单词各有多少？")
echo "  task=$T"
ST=$(wait_task "$T")
echo "  状态: $ST"
for round in 1 2 3; do
  [ "$ST" != "awaiting_approval" ] && break
  approve_all
  ST=$(wait_task "$T")
  echo "  批准后: $ST"
done

echo ""
echo "=== 工具调用序列 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
for (const r of rows) console.log("    " + String(r.tool_name).padEnd(14) + r.status);
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log("");
console.log("  回答: " + (m ? String(m.content).replace(/\s+/g," ").slice(0,250) : "(无)"));
db.close();' "$T"

echo ""
echo "=== 工具数量最终统计 ==="
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
docker exec "$CID" sh -c 'ls /dot/home/tools/ | wc -l; echo "--- 列表 ---"; ls /dot/home/tools/'
