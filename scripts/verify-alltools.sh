#!/usr/bin/env bash
# 动态验证：让模型实际调用每个工具，看是否真的可用
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
PASS=0; FAIL=0

check() {
  local name="$1" goal="$2" expect_tool="$3"
  local BODY TID ST TOOLS
  BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$TID" ] && { echo "  ❌ $name 提交失败"; FAIL=$((FAIL+1)); return; }
  for i in $(seq 1 60); do
    sleep 2
    ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
    case "$ST" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  TOOLS=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
process.stdout.write(rows.map(r => r.tool_name + ":" + r.status).join(", "));
db.close();' "$TID")
  if printf '%s' "$TOOLS" | grep -q "$expect_tool:succeeded"; then
    echo "  ✅ $name（$TOOLS）"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name（$ST，$TOOLS）"
    FAIL=$((FAIL+1))
  fi
}

echo "════ 动态验证：让模型实际用每个工具 ════"
echo

# 准备测试文件
docker exec "$CID" sh -c 'mkdir -p /dot/home/t && echo "hello" > /dot/home/t/a.txt' 2>/dev/null

check "fs.list"   "用 fs.list 列出 home 下的 t 目录" "fs.list"
check "fs.stat"   "用 fs.stat 看 t/a.txt 的大小" "fs.stat"
check "fs.read"   "用 fs.read 读 t/a.txt 的内容" "fs.read"
check "fs.write"  "用 fs.write 把 hello2 写进 t/b.txt" "fs.write"
check "shell.run" "用 shell.run 执行 echo test" "shell.run"
check "net.get"   "用 net.get 访问 https://api.github.com/zen" "net.get"
check "schedule.list" "用 schedule.list 看看我有哪些定时任务" "schedule.list"

echo
echo "════ 汇总 ════"
echo "PASS=$PASS FAIL=$FAIL"
