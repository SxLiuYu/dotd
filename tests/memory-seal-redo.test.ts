/**
 * tests/memory-seal-redo.test.ts —— P1-4「WRITE-SEAL 补写一轮真的是补写」验收。
 *
 * ## 老的缺陷（一句话）
 * `sealTask` 由 CP 的 `sealTask` 钩子在 `queue.finish()` **内部**调用——那时任务已是终态、
 * Runner 主循环已退出，它 `appendSystemMessage(SEAL_REMINDER_TEXT)` 追加的"提醒"永远
 * 没有下一轮 LLM 去读。所以"补写一轮"从未发生，那条消息只会在下次同 thread 的任务里
 * 当历史噪音出现 = **假提醒**。
 *
 * ## 修法（选项 A：Runner 侧收口）
 * 在 `cp.finish()` **之前**问 `memory.needsMemoryRedo()`（只判定、不写库），
 * 该补就真跑一轮（`memoryWriteRedo`）——补写轮里的 `fs.write` 落在任务**仍 running**
 * 的时间窗内，journal/心跳/epoch 围栏全部照常成立，最后才 finish。
 * 不用选项 B（sealTask 返回信号）的原因：B 要求改 CP 的 sealTask 钩子签名（跨模块契约），
 * 而且照样受"终态之后"约束——信号回到 Runner 时任务已经 finish 了，还是跑不了 LLM。
 *
 * ## 四条验收（对应任务描述 ①②③④）
 * ① done + 未写记忆 → 确实发生了一轮额外模型调用，其 prompt 含提醒文案；
 * ② 该轮写了 notes/ → 判定为已补写，sealTask 不再记 missed；
 * ③ 回复 SKIP → 记 missed，且**不会重复提醒**（injectOnce，跨 attempt）；
 * ④ failed/cancelled 不触发补写轮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTempDataDir, makeStubTransport, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import { DotRunner, MEMORY_REDO_PROMPT } from '../src/runner/dot.ts';
import type { RunnerOptions } from '../src/runner/dot.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { createGovernance, initGovernance, evaluate, claim, forceApproval, resolveExecution } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import type {
  ExecToolCall,
  ExecToolResult,
  GovernanceApi,
  MemoryServiceApi,
  ModelRouterApi,
  RouteRequest,
  RouteResult,
} from '../src/shared/contracts.ts';

const tmps: TempDataDir[] = [];
const cfgRoots: string[] = [];
test.afterEach(async () => {
  // ⚠ CP 的 sealTask 钩子在 `queue.finish()` 里**同步触发、异步完成**（契约 M3）。
  // 若这里立刻 cleanup() 关库，收口里的 DB 写会拿到 `database is not open`，
  // 而该错误被 sealTask 的软线吞掉 → 表现成"missed 恒为 1"这种假红（排查时踩过）。
  // 先让收口的异步段跑完，再关库。
  await new Promise<void>((r) => setImmediate(r));
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
test.after(sweepTempPaths);

const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]
  - name: shell.run
    tier: write_file
`;

/** 一次模型响应。`toolCalls` 被刻意放宽成 unknown[]，便于构造脏数据。 */
type StubResp = { content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };

interface Rig {
  tmp: TempDataDir;
  cp: ReturnType<typeof createControlPlane>;
  runner: DotRunner;
  exec: ExecServiceImpl;
  memory: MemoryServiceImpl;
  taskId: string;
  /** 主循环 + 补写轮全部模型请求（按顺序）。 */
  requests: RouteRequest[];
  /** 第 0 轮主循环脚本、第 1 轮补写轮脚本分开给，便于断言"补写轮确实发生"。 */
  taskStatus(): string;
  memMessages(): Array<{ kind: string; content: string }>;
  /**
   * 等收口异步段落库（CP 的 sealTask 钩子是 finish 内同步触发、异步完成）。
   * 断言 `mem.status()` 之前必须调它，否则会读到收口之前的快照。
   */
  settle(): Promise<void>;
}

/**
 * @param opts.main       主循环的模型脚本（耗尽即抛）。
 * @param opts.redo       **补写轮**的响应（只在第 2 类请求上消费；不给 = 补写轮返回 SKIP）。
 * @param opts.runnerOpts RunnerOptions 覆写（含 memoryRedo 开关）。
 * @param opts.seedNotes 预置：主循环里已经用 fs.write 写过记忆文件（模拟"本次写过"）。
 */
async function makeRig(opts: {
  main: StubResp[];
  redo?: StubResp;
  runnerOpts?: RunnerOptions;
  /**
   * 传 false = **不替调用方填 memoryRedo**，让 DotRunner 用它自己的默认值
   * （默认值语义由 ⑤-a 单独钉住）。缺省 true = 本文件其他用例都测"打开时"的行为。
   */
  defaultRedo?: boolean;
}): Promise<Rig> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-seal-redo-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  // 记忆：真 MemoryServiceImpl；journalMemoryProbe 走真 journal（getJournal 全量步）。
  // 必须先于 CP 建（CP 的 sealTask 钩子在构造期注入，见下）。
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    // 与 daemon.ts 同款：从 steps.args_json 还原真实路径
    journalMemoryProbe: async (taskId, sinceMs) => {
      const { memoryWritePathsOfStep } = await import('../src/memory/step-paths.ts');
      return cp
        .getJournal(taskId)
        .filter((s) => s.startedAt >= sinceMs)
        .flatMap((s) => memoryWritePathsOfStep(s));
    },
  });

  // 真控制面 + **契约 M3 的真装配**：Queue.finish 内部调 sealTask 钩子。
  // 这就是"终态之后才封存"的现场——P1-4 的补写轮必须绕开它、提前到 finish 之前。
  const cp = createControlPlane({
    db: tmp.db,
    bus: tmp.bus,
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
  });

  // 执行面：真 ExecServiceImpl + stub runtime（fs.write 落内存文件系统）
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root },
    stubRuntime: {
      handlers: {
        // shell.run 默认成功（本文件不靠它写记忆）
        'shell.run': (call: ExecToolCall): ExecToolResult => ({
          call_id: call.call_id,
          status: 'ok',
          result: { stdout: '', exit_code: 0 },
          finished_at: new Date().toISOString(),
        }),
      },
    },
  });

  // 治理
  const govCp = {
    setAwaitingApproval: () => {},
    onApprovalSettled: () => {},
    resumeDotQueue: () => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: () => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: {
      publish: (topic, payload, o) => tmp.bus.publish(topic, payload, o),
      on: (topic, h) => tmp.bus.on(topic, h),
    },
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
    },
  };
  const rt = createGovernance(tmp.db, catalog, govDeps, govOpts as never);
  initGovernance(tmp.db, catalog, govDeps, govOpts as never);

  // ── 模型：一个小路由器，把"补写轮"与"主循环轮"区分开 ──
  // 判据 = 请求里第一条 message 的 content 是否就是 MEMORY_REDO_PROMPT（补写轮的请求体
  // 第一句就是我们写死的 system 文案）。这样断言"补写轮真的发了一次请求"不依赖调用次数。
  const mainTransport = makeStubTransport(opts.main as never);
  const requests: RouteRequest[] = [];
  const router = {
    async complete(req: RouteRequest): Promise<RouteResult> {
      requests.push(req);
      const first = req.messages[0];
      const isRedo = first !== undefined && first.role === 'system' && first.content === MEMORY_REDO_PROMPT;
      if (isRedo) {
        const r = opts.redo ?? { content: 'SKIP' };
        return {
          meta: {
            endpointId: 'stub-redo',
            tier: 2,
            model: 'stub-light',
            degraded: false,
            attemptSeq: 0,
            tried: [],
            streamStarted: false,
          },
          response: { content: r.content, toolCalls: r.toolCalls },
          usage: { promptTokens: 30, completionTokens: 5 },
        };
      }
      return mainTransport.complete(req);
    },
  } as unknown as ModelRouterApi;

  const task = cp.queue.submit({ title: '整理会议记录', goal: '把会议记录整理成要点' });

  const memApi: MemoryServiceApi = {
    openThread: (d, c, o) => memory.openThread(d, c, o),
    appendMessage: (t2, m) => memory.appendMessage(t2, m),
    appendSystemMessage: (t2, m) => memory.appendSystemMessage(t2, m),
    buildContextBundle: (d, text, b, o) => memory.buildContextBundle(d, text, b, o),
    buildSessionReplay: (thr, task2, b) => memory.buildSessionReplay(thr, task2, b),
    beforeWrite: (d, p, c) => memory.beforeWrite(d, p, c),
    sealTask: (t2, o, r) => memory.sealTask(t2, o, r),
    needsMemoryRedo: (t2, o) => memory.needsMemoryRedo(t2, o),
    hasMemoryReminder: (id) => memory.hasMemoryReminder(id),
    markMemoryReminder: (id, at) => memory.markMemoryReminder(id, at),
  };
  const governance: GovernanceApi = {
    evaluate: (ctx, call, o) => evaluate(ctx, call, o ?? {}, rt),
    claim: (id) => claim(id, rt),
    forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
    resolveExecution: (id, outcome) => resolveExecution(id, outcome, rt),
  };

  await exec.boot(['dot1']);

  const runner = new DotRunner(
    {
      cp: cp as never,
      router,
      exec: {
        runTool: (c: ExecToolCall) => exec.runTool(c),
        getCapabilities: (d: string) => exec.getCapabilities(d),
        reconcileCall: async () => 'unknown',
        getCallResult: () => Promise.resolve(null),
        cancelTool: (id: string, reason: string) => exec.cancelTool(id, reason),
      },
      memory: memApi,
      governance,
    },
    opts.defaultRedo === false ? { ...opts.runnerOpts } : { memoryRedo: true, ...opts.runnerOpts },
  );

  return {
    tmp,
    cp,
    runner,
    exec,
    memory,
    taskId: task.id,
    requests,
    taskStatus: () => String((cp.getTask(task.id) as { status?: string } | null)?.status),
    memMessages: () =>
      tmp.db
        .prepare('SELECT kind, content FROM mem_messages ORDER BY seq ASC')
        .all() as unknown as Array<{ kind: string; content: string }>,
    settle: () => new Promise<void>((r) => setImmediate(r)),
  };
}

/**
 * 本任务自己的 seal 记账（missed:<taskId> 这一行）。
 *
 * 为什么不直接断言 `status().seal.missed`：那个计数是**全局**的，且同时被
 * buildContextBundle 的 bridge 降级计入（key=`inject:<dot>:<taskId>`）——本用例里
 * stub 桥读不到 /dot/home 就会记一条。全局计数适合看板，不适合做"这次 seal 记了什么"的断言。
 */
function sealMarkOf(rig: Rig): string | null {
  const row = rig.tmp.db
    .prepare('SELECT value FROM mem_maintenance_state WHERE key = ?')
    .get(`missed:${rig.taskId}`) as { value?: string } | undefined;
  return row?.value ?? null;
}

/** 常规主循环：一轮工具调用 + 一轮收尾（无工具 → done）。 */
const MAIN_WITH_WRITE: StubResp[] = [
  {
    content: '先把要点写下来',
    toolCalls: [
      {
        id: 'call_w1',
        name: 'fs.write',
        arguments: JSON.stringify({ path: 'notes/2026-10-18-meeting.md', content: '# 要点\n- 三件事' }),
      },
    ],
  },
  { content: '整理完了。' },
];
const MAIN_NO_WRITE: StubResp[] = [
  { content: '读了一下资料' },
];

function isRedoRequest(r: RouteRequest): boolean {
  const first = r.messages[0];
  return first !== undefined && first.role === 'system' && first.content === MEMORY_REDO_PROMPT;
}

// ═══════════════════════════════════════════════════════════════════
// ① done + 未写记忆 → 确实发生了一轮额外模型调用，prompt 含提醒文案
// ═══════════════════════════════════════════════════════════════════

test('① done + 未写记忆 → 补写轮真的发生了（额外一次模型调用，prompt 含提醒文案）', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE, redo: { content: 'SKIP' } });
  const out = await rig.runner.runNext();

  assert.equal(out.status, 'done', '任务正常收口');
  // 主循环 1 次 + 补写轮 1 次
  assert.equal(rig.requests.length, 2, `应发生 2 次模型调用，实际 ${rig.requests.length}`);
  const redo = rig.requests.filter(isRedoRequest);
  assert.equal(redo.length, 1, '补写轮是独立的一次请求');
  const prompt = redo[0]!.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('SKIP'), 'prompt 必须告诉模型"没有可沉淀的回 SKIP"');
  assert.ok(prompt.includes('notes/'), 'prompt 必须指明往哪写');
  assert.ok(prompt.includes(MEMORY_REDO_PROMPT), 'system 段就是导出的常量（可测试）');
});

test('①b 顺序正确：补写轮发生在 cp.finish() **之前**（任务此刻仍是 running）', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE });
  // 记录补写轮请求发生时任务的状态
  const statusesDuringRedo: string[] = [];
  const origComplete = rig.runner['router'] as unknown as {
    complete: (r: RouteRequest) => Promise<RouteResult>;
  };
  const wrapped = origComplete.complete.bind(origComplete);
  origComplete.complete = async (r: RouteRequest): Promise<RouteResult> => {
    if (isRedoRequest(r)) statusesDuringRedo.push(rig.taskStatus());
    return wrapped(r);
  };
  await rig.runner.runNext();
  assert.deepEqual(
    statusesDuringRedo,
    ['running'],
    '补写轮必须在任务仍 running 时发出——这是"终态之后跑不了 LLM"那个难点的直接证据',
  );
});

// ═══════════════════════════════════════════════════════════════════
// ② 补写轮写了 notes/ → 判定为已补写，sealTask 不再记 missed
// ═══════════════════════════════════════════════════════════════════

test('② 补写轮写了 notes/ → 工具真的执行了，且 sealTask 判定已写记忆（missed=0）', async () => {
  const rig = await makeRig({
    main: MAIN_NO_WRITE,
    redo: {
      content: '',
      toolCalls: [
        {
          id: 'call_redo_1',
          name: 'fs.write',
          arguments: JSON.stringify({ path: 'notes/2026-10-18-lesson.md', content: '## 经验\n先看再改' }),
        },
      ],
    },
  });
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done');

  // journal 里应有补写轮的工具步，且 succeeded
  const toolSteps = rig.tmp.db
    .prepare("SELECT tool_name, status, args_json FROM steps WHERE tool_name='fs.write' ORDER BY seq")
    .all() as unknown as Array<{ tool_name: string; status: string; args_json: string }>;
  assert.equal(toolSteps.length, 1, '补写轮里的 fs.write 必须真的派发并落 journal');
  assert.equal(toolSteps[0]!.status, 'succeeded');
  // Runner 的 path 域适配：模型给相对路径 → 派发前补 /dot/home/ 前缀（exec 侧再校验）
  assert.match(toolSteps[0]!.args_json, /notes\/2026-10-18-lesson\.md/);

  // sealTask 的判定：写过了 → 不记 missed
  await rig.settle(); // 收口是 finish 内同步触发、异步完成，先等它落库
  const st = await rig.memory.status();
  assert.equal(sealMarkOf(rig), null, '补写成功 → 本任务不记 missed（这正是 §4.3 想要的效果）');
});

test('②b 主循环里已经写过记忆 → 根本不该发起补写轮（零打扰）', async () => {
  const rig = await makeRig({ main: MAIN_WITH_WRITE });
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(
    rig.requests.filter(isRedoRequest).length,
    0,
    '已写过 → 不花这一次模型调用（补写轮是唯一可能多出来的轮次）',
  );
  assert.equal(rig.requests.length, 2, '只有主循环的两轮');
});

// ═══════════════════════════════════════════════════════════════════
// ③ 回复 SKIP → 记 missed，且不会重复提醒（injectOnce）
// ═══════════════════════════════════════════════════════════════════

test('③ 回复 SKIP → 记 missed，且同一任务不会再被提醒第二次', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE, redo: { content: 'SKIP' } });
  await rig.runner.runNext();
  await rig.settle();

  const st = await rig.memory.status();
  assert.equal(sealMarkOf(rig), 'done', 'SKIP = 模型明确说没东西可写 → 记 missed（reason=done，已提醒过）');
  assert.equal(rig.memory.hasMemoryReminder(rig.taskId), true, 'injectOnce 已记账');

  // 再跑一次收口判定（模拟下一 attempt / 重试）：不得再提醒
  const task = rig.cp.getTask(rig.taskId)!;
  assert.equal(
    await rig.memory.needsMemoryRedo(task, 'done'),
    false,
    'injectOnce：同一任务不再提醒（否则每次重试都白烧一次调用）',
  );
});

test('③b 补写轮失败/模型抛错 → 软降级：任务仍然 done，不重复提醒', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE });
  // 让补写轮抛错
  const router = rig.runner['router'] as unknown as { complete: (r: RouteRequest) => Promise<RouteResult> };
  const orig = router.complete.bind(router);
  router.complete = async (r: RouteRequest): Promise<RouteResult> => {
    if (isRedoRequest(r)) throw new Error('light 轨全灭');
    return orig(r);
  };
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done', '补写轮失败绝不能把成功的任务拖成失败（§8 软线）');
  assert.equal(rig.taskStatus(), 'done');

  // 已记账 → 下一 attempt 不会再问
  assert.equal(rig.memory.hasMemoryReminder(rig.taskId), true);
  assert.equal(await rig.memory.needsMemoryRedo(rig.cp.getTask(rig.taskId)!, 'done'), false);
  // 补写轮的失败在 journal 留痕（可排查），但不影响任务终态。
  // llm 步的错误摘要落在 result_json（endLlm 的 respDigest 位）；按前缀搜。
  const llmSteps = rig.tmp.db
    .prepare("SELECT result_json FROM steps WHERE kind='llm' ORDER BY seq")
    .all() as unknown as Array<{ result_json: string | null }>;
  assert.ok(
    llmSteps.some((s) => String(s.result_json ?? '').startsWith('error:')),
    '补写轮的错误要落 journal（不留静默黑洞）',
  );
});

// ═══════════════════════════════════════════════════════════════════
// ④ failed / cancelled 不触发补写轮
// ═══════════════════════════════════════════════════════════════════

test('④ failed：不触发补写轮（止损优先）', async () => {
  const rig = await makeRig({
    main: [
      {
        content: '跑个命令',
        toolCalls: [{ id: 'call_s1', name: 'shell.run', arguments: JSON.stringify({ cmd: 'x', timeout_ms: 100 }) }],
      },
    ],
  });
  // 让主循环在工具轮之后失败：模型面抛非熔断错误
  const router = rig.runner['router'] as unknown as { complete: (r: RouteRequest) => Promise<RouteResult> };
  let n = 0;
  const orig = router.complete.bind(router);
  router.complete = async (r: RouteRequest): Promise<RouteResult> => {
    if (isRedoRequest(r)) return orig(r);
    n += 1;
    if (n >= 2) throw new Error('模型炸了');
    return orig(r);
  };
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'failed', '模型错误 → 任务失败');
  assert.equal(rig.requests.filter(isRedoRequest).length, 0, 'failed 不得触发补写轮');
});

test('④b cancelled：sealTask(cancelled) 不触发补写轮的判定', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE });
  const task = rig.cp.getTask(rig.taskId)!;
  // needsMemoryRedo 只对 done 为真
  assert.equal(await rig.memory.needsMemoryRedo(task, 'cancelled'), false);
  assert.equal(await rig.memory.needsMemoryRedo(task, 'failed'), false);
  assert.equal(await rig.memory.needsMemoryRedo(task, 'done'), true, 'done 且未写 → 该补');
});

test('④c 开关关闭（memoryRedo:false）→ 逐字回到老行为：不补写、不花调用', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE, runnerOpts: { memoryRedo: false } });
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(rig.requests.filter(isRedoRequest).length, 0, '开关关闭 → 零补写轮');
  // 老行为：sealTask 会记 missed（因为确实没写记忆）
  await rig.settle();
  const st = await rig.memory.status();
  assert.equal(sealMarkOf(rig), 'seal_missed', '没补写 → 记 seal_missed（观测面：该提醒却漏了）');
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ 开关语义（Lead 裁定）：默认 false = 既有行为；装配层显式传 true 才真补写
// ═══════════════════════════════════════════════════════════════════
//
// 这一组是"功能在生产上不会变回假提醒"的**唯一证据**：
//   - 默认值必须等于既有行为（否则等于悄悄给每个任务多一轮 LLM 调用）；
//   - 生产语义由装配层显式声明（src/daemon.ts 传 memoryRedo:true）；
//   - 传了 true 就必须真的发生，否则 P1-4 又退化成假提醒。

test('⑤-a 默认值（不传 memoryRedo）→ 与既有行为逐字相同：零补写轮、主循环轮次不变', async () => {
  // defaultRedo:false = 不替调用方填 memoryRedo，让 DotRunner 用它自己的默认值
  const rig = await makeRig({ main: MAIN_NO_WRITE, defaultRedo: false });
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done');
  // 主循环 1 轮（MAIN_NO_WRITE 只有一条无工具响应）
  assert.equal(rig.requests.length, 1, '默认不补写：只有主循环那一次模型调用');
  assert.equal(rig.requests.filter(isRedoRequest).length, 0);
});

test('⑤-b 显式传 memoryRedo:true → 补写轮真的发生（防"生产上又变回假提醒"）', async () => {
  const rig = await makeRig({ main: MAIN_NO_WRITE, runnerOpts: { memoryRedo: true } });
  const out = await rig.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(
    rig.requests.filter(isRedoRequest).length,
    1,
    '装配层显式打开后，必须真的多跑一轮"要么写记忆、要么 SKIP"',
  );
  assert.equal(rig.requests.length, 2, '主循环 1 次 + 补写轮 1 次');
  // 且这一轮的 prompt 就是导出的提醒文案（不是别的什么请求）
  const redo = rig.requests.find(isRedoRequest)!;
  assert.equal(redo.messages[0]!.content, MEMORY_REDO_PROMPT);
});

test('⑤-c 生产装配（src/daemon.ts）确实显式传了 memoryRedo:true', async () => {
  // 静态守卫：默认值是 false，若装配层忘了显式打开，功能在生产上就等于不存在。
  // 这条用源码文本断言，防的是"改回 ?? true 或在装配里漏掉"的复发。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const daemonSrc = readFileSync(
    fileURLToPath(new URL('../src/daemon.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    daemonSrc,
    /new DotRunner\([\s\S]*?memoryRedo:\s*true/,
    'daemon 装配必须显式 memoryRedo: true（否则 P1-4 在生产上不生效）',
  );

  const runnerSrc = readFileSync(
    fileURLToPath(new URL('../src/runner/dot.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    runnerSrc,
    /this\.memoryRedoEnabled = opts\.memoryRedo \?\? false/,
    'RunnerOptions.memoryRedo 的默认值必须是 false（= 与既有行为一致）',
  );
  assert.doesNotMatch(
    runnerSrc,
    /this\.memoryRedoEnabled = opts\.memoryRedo \?\? true/,
    '不得改回默认 true：那会给所有人的每个任务悄悄多加一轮 LLM 调用',
  );
});
