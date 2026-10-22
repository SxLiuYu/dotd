import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { ControlPlane, MemoryServiceApi, GovernanceApi, RouteResult, RouteRequest } from '../src/shared/contracts.ts';

/**
 * 护栏收口轮的注记必须讲明「材料在上文」（2026-10-22 真机缺陷）。
 *
 * 现场：让 dotd 打开一个电商站读前 3 个商品名。模型重复了 4 轮
 *   open → snapshot → open → snapshot → …
 * 护栏按设计介入：摘掉工具清单（dot.ts:1505 `tools = []`），
 * 让模型「在没有工具可调的情况下」给结论。然后模型回答：
 *
 *   「我没有可用的浏览器工具，因此无法打开该页面并读取内容。
 *     这个环境里只提供了文件读写工具，没有发起网络请求的能力……」
 *
 * 它把「这一轮没给工具」读成了「这个任务根本没有工具」。
 * 而真相是：前几轮的 browser.snapshot 结果就躺在它的上下文里，
 * 商品名和价格全都在。**能力没丢，是它以为丢了。**
 *
 * 原注记只有一句「不要再调用任何工具，直接给出最终结论」——
 * 只说了「别做什么」，没说「你有什么」「从哪拿」。
 *
 * 这个文件锁两件事：
 *   ① 收口注记必须显式指向「上文的工具结果」；
 *   ② 必须明确否定「我没有那个工具」这种误读。
 */
function repeatingRouter(seen: string[]): { complete: (req: RouteRequest) => Promise<RouteResult> } {
  let n = 0;
  return {
    async complete(req: RouteRequest): Promise<RouteResult> {
      n += 1;
      // 把每轮收到的 system 注记抄下来，供断言（护栏注记走 notes → messages）
      for (const m of req.messages ?? []) {
        const c = typeof m.content === 'string' ? m.content : '';
        if (c.includes('反复') || c.includes('收尾') || c.includes('不要再调用')) seen.push(c);
      }
      return {
        response: {
          content: '',
          toolCalls: [{ id: `call_${n}`, name: 'browser.snapshot', arguments: '{}' }],
        },
        meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as unknown as RouteResult;
    },
  };
}

test('行为：护栏收口注记必须说清「答案已在上文的工具结果里」', async () => {
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    const seen: string[] = [];
    const task = {
      id: 'tk_wrapup_note',
      dotId: 'dot1',
      runEpoch: 1,
      threadId: 'thr_w',
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
        router: repeatingRouter(seen) as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
        exec: {
          runTool: async (c: { call_id: string }) => ({
            call_id: c.call_id,
            status: 'ok',
            // 模拟真实快照：内容里有答案，且 ref 编号会变
            result: { output: '- link "Abominable Hoodie" [ref=e1]' },
          }),
          getCapabilities: async () => [
            { name: 'browser.snapshot', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
          ],
          reconcileCall: async () => 'unknown',
          getCallResult: async () => null,
          cancelTool: async () => {},
        } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
        memory: {
          openThread: async () => 'thr_w',
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

    const out = await (
      runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }
    ).runTask(task);

    assert.equal(out.status, 'done', `应正常收口，实际 ${out.status}`);

    const wrapup = seen.filter((c) => c.includes('这一步已经做完'));
    assert.ok(
      wrapup.length > 0,
      `收口注记没送到模型手里。实际收到的相关注记：${seen.slice(-3).join(' ||| ') || '(无)'}`,
    );
    const note = wrapup[wrapup.length - 1]!;

    // ① 必须指向「上文的工具结果」——这是原话缺失的部分
    assert.ok(
      /上文/.test(note) && /工具.*结果|结果.*工具/.test(note),
      `收口注记必须指出答案在上文的工具结果里，实际：${note}`,
    );
    // ② 必须明确否定「我没有那个工具」的误读
    assert.ok(
      /不要再说.*没有.*工具/.test(note),
      `收口注记必须否定「我没有工具」这种误读，实际：${note}`,
    );
    // ③ 仍要保留「别再调工具」的原意（不能为了讲清楚而放松约束）
    assert.ok(/不要再调用任何工具/.test(note), `收口注记仍须禁止再调工具，实际：${note}`);
  } finally {
    tmp.cleanup();
  }
});