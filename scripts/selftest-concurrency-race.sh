#!/usr/bin/env bash
# 第二十一轮：真并发下的**资源竞争**。
#
# 前提：并发额度=2 必须真的生效（由 lib/daemon-restart.sh 重启后读回 /proc/<pid>/environ 保证；
# 原来那句 `DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh &` 是静默 no-op）。
# 两个任务跑在**同一个容器**里，要验证的是：并发的 shell.run / fs.write 会不会互相干扰？
#
# 场景：
#   A. 两个任务同时写**同一个文件**（冲突必然发生）→ 结果应该是什么？不能损坏、不能假装成功
#   B. 两个任务同时跑 shell.run → 输出不能串台
#   C. 并发下的 SQLite（node:sqlite 同步 API）会不会因锁冲突抛错
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
st_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}

echo "=== 以并发 2 重启 ==="
# 原来这里是 pkill + `DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh &`：
# 锁在 supervisor 手里 → 一次都没起；额度也没变（第十一例，见 lib/daemon-restart.sh）。
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
daemon_restart DOTD_MAX_RUNNING=2 || { echo "  ❌ 重启/环境验证失败，实验不成立"; exit 1; }

echo
echo "======== A. 两个任务同时写同一个文件 ========"
T1=$(submit "用 shell.run 执行 sleep 4; echo AAA > conflict.txt; cat conflict.txt")
T2=$(submit "用 shell.run 执行 sleep 4; echo BBB > conflict.txt; cat conflict.txt")
echo "  task1=$T1  task2=$T2"

for i in $(seq 1 90); do
  sleep 2
  S1=$(st_of "$T1"); S2=$(st_of "$T2")
  case "$S1" in done|failed|cancelled) ;; *) continue ;; esac
  case "$S2" in done|failed|cancelled) break ;; esac
done
echo "  最终: task1=$S1 task2=$S2"

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
FINAL=$(timeout 60 docker exec "$CID" sh -c 'cat /dot/home/conflict.txt 2>&1' 2>&1)
echo "  conflict.txt 最终内容: '$FINAL'"
case "$FINAL" in
  AAA|BBB) echo "  ✅ 文件完整（是其中一方内容，没有交错损坏）" ;;
  *) echo "  ⚠️ 内容异常: '$FINAL'" ;;
esac

echo
echo "======== B. 两个任务同时跑 shell.run，输出不能串台 ========"
T3=$(submit "用 shell.run 执行 sleep 3; echo ONLY-TASK3-XYZ")
T4=$(submit "用 shell.run 执行 sleep 3; echo ONLY-TASK4-ABC")
echo "  task3=$T3  task4=$T4"
for i in $(seq 1 90); do
  sleep 2
  S3=$(st_of "$T3"); S4=$(st_of "$T4")
  case "$S3" in done|failed|cancelled) ;; *) continue ;; esac
  case "$S4" in done|failed|cancelled) break ;; esac
done
echo "  task3=$S3 task4=$S4"
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const t of process.argv.slice(2)) {
  const rows = db.prepare("SELECT result_json FROM steps WHERE task_id=? AND kind=?").all(t, "tool");
  console.log("  " + t + " 输出: " + rows.map(r => String(r.result_json||"").match(/"stdout":"([^"]*)"/)?.[1]||"?").join(" | "));
}
db.close();' "$T3" "$T4"

echo
echo "======== C. 并发期间的错误日志（SQLite 锁等）========"
grep -iE 'SQLITE_BUSY|database is locked|锁|busy' /tmp/dotd-wsl.log | tail -5 || echo "  无锁冲突错误"
echo
echo "======== 本轮 daemon 日志中的异常 ========"
grep -iE '异常|error|failed|错误' /tmp/dotd-wsl.log | tail -6 || echo "  无异常"
