#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

echo "=== 1. 找 pending 审批 ==="
APPR=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const j = JSON.parse(s);
    for (const a of (j.approvals||[])) {
      if (String(a.summary||"").includes("tool.create")) { process.stdout.write(String(a.id)); return; }
    }
  } catch {}
});')
echo "  审批单: ${APPR:-未找到}"
[ -z "$APPR" ] && exit 1

echo ""
echo "=== 2. 批准 ==="
curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$APPR/decision" | head -c 200
echo ""

echo ""
echo "=== 3. 等任务继续 ==="
sleep 15
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const t = db.prepare("SELECT id, status FROM tasks WHERE goal LIKE ? ORDER BY created_at DESC LIMIT 1").get("%word-count%");
if (!t) { console.log("  没找到任务"); process.exit(0); }
console.log("  任务: " + t.id + "  " + t.status);
for (const r of db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(t.id, "tool")) {
  console.log("    " + String(r.tool_name).padEnd(14) + r.status);
}
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(t.id,"assistant","text");
console.log("  回答: " + (m ? String(m.content).replace(/\s+/g," ").slice(0,300) : "(无)"));
db.close();'

echo ""
echo "=== 4. 磁盘检查 ==="
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
docker exec "$CID" sh -c 'ls -la /dot/home/tools/ 2>/dev/null || echo "  (仍无 tools 目录)"'
docker exec "$CID" sh -c 'echo "--- manifest ---"; cat /dot/home/tools/word-count/manifest.json 2>/dev/null' | head -15
