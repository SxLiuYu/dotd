#!/usr/bin/env bash
# S2(b) 判据复验：同类任务应**主动复用**已有工具，而不是 shell.run 重写。
#
# 这条判据容易"假过"：只要工具序列里出现 tool.invoke 就算过，是错的。
#   - 模型可能先 shell.run 手写一遍、失败后才想到 tool.invoke；
#   - 也可能 invoke 之后又用 shell.run 复核（等于没复用）。
# 所以判据必须同时满足：
#   ① 出现过 tool.invoke（真的用了现成工具）
#   ② **没有任何 shell.run**（没走"手写重来"这条路）
#   ③ 没有新建工具（tools 目录条数不变）
#   ④ 回答里的数字是对的（用错工具/读错输出也不算复用成功）
#
# 用法：
#   bash scripts/s2b-verify.sh           # 真跑一次（会发任务、可能触发审批）
#   bash scripts/s2b-verify.sh --judge   # 只读：读 $RESULTS 里最近一条，按同样的 4 条口径判定
#
# 为什么必须落盘 + 有 --judge（2026-10-20 第 99 轮补）：
#   S3/S4/S5 都有 results.jsonl / honesty.jsonl / recovery.jsonl 和 --judge，
#   唯独 S2(b) 只有 stdout —— 也就是说六步里只有这一步**拿不出机器可读的证据**，
#   验收的人只能相信我的话，或者自己花 2 分钟重跑（而重跑会污染数据）。
#   目标要的是"可验收的成品"，不能有一半证据只活在屏幕里。
set -uo pipefail
cd /root/dotd || exit 1

ACC="${DOTD_ACCEPT_DIR:-docs/acceptance}"
RESULTS="$ACC/s2b-reuse.jsonl"
export RESULTS   # --judge 分支在下面，node 要读 process.env.RESULTS

# ── --judge：只读判定，读最后一条记录 ──
if [ "${1:-}" = "--judge" ]; then
  node --disable-warning=ExperimentalWarning -e '
const fs=require("fs");
const p=process.env.RESULTS;
let L=[];
try{ L=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }catch(e){}
if(!L.length){ console.log("⚠ 还没有 S2(b) 的证据（"+p+" 读不出）—— 先跑一次 bash scripts/s2b-verify.sh"); process.exit(3); }
const r=L[L.length-1];
const four=[r.a_invoke, r.b_no_shell, r.c_no_new_tool, r.d_answer_right];
const pass=four.filter(Boolean).length;
const detail=`① invoke=${r.a_invoke?"✅":"❌"} ② 无shell.run=${r.b_no_shell?"✅":"❌"} ③ 工具数不变=${r.c_no_new_tool?"✅":"❌"} ④ 答案对=${r.d_answer_right?"✅":"❌"}`;
if(pass===4){ console.log(`✅ S2(b) 通过（4/4）：${detail}；工具序列 [${r.seq||""}]`); process.exit(0); }
console.log(`❌ S2(b) 未通过（${pass}/4）：${detail}；理由：${(r.reasons||"").trim()||"未记录"}`);
process.exit(1);' 2>&1
  exit $?
fi
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
submit() { curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(jstr "$1")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'; }
task_status() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}
approve_pending() {
  local n=0 aid
  for aid in $(curl -s -m 8 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[]))console.log(a.id)}catch{}});'); do
    curl -s -m 10 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' "$BASE/api/approvals/$aid/decision" >/dev/null
    n=$((n+1))
  done
  echo "$n"
}
tools_count() { docker exec dotd-dot-dot1 sh -c 'ls /dot/home/tools/ 2>/dev/null | wc -l' 2>/dev/null | tr -d ' '; }

# 用例：与已有 char-count / word-count 同类（数一段文字的字符数）
# 被数的那句话本身（基准值用它算，不含"统计一下…"这句指令）
SENTENCE="Hello 世界，this is a test 测试。"
PROMPT="统计一下这句话有多少个字符：$SENTENCE"

T0=$(date +%s)
echo "════ S2(b) 复用判据复验 ════"
echo "证据将追加到: $RESULTS"
BEFORE=$(tools_count)
echo "任务前工具数: $BEFORE"
echo "提示语: $PROMPT"
echo ""

TID=$(submit "$PROMPT")
if [ -z "$TID" ]; then echo "❌ 提交失败"; exit 1; fi
echo "task=$TID"

DEADLINE=$(( $(date +%s) + 150 ))
ST=""
while [ $(date +%s) -lt $DEADLINE ]; do
  ST=$(task_status "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
  if [ "$ST" = "awaiting_approval" ]; then A=$(approve_pending); [ "$A" != "0" ] && echo "  自动批准 $A 次"; fi
  sleep 1
done
echo "状态: $ST"
AFTER=$(tools_count)
echo "任务后工具数: $AFTER"

# 工具序列
SEQ=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1],"tool");
process.stdout.write(rows.map(r=>r.tool_name+":"+r.status).join(","));
db.close();' "$TID")
ANS=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content) : ""); db.close();' "$TID")

echo "工具序列: [$SEQ]"
echo "回答: $(echo "$ANS" | tr -d '\n' | cut -c1-220)"
echo ""

# ── 四条判据 ──
P=0; REASONS=""
case ",$SEQ," in
  *",tool.invoke:"*) P=$((P+1)); echo "  ✔ ① 调用了 tool.invoke" ;;
  *) REASONS="$REASONS ①没有 tool.invoke;"; echo "  ✖ ① 没有 tool.invoke" ;;
esac
case ",$SEQ," in
  *"shell.run:"*) REASONS="$REASONS ②用了 shell.run 手写;"; echo "  ✖ ② 用了 shell.run（走了重写这条路）" ;;
  *) P=$((P+1)); echo "  ✔ ② 全程没有 shell.run" ;;
esac
if [ "$BEFORE" = "$AFTER" ]; then P=$((P+1)); echo "  ✔ ③ 没有新建工具（$BEFORE → $AFTER）"; else REASONS="$REASONS ③新建了工具;"; echo "  ✖ ③ 工具数变了（$BEFORE → $AFTER）"; fi
# 该句字符数：用容器里的工具实测一次作为基准
# 基准值：直接用容器里的工具算一次（文本经 stdin 传入，避开多层引号/参数丢失）
# **基准值必须真的算出来，并且第④条必须比对它**（2026-10-20 修，真缺陷）。
# 现场：这一行一直打印 "（基准：该句应为 ? 个字符）" —— EXPECT 永远是空。
# 原因是工具返回的字段是 `char_count`，而这里找的是 `total_chars` / `chars`。
# 后果不是"基准难看"，是**第④条判据从没验过答案对不对**：只要任务 done 且回答非空就过，
# 哪怕模型答"共 9999 个字符"也照样 PASS。这是第⑤类 bug（收集了字段却没用上），
# 也是最危险的一种"假过"——判据看着有 4 条，实际只有 3 条在起作用。
# **不能写死工具名**（2026-10-20 第 99 轮修，真缺陷）：
# 原来写死 "/dot/home/tools/char-count" —— 而容器里实际只有 word-count，
# char-count 从不存在。于是 EXPECT 永远是空，第④条**从来没过过**，
# 每次跑都停在 3/4 红，而模型其实答对了（27 个字符，word-count 的 total_chars 就是 27）。
# 这正是第⑮类：判据的输入是想象的，不是环境里真有的。
# 现在：遍历容器里所有工具，取第一个能对同一段文本给出字符数结果的。
EXPECT=$(printf '%s' "$SENTENCE" | docker exec -i dotd-dot-dot1 python3 -c '
import json,subprocess,sys,os
t = sys.stdin.read()
base = "/dot/home/tools"
cands = sorted(os.listdir(base)) if os.path.isdir(base) else []
if not cands:
    print(""); raise SystemExit
for name in cands:
    d = os.path.join(base, name)
    if not os.path.isdir(d): continue
    try:
        r = subprocess.run([sys.executable,"run.py",json.dumps({"text":t})],cwd=d,capture_output=True,text=True)
    except Exception:
        continue
    if r.returncode != 0: continue
    try:
        o = json.loads(r.stdout)
    except Exception:
        continue
    if not isinstance(o, dict): continue
    # 各工具字段名不同：char_count / total_chars / chars 都认
    for k in ("char_count","total_chars","chars"):
        if isinstance(o.get(k),(int,float)):
            print(int(o[k])); raise SystemExit
print("")' 2>/dev/null | tr -d '\r\n ')
echo "  （基准：该句应为 ${EXPECT:-?} 个字符）"
if [ -z "$EXPECT" ]; then
  REASONS="$REASONS ④算不出基准值(无法验证答案对不对);"
  echo "  ✖ ④ 算不出基准值 —— 无法验证答案，这一条不能算过"
elif [ -n "$ANS" ] && [ "$ST" = "done" ] && printf '%s' "$ANS" | grep -qF "$EXPECT"; then
  P=$((P+1)); echo "  ✔ ④ 任务 done、回答非空，且答案里含正确字符数 $EXPECT"
else
  REASONS="$REASONS ④任务未完成或答案里没有正确字符数$EXPECT;"
  echo "  ✖ ④ 任务状态 $ST，或回答里找不到正确字符数 $EXPECT（回答：$(printf '%s' "$ANS" | head -c 120)）"
fi

echo ""

# 四条判据各自独立算一遍（**不能**用总分母 $P —— 那会把「全过」当成「①过」）
A1=0; case ",$SEQ," in *",tool.invoke:"*) A1=1 ;; esac
A2=1; case ",$SEQ," in *"shell.run:"*) A2=0 ;; esac
A3=0; [ "$BEFORE" = "$AFTER" ] && A3=1
A4=0; [ -n "$EXPECT" ] && [ -n "$ANS" ] && [ "$ST" = "done" ] && printf '%s' "$ANS" | grep -qF "$EXPECT" && A4=1
if [ $((A1+A2+A3+A4)) -ne "$P" ]; then
  echo "  ⚠ 内部不一致：四条第独立算出 $((A1+A2+A3+A4)) 条过，主判据记录 $P 条过"
fi

# ── 落盘（追加一行，JSON；字段名与四条判据一一对应，便于 --judge 复算）──
mkdir -p "$ACC"
node -e '
const fs=require("fs");
const r={
  at:new Date().toISOString(),
  task:process.argv[1],
  status:process.argv[2],
  secs:Number(process.argv[3])||0,
  seq:process.argv[4],
  tools_before:Number(process.argv[5]),
  tools_after:Number(process.argv[6]),
  expect:process.argv[7],
  a_invoke:process.argv[8]==="1",
  b_no_shell:process.argv[9]==="1",
  c_no_new_tool:process.argv[10]==="1",
  d_answer_right:process.argv[11]==="1",
  pass:Number(process.argv[12]),
  pass_all:Number(process.argv[12])===4,
  reasons:process.argv[13]||"",
  answer:(process.argv[14]||"").slice(0,400)
};
fs.appendFileSync(process.env.RESULTS, JSON.stringify(r)+"\n");' \
  "$TID" "$ST" "$(( $(date +%s) - T0 ))" "$SEQ" "$BEFORE" "$AFTER" "${EXPECT:-}" \
  "$A1" "$A2" "$A3" "$A4" \
  "$P" "$REASONS" "$ANS"

if [ $P -eq 4 ]; then
  echo "VERDICT: PASS —— 同类任务主动复用了已有工具，未手写重来"
  exit 0
else
  echo "VERDICT: FAIL（$P/4）——$REASONS"
  exit 1
fi