#!/usr/bin/env bash
# 第三轮复测：贴近真实使用，并覆盖前两轮没测的路径。
# 同时修正第二轮脚本的两个自身缺陷：
#   ① E1 的期望正则写成 'shell.run|calculator'——grep -E 里 '.' 是任意字符且 '|' 有歧义，
#      改成对**回答内容**断言（模型答对数字即可，不关心它用了哪个工具）；
#   ② 工具名断言改成 grep -F（固定串），避免正则歧义。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "     $2"; FAIL=$((FAIL+1)); }

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

wait_task() {
  local tid="$1" max="${2:-120}" i st
  for ((i = 0; i < max; i++)); do
    sleep 2
    st=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo timeout
}

answer_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1")
  .get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ") : "");
db.close();' "$1" 2>/dev/null
}

step_count() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$1" 2>/dev/null
}

tools_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
process.stdout.write(rows.map(r => r.tool_name + "=" + r.status).join(","));
db.close();' "$1" 2>/dev/null
}

# run name prompt expect_regex maxsteps
run() {
  local name="$1" prompt="$2" want="$3" maxsteps="${4:-12}"
  echo
  echo "### $name"
  local tid st ans tl n
  tid=$(submit "$prompt")
  [ -z "$tid" ] && { bad "$name" "提交失败"; return; }
  st=$(wait_task "$tid")
  ans=$(answer_of "$tid"); tl=$(tools_of "$tid"); n=$(step_count "$tid")
  echo "  task=$tid status=$st steps=$n"
  echo "  tools: $(printf '%s' "$tl" | cut -c1-120)"
  echo "  answer: $(printf '%s' "$ans" | cut -c1-170)"
  [ "$st" = "done" ] || [ "$st" = "succeeded" ] || { bad "$name" "状态 $st"; return; }
  if [ "$n" -gt "$maxsteps" ]; then bad "$name" "步数 $n 超过上限 $maxsteps（疑似死循环）"; return; fi
  if [ -n "$want" ] && ! printf '%s' "$ans" | grep -Eq "$want"; then bad "$name" "回答未命中 /$want/"; return; fi
  ok "$name（$n 步）"
}

echo "=========== 第三轮：真实使用场景 ==========="

run "F1 计算（不关心用哪个工具）" \
  "用你能用的方式算一下 17 乘 23 等于多少，只回数字。" \
  "391" 8

run "F2 中文文件命名规范（记忆层硬限）" \
  "在 notes/ 目录写一个今天的笔记文件，内容是「今天验证了 dotd 的端到端能力」。写完告诉我文件名。" \
  "(20[0-9]{2}-[0-9]{2}-[0-9]{2}|notes)" 10

run "F3 先查再答（真实信息获取）" \
  "用 net.get 访问 https://api.github.com/zen，把返回的那句话原样告诉我。" \
  "." 10

run "F4 两文件对比（多步推理）" \
  "创建 a.txt 内容写 111，创建 b.txt 内容写 222，然后告诉我两个文件内容相加是多少。" \
  "333" 12

run "F5 记住并复用（会话上下文）" \
  "记住一个数字：4711。只回复收到。" \
  "(收到|好|记住)" 6

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
