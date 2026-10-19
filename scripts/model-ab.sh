#!/usr/bin/env bash
# 决定性实验：同一任务，不同模型，看工具复用行为
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

GOAL="统计一下这句话：Hello 世界，this is a test 测试。中文字和英文单词各有多少？"

test_model() {
  local model="$1"
  echo "════════ 模型: $model ════════"

  # 改配置
  python3 - "$model" <<'PYEOF'
import sys, re, io
model = sys.argv[1]
p = '/root/dotd/config/models.yml'
t = io.open(p, encoding='utf-8').read()
t = re.sub(r'(models:\s*\n\s*primary:\s*)\S+', r'\g<1>' + model, t, count=1)
io.open(p, 'w', encoding='utf-8').write(t)
PYEOF
  echo "  配置已切到 $model"

  # 重启
  pkill -f 'daemon.ts' 2>/dev/null || true
  sleep 3
  nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
  for i in $(seq 1 30); do
    sleep 2
    if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then break; fi
  done
  sleep 3

  # 发任务
  local tid st
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$GOAL")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  for i in $(seq 1 240); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done

  echo "  状态: $st"
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const ts = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
console.log("  工具: " + (ts.map(r => r.tool_name + ":" + r.status).join(" → ") || "(无)"));
const usedInvoke = ts.some(r => r.tool_name === "tool.invoke");
console.log("  " + (usedInvoke ? "✅ 复用了自造工具" : "❌ 没用自造工具"));
db.close();' "$tid"
  echo ""
}

for m in deepseek-v4.1-flash glm-5.3-flash agnes-3.0-flash; do
  test_model "$m"
done

echo "=== 恢复原配置 ==="
python3 - <<'PYEOF'
import re, io
p = '/root/dotd/config/models.yml'
t = io.open(p, encoding='utf-8').read()
t = re.sub(r'(models:\s*\n\s*primary:\s*)\S+', r'\g<1>deepseek-v4.1-flash', t, count=1)
io.open(p, 'w', encoding='utf-8').write(t)
print("  已恢复 deepseek-v4.1-flash")
PYEOF
