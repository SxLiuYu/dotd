#!/usr/bin/env bash
# 第二十一轮 D：验证 fs 层的 read-modify-write 竞态（真并发下会丢更新）。
#
# 这是分布式系统经典问题：两个写者各自 读全文 → 改 → 覆盖写，
# 后写的会覆盖先写的（lost update），除非有版本/锁/重试。
#
# 做法：直接用 shell 模拟两个进程同时做 RMW，看结果。
# 这测的是**存储层**，不依赖模型。
set -uo pipefail
CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 准备测试文件 ==="
timeout 60 docker exec "$CID" sh -c 'echo "BASE" > /dot/home/rmw.txt; cat /dot/home/rmw.txt' 2>&1

echo
echo "=== 模拟 10 个并发进程各自 RMW（读全文→追加→写回）==="
timeout 120 docker exec "$CID" sh -c '
for i in 1 2 3 4 5 6 7 8 9 10; do
  (
    # 经典的 lost-update 场景：读 → 改 → 写，中间无锁
    content=$(cat /dot/home/rmw.txt)
    sleep 0.05
    printf "%s\nLINE-$i" "$content" > /dot/home/rmw.txt
  ) &
done
wait
echo "--- 结果 ---"
cat /dot/home/rmw.txt
echo "--- 行数 ---"
wc -l < /dot/home/rmw.txt
' 2>&1

echo
echo "=== 对照：用 shell 的 >> 追加（原子）==="
timeout 60 docker exec "$CID" sh -c 'echo "BASE2" > /dot/home/rmw2.txt; for i in $(seq 1 10); do (echo "LINE-$i" >> /dot/home/rmw2.txt) & done; wait; wc -l < /dot/home/rmw2.txt' 2>&1

echo
echo "=== 结论 ==="
echo "  上面两个数字对比："
echo "    RMW 方式（读-改-写）：理论可能丢失更新（行数 < 11）"
echo "    >> 追加方式：应该正好 11 行（原子追加）"
echo "  这决定了：dotd 的记忆写入是否需要在并发下加保护。"
