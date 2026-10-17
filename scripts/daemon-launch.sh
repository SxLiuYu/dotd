#!/usr/bin/env bash
# dotd daemon 分离启动 wrapper（被 dev-run.sh、systemd/计划任务或手工调用）。
#
# 仓库位置解析顺序（第一个存在的目录胜出）：
#   1. $DOTD_REPO_DIR        —— 部署方显式指定（推荐：WSL 侧 /root/dotd）
#   2. 本脚本上级目录        —— 脚本就在仓库 scripts/ 里时（开发态）
# 旧版写死 `cd /c/Users/1/.../dotd`：那条路径只在"Windows 侧 Git Bash"里成立，
# 而 daemon 实际跑在 WSL（docker/飞书/tier2 全要求 WSL）。DrvFs 上的中文路径 +
# /c 前缀在 WSL 里能不能用全看挂载配置，踩过的坑别再踩——所以改为从环境变量或
# 脚本自身位置推导，部署到哪就从哪起。
set -u

REPO="${DOTD_REPO_DIR:-}"
if [ -z "$REPO" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$(cd "$SELF_DIR/.." && pwd)"
fi
if [ ! -f "$REPO/src/daemon.ts" ]; then
  echo "daemon-launch: 找不到 daemon 入口（$REPO/src/daemon.ts）；用 DOTD_REPO_DIR 指定仓库根" >&2
  exit 3
fi

# tokens.env 是启动前提（master/ro/hook/feishu/tier2 全在里面）。缺了直接退，
# 别让 daemon 带着空 token 起来再报一堆指不回病因的 ConfigError。
if [ ! -f "$HOME/.dotd/tokens.env" ]; then
  echo "daemon-launch: 缺 \$HOME/.dotd/tokens.env，先跑 scripts/setup-dev-env.sh（WSL）或 node scripts/init-config.mjs" >&2
  exit 3
fi
# shellcheck disable=SC1090
source "$HOME/.dotd/tokens.env"

# 本机 https_proxy 指向 127.0.0.1:1081，该代理已死且模型端点可裸连——必须剥掉。
unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY

cd "$REPO"
exec node --max-old-space-size=1024 --import tsx src/daemon.ts >> "$HOME/.dotd/daemon.log" 2>&1
