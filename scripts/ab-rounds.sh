#!/usr/bin/env bash
# 重复三轮 A/B，排除单次波动：只看 S5（确认型）与合计数。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

MODEL="${1:?model}"
ROUNDS="${2:-3}"

cp config/models.yml /tmp/models.yml.ab
node -e '
const fs=require("fs");const p="config/models.yml";
let t=fs.readFileSync(p,"utf8");
t=t.replace(/^(\s*)primary: .*$/m,"$1primary: "+process.argv[1]);
fs.writeFileSync(p,t);' "$MODEL"

pkill -9 -f 'src/daemon.ts' 2>/dev/null || true
sleep 3
nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 45); do
  sleep 2
  curl -sf -m 3 -H "Authorization: Bearer $DOTD_MASTER_TOKEN" "$BASE/api/status" >/dev/null 2>&1 && break
done

submit() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$1")
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$body" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}
wait_task() {
  local tid="$1" i st
  for ((i = 0; i < 150; i++)); do
    sleep 2
    st=$(curl -s -m 10 "${HDR[@]}" "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo timeout
}
steps_of() {
  node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM steps WHERE task_id=?").get(process.argv[1]);
process.stdout.write(String(r.c));db.close();' "$1" 2>/dev/null
}
answer_of() {
  node --disable-warning=ExperimentalWarning -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.dotd/dotd.db",{readOnly:true});
const m=db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m?String(m.content).replace(/\s+/g," "):"");db.close();' "$1" 2>/dev/null
}

echo "#### $MODEL ####"
for r in $(seq 1 "$ROUNDS"); do
  # S5 确认型（本轮主战场）
  T=$(submit "创建 d1.txt 写 11，d2.txt 写 22，读回确认，最后回复两数之和。")
  ST=$(wait_task "$T"); N=$(steps_of "$T"); A=$(answer_of "$T")
  OK="✅"; printf '%s' "$A" | grep -q "33" || OK="❌"
  # 简单任务做对照
  T2=$(submit "用 shell.run 算 27*39，只回数字。")
  ST2=$(wait_task "$T2"); N2=$(steps_of "$T2")
  printf '  round%s  S5(确认型)=%-3s步 %s   S1(简单)=%-2s步\n' "$r" "$N" "$OK" "$N2"
done

cp /tmp/models.yml.ab config/models.yml
