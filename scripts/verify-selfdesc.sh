#!/usr/bin/env bash
# 复测"你能干什么"——新纪律要求先实测再回答
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

ask() {
  local goal="$1"
  local body tid st ans steps
  body=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  for i in $(seq 1 90); do
    sleep 2
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused) break ;; esac
  done
  ans=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content).replace(/\s+/g," ") : ""); db.close();' "$tid")
  steps=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c)); db.close();' "$tid")
  local tools
  tools=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name FROM steps WHERE task_id=? AND kind=?").all(process.argv[1],"tool");
process.stdout.write(rows.map(r=>r.tool_name).join(",") || "(无工具调用)"); db.close();' "$tid")
  echo "  [状态=$st 步数=$steps 工具=$tools]"
  echo "  $(printf '%s' "$ans" | cut -c1-350)"
}

echo "=== 第 1 次 ==="
ask "你能干什么"
echo
echo "=== 第 2 次 ==="
ask "你能干什么"