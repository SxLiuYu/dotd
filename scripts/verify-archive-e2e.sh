#!/usr/bin/env bash
# 端到端验证：模型改 MEMORY.md → 归档生效 → 内容正确
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "=== 写入前的基线 ==="
timeout 60 docker exec "$CID" sh -c 'wc -c /dot/home/MEMORY.md; ls /dot/home/.archive 2>/dev/null | wc -l' 2>&1

echo
echo "=== 让模型改 MEMORY.md ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
  "读 MEMORY.md，在 ## Current concerns 段末尾加一行「- 归档测试标记」，保留其他所有内容，整篇写回。完成后回复完成。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "task=$TID"

for i in $(seq 1 120); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "状态=$ST（$((i*2))s）"

echo
echo "=== 写入后 ==="
timeout 60 docker exec "$CID" sh -c '
  echo "  MEMORY.md 大小: $(wc -c < /dot/home/MEMORY.md)"
  echo "  归档数量: $(ls /dot/home/.archive 2>/dev/null | wc -l)"
  echo "  最新归档: $(ls /dot/home/.archive 2>/dev/null | sort | tail -1)"
  echo "  标记是否写入: $(grep -c "归档测试标记" /dot/home/MEMORY.md 2>/dev/null || echo 0)"
' 2>&1

echo
echo "=== 归档里是否是改动前的内容 ==="
timeout 60 docker exec "$CID" sh -c '
  latest=$(ls /dot/home/.archive 2>/dev/null | grep MEMORY | sort | tail -1)
  if [ -n "$latest" ]; then
    echo "  归档文件: $latest ($(wc -c < /dot/home/.archive/$latest) 字节)"
    echo "  归档内容里有标记吗: $(grep -c "归档测试标记" /dot/home/.archive/$latest 2>/dev/null || echo 0)（应为 0）"
  fi' 2>&1
