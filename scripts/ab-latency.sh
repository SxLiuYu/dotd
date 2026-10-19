#!/usr/bin/env bash
# 带延迟的 A/B：glm-5.3-flash vs deepseek-v4.1-flash
# 上次选型只看了步数，没测延迟。这次两者都看。
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

run_one() {
  local goal="$1"
  local body tid st t0 t1 steps
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$tid" ] && { echo "0 0"; return; }
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

echo "=== 当前模型配置 ==="
grep -E "^\s+primary:|^\s+light:" config/models.yml | head -2
echo

echo "=== 任务 A：简单（4 步档）==="
read -r s t st <<< "$(run_one '用 shell.run 计算 25*4，只回数字')"
echo "  步数=$s 耗时=${t}ms 状态=$st"

echo
echo "=== 任务 B：多步（要写文件）==="
read -r s2 t2 st2 <<< "$(run_one '把内容 AB-TEST-123 写到 ab-test.txt，读回确认，告诉我结果')"
echo "  步数=$s2 耗时=${t2}ms 状态=$st2"

echo
echo "=== 本次两个任务的模型调用延迟 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare(`
  SELECT model, latency_ms, prompt_tokens, completion_tokens FROM model_call_log
  WHERE id > (SELECT MAX(id) - 20 FROM model_call_log) AND outcome = "ok" ORDER BY id DESC
`).all();
for (const r of rows) {
  console.log(`  ${String(r.model).padEnd(20)} ${String(r.latency_ms).padStart(6)}ms  prompt=${r.prompt_tokens} completion=${r.completion_tokens}`);
}
db.close();' 2>&1 | head -12
