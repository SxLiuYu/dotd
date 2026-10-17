/**
 * tests/governance-memory.test.ts —— 持久化记忆（GOV §4）：派生、命中、撤销、
 * 档位分桶、LRU 上限、登录态永不、emergency 休眠。
 *
 * 依据 governance.md §4.1 两个概念、§4.2 规则键派生、§4.3 匹配与命中语义、
 * §4.4 优先级、§4.5 安全阀。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGovFixture, ctxOf, auditRows } from './governance-support.ts';
import type { GovFixture } from './governance-support.ts';
import { evaluate, decide } from '../src/governance/gate.ts';
import {
  deriveRule,
  globMatch,
  matchMemory,
  persistMemory,
  listMemory,
  revokeMemory,
  expireMemory,
  enforceTierCap,
} from '../src/governance/memory-rules.ts';
import { govDefaults } from '../src/governance/config.ts';

const fixtures: GovFixture[] = [];
function fixture(opts: Parameters<typeof makeGovFixture>[0] = {}): GovFixture {
  const f = makeGovFixture(opts);
  fixtures.push(f);
  return f;
}

/** 走一遍「evaluate → decide(approve_remember)」把记忆落库。 */
async function rememberViaGate(
  f: GovFixture,
  call: { callId: string; tool: string; params: Record<string, unknown>; identity?: string | null },
  taskId = 'tk_mem',
) {
  const d = await evaluate(ctxOf({ taskId }), call, {}, f.rt);
  assert.equal(d.kind, 'review_approve', `应转人工审批，实际 ${d.kind}`);
  if (d.kind !== 'review_approve') throw new Error('unreachable');
  const r = await decide(d.approvalId, 'web', 'approve_remember', '主人');
  assert.equal(r.ok, true);
  return d.approvalId;
}

/**
 * 造一个真实审批单（满足 approval_rules/endpoint_grants 的 source_approval FK）。
 * 直接 SQL 插 pending 单，不走 evaluate（避免触发策略开一堆别的单）。
 */
function makeApproval(f: GovFixture, id: number, tool = 'fs.read', tier = 'read'): number {
  f.db
    .prepare(
      `INSERT INTO approvals (id, seq, kind, dot_id, task_id, journal_step, tool, tier,
                              params_json, summary, reason, status, pending_until)
       VALUES ($id, $id, 'tool_call', 'dot1', 'tk_fk', $step, $tool, $tier,
               '{}', 'test', 'fk', 'pending', '2099-01-01T00:00:00.000Z')`,
    )
    .run({ id, step: `step_fk_${id}`, tool, tier });
  return id;
}

// ── §4.2 规则键派生（磁盘稿逐字三例）────────────────────────────────────────

test('§4.2 deriveRule 三个逐字例子：fs.write 路径前缀 / net.post origin 级 / browser.act 动作', () => {
  const fs = deriveRule('write_file', {
    callId: 'c1',
    tool: 'fs.write',
    params: { path: '/dot/home/notes/x.md' },
    identity: 'anon',
  });
  assert.equal(fs?.source, 'rule');
  assert.equal(fs?.ruleKey, 'rule:fs.write:path=/dot/home/notes/*');

  const net = deriveRule('write_file', {
    callId: 'c2',
    tool: 'net.post',
    params: { url: 'https://api.x.com/v1/jobs' },
    identity: 'anon',
  });
  assert.equal(net?.source, 'grant');
  assert.equal(net?.ruleKey, 'grant:api.x.com:/v1/*');

  const br = deriveRule('browser', {
    callId: 'c3',
    tool: 'browser.act',
    params: { actions: 'navigate,click' },
    identity: 'anon',
  });
  assert.equal(br?.source, 'rule');
  assert.equal(br?.ruleKey, 'rule:browser.act:actions=navigate,click');
});

test('§4.2 URL 类宁粗勿漏：browser.act 带 url 时优先 origin 级 grant', () => {
  const g = deriveRule('browser', {
    callId: 'c4',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  assert.equal(g?.source, 'grant');
  assert.equal(g?.origin, 'x.com');
  assert.equal(g?.pathGlob, '/home/*');
});

test('§4.1/§4.3 登录态永不入记忆：identity 缺失（fail-closed）/真实身份都返回 null', () => {
  // 缺失 ⇒ fail-closed 按登录态 ⇒ 不可派生
  assert.equal(
    deriveRule('browser', { callId: 'c5', tool: 'browser.act', params: { url: 'https://x.com/' } }),
    null,
  );
  // 真实身份 ⇒ 登录态 ⇒ 不可派生
  assert.equal(
    deriveRule('browser', {
      callId: 'c6',
      tool: 'browser.act',
      params: { url: 'https://x.com/' },
      identity: 'alice',
    }),
    null,
  );
  // 'anon' / null ⇒ 非登录态 ⇒ 可派生
  assert.notEqual(
    deriveRule('browser', {
      callId: 'c7',
      tool: 'browser.act',
      params: { url: 'https://x.com/' },
      identity: null,
    }),
    null,
  );
});

test('§4.1 spend / dangerous 档永不入记忆', () => {
  assert.equal(
    deriveRule('spend', {
      callId: 'c8',
      tool: 'shop.checkout',
      params: { amountCents: 100, currency: 'USD', category: 'x' },
      identity: 'anon',
    }),
    null,
  );
  assert.equal(
    deriveRule('dangerous', {
      callId: 'c9',
      tool: 'shell.run',
      params: { path: '/dot/home/a' },
      identity: 'anon',
    }),
    null,
  );
});

// ── §4.3 匹配与命中语义 ─────────────────────────────────────────────────────

test('§4.3 命中即 allow 且记账：endpoint_grants 命中后 hits+1（无 last_hit_at 列）', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_g1',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  const hit = matchMemory(f.db, 'dot1', 'browser', {
    callId: 'call_g2',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  assert.notEqual(hit, null);
  assert.equal(hit!.source, 'grant');
  const grant = f.db.prepare('SELECT hits FROM endpoint_grants').get() as Record<string, unknown>;
  assert.equal(Number(grant.hits), 1);
  // §6：命中即治理动作 ⇒ 落 memory_hit 审计（说明这次 allow 凭什么发生）
  const hitAudits = auditRows(f.db, 'memory_hit');
  assert.equal(hitAudits.length, 1);
  assert.equal(hitAudits[0]!.dot_id, 'dot1');
  assert.equal(hitAudits[0]!.decision, 'allow');
  const hitDetails = JSON.parse(String(hitAudits[0]!.details_json)) as Record<string, unknown>;
  assert.equal(hitDetails.source, 'grant');
  const grantId = Number((f.db.prepare('SELECT id FROM endpoint_grants').get() as { id: number }).id);
  assert.equal(hitDetails.refId, grantId);
});

test('§4.3 登录态调用永不命中记忆（identity 缺失 ⇒ fail-closed 跳过）', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_g3',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  // 同一 URL，但 identity 缺失 ⇒ fail-closed 按登录态 ⇒ 不命中
  assert.equal(
    matchMemory(f.db, 'dot1', 'browser', {
      callId: 'call_g4',
      tool: 'browser.act',
      params: { url: 'https://x.com/home', actions: 'click' },
    }),
    null,
  );
});

test('§4.3 emergency 下 browser 记忆休眠，解除即恢复', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_g5',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  const call = {
    callId: 'call_g6',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon' as string,
  };
  assert.equal(matchMemory(f.db, 'dot1', 'browser', call, { emergency: true }), null, '应急中 browser 档休眠');
  assert.notEqual(matchMemory(f.db, 'dot1', 'browser', call, { emergency: false }), null, '应急解除即恢复');
});

test('§4.3 记忆按 tier 分桶：browser 记忆不放行 read 调用', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_g7',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  const fk = makeApproval(f, 900, 'browser.act', 'browser');
  // approval_rules 按 tier 精确分桶：造一条 browser 档 rule，验证 read 档查询取不到。
  persistMemory(
    f.db,
    'dot1',
    fk,
    {
      source: 'rule',
      tier: 'browser',
      ruleKey: 'rule:browser.act:tool',
      matcher: { tool: 'browser.act' },
      text: '已批规则 browser.act 全部调用（档位 browser，兜底派生）',
    },
    { defaults: govDefaults() },
  );
  assert.equal(
    matchMemory(f.db, 'dot1', 'read', {
      callId: 'call_g8',
      tool: 'browser.snapshot',
      params: {},
      identity: 'anon',
    }),
    null,
    'read 桶里没有这条 browser 规则',
  );
  assert.notEqual(
    matchMemory(f.db, 'dot1', 'browser', {
      callId: 'call_g9',
      tool: 'browser.act',
      params: { actions: 'click' },
      identity: 'anon',
    }),
    null,
  );
});

test('§4.3 过期记忆不命中（expires_at <= now）', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_g10',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  // 改成过去 ⇒ 过期
  const past = new Date(Date.now() - 1000).toISOString();
  f.db.prepare('UPDATE endpoint_grants SET expires_at=$e').run({ e: past });
  assert.equal(
    matchMemory(f.db, 'dot1', 'browser', {
      callId: 'call_g11',
      tool: 'browser.act',
      params: { url: 'https://x.com/home', actions: 'click' },
      identity: 'anon',
    }),
    null,
  );
});

test('§4.4 rules.yml（人工收紧）> 记忆：deny 规则不被记忆推翻', async () => {
  // rules.yml 收紧 browser.act 到 approve；记忆里另有 endpoint_grants。
  const f = fixture({
    script: ['R|点一下'],
    rulesYml: `rules:
  - match: { tool: browser.act }
    decision: approve
    reason: "主人要求 browser.act 一律人工"
`,
  });
  // 先手动落一条 endpoint_grants（绕开 decide 的 rules.yml 拦截；source_approval 需真实单）
  const fk = makeApproval(f, 901, 'browser.act', 'browser');
  persistMemory(
    f.db,
    'dot1',
    fk,
    {
      source: 'grant',
      tier: 'browser',
      ruleKey: 'grant:x.com:/*',
      matcher: { origin: 'x.com', pathGlob: '/*', tool: 'browser.act' },
      text: '已批端点 x.com/*',
      origin: 'x.com',
      pathGlob: '/*',
    },
    { defaults: govDefaults() },
  );
  const d = await evaluate(
    ctxOf({ taskId: 'tk_prio' }),
    { callId: 'call_p1', tool: 'browser.act', params: { url: 'https://x.com/home' }, identity: 'anon' },
    {},
    f.rt,
  );
  assert.equal(d.kind, 'approve', 'rules.yml 收紧 ⇒ 开人工单，不被记忆放行');
  if (d.kind !== 'approve') return;
  const row = f.db.prepare('SELECT reason FROM approvals WHERE id=$id').get({ id: d.approvalId }) as {
    reason: string;
  };
  assert.match(row.reason, /rules\.yml/);
  const decisions = f.db.prepare('SELECT kind, reason FROM decisions ORDER BY id ASC').all() as Array<
    Record<string, unknown>
  >;
  assert.ok(decisions.every((r) => r.kind !== 'allow'), '没有任何 allow 出口');
});

// ── §4.5 安全阀 ─────────────────────────────────────────────────────────────

test('§4.5 每 Dot 每档位上限 50：第 51 条 approval_rules 触发 LRU 淘汰', () => {
  const f = fixture();
  const defaults = govDefaults();
  const fk = makeApproval(f, 902, 'fs.read', 'read');
  const first: number[] = [];
  for (let i = 0; i < 55; i++) {
    const res = persistMemory(
      f.db,
      'dot1',
      fk,
      {
        source: 'rule',
        tier: 'read',
        ruleKey: `rule:fs.read:path=/dot/home/${i}/*`,
        matcher: { tool: 'fs.read', pathGlob: `/dot/home/${i}/*` },
        text: `已批规则 fs.read 路径 /dot/home/${i}/*（档位 read）`,
      },
      { defaults },
    );
    first.push(res.id);
  }
  const active = f.db
    .prepare("SELECT id FROM approval_rules WHERE status='active'")
    .all() as unknown as { id: number }[];
  assert.equal(active.length, 50, '封顶 50 条');
  // 最早的 5 条被 LRU 淘汰
  for (const id of first.slice(0, 5)) {
    const r = f.db.prepare('SELECT status FROM approval_rules WHERE id=$id').get({ id }) as {
      status: string;
    };
    assert.equal(r.status, 'expired', `#${id} 应被淘汰`);
  }
  // 直接调 enforceTierCap 幂等（不会误杀）
  assert.equal(enforceTierCap(f.db, 'dot1', 'read', 'approval_rules', defaults), 0);
});

test('§4.5 endpoint_grants 列名不同（tier_ceiling）照样封顶', () => {
  const f = fixture();
  const defaults = govDefaults();
  const fk = makeApproval(f, 903, 'net.get', 'read');
  for (let i = 0; i < 52; i++) {
    persistMemory(
      f.db,
      'dot1',
      fk,
      {
        source: 'grant',
        tier: 'read',
        ruleKey: `grant:h${i}.com:/*`,
        matcher: { origin: `h${i}.com`, pathGlob: '/*', tool: 'net.get' },
        text: `已批端点 h${i}.com/*`,
        origin: `h${i}.com`,
        pathGlob: '/*',
      },
      { defaults },
    );
  }
  const active = f.db
    .prepare("SELECT id FROM endpoint_grants WHERE status='active'")
    .all() as unknown as { id: number }[];
  assert.equal(active.length, 50);
});

test('§4.5 endpoint_grants 也按 last_hit_at 淘汰（090 起冷热分明，不再按 id 序踢热授权）', () => {
  const f = fixture();
  const defaults = govDefaults();
  const fk = makeApproval(f, 904, 'net.get', 'read');
  const grant = (i: number): void => {
    persistMemory(
      f.db,
      'dot1',
      fk,
      {
        source: 'grant',
        tier: 'read',
        ruleKey: `grant:c${i}.com:/*`,
        matcher: { origin: `c${i}.com`, pathGlob: '/*', tool: 'net.get' },
        text: `已批端点 c${i}.com/*`,
        origin: `c${i}.com`,
        pathGlob: '/*',
      },
      { defaults },
    );
  };
  for (let i = 0; i < 52; i++) grant(i);

  // 把最早的 3 条标成"刚刚还在用"：它们有了 last_hit_at，该活下来
  const oldest = f.db
    .prepare("SELECT id FROM endpoint_grants WHERE status='active' ORDER BY id ASC LIMIT 3")
    .all() as unknown as { id: number }[];
  const recent = new Date(Date.now() + 60_000).toISOString();
  for (const r of oldest) {
    f.db.prepare('UPDATE endpoint_grants SET last_hit_at=$at WHERE id=$id').run({ at: recent, id: r.id });
  }
  // 再塞两条 → 触发淘汰；按 id 序的旧实现会砍掉最早那 3 条热授权
  grant(52);
  grant(53);
  for (const r of oldest) {
    const row = f.db
      .prepare('SELECT status FROM endpoint_grants WHERE id=$id')
      .get({ id: r.id }) as { status: string };
    assert.equal(row.status, 'active', `热授权 #${r.id} 不该被淘汰`);
  }
  const stillActive = f.db
    .prepare("SELECT COUNT(*) AS n FROM endpoint_grants WHERE status='active'")
    .get() as { n: number };
  assert.equal(stillActive.n, 50, '封顶仍是 50 条');
});

test('§4.5 记忆全量可见可撤：listMemory / revokeMemory / expireMemory', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_ls',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  const all = listMemory(f.db, 'dot1');
  assert.equal(all.length, 1);
  assert.equal(all[0]!.source, 'grant');
  assert.equal(all[0]!.key, 'grant:x.com/home/*');

  const revoked = revokeMemory(f.db, all[0]!.id);
  assert.equal(revoked.ok, true);
  assert.equal(listMemory(f.db, 'dot1').length, 0, '撤销后不再列出');
  assert.equal(listMemory(f.db, 'dot1', { includeTerminal: true }).length, 1, '含终态仍可查');
  // §6：撤销记忆必须落 memory_revoked 审计（含 dot_id/tier/key，可回答"谁撤了什么授权"）
  const revokedAudits = auditRows(f.db, 'memory_revoked');
  assert.equal(revokedAudits.length, 1, '撤销落一条 memory_revoked');
  assert.equal(revokedAudits[0]!.dot_id, 'dot1');
  assert.equal(revokedAudits[0]!.tier, 'browser');
  assert.equal(revokedAudits[0]!.actor, 'owner');
  const revokedDetails = JSON.parse(String(revokedAudits[0]!.details_json)) as Record<string, unknown>;
  assert.equal(revokedDetails.source, 'grant');
  assert.equal(revokedDetails.key, 'grant:x.com/home/*');
  // 撤销后不再命中
  assert.equal(
    matchMemory(f.db, 'dot1', 'browser', {
      callId: 'call_ls2',
      tool: 'browser.act',
      params: { url: 'https://x.com/home', actions: 'click' },
      identity: 'anon',
    }),
    null,
  );
  // 撤销不存在的 ⇒ ok=false
  const bad = revokeMemory(f.db, 9999);
  assert.equal(bad.ok, false);
  assert.equal(expireMemory(f.db), 0);
});

test('§4.5 expireMemory：到期记忆置 expired', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_exp',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  const past = new Date(Date.now() - 1000).toISOString();
  f.db.prepare('UPDATE endpoint_grants SET expires_at=$e').run({ e: past });
  assert.equal(expireMemory(f.db), 1);
  const row = f.db.prepare('SELECT status FROM endpoint_grants').get() as { status: string };
  assert.equal(row.status, 'expired');
  // §6：到期失效也要落 memory_expired 审计（逐条可追溯，不是一次批量吞掉）
  const expiredAudits = auditRows(f.db, 'memory_expired');
  assert.equal(expiredAudits.length, 1);
  assert.equal(expiredAudits[0]!.dot_id, 'dot1');
  assert.equal(expiredAudits[0]!.decision, 'expired');
});

// ── glob 与幂等 ─────────────────────────────────────────────────────────────

test('globMatch：* 与 ? 语义；`/x/*` 也命中目录自身 /x', () => {
  assert.equal(globMatch('/home/*', '/home/a.md'), true);
  assert.equal(globMatch('/home/*', '/home/a/b.md'), true);
  assert.equal(globMatch('/home/*', '/home'), true, '目录自身也算前缀内');
  assert.equal(globMatch('/home/*', '/other/a.md'), false);
  assert.equal(globMatch('/home/?.md', '/home/a.md'), true);
  assert.equal(globMatch('/home/?.md', '/home/ab.md'), false);
  assert.equal(globMatch('/*', '/anything'), true);
  assert.equal(globMatch('/*', '/'), true);
  // 正则元字符必须转义
  assert.equal(globMatch('/a.b/*', '/a.b/x'), true);
  assert.equal(globMatch('/a.b/*', '/axb/x'), false);
});

test('persistMemory 幂等：同 (dot,tier,rule_key) 复用既有活动行', () => {
  const f = fixture();
  const fk = makeApproval(f, 904, 'fs.read', 'read');
  const derived = {
    source: 'rule' as const,
    tier: 'read' as const,
    ruleKey: 'rule:fs.read:tool',
    matcher: { tool: 'fs.read' },
    text: '已批规则 fs.read 全部调用（档位 read，兜底派生）',
  };
  const a = persistMemory(f.db, 'dot1', fk, derived, { defaults: govDefaults() });
  const b = persistMemory(f.db, 'dot1', fk, derived, { defaults: govDefaults() });
  assert.equal(a.id, b.id);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  const n = f.db.prepare('SELECT count(*) AS n FROM approval_rules').get() as { n: number };
  assert.equal(n.n, 1);
});

test('approve_remember 全程：evaluate → decide → 落库 → 重放命中放行', async () => {
  const f = fixture({ script: ['R|点一下'] });
  await rememberViaGate(f, {
    callId: 'call_e2e',
    tool: 'browser.act',
    params: { url: 'https://x.com/home', actions: 'click' },
    identity: 'anon',
  });
  assert.equal(auditRows(f.db, 'memory_created').length, 1);

  // 同 URL 重放 ⇒ 记忆放行（allow，不再开单）
  const d2 = await evaluate(
    ctxOf({ taskId: 'tk_e2e2' }),
    {
      callId: 'call_e2e_b',
      tool: 'browser.act',
      params: { url: 'https://x.com/home', actions: 'click' },
      identity: 'anon',
    },
    {},
    f.rt,
  );
  assert.equal(d2.kind, 'allow');
  if (d2.kind !== 'allow') return;
  const dec = f.db.prepare('SELECT reason, from_memory FROM decisions WHERE id=$id').get({
    id: d2.decisionId,
  }) as Record<string, unknown>;
  assert.match(String(dec.reason), /记忆放行/);
  assert.notEqual(dec.from_memory, null);
});
