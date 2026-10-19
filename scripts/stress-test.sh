#!/usr/bin/env bash
# 持续压测：连续跑 12 个真实任务，观察稳定性与延迟
# 目的：确认"切模型 + 修 relay + 加探针"之后，系统能连续稳定工作
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0; TOTAL_MS=0

run() {
  local name="$1" goal="$2" expect="$3"
  local body tid st t0 t1 ans ms
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$tid" ] && { echo "  ❌ $name 提交失败"; FAIL=$((FAIL+1)); return; }
  t0=$(date +%s%3N)
  for i in $(seq 1 150); do
    sleep 1
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused) break ;; esac
  done
  t1=$(date +%s%3N)
  ms=$((t1 - t0))
  TOTAL_MS=$((TOTAL_MS + ms))
  ans=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content).replace(/\s+/g," ") : ""); db.close();' "$tid")
  if [ "$st" = "done" ] && printf '%s' "$ans" | grep -Eq "$expect"; then
    echo "  ✅ $name（${ms}ms）"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name（${ms}ms, 状态=$st）"
    echo "     $(printf '%s' "$ans" | cut -c1-90)"
    FAIL=$((FAIL+1))
  fi
}

echo "=== 连续压测开始 $(date '+%H:%M:%S') ==="
echo

run "算术1" "只回答数字：17 * 23 等于多少" "391"
run "算术2" "只回答数字：144 / 12 等于多少" "12"
run "写文件" "把内容 STRESS-A 写进 stress-a.txt，只回复完成。" "(完成|好|OK)"
run "读文件" "读 stress-a.txt，告诉我内容。" "STRESS-A"
run "写文件2" "把内容 STRESS-B 写进 stress-b.txt，只回复完成。" "(完成|好|OK)"
run "读文件2" "读 stress-b.txt，告诉我内容。" "STRESS-B"
run "列目录" "列出家目录里所有 .txt 文件，告诉我有多少个。" "[0-9]"
run "推理" "一件商品 200 元打八折，再减 20 元，最终多少元？只回答数字。" "140"
run "联网" "用 net.get 访问 https://api.github.com/zen，把原文告诉我。" "."
run "记忆" "记住这个标记：STRESS-MARK-789。只回复收到。" "(收到|好|OK)"
run "文档" "读 home 里的 health-doc.pdf，里面的 code 是什么？" "HX-2026"
run "定时" "我目前有哪些定时任务？简单列一下。" "(提醒|任务|喝水|天气)"

echo
echo "=== 压测结束 $(date '+%H:%M:%S') ==="
echo "PASS=$PASS FAIL=$FAIL"
if [ "$PASS" -gt 0 ]; then echo "平均耗时: $((TOTAL_MS / (PASS + FAIL)))ms"; fi
