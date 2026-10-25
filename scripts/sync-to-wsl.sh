#!/usr/bin/env bash
# 把 D 盘的项目同步到 WSL（WSL 里跑 daemon + 容器）
set -uo pipefail
# 源目录：仓库就在 D:\dotd（旧值 /mnt/d/toagi/dotd 早已不存在，脚本每次都直接 exit 1，
# 也就是"同步脚本从未真正同步过任何东西"）。
WIN_SRC="/mnt/d/dotd"
WSL_DST="$HOME/dotd"

if [ ! -d "$WIN_SRC" ]; then echo "源目录不存在: $WIN_SRC"; exit 1; fi

echo "=== 同步源码 ==="
for d in src db config scripts agent-runtime exec-image tests; do
  if [ -d "$WIN_SRC/$d" ]; then
    rsync -a --delete "$WIN_SRC/$d/" "$WSL_DST/$d/" 2>/dev/null \
      || { rm -rf "$WSL_DST/$d"; cp -r "$WIN_SRC/$d" "$WSL_DST/"; }
  fi
done
for f in package.json package-lock.json tsconfig.json; do
  [ -f "$WIN_SRC/$f" ] && cp "$WIN_SRC/$f" "$WSL_DST/$f"
done

echo "  完成"
echo "=== 校验关键文件 ==="
for f in src/shared/contracts.ts src/router/transport.ts src/runner/dot.ts; do
  printf "  %-32s %s 字节\n" "$f" "$(stat -c %s "$WSL_DST/$f" 2>/dev/null || echo 0)"
done
echo "  toWireMessages: $(grep -c 'toWireMessages' "$WSL_DST/src/router/transport.ts" 2>/dev/null || echo 0)"
echo "  loadGoalImages: $(grep -c 'loadGoalImages' "$WSL_DST/src/runner/dot.ts" 2>/dev/null || echo 0)"
