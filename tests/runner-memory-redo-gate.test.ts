/**
 * tests/runner-memory-redo-gate.test.ts —— 补写轮的**零成本前置闸门**（2026-10-24）。
 *
 * 背景（实测，证据 docs/acceptance/model-latency/e2e-timeline.txt）：
 *   `needsMemoryRedo` 的判据是"这次没写过记忆文件"，对"3+5 等于几"同样成立，
 *   于是每个短问答在收口前都多跑一轮模型（1.5–1.9 s，结果全是 SKIP），
 *   而这一轮发生在 `cp.finish()` 之前 —— 设备一直 `device_busy`，
 *   连续对话每句都要多等这么久。
 *
 * 闸门只做本地判断，不调模型：
 *   1. 偏好词命中 → **必须问**（纯口头偏好最该记）；
 *   2. 零工具 + 短回答 → 跳过；
 *   3. 同 thread 节流窗口内已问过 + 零工具 → 跳过（有工具的任务不受节流限制）。
 *
 * 这些用例盯的就是"省调用"和"别省错"两件事同时成立。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type {
  ControlPlane,
  MemoryServiceApi,
  GovernanceApi,
  RouteRequest,
  RouteResult,
} from '../src/shared/contracts.ts';

interface RigOpts {
  /** 主循环的回复序列；每个元素要么是正文，要么带工具调用。 */
  main: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>;
  goal?: string;
  runnerOpts?: Record<string, unknown>;
  /** 补写轮回复（默认 SKIP）。 */
  redo?: { content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
}

function isRedoRequest(r: RouteRequest): boolean {
  const first = r.messages[0];
  return (
    first !== undefined &&
    first.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.startsWith('任务已经结束。现在做最后一件收尾动作')
  );
}

async function makeRig(opts: RigOpts) {
  const tmp = makeTempDataDir();
  const requests: RouteRequest[] = [];
  const notes: string[] = [];
  let mainIdx = 0;
  let stepCount = 0;

  const task = {
    id: 'tk_gate',
    dotId: 'dot1',
    runEpoch: 1,
    threadId: 'thr_gate',
    title: 't',
    goal: opts.goal ?? '用一句话回答：3+5 等于几？',
    budgetTokens: 100000,
    resumeFromSeq: null,
  };

  const router = {
    async complete(req: RouteRequest): Promise<RouteResult> {
      requests.push(req);
      if (isRedoRequest(req)) {
        const r = opts.redo ?? { content: 'SKIP' };
        return {
          response: { content: r.content, toolCalls: r.toolCalls ?? [] },
          meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
          usage: { promptTokens: 1, completionTokens: 1 },
        } as unknown as RouteResult;
      }
      // 循环取：同一个 rig 里跑第二个任务时，它也该看到同一套主循环剧本
      const resp = opts.main[mainIdx % opts.main.length]!;
      mainIdx += 1;
      return {
        response: { content: resp.content, toolCalls: resp.toolCalls ?? [] },
        meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as unknown as RouteResult;
    },
  };

  const cp = {
    pop: () => null,
    getTask: () => ({ ...task, status: 'running' }),
    bindSession: () => {},
    finish: () => {},
    failTask: () => {},
    pauseByReason: () => {},
    setAwaitingApproval: () => {},
    heartbeat: () => ({ aborted: false, overBudget: false }),
    journal: {
      beginLlm: () => ({ seq: ++stepCount, callId: `llm_${stepCount}` }),
      endLlm: () => {},
      beginTool: () => ({ seq: ++stepCount, callId: `tool_${stepCount}` }),
      endTool: () => {},
      skipStep: () => {},
      markPending: () => {},
      resumeStep: () => ({ callId: '' }),
      tail: () => [],
      getStepByCallId: () => null,
    },
  } as unknown as ControlPlane;

  const runner = new DotRunner(
    {
      cp,
      router: router as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: {
        runTool: async (c: { call_id: string }) => ({ call_id: c.call_id, status: 'ok', result: { ok: true } }),
        getCapabilities: async () => [
          { name: 'fs.write', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'unknown' },
          { name: 'fs.read', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
        ],
        reconcileCall: async () => 'unknown',
        getCallResult: async () => null,
        cancelTool: async () => {},
      } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
      memory: {
        openThread: async () => 'thr_gate',
        appendMessage: async () => ({ id: 'm', seq: 1 }),
        appendSystemMessage: async () => ({ id: 'm', seq: 1 }),
        buildContextBundle: async () => ({ memoryMd: '', manualExcerpts: [], summary: null }),
        buildSessionReplay: async () => [],
        beforeWrite: async () => ({ ok: true }),
        sealTask: async () => {},
        needsMemoryRedo: async () => true,
        markMemoryReminder: () => {},
      } as unknown as MemoryServiceApi,
      governance: {
        evaluate: async () => ({ kind: 'allow' as const, decisionId: 'd' }),
        claim: async () => ({ ok: false }),
        forceApproval: async () => ({ approvalId: 0 }),
      } as unknown as GovernanceApi,
    },
    { idlePollMs: 5, log: (m: string) => notes.push(m), memoryRedo: true, ...opts.runnerOpts } as never,
  );

  const run = async (which: 'runTask' | 'runNext' = 'runTask') => {
    if (which === 'runNext') return (runner as unknown as { runNext: () => Promise<{ status: string }> }).runNext();
    return (runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }).runTask(task);
  };

  return { tmp, task, requests, notes, runner, run };
}

const SHORT = { content: '3+5 等于 8。' };
const LONG = { content: '好的，我从三个方面说明：'.padEnd(200, '这') };

test('闸门 2：零工具 + 短回答 → 不发起补写轮（省一次模型往返）', async () => {
  const rig = await makeRig({ main: [SHORT] });
  try {
    const out = await rig.run();
    assert.equal(out.status, 'done');
    assert.equal(rig.requests.length, 1, `只该有主循环那一次模型调用，实际 ${rig.requests.length}`);
    assert.equal(rig.requests.filter(isRedoRequest).length, 0);
    assert.ok(
      rig.notes.some((n) => n.includes('补写轮跳过')),
      `应留下"跳过"的可排查日志，实际：${rig.notes.slice(-3).join(' | ')}`,
    );
  } finally {
    rig.tmp.cleanup();
  }
});

test('闸门 1：目标里出现偏好词（以后）→ 即使零工具短回答也照常补写', async () => {
  const rig = await makeRig({
    main: [SHORT],
    goal: '以后回答都用中文，并记住我的时区是东八区',
  });
  try {
    const out = await rig.run();
    assert.equal(out.status, 'done');
    assert.equal(
      rig.requests.filter(isRedoRequest).length,
      1,
      '偏好类内容没有工具可依，恰恰最该进长期记忆，不能被闸门省掉',
    );
  } finally {
    rig.tmp.cleanup();
  }
});

test('闸门 1：回答里出现偏好词（记住）也算', async () => {
  const rig = await makeRig({ main: [{ content: '记住了，以后都这样。' }] });
  try {
    await rig.run();
    assert.equal(rig.requests.filter(isRedoRequest).length, 1);
  } finally {
    rig.tmp.cleanup();
  }
});

test('闸门 3：长回答（无工具）第一次问，同 thread 立刻第二次 → 节流跳过', async () => {
  const rig = await makeRig({ main: [LONG] });
  try {
    await rig.run();
    assert.equal(rig.requests.filter(isRedoRequest).length, 1, '第一次应问（回答长，可能有经验）');
    // 同一 runner、同一 thread，第二个任务
    const second = await (rig.runner as unknown as {
      runTask: (t: unknown) => Promise<{ status: string }>;
    }).runTask({ ...rig.task, id: 'tk_gate_2' });
    assert.equal(second.status, 'done');
    assert.equal(
      rig.requests.filter(isRedoRequest).length,
      1,
      '同一个 thread 在节流窗口内只问一次；第二次必须跳过',
    );
    assert.ok(rig.notes.some((n) => n.includes('同 thread')));
  } finally {
    rig.tmp.cleanup();
  }
});

test('节流不误伤：有工具派发的任务仍然每次都问', async () => {
  const rig = await makeRig({
    main: [
      { content: '', toolCalls: [{ id: 'c1', name: 'fs.read', arguments: '{"path":"notes/a.md"}' }] },
      { content: '做完了。' },
    ],
  });
  try {
    await rig.run();
    const first = rig.requests.filter(isRedoRequest).length;
    assert.equal(first, 1, '有工具 → 第一次要问');
    await (rig.runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }).runTask({
      ...rig.task,
      id: 'tk_gate_2',
    });
    assert.equal(
      rig.requests.filter(isRedoRequest).length,
      2,
      '动作型任务才是记忆的主要来源，不能被同 thread 节流掉',
    );
  } finally {
    rig.tmp.cleanup();
  }
});

test('闸门可关：memoryRedoGate=false → 逐字回到老行为（短问答也问一轮）', async () => {
  const rig = await makeRig({ main: [SHORT], runnerOpts: { memoryRedoGate: false } });
  try {
    await rig.run();
    assert.equal(
      rig.requests.filter(isRedoRequest).length,
      1,
      '关掉闸门 = 2026-10-24 之前的行为，用于对照与紧急回退',
    );
  } finally {
    rig.tmp.cleanup();
  }
});
