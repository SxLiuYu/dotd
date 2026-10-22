/**
 * tests/exec-image-drift.test.ts —— F9 镜像漂移判定（2026-10-22）。
 *
 * 为什么单独测：现场 bug 是「容器在跑就采纳，不看它跑的是哪个镜像」，换基座形同没做
 * （handoff §7.1「说上线了而实际没上线」）。判定逻辑抽成纯函数 imageDrift/isImageDigest
 * 放 protocol.ts，调用点在 fleet.ts 的 reconcile 采纳分支 —— 本文件测纯函数的判定，
 * 并有一条源码级断言钉住「调用点确实调了它」（本轮项目吃过两次「函数对但没人调用」的亏）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { imageDrift, isImageDigest } from '../src/exec/protocol.ts';

const REAL = 'sha256:' + 'a'.repeat(64);
const REAL2 = 'sha256:' + 'b'.repeat(64);

test('isImageDigest：认 sha256: + 64 hex，其余当 tag', () => {
  assert.equal(isImageDigest(REAL), true);
  assert.equal(isImageDigest('sha256:ABC' + '0'.repeat(61)), true, '大写 hex 也算');
  assert.equal(isImageDigest('dotd/exec:slim-0.1.0'), false);
  assert.equal(isImageDigest('sha256:tooshort'), false);
  assert.equal(isImageDigest(''), false);
});

test('imageDrift：同种标识、值不同 → 漂移', () => {
  assert.equal(imageDrift(REAL, REAL2), true, 'digest 对 digest，不同 = 漂移');
  assert.equal(imageDrift('dotd/exec:slim-0.1.0', 'dotd/exec:1.49.1-0.1.0'), true, 'tag 对 tag，不同 = 漂移');
});

test('imageDrift：同种标识、值相同 → 不漂移', () => {
  assert.equal(imageDrift(REAL, REAL), false);
  assert.equal(imageDrift('dotd/exec:slim-0.1.0', 'dotd/exec:slim-0.1.0'), false);
});

test('imageDrift：任一侧空/缺字段 → 不漂移（没证据不重建生产容器）', () => {
  assert.equal(imageDrift(REAL, undefined), false, 'stub 后端拿不到 ImageID');
  assert.equal(imageDrift(REAL, null), false);
  assert.equal(imageDrift(undefined, REAL), false);
  assert.equal(imageDrift(REAL, ''), false, '空串不是证据');
  assert.equal(imageDrift('', REAL), false);
});

test('imageDrift：digest 与 tag 混比 → 一律不漂移（防每次 boot 重建）', () => {
  // 这是 2026-10-22 lead 自己先写错的一种：want 退化成 tag 却去比容器 ImageID，恒不相等
  // → 每次 boot 都判漂移、每次重建，比原 bug 更糟。混比必须短路成"没漂移"。
  assert.equal(imageDrift(REAL, 'dotd/exec:slim-0.1.0'), false);
  assert.equal(imageDrift('dotd/exec:slim-0.1.0', REAL), false);
});

/** 取 boot() 函数体（reconcile 的采纳逻辑都在里面），避免匹配到别处的同名符号。 */
function bootBody(src: string): string {
  const start = src.indexOf('  async boot(');
  assert.notEqual(start, -1, 'fleet.ts 必须仍有 boot()');
  const end = src.indexOf('\n  /** ', start + 10);
  assert.notEqual(end, -1, 'boot() 函数体必须能定界');
  return src.slice(start, end);
}

test('调用点接线：漂移判定必须**先于**采纳（imageDrift 被调用且顺序在 adopted.push 之前）', () => {
  // 源码级断言：本轮项目吃过两次「函数对但无人调用」的亏（resolveExecution、clipForFeishu）。
  // 这里故意不匹配整行文本（改动条件表达式就会误报），而是钉住**语义顺序**：
  //   imageDrift( 出现的位置 < 第一个 report.adopted.push 的位置
  // 谁把漂移检查挪到采纳之后、或整段删掉，这条都会红。
  const src = readFileSync(fileURLToPath(new URL('../src/exec/fleet.ts', import.meta.url)), 'utf8');
  const body = bootBody(src);
  const atDrift = body.indexOf('imageDrift(want, got)');
  const atAdopt = body.indexOf('report.adopted.push');
  assert.notEqual(atDrift, -1, 'boot() 里必须调用 imageDrift');
  assert.notEqual(atAdopt, -1, 'boot() 里必须有采纳路径（本断言的前提）');
  assert.ok(atDrift < atAdopt, `漂移判定必须在采纳之前：imageDrift@${atDrift} vs adopted.push@${atAdopt}`);
  assert.match(body, /isImageDigest\(want\)\s*\?\s*match\.ImageID\s*:\s*match\.Image/, '期望是 digest 取容器 ImageID、是 tag 取 Image');
  assert.match(body, /canTransition\(row\.state, 'removed'\)/, '重建前必须确认当前状态能安全走 recreate（否则一次漂移会变成一条 boot 失败）');
});

test('调用点接线：reapOldImages 删镜像前必须问过「有没有容器在用」（F4）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/exec/image.ts', import.meta.url)), 'utf8');
  const atQuery = src.indexOf('listContainerImages()');
  const atRemove = src.indexOf('this.deps.backend.removeImage(b.tag)');
  assert.notEqual(atQuery, -1, '回收前必须查询在用镜像');
  assert.ok(atQuery < atRemove, '查询必须在 removeImage 之前');
  assert.match(src, /canSeeContainers/, '查询失败时必须当作"不许删"（保守分支必须存在）');
});