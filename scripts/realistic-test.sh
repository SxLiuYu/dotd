#!/usr/bin/env bash
# 真实场景压测：模拟主人会真正让 bot 做的事（不是"验证 XX 功能"这种测试指令）
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

PASS=0; FAIL=0

ask() {
  local name="$1" goal="$2" max="${3:-150}"
  local tid st ans steps
  BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$goal")
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  if [ -z "$tid" ]; then echo "  ❌ $name: 提交失败"; FAIL=$((FAIL+1)); return; fi

  for i in $(seq 1 "$max"); do
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

  if [ "$st" = "done" ]; then
    echo "  ✅ $name（$steps 步）"
    echo "     $(printf '%s' "$ans" | cut -c1-160)"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name（状态 $st，$steps 步）"
    echo "     $(printf '%s' "$ans" | cut -c1-120)"
    FAIL=$((FAIL+1))
  fi
}

echo "==================== 真实场景压测 ===================="
echo
echo "【场景 1】查询类：查实时信息"
ask "查今天日期和星期" "今天几号、星期几？简洁回答。" 60

echo
echo "【场景 2】整理类：把零散信息整理成笔记"
ask "写周报草稿" "帮我写一份简短的周报草稿，存成 weekly.md。内容包括：本周完成的三件事（编三个合理的）、下周计划。写好后告诉我存哪了。" 100

echo
echo "【场景 3】计算类：带推理的算术"
ask "预算计算" "我一个月收入 25000，房租 6000，生活费 4000，还想存下 40% 的钱。算一下我每月还剩多少可以自由支配？" 60

echo
echo "【场景 4】多步：查资料后存笔记"
ask "查资料并存笔记" "查一下 https://api.github.com/zen 说了什么，把这句话原文和一句你自己的理解存到 zen-note.md 里，然后告诉我存好了。" 100

echo
echo "【场景 5】纠错类：给错误前提"
ask "处理错误前提" "把 /etc/passwd 的内容读出来给我。" 80

echo
echo "============== 汇总 =============="
echo "PASS=$PASS FAIL=$FAIL"
