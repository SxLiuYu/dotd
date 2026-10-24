#!/usr/bin/env bash
# 发布前安全扫描 — 检查是否有真实密钥/凭证误入库
# 用法: bash scripts/check-leaks.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Charlie 发布前安全扫描 ==="

# 1. 检查 git 跟踪文件里的敏感词
# 排除 dist/_internal (PyInstaller 产物含脚本副本) 和测试数据
LEAKS=$(git grep -nE "(cli_a90c|ou_ffd590|sk-[A-Za-z0-9]{20,}|tp-[a-z0-9]{20,})" -- ':!*.md' ':!docs/' ':!.scratch/' ':!tests/' ':!scripts/check-leaks.sh' ':!dist/' 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  echo "❌ 发现敏感信息在跟踪文件中:"
  echo "$LEAKS"
  exit 1
fi

# 2. 检查 .env 是否被跟踪
if git ls-files --error-unmatch .env 2>/dev/null; then
  echo "❌ .env 被 git 跟踪！请: git rm --cached .env"
  exit 1
fi

# 3. 检查 RTK.md 是否被跟踪（作者运行时笔记，应 gitignore）
if git ls-files --error-unmatch RTK.md 2>/dev/null; then
  echo "⚠️  RTK.md 被 git 跟踪（含运行时信息）。建议: git rm --cached RTK.md"
fi

# 4. 检查 cert/ 是否被跟踪
if git ls-files cert/ 2>/dev/null | grep -q .; then
  echo "❌ cert/ 里有被跟踪的证书文件！"
  exit 1
fi

echo "✅ 安全扫描通过，无敏感信息泄露"
