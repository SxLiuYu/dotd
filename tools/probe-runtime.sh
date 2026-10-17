#!/bin/bash
# 带 runtime token 探真实能力清单
docker exec dotd-dot-dot1 sh -c '
T=$(cat /run/dotd/token)
echo "healthz:"; curl -s -m 5 -H "authorization: Bearer $T" http://127.0.0.1:9223/healthz; echo
echo "capabilities:"; curl -s -m 5 -H "authorization: Bearer $T" http://127.0.0.1:9223/capabilities | head -c 3000; echo
echo "fs list:"; curl -s -m 5 -X POST -H "authorization: Bearer $T" -H "content-type: application/json" -d "{\"call_id\":\"probe1\",\"op\":\"list\",\"path\":\"/dot/home\"}" http://127.0.0.1:9223/fs/ops | head -c 800; echo
'
