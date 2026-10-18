#!/usr/bin/env bash
# 第二十一轮 C：人为制造 read-modify-write 竞争。
#
# 上一轮两个任务刚好错开，没暴露问题。这次让它们**卡在同一个时刻**：
#   每个任务都用 shell.run 先 sleep 到同一个绝对时刻，再执行写入。
# 这样才能真正测试"同时读-改-写"是否会丢更新。
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

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)

echo "=== 清理旧标记 ==="
timeout 60 docker exec "$CID" sh -c 'grep -v "SYNC-MARK" /dot/home/MEMORY.md > /tmp/m3 && mv /tmp/m3 /dot/home/MEMORY.md; wc -c /dot/home/MEMORY.md' 2>&1

# 让两个任务都在 T+20s 这个绝对时刻动手
TARGET=$(( $(date +%s) + 20 ))
echo "=== 目标同步时刻: $(date -d @$TARGET '+%H:%M:%S') ==="

echo "=== 提交两个任务，它们会在同一秒内执行 append ==="
T1=$(submit "严格按以下步骤做：
1. 用 shell.run 执行：while [ \$(date +%s) -lt $TARGET ]; do sleep 0.2; done; echo GO
2. 然后立刻用 shell.run 执行：echo '- SYNC-MARK-1' >> /dot/home/MEMORY.md
3. 回复完成")
T2=$(submit "严格按以下步骤做：
1. 用 shell.run 执行：while [ \$(date +%s) -lt $TARGET ]; do sleep 0.2; done; echo GO
2. 然后立刻用 shell.run 执行：echo '- SYNC-MARK-2' >> /dot/home/MEMORY.md
3. 回复完成")
echo "  task1=$T1  task2=$T2"

for i in $(seq 1 120); do
  sleep 2
  S1=$(st_of "$T1"); S2=$(st_of "$T2")
  case "$S1" in done|failed|cancelled) ;; *) continue ;; esac
  case "$S2" in done|failed|cancelled) break ;; esac
done
echo "  最终: task1=$S1 task2=$S2"

echo
echo "=== 两个标记是否都在 ==="
CONTENT=$(timeout 60 docker exec "$CID" sh -c 'cat /dot/home/MEMORY.md' 2>&1)
printf '%s' "$CONTENT" | grep -q "SYNC-MARK-1" && echo "  ✅ SYNC-MARK-1 在" || echo "  ❌ SYNC-MARK-1 丢失"
printf '%s' "$CONTENT" | grep -q "SYNC-MARK-2" && echo "  ✅ SYNC-MARK-2 在" || echo "  ❌ SYNC-MARK-2 丢失"

echo
echo "=== 说明 ==="
echo "  这一步用的是 shell.run 的 >> 追加（原子操作），不是 read-modify-write。"
echo "  真正的 RMW 竞争在模型层（fs.read 全文 → 改 → fs.write 全文覆盖），"
echo "  那种情况无法用 shell 原子性规避 —— 下面单独测。"
