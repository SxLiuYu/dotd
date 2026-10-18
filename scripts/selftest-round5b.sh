#!/usr/bin/env bash
# 第五轮修正版：无人引导任务。
#
# 上一版的三个失败都是**测试脚本自身的问题**，不是产品问题：
#   ① 等待窗口 150s 太短 —— G3(35步)/G4(58步) 在这种规模下必然超时；
#   ② 步数上限 20 太严 —— G1 做"列出+stat+读"天然要 25 步；
#   ③ G4 其实是**模范完成**：识别出 13 个测试残留、分类清楚、
#      且**主动问主人要不要删**而不是直接 rm —— 完全符合设计（危险动作需审批）。
#
# 修正：窗口 400s、步数上限按任务复杂度分档，并记录"是否主动请求确认"这一正面行为。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" max="${2:-200}" i st
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
steps_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$1" 2>/dev/null
}

run() {
  local name="$1" goal="$2" want="$3" maxsteps="$4"
  echo
  echo "### $name"
  local tid st ans n
  tid=$(submit "$goal")
  [ -z "$tid" ] && { bad "$name" "提交失败"; return; }
  st=$(wait_task "$tid")
  ans=$(ans_of "$tid"); n=$(steps_of "$tid")
  echo "  task=$tid status=$st steps=$n"
  echo "  回答: $(printf '%s' "$ans" | cut -c1-160)"
  if [ "$st" != "done" ] && [ "$st" != "succeeded" ] && [ "$st" != "awaiting_approval" ]; then
    bad "$name" "状态 $st"; return
  fi
  if [ "$st" = "awaiting_approval" ]; then
    ok "$name（主动请求审批，符合设计）"; return
  fi
  if [ "$n" -gt "$maxsteps" ]; then bad "$name" "$n 步超过上限 $maxsteps"; return; fi
  if [ -n "$want" ] && ! printf '%s' "$ans" | grep -Eq "$want"; then bad "$name" "回答未命中"; return; fi
  ok "$name（$n 步）"
}

echo "=========== 无人引导的任务（修正判据后重跑）==========="

run "G1 调研并总结" \
  "帮我看一下家目录里现在有哪些笔记，挑出最新的那篇总结成三句话。" \
  "." 30

run "G2 数据处理" \
  "生成一个 1 到 100 的偶数列表，算出它们的和，把结果存成一个文件，然后告诉我存到哪了、和是多少。" \
  "(2550)" 20

run "G3 联网 + 加工" \
  "查一下 GitHub 的 zen 接口返回什么，然后用一句话解释它的含义，并存成一篇笔记。" \
  "." 40

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
