#!/usr/bin/env bash
# 第十二轮 B：运维健壮性 —— daemon 重启后的状态恢复。
#
# 真实使用中最常见的运维动作就是重启（改配置、升级、机器重启）。
# 必须确认重启后：容器能接管、会话还在、记忆还在、飞书还能收消息。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; echo "      $2"; FAIL=$((FAIL+1)); }

echo "=== 重启前：记一条会话基准 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:"重启测试：记住标记 RESTART-OK。只回收到。"}))')
R=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages")
T1=$(printf '%s' "$R" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
TH=$(printf '%s' "$R" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
for i in $(seq 1 60); do
  sleep 2
  ST=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$T1" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST" in done|succeeded|failed) break ;; esac
done
echo "  轮1 status=$ST thread=$TH"
BEFORE_MSGS=$(node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM mem_messages WHERE thread_id=?").get(process.argv[1]);
process.stdout.write(String(r.c));db.close();' "$TH")
echo "  重启前该会话消息数: $BEFORE_MSGS"

echo
echo "=== 重启 daemon ==="
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 60); do
  sleep 2
  curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break
done
echo "  重启完成（$((i*2))s）"

echo
echo "=== 重启后检查 ==="
# ① 容器是否接管
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.Names}}|{{.Status}}' 2>&1 | head -1)
echo "  容器: $CID"
case "$CID" in *Up*) ok "容器仍在运行" ;; *) bad "容器" "$CID" ;; esac

# ② 会话消息是否还在
AFTER_MSGS=$(node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM mem_messages WHERE thread_id=?").get(process.argv[1]);
process.stdout.write(String(r.c));db.close();' "$TH")
echo "  重启后该会话消息数: $AFTER_MSGS（重启前 $BEFORE_MSGS）"
if [ "$AFTER_MSGS" -ge "$BEFORE_MSGS" ]; then ok "会话历史完好"; else bad "会话历史" "少了 $((BEFORE_MSGS - AFTER_MSGS)) 条"; fi

# ③ 用同一个 thread 继续对话，看能否记起
BODY2=$(node -e 'process.stdout.write(JSON.stringify({text:"刚才让你记的标记是什么？",threadId:process.argv[1]}))' "$TH")
R2=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY2" "$BASE/api/messages")
T2=$(printf '%s' "$R2" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
for i in $(seq 1 90); do
  sleep 2
  ST2=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$T2" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
  case "$ST2" in done|succeeded|failed) break ;; esac
done
A2=$(node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const m=db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m?String(m.content).replace(/\s+/g," "):"");db.close();' "$T2")
echo "  重启后追问 status=$ST2"
echo "    回答: $(printf '%s' "$A2" | cut -c1-120)"
if printf '%s' "$A2" | grep -q "RESTART-OK"; then ok "重启后会话上下文可续（记得 RESTART-OK）"; else bad "重启后上下文" "回答里没有 RESTART-OK"; fi

# ④ 飞书长连接
if grep -q '飞书长连接已建立' /tmp/dotd-wsl.log; then ok "飞书长连接已重建"; else bad "飞书长连接" "日志里没有建立记录"; fi

echo
echo "=========== 汇总 ==========="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
