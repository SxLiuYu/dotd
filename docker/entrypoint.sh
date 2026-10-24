#!/bin/sh
# docker/entrypoint.sh —— 首次启动把「空数据卷」变成「能跑的配置」（2026-10-24）。
#
# 为什么需要它：compose 只挂一个 /data 卷，干净主机上这个卷是空的，而 one_system
# 期望 /data/config.yml 已存在、dotd 期望 /data/models.yml 已存在。没有这一步，
# 镜像能起、Charlie 能响应 /health，但**内核永远是离线**，用户会以为是镜像坏了。
#
# 三条原则：
#   1. 只在缺失时生成/复制，绝不覆盖已有的配置（升级不抹掉主人的修改）；
#   2. 失败不阻塞启动：宁可 /health 如实显示 kernel=false，也不静默退出；
#   3. 不做"聪明"的配置推断：模型端点仍然要主人自己填（没有 key 就只跑反射层）。
set -eu

DATA="${CHARLIE_HOME:-/data}"
APP="${DOTD_APP_ROOT:-/app}"

mkdir -p "$DATA" "$DATA/voice"

# 1) config.yml：用仓库模板 + 环境变量（DOTD_MASTER_TOKEN 等）生成
if [ ! -f "$DATA/config.yml" ]; then
  echo "[entrypoint] 首次启动：生成 $DATA/config.yml（master token 取自环境）"
  if ! node "$APP/scripts/init-config.mjs"; then
    echo "[entrypoint] ⚠️ init-config 失败；内核会离线，请检查日志" >&2
  fi
else
  echo "[entrypoint] 复用已有 $DATA/config.yml"
fi

# 2) 其余配置：仓库模板 → 数据卷（同样只在缺失时复制）
for f in models.yml tools.yml rules.yml event-rules.yml free-models.yml mcp-servers.yml mcp-servers.voice.yml; do
  if [ -f "$APP/config/$f" ] && [ ! -f "$DATA/$f" ]; then
    cp "$APP/config/$f" "$DATA/$f"
    echo "[entrypoint] 已复制默认 $f（可自行修改）"
  fi
done

# 3) 交回 CMD（one_system: 拉起 dotd + Charlie）
exec "$@"
