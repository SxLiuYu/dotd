/**
 * tests/runner-cache-lifecycle.test.ts —— Runner 里按 taskId 累积的缓存必须随任务终态释放。
 *
 * 现场（2026-10-19 审计）：`Runner` 里有一组 `Map<taskId, ...>` 的护栏状态：
 *
 *   repeatGuard          ✅ resetRepeatGuard 里 delete
 *   repeatSkipsByTask    ✅ resetRepeatGuard 里 delete
 *   toolCallCounts       ❌ 只有 set，从来没有 delete —— 每个任务留一条永不释放
 *
 * daemon 是常驻进程，这类"按任务累积却不清理"的 Map 会让内存随任务数单调增长。
 * 实测 524 个任务时影响还小，但性质上是泄漏，且三个缓存生命周期完全一致，
 * 漏一个没有理由。
 *
 * 这个测试做源码守卫：凡是 `Map<taskId` 形态的字段，都要在清理函数里出现。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

/** 取出 resetRepeatGuard 的函数体（代码行，剥注释）。 */
function cleanupBody(): string {
  const idx = src.indexOf('private resetRepeatGuard(');
  assert.ok(idx > 0, 'dot.ts 里应有 resetRepeatGuard');
  const window = src.slice(idx, idx + 1200);
  return window
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

test('按 taskId 累积的三组缓存都随任务终态释放', () => {
  const body = cleanupBody();
  // A1：模块级浏览器身份表同样随任务终态释放（不在 this. 上，单独判）
  assert.ok(
    /browserIdentityByTask\.delete\(taskId\)/.test(body),
    'browserIdentityByTask 应在 resetRepeatGuard 里被 delete',
  );
  for (const field of ['repeatGuard', 'repeatSkipsByTask', 'toolCallCounts']) {
    assert.ok(
      new RegExp(`this\\.${field}\\.delete\\(taskId\\)`).test(body),
      `${field} 应在 resetRepeatGuard 里被 delete —— 否则常驻进程内存随任务数单调增长`,
    );
  }
});

test('没有遗漏：所有 Map<taskId 形态的字段都在清理函数里', () => {
  // 收集「按 taskId 累积」的字段名：形如 new Map<string, ...> 且名字里带 task 语义，或已确认的清单
  const declared = [...src.matchAll(/private (?:readonly )?(\w+)\s*=\s*new Map<string, Map<string, number>>\(\)/g)]
    .map((m) => m[1]!)
    .filter((n) => /toolCallCounts|repeatGuard/i.test(n));
  for (const field of declared) {
    assert.ok(
      cleanupBody().includes(`this.${field}.delete(taskId)`),
      `声明的按任务缓存 ${field} 未被清理`,
    );
  }
});
