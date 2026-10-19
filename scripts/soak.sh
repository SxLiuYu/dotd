#!/usr/bin/env bash
# S6 长期运行（7 天）验收工具。
#
# 判据（原文）：连续 7 天不干预；RSS 增长 < 50MB；成功率保持；无句柄泄漏。
#
# 为什么这么设计：7 天没法"跑一下就算完"。只能**真的跑 7 天**，
# 期间每 30 分钟采一次样、每 6 小时跑一次真实业务探针。所以这里提供：
#   sample  —— 采一个数据点（RSS / fd / 线程数 / 容器状态），追加到 soak.jsonl
#   probe   —— 跑一条真实业务任务（不是端口探测），记录成功/失败
#   report  —— 读 soak.jsonl，算已运行时长、RSS 增长、fd 增长、成功率，给结论
#
# 采样本身**绝不重启任何东西**：一旦它去"修理"，测的就不是长期稳定性了。
#
# 装进 cron（见 install_cron 输出）：
#   */30 * * * *  soak.sh sample
#   0 */6 * * *   soak.sh probe
set -uo pipefail
cd /root/dotd || exit 1
OUTDIR=/root/dotd/docs/acceptance
mkdir -p "$OUTDIR"
# 允许用 SOAK=... 覆盖，便于用合成数据验证 report 的判断逻辑是否真的判得对
# （不然只能等 7 天才能知道"它会判错吗"，那太晚了）。
SOAK="${SOAK:-$OUTDIR/soak.jsonl}"
export SOAK

PID_DAEMON() { pgrep -f 'src/daemon.ts' | head -1; }

do_sample() {
  local pid rss_kb fd n_threads cont db_kb ts
  ts=$(date +%s)
  pid=$(PID_DAEMON)
  if [ -z "$pid" ]; then
    node -e 'const fs=require("fs");fs.appendFileSync(process.env.SOAK, JSON.stringify({ts:Number(process.argv[1]),alive:false})+"\n")' "$ts"
    echo "daemon 不在跑（已记录 alive=false）"
    return 0
  fi
  rss_kb=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
  n_threads=$(ls "/proc/$pid/task" 2>/dev/null | wc -l)
  fd=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
  cont=$(docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -c Up || true)
  db_kb=$(stat -c '%s' "$HOME/.dotd/dotd.db" 2>/dev/null | awk '{print int($1/1024)}')
  # **记录 daemon 身份**（进程启动时刻 + pid）。没有这个，RSS 判据是假的：
  # 2026-10-19 实测就踩到了 —— 采样 3 个点算出"RSS 增长 -32.1MB"，看着很好，
  # 其实是中途 daemon 被重启过，拿"新进程的小内存"减"旧进程的大内存"，
  # 毫无意义。只有同一个 daemon 生命周期内的首尾差才是"增长"。
  proc_start=$(stat -c %Y "/proc/$pid" 2>/dev/null || echo 0)
  node -e '
const fs=require("fs");
const o={ts:Number(process.argv[1]),alive:true,rss_kb:Number(process.argv[2]),
  fd:Number(process.argv[3]),threads:Number(process.argv[4]),
  container_up:Number(process.argv[5]),db_kb:Number(process.argv[6]),
  pid:Number(process.argv[7]),proc_start:Number(process.argv[8])};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$rss_kb" "$fd" "$n_threads" "$cont" "${db_kb:-0}" "$pid" "${proc_start:-0}"
  echo "sample: rss=${rss_kb}KB fd=$fd threads=$n_threads container_up=$cont db=${db_kb}KB pid=$pid"
}

do_probe() {
  local tid st t0 ok=0 ts
  ts=$(date +%s)
  set -a; . ./_tokens_src.env 2>/dev/null; set +a
  local base=http://127.0.0.1:7788
  local hdr=(-H "Authorization: Bearer ${DOTD_MASTER_TOKEN:-}" -H "Content-Type: application/json")
  t0=$(date +%s)
  tid=$(curl -s -m 20 "${hdr[@]}" -X POST --data-binary '{"text":"回复 OK 两个字母就行"}' "$base/api/messages" \
        | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  if [ -n "$tid" ]; then
    local deadline=$(( $(date +%s) + 120 ))
    while [ $(date +%s) -lt $deadline ]; do
      st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
      [ "$st" = "done" ] && { ok=1; break; }
      case "$st" in failed|cancelled|paused) break ;; esac
      sleep 3
    done
  fi
  node -e '
const fs=require("fs");
const o={ts:Number(process.argv[1]),kind:"probe",ok:process.argv[2]==="1",
  taskId:process.argv[3]||"",status:process.argv[4]||"",secs:Number(process.argv[5])};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$ok" "$tid" "${st:-}" "$(( $(date +%s) - t0 ))"
  echo "probe: ok=$ok status=${st:-none} secs=$(( $(date +%s) - t0 ))"
}

do_report() {
  node -e '
const fs=require("fs");
let lines=[];
try{lines=fs.readFileSync(process.env.SOAK,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);}catch{}
const probes=lines.filter(x=>x.kind==="probe");
// 修复前采的样本没有 pid/proc_start 字段（那时还没记录身份），
// 它们无法参与"生命周期"判断，单独算一类，不混进来算增长。
const raw=lines.filter(x=>x.kind!=="probe"&&x.alive);
const legacy=raw.filter(s=>s.proc_start===undefined||s.pid===undefined);
const all=raw.filter(s=>s.proc_start!==undefined&&s.pid!==undefined);
if(!all.length){
  console.log("还没有可用于判据的样本（无 pid 的历史样本 "+legacy.length+" 条已忽略）");
  process.exit(1);
}

// **只跟同一个 daemon 生命周期比较**（见 sample 里的注释：跨重启会算出负数增长）
const cur=all[all.length-1];
const sameLifetime=all.filter(s=>s.proc_start===cur.proc_start && s.pid===cur.pid);
const S=sameLifetime.length?sameLifetime:all;

const first=all[0], last=all[all.length-1];
const hours=(last.ts-first.ts)/3600, days=hours/24;

// **连续性**（2026-10-19 补）：只看"首尾跨了 7 天"是不够的 ——
// 采样器如果在中间死了 3 天，首尾照样跨 7 天，报告会给出一个虚假的"连续 7 天"。
// 真实的 7×24 里，cron 每 30 分钟一个点，正常间隔 1800s；
// 窗口内若出现远超此值的空档，说明那段没在观测，必须扣掉。
const sorted=all.slice().sort((a,b)=>a.ts-b.ts);
const GAP_LIMIT=5400;                  // 90 分钟：容忍 cron 抖动/一次漏跑
let maxGap=0, deadTotal=0;
for(let i=1;i<sorted.length;i++){
  const g=sorted[i].ts-sorted[i-1].ts;
  if(g>maxGap) maxGap=g;
  if(g>GAP_LIMIT) deadTotal+=g-GAP_LIMIT;   // 超出容忍的部分算"没在看"
}
const coveredDays=Math.max(0,(hours*3600-deadTotal))/86400;
const rss0=S[0].rss_kb/1024, rssN=S[S.length-1].rss_kb/1024;
const growth=rssN-rss0;
const fdGrowth=S[S.length-1].fd-S[0].fd;
const thGrowth=S[S.length-1].threads-S[0].threads;
const maxRss=Math.max(...S.map(s=>s.rss_kb))/1024;
const maxFd=Math.max(...S.map(s=>s.fd));
const passRate=probes.length? probes.filter(p=>p.ok).length/probes.length : null;

// 生命周期 = 一个 daemon 进程从生到死。>1 说明期间重启过 ——
// "连续 7 天不干预"必须把这件事显式说出来，否则报告在撒谎。
const lifeMap=new Map();
for(const s of all){
  const k=String(s.proc_start)+":"+String(s.pid);
  if(!lifeMap.has(k)) lifeMap.set(k,{key:k,pid:s.pid,first:s.ts,last:s.ts,samples:0});
  const L=lifeMap.get(k); L.last=s.ts; L.samples++;
}
const lifetimes=lifeMap.size;
const LIFE=[...lifeMap.values()].sort((a,b)=>a.first-b.first);

// **重启归因**（2026-10-19 补）：S6 的字面要求是"无**人工**干预"，
// 而"重启过几次"本身不区分"自愈救回来的"和"人去手动拉起来的"。
// 这两者性质完全不同：watchdog 自愈恰恰是长期运行该有的能力，
// 而人工重启会让"连续 7 天"作废。所以每次重启都要去 watchdog 日志里找证据：
// 新生命周期开始前 15 分钟内若有"自愈:…已恢复"记录 → 判为自愈；
// 找不到 → 如实标成"无自愈记录"，不替它圆场。
const WD=process.env.DOTD_WATCHDOG_LOG||"/var/log/dotd-watchdog.log";
let wdLines=[];
try{
  wdLines=fs.readFileSync(WD,"utf8").split("\n").filter(Boolean)
    .map(l=>{
      const m=l.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+(.*)$/);
      if(!m) return null;
      return { ts: Math.floor(new Date(`${m[1]}T${m[2]}`).getTime()/1000), text: m[3] };
    }).filter(Boolean);
}catch{}
const healed=wdLines.filter(w=>w.text.includes("已恢复"));
const restartRows=[];
for(let i=1;i<LIFE.length;i++){
  const prev=LIFE[i-1], cur2=LIFE[i];
  // 新进程的 proc_start 是它真正起来的时刻，比首个采样点更准
  const bornAt=cur2.key.split(":")[0];
  const born=Number(bornAt)||cur2.first;
  const near=healed.filter(w=>w.ts>=born-900 && w.ts<=born+300);
  restartRows.push({
    pid:cur2.pid, born,
    healed: near.length>0,
    evidence: near.map(w=>w.text).join(" / "),
    downtimeSec: Math.max(0, born-prev.last),
  });
}
const unattended=restartRows.filter(r=>!r.healed);

console.log("== S6 长期运行现状 ==");
console.log(`采样点 ${all.length} 个，跨度 ${hours.toFixed(2)} 小时（${days.toFixed(2)} 天 / 需 7 天）`);
console.log(`观测连续性：最长空档 ${(maxGap/3600).toFixed(2)}h，扣除断档后有效覆盖 ${coveredDays.toFixed(2)} 天`);
if(legacy.length) console.log(`（另有 ${legacy.length} 条修复前的历史样本无 daemon 身份，不计入判据）`);
console.log(`daemon 生命周期数：${lifetimes}（>1 说明期间重启过）`);
if(lifetimes>1){
  for(const L of LIFE){
    console.log(`  · pid=${L.pid} ${new Date(L.first*1000).toISOString().replace("T"," ").slice(0,19)} → `+
                `${new Date(L.last*1000).toISOString().replace("T"," ").slice(0,19)}  `+
                `(${((L.last-L.first)/3600).toFixed(2)}h, ${L.samples} 点)`);
  }
  if(restartRows.length){
    console.log("  重启归因（对照 watchdog 日志）：");
    for(const r of restartRows){
      const when=new Date(r.born*1000).toISOString().replace("T"," ").slice(0,19);
      if(r.healed) console.log(`    ✔ ${when} pid=${r.pid} 自愈恢复（空窗 ${r.downtimeSec}s）← ${r.evidence}`);
      else console.log(`    ✖ ${when} pid=${r.pid} **无自愈记录**（空窗 ${r.downtimeSec}s）—— 疑似人工干预`);
    }
  }
}
console.log(`当前生命周期内采样 ${S.length} 个点，pid=${cur.pid}`);
console.log(`RSS: 起 ${rss0.toFixed(1)}MB → 末 ${rssN.toFixed(1)}MB，增长 ${growth>=0?"+":""}${growth.toFixed(1)}MB（判据 < +50MB）`);
console.log(`RSS 峰值 ${maxRss.toFixed(1)}MB（仅当前生命周期）`);
console.log(`句柄: 起 ${S[0].fd} → 末 ${S[S.length-1].fd}（增长 ${fdGrowth>=0?"+":""}${fdGrowth}），峰值 ${maxFd}`);
console.log(`线程: 起 ${S[0].threads} → 末 ${S[S.length-1].threads}（增长 ${thGrowth>=0?"+":""}${thGrowth}）`);
console.log(`探针 ${probes.length} 次，成功率 ${passRate===null?"n/a":(passRate*100).toFixed(0)+"%"}`);

const c=[];
if(days>=7 && coveredDays>=7){
  c.push("✅ 已满 7 天且观测连续");
} else if(days>=7){
  c.push(`❌ 首尾跨 ${days.toFixed(2)} 天，但**观测有断档**：扣除断档后只有 ${coveredDays.toFixed(2)} 天`+
         `（最长空档 ${(maxGap/3600).toFixed(2)}h，超过 ${(GAP_LIMIT/3600).toFixed(1)}h 的部分累计 ${(deadTotal/3600).toFixed(2)}h）`);
} else {
  c.push(`❌ 未满 7 天（还差 ${(7-days).toFixed(2)} 天）`);
}
c.push(growth<50? "✅ RSS 增长 <50MB" : `❌ RSS 增长 ${growth.toFixed(1)}MB ≥50MB`);
c.push(fdGrowth<=2? "✅ 无明显句柄泄漏" : `❌ 句柄增长 ${fdGrowth}`);
if(unattended.length){
  c.push(`❌ 有 ${unattended.length} 次重启**找不到自愈记录**（${unattended.map(r=>new Date(r.born*1000).toISOString().slice(11,19)).join(", ")}）`+
         ` —— "无人工干预"不成立`);
} else if(restartRows.length){
  c.push(`✅ 期间重启 ${restartRows.length} 次，**全部是 watchdog 自愈**（无人干预，符合判据）`);
}
if(passRate!==null) c.push(passRate>=0.95? "✅ 成功率 ≥95%" : `❌ 成功率 ${(passRate*100).toFixed(0)}%`);
console.log("\n判定：" + c.join("；"));
process.exit(days>=7 && coveredDays>=7 && growth<50 && fdGrowth<=2 && unattended.length===0 ? 0 : 1);'
}
case "${1:-sample}" in
  sample) do_sample ;;
  probe)  do_probe ;;
  report) do_report ;;
  install_cron)
    LINE1='*/30 * * * * /root/dotd/scripts/soak.sh sample >/dev/null 2>&1'
    LINE2='0 */6 * * * /root/dotd/scripts/soak.sh probe >/dev/null 2>&1'
    CUR=$(crontab -l 2>/dev/null || true)
    printf '%s\n' "$CUR" | grep -qF 'soak.sh sample' || CUR=$(printf '%s\n%s' "$CUR" "$LINE1")
    printf '%s\n' "$CUR" | grep -qF 'soak.sh probe'  || CUR=$(printf '%s\n%s' "$CUR" "$LINE2")
    printf '%s\n' "$CUR" | sed '/^$/d' | crontab -
    echo "已装 cron："; crontab -l | grep soak
    ;;
  *) echo "用法: $0 {sample|probe|report|install_cron}"; exit 1 ;;
esac