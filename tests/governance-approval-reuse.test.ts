/**
 * tests/governance-approval-reuse.test.ts —— 同一个动作不要重复问主人（2026-10-25）。
 *
 * 现场（approvals#160/#161）：主人同意 → 工具执行返回 `container_not_ready`
 * （容器 quarantined，动作**根本没跑起来**）→ 模型原样重试 → 又开一张新单、
 * 又发一张卡。主人看到的就是"审批之后又重置了"。
 *
 * 这里锁住四条边界：
 *   ① 同参数还有 pending 单 → 复用同一张（不开新票）；
 *   ② 同参数批过、但执行因**基础设施**失败（30 分钟内）→ 直接放行；
 *   ③ 业务失败 / 参数不同 / 超窗口 → 仍然重新问；
 *   ④ spend 档永不自动复用（花钱每次都要点头）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeGovFixture, ctxOf } from './governance-support.ts';
import { evaluate, decide, claim, resolveExecution } from '../src/governance/gate.ts';
import type { ToolCall } from '../src/governance/types.ts';
import { sweepTempPaths } from './helpers.ts';

test.after(() => {
  sweepTempPaths();
});

// 生产 tools.yml 里 shell.run 对出网命令（含 `https://`）提档到 dangerous；
// 这里直接用 dangerous 目录，免得用例依赖 upgrade 子串解析。
const TOOLS_YML = `tools:
  - name: shell.run
    tier: dangerous
  - name: shop.checkout
    tier: spend
    spendParams:
      required: [amountCents, currency, category]
`;

const CMD = "python3 - <<'EOF'\nimport urllib.request\nprint(urllib.request.urlopen('https://api.example.com/x').read())\nEOF";

function seedTask(f: ReturnType<typeof makeGovFixture>, taskId: string): void {
  f.db
    .prepare(
      'INSERT INTO tasks (id,title,goal,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(taskId, '查一下北京天气', '查一下北京天气', 'running', 1, Date.now(), Date.now());
}

function seedStep(
  f: ReturnType<typeof makeGovFixture>,
  taskId: string,
  callId: string,
  result: unknown,
): void {
  f.db
    .prepare(
      `INSERT INTO steps (task_id,seq,kind,status,call_id,tool_name,args_json,result_json,run_epoch,started_at,finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(taskId, 1, 'tool', 'failed', callId, 'shell.run', '{}', JSON.stringify(result), 1, Date.now(), Date.now());
}

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  callId: 'c1',
  tool: 'shell.run',
  params: { cmd: CMD },
  ...over,
});

async function approveAndFailInfra(
  f: ReturnType<typeof makeGovFixture>,
  taskId: string,
  approvalId: number,
  callId: string,
  code = 'container_not_ready',
): Promise<void> {
  const d = await decide(approvalId, 'web', 'approve_once', 'owner');
  assert.equal(d.ok, true, '先得能批');
  const c = await claim(approvalId);
  assert.equal(c.ok, true, 'claim 应成功');
  seedStep(f, taskId, callId, { code, message: '容器状态 quarantined 不可派发（需 ready）', retryable: true });
  const r = await resolveExecution(approvalId, { ok: false, errorText: `${code}: quarantined` });
  assert.equal(r.status, 'failed');
}

test('基础设施失败后，同参数重试不再开新单（直接放行 + 审计 approval_reused）', async () => {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  seedTask(f, 'tk_reuse');
  const ctx = ctxOf({ taskId: 'tk_reuse' });

  const d1 = await evaluate(ctx, call({ callId: 'c1' }));
  assert.equal(d1.kind, 'approve');
  if (d1.kind !== 'approve') return;
  await approveAndFailInfra(f, 'tk_reuse', d1.approvalId, 'c1');

  const d2 = await evaluate(ctx, call({ callId: 'c2' }));
  assert.equal(d2.kind, 'allow', '同参数的基建失败重试应直接放行');

  const audit = f.db
    .prepare("SELECT action, reason FROM audit_log WHERE task_id='tk_reuse' AND action='approval_reused'")
    .all() as Array<{ action: string; reason: string }>;
  assert.equal(audit.length, 1, '应有一条 approval_reused 审计');
  assert.match(audit[0]!.reason, /container_not_ready/);

  // 失败原因必须如实入库：原来写的是 `执行失败：no digest`（把结果摘要当错误文案）。
  const dec = f.db
    .prepare(
      "SELECT reason FROM audit_log WHERE approval_id=? AND action='approval_decided' AND decision='failed'",
    )
    .get(d1.approvalId) as { reason: string } | undefined;
  assert.ok(dec !== undefined, '缺少 approval_decided(failed) 审计');
  assert.match(dec!.reason, /container_not_ready/);
  assert.ok(!dec!.reason.includes('no digest'), '失败原因不能还是 no digest');
});

test('业务失败不自动复用：仍然重新问主人', async () => {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  seedTask(f, 'tk_biz');
  const ctx = ctxOf({ taskId: 'tk_biz' });

  const d1 = await evaluate(ctx, call({ callId: 'c1' }));
  assert.equal(d1.kind, 'approve');
  if (d1.kind !== 'approve') return;
  await approveAndFailInfra(f, 'tk_biz', d1.approvalId, 'c1', 'invalid_argument');

  const d2 = await evaluate(ctx, call({ callId: 'c2' }));
  assert.equal(d2.kind, 'approve', '非基建失败必须重新批准');
});

test('参数不同 / 超出 30 分钟窗口：重新问', async () => {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  seedTask(f, 'tk_win');
  const ctx = ctxOf({ taskId: 'tk_win' });

  const d1 = await evaluate(ctx, call({ callId: 'c1' }));
  assert.equal(d1.kind, 'approve');
  if (d1.kind !== 'approve') return;
  await approveAndFailInfra(f, 'tk_win', d1.approvalId, 'c1');

  const other = await evaluate(ctx, call({ callId: 'c2', params: { cmd: 'echo hi' } }));
  assert.equal(other.kind, 'approve', '参数不同不能复用');

  // 把上次裁决时间挪到 31 分钟前 → 窗口外
  f.db
    .prepare('UPDATE approvals SET decided_at=? WHERE id=?')
    .run(new Date(Date.now() - 31 * 60_000).toISOString(), d1.approvalId);
  const stale = await evaluate(ctx, call({ callId: 'c3' }));
  assert.equal(stale.kind, 'approve', '超窗后应重新问');
});

test('同参数仍有 pending 单：复用同一张，不重复开票', async () => {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  seedTask(f, 'tk_pending');
  const ctx = ctxOf({ taskId: 'tk_pending' });

  const d1 = await evaluate(ctx, call({ callId: 'c1' }));
  const d2 = await evaluate(ctx, call({ callId: 'c2' }));
  assert.equal(d1.kind, 'approve');
  assert.equal(d2.kind, 'approve');
  if (d1.kind !== 'approve' || d2.kind !== 'approve') return;
  assert.equal(d2.approvalId, d1.approvalId, '应复用同一张审批单');

  const pending = f.db
    .prepare("SELECT count(*) n FROM approvals WHERE task_id='tk_pending' AND status='pending'")
    .get() as { n: number };
  assert.equal(pending.n, 1, 'pending 单只能有一张');
});

test('spend 档永不复用：花钱每次都要点头', async () => {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  seedTask(f, 'tk_spend');
  const ctx = ctxOf({ taskId: 'tk_spend' });
  const params = { amountCents: 3550, currency: 'CNY', category: 'food' };

  const d1 = await evaluate(ctx, call({ callId: 'c1', tool: 'shop.checkout', params }));
  assert.equal(d1.kind, 'approve');
  if (d1.kind !== 'approve') return;
  await approveAndFailInfra(f, 'tk_spend', d1.approvalId, 'c1');

  const d2 = await evaluate(ctx, call({ callId: 'c2', tool: 'shop.checkout', params }));
  assert.equal(d2.kind, 'approve', 'spend 档不允许复用同意');
});
