#!/usr/bin/env bash
# 第四轮：区分「产品缺陷」与「模型行为」。
# 同一能力，换更明确/更简单的 prompt，看步数是否收敛。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" i st
  for ((i = 0; i < 120; i++)); do
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
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ").slice(0, 120) : "");
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
  local name="$1" prompt="$2"
  local tid st ans n
  tid=$(submit "$prompt"); [ -z "$tid" ] && { echo "  ❌ $name 提交失败"; return; }
  st=$(wait_task "$tid"); ans=$(answer_of "$tid"); n=$(steps_of "$tid")
  printf '  %-28s status=%-9s steps=%-3s answer=%s\n' "$name" "$st" "$n" "$(printf '%s' "$ans" | cut -c1-60)"
}

echo "=========== 同一能力的 prompt 敏感度对比 ==========="
run "A 明确单步" "只做一件事：用 shell.run 执行 echo \$((17*23))，然后只回复结果数字。"
run "B 明确写文件" "只做一件事：写 a.txt 内容 111。写完直接回复「好了」两个字，不要读回。"
run "C 读已有文件" "读 a.txt 的第一行告诉我。"
run "D 简单加法" "a.txt 里是 111，b.txt 里是 222。用 shell.run 算它们的和，只回复数字。"
run "E 反例：要求确认" "创建 x1.txt 写 1，创建 x2.txt 写 2，然后读回两个文件确认内容正确，最后回复两数之和。"

echo
echo "=========== 说明 ==========="
echo "若 A-D 步数都很小(<=6)而 E 很大，说明是**模型对「确认型任务」过度反复**，不是上下文缺陷。"
