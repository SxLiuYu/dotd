#!/usr/bin/env bash
# 验证 CAS 在真实并发冲突下能正确保护（不依赖模型自觉，直接构造冲突）
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 场景：A 读到文件 → B 抢先改了 → A 带旧 expected_size 写回 ==="
timeout 120 docker exec "$CID" sh -c '
# 准备文件
echo "ORIGINAL" > /dot/home/cas-demo.txt
size_before=$(stat -c %s /dot/home/cas-demo.txt)
echo "  A 读到 size=$size_before"

# B 抢先修改
echo "MODIFIED-BY-B" > /dot/home/cas-demo.txt
echo "  B 抢先改成: $(cat /dot/home/cas-demo.txt)"

# A 用旧的 expected_size 写回（走 fs.write 的 CAS 路径）
node -e "
const size = Number(process.argv[1]);
fetch(\"http://127.0.0.1:5911/jobs/start\", {
  method: \"POST\",
  headers: { \"Content-Type\": \"application/json\" },
  body: JSON.stringify({
    tool: \"fs.write\",
    args: { path: \"/dot/home/cas-demo.txt\", content: \"WRITTEN-BY-A\", expected_size: size }
  }),
  signal: AbortSignal.timeout(5000)
}).then(r => r.json()).then(j => console.log(\"  A 写入结果:\", JSON.stringify(j).slice(0,200)))
 .catch(e => console.log(\"  (容器内无 API 端口，跳过：\" + e.message + \")\"))
" "$size_before"

echo "  最终内容: $(cat /dot/home/cas-demo.txt)"
' 2>&1

echo
echo "=== 用 python 直接调用 fs.ts 的 CAS 逻辑（更直接）==="
timeout 120 docker exec "$CID" sh -c '
cd /opt/agent-runtime && node --experimental-strip-types -e "
import(\"./fs.ts\").then(m => {
  const fs = new m.FsTools({ homeRoot: \"/dot/home\" });
  const p = \"/dot/home/cas-direct.txt\";
  require(\"node:fs\").writeFileSync(p, \"ORIGINAL\");
  const size = require(\"node:fs\").statSync(p).size;
  console.log(\"  读到 size=\" + size);
  require(\"node:fs\").writeFileSync(p, \"MODIFIED-BY-B\");
  const res = fs.write(\"c1\", { path: \"/dot/home/cas-direct.txt\", content: \"WRITTEN-BY-A\", expected_size: size });
  console.log(\"  写入结果: \" + JSON.stringify(res).slice(0, 220));
  console.log(\"  最终内容: \" + require(\"node:fs\").readFileSync(p, \"utf8\").trim());
}).catch(e => console.log(\"  导入失败: \" + e.message));
"' 2>&1 | head -12
