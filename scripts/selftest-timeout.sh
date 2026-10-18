#!/usr/bin/env bash
# 第十九轮：超时语义一致性。
#
# 三层各有自己的超时，容易不一致：
#   ① Runner 派发给执行面的 toolDeadlineMs（sync 60s / async 30min）
#   ② 工具自己的 timeout_ms 参数（模型可传）
#   ③ 容器内实际执行超时
#
# 要验证的是：**模型传 timeout_ms 时，到底谁说了算？边界行为是否可预期？**
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
  local tid="$1" max="${2:-150}" i st
  for ((i = 0; i < max; i++)); do
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
tools_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status,args_json,result_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
for (const r of rows) {
  console.log("   " + r.tool_name + " " + r.status);
  console.log("     args: " + String(r.args_json||"").replace(/\s+/g," ").slice(0,90));
  console.log("     res : " + String(r.result_json||"").replace(/\s+/g," ").slice(0,160));
}
db.close();' "$1" 2>/dev/null
}

echo "======== 场景 A：命令超时（sleep 比 timeout_ms 长）========"
T=$(submit "用 shell.run 执行 sleep 8; echo done，并把 timeout_ms 明确设成 3000。告诉我实际发生了什么。")
ST=$(wait_done "$T"); echo "task=$T 状态=$ST"
tools_of "$T"

echo
echo "======== 场景 B：命令在超时内完成 ========"
T2=$(submit "用 shell.run 执行 sleep 2; echo finished，timeout_ms 设成 30000。告诉我输出。")
ST2=$(wait_done "$T2"); echo "task=$T2 状态=$ST2"
tools_of "$T2"

echo
echo "======== 场景 C：模型传不合理的 timeout_ms ========"
T3=$(submit "用 shell.run 执行 echo hi，把 timeout_ms 设成 0。看系统怎么反应，如实告诉我。")
ST3=$(wait_done "$T3"); echo "task=$T3 状态=$ST3"
tools_of "$T3"

echo
echo "======== 场景 D：超过 sync 上限的 timeout_ms ========"
T4=$(submit "用 shell.run 执行 echo hi，把 timeout_ms 设成 600000（10 分钟）。如实告诉我结果。")
ST4=$(wait_done "$T4"); echo "task=$T4 状态=$ST4"
tools_of "$T4"
