/**
 * tests/screenshot-path.test.ts —— 截图路径解析（2026-10-21 修的静默失效）
 *
 * 现场：checklist B1 要求「进度推送里接真截图」。代码看着接好了：
 * `readHomeFile` 读图、`sendImage` 发图、`decideScreen` 去重三件齐备。
 * 真跑一个 `browser.open` + `browser.screenshot` 的任务，进度推了 7 次，
 * **一张图都没发出去**，日志里连一行「读图失败」都没有 —— 因为
 * `sendShot` 压根没被调用。
 *
 * 根因在 `screenshotPathOf`：它只认 `{path}` 和 `{result:{path}}`，
 * 而 `steps.result_json` 实际存的是
 *   {"output":"{\"path\":\"/dot/home/screenshots/x.png\",\"bytes\":67006}"}
 * —— 工具输出先被字符串化、又包了一层。于是永远返回 null。
 *
 * 这组用例把真实形状钉死。注意第一条：它抄的是**生产库里捞出来的原文**，
 * 不是我想象的形状 —— 这种"我以为是 A 实际是 B"的 bug，只有抄原文才防得住。
 */
import { screenshotPathOf } from '../src/surfaces/screenshot-push.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const D = '/dot/home/screenshots/';

console.log('');
console.log('  真实形状（生产库原文）');

// 这一条如果挂了，说明工具输出形状变了，B1 又会静默失效
const REAL = '{"output":"{\\"path\\":\\"/dot/home/screenshots/shot-mvhqow41.png\\",\\"bytes\\":67006}"}';
ok('二次编码的 output 能解出来', screenshotPathOf(REAL) === D + 'shot-mvhqow41.png', String(screenshotPathOf(REAL)));

// 上面那个常量是双重转义写法，等价但难读；这里用单次转义再验一遍，
// 确保测试本身没写错（否则测的是"我构造错了"而不是"代码能解析"）。
const REAL2 = JSON.stringify({
  output: JSON.stringify({ path: '/dot/home/screenshots/shot-mvhqow41.png', bytes: 67006 }),
});
ok('构造等价的 raw 也解得出', screenshotPathOf(REAL2) === D + 'shot-mvhqow41.png', REAL2.slice(0, 60));
ok('两个 raw 形式一致', screenshotPathOf(REAL) === screenshotPathOf(REAL2));

console.log('');
console.log('  兼容旧形状（不能因为修一个 shape 就把另一个弄坏）');

ok('直挂 path', screenshotPathOf(JSON.stringify({ path: D + 'a.png' })) === D + 'a.png');
ok('result.path', screenshotPathOf(JSON.stringify({ result: { path: D + 'b.png' } })) === D + 'b.png');
ok(
  'output 里再套 result.path',
  screenshotPathOf(JSON.stringify({ output: JSON.stringify({ result: { path: D + 'c.png' } }) })) === D + 'c.png',
);

console.log('');
console.log('  边界：解不出来就返回 null（绝不猜、绝不拼路径）');

ok('坏 JSON → null', screenshotPathOf('{not json') === null);
ok('空字符串 → null', screenshotPathOf('') === null);
ok('没有 path 字段 → null', screenshotPathOf(JSON.stringify({ bytes: 1 })) === null);
ok('path 不是字符串 → null', screenshotPathOf(JSON.stringify({ path: 42 })) === null);
ok('path 在别处（不在 screenshots 目录）→ null', screenshotPathOf(JSON.stringify({ path: '/etc/passwd' })) === null);
ok('output 里是坏 JSON → null', screenshotPathOf(JSON.stringify({ output: '{"path":' })) === null);
ok('output 不是字符串 → null', screenshotPathOf(JSON.stringify({ output: { path: D + 'x.png' } })) === null);
// 防递归炸：深度超过 3 层就停
let deep = JSON.stringify({ path: D + 'deep.png' });
for (let i = 0; i < 6; i++) deep = JSON.stringify({ output: deep });
ok('超深嵌套不递归到爆栈，返回 null', screenshotPathOf(deep) === null);

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
