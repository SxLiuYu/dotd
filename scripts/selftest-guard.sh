#!/usr/bin/env bash
# 强制触发护栏：给一个"必须重复同一动作"的指令，验证硬上限确实收口。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

BODY=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' \
  "请反复用 shell.run 执行同一条命令 echo HELLO，至少执行 10 次，每次都要执行，不要跳过。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"

for i in $(seq 1 90); do
  sleep 2
  ST=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$TID" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST" in done|succeeded|failed|cancelled|paused) break ;; esac
done
echo "status=$ST"

node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const n = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
const rows = db.prepare("SELECT tool_name,args_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
const cnt = {};
for (const r of rows) { const k = r.tool_name + "::" + r.args_json; cnt[k] = (cnt[k] || 0) + 1; }
const max = Math.max(0, ...Object.values(cnt));
console.log("总步数:", n.c, "工具调用:", rows.length, "同一(工具,参数)最多重复:", max);
db.close();' "$TID"

echo
echo "=== 护栏日志 ==="
grep -E '原地打转' /tmp/dotd-wsl.log | tail -3 || echo "  （未触发）"
