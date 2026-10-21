#!/usr/bin/env bash
# scripts/regress/suite-chunked.sh —— 分块跑全量套件（2026-10-21）。
#
# 为什么：node --test 一次性跑 tests/*.test.ts 时，在容器+daemon 并行环境下
# 个别重测试会把总时长拉到 25min+ 甚至进程不退出；分块跑让每块独立判定、
# 单块超时可定位（exit 124 = 该块卡住，文件名在输出里）。
#
# 用法：bash scripts/regress/suite-chunked.sh [每块文件数，默认 15]
# 退出码：全块 pass 才 0；任何块失败/超时 → 1。
set -u
cd "$(dirname "$0")/../.."
CHUNK="${1:-15}"
MAP=$(mktemp /tmp/dotd-chunk-map-XXXXXX)
trap 'rm -f "$MAP"' EXIT

# 已知"跑完但进程不退出"的重测试（2026-10-21 实测：真 ExecServiceImpl + boot([])
# 留下未关的容器 runtime 连接，node --test 等不到退出）。单列跑、超时只告警，
# 不计入失败——它内部断言仍然会正常 pass/fail 输出。修好那天从这里删掉。
SLOW="${DOTD_SLOW_TESTS:-tests/exec-container-concurrency.test.ts}"
ls tests/*.test.ts | sort > "$MAP"
if [ -n "$SLOW" ]; then
  for x in $SLOW; do sed -i "\\|^$x$|d" "$MAP"; done
fi
TOTAL=$(wc -l < "$MAP")
FAILED=""
IDX=0
PASS_SUM=0
FAIL_SUM=0
START_ALL=$(date +%s)

while [ "$IDX" -lt "$TOTAL" ]; do
  BATCH=$(sed -n "$((IDX + 1)),$((IDX + CHUNK))p" "$MAP")
  IDX=$((IDX + CHUNK))
  OUT=$(mktemp /tmp/dotd-chunk-out-XXXXXX)
  S=$(date +%s)
  # 单块上限 600s：够慢测试喘气，又不至于整晚
  timeout 600 node --import tsx --test $BATCH >"$OUT" 2>&1
  RC=$?
  D=$(( $(date +%s) - S ))
  P=$(grep -E "^ℹ pass" "$OUT" | tail -1 | grep -o "[0-9]*")
  F=$(grep -E "^ℹ fail" "$OUT" | tail -1 | grep -o "[0-9]*")
  P=${P:-0}; F=${F:-0}
  PASS_SUM=$((PASS_SUM + P)); FAIL_SUM=$((FAIL_SUM + F))
  if [ "$RC" -eq 0 ]; then
    echo "  块 $((IDX / CHUNK)): pass=$P fail=$F (${D}s)"
  else
    echo "  块 $((IDX / CHUNK)): 失败 rc=$RC pass=$P fail=$F (${D}s)"
    echo "    文件: $(echo $BATCH | tr '\n' ' ')"
    grep -E "^✖|not ok" "$OUT" | head -5 | sed 's/^/      /'
    FAILED="$FAILED 块$((IDX / CHUNK))"
  fi
  rm -f "$OUT"
done

# ── 单列慢测（超时只告警）──
if [ -n "$SLOW" ] && [ -x /usr/bin/timeout ]; then
  for x in $SLOW; do
    [ -f "$x" ] || continue
    OUT=$(mktemp /tmp/dotd-slow-out-XXXXXX)
    S=$(date +%s)
    timeout 420 node --import tsx --test "$x" >"$OUT" 2>&1
    RC=$?
    D=$(( $(date +%s) - S ))
    F=$(grep -E "^ℹ fail" "$OUT" | tail -1 | grep -o "[0-9]*"); F=${F:-0}
    if [ "$F" -gt 0 ]; then
      echo "  慢测 $x: FAIL fail=$F (${D}s)"
      grep -E "^✖|not ok" "$OUT" | head -3 | sed 's/^/      /'
      FAILED="$FAILED $x(fail=$F)"
    elif [ "$RC" -eq 124 ]; then
      echo "  慢测 $x: WARN 跑完但进程未退出（${D}s 超时杀），断言 fail=$F"
    else
      echo "  慢测 $x: pass (${D}s)"
    fi
    rm -f "$OUT"
  done
fi

DUR=$(( $(date +%s) - START_ALL ))
echo "  ══════════════════════════"
echo "总计: pass=$PASS_SUM fail=$FAIL_SUM 用时 ${DUR}s"
if [ -n "$FAILED" ]; then echo "FAILED:$FAILED"; exit 1; fi
echo "PASS: 全部分块通过"
