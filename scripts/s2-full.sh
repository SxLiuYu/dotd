#!/usr/bin/env bash
# S2 完整验证：造工具 → 批准 → 复用
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

submit() {
  local goal="$1"
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$goal")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

wait_task() {
  local tid="$1" st
  for i in $(seq 1 300); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  echo "$st"
}

approve_all() {
  local n=0
  for aid in $(curl -s -m 10 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const j=JSON.parse(s); for (const a of (j.approvals||[])) { if (String(a.summary||"").includes("tool.")) console.log(a.id); } } catch {}
});'); do
    curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
    echo "    批准审批单 $aid"
    n=$((n+1))
  done
  [ "$n" = "0" ] && echo "    (本次无待批)"
}

echo "【任务 1】让模型造工具"
T1=$(submit "帮我做一个工具，名字叫 word-count，功能：接收一段文本，返回中文字符数和英文单词数。做完告诉我怎么用。")
echo "  task=$T1"
ST=$(wait_task "$T1")
echo "  状态: $ST"
if [ "$ST" = "awaiting_approval" ]; then
  approve_all
  echo "  批准后等执行..."
  ST=$(wait_task "$T1")
  echo "  最终: $ST"
  # 可能还有第二次审批（invoke 验证）
  if [ "$ST" = "awaiting_approval" ]; then approve_all; ST=$(wait_task "$T1"); echo "  最终: $ST"; fi
fi

echo ""
echo "=== 磁盘检查 ==="
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
docker exec "$CID" sh -c 'ls /dot/home/tools/ 2>/dev/null || echo "  (无 tools)"'
docker exec "$CID" sh -c 'echo "--- manifest ---"; head -c 400 /dot/home/tools/word-count/manifest.json 2>/dev/null; echo; echo "--- 入口文件 ---"; ls -la /dot/home/tools/word-count/ 2>/dev/null | head -6'

echo ""
echo "=== 总结 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const t = db.prepare("SELECT id, status FROM tasks WHERE id=?").get(process.argv[1]);
console.log("  任务: " + t.status);
for (const r of db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool")) {
  console.log("    " + String(r.tool_name).padEnd(14) + r.status);
}
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log("  回答: " + (m ? String(m.content).replace(/\s+/g," ").slice(0,250) : "(无)"));
db.close();' "$T1"
