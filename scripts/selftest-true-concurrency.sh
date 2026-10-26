#!/usr/bin/env bash
# 真并发写测试：DOTD_MAX_RUNNING=2，让两个任务真正同时跑，看记忆写入是否冲突。
#
# 2026-10-26（同类缺陷第十一例）：原来这里是
#     pkill -9 -f 'src/daemon.ts'; sleep 3
#     DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh &   ← 锁被 supervisor 持着
# 第二行一次都没启动过任何东西（wsl-daemon.sh 打印「已有实例持锁」后 exit 0），
# 额度仍是启动 supervisor 时的旧值；更要命的是最后只**打印**观察到多少并发、从不断言，
# 于是「额度=2 生效」这个结论从来没被检验过。
# 现在：重启走 lib/daemon-restart.sh 并读回运行期环境，最后对 MAXRUN 断言。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

WANT_MAX=2
echo "=== 以 DOTD_MAX_RUNNING=$WANT_MAX 重启 daemon ==="
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
daemon_restart "DOTD_MAX_RUNNING=$WANT_MAX" || { echo "  ❌ 重启/环境验证失败，实验不成立"; exit 1; }
echo "  并发配置:"
curl -s -m 10 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" | head -c 250
echo

echo
echo "=== 同时提交 4 个任务，各写自己的文件 ==="
TID=()
for n in 1 2 3 4; do
  BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
    "用 shell.run 执行 sleep 3; echo RACE$n > race-$n.txt; cat race-$n.txt，把输出告诉我。")
  T=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  TID+=("$T")
  echo "  任务$n = $T"
done

echo
echo "=== 采样并发度 ==="
MAXRUN=0
for i in $(seq 1 60); do
  sleep 2
  N=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status=?").get("running");
process.stdout.write(String(r.c)); db.close();')
  [ "$N" -gt "$MAXRUN" ] && MAXRUN=$N
  D=0
  for t in "${TID[@]}"; do
    ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$t")
    case "$ST" in done|failed|cancelled) D=$((D+1)) ;; esac
  done
  [ "$D" -eq 4 ] && break
done
echo "  观察到最大并发 running = $MAXRUN"

echo
echo "=== 各任务结果 ==="
OK=0
for n in 1 2 3 4; do
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "${TID[$((n-1))]}")
  echo "  任务$n: $ST"
  [ "$ST" = "done" ] && OK=$((OK+1))
done

echo
echo "=== 容器内文件是否都在且内容正确 ==="
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
CGOOD=0
for n in 1 2 3 4; do
  C=$(timeout 60 docker exec "$CID" sh -c "cat /dot/home/race-$n.txt 2>/dev/null" 2>&1)
  if [ "$C" = "RACE$n" ]; then
    echo "  ✅ race-$n.txt = $C"
    CGOOD=$((CGOOD+1))
  else
    echo "  ❌ race-$n.txt 异常: '$C'"
  fi
done

echo
echo "======== 汇总 ========"
echo "并发度=$MAXRUN  任务完成=$OK/4  文件正确=$CGOOD/4"

# 断言（原来只打印，结论无人检验）：
#   上限 —— 超过额度就是额度没生效，本实验的核心前提塌了；
#   下限 —— 没到 2 说明根本没并发起来，"并发写不冲突"这句话也就没被验证过。
FAIL=0
if [ "$MAXRUN" -gt "$WANT_MAX" ]; then
  echo "  ❌ 并发度 $MAXRUN 超过额度 $WANT_MAX（额度没生效）"; FAIL=1
elif [ "$MAXRUN" -lt "$WANT_MAX" ]; then
  echo "  ⚠️ 并发度只到 $MAXRUN（<$WANT_MAX）：没有真正并发，结论不成立"; FAIL=1
fi
[ "$OK" -eq 4 ] || { echo "  ❌ 完成任务 $OK/4"; FAIL=1; }
[ "$CGOOD" -eq 4 ] || { echo "  ❌ 文件正确 $CGOOD/4"; FAIL=1; }
[ "$FAIL" -eq 0 ] && echo "  ✅ 并发度恰好 $WANT_MAX，任务与文件全部正确"
exit "$FAIL"
