/**
 * tests/governance-approvals-switch.test.ts —— 审批总开关 `DOTD_APPROVALS`。
 *
 * 2026-10-26 主人要求：「必须满足家居控制。dotd 的审批去掉」，并选定
 * 「加一个总开关，默认全关」。
 *
 * 这个文件钉四件事：
 *   ① off 时 dangerous / spend / browser 全部直通 allow，**不开审批单**；
 *   ② off 时**仍然**拒绝：未登记工具、spend 缺金额契约、EMERGENCY 冻结 dangerous；
 *   ③ off 时**仍然记账**：decisions + audit 各一条，reason 带 `approvals=off`；
 *   ④ on 时回到原五档（dangerous 照样开单）——开关是双通的，不是单向拆除。
 *
 * 另外一条静态守卫：`approvalsDisabled` 的默认值是 off（主人要求），
 * 但**不能被写在**「未登记 / spend 契约 / emergency / identity」这四条硬判定之前
 * （否则开关会把"工具不存在"也一起放行了）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGovFixture, ctxOf, auditRows } from './governance-support.ts';
import type { GovFixture } from './governance-support.ts';
import { evaluate } from '../src/governance/gate.ts';
import { approvalsDisabled } from '../src/governance/policy.ts';
import type { ToolCall } from '../src/governance/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_SRC = readFileSync(join(HERE, '..', 'src', 'governance', 'gate.ts'), 'utf8');

const fixtures: GovFixture[] = [];

/**
 * 本文件专用的最小目录：只放这四条用例要用的工具。
 * 为什么不用 `DEFAULT_TOOLS_YML`：那里没有 `fs.remove` / `pay.charge`，
 * 用它们的调用会在 §1 就以「工具未登记」deny —— 那时测的就不再是开关，
 * 而是"我写错了工具名"。（第一版就是这么错的，五条红全红在这里。）
 */
const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: shell.run
    tier: write_file
    upgrade:
      tier: dangerous
      whenContains: ["rm ", "sudo "]
  - name: fs.remove
    tier: dangerous
  - name: browser.act
    tier: browser
  - name: pay.charge
    tier: spend
    spendParams:
      required: [amountCents, currency, category]
  - name: net.post
    tier: write_file
`;

function fixture(): GovFixture {
  const f = makeGovFixture({ toolsYml: TOOLS_YML });
  fixtures.push(f);
  return f;
}

test.after(() => {
  for (const f of fixtures) f.cleanup();
  delete process.env['DOTD_APPROVALS'];
});

function withApprovals<T>(value: string | undefined, fn: () => T): T {
  const old = process.env['DOTD_APPROVALS'];
  if (value === undefined) delete process.env['DOTD_APPROVALS'];
  else process.env['DOTD_APPROVALS'] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env['DOTD_APPROVALS'];
    else process.env['DOTD_APPROVALS'] = old;
  }
}

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  callId: 'c1',
  tool: 'shell.run',
  params: { command: 'echo hi' },
  ...over,
});

// ═══════════════════════════════════════════════════════════════════
// ① 解析口径
// ═══════════════════════════════════════════════════════════════════

test('① 开关解析：只有显式 on/1/true/yes 才恢复审批，其余（含未设置）都是 off', () => {
  for (const v of ['on', 'ON', ' on ', '1', 'true', 'yes']) {
    assert.equal(withApprovals(v, () => approvalsDisabled()), false, `DOTD_APPROVALS=${v} 应恢复审批`);
  }
  for (const v of [undefined, '', 'off', '0', 'false', 'no', '随便什么']) {
    assert.equal(withApprovals(v, () => approvalsDisabled()), true, `DOTD_APPROVALS=${String(v)} 应直通`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ② off：危险档直通，且不开审批单
// ═══════════════════════════════════════════════════════════════════

test('② off：dangerous(shell.run+rm) 直通 allow，不产生任何审批单', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(ctxOf(), call({ params: { command: 'rm -rf /dot/home/x' } }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'allow');
  const approvals = f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number };
  assert.equal(Number(approvals.n), 0, 'off 时不该有审批单');
});

test('② off：spend 档（真掏钱）也直通，只看金额契约', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(
      ctxOf(),
      call({ tool: 'pay.charge', params: { amountCents: 1999, currency: 'CNY', category: 'x' } }),
      {},
      f.rt,
    ),
  );
  assert.equal(verdict.kind, 'allow');
});

test('② off：browser.act（会点会提交）不再走预审', async () => {
  const f = fixture();
  // 必须带 identity：不带的话 §6 会先以 identity_missing deny ——
  // 那测的是"缺身份"，不是开关。开关在 §6 之后，这是故意的（见 ⑥ 静态守卫）。
  const verdict = await withApprovals('off', () =>
    evaluate(
      ctxOf(),
      call({ tool: 'browser.act', params: { action: 'click', selector: '#buy' }, identity: 'owner' }),
      {},
      f.rt,
    ),
  );
  assert.equal(verdict.kind, 'allow');
  // 预审模型一次都不该被问（省时省钱，且 off 的语义就是"不先问"）
  assert.equal(f.router.requests.length, 0, 'off 时不该再多跑一次预审模型');
});

// ═══════════════════════════════════════════════════════════════════
// ③ off：四条硬判定照样拦
// ═══════════════════════════════════════════════════════════════════

test('③ off 仍然 deny 未登记工具（工具不存在，与"要不要批"无关）', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(ctxOf(), call({ tool: 'bash', params: {} }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.kind === 'deny' ? verdict.reason : '', /未登记/);
});

test('③ off 仍然 deny spend 缺金额（钱算不清不能靠开关绕过）', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(ctxOf(), call({ tool: 'pay.charge', params: {} }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.kind === 'deny' ? verdict.reason : '', /spend 参数契约/);
});

test('③ off 仍然 deny EMERGENCY 下的 dangerous（硬冻结不是"等人批"）', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(ctxOf({ emergency: true }), call({ tool: 'fs.remove', params: { path: '/dot/home/a' } }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.kind === 'deny' ? verdict.reason : '', /应急模式冻结/);
});

// ═══════════════════════════════════════════════════════════════════
// ④ off：记账一条不少
// ═══════════════════════════════════════════════════════════════════

test('④ off：直通也写 decisions + audit，reason 带 approvals=off', async () => {
  const f = fixture();
  const verdict = await withApprovals('off', () =>
    evaluate(ctxOf(), call({ tool: 'net.post', params: { url: 'https://example.com', body: 'x' } }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'allow');

  const dec = f.db.prepare("SELECT kind, reason FROM decisions ORDER BY rowid DESC LIMIT 1").get() as
    | { kind: string; reason: string }
    | undefined;
  assert.ok(dec !== undefined, '必须落 decisions');
  assert.equal(dec.kind, 'allow');
  assert.match(dec.reason, /approvals=off/);

  const audits = auditRows(f.db, 'decision');
  assert.equal(audits.length, 1, '审计必须有一条 decision');
  assert.match(String(audits[0]!['reason']), /approvals=off/);
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ on：回到原五档（开关双通）
// ═══════════════════════════════════════════════════════════════════

test('⑤ on：dangerous 照样开单（开关不是单向拆除）', async () => {
  const f = fixture();
  const verdict = await withApprovals('on', () =>
    evaluate(ctxOf(), call({ tool: 'fs.remove', params: { path: '/dot/home/a' } }), {}, f.rt),
  );
  assert.equal(verdict.kind, 'approve');
  const approvals = f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number };
  assert.equal(Number(approvals.n), 1);
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ 静态守卫：开关的位置
// ═══════════════════════════════════════════════════════════════════

test('⑥ 静态守卫：开关分支必须在四条硬判定之后、登录态/预审之前', () => {
  const at = (needle: string): number => {
    const i = GATE_SRC.indexOf(needle);
    assert.ok(i >= 0, `gate.ts 里找不到 ${needle}`);
    return i;
  };
  const switchAt = at('if (approvalsDisabled())');
  // 之前：白名单 / spend 契约 / emergency / identity
  assert.ok(switchAt > at("if (def === undefined) return deny('工具未登记')"), '开关不能抢在白名单之前');
  assert.ok(switchAt > at('if (def.tier === \'spend\')'), '开关不能抢在 spend 契约之前');
  assert.ok(switchAt > at("if (tier === 'dangerous' && ctx.emergency)"), '开关不能抢在 EMERGENCY 冻结之前');
  assert.ok(switchAt > at('if (isIdentityMissing(call))'), '开关不能抢在 identity 判定之前');
  // 之后：登录态审批 / read 快速路径 / base 策略
  assert.ok(switchAt < at('const loginSensitive = isLoginSensitive(call)'), '开关必须先于登录态审批');
  assert.ok(switchAt < at('// —— 7. read 快速路径'), '开关必须先于 read 快速路径');
  assert.ok(switchAt < at('// —— 9. base 策略'), '开关必须先于默认策略');
});

test('⑥ 静态守卫：policy 与 gate 都不许把"未登记"写在开关之内', () => {
  // 反例守卫：如果将来有人把 lookupTool 挪进 if (approvalsDisabled()) 里，
  // 未登记工具就会被放行。这里钉住 deny 的措辞仍在开关之前出现。
  const denyAt = GATE_SRC.indexOf("return deny('工具未登记')");
  const switchAt = GATE_SRC.indexOf('if (approvalsDisabled())');
  assert.ok(denyAt >= 0 && switchAt > denyAt);
});
