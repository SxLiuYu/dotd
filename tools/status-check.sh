#!/bin/bash
set -u
echo "=== 生产 daemon 健康 ==="
curl -s -m 5 http://127.0.0.1:7789/api/health | head -c 500
echo
echo
echo "=== 容器状态 ==="
curl -s -m 5 http://127.0.0.1:7789/api/status | head -c 600
echo
echo
echo "=== 审批挂起数 ==="
TOK=$(node -e "const fs=require('fs');const m=/DOTD_MASTER_TOKEN=([0-9a-f]+)/.exec(fs.readFileSync('/root/.dotd/tokens.env','utf8'));process.stdout.write(m[1])")
curl -s -m 5 -H "authorization: Bearer $TOK" "http://127.0.0.1:7789/api/queue" | head -c 400
echo
