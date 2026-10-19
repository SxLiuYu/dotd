#!/usr/bin/env bash
# 模拟主人一天的真实使用节奏——不是测单个功能，而是测整条链路会不会断
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)

THREAD=""
say() {
  local goal="$1" label="$2"
  local body t0 t1 tid st ans
  if [ -n "$THREAD" ]; then
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1],threadId:process.argv[2]}))' "$goal" "$THREAD")
  else
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  fi
  t0=$(date +%s%3N)
  local resp
  resp=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages")
  tid=$(printf '%s' "$resp" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  local nt
  nt=$(printf '%s' "$resp" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
  [ -n "$nt" ] && THREAD="$nt"
  [ -z "$tid" ] && { echo "  ❌ [$label] 提交失败"; return 1; }

  for i in $(seq 1 180); do
    sleep 0.4
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  t1=$(date +%s%3N)
  ans=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content).replace(/\s+/g," ") : ""); db.close();' "$tid")
  printf "  %-14s %5.1fs  %-16s %s\n" "$label" "$(awk "BEGIN{printf \"%.1f\", ($t1-$t0)/1000}")" "$st" "$(printf '%s' "$ans" | cut -c1-100)"
}

echo "════════ 模拟一天的节奏 ════════"
echo

echo "【早上 8:00】设一个提醒 + 交代今天的事"
say "帮我设个提醒：今天下午3点提醒我去开组会" "设提醒"
say "我今天要做三件事：上午写周报、下午开组会、晚上健身。帮我记一下。" "交代三件事"

echo
echo "【上午 10:00】发文件让它读"
docker exec "$CID" sh -c 'printf "第三季度销售数据\n产品A: 120万\n产品B: 85万\n产品C: 200万\n总目标: 350万\n" > /dot/home/q3-sales.txt' 2>/dev/null
say "读一下 home 下的 q3-sales.txt，告诉我达标了没有" "读文件"

echo
echo "【上午 11:00】中途改主意"
say "算了，健身改成明天晚上，其他不变" "改主意"

echo
echo "【下午 2:00】连发三条问不同的事（不该排队）"
say "周报大概要写多少字比较合适" "连发1"
say "组会一般准备哪些材料" "连发2"
say "帮我算下 350 减 405 等于多少" "连发3"

echo
echo "【下午 5:00】回来问整体进展"
say "今天我交代的事，现在进展怎么样？" "回顾"

echo
echo "════════ 结果核对 ════════"
echo "  会话: $THREAD"
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const n = db.prepare("SELECT COUNT(*) c FROM mem_messages WHERE thread_id=?").get(process.argv[1]).c;
const s = db.prepare("SELECT LENGTH(context_summary) l FROM mem_threads WHERE id=?").get(process.argv[1]);
console.log("  消息: " + n + " 条   摘要: " + (s.l ? s.l + " 字节" : "无"));
db.close();' "$THREAD"

echo ""
echo "  定时任务:"
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const r of db.prepare("SELECT title, cron, enabled FROM crontabs ORDER BY id DESC LIMIT 3").all()) {
  console.log("    " + r.cron + "  " + r.title + "  " + (r.enabled ? "启用" : "停用"));
}
db.close();'
