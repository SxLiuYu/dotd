#!/usr/bin/env bash
# scripts/wsl-deploy.sh —— 把仓库同步到 WSL 侧运行副本（默认 /root/dotd），按需重启 daemon。
#
# 为什么需要它：daemon 实际跑在 WSL（Docker 执行面、飞书长连接、tier2 经网关），
# 而开发副本在 Windows 的 /mnt/c 下。两边没有自动同步机制 —— 2026-10-17 全方位
# 测试发现 live daemon 跑的是 6 小时前的旧代码，Windows 侧怎么改都不生效，
# 而日志里看不出任何异常（"配置漂移炸弹"的一种形态）。本脚本把部署变成一条命令。
#
# 用法（在 WSL 里跑；从 Windows 触发见文末）：
#   bash scripts/wsl-deploy.sh                 # 同步 + 类型检查 + 测试 + 对齐 live 配置 + 重启 + 健康检查
#   bash scripts/wsl-deploy.sh --no-restart    # 只同步 + 类型检查 + 测试（改完想先看结果）
#   bash scripts/wsl-deploy.sh --no-test       # 跳过 WSL 侧全量测试（省时间，不推荐）
#   bash scripts/wsl-deploy.sh --no-align      # 不动 ~/.dotd/config.yml（手工管配置时用）
#
# 目标目录用 DOTD_DEPLOY_DIR 覆盖（默认 /root/dotd）。
# 同步**不覆盖** ~/.dotd 里的 token/库；config.yml 只由 align-live-config.mjs 做
# 逐行对齐（端口、退役段、迁移版本），改前备份到 ~/.dotd/backups/。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SELF_DIR/.." && pwd)"
DST="${DOTD_DEPLOY_DIR:-/root/dotd}"
DO_RESTART=1
DO_TEST=1
DO_ALIGN=1
for a in "$@"; do
  case "$a" in
    --no-restart) DO_RESTART=0 ;;
    --no-test) DO_TEST=0 ;;
    --no-align) DO_ALIGN=0 ;;
    *) echo "用法：$0 [--no-restart] [--no-test] [--no-align]" >&2; exit 2 ;;
  esac
done

log() { echo "[deploy] $*"; }

[ -f "$SRC/src/daemon.ts" ] || { echo "源仓库不像仓库：$SRC/src/daemon.ts 不在" >&2; exit 3; }
[ -f "$DST/package.json" ] || { echo "目标 $DST 没有 package.json（首次部署请先手工 clone/拷贝一次）" >&2; exit 3; }

# ── 0. 记录现状（重启前的 PID、库版本），便于出问题回溯 ─────────────────
OLD_PID="$(pgrep -f 'src/daemon\.ts' | head -1 || true)"
log "源=$SRC"
log "目标=$DST"
log "当前 daemon PID=${OLD_PID:-（未运行）}"

# ── 1. 同步源码（node_modules 不同步：DrvFs 上拷 101MB 又慢又容易带坏原生模块）──
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.zcode' \
  --exclude 'journal-blobs' \
  --exclude 'web-ui/node_modules' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude 'nul' \
  --exclude '.tmp-*' \
  --exclude 'tmp-*' \
  --exclude '*.log' \
  "$SRC/" "$DST/"
log "同步完成"

# ── 2. 依赖：lock 变了才装（node_modules 已在目标机，别每次 npm install）─────
LOCK_CHANGED=0
if ! cmp -s "$SRC/package.json" "$DST/package.json" 2>/dev/null; then LOCK_CHANGED=1; fi
if ! cmp -s "$SRC/package-lock.json" "$DST/package-lock.json" 2>/dev/null; then LOCK_CHANGED=1; fi
if [ "$LOCK_CHANGED" = "1" ]; then
  log "package.json/lock 有变化 → npm install"
  (cd "$DST" && npm install --no-audit --no-fund)
else
  log "依赖未变，跳过 npm install"
fi

# ── 3. 类型检查（重启前的闸门：编不过就别动 live）──────────────────────
log "tsc --noEmit"
(cd "$DST" && npx tsc --noEmit -p .)
log "类型检查通过"

# ── 4. WSL 侧全量测试（默认开；平台相关 bug 只有在这儿现形）────────────
if [ "$DO_TEST" = "1" ]; then
  log "WSL 全量测试（npm test）"
  (cd "$DST" && npm test)
fi

# ── 4.5 live 配置对齐（端口/退役段/迁移版本；只在真要重启时才动文件）──────
# 不覆盖整个 config.yml：live 里有 ${VAR} 引用和运维手改注释，align 脚本做逐行
# 外科手术并先备份到 ~/.dotd/backups/。幂等，已对齐时只打印一行。
if [ "$DO_RESTART" = "1" ] && [ "$DO_ALIGN" = "1" ]; then
  if [ -f "$HOME/.dotd/config.yml" ]; then
    log "对齐 $HOME/.dotd/config.yml"
    node --import tsx "$DST/scripts/align-live-config.mts" --config "$HOME/.dotd/config.yml" || true
  else
    log "live 配置不在 $HOME/.dotd/config.yml，跳过对齐（首次部署请先跑 init-config）"
  fi
fi

if [ "$DO_RESTART" = "0" ]; then
  log "--no-restart：不同步 live 进程，收工"
  exit 0
fi

# ── 5. 重启 daemon（优雅退出优先；起不来自动回滚到旧 PID 的日志供查）──────
if [ -n "$OLD_PID" ]; then
  log "SIGTERM $OLD_PID（宽限 30s）"
  kill -TERM "$OLD_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    log "30s 还没退，SIGKILL"
    kill -KILL "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

log "启动 daemon（DOTD_REPO_DIR=$DST）"
mkdir -p "$HOME/.dotd"
DOTD_REPO_DIR="$DST" setsid nohup bash "$DST/scripts/daemon-launch.sh" \
  >> "$HOME/.dotd/daemon.log" 2>&1 < /dev/null &
disown 2>/dev/null || true

# ── 6. 健康检查：等端口起来 + /api/health 200 ─────────────────────────
PORT="$(grep -E '^[[:space:]]+port:' "$HOME/.dotd/config.yml" 2>/dev/null | head -1 | tr -d ' ' | cut -d: -f2 || true)"
PORT="${PORT:-7788}"
log "等 127.0.0.1:$PORT 监听（最多 60s）"
UP=0
for _ in $(seq 1 60); do
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then UP=1; break; fi
  sleep 1
done
if [ "$UP" != "1" ]; then
  echo "[deploy] 端口没起来，daemon.log 尾部：" >&2
  tail -20 "$HOME/.dotd/daemon.log" >&2 || true
  exit 4
fi

TOKEN="$(grep -E '^export DOTD_MASTER_TOKEN=' "$HOME/.dotd/tokens.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$PORT/api/health" || true)"
log "GET /api/health → $CODE"
if [ "$CODE" != "200" ]; then
  echo "[deploy] 健康检查没过，daemon.log 尾部：" >&2
  tail -20 "$HOME/.dotd/daemon.log" >&2 || true
  exit 5
fi

NEW_PID="$(pgrep -f 'src/daemon\.ts' | head -1 || true)"
log "完成：daemon PID=${NEW_PID:-?} 在 127.0.0.1:$PORT（旧 PID=${OLD_PID:-无}）"
log "飞书长连接/模型热备由 daemon 自行恢复；可用 \`dotd sos-test\` 与 /api/status 复核。"
