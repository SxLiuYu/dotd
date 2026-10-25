/**
 * tests/cp-model-recovery-wiring.test.ts —— 模型恢复兜底必须真的在跑。
 *
 * 背景（2026-10-25 现场）：线上有 3 条任务 `stop_reason='endpoints_unreachable'`
 * 卡在 paused，分别卡了 2 天、11 小时、27 分钟；期间模型早就恢复、新任务正常跑。
 *
 * 根因不是"没有恢复函数"（`resumeCircuitOpenTasks` 一直都在），而是它的触发点
 * 只有 `router.breaker_changed(to=closed)` / `router.mode_changed`：
 * 断路器状态存在内存里，daemon 重启后就是全新的 closed，**不会补发事件**；
 * mode 也一直是 NORMAL。于是这些任务永远等不到那一声通知。
 *
 * 所以装配层必须有一个周期性的兜底扫描，判据是"最近一次成功模型调用"。
 * 这个测试读 daemon.ts 做静态守卫（单测证明不了"有人在调它"）：
 *  ① 注册了 cp.model-recovery 内部 job；
 *  ② job 里查的是 model_call_log 的 ok 记录，并调用 cp.resumePausedAfterModelOk；
 *  ③ 周期 ≤ 5 分钟（要快过"主人发现任务卡住"的时间）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(REPO, 'src/daemon.ts'), 'utf8').replace(/\r\n/g, '\n');

function jobBlock(): string {
  const m = SRC.match(/registerInternalJob\(\{\n\s*name: 'cp\.model-recovery'[\s\S]{0,900}?\n  \}\);/);
  assert.ok(m, "缺少 registerInternalJob({ name: 'cp.model-recovery' })");
  return m![0];
}

test('daemon 注册了 cp.model-recovery job，且调用 resumePausedAfterModelOk', () => {
  const block = jobBlock();
  assert.match(block, /cp\.resumePausedAfterModelOk\(/, 'job 内必须调用兜底恢复');
  assert.match(block, /kind: 'light'/, '只做一次单表 MAX 查询，应走 light 轨');
});

test('判据来自 model_call_log 的成功记录，而不是"现在看起来健康"', () => {
  const block = jobBlock();
  assert.match(block, /model_call_log/, '必须读 model_call_log');
  assert.match(block, /outcome\s*=\s*'ok'/, "只认 outcome='ok' 的调用");
  assert.match(block, /MAX\(ts\)/, '取最近一次成功的时间戳');
});

test('扫描周期 ≤ 5 分钟', () => {
  const every = jobBlock().match(/everyMs: ([0-9_]+)/);
  assert.ok(every, '必须显式指定 everyMs');
  const ms = Number((every![1] ?? '').replace(/_/g, ''));
  assert.ok(ms > 0 && ms <= 5 * 60_000, `everyMs=${ms} 超过 5 分钟`);
});
