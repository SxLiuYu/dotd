#!/usr/bin/env bash
# 工具链完整性核对（2026-10-19）——静态六环 + 动态抽查
#
# 背景：一个工具要真正到模型手上，得穿过六环：
#   能力目录 → 容器镜像 → 宿主白名单 → 治理登记 → 处理器注册 → 工具说明书
# 任何一环漏了都是**静默失效**：没有报错，模型只会说"我没这个工具"。
# 2026-10-19 两天内各漏过一环（YAML 解析残缺、白名单漏 schedule.remove）。
#
# 用法：bash scripts/audit-tool-chain.sh          # 静态核对
#       bash scripts/audit-tool-chain.sh --live   # 再跑动态抽查（会真发任务）
set -uo pipefail
cd "$HOME/dotd" || exit 1

echo "════ 静态核对：目录 / 白名单 / 治理 / 处理器 / 说明书 ════"
node --import tsx "$HOME/dotd/_chain.mjs" 2>&1 || exit 1

if [ "${1:-}" = "--live" ]; then
  echo
  echo "════ 动态抽查 ════"
  bash "$HOME/dotd/scripts/verify-alltools.sh" 2>&1
fi
