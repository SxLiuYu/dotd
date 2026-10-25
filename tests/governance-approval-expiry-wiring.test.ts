/**
 * tests/governance-approval-expiry-wiring.test.ts —— 审批到期扫描必须真的在跑。
 *
 * 背景（2026-10-25 现场）：`expirePending` 有实现、有单测，契约也写着
 * "cron 每 5 分钟"（GOV §3.4），但**生产装配里没有任何调用点**。结果：
 * `approvals#159` 的 `pending_until` 到了之后仍是 `pending`，
 * 宿主任务永远停在 `awaiting_approval`，`/api/status` 一直报 `approvalsPending=1`。
 *
 * 单测只能证明"函数算得对"，证明不了"有人在调它"。所以这里读装配层源码做静态守卫：
 * ① daemon 必须把 `expirePending` 注册成内部 job；
 * ② 周期不得超过 5 分钟（契约值，别悄悄改成一天一次）；
 * ③ 必须复用 `governance/gate.ts` 的实现，不能另写一套过期语义。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(REPO, 'src/daemon.ts'), 'utf8').replace(/\r\n/g, '\n');

function jobBlock(): string {
  const m = SRC.match(/registerInternalJob\(\{\n\s*name: 'gov\.approval-expiry'[\s\S]{0,600}?\n  \}\);/);
  assert.ok(m, "缺少 registerInternalJob({ name: 'gov.approval-expiry' })");
  return m![0];
}

test('daemon 注册了审批到期扫描 job，且周期性调用 expirePending', () => {
  const block = jobBlock();
  assert.match(block, /govExpirePending\(/, 'job 内必须调用 expirePending（导入别名 govExpirePending）');
  assert.match(block, /kind: 'light'/, '水位紧张时应跳轮，不该是 heavy');
});

test('扫描周期 ≤ 5 分钟（GOV §3.4 的契约值）', () => {
  const every = jobBlock().match(/everyMs: ([0-9_]+)/);
  assert.ok(every, '必须显式指定 everyMs');
  const ms = Number((every![1] ?? '').replace(/_/g, ''));
  assert.ok(ms > 0 && ms <= 5 * 60_000, `everyMs=${ms} 超过 5 分钟`);
});

test('expirePending 从 gate 导入（不是自造一个同名函数）', () => {
  assert.match(
    SRC,
    /import \{[^}]*expirePending as govExpirePending[^}]*\} from '\.\/governance\/gate\.ts'/,
    '必须复用 governance/gate.ts 的实现，避免两套过期语义',
  );
});
