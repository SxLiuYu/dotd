#!/usr/bin/env bash
# dotd 开发态启动器：真实模型 transport（OpenRouter）+ stub fleet（本机 docker 不可达）。
# token 从 ~/.dotd/tokens.env 加载（首次由 setup-dev-env.sh 生成）。
# 注意：本机 https_proxy 指向 127.0.0.1:1081，该代理已死且 OpenRouter 可裸连——必须剥掉代理变量。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOTD_HOME="$HOME/.dotd"
mkdir -p "$DOTD_HOME"

[ -f "$DOTD_HOME/tokens.env" ] || { echo "缺 $DOTD_HOME/tokens.env，先跑 scripts/setup-dev-env.sh" >&2; exit 1; }
# shellcheck disable=SC1090
source "$DOTD_HOME/tokens.env"

# surfaces 配置在数据目录下（daemon 的 loadSurfacesConfig 默认读 ~/.dotd/config.yml）。
# ⚠️ 别再用 `cp config/dotd.yml ~/.dotd/config.yml` 一次性播种：那样落盘的是带
#    ${DOTD_MASTER_TOKEN} 占位符的模板，能不能用全看启动时环境变量碰巧在不在；
#   而且只播种一次，之后仓库模板改了（端口/白名单/telegram 退役）实况永远不跟上
#   ——2026-10-17 全方位测试的"配置漂移炸弹"就是这么来的。
#   改用 init-config.mjs：幂等、把占位渲染成真值、只补缺键不动已有行。
if [ ! -f "$DOTD_HOME/config.yml" ]; then
  echo "首次运行：生成 ~/.dotd/config.yml"
  node "$REPO/scripts/init-config.mjs"
fi

unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY

export DOTD_HOME
cd "$REPO"
exec node --max-old-space-size=1024 --import tsx src/daemon.ts
