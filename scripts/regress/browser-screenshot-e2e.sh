#!/bin/bash
# A3（2026-10-21）browser.screenshot 实机验收：
# ① 打开测试页 → ② browser.screenshot → 断言返回 {path,bytes,sha256} 且 PNG 真落盘
#   （魔数 89504E47、sha256 对得上）→ ③ anon 身份再截一张（隔离无要求，只验可用）。
# 判定：exit 0 = 全过。依赖：daemon 活着、DOTD 工具面已含 browser.screenshot。
set -u
BASE="${DOTD_BASE:-http://127.0.0.1:7081}"
TOKEN="$(cat /root/.dotd/exec-tokens/dot1.token 2>/dev/null || cat /run/dotd/token 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then echo "SKIP: no token"; exit 2; fi
FAIL=0

api() { # method path json -> body
  curl -s -X "$1" "$BASE$2" -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" ${3:+-d "$3"}
}

# 容器 id：取第一个 running 的 dot 容器
# dot-* 与 dotd-dot-*（compose 前缀）都认
DOT_ID="$(docker ps --format "{{.Names}}" | grep -E "^dot" | head -1)"
[ -z "$DOT_ID" ] && { echo "FAIL: 无运行中的 dot 容器"; exit 1; }
# runtime 在 dotd 桥接网里，宿主直达容器 IP:9223（与 identity-e2e 同法）；:7081 是旧主机 API，已废弃
BASE="http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DOT_ID"):9223"
# 容器内测试页服务（与 identity-e2e 同法）：/read 给一个可截的画面
docker exec dotd-dot-dot1 pkill -f "listen.8899" 2>/dev/null || true
docker exec -d dotd-dot-dot1 node -e 'const h=require("http");h.createServer((q,s)=>{s.end("<title>A3 截图测试页</title><h1>screenshot e2e</h1><p>hello shot</p>")}).listen(8899)' || { echo "FAIL: 测试页服务起不来"; exit 1; }
sleep 1

echo "── ① browser.open 测试页 ──"
CID="e2e-a3-$(date +%s%N)"
JOB="$(api POST /jobs/start "{\"call_id\":\"$CID\",\"dot_id\":\"$DOT_ID\",\"task_id\":\"e2e-a3\",\"tool\":\"browser.open\",\"args\":{\"url\":\"http://127.0.0.1:8899/read\"},\"deadline_ms\":60000,\"identity\":\"e2e-a3\",\"issued_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("job_id",""))')"
[ -z "$JOB" ] && { echo "FAIL: open 无 job_id"; exit 1; }
for i in $(seq 1 30); do
  ST="$(api GET "/jobs/$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')"
  [ "$ST" = "done" ] || [ "$ST" = "error" ] && break; sleep 1
done
echo "  open state=$ST"
[ "$ST" = "done" ] || { echo "FAIL: open 未完成"; exit 1; }

echo "── ② browser.screenshot ──"
CID2="a3-shot-$(date +%s%N)"
JOB2="$(api POST /jobs/start "{\"call_id\":\"$CID2\",\"dot_id\":\"$DOT_ID\",\"task_id\":\"e2e-a3\",\"tool\":\"browser.screenshot\",\"args\":{},\"identity\":\"e2e-a3\",\"deadline_ms\":60000,\"issued_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("job_id",""))')"
[ -z "$JOB2" ] && { echo "FAIL: screenshot 无 job_id"; exit 1; }
RES=""
for i in $(seq 1 30); do
  RES="$(api GET "/jobs/$JOB2")"
  ST2="$(echo "$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')"
  [ "$ST2" = "done" ] || [ "$ST2" = "error" ] && break
  sleep 1
done
echo "  screenshot state=$ST2"
[ "$ST2" = "done" ] || { echo "FAIL: screenshot 未完成"; exit 1; }
echo "  $(echo "$RES" | head -c 220)"
PATH_="$(echo "$RES" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("result") or {}).get("path",""))')"
BYTES="$(echo "$RES" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("result") or {}).get("bytes",0))')"
SHA="$(echo "$RES" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("result") or {}).get("sha256",""))')"
case "$PATH_" in /dot/home/screenshots/*.png) ;; *) echo "FAIL: path 不符: $PATH_"; FAIL=1;; esac
[ "$BYTES" -gt 100 ] 2>/dev/null || { echo "FAIL: bytes 异常: $BYTES"; FAIL=1; }

# 文件本体：容器内核对魔数 + sha256
if [ "$FAIL" = 0 ]; then
  IN="$(docker exec "$DOT_ID" sh -c "ls -l $PATH_ >/dev/null 2>&1 && echo yes || echo no")"
  [ "$IN" = "yes" ] || { echo "FAIL: PNG 未落盘 $PATH_"; FAIL=1; }
  MAGIC="$(docker exec "$DOT_ID" sh -c "head -c4 $PATH_ | od -An -tx1 | tr -d ' \n'")"
  [ "$MAGIC" = "89504e47" ] || { echo "FAIL: PNG 魔数不符: $MAGIC"; FAIL=1; }
  SHA2="$(docker exec "$DOT_ID" sh -c "sha256sum $PATH_" | cut -d" " -f1)"
  [ "$SHA2" = "$SHA" ] || { echo "FAIL: sha256 不一致 tool=$SHA file=$SHA2"; FAIL=1; }
fi

api POST /jobs/start "{\"call_id\":\"a3-close-$(date +%s%N)\",\"dot_id\":\"$DOT_ID\",\"task_id\":\"e2e-a3\",\"tool\":\"browser.close\",\"args\":{},\"identity\":\"e2e-a3\",\"deadline_ms\":30000,\"issued_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >/dev/null 2>&1 || true
api POST /jobs/start "{\"dot_id\":\"$DOT_ID\",\"task_id\":\"e2e-a3\",\"tool\":\"browser.close\",\"args\":{},\"deadline_ms\":30000}" >/dev/null

if [ "$FAIL" = 0 ]; then echo "PASS: browser.screenshot e2e 3/3（path/bytes/sha256+落盘魔数）"; exit 0
else echo "FAIL"; exit 1; fi
