/**
 * tests/exec-periodic-healthcheck.test.ts —— 运行期容器探活 + 状态机路径正确。
 *
 * 现场（2026-10-19）：healthcheck 只在 boot 跑一次，运行期完全没探活。
 * `docker stop` 掉容器后，数据库 state 仍然是 `ready` —— **状态失真**。
 * 任务派发过去拿到 `transport_error: fetch failed`，直接失败给主人看，
 * 而 `ExecService` 的注释写着"运行期 unhealthy 由重试+重启兜底"—— 实测根本没有重试。
 *
 * 修复：加 `exec.healthcheck` 周期 job（60s）：
 *   - ready 但探活连续失败 3 次 → unhealthy
 *   - unhealthy 探活恢复 → **unhealthy → booting → ready**（不是直接跳 ready）
 *
 * 第二个坑：第一次修的时候直接 `transition(dotId,'ready')`，被状态机拒绝
 * （CONTAINER_TRANSITIONS.unhealthy 里没有 ready），但异常被吞掉，
 * 日志连着打两次"恢复"而状态纹丝不动。所以这个测试也钉住"必须经 booting"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const execSrc = readFileSync(join(here, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');
const daemonSrc = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');
const typesSrc = readFileSync(join(here, '..', 'src', 'exec', 'types.ts'), 'utf8');

test('ExecService 暴露运行期探活方法', () => {
  assert.ok(/async periodicHealthCheck\(/.test(execSrc), '应有 periodicHealthCheck()');
});

test('daemon 把探活挂成周期 job', () => {
  assert.ok(daemonSrc.includes("name: 'exec.healthcheck'"), "应有 exec.healthcheck job");
  assert.ok(/exec\.periodicHealthCheck\(/.test(daemonSrc), 'job 里应调用 periodicHealthCheck');
});

test('自愈必须经 booting 中转（状态机不允许 unhealthy → ready）', () => {
  // 先确认状态机事实
  const m = /unhealthy: \[([^\]]*)\]/.exec(typesSrc);
  assert.ok(m !== null, 'types.ts 里应有 unhealthy 的转移表');
  assert.ok(
    !/['"]ready['"]/.test(m![1]!),
    'unhealthy 不该能直接转 ready（如果哪天改了状态机，这个断言和下面的实现都要同步）',
  );
  // 再确认实现走的是 booting → ready
  const idx = execSrc.indexOf('periodicHealthCheck(');
  const body = execSrc.slice(idx, idx + 2500);
  const bootingFirst = body.indexOf("transition(dotId, 'booting'");
  const readyAfter = body.indexOf("transition(dotId, 'ready'");
  assert.ok(bootingFirst > 0, '恢复路径应先 transition 到 booting');
  assert.ok(readyAfter > bootingFirst, 'booting 之后才 transition 到 ready');
});
