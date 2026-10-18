#!/usr/bin/env bash
# 第二十轮：并发写记忆 —— 多任务同时写 MEMORY.md 会不会互相覆盖？
#
# 记忆层的关键不变量：**并发写不能丢数据**。
# 手法：提交 N 个任务，每个都要求"往 MEMORY.md 里追加一条自己的标记"，
# 最后检查 MEMORY.md 里是否 N 条标记全在。
#
# 注意 maxRunningTasks=1，任务本身串行；但这仍能验证"读-改-写"是否丢失更新
# （模型 fs.read → 改 → fs.write 整篇覆盖，中间若有别人写入就会丢）。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_done() {
  local tid="$1" i st
  for ((i = 0; i < 150; i++)); do
    sleep 2
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo timeout
}

echo "======== 提交 3 个任务，各自往 MEMORY.md 追加一条标记 ========"
TID=()
for n in 1 2 3; do
  T=$(submit "读一下 MEMORY.md，然后在它的末尾追加一行「并发标记 CONC-$n」（保留原有内容，用 fs.write 整篇写回），完成后回复完成。")
  TID+=("$T")
  echo "  任务$n = $T"
done

echo
echo "======== 等待全部完成 ========"
for t in "${TID[@]}"; do
  ST=$(wait_done "$t")
  echo "  $t → $ST"
done

echo
echo "======== 检查 MEMORY.md 内容 ========"
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const t of process.argv.slice(2)) {
  const rows = db.prepare("SELECT seq,tool_name,status,substr(args_json,1,60) a FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(t, "tool");
  console.log(t + ": " + rows.map(r => r.tool_name + "=" + r.status).join(", "));
}
db.close();' "${TID[@]}" 2>&1 | head -6

echo
echo "=== 容器内 MEMORY.md 全文 ==="
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
timeout 60 docker exec "$CID" sh -c 'cat /dot/home/MEMORY.md' 2>&1 | head -40

echo
echo "=== 三个标记是否都在 ==="
CONTENT=$(timeout 60 docker exec "$CID" sh -c 'cat /dot/home/MEMORY.md' 2>&1)
FOUND=0
for n in 1 2 3; do
  if printf '%s' "$CONTENT" | grep -q "CONC-$n"; then
    echo "  ✅ CONC-$n 存在"
    FOUND=$((FOUND+1))
  else
    echo "  ❌ CONC-$n 丢失"
  fi
done
echo "  保留 $FOUND/3"
