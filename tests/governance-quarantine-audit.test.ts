/**
 * tests/governance-quarantine-audit.test.ts —— Dot 隔离（GOV §5.4）与审计（GOV §6）。
 *
 * 依据 governance.md §5.4「quarantine 的持久化与解除」、§6.1 动作枚举、
 * §6.2 保留上限与回收（只追加 / 2KB 截断 / 90 天·20000 行窗口 / id 区间归档）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { makeGovFixture, ctxOf, auditRows } from './governance-support.ts';
import type { GovFixture } from './governance-support.ts';
import { evaluate, decide } from '../src/governance/gate.ts';
import {
  isQuarantined,
  quarantineDot,
  liftQuarantine,
  activeQuarantine,
  listQuarantines,
} from '../src/governance/quarantine.ts';
import {
  appendAudit,
  tailAudit,
  replayAudit,
  encodeDetails,
  DETAILS_LIMIT,
  compactAudit,
  defaultArchiveDir,
  enforceArchiveCap,
  verifyArchiveFile,
  purgeTerminal,
  purgeMemoryTerminal,
  archiveSizeMb,
} from '../src/governance/audit.ts';

const fixtures: GovFixture[] = [];
function fixture(opts: Parameters<typeof makeGovFixture>[0] = {}): GovFixture {
  const f = makeGovFixture(opts);
  fixtures.push(f);
  return f;
}

/** 造一条真实 decision（quarantines.decision_id 有 FK 指向 decisions.id）。 */
function makeDecision(f: GovFixture, id = 'dec_qtest'): string {
  f.db
    .prepare(
      `INSERT INTO decisions (id, dot_id, task_id, journal_step, kind, tier, tool, params_json, reason)
       VALUES ($id, 'dot1', 'tk_q', 'step_q', 'deny', 'browser', 'browser.act', '{}', '后审判危')`,
    )
    .run({ id });
  return id;
}

// ── §5.4 隔离 ───────────────────────────────────────────────────────────────

test('§5.4 quarantineDot：先落库后发事件，isQuarantined 同步可查', () => {
  const f = fixture();
  const decisionId = makeDecision(f);
  assert.equal(isQuarantined(f.db, 'dot1'), false);

  const out = quarantineDot(f.db, f.rt.deps, { dotId: 'dot1', decisionId, reason: '后审判危' });
  assert.equal(out.created, true);
  assert.equal(out.view.dotId, 'dot1');
  assert.equal(out.view.status, 'active');

  assert.equal(isQuarantined(f.db, 'dot1'), true);
  const row = f.db.prepare('SELECT * FROM quarantines').get() as Record<string, unknown>;
  assert.equal(row.decision_id, decisionId);
  assert.equal(auditRows(f.db, 'quarantine').length, 1);
});

test('§5.4 幂等：同 dot 二次隔离不炸，created=false 复用既有行', () => {
  const f = fixture();
  const d1 = makeDecision(f, 'dec_q1');
  const d2 = makeDecision(f, 'dec_q2');
  quarantineDot(f.db, f.rt.deps, { dotId: 'dot1', decisionId: d1, reason: '第一次' });
  const second = quarantineDot(f.db, f.rt.deps, { dotId: 'dot1', decisionId: d2, reason: '第二次' });
  assert.equal(second.created, false);
  assert.equal(second.view.decisionId, d1, '沿用首条 active 行');
  const n = f.db.prepare('SELECT count(*) AS n FROM quarantines').get() as { n: number };
  assert.equal(n.n, 1, 'uniq_quarantine 保证同 dot 至多一条 active');
});

test('§5.4 隔离跨"重启"不丢：同一 db 文件重开后 isQuarantined 仍为 true', async () => {
  const f = fixture();
  const decisionId = makeDecision(f);
  quarantineDot(f.db, f.rt.deps, { dotId: 'dot1', decisionId, reason: '持久化验证' });
  // 模拟 daemon 重启：丢弃内存态，只靠表。
  const file = f.db.prepare('PRAGMA database_list').get() as { file?: string };
  assert.ok(typeof file.file === 'string' && file.file.length > 0);
  const { DatabaseSync } = await import('node:sqlite');
  const reopened = new DatabaseSync(file.file!);
  try {
    assert.equal(isQuarantined(reopened, 'dot1'), true, '表内状态不依赖进程内存');
    assert.notEqual(activeQuarantine(reopened, 'dot1'), null);
  } finally {
    reopened.close();
  }
});

test('§5.4 liftQuarantine：置 lifted + 审计 + 事件 + resumeDotQueue', () => {
  const f = fixture();
  const decisionId = makeDecision(f);
  quarantineDot(f.db, f.rt.deps, { dotId: 'dot1', decisionId, reason: '待解除' });
  assert.equal(f.cp.resumed.length, 0);

  const r = liftQuarantine(f.db, f.rt.deps, 'dot1', '主人');
  assert.equal(r.ok, true);
  assert.equal(r.view.status, 'lifted');
  assert.equal(r.view.liftedBy, '主人');
  assert.equal(isQuarantined(f.db, 'dot1'), false, '解除后不再隔离');
  assert.equal(auditRows(f.db, 'quarantine_lifted').length, 1);
  assert.deepEqual(f.cp.resumed, ['dot1'], '契约 G3：控制面 per-dot 队列恢复');

  // 幂等：无 active ⇒ ok=false，绝不制造第二条
  const again = liftQuarantine(f.db, f.rt.deps, 'dot1', '主人');
  assert.equal(again.ok, false);
  const n = f.db.prepare('SELECT count(*) AS n FROM quarantines').get() as { n: number };
  assert.equal(n.n, 1);
});

test('§5.4 历史可查：listQuarantines 倒序回看，含 lifted', () => {
  const f = fixture();
  const d1 = makeDecision(f, 'dec_h1');
  const d2 = makeDecision(f, 'dec_h2');
  quarantineDot(f.db, f.rt.deps, { dotId: 'dotA', decisionId: d1, reason: 'A' });
  quarantineDot(f.db, f.rt.deps, { dotId: 'dotB', decisionId: d2, reason: 'B' });
  liftQuarantine(f.db, f.rt.deps, 'dotA', '主人');
  const list = listQuarantines(f.db);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.dotId, 'dotB', '倒序（id 大的在前）');
  assert.equal(list[1]!.status, 'lifted');
});

// ── §6 审计 ─────────────────────────────────────────────────────────────────

test('§6 只追加：appendAudit 只 INSERT；id 单调递增', () => {
  const f = fixture();
  const a = appendAudit(f.db, { actor: 'system', action: 'decision', reason: 'r1' });
  const b = appendAudit(f.db, { actor: 'system', action: 'decision', reason: 'r2' });
  assert.equal(b, a + 1);
  const n = f.db.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number };
  assert.equal(n.n, 2);
});

test('§6.2 details 超 2KB ⇒ 截断 + details_truncated=1', () => {
  const f = fixture();
  const big = 'x'.repeat(DETAILS_LIMIT + 500);
  appendAudit(f.db, { actor: 'system', action: 'decision', details: { big } });
  const row = f.db.prepare('SELECT details_json, details_truncated FROM audit_log').get() as {
    details_json: string;
    details_truncated: number;
  };
  assert.equal(row.details_truncated, 1);
  assert.ok(row.details_json.length <= DETAILS_LIMIT);
  assert.match(row.details_json, /…\[truncated\]$/);
});

test('§6.2 encodeDetails：未超限原样；不可序列化不炸', () => {
  assert.deepEqual(encodeDetails(undefined), { json: null, truncated: 0 });
  const ok = encodeDetails({ a: 1 });
  assert.equal(ok.json, '{"a":1}');
  assert.equal(ok.truncated, 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const bad = encodeDetails(cyclic);
  assert.equal(bad.truncated, 0);
  assert.match(String(bad.json), /unserializable/);
});

test('§6 审计脱敏：cookie/token 形态入库前被替换', () => {
  const f = fixture();
  appendAudit(f.db, {
    actor: 'system',
    action: 'decision',
    reason: 'cookie: abcdef123456',
    details: { auth: 'authorization: Bearer abcdef123456' },
  });
  const row = f.db.prepare('SELECT reason, details_json FROM audit_log').get() as {
    reason: string;
    details_json: string;
  };
  assert.match(row.reason, /cookie:\[REDACTED\]/);
  assert.match(row.details_json, /\[REDACTED\]/);
  assert.doesNotMatch(row.details_json, /abcdef123456/);
});

test('§6 tailAudit / replayAudit：倒序 tail + 按 task 正序回放', async () => {
  const f = fixture();
  const d = await evaluate(
    ctxOf({ taskId: 'tk_audit' }),
    { callId: 'call_a1', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  await decide(d.approvalId, 'web', 'approve_once', '主人');

  const tail = tailAudit(f.db, 10);
  assert.ok(tail.length >= 3);
  // tail 人读时序正序返回
  for (let i = 1; i < tail.length; i++) assert.ok(tail[i]!.id > tail[i - 1]!.id);

  const replay = replayAudit(f.db, { taskId: 'tk_audit' });
  assert.ok(replay.length >= 3);
  assert.ok(replay.every((r) => r.taskId === 'tk_audit'));
  assert.ok(replay.some((r) => r.action === 'approval_created'));
  assert.ok(replay.some((r) => r.action === 'approval_decided'));
});

test('§6.2 compactAudit：id 区间归档 + 删行 + manifest + sha256 可校验', () => {
  const f = fixture();
  const archiveDir = join(f.tmp.root, 'audit-archive-test');
  // 造 5 条"很旧"的审计（ts 直接改写过去，模拟 90 天前）
  for (let i = 0; i < 5; i++) {
    appendAudit(f.db, { actor: 'system', action: 'decision', reason: `old-${i}` });
  }
  f.db
    .prepare(`UPDATE audit_log SET ts = '2000-01-01T00:00:00' WHERE reason LIKE 'old-%'`)
    .run();
  appendAudit(f.db, { actor: 'system', action: 'decision', reason: 'new' });

  const res = compactAudit(f.db, {
    retentionDays: 90,
    chunkBytes: 10 * 1024 * 1024,
    archiveDir,
    archiveCapMb: 200,
  });
  assert.equal(res.archived.length, 1, '5 条旧行合成一段');
  assert.equal(res.archived[0]!.rows, 5);
  assert.equal(res.remaining, 1, '只剩新行');

  const manifest = f.db
    .prepare('SELECT * FROM audit_archive')
    .all() as unknown as Record<string, unknown>[];
  assert.equal(manifest.length, 1);
  assert.equal(Number(manifest[0]!.rows), 5);
  assert.equal(Number(manifest[0]!.min_id), res.archived[0]!.minId);

  const abs = join(archiveDir, String(manifest[0]!.file));
  assert.ok(existsSync(abs), '归档文件已落盘');
  const v = verifyArchiveFile(abs, String(manifest[0]!.sha256));
  assert.equal(v.ok, true);
  // 解压回来就是 jsonl，行数一致
  const lines = gunzipSync(readFileSync(abs)).toString('utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /old-0/);
});

test('§6.2 compactAudit：无过期行时不归档（空跑）', () => {
  const f = fixture();
  const res = compactAudit(f.db, {
    retentionDays: 90,
    chunkBytes: 1024,
    archiveDir: join(f.tmp.root, 'audit-empty'),
    archiveCapMb: 200,
  });
  assert.deepEqual(res.archived, []);
  assert.equal(res.remaining, 0);
  const n0 = f.db.prepare('SELECT count(*) AS n FROM audit_archive').get() as { n: number };
  assert.equal(n0.n, 0);
});

test('§6.2 enforceArchiveCap：超限删最旧文件 + manifest 行', () => {
  const f = fixture();
  const archiveDir = join(f.tmp.root, 'audit-cap');
  mkdirSync(archiveDir, { recursive: true });
  // 三段假归档：每段 1MB（bytes 记 1MB）
  for (let i = 1; i <= 3; i++) {
    const file = `audit-${i}-${i}.jsonl.gz`;
    f.db
      .prepare(
        `INSERT INTO audit_archive (file, min_id, max_id, min_ts, max_ts, rows, bytes, sha256)
         VALUES ($file, $i, $i, '2000-01-01', '2000-01-01', 1, $bytes, 'x')`,
      )
      .run({ file, i, bytes: 1024 * 1024 });
    // 真实文件也要有（enforceArchiveCap 只删 manifest + unlink）
    writeFileSync(join(archiveDir, file), 'x');
  }
  const deleted = enforceArchiveCap(f.db, archiveDir, 2); // 上限 2MB ⇒ 删最旧 1 段
  assert.deepEqual(deleted, ['audit-1-1.jsonl.gz']);
  assert.equal(existsSync(join(archiveDir, 'audit-1-1.jsonl.gz')), false);
  const left = f.db.prepare('SELECT count(*) AS n FROM audit_archive').get() as { n: number };
  assert.equal(left.n, 2);
});

test('§6.2 purgeTerminal：被 spend_ledger/audit_log 引用的行保留（引用豁免）', async () => {
  const f = fixture();
  const { claim, resolveExecution } = await import('../src/governance/gate.ts');
  const d = await evaluate(
    ctxOf({ taskId: 'tk_purge' }),
    { callId: 'call_p1', tool: 'shop.checkout', params: { amountCents: 100, currency: 'USD', category: 'x' } },
    {},
    f.rt,
  );
  if (d.kind !== 'approve') throw new Error('应开单');
  await decide(d.approvalId, 'web', 'approve_once', '主人');
  await claim(d.approvalId, f.rt);
  await resolveExecution(d.approvalId, { ok: true }, f.rt);

  // 全部改旧：approvals 有 spend_ledger 引用、decisions 有 audit_log 引用 ⇒ 都不该被清。
  f.db.prepare(`UPDATE approvals SET created_at='2000-01-01T00:00:00'`).run();
  f.db.prepare(`UPDATE decisions SET ts='2000-01-01T00:00:00'`).run();
  f.db.prepare(`UPDATE audit_log SET ts='2000-01-01T00:00:00'`).run();

  const r = purgeTerminal(f.db, 90);
  assert.equal(r.approvals, 0, 'spend_ledger 引用的 approval 保留（冲账可追溯）');
  assert.equal(r.decisions, 0, 'audit_log 引用的 decision 保留');
  const ap = f.db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number };
  assert.equal(ap.n, 1);
  const ledger = f.db.prepare('SELECT count(*) AS n FROM spend_ledger').get() as { n: number };
  assert.equal(ledger.n, 1, '台账行在');

  // 无引用的孤立终态行才被清：再造一张 rejected 单（无 ledger 无 audit 引用）。
  f.db
    .prepare(
      `INSERT INTO approvals (seq, kind, dot_id, task_id, journal_step, tool, tier, params_json, summary, reason, status, created_at, pending_until)
       VALUES (99, 'tool_call', 'dot1', 'tk_x', 'step_x', 'fs.read', 'read', '{}', 't', 't', 'rejected', '2000-01-01', '2000-01-02')`,
    )
    .run();
  const r2 = purgeTerminal(f.db, 90);
  assert.equal(r2.approvals, 1, '孤立终态单被清');
});

test('§6.2 purgeMemoryTerminal：记忆终态行满 90 天才清', () => {
  const f = fixture();
  // FK 顺序：先插 source_approval 指向的 approval，再插 memory 行。
  f.db
    .prepare(
      `INSERT INTO approvals (id, seq, kind, dot_id, task_id, journal_step, tool, tier, params_json, summary, reason, status, pending_until)
       VALUES (1, 1, 'tool_call', 'dot1', 'tk_fk', 'step_fk_1', 'fs.read', 'read', '{}', 't', 't', 'executed', '2099-01-01')`,
    )
    .run();
  f.db
    .prepare(
      `INSERT INTO approval_rules (dot_id, tier, rule_key, matcher, text, source_approval, status, created_at, expires_at)
       VALUES ('dot1','read','rule:fs.read:tool','{}','t', 1, 'revoked', '2000-01-01', '2099-01-01')`,
    )
    .run();
  assert.equal(purgeMemoryTerminal(f.db, 90), 1);
  const left = f.db.prepare('SELECT count(*) AS n FROM approval_rules').get() as { n: number };
  assert.equal(left.n, 0);
});

test('§6.2 defaultArchiveDir 与 archiveSizeMb', () => {
  const f = fixture();
  const dir = defaultArchiveDir(f.db);
  assert.match(dir, /audit-archive$/);
  assert.equal(archiveSizeMb(dir), 0, '目录不存在 ⇒ 0');
  mkdirSync(dir, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
});
