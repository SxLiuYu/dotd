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
SOAK="$OUTDIR/soak.jsonl"
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
  node -e '
const fs=require("fs");
const o={ts:Number(process.argv[1]),alive:true,rss_kb:Number(process.argv[2]),
  fd:Number(process.argv[3]),threads:Number(process.argv[4]),
  container_up:Number(process.argv[5]),db_kb:Number(process.argv[6])};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$rss_kb" "$fd" "$n_threads" "$cont" "${db_kb:-0}"
  echo "sample: rss=${rss_kb}KB fd=$fd threads=$n_threads container_up=$cont db=${db_kb}KB"
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
const samples=lines.filter(x=>x.kind!=="probe"&&x.alive);
const probes=lines.filter(x=>x.kind==="probe");
if(!samples.length){console.log("还没有样本");process.exit(1);}
const first=samples[0], last=samples[samples.length-1];
const hours=(last.ts-first.ts)/3600, days=hours/24;
const rss0=first.rss_kb/1024, rssN=last.rss_kb/1024;
const growth=rssN-rss0;
const fdGrowth=last.fd-first.fd, thGrowth=last.threads-first.threads;
const maxRss=Math.max(...samples.map(s=>s.rss_kb))/1024;
const maxFd=Math.max(...samples.map(s=>s.fd));
const passRate=probes.length? probes.filter(p=>p.ok).length/probes.length : null;
console.log("== S6 长期运行现状 ==");
console.log(`采样点 ${samples.length} 个，跨度 ${hours.toFixed(2)} 小时（${days.toFixed(2)} 天 / 需 7 天）`);
console.log(`RSS: 起 ${rss0.toFixed(1)}MB → 末 ${rssN.toFixed(1)}MB，增长 ${growth>=0?"+":""}${growth.toFixed(1)}MB（判据 < +50MB）`);
console.log(`RSS 峰值 ${maxRss.toFixed(1)}MB`);
console.log(`句柄: 起 ${first.fd} → 末 ${last.fd}（增长 ${fdGrowth>=0?"+":""}${fdGrowth}），峰值 ${maxFd}`);
console.log(`线程: 起 ${first.threads} → 末 ${last.threads}（增长 ${thGrowth>=0?"+":""}${thGrowth}）`);
console.log(`探针 ${probes.length} 次，成功率 ${passRate===null?"n/a":(passRate*100).toFixed(0)+"%"}`);
const c=[];
if(days>=7) c.push("✅ 已满 7 天"); else c.push(`❌ 未满 7 天（还差 ${(7-days).toFixed(2)} 天）`);
c.push(growth<50? "✅ RSS 增长 <50MB" : `❌ RSS 增长 ${growth.toFixed(1)}MB ≥50MB`);
c.push(fdGrowth<=2? "✅ 无明显句柄泄漏" : `❌ 句柄增长 ${fdGrowth}`);
if(passRate!==null) c.push(passRate>=0.95? "✅ 成功率 ≥95%" : `❌ 成功率 ${(passRate*100).toFixed(0)}%`);
console.log("\n判定：" + c.join("；"));
process.exit(days>=7 && growth<50 && fdGrowth<=2 ? 0 : 1);'
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