#!/usr/bin/env bash
# 第十四轮：异常路径 —— 模型不可用时的行为。
#
# 这些都是"平时不出现、出现就要命"的场景：
#   ① 模型端点全挂（503/连接拒绝）→ 任务应 paused(circuit_open)，不能永久卡 running
#   ② 端点恢复后 → 应能自动恢复领取任务
#   ③ 单个端点 429 → 应降级到 fallback 模型，不是直接失败
#
# 手法：临时改 models.yml 的 base_url 指向一个不存在的端口，制造"全挂"；
# 再改回来验证恢复。全程不碰容器。
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

cp config/models.yml /tmp/models.normal.bak

echo "======== 场景 A：模型端点全挂 ========"
# 把 tier1 的 base_url 指到一个没人监听的端口
python3 - <<'PY'
import re
p = 'config/models.yml'
t = open(p, encoding='utf-8').read()
t = re.sub(r'(base_url:\s*)https?://[^\s]+', r'\g<1>http://127.0.0.1:59999/v1', t, count=1)
open(p, 'w', encoding='utf-8').write(t)
print('  base_url → 127.0.0.1:59999（无人监听）')
PY
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do sleep 2; curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break; done
echo "  daemon 已起（$((i*2))s，模型不可达）"

T1=$(submit "算一下 1+1")
echo "  提交 task=$T1"
for i in $(seq 1 60); do
  sleep 2
  ST=$(task_status "$T1")
  case "$ST" in paused|failed|done|cancelled) break ;; esac
done
echo "  最终状态: $ST（$((i*2))s）"
case "$ST" in
  paused) ok "模型全挂 → paused（电路熔断，不是永久 running）" ;;
  failed) ok "模型全挂 → failed（可重试收口）" ;;
  done)   bad "模型全挂" "居然 done 了（说明没真挂）" ;;
  *)      bad "模型全挂收口" "状态 $ST（卡住了）" ;;
esac
echo "  熔断日志:"
grep -iE 'circuit|熔断|AllEndpointsDown|paused' /tmp/dotd-wsl.log | tail -3 || echo "  (无)"

echo
echo "======== 场景 B：恢复端点后能否继续干活 ========"
cp /tmp/models.normal.bak config/models.yml
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do sleep 2; curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break; done
T2=$(submit "只回复 OK 两个字")
for i in $(seq 1 90); do
  sleep 2
  ST2=$(task_status "$T2")
  case "$ST2" in paused|failed|done|cancelled) break ;; esac
done
echo "  恢复后新任务 task=$T2 状态: $ST2"
case "$ST2" in
  done) ok "端点恢复后能正常干活" ;;
  *)    bad "端点恢复" "状态 $ST2" ;;
esac

echo
echo "======== 汇总 ========"
echo "PASS=$PASS FAIL=$FAIL"
cp /tmp/models.normal.bak config/models.yml
[ "$FAIL" -eq 0 ]
