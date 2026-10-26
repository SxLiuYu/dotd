#!/usr/bin/env bash
# 运维脚本：清掉卡住的审批/任务，然后重启 daemon。**会写活库**，必须显式确认。
#
# 用法：bash scripts/s2-restart.sh --yes
#
# 为什么加这道闸门（2026-10-26，同类缺陷第十一例的姊妹问题）：这个脚本一上来就对
# 活库执行两条 UPDATE，而它原来既没有参数也没有提示 —— 谁把它当"看状态的脚本"
# 跑一下，pending 审批就全变 expired、awaiting_approval 任务全变 cancelled，
# 而输出只有一行"过期审批: N 条"，看不出这是一次**写**操作。
set -uo pipefail

CLEAN_DB=0
[ "${1:-}" = "--yes" ] && CLEAN_DB=1

cd /root/dotd || exit 1

echo "=== 1. 清理卡住的审批与任务 ==="
if [ "$CLEAN_DB" = "1" ]; then
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db");
const a = db.prepare("UPDATE approvals SET status=? WHERE status=?").run("expired", "pending");
const t = db.prepare("UPDATE tasks SET status=? WHERE status=?").run("cancelled", "awaiting_approval");
console.log("  过期审批: " + a.changes + " 条, 取消任务: " + t.changes + " 条");
db.close();'
else
  echo "  (跳过：这会写活库，需要 --yes 才执行)"
fi

echo ""
echo "=== 2. 重启 daemon ==="
# 走 lib/daemon-restart.sh：托管部署里要停的是 supervisor（one_system），
# 不是它的 node 子进程；直接起 wsl-daemon.sh 在锁被占时是静默 no-op。
# 原来这里的 `pkill -f 'daemon.ts'` 还会匹配到执行本脚本的 shell 自己。
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
daemon_restart || { echo "  ❌ 重启失败"; exit 1; }

echo ""
echo "=== 3. 确认 deadline 已生效 ==="
node --import tsx -e '
const { CAPABILITY_CATALOG } = await import("./src/exec/protocol.ts");
const c = CAPABILITY_CATALOG.find((x) => x.name === "tool.create");
console.log("  tool.create max_deadline_ms = " + c.max_deadline_ms);
'
