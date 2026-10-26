#!/usr/bin/env bash
# A/B 对比：把 primary 换成 deepseek-v4.1-flash，跑同样的任务
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

MODEL="${1:-deepseek-v4.1-flash}"
echo "=== 切到 $MODEL ==="
# 改的是 daemon **真读的那份**（托管部署里是 ~/.dotd/models.yml），并读回验证。
# 原来只 sed 仓库副本 config/models.yml：靠 wsl-daemon.sh 启动时拷过去才"碰巧生效"，
# 换成 one_system / charlie:start 重启就完全没生效，而脚本照样打印步数。
. "$(dirname "${BASH_SOURCE[0]}")/lib/model-switch.sh"
models_begin || exit 1
models_set_primary "$MODEL"
models_verify_primary "$MODEL" || exit 1

echo
echo "=== 重启 daemon 加载新配置 ==="
# 走 lib/daemon-restart.sh：托管部署里要停 supervisor，且 DOTD_MAX_RUNNING=1
# 只有在它交给新 supervisor 并读回 /proc/<pid>/environ 后才算数（第十一例）。
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
daemon_restart DOTD_MAX_RUNNING=1 || { echo "  ❌ 重启/环境验证失败"; exit 1; }
sleep 5

run_one() {
  local goal="$1"
  local body tid st t0 t1 steps
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$tid" ] && { echo "0 0 fail"; return; }
  t0=$(date +%s%3N)
  for i in $(seq 1 200); do
    sleep 1
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused) break ;; esac
  done
  t1=$(date +%s%3N)
  steps=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$tid")
  echo "$steps $((t1 - t0)) $st"
}

echo
echo "=== 任务 A：简单计算 ==="
read -r s t st <<< "$(run_one '用 shell.run 计算 25*4，只回数字')"
echo "  步数=$s 耗时=${t}ms 状态=$st"

echo
echo "=== 任务 B：写文件 ==="
read -r s2 t2 st2 <<< "$(run_one '把内容 AB-TEST-123 写到 ab-test.txt，读回确认，告诉我结果')"
echo "  步数=$s2 耗时=${t2}ms 状态=$st2"
