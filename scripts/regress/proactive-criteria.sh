#!/usr/bin/env bash
# scripts/regress/proactive-criteria.sh —— T4 主动发起对话的硬判据
#
# 用法：bash scripts/regress/proactive-criteria.sh
#   exit 0 = 全过    exit 1 = 有失败    exit 2 = 脚本崩了
#
# T4 要回答的问题不是"能不能主动发消息"（那个 2026-10-19 就修了），
# 而是"**该不该现在发**"。所以判据几乎全集中在闸门上。

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
echo "════ T4 主动发起对话验收 ════"
echo ""

# ── A. 文件与单元判据 ────────────────────────────────────────
t "闸门模块存在"                      test -f src/surfaces/proactive.ts
t "闸门测试存在"                      test -f tests/proactive.test.ts
t "迁移包存在"                        test -f db/migrations/170_proactive.sql

GATE=$(node --import tsx tests/proactive.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "闸门单元判据 30 条全过"            test "$GATE" = "合计 30 通过 / 0 失败"

# ── B. 三道闸的口径 ──────────────────────────────────────────
# 跨午夜必须真的生效 —— 写错这里会让主人凌晨被叫醒
t "安静时段支持跨午夜"                grep -q 'cur >= startMin || cur < endMin' src/surfaces/proactive.ts
t "开关优先级最高"                    grep -q "reason: 'disabled'" src/surfaces/proactive.ts
t "节流从库读不从内存读"              grep -q 'lastPushAt' src/control-plane/index.ts
t "节流落库（UPDATE crontabs）"       grep -q 'UPDATE crontabs SET last_push_at' src/control-plane/index.ts
t "格式错按不静音（不误伤）"          grep -q 'if (range === null) return false' src/surfaces/proactive.ts

# ── C. 迁移与装配 ────────────────────────────────────────────
t "迁移加 3 个字段"                   grep -q 'ADD COLUMN proactive' db/migrations/170_proactive.sql
t "expectedVersion 升到 170"          grep -q 'expectedVersion: 170' src/daemon.ts
t "CrontabRow 类型有 proactive"       grep -q 'proactive: number' src/control-plane/types.ts
t "CrontabRow 类型有 last_push_at"    grep -q 'last_push_at: number | null' src/control-plane/types.ts
t "fireHeartbeat 接入了闸门"          grep -q 'shouldPush({' src/control-plane/index.ts
t "判定结论传给下游"                  grep -q 'proactive: decision.allowed' src/control-plane/index.ts

# 关键的语义区分：不推送 ≠ 不执行
t "proactive=0 不阻止任务执行"        grep -q '任务\*\*照常执行\*\*' src/control-plane/types.ts

# ── D. 迁移真的跑通（从 0 到 170）────────────────────────────
cat > .t4-mig.ts <<'NODE'
import { openDb } from './db/conn.ts';
import { migrate } from './db/migrate.ts';
const db = openDb('/tmp/t4-criteria.db');
const r = migrate(db, { expectedVersion: 170 });
const cols = db.prepare('PRAGMA table_info(crontabs)').all().map((c: any) => c.name);
const ver = (db.prepare('PRAGMA user_version').get() as any).user_version;
const okCols = cols.includes('proactive') && cols.includes('throttle_hours') && cols.includes('last_push_at');
console.log(r.to === 170 && ver === 170 && okCols ? 'OK' : 'BAD');
db.close();
NODE
MIG=$(rm -f /tmp/t4-criteria.db*; node --import tsx .t4-mig.ts 2>&1 | tail -1)
rm -f .t4-mig.ts
t "迁移从 0 跑到 170 且字段齐"        test "$MIG" = "OK"

# 默认值必须是 0（升级后不会突然开始发消息）
cat > .t4-def.ts <<'NODE'
import { openDb } from './db/conn.ts';
import { migrate } from './db/migrate.ts';
const db = openDb('/tmp/t4-def.db');
migrate(db, { expectedVersion: 170 });
db.prepare("INSERT INTO crontabs(id,dot_id,title,prompt,cron,next_fire) VALUES('ct_x','dot1','t','p','* * * * *',1)").run();
const row = db.prepare('SELECT proactive, throttle_hours, last_push_at FROM crontabs WHERE id=?').get('ct_x') as any;
// 新插入的行默认 proactive=0（不打扰）、throttle=6h、从没推过
console.log(row.proactive === 0 && row.throttle_hours === 6 && row.last_push_at === null ? 'OK' : 'BAD ' + JSON.stringify(row));
db.close();
NODE
DEF=$(rm -f /tmp/t4-def.db*; node --import tsx .t4-def.ts 2>&1 | tail -1)
rm -f .t4-def.ts
t "默认关（升级后不突然发消息）"      test "$DEF" = "OK"

# ── E. 类型检查 ──────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1