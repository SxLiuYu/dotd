#!/usr/bin/env bash
# 会话摘要验证：跑一轮，看摘要有没有真的生成 / 有没有被 Runner 触发。
#
# 2026-10-26 修正（同类缺陷第十例）：
#   原来第二节写的是
#       echo "=== DIAG-SUM (hasFn 应为 true) ==="
#       grep 'DIAG-SUM' /tmp/dotd-wsl.log | tail -2
#   而 `DIAG-SUM` 在 src/ 里**只作为注释里的举例**存在（src/daemon.ts:756
#   「Runner 侧日志形如：DIAG-SUM ... hasFn=false」），没有任何地方打印它。
#   于是这一节永远空着，读的人却会以为"hasFn 不是 true = 代码有问题"。
#   真正的判据是三处：
#     · 装配层有没有转发 refreshContextSummary（2026-10-19 那次漏转发 → 422 线程全 null）
#     · src/runner/dot.ts:3074 `runner: 已更新会话摘要 <task>/<thread>`
#     · mem_threads.context_summary / context_summary_upto_seq 有没有值
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")
TID="${1:-thr_01M56VDNAZDDACBEB80CE1EKNP}"
LOG=/tmp/dotd-wsl.log

echo "=== ① 静态：装配层是否转发了 refreshContextSummary ==="
if grep -qE '^[[:space:]]*refreshContextSummary:[[:space:]]*\(' src/daemon.ts 2>/dev/null; then
  echo "  ✅ daemon.ts 的 memApiOf 里有 refreshContextSummary 转发"
else
  echo "  ❌ 装配层没转发 refreshContextSummary —— Runner 拿到 undefined，摘要永远不会生成"
  exit 1
fi

echo
echo "=== ② 提交任务触发摘要（threadId=$TID）==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:"只回复 SUMOK2",threadId:process.argv[1]}))' "$TID")
RESP=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages")
TASK=$(printf '%s' "$RESP" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TASK"
[ -z "$TASK" ] && { echo "  ❌ 提交失败: $(printf '%s' "$RESP" | head -c 150)"; exit 1; }

for i in $(seq 1 90); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TASK")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  状态=$ST"
sleep 6

echo
echo "=== ③ Runner 摘要触发日志（该有）==="
grep -F "已更新会话摘要 $TASK" "$LOG" | tail -2 \
  || echo "  (本轮没有摘要日志 —— 多半是增量没到阈值，属正常；看 ④ 的 upto_seq 是否变化)"

echo
echo "=== ④ 库里摘要是否真的写进去了 ==="
SUMMARY_LEN=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT LENGTH(context_summary) sl, context_summary_upto_seq u FROM mem_threads WHERE id=?").get(process.argv[1]);
if (!r) { console.log("0 0"); process.exit(0); }
console.log(`${r.sl} ${r.u}`);' "$TID")
read -r SLEN UPT <<< "$SUMMARY_LEN"
echo "  summary 长度=$SLEN  upto_seq=$UPT"
if [ "${SLEN:-0}" -gt 0 ]; then
  echo "  ✅ 该线程已有摘要"
else
  echo "  ⚠️ 该线程还没有摘要（历史线程可能本来就没到阈值，不算失败）"
fi
exit 0
