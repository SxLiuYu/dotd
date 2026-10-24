/**
 * tests/surfaces-proof.test.ts —— 执行凭证（P1，2026-10-23）。
 *
 * 守四件事：
 *   1. 同一个 journal 两次导出 bundleHash 一致（导出时间不影响）；
 *   2. journal 与方法记账（exec_calls）对不上时，hashMatch=false 必须显形；
 *   3. 默认不导出明文参数；--args 才给预览；
 *   4. 空任务（只有部分表有记录）不崩，缺的维度明说而不是编。
 *
 * 这里**不证明**数据库未被篡改——凭证的边界就写在 PROOF.md 里，测试也守着那句话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProof,
  collectProof,
  renderProofMarkdown,
  type ProofInput,
} from '../src/surfaces/proof.ts';
import { argsHash, resultHash } from '../src/exec/protocol.ts';
import type { Step, Task } from '../src/shared/contracts.ts';
import { makeTempDataDir } from './helpers.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 'tk1',
    dotId: 'dot1',
    title: '核对报价单',
    goal: '把今天的报价单核对一遍，异常标出来',
    status: 'done',
    priority: 1,
    runAt: null,
    sourceEventId: null,
    sessionId: null,
    threadId: null,
    attempt: 1,
    maxAttempts: 3,
    runEpoch: 1,
    lastHeartbeatAt: NOW - 1000,
    budgetTokens: 100_000,
    usageTokens: 1234,
    resumeFromSeq: null,
    stopReason: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...over,
  };
}

function stepOf(over: Partial<Step> = {}): Step {
  return {
    taskId: 'tk1',
    seq: 1,
    kind: 'tool',
    status: 'succeeded',
    callId: 'c1',
    toolName: 'fs.read',
    argsJson: null,
    resultJson: null,
    sideEffect: 'safe',
    runEpoch: 1,
    approvalId: null,
    startedAt: NOW - 30_000,
    finishedAt: NOW - 29_000,
    ...over,
  };
}

function inputOf(over: Partial<ProofInput> = {}): ProofInput {
  return {
    task: taskOf(),
    steps: [],
    execCalls: [],
    approvals: [],
    modelCalls: [],
    audit: [],
    result: { ok: 1, summary: '核对完成，2 处异常' },
    generatedAt: NOW,
    ...over,
  };
}

test('bundleHash 只取决于内容：同一 journal 不同导出时间 → 同一 hash', () => {
  const a = buildProof(inputOf({ generatedAt: NOW }));
  const b = buildProof(inputOf({ generatedAt: NOW + 86_400_000 }));
  assert.equal(a.bundleHash, b.bundleHash);
  assert.notEqual(a.generatedAt, b.generatedAt);
  assert.match(a.bundleHash, /^[0-9a-f]{64}$/);
});

test('任何一步变化都会改 bundleHash（不是只把任务 id 哈希一遍）', () => {
  const base = buildProof(inputOf());
  const changed = buildProof(inputOf({ steps: [stepOf({ status: 'failed' })] }));
  assert.notEqual(base.bundleHash, changed.bundleHash);
});

test('方法记账一致 → hashMatch=true；用的正是 exec_calls 的权威哈希', () => {
  const args = { path: '/dot/home/a.txt' };
  const result = { text: 'hello' };
  const b = buildProof(
    inputOf({
      steps: [stepOf({ argsJson: JSON.stringify(args), resultJson: JSON.stringify(result) })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: argsHash(args),
          resultHash: resultHash(result),
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, true);
  assert.equal(b.steps[0]!.argsHash, argsHash(args));
  assert.equal(b.counts.hashMismatches, 0);
});

test('journal 与 exec_calls 不一致 → hashMatch=false，且计数显形（不吞）', () => {
  const b = buildProof(
    inputOf({
      steps: [stepOf({ argsJson: '{"path":"/dot/home/a.txt"}' })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: 'deadbeef'.repeat(8),
          resultHash: null,
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, false);
  assert.equal(b.counts.hashMismatches, 1);
  assert.match(renderProofMarkdown(b), /不一致/);
});

test('没有 exec_calls / args 是 blob 指针 → hashMatch=null（无从比对），不假装一致', () => {
  const b = buildProof(
    inputOf({
      steps: [
        stepOf({ seq: 1, callId: 'c1', argsJson: null }),
        stepOf({ seq: 2, callId: 'c2', argsJson: 'journal-blobs/abc.json' }),
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, null);
  assert.equal(b.steps[1]!.hashMatch, null);
  assert.equal(b.counts.hashUnverifiable, 2);
  assert.match(renderProofMarkdown(b), /无从比对/);
});

test('默认不导出明文参数（token/正文不外泄）；JSON 里连键名都不该出现', () => {
  const secret = 'sk-live-THIS-MUST-NOT-LEAK';
  const args = { token: secret, body: '给客户的报价' };
  const b = buildProof(
    inputOf({
      steps: [stepOf({ argsJson: JSON.stringify(args) })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: argsHash(args),
          resultHash: null,
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  const json = JSON.stringify(b);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes('给客户的报价'), false);
  assert.equal(b.steps[0]!.argsPreview, undefined);
});

test('--args 才给预览（明确 opt-in）', () => {
  const b = buildProof(
    inputOf({
      steps: [stepOf({ argsJson: '{"path":"/dot/home/a.txt"}', resultJson: '"ok"' })],
      includeArgs: true,
    }),
  );
  assert.match(b.steps[0]!.argsPreview ?? '', /a\.txt/);
  assert.match(b.steps[0]!.resultPreview ?? '', /ok/);
});

test('空任务：只有任务骨架 → 计数为 0，Markdown 仍可读，不编造步骤', () => {
  const b = buildProof(inputOf());
  assert.deepEqual(b.counts, {
    steps: 0,
    toolSteps: 0,
    failedSteps: 0,
    approvals: 0,
    modelCalls: 0,
    hashMismatches: 0,
    hashUnverifiable: 0,
  });
  const md = renderProofMarkdown(b);
  assert.match(md, /没有步骤记录/);
  assert.match(md, /没有模型调用记录/);
  assert.match(md, /这次任务没有触发审批/);
  assert.match(md, /不是第三方公证/);
});

test('审批与模型调用会进凭证：能回答「谁批的 / 走的哪个模型」', () => {
  const b = buildProof(
    inputOf({
      steps: [stepOf({ seq: 1, kind: 'llm', toolName: null, status: 'succeeded', approvalId: null })],
      approvals: [
        {
          id: 7,
          seq: 12,
          kind: 'tool_call',
          tool: 'mail.send',
          tier: 'dangerous',
          status: 'approved',
          summary: '发送报价单给客户',
          reason: '收件人在白名单内',
          decidedAt: '2026-10-23 11:58:00',
          decidedBy: 'web',
          note: null,
          finalParamsJson: '{"to":"a@b.com"}',
        },
      ],
      modelCalls: [
        {
          attemptId: 'c1',
          attemptSeq: 0,
          track: 'primary',
          endpointId: 'deepseek',
          model: 'deepseek-chat',
          outcome: 'ok',
          degraded: 0,
          latencyMs: 812,
          promptTokens: 900,
          completionTokens: 120,
          ts: NOW,
        },
      ],
    }),
  );
  assert.equal(b.approvals[0]!.decidedBy, 'web');
  assert.match(b.approvals[0]!.finalParamsHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(b.modelCalls[0]!.model, 'deepseek-chat');
  const md = renderProofMarkdown(b);
  assert.match(md, /mail\.send/);
  assert.match(md, /deepseek-chat/);
});

test('collectProof：从真库（exec_calls / 审批 / 模型日志 / 审计 / 结果）取数', () => {
  const dir = makeTempDataDir();
  try {
    const db = dir.db;
    db.prepare(
      `INSERT INTO tasks (id, dot_id, title, goal, status, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('tk1', 'dot1', '核对报价单', '核对报价单', 'done', 1, NOW - 60_000, NOW);
    const args = { path: '/dot/home/a.txt' };
    const res = { text: 'hello' };
    db.prepare(
      `INSERT INTO exec_calls
         (call_id, task_id, dot_id, tool, mode, args_hash, state, result_hash, sent_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('c1', 'tk1', 'dot1', 'fs.read', 'sync', argsHash(args), 'done', resultHash(res), '2026-10-23 11:59:30', '2026-10-23 11:59:31');
    db.prepare(
      `INSERT INTO approvals
         (seq, kind, dot_id, task_id, journal_step, tool, tier, params_json, summary, reason,
          status, pending_until, decided_at, decided_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(3, 'tool_call', 'dot1', 'tk1', 'c1', 'fs.read', 'read', '{}', '读报价单', '只读', 'approved', '2026-10-24 11:00:00', '2026-10-23 11:59:00', 'cli');
    db.prepare(
      `INSERT INTO model_call_log
         (attempt_id, attempt_seq, track, endpoint_id, model, degraded, outcome, latency_ms, prompt_tokens, completion_tokens, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('c1', 0, 'primary', 'deepseek', 'deepseek-chat', 0, 'ok', 900, 1000, 200, NOW);
    db.prepare(
      `INSERT INTO audit_log (ts, dot_id, task_id, actor, action, tool, decision, reason)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('2026-10-23 11:59:00', 'dot1', 'tk1', 'owner', 'approval_decided', 'fs.read', 'approved', '只读操作');
    db.prepare('INSERT INTO task_results (task_id, summary, ok) VALUES (?,?,?)').run('tk1', '核对完成', 1);

    const steps = [
      stepOf({ argsJson: JSON.stringify(args), resultJson: JSON.stringify(res), approvalId: 3 }),
      stepOf({ seq: 2, kind: 'llm', callId: 'm1', toolName: null, status: 'succeeded' }),
    ];
    const cp = {
      getTask: (id: string): Task | null => (id === 'tk1' ? taskOf() : null),
      getJournal: (id: string): Step[] => (id === 'tk1' ? steps : []),
    };

    const b = collectProof(db, cp, 'tk1', NOW);
    assert.ok(b !== null);
    assert.equal(b.counts.steps, 2);
    assert.equal(b.counts.toolSteps, 1);
    assert.equal(b.counts.approvals, 1);
    assert.equal(b.counts.modelCalls, 1);
    assert.equal(b.steps[0]!.hashMatch, true);
    assert.equal(b.steps[0]!.approvalId, 3);
    assert.equal(b.result.ok, true);
    assert.equal(b.audit.length, 1);
    assert.equal(b.audit[0]!.actor, 'owner');

    // 同一份库导出两次：hash 必须一致（generatedAt 不同也不影响）
    const again = collectProof(db, cp, 'tk1', NOW + 60_000);
    assert.equal(again!.bundleHash, b.bundleHash);

    // 不存在的任务 → null（HTTP 层据此回 404，不回空凭证）
    assert.equal(collectProof(db, cp, 'nope', NOW), null);
  } finally {
    dir.cleanup();
  }
});

test('执行面把相对 path 补成 /dot/home：判"一致（路径规范化）"，不报篡改', () => {
  // 实测形状（2026-10-23 真模型任务）：模型给 {"path":"."}，Runner 派发前补成
  // {"path":"/dot/home/."} 再记账。两份记录都对，输入不同 → 旧版会报「不一致」。
  const b = buildProof(
    inputOf({
      steps: [stepOf({ toolName: 'fs.list', argsJson: '{"path":"."}' })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: argsHash({ path: '/dot/home/.' }),
          resultHash: null,
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, true);
  assert.equal(b.steps[0]!.argsNormalized, true);
  assert.equal(b.counts.hashMismatches, 0);
  assert.match(renderProofMarkdown(b), /一致（路径规范化）/);
});

test('规范化救不了真不一致：两份都不是 → 仍然是 false', () => {
  const b = buildProof(
    inputOf({
      steps: [stepOf({ toolName: 'fs.list', argsJson: '{"path":"."}' })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: 'deadbeef'.repeat(8),
          resultHash: null,
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, false);
  assert.equal(b.steps[0]!.argsNormalized, undefined);
});

test('绝对路径本就不该被改写：不走规范化分支', () => {
  const args = { path: '/dot/home/notes/a.md' };
  const b = buildProof(
    inputOf({
      steps: [stepOf({ toolName: 'fs.write', argsJson: JSON.stringify(args) })],
      execCalls: [
        {
          callId: 'c1',
          argsHash: argsHash(args),
          resultHash: null,
          errorCode: null,
          state: 'done',
          sentAt: '2026-10-23 11:59:30',
          finishedAt: '2026-10-23 11:59:31',
        },
      ],
    }),
  );
  assert.equal(b.steps[0]!.hashMatch, true);
  assert.equal(b.steps[0]!.argsNormalized, undefined);
});
