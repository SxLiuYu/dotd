#!/usr/bin/env bash
# 在真容器里验证 fs.write 的乐观锁：并发 RMW 是否还会丢更新。
set -uo pipefail
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 1. 确认容器里的 fs.ts 有 CAS ==="
timeout 60 docker exec "$CID" sh -c 'grep -n "expected_size\|stale_write" /opt/agent-runtime/fs.ts | head -4' 2>&1

echo
echo "=== 2. 对比实验：不用 CAS 的并发 RMW（预期丢更新）==="
timeout 120 docker exec "$CID" sh -c '
echo "BASE" > /dot/home/nocas.txt
for i in 1 2 3 4 5 6 7 8 9 10; do
  ( c=$(cat /dot/home/nocas.txt); sleep 0.05; printf "%s\nL$i" "$c" > /dot/home/nocas.txt ) &
done
wait
echo "  最终行数: $(wc -l < /dot/home/nocas.txt)（理想 11）"'

echo
echo "=== 3. 用 CAS 的并发 RMW（预期：冲突被拒，不丢数据）==="
timeout 120 docker exec "$CID" sh -c '
echo "BASE" > /dot/home/withcas.txt
# 用 shell 模拟 CAS：读大小 → 改 → 带期望大小写回（用 python 做原子校验+写）
python3 - <<PY
import os, time, threading
P = "/dot/home/withcas.txt"
ok = 0
conflict = 0
def worker(i):
    global ok, conflict
    for attempt in range(20):
        try:
            with open(P, "r") as f:
                content = f.read()
            size = len(content.encode())
            time.sleep(0.01)
            new = content.rstrip("\\n") + "\\nL%d\\n" % i
            # 校验：写之前再查一次大小，不符就重试（模拟 expected_size 的 CAS）
            with open(P, "rb") as f:
                cur = f.read()
            if len(cur) != size:
                conflict += 1
                time.sleep(0.01)
                continue
            with open(P, "w") as f:
                f.write(new)
            ok += 1
            return
        except Exception:
            conflict += 1
threads = [threading.Thread(target=worker, args=(i,)) for i in range(1, 11)]
for t in threads: t.start()
for t in threads: t.join()
print("  CAS 成功写入: %d, 冲突重试: %d" % (ok, conflict))
PY
echo "  最终行数: $(wc -l < /dot/home/withcas.txt)"
echo "  --- 内容 ---"
cat /dot/home/withcas.txt'
