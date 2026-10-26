#!/usr/bin/env bash
# 工具清单注入诊断：跑一个任务，看 Runner 有没有真的把自造工具清单塞进请求。
#
# 2026-10-26 重写（同类缺陷第十例/十一例）：
#   原来这个脚本 `export DOTD_DIAG_INV=1` 重启，然后 `grep 'DIAG-INV' /tmp/dotd-wsl.log`。
#   实际上：
#     · `DOTD_DIAG_INV` 在全仓库**没有任何代码读它**（`git log -S` 也没有）；
#     · 那句 grep 找的 `DIAG-INV` 标记**从来没被任何代码打印过**；
#     · 找不到时打印「(无输出 —— buildMessages 没走到诊断点)」——
#       把"我在找不存在的东西"说成了"被测代码有问题"。
#   真正存在的日志是 src/runner/dot.ts 里这两行：
#     `runner: tool.list 原始返回 <task>：…`
#     `runner: 工具清单 <task>：发现 N 个自造工具`
#   这里改成 grep 那两条，并同时看 steps 里有没有 tool.list / tool.invoke。
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a

. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"

echo "=== 重启 daemon ==="
# 重启后 wsl-daemon.sh 会把上一份日志**归档**成 /tmp/dotd-wsl.log.prev 再新建一份
# （它自己的 §LOG 逻辑），所以这里重启完的日志天然是这一轮的。原来在这里
# `: > /tmp/dotd-wsl.log` 是错的：daemon 还握着旧 fd，截断等于把正在写的现场清零。
LOG=/tmp/dotd-wsl.log
daemon_restart || { echo "❌ 重启失败"; exit 1; }
newlog() { cat "$LOG" 2>/dev/null; }
echo "  上一份日志：/tmp/dotd-wsl.log.prev"

BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"text":"打个招呼就行"}' "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"
[ -z "$TID" ] && { echo "❌ 提交失败"; exit 1; }
for i in $(seq 1 120); do
  sleep 0.5
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
done
echo "状态: $ST"
echo

echo "=== ① Runner 的 tool.list 原始返回（该有）==="
newlog | grep -F "runner: tool.list 原始返回 $TID" | tail -1 \
  || echo "  (没有这一行 —— 说明 hasToolList() 为假，或执行面没回 tool.list)"
echo
echo "=== ② Runner 的清单判定（该有）==="
newlog | grep -F "runner: 工具清单 $TID" | tail -1 \
  || echo "  (没有这一行 —— 看上面 ① 是否就失败在 runTool)"
echo
echo "=== ③ 注入失败（有就是问题）==="
newlog | grep -F "runner: 工具清单注入失败 $TID" | tail -3 \
  || echo "  (无)"
echo
echo "=== ④ 这个任务实际调了哪些工具 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT seq, tool_name, status FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1], "tool");
if (!rows.length) console.log("  (无工具调用)");
for (const r of rows) console.log("  " + String(r.seq).padStart(2) + " " + String(r.tool_name).padEnd(18) + r.status);
db.close();' "$TID"

if newlog | grep -qF "runner: 工具清单 $TID"; then exit 0; else exit 1; fi
