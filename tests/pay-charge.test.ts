/**
 * tests/pay-charge.test.ts —— 一等支付工具 `pay.charge`（2026-10-25）。
 *
 * 主人要的是"审批得是具体操作，比如点外卖支付这种操作"。支付成为 spend 档工具后，
 * 卡片、台账、幂等、上限才有落脚点。这组用例锁住：
 *   ① 配置：没配就不注册（null）；dry-run 可独立启用；非法数字拒启动；
 *   ② 参数：金额/币种/类别/收款方缺一不可，金额必须是正整数分；
 *   ③ 上限：单笔、当日累计（连接器不直接读治理库，由装配层传入"今天已花"）；
 *   ④ 幂等：同一单号命中回执就不再发请求（dry-run 与真实网关都适用）；
 *   ⑤ 协议：POST + idempotency-key + Bearer；2xx 无 receiptId = 结果不明，**不自动重试**；
 *   ⑥ 治理：真实 config/tools.yml 里是 spend 档，批准执行成功后落 spend_ledger.charge。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  payConfigFromEnv,
  payCharge,
  deriveOrderId,
  type PayReceipt,
} from '../src/connectors/pay.ts';
import { makeGovFixture, ctxOf } from './governance-support.ts';
import { evaluate, decide, claim, resolveExecution } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import { sweepTempPaths } from './helpers.ts';

test.after(() => {
  sweepTempPaths();
});

const REPO = fileURLToPath(new URL('..', import.meta.url));

function cfg(over: Partial<ReturnType<typeof payConfigFromEnv>> = {}) {
  const base = payConfigFromEnv({ DOTD_PAY_DRY_RUN: '1' });
  assert.ok(base !== null);
  return { ...base!, ...over };
}

// ── ① 配置 ───────────────────────────────────────────────────────────────────

test('完全没配 → null（装配层据此不注册工具）', () => {
  assert.equal(payConfigFromEnv({}), null);
});

test('dry-run 可独立启用；真实端点必须是 http(s)', () => {
  const dry = payConfigFromEnv({ DOTD_PAY_DRY_RUN: '1' });
  assert.ok(dry !== null && dry.dryRun);
  const real = payConfigFromEnv({ DOTD_PAY_ENDPOINT: 'https://pay.example.com/charge' });
  assert.ok(real !== null && !real.dryRun);
  assert.throws(
    () => payConfigFromEnv({ DOTD_PAY_ENDPOINT: 'pay.example.com' }),
    /http\(s\)/,
  );
});

test('上限配置非法/倒置 → 拒启动（不静默回落）', () => {
  assert.throws(
    () => payConfigFromEnv({ DOTD_PAY_DRY_RUN: '1', DOTD_PAY_MAX_CENTS: '0' }),
    /DOTD_PAY_MAX_CENTS/,
  );
  assert.throws(
    () =>
      payConfigFromEnv({
        DOTD_PAY_DRY_RUN: '1',
        DOTD_PAY_MAX_CENTS: '100000',
        DOTD_PAY_DAILY_CENTS: '5000',
      }),
    /不能小于/,
  );
});

// ── ② 参数 ───────────────────────────────────────────────────────────────────

test('参数缺项/金额非法 → BAD_ARG，不发请求', async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return new Response('{}');
  }) as unknown as typeof fetch;
  for (const bad of [
    { currency: 'CNY', category: 'food', payee: '美团' },
    { amountCents: 35.5, currency: 'CNY', category: 'food', payee: '美团' },
    { amountCents: -1, currency: 'CNY', category: 'food', payee: '美团' },
    { amountCents: 100, currency: 'cny', category: 'food', payee: '美团' },
    { amountCents: 100, currency: 'CNY', category: '', payee: '美团' },
    { amountCents: 100, currency: 'CNY', category: 'food', payee: '  ' },
  ]) {
    const r = await payCharge(cfg(), bad as Record<string, unknown>, { fetchImpl });
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.equal(r.code, 'BAD_ARG');
  }
  assert.equal(called, 0, '参数不合法时不该发起任何网络请求');
});

// ── ③ 上限 ───────────────────────────────────────────────────────────────────

test('单笔上限：超过就拒，不问主人', async () => {
  const r = await payCharge(
    cfg({ maxCents: 1000, dailyCents: 10_000 }),
    { amountCents: 1001, currency: 'CNY', category: 'food', payee: '美团' },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PAY_LIMIT');
});

test('当日累计上限：今天已花 + 本次 超限就拒', async () => {
  const r = await payCharge(
    cfg({ maxCents: 5000, dailyCents: 5000 }),
    { amountCents: 3000, currency: 'CNY', category: 'food', payee: '美团' },
    { spentTodayCents: () => 2500 },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PAY_DAILY_LIMIT');
});

// ── ④ 幂等 ───────────────────────────────────────────────────────────────────

test('dry-run：返回合成回执，同单号第二次命中缓存', async () => {
  const store = new Map<string, PayReceipt>();
  const deps = {
    taskId: 'tk_pay',
    getReceipt: (k: string) => store.get(k) ?? null,
    putReceipt: (r: PayReceipt) => store.set(r.orderId, r),
  };
  const args = { amountCents: 3500, currency: 'CNY', category: 'food', payee: '美团', memo: '午饭' };
  const a = await payCharge(cfg(), args, deps);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.value.receiptId, `dryrun_${a.value.orderId}`);
  assert.equal(a.value.amountCents, 3500);
  assert.equal(a.value.dryRun, true);

  const b = await payCharge(cfg(), args, deps);
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.value.receiptId, a.value.receiptId);
  assert.equal(store.size, 1, '同参数只能有一个回执');
});

test('orderId 按"任务+参数"确定：同任务同参数恒定，换参数就变', () => {
  const a = deriveOrderId('tk1', { amountCents: 100, currency: 'CNY', payee: '美团', memo: 'x' });
  const b = deriveOrderId('tk1', { amountCents: 100, currency: 'CNY', payee: '美团', memo: 'x' });
  const c = deriveOrderId('tk1', { amountCents: 101, currency: 'CNY', payee: '美团', memo: 'x' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^pay_[0-9a-f]{24}$/);
});

// ── ⑤ 协议 ───────────────────────────────────────────────────────────────────

async function withServer(
  handler: (req: { method: string; headers: Record<string, string>; body: string }) => {
    status: number;
    body: string;
  },
  fn: (endpoint: string, seen: Array<{ method: string; headers: Record<string, string>; body: string }>) => Promise<void>,
): Promise<void> {
  const seen: Array<{ method: string; headers: Record<string, string>; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += String(c);
    });
    req.on('end', () => {
      const item = {
        method: req.method ?? '',
        headers: req.headers as Record<string, string>,
        body,
      };
      seen.push(item);
      const out = handler(item);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}/charge`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('真实网关：POST + idempotency-key + Bearer，2xx 带回执', async () => {
  await withServer(
    () => ({ status: 200, body: JSON.stringify({ receiptId: 'rcpt_1', status: 'succeeded' }) }),
    async (endpoint, seen) => {
      const store = new Map<string, PayReceipt>();
      const r = await payCharge(
        cfg({ dryRun: false, endpoint, token: 'tok_x' }),
        { amountCents: 3500, currency: 'CNY', category: 'food', payee: '美团', memo: '午饭' },
        {
          taskId: 'tk_real',
          getReceipt: (k) => store.get(k) ?? null,
          putReceipt: (x) => store.set(x.orderId, x),
        },
      );
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.value.receiptId, 'rcpt_1');
      assert.equal(seen.length, 1);
      const req = seen[0]!;
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['authorization'], 'Bearer tok_x');
      assert.match(String(req.headers['idempotency-key']), /^pay_/);
      const body = JSON.parse(req.body) as Record<string, unknown>;
      assert.equal(body.amountCents, 3500);
      assert.equal(body.payee, '美团');
      assert.equal(body.currency, 'CNY');
    },
  );
});

test('网关 4xx 不可重试、5xx 可重试；2xx 缺 receiptId = 结果不明（不自动重试）', async () => {
  await withServer(
    (req) => {
      if (req.body.includes('3500')) return { status: 400, body: JSON.stringify({ error: '余额不足' }) };
      if (req.body.includes('3600')) return { status: 500, body: 'boom' };
      return { status: 200, body: '{"ok":true}' };
    },
    async (endpoint) => {
      const c = cfg({ dryRun: false, endpoint });
      const bad = await payCharge(c, { amountCents: 3500, currency: 'CNY', category: 'x', payee: 'p' });
      assert.equal(bad.ok, false);
      if (!bad.ok) {
        assert.equal(bad.code, 'PAY_REJECTED');
        assert.equal(bad.retryable, false);
        assert.match(bad.message, /余额不足/);
      }
      const srv = await payCharge(c, { amountCents: 3600, currency: 'CNY', category: 'x', payee: 'p' });
      assert.equal(srv.ok, false);
      if (!srv.ok) {
        assert.equal(srv.code, 'PAY_REJECTED');
        assert.equal(srv.retryable, true);
      }
      const amb = await payCharge(c, { amountCents: 3700, currency: 'CNY', category: 'x', payee: 'p' });
      assert.equal(amb.ok, false);
      if (!amb.ok) {
        assert.equal(amb.code, 'PAY_AMBIGUOUS');
        assert.equal(amb.retryable, false, '钱可能已经动了，不能自动重试');
      }
    },
  );
});

test('网络不可达 → PAY_UNREACHABLE，且标记 not retryable（钱的结果未知）', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r = await payCharge(
    cfg({ dryRun: false, endpoint: 'http://127.0.0.1:1/charge' }),
    { amountCents: 100, currency: 'CNY', category: 'x', payee: 'p' },
    { fetchImpl },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'PAY_UNREACHABLE');
    assert.equal(r.retryable, false);
  }
});

// ── ⑥ 治理：真实目录 + 台账 ─────────────────────────────────────────────────

test('config/tools.yml：pay.charge 是 spend 档且带 spendParams', () => {
  const { catalog } = loadCatalog(join(REPO, 'config/tools.yml'), join(REPO, 'config/rules.yml'));
  const def = catalog.tools.get('pay.charge');
  assert.ok(def !== undefined, '真实目录里必须有 pay.charge');
  assert.equal(def!.tier, 'spend');
  assert.ok(def!.spendParams !== undefined);
  assert.deepEqual([...(def!.spendParams?.required ?? [])], ['amountCents', 'currency', 'category']);
});

test('治理全链：spend 档必然开单 → 批准执行 → spend_ledger 记 charge', async () => {
  const toolsYml = readFileSync(join(REPO, 'config/tools.yml'), 'utf8');
  const f = makeGovFixture({ toolsYml });
  f.db
    .prepare(
      'INSERT INTO tasks (id,title,goal,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run('tk_pay', '点一份午饭', '点一份午饭', 'running', 1, Date.now(), Date.now());

  const params = {
    amountCents: 3500,
    currency: 'CNY',
    category: 'food',
    payee: '美团外卖',
    memo: '午饭',
  };
  const d = await evaluate(ctxOf({ taskId: 'tk_pay' }), { callId: 'c_pay', tool: 'pay.charge', params });
  assert.equal(d.kind, 'approve', 'spend 档必须人工审批');
  if (d.kind !== 'approve') return;

  const row = f.db.prepare('SELECT summary FROM approvals WHERE id=?').get(d.approvalId) as {
    summary: string;
  };
  assert.match(row.summary, /点一份午饭/, '摘要要带业务动作');
  assert.match(row.summary, /美团外卖/, '摘要要带收款方');

  await decide(d.approvalId, 'web', 'approve_once', '主人');
  const c = await claim(d.approvalId);
  assert.equal(c.ok, true);
  const r = await resolveExecution(d.approvalId, { ok: true, resultDigest: 'rcpt_1' });
  assert.equal(r.status, 'executed');

  const ledger = f.db
    .prepare('SELECT kind, amount_cents, category FROM spend_ledger WHERE approval_id=?')
    .all(d.approvalId) as Array<{ kind: string; amount_cents: number; category: string }>;
  assert.deepEqual(
    ledger.map((x) => [x.kind, x.amount_cents, x.category]),
    [['charge', 3500, 'food']],
  );
});
