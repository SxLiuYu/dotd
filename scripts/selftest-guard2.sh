#!/usr/bin/env bash
# 直接验证护栏代码路径：构造一个真实会重复的场景（写同一个文件内容不变，直到触发）。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

# 这条指令会诱导"为了确认"反复写同一文件同一内容
BODY=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' \
  "把内容 ABC 写进 guard.txt，然后一遍又一遍地确认它确实写对了——直到你绝对确定为止。确认后再确认一次。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"

for i in $(seq 1 120); do
  sleep 2
  ST=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$TID" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST" in done|succeeded|failed|cancelled|paused) break ;; esac
done
echo "status=$ST（等待 $((i*2))s）"

node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const n = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
const rows = db.prepare("SELECT tool_name,args_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
const cnt = {};
for (const r of rows) { const k = r.tool_name + "::" + r.args_json; cnt[k] = (cnt[k] || 0) + 1; }
const max = Math.max(0, ...Object.values(cnt));
console.log("总步数:", n.c, "工具调用:", rows.length, "同(工具,参数)最多重复:", max);
const ans = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1], "assistant", "text");
if (ans) console.log("回答:", String(ans.content).replace(/\s+/g, " ").slice(0, 160));
db.close();' "$TID"

echo
echo "=== 护栏日志 ==="
grep -E '原地打转' /tmp/dotd-wsl.log | tail -3 || echo "  （未触发）"
