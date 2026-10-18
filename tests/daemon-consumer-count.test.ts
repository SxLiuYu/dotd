/**
 * tests/daemon-consumer-count.test.ts —— 并发额度必须真的启动对应数量的消费者循环。
 *
 * 现场（2026-10-18）：`DOTD_MAX_RUNNING=2` 时环境变量确实进了进程、
 * `cpConcurrencyFromEnv()` 也正确返回 `{maxRunningTasks:2}`，
 * 但**并发度恒为 1**——因为 daemon 只 `new DotRunner(...)` 一次并只起了一个 `runner.start()`。
 *
 * 配置项承诺了并发能力，实现却只起一个消费协程，是名不副实。
 * 修法：按额度起 N 个循环（默认额度 1 → 仍只起 1 个，行为与改动前逐字一致）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');

test('消费者循环数量由并发额度决定', () => {
  assert.ok(src.includes('每个消费者一个循环'), '必须有"按额度起多个循环"的说明');
  assert.match(
    src,
    /const consumers = Math\.max\(1, cpConcurrencyFromEnv\(\)\.maxRunningTasks \?\? 1\);/,
    '必须从并发配置推导循环数',
  );
  assert.match(src, /for \(let i = 0; i < consumers; i \+= 1\)/, '必须起 consumers 个循环');
});

test('关闭时等待全部循环（不能只等一个）', () => {
  assert.match(
    src,
    /const runnerLoop = Promise\.all\(runnerLoops\)\.then\(\(\) => undefined\);/,
    'runnerLoop 必须是所有循环的合并等待',
  );
});

test('循环数 >1 时留下可观察日志', () => {
  assert.match(
    src,
    /if \(consumers > 1\) log\(/,
    '多消费者启动时必须打日志（否则"我设了 2 却还是串行"无从排查）',
  );
});
