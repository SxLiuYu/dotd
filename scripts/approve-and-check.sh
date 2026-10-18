#!/usr/bin/env bash
# 审批浏览器工具调用，看任务能否续跑完成。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

echo "=== 待批审批 ==="
APV=$(curl -s -m 15 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);const items=j.approvals||j.items||[];
    if(items.length===0){console.log("");return}
    console.log(items[0].id);
    for(const a of items) console.error("  #"+a.id+" "+a.kind+" tier="+a.tier+" "+(a.summary||"").slice(0,60));
  }catch(e){console.log("")}
});' 2>/tmp/apv.err)
cat /tmp/apv.err 2>/dev/null
if [ -z "$APV" ]; then echo "没有待批审批"; exit 0; fi
echo "批准 #$APV"

curl -s -m 15 "${HDR[@]}" -X POST -d "{\"verdict\":\"approve_once\",\"channel\":\"cli\"}" \
  "$BASE/api/approvals/$APV/decision" | head -c 200
echo

echo "=== 等任务续跑（最多 180s）==="
TID=$(curl -s -m 15 "${HDR[@]}" "$BASE/api/queue" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p' | head -1)
for i in $(seq 1 90); do
  sleep 2
  ST=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/tk_mvdk29ttv2xvi5" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST" in done|succeeded|failed|cancelled) break ;; esac
done
echo "任务终态: $ST"
