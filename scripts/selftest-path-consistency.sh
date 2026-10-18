#!/usr/bin/env bash
# 第十八轮：系统性排查"工具间的行为不一致"。
#
# 上轮发现 fs.read 接受绝对路径而 fs.write 不接受 —— 一次修一个太慢。
# 这轮直接**枚举所有路径类工具**，用同一批路径去打，看行为是否一致。
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
  local tid="$1" i st
  for ((i = 0; i < 150; i++)); do
    sleep 2
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled) echo "$st"; return 0 ;; esac
  done
  echo timeout
}
tools_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status,args_json,result_json FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
for (const r of rows) {
  const a = String(r.args_json||"").replace(/\s+/g," ").slice(0,70);
  const fail = r.status === "failed" ? "  ← " + String(r.result_json||"").replace(/\s+/g," ").slice(0,90) : "";
  console.log("   " + r.tool_name.padEnd(10) + " " + r.status.padEnd(9) + a + fail);
}
db.close();' "$1" 2>/dev/null
}

echo "======== 用绝对路径 /dot/home/probe.txt 打全部路径类工具 ========"
echo "（期望：全部一致——要么都接受到 home 内，要么都拒绝）"
T=$(submit "依次做这几件事，每步都严格使用我给的路径写法：
1. 用 fs.write 写 /dot/home/probe.txt，内容 PROBE
2. 用 fs.read 读 /dot/home/probe.txt
3. 用 fs.stat 查 /dot/home/probe.txt
4. 用 fs.list 列 /dot/home
5. 用 shell.run 执行 cat /dot/home/probe.txt
每一步把结果告诉我，失败也照实说。")
wait_done "$T" >/dev/null
echo "task=$T"
tools_of "$T"

echo
echo "======== 用相对路径 probe2.txt 打同样的工具 ========"
T2=$(submit "依次做这几件事，路径一律用相对路径：
1. 用 fs.write 写 probe2.txt，内容 PROBE2
2. 用 fs.read 读 probe2.txt
3. 用 fs.stat 查 probe2.txt
4. 用 shell.run 执行 cat probe2.txt
把每步结果告诉我。")
wait_done "$T2" >/dev/null
echo "task=$T2"
tools_of "$T2"

echo
echo "======== 越界路径（期望：路径类工具一致拒绝）========"
T3=$(submit "依次尝试用 fs.write 写 /etc/dotd-probe、用 fs.read 读 /etc/passwd，把失败原因如实告诉我。")
wait_done "$T3" >/dev/null
echo "task=$T3"
tools_of "$T3"
