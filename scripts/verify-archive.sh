#!/usr/bin/env bash
# 在真容器里验证：误改 MEMORY.md 后能从 .archive/ 恢复
set -uo pipefail
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 1. 当前 MEMORY.md ==="
timeout 60 docker exec "$CID" sh -c 'wc -c /dot/home/MEMORY.md; head -2 /dot/home/MEMORY.md' 2>&1

echo
echo "=== 2. 模拟模型误改（把内容改乱）==="
timeout 120 docker exec "$CID" sh -c '
cd /opt/agent-runtime && node --experimental-strip-types -e "
import(\"./fs.ts\").then(m => {
  const fsMod = require(\"node:fs\");
  const tools = new m.FsTools({ homeRoot: \"/dot/home\" });
  // 读原文
  const orig = fsMod.readFileSync(\"/dot/home/MEMORY.md\", \"utf8\");
  console.log(\"  原文长度: \" + orig.length);
  // 误改：只保留前 20 字（模拟\"改乱了\"）
  const res = tools.write(\"m1\", { path: \"/dot/home/MEMORY.md\", content: orig.slice(0, 20) });
  console.log(\"  误改结果: \" + res.status + \"  archived_as=\" + (res.result && res.result.archived_as));
  console.log(\"  误改后长度: \" + fsMod.readFileSync(\"/dot/home/MEMORY.md\", \"utf8\").length);
}).catch(e => console.log(\"  失败: \" + e.message));
"' 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings

echo
echo "=== 3. .archive/ 里有没有原文 ==="
timeout 60 docker exec "$CID" sh -c 'ls -la /dot/home/.archive/ 2>&1 | head -5; echo "---最新的那份内容前2行---"; latest=$(ls /dot/home/.archive/ | sort | tail -1); head -2 "/dot/home/.archive/$latest" 2>&1' 2>&1

echo
echo "=== 4. 模拟恢复 ==="
timeout 120 docker exec "$CID" sh -c '
latest=$(ls /dot/home/.archive/ | grep MEMORY | sort | tail -1)
if [ -n "$latest" ]; then
  cp "/dot/home/.archive/$latest" /dot/home/MEMORY.md
  echo "  已从 .archive/$latest 恢复"
  wc -c /dot/home/MEMORY.md
  head -2 /dot/home/MEMORY.md
else
  echo "  ❌ 没找到归档"
fi' 2>&1
