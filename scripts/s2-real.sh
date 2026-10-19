#!/usr/bin/env bash
# S2 验证：模型真的能造工具并复用
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

ask() {
  local goal="$1" label="$2"
  local t0 t1 tid st ans
  t0=$(date +%s%3N)
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$goal")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  [ -z "$tid" ] && { echo "  ❌ [$label] 提交失败"; return 1; }
  for i in $(seq 1 300); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done
  t1=$(date +%s%3N)
  ans=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content).replace(/\s+/g," ") : ""); db.close();' "$tid")
  echo "── [$label] $(awk "BEGIN{printf \"%.1f\", ($t1-$t0)/1000}")s  ${st}"
  echo "   $(printf '%s' "$ans" | cut -c1-260)"
  echo "   工具: $(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
process.stdout.write(rows.map(r => r.tool_name + ":" + r.status).join(" → ") || "(无)");
db.close();' "$tid")"
  echo ""
}

echo "════════ S2：造工具 ════════"
echo

echo "【任务 1】让模型造一个工具"
ask "帮我做一个工具，名字叫 word-count，功能：接收一段文本，返回它的字数（中文字符数+英文单词数）。做完告诉我怎么用。" "造工具"

echo
echo "=== 磁盘检查 ==="
CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
docker exec "$CID" sh -c 'ls -la /dot/home/tools/ 2>/dev/null || echo "  (无 tools 目录)"'
docker exec "$CID" sh -c 'cat /dot/home/tools/word-count/manifest.json 2>/dev/null | head -12'
