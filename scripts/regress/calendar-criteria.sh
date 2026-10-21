#!/usr/bin/env bash
# scripts/regress/calendar-criteria.sh —— T6/T7 日历硬判据（只读订阅 + 本地写回）
#
# T6（2026-10-20）回答：能不能读 .ics、列窗口、查冲突，而且**绝不写**。
# T7（2026-10-21）把边界改成"**订阅只读，本地可写**"，本脚本随之升级：
#   - 原第 C 节"日历模块没有任何写入 API/不写文件"被替换为写时代的边界判据：
#     写 API 恰好 3 个、只写 local.ics、订阅 .ics 在写路径上字节不变。
#   - 新增能力链路与双向守卫（2026-10-18 邮件事故的教训：注册了≠模型看得见）。
#
# 用法：bash scripts/regress/calendar-criteria.sh
#   exit 0 = 全部通过
#   exit 1 = 有判据失败
#   exit 2 = 脚本自身崩了

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
echo "════ T6/T7 日历验收（订阅只读 + 本地写回）════"
echo ""

# ── A. 文件与单元判据 ────────────────────────────────────────
t "ICS 解析器存在"                    test -f src/calendar/ics.ts
t "日历服务存在"                      test -f src/calendar/CalendarService.ts
t "解析单元测试存在"                  test -f tests/calendar-ics.test.ts
t "写回单元测试存在"                  test -f tests/calendar-write.test.ts

CAL=$(node --import tsx tests/calendar-ics.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "解析单元判据 56 条全过"            test "$CAL" = "合计 56 通过 / 0 失败"

WRITE=$(node --import tsx --test tests/calendar-write.test.ts 2>&1)
WPASS=$(printf '%s' "$WRITE" | grep -oE 'ℹ pass [0-9]+' | grep -oE '[0-9]+' | head -1)
WFAIL=$(printf '%s' "$WRITE" | grep -oE 'ℹ fail [0-9]+' | grep -oE '[0-9]+' | head -1)
t "写回判据 ≥8 条全过（pass=$WPASS fail=$WFAIL）" \
  bash -c "test -n \"$WPASS\" -a \"$WPASS\" -ge 8 -a \"$WFAIL\" = 0"

# ── B. RFC 5545 的陷阱（读侧 + 写侧对称）─────────────────────
t "折行被处理"                        grep -q 'export function unfoldLines' src/calendar/ics.ts
t "转义被处理（状态机）"              grep -q 'export function unescapeText' src/calendar/ics.ts
t "DATE vs DATE-TIME 分开处理"        grep -q "allDay: true" src/calendar/ics.ts
t "认不出的时间不猜"                  grep -q '时刻未知' src/calendar/ics.ts
t "重复规则明确说明不支持"            grep -q '重复规则' src/calendar/ics.ts
# 写侧三件套与读侧同住一文件：折行/转义/时刻格式读写必须同一套认知
t "生成侧：TEXT 转义"                 grep -q 'export function escapeIcsText' src/calendar/ics.ts
t "生成侧：按字节折行"                grep -q 'export function foldIcsLine' src/calendar/ics.ts
t "生成侧：序列化器"                  grep -q 'export function serializeIcs' src/calendar/ics.ts
t "生成侧：时刻带时区（Z 形态）"      grep -q 'export function toIcsUtc' src/calendar/ics.ts

# ── C. 写时代的边界：订阅只读 + 本地可写（替代 T6 的"整体只读"）──
# 写 API 恰好 3 个，名字点得出来
t "写 API：addLocalEvent"             grep -q 'export function addLocalEvent' src/calendar/CalendarService.ts
t "写 API：editLocalEvent"            grep -q 'export function editLocalEvent' src/calendar/CalendarService.ts
t "写 API：deleteLocalEvent"          grep -q 'export function deleteLocalEvent' src/calendar/CalendarService.ts
# 写文件的口子只有 1 个（writeLocalEvents）：想绕过它写日历 = 没有这种代码
# 数带括号的调用（=1），import 行里的裸名不算
t "写文件口子唯一（1 处 writeFileSync 调用）"  test "$(grep -c 'writeFileSync(' src/calendar/CalendarService.ts)" = "1"
# 解析器仍然不写文件（读写分层的另一半）
t "ICS 解析器不写文件"                bash -c '! grep -qE "writeFileSync|appendFileSync" src/calendar/ics.ts'
# 订阅只读落进文案：服务头版写明"订阅 .ics 永远只读"
t "订阅只读边界写明"                  grep -q '订阅 .ics 永远只读' src/calendar/CalendarService.ts
# ── D. 装配（daemon）────────────────────────────────────────
t "daemon 注册了 calendar.list"       grep -qF "registerHostTool('calendar.list'" src/daemon.ts
t "daemon 注册了 calendar.conflicts"  grep -qF "registerHostTool('calendar.conflicts'" src/daemon.ts
t "daemon 注册了 calendar.add"        grep -qF "registerHostTool('calendar.add'" src/daemon.ts
t "daemon 注册了 calendar.edit"       grep -qF "registerHostTool('calendar.edit'" src/daemon.ts
t "daemon 注册了 calendar.delete"     grep -qF "registerHostTool('calendar.delete'" src/daemon.ts
t "daemon 建了日历目录"               grep -qF 'join(cfg.dataDir, '"'"'calendar'"'"')' src/daemon.ts

# ⚠️ 回归守卫（2026-10-20 踩过）：日历注册一度被嵌进 mail 的 if (mailKey) 分支，
# 于是线上没配 DOTD_MAIL_KEY 时日历工具**静默不注册**，而 tsc 和单测全绿。
# 判据：日历注册所在行必须**晚于** mail else 分支的收尾 —— 早于就说明还在闸门里。
CAL_LINE=$(grep -nF "registerHostTool('calendar.list'" src/daemon.ts | head -1 | cut -d: -f1)
MAIL_LINE=$(grep -nF "未配置 DOTD_MAIL_KEY" src/daemon.ts | head -1 | cut -d: -f1)
t "日历注册不在 mail 密钥闸门内"        test -n "$CAL_LINE" -a -n "$MAIL_LINE" -a "$CAL_LINE" -gt "$MAIL_LINE"
CATCH_LINE=$(grep -nF "邮件工具未启用" src/daemon.ts | head -1 | cut -d: -f1)
t "日历注册不在 mail 的 try/catch 里"   test -n "$CATCH_LINE" -a "$CAL_LINE" -gt "$CATCH_LINE"
t "建目录失败不阻断启动"                grep -qF '建不出来也不影响启动' src/daemon.ts
t "注册日志如实报 5 个工具"             grep -q '日历工具已注册（5 个' src/daemon.ts

# ── E. 行为：真读一个 .ics 文件（T6 原判据，保留）───────────
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

cat > .vg-cal-read.ts <<'NODE'
import { listEvents, listConflicts, renderList } from './src/calendar/CalendarService.ts';
const now = Date.UTC(2026, 9, 20, 0, 0, 0);
const r = listEvents({ dir: '/tmp/t6cal' }, now, 7);
const c = listConflicts({ dir: '/tmp/t6cal' }, now, 7);
const txt = renderList(r);
const checks = [
  r.events.length === 3,
  r.sources.length === 1,
  r.errors.length === 0,
  c.conflicts.length === 1,
  !txt.includes('时刻未知'),
  txt.includes('产品评审'),
  txt.includes('会议室 A'),
];
console.log(checks.every(Boolean) ? 'OK' : 'BAD ' + JSON.stringify(checks));
NODE
READ=$(node --import tsx .vg-cal-read.ts 2>&1 | tail -1)
rm -f .vg-cal-read.ts
t "真读 .ics：3 事件 1 冲突"          test "$READ" = "OK"

cat > .vg-cal-nodir.ts <<'NODE'
import { listEvents } from './src/calendar/CalendarService.ts';
const r = listEvents({ dir: '/tmp/t7-does-not-exist' }, Date.now(), 7);
console.log(r.events.length === 0 && r.errors.length > 0 ? 'OK' : 'BAD ' + JSON.stringify(r.errors));
NODE
NODIR=$(node --import tsx .vg-cal-nodir.ts 2>&1 | tail -1)
rm -f .vg-cal-nodir.ts
t "目录不存在时如实报错"              test "$NODIR" = "OK"

cat > .vg-cal-allday.ts <<'NODE'
import { listConflicts } from './src/calendar/CalendarService.ts';
const now = Date.UTC(2026, 9, 20, 0, 0, 0);
const c = listConflicts({ dir: '/tmp/t6cal' }, now, 7);
console.log(c.conflicts.length === 1 ? 'OK' : 'BAD ' + c.conflicts.length);
NODE
AD=$(node --import tsx .vg-cal-allday.ts 2>&1 | tail -1)
rm -f .vg-cal-allday.ts
t "全天事件不计入冲突"                test "$AD" = "OK"
rm -rf /tmp/t6cal
# ── F. 行为：写回端到端（T7 新增；订阅文件字节不变是硬边界）──
cat > .vg-cal-write.ts <<'NODE'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addLocalEvent,
  deleteLocalEvent,
  editLocalEvent,
  listConflicts,
  listEvents,
} from './src/calendar/CalendarService.ts';
const dir = mkdtempSync(join(tmpdir(), 'vg-cal-'));
const sub = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:vg-1', 'SUMMARY:产品评审',
  'DTSTART:20261021T140000Z', 'DTEND:20261021T150000Z', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
writeFileSync(join(dir, 'work.ics'), sub, 'utf8');
const now = Date.UTC(2026, 9, 21, 8, 0, 0);
const cfg = { dir };
const checks: boolean[] = [];
const chk = (c: boolean) => checks.push(c);

const r1 = addLocalEvent(cfg, now, { summary: '周会', start: '2026-10-21T22:00:00+08:00', durationMin: 60 });
chk(r1.ok && r1.event.source === 'local');
const r2 = addLocalEvent(cfg, now, { summary: '周会', start: '2026-10-21T22:00:00+08:00', durationMin: 60 });
chk(r2.ok && r2.duplicate === true);
const listed = listEvents(cfg, now, 7);
chk(listed.events.length === 2 && listed.sources.length === 2);
const c = listConflicts(cfg, now, 7);
chk(c.conflicts.length === 1);
const e = editLocalEvent(cfg, now, r1.event.uid, { start: '2026-10-21T23:00:00+08:00' });
chk(e.ok && e.event.endMs - e.event.startMs === 60 * 60_000);
const raw = readFileSync(join(dir, 'local.ics'), 'utf8');
chk(raw.includes('BEGIN:VEVENT') && /DTSTART:\d{8}T\d{6}Z/.test(raw));
const d = deleteLocalEvent(cfg, now, r1.event.uid);
chk(d.ok && d.removed === true);
const d2 = deleteLocalEvent(cfg, now, r1.event.uid);
chk(d2.ok && d2.removed === false);
chk(readFileSync(join(dir, 'work.ics')).equals(Buffer.from(sub, 'utf8')));
rmSync(dir, { recursive: true, force: true });
console.log(checks.every(Boolean) ? 'OK ' + checks.length : 'BAD ' + JSON.stringify(checks));
NODE
W=$(node --import tsx .vg-cal-write.ts 2>&1 | tail -1)
rm -f .vg-cal-write.ts
t "写回端到端 9 项全过"               test "${W%% *}" = "OK"

# ── G. 能力链路（2026-10-18 邮件事故：注册了≠模型看得见）────
# 约束链：CAPABILITY_CATALOG 规范 + HOST_SIDE_TOOLS 名字 → getCapabilities
# 合并 → toolSpecs → 模型工具清单。缺任何一环模型就报"没有日历工具"。
t "calendar.add 在能力目录"           grep -qF "name: 'calendar.add'," src/exec/protocol.ts
t "calendar.edit 在能力目录"          grep -qF "name: 'calendar.edit'," src/exec/protocol.ts
t "calendar.delete 在能力目录"        grep -qF "name: 'calendar.delete'," src/exec/protocol.ts
t "目录尾部收口（最后一批是连接器+保险库，vault.sites 收尾）"  bash -c "grep -B10 '^];' src/exec/protocol.ts | grep -qF \"name: 'vault.sites',\""
t "3 名记入 HOST_SIDE_TOOLS"          grep -qF "'calendar.add', 'calendar.edit', 'calendar.delete'" src/exec/ExecService.ts
t "ToolDoc：calendar.add"             grep -qF "name: 'calendar.add'," src/runner/tool-catalog.ts
t "ToolDoc：calendar.edit"            grep -qF "name: 'calendar.edit'," src/runner/tool-catalog.ts
t "ToolDoc：calendar.delete"          grep -qF "name: 'calendar.delete'," src/runner/tool-catalog.ts
t "TOOLS_GUIDE 提到 calendar.add"     grep -q 'calendar.add 记日程' src/runner/tool-catalog.ts
t "词表测试已收编 3 名"               grep -qF "'calendar.add'," tests/runner-tool-catalog.test.ts
t "漂移白名单已收编 3 名"             grep -qF "'calendar.add', 'calendar.edit', 'calendar.delete'," tests/agent-runtime-protocol.test.ts

# ── H. 双向守卫（lead 指定）：目录与 Set 互为镜像，一个都不能漏 ──
cat > .vg-mirror.mjs <<'NODE'
import { readFileSync } from 'node:fs';
const cat = readFileSync('src/exec/protocol.ts', 'utf8');
const exec = readFileSync('src/exec/ExecService.ts', 'utf8');
const daemon = readFileSync('src/daemon.ts', 'utf8');
const names = [...cat.matchAll(/name: '([a-z][a-z0-9.]*)'/g)].map((m) => m[1]);
const m = /HOST_SIDE_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(exec);
const set = m === null ? [] : m[1].split(',').map((s) => s.trim().replaceAll("'", '')).filter(Boolean);
const hostPrefix = /^(schedule|mail|calendar|github|rss|vault)\./;
const hostInCatalog = names.filter((n) => hostPrefix.test(n));
const forward = hostInCatalog.every((n) => set.includes(n));
const backward = set.every((n) => names.includes(n));
const handlers = set.every((n) => daemon.includes("registerHostTool('" + n + "'"));
console.log(forward && backward && handlers ? 'OK ' + set.length + '/' + hostInCatalog.length : 'BAD');
NODE
MIRROR=$(node .vg-mirror.mjs 2>&1 | tail -1)
rm -f .vg-mirror.mjs
t "宿主侧工具目录↔Set 双向镜像+全有处理器"  test "$MIRROR" = "OK 19/19"

# ── I. tools.yml：可解析 + 分档正确（安全判据，不能放松）────
cat > .vg-yaml.mjs <<'NODE'
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const y = parse(readFileSync('./config/tools.yml', 'utf8'));
const cal = y.tools.filter((t) => String(t.name).startsWith('calendar.'));
const want = { 'calendar.list': 'read', 'calendar.conflicts': 'read',
               'calendar.add': 'write_file', 'calendar.edit': 'write_file', 'calendar.delete': 'write_file' };
const got = Object.fromEntries(cal.map((t) => [t.name, t.tier]));
const ok = Object.keys(want).every((k) => got[k] === want[k]);
console.log(ok && y.tools.length >= 36 ? 'OK ' + y.tools.length : 'BAD ' + JSON.stringify(got));
NODE
YAML=$(node .vg-yaml.mjs 2>&1 | tail -1)
rm -f .vg-yaml.mjs
t "tools.yml 可解析且日历 5 档正确"   test "${YAML%% *}" = "OK"

# ── J. 类型检查 ─────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1