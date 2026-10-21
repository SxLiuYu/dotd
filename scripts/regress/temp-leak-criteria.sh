#!/usr/bin/env bash
# 全局临时目录净增长判据（2026-10-21 从 tests/temp-cleanup.test.ts 挪出）。
# 原因：node --test 并行跑文件时，别的文件的同前缀目录会在「before↔after」窗口内
# 涨落，把文件内的计数判据误伤（单跑恒绿、全量偶红）。套件级前后计数天然串行：
# 跑完套件后还多出来的 dotd-test-* 就是真泄漏（没人删的），确定性成立。
# 用法：bash scripts/regress/temp-leak-criteria.sh   （内含一次全量套件，约 10 分钟）
set -u
cd "$(dirname "$0")/../.."
BEFORE=$(ls -d /tmp/dotd-test-* 2>/dev/null | wc -l)
node --import tsx --test tests/*.test.ts > /tmp/leak-suite.txt 2>&1
SUITE=$?
AFTER=$(ls -d /tmp/dotd-test-* 2>/dev/null | wc -l)
PASS=$(grep -E "^ℹ pass" /tmp/leak-suite.txt | tail -1 | grep -o "[0-9]*")
FAIL=$(grep -E "^ℹ fail" /tmp/leak-suite.txt | tail -1 | grep -o "[0-9]*")
echo "suite: pass=$PASS fail=$FAIL (exit=$SUITE)"
echo "dotd-test-*: $BEFORE -> $AFTER"
t() { echo "  $2: $1"; }
t "$([ "$AFTER" -le "$BEFORE" ] && echo PASS || echo "FAIL 泄漏 $((AFTER - BEFORE)) 个")" "全局临时目录净增长 ≤ 0（没人删的 = 泄漏）"
[ "$SUITE" -eq 0 ] && [ "$AFTER" -le "$BEFORE" ]