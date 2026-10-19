#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")
TID="thr_01M56VDNAZDDACBEB80CE1EKNP"

echo "=== 提交任务触发摘要 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:"只回复 SUMOK2",threadId:process.argv[1]}))' "$TID")
RESP=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages")
TASK=$(printf '%s' "$RESP" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TASK"
[ -z "$TASK" ] && { echo "  提交失败: $(printf '%s' "$RESP" | head -c 150)"; exit 1; }

for i in $(seq 1 90); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TASK")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  状态=$ST"
sleep 6

echo
echo "=== DIAG-SUM (hasFn 应为 true) ==="
grep 'DIAG-SUM' /tmp/dotd-wsl.log 2>/dev/null | tail -2

echo
echo "=== 摘要日志 ==="
grep -iE '会话摘要' /tmp/dotd-wsl.log 2>/dev/null | tail -3

echo
echo "=== 摘要是否生成 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT LENGTH(context_summary) sl, context_summary_upto_seq u FROM mem_threads WHERE id=?").get(process.argv[1]);
console.log(`  summary 长度=${r.sl}  upto_seq=${r.u}`);
db.close();' "$TID"