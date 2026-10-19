/**
 * tests/exec-sync-deadline-consistency.test.ts —— sync 工具的 max_deadline_ms 必须 ≥ 派发档。
 *
 * 这个坑踩了三次（2026-10-19）：
 *   ① fs.remove        设 15_000 → 模型按默认节奏传更长值 → deadline_too_long
 *   ② tool.create      设 30_000 → 同上
 *   ③ tool.list        设 10_000 → **模型根本没传 deadline**，是 Runner 给 sync 工具
 *                        统一派 syncTierMs(=60s)，而校验取 min(10_000, asyncDeadline)=10_000
 *                        → 系统自己派的值超了自己的上限
 *
 * 根因是一致性问题：Runner 对 `mode==='sync'` 的工具一律派 `syncTierMs`，
 * 所以任何 sync 工具的 `max_deadline_ms` 只要小于该值，就**必然**被自己的校验拒掉。
 *
 * 这个测试把"声明值"与"派发值"钉在一起。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPABILITY_CATALOG } from '../src/exec/protocol.ts';
import { toolDeadlineMsFor } from '../src/runner/dot.ts';

/** Runner 侧 sync 档的实际取值（EX §5.2 的 60s 档）。 */
const SYNC_TIER_MS = 60_000;

test('每个 sync 工具的 max_deadline_ms 都不小于 Runner 派发档（否则必然被自己的校验拒）', () => {
  const offenders: string[] = [];
  for (const cap of CAPABILITY_CATALOG) {
    if (cap.mode !== 'sync') continue;
    const dispatched = toolDeadlineMsFor(SYNC_TIER_MS, {
      mode: cap.mode,
      maxDeadlineMs: cap.max_deadline_ms,
    });
    if (dispatched > cap.max_deadline_ms) {
      offenders.push(`${cap.name}: 派发 ${dispatched}ms > 声明上限 ${cap.max_deadline_ms}ms`);
    }
  }
  assert.deepEqual(offenders, [], '以下 sync 工具会把系统自己派发的 deadline 判成超限：\n  ' + offenders.join('\n  '));
});

test('sync 工具的派发值恒为 syncTierMs（钉住 toolDeadlineMsFor 的语义）', () => {
  const cap = CAPABILITY_CATALOG.find((c) => c.mode === 'sync');
  assert.ok(cap !== undefined, '目录里应有 sync 工具');
  assert.equal(
    toolDeadlineMsFor(SYNC_TIER_MS, { mode: 'sync', maxDeadlineMs: cap!.max_deadline_ms }),
    SYNC_TIER_MS,
  );
});

test('async 工具用自己声明的上限（不受 syncTierMs 影响）', () => {
  const asyncCap = CAPABILITY_CATALOG.find((c) => c.mode === 'async');
  assert.ok(asyncCap !== undefined, '目录里应有 async 工具');
  const dispatched = toolDeadlineMsFor(SYNC_TIER_MS, {
    mode: 'async',
    maxDeadlineMs: asyncCap!.max_deadline_ms,
  });
  assert.equal(dispatched, asyncCap!.max_deadline_ms);
});