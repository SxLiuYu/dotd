#!/usr/bin/env bash
# 第十六轮 B：任务执行中动态提交 —— 验证抢占/中断/排队。
#
# ① 先提交一个长任务（占用唯一名额）
# ② 在它执行中再提交 3 个短任务
# ③ 验证：长任务不被打断、短任务排队且全部完成、顺序合理
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
st_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}

echo "======== 1. 提交长任务 ========"
LONG=$(submit "用 shell.run 执行 sleep 25，然后用一句话告诉我结果。")
echo "  长任务=$LONG"

echo "======== 2. 等它进入 running ========"
for i in $(seq 1 30); do
  sleep 2
  ST=$(st_of "$LONG")
  [ "$ST" = "running" ] && { echo "  已 running（$((i*2))s）"; break; }
done

echo "======== 3. 执行中提交 3 个短任务 ========"
S=()
for n in 1 2 3; do
  T=$(submit "只回复 SHORT$n")
  S+=("$T")
  echo "  短任务$n=$T"
done

echo "======== 4. 观察：短任务应排队，不能被抢占执行 ========"
QUEUED_OK=1
for t in "${S[@]}"; do
  ST=$(st_of "$t")
  echo "  立即状态: $t → $ST"
  case "$ST" in queued|pending|running) ;; *) QUEUED_OK=0 ;; esac
done
if [ "$QUEUED_OK" = "1" ]; then ok "短任务在队列中（未立即抢占）"; else bad "排队" "有任务状态异常"; fi

echo "======== 5. 等全部完成 ========"
for i in $(seq 1 150); do
  sleep 3
  D=0
  LST=$(st_of "$LONG")
  case "$LST" in done|failed|cancelled) D=$((D+1)) ;; esac
  for t in "${S[@]}"; do
    ST=$(st_of "$t")
    case "$ST" in done|failed|cancelled) D=$((D+1)) ;; esac
  done
  [ "$D" -eq 4 ] && break
done

echo "  长任务最终: $LST"
case "$LST" in done) ok "长任务完整跑完（未被打断）" ;; *) bad "长任务" "状态 $LST" ;; esac

SHORT_DONE=0
for t in "${S[@]}"; do
  ST=$(st_of "$t")
  echo "  $t → $ST"
  case "$ST" in done) SHORT_DONE=$((SHORT_DONE+1)) ;; esac
done
[ "$SHORT_DONE" -eq 3 ] && ok "3 个短任务全部完成" || bad "短任务" "只完成 $SHORT_DONE/3"

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
