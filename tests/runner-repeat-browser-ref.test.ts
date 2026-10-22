import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResultForRepeatForTest as norm } from '../src/runner/dot.ts';

/**
 * 「同结果」判据被 browser.snapshot 的 ref 编号击穿（2026-10-22 真机）。
 *
 * 现场：一个「读电商站前 3 个商品名」的任务，模型连开 3 轮
 *   open → snapshot → open → snapshot → open → snapshot（共 15 步才收尾）。
 * 三轮 snapshot 的**页面内容完全一样**，但 ref 编号每轮整体上移 90：
 *   #0 ref=e1,e2,e3   #1 ref=e91,e92,e93   #2 ref=e181,e182,e183
 * 字符串比较自然全不相等 → sameResultCount 永远停在 1 → 护栏一声不响。
 *
 * 为什么 ref 会递增：agent-browser 的 @eN 是**会话内单调递增**的引用，
 * 重新 open 一次就往前推一段。页面没变，编号变了。
 *
 * 这与 2026-10-18 那个 written_at 缺陷是**同一类**：
 * 「每次都不一样、但不代表进展」的字段让"结果相同"判据形同虚设。
 * 那次修的是顶层键；这次的在 output 字符串**内部**，顶层过滤够不着。
 *
 * 归一化必须做到：只换 ref 编号、不动其余文本，保证
 * 「同一页面两次快照」判为相同，「两个不同页面」仍判为不同。
 */
test('repeat 归一化：snapshot 的 ref 编号递增不算「结果变化」', () => {
  const page = (base: number) =>
    `- link "Skip to navigation" [ref=e${base}]\n` +
    `- link "Skip to content" [ref=e${base + 1}]\n` +
    `- link "Shop" [ref=e${base + 8}]\n` +
    `- link "Abominable Hoodie Abominable Hoodie $69.00" [ref=e${base + 17}]`;

  const a = norm({ output: page(1) });
  const b = norm({ output: page(91) });
  const c = norm({ output: page(181) });

  assert.equal(a, b, `同一页面（仅 ref 编号不同）应判为同结果：\n  ${a}\n  ${b}`);
  assert.equal(b, c, '第三次快照也应与第一次相同');
});

test('repeat 归一化：真的换了页面仍要判为不同', () => {
  const pageA = '- link "Abominable Hoodie $69.00" [ref=e1]\n- button "Search" [ref=e2]';
  const pageB = '- link "Adrienne Trek Jacket $57.00" [ref=e1]\n- button "Search" [ref=e2]';
  assert.notEqual(norm({ output: pageA }), norm({ output: pageB }), '不同页面的商品不同，不该被归一成一样');
});

test('repeat 归一化：ref 之外的文本一个字都不能动', () => {
  const s = norm({ output: '- link "Abominable Hoodie $69.00" [ref=e42]' });
  assert.ok(s.includes('Abominable Hoodie $69.00'), '商品名与价格必须原样保留');
  assert.ok(s.includes('link'), '角色名必须保留');
  assert.ok(!s.includes('e42'), 'ref 的具体编号应被抹平（否则跨轮比较仍失败）');
});

test('repeat 归一化：带前缀的 ref 写法也要抹平（真机漏掉的那种）', () => {
  // 真机数据里 ref 有两种出现形式，第一种正则漏掉了第二种：
  //   - link "Shop" [ref=e374]              ← 这个替换到了
  //   - heading "Shop" [level=1, ref=e374]  ← 这个没替换，于是两轮仍判不同
  // 结果是：单元测试绿了，真机还是重复 3 轮。这里把真机那一行原样搬过来锁住。
  const a = norm({ output: '- heading "Shop" [level=1, ref=e374]' });
  const b = norm({ output: '- heading "Shop" [level=1, ref=e464]' });
  assert.equal(a, b, '带 level= 前缀的 ref 也必须被抹平，否则跨轮比较仍失败');
  assert.ok(a.includes('level=1'), 'level 属性本身要保留（它是内容，不是易变记号）');
  assert.ok(a.includes('Shop'), '元素名要保留');
});

test('repeat 归一化：真机三段快照相减后必须相等', () => {
  // 取自 tk_mvjtrrcs4neczl 的真实三次快照（已抹掉具体编号），
  // 含 [ref=eN] 与 [level=1, ref=eN] 两种写法混排。
  const page = (base: number) =>
    `- link "My account" [ref=e${base}]` +
    `\n- heading "Shop" [level=1, ref=e${base + 13}]` +
    `\n- combobox "Shop order" [expanded=false, ref=e${base + 16}]: Default sorting`;
  const a = norm({ output: page(361) });
  const b = norm({ output: page(451) });
  const c = norm({ output: page(541) });
  assert.equal(a, b);
  assert.equal(b, c);
});