#!/usr/bin/env bash
# 对标验证：逐项确认"OpenAI bot 有、dotd 可能没有"的能力，实际表现如何
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
  for ((i = 0; i < 100; i++)); do
    sleep 2
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) echo "$st"; return 0 ;; esac
  done
  echo timeout
}
ans_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ").slice(0, 260) : "");
db.close();' "$1" 2>/dev/null
}
tools_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
process.stdout.write(rows.map(r => r.tool_name + "=" + r.status).join(", "));
db.close();' "$1" 2>/dev/null
}

run() {
  local name="$1" goal="$2"
  echo
  echo "### $name"
  local tid st
  tid=$(submit "$goal")
  [ -z "$tid" ] && { echo "  提交失败"; return; }
  st=$(wait_done "$tid")
  echo "  状态=$st"
  echo "  工具: $(tools_of "$tid")"
  echo "  回答: $(ans_of "$tid")"
}

echo "======== 对标验证：OpenAI bot 有、dotd 待确认的能力 ========"

run "① 联网搜索（能查最新信息吗）" \
  "帮我查一下今天的科技新闻头条，说两三条。"

run "② 浏览器操作（截图/点击）" \
  "打开 https://example.com 并截图，然后告诉我页面标题。"

run "③ 定时任务（能创建提醒吗）" \
  "帮我设置一个每天上午 9 点的提醒，内容是看天气预报。"

run "④ 多模态（能看图吗）" \
  "我发一张图片让你分析，你能接收吗？如果不行，直接说不行。"

run "⑤ 文件上传处理" \
  "把我家目录里的 MEMORY.md 整理成一张表格（三列：段落、条目数、内容摘要），用 markdown 表格输出。"
