/**
 * tests/surfaces-task-summary.test.ts —— L1 任务摘要（M2，2026-10-23）。
 *
 * 守三条语义（见 src/surfaces/task-summary.ts 文件头）：
 *   1. 不编 ETA：没有计划就没有"下一步/进度"；
 *   2. 不把"没记录"说成"没进展"；
 *   3. 在途步让心跳静止时，不误报"卡住"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskSummary, DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../src/surfaces/task-summary.ts';
import type { Step, Task } from '../src/shared/contracts.ts';

const NOW = 1_700_000_000_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'tk_1',
    dotId: 'dot1',
    title: '查一下明天的会议',
    goal: '查一下明天的会议',
    status: 'running',
    priority: 1,
    runAt: null,
    sourceEventId: null,
    sessionId: 'th_1',
    threadId: 'th_1',
    attempt: 0,
    maxAttempts: 3,
    runEpoch: 1,
    lastHeartbeatAt: NOW - 10_000,
    budgetTokens: 200000,
    usageTokens: 0,
    resumeFromSeq: null,
    stopReason: null,
    createdAt: NOW - 120_000,
    updatedAt: NOW - 10_000,
    ...over,
  };
}

function step(over: Partial<Step> = {}): Step {
  return {
    taskId: 'tk_1',
    seq: 1,
    kind: 'tool',
    status: 'succeeded',
    callId: 'c1',
    toolName: 'calendar.list',
    argsJson: '{}',
    resultJson: '{}',
    sideEffect: 'safe',
    runEpoch: 1,
    approvalId: null,
    startedAt: NOW - 60_000,
    finishedAt: NOW - 50_000,
    ...over,
  };
}

test('排队中：不说已用时', () => {
  const s = buildTaskSummary({ task: task({ status: 'queued' }), steps: [], now: NOW });
  assert.equal(s.stateLine, '排队中，还没开始');
  assert.equal(s.elapsedMs, null);
  assert.equal(s.progress, null);
});

test('运行中 + 在途工具步：说正在做什么、这一步多久', () => {
  const s = buildTaskSummary({
    task: task(),
    steps: [
      step(),
      step({ seq: 2, status: 'started', toolName: 'web.open', startedAt: NOW - 30_000, finishedAt: null }),
    ],
    now: NOW,
  });
  assert.equal(s.doing, '打开网页');
  assert.match(s.stateLine, /正在：打开网页/);
  assert.match(s.stateLine, /30 秒/);
  assert.equal(s.stalled, false);
});

test('在途步 200 秒 + 心跳停了：不误报卡住（长命令是老盲区）', () => {
  const s = buildTaskSummary({
    task: task({ lastHeartbeatAt: NOW - 200_000 }),
    steps: [step({ status: 'started', startedAt: NOW - 200_000, finishedAt: null })],
    now: NOW,
  });
  assert.equal(s.stalled, false);
  assert.match(s.stateLine, /这一步已 3 分钟/);
});

test('没有在途步且心跳超时：提示可能卡住', () => {
  const s = buildTaskSummary({
    task: task({ lastHeartbeatAt: NOW - (DEFAULT_HEARTBEAT_TIMEOUT_MS + 10_000) }),
    steps: [step({ finishedAt: NOW - 200_000 })],
    now: NOW,
  });
  assert.equal(s.stalled, true);
  assert.match(s.stateLine, /心跳已停/);
  assert.match(s.stateLine, /可能卡住/);
});

test('等待审批：必须主人出手', () => {
  const s = buildTaskSummary({
    task: task({ status: 'awaiting_approval' }),
    steps: [step({ status: 'started', toolName: 'mail.send', finishedAt: null, approvalId: 7 })],
    now: NOW,
  });
  assert.equal(s.needsOwner, true);
  assert.match(s.stateLine, /停在审批：发邮件/);
});

test('完成：带结果摘要；没有结果也不编', () => {
  const withResult = buildTaskSummary({
    task: task({ status: 'done' }),
    steps: [step()],
    resultSummary: '明天 10:00 有一个评审',
    now: NOW,
  });
  assert.match(withResult.stateLine, /已办完：明天 10:00 有一个评审/);
  const noResult = buildTaskSummary({ task: task({ status: 'done' }), steps: [step()], now: NOW });
  assert.equal(noResult.stateLine, '已办完');
});

test('失败：优先用结果摘要，否则用 stopReason', () => {
  const a = buildTaskSummary({ task: task({ status: 'failed' }), steps: [], resultSummary: '登录态过期', now: NOW });
  assert.match(a.stateLine, /没办成：登录态过期/);
  const b = buildTaskSummary({ task: task({ status: 'failed', stopReason: 'budget' }), steps: [], now: NOW });
  assert.match(b.stateLine, /budget/);
});

test('有计划：给下一步和进度；没有计划一律 null', () => {
  const plan = {
    version: 1,
    revisionReason: '',
    items: [
      { index: 1, text: '查日历', status: 'done' as const },
      { index: 2, text: '整理成一句话', status: 'doing' as const },
      { index: 3, text: '发给主人', status: 'todo' as const },
    ],
  };
  const s = buildTaskSummary({ task: task(), steps: [step()], plan, now: NOW });
  assert.deepEqual(s.progress, { done: 1, total: 3 });
  assert.equal(s.next, '整理成一句话');
  const none = buildTaskSummary({ task: task(), steps: [step()], now: NOW });
  assert.equal(none.next, null);
  assert.equal(none.progress, null);
});

test('刚建的任务没有任何 step：如实说还没第一步，不假装在思考', () => {
  const s = buildTaskSummary({ task: task(), steps: [], now: NOW });
  assert.equal(s.stateLine, '已开始，还没有第一步记录');
  assert.equal(s.doing, null);
  assert.equal(s.elapsedMs, null);
});
