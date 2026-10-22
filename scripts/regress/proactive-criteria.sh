#!/usr/bin/env bash
# scripts/regress/proactive-criteria.sh —— 主动打扰（cron + 事件）的硬判据
#
# 用法：bash scripts/regress/proactive-criteria.sh
#   exit 0 = 全过    exit 1 = 有失败    exit 2 = 脚本崩了
#
# 这个脚本要回答的问题是"**该不该现在发**"，不是"能不能发"。
# 两条路径共用同一套三道闸，所以判据也分两组：
#   T4（2026-10-20）：cron / crontabs 一行
#   F7（2026-10-22）：事件 / event_push_policy(source, actor) 一行
#
# ⚠️ 排版约定（本轮吃过两次亏，别再犯）
#   ① **不准把通过条数钉死**。曾经有一条 t "...30 条全过" 比对的是一整串
#      "合计 30 通过 / 0 失败"，于是任何人给单测加一条断言都会红 —— 红的不是
#      "闸门坏了"而是"数字没跟上"。只守 0 失败。
#   ② **不准把迁移版本号写死**。曾经钉了 'expectedVersion: 170'，别人加一个
#      180 包就整片红（实测：本轮加 180_image_base_tag 后本脚本自己掉了 3 条）。
#      版本号一律从 src/daemon.ts 或 db/migrations/ 目录推出来。
#      唯一该写死的是"本模块自己的那个包存在"（170/185），那是接线点不是配置值。

set -uo pipefail
REPO="${DOTD_REPO:-/root/dotd}"
cd "$REPO" || { echo "  找不到 $REPO"; exit 2; }

P=0
F=0
t() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m %s\n' "$name"
    P=$((P+1))
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$name"
    F=$((F+1))
  fi
}

# 迁移终态版本号：从装配层读，不写死（写死 = 别人加包我就红）
DAEMON_VER=$(sed -n 's/.*expectedVersion:[[:space:]]*\([0-9]\+\).*/\1/p' src/daemon.ts | head -1)
DIR_VER=$(ls db/migrations/*.sql 2>/dev/null | sed 's#.*/##; s#^0*\([0-9]\+\)_.*#\1#' | sort -n | tail -1)
echo ""
echo "════ 主动打扰验收（cron + 事件）════"
echo ""
t "daemon 的 expectedVersion 跟得上迁移目录" test -n "$DAEMON_VER" -a "$DAEMON_VER" = "$DIR_VER"
# 这条红起来通常**不是本模块的缺陷**，而是"有人加了迁移包、装配层还没跟"：
# 加包的人报 NNN，改 daemon 的人对齐。这里把它显式打在输出上，免得被当成误报忽略。
if [ "$DAEMON_VER" != "$DIR_VER" ]; then
  printf '  \033[33mNOTE\033[0m src/daemon.ts 应改为 expectedVersion: %s（当前 %s）\n' "$DIR_VER" "$DAEMON_VER"
fi

# ── A. 文件与单元判据 ────────────────────────────────────────
t "闸门模块存在"                      test -f src/surfaces/proactive.ts
t "闸门测试存在"                      test -f tests/proactive.test.ts
t "事件闸门单测存在"            test -f tests/proactive-event.test.ts
t "事件闸门接线测试存在"        test -f tests/event-proactive-wiring.test.ts
t "cron 迁移包存在"             test -f db/migrations/170_proactive.sql
t "事件迁移包存在"              test -f db/migrations/185_event_proactive.sql

# 只守 0 失败，不钉条数（见上①）
GATE=$(node --import tsx tests/proactive.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "cron 闸门单测 0 失败"              test -n "$GATE" -a "${GATE##* / }" = "0 失败"
EGATE=$(node --import tsx tests/proactive-event.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "事件闸门单测 0 失败"              test -n "$EGATE" -a "${EGATE##* / }" = "0 失败"
# 复合判据（管道/多条命令）必须走 bash -c：
#   t "名" grep -A12 X f | grep -q Y   ← 错：只把第一个 grep 的退出码算一条判据，
#   第二个 grep 的结果被丢掉，于是"接线点"根本没被检查（2026-10-22 实测）。
tc() {
  local name="$1"; local script="$2"
  if bash -c "$script" >/dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m %s\n' "$name"; P=$((P+1))
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$name"; F=$((F+1))
  fi
}

# ── B. 三道闸的口径（cron 路径）────────────────────────────────
t "安静时段支持跨午夜"                grep -q 'cur >= startMin || cur < endMin' src/surfaces/proactive.ts
t "开关优先级最高"                    grep -q "reason: 'disabled'" src/surfaces/proactive.ts
t "节流从库读不从内存读"              grep -q 'lastPushAt' src/control-plane/index.ts
t "节流落库（UPDATE crontabs）"       grep -q 'UPDATE crontabs SET last_push_at' src/control-plane/index.ts
t "格式错按不静音（不误伤）"          grep -q 'if (range === null) return false' src/surfaces/proactive.ts
t "迁移加 3 个字段"                   grep -q 'ADD COLUMN proactive' db/migrations/170_proactive.sql
t "CrontabRow 类型有 proactive"       grep -q 'proactive: number' src/control-plane/types.ts
t "CrontabRow 类型有 last_push_at"    grep -q 'last_push_at: number | null' src/control-plane/types.ts
t "fireHeartbeat 接入了闸门"          grep -q 'shouldPush({' src/control-plane/index.ts
t "判定结论传给下游"                  grep -q 'proactive: decision.allowed' src/control-plane/index.ts
t "proactive=0 不阻止任务执行"        grep -q '任务\*\*照常执行\*\*' src/control-plane/types.ts
# ── C. F7 事件驱动主动打扰：判据必须钉住**接线点** ───────────────
# 本轮被"函数写对了但没人调用"坑过两次（resolveExecution / clipForFeishu）。
# 所以这几条不是"模块里有这个函数"，而是"闸门挂在非 cron 机器事件的唯一漏斗上"。
t "闸门纯函数导出"                    grep -q 'export function decideEventPush' src/surfaces/proactive.ts
t "策略读取函数导出"                  grep -q 'export function readEventPushPolicy' src/surfaces/proactive.ts
t "记账函数导出"                      grep -q 'export function recordEventFire' src/surfaces/proactive.ts
t "control-plane 确实 import 了闸门"  grep -q 'decideEventPush,' src/control-plane/index.ts
t "闸门用 (source, actor) 读策略"     grep -q 'readEventPushPolicy(db, e.source, e.actor)' src/control-plane/index.ts
t "判定结论写进 payload.proactive"    grep -q 'proactive: gate.announce' src/control-plane/index.ts
t "放行时 last_push_at 落库"          grep -q 'SET last_push_at = ?' src/surfaces/proactive.ts
t "被拦时不推进 last_push_at"         grep -q 'SET last_fire_at = ?' src/surfaces/proactive.ts
t "安静时段拦在进管线之前"            grep -q 'ingest: false' src/surfaces/proactive.ts
t "安静时段留 skipped_quiet 证据"     grep -q "'skipped_quiet'" src/surfaces/proactive.ts
t "开关/节流不拦进管线"               grep -q 'ingest: true' src/surfaces/proactive.ts
t "cron 心跳不经事件闸门（不判两遍）" grep -q 'matcher.ingestEvent({' src/control-plane/index.ts
t "没配策略时闸门不介入"              grep -q 'intervenes: false' src/surfaces/proactive.ts
t "不推送≠不执行写进事件侧测试"      grep -q '不推送 ≠ 不执行' tests/event-proactive-wiring.test.ts
t "重启不归零写进事件侧测试"         grep -q '重启' tests/event-proactive-wiring.test.ts
# 接线点必须落在门面函数体内（不是文件里随便一处）
tc "闸门调用点在 ingestEvent 门面体内" \
  "awk '/ingestEvent\\(e: IngestEventReq\\): IngestEventResult \\{/,/^    \\},/' src/control-plane/index.ts | grep -q 'decideEventPush({'"
tc "门面体内先 matcher 再记账（dup 不吃额度）" \
  "awk '/ingestEvent\\(e: IngestEventReq\\): IngestEventResult \\{/,/^    \\},/' src/control-plane/index.ts | grep -q 'if (gate.intervenes && !res.dup)'"
# ── D. 迁移真的跑通（版本号一律推导，见开头②）──────────────────
MIG_VER="$DIR_VER"
cat > .t4-mig.ts <<NODE
import { openDb } from './db/conn.ts';
import { migrate } from './db/migrate.ts';
const db = openDb('/tmp/t4-criteria.db');
const r = migrate(db, { expectedVersion: $MIG_VER });
const cols = db.prepare('PRAGMA table_info(crontabs)').all().map((c: any) => c.name);
const ver = (db.prepare('PRAGMA user_version').get() as any).user_version;
const okCols = cols.includes('proactive') && cols.includes('throttle_hours') && cols.includes('last_push_at');
console.log(r.to === $MIG_VER && ver === $MIG_VER && okCols ? 'OK' : 'BAD');
db.close();
NODE
MIG=$(rm -f /tmp/t4-criteria.db*; node --import tsx .t4-mig.ts 2>&1 | tail -1)
rm -f .t4-mig.ts
t "迁移从 0 跑到 $MIG_VER 且 crontabs 三字段齐" test "$MIG" = "OK"

# 185 包能被应用：事件策略表真的建出来、列齐、默认值 = 不打扰
cat > .t4-mig185.ts <<NODE
import { openDb } from './db/conn.ts';
import { migrate } from './db/migrate.ts';
const db = openDb('/tmp/t4-185.db');
migrate(db, { expectedVersion: $MIG_VER });
const cols = db.prepare('PRAGMA table_info(event_push_policy)').all().map((c: any) => c.name);
const need = ['source','actor','enabled','quiet_hours','throttle_hours','last_push_at','last_fire_status'];
console.log(need.every((c) => cols.includes(c)) ? 'OK' : 'BAD ' + cols.join(','));
db.close();
NODE
M185=$(rm -f /tmp/t4-185.db*; node --import tsx .t4-mig185.ts 2>&1 | tail -1)
rm -f .t4-mig185.ts
t "185 包能应用且 event_push_policy 列齐"  test "$M185" = "OK"

# 默认值必须是"不打扰"（cron + 事件两条路径同一个升级原则）
cat > .t4-def.ts <<NODE
import { openDb } from './db/conn.ts';
import { migrate } from './db/migrate.ts';
const db = openDb('/tmp/t4-def.db');
migrate(db, { expectedVersion: $MIG_VER });
db.prepare("INSERT INTO crontabs(id,dot_id,title,prompt,cron,next_fire) VALUES('ct_x','dot1','t','p','* * * * *',1)").run();
const ct = db.prepare('SELECT proactive, throttle_hours, last_push_at FROM crontabs WHERE id=?').get('ct_x') as any;
const okCron = ct.proactive === 0 && ct.throttle_hours === 6 && ct.last_push_at === null;
// 只给 source/actor/updated_at，其余走列默认
db.prepare('INSERT INTO event_push_policy(source,actor,updated_at) VALUES(?,?,1)').run('http','sub_x');
const ep = db.prepare('SELECT enabled, quiet_hours, throttle_hours, last_push_at, last_fire_status FROM event_push_policy').get() as any;
const okEv = ep.enabled === 0 && ep.quiet_hours === null && ep.throttle_hours === 6 && ep.last_push_at === null && ep.last_fire_status === null;
console.log(okCron && okEv ? 'OK' : 'BAD ' + JSON.stringify({ ct, ep }));
db.close();
NODE
DEF=$(rm -f /tmp/t4-def.db*; node --import tsx .t4-def.ts 2>&1 | tail -1)
rm -f .t4-def.ts
t "默认关（cron 与事件都是）：升级后不突然发消息" test "$DEF" = "OK"

# 185 的排版必须照 170（注释块后接 SELECT 1;，否则模板库可能建不出来）
t "185 包用 170 的排版（注释后先接无害语句）" \
  bash -c "grep -q '^SELECT 1;$' db/migrations/185_event_proactive.sql"

# 接线测试真的跑过（0 失败）
WIR=$(node --import tsx --test tests/event-proactive-wiring.test.ts 2>&1 | grep -oE 'pass [0-9]+' | tail -1)
WFAIL=$(node --import tsx --test tests/event-proactive-wiring.test.ts 2>&1 | grep -oE 'fail [0-9]+' | tail -1)
t "事件闸门接线测试 0 失败"            test -n "$WIR" -a "${WFAIL##* }" = "0"
# ── E. 类型检查（只看本模块的文件）─────────────────────────────
# 不数全仓错误总数：本轮 daemon.ts / feishu-approval.ts 由别的模块在改，
# 把它们的中间态算成我的红，等于用别人的进度卡我的门（同开头①②的教训）。
TSC=$(npx tsc --noEmit 2>&1 | grep -E 'surfaces/proactive\.ts|control-plane/index\.ts|tests/proactive-event\.test\.ts|tests/event-proactive-wiring\.test\.ts' | grep -c 'error TS')
t "本模块文件 tsc 无错误"              test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1