#!/usr/bin/env bash
# 验证定时任务：模型能不能真的创建（对标 OpenAI bot 的"每天 9 点提醒我"）
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

echo "=== 1. 重启 daemon 加载新工具 ==="
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
DOTD_MAX_RUNNING=1 nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do sleep 2; curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break; done
echo "  已起（$((i*2))s）"

echo
echo "=== 2. 确认模型能看到 schedule 工具 ==="
node --import tsx src/surfaces/cli.ts status 2>/dev/null | head -2
curl -s -m 20 "${HDR[@]}" "$BASE/api/schedules" | head -c 150
echo

echo
echo "=== 3. 让模型创建定时任务 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
  "帮我设置一个每天早上 8 点 30 分的提醒，内容是「查一下北京今天的天气，用一句话告诉我气温和要不要带伞」。设好后把下次触发时间告诉我。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TID"

for i in $(seq 1 120); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
done
echo "  状态=$ST（$((i*2))s）"

echo
echo "=== 4. 工具调用 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const r of db.prepare("SELECT seq,tool_name,status,args_json,result_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1],"tool")) {
  console.log(" " + String(r.seq).padStart(2) + " " + String(r.tool_name).padEnd(16) + r.status);
  console.log("     args: " + String(r.args_json||"").replace(/\s+/g," ").slice(0,120));
  const res = String(r.result_json||"").replace(/\s+/g," ").slice(0,160);
  if (res) console.log("     res : " + res);
}
db.close();' "$TID" 2>&1 | head -14

echo
echo "=== 5. 回答 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log(m ? String(m.content).replace(/\s+/g," ").slice(0,300) : "(无)");
db.close();' "$TID" 2>&1

echo
echo "=== 6. crontabs 表里的实际记录 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const r of db.prepare("SELECT id,title,cron,enabled,next_fire FROM crontabs WHERE enabled=1 ORDER BY next_fire").all()) {
  console.log("  " + r.id + " | " + r.cron + " | " + r.title + " | 下次: " + new Date(Number(r.next_fire)).toLocaleString("zh-CN"));
}
db.close();' 2>&1
