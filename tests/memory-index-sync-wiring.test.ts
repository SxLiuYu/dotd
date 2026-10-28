/**
 * tests/memory-index-sync-wiring.test.ts —— 记忆文件索引对账必须真的在跑。
 *
 * 背景（2026-10-27 现场）：`mem_files_index` 全库只有 1 行，停在 10-25 09:00；
 * 而容器里 `/dot/home/notes/` 昨晚 00:30 还在写文件。索引比磁盘落后两天多。
 *
 * 根因不是"没有对账函数"——`MemoryService.syncFilesIndex()` 一直都在，
 * §6.2 也明写"心跳经 /fs/ops list 增量对账"——而是**全仓库没有生产调用方**，
 * 只有测试在调它。于是：
 *  ① 笔记检索（memory.search）看不到新写的笔记；
 *  ② 模型去读 `fs.read /dot/home/MEMORY.md` 这类路径时不存在的提示越积越多
 *     （本周 21 次 not_found 全是这个路径）；
 *  ③ 指标里"记忆文件"永远是 1，看不出系统有没有在积累。
 *
 * 还有第二层坑（部署后实测踩到）：`registerInternalJob` 的首次到期是
 * `now + everyMs`，**不是立刻跑**。只注册的话，部署完那十分钟里索引还是旧的，
 * 日志也看不出"没跑"。所以启动处必须显式调一次。
 *
 * 这个测试读 daemon.ts 做静态守卫（单测证明得了函数对不对，证明不了"有人在调"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(REPO, 'src/daemon.ts'), 'utf8').replace(/\r\n/g, '\n');

/** 取 syncMemoryIndex 的函数体（对账逻辑都在里面）。 */
function syncBody(): string {
  const m = SRC.match(/const syncMemoryIndex = async \(\): Promise<void> => \{[\s\S]{0,1600}?\n  \};/);
  assert.ok(m, '缺少 syncMemoryIndex 实现');
  return m![0];
}

/** 取 job 注册块。 */
function jobBlock(): string {
  const m = SRC.match(/registerInternalJob\(\{\n\s*name: 'memory\.index-sync'[\s\S]{0,300}?\n  \}\);/);
  assert.ok(m, "缺少 registerInternalJob({ name: 'memory.index-sync' })");
  return m![0];
}

test('daemon 注册了 memory.index-sync job，且真的调到 syncFilesIndex', () => {
  assert.match(syncBody(), /memory\.syncFilesIndex\(/, '对账函数必须真的调 syncFilesIndex');
  // job 的 run 必须指向那个函数，不能是空壳。
  assert.match(jobBlock(), /run: syncMemoryIndex/, 'job 必须执行对账逻辑');
  assert.match(jobBlock(), /kind: 'light'/, '水位紧张时应跳轮：索引晚半小时不影响正确性');
});

test('周期够快：笔记随时写，落后一天就等于搜不到', () => {
  const every = jobBlock().match(/everyMs: ([0-9_]+)/);
  assert.ok(every, '必须显式指定 everyMs');
  const ms = Number((every![1] ?? '').replace(/_/g, ''));
  assert.ok(ms > 0 && ms <= 30 * 60_000, `everyMs=${ms} 超过 30 分钟`);
  // 里面的节流阈值也不能超过 30 分钟，否则 everyMs 小也没用。
  const gate = syncBody().match(/nowMs - lastIndexSyncAt < (\d+) \* 60_000/);
  assert.ok(gate, '必须有自己的节流判据');
  assert.ok(Number(gate![1]) <= 30, `节流上限 ${gate![1]} 分钟超过 30 分钟`);
});

test('启动时立刻对账一次（registerInternalJob 首次到期是 now+everyMs，不是立刻）', () => {
  // 节流锚点从 0 开始 ⇒ 第一次调用不被挡。
  assert.match(SRC, /let lastIndexSyncAt = 0;/, '节流锚点必须从 0 开始');
  assert.match(syncBody(), /lastIndexSyncAt !== 0 &&/, '0 时不该被节流挡住');
  // 关键：启动处要有显式调用。这条是部署后实测补的 —— 只注册不调用，
  // 索引会一直停在旧值直到第一个 10 分钟周期。
  assert.match(SRC, /void syncMemoryIndex\(\);/, '启动处必须显式对账一次');
});
