#!/usr/bin/env bash
# S3 能力验收：20 条日常场景，成功率必须 ≥ 95%（≥19/20）。
#
# 设计原则（都是为了"验得准"）：
#  1. 每条场景都是**主人真会说的话**，不是"请调用 fs.read"这种指路式提示。
#  2. 判分只看**主人能看见的产出**（回答文本 / 容器里的文件 / crontabs 表），
#     不看模型自称做了什么 —— 否则模型说"我写好了"就能骗过判据。
#  3. 需要审批的场景自动批准（tool.* / 写操作），并在报告里标明批了几次。
#  4. 单条超时 180s，避免一条卡死带崩整轮。
#
# 用法：bash scripts/acceptance.sh            # 全跑
#       bash scripts/acceptance.sh calc file  # 只跑指定场景（调试用）
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")
# **OUTDIR 必须可覆盖**（2026-10-20 修，真缺陷）。
#
# 原来这里硬编码 `/root/dotd/docs/acceptance`，而下面紧接着就 `: > "$RESULTS"`
# 清空证据文件。于是想验证"判定逻辑判得对不对"**只能拿真证据去跑**，
# 跑一次证据就没了 —— 而验收脚本本身恰恰是最该被验证的东西：
# 它是 S3/S4/S5 的唯一证据来源，判错了没人会发现。
#
# 对照：soak.sh 早就支持 `SOAK=` 覆盖（第 22 行注释写得很清楚：
# "便于用合成数据验证 report 的判断逻辑是否真的判得对"）。
# 三个验收脚本漏了这件事，等于它们的判定逻辑**从来没被验证过**。
#
# 与 SOAK 同一套约定：设了就用，没设就用默认。往回兼容，不影响正常验收。
OUTDIR="${DOTD_ACCEPT_DIR:-/root/dotd/docs/acceptance}"
mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/results.jsonl"
export RESULTS
# **不要每次运行都清空历史**（2026-10-19 修）：原来是 `: > "$RESULTS"`，
# 于是"只跑 1 个场景"会把之前 20 个场景的证据全部抹掉 ——
# 实测就发生过：S3 记录 20/20，但 results.jsonl 只剩 1 行（最后那次单场景重跑）。
# 判据要求"20 条场景成功率 ≥95%"，证据必须留下来。
# 改为归档上一次的完整结果，再开新文件；`KEEP_HISTORY=1` 时可追加。
ARCHIVE="$OUTDIR/results.$(date +%Y%m%d-%H%M%S).jsonl"
if [ -s "$RESULTS" ]; then
  cp "$RESULTS" "$ARCHIVE"
  echo "已归档上一轮结果：$ARCHIVE"
fi

# **纯判定模式：只看已有证据，不跑任何场景、不清空任何文件**（2026-10-20 修，真缺陷）。
#
# 原来想验证"这份判定逻辑判得对不对"，只能拿真证据去跑 —— 而脚本第一件事就是
# `: > "$RESULTS"` 清空证据。于是验收脚本自己**从来没被验证过**：
# 它是 S3 的唯一证据来源，判错了没人会发现（回归里引用次数 = 0）。
#
# 对照 soak.sh：早就支持 `SOAK=` 覆盖 + `report` 只读不写，所以它的判定逻辑
# 被 120 个回归用例翻来覆去地验。三个验收脚本缺的就是这个"只读判定"入口。
#
# 用法：`acceptance.sh --judge`（读 $RESULTS，按同样的三态口径给结论）
# 这样回归就能喂合成证据，验它判得对不对。
if [ "${1:-}" = "--judge" ]; then
  node -e '
const fs=require("fs");
let lines=[];
try{
  lines=fs.readFileSync(process.env.RESULTS,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}catch(e){
  console.log("");
  console.log("判定：❌ **证据文件读不出来**："+process.env.RESULTS+" —— "+(e.code||e.message));
  console.log("　　　　（先确认路径对不对；`--judge` 只读不写，不会碰你的证据）");
  process.exit(1);
}
const total=lines.length, pass=lines.filter(r=>r.pass).length;
const rate=total? (pass/total*100):0;
for (const r of lines) console.log((r.pass?"✔":"✖"), String(r.id||"").padEnd(16), String((r.secs||0)+"s").padStart(5), r.name||"");
console.log("");
const EXPECT_TOTAL=20;
console.log(`合计 ${pass}/${total} 通过 = ${rate.toFixed(1)}%` + (total<EXPECT_TOTAL?`   本次只跑了 ${total}/${EXPECT_TOTAL} 条（覆盖面不够）`:""));
// **0 条不能说"未达标"**（2026-10-20 修）：
// 原来先判 `rate<95` 再判 `total<EXPECT_TOTAL`，于是 total=0 时 rate=0，
// 命中第一条 → 打印「❌ 未达标（还需 0 条）」。**"还需 0 条" + "未达标" 自相矛盾**，
// 而且把"没有证据"说成了"证据不行"。两者处置完全不同：前者去查有没有跑，
// 后者去查哪条挂了。必须先分流"一条都没有"。
if(total===0){
  console.log("判定：❌ **一条证据都没有**：文件里没有任何记录 —— 先确认场景有没有真的跑过");
  process.exit(1);
}
if(total<EXPECT_TOTAL && rate>=95){
  console.log(`判定：⏳ 已跑的 ${total} 条全过，但只覆盖 ${total}/${EXPECT_TOTAL} 条 —— 覆盖面不够，还不能算达标`);
  process.exit(3);
}
if(rate<95){
  console.log(`判定：❌ 未达标（还需 ${Math.ceil(total*0.95)-pass} 条），通过率 ${rate.toFixed(1)}% < 95%`);
  process.exit(1);
}
console.log("判定：✅ 达标");
process.exit(0);'
  # **必须立刻 exit**（2026-10-20 修，真缺陷）：
  # 没有这一句，`--judge` 打印完判定后会**继续往下跑真实场景** ——
  # 下一句就是 `: > "$RESULTS"`，把证据清空，然后真的去调模型、跑 20 条。
  # 症状极具迷惑性：判定文字完全正确（✅达标 / ⏳ / ❌），但退出码永远是最后
  # 那轮真实汇总留下的值。实测：k1（20条全过）打印"✅ 达标"却 exit=1，
  # 而 k1/results.jsonl 从 20 行变成 0 行 —— 证据被自己吃了。
  # 这是第⑩类（不改 process.exit 就不算数）的镜像：**改了退出码，但没让它成为脚本的退出码**。
  exit $?
fi

: > "$RESULTS"

ONLY=("$@")
want() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local s; for s in "${ONLY[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

jstr() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

submit() {
  curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(jstr "$1")}" "$BASE/api/messages" \
    | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p'
}

task_status() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$1"
}

approve_pending() {
  local n=0 aid
  for aid in $(curl -s -m 10 "${HDR[@]}" "$BASE/api/approvals?state=pending" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const a of (j.approvals||[]))console.log(a.id)}catch{}});'); do
    curl -s -m 20 "${HDR[@]}" -X POST --data-binary '{"verdict":"approve_once","actor":"owner"}' \
      "$BASE/api/approvals/$aid/decision" >/dev/null
    n=$((n+1))
  done
  echo "$n"
}

wait_done() {
  local tid="$1" deadline=$(( $(date +%s) + 180 )) st approvals=0
  while [ $(date +%s) -lt $deadline ]; do
    st=$(task_status "$tid")
    case "$st" in
      done|failed|cancelled|paused) break ;;
      awaiting_approval)
        local got; got=$(approve_pending); approvals=$((approvals+got)); sleep 1 ;;
    esac
    sleep 1
  done
  echo "$st|$approvals"
}

answer_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(r ? String(r.content) : ""); db.close();' "$1"
}

tools_of() {
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name FROM steps WHERE task_id=? AND kind=?").all(process.argv[1],"tool");
process.stdout.write(rows.map(r=>r.tool_name).join(",")); db.close();' "$1"
}

# 记录一条结果：id / 名称 / 通过? / 状态 / 耗时 / 工具序列 / 证据
record() {
  local id="$1" name="$2" pass="$3" status="$4" secs="$5" tools="$6" ev="$7" ans="$8"
  node -e '
const fs=require("fs");
const o={id:process.argv[1],name:process.argv[2],pass:process.argv[3]==="1",status:process.argv[4],
  secs:Number(process.argv[5]),tools:process.argv[6],evidence:process.argv[7],
  answer:String(process.argv[8]||"").replace(/\s+/g," ").slice(0,300)};
fs.appendFileSync(process.argv[9], JSON.stringify(o)+"\n");' \
    "$id" "$name" "$pass" "$status" "$secs" "$tools" "$ev" "$ans" "$RESULTS"
  local mark="✖"; [ "$pass" = "1" ] && mark="✔"
  echo "  $mark [$id] $name (${secs}s) tools=[$tools]"
  [ "$pass" = "1" ] || echo "      证据: $ev"
}

# run_case <id> <名称> <提示语> <判分命令>
# 判分命令收到 $TID / $ANS / $TOOLS，退出码 0=通过，非 0=失败（stdout 作为证据）
run_case() {
  local id="$1" name="$2" prompt="$3" check="$4"
  want "$id" || return 0
  echo "▶ [$id] $name"
  local t0=$(date +%s) tid st_ap st approvals ans tools rc ev
  tid=$(submit "$prompt")
  if [ -z "$tid" ]; then
    record "$id" "$name" 0 "submit_failed" 0 "" "提交任务失败（daemon 或 token 问题）" ""
    return 0
  fi
  st_ap=$(wait_done "$tid"); st="${st_ap%%|*}"; approvals="${st_ap##*|}"
  ans=$(answer_of "$tid"); tools=$(tools_of "$tid")
  local secs=$(( $(date +%s) - t0 ))
  set +e
  ev=$(TID="$tid" ANS="$ans" TOOLS="$tools" bash -c "$check" 2>&1); rc=$?
  set -e 2>/dev/null || true
  local pass=0
  # done + 判分通过 才算过；paused/failed 一律不过（要的是"真干活"）
  if [ "$st" = "done" ] && [ $rc -eq 0 ]; then pass=1; fi
  [ "$pass" = "1" ] || ev="status=$st approvals=$approvals rc=$rc; $ev"
  # 同 id 重跑时先删掉旧行，避免结果里出现两条同名记录
  node -e '
const fs=require("fs");const p=process.argv[1],id=process.argv[2];
try{const ls=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).filter(l=>{try{return JSON.parse(l).id!==id}catch{return false}});
fs.writeFileSync(p, ls.length? ls.join("\n")+"\n":"");}catch{}' "$RESULTS" "$id"
  record "$id" "$name" "$pass" "$st" "$secs" "$tools" "$ev" "$ans"
}

has() { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }
num_near() { node -e 'const a=Number(process.argv[1]),b=Number(process.argv[2]);process.exit(Math.abs(a-b)<=Number(process.argv[3])?0:1)' "$1" "$2" "$3"; }
# 判分命令在子 shell（bash -c）里跑，函数必须 export 才可见。
export -f has num_near 2>/dev/null || true
export ANS TOOLS TID 2>/dev/null || true

echo "════════ S3 能力验收（20 条日常场景）════════"

# ── A. 算数 / 推理（3 条）──────────────────────────────────────────────
run_case calc "算术：350减405" "帮我算一下 350 减 405 等于多少？只给数字。" '
  has "-55" "$ANS" || has "－55" "$ANS" || has "负55" "$ANS"
'
run_case calc2 "算术：打折后总价" "一件商品原价 1280 元，打 7.5 折，再减 100 元券。最后多少钱？只给数字。" '
  has "860" "$ANS"
'
run_case calc3 "多步推理：鸡兔同笼" "笼子里鸡和兔一共 35 个头、94 只脚。鸡和兔各几只？" '
  has "23" "$ANS" || has "兔子 12" "$ANS" || has "兔 12" "$ANS"
'

# ── B. 读写文件（4 条）─────────────────────────────────────────────────
run_case read_file "读文件：q3-sales.txt" "看一下 /dot/home/q3-sales.txt 这个文件，告诉我第三季度三个产品各多少万。" '
  has "120" "$ANS" && has "85" "$ANS" && has "200" "$ANS"
'
run_case list_dir "看目录：notes 里有什么" "看看 /dot/home/notes 目录下都有哪些文件，随便说几个文件名。" '
  has ".md" "$ANS"
'
# 每次跑前先清掉上一次的产物，否则模型会读到旧文件、说"已经是这样了"——
# 那样判据验的是"上次跑的结果"，不是"这次真写了"，会假过。
docker exec dotd-dot-dot1 sh -c 'rm -f /dot/home/reports/s3-write-test.txt' 2>/dev/null || true
run_case write_file "写文件：落到 /dot/home/reports" "帮我写一个文件 /dot/home/reports/s3-write-test.txt，内容就写三行：第一行 S3-ALPHA，第二行 S3-BETA，第三行 S3-GAMMA。写完告诉我。" '
  docker exec dotd-dot-dot1 sh -c "test -f /dot/home/reports/s3-write-test.txt && grep -q S3-ALPHA /dot/home/reports/s3-write-test.txt && grep -q S3-GAMMA /dot/home/reports/s3-write-test.txt" \
    && echo "文件与内容均已落盘"
'
# edit_file 依赖 write_file 的产物；单独跑本场景时必须自己造前置文件，
# 否则测的就不是"改文件"而是"改一个不存在的文件"。
# 前置文件**只写 3 行**（不含 S3-DELTA），这样"再加一行 S3-DELTA"才是真动作；
# 判据也就能区分"真追加了一次"和"模型看到已存在就跳过"。
docker exec dotd-dot-dot1 sh -c "mkdir -p /dot/home/reports && printf 'S3-ALPHA\nS3-BETA\nS3-GAMMA\n' > /dot/home/reports/s3-write-test.txt; grep -c S3-DELTA /dot/home/reports/s3-write-test.txt || true" 2>/dev/null || true
run_case edit_file "改文件：读后追加" "把 /dot/home/reports/s3-write-test.txt 最后再加一行 S3-DELTA。" '
  docker exec dotd-dot-dot1 sh -c "
    grep -q S3-ALPHA /dot/home/reports/s3-write-test.txt &&
    grep -q S3-DELTA /dot/home/reports/s3-write-test.txt &&
    test \$(grep -c S3-DELTA /dot/home/reports/s3-write-test.txt) -eq 1 &&
    test \$(wc -l < /dot/home/reports/s3-write-test.txt) -eq 4" && echo "4 行且 S3-DELTA 恰好一次（前 3 行没被弄丢）"
'

# ── C. 查资料（出网，2 条）──────────────────────────────────────────────
run_case net_get "查资料：GET 一个真实接口" "访问 https://api.github.com/zen ，把它返回的那句话原样告诉我。" '
  [ ${#ANS} -ge 8 ] && ! has "无法" "$ANS" && ! has "不能访问" "$ANS" && ! has "没有联网" "$ANS"
'
run_case search_note "查资料：从本地笔记找答案" "我的笔记里有一条记着 code-zebra-9 这件事，去 notes 里找出来，告诉我那条笔记讲了什么。" '
  has "zebra" "$ANS" || has "ZEBRA" "$ANS" || has "斑马" "$ANS"
'

# ── D. 定时提醒（2 条）─────────────────────────────────────────────────
# 判据要能区分"这次真新建了一条"和"库里本来就有旧的"：
# 记录跑之前的条数，跑完必须**变多**，且新增条目里要有 0 9 * * *。
# 前置清场：如果库里已经有一条 0 9 * * *，模型会（正确地）拒绝重复创建，
# 那样测的就不是"能不能定提醒"。先删掉，保证场景是"从无到有"。
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db");
db.prepare("DELETE FROM crontabs WHERE cron=?").run("0 9 * * *");
db.close();' 2>/dev/null || true
CRON_BEFORE=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
process.stdout.write(String(db.prepare("SELECT COUNT(*) c FROM crontabs").get().c)); db.close();')
export CRON_BEFORE
run_case sched_create "定提醒：每天早上9点" "帮我新定一个提醒（我原来没有这个）：每天早上 9 点提醒我看一眼当天日程。" '
  node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require(\"node:sqlite\");
const db = new DatabaseSync(process.env.HOME + \"/.dotd/dotd.db\", { readOnly: true });
const after = db.prepare(\"SELECT COUNT(*) c FROM crontabs\").get().c;
const hit = db.prepare(\"SELECT COUNT(*) c FROM crontabs WHERE enabled=1 AND cron=? \").get(\"0 9 * * *\").c;
db.close();
const before = Number(process.env.CRON_BEFORE);
if (!(after > before)) { console.error(\"没有新增提醒：before=\"+before+\" after=\"+after); process.exit(1); }
if (hit < 1) { console.error(\"没有 enabled 的 0 9 * * * 条目\"); process.exit(1); }
process.exit(0);" && echo "新增了一条 enabled 的 0 9 * * *（before=$CRON_BEFORE）"
'
run_case sched_list "定提醒：列出当前所有提醒" "现在都有哪些定时提醒？列一下。" '
  [ ${#ANS} -ge 4 ]
'

# ── E. 看图（2 条）─────────────────────────────────────────────────────
# 事实核对（2026-10-19 解码 PNG 逐像素确认）：tri.png 是 60x20，三列各 20px 的
# 纯红/纯绿/纯蓝竖条 —— **不是三角形**（文件名骗人）。判据必须对齐真实像素，
# 否则模型说"三角形"反而会被判过、说真话（"三条竖色块"）会被判错。
run_case vision_png "看图：media/tri.png（实为三色竖条）" "看一下 /dot/home/media/tri.png 这张图，里面画的是什么？颜色怎么分布？" '
  has "红" "$ANS" && has "绿" "$ANS" && has "蓝" "$ANS"
'
run_case vision_invoice "看 PDF：发票" "读一下 /dot/home/media/发票-2026-1019.pdf ，告诉我上面写了什么。" '
  # 只验"有回答"太弱：必须验出票面关键字段（已用 pdftotext 核对原文：
  # INVOICE NO 2026-1019 / Total Amount 76543 CNY / Vendor ACME）
  has "76543" "$ANS" && ( has "2026-1019" "$ANS" || has "ACME" "$ANS" )
'

# ── F. PDF / Excel（2 条）──────────────────────────────────────────────
run_case pdf_read "读 PDF：季度报告" "读一下 /dot/home/report.pdf ，里面营收增长了多少？" '
  has "1250000" "$ANS" || has "1,250,000" "$ANS" || has "18" "$ANS"
'
run_case excel_read "读 Excel：q3-sales.xlsx" "打开 /dot/home/q3-sales.xlsx ，告诉我华东和华南的收入分别是多少。" '
  has "125" "$ANS" && has "83" "$ANS"
'

# ── G. 造工具并复用（2 条，S2 能力的日常化回归）────────────────────────
# 先删掉上一次跑留下的 char-count，否则模型可能只说"已经有了"——验不到"真造"。
docker exec dotd-dot-dot1 sh -c 'rm -rf /dot/home/tools/char-count' 2>/dev/null || true
run_case tool_create "造工具：字符统计" "帮我做一个小工具，名字叫 char-count，功能是数一段文字有多少个字符（中文英文都算）。以后我会反复用。做完自己测一下。" '
  # 校验脚本写进临时文件再执行：多行 python 嵌在 sh -c 里引号会打架（踩过）。
  cat > /tmp/s3_check_char_count.py <<'PYEOF'
import json, subprocess, sys
base = '/dot/home/tools/char-count'
open_manifest = base + '/manifest.json'
try:
    m = json.load(open(open_manifest))
except Exception as e:
    print('manifest 读不了:', e); sys.exit(1)
if m.get('name') != 'char-count':
    print('manifest.name 不对:', m.get('name')); sys.exit(1)
r = subprocess.run([sys.executable, 'run.py', json.dumps({'text': 'abc中文'})],
                   cwd=base, capture_output=True, text=True)
if r.returncode != 0:
    print('run.py 失败:', r.stderr[:300]); sys.exit(1)
try:
    out = json.loads(r.stdout)
except Exception:
    print('输出不是 JSON:', r.stdout[:200]); sys.exit(1)
if out.get('chars') != 5:
    print('chars 应为 5（abc中文），实际', out.get('chars')); sys.exit(1)
print("char-count 落盘、manifest 正确、自测通过（'abc中文' → 5 字符）")
PYEOF
  docker cp /tmp/s3_check_char_count.py dotd-dot-dot1:/tmp/check.py >/dev/null 2>&1 &&
  docker exec dotd-dot-dot1 python3 /tmp/check.py
'
run_case tool_reuse "复用工具：数这行字" "用你已经有的那个数字符的工具，数一下这句话有多少个字符：今天天气不错。" '
  # 光"调了 tool.invoke"不够（可能调错工具/读错输出）；数字也必须对：
  # 「今天天气不错」+ 句号 = 7 个字符（已用容器内 run.py 实测）。
  case ",$TOOLS," in *,tool.invoke,*) ;; *) echo "没有调用 tool.invoke，tools=[$TOOLS]"; exit 1;; esac
  has "7" "$ANS"
'

# ── H. 综合（3 条）─────────────────────────────────────────────────────
run_case multi_step "综合：读文件+算总价" "读 /dot/home/q3-sales.txt ，把三个产品的销售额加起来，告诉我总和是多少万。" '
  has "405" "$ANS"
'
# MEMORY.md 里真实记的是"主人的关注点/接口人/工具入口"这类长期信息，
# 抽查两个实际存在的关键词，避免模型泛泛而谈也过关。
run_case summary "综合：总结笔记" "看 /dot/home/MEMORY.md ，用一句话概括里面记了哪些长期信息。" '
  has "记住" "$ANS" || has "标记" "$ANS" || has "暗号" "$ANS" || has "PHOENIX" "$ANS" || has "项目" "$ANS" || has "北京" "$ANS"
'
# 判据：必须点到它真实拥有的能力类目（文件/浏览器/命令/定时/出网 之一），
# 且不能出现"什么都能做"这种无边界吹牛。
run_case honesty_capability "边界：问它自己会什么" "你现在能做什么、不能做什么？简单说一下。" '
  ( has "文件" "$ANS" || has "命令" "$ANS" || has "浏览器" "$ANS" || has "定时" "$ANS" || has "网络" "$ANS" ) &&
  ! has "什么都能" "$ANS" && ! has "无所不能" "$ANS"
'

echo ""
echo "════════ 汇总 ════════"
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.env.RESULTS,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const total=lines.length, pass=lines.filter(r=>r.pass).length;
const rate=total? (pass/total*100):0;
for (const r of lines) console.log((r.pass?"✔":"✖"), r.id.padEnd(16), String(r.secs+"s").padStart(5), r.name);
console.log("");
// **"只跑 1 条且成功" 曾经会算出 100% 然后判达标**（2026-10-20 修，真缺陷）。
// 判据写的是"20 条里 ≥19 条通过"，分母被写成"实际跑了几条"，
// 于是 `acceptance.sh calc`（只跑算术一条）会打印 "1/1 = 100% ✅ 达标"。
// 这是第⑨类（标签会撒谎）：判据要求的是**覆盖面**，不是**通过率**。
// 修成三态，和 recovery.sh 同一个口径：
//   · 跑了 20 条且 ≥19 过 → ✅ 达标 exit 0
//   · 跑了 n<20 条且全过 → ⏳ 已跑的 n 条全过，但覆盖面不够，exit 3
//   · 通过率 <95% → ❌ 未达标 exit 1
const EXPECT_TOTAL=20;
console.log(`合计 ${pass}/${total} 通过 = ${rate.toFixed(1)}%` + (total<EXPECT_TOTAL?`   本次只跑了 ${total}/${EXPECT_TOTAL} 条（覆盖面不够）`:`   判据：≥95%（≥19/20）`));
if(rate<95){ console.log(`结论：❌ 未达标（还需 ${Math.ceil(total*0.95)-pass} 条）`); process.exit(1); }
if(total<EXPECT_TOTAL){ console.log(`结论：⏳ 已跑的 ${total} 条全过，但只覆盖 ${total}/${EXPECT_TOTAL} —— 这不等于通过`); process.exit(3); }
console.log("结论：✅ 达标");
process.exit(0);'