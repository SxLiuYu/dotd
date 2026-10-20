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
t "判定单元判据 28 条全过"            test "$PG" = "合计 28 通过 / 0 失败"

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
console.log(c.progress.enabled === false && c.progress.everyNSteps === 3 && c.progress.minIntervalMs === 90000 ? 'OK' : 'BAD ' + JSON.stringify(c.progress));
NODE
# 配置里有 9 个 ${ENV} 占位，缺一个就 fail-closed 拒启动。
# 这里给全占位值 —— 判据只验 progress 段的默认值，不验凭据。
CFG=$(env \
  DOTD_DB_PATH=/tmp/t5.db DOTD_MASTER_TOKEN=x DOTD_RO_TOKEN=y \
  FEISHU_APP_ID=a FEISHU_APP_SECRET=b FEISHU_ENCRYPT_KEY=c \
  FEISHU_OWNER_CHAT_ID=oc_z FEISHU_VERIFICATION_TOKEN=d HOOK_GRAFANA=e \
  node --import tsx .t5-cfg.ts 2>&1 | tail -1)
rm -f .t5-cfg.ts
t "配置读出默认关 + 3 步 + 90 秒"     test "$CFG" = "OK"

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

# ── F. 类型检查 ──────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1