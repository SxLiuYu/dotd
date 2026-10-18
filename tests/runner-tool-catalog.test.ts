/**
 * tests/runner-tool-catalog.test.ts —— Runner 提示词层（工具词表 + system prompt + 接线）。
 *
 * 守的是什么（这几个断言一旦红掉，模型的"智商"会静默退化）：
 *  1. 11 个工具每个都有**非模板化**的说明书：不是 `工具 fs.read（mode=…）` 那种
 *     同构串，长度 > 80，且讲到了"返回什么"和"失败了怎么办"。
 *  2. 说明书里点名的每个参数都**真实存在于**当前 schema（防编造）：宿主目录
 *     （src/exec/protocol.ts）与容器目录（agent-runtime/protocol.ts）字段不一致，
 *     渲染必须按当前 schema 求交，不能教模型填一个会被 additionalProperties 拒掉的键。
 *  3. system prompt 是**导出常量**、有长度上限，且真的出现在发往模型的 messages[0]
 *     （role=system），而任务目标仍在最后一条 user。
 *  4. 接线不退步：ToolSpec.parameters 与能力目录逐字相同（schema 不归 Runner 改）；
 *     tool_result 投影成 role='tool' 且带 tool_call_id，前面有 assistant.tool_calls 配对；
 *     工具结果**全文**回喂（不是 200 字 digest）；tool_result 消息的 role 合法。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeStubTransport } from './helpers.ts';
import { DotRunner } from '../src/runner/dot.ts';
import { CAPABILITY_CATALOG, TOOL_NAMES } from '../src/exec/protocol.ts';
import {
  TOOL_DOCS,
  TOOLS_GUIDE,
  HOME_ROOT,
  buildToolSpecs,
  documentedToolNames,
  renderParamLines,
  schemaParamNames,
  toolDescriptionFor,
  toolDocOf,
} from '../src/runner/tool-catalog.ts';
import {
  DOT_SYSTEM_PROMPT,
  SYSTEM_PROMPT_BUDGET,
  checkSystemPromptBudget,
  composeSystemPrompt,
} from '../src/runner/system-prompt.ts';
import type { Capability, ChatMessage, RouteRequest, RouteResult } from '../src/shared/contracts.ts';

const CAPS: Capability[] = [...CAPABILITY_CATALOG] as Capability[];
const capOf = (name: string): Capability => {
  const c = CAPS.find((x) => x.name === name);
  assert.ok(c !== undefined, `能力目录缺 ${name}`);
  return c;
};

/** 旧模板串：说明书的反面教材，任何一条 description 都不许等形。 */
const TEMPLATE_RE = /^工具\s+\S+（mode=/;

/** 纯 schema 派生的通用参数名（schema 里有、说明书没逐条写时必须兜底生成说明）。 */
const MAX_DESCRIPTION_CHARS = 2400;

// ── 1. 词表覆盖 ─────────────────────────────────────────────────────────

test('词表：11 个工具全部有说明书，且与契约词表逐名对齐（不多不少）', () => {
  const documented = documentedToolNames();
  const contract = [...TOOL_NAMES].sort();
  assert.equal(documented.length, contract.length, '说明书条数 = 契约词表条数（11）');
  assert.deepEqual([...documented].sort(), contract, '说明书覆盖的工具名与契约词表一致');
  // 顺序也钉住：将来加工具时逼人先想清楚放哪一段。
  assert.deepEqual(
    TOOL_DOCS.map((d) => d.name),
    [
      'fs.read',
      'fs.write',
      'fs.list',
      'fs.stat',
      'shell.run',
      'browser.open',
      'browser.act',
      'browser.snapshot',
      'browser.close',
      'net.get',
      'net.post',
    ],
  );
});

// ── 2. description 质量 ─────────────────────────────────────────────────

test('description：每个工具都非模板化、> 80 字符、讲了返回与失败、长度可控', () => {
  for (const cap of CAPS) {
    const desc = toolDescriptionFor(cap);
    assert.ok(!TEMPLATE_RE.test(desc), `${cap.name} 不许退回模板串：${desc.slice(0, 40)}`);
    assert.ok(desc.length > 80, `${cap.name} description 太短（${desc.length}）`);
    assert.ok(
      desc.length < MAX_DESCRIPTION_CHARS,
      `${cap.name} description 过长（${desc.length} > ${MAX_DESCRIPTION_CHARS}），每步都要付 token`,
    );
    assert.ok(desc.includes('成功返回'), `${cap.name} 没讲成功返回什么`);
    assert.ok(desc.includes('失败'), `${cap.name} 没讲失败怎么读`);
    // 说明书必须有"何时用"的语义，而不是只罗列字段。
    assert.match(desc, /用|读|执行|发|查|列|写|取|操作|关闭/, `${cap.name} 没讲怎么用`);
  }
});

test('description：互不相同（防复制粘贴），且不含内部实现术语泄漏', () => {
  const descs = CAPS.map((c) => toolDescriptionFor(c));
  assert.equal(new Set(descs).size, descs.length, '11 条 description 必须两两不同');
  for (const d of descs) {
    for (const leak of ['journal', 'sideEffect=unknown（', 'SQLite', 'daemon']) {
      assert.ok(!d.includes(` ${leak} `), `description 泄漏内部术语：${leak}`);
    }
  }
});

test('description：执行形态行反映真实 mode / sideEffect / 截止时间', () => {
  for (const cap of CAPS) {
    const desc = toolDescriptionFor(cap);
    assert.ok(desc.includes(`mode=${cap.mode}`), `${cap.name} 应标注 mode`);
    assert.ok(desc.includes(`sideEffect=${cap.sideEffect}`), `${cap.name} 应标注 sideEffect`);
    assert.ok(desc.includes(`${Math.round(cap.max_deadline_ms / 1000)} 秒`), `${cap.name} 应标注截止时间`);
  }
});

// ── 3. 参数说明防编造 ───────────────────────────────────────────────────

test('参数说明：点名的每个参数都真实存在于对应 schema（双向覆盖）', () => {
  for (const cap of CAPS) {
    const schemaNames = schemaParamNames(cap.args_schema);
    const doc = toolDocOf(cap.name);
    assert.ok(doc !== null, `缺 ${cap.name} 说明书`);
    const described = Object.keys(doc.params);
    for (const p of described) {
      // 说明书可以为"某些环境下才存在"的字段预先写好说明（如 shell.run.cwd 只在容器侧
      // 目录里出现）。真正会伤模型的是**渲染**出 schema 里没有的字段——见下面的渲染断言。
      const rendered = renderParamLines(doc, cap.args_schema);
      assert.ok(
        !rendered.some((l) => l.startsWith(`- ${p}：`)) || schemaNames.includes(p),
        `${cap.name} 渲染出了 schema 里不存在的参数：${p}（真实：${schemaNames.join(',') || '无'}）`,
      );
    }
    for (const p of schemaNames) {
      assert.ok(described.includes(p), `${cap.name} 的 schema 参数 ${p} 没有一句说明（模型只会盲填）`);
    }
    // 渲染出来的参数行与 schema 一一对应，顺序一致。
    const lines = renderParamLines(doc, cap.args_schema);
    assert.equal(lines.length, schemaNames.length);
    lines.forEach((line, i) => {
      assert.ok(line.includes(`${schemaNames[i]}：`), `参数行顺序应与 schema 一致：${line}`);
      assert.ok(line.length > 20, `参数说明太短，等于没写：${line}`);
    });
  }
});

test('参数说明：容器侧目录（agent-runtime）字段差异下不得渲染出冻结字段', () => {
  // 宿主目录与容器目录是两份手写 schema，历史上有过差异（如 fs.write.content_base64、
  // net.get.headers）。说明书必须按**传入的** schema 求交，而不是按宿主那份写死。
  const containerLike: Capability = {
    name: 'fs.read',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  };
  const desc = toolDescriptionFor(containerLike);
  assert.ok(desc.includes('path：'), '真实存在的参数要有说明');
  assert.ok(!desc.includes('offset'), '不得引入 schema 里没有的 offset');
  assert.ok(!desc.includes('limit：'), '不得引入 schema 里没有的 limit');

  // 反向：schema 里出现说明书没写过的字段时，渲染器要兜底，而不是留一个裸参数名。
  const withExtra: Capability = {
    name: 'fs.read',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, encoding: { type: 'string' } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  };
  const doc = toolDocOf('fs.read')!;
  const lines = renderParamLines(doc, withExtra.args_schema);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes('encoding'));
  assert.ok(lines[1]!.length > 8, '兜底行也要有说明文字');
});

test('参数说明：无参工具不渲染空参数段；schema 里的可选参数必须有说明', () => {
  // 真正无参的是 browser.close（宿主与容器两份目录一致）。
  // browser.snapshot 在宿主目录里多一个可选 selector、容器侧没有——两种都得渲染正确。
  const closeCap = capOf('browser.close');
  assert.deepEqual(schemaParamNames(closeCap.args_schema), [], 'browser.close 应无参数');
  const closeDesc = toolDescriptionFor(closeCap);
  assert.ok(!closeDesc.includes('参数：'), 'browser.close 不该出现"参数："段');

  for (const name of ['browser.snapshot', 'browser.act', 'fs.list', 'net.get', 'net.post']) {
    const cap = capOf(name);
    const names = schemaParamNames(cap.args_schema);
    const lines = renderParamLines(toolDocOf(name)!, cap.args_schema);
    assert.equal(lines.length, names.length, `${name} 参数行数应等于 schema 参数数`);
    for (const line of lines) {
      assert.ok(!line.includes('按下方调用形态里的取值约定填写'), `说明书写漏了可选参数（走到兜底文案）：${line}`);
      assert.ok(line.length > 12, `参数说明太短：${line}`);
    }
  }
  // browser.snapshot 的 selector 确实有说明（宿主目录特有字段也要讲）。
  const snapLines = renderParamLines(toolDocOf('browser.snapshot')!, capOf('browser.snapshot').args_schema);
  assert.ok(snapLines.some((l) => l.includes('selector：')), 'browser.snapshot.selector 要有说明');
});

// ── 4. ToolSpec 接线 ────────────────────────────────────────────────────

test('buildToolSpecs：schema 逐字透传能力目录，description 全部来自说明书', () => {
  const specs = buildToolSpecs(CAPS);
  assert.equal(specs.length, CAPS.length);
  specs.forEach((s, i) => {
    const cap = CAPS[i]!;
    assert.equal(s.name, cap.name);
    assert.deepEqual(s.parameters, cap.args_schema, `${s.name} 的 parameters 必须与能力目录逐字相同`);
    assert.equal(s.description, toolDescriptionFor(cap));
    assert.ok(!TEMPLATE_RE.test(s.description), `${s.name} 仍是模板描述`);
  });
  // 相同的 schema 对象引用（不是拷贝变形）——透传语义。
  assert.equal(specs[0]!.parameters, CAPS[0]!.args_schema);
});

test('工具引导段：讲清"先便宜后昂贵"的优先级，并覆盖 11 个工具名', () => {
  assert.ok(TOOLS_GUIDE.length > 200);
  for (const name of TOOL_NAMES) {
    assert.ok(TOOLS_GUIDE.includes(name), `引导段没提到 ${name}，模型不知道它归哪一类`);
  }
  assert.ok(TOOLS_GUIDE.includes(HOME_ROOT), '引导段必须讲路径口径（/dot/home）');
  assert.ok(TOOLS_GUIDE.includes('retryable'), '引导段必须教模型读 retryable');
});

// ── 5. system prompt ────────────────────────────────────────────────────

test('system prompt：是导出常量、有长度预算、内容不是空话', () => {
  assert.ok(DOT_SYSTEM_PROMPT.length > 600, '运行手册太短，撑不起行为约束');
  const prompt = composeSystemPrompt();
  assert.ok(prompt.startsWith(DOT_SYSTEM_PROMPT), '运行手册在最前（模型对开头最敏感）');
  const budget = checkSystemPromptBudget(prompt);
  assert.equal(budget.budget, SYSTEM_PROMPT_BUDGET);
  assert.equal(budget.chars, prompt.length);
  assert.ok(budget.ok, `system prompt ${prompt.length} 字符超预算 ${SYSTEM_PROMPT_BUDGET}`);
  assert.ok(SYSTEM_PROMPT_BUDGET <= 4000, '任务要求总长 < 4000 字符');

  // 必备的四块：身份/环境、工作纪律、记忆、对主人表达。
  for (const must of ['Dot', '/dot/home', 'MEMORY.md', 'notes/', 'manuals/', '结论先行', '中文']) {
    assert.ok(prompt.includes(must), `system prompt 缺关键要素：${must}`);
  }
  // 纪律必须可执行：明确禁止"一次发一堆无关调用"、要求失败先读错误。
  assert.match(prompt, /一轮只发一类动作/);
  assert.match(prompt, /失败/);
  assert.match(prompt, /同样的失败连续两次/);
  // 不许出现门槛不明的空话。
  for (const hollow of ['努力', '尽量发挥', '作为一个AI', '作为一个 AI', '请注意安全']) {
    assert.ok(!prompt.includes(hollow), `system prompt 出现空话：${hollow}`);
  }
  // 不把工具说明书抄进来（会重复计费且在改说明书时两处漂移）。
  for (const cap of CAPS) {
    assert.ok(!prompt.includes(toolDescriptionFor(cap)), `system prompt 抄了 ${cap.name} 的说明书`);
  }
});

test('system prompt：composeSystemPrompt 可裁剪（空引导段只留手册）', () => {
  const bare = composeSystemPrompt('');
  assert.equal(bare, DOT_SYSTEM_PROMPT);
  assert.ok(composeSystemPrompt().length > bare.length);
});

// ── 6. 接线：messages[0] / tool 消息 role / 全文回喂 ────────────────────

/** 直接读 dot.ts 源码做静态守卫（这两个方法都是 private，且不该为了测试改可见性）。 */
const dotSrc = readFileSync(new URL('../src/runner/dot.ts', import.meta.url), 'utf8');

test('接线（源码守卫）：buildMessages 首条即 composeSystemPrompt()，模板串已删除', () => {
  assert.ok(dotSrc.includes('composeSystemPrompt()'), 'dot.ts 必须调用 composeSystemPrompt');
  assert.ok(dotSrc.includes('buildToolSpecs('), 'dot.ts 的 toolSpecs 必须走 tool-catalog');
  assert.ok(dotSrc.includes('id: \'sys:prompt\''), 'system prompt 消息要有稳定 id（便于重建时去重）');
  assert.ok(!dotSrc.includes('工具 ${c.name}（mode='), '旧的模板描述必须删掉，不许留死码');
  // system prompt 必须排在文件记忆之前：文件记忆是"数据"，不该占据 messages[0]。
  const promptAt = dotSrc.indexOf("id: 'sys:prompt'");
  const memoryAt = dotSrc.indexOf("id: 'sys:file-memory'");
  assert.ok(promptAt > 0 && memoryAt > promptAt, 'sys:prompt 必须排在 sys:file-memory 之前');
});

test('接线（源码守卫）：tool 消息投影为 role=tool + tool_call_id，并前置 assistant.tool_calls', () => {
  assert.ok(dotSrc.includes("case 'tool_result'") || dotSrc.includes("m.kind === 'tool_result'"));
  assert.ok(dotSrc.includes("role: 'tool'"), 'tool_result 必须投影成 role=tool');
  assert.ok(dotSrc.includes('tool_call_id'), 'tool 消息必须带 tool_call_id 才能与调用配对');
  assert.ok(dotSrc.includes("tool_calls"), 'assistant 消息要复原 tool_calls 声明');
  assert.ok(dotSrc.includes('dispatched'), '恢复期补喂的结果与真实派发结果必须分流');
});

test('运行时：查 model 请求 messages —— [0] 是 system prompt，末尾是 user 目标', async () => {
  const transport = makeStubTransport([
    // 第一轮：调用两个互不依赖的读工具（同一轮并发）
    {
      content: '',
      toolCalls: [
        { id: 'call_r1', name: 'fs.read', arguments: '{"path":"/dot/home/notes/a.md"}' },
        { id: 'call_l1', name: 'fs.list', arguments: '{"path":"/dot/home/notes"}' },
      ],
      usage: { promptTokens: 10, completionTokens: 5 },
    },
    // 第二轮：收尾
    { content: '读完了。', usage: { promptTokens: 10, completionTokens: 5 } },
  ]);

  // 能力目录换成宿主真目录（Runner 的 toolSpecs 从这里取）。
  const capsCalls: string[] = [];
  const execApi = {
    runTool: async (call: { call_id: string; tool: string; args: Record<string, unknown> }) => {
      capsCalls.push(call.tool);
      if (call.tool === 'fs.read') {
        return {
          call_id: call.call_id,
          status: 'ok' as const,
          result: { path: 'notes/a.md', content: 'X'.repeat(1200), size_bytes: 1200, truncated: false },
        };
      }
      return {
        call_id: call.call_id,
        status: 'ok' as const,
        result: { path: 'notes', entries: [{ name: 'a.md', type: 'file', size_bytes: 1200 }] },
      };
    },
    getCapabilities: async () => CAPS,
    reconcileCall: async () => 'unknown' as const,
    getCallResult: async () => null,
    cancelTool: async () => {},
  };

  // 最小控制面假件：主循环只需要这几个方法。
  let seq = 0;
  const thread: unknown[] = [];
  const task = {
    id: 'tk_prompt_1',
    dotId: 'dot1',
    title: '读笔记',
    goal: '把 notes/a.md 读出来并汇报',
    status: 'running' as const,
    runEpoch: 1,
    threadId: 'thr_prompt_1',
    sessionId: 'thr_prompt_1',
    resumeFromSeq: null,
    budgetTokens: undefined,
  };
  const madeSteps: Array<Record<string, unknown>> = [];
  const cp = {
    pop: () => (seq === 0 ? (seq += 1, task) : null),
    bindSession: () => {},
    getTask: () => task,
    journal: {
      beginLlm: (_t: string, _e: number, _d: string) => ({ seq: (seq += 1), callId: `c_llm_${seq}` }),
      endLlm: () => {},
      beginTool: (t: string, e: number, name: string, args: Record<string, unknown>) => ({
        seq: (seq += 1),
        callId: `c_tool_${seq}`,
      }),
      endTool: (_t: string, _e: number, s: number, status: string, result: unknown) => {
        madeSteps.push({ status, result });
      },
      skipStep: () => {},
      markPending: () => {},
      resumeStep: () => ({ callId: '' }),
      tail: () => [],
      getStepByCallId: () => null,
    },
    setAwaitingApproval: () => {},
    heartbeat: () => ({ aborted: false, overBudget: false }),
    finish: () => {},
    failTask: () => {},
    pauseByReason: () => {},
  };
  const memoryApi = {
    openThread: async () => 'thr_prompt_1',
    appendMessage: async (_t: string, m: unknown) => {
      thread.push(m);
      return { id: 'm', seq: thread.length };
    },
    appendSystemMessage: async () => ({ id: 'm', seq: 0 }),
    buildContextBundle: async () => ({
      memoryMd: '# MEMORY (index)\nupdated: 2026-10-17T00:00:00Z\n## Interests\n## Current concerns\n## Pointers\n',
      manualExcerpts: [],
      summary: null,
      // 其余字段 MemoryService 会带，Runner 不读
    }),
    buildSessionReplay: async () => [],
    beforeWrite: async () => ({ ok: true }),
    sealTask: async () => {},
  };

  const runner = new DotRunner(
    {
      cp: cp as unknown as ConstructorParameters<typeof DotRunner>[0]['cp'],
      router: {
        complete: (req: RouteRequest): Promise<RouteResult> => transport.complete(req),
        emergencyActive: false,
      } as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: execApi as unknown as ConstructorParameters<typeof DotRunner>[0]['exec'],
      memory: memoryApi as unknown as ConstructorParameters<typeof DotRunner>[0]['memory'],
      governance: {
        evaluate: async () => ({ kind: 'allow', decisionId: 'd1', brief: null }),
        claim: async () => ({ ok: true }),
        forceApproval: async () => ({ approvalId: 0 }),
      } as unknown as ConstructorParameters<typeof DotRunner>[0]['governance'],
    },
    { dotId: 'dot1' },
  );

  const out = await runner.runNext();
  assert.equal(out.status, 'done', `主循环应跑完：${JSON.stringify(out)}`);
  assert.equal(transport.requests.length, 2, '两轮模型请求');
  assert.equal(capsCalls.length, 2, '两个工具都真的执行了');

  const req0 = transport.requests[0]!;
  // ① messages[0] = system prompt（每一轮都在）
  const head = req0.messages[0] as ChatMessage;
  assert.equal(head.role, 'system');
  assert.equal(head.content, composeSystemPrompt(), 'messages[0] 必须是运行手册全文');
  // ② 文件记忆排在它后面，且不覆盖 prompt
  const memoryMsg = req0.messages[1] as ChatMessage;
  assert.equal(memoryMsg.role, 'system');
  assert.ok(memoryMsg.content.includes('# MEMORY.md'));
  assert.notEqual(memoryMsg.content, composeSystemPrompt());
  // ③ 目标在最后一条 user
  const last = req0.messages[req0.messages.length - 1]!;
  assert.equal(last.role, 'user');
  assert.equal(last.content, '把 notes/a.md 读出来并汇报');
  // ④ 工具清单：11 个，description 全是说明书
  assert.equal(req0.tools?.length, TOOL_NAMES.length);
  for (const t of req0.tools!) {
    assert.ok((t.description ?? '').length > 80, `${t.name} description 太短`);
    assert.ok(!TEMPLATE_RE.test(t.description ?? ''), `${t.name} 还是模板描述`);
  }
  const readSpec = req0.tools!.find((t) => t.name === 'fs.read')!;
  assert.deepEqual(readSpec.parameters, capOf('fs.read').args_schema, 'parameters 透传 schema');

  // ⑤ 第二轮：system prompt 仍在最前；工具结果以 role=tool + tool_call_id 回喂，
  //    半截截断会让模型看不到正文（本用例正文 1200 字，远大于旧的 200 字预览）。
  const req1 = transport.requests[1]!;
  assert.equal((req1.messages[0] as ChatMessage).role, 'system');
  const toolMsgs = req1.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2, '两个工具调用 → 两条 tool 消息');
  for (const m of toolMsgs) {
    assert.ok(typeof m.tool_call_id === 'string' && m.tool_call_id.length >= 8, 'tool 消息必须带 tool_call_id');
  }
  const readMsg = toolMsgs.find((m) => m.content.includes('X'.repeat(1200)));
  assert.ok(readMsg !== undefined, 'fs.read 的 1200 字正文必须全文回喂（不得被 digest 成 200 字）');
  //    并且前面有一条 assistant.tool_calls 把它们接住（OpenAI 兼容协议的硬要求）。
  const toolIdx = req1.messages.findIndex((m) => m.role === 'tool');
  let anchorIdx = -1;
  for (let i = toolIdx - 1; i >= 0; i -= 1) {
    const m = req1.messages[i] as ChatMessage & { tool_calls?: unknown };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      anchorIdx = i;
      break;
    }
  }
  assert.ok(anchorIdx >= 0, 'tool 消息前必须有 assistant.tool_calls（否则网关 400）');
  const anchor = req1.messages[anchorIdx] as ChatMessage & {
    tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  };
  assert.equal(anchor.role, 'assistant');
  const ids = anchor.tool_calls.map((c) => c.id).sort();
  assert.deepEqual(ids, toolMsgs.map((m) => m.tool_call_id).sort(), 'tool_call_id 与声明 id 逐一配对');
  assert.ok(anchor.tool_calls.every((c) => c.type === 'function'), '线格式 type 必须是 function');
  assert.deepEqual(
    anchor.tool_calls.map((c) => c.function.name).sort(),
    ['fs.list', 'fs.read'],
    '声明里要带工具名',
  );

  // ⑥ thread 里的 tool_result 仍是 digest+预览（双写禁令 S6 只约束入 thread 那份）
  const threadTool = (thread as Array<{ kind: string; content: string }>).filter((m) => m.kind === 'tool_result');
  assert.equal(threadTool.length, 2);
  for (const m of threadTool) {
    assert.ok(m.content.length <= 260, '入 thread 的 tool 消息仍只存 digest+200 预览');
  }
});

test('system prompt：有「别把过去的话当现在的状态」这条纪律（防复述过时结论）', () => {
  // 现场（2026-10-18）：出网早已开通并验证过，模型却按会话历史里几小时前的旧回复
  // 对新问题答"出网通道现在还没接通"，误导了主人。
  assert.ok(
    DOT_SYSTEM_PROMPT.includes('别把过去的话当现在的状态'),
    '必须有"先试一次再回答"的纪律',
  );
  assert.ok(
    DOT_SYSTEM_PROMPT.includes('先实际试一次'),
    '要明确要求先验证再回答',
  );
});
