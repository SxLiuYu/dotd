#!/usr/bin/env bash
# 第十六轮：并发 —— 多任务同时进来时的排队、公平性、隔离。
#
# maxRunningTasks=1 意味着任务串行执行。要验证的：
#   ① 一次性提交 5 个任务：全部完成，一个不丢
#   ② 串行性：任何时刻最多 1 个 running（不会并发抢占同一个容器）
#   ③ 公平性：不会饿死（后提交的也能跑到）
#   ④ 优先级：interactive(1) 的任务不被丢弃
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
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

echo "======== 一次性提交 5 个任务 ========"
TIDS=()
TEXTS=(
  "只回复 A1"
  "只回复 A2"
  "只回复 A3"
  "只回复 A4"
  "只回复 A5"
)
for txt in "${TEXTS[@]}"; do
  T=$(submit "$txt")
  TIDS+=("$T")
  echo "  $txt → $T"
done

echo
echo "======== 采样并发度（每 3s 一次，共 60 次）========"
MAXRUN=0
SAMPLES=0
for i in $(seq 1 60); do
  N=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status=?").get("running");
process.stdout.write(String(r.c)); db.close();')
  SAMPLES=$((SAMPLES+1))
  [ "$N" -gt "$MAXRUN" ] && MAXRUN=$N
  # 全部结束就退出
  DONE=0
  for t in "${TIDS[@]}"; do
    ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$t")
    case "$ST" in done|failed|cancelled) DONE=$((DONE+1)) ;; esac
  done
  [ "$DONE" -eq 5 ] && break
  sleep 3
done

echo "  采样 $SAMPLES 次，观察到最大并发 running = $MAXRUN"
if [ "$MAXRUN" -le 1 ]; then ok "串行执行（最大并发 1，不抢占同一容器）"; else bad "串行性" "观察到 $MAXRUN 个并发 running"; fi

echo
echo "======== 各任务最终状态 ========"
FIN=0
for t in "${TIDS[@]}"; do
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status,stop_reason FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? (r.status + (r.stop_reason ? "/" + r.stop_reason : "")) : "(missing)"); db.close();' "$t")
  ANS=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ").slice(0, 40) : ""); db.close();' "$t")
  echo "  $t → $ST | $ANS"
  case "$ST" in done*) FIN=$((FIN+1)) ;; esac
done

if [ "$FIN" -eq 5 ]; then ok "5 个任务全部完成（一个不丢）"; else bad "全部完成" "只有 $FIN/5 完成"; fi

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
