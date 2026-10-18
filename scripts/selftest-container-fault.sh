#!/usr/bin/env bash
# 第十五轮：容器异常 —— 执行中容器被杀 / 镜像丢失时能否优雅降级。
#
# 场景：
#   ① 任务执行中 `docker kill` 容器 → 工具调用应失败但任务应收口，不能永久卡 running
#   ② 容器被杀后 daemon 能否自动重建容器（boot/recreate 逻辑）
#   ③ 重建后还能否正常工作
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

task_status() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : "(missing)"); db.close();' "$1"
}
submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

echo "======== 场景 A：任务执行中强杀容器 ========"
T1=$(submit "用 shell.run 执行 sleep 20; echo 容器测试完成，然后把输出告诉我。")
echo "  task=$T1"
# 等它真正开始跑工具
for i in $(seq 1 30); do
  sleep 2
  N=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=? AND status=?").get(process.argv[1], "started");
process.stdout.write(String(r.c)); db.close();' "$T1")
  [ "$N" -gt 0 ] && { echo "  已开始执行（started 步骤 $N）"; break; }
done

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "  强杀容器 $CID"
timeout 60 docker kill "$CID" >/dev/null 2>&1
echo "  killed"

echo "  等任务收口（最多 180s）..."
for i in $(seq 1 90); do
  sleep 2
  ST=$(task_status "$T1")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  任务最终状态: $ST（$((i*2))s）"
case "$ST" in
  done|failed|cancelled) ok "容器被杀 → 任务正常收口（未卡 running）" ;;
  paused) ok "容器被杀 → 任务 paused" ;;
  running) bad "容器被杀收口" "仍卡在 running" ;;
  *) bad "容器被杀收口" "状态 $ST" ;;
esac

echo
echo "======== 场景 B：daemon 能否自动重建容器 ========"
sleep 5
CID2=$(timeout 40 docker ps -a --filter name=dotd-dot-dot1 --format '{{.ID}}|{{.Status}}' | head -1)
echo "  容器现状: ${CID2:-（无）}"
# 触发一次 daemon 重启（boot 会 reconcile）
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do sleep 2; curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break; done
sleep 10
CID3=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.Names}}|{{.Status}}' | head -1)
echo "  重启后容器: ${CID3:-（无）}"
case "$CID3" in
  *Up*) ok "daemon 自动重建了容器" ;;
  *) bad "容器重建" "$CID3" ;;
esac
echo "  boot 日志:"
grep -E 'boot|recreate|重建' /tmp/dotd-wsl.log | tail -3

echo
echo "======== 场景 C：重建后能否正常干活 ========"
T3=$(submit "只回复 OK")
for i in $(seq 1 90); do
  sleep 2
  ST3=$(task_status "$T3")
  case "$ST3" in done|failed|cancelled|paused) break ;; esac
done
echo "  task=$T3 状态: $ST3"
case "$ST3" in
  done) ok "重建后能正常工作" ;;
  *) bad "重建后工作" "状态 $ST3" ;;
esac

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
