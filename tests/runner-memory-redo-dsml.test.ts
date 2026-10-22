/**
 * tests/runner-memory-redo-dsml.test.ts —— 记忆补写轮必须走同一套 DSML 兜底。
 *
 * 2026-10-22 真机缺陷：主循环的 `completeLlm` 早就在 :1645 接了兜底
 * （正文里出现 DSML 调用块时捞回来），但**记忆补写轮**是直接调
 * `this.router.complete(req)`、自己 map toolCalls —— 绕过了那层归一。
 *
 * 后果：模型在补写轮用正文发意图（而不是发结构化 tool_calls）时，
 * `calls` 为空、正文是裸标签 → 落到 else 分支 →
 * 日志写「补写轮无工具调用（正文 N 字）」，那条该沉淀的经验**静默丢掉**，
 * 而且日志看不出异常（它被归类成"模型自己决定不写"）。
 *
 * 这正是「两处代码各写一遍同一个归一化」的典型代价：
 * 主循环修好了，旁路没修，而旁路恰恰是最难被注意到的地方。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { ControlPlane, MemoryServiceApi, GovernanceApi, RouteResult, RouteRequest } from '../src/shared/contracts.ts';

const SEP = '｜｜DSML｜｜';

/** 记忆补写轮专用桩：第一轮正常收尾，补写轮用**正文裸标签**要写文件。 */
function routerThatEmitsDsmlInRedo(seen: { redoPrompt: boolean; toolNames: string[] }): {
  complete: (req: RouteRequest) => Promise<RouteResult>;
} {
  let n = 0;
  return {
    async complete(req: RouteRequest): Promise<RouteResult> {
      n += 1;
      const sys = (req.messages ?? [])
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      const isRedo = /最后一件收尾动作|值得长期保留的经验|只回复 SKIP/.test(sys);
      if (!isRedo) {
        // 主循环：直接给一句结论收尾（不调工具）
        return {
          response: { content: '任务完成。', toolCalls: [] },
          meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
          usage: { promptTokens: 1, completionTokens: 1 },
        } as unknown as RouteResult;
      }
      seen.redoPrompt = true;
      // 补写轮：**结构化 toolCalls 为空**，正文里放 DSML 块（真机形状）
      const content =
        `<${SEP} calls>\n` +
        `<${SEP} invoke name="fs.write">\n` +
        `<${SEP} parameter name="path" string="true">/dot/home/notes/learned.md</${SEP} parameter>\n` +
        `<${SEP} parameter name="content" string="true">经验正文</${SEP} parameter>\n` +
        `</${SEP} invoke>\n` +
        `</${SEP} calls>`;
      return {
        response: { content, toolCalls: [] },
        meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as unknown as RouteResult;
    },
  };
}

test('补写轮：正文里的 DSML 调用必须被捞回并真的派发', async () => {
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    const seen = { redoPrompt: false, toolNames: [] as string[] };
    const task = {
      id: 'tk_redo_dsml',
      dotId: 'dot1',
      runEpoch: 1,
      threadId: 'thr_r',
      title: 't',
      goal: 'g',
      budgetTokens: 100000,
      resumeFromSeq: null,
    };

    const cp = {
      pop: () => null,
      // :2740 要求取回的任务仍是 running，否则补写轮直接跳过
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
        router: routerThatEmitsDsmlInRedo(seen) as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
        exec: {
          // ExecToolCall 的字段是 tool（不是 name）——见 src/runner/dot.ts 的 toolCall()
          runTool: async (c: { call_id: string; tool: string }) => {
            seen.toolNames.push(c.tool);
            return { call_id: c.call_id, status: 'ok', result: { ok: true } };
          },
          getCapabilities: async () => [
            { name: 'fs.write', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'unknown' },
          ],
          reconcileCall: async () => 'unknown',
          getCallResult: async () => null,
          cancelTool: async () => {},
        } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
        memory: {
          openThread: async () => 'thr_r',
          appendMessage: async () => ({ id: 'm', seq: 1 }),
          appendSystemMessage: async () => ({ id: 'm', seq: 1 }),
          buildContextBundle: async () => ({ memoryMd: '', manualExcerpts: [], summary: null }),
          buildSessionReplay: async () => [],
          beforeWrite: async () => ({ ok: true }),
          sealTask: async () => {},
          // 补写轮的开关探针：没有它 memoryWriteRedo 会直接 return（旧装配的兼容行为）
          needsMemoryRedo: async () => true,
          markMemoryReminder: () => {},
        } as unknown as MemoryServiceApi,
        governance: {
          evaluate: async () => ({ kind: 'allow' as const, decisionId: 'd' }),
          claim: async () => ({ ok: false }),
          forceApproval: async () => ({ approvalId: 0 }),
        } as unknown as GovernanceApi,
      },
      // memoryRedoEnabled 默认值取决于装配层；这里显式打开，确保这条测试测的是补写轮本身
      { idlePollMs: 5, log: (m: string) => notes.push(m), memoryRedo: true } as never,
    );

    const out = await (
      runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }
    ).runTask(task);

    assert.equal(out.status, 'done', `应正常收口，实际 ${out.status}`);
    assert.equal(seen.redoPrompt, true, '补写轮应当真的被触发（否则这条测试没测到东西）');

    // 核心断言：模型没发结构化 toolCalls，但正文里的调用必须被捞回并派发
    assert.ok(
      seen.toolNames.includes('fs.write'),
      `补写轮的 DSML 调用应被派发给 fs.write，实际派发：${seen.toolNames.join(',') || '(无)'}。` +
        `日志：${notes.slice(-4).join(' | ')}`,
    );
    assert.ok(
      notes.some((n) => n.includes('补写轮从正文里捞回')),
      `应留下"捞回"的可排查日志，实际：${notes.slice(-4).join(' | ')}`,
    );
  } finally {
    tmp.cleanup();
  }
});
test('补写轮：提示词说「用 fs.write 写」，请求体就必须真的给 fs.write', async () => {
  // 2026-10-22 真机缺陷：MEMORY_REDO_PROMPT 明说「如果有：用 fs.write 把它写进 notes/」，
  // 请求体却刻意**不带 tools**（old :2767 注释写着「不给它别的动作面」）。
  // 结果是自相矛盾：
  //   提示词：「用 fs.write 写进去」
  //   请求体：没有 tools
  //   模型回：「我这边没有可用的 fs.write 工具，所以这条经验没法落盘」
  // 意图是「只允许写」，实现成了「一律不许」。
  //
  // 这个测试盯的是「请求里有 tools 且含 fs.write」——前者是协议层的事实，
  // 后者是白名单的事实。两者缺一，补写轮就又是一句空话。
  const tmp = makeTempDataDir();
  try {
    let stepCount = 0;
    const notes: string[] = [];
    let redoToolNames: string[] = [];
    let redoToolChoice = '';
    const task = { id: 'tk_redo_tools', dotId: 'dot1', runEpoch: 1, threadId: 'thr_t', title: 't', goal: 'g', budgetTokens: 100000, resumeFromSeq: null };

    const routerStub = {
      async complete(req: RouteRequest): Promise<RouteResult> {
        const sys = (req.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
        const isRedo = /最后一件收尾动作|值得长期保留的经验|只回复 SKIP/.test(sys);
        if (isRedo) {
          redoToolNames = (req.tools ?? []).map((x) => x.name);
          redoToolChoice = String(req.tool_choice ?? '');
          return {
            response: { content: 'SKIP', toolCalls: [] },
            meta: { endpointId: 'stub', model: 'stub', tier: 1, degraded: false, tried: [] },
            usage: { promptTokens: 1, completionTokens: 1 },
          } as unknown as RouteResult;
        }
        return {
          response: { content: '完成。', toolCalls: [] },
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
        router: routerStub as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
        exec: {
          runTool: async (c: { call_id: string }) => ({ call_id: c.call_id, status: 'ok', result: {} }),
          getCapabilities: async () => [
            { name: 'fs.write', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'unknown' },
            { name: 'fs.read', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
            { name: 'shell.run', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'unknown' },
            { name: 'net.get', mode: 'sync', max_deadline_ms: 60000, args_schema: {}, sideEffect: 'safe' },
          ],
          reconcileCall: async () => 'unknown',
          getCallResult: async () => null,
          cancelTool: async () => {},
        } as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
        memory: {
          openThread: async () => 'thr_t',
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
      { idlePollMs: 5, log: (m: string) => notes.push(m), memoryRedo: true } as never,
    );

    await (runner as unknown as { runTask: (t: unknown) => Promise<{ status: string }> }).runTask(task);

    assert.ok(redoToolNames.length > 0, '补写轮的请求体必须带 tools，否则提示词里的「用 fs.write 写」是空话');
    assert.ok(redoToolNames.includes('fs.write'), `补写轮必须给 fs.write，实际给了：${redoToolNames.join(',')}`);
    assert.equal(redoToolChoice, 'auto', '给了工具就必须允许调用（tool_choice:auto），不能又设成 none');

    // 反向：白名单之外的一个都不能给。补写轮跑在任务收口后，不该再有任何副作用机会。
    // **读类工具也不该给**（2026-10-22 真机第三修）。
  //
  // 原来给的是四个文件工具，想着「写之前先看看目录结构是合理的」。
  // 真机抓到的补写轮是：`fs.read MEMORY.md` + `fs.list .` —— 一个 fs.write 都没有。
  // 工具清单的形状本身就在暗示任务是什么，摆四个调查类工具它就去做调查了。
  // 这一轮的任务是唯一的：把已经想清楚的经验写下来。
  for (const forbidden of ['fs.read', 'fs.list', 'fs.stat']) {
    assert.ok(
      !redoToolNames.includes(forbidden),
      `补写轮不该给 ${forbidden} —— 给了它就读文件去了，不会写。实际给了：${redoToolNames.join(',')}`,
    );
  }
  assert.deepEqual(
    redoToolNames.filter((n) => n.startsWith('fs.')),
    ['fs.write'],
    `补写轮的文件类工具应当只有 fs.write，实际：${redoToolNames.join(',')}`,
  );

  for (const forbidden of ['shell.run', 'net.get']) {
      assert.ok(!redoToolNames.includes(forbidden), `补写轮不该给 ${forbidden}，实际给了：${redoToolNames.join(',')}`);
    }
  } finally {
    tmp.cleanup();
  }
});