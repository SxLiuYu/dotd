#!/usr/bin/env bash
# 冷构建计时（缓存全关）。结果写到 /tmp/cold.log 末尾两行：
#   rc=<退出码> elapsed=<秒>
# 用法（WSL 内）：
#   nohup bash /mnt/d/dotd/docs/acceptance/voice-docker/cold-build.sh >/dev/null 2>&1 &
set -u
cd /mnt/d/dotd || exit 1
start=$(date +%s)
DOTD_PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  docker compose -f docker/compose.voice.yml build --no-cache > /tmp/cold.log 2>&1
rc=$?
end=$(date +%s)
echo "rc=$rc elapsed=$((end - start))" >> /tmp/cold.log
