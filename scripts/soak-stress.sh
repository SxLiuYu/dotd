#!/usr/bin/env bash
# S6 辅助：加速耐久测试。
#
# **这不是 7 天判据的替代品。** 7 天判据只能真跑 7 天。
# 这个脚本的用途是：用高密度真实任务在几十分钟内压出**早期信号**——
# 如果 RSS/句柄在这种压力下就涨，那 7 天肯定过不了，可以提前发现问题；
# 如果涨得很稳，也只是"暂时没看到问题"，不能据此宣布 7 天达标。
#
# 用法：bash scripts/soak-stress.sh [任务数，默认 60]
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env 2>/dev/null; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer ${DOTD_MASTER_TOKEN:-}" -H "Content-Type: application/json")
OUTDIR=/root/dotd/docs/acceptance
mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/soak-stress.jsonl"
export RESULTS
: > "$RESULTS"
N="${1:-60}"

jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
pid_of() { pgrep -f 'src/daemon.ts' | head -1; }
rss_of() { local p; p=$(pid_of); [ -n "$p" ] && awk '/^VmRSS:/{print int($2/1024)}' "/proc/$p/status" 2>/dev/null || echo -1; }
fd_of()  { local p; p=$(pid_of); [ -n "$p" ] && ls "/proc/$p/fd" 2>/dev/null | wc -l || echo -1; }

# 混合负载：算数/读文件/出网/写文件/定时/造工具复用，尽量覆盖不同代码路径
PROMPTS=(
  "算一下 137 乘以 24 等于多少？只给数字。"
  "读 /dot/home/q3-sales.txt，告诉我产品A多少万。"
  "看看 /dot/home/notes 目录下有几个文件。"
  "用你已有的 char-count 工具数一下'压力测试abc'有几个字符。"
  "访问 https://api.github.com/zen ，把返回的话原样告诉我。"
  "读 /dot/home/report.pdf ，告诉我营收增长率。"
  "帮我算 89 减 143 等于多少。"
  "一句话说说你现在有哪些工具。"
  "把 /dot/home/soak-probe.txt 写成三行：A1 A2 A3。"
  "读 /dot/home/q3-sales.txt，把三个产品加总等于多少万？"
)

submit() {
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(jstr "$1")}" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
task_status() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}
approve_pending() {
  local aid
  for aid in $(curl -s -m 8 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[]))console.log(a.id)}catch{}});'); do
    curl -s -m 10 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
  done
}

echo "════ 加速耐久：$N 个真实任务（占位：RSS/句柄起点）════"
RSS0=$(rss_of); FD0=$(fd_of)
echo "起点 RSS=${RSS0}MB fd=$FD0   $(date '+%F %T')"

pass=0; fail=0; i=0
while [ $i -lt "$N" ]; do
  i=$((i+1))
  p="${PROMPTS[$(( (i-1) % ${#PROMPTS[@]} ))]}"
  tid=$(submit "$p")
  if [ -z "$tid" ]; then fail=$((fail+1)); continue; fi
  deadline=$(( $(date +%s) + 120 ))
  st=""
  while [ $(date +%s) -lt $deadline ]; do
    st=$(task_status "$tid")
    case "$st" in done|failed|cancelled|paused) break ;; esac
    [ "$st" = "awaiting_approval" ] && approve_pending
    sleep 2
  done
  if [ "$st" = "done" ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  node -e '
const fs=require("fs");
fs.appendFileSync(process.env.RESULTS, JSON.stringify({i:Number(process.argv[1]),ok:process.argv[2]==="done",status:process.argv[3],rss_mb:Number(process.argv[4]),fd:Number(process.argv[5])})+"\n");' \
    "$i" "$st" "$st" "$(rss_of)" "$(fd_of)"
  # 每 10 个打印一次趋势
  if [ $((i % 10)) -eq 0 ]; then
    echo "  [$i/$N] pass=$pass fail=$fail  RSS=$(rss_of)MB fd=$(fd_of)  $(date '+%H:%M:%S')"
  fi
done

RSS1=$(rss_of); FD1=$(fd_of)
echo ""
echo "════ 结果 ════"
echo "任务：$pass 成功 / $fail 失败（共 $N）成功率 $(node -e "process.stdout.write(((Number(process.argv[1])/Number(process.argv[2]))*100).toFixed(0))" "$pass" "$N")%"
echo "RSS：${RSS0}MB → ${RSS1}MB，增长 $(( RSS1 - RSS0 ))MB"
echo "句柄：$FD0 → $FD1，增长 $(( FD1 - FD0 ))"
echo ""
echo "注意：这只是加速信号，**不能替代 7 天判据**。"