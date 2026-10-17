#!/bin/bash
set -u
echo "=== Windows 侧 hy3 代理 :3065 是否在听 ==="
curl -s -m 5 -o /dev/null -w 'http_code=%{http_code}\n' http://127.0.0.1:3065/v1/models 2>&1 || echo "连不上"
echo
echo "=== win-tcp-relay :13065（从 WSL 侧探测）==="
# 换环境不用改脚本：export RELAY_HOST=<WSL 网关 IP 或 Windows 内网 IP> 即可；
# 留空则用默认网关探测。WSL2 网关常见是 172.x.0.1，但随发行版/配置会变。
RELAY_HOST="${RELAY_HOST:-172.17.48.1}"
RELAY_PORT="${RELAY_PORT:-13065}"
curl -s -m 5 -o /dev/null -w 'http_code=%{http_code}\n' "http://$RELAY_HOST:$RELAY_PORT/v1/models" 2>&1 || echo "连不上"
echo
echo "=== breaker 状态 ==="
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/root/.dotd/dotd.db');
const rows = db.prepare('SELECT * FROM breaker_state').all();
console.log(JSON.stringify(rows, null, 1));
" 2>&1 | head -30
echo
echo "=== router mode / events ==="
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/root/.dotd/dotd.db');
const rows = db.prepare(\"SELECT * FROM router_state\").all();
console.log('router_state:', JSON.stringify(rows));
" 2>&1 | head -10
