/**
 * tests/temp-cleanup.test.ts —— 临时目录不泄漏（测试基建自检）。
 *
 * 背景（2026-10-17 live-proof 发现）：`%TEMP%` 里积了 4600+ 个 `dotd-test-*` 目录。
 * 逐个排查后的**真实根因不是** `tests/helpers.ts:cleanup()` 删不掉（实测先 `db.close()`
 * 再 `rmSync`，30/30 干净），而是**有些用例根本没调 cleanup**：
 * - `tests/governance-support.ts:makeGovFixture()` 额外 `mkdtempSync('dotd-gov-cfg-')`
 *   却从来没人删（每个 fixture 一个）；
 * - `tests/governance-review-catalog.test.ts:tmpYml()` 每个 yaml 一个临时目录；
 * - `tests/surfaces-channels-web-config.test.ts` 多处内联 `mkdtempSync` 当 filePath。
 *
 * 本文件守两件事：
 * 1. `cleanup()` 之后目录**确实不存在**（同一路径不得再次用到）；
 * 2. 用例忘了 cleanup 时，`sweepTempPaths()`（各文件 `test.after(sweepTempPaths)` 兜底）
 *    能把登记过的路径全部收干净——登记表本身也要证明会被清空。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  makeTempDataDir,
  forceRemoveTempPath,
  registerTempPath,
  removeTempPath,
  sweepTempPaths,
  liveTempPathCount,
} from './helpers.ts';

const CREATED: string[] = [];
before(() => {
  CREATED.length = 0;
});
after(() => {
  sweepTempPaths();
});

test('cleanup() 之后目录确实不存在（不留 dotd-test-*）', () => {
  const beforeCount = liveTempPathCount();
  const dirs = [makeTempDataDir(), makeTempDataDir(), makeTempDataDir()];
  const roots = dirs.map((d) => d.root);
  for (const r of roots) assert.ok(existsSync(r), `建库后目录应存在：${r}`);
  // 建库时就已经把 WAL/SHM 写进目录了：cleanup 必须先关库再删，否则 Windows 上 EBUSY/EPERM
  for (const d of dirs) d.cleanup();
  for (const r of roots) assert.equal(existsSync(r), false, `cleanup() 后目录必须消失：${r}`);
  // 重复 cleanup 安全（幂等），且不会把登记表越攒越大
  for (const d of dirs) d.cleanup();
  assert.equal(liveTempPathCount(), beforeCount + 3 - 3, '已删除的路径必须从登记表移除');
});

test('cleanup() 幂等：重复调用不抛错', () => {
  const d = makeTempDataDir();
  d.cleanup();
  assert.doesNotThrow(() => d.cleanup());
  assert.doesNotThrow(() => d.cleanup());
});

test('登记表兜底：忘调 cleanup 的路径也能被 sweepTempPaths() 收干净', () => {
  const d = makeTempDataDir();
  const forgotten = d.root;
  assert.ok(existsSync(forgotten));
  // 故意不调 d.cleanup()（模拟用例中途抛错/没写 finally）
  registerTempPath(forgotten); // makeTempDataDir 已登记，这里重复登记是幂等的
  assert.ok(liveTempPathCount() > 0);

  // 连接还开着时 Windows 上删不掉（WAL/SHM 句柄）——这是安全边界，sweep 会把它留在清单里。
  const stillHeld = sweepTempPaths();
  assert.ok(stillHeld.includes(forgotten), '连接未关的目录应被如实列为"删不掉"，而不是假装成功');

  // 兜底的正确姿势：先关（代持）连接，再删。
  assert.equal(forceRemoveTempPath(forgotten, () => d.db.close()), true, '关库后必须能删掉');
  assert.equal(existsSync(forgotten), false, '登记过的路径必须被删掉');
  // 兜底之后 cleanup() 仍要安全（句柄已随 sweep 关掉）
  assert.doesNotThrow(() => d.cleanup());
});

test('removeTempPath 自检：删成功返回 true，路径不存在也返回 true（幂等）', () => {
  const d = makeTempDataDir();
  const root = d.root;
  // 库连接开着时 Windows 删不掉（WAL/SHM 句柄）：先验证"如实返回 false"，再关库重试。
  d.db.close();
  assert.equal(removeTempPath(root), true, '关库后删除应确认目录不存在');
  assert.equal(existsSync(root), false);
  assert.equal(removeTempPath(root), true, '对已不存在的路径重复调用仍返回 true');
  assert.doesNotThrow(() => d.cleanup());
});

test('池模式：借还之间数据隔离，cleanup 后临时目录同样消失', () => {
  const a = makeTempDataDir({ pool: true });
  a.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire)
       VALUES ('ct_leak_probe', 'dot1', 't', 'p', '* * * * *', 1, 0)`,
    )
    .run();
  const rootA = a.root;
  a.cleanup();
  assert.equal(existsSync(rootA), false, '池模式下临时目录也要删掉（池库是内存库除外）');

  const b = makeTempDataDir({ pool: true });
  const rows = b.db.prepare('SELECT count(*) AS c FROM crontabs').get() as { c?: number } | undefined;
  assert.equal(rows?.c, 0, '复用的池库必须是空表（上一个用例的数据不得残留）');
  const uv = b.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  assert.equal(uv?.user_version, 140, '迁移终态 140（P1-3 加 FTS、第十三轮加 task_paused、第四十三轮加 outbound_log）');
  const rootB = b.root;
  b.cleanup();
  assert.equal(existsSync(rootB), false);
});
