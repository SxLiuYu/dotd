#!/usr/bin/env bash
# web-tools 判据（W2，2026-10-21）：宿主侧浏览器三件套必须真的能用。
#
# ## 为什么需要它
# 容器里的 net.get 只是 HTTP 客户端，遇到 JS 渲染的页面拿到的是一堆空壳
# （实测模型两次 net_get 都失败，只能答"没有拿到任何页面内容"）。browser.*
# 又只能在容器里猜 CSS 选择器，而容器 rootfs 只读、Chrome 进不了镜像。
#
# 解法是宿主侧的 agent-browser CLI（vercel-labs，GitHub 44.4k stars）：
# snapshot 返回带 @eN 引用的可交互元素，模型据此操作，不用猜选择器。
#
# ## 这个脚本验什么
#   ① 我们自己那层逻辑（URL 白名单/action 白名单/截断/错误话术）
#   ② 五层接线（catalog / HOST_SIDE_TOOLS / ToolDoc / tools.yml / registerHostTool）
#   ③ 真浏览器跑一次（若 agent-browser 可用）—— 端到端，不只是打桩
#
# 用法：bash scripts/regress/web-tools-criteria.sh   （约 40s）
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

echo "① 逻辑层单测"
t "node --import tsx --test tests/web-tools.test.ts >/dev/null 2>&1" \
  "web-tools 10 条（URL/action 白名单、截断、错误话术）全过"

echo "② 五层接线"
t "grep -q \"name: 'web.snapshot'\" src/exec/protocol.ts" "能力目录有 web.snapshot"
t "grep -q \"name: 'web.read'\" src/exec/protocol.ts" "能力目录有 web.read"
t "grep -q \"name: 'web.act'\" src/exec/protocol.ts" "能力目录有 web.act"
t "grep -q \"'web.snapshot', 'web.read', 'web.act'\" src/exec/ExecService.ts" "HOST_SIDE_TOOLS 已收录"
t "grep -q \"name: 'web.snapshot'\" src/runner/tool-catalog.ts" "ToolDoc 有 web.snapshot"
t "grep -q 'web.read' config/tools.yml" "tools.yml 有 web.read"
t "grep -q \"registerHostTool('web.act'\" src/daemon.ts" "daemon 已注册 web.act"
t "grep -q 'web.snapshot' tests/agent-runtime-protocol.test.ts" "宿主侧清单已登记（防漂移）"

echo "③ 真浏览器端到端（agent-browser 可用时）"
if command -v agent-browser >/dev/null 2>&1; then
  t "agent-browser read https://example.com 2>&1 | grep -qi 'documentation'" \
    "web.read 真实抓取 example.com 拿到正文"
  t "agent-browser snapshot -i 2>&1 | grep -q 'ref=e'" \
    "web.snapshot 真实返回带 @eN 引用的元素"
else
  echo "  SKIP agent-browser 未安装（npm i -g agent-browser && agent-browser install --with-deps）"
fi

echo "④ tsc"
t "! npx tsc --noEmit 2>&1 | grep -q 'error TS'" "tsc 无错误"

echo "  ══════════════════════════"
echo "合计 $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && { echo "PASS: web-tools-criteria 全过（$PASS/$PASS）"; exit 0; }
exit 1
