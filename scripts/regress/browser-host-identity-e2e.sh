#!/usr/bin/env bash
# A1 宿主侧浏览器身份 实机验收（2026-10-21）
#
# 和 browser-identity-e2e.sh 的区别：那份验**容器内** playwright 的
# launchPersistentContext + /dot/profiles 卷；browser.* 已于 2026-10-21
# 改由宿主 agent-browser 承接，所以登录态走的是另一条路径（--session）。
#
# 证明什么：identity 从 runner 决议 → 顶层 call.identity 与 args.identity 双写
# → 宿主 legacyBrowser 读 args.identity 派生 session → 真实浏览器打开页面。
#
# 为什么必须实机跑：这条链路上有个只会在真实执行时暴露的坑 —— 曾在
# toolCall() 里剥掉 args.identity（防容器 400），而宿主身份 100% 从 args 读，
# 结果 runner 决议出 mysession、宿主只看到 undefined，静默退回匿名。
# 单测能钉住两个方向，但"真的打开了一个页面"只有实机能证。
#
# 前置：装好 agent-browser（which agent-browser）；能访问外网。
# 用法：bash scripts/regress/browser-host-identity-e2e.sh   （exit 0=全过）
set -u
cd "$(dirname "$0")/../.."
FAIL=0

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "  SKIP：没装 agent-browser（这条验收依赖它，不是代码坏了）"
  exit 0
fi

# 落在仓库根（import 相对路径才对得上），退出时删掉
DRIVER="./_host-id-e2e.$$.ts"
trap 'rm -f "$DRIVER"' EXIT

cat > "$DRIVER" <<'TS'
import { toolCall } from './src/runner/dot.ts';
import { ExecServiceImpl } from './src/exec/ExecService.ts';
import { legacyBrowser } from './src/exec/webtools.ts';

const svc: any = new ExecServiceImpl({ bus: { publish() {}, subscribe() {} } } as any);
// 与 daemon.ts 完全同形地注册（同一函数、同一参数形状）
for (const name of ['browser.open', 'browser.snapshot', 'browser.act', 'browser.screenshot', 'browser.close'] as const) {
  svc.registerHostTool(name, async (args: any, taskId?: string) => {
    const r = await legacyBrowser(name, (args ?? {}) as Record<string, unknown>, taskId);
    return r.ok ? { ok: true, value: r.output } : { ok: false, code: 'browser_error', message: r.error };
  });
}

const task: any = { id: 'host-id-e2e', dotId: 'dot1' };
const open = toolCall(task, 'c-open', 'browser.open', { url: 'https://example.com', identity: 'e2e-session' }, 60_000);

// ① toolCall 不许把 args.identity 剥掉（剥了宿主就退回匿名）
if ((open.args as any).identity !== 'e2e-session') {
  console.log('FAIL toolCall 把 args.identity 剥掉了，宿主将退回匿名会话');
  process.exit(1);
}
// ② 顶层 identity 按契约 G1 承载
if ((open as any).identity !== 'e2e-session') {
  console.log('FAIL 顶层 call.identity 丢了（契约 G1）');
  process.exit(1);
}

const r1 = await svc.runTool(open);
if (r1.status !== 'ok') {
  console.log('FAIL browser.open 失败: ' + JSON.stringify(r1.error));
  process.exit(1);
}
const out1 = String(r1.result);
if (!out1.includes('example.com')) {
  console.log('FAIL open 回包不含 URL: ' + out1.slice(0, 200));
  process.exit(1);
}

// ③ snapshot 不传身份 → 宿主继承表接上同一 session，返回真实页面元素
const snap = toolCall(task, 'c-snap', 'browser.snapshot', {}, 60_000);
const r2 = await svc.runTool(snap);
if (r2.status !== 'ok') {
  console.log('FAIL browser.snapshot 失败: ' + JSON.stringify(r2.error));
  process.exit(1);
}
const out2 = String(r2.result);
if (out2.trim() === '' || out2.includes('页面上没有可交互元素')) {
  console.log('FAIL snapshot 是空页 —— 会话没接上（身份没贯穿）');
  process.exit(1);
}

console.log('OK open=' + out1.split('\n')[0]);
console.log('OK snapshot ' + out2.trim().split('\n').length + ' 行');
TS

OUT="$(timeout 240 node --import tsx "$DRIVER" 2>&1)"
RC=$?

if [ $RC -ne 0 ]; then
  echo "  ✗ 宿主侧身份链路：rc=$RC"
  echo "$OUT" | head -20 | sed 's/^/    /'
  FAIL=1
else
  echo "$OUT" | sed 's/^/  ✓ /'
fi

if [ $FAIL -eq 0 ]; then
  echo "PASS 宿主侧浏览器身份链路（identity → args 双写 → session → 真实页面）"
else
  echo "FAIL 见上"
fi
exit $FAIL
