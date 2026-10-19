/**
 * tests/runner-alternating-loop.test.ts —— 交替调用绕开重复守卫（2026-10-19）。
 *
 * 现场：一个"查 https://api.github.com/zen 并存到 zen-note.md"的真实任务
 * 跑满 25 步还没写文件，模式是：
 *
 *   net.get(zen) → fs.stat(note 不存在) → net.get(zen) → fs.stat(note 不存在) → …
 *
 * 每一步**单独看都是新调用**（参数不同、工具不同），所以原来只认
 * "同一 (工具,参数)" 的重复守卫完全沉默，模型就这么一直空转。
 *
 * 修法：额外跟踪"每任务 × 每工具"的调用次数；同一工具达到 6 次时回喂一条
 * "你已经拿到信息了，别再查，去完成目标"的注记。
 *
 * 这里不驱动整个 Runner（太重），直接验证**计数与注记的判定逻辑**在
 * 交替调用模式下会触发——即"守卫能返回另一个答案"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 抽出来的判定规则（与 src/runner/dot.ts checkRepeat 中的增量逻辑同构）：
 * 同一工具第 6 次调用且属于"只读查询类"时给出提示。
 */
const GUARDED_TOOLS = new Set(['net.get', 'fs.stat']);
const THRESHOLD = 6;

function makeCounter() {
  const perTool = new Map<string, number>();
  return {
    hit(tool: string): string | null {
      const n = (perTool.get(tool) ?? 0) + 1;
      perTool.set(tool, n);
      if (n === THRESHOLD && GUARDED_TOOLS.has(tool)) {
        return `【检查方向】${tool} 已调用 ${n} 次`;
      }
      return null;
    },
  };
}

test('交替调用：net.get 与 fs.stat 各 6 次时都能触发提示', () => {
  const c = makeCounter();
  const hits: string[] = [];

  // 模拟真实序列：A B A B A B A B A B A B（各 6 次）
  for (let i = 0; i < 6; i += 1) {
    const a = c.hit('net.get');
    const b = c.hit('fs.stat');
    if (a !== null) hits.push(a);
    if (b !== null) hits.push(b);
  }

  assert.equal(hits.length, 2, `交替调用本身不会因"相同调用"触发，但工具计数应各触发一次；实际 ${hits.length}`);
  assert.ok(
    hits.some((h) => h.includes('net.get')),
    'net.get 6 次必须提示——这正是现场空转的那个工具',
  );
});

test('不误伤：正常批量操作（每工具 ≤5 次）不触发', () => {
  const c = makeCounter();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(c.hit('net.get'), null, '第 5 次不该触发');
    assert.equal(c.hit('fs.stat'), null, '第 5 次不该触发');
  }
});

test('不误伤：写操作类工具不在计数护栏范围内', () => {
  const c = makeCounter();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(c.hit('fs.write'), null, 'fs.write 可能有合法的多次写入，不该被工具计数拦');
  }
});
