#!/usr/bin/env bash
# scripts/regress/calendar-criteria.sh —— T6 日历只读硬判据
#
# T6 要回答：能不能读 .ics、列出未来 7 天、发现冲突，而且**绝不写**。

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

echo ""
echo "════ T6 日历只读验收 ════"
echo ""

# ── A. 文件与单元判据 ────────────────────────────────────────
t "ICS 解析器存在"                    test -f src/calendar/ics.ts
t "日历服务存在"                      test -f src/calendar/CalendarService.ts
t "测试存在"                          test -f tests/calendar-ics.test.ts

CAL=$(node --import tsx tests/calendar-ics.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "单元判据 56 条全过"                test "$CAL" = "合计 56 通过 / 0 失败"

# ── B. RFC 5545 的四个陷阱 ───────────────────────────────────
t "折行被处理"                        grep -q 'export function unfoldLines' src/calendar/ics.ts
t "转义被处理（状态机）"              grep -q 'export function unescapeText' src/calendar/ics.ts
t "DATE vs DATE-TIME 分开处理"        grep -q "allDay: true" src/calendar/ics.ts
t "认不出的时间不猜"                  grep -q '时刻未知' src/calendar/ics.ts
t "重复规则明确说明不支持"            grep -q '重复规则' src/calendar/ics.ts

# ── C. 只读是硬边界 ─────────────────────────────────────────
# 这是 T6 最重要的判据：日历模块里**不能有任何写入方法**
WRITE_API=$(grep -cE 'export (async )?function (create|update|delete|put|remove|write|add)Event' src/calendar/*.ts 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
t "日历模块没有写入 API"              test "$WRITE_API" = "0"
# 也不该 import 任何写文件的函数
t "ICS 解析器不写文件"                bash -c '! grep -qE "writeFileSync|appendFileSync" src/calendar/ics.ts'
# 服务只读文件（readFileSync 可以有，write 不行）
t "日历服务不写文件"                  bash -c '! grep -qE "writeFileSync|appendFileSync" src/calendar/CalendarService.ts'
# 工具清单里两个都是 read 档
t "calendar.list 是 read 档"          bash -c 'grep -A1 "name: calendar.list" config/tools.yml | grep -q "tier: read"'
t "calendar.conflicts 是 read 档"     bash -c 'grep -A1 "name: calendar.conflicts" config/tools.yml | grep -q "tier: read"'

# ── D. 装配 ──────────────────────────────────────────────────
t "daemon 注册了 calendar.list"       grep -qF "registerHostTool('calendar.list'" src/daemon.ts
t "daemon 注册了 calendar.conflicts"  grep -qF "registerHostTool('calendar.conflicts'" src/daemon.ts
t "daemon 建了日历目录"               grep -qF 'join(cfg.dataDir, '"'"'calendar'"'"')' src/daemon.ts

# ── E. 行为：真读一个 .ics 文件 ─────────────────────────────
mkdir -p /tmp/t6cal
cat > /tmp/t6cal/work.ics <<'ICS'
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:t6-1
SUMMARY:产品评审
DTSTART:20261020T140000Z
DTEND:20261020T150000Z
LOCATION:会议室 A
END:VEVENT
BEGIN:VEVENT
UID:t6-2
SUMMARY:技术讨论
DTSTART:20261020T143000Z
DTEND:20261020T153000Z
END:VEVENT
BEGIN:VEVENT
UID:t6-3
SUMMARY:出差
DTSTART;VALUE=DATE:20261021
DTEND;VALUE=DATE:20261022
END:VEVENT
END:VCALENDAR
ICS

cat > .t6-read.ts <<'NODE'
import { listEvents, listConflicts, renderList } from './src/calendar/CalendarService.ts';
const now = Date.UTC(2026, 9, 20, 0, 0, 0);
const r = listEvents({ dir: '/tmp/t6cal' }, now, 7);
const c = listConflicts({ dir: '/tmp/t6cal' }, now, 7);
const txt = renderList(r);
const checks = [
  r.events.length === 3,               // 三个事件都读出来
  r.sources.length === 1,              // 一个文件
  r.errors.length === 0,               // 没错误
  c.conflicts.length === 1,            // 14:00-15:00 撞 14:30-15:30
  !txt.includes('时刻未知'),           // 时间都解析出来了
  txt.includes('产品评审'),            // 标题在
  txt.includes('会议室 A'),            // 地点在
];
console.log(checks.every(Boolean) ? 'OK' : 'BAD ' + JSON.stringify(checks));
NODE
READ=$(node --import tsx .t6-read.ts 2>&1 | tail -1)
rm -f .t6-read.ts
t "真读 .ics：3 事件 1 冲突"          test "$READ" = "OK"

# ── F. 行为：目录不存在要如实报错，不能当"没有日程" ─────────
cat > .t6-nodir.ts <<'NODE'
import { listEvents } from './src/calendar/CalendarService.ts';
const r = listEvents({ dir: '/tmp/t6-does-not-exist' }, Date.now(), 7);
// 关键：errors 非空。静默返回空列表会让主人以为"我没安排"。
console.log(r.events.length === 0 && r.errors.length > 0 ? 'OK' : 'BAD ' + JSON.stringify(r.errors));
NODE
NODIR=$(node --import tsx .t6-nodir.ts 2>&1 | tail -1)
rm -f .t6-nodir.ts
t "目录不存在时如实报错"              test "$NODIR" = "OK"

# ── G. 行为：全天 + 会议不算冲突 ────────────────────────────
cat > .t6-allday.ts <<'NODE'
import { listConflicts } from './src/calendar/CalendarService.ts';
const now = Date.UTC(2026, 9, 20, 0, 0, 0);
const c = listConflicts({ dir: '/tmp/t6cal' }, now, 7);
// 出差（全天）和两个会议都重叠，但只应报"两个会议相撞"这一对
console.log(c.conflicts.length === 1 ? 'OK' : 'BAD ' + c.conflicts.length);
NODE
AD=$(node --import tsx .t6-allday.ts 2>&1 | tail -1)
rm -f .t6-allday.ts
t "全天事件不计入冲突"                test "$AD" = "OK"
rm -rf /tmp/t6cal

# ── H. 类型检查 ──────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1