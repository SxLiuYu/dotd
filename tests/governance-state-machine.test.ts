/**
 * tests/governance-state-machine.test.ts —— 审批状态机 + 双通道冲突规则（GOV §3）。
 *
 * 依据 governance.md §3.2（八态与 TRANSITIONS）、§3.3（先到先得 = 单写者条件 UPDATE）、
 * §3.3.3（迟到裁决不报错只记账）、§3.3.6（认领/撤销竞态谁先提交谁赢）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { makeGovFixture, ctxOf, approvalRow, auditRows } from './governance-support.ts';
import type { GovFixture } from './governance-support.ts';
import { evaluate, decide, claim, resolveExecution, revoke } from '../src/governance/gate.ts';
import { isLegalTransition, TRANSITIONS } from '../src/governance/status.ts';
import { forceApproval } from '../src/governance/gate.ts';
import type { ApprovalStatus } from '../src/shared/contracts.ts';

// 兜底回收临时目录：治理用例大量走 makeGovFixture()（真库 + 临时 config），
// 个别用例忘了 cleanup 时不让目录留在 TEMP 里（tests/helpers.ts 的登记表 + 自检）。
test.after(() => { sweepTempPaths(); });

const fixtures: GovFixture[] = [];
const tmps: TempDataDir[] = [];

function fixture(opts: Parameters<typeof makeGovFixture>[0] = {}): GovFixture {
  const f = makeGovFixture(opts);
  fixtures.push(f);
  return f;
}

test('八态与 TRANSITIONS 表逐字一致（GOV §3.2 合法迁移表）', () => {
  assert.deepEqual(TRANSITIONS.pending, ['approved', 'rejected', 'expired']);
  assert.deepEqual(TRANSITIONS.approved, ['executing', 'revoked']);
  assert.deepEqual(TRANSITIONS.executing, ['executed', 'failed']);
  assert.deepEqual(TRANSITIONS.rejected, []);
  assert.deepEqual(TRANSITIONS.expired, []);
  assert.deepEqual(TRANSITIONS.executed, []);
  assert.deepEqual(TRANSITIONS.failed, []);
  assert.deepEqual(TRANSITIONS.revoked, []);
  // 非法迁移一律 false
  assert.equal(isLegalTransition('pending', 'executing'), false);
  assert.equal(isLegalTransition('executing', 'revoked'), false); // 执行中不可逆
  assert.equal(isLegalTransition('rejected', 'approved'), false); // 裁决即终局
});

test('spend 档一律开人工审批单（policy:spend），审批通过后认领执行', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_spend' }),
    {
      callId: 'call_spend_1',
      tool: 'shop.checkout',
      params: { amountCents: 2000, currency: 'USD', category: 'api_credit' },
    },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'approve');
  if (d.kind !== 'approve') return;
  const row = approvalRow(f.db, d.approvalId);
  assert.equal(row.status, 'pending');
  assert.equal(row.tier, 'spend');
  assert.equal(row.reason, 'policy:spend');
  assert.equal(row.seq, 1); // gov_seq 同事务生成

  const r1 = await decide(d.approvalId, 'web', 'approve_once', '主人');
  assert.equal(r1.ok, true);
  assert.equal(r1.finalStatus, 'approved');
  assert.equal(approvalRow(f.db, d.approvalId).status, 'approved');
  assert.equal(approvalRow(f.db, d.approvalId).decided_by, 'web');

  const c = await claim(d.approvalId, f.rt);
  assert.equal(c.ok, true);
  assert.equal(c.status, 'executing');
  assert.deepEqual(c.finalParams, {
    amountCents: 2000,
    currency: 'USD',
    category: 'api_credit',
  });

  const e = await resolveExecution(d.approvalId, { ok: true }, f.rt);
  assert.equal(e.ok, true);
  assert.equal(e.status, 'executed');
  assert.equal(approvalRow(f.db, d.approvalId).status, 'executed');

  // §2.5：spend 执行成功 ⇒ charge 台账行（正数）
  const ledger = f.db
    .prepare('SELECT * FROM spend_ledger WHERE approval_id=$id')
    .all({ id: d.approvalId }) as unknown as Record<string, unknown>[];
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.kind, 'charge');
  assert.equal(ledger[0]!.amount_cents, 2000);
  assert.equal(ledger[0]!.currency, 'USD');
  assert.equal(ledger[0]!.category, 'api_credit');
});

test('spend 参数契约不满足 ⇒ deny，钱都算不清的事不进审批', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf(),
    { callId: 'call_bad', tool: 'shop.checkout', params: { amountCents: -5 } },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.match(d.reason, /spend 参数契约不满足/);
  const rows = f.db
    .prepare('SELECT * FROM approvals')
    .all() as unknown as Record<string, unknown>[];
  assert.equal(rows.length, 0); // 未开单
});

test('未登记工具一律 deny（白名单制）', async () => {
  const f = fixture();
  const d = await evaluate(ctxOf(), { callId: 'c1', tool: 'evil.tool', params: {} }, {}, f.rt);
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.match(d.reason, /工具未登记/);
});

test('双通道冲突：web 抢先批准后 telegram 迟到裁决只记账不回滚', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_race' }),
    { callId: 'call_race', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'approve');
  if (d.kind !== 'approve') return;
  const id = d.approvalId;

  // web 先到：批准
  const web = await decide(id, 'web', 'approve_once', '主人-web');
  assert.equal(web.ok, true);
  assert.equal(web.finalStatus, 'approved');

  // telegram 迟到：不报错、只记账
  const tg = await decide(id, 'telegram', 'reject', '主人-tg');
  assert.equal(tg.ok, false);
  assert.equal(tg.finalStatus, 'approved'); // 状态不回滚
  assert.match(tg.reason ?? '', /已被 web 通道抢先/);
  assert.equal(tg.decidedBy, 'web');

  // 库里仍是 approved，decided_by 仍是 web（无二次执行）
  const row = approvalRow(f.db, id);
  assert.equal(row.status, 'approved');
  assert.equal(row.decided_by, 'web');
  assert.equal(row.decided_at !== null, true);

  // late_decision 审计落地
  const late = auditRows(f.db, 'late_decision');
  assert.equal(late.length, 1);
  assert.equal(late[0]!.channel, 'telegram');
  assert.equal(late[0]!.approval_id, id);

  // 迟到裁决不触发 onApprovalSettled（绝不二次执行）
  assert.equal(f.cp.settled.length, 1);
  assert.equal(f.cp.settled[0]!.ok, true);
  assert.equal(f.cp.settled[0]!.approvalId, id);
});

test('双通道冲突反向：先 reject 后 approve 同样迟到', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_race2' }),
    { callId: 'call_race2', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  const cli = await decide(d.approvalId, 'cli', 'reject', '主人-cli');
  assert.equal(cli.ok, true);
  const tg = await decide(d.approvalId, 'telegram', 'approve_once', '主人-tg');
  assert.equal(tg.ok, false);
  assert.equal(tg.finalStatus, 'rejected');
  assert.match(tg.reason ?? '', /已被 cli 通道抢先拒绝/);
  assert.equal(approvalRow(f.db, d.approvalId).status, 'rejected');
  // 只有一次 settle（reject → ok=false）
  assert.equal(f.cp.settled.length, 1);
  assert.equal(f.cp.settled[0]!.ok, false);
});

test('并发 decide 竞态：两通道同时裁决只有一赢（BEGIN IMMEDIATE 单写者）', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_conc' }),
    { callId: 'call_conc', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');

  // 两个通道"同时"到达（同步发起，SQLite 串行化执行）
  const [a, b] = await Promise.all([
    decide(d.approvalId, 'web', 'approve_once', 'A'),
    decide(d.approvalId, 'telegram', 'reject', 'B'),
  ]);
  const oks = [a.ok, b.ok].filter(Boolean).length;
  assert.equal(oks, 1, '恰好一个通道获胜');
  const winner = a.ok ? a : b;
  const loser = a.ok ? b : a;
  assert.equal(loser.ok, false);
  assert.equal(loser.finalStatus, winner.finalStatus);
  assert.equal(approvalRow(f.db, d.approvalId).status, winner.finalStatus);
  assert.equal(f.cp.settled.length, 1, '只有获胜方触发 settle');
  assert.equal(auditRows(f.db, 'late_decision').length, 1);
});

test('认领竞态：revoke 抢先则 claim 失败，控制面收到 revoke=pre-claim', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_rev' }),
    { callId: 'call_rev', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  await decide(d.approvalId, 'web', 'approve_once', '主人');

  const rev = await revoke(d.approvalId, '主人', '想清楚了，不买了');
  assert.equal(rev.ok, true);
  assert.equal(rev.revoked, true);
  assert.equal(approvalRow(f.db, d.approvalId).status, 'revoked');

  const c = await claim(d.approvalId, f.rt);
  assert.equal(c.ok, false); // 撤销后不可认领
  assert.equal(c.status, 'revoked');

  // §3.3.6：revoke 抢先 ⇒ settle(false, {revoke:'pre-claim'})
  const settles = f.cp.settled;
  assert.equal(settles.length, 2); // approve 一次 + revoke 一次
  const revokeSettle = settles[1]!;
  assert.equal(revokeSettle.ok, false);
  assert.equal(revokeSettle.meta?.revoke, 'pre-claim');
  assert.equal(auditRows(f.db, 'approval_revoked').length, 1);
});

test('executing 之后不接受 revoke（不可逆操作的安全边界在认领之前）', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf(),
    { callId: 'call_irr', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  await decide(d.approvalId, 'web', 'approve_once', '主人');
  await claim(d.approvalId, f.rt);
  const rev = await revoke(d.approvalId, '主人', '太晚了');
  assert.equal(rev.ok, false);
  assert.match(rev.reason ?? '', /仅 approved 可撤销/);
  assert.equal(approvalRow(f.db, d.approvalId).status, 'executing');
  assert.equal(auditRows(f.db, 'illegal_transition').length, 1);
});

test('approve_remember 落记忆 + TG 通道禁用 approve_remember', async () => {
  // browser.act 是 browser 档（默认 review）：precheck 判危 ⇒ 转人工；批准并记住 ⇒ 落记忆。
  // identity='anon' 走非登录态（契约 G1：缺失会 fail-closed 按登录态恒审批）。
  const f = fixture({ script: ['R|点击可疑按钮'] });
  const d = await evaluate(
    ctxOf({ taskId: 'tk_rem' }),
    {
      callId: 'call_rem',
      tool: 'browser.act',
      params: { url: 'https://x.com/home', actions: 'click' },
      identity: 'anon',
    },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'review_approve');
  if (d.kind !== 'review_approve') return;
  assert.equal(f.router.requests.length, 1, '走了一次低智能轨 precheck');

  const r = await decide(d.approvalId, 'web', 'approve_remember', '主人');
  assert.equal(r.ok, true);
  // §4.2：URL 类调用优先派生成 origin 级 endpoint_grants（宁粗勿漏），不进 approval_rules。
  const rules = f.db
    .prepare('SELECT * FROM approval_rules')
    .all() as unknown as Record<string, unknown>[];
  assert.equal(rules.length, 0, 'URL 类走 endpoint_grants，不落 approval_rules');
  const grants = f.db
    .prepare('SELECT * FROM endpoint_grants')
    .all() as unknown as Record<string, unknown>[];
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.origin, 'x.com');
  assert.equal(grants[0]!.path_glob, '/home/*');
  assert.equal(grants[0]!.tier_ceiling, 'browser');
  assert.equal(grants[0]!.status, 'active');
  assert.equal(auditRows(f.db, 'memory_created').length, 1);
  assert.match(String(grants[0]!.origin), /^x\.com$/);

  // TG 禁用 approve_remember（§3.4：防手机误触形成持久授权）
  const f2 = fixture({ script: ['R|点击可疑按钮'] });
  const d2 = await evaluate(
    ctxOf(),
    {
      callId: 'call_rem2',
      tool: 'browser.act',
      params: { url: 'https://y.com/a', actions: 'click' },
      identity: 'anon',
    },
    {},
    f2.rt,
  );
  if (d2.kind !== 'review_approve') throw new Error('应转人工');
  const tg = await decide(d2.approvalId, 'telegram', 'approve_remember', '主人-tg');
  assert.equal(tg.ok, false);
  assert.match(tg.reason ?? '', /TG 通道禁用 approve_remember/);
  const rules2 = f2.db
    .prepare('SELECT * FROM approval_rules')
    .all() as unknown as Record<string, unknown>[];
  assert.equal(rules2.length, 0, 'TG 未新增记忆');
});

test('幂等重入：pending 单原样返回同一张；approved 单认领放行', async () => {
  const f = fixture();
  const d1 = await evaluate(
    ctxOf({ taskId: 'tk_re' }),
    { callId: 'call_re', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d1.kind !== 'approve') throw new Error('应开单');

  // 同一 callId 重入 ⇒ 原样返回同一单（绝不重复开单）
  const d2 = await evaluate(
    ctxOf({ taskId: 'tk_re' }),
    { callId: 'call_re', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  assert.equal(d2.kind, 'approve');
  if (d2.kind !== 'approve') return;
  assert.equal(d2.approvalId, d1.approvalId);
  const count = f.db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number };
  assert.equal(count.n, 1);

  // 批准后重入 ⇒ claimAndAllow（认领后放行）
  await decide(d1.approvalId, 'web', 'approve_once', '主人');
  const d3 = await evaluate(
    ctxOf({ taskId: 'tk_re' }),
    { callId: 'call_re', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  assert.equal(d3.kind, 'allow');
  assert.equal(approvalRow(f.db, d1.approvalId).status, 'executing');
});

test('executing 中重入 ⇒ deny("execution in flight") 竞态防御', async () => {
  const f = fixture();
  const d1 = await evaluate(
    ctxOf(),
    { callId: 'call_flight', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d1.kind !== 'approve') throw new Error('应开单');
  await decide(d1.approvalId, 'web', 'approve_once', '主人');
  await claim(d1.approvalId, f.rt);
  const d2 = await evaluate(
    ctxOf(),
    { callId: 'call_flight', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  assert.equal(d2.kind, 'deny');
  if (d2.kind !== 'deny') return;
  assert.equal(d2.reason, 'execution in flight');
});

test('终态单重入 ⇒ deny + reentry_after_terminal 审计（bug 信号）', async () => {
  const f = fixture();
  const d1 = await evaluate(
    ctxOf(),
    { callId: 'call_term', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d1.kind !== 'approve') throw new Error('应开单');
  await decide(d1.approvalId, 'web', 'reject', '主人');

  const d2 = await evaluate(
    ctxOf(),
    { callId: 'call_term', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  assert.equal(d2.kind, 'deny');
  if (d2.kind !== 'deny') return;
  assert.equal(d2.reason, 'step already terminal: rejected');

  const re = auditRows(f.db, 'reentry_after_terminal');
  assert.equal(re.length, 1);
  assert.equal(re[0]!.approval_id, d1.approvalId);
});

test('upgrade 提档：shell.run 命中 "rm " ⇒ dangerous ⇒ emergency 下冻结', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ emergency: true }),
    { callId: 'call_rm', tool: 'shell.run', params: { cmd: 'rm -rf /tmp/x' } },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.reason, '应急模式冻结危险操作');
  // 非应急同样开单（dangerous ⇒ approve）
  const d2 = await evaluate(
    ctxOf(),
    { callId: 'call_rm2', tool: 'shell.run', params: { cmd: 'rm -rf /tmp/x' } },
    {},
    f.rt,
  );
  assert.equal(d2.kind, 'approve');
  if (d2.kind !== 'approve') return;
  assert.equal(approvalRow(f.db, d2.approvalId).tier, 'dangerous');
});

test('forceApproval：非工具单幂等（同 subject_key 复用）', async () => {
  const f = fixture();
  const a = await forceApproval(
    'tk_1',
    { kind: 'recon_candidate', subject: { model: 'free.xx/yy' }, reason: '接入必须主人批准' },
    f.rt,
  );
  const b = await forceApproval(
    'tk_1',
    { kind: 'recon_candidate', subject: { model: 'free.xx/yy' }, reason: '接入必须主人批准' },
    f.rt,
  );
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.approvalId, b.approvalId);
  const row = approvalRow(f.db, a.approvalId);
  assert.equal(row.kind, 'synthetic');
  assert.equal(row.subject_key, 'recon:free.xx/yy');
  assert.equal(row.tool, null); // 非工具单 tool/tier/journal_step 可空（DDL CHECK）
});

test('approval:created / approval:decided 事件广播（§8 事件表）', async () => {
  const f = fixture();
  const seen: string[] = [];
  f.bus.on('approval:created', () => {
    seen.push('created');
  });
  f.bus.on('approval:decided', () => {
    seen.push('decided');
  });
  const d = await evaluate(
    ctxOf({ taskId: 'tk_ev' }),
    { callId: 'call_ev', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  await decide(d.approvalId, 'web', 'approve_once', '主人');
  assert.deepEqual(seen, ['created', 'decided']);
});

test.after(() => {
  for (const f of fixtures) f.cleanup();
  for (const t of tmps) t.cleanup();
});
