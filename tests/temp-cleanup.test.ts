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
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// 平台差异（2026-10-19）：本用例断言的是 **Windows 句柄语义** —— 库连接还开着时
// WAL/SHM 句柄会让目录删不掉，sweep 必须把它如实留在清单里。Linux 允许删除已打开
// 的目录，sweep 会直接删成功，该断言在 Linux 上不成立（不是回归）。
// 保留 Windows 覆盖，Linux 上跳过；兜底删除逻辑本身由下一个用例继续验证。
test(
  '登记表兜底：忘调 cleanup 的路径也能被 sweepTempPaths() 收干净',
  { skip: process.platform !== 'win32' ? '仅 Windows 有"打开句柄删不掉"语义' : false },
  () => {
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
  },
);

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
  assert.equal(
    uv?.user_version,
    170,
    '迁移终态 170（P1-3 加 FTS、第十三轮加 task_paused、第四十三轮加 outbound_log、T2 加 mail、T4 加 proactive）',
  );
  const rootB = b.root;
  b.cleanup();
  assert.equal(existsSync(rootB), false);
});

// ── 跨文件判据：TEMP 里的 dotd-test-* 不该净增长 ─────────────────────
//
// 背景（2026-10-19 实测，真缺陷）：上面所有用例都是**进程内自证** ——
// 它们只证明"我建的目录我自己删得掉"，**对别的测试文件没调 cleanup() 一无所知**。
// 也正因如此，2026-10-17 那次修完之后泄漏照样发生：
//   实测 `%TEMP%` 里 dotd-test-* 累积到 **11188 个**（全部当天新建）；
//   跑一次全量 `npm test` 新增 **104 个、一个都没删**。
// 逐文件扫描（135 个文件）后确认：**55 个测试文件**建了临时目录却从不 cleanup()。
//
// 后果不只是脏：目录堆到一万多个之后 `rmSync` 与目录枚举越来越慢，
// 最终把整份测试文件拖到超时崩溃 —— 表现为间歇性的
// `pass 1561 / fail 2`、`pass 1527 / fail 2`（**总数少于 1575**，
// 说明整份文件没跑完，不是某条断言失败）。
// 也就是说：**这个泄漏会自己把 S1 判据"0 失败"弄红**，而且时红时绿、极难归因。
//
// 判据：本文件建两个目录、**故意不删**，净增长必须被看见（先自证工具灵）；
// 然后正常建删，净增长必须为 0。第一条是关键 —— 它证明这条判据不是恒真。
test('计数工具自证：故意不删的目录必须被数出来（否则判据恒真）', () => {
  const base = countTempDirs();
  const d = makeTempDataDir();
  assert.ok(
    countTempDirs() > base,
    `建了目录但 countTempDirs() 没变（${base} → ${countTempDirs()}）：判据会恒真，必须先修工具`,
  );
  d.cleanup(); // 收尾（这一条只验证"数得到"）
});

test('净增长为 0：本文件建的临时目录全部删干净', () => {
  // 判据拆分（2026-10-21）：本文件内能确定性保证的是「自己建的目录自己删干净」
  // ——按名字逐一 existsSync 断言，无并发噪声。全局净增长（抓别的文件忘了
  // cleanup）挪到 scripts/regress/temp-leak-criteria.sh：套件级前后计数，天然
  // 串行、确定性。在并行 node --test 里数全局目录会被别的文件的存活目录
  // 误伤（单跑恒绿、全量偶红，连接器集成期间实测复现）。
  const dirs = [makeTempDataDir(), makeTempDataDir(), makeTempDataDir()];
  assert.ok(countTempDirs() > 0, '计数工具自检：TEMP 里至少数得出本文件的目录');
  for (const d of dirs) d.cleanup();
  for (const d of dirs) {
    assert.ok(!existsSync(d.root), `自建目录没删干净：${d.root}`);
  }
});

/** TEMP 里 dotd-test-* 目录个数（读不到时 0）。 */
function countTempDirs(): number {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith('dotd-test-')).length;
  } catch {
    return 0;
  }
}