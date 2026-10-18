#!/usr/bin/env bash
# 第二十一轮 B：真并发下的记忆层竞争。
#
# A 测过文件不损坏、输出不串台。这轮测**记忆层**：
#   两个任务同时 读 MEMORY.md → 改 → 写回（典型的 read-modify-write 竞争）
#   如果有 lost update，其中一个的修改会丢。
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
st_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}

echo "=== 确认并发 2 已生效 ==="
curl -s -m 10 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" | head -c 150
echo

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "=== 清空测试标记 ==="
timeout 60 docker exec "$CID" sh -c 'grep -v "RACE-MARK" /dot/home/MEMORY.md > /tmp/m2 && mv /tmp/m2 /dot/home/MEMORY.md' 2>&1
echo "  已清理"

echo
echo "=== 同时提交 2 个任务，各自往 MEMORY.md 的 Current concerns 段追加标记 ==="
echo "   （这是典型的 read-modify-write 竞争）"
T1=$(submit "读 MEMORY.md，在 ## Current concerns 段末尾追加一行「- RACE-MARK-1」，保留其他所有内容，整篇写回。完成后回复完成。")
T2=$(submit "读 MEMORY.md，在 ## Current concerns 段末尾追加一行「- RACE-MARK-2」，保留其他所有内容，整篇写回。完成后回复完成。")
echo "  task1=$T1  task2=$T2"

for i in $(seq 1 120); do
  sleep 2
  S1=$(st_of "$T1"); S2=$(st_of "$T2")
  case "$S1" in done|failed|cancelled) ;; *) continue ;; esac
  case "$S2" in done|failed|cancelled) break ;; esac
done
echo "  最终: task1=$S1 task2=$S2"

echo
echo "=== MEMORY.md 里两个标记是否都在 ==="
CONTENT=$(timeout 60 docker exec "$CID" sh -c 'cat /dot/home/MEMORY.md' 2>&1)
M1=0; M2=0
printf '%s' "$CONTENT" | grep -q "RACE-MARK-1" && M1=1
printf '%s' "$CONTENT" | grep -q "RACE-MARK-2" && M2=1
echo "  RACE-MARK-1: $([ $M1 = 1 ] && echo '✅ 在' || echo '❌ 丢失')"
echo "  RACE-MARK-2: $([ $M2 = 1 ] && echo '✅ 在' || echo '❌ 丢失')"

echo
echo "=== MEMORY.md 结构是否仍完整 ==="
for sec in "# MEMORY (index)" "## Current concerns" "## Pointers"; do
  printf '%s' "$CONTENT" | grep -q "$sec" && echo "  ✅ $sec" || echo "  ❌ 缺 $sec"
done

echo
echo "=== 两个任务的执行序列（看是否都做了 read-modify-write）==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const t of process.argv.slice(2)) {
  const rows = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=?").all(t, "tool");
  console.log("  " + t + ": " + rows.map(r => r.tool_name + "=" + r.status).join(", "));
}
db.close();' "$T1" "$T2"
