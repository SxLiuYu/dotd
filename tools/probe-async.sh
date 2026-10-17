#!/bin/bash
# 复现 daemon 视角：用库里 endpoint + 当前 token 直接调 /jobs/start 与轮询
# 换环境不用改脚本：export RUNTIME_HOST=127.0.0.1 RUNTIME_PORT=9223 即可。
RT_HOST="${RUNTIME_HOST:-172.19.0.2}"
RT_PORT="${RUNTIME_PORT:-9223}"
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
const row = db.prepare("SELECT endpoint FROM containers WHERE dot_id=?").get("dot1");
console.log("endpoint:", row.endpoint);
'
T=$(docker exec dotd-dot-dot1 cat /run/dotd/token)
NOW=$(node -e "console.log(new Date().toISOString())")
DL=$(node -e "console.log(Date.now()+60000)")
CID="diag_$(date +%s%N | tail -c 8)"
RESP=$(curl -s -m 10 -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d "{\"call_id\":\"$CID\",\"task_id\":\"tk_diag\",\"dot_id\":\"dot1\",\"tool\":\"shell.run\",\"args\":{\"cmd\":\"echo hi; pwd\",\"timeout_ms\":10000},\"deadline_ms\":$DL,\"issued_at\":\"$NOW\"}" \
  "http://$RT_HOST:$RT_PORT/jobs/start")
echo "start: $RESP"
JID=$(echo "$RESP" | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{try{const j=JSON.parse(d);console.log(j.job_id||\"\")}catch{console.log(\"\")}})")
echo "job_id=$JID"
for i in 1 2 3; do
  sleep 2
  echo "poll$i: $(curl -s -m 10 -H "authorization: Bearer $T" "http://$RT_HOST:$RT_PORT/jobs/$JID" | head -c 400)"
done
