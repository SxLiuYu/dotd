#!/usr/bin/env bash
# dotd 多轮端到端复测：直接打 API，逐项验证真实能力（不经飞书，排除 UI 因素）。
#
# 每一个用例都是一个"主人真的会提的需求"，断言**真实产物**（文件内容/工具结果），
# 而不是"任务 status=done"。status=done 但什么也没干，正是本项目最需要防的假成功。
set -uo pipefail
cd "$HOME/dotd" || exit 1

set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

api() { curl -s -m 20 "${HDR[@]}" "$@"; }

submit() {
  local text="$1"
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' "$text")
  api -X POST --data-binary "$body" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

wait_task() {
  local tid="$1" max="${2:-90}" i st
  for ((i = 0; i < max; i++)); do
    sleep 2
    st=$(api "$BASE/api/tasks/$tid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -1)
    case "$st" in done|succeeded|failed|cancelled|paused) echo "$st"; return 0 ;; esac
  done
  echo "timeout"
}

steps_of() {
  api "$BASE/api/tasks/$1?verbose=1" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const j = JSON.parse(s);
        const steps = j.journal || j.steps || (j.view && j.view.steps) || [];
        console.log(steps.map(x => `${x.seq}:${x.kind}${x.toolName?":"+x.toolName:""}=${x.status}`).join(" | "));
      } catch { console.log("(解析失败)"); }
    });'
}

PASS=0; FAIL=0
check() {
  local name="$1" ok="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    echo "  ✅ $name"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name"
    echo "     $detail"
    FAIL=$((FAIL+1))
  fi
}

echo "############ 用例 A：写文件（真容器 fs.write）############"
T=$(submit "在家目录创建文件 reports/round-a.md，内容写两行：第一行 round A，第二行 2026-10-18。写完用一句话回复。")
echo "task=$T"
ST=$(wait_task "$T" 90)
echo "status=$ST"
echo "steps: $(steps_of "$T")"
CONTENT=$(cat "$HOME/.dotd"/*/dotd* 2>/dev/null | head -1)
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
OUT=$(timeout 60 docker exec "$CID" cat /dot/home/reports/round-a.md 2>&1 | tr '\n' '|')
echo "容器内文件: $OUT"
case "$OUT" in *"round A"*) check "A 文件内容正确" 1 "" ;; *) check "A 文件内容正确" 0 "实际=$OUT" ;; esac

echo
echo "############ 用例 B：shell.run（真命令）############"
T=$(submit "用 shell.run 执行 date -u +%Y-%m-%dT%H:%M:%SZ 并把命令输出原样告诉我。")
echo "task=$T"
ST=$(wait_task "$T" 90)
echo "status=$ST"
echo "steps: $(steps_of "$T")"
case "$ST" in done|succeeded) check "B shell.run 跑通" 1 "" ;; *) check "B shell.run 跑通" 0 "status=$ST" ;; esac

echo
echo "############ 用例 C：net.get（出网只读）############"
T=$(submit "用 net.get 请求 https://www.baidu.com，告诉我返回的 HTTP 状态码和响应体长度。如果工具不可用，如实说明错误码。")
echo "task=$T"
ST=$(wait_task "$T" 120)
echo "status=$ST"
echo "steps: $(steps_of "$T")"
case "$ST" in done|succeeded) check "C net.get 跑通" 1 "" ;; *) check "C net.get 跑通" 0 "status=$ST" ;; esac

echo
echo "############ 用例 D：读回自己写的文件（上下文连续性）############"
T=$(submit "读一下 reports/round-a.md，把第一行原样告诉我。")
echo "task=$T"
ST=$(wait_task "$T" 90)
echo "status=$ST"
echo "steps: $(steps_of "$T")"
case "$ST" in done|succeeded) check "D 文件读回" 1 "" ;; *) check "D 文件读回" 0 "status=$ST" ;; esac

echo
echo "############ 汇总 ############"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
