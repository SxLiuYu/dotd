#!/usr/bin/env bash
set -uo pipefail
cd /root/dotd || exit 1

echo "=== 1. 清理卡住的审批与任务 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db");
const a = db.prepare("UPDATE approvals SET status=? WHERE status=?").run("expired", "pending");
const t = db.prepare("UPDATE tasks SET status=? WHERE status=?").run("cancelled", "awaiting_approval");
console.log("  过期审批: " + a.changes + " 条, 取消任务: " + t.changes + " 条");
db.close();'

echo ""
echo "=== 2. 重启 daemon ==="
pkill -f 'daemon.ts' 2>/dev/null || true
sleep 4
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &

for i in $(seq 1 60); do
  sleep 4
  if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/7788' 2>/dev/null; then
    echo "  就绪（$((i*4))s）"
    break
  fi
done

echo ""
echo "=== 3. 确认 deadline 已生效 ==="
node --import tsx -e '
const { CAPABILITY_CATALOG } = await import("./src/exec/protocol.ts");
const c = CAPABILITY_CATALOG.find((x) => x.name === "tool.create");
console.log("  tool.create max_deadline_ms = " + c.max_deadline_ms);
'
