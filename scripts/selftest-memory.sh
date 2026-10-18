#!/usr/bin/env bash
# 第十轮：长会话与记忆连续性。
#
# 前九轮都是"独立新任务"。真实使用中主人会**连续对话**：
#   ① 同一个 thread 里多轮追问，模型要记得上文；
#   ② 跨任务（不同 thread）的长期记忆要能复用；
#   ③ daemon 重启后，会话上下文与文件记忆都要还在。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

# 带 threadId 提交（同 thread = 同一段对话）
submit_in() {
  local threadId="$1" text="$2" body
  if [ -n "$threadId" ]; then
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1],threadId:process.argv[2]}))' "$text" "$threadId")
  else
    body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$text")
  fi
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages"
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

echo "=========== 场景 A：同一会话多轮追问 ==========="
R=$(submit_in "" "记住一个暗号：BLUE-7。只回复收到。")
T1=$(printf '%s' "$R" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
TH=$(printf '%s' "$R" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
ST=$(wait_task "$T1"); A=$(ans_of "$T1")
echo "  轮1 task=$T1 thread=$TH status=$ST"
echo "  回答: $(printf '%s' "$A" | cut -c1-80)"
[ -n "$TH" ] && ok "拿到 threadId" || bad "拿到 threadId" "空"

R2=$(submit_in "$TH" "我刚才让你记的暗号是什么？")
T2=$(printf '%s' "$R2" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
ST2=$(wait_task "$T2"); A2=$(ans_of "$T2")
echo "  轮2 task=$T2 status=$ST2"
echo "  回答: $(printf '%s' "$A2" | cut -c1-120)"
if printf '%s' "$A2" | grep -q "BLUE-7"; then ok "同会话记得上文（BLUE-7）"; else bad "同会话记得上文" "回答里没有 BLUE-7"; fi

echo
echo "=========== 场景 B：跨任务长期记忆（不同 thread）==========="
R3=$(submit_in "" "我之前让你记过一个暗号，你还记得吗？如果记得，告诉我是什么。")
T3=$(printf '%s' "$R3" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
ST3=$(wait_task "$T3"); A3=$(ans_of "$T3")
echo "  新会话 task=$T3 status=$ST3"
echo "  回答: $(printf '%s' "$A3" | cut -c1-150)"
if printf '%s' "$A3" | grep -q "BLUE-7"; then ok "跨会话记得（长期记忆生效）"; else bad "跨会话记得" "新 thread 里没找到 BLUE-7"; fi

echo
echo "=========== 场景 C：会话上下文重建（读回历史）==========="
R4=$(submit_in "$TH" "这个会话里我们总共聊了几件事？简单说说。")
T4=$(printf '%s' "$R4" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
ST4=$(wait_task "$T4"); A4=$(ans_of "$T4")
echo "  task=$T4 status=$ST4"
echo "  回答: $(printf '%s' "$A4" | cut -c1-150)"
if [ "$ST4" = "done" ] || [ "$ST4" = "succeeded" ]; then ok "多轮会话可继续"; else bad "多轮会话" "状态 $ST4"; fi

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
echo "THREAD=$TH"
[ "$FAIL" -eq 0 ]
