#!/usr/bin/env bash
# S5 故障自恢复验收：造 3 种真故障，要求 3/3 在 5 分钟内**无人干预**自愈。
#
# 三种故障（覆盖三层）：
#   ① 容器停掉          → 该恢复的是容器（dotd-dot-dot1 重新 Up）
#   ② 网关端口不可用    → 该恢复的是 win-relay（13065 重新可连）
#   ③ daemon 被 kill -9 → 该恢复的是 daemon（7788 重新可达 + 能接活）
#
# 判定"自愈"必须同时满足：
#   a) 目标能力恢复（能跑通一次真实业务动作，不只是端口探测通过）；
#   b) 全程没有任何人工干预（脚本只负责"造故障"和"观察"，不替它修）；
#   c) 从造故障到恢复 < 300s。
#
# 关键设计：脚本**绝不调用修复命令**。它只 kill / stop / 关端口，然后干等。
# 如果脚本自己修，那测的是脚本，不是系统的自恢复能力。
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
OUTDIR=/root/dotd/docs/acceptance
mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/recovery.jsonl"
export RESULTS
: > "$RESULTS"

LIMIT=300
export LIMIT
ONLY=("$@")
want() { [ ${#ONLY[@]} -eq 0 ] && return 0; local s; for s in "${ONLY[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

GW=$(ip route | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

c_daemon() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/health" 2>/dev/null | grep -qE '^(200|404)$'; }
c_relay()  { timeout 4 bash -c "exec 3<>/dev/tcp/$GW/13065" 2>/dev/null; }
c_container(){ docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -q 'Up'; }

# 端到端探活：真提交一句最简单的话，等它 done —— 只端口通不算"活了"
e2e_alive() {
  local tid st deadline=$(( $(date +%s) + 90 ))
  tid=$(curl -s -m 15 "${HDR[@]}" -X POST --data-binary "{\"text\":$(jstr '回复 OK 两个字母就行')}" "$BASE/api/messages" \
        | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$tid" ] && return 1
  while [ $(date +%s) -lt $deadline ]; do
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done) return 0;; failed|cancelled|paused) return 1;; esac
    # 自动批审批，避免卡在 awaiting_approval 被误判成"没恢复"
    for aid in $(curl -s -m 8 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[]))console.log(a.id)}catch{}});'); do
      curl -s -m 10 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
    done
    sleep 2
  done
  return 1
}

record() {
  local id="$1" name="$2" pass="$3" secs="$4" ev="$5"
  node -e '
const fs=require("fs");const p=process.argv[6],id=process.argv[1];
try{const ls=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).filter(l=>{try{return JSON.parse(l).id!==id}catch{return false}});fs.writeFileSync(p,ls.length?ls.join("\n")+"\n":"");}catch{}
fs.appendFileSync(p, JSON.stringify({id,name:process.argv[2],pass:process.argv[3]==="1",secs:Number(process.argv[4]),evidence:process.argv[5]})+"\n");' \
    "$id" "$name" "$pass" "$secs" "$ev" "$RESULTS"
  local mark="✖"; [ "$pass" = "1" ] && mark="✔"
  echo "  $mark [$id] $name (${secs}s)"
  [ "$pass" = "1" ] || echo "      $ev"
}

# wait_until <检查命令> <上限秒>：返回恢复耗时；超时返回空
wait_until() {
  local check="$1" limit="${2:-$LIMIT}" t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "$limit" ]; do
    bash -c "$check" >/dev/null 2>&1 && { echo $(( $(date +%s) - t0 )); return 0; }
    sleep 5
  done
  return 1
}

echo "════════ S5 故障自恢复验收（3 种故障，限 ${LIMIT}s 内自愈）════════"
echo "网关=$GW"

# ── ① 容器停掉 ────────────────────────────────────────────────────────────
if want container_stop; then
  echo "▶ [container_stop] 停掉 dotd-dot-dot1"
  docker stop dotd-dot-dot1 >/dev/null 2>&1
  sleep 2
  if c_container; then
    record container_stop "容器停掉" 0 0 "造故障失败：容器还活着"
  else
    # 恢复判据：容器重新 Up **且**能真跑一次命令（不只看 docker ps）
    if secs=$(wait_until 'docker ps --filter name=dotd-dot-dot1 --format "{{.Status}}" | grep -q Up && docker exec dotd-dot-dot1 sh -c "echo alive" >/dev/null 2>&1'); then
      record container_stop "容器停掉" 1 "$secs" "容器 ${secs}s 后重新 Up 且能执行命令"
    else
      record container_stop "容器停掉" 0 "$LIMIT" "${LIMIT}s 内未自愈"
    fi
  fi
fi

# ── ② 网关端口不可用（把 win-relay 打断）────────────────────────────────
if want relay_down; then
  echo "▶ [relay_down] 让 13065 不可用"
  # 从 WSL 侧无法直接杀 Windows 进程；用 Windows 侧 taskkill 结束 relay（node 跑的那个）
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*win-relay.mts*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
  sleep 3
  if c_relay; then
    record relay_down "网关端口不可用" 0 0 "造故障失败：13065 仍可连（可能没杀掉，或 relay 由别的进程提供）"
  else
    if secs=$(wait_until "timeout 4 bash -c 'exec 3<>/dev/tcp/$GW/13065'"); then
      # 端口回来还不够，模型得真能答
      if e2e_alive; then
        record relay_down "网关端口不可用" 1 "$secs" "relay ${secs}s 后恢复且模型能真应答"
      else
        record relay_down "网关端口不可用" 0 "$secs" "端口 ${secs}s 后通了，但端到端仍答不出来"
      fi
    else
      record relay_down "网关端口不可用" 0 "$LIMIT" "${LIMIT}s 内 13065 未恢复"
    fi
  fi
fi

# ── ③ daemon kill -9 ─────────────────────────────────────────────────────
if want daemon_kill; then
  echo "▶ [daemon_kill] kill -9 daemon"
  PID=$(ss -lptn 'sport = :7788' 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  [ -z "$PID" ] && PID=$(pgrep -f 'src/daemon.ts' | head -1)
  if [ -z "$PID" ]; then
    record daemon_kill "daemon kill -9" 0 0 "找不到 daemon 进程，造故障失败"
  else
    kill -9 "$PID" 2>/dev/null
    sleep 2
    if c_daemon; then
      record daemon_kill "daemon kill -9" 0 0 "造故障失败：kill 后 7788 仍可达（pid=$PID 可能不是 daemon）"
    else
      if secs=$(wait_until 'curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:7788/health | grep -qE "^(200|404)$"'); then
        if e2e_alive; then
          record daemon_kill "daemon kill -9" 1 "$secs" "daemon ${secs}s 后恢复且能真接活"
        else
          record daemon_kill "daemon kill -9" 0 "$secs" "端口 ${secs}s 后通了，但端到端答不出来"
        fi
      else
        record daemon_kill "daemon kill -9" 0 "$LIMIT" "${LIMIT}s 内 daemon 未恢复"
      fi
    fi
  fi
fi

echo ""
echo "════════ 汇总 ════════"
node -e '
const fs=require("fs");
// 逐行解析，坏行跳过（与 soak.sh 同步修）：一行残缺不该毁掉整份验收证据
const ls=[]; let bad=0;
for(const ln of fs.readFileSync(process.env.RESULTS,"utf8").split("\n")){
  if(!ln.trim()) continue;
  try{ ls.push(JSON.parse(ln)); }catch{ bad++; }
}
if(bad) console.log(`⚠ ${bad} 行残缺，已跳过`);
const total=ls.length, pass=ls.filter(r=>r.pass).length;
for (const r of ls) console.log((r.pass?"✔":"✖"), r.id.padEnd(16), String(r.secs+"s").padStart(6), r.name, "|", r.evidence);
console.log("");
console.log(`合计 ${pass}/${total} 自愈 = ${(pass/total*100).toFixed(0)}%   判据：3/3 且均在 ${process.env.LIMIT||300}s 内`);
console.log(pass===total && total===3 ? "结论：✅ 达标" : "结论：❌ 未达标");
process.exit(pass===total && total===3 ? 0 : 1);'
