#!/usr/bin/env bash
# 全面能力体检：一次跑完所有核心能力，确认都在正常运转
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "     $2"; FAIL=$((FAIL+1)); }

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" max="${2:-120}" i st
  for ((i = 0; i < max; i++)); do
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
  local name="$1" goal="$2" want="$3" maxsteps="${4:-16}"
  local tid st ans n
  tid=$(submit "$goal")
  [ -z "$tid" ] && { bad "$name" "提交失败"; return; }
  st=$(wait_task "$tid"); ans=$(ans_of "$tid"); n=$(steps_of "$tid")
  if [ "$st" != "done" ] && [ "$st" != "succeeded" ]; then bad "$name" "状态 $st"; return; fi
  if [ "$n" -gt "$maxsteps" ]; then bad "$name" "$n 步超过 $maxsteps"; return; fi
  if [ -n "$want" ] && ! printf '%s' "$ans" | grep -Eq "$want"; then
    bad "$name" "回答未命中：$(printf '%s' "$ans" | cut -c1-90)"; return
  fi
  ok "$name（$n 步）"
}

echo "==================== 全面能力体检 ===================="
echo

echo "【1】基础：文件读写"
run "写文件" "把内容 HEALTH-OK 写进 health.txt，只回完成。" "(完成|好了|OK)" 10
run "读文件" "读 health.txt 内容告诉我。" "HEALTH-OK" 8

echo
echo "【2】执行：命令"
run "shell 计算" "用 shell.run 计算 12*34，只回数字。" "408" 8

echo
echo "【3】联网"
run "net.get 取数" "用 net.get 访问 https://api.github.com/zen，把原文告诉我。" "." 10

echo
echo "【4】文档：PDF / Excel"
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
docker exec "$CID" sh -c 'python3 - <<PY
text = "Health Check Doc: code HX-2026 total 1234"
stream = f"BT /F1 12 Tf 30 700 Td ({text}) Tj ET".encode()
pdf = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
       b"4 0 obj<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream endobj\n"
       b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF")
open("/dot/home/health-doc.pdf","wb").write(pdf)
PY' 2>/dev/null
run "读 PDF" "读 home 里的 health-doc.pdf，告诉我里面的 code 是多少。" "HX-2026" 14

echo
echo "【5】定时任务"
run "创建定时任务" "创建一个定时任务：每天早上 7 点提醒我喝水。建好后告诉我下次触发时间。" "(7|触发|创建)" 14
run "列出定时任务" "我现在有哪些定时任务？" "(喝水|定时|任务)" 10

echo
echo "【6】记忆"
run "写记忆" "把 HEALTH-CHECK-2026 这个标记记到记忆里，只回收到。" "(收到|好|OK)" 12

echo
echo "============== 汇总 =============="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
