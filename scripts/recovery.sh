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
# **OUTDIR 必须可覆盖**（2026-10-20 修，真缺陷）。
#
# 原来这里硬编码 `/root/dotd/docs/acceptance`，而下面紧接着就 `: > "$RESULTS"`
# 清空证据文件。于是想验证"判定逻辑判得对不对"**只能拿真证据去跑**，
# 跑一次证据就没了 —— 而验收脚本本身恰恰是最该被验证的东西：
# 它是 S3/S4/S5 的唯一证据来源，判错了没人会发现。
#
# 对照：soak.sh 早就支持 `SOAK=` 覆盖（第 22 行注释写得很清楚：
# "便于用合成数据验证 report 的判断逻辑是否真的判得对"）。
# 三个验收脚本漏了这件事，等于它们的判定逻辑**从来没被验证过**。
#
# 与 SOAK 同一套约定：设了就用，没设就用默认。往回兼容，不影响正常验收。
OUTDIR="${DOTD_ACCEPT_DIR:-/root/dotd/docs/acceptance}"
mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/recovery.jsonl"
export RESULTS

# **纯判定模式：只看已有证据，不跑任何故障、不清空任何文件**（2026-10-20 修，真缺陷）。
#
# 原来想验证"这份判定逻辑判得对不对"，只能拿真证据去跑 —— 而脚本第一件事就是
# `: > "$RESULTS"` 清空证据，而且它会**真的去 kill -9 daemon、停容器**。
# 于是验收脚本自己**从来没被验证过**：它是 S5 的唯一证据来源（回归引用次数 = 0）。
#
# 对照 soak.sh：早就支持 `SOAK=` 覆盖 + `report` 只读不写。
# 用法：`recovery.sh --judge`（读 $RESULTS，按同样的三态口径给结论）
if [ "${1:-}" = "--judge" ]; then
  node -e '
const fs=require("fs");
let ls=[]; let bad=0;
try{
  for(const ln of fs.readFileSync(process.env.RESULTS,"utf8").split("\n")){
    if(!ln.trim()) continue;
    try{ ls.push(JSON.parse(ln)); }catch{ bad++; }
  }
}catch(e){
  console.log("");
  console.log("判定：❌ **证据文件读不出来**："+process.env.RESULTS+" —— "+(e.code||e.message));
  console.log("　　　　（先确认路径对不对；`--judge` 只读不写，不会碰你的证据）");
  process.exit(1);
}
if(bad) console.log(`⚠ ${bad} 行残缺，已跳过`);
const total=ls.length, pass=ls.filter(r=>r.pass).length;
for (const r of ls) console.log((r.pass?"✔":"✖"), String(r.id||"").padEnd(16), String((r.secs||0)+"s").padStart(6), r.name||"", "|", r.evidence||"");
console.log("");
// **0 条不能说"已验的 0 项全过"**（2026-10-20 修，与 acceptance/honesty 同一处病根）。
// 原来 `notRun.length===3` 时打印"⏳ 已验的 0 项全过，但还差 3 项"，
// **"0 项全过"是空话** —— 没有证据不等于证据合格。必须先分流"一条都没有"。
const ALL_IDS=["container_stop","relay_down","daemon_kill"];
const ranIds=new Set(ls.map(r=>r.id));
const notRun=ALL_IDS.filter(id=>!ranIds.has(id));
if(total===0){
  console.log("判定：❌ **一条证据都没有**：文件里没有任何记录 —— 先确认三种故障有没有真的验过");
  process.exit(1);
}
console.log(`${pass}/${total} 自愈` + (notRun.length?`   没验：${notRun.join(", ")}`:""));
if(pass!==total){
  console.log(`判定：❌ 未达标（${total-pass} 项没通过）`);
  process.exit(1);
}
if(notRun.length){
  console.log(`判定：⏳ 已验的 ${total} 项全过，但还差 ${notRun.length} 项没验（${notRun.join(", ")}）—— 覆盖面不够`);
  process.exit(3);
}
console.log("判定：✅ 达标");
process.exit(0);'
  # **必须立刻 exit**（2026-10-20 修，真缺陷）：
  # 没有这一句，`--judge` 打印完判定后会**继续往下跑真实故障** ——
  # 它会 kill -9 daemon、停容器、改网关，把正在跑的服务真的弄坏。
  # 症状极具迷惑性：判定文字完全正确，但退出码永远是最后那轮真实汇总留下的值。
  # 这是第⑩类的镜像：**改了退出码，但没让它成为脚本的退出码**。
  exit $?
fi

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
  # **杀之前先确认它本来是活的**（2026-10-20 修，真缺陷）。
  # 现场：单跑 relay_down 报"造故障失败：13065 仍可连"。查下去发现
  # 上一步 container_stop 之后 relay 已经意外死了（或者刚被别的原因打死），
  # 脚本对着一个**已经死的**目标执行 kill，然后立刻看到 watchdog 把它拉起来，
  # 于是误判成"没杀掉"。**造故障失败被记成了验收失败**——两种完全不同的结论。
  # 修法：杀之前先探活，本来就不通就直接说"前提不成立"，不去杀。
  if ! c_relay; then
    echo "  ! [relay_down] 杀之前 13065 就不通 —— 前提不成立，先等它起来"
    if ! wait_until c_relay >/dev/null; then
      record relay_down "网关端口不可用" 0 0 "造故障失败：13065 本来就不可用（前提不成立，不是 dotd 的问题）"
      RELAY_SKIP=1
    fi
  fi
  if [ "${RELAY_SKIP:-0}" != "1" ]; then
  # **必须"杀掉并确认断了"，不能"杀掉 + sleep 3 后看一眼"**（2026-10-20 修，真缺陷）。
  # 现场：完整跑三项时 relay_down 报"造故障失败：13065 仍可连（0s）"，
  # 但同样一条命令手工执行、单独跑本项都能杀成。差别在于——
  # container_stop 那 47 秒里 watchdog 也在跑（每 2 分钟一轮），
  # 它发现有环节不对就会把 relay 拉起来；固定 sleep 3 正好撞上刚被拉起的瞬间，
  # 于是"杀掉了又被拉起"被判成"根本没杀掉"。**造故障失败 ≠ 验收失败**。
  # 修法：杀掉后**轮询 20 秒确认真的断了**，断了才继续；
  # 20 秒内一直被拉起 → 明确说"杀不住（watchdog 抢着拉起）"，这是环境问题不是 dotd 问题。
  RELAY_KILLED=0
  for _i in $(seq 1 20); do
    powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*win-relay.mts*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
    sleep 1
    if ! c_relay; then RELAY_KILLED=1; break; fi
  done
  if [ "$RELAY_KILLED" != "1" ]; then
    record relay_down "网关端口不可用" 0 0 "造故障失败：20 秒内一直被拉起（watchdog 抢跑），不是 dotd 的问题"
  elif false; then
    :
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
// **只跑了部分项时不能说"未达标"**（2026-10-20 修）。
// 原来硬编码 total===3，于是"只跑 2 项且 2 项全过"也被打成 ❌ ——
// 那是把"没全测"说成"没通过"，两种完全不同的结论（第⑨类：标签会撒谎）。
// 正确语义：
//   · 全过且跑满 3 项 → ✅ 达标，exit 0
//   · 全过但只跑了 n<3 项 → ⏳ 已跑的 n 项全过，还剩 3-n 项没验，exit 3（区别于失败）
//   · 有任何一项没过 → ❌ 未达标，exit 1
const ALL_IDS=["container_stop","relay_down","daemon_kill"];
const ranIds=new Set(ls.map(r=>r.id));
const notRun=ALL_IDS.filter(id=>!ranIds.has(id));
console.log(`合计 ${pass}/${total} 自愈 = ${(pass/total*100).toFixed(0)}%` + (notRun.length?`   本次只验了 ${total}/3 项（未验：${notRun.join(", ")}）`:`   判据：3/3 且均在 ${process.env.LIMIT||300}s 内`));
if(pass!==total){ console.log("结论：❌ 未达标"); process.exit(1); }
if(notRun.length){ console.log(`结论：⏳ 已验的 ${total} 项全过，但还差 ${notRun.length} 项没验 —— 这不等于通过`); process.exit(3); }
console.log("结论：✅ 达标");
process.exit(0);'
