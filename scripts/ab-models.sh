#!/usr/bin/env bash
# 跨模型 A/B：同一批用例，换 primary 模型跑，比步数与正确率。
#
# 判据（与前几轮一致）：
#   - 任务必须 done/succeeded；
#   - **步数**要收敛（这是本轮的比较维度）；
#   - 回答要正确（内容断言）。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

MODEL="${1:?用法: $0 <model-id>}"
echo "################ model = $MODEL ################"

# 切模型：改 **daemon 真读的那份**（托管部署里是 ~/.dotd/models.yml），并读回验证。
# 原来只改仓库副本 config/models.yml —— 靠 wsl-daemon.sh 启动时拷到 ~/.dotd 才
# "碰巧生效"；用 one_system / charlie:start 重启时改动完全不生效，而脚本照样
# 打印步数与正确率，看起来像"两个模型差不多"（2026-10-26，同类缺陷第九例）。
. "$(dirname "${BASH_SOURCE[0]}")/lib/model-switch.sh"
models_begin || exit 1
models_set_primary "$MODEL"
models_verify_primary "$MODEL" || exit 1
grep -E '^\s+(primary|light):' "$_MODELS_RUNTIME" | head -2

# 重启让它生效
pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 45); do
  sleep 2
  if curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1; then break; fi
done
echo "daemon 就绪（$((i*2))s）"

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" i st
  for ((i = 0; i < 150; i++)); do
    sleep 2
    st=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo timeout
}
answer_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1")
  .get(process.argv[1], "assistant", "text");
process.stdout.write(m ? String(m.content).replace(/\s+/g, " ") : "");
db.close();' "$1" 2>/dev/null
}
steps_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$1" 2>/dev/null
}

TOTAL=0
run() {
  local name="$1" prompt="$2" want="$3"
  local tid st ans n
  tid=$(submit "$prompt")
  if [ -z "$tid" ]; then printf '  %-16s SUBMIT-FAIL\n' "$name"; return; fi
  st=$(wait_task "$tid"); ans=$(answer_of "$tid"); n=$(steps_of "$tid")
  TOTAL=$((TOTAL + n))
  local mark="✅"
  if [ "$st" != "done" ] && [ "$st" != "succeeded" ]; then mark="❌状态"; fi
  if [ -n "$want" ] && ! printf '%s' "$ans" | grep -Eq "$want"; then mark="❌答案"; fi
  printf '  %-16s %-10s steps=%-4s %s  %s\n' "$name" "$st" "$n" "$mark" "$(printf '%s' "$ans" | cut -c1-46)"
}

run "S1 简单算数"   "用 shell.run 算 27*39，只回数字。" "1053"
run "S2 写文件"     "把文字 OK-777 写进 s2.txt，只回「完成」。" "(完成|好了|OK)"
run "S3 读文件"     "读 s2.txt 内容告诉我。" "OK-777"
run "S4 联网取数"   "用 net.get 访问 https://api.github.com/zen，把原文告诉我。" "."
run "S5 确认型"     "创建 c1.txt 写 11，c2.txt 写 22，读回确认，最后回复两数之和。" "33"

echo "  ---- 合计步数: $TOTAL ----"
cp /tmp/models.yml.bak config/models.yml
