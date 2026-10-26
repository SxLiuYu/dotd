#!/usr/bin/env bash
# 第十二轮 C：崩溃恢复（kill -9 中途打断）。
#
# 这是与"优雅重启"完全不同的场景，之前从未验证：
#   daemon 在**任务执行中**被强杀 → 库里有 running 任务 + started 步骤 →
#   重启后必须能对账：不重复执行副作用、不把任务永久卡死。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

echo "=== 1. 提交一个会跑一段时间任务 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:"用 shell.run 连续执行三条命令：sleep 3; echo step1、sleep 3; echo step2、sleep 3; echo step3，然后把三步输出都告诉我。"}))')
R=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages")
T1=$(printf '%s' "$R" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$T1"

echo "=== 2. 等它进入 running（有 started 步骤）==="
for i in $(seq 1 30); do
  sleep 2
  N=$(node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=? AND status=?").get(process.argv[1],"started");
process.stdout.write(String(r.c));db.close();' "$T1")
  if [ "$N" -gt 0 ]; then echo "  已进入执行中（started 步骤 $N 个，等待 ${i}0s 内）"; break; fi
done

echo "=== 3. 强杀 daemon（kill -9，模拟崩溃）==="
# 用库的判据找 pid（不再 `ps aux | grep`）：顺带确认它到底有没有 supervisor 托管。
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
PID="$(daemon_pids | head -1)"
if [ -z "$PID" ]; then echo "  !! daemon 没找到"; exit 2; fi
SUP="$(daemon_supervisor_pids | tr '\n' ' ')"
echo "  daemon pid=$PID supervisor=${SUP:-（无）}"
kill -9 "$PID"
echo "  已 kill -9 $PID"

echo "=== 4. 崩溃瞬间的库状态 ==="
node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const t=db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
const steps=db.prepare("SELECT seq,kind,tool_name,status FROM steps WHERE task_id=? ORDER BY seq").all(process.argv[1]);
console.log("  任务状态:", t?t.status:"?");
console.log("  步骤:", steps.map(function(s){return s.seq+":"+s.kind+(s.tool_name?":"+s.tool_name:"")+"="+s.status;}).join(" | "));
db.close();' "$T1"

echo "=== 5. 等 supervisor 把 daemon 拉回来（应触发崩溃恢复对账）==="
# 这里**故意**只 kill 子进程：本脚本要验的就是"崩溃后自动恢复"。
# 托管模式下 supervisor 会按退避重启子进程 —— 所以原来那句
# `nohup setsid bash scripts/wsl-daemon.sh &` 是多余的空操作
# （锁在 supervisor 手上，wsl-daemon.sh 会打印「已有实例持锁」并 exit 0；
#  见 scripts/lib/daemon-restart.sh 头部第十一例）。
# 正确的等待条件是"出现了**新** pid，且端口通"。
sleep 2
if [ -z "${SUP// /}" ]; then
  # 没有 supervisor（裸跑 daemon）时没人替我们拉起来 —— 这时才需要自己起。
  echo "  （无 supervisor，自己拉起）"
  daemon_restart || { echo "  ❌ 重启失败"; exit 2; }
  NEW_PID="$(daemon_pids | head -1)"
else
  NEW_PID=""
  for i in $(seq 1 60); do
    sleep 2
    NEW_PID="$(daemon_pids | head -1)"
    if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$PID" ] \
       && curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1; then
      break
    fi
    NEW_PID=""
  done
fi
if [ -z "$NEW_PID" ]; then
  echo "  ❌ 60×2s 内没有起来新的 daemon（旧 pid=$PID）"
  tail -n 10 /tmp/dotd-wsl.log 2>/dev/null | sed 's/^/      /'
  exit 2
fi
echo "  已恢复：新 pid=$NEW_PID（旧 $PID）"
echo "  恢复日志:"
grep -E '启动恢复|孤儿步|reconcile|对账' /tmp/dotd-wsl.log | tail -4

echo "=== 6. 等任务收敛（最多 240s）==="
# 注意两点：
#   ① /api/tasks 返回的 status 是**步骤**状态，任务状态必须查 tasks 表；
#   ② 崩溃恢复后任务是 running→queued→再被领回→running，所以必须等到**终态**，
#      queued 只是中间态（我第一版把它当终态，误判成"卡住"）。
for i in $(seq 1 120); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$T1")
  case "$ST" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
done
echo "  最终状态: $ST"

echo "=== 7. 检查结果 ==="
if [ "$ST" = "done" ] || [ "$ST" = "failed" ] || [ "$ST" = "cancelled" ]; then
  ok "任务收敛到终态（没有永久卡在 running）"
else
  bad "任务收敛" "仍是 $ST"
fi

LEFT=$(node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=? AND status=?").get(process.argv[1],"started");
process.stdout.write(String(r.c));db.close();' "$T1")
echo "  残留 started 步骤: $LEFT"
if [ "$LEFT" -eq 0 ]; then ok "无孤儿 started 步骤"; else bad "孤儿步骤" "还有 $LEFT 个 started"; fi

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
