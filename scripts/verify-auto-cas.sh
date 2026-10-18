#!/usr/bin/env bash
# 验证 Runner 自动补 expected_size：模型不传，系统也要保护。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
  "读 MEMORY.md，在 ## Current concerns 段末尾加一行「- AUTO-CAS-验证」，保留其他所有内容，整篇写回。完成后回复完成。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"

for i in $(seq 1 120); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "状态=$ST（$((i*2))s）"

echo
echo "=== 模型实际传的参数（应该没有 expected_size）==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const r of db.prepare("SELECT seq,tool_name,status,args_json,result_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool")) {
  const a = String(r.args_json||"");
  let hasExp = false;
  try { hasExp = JSON.parse(a).expected_size !== undefined; } catch {}
  console.log(" " + String(r.seq).padStart(2) + " " + String(r.tool_name).padEnd(9) + r.status + (hasExp ? "  [含 expected_size]" : ""));
}
db.close();' "$TID"

echo
echo "=== 标记是否写入 ==="
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
CONTENT=$(timeout 60 docker exec "$CID" sh -c 'cat /dot/home/MEMORY.md' 2>&1)
printf '%s' "$CONTENT" | grep -q "AUTO-CAS-验证" && echo "  ✅ 标记已写入" || echo "  ❌ 标记未写入"
