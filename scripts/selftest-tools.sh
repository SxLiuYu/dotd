#!/usr/bin/env bash
# 第十二轮：未验证过的工具面（browser.* 与 net.post）。
#
# 前十一轮验证了 fs.* / shell.run / net.get。剩下这 5 个工具从没在真容器里跑过：
#   browser.open / browser.act / browser.snapshot / browser.close / net.post
#
# 已知前提：browser.* 缺 identity 会被治理 deny（identity_missing，第十轮已改成直接 deny）。
# 本轮要确认的是：**这条 deny 路径给出的是清晰错误，而不是让任务卡死或崩溃**。
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
  local tid="$1" max="${2:-120}" i st
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
  local name="$1" goal="$2" want="$3" maxsteps="${4:-20}"
  echo
  echo "### $name"
  local tid st ans n
  tid=$(submit "$goal")
  [ -z "$tid" ] && { bad "$name" "提交失败"; return; }
  st=$(wait_task "$tid"); ans=$(ans_of "$tid"); n=$(steps_of "$tid")
  echo "  task=$tid status=$st steps=$n"
  echo "  回答: $(printf '%s' "$ans" | cut -c1-170)"
  if [ "$st" = "awaiting_approval" ]; then ok "$name（停在审批，符合预期）"; return; fi
  if [ "$st" != "done" ] && [ "$st" != "succeeded" ]; then bad "$name" "状态 $st"; return; fi
  if [ "$n" -gt "$maxsteps" ]; then bad "$name" "$n 步超上限"; return; fi
  if [ -n "$want" ] && ! printf '%s' "$ans" | grep -Eq "$want"; then bad "$name" "回答未命中"; return; fi
  ok "$name（$n 步）"
}

echo "=========== 未验证工具：browser.* 与 net.post ==========="

# 浏览器：预期被 identity 拒绝，但要"清晰拒绝 + 任务正常收尾"
run "T1 浏览器访问（预期 identity deny）" \
  "用浏览器打开 https://example.com，看看页面上写了什么。" \
  "(身份|identity|登录|拒绝|无法|做不到)" 16

# net.post：默认 DOTD_NET_TOOLS=get，POST 应该被拒
run "T2 net.post（预期被策略拒绝）" \
  "用 net.post 往 https://httpbin.org/post 提交 {\"a\":1}，告诉我结果。" \
  "(拒绝|禁用|不允许|disabled|GET|只能)" 16

# 组合：先浏览器失败，能否改用 net.get 达成目标
run "T3 浏览器不可用时的降级" \
  "我想看 https://example.com 的内容。你想办法拿到并告诉我页面标题。" \
  "." 20

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
