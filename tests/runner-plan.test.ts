/**
 * tests/runner-plan.test.ts —— P2-2 显式计划与目标锚定。
 *
 * 三件事（任务书的"必须证明"）：
 * ① **抗跑偏**：≥8 步的任务，第二轮之后**每一次** LLM 请求都带着当前计划；
 * ② **可观测**：`buildTaskView` 里能看到计划与"已完成/进行中/未开始"对照；
 * ③ **零行为回退**：计划关闭时，主循环的 LLM 请求与改动前**逐字一致**（请求快照）。
 *
 * 另加两条纪律守卫：
 * - **默认关闭**：RunnerOptions.plan 缺省 false，且 daemon 只按 `DOTD_PLAN=on` 打开
 *   （读源码文本的静态守卫，防"悄悄改成默认开"——本轮已有三次同类教训）；
 * - **不是控制流**：计划不驱动执行——模型不照计划走也能正常收尾（计划只进上下文）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLAN_MARKER,
  PLAN_MAX_ITEMS,
  PLAN_MIN_ITEMS,
  PLAN_REQUEST_TEXT,
  formatPlanForPrompt,
  parsePlan,
  planFromMessage,
  plansFromMessages,
  samePlan,
  serializePlan,
  type Plan,
} from '../src/runner/plan.ts';
import { buildPlanView, buildTaskView, renderTaskView } from '../src/surfaces/task-view.ts';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { EventRule } from '../src/control-plane/match.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { RunnerOptions } from '../src/runner/dot.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { createGovernance, initGovernance, decide, evaluate, claim, forceApproval } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import type { GovDefaults } from '../src/governance/config.ts';
import type {
  ChatMessage,
  ControlPlane,
  ExecToolCall,
  ExecToolResult,
  GovernanceApi,
  MemoryServiceApi,
  RouteRequest,
  RouteResult,
  Step,
  Task,
} from '../src/shared/contracts.ts';

// ── 1. 纯函数：解析 / 序列化 / 渲染 ─────────────────────────────────────────

/** 一份合法计划 JSON（模型最可能给出的形态）。 */
const PLAN_JSON = JSON.stringify({
  items: [
    { text: '先看目录里有什么', status: 'done' },
    { text: '读关键文件', status: 'doing' },
    { text: '汇总成结论', status: 'todo' },
  ],
  revisionReason: '',
});

test('解析：标准 JSON → 3 条计划，index 从 1 起、状态缺省为 todo', () => {
  const p = parsePlan(PLAN_JSON);
  assert.ok(p !== null);
  assert.equal(p.items.length, 3);
  assert.deepEqual(p.items.map((i) => i.index), [1, 2, 3]);
  assert.equal(p.items[0]!.status, 'done');
  assert.equal(p.items[2]!.status, 'todo');
});

test('解析：容忍 ```json 围栏与前后说明文字（模型常带客套话）', () => {
  const raw = `好的，计划如下：\n\`\`\`json\n${PLAN_JSON}\n\`\`\`\n请确认。`;
  const p = parsePlan(raw);
  assert.ok(p !== null, '围栏 + 前后缀仍应解析成功');
  assert.equal(p.items.length, 3);
});

test('解析：容忍字符串里的花括号（用平衡扫描，不按第一个 } 截断）', () => {
  const raw = '{"items":[{"text":"把 {{占位符}} 换成真值","status":"todo"}],"revisionReason":""}';
  const p = parsePlan(raw);
  assert.ok(p !== null);
  assert.equal(p.items[0]!.text, '把 {{占位符}} 换成真值');
});

test('解析：坏输入一律返回 null（绝不抛错炸主循环）', () => {
  for (const bad of ['', '不是 JSON', '{"items":[]}', '{"items":"x"}', '{}{}', '[1,2,3]']) {
    assert.equal(parsePlan(bad), null, `应当拒绝：「${bad}」`);
  }
});

test('解析：条目上限 7、非法状态回落 todo、空文本条目被丢弃', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ text: `第${i}步`, status: i === 0 ? '怪状态' : 'todo' }));
  const p = parsePlan(JSON.stringify({ items }));
  assert.ok(p !== null);
  assert.equal(p.items.length, PLAN_MAX_ITEMS, '超过 7 条按 7 截断');
  assert.equal(p.items[0]!.status, 'todo', '未知状态回落 todo');
  const withEmpty = parsePlan(JSON.stringify({ items: [{ text: '  ', status: 'todo' }, { text: '有效' }] }));
  assert.ok(withEmpty !== null);
  assert.equal(withEmpty.items.length, 1);
  assert.equal(withEmpty.items[0]!.text, '有效');
});

test('序列化 ↔ 反序列化往返：内容逐字保持', () => {
  const plan: Plan = {
    version: 3,
    items: [
      { index: 1, text: '甲', status: 'done' },
      { index: 2, text: '乙', status: 'doing' },
      { index: 3, text: '丙', status: 'todo' },
    ],
    revisionReason: '原路不通，改走备份方案',
  };
  const text = serializePlan(plan);
  assert.ok(text.startsWith(PLAN_MARKER), '带稳定标记');
  const back = planFromMessage({
    id: 'm1',
    threadId: 't',
    seq: 1,
    role: 'system',
    kind: 'text',
    content: text,
    tokenEst: 0,
    createdAt: 0,
  });
  assert.ok(back !== null);
  assert.equal(back.version, 3);
  assert.equal(back.revisionReason, '原路不通，改走备份方案');
  assert.ok(samePlan(plan, back), '往返后内容一致');
});

test('planFromMessage：普通助手正文 / 非 system 消息都不被误认成计划', () => {
  const normal = {
    id: 'm',
    threadId: 't',
    seq: 1,
    role: 'assistant' as const,
    kind: 'text' as const,
    content: '这就是计划：{"items":[...]}',
    tokenEst: 0,
    createdAt: 0,
  };
  assert.equal(planFromMessage(normal), null, '没有稳定标记 → 不是计划');
  const sysButPlain = { ...normal, role: 'system' as const };
  assert.equal(planFromMessage(sysButPlain), null);
});

test('plansFromMessages：取最后一条为当前计划，全部构成修订历史', () => {
  const mk = (v: number): ChatMessage extends never ? never : ReturnType<typeof serializePlan> =>
    serializePlan({ version: v, items: [{ index: 1, text: `第${v}版`, status: 'todo' }], revisionReason: '' });
  const msgs = [1, 2, 3].map((v) => ({
    id: `m${v}`,
    threadId: 't',
    seq: v,
    role: 'system' as const,
    kind: 'text' as const,
    content: mk(v),
    tokenEst: 0,
    createdAt: 0,
  }));
  const { current, history } = plansFromMessages(msgs);
  assert.equal(history.length, 3);
  assert.equal(current?.version, 3, '当前 = 最后一条');
  assert.deepEqual(plansFromMessages([]), { current: null, history: [] });
});

test('formatPlanForPrompt：带版本号、逐条状态与"不约束你的选择"这句', () => {
  const text = formatPlanForPrompt({
    version: 2,
    items: [
      { index: 1, text: '读目录', status: 'done' },
      { index: 2, text: '写结论', status: 'doing' },
    ],
    revisionReason: '发现路径变了',
  });
  assert.match(text, /第 2 版/);
  assert.match(text, /读目录/);
  assert.match(text, /已完成/);
  assert.match(text, /进行中/);
  assert.match(text, /不约束你的选择/, '必须写明计划不是强制流程');
  assert.match(text, /发现路径变了/);
});

// ── 2. 可观测（证明②）：buildTaskView 里能看到计划对照 ─────────────────────

const TS = 1_700_000_000_000;

function fakeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'tk_plan',
    dotId: 'dot1',
    title: '整理笔记',
    goal: '把 notes 里的东西整理成一份清单',
    status: 'running',
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    budgetTokens: 100_000,
    runEpoch: 1,
    threadId: 'thr_x',
    sessionId: 'thr_x',
    resumeFromSeq: null,
    createdAt: TS,
    updatedAt: TS,
    runAt: null,
    lastHeartbeatAt: null,
    stopReason: null,
    ...over,
  } as unknown as Task;
}

function fakeStep(over: Partial<Step>): Step {
  return {
    taskId: 'tk_plan',
    seq: 1,
    kind: 'llm',
    status: 'succeeded',
    callId: 'c1',
    toolName: null,
    argsJson: null,
    resultJson: null,
    sideEffect: null,
    runEpoch: 1,
    approvalId: null,
    startedAt: TS,
    finishedAt: TS + 100,
    ...over,
  } as Step;
}

test('可观测②：buildTaskView 带出计划（版本/条目/进度/对照）', () => {
  const plan: Plan = {
    version: 2,
    items: [
      { index: 1, text: '读目录', status: 'done' },
      { index: 2, text: '写清单', status: 'doing' },
      { index: 3, text: '发给主人', status: 'todo' },
    ],
    revisionReason: '多了一步',
  };
  const v = buildTaskView({
    task: fakeTask(),
    steps: [fakeStep({ seq: 1 })],
    callLogs: [],
    now: TS + 500,
    plan,
  });
  assert.ok(v.plan !== null, 'plan 必须出现在 TaskView 里');
  assert.equal(v.plan!.version, 2);
  assert.equal(v.plan!.revisions, 1, '版本 2 = 改过 1 次');
  assert.equal(v.plan!.completed, 1);
  assert.equal(v.plan!.total, 3);
  assert.deepEqual(
    v.plan!.items.map((i) => i.statusLabel),
    ['已完成', '进行中', '未开始'],
    '三条状态的中文对照',
  );
  assert.equal(v.plan!.revisionReason, '多了一步');
});

test('可观测②：renderTaskView 输出"它打算怎么干"一段（含已完成 x/y）', () => {
  const plan: Plan = {
    version: 1,
    items: [
      { index: 1, text: '读目录', status: 'done' },
      { index: 2, text: '写清单', status: 'todo' },
    ],
    revisionReason: '',
  };
  const text = renderTaskView(
    buildTaskView({ task: fakeTask(), steps: [fakeStep({})], callLogs: [], now: TS + 100, plan }),
  );
  assert.match(text, /它打算怎么干/);
  assert.match(text, /已完成 1\/2 条/);
  assert.match(text, /读目录/);
  assert.match(text, /未开始/);
});

test('可观测②：没有计划时 TaskView.plan 为 null，渲染里也不出现计划段（零噪声）', () => {
  const v = buildTaskView({ task: fakeTask(), steps: [fakeStep({})], callLogs: [], now: TS + 100 });
  assert.equal(v.plan, null);
  const text = renderTaskView(v);
  assert.ok(!text.includes('它打算怎么干'), '功能关闭时输出与改动前一致');
});

test('buildPlanView：状态标签与 plan.ts 的渲染口径一致', () => {
  const v = buildPlanView({
    version: 1,
    items: [{ index: 1, text: 'x', status: 'dropped' }],
    revisionReason: '',
  });
  assert.equal(v.items[0]!.statusLabel, '已放弃');
  assert.equal(v.completed, 0);
});

// ── 3. 端到端：抗跑偏（证明①）+ 不是控制流 + 零行为回退（证明③）───────────

const tmps: TempDataDir[] = [];
const cfgRoots: string[] = [];

const TOOLS_YML = `tools:
  - name: fs.list
    tier: read
  - name: fs.read
    tier: read
`;

const RUN_NEW_RULE: EventRule = {
  id: 'r-run',
  match: { source: 'http' },
  action: 'run_new',
  task: { title: '整理笔记', goal: '把 notes 里的东西整理成一份清单' },
  reason: '命中 http 规则',
};

interface Turn {
  /** 这一轮的正文（计划轮的正文就是计划 JSON）。 */
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

interface PlanFixture {
  tmp: TempDataDir;
  cp: ReturnType<typeof createControlPlane>;
  runner: DotRunner;
  /** 所有发往模型的请求（含计划轮），按发生顺序。 */
  requests: RouteRequest[];
  memory: MemoryServiceImpl;
}

/**
 * 装配一个只关心"请求体"的 fixture：模型面是可编程脚本，
 * 每次调用都把完整 `RouteRequest` 记下来（证明①②③ 全靠它）。
 */
async function planFixture(opts: {
  turns: Turn[];
  runnerOpts?: RunnerOptions;
  tools?: Record<string, (call: ExecToolCall) => ExecToolResult>;
}): Promise<PlanFixture> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-plan-cfg-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  const requests: RouteRequest[] = [];
  const queue = [...opts.turns];
  const router = {
    async complete(req: RouteRequest): Promise<RouteResult> {
      requests.push(req);
      const t = queue.shift();
      if (t === undefined) throw new Error('模型脚本耗尽');
      return {
        meta: {
          endpointId: 'stub',
          tier: 1,
          model: 'stub-model',
          degraded: false,
          attemptSeq: 0,
          tried: [],
          streamStarted: false,
        },
        response: { content: t.content, ...(t.toolCalls !== undefined ? { toolCalls: t.toolCalls } : {}) },
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
    emergencyActive: false,
  };

  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean, _m?: { note?: string; revoke?: string }): void => {},
    resumeDotQueue: (_d: string): void => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: (_c: string) => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: { publish: (t, p, o) => tmp.bus.publish(t, p, o), on: (t, h) => tmp.bus.on(t, h) },
  };
  const govOpts = {
    defaults: {
      approvalTtlMs: 24 * 3600_000,
      expireScanMs: 5 * 60_000,
      precheckTimeoutMs: 45_000,
      precheckBudget: { goalBytes: 800, paramsBytes: 1500, maxOutputTokens: 40 },
      reviewFailThreshold: { windowMs: 600_000, fails: 5, openMs: 900_000 },
      auditRetentionDays: 90,
      auditRetentionRows: 20_000,
      auditArchiveCapMb: 200,
      chunkBytes: 10 * 1024 * 1024,
      memoryPerTierCap: 50,
      memoryDefaultExpiryDays: 90,
    } satisfies GovDefaults,
  };
  const rt = createGovernance(tmp.db, catalog, govDeps, govOpts);
  initGovernance(tmp.db, catalog, govDeps, govOpts);

  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root },
    ...(opts.tools !== undefined ? { stubRuntime: { handlers: opts.tools } } : {}),
  });
  await exec.boot(['dot1']);
  const memory = new MemoryServiceImpl({ db: tmp.db, outboxPath: tmp.outboxPath, journalMemoryProbe: () => [] });
  const cp = createControlPlane({
    db: tmp.db,
    bus: tmp.bus,
    rules: [RUN_NEW_RULE],
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
  });
  (cp as unknown as { failTask: (t: string, e: number, r: string) => void }).failTask = (taskId, epoch, reason) => {
    cp.queue.markFailed(taskId, epoch, reason);
  };
  govCp.setAwaitingApproval = (taskId, epoch, approvalId) => cp.setAwaitingApproval(taskId, epoch, approvalId);
  govCp.onApprovalSettled = (taskId, approvalId, ok, meta) => cp.onApprovalSettled(taskId, approvalId, ok, meta);

  const runner = new DotRunner(
    {
      cp,
      router: router as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: {
        runTool: (c) => exec.runTool(c),
        getCapabilities: (d) => exec.getCapabilities(d),
        reconcileCall: async (callId) => ((await exec.reconcileCall(callId)).outcome === 'done' ? 'done' : 'unknown'),
        getCallResult: (callId) => exec.getCallResult(callId),
        cancelTool: (callId, reason) => exec.cancelTool(callId, reason),
      },
      memory: {
        openThread: (d, c, o) => memory.openThread(d, c, o),
        appendMessage: (t, m) => memory.appendMessage(t, m),
        appendSystemMessage: (t, m) => memory.appendSystemMessage(t, m),
        buildContextBundle: (d, text, b, o) => memory.buildContextBundle(d, text, b, o),
        buildSessionReplay: (t, task, b) => memory.buildSessionReplay(t, task, b),
        beforeWrite: (d, path, content) => memory.beforeWrite(d, path, content),
        sealTask: (t, o, r) => memory.sealTask(t, o, r),
      },
      governance: {
        evaluate: (ctx, call, evaluateOpts) => evaluate(ctx, call, evaluateOpts ?? {}, rt),
        claim: (approvalId) => claim(approvalId, rt),
        forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
      },
    },
    { log: () => {}, ...opts.runnerOpts },
  );
  return { tmp, cp, runner, requests, memory };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function ingestAndDecide(cp: ReturnType<typeof createControlPlane>): { eventId: number; taskId: string } {
  const ing = cp.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: { q: '整理' } });
  void cp.matcher.processEvent(ing.eventId);
  return { eventId: ing.eventId, taskId: `tk_ev_${ing.eventId}` };
}

/** 一次工具调用的成功结果。 */
const okList = (call: ExecToolCall): ExecToolResult => ({
  call_id: call.call_id,
  status: 'ok',
  result: { entries: [{ name: 'a.md' }, { name: 'b.md' }] },
  usage: { wall_ms: 1, peak_mem_mb: 1 },
  finished_at: new Date().toISOString(),
});

/** 从请求体里取出"计划注记"（role=system 且内容带计划标题的那条）。 */
function planNoteOf(req: RouteRequest): string | null {
  const m = req.messages.find((x) => x.role === 'system' && x.content.includes('# 当前计划'));
  return m === undefined ? null : m.content;
}

test('抗跑偏①：8 步任务里，计划轮之后的**每一次** LLM 请求都带着当前计划', async () => {
  // 1 轮计划 + 8 轮工具（每轮一个 fs.list）+ 1 轮收尾 = 10 次模型调用
  const turns: Turn[] = [{ content: PLAN_JSON }];
  for (let i = 0; i < 8; i += 1) {
    turns.push({
      content: `第 ${i + 1} 步`,
      toolCalls: [{ id: `call_${i}`, name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
    });
  }
  turns.push({ content: '整理完了。' });

  const f = await planFixture({ turns, runnerOpts: { plan: true }, tools: { 'fs.list': okList } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(out.summary, '整理完了。');

  assert.equal(f.requests.length, 10, '1 计划轮 + 8 工具轮 + 1 收尾轮');
  // 第 0 次是计划轮（prompt 含 PLAN_REQUEST_TEXT，且**还没**挂计划注记）
  assert.ok(f.requests[0]!.messages.some((m) => m.content.includes('先用一份短计划')));
  assert.equal(planNoteOf(f.requests[0]!), null, '计划轮本身还没有计划');

  // 第 1..9 次（工具轮 + 收尾轮）**全部都**带着计划 —— 这是抗跑偏的核心断言
  for (let i = 1; i < f.requests.length; i += 1) {
    const note = planNoteOf(f.requests[i]!);
    assert.ok(note !== null, `第 ${i} 次请求必须带计划注记（共 ${f.requests.length} 次）`);
    assert.match(note!, /读关键文件/, `第 ${i} 次请求里的计划内容正确`);
  }
  // 计划注记位置：在文件记忆之后、会话历史之前（不抢 system prompt 的头位）
  const reqIdx = f.requests[3]!;
  const sysIdx = reqIdx.messages.findIndex((m) => m.role === 'system' && m.content.includes('你是 Dot'));
  const planIdx = reqIdx.messages.findIndex((m) => m.role === 'system' && m.content.includes('# 当前计划'));
  assert.equal(sysIdx, 0, '运行手册仍是 messages[0]');
  assert.ok(planIdx > sysIdx, '计划排在运行手册之后');
  // 目标仍在末尾（不变）
  assert.equal(reqIdx.messages[reqIdx.messages.length - 1]!.role, 'user');

  // 计划落进了 thread（可观测的产物）
  const threadId = String((f.tmp.db.prepare('SELECT thread_id FROM tasks WHERE id=?').get(taskId) as { thread_id: string }).thread_id);
  const rows = f.tmp.db
    .prepare(`SELECT role, kind, content FROM mem_messages WHERE thread_id=? ORDER BY seq ASC`)
    .all(threadId) as Array<{ role: string; kind: string; content: string }>;
  const planRows = rows.filter((r) => r.content.startsWith(PLAN_MARKER));
  assert.equal(planRows.length, 1, '首版计划恰好一条 thread 消息');
  assert.equal(planRows[0]!.role, 'system');
  assert.equal(planRows[0]!.kind, 'text');
});

test('不是控制流：模型完全不照计划走，任务照样正常收尾（计划只进上下文）', async () => {
  // 计划说"先读目录"，但模型第一轮就去读文件、第二轮直接收尾 —— 不允许 Runner 干预
  const turns: Turn[] = [
    { content: PLAN_JSON },
    { content: '我不按计划来，直接收尾。' },
  ];
  const f = await planFixture({ turns, runnerOpts: { plan: true } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(out.summary, '我不按计划来，直接收尾。', '收口用模型自己的结论');
  // 计划里的三条 todo/done 没有被 Runner 用来"催"模型继续
  const steps = f.tmp.db.prepare('SELECT kind FROM steps WHERE task_id=? ORDER BY seq').all(taskId) as Array<{ kind: string }>;
  assert.equal(steps.filter((s) => s.kind === 'llm').length, 1, '只有一轮业务 LLM（计划轮不占 journal 步）');
  assert.equal(steps.filter((s) => s.kind === 'tool').length, 0, '没有任何工具步被计划驱动出来');
});

test('零行为回退③：plan 关闭时，请求体与"没有计划功能"逐字一致（请求快照）', async () => {
  const turns: Turn[] = [
    { content: '直接干。', toolCalls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }] },
    { content: '完了。' },
  ];
  const off = await planFixture({ turns, runnerOpts: { plan: false }, tools: { 'fs.list': okList } });
  const on = await planFixture({ turns, tools: { 'fs.list': okList } }); // 完全不传 plan（缺省）
  const a = ingestAndDecide(off.cp);
  const b = ingestAndDecide(on.cp);
  await flush();
  await off.runner.runNext();
  await on.runner.runNext();

  assert.equal(off.requests.length, 2, '关闭时没有计划轮（不多花模型调用）');
  assert.equal(on.requests.length, 2, '缺省 false 同样没有计划轮');

  // 逐字快照对比：把易变字段（call_id/ULID/时间）归一化后必须完全相同
  const shape = (r: RouteRequest) => ({
    role: r.track,
    maxTokens: r.maxTokens,
    messages: r.messages.map((m) => ({
      role: m.role,
      // call_id 是每次运行的 ULID（天然不同），归一化后才能比"结构是否逐字一致"
      content: m.content.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ULID>'),
      ...(m.tool_call_id !== undefined ? { tool_call_id: '<ULID>' } : {}),
    })),
    tools: (r.tools ?? []).map((t) => t.name),
  });
  assert.deepEqual(off.requests.map(shape), on.requests.map(shape), '关闭 vs 缺省：请求体逐字一致');

  // 且都没有计划注记
  for (const r of [...off.requests, ...on.requests]) {
    assert.equal(planNoteOf(r), null, '关闭时请求里绝不出现计划注记');
    assert.ok(!r.messages.some((m) => m.content.includes('先用一份短计划')), '也没有计划提示轮');
  }
});

test('零行为回退③：关闭时 LLM 步数/工具步数与开启时相同（计划轮不占 journal）', async () => {
  const turns: Turn[] = [{ content: PLAN_JSON }, { content: '好了。' }];
  const f = await planFixture({ turns, runnerOpts: { plan: true } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done', '计划轮之后模型收尾 → done（不是被计划轮吃掉）');
  const task = f.tmp.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
  assert.equal(task.status, 'done');
  const llmSteps = f.tmp.db
    .prepare(`SELECT status, result_json FROM steps WHERE task_id=? AND kind='llm' ORDER BY seq`)
    .all(taskId) as Array<{ status: string; result_json: string }>;
  assert.equal(llmSteps.length, 1, '计划轮**不进** journal（它不是执行步）');
  assert.ok(!String(llmSteps[0]!.result_json).includes('读关键文件'), 'journal 里没有计划内容');
});

test('计划写不出来（模型乱答）→ 静默跳过，主循环照常跑', async () => {
  const turns: Turn[] = [
    { content: '我不知道该怎么计划。' }, // 第一轮 = 计划轮，返回非 JSON
    { content: '但活我干了。' },
  ];
  const f = await planFixture({ turns, runnerOpts: { plan: true } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done', '计划失败不能变成任务失败');
  assert.equal(out.summary, '但活我干了。');
  for (const r of f.requests.slice(1)) assert.equal(planNoteOf(r), null, '没有计划就不注入计划注记');
  const rows = f.tmp.db
    .prepare(`SELECT content FROM mem_messages WHERE task_id=? AND content LIKE '%dotd.plan%'`)
    .all(taskId) as Array<{ content: string }>;
  assert.equal(rows.length, 0, '没有计划就不落库');
});

test('计划轮模型报错（如熔断）→ 不炸主循环，任务继续', async () => {
  let calls = 0;
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-plan-cfg2-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));
  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean): void => {},
    resumeDotQueue: (): void => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: () => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: { publish: (t, p, o) => tmp.bus.publish(t, p, o), on: (t, h) => tmp.bus.on(t, h) },
  };
  const govOpts = {
    defaults: {
      approvalTtlMs: 86400000, expireScanMs: 300000, precheckTimeoutMs: 45000,
      precheckBudget: { goalBytes: 800, paramsBytes: 1500, maxOutputTokens: 40 },
      reviewFailThreshold: { windowMs: 600000, fails: 5, openMs: 900000 },
      auditRetentionDays: 90, auditRetentionRows: 20000, auditArchiveCapMb: 200,
      chunkBytes: 10485760, memoryPerTierCap: 50, memoryDefaultExpiryDays: 90,
    },
  } as never;
  const rt = createGovernance(tmp.db, catalog, govDeps, govOpts);
  initGovernance(tmp.db, catalog, govDeps, govOpts);
  const exec = new ExecServiceImpl({ db: tmp.db, bus: tmp.bus, cfg: { tokenDir: tmp.root } });
  await exec.boot(['dot1']);
  const memory = new MemoryServiceImpl({ db: tmp.db, outboxPath: tmp.outboxPath, journalMemoryProbe: () => [] });
  const cp = createControlPlane({
    db: tmp.db,
    bus: tmp.bus,
    rules: [RUN_NEW_RULE],
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
  });
  govCp.setAwaitingApproval = (t: string, e: number, a: number) => cp.setAwaitingApproval(t, e, a);
  govCp.onApprovalSettled = (t: string, a: number, ok: boolean) => cp.onApprovalSettled(t, a, ok);
  const runner = new DotRunner(
    {
      cp,
      router: {
        async complete(): Promise<RouteResult> {
          calls += 1;
          if (calls === 1) throw new Error('计划轮挂了');
          return {
            meta: { endpointId: 'e', tier: 1, model: 'm', degraded: false, attemptSeq: 0, tried: [], streamStarted: false },
            response: { content: '照样完成了。' },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
        emergencyActive: false,
      } as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: {
        runTool: (c) => exec.runTool(c),
        getCapabilities: (d) => exec.getCapabilities(d),
        reconcileCall: async () => 'unknown',
        getCallResult: (c) => exec.getCallResult(c),
        cancelTool: (c, r) => exec.cancelTool(c, r),
      },
      memory: {
        openThread: (d, c, o) => memory.openThread(d, c, o),
        appendMessage: (t, m) => memory.appendMessage(t, m),
        appendSystemMessage: (t, m) => memory.appendSystemMessage(t, m),
        buildContextBundle: (d, x, b, o) => memory.buildContextBundle(d, x, b, o),
        buildSessionReplay: (t, task, b) => memory.buildSessionReplay(t, task, b),
        beforeWrite: (d, p, c) => memory.beforeWrite(d, p, c),
        sealTask: (t, o, r) => memory.sealTask(t, o, r),
      },
      governance: {
        evaluate: (ctx, call, o) => evaluate(ctx, call, o ?? {}, rt),
        claim: (a) => claim(a, rt),
        forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
      },
    },
    { log: () => {}, plan: true } as RunnerOptions,
  );
  const { taskId } = ingestAndDecide(cp);
  await flush();
  const out = await runner.runNext();
  assert.equal(out.status, 'done', '计划轮报错不得让任务失败');
  assert.equal(out.summary, '照样完成了。');
  const task = tmp.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
  assert.equal(task.status, 'done');
});

test('修订：模型在正文里给出新版本计划 → 版本号 +1、历史保留、下一轮注入新版', async () => {
  const revised = JSON.stringify({
    items: [
      { text: '先看目录里有什么', status: 'done' },
      { text: '改走备份方案', status: 'doing' },
      { text: '汇总成结论', status: 'todo' },
    ],
    revisionReason: '目录里没有原计划的文件',
  });
  const turns: Turn[] = [
    { content: PLAN_JSON },
    { content: `原路不通，改计划：\n\`\`\`json\n${revised}\n\`\`\``, toolCalls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }] },
    { content: '完成。' },
  ];
  const f = await planFixture({ turns, runnerOpts: { plan: true }, tools: { 'fs.list': okList } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');

  const rows = f.tmp.db
    .prepare(`SELECT content FROM mem_messages WHERE thread_id=(SELECT thread_id FROM tasks WHERE id=?) AND content LIKE ? ORDER BY seq`)
    .all(taskId, `${PLAN_MARKER}%`) as Array<{ content: string }>;
  assert.equal(rows.length, 2, '首版 + 修订版各一条（历史保留，不覆盖）');
  assert.ok(rows[0]!.content.includes('读关键文件'), '历史第一条是首版');
  assert.ok(rows[1]!.content.includes('改走备份方案'), '第二条是修订版');
  assert.ok(rows[1]!.content.includes('"version":2'), '修订版版本号为 2');

  // 最后一轮请求里带的是**修订后**的计划
  const lastReq = f.requests[f.requests.length - 1]!;
  const note = planNoteOf(lastReq);
  assert.ok(note !== null);
  assert.match(note!, /改走备份方案/);
  assert.match(note!, /第 2 版/);
});

test('修订不起作用：正文里给出**相同**计划不刷版本号', async () => {
  const turns: Turn[] = [
    { content: PLAN_JSON },
    { content: `还是这个计划：${PLAN_JSON}`, toolCalls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }] },
    { content: '完成。' },
  ];
  const f = await planFixture({ turns, runnerOpts: { plan: true }, tools: { 'fs.list': okList } });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  await f.runner.runNext();
  const rows = f.tmp.db
    .prepare(`SELECT content FROM mem_messages WHERE thread_id=(SELECT thread_id FROM tasks WHERE id=?) AND content LIKE ?`)
    .all(taskId, `${PLAN_MARKER}%`) as Array<{ content: string }>;
  assert.equal(rows.length, 1, '内容没变 → 不算一次修订');
});

// ── 4. 默认值纪律（静态守卫）──────────────────────────────────────────────

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('默认值守卫：RunnerOptions.plan 缺省 false（不改 Runner 就是关）', async () => {
  const f = await planFixture({
    turns: [{ content: '干完了。' }],
  });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  await f.runner.runNext();
  assert.equal(f.requests.length, 1, '缺省时只有业务那一次调用（没有计划轮）');
  for (const r of f.requests) assert.equal(planNoteOf(r), null);
  const rows = f.tmp.db
    .prepare(`SELECT content FROM mem_messages WHERE thread_id=(SELECT thread_id FROM tasks WHERE id=?) AND content LIKE ?`)
    .all(taskId, `${PLAN_MARKER}%`) as Array<{ content: string }>;
  assert.equal(rows.length, 0, '缺省时不落任何计划消息');
});

test('默认值守卫（源码）：Runner 里 plan 的缺省值必须是 false', () => {
  const src = readFileSync(join(REPO, 'src/runner/dot.ts'), 'utf8');
  assert.match(
    src,
    /this\.planEnabled\s*=\s*opts\.plan\s*\?\?\s*false/,
    'RunnerOptions.plan 缺省必须显式写 false（本轮已有三次"默认值被悄悄改"的教训）',
  );
  assert.ok(
    !/this\.planEnabled\s*=\s*opts\.plan\s*\?\?\s*true/.test(src),
    '不允许缺省 true',
  );
});

test('默认值守卫（源码）：daemon 只在 DOTD_PLAN=on 时打开计划', () => {
  const src = readFileSync(join(REPO, 'src/daemon.ts'), 'utf8');
  assert.match(
    src,
    /plan:\s*process\.env\.DOTD_PLAN\s*===\s*'on'/,
    "装配层必须读 DOTD_PLAN（且只认 'on'），不能硬编码 true",
  );
  assert.ok(
    !/plan:\s*true\b/.test(src),
    '不允许在装配层硬编码 plan: true',
  );
});

test('默认值守卫（源码）：Runner 从不读计划来调度（计划不是控制流）', () => {
  const src = readFileSync(join(REPO, 'src/runner/dot.ts'), 'utf8');
  // 计划只允许出现在"设置/注入/记录"三处；不允许出现在工具派发决策里
  const planRefs = src.split('\n').filter((l) => /planEnabled|planNote|ctx\.plan\b|setPlan|recordPlan/.test(l));
  assert.ok(planRefs.length > 0, '确实有接线');
  assert.ok(
    !/for \(const call of .*plan/i.test(src),
    '工具派发循环不得依赖计划',
  );
  // 计划内容不得出现在 toolCalls 的构造里
  const toolCallLines = src.split('\n').filter((l) => l.includes('toolCalls:') && /plan/i.test(l));
  assert.equal(toolCallLines.length, 0, 'toolCalls 不得由计划推导');
});

// ── 5. 提示词契约 ─────────────────────────────────────────────────────────

test('PLAN_REQUEST_TEXT：要求 3–7 条、指定 JSON 结构、说明"可调整"', () => {
  assert.match(PLAN_REQUEST_TEXT, /3–7 条|3-7 条/);
  assert.match(PLAN_REQUEST_TEXT, /"items"/);
  assert.match(PLAN_REQUEST_TEXT, /status/);
  assert.match(PLAN_REQUEST_TEXT, /不是\*\*必须照做|不是必须照做|新的完整计划/, '必须写明计划不是强制流程');
  assert.ok(PLAN_MIN_ITEMS === 3 && PLAN_MAX_ITEMS === 7, '常量与文案一致');
});

test('与 system prompt 的"干活的节奏"不重复：计划请求只讲**产出格式**，不讲怎么干活', () => {
  // 计划提示不应重复 system prompt 已有的纪律（一次一类动作 / 读错误再改 等）
  assert.ok(!PLAN_REQUEST_TEXT.includes('一轮只发一类动作'), '不与 system prompt 重复');
  assert.ok(!PLAN_REQUEST_TEXT.includes('读错误码'), '不与 system prompt 重复');
});

// ── 6. 清理 ──────────────────────────────────────────────────────────────

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
