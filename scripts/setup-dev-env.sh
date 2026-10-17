#!/usr/bin/env bash
# 生成/补齐 dotd 开发态 token 文件（幂等：已有键原样保留，只补缺键）。
#
# 为什么从"已存在即退出"改成"补齐"：旧脚本第一次跑完就再也不管，后来主人手工往
# tokens.env 里加的 FEISHU_* / WB2API_KEY / DOTD_TIER2_HOST 全靠记忆维护——
# 仓库脚本与实况漂移，换机器部署时必然缺键（2026-10-17 全方位测试"配置漂移炸弹"）。
# 现在缺哪些键一眼可见，重复跑也只会补不会覆盖（真值优先）。
set -euo pipefail
DOTD_HOME="$HOME/.dotd"
mkdir -p "$DOTD_HOME"
F="$DOTD_HOME/tokens.env"
touch "$F"
chmod 600 "$F" 2>/dev/null || true

gen() { node -e "console.log(require('crypto').randomBytes(${1:-16}).toString('hex'))"; }

# 已有键原样保留；缺键才写入（第二参数为生成式或占位串）。
ensure() {
  local key="$1" val="$2"
  if grep -q "^export ${key}=" "$F" 2>/dev/null; then return 0; fi
  printf 'export %s=%s\n' "$key" "$val" >> "$F"
  echo "补键 ${key}"
}

# 易失值每次重算覆盖（网关 IP 会漂移，保留旧值只会让 tier2 继续断）。
refresh() {
  local key="$1" val="$2"
  if grep -q "^export ${key}=" "$F" 2>/dev/null; then
    sed -i "s|^export ${key}=.*|export ${key}=${val}|" "$F"
  else
    printf 'export %s=%s\n' "$key" "$val" >> "$F"
  fi
  echo "刷新 ${key}"
}

# ── 自签发令牌（缺了才生成；已有的是主人可能已分发的，不能动）──────────
ensure DOTD_MASTER_TOKEN "$(gen)"
ensure DOTD_RO_TOKEN "$(gen 12)"
ensure HOOK_GRAFANA "$(gen 12)"

# ── 模型端点密钥（占位空串；surfaces fail-closed 只要求非空，填真值才通）──
# WB2API_KEY：tier1 workbuddy2api 容器（:7863）的 key，37 位 wb2a… 前缀。
ensure WB2API_KEY ""
# HY3_API_KEY：同一供应商的另一把（Agent2API 那一版），代理回来即可回退。
ensure HY3_API_KEY ""
# OPENROUTER_API_KEY：tier3 池侦察/备胎用（免费路由空壳率高，见项目记忆）。
ensure OPENROUTER_API_KEY ""
# BACKUP_API_KEY：备胎端点（models.yml 里 enabled: false）。
ensure BACKUP_API_KEY ""

# ── 飞书通道（求救 + 任务回帖都走它；没有 Telegram）────────────────────
ensure FEISHU_APP_ID ""
ensure FEISHU_APP_SECRET ""
ensure FEISHU_ENCRYPT_KEY ""
ensure FEISHU_VERIFICATION_TOKEN ""
ensure FEISHU_OWNER_CHAT_ID ""

# ── tier2（Colibrì/OLMoE）通路：daemon 在 WSL，引擎只绑 Windows 127.0.0.1:8001，
# 要经 WSL 默认网关 + Windows 侧 win-relay.mts（0.0.0.0:18001）才够得着。
# 网关 IP 会随 WSL 重启漂移，故每次跑本脚本重算一次（models.yml 里也有默认值兜底）。
GW="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1 || true)"
if [ -n "${GW}" ]; then
  refresh DOTD_TIER2_HOST "http://${GW}:18001"
else
  # 不在 WSL 里跑（拿不到网关）→ 不写，让 models.yml 的默认值兜底
  echo "跳过 DOTD_TIER2_HOST（取不到默认网关；models.yml 有默认值兜底）"
fi

# ── 水位阈值（guard 用；不设则走代码默认）─────────────────────────────
ensure DOTD_GUARD_BASE_MB ""
ensure DOTD_RESERVE_MB ""

echo "$F 就绪（$(grep -c '^export ' "$F") 个键）"
