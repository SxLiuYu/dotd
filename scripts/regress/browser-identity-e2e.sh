#!/usr/bin/env bash
# A1 浏览器登录态持久化 实机验收（2026-10-21）
# 需要 live 栈：WSL docker + 容器 dotd-dot-dot1 的 runtime(9223) + exec token。
# 证明链：
#   ① 同一 identity 设 cookie → 立即读回（会话内前提）
#   ② docker restart 容器后同 identity 读回 —— cookie 仍在 = profile 落 /dot/profiles 卷
#   ③ anon 对照 → 无 cookie（非持久路径不受污染）
# 用法：bash scripts/regress/browser-identity-e2e.sh   （exit 0=全过）
set -u
cd "$(dirname "$0")/../.."
FAIL=0
T() { local name="$1"; if eval "$2" >/dev/null 2>&1; then echo "  ✓ $name"; else echo "  ✗ $name"; echo "    原始: $(echo "$R" | head -c 300)"; FAIL=1; fi }

EP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dotd-dot-dot1):9223"
TOK="$(cat /root/.dotd/exec-tokens/dot1.token)"

# browser.* 是 async 工具：POST /jobs/start → {job_id} → 轮询 /jobs/{id} 到终态，
# 输出整个响应体（done 时含 result，grep 直接在全文上做）。
call_tool() { # tool args-json identity（"-"=不带 identity）
  local tool="$1" args="$2" identity="$3" cid="a1e2e-$(date +%s%N)"
  local body="{\"call_id\":\"$cid\",\"task_id\":\"a1-e2e\",\"dot_id\":\"dot1\",\"tool\":\"$tool\",\"args\":$args,\"deadline_ms\":25000,\"issued_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  [ "$identity" != "-" ] && body="$body,\"identity\":\"$identity\""
  body="$body}"
  local start job
  start="$(curl -s -m 30 -X POST "http://$EP/jobs/start" \
    -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$body")"
  job="$(echo "$start" | grep -o '"job_id":"[^"]*"' | head -1 | cut -d\" -f4)"
  if [ -z "$job" ]; then echo "$start"; return; fi
  for _ in $(seq 1 25); do
    local poll
    poll="$(curl -s -m 5 -H "authorization: Bearer $TOK" "http://$EP/jobs/$job")"
    case "$poll" in
      *'"state":"done"'*|*'"state":"error"'*|*'"state":"cancelled"'*) echo "$poll"; return ;;
    esac
    sleep 1
  done
  echo "{\"state\":\"error\",\"error\":{\"message\":\"poll 超时\"}}"
}

# 容器内 cookie 服务：/set 发 cookie（title=SET）；/read 回显 Cookie（title=CK <cookie|none>）
docker exec dotd-dot-dot1 pkill -f "listen.8899" 2>/dev/null || true
docker exec -d dotd-dot-dot1 node -e 'const h=require("http");h.createServer((q,s)=>{if(q.url.startsWith("/set")){s.setHeader("set-cookie","sid=e2e123; Path=/; Max-Age=86400");s.end("<title>SET</title>")}else{s.end("<title>CK "+(q.headers.cookie||"none")+"</title>")}}).listen(8899)' || { echo "  ✗ cookie 服务起不来"; exit 1; }
sleep 1

R="$(call_tool browser.open '{"url":"http://127.0.0.1:8899/set"}' e2e-a1)"
T "① open /set（identity=e2e-a1）"          "echo '$R' | grep -q '\"state\":\"done\"'"

R="$(call_tool browser.open '{"url":"http://127.0.0.1:8899/read"}' e2e-a1)"
T "② 同身份读回 cookie（重启前）"            "echo '$R' | grep -q 'CK sid=e2e123'"

# ②b 干净关闭：persistent context ctx.close() → Chromium 落盘 cookie（真实 agent 收尾流程）。
# 不 close 就 docker restart 会硬杀 Chromium，cookie 批量写盘（~30s 或干净关闭）来不及 → 丢。
R="$(call_tool browser.close '{}' e2e-a1)"
T "②b browser.close（干净关闭落盘）" "echo '$R' | grep -q '\"state\":\"done\"'"
echo "    profile 目录: $(docker exec dotd-dot-dot1 sh -c 'ls /dot/profiles/ 2>/dev/null | head -3' | tr '\n' ' ')"

docker restart dotd-dot-dot1 >/dev/null
OK=0; for i in $(seq 1 30); do curl -s -m 2 -H "authorization: Bearer $TOK" "http://$EP/healthz" >/dev/null 2>&1 && { OK=1; break; }; sleep 2; done
T "③ 容器重启后 healthz 恢复"               "test $OK -eq 1"

# cookie 服务随容器一起死了：重启后重新拉起（被测对象是 profile 持久化，不是服务存活）
docker exec -d dotd-dot-dot1 node -e 'const h=require("http");h.createServer((q,s)=>{if(q.url.startsWith("/set")){s.setHeader("set-cookie","sid=e2e123; Path=/; Max-Age=86400");s.end("<title>SET</title>")}else{s.end("<title>CK "+(q.headers.cookie||"none")+"</title>")}}).listen(8899)'
sleep 1

R="$(call_tool browser.open '{"url":"http://127.0.0.1:8899/read"}' e2e-a1)"
T "④ 重启后同身份 cookie 仍在（持久 profile 生效）" "echo '$R' | grep -q 'CK sid=e2e123'"

R="$(call_tool browser.open '{"url":"http://127.0.0.1:8899/read"}' anon)"
T "⑤ anon 无痕（不继承持久 cookie）"         "echo '$R' | grep -q 'CK none'"

echo "browser-identity-e2e: FAIL=$FAIL (0=全过)"
exit $FAIL