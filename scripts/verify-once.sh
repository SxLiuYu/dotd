#!/usr/bin/env bash
# 验证一次性定时任务：建 → 触发 → 自动停用
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a

echo "=== 1. 数据库版本 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
console.log("  user_version=" + db.prepare("PRAGMA user_version").get().user_version);
const cols = db.prepare("PRAGMA table_info(crontabs)").all().map(c => c.name);
console.log("  once 列: " + (cols.includes("once") ? "✅ 有" : "❌ 无"));
db.close();'

echo ""
echo "=== 2. 建一个一次性任务（1 分钟后触发）==="
node --import tsx -e '
const { openDb } = await import("./db/conn.ts");
const { createSchedule } = await import("./src/control-plane/schedules.ts");
const { CronExpressionParser } = await import("cron-parser");
const db = openDb(process.env.HOME + "/.dotd/dotd.db");
const cronNext = (c, from) => CronExpressionParser.parse(c, { currentDate: new Date(from) }).next().getTime();

// 用临时 cron：每分钟，但标记 once
const r = await createSchedule(db, {
  title: "一次性测试",
  prompt: "只回复 ONCE-OK",
  cron: "* * * * *",
  once: true,
}, cronNext);
console.log("  创建: " + (r.ok ? "✅ " + r.schedule.id : "❌ " + r.error));
console.log("  once 标记: " + (r.schedule && r.schedule.once ? "✅ true" : "❌ false"));
process.stdout.write(r.ok ? r.schedule.id : "");
db.close();
' > /tmp/once-id.txt 2>&1

ID=$(cat /tmp/once-id.txt | tail -1)
echo "  任务 id: $ID"

echo ""
echo "=== 3. 等它触发（最多 90 秒）==="
for i in $(seq 1 18); do
  sleep 5
  S=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT enabled, last_fire_status, last_fire_seq FROM crontabs WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? ("enabled=" + r.enabled + " status=" + (r.last_fire_status||"-") + " seq=" + r.last_fire_seq) : "?");
db.close();' "$ID")
  echo "  $((i*5))s: $S"
  case "$S" in *"enabled=0"*) echo "  ✅ 一次性任务触发后已自动停用"; break ;; esac
done
