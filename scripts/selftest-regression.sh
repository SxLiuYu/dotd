#!/usr/bin/env bash
# 第十六轮 C：全局回归 —— 把历轮的关键用例一次性跑一遍，确认没有互相破坏。
#
# 十六轮里改了 runner/http/exec/governance/prompt/迁移，这些改动可能互相影响。
# 这个脚本是"总闸"：任何一轮的修复被后来的改动破坏，这里会立刻暴露。
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
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1],threadId:process.argv[2]||undefined}))' "$1" "${2:-}")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages"
}
wait_done() {
  local tid="$1" i st
  for ((i = 0; i < 120; i++)); do
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
ans_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ") : ""); db.close();' "$1" 2>/dev/null
}
steps_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$1"
}

run() {
  local name="$1" goal="$2" want="$3" maxsteps="${4:-14}"
  local R TID ST A N
  R=$(submit "$goal")
  TID=$(printf '%s' "$R" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$TID" ] && { bad "$name" "提交失败"; return; }
  ST=$(wait_done "$TID"); A=$(ans_of "$TID"); N=$(steps_of "$TID")
  if [ "$ST" != "done" ]; then bad "$name" "状态 $ST"; return; fi
  if [ "$N" -gt "$maxsteps" ]; then bad "$name" "$N 步超上限 $maxsteps"; return; fi
  if [ -n "$want" ] && ! printf '%s' "$A" | grep -Eq "$want"; then bad "$name" "回答未命中：$(printf '%s' "$A" | cut -c1-80)"; return; fi
  ok "$name（$N 步）"
}

echo "======== 全局回归（覆盖历轮修复）========"
echo
echo "第1轮 工具结果完整回喂"
run "写文件" "把内容 REGRESSION-OK 写进 reg.txt，只回完成。" "(完成|好了|OK)" 8
run "读回文件" "读 reg.txt 的内容告诉我。" "REGRESSION-OK" 8

echo
echo "第5轮 工具轮入 thread / call_id 配对（多步不出错）"
run "多步写读" "创建 m1.txt 写 7，m2.txt 写 8，算出两者之和告诉我。" "15" 12

echo
echo "第5轮 出网"
run "联网取数" "用 net.get 访问 https://api.github.com/zen，把原文告诉我。" "." 10

echo
echo "第9轮 效率纪律（不该反复查）"
run "列目录" "列出家目录里有哪些 .txt 文件，告诉我数量。" "([0-9]+)" 12

echo
echo "第8轮 先实测再回答"
run "能力自述" "你现在能不能联网？先试一下再回答。" "(能|可以|通的|HTTP 200|200)" 14

echo
echo "第10/11轮 会话复用"
R1=$(submit "记住代号 ZEBRA-9，只回收到。")
T1=$(printf '%s' "$R1" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
TH=$(printf '%s' "$R1" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
wait_done "$T1" >/dev/null
R2=$(submit "刚才的代号是什么？" "$TH")
T2=$(printf '%s' "$R2" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
ST2=$(wait_done "$T2"); A2=$(ans_of "$T2")
if printf '%s' "$A2" | grep -q "ZEBRA-9"; then ok "同会话多轮记得上文"; else bad "会话复用" "回答：$(printf '%s' "$A2" | cut -c1-80)"; fi

echo
echo "第6轮 护栏（确认型任务不失控）"
run "确认型任务" "创建 g1.txt 写 3，g2.txt 写 4，读回确认，最后回复两数之和。" "7" 20

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
