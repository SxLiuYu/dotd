/**
 * tests/proof-timeline.test.ts —— 任务分段时间线（2026-10-24）。
 *
 * 为什么值得单测：这条时间线是"这轮为什么慢"的**唯一**现成答案。
 * 2026-10-24 为了回答这个问题，手工起了三次临时 daemon、直接查 steps/model_call_log。
 * 它一旦算错（比如把补写轮漏掉、把 setup 算成 0），会让下一次优化走错方向。
 *
 * 同时钉住兼容口径：**没有步骤时 proof 里不出现 timeline 键**，
 * 老凭证的形状（以及"内容不变 → hash 不变"）不受影响。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProof, type ProofInput } from '../src/surfaces/proof.ts';
import { computeTimeline, MEMORY_REDO_MARK } from '../src/shared/timeline.ts';
import type { Step, Task } from '../src/shared/contracts.ts';

const T0 = Date.parse('2026-10-24T10:00:00Z');

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 'tk_tl',
    dotId: 'dot1',
    title: 't',
    goal: 'g',
    status: 'done',
    priority: 1,
    runAt: null,
    sourceEventId: null,
    sessionId: null,
    threadId: null,
    attempt: 1,
    maxAttempts: 3,
    runEpoch: 1,
    lastHeartbeatAt: T0,
    budgetTokens: 100_000,
    usageTokens: 0,
    resumeFromSeq: null,
    stopReason: null,
    createdAt: T0,
    updatedAt: T0 + 3_300,
    ...over,
  };
}

function stepOf(over: Partial<Step> = {}): Step {
  return {
    taskId: 'tk_tl',
    seq: 1,
    kind: 'llm',
    status: 'succeeded',
    callId: 'c1',
    toolName: null,
    argsJson: '用一句话回答：3+5 等于几？',
    resultJson: '3+5 等于 8。',
    sideEffect: 'safe',
    runEpoch: 1,
    approvalId: null,
    startedAt: T0 + 300,
    finishedAt: T0 + 1_700,
    ...over,
  };
}

function inputOf(steps: Step[]): ProofInput {
  return {
    task: taskOf(),
    steps,
    execCalls: [],
    approvals: [],
    modelCalls: [],
    audit: [],
    result: { ok: 1, summary: 'ok' },
    generatedAt: T0 + 5_000,
  };
}

test('computeTimeline：setup / llm / tool / tail 四段拆得开', () => {
  const steps: Step[] = [
    stepOf({ seq: 1, kind: 'llm', startedAt: T0 + 300, finishedAt: T0 + 1_700 }),
    stepOf({ seq: 2, kind: 'tool', callId: 'c2', toolName: 'fs.read', startedAt: T0 + 1_750, finishedAt: T0 + 2_050 }),
    stepOf({ seq: 3, kind: 'llm', startedAt: T0 + 2_100, finishedAt: T0 + 3_100 }),
  ];
  const tl = computeTimeline({ createdAt: T0, updatedAt: T0 + 3_300, steps });
  assert.ok(tl !== null);
  assert.equal(tl.totalMs, 3_300);
  assert.equal(tl.setupMs, 300, '创建 → 第一步开始');
  assert.deepEqual(tl.llmMs, [1_400, 1_000]);
  assert.deepEqual(tl.toolMs, [300]);
  assert.equal(tl.llmTotalMs, 2_400);
  assert.equal(tl.toolTotalMs, 300);
  assert.equal(tl.tailMs, 200, '最后一步 → 任务终态（finish/seal）');
  assert.equal(tl.memoryRedoMs, null, '普通对话轮不该被认成补写轮');
});

test('computeTimeline：补写轮单独标出来（args 以 MEMORY_REDO_MARK 开头）', () => {
  const steps: Step[] = [
    stepOf({ seq: 1, kind: 'llm', startedAt: T0 + 200, finishedAt: T0 + 2_000 }),
    stepOf({
      seq: 2,
      kind: 'llm',
      callId: 'c2',
      argsJson: `${MEMORY_REDO_MARK}：判断本次工作有没有值得长期保留的经验。\n（还没有成功派发过工具）`,
      resultJson: 'memory_redo:skip',
      startedAt: T0 + 2_050,
      finishedAt: T0 + 3_600,
    }),
  ];
  const tl = computeTimeline({ createdAt: T0, updatedAt: T0 + 3_650, steps });
  assert.ok(tl !== null);
  assert.equal(tl.memoryRedoMs, 1_550, '补写轮耗时必须能一眼看到（这是设备被占住的那段）');
  assert.deepEqual(tl.llmMs, [1_800, 1_550], '补写轮同时仍是一条 llm 步');
});

test('computeTimeline：没有步骤 → null（空任务不编时间线）', () => {
  assert.equal(computeTimeline({ createdAt: T0, updatedAt: T0 + 100, steps: [] }), null);
});

test('computeTimeline：脏数据（未结束的步）不崩、不计入分项', () => {
  const steps: Step[] = [
    stepOf({ seq: 1, kind: 'llm', startedAt: T0 + 100, finishedAt: null }),
    stepOf({ seq: 2, kind: 'llm', startedAt: T0 + 200, finishedAt: T0 + 400 }),
  ];
  const tl = computeTimeline({ createdAt: T0, updatedAt: T0 + 500, steps });
  assert.ok(tl !== null);
  assert.deepEqual(tl.llmMs, [200], '未结束的步只影响 tail，不进时长数组');
  assert.ok(tl.tailMs >= 0);
});

test('proof：有步骤时带 timeline，且同一个 journal 两次导出一致', () => {
  const steps = [stepOf({ seq: 1 }), stepOf({ seq: 2, kind: 'tool', callId: 'c2', toolName: 'fs.read' })];
  const a = buildProof(inputOf(steps));
  const b = buildProof({ ...inputOf(steps), generatedAt: T0 + 99_999 });
  assert.ok(a.timeline !== undefined, '应带 timeline');
  assert.deepEqual(a.timeline, b.timeline, '导出时间不影响时间线');
  assert.equal(a.bundleHash, b.bundleHash);
});

test('proof：没有步骤时不出现 timeline 键（老凭证形状不变）', () => {
  const p = buildProof(inputOf([]));
  assert.equal('timeline' in p, false);
});
