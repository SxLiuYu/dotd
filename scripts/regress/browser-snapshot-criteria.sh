#!/usr/bin/env bash
# browser-snapshot 判据（W1，2026-10-21）：模型"看"页面这条路必须真的通。
#
# ## 为什么需要它
# browser.snapshot 曾经是**契约与实现断裂**的典型：browser.ts 声明了
# `snapshot(): Promise<{text, html?}>`，server.ts 直接 `as unknown as
# BrowserContextLike` 强转 playwright 对象，类型检查通过；但容器里是
# playwright-core 1.49.1，它的 Page 上根本没有 snapshot()，也没有
# ariaSnapshot()（实测 getOwnPropertyNames 两者皆无）。结果模型每"看"一次
# 页面就 browser_crashed，等于瞎着眼上网。
#
# 修法：适配层（adaptContext/axSnapshot）走 CDP 的 Accessibility.getFullAXTree
# —— ariaSnapshot 内部的同一数据源 —— 手工渲染成缩进文本。
#
# ## 这个脚本验什么
#   ① 渲染规则单测（ignored 不切断子树 / StaticText 去重边界 / 截断）
#   ② 五层里 snapshot 仍在能力目录与 ToolDoc（别把工具改没了）
#   ③ 源码里不再有 page.snapshot() 这种对不存在 API 的直接调用
#   ④ tsc 无新增错误
#
# 用法：bash scripts/regress/browser-snapshot-criteria.sh   （约 30s）
set -u
cd "$(dirname "$0")/../.."
PASS=0
FAIL=0
t() {
  local out
  if out=$(eval "$1" 2>&1); then
    PASS=$((PASS + 1)); echo "  PASS $2"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL $2"; echo "$out" | head -4 | sed 's/^/       /'
  fi
}

echo "① 渲染规则单测"
t "node --import tsx --test tests/agent-runtime-axsnapshot.test.ts >/dev/null 2>&1" \
  "axSnapshot 6 条渲染规则全过"

echo "② 五层接线仍然在"
t "grep -q \"name: 'browser.snapshot'\" src/exec/protocol.ts" "能力目录仍有 browser.snapshot"
t "grep -q \"name: 'browser.snapshot'\" src/runner/tool-catalog.ts" "ToolDoc 仍有 browser.snapshot"
t "grep -q 'browser.snapshot' config/tools.yml" "tools.yml 仍有 browser.snapshot"
t "grep -q \"case 'browser.snapshot'\" agent-runtime/server.ts" "runtime 分发仍有 browser.snapshot"

echo "③ 不再调用不存在的 API"
t "grep -q 'await page.snapshot()' agent-runtime/server.ts" "分发点经适配层调 page.snapshot()（契约调用）"
t "grep -q \"prop === 'snapshot'\" agent-runtime/server.ts" "适配层给 page 注入了 snapshot（否则上面的调用会崩）"
t "! grep -q 'page\\.ariaSnapshot()' agent-runtime/server.ts" "server.ts 不再调此版本没有的 ariaSnapshot()"
t "grep -q 'Accessibility.getFullAXTree' agent-runtime/server.ts" "改用 CDP AX 树"
t "grep -q 'adaptContext' agent-runtime/server.ts" "适配层存在（不再裸强转）"

echo "④ tsc"
t "! npx tsc --noEmit 2>&1 | grep -q 'error TS'" "tsc 无新增错误"

echo "  ══════════════════════════"
echo "合计 $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && { echo "PASS: browser-snapshot-criteria 全过（$PASS/$PASS）"; exit 0; }
exit 1
