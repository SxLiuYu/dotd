#!/usr/bin/env bash
# scripts/regress/progress-criteria.sh —— T5 过程可视化硬判据
#
# T5 要回答的问题：
#   一个跑 10 分钟的任务，主人能不能知道"它在干嘛、还要多久"？
#   而不会因为刷屏把通知全关掉？

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
echo "════ T5 过程可视化验收 ════"
echo ""

# ── A. 文件与单元判据 ────────────────────────────────────────
t "判定模块存在"                      test -f src/surfaces/progress.ts
t "推送编排模块存在"                  test -f src/surfaces/progress-push.ts
t "判定测试存在"                      test -f tests/progress.test.ts

PG=$(node --import tsx tests/progress.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "判定单元判据全过"            bash -c '[[ "$1" =~ 0\ 失败$ ]]' _ "$PG"

# ── B. 双阈值与必推路径 ──────────────────────────────────────
t "步数阈值生效"                      grep -q "reason: 'too_few_steps'" src/surfaces/progress.ts
t "时间阈值生效"                      grep -q "reason: 'too_soon'" src/surfaces/progress.ts
t "双阈值都要满足"                    grep -q 'stepDelta < cfg.everyNSteps' src/surfaces/progress.ts
t "需要关注突破节流"                  grep -q "reason: 'attention'" src/surfaces/progress.ts
t "默认关"                            grep -q 'enabled: false' src/surfaces/progress.ts
t "工具名翻人话"                      grep -q 'mail.send.*发邮件' src/surfaces/progress.ts
t "未登记工具不编名字"                grep -q 'TOOL_PHRASES\[tool\] ?? tool' src/surfaces/progress.ts

# ── C. 装配与配置 ────────────────────────────────────────────
t "daemon 启动了进度推送"             grep -q 'startProgressPush({' src/daemon.ts
t "config 有 progress 段"             grep -q '^  progress:' config/dotd.yml
t "配置 schema 有 progress"           grep -q 'progressSchema' src/surfaces/config.ts
t "配置默认 enabled=false"            grep -q 'enabled: z.boolean().default(false)' src/surfaces/config.ts
t "配置映射到 camelCase"              grep -q 'everyNSteps: s.progress.every_n_steps' src/surfaces/config.ts

# ── D. 行为：配置真的能读出来 ────────────────────────────────
cat > .t5-cfg.ts <<'NODE'
import { loadSurfacesConfig } from './src/surfaces/config.ts';
const c = loadSurfacesConfig('/root/dotd/config/dotd.yml');
// 默认必须是关的（升级后不突然刷屏）
// 两个不变量：节流值不能变；代码默认必须是关（升级不能自己开始发消息）。
// 部署值（config/dotd.yml 的 enabled）是主人的选择，不属于判据范围。
import { DEFAULT_PROGRESS } from './src/surfaces/progress.ts';
console.log(c.progress.everyNSteps === 3 && c.progress.minIntervalMs === 90000 && DEFAULT_PROGRESS.enabled === false ? 'OK' : 'BAD ' + JSON.stringify(c.progress));
NODE
# 配置里有 9 个 ${ENV} 占位，缺一个就 fail-closed 拒启动。
# 这里给全占位值 —— 判据只验 progress 段的默认值，不验凭据。
CFG=$(env \
  DOTD_DB_PATH=/tmp/t5.db DOTD_MASTER_TOKEN=x DOTD_RO_TOKEN=y \
  FEISHU_APP_ID=a FEISHU_APP_SECRET=b FEISHU_ENCRYPT_KEY=c \
  FEISHU_OWNER_CHAT_ID=oc_z FEISHU_VERIFICATION_TOKEN=d HOOK_GRAFANA=e \
  node --import tsx .t5-cfg.ts 2>&1 | tail -1)
rm -f .t5-cfg.ts
t "节流默认 3 步/90 秒 + 代码默认关"  test "$CFG" = "OK"

# ── E. 行为：开关关掉时一句都不推 ────────────────────────────
cat > .t5-off.ts <<'NODE'
import { startProgressPush } from './src/surfaces/progress-push.ts';
import { DEFAULT_PROGRESS } from './src/surfaces/progress.ts';

let sent = 0;
const handlers: Array<(e: { payload: unknown }) => void | Promise<void>> = [];
const stop = startProgressPush({
  db: {} as never,
  bus: { on: (_t, h) => { handlers.push(h); return () => undefined; } },
  sender: { send: async () => { sent++; return { ok: true }; } },
  chatId: 'oc_x',
  cfg: DEFAULT_PROGRESS,  // enabled: false
  log: () => undefined,
});
// 推一条假事件进去
for (const h of handlers) await h({ payload: { taskId: 'tk_1', tool: 'fs.read', callId: 'c1', status: 'ok' } });
stop();
console.log(sent === 0 ? 'OK' : 'BAD sent=' + sent);
NODE
OFF=$(node --import tsx .t5-off.ts 2>&1 | tail -1)
rm -f .t5-off.ts
t "开关关掉时一句都不推"              test "$OFF" = "OK"

# ── F. 画面链路（T5 判据里 browser.snapshot 那一半）───────────
t "从 steps 取 result_json"            grep -q 'result_json AS resultJson' src/surfaces/progress-push.ts
t "browser.* 结果被抽成画面"          grep -q 'export function screenOf' src/surfaces/progress-push.ts
t "snapshot 递归挖 name"              grep -q 'function collectNodeNames' src/surfaces/progress-push.ts
t "取不到内容退回域名"                grep -q "return url !== '' ? hostOf(url) : null" src/surfaces/progress-push.ts
t "画面限长 200"                      grep -q 'slice(0, 200)' src/surfaces/progress-push.ts
t "文案里带页面"                      grep -q "页面：' + input.screen" src/surfaces/progress.ts

cat > .t5-screen.ts <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { screenOf } from './src/surfaces/progress-push.ts';
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE steps (task_id TEXT, seq INTEGER, kind TEXT, tool_name TEXT, status TEXT, result_json TEXT)`);
db.prepare('INSERT INTO steps VALUES (?,?,?,?,?,?)').run(
  'tk_1', 1, 'tool', 'browser.open', 'succeeded',
  JSON.stringify({ url: 'https://example.com/x', title: '示例站' }),
);
const row = db.prepare(
  'SELECT tool_name, result_json FROM steps WHERE task_id=? AND status=? ORDER BY seq DESC',
).get('tk_1', 'succeeded') as { tool_name: string; result_json: string };
const got = screenOf(row.tool_name, row.result_json);
// 整条链路：库里的 browser 结果 → 主人看得懂的一句
console.log(got === '示例站 — example.com' ? 'OK' : 'BAD ' + String(got));
db.close();
NODE
SCREEN=$(node --import tsx .t5-screen.ts 2>&1 | tail -1)
rm -f .t5-screen.ts
t "端到端：steps 里的画面变人话"      test "$SCREEN" = "OK"

# ── G. 端到端：真迁移库 + 真 steps 行 → 主人看到的那句话 ──────
# 这条是最有分量的判据：不是单测里的假对象，是从 user_version=170 的库里
# 读出 browser 步骤的 result_json，渲染成能给主人看的文字。
cat > .t5-e2e.ts <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { ensurePragmas } from './db/conn.ts';
import { migrate, latestMigrationVersion } from './db/migrate.ts';
import { startProgressPush } from './src/surfaces/progress-push.ts';

const db = new DatabaseSync(':memory:');
ensurePragmas(db);
// 版本号从 db/migrations/ 目录推，不写死（2026-10-22：这里钉死 170，加第一个新迁移包
// 就整条判据红 —— 而红的理由是"脚本自己过期"，不是"进度功能坏了"。
migrate(db, { expectedVersion: latestMigrationVersion() });
const now = Date.now();
db.prepare(
  'INSERT INTO tasks (id,dot_id,title,goal,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
).run('tk_e', 'dot1', '查订单', 'g', 'running', now, now);
db.prepare(
  'INSERT INTO steps (task_id,seq,kind,status,tool_name,result_json,run_epoch,started_at) VALUES (?,?,?,?,?,?,?,?)',
).run(
  'tk_e', 1, 'tool', 'succeeded', 'browser.open',
  JSON.stringify({ url: 'https://shop.example.com/orders', title: '我的订单' }), 1, now,
);

const sent: string[] = [];
const handlers: Array<(e: { payload: unknown }) => void | Promise<void>> = [];
const stop = startProgressPush({
  db,
  bus: { on: (_t, h) => { handlers.push(h); return () => undefined; } },
  sender: { send: async (_c, text) => { sent.push(text); return { ok: true }; } },
  chatId: 'oc_test',
  cfg: { enabled: true, everyNSteps: 1, minIntervalMs: 0 },
  log: () => undefined,
});
for (const h of handlers) await h({ payload: { taskId: 'tk_e', tool: 'browser.open', callId: 'c1', status: 'ok' } });
stop();

const msg = sent[0] ?? '';
const checks = [
  sent.length === 1,                          // 恰好推一条
  msg.includes('正在做'),                     // 抬头是人话不是 task.state
  msg.includes('查订单'),                     // 带任务标题
  msg.includes('打开网页'),                   // browser.open 翻了人话
  msg.includes('我的订单 — shop.example.com'),// 画面：标题 + 域名
  !msg.includes('{'),                         // 不泄露 JSON
];
console.log(checks.every(Boolean) ? 'OK' : 'BAD ' + JSON.stringify(checks));
db.close();
NODE
E2E=$(node --import tsx .t5-e2e.ts 2>&1 | tail -1)
rm -f .t5-e2e.ts
t "端到端：真库→真消息→人话+画面"      test "$E2E" = "OK"

# ── H. 类型检查 ──────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1