#!/usr/bin/env bash
# 第十一轮：真实多轮对话场景（会话修复后）。
#
# 模拟主人真实用法：先让它做一件事，再**基于结果追问**，
# 而不是像前面几轮那样每个用例互相独立。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

# 在一个 thread 里发一轮，返回 "taskId threadId"
turn() {
  local THREAD="$1" TEXT="$2" body resp
  if [ -n "$THREAD" ]; then
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1],threadId:process.argv[2]}))' "$TEXT" "$THREAD")
  else
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$TEXT")
  fi
  resp=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages")
  local tid th
  tid=$(printf '%s' "$resp" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  th=$(printf '%s' "$resp" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
  echo "$tid|$th"
}
wait_task() {
  local tid="$1" max="${2:-150}" i st
  for ((i = 0; i < max; i++)); do
    sleep 2
    st=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused|awaiting_approval) echo "$st"; return 0 ;; esac
  done
  echo timeout
}
ans_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ") : "");
db.close();' "$1" 2>/dev/null
}

echo "======== 场景 A：做任务 → 基于结果追问 ========"
R=$(turn "" "帮我看一下家目录 reports/ 下有哪些文件，每个文件多大。")
TID=${R%%|*}; TH=${R#*|}
ST=$(wait_task "$TID"); A=$(ans_of "$TID")
echo "  轮1(task=$TID, thread=$TH): status=$ST"
echo "    $(printf '%s' "$A" | cut -c1-130)"
if [ "$ST" = "done" ] || [ "$ST" = "succeeded" ]; then ok "轮1 完成"; else bad "轮1" "状态 $ST"; fi

R2=$(turn "$TH" "刚才列出的文件里，最小的那个叫什么？")
TID2=${R2%%|*}; TH2=${R2#*|}
ST2=$(wait_task "$TID2"); A2=$(ans_of "$TID2")
echo "  轮2(task=$TID2): status=$ST2"
echo "    $(printf '%s' "$A2" | cut -c1-150)"
if [ "$TH" = "$TH2" ]; then ok "会话被复用（thread 一致）"; else bad "会话复用" "thread 变了：$TH -> $TH2"; fi
# 能答出"刚才列出的文件"里的内容，说明记得上文
if printf '%s' "$A2" | grep -Eq "(\.md|\.txt|\.json|文件|KB|字节)"; then
  ok "轮2 能基于上文回答"
else
  bad "轮2 基于上文" "回答没体现出上文"
fi

echo
echo "======== 场景 B：任务的连续性（继续上一次的工作）========"
R3=$(turn "$TH" "把刚才最大的那个文件的内容读出来，告诉我前两行。")
TID3=${R3%%|*}
ST3=$(wait_task "$TID3"); A3=$(ans_of "$TID3")
echo "  轮3(task=$TID3): status=$ST3"
echo "    $(printf '%s' "$A3" | cut -c1-170)"
if [ "$ST3" = "done" ] || [ "$ST3" = "succeeded" ]; then ok "轮3 完成"; else bad "轮3" "状态 $ST3"; fi

echo
echo "======== 场景 C：新会话不应串到旧会话 ========"
R4=$(turn "" "我们之前聊过什么吗？如果没聊过就直接说没有。")
TID4=${R4%%|*}; TH4=${R4#*|}
ST4=$(wait_task "$TID4"); A4=$(ans_of "$TID4")
echo "  新会话(task=$TID4, thread=$TH4): status=$ST4"
echo "    $(printf '%s' "$A4" | cut -c1-150)"
if [ "$TH4" != "$TH" ]; then ok "新会话独立（thread 不同）"; else bad "会话隔离" "新请求复用了旧 thread"; fi

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
echo "MAIN_THREAD=$TH"
[ "$FAIL" -eq 0 ]
