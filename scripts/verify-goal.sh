#!/usr/bin/env bash
# scripts/verify-goal.sh -- S1..S6 总验收入口 (2026-10-20 第 98 轮新增)
#
# 为什么需要它：目标原话是"交付可验收的成品"。
# 前面 97 轮把六步各自做出来了（npm test / acceptance.sh / honesty.sh /
# recovery.sh / soak.sh），但没有任何一条命令能一次回答"六步全过了吗"。
# 验收的人要么读 3400 行 goal-progress.md，要么自己拼 5 条命令 -- 这不是可验收。
#
# 设计原则（沿用 soak.sh 的教训）：
#  1. 只读：默认不跑任何会改数据的动作。acceptance/honesty 会真发任务，
#     recovery 会真 kill 容器 -- 这些只有显式加 --run 才会执行。
#  2. 三态：通过 / 不通过 / 还没到判的时候。
#     "还没到判的时候"绝不能算通过（不进 process.exit 就不算判据）。
#  3. 不掩盖：任一步不是通过，整体就不是通过，且退出码非 0。
#  4. 可独立复现：每一行都打印出"它跑了哪条命令"，验收的人能自己重跑。
#
# 用法：
#   bash scripts/verify-goal.sh          # 只读判定（用现有证据）
#   bash scripts/verify-goal.sh --run    # 先跑 S3/S4/S5 再判定（S6 永远只读）
#
# ⚠ **`--run` 会破坏正在进行的 S6 观测**（2026-10-20 第 103 轮补，真风险）。
#   它内含 recovery.sh，会真的 `docker stop` 容器、`kill -9` daemon。
#   如果此刻 S6 的 7 天窗口正在计时，那这些动作就是**人工制造的中断**：
#   窗口里会多出重启记录，而 soak.sh 会要求它们都能找到自愈证据才认"无人工干预"。
#   所以：**S6 窗口进行中只用默认（只读）模式**；`--run` 留到窗口开始之前，
#   或者明知道要重来一次窗口的时候再用。
#   bash scripts/verify-goal.sh --json   # 附带机器可读输出
#
# 退出码：0=六步全过  1=有步骤不通过  3=有步骤还没到判的时候  2=脚本自身出错

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

RUN=0; JSONOUT=0
for a in "$@"; do
  case "$a" in
    --run) RUN=1 ;;
    --json) JSONOUT=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "未知参数：$a（见 --help）" >&2; exit 2 ;;
  esac
done

ACC="${DOTD_ACCEPT_DIR:-docs/acceptance}"
export DOTD_ACCEPT_DIR="$ACC"

# ── `--run` 的护栏（第 103 轮补）──
# `--run` 里有 recovery.sh，会真的停容器、kill daemon。
# 如果正在做 7 天窗口观测，这就是人为制造的中断，而且事后很难解释。
# 所以：默认**拒绝**在「窗口已开始且未满 7 天」时跑 --run，
# 除非显式设置 DOTD_ALLOW_DISRUPT=1（表示"我知道，我要重来"）。
if [ "$RUN" -eq 1 ] && [ "${DOTD_ALLOW_DISRUPT:-0}" != "1" ]; then
  _d0f="$ACC/soak-day0.txt"
  if [ -f "$_d0f" ]; then
    _d0=$(cut -d' ' -f3 "$_d0f" 2>/dev/null)
    _now=$(date +%s)
    if [ -n "$_d0" ] && [ "$_now" -ge "$_d0" ] && [ $(( _now - _d0 )) -lt $(( 7*86400 )) ]; then
      _el=$(awk -v e=$(( _now - _d0 )) 'BEGIN{printf "%.2f", e/86400}')
      echo "❌ 拒绝执行 --run：S6 的 7 天窗口正在进行（已走 ${_el} 天 / 7 天）。" >&2
      echo "   --run 会跑 recovery.sh，真的停容器、kill daemon —— 那会成为窗口里的人为中断。" >&2
      echo "   · 只想看现在六步什么状态 → 去掉 --run（默认只读）：" >&2
      echo "       bash scripts/verify-goal.sh" >&2
      echo "   · 确定要重来一次 7 天窗口 → 显式确认：" >&2
      echo "       DOTD_ALLOW_DISRUPT=1 bash scripts/verify-goal.sh --run" >&2
      exit 2
    fi
  fi
fi

ROWS=()
OVERALL=0

# 记一行。$1=步骤 $2=PASS|FAIL|WAIT $3=摘要 $4=验法
row() {
  case "$2" in
    FAIL) [ "$OVERALL" -eq 0 ] && OVERALL=1 ;;
    WAIT) [ "$OVERALL" -eq 0 ] && OVERALL=3 ;;
  esac
  ROWS+=("$1|$2|$3|$4")
}

sym() {
  case "$1" in PASS) echo "✅" ;; FAIL) echo "❌" ;; *) echo "⏳" ;; esac
}

echo "════════ dotd 目标验收（S1 → S6）════════"
echo "证据目录：$ACC"
echo "时间：$(date '+%F %T %Z')"
if [ "$RUN" -eq 0 ]; then
  echo "模式：只读（不跑任何会改数据的动作；加 --run 才会真跑 S1/S3/S4/S5）"
else
  echo "模式：--run（S1/S3/S4/S5 会真跑；S6 永远只读）"
fi
echo ""

# ─── S1 修绿基线：npm test 0 失败 + git status 干净 ───
S1_ST=PASS; S1_MSG=""
if [ "$RUN" -eq 1 ]; then
  echo "▸ S1：跑 npm test …"
  if npm test >/tmp/verify-goal-npmtest.log 2>&1; then
    NT=$(grep -aE '^ℹ pass [0-9]+' /tmp/verify-goal-npmtest.log | tail -1 | grep -oE '[0-9]+' | head -1)
    NF=$(grep -aE '^ℹ fail [0-9]+' /tmp/verify-goal-npmtest.log | tail -1 | grep -oE '[0-9]+' | head -1)
    S1_MSG="npm test ${NT:-?} 通过 / ${NF:-?} 失败"
    [ "${NF:-1}" -ne 0 ] && S1_ST=FAIL
  else
    S1_ST=FAIL; S1_MSG="npm test 退出码非 0（见 /tmp/verify-goal-npmtest.log）"
  fi
else
  S1_ST=WAIT; S1_MSG="未加 --run，没真跑 npm test"
fi
if git rev-parse --git-dir >/dev/null 2>&1; then
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l)
  if [ "${DIRTY:-0}" -ne 0 ]; then
    S1_ST=FAIL; S1_MSG="$S1_MSG；git status 有 $DIRTY 个未提交改动"
  else
    S1_MSG="$S1_MSG；git status 干净"
  fi
else
  # WSL 侧 /root/dotd 不是 git 仓库（源码权威在 Windows 的 D:\\toagi\\dotd）。
  # 这时**不能**当作「干净」放过去 —— 第⑰类：没测到不能编码成合法值。
  # 保持 ⏳ 并明说去哪验，而不是假装检查过。
  S1_ST=WAIT
  S1_MSG="$S1_MSG；**本目录不是 git 仓库**，git 半边没验 —— 请在 D:\\toagi\\dotd 侧跑 `git status --porcelain`"
fi
row "S1 修绿基线" "$S1_ST" "$S1_MSG" "npm test + git status"

# ─── S2 自己造工具：(a)(b)(c) ───
# (a) 造工具：tool.create 真造过
# (b) 复用：**不靠数 tool.invoke 的次数**，而是读 s2b-verify.sh 的落盘证据
#     （2026-10-20 第 99 轮修：原来只数 steps 表里 tool.invoke 有多少行，
#      那只能证明"调用过"，证明不了"同类任务主动选了它、且没手写重来、且答案对"。
#      目标是三选一里最严的那条，就必须用最严的证据。）
# (c) 三工具六环：白名单条数
S2_OUT=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const home = process.env.HOME || "/root";
let db;
try { db = new DatabaseSync(home + "/.dotd/dotd.db", { readOnly: true }); }
catch (e) { console.log("ERR|0|0|0"); process.exit(0); }
const one = (s, ...a) => { try { return db.prepare(s).get(...a); } catch (e) { return null; } };
const created = (one("SELECT COUNT(*) c FROM steps WHERE tool_name=?", "tool.create") || {}).c || 0;
const invAll  = (one("SELECT COUNT(*) c FROM steps WHERE tool_name=?", "tool.invoke") || {}).c || 0;
let wl = 0;
try {
  const y = require("fs").readFileSync("config/tools.yml", "utf8");
  wl = (y.match(/^\s*-\s*name:\s*\S+/gm) || []).length;
} catch (e) {}
console.log([created, invAll, wl].join("|"));
db.close();' 2>/dev/null)

IFS='|' read -r S2_CREATED S2_INVALL S2_WL <<< "${S2_OUT:-ERR|0|0}"
if [ "${S2_CREATED:-ERR}" = "ERR" ] || [ -z "${S2_CREATED:-}" ]; then
  row "S2 自己造工具" FAIL "读不到 steps 表（库路径或权限问题）" "sqlite + s2b-verify.sh --judge"
else
  S2_ST=PASS; S2_D=""
  if [ "$S2_CREATED" -gt 0 ]; then S2_D="(a) tool.create $S2_CREATED 次 ✅"
  else S2_D="(a) tool.create 0 次 ❌"; S2_ST=FAIL; fi

  # (b) 用 s2b-verify.sh --judge 的结论，不看有多少次调用
  bash scripts/s2b-verify.sh --judge >/tmp/verify-goal-s2b.log 2>&1; S2B_RC=$?
  case "$S2B_RC" in
    0) S2_D="$S2_D；(b) 复用实测 4/4 ✅" ;;
    3) S2_D="$S2_D；(b) 还没有 S2(b) 证据 ⏳"; [ "$S2_ST" = "PASS" ] && S2_ST=WAIT ;;
    *) S2_D="$S2_D；(b) 复用未达标 ❌"; S2_ST=FAIL ;;
  esac

  if [ "${S2_WL:-0}" -ge 3 ]; then S2_D="$S2_D；(c) 白名单 $S2_WL 个 ✅"
  else S2_D="$S2_D；(c) 白名单仅 $S2_WL 个 ❌"; S2_ST=FAIL; fi
  row "S2 自己造工具" "$S2_ST" "$S2_D" "sqlite steps + s2b-verify.sh --judge + config/tools.yml"
fi

# ─── S3 能力验收：20 条 ≥19 ───
if [ "$RUN" -eq 1 ]; then
  echo "▸ S2(b)：真跑一次复用判据（会发任务）…"
  DOTD_ACCEPT_DIR="$ACC" bash scripts/s2b-verify.sh >/tmp/verify-goal-s2b-run.log 2>&1 || true
  echo "▸ S3：跑 20 条日常场景（约 5-10 分钟）…"
  DOTD_ACCEPT_DIR="$ACC" bash scripts/acceptance.sh >/tmp/verify-goal-s3.log 2>&1 || true
fi
DOTD_ACCEPT_DIR="$ACC" bash scripts/acceptance.sh --judge >/dev/null 2>&1; S3_RC=$?
S3_SUM=$(node --disable-warning=ExperimentalWarning -e '
const fs=require("fs");
const p=process.env.DOTD_ACCEPT_DIR+"/results.jsonl";
try{
  const L=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const ok=L.filter(r=>r.pass).length;
  console.log(ok+"/"+L.length+(L.length?" = "+(ok/L.length*100).toFixed(1)+"%":""));
}catch(e){ console.log("无证据（"+p+" 读不出）"); }' 2>/dev/null)
case "$S3_RC" in
  0) row "S3 能力验收" PASS "$S3_SUM（判据 ≥19/20）" "acceptance.sh --judge" ;;
  3) row "S3 能力验收" WAIT "$S3_SUM：覆盖不足 20 条，还不能算达标" "acceptance.sh --judge" ;;
  *) row "S3 能力验收" FAIL "$S3_SUM：未达 95%" "acceptance.sh --judge" ;;
esac

# ─── S4 说实话验收：10/10，0 编造 ───
if [ "$RUN" -eq 1 ]; then
  echo "▸ S4：跑 10 条做不到的任务…"
  DOTD_ACCEPT_DIR="$ACC" bash scripts/honesty.sh >/tmp/verify-goal-s4.log 2>&1 || true
fi
DOTD_ACCEPT_DIR="$ACC" bash scripts/honesty.sh --judge >/dev/null 2>&1; S4_RC=$?
S4_SUM=$(node --disable-warning=ExperimentalWarning -e '
const fs=require("fs");
const p=process.env.DOTD_ACCEPT_DIR+"/honesty.jsonl";
try{
  const L=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const ok=L.filter(r=>r.pass).length;
  console.log(ok+"/"+L.length+" 正确承认");
}catch(e){ console.log("无证据（"+p+" 读不出）"); }' 2>/dev/null)
case "$S4_RC" in
  0) row "S4 说实话验收" PASS "$S4_SUM（判据 10/10、0 编造）" "honesty.sh --judge" ;;
  3) row "S4 说实话验收" WAIT "$S4_SUM：不够 10 条" "honesty.sh --judge" ;;
  *) row "S4 说实话验收" FAIL "$S4_SUM：有编造或不足" "honesty.sh --judge" ;;
esac

# ─── S5 故障自恢复：3/3，<5 分钟 ───
if [ "$RUN" -eq 1 ] && [ "${DOTD_ALLOW_DISRUPT:-0}" = "1" ]; then
  # **第二道护栏**（第 103 轮补，因为我自己踩了）。这里才是真的会 kill 东西的地方。
  # 外层护栏拦的是"窗口进行中 + --run"，但只要 DOTD_ALLOW_DISRUPT=1 就放行了 ——
  # 而第 103 轮我为了让"放行逻辑能验到"，真的写了 DOTD_ALLOW_DISRUPT=1，
  # 于是 recovery.sh 当场开始杀容器。
  # 教训：**危险动作的确认粒度不能等于"我想验证它没写错"**。
  # 看放行与否，用 `DOTD_DRYRUN_S5=1` —— 它只打印、不执行。
  if [ "${DOTD_DRYRUN_S5:-0}" = "1" ]; then
    echo "  ⏭ S5 试运行（DOTD_DRYRUN_S5=1）：本来会跑 recovery.sh，现在只打印" >&2
  else
  echo "▸ S5：注入 3 种故障（会真的 stop 容器 / 断网关 / kill daemon）…"
  DOTD_ACCEPT_DIR="$ACC" bash scripts/recovery.sh >/tmp/verify-goal-s5.log 2>&1 || true
  fi
fi
DOTD_ACCEPT_DIR="$ACC" bash scripts/recovery.sh --judge >/dev/null 2>&1; S5_RC=$?
S5_SUM=$(node --disable-warning=ExperimentalWarning -e '
const fs=require("fs");
const p=process.env.DOTD_ACCEPT_DIR+"/recovery.jsonl";
try{
  const L=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const ok=L.filter(r=>r.pass).length;
  const slow=L.filter(r=>r.pass && Number(r.secs)>300).length;
  console.log(ok+"/"+L.length+" 恢复成功"+(slow?("，"+slow+" 次超过 5 分钟"):"，全部 <5 分钟"));
}catch(e){ console.log("无证据（"+p+" 读不出）"); }' 2>/dev/null)
case "$S5_RC" in
  0) row "S5 故障自恢复" PASS "$S5_SUM" "recovery.sh --judge" ;;
  3) row "S5 故障自恢复" WAIT "$S5_SUM：不够 3 种" "recovery.sh --judge" ;;
  *) row "S5 故障自恢复" FAIL "$S5_SUM" "recovery.sh --judge" ;;
esac

# ─── S6 长期运行（永远只读）───
bash scripts/soak.sh report >/tmp/verify-goal-s6.log 2>&1; S6_RC=$?
S6_SUM=$(grep -aoE '❌ 未满 7 天（还差 [0-9.]+ 天）' /tmp/verify-goal-s6.log | head -1)
if [ -z "$S6_SUM" ]; then
  S6_SUM=$(grep -aoE '✅ 已满 7 天[^；]*' /tmp/verify-goal-s6.log | head -1)
fi
if [ -z "$S6_SUM" ]; then S6_SUM="详见 /tmp/verify-goal-s6.log"; fi
S6_RED=$(grep -ac '❌' /tmp/verify-goal-s6.log 2>/dev/null || echo 0)
S6_WARN=$(grep -ac '⚠' /tmp/verify-goal-s6.log 2>/dev/null || echo 0)
case "$S6_RC" in
  0) row "S6 长期运行" PASS "7 天窗口通过（另有 ⚠ $S6_WARN 条提示）" "soak.sh report" ;;
  3) row "S6 长期运行" WAIT "$S6_SUM" "soak.sh report" ;;
  *) row "S6 长期运行" FAIL "$S6_SUM（$S6_RED 条 ❌，详见 /tmp/verify-goal-s6.log）" "soak.sh report" ;;
esac

# ─── 汇总 ───
echo ""
echo "────────────────────────────────────────────────────────────────"
printf "%-18s %-2s %s\n" "步骤" "" "结论"
echo "────────────────────────────────────────────────────────────────"
NP=0; NF2=0; NW=0
for r in "${ROWS[@]}"; do
  IFS='|' read -r name st msg how <<< "$r"
  printf "%-18s %-2s %s\n" "$name" "$(sym "$st")" "$msg"
  printf "%-18s %-2s   ↳ 验法：%s\n" "" "" "$how"
  case "$st" in PASS) NP=$((NP+1)) ;; FAIL) NF2=$((NF2+1)) ;; *) NW=$((NW+1)) ;; esac
done
echo "────────────────────────────────────────────────────────────────"
echo "合计：✅ $NP   ❌ $NF2   ⏳ $NW   （共 ${#ROWS[@]} 步）"
if [ "$OVERALL" -eq 0 ]; then
  echo ""
  echo "✅ 六步全部通过 = 目标达成：$NP/6"
elif [ "$OVERALL" -eq 1 ]; then
  echo ""
  echo "❌ 有 $NF2 步不通过，目标未达成。"
else
  echo ""
  echo "⏳ 还没到判的时候：$NW 步在等（不是失败，是证据还没长齐）。已过 $NP 步。"
  if [ "$NW" -gt 0 ] && [ "$NP" -gt 0 ]; then
    echo "   **⏳ 不算通过** —— 别把「证据还没长齐」读成「差不多了 / 都好了」。"
  fi
fi

if [ "$JSONOUT" -eq 1 ]; then
  echo ""
  echo "--- JSON ---"
  node -e '
const rows=process.argv[1].split("\n").filter(Boolean).map(l=>{
  const i=l.indexOf("|"), j=l.indexOf("|",i+1), k=l.indexOf("|",j+1);
  return {step:l.slice(0,i), state:l.slice(i+1,j), msg:l.slice(j+1,k), how:l.slice(k+1)};
});
console.log(JSON.stringify({at:new Date().toISOString(), dir:process.argv[3], overall:Number(process.argv[2]), rows},null,2));' \
    "$(printf '%s\n' "${ROWS[@]}")" "$OVERALL" "$ACC" 2>/dev/null
fi

case "$OVERALL" in
  0) exit 0 ;;
  3) exit 3 ;;
  *) exit 1 ;;
esac
