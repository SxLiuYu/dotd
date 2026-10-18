#!/usr/bin/env bash
# 重建容器后检查家目录状态 + 验证防清空保护
set -uo pipefail
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 1. 家目录文件 ==="
timeout 60 docker exec "$CID" sh -c 'ls -la /dot/home/ | head -12' 2>&1

echo
echo "=== 2. MEMORY.md 是否还在 ==="
timeout 60 docker exec "$CID" sh -c 'wc -c /dot/home/MEMORY.md 2>&1; echo "---前3行---"; head -3 /dot/home/MEMORY.md 2>&1' 2>&1

echo
echo "=== 3. 验证防清空保护 ==="
timeout 120 docker exec "$CID" sh -c '
cd /opt/agent-runtime && node --experimental-strip-types -e "
import(\"./fs.ts\").then(m => {
  const fsMod = require(\"node:fs\");
  const p = \"/dot/home/guard-test.txt\";
  fsMod.writeFileSync(p, \"IMPORTANT CONTENT\");
  const tools = new m.FsTools({ homeRoot: \"/dot/home\" });
  const res = tools.write(\"g1\", { path: \"/dot/home/guard-test.txt\", content: \"\" });
  console.log(\"  空内容覆盖结果: \" + JSON.stringify(res).slice(0, 180));
  console.log(\"  文件内容: \" + fsMod.readFileSync(p, \"utf8\"));
  const res2 = tools.write(\"g2\", { path: \"/dot/home/guard-test.txt\", content: \"NEW\" });
  console.log(\"  正常覆盖结果: \" + res2.status);
  console.log(\"  文件内容: \" + fsMod.readFileSync(p, \"utf8\"));
}).catch(e => console.log(\"  失败: \" + e.message));
"' 2>&1 | head -12
