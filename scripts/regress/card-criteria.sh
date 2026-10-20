#!/usr/bin/env bash
# scripts/regress/card-criteria.sh —— T3 飞书审批卡片的硬判据
#
# 用法：bash scripts/regress/card-criteria.sh
#   exit 0 = 全部通过    exit 1 = 有判据失败    exit 2 = 脚本崩了
#
# 判据分三层：
#   A. 卡片能造出来（结构对、信息全）—— tests/approval-card.test.ts
#   B. 回调能解析且鉴权生效            —— 同上
#   C. 装配层真的接上了                —— 查代码 + 隔离实例启动日志

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
echo "════ T3 飞书审批卡片验收 ════"
echo ""

# ── A/B. 单元判据（48 条在测试文件里）────────────────────────
t "卡片模块存在"                      test -f src/surfaces/feishu-card.ts
t "审批接线模块存在"                  test -f src/surfaces/feishu-approval.ts
t "测试文件存在"                      test -f tests/approval-card.test.ts

CARD=$(node --import tsx tests/approval-card.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "卡片单元判据 48 条全过"            test "$CARD" = "合计 48 通过 / 0 失败"

# ── C. 装配层接线 ─────────────────────────────────────────────
t "channels 有 sendCard"              grep -q 'async sendCard' src/surfaces/channels.ts
t "channels 有 updateCard"            grep -q 'async updateCard' src/surfaces/channels.ts
t "卡片用 interactive 类型"           grep -q "msg_type: 'interactive'" src/surfaces/channels.ts
t "daemon 订阅 approval:created"      grep -q "bus.on('approval:created'" src/daemon.ts
t "daemon 推送失败只记日志"           grep -q '审批单仍在 /approvals 可处理' src/daemon.ts
t "入站识别 card.action.trigger"      grep -q "card.action.trigger" src/surfaces/feishu-inbound.ts
t "卡片回调不过事件流（走 card_action）" grep -q "kind: 'card_action'" src/surfaces/feishu-inbound.ts

# 关键安全判据：卡片回调必须也过主人闸门
t "卡片回调过主人闸门"                grep -q '拒卡片回调' src/surfaces/feishu-inbound.ts
# 关键安全判据：超时必须按拒绝
t "卡片写明超时按拒绝"                grep -q '按拒绝处理' src/surfaces/feishu-card.ts
# 关键：落定后必须改卡片（否则重复点）
t "落定后改卡片去按钮"                grep -q 'buildResolvedCard' src/surfaces/feishu-approval.ts

# ── D. 类型检查 ───────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

# ── E. 隔离实例启动时真的报"审批卡片已启用" ───────────────────
PID=$(pgrep -f 'src/daemon.ts' | head -1)
if [ -n "$PID" ]; then
  get() { tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep "^$1=" | head -1 | cut -d= -f2-; }
  rm -rf /tmp/vg-card && mkdir -p /tmp/vg-card
  env \
    DOTD_HOME=/tmp/vg-card DOTD_CONFIG_DIR="$REPO/config" DOTD_DB_PATH=/tmp/vg-card/dotd.db \
    DOTD_MAIL_KEY="$(openssl rand -base64 32)" \
    DOTD_MASTER_TOKEN="$(get DOTD_MASTER_TOKEN)" DOTD_RO_TOKEN="$(get DOTD_RO_TOKEN)" \
    FEISHU_APP_ID="$(get FEISHU_APP_ID)" FEISHU_APP_SECRET="$(get FEISHU_APP_SECRET)" \
    FEISHU_ENCRYPT_KEY="x" FEISHU_OWNER_CHAT_ID="$(get FEISHU_OWNER_CHAT_ID)" \
    FEISHU_VERIFICATION_TOKEN="x" HOOK_GRAFANA="$(get HOOK_GRAFANA)" \
    DOTD_MODEL_TRANSPORT=stub DOTD_FLEET=stub \
    timeout 50 node --import tsx src/daemon.ts > /tmp/vg-card/boot.log 2>&1 &
  sleep 26
  BOOT=$(grep -c 'approval-card\] 审批卡片已启用' /tmp/vg-card/boot.log 2>/dev/null || echo 0)
  t "启动日志报审批卡片已启用"        test "$BOOT" = "1"
  pkill -f 'vg-card' 2>/dev/null
else
  printf '  \033[33mSKIP\033[0m %s\n' "启动日志判据（真实 daemon 没在跑，拿不到 env）"
  F=$((F+0))
fi

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1