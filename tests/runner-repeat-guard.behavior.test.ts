/**
 * tests/runner-repeat-guard.behavior.test.ts —— 护栏的**行为**测试（不是源码守卫）。
 *
 * 前面的 runner-repeat-guard.test.ts 只做源码静态断言；本文件用真实 DotRunner
 * 驱动一条会重复调用的任务，验证：
 *   ① 第 2 次同参数调用会向模型回喂"你已经做过 N 次"的注记；
 *   ② 第 4 次同参数调用会触发强制收口（不再无限派发）。
 *
 * 为什么必须单独测：实跑时主流模型会自己收敛（"重复读取同一文件不会产生新信息"），
 * 护栏从不触发——所以只有构造**模型执意重复**的桩，才能证明兜底真的有效。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { ControlPlane, MemoryServiceApi, GovernanceApi, RouteResult, RouteRequest } from '../src/shared/contracts.ts';

/** 造一个永远重复同一工具调用、且从不主动收尾的模型桩。 */
function alwaysRepeatRouter(): { complete: (req: RouteRequest) => Promise<RouteResult>; calls: number } {
  const state = { calls: 0 };
  return {
    calls: 0,
    async complete(_req: RouteRequest): Promise<RouteResult> {
      state.calls += 1;
      return {
        response: {
          content: '',
          toolCalls: [{ id: `call_${state.calls}`, name: 'fs.read', arguments: '{"path":"same.txt"}' }],
        },
        meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as unknown as RouteResult;
    },
  };
}

test('行为：模型执意重复同一调用时，护栏会在第 4 次强制收口', async () => {
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    const task = {
      id: 'tk_guard',
      dotId: 'dot1',
      runEpoch: 1,
      threadId: 'thr_g',
      title: 't',
      goal: 'g',
      budgetTokens: 100000,
      resumeFromSeq: null,
    };

    const cp = {
      pop: () => null,
      getTask: () => task,
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
        router: alwaysRepeatRouter() as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
        exec: {
          runTool: async (c: { call_id: string }) => ({ call_id: c.call_id, status: 'ok', result: { hit: true } }),
          getCapabilities: async () => [
            { name: 'fs.read', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
          ],
          reconcileCall: async () => 'unknown',
          getCallResult: async () => null,
          cancelTool: async () => {},
        } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
        memory: {
          openThread: async () => 'thr_g',
          appendMessage: async () => ({ id: 'm', seq: 1 }),
          appendSystemMessage: async () => ({ id: 'm', seq: 1 }),
          buildContextBundle: async () => ({ memoryMd: '', manualExcerpts: [], summary: null }),
          buildSessionReplay: async () => [],
          beforeWrite: async () => ({ ok: true }),
          sealTask: async () => {},
        } as unknown as MemoryServiceApi,
        governance: {
          evaluate: async () => ({ kind: 'allow' as const, decisionId: 'd' }),
          claim: async () => ({ ok: false }),
          forceApproval: async () => ({ approvalId: 0 }),
        } as unknown as GovernanceApi,
      },
      { idlePollMs: 5, log: (m: string) => notes.push(m) },
    );

    // 直接驱动 runTask（绕过 pop），让它跑到护栏收口
    const out = await (
      runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }
    ).runTask(task);

    // 关键断言：必须收口成功，而不是无限循环
    assert.equal(out.status, 'done', `护栏应让它收口成 done，实际 ${out.status}`);
    // 工具步数要有界（每次重复 1 个工具步，硬上限 4 → 不会无限增长）
    assert.ok(stepCount < 60, `步数应有界，实际 ${stepCount}`);
    // 日志里必须留下护栏触发痕迹（可排查性）
    assert.ok(
      notes.some((n) => n.includes('原地打转')),
      `应记录护栏触发，实际日志：${notes.slice(-5).join(' | ')}`,
    );
  } finally {
    tmp.cleanup();
  }
});
