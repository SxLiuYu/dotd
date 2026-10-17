#!/bin/bash
# 换环境不用改脚本：export RUNTIME_HOST=127.0.0.1 RUNTIME_PORT=9223 即可。
RT_HOST="${RUNTIME_HOST:-172.19.0.2}"
RT_PORT="${RUNTIME_PORT:-9223}"
T=$(docker exec dotd-dot-dot1 cat /run/dotd/token)
NOW=$(node -e "console.log(new Date().toISOString())")
DL=$(node -e "console.log(Date.now()+30000)")
CID="sync_diag_$(date +%s%N | tail -c 8)"
echo "== sync /tools/call (fs.list) =="
curl -s -m 10 -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d "{\"call_id\":\"$CID\",\"task_id\":\"tk_diag\",\"dot_id\":\"dot1\",\"tool\":\"fs.list\",\"args\":{\"path\":\"/dot/home\"},\"deadline_ms\":$DL,\"issued_at\":\"$NOW\"}" \
  "http://$RT_HOST:$RT_PORT/tools/call" | head -c 500
echo
echo "== async GET /calls/{id}（回执端点）=="
CID2="call_diag_$(date +%s%N | tail -c 8)"
curl -s -m 10 -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d "{\"call_id\":\"$CID2\",\"task_id\":\"tk_diag\",\"dot_id\":\"dot1\",\"tool\":\"shell.run\",\"args\":{\"cmd\":\"echo hi\",\"timeout_ms\":5000},\"deadline_ms\":$DL,\"issued_at\":\"$NOW\"}" \
  "http://$RT_HOST:$RT_PORT/jobs/start" | head -c 300
echo
sleep 2
curl -s -m 10 -H "authorization: Bearer $T" "http://$RT_HOST:$RT_PORT/calls/$CID2" | head -c 400
echo
