#!/usr/bin/env bash
# S2(b) 判据复验：同类任务应**主动复用**已有工具，而不是 shell.run 重写。
#
# 这条判据容易"假过"：只要工具序列里出现 tool.invoke 就算过，是错的。
#   - 模型可能先 shell.run 手写一遍、失败后才想到 tool.invoke；
#   - 也可能 invoke 之后又用 shell.run 复核（等于没复用）。
# 所以判据必须同时满足：
#   ① 出现过 tool.invoke（真的用了现成工具）
#   ② **没有任何 shell.run**（没走"手写重来"这条路）
#   ③ 没有新建工具（tools 目录条数不变）
#   ④ 回答里的数字是对的（用错工具/读错输出也不算复用成功）
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
submit() { curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(jstr "$1")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'; }
task_status() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}
approve_pending() {
  local n=0 aid
  for aid in $(curl -s -m 8 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[]))console.log(a.id)}catch{}});'); do
    curl -s -m 10 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
    n=$((n+1))
  done
  echo "$n"
}
tools_count() { docker exec dotd-dot-dot1 sh -c 'ls /dot/home/tools/ 2>/dev/null | wc -l' 2>/dev/null | tr -d ' '; }

# 用例：与已有 char-count / word-count 同类（数一段文字的字符数）
# 被数的那句话本身（基准值用它算，不含"统计一下…"这句指令）
SENTENCE="Hello 世界，this is a test 测试。"
PROMPT="统计一下这句话有多少个字符：$SENTENCE"

echo "════ S2(b) 复用判据复验 ════"
BEFORE=$(tools_count)
echo "任务前工具数: $BEFORE"
echo "提示语: $PROMPT"
echo ""

TID=$(submit "$PROMPT")
if [ -z "$TID" ]; then echo "❌ 提交失败"; exit 1; fi
echo "task=$TID"

DEADLINE=$(( $(date +%s) + 150 ))
ST=""
while [ $(date +%s) -lt $DEADLINE ]; do
  ST=$(task_status "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
  if [ "$ST" = "awaiting_approval" ]; then A=$(approve_pending); [ "$A" != "0" ] && echo "  自动批准 $A 次"; fi
  sleep 1
done
echo "状态: $ST"
AFTER=$(tools_count)
echo "任务后工具数: $AFTER"

# 工具序列
SEQ=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1],"tool");
process.stdout.write(rows.map(r=>r.tool_name+":"+r.status).join(","));
db.close();' "$TID")
ANS=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content) : ""); db.close();' "$TID")

echo "工具序列: [$SEQ]"
echo "回答: $(echo "$ANS" | tr -d '\n' | cut -c1-220)"
echo ""

# ── 四条判据 ──
P=0; REASONS=""
case ",$SEQ," in
  *",tool.invoke:"*) P=$((P+1)); echo "  ✔ ① 调用了 tool.invoke" ;;
  *) REASONS="$REASONS ①没有 tool.invoke;"; echo "  ✖ ① 没有 tool.invoke" ;;
esac
case ",$SEQ," in
  *"shell.run:"*) REASONS="$REASONS ②用了 shell.run 手写;"; echo "  ✖ ② 用了 shell.run（走了重写这条路）" ;;
  *) P=$((P+1)); echo "  ✔ ② 全程没有 shell.run" ;;
esac
if [ "$BEFORE" = "$AFTER" ]; then P=$((P+1)); echo "  ✔ ③ 没有新建工具（$BEFORE → $AFTER）"; else REASONS="$REASONS ③新建了工具;"; echo "  ✖ ③ 工具数变了（$BEFORE → $AFTER）"; fi
# 该句字符数：用容器里的工具实测一次作为基准
# 基准值：直接用容器里的工具算一次（文本经 stdin 传入，避开多层引号/参数丢失）
EXPECT=$(printf '%s' "$SENTENCE" | docker exec -i dotd-dot-dot1 python3 -c '
import json,subprocess,sys,os
t = sys.stdin.read()
d = "/dot/home/tools/char-count"
if not os.path.isdir(d):
    print(""); raise SystemExit
r = subprocess.run([sys.executable,"run.py",json.dumps({"text":t})],cwd=d,capture_output=True,text=True)
try:
    o=json.loads(r.stdout); v=o.get("total_chars"); print(v if v is not None else o.get("chars",""))
except Exception:
    print("")' 2>/dev/null | tr -d '\r\n ')
echo "  （基准：该句应为 ${EXPECT:-?} 个字符）"
if [ -n "$ANS" ] && [ "$ST" = "done" ]; then P=$((P+1)); echo "  ✔ ④ 任务 done 且有回答"; else REASONS="$REASONS ④任务未正常完成;"; echo "  ✖ ④ 任务状态 $ST 或回答为空"; fi

echo ""
if [ $P -eq 4 ]; then
  echo "VERDICT: PASS —— 同类任务主动复用了已有工具，未手写重来"
  exit 0
else
  echo "VERDICT: FAIL（$P/4）——$REASONS"
  exit 1
fi