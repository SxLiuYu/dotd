/**
 * tests/runner-deny-repeat-guard.test.ts —— 被治理拒掉的调用也必须触发原地打转护栏。
 *
 * 2026-10-22 真机缺陷（147 步失控）：
 *
 *   容器被隔离后，所有工具回 `container_not_ready`。模型转而反复发 `bash`
 *   —— 它不在白名单里 —— 治理 deny「工具未登记」。
 *   每次 deny 都 skipStep + 回喂 + continue，是**正确的**局部行为；
 *   但 `recordRepeatResult` 只挂在派发成功/失败那条路上（dot.ts:2442），
 *   被拒的调用压根没进 repeatGuard 的账本。于是：
 *
 *     · 同一个被拒的调用重复了 70 次，sameResultCount 一直是 0；
 *     · 护栏一声不响，任务一路烧到 147 步；
 *     · 步数硬上限是 2000（journal.ts:494），远在它够不着的地方。
 *
 * 「被拒」也是结果，而且是最能说明模型在打转的那种：
 * 它不是在等新信息，它是在反复撞同一堵墙。
 *
 * 这个测试模拟「模型只会发被拒的工具」这一种模型，断言它在
 * REPEAT_MAX_SKIPS 轮内被收口，而不是跑到 2000 步。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { ControlPlane, MemoryServiceApi, GovernanceApi, RouteResult, RouteRequest } from '../src/shared/contracts.ts';

/** 永远只想调 bang（治理一直 deny）的模型。 */
function alwaysDeniedRouter(): { complete: (req: RouteRequest) => Promise<RouteResult> } {
  let n = 0;
  return {
    async complete(req: RouteRequest): Promise<RouteResult> {
      n += 1;
      // 收口轮（护栏摘了工具）时给一句正文，好让任务正常结束
      if ((req.tools ?? []).length === 0) {
        return {
          response: { content: '收尾：这个动作做不了，以现有信息为准。', toolCalls: [] },
          meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
          usage: { promptTokens: 1, completionTokens: 1 },
        } as unknown as RouteResult;
      }
      return {
        response: {
          content: '',
          // 每轮参数完全一样 —— 真机上就是反复撞同一堵墙
          toolCalls: [{ id: `c${n}`, name: 'bash', arguments: '{"cmd":"ls"}' }],
        },
        meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as unknown as RouteResult;
    },
  };
}

test('被治理拒掉的调用重复多次，必须在几轮内被护栏收口（不能烧到 2000 步）', async () => {
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    let llmRounds = 0;

    const task = {
      id: 'tk_deny_loop',
      dotId: 'dot1',
      runEpoch: 1,
      threadId: 'thr_d',
      title: 't',
      goal: 'g',
      budgetTokens: 10_000_000, // 预算故意给足：这条测试盯的是护栏，不是预算
      resumeFromSeq: null,
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
        beginLlm: () => {
          llmRounds += 1;
          return { seq: ++stepCount, callId: `llm_${stepCount}` };
        },
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
        router: alwaysDeniedRouter() as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
        exec: {
          runTool: async (c: { call_id: string }) => ({ call_id: c.call_id, status: 'ok', result: {} }),
          getCapabilities: async () => [
            { name: 'fs.read', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
          ],
          reconcileCall: async () => 'unknown',
          getCallResult: async () => null,
          cancelTool: async () => {},
        } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
        memory: {
          openThread: async () => 'thr_d',
          appendMessage: async () => ({ id: 'm', seq: 1 }),
          appendSystemMessage: async () => ({ id: 'm', seq: 1 }),
          buildContextBundle: async () => ({ memoryMd: '', manualExcerpts: [], summary: null }),
          buildSessionReplay: async () => [],
          beforeWrite: async () => ({ ok: true }),
          sealTask: async () => {},
          needsMemoryRedo: async () => false,
        } as unknown as MemoryServiceApi,
        governance: {
          // 治理一直拒绝：模拟「工具未登记」
          evaluate: async () => ({ kind: 'deny' as const, reason: '工具未登记' }),
          claim: async () => ({ ok: false }),
          forceApproval: async () => ({ approvalId: 0 }),
        } as unknown as GovernanceApi,
      },
      { idlePollMs: 5, log: (m: string) => notes.push(m) },
    );

    const out = await (
      runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }
    ).runTask(task);

    assert.equal(out.status, 'done', `应被收口成 done，实际 ${out.status}`);
    assert.ok(
      llmRounds <= 5,
      `被拒调用重复应在 5 轮内被收口，实际跑了 ${String(llmRounds)} 轮 LLM（真机曾烧到 147 步）。` +
        `日志：${notes.slice(-4).join(' | ')}`,
    );
    // 护栏必须真的报出「在原地打转」，而不是靠别的机制碰巧停下
    assert.ok(
      notes.some((n) => n.includes('原地打转') || n.includes('护栏')),
      `应留下护栏介入的日志，实际：${notes.slice(-4).join(' | ')}`,
    );
  } finally {
    tmp.cleanup();
  }
});
test('被拒调用：参数每次微调也必须被拦住（治理只看工具名，不看参数）', async () => {
  // 2026-10-22 第二次真机修，同一现场。第一条测试用的是**完全相同的参数**，
  // 所以按 (工具,参数) 记账就够了。真机上模型并不那么老实 —— 它会在参数里
  // 塞点无关字段（实测是 description 换措辞）：
  //
  //   bash :: {"command":"ls -la","description":"Inspect repo root"}
  //   bash :: {"command":"ls -la","description":"List working directory"}
  //   bash :: {"command":"ls -la","description":"List repo root and notes"}
  //
  // 25 次 bash、21 个不同 key、结果**全部**是同一句 `deny:工具未登记`。
  // 每个 key 的 sameResultCount 都到不了 3，护栏继续沉默，任务烧到 72 步以上。
  //
  // 根因：治理判定 deny 走 `lookupTool(name)` —— **只看工具名，不看参数**。
  // 参数怎么改都不会让 bash 变合法。所以记账也不能按参数分流。
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    let llmRounds = 0;
    const task = { id: 'tk_deny_loop_vary', dotId: 'dot1', runEpoch: 1, threadId: 'thr_dv', title: 't', goal: 'g', budgetTokens: 10_000_000, resumeFromSeq: null };

    const routerStub = {
      async complete(req: RouteRequest): Promise<RouteResult> {
        if ((req.tools ?? []).length === 0) {
          return { response: { content: '收尾：做不了，以现有信息为准。', toolCalls: [] },
            meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
            usage: { promptTokens: 1, completionTokens: 1 } } as unknown as RouteResult;
        }
        // 每轮参数都不同 —— 用轮次号塞进 description，模拟模型换措辞
        const n = ++llmRounds;
        return { response: { content: '', toolCalls: [{ id: `c${n}`, name: 'bash',
          arguments: JSON.stringify({ command: 'ls -la', description: `attempt ${n} wording` }) }] },
          meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
          usage: { promptTokens: 1, completionTokens: 1 } } as unknown as RouteResult;
      },
    };

    const cp = { pop: () => null, getTask: () => ({ ...task, status: 'running' }), bindSession: () => {},
      finish: () => {}, failTask: () => {}, pauseByReason: () => {}, setAwaitingApproval: () => {},
      heartbeat: () => ({ aborted: false, overBudget: false }),
      journal: { beginLlm: () => ({ seq: ++stepCount, callId: `llm_${stepCount}` }), endLlm: () => {},
        beginTool: () => ({ seq: ++stepCount, callId: `tool_${stepCount}` }), endTool: () => {},
        skipStep: () => {}, markPending: () => {}, resumeStep: () => ({ callId: '' }),
        tail: () => [], getStepByCallId: () => null } } as unknown as ControlPlane;

    const runner = new DotRunner({
      cp,
      router: routerStub as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: { runTool: async (c: { call_id: string }) => ({ call_id: c.call_id, status: 'ok', result: {} }),
        getCapabilities: async () => [{ name: 'fs.read', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' }],
        reconcileCall: async () => 'unknown', getCallResult: async () => null, cancelTool: async () => {} } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
      memory: { openThread: async () => 'thr_dv', appendMessage: async () => ({ id: 'm', seq: 1 }),
        appendSystemMessage: async () => ({ id: 'm', seq: 1 }),
        buildContextBundle: async () => ({ memoryMd: '', manualExcerpts: [], summary: null }),
        buildSessionReplay: async () => [], beforeWrite: async () => ({ ok: true }),
        sealTask: async () => {}, needsMemoryRedo: async () => false } as unknown as MemoryServiceApi,
      governance: { evaluate: async () => ({ kind: 'deny' as const, reason: '工具未登记' }),
        claim: async () => ({ ok: false }), forceApproval: async () => ({ approvalId: 0 }) } as unknown as GovernanceApi,
    }, { idlePollMs: 5, log: (m: string) => notes.push(m) });

    const out = await (runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }).runTask(task);
    assert.equal(out.status, 'done', `应被收口成 done，实际 ${out.status}`);
    assert.ok(llmRounds <= 6,
      `参数不断变化也必须被拦住，实际跑了 ${String(llmRounds)} 轮 LLM（真机烧到 72 步以上）。日志：${notes.slice(-4).join(' | ')}`);
  } finally {
    tmp.cleanup();
  }
});