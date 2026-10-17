/**
 * tests/runner-main.test.ts —— 主循环 Dot（接缝契约 §8 ①–⑫ 时序 + CP §12 骨架）。
 *
 * 目标断言（ask 指定）：**一个完整任务从事件进赶到 done** 的全链路：
 *   ingestEvent → 规则 run_new → 任务入队 → Runner pop → ⑤ 开会话/绑 thread/注入
 *   → ⑥ LLM 步（journal + attemptId=callId）→ ⑦ 工具步（allow 直接执行）
 *   → ⑩ 结果回喂 → 二次 LLM 无 tool_calls → ⑪ WRITE-SEAL + finish(ok:true) → done。
 *
 * 装配（CONVENTIONS.md §7 stub 模式 + 模块边界）：
 *  - 真件：createControlPlane（Queue/Journal/Matcher/Guard/Scheduler）、
 *          createGovernance（真 tools.yml 目录）、MemoryServiceImpl、ExecServiceImpl；
 *  - stub：makeStubTransport（模型，不发 HTTP）、stubRuntime.handlers（工具，不起容器）。
 *
 * 覆盖支线：
 *  - ⑦ approve 支线：spend 工具 → pending 步 + awaiting_approval → decide(approve_once)
 *    → onApprovalSettled(ok) → 回 queued(resume_from_seq) → 二次 pop
 *    → ⑨ resumeStep 复用同 call_id + claim(final_params_json) → 执行 → done。
 *  - ⑦ deny 支线：未登记工具 → 步 skipped + 结果回喂 → 模型改道 → done。
 *  - 模型熔断支线：AllEndpointsDownError → paused(circuit_open)。
 *  - 背压支线：heartbeat 报 aborted → Runner 让位（迟到 Runner 交看门狗）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTempDataDir, makeStubTransport } from './helpers.ts';
import type { StubResponse, TempDataDir } from './helpers.ts';
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
import { AllEndpointsDownError } from '../src/shared/errors.ts';
import type {
  ChatMessage,
  ExecToolCall,
  ExecToolResult,
  HomeRelPath,
  MemoryServiceApi,
  MemoryWriteResult,
  RouteRequest,
  RouteResult,
} from '../src/shared/contracts.ts';

// ── 1. 脚手架 ────────────────────────────────────────────────────────────

const tmps: TempDataDir[] = [];
const cfgRoots: string[] = [];

/** 与仓库 config/tools.yml 等价的目录（治理未登记一律 deny，契约 J2）。 */
const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: fs.list
    tier: read
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]
  - name: shell.run
    tier: write_file
    upgrade:
      tier: dangerous
      whenContains: ["rm ", "sudo ", "docker ", "> /dev/"]
  - name: browser.open
    tier: read
  - name: browser.act
    tier: browser
  - name: browser.snapshot
    tier: read
  - name: browser.close
    tier: read
  - name: net.get
    tier: read
  - name: net.post
    tier: write_file
  - name: shop.checkout
    tier: spend
    spendParams:
      required: [amountCents, currency, category]
`;

interface Fixture {
  tmp: TempDataDir;
  cp: ReturnType<typeof createControlPlane>;
  runner: DotRunner;
  transport: ReturnType<typeof makeStubTransport>;
  memory: MemoryServiceImpl;
  govRt: ReturnType<typeof createGovernance>;
  /** 接缝 G5 断言用：记录每次 evaluate 收到的 goalDigest（未传 = null）。 */
  goalDigests: Array<string | null>;
}

async function fixture(opts: {
  /** 模型脚本（按顺序消费；耗尽即抛，迫使测试显式声明交互次数）。 */
  script?: StubResponse[];
  /** 工具 stub handler（按工具名；同时喂给 ExecServiceImpl.stubRuntime）。 */
  tools?: Record<string, (call: ExecToolCall) => ExecToolResult>;
  /** stub 容器内预置文件（fs.read/fs.list 用）。 */
  seedFiles?: Record<string, string>;
  /** 事件规则（run_new 才会建任务）。 */
  rules?: EventRule[];
  /** Runner 运行参数覆写。 */
  runnerOpts?: RunnerOptions;
  /** 控制面配置覆写（CP §5.4 步数上限在 ControlPlaneConfig，不在 RunnerOptions）。 */
  cpCfg?: { stepHardLimit?: number; stepSoftLimit?: number };
  /** 覆写 MemoryServiceApi.beforeWrite（接缝 M6 前置检查点）。 */
  beforeWrite?: (dotId: string, path: HomeRelPath, content: string) => Promise<MemoryWriteResult>;
  /** 替换模型面（默认 stub transport；熔断测试传抛错的）。 */
  router?: {
    complete(req: RouteRequest): Promise<RouteResult>;
  };
} = {}): Promise<Fixture> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-runner-cfg-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  // 模型：stub transport（不发 HTTP）
  const transport = makeStubTransport(opts.script ?? []);

  // 治理：真 gate + 真 catalog；cp 钩子在 CP 建好后回填（GOV 不持 epoch）
  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean, _m?: { note?: string; revoke?: string }): void => {},
    resumeDotQueue: (_d: string): void => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: (_c: string) => true },
    router: {
      async complete() {
        return { response: { content: '{"ok":true}' } };
      },
    },
    bus: {
      publish: (topic, payload, o) => tmp.bus.publish(topic, payload, o),
      on: (topic, handler) => tmp.bus.on(topic, handler),
    },
  };
  // 治理：真 gate + 真 catalog；cp 钩子在 CP 建好后回填（GOV 不持 epoch）。
  // defaults 全量必填（GovDefaults 无 Partial 语义），这里只覆盖 precheckBudget 一项、
  // 其余取仓库默认值的等价常量（tests/governance-support.ts 同款做法）。
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

  // 执行面：真 ExecServiceImpl + stub fleet（不起容器）。
  // seedFiles 让 fs.read 有真实内容（stub runtime 的内存文件系统）。
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root },
    ...(opts.tools !== undefined ? { stubRuntime: { handlers: opts.tools } } : {}),
    ...(opts.seedFiles !== undefined ? { stubRuntime: { seedFiles: opts.seedFiles } } : {}),
  });
  // EX §10 boot：容器 absent → ready（stub 后端不起 Docker）
  await exec.boot(['dot1']);

  // 控制面：真件
  // 记忆：真 MemoryServiceImpl（bridge 缺省 = 空桥；/dot/home 读不到即不注入文件记忆）。
  // 必须在建 CP 之前——CP 的 sealTask 钩子（契约 M3）由它提供。
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    journalMemoryProbe: (_taskId, _sinceMs) => [],
  });

  // 控制面：真件。sealTask 钩子 = 记忆模块（契约 M3：终态收口全覆盖）。
  const cp = createControlPlane({
    db: tmp.db,
    bus: tmp.bus,
    ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
    ...(opts.cpCfg !== undefined ? { cfg: opts.cpCfg } : {}),
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
  });
  // 契约面 failTask（CP §5.4 硬上限）→ Queue.markFailed（看门狗同路径）。
  // 装配层未提供该方法时 Runner 会退化为 finish(ok:false)。
  (cp as unknown as { failTask: (t: string, e: number, r: string) => void }).failTask = (
    taskId,
    epoch,
    reason,
  ) => {
    cp.queue.markFailed(taskId, epoch, reason);
  };

  // 治理的 cp 钩子回填到真控制面
  govCp.setAwaitingApproval = (taskId, epoch, approvalId) => {
    cp.setAwaitingApproval(taskId, epoch, approvalId);
  };
  govCp.onApprovalSettled = (taskId, approvalId, ok, meta) => {
    cp.onApprovalSettled(taskId, approvalId, ok, meta);
  };

  // Runner：模型走 stub transport（或测试注入的抛错面）。
  // 治理投影成 GovernanceApi（gate 的自由函数默认读模块单例，即本 fixture 的 rt）。
  // 接缝 G5：evaluate 的第三个参数（goalDigest）由 Runner 传入，这里记录后透传。
  // exec 投影成 ExecServiceApi：reconcileCall 的词表两版不同——
  //   contracts §9（配 Journal 的 ExecReconciler）='done'|'aborted'|'unknown'|'unknown_host'，
  //   ExecServiceImpl 实现（配 CP §5.3 三分流）= ReconcileEntry{outcome:'done'|'doing'|'interrupted'|'skipped'}。
  // Runner 主循环不调它（⑫ 对账归 CP/Journal），此处只做形状适配。
  const goalDigests: Array<string | null> = [];
  const router = opts.router ?? {
    complete: (req: RouteRequest): Promise<RouteResult> => transport.complete(req),
  };
  const runner = new DotRunner(
    {
      cp,
      router: router as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: {
        runTool: (c) => exec.runTool(c),
        getCapabilities: (d) => exec.getCapabilities(d),
        reconcileCall: async (callId) => {
          const entry = await exec.reconcileCall(callId);
          return entry.outcome === 'done' ? 'done' : 'unknown';
        },
        getCallResult: (callId) => exec.getCallResult(callId),
        cancelTool: (callId, reason) => exec.cancelTool(callId, reason),
      },
      // 接缝 M6：beforeWrite 前置检查点（默认走真 MemoryServiceImpl，测试可覆写）。
      // 注意：不能展开 spread 真实例（原型方法会丢），用原型级覆写。
      memory: (() => {
        const wrapped: MemoryServiceApi = {
          openThread: (d, c, o) => memory.openThread(d, c, o),
          appendMessage: (t, m) => memory.appendMessage(t, m),
          appendSystemMessage: (t, m) => memory.appendSystemMessage(t, m),
          buildContextBundle: (d, text, b, o) => memory.buildContextBundle(d, text, b, o),
          buildSessionReplay: (t, task, b) => memory.buildSessionReplay(t, task, b),
          beforeWrite: (d, p, c) =>
            opts.beforeWrite !== undefined ? opts.beforeWrite(d, p, c) : memory.beforeWrite(d, p, c),
          sealTask: (t, o, r) => memory.sealTask(t, o, r),
        };
        return wrapped;
      })(),
      governance: {
        // 接缝 G5：Runner 在 evaluate 前截取 goalDigest（≤800B）注入审查档（不走 GovCtx）
        evaluate: (ctx, call, evaluateOpts) => {
          goalDigests.push(evaluateOpts?.goalDigest ?? null);
          return evaluate(ctx, call, evaluateOpts ?? {}, rt);
        },
        claim: (approvalId) => claim(approvalId, rt),
        forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
      },
    },
    opts.runnerOpts,
  );

  return { tmp, cp, runner, transport, memory, govRt: rt, goalDigests };
}

/** 让微任务/定时器跑完（setImmediate 的 wake、fire-and-forget 的收口）。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** 跑任务直到让位/终态（suspended 会再跑一轮；最多 maxIterations 防死循环）。 */
async function runToSettle(
  runner: DotRunner,
  maxIterations = 20,
): Promise<Array<{ taskId: string; epoch: number; status: string; summary?: string }>> {
  const outs: Array<{ taskId: string; epoch: number; status: string; summary?: string }> = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const out = await runner.runNext();
    if (out.status === 'none') break;
    outs.push({ taskId: out.taskId, epoch: out.epoch, status: out.status, summary: out.summary });
    if (out.status !== 'suspended') break;
  }
  return outs;
}

function taskOf(tmp: TempDataDir, id: string): Record<string, unknown> | undefined {
  return tmp.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
}

function stepsOf(tmp: TempDataDir, taskId: string): Array<Record<string, unknown>> {
  return tmp.db
    .prepare('SELECT * FROM steps WHERE task_id=? ORDER BY seq ASC')
    .all(taskId) as unknown as Array<Record<string, unknown>>;
}

function msgsOf(tmp: TempDataDir, threadId: string): Array<Record<string, unknown>> {
  return tmp.db
    .prepare('SELECT * FROM mem_messages WHERE thread_id=? ORDER BY seq ASC')
    .all(threadId) as unknown as Array<Record<string, unknown>>;
}

/** 事件进赶 + 规则决策（规则命中恒 1.0 → run_new → 入队）。 */
function ingestAndDecide(
  cp: ReturnType<typeof createControlPlane>,
  payload: unknown,
): { eventId: number; taskId: string } {
  const ing = cp.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload });
  void cp.matcher.processEvent(ing.eventId);
  return { eventId: ing.eventId, taskId: `tk_ev_${ing.eventId}` };
}

const RUN_NEW_RULE: EventRule = {
  id: 'r-run',
  match: { source: 'http' },
  action: 'run_new',
  task: { title: '读文件', goal: '读取 notes/x.md 并汇报' },
  reason: '命中 http 规则',
};

// ── 2. 端到端：事件进赶 → done（接缝 §8 ①–⑪）─────────────────────────

test('端到端：事件 ingest → run_new → Runner 主循环 → 工具执行 → WRITE-SEAL → done', async () => {
  const { tmp, cp, runner, transport, goalDigests } = await fixture({
    script: [
      // ① 第一轮 LLM：要调 fs.read（read 层 → allow）
      {
        content: '我先读一下文件。',
        toolCalls: [
          { id: 'call_a1', name: 'fs.read', arguments: '{"path":"/dot/home/notes/x.md"}' },
        ],
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      // ② 工具结果回喂后第二轮：无 tool_calls → done
      { content: '文件读完了，任务完成。', usage: { promptTokens: 120, completionTokens: 30 } },
    ],
    tools: {
      'fs.read': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { path: '/dot/home/notes/x.md', text: 'hello memory' },
        usage: { wall_ms: 2, peak_mem_mb: 4 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [RUN_NEW_RULE],
  });

  // ①–② 事件进赶 + 决策
  const { taskId } = ingestAndDecide(cp, { q: '读一下' });
  await flush();
  assert.ok(taskOf(tmp, taskId) !== undefined, '事件应派生任务 tk_ev_<id>');
  assert.equal(taskOf(tmp, taskId)!['status'], 'queued');

  // ③–⑪ Runner 领任务跑完整主循环
  const outs = await runToSettle(runner);
  assert.equal(outs.length, 1);
  assert.equal(outs[0]!.status, 'done', '任务应跑到 done');
  assert.equal(outs[0]!.summary, '文件读完了，任务完成。');

  const task = taskOf(tmp, taskId)!;
  assert.equal(task['status'], 'done');
  assert.equal(task['stop_reason'], null);
  assert.ok(Number(task['run_epoch']) >= 1, 'pop 后 run_epoch 递增');

  // ⑥/⑦ journal：两步 LLM + 一步工具
  const steps = stepsOf(tmp, taskId);
  const llmSteps = steps.filter((s) => s['kind'] === 'llm');
  const toolSteps = steps.filter((s) => s['kind'] === 'tool');
  assert.equal(llmSteps.length, 2, '两次 LLM 步');
  assert.equal(toolSteps.length, 1, '一次工具步');
  assert.equal(toolSteps[0]!['tool_name'], 'fs.read');
  assert.equal(toolSteps[0]!['status'], 'succeeded');
  assert.equal(toolSteps[0]!['side_effect'], 'safe', 'sideEffect 取 exec.getCapabilities（契约 J2）');
  assert.ok(String(toolSteps[0]!['result_json']).includes('hello memory'), '工具结果落 journal');

  // ⑥ attemptId = journal 步 callId（契约 J1）
  assert.equal(transport.requests.length, 2, '两次模型请求');
  const llmCallIds = llmSteps.map((s) => String(s['call_id']));
  assert.equal(transport.requests[0]!.attemptId, llmCallIds[0], 'attemptId 必须等于 LLM 步 callId');
  assert.equal(transport.requests[1]!.attemptId, llmCallIds[1]);
  assert.equal(transport.requests[0]!.track, 'primary', '主循环走 primary 轨');

  // ⑤ 会话绑定：threadId 回写 tasks（契约 M2 唯一通道）
  assert.ok(String(task['thread_id']).startsWith('thr_'), 'bindSession 回写 thread_id');
  const msgs = msgsOf(tmp, String(task['thread_id']));

  // ⑩ 结果回报（接缝契约 §8 ⑩）：assistant 全文 + tool 摘要都入 thread
  const assistants = msgs.filter((m) => m['role'] === 'assistant' && m['kind'] === 'text');
  assert.ok(assistants.length >= 1, 'assistant 至少一条');
  assert.ok(
    assistants.some((m) => m['content'] === '文件读完了，任务完成。'),
    'assistant 全文（无 tool_calls 的收尾轮）应 appendMessage 入 thread',
  );
  const toolMsgs = msgs.filter((m) => m['kind'] === 'tool_result');
  assert.equal(toolMsgs.length, 1, '一次工具步 → 一条 tool_result');
  assert.ok(String(toolMsgs[0]!['content']).includes('call_id'), 'tool 消息内嵌 call_id 供 §7.3 回填');
  assert.ok(String(toolMsgs[0]!['content']).includes('hello memory'), 'tool 摘要含结果预览');

  // ⑩ 双写禁令（S6）：tool_result 只存 digest+预览，全文在 steps
  for (const m of toolMsgs) {
    assert.ok(String(m['content']).length <= 260, 'tool 消息只存 digest+200 字预览');
  }
  assert.ok(msgs.length >= 2, '至少 task_end + 一条正文');

  // ⑪ WRITE-SEAL：task_end 系统消息恰好一条
  const taskEnd = msgs.filter((m) => m['kind'] === 'task_end');
  assert.equal(taskEnd.length, 1, '恰好一次 WRITE-SEAL');
  assert.ok(String(taskEnd[0]!['content']).includes('"outcome":"done"'));
  assert.equal(String(taskEnd[0]!['task_id']), taskId);

  // 接缝 G5：evaluate 前 Runner 截取 goalDigest（≤800B）注入审查档（不走 GovCtx）
  assert.equal(goalDigests.length, 1, '一次 evaluate（fs.read 一次工具步）');
  assert.equal(goalDigests[0], '读取 notes/x.md 并汇报', 'goalDigest = 任务目标（未超 800B 不截断）');
});

// ── 3. 审批挂起 / 续跑（接缝 §8 ⑨）───────────────────────────────────

test('审批：dangerous(shell.run+rm) → awaiting_approval → approve_once → 续跑同 call_id → done', async () => {
  const { tmp, cp, runner } = await fixture({
    script: [
      // 第一轮：调 shell.run 带 `rm ` 命中 upgrade → dangerous → 一律人工审批
      {
        content: '需要清理。',
        toolCalls: [
          {
            id: 'call_buy',
            name: 'shell.run',
            arguments: '{"cmd":"rm -rf /dot/home/tmp","timeout_ms":5000}',
          },
        ],
        usage: { promptTokens: 50, completionTokens: 10 },
      },
      // 续跑后：无 tool_calls → done
      { content: '清理完成。', usage: { promptTokens: 60, completionTokens: 12 } },
    ],
    tools: {
      'shell.run': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { exitCode: 0, stdout: 'removed' },
        usage: { wall_ms: 3, peak_mem_mb: 2 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [
      { id: 'r-buy', match: { source: 'http' }, action: 'run_new', task: { title: '清理', goal: '清理临时目录' }, reason: 'x' },
    ],
  });

  const { taskId } = ingestAndDecide(cp, 'buy');
  await flush();

  // 第一轮：跑到挂起点
  const first = await runner.runNext();
  assert.equal(first.status, 'suspended', 'dangerous 工具应挂起等审批');
  assert.equal(taskOf(tmp, taskId)!['status'], 'awaiting_approval');

  // journal：该步 pending 且绑定审批单
  const pendingStep = stepsOf(tmp, taskId).find((s) => s['status'] === 'pending');
  assert.ok(pendingStep !== undefined, '工具步应标 pending');
  const callId = String(pendingStep!['call_id']);
  const approvalId = Number(pendingStep!['approval_id']);
  assert.ok(approvalId > 0, 'pending 步绑定审批单');

  // 审批通过（真治理 decide → approved → 钩子 onApprovalSettled(ok) → 回 queued）
  const verdict = await decide(approvalId, 'web', 'approve_once', 'owner');
  assert.equal(verdict.ok, true, 'decide 应放行');
  await flush();

  const afterDecide = taskOf(tmp, taskId)!;
  assert.equal(afterDecide['status'], 'queued', '放行后回 queued 等 pop（不是直入 running，CP §4.1）');
  assert.equal(
    Number(afterDecide['resume_from_seq']),
    Number(pendingStep!['seq']),
    'resume_from_seq = pending 步 seq',
  );

  // 第二轮：Runner 续跑（新 epoch）
  const second = await runner.runNext();
  assert.equal(second.status, 'done', '续跑应完成');
  assert.ok(second.epoch > first.epoch, '续跑 epoch 递增');

  // ⑨ 同一 call_id：pending→started 复用（契约 J1-2）
  const resumed = stepsOf(tmp, taskId).find((s) => s['call_id'] === callId)!;
  assert.equal(resumed['status'], 'succeeded');
  assert.equal(Number(resumed['run_epoch']), second.epoch, '该步带新 epoch');

  // 同 call_id 在执行面 ledger 只有一行（幂等）
  const execRows = tmp.db
    .prepare('SELECT * FROM exec_calls WHERE call_id=?')
    .all(callId) as unknown as Array<Record<string, unknown>>;
  assert.equal(execRows.length, 1, '同 call_id 在 exec ledger 只有一行');

  // claim() 把 final_params_json 固化（GOV §3.3.6）；executing→executed 的终态回写
  // 归治理 decide/执行面回收（Runner 只负责执行前认领），故此处断 executing。
  const apRow = tmp.db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as Record<string, unknown>;
  assert.equal(apRow['status'], 'executing', 'claim 后应为 executing');
  assert.ok(String(apRow['final_params_json']).includes('rm -rf'), 'claim 固化 final_params_json');

  // WRITE-SEAL 一次
  const taskEnd = tmp.db
    .prepare("SELECT * FROM mem_messages WHERE task_id=? AND kind='task_end'")
    .all(taskId) as unknown as Array<Record<string, unknown>>;
  assert.equal(taskEnd.length, 1);
});

// ── 4. deny 支线：步 skipped + 改道 ────────────────────────────────────

test('deny：未登记工具 → 步 skipped + 结果回喂 → 模型改道 → done', async () => {
  const { tmp, cp, runner } = await fixture({
    script: [
      {
        content: '试试。',
        toolCalls: [{ id: 'call_dirty', name: 'evil.tool', arguments: '{"x":1}' }],
        usage: { promptTokens: 10, completionTokens: 5 },
      },
      { content: '该工具被拒，我直接收尾。', usage: { promptTokens: 12, completionTokens: 6 } },
    ],
    rules: [
      { id: 'r-deny', match: { source: 'http' }, action: 'run_new', task: { title: 't', goal: 'g' }, reason: 'x' },
    ],
  });

  const { taskId } = ingestAndDecide(cp, 'x');
  await flush();

  const outs = await runToSettle(runner);
  assert.equal(outs[0]!.status, 'done');
  const skipped = stepsOf(tmp, taskId).find((s) => s['status'] === 'skipped');
  assert.ok(skipped !== undefined, 'deny 的步应标 skipped');
  assert.ok(String(skipped!['result_json']).length > 0, 'skipStep 记录原因');
});

// ── 5. 模型熔断 → paused(circuit_open) ─────────────────────────────────

test('模型熔断：AllEndpointsDownError → paused(circuit_open)（无 waiting_model 态）', async () => {
  const { tmp, cp, runner } = await fixture({
    rules: [RUN_NEW_RULE],
    router: {
      async complete(_req: RouteRequest): Promise<RouteResult> {
        throw new AllEndpointsDownError(['e1#primary'], false);
      },
    },
  });
  const { taskId } = ingestAndDecide(cp, 'boom');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'paused', '模型全灭应挂起');
  assert.equal(taskOf(tmp, taskId)!['status'], 'paused');
  assert.equal(taskOf(tmp, taskId)!['stop_reason'], 'circuit_open');
});

// ── 6. 步数硬上限 → failed(budget)（CP §5.4）────────────────────────────

test('步数硬上限：Journal.nextSeq 越线抛 StepLimitError → failed 且不经 attempt 重试', async () => {
  const { tmp, cp, runner } = await fixture({
    // 上限在控制面配置（Journal 持有；Runner 不持计数器——审码 finding ①：
    // 老测试用 runnerOpts.stepHardLimit=2 掩盖了"默认配置下死码"的实情）。
    cpCfg: { stepHardLimit: 3, stepSoftLimit: 2 },
    script: [
      {
        content: '1',
        toolCalls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        content: '2',
        toolCalls: [{ id: 'c2', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        content: '3',
        toolCalls: [{ id: 'c3', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      { content: '4', usage: { promptTokens: 1, completionTokens: 1 } },
    ],
    tools: {
      'fs.list': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { entries: [] },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [RUN_NEW_RULE],
  });
  const { taskId } = ingestAndDecide(cp, 'loop');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'failed', '越硬上限应判 failed');
  const task = taskOf(tmp, taskId)!;
  assert.equal(task['status'], 'failed', '必须 failed，不能回 queued 重试');
  assert.equal(Number(task['attempt']), 0, 'CP §5.4：硬上限不经 attempt 重试');
  // CP §5.4 原文写 failed(stop_reason='budget')，但 Queue.markFailed 的 SQL 只写
  // status='failed'（queue.ts:628-636，无 stop_reason 列）——CP 缺口，记 deviations。
  // 这里断 task_results 里的 reason（Runner 传入的 summary 落库处）。
  const result = tmp.db
    .prepare('SELECT * FROM task_results WHERE task_id=?')
    .get(taskId) as Record<string, unknown> | undefined;
  assert.ok(result !== undefined, 'failed 任务应写 task_results');
  assert.ok(String(result!['summary']).includes('步数越硬上限'), 'summary 来自 StepLimitError');
});

// ── 7. 背压：heartbeat 报 aborted → Runner 让位 ────────────────────────

test('背压：heartbeat 报 aborted → Runner 让位（迟到 Runner 交看门狗 reclaim）', async () => {
  const { tmp, cp, runner, transport } = await fixture({
    script: [
      {
        content: 'a',
        toolCalls: [{ id: 'c1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      { content: 'b', usage: { promptTokens: 1, completionTokens: 1 } },
    ],
    tools: {
      'fs.list': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { entries: [] },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [RUN_NEW_RULE],
  });
  const { taskId } = ingestAndDecide(cp, 'bp');
  await flush();

  // 模拟看门狗判迟到：把 heartbeat 打成 aborted
  const realHeartbeat = cp.heartbeat.bind(cp);
  let abortedOnce = false;
  (cp as unknown as { heartbeat: typeof cp.heartbeat }).heartbeat = (id, epoch, usage) => {
    if (!abortedOnce) {
      abortedOnce = true;
      return { overBudget: false, aborted: true };
    }
    return realHeartbeat(id, epoch, usage);
  };

  const out = await runner.runNext();
  assert.equal(out.status, 'aborted', 'heartbeat aborted 应立即让位');
  void transport;
  void taskId;
});

// ── 8. 接缝 M6：fs.write 前置 beforeWrite 检查点 ────────────────────────

test('接缝 M6：beforeWrite 软限 warning 附回工具响应', async () => {
  const { tmp, cp, runner, transport } = await fixture({
    beforeWrite: async () => ({ ok: true, warning: 'soft:warn' }),
    script: [
      {
        content: '写一下。',
        toolCalls: [{ id: 'c_w1', name: 'fs.write', arguments: '{"path":"/dot/home/a.md","content":"x"}' }],
        usage: { promptTokens: 5, completionTokens: 2 },
      },
      { content: '写好了。', usage: { promptTokens: 6, completionTokens: 3 } },
    ],
    tools: {
      'fs.write': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { written: call.args['path'] },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [RUN_NEW_RULE],
  });
  const { taskId } = ingestAndDecide(cp, 'w');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'done');
  const wStep = stepsOf(tmp, taskId).find((s) => s['tool_name'] === 'fs.write')!;
  assert.equal(wStep['status'], 'succeeded', '软限不阻断派发');
  assert.ok(String(wStep['result_json']).includes('soft:warn'), '软限 warning 应附回工具结果');
  assert.equal(transport.requests.length, 2, 'warning 回喂后模型应收尾');
});

test('接缝 M6：beforeWrite 硬限 → 不派发工具、error 回喂让模型改道', async () => {
  const dispatched: string[] = [];
  const { tmp, cp, runner } = await fixture({
    beforeWrite: async () => ({ ok: false, error: 'HARD_LIMIT', warning: 'soft:warn' }),
    script: [
      {
        content: '写一下。',
        toolCalls: [{ id: 'c_w2', name: 'fs.write', arguments: '{"path":"/dot/home/b.md","content":"y"}' }],
        usage: { promptTokens: 5, completionTokens: 2 },
      },
      { content: '写不了，改道。', usage: { promptTokens: 6, completionTokens: 3 } },
    ],
    tools: {
      'fs.write': (call) => {
        dispatched.push(call.call_id);
        return {
          call_id: call.call_id,
          status: 'ok',
          result: { written: call.args['path'] },
          usage: { wall_ms: 1, peak_mem_mb: 1 },
          finished_at: new Date().toISOString(),
        };
      },
    },
    rules: [RUN_NEW_RULE],
  });
  const { taskId } = ingestAndDecide(cp, 'w2');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'done', '硬限不失败任务，回喂后改道收尾');
  assert.equal(dispatched.length, 0, '硬限不得派发 fs.write');
  const wStep = stepsOf(tmp, taskId).find((s) => s['tool_name'] === 'fs.write')!;
  assert.equal(wStep['status'], 'failed', '硬限步记 failed');
  assert.ok(String(wStep['result_json']).includes('HARD_LIMIT'), '回喂 error 落 journal');
});

// ── 9. 接缝 G5：goalDigest ≤800B 截断 ──────────────────────────────────

test('接缝 G5：超长 goal 截到 ≤800B 后再注入 evaluate', async () => {
  const longGoal = 'G'.repeat(5_000);
  const { cp, runner, goalDigests } = await fixture({
    script: [
      {
        content: '读。',
        toolCalls: [{ id: 'c_g1', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        usage: { promptTokens: 5, completionTokens: 2 },
      },
      { content: '完。', usage: { promptTokens: 6, completionTokens: 3 } },
    ],
    tools: {
      'fs.list': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { entries: [] },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      }),
    },
    rules: [
      { id: 'r-g5', match: { source: 'http' }, action: 'run_new', task: { title: 't', goal: longGoal }, reason: 'x' },
    ],
  });
  ingestAndDecide(cp, 'g5');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(goalDigests.length, 1);
  const digest = goalDigests[0]!;
  assert.ok(Buffer.byteLength(digest, 'utf8') <= 800, 'goalDigest 必须 ≤800B');
  assert.ok(digest.length < longGoal.length, '超长 goal 应被截断');
});

// ── 10. WRITE-SEAL 去重键时序（审码 finding ⑦）────────────────────────

test('WRITE-SEAL：sealOnFinish=false 的空跑不得占住去重键', async () => {
  const { cp, runner } = await fixture({
    script: [{ content: '完。', usage: { promptTokens: 1, completionTokens: 1 } }],
    rules: [RUN_NEW_RULE],
  });
  ingestAndDecide(cp, 'seal1');
  await flush();

  const out = await runner.runNext();
  assert.equal(out.status, 'done');
  // 旧实现先 add(key) 再判 sealOnFinish：空跑也会把键写进去，
  // 之后同一 (task,outcome,reason) 的真封会被静默吞掉（finding ⑦）。
  const sealed = (runner as unknown as { sealed: Set<string> }).sealed;
  assert.equal(sealed.size, 0, '空跑（sealOnFinish=false）不得登记去重键');
});

test('WRITE-SEAL：sealTask 抛错不得登记去重键（后续同键收口仍可重试）', async () => {
  let calls = 0;
  const base = await fixture({
    script: [
      { content: 'a', usage: { promptTokens: 1, completionTokens: 1 } },
      { content: 'b', usage: { promptTokens: 1, completionTokens: 1 } },
    ],
    rules: [RUN_NEW_RULE],
  });
  // 让模型步抛普通错误：stepLlm → finish(ok:false) → attempt<max 回 queued（可再 pop）
  const runner = new DotRunner(
    {
      cp: base.cp,
      router: {
        complete: async () => {
          throw new Error('model boom');
        },
      } as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: {
        runTool: async () => ({ call_id: '', status: 'ok', result: null }),
        getCapabilities: async () => [],
        reconcileCall: async () => 'unknown',
        getCallResult: async () => null,
        cancelTool: async () => {},
      },
      memory: {
        openThread: (d, c, o) => base.memory.openThread(d, c, o),
        appendMessage: (t, m) => base.memory.appendMessage(t, m),
        appendSystemMessage: (t, m) => base.memory.appendSystemMessage(t, m),
        buildContextBundle: (d, text, b, o) => base.memory.buildContextBundle(d, text, b, o),
        buildSessionReplay: (t, task, b) => base.memory.buildSessionReplay(t, task, b),
        beforeWrite: (d, p, c) => base.memory.beforeWrite(d, p, c),
        sealTask: async () => {
          calls += 1;
          throw new Error('seal boom');
        },
      },
      governance: {
        evaluate: async () => ({ kind: 'deny', decisionId: 'd', reason: 'no tools' }),
        claim: async () => ({ ok: false }),
        forceApproval: async () => ({ approvalId: 0 }),
      },
    },
    { sealOnFinish: true },
  );

  const { taskId } = ingestAndDecide(base.cp, 'seal2');
  await flush();

  // 第一轮：模型错 → finish(ok:false) → 回 queued；sealTask 抛错（记 failed/model_error）
  const first = await runner.runNext();
  assert.equal(first.status, 'failed');
  assert.equal(calls, 1, '第一次收口应调 sealTask');
  assert.equal(taskOf(base.tmp, taskId)!['status'], 'queued', 'attempt<max → 回 queued 重试');

  // 等 backoff（finish 里 2^1*1000ms）过后再 pop 一次，同一收口键
  await new Promise((r) => setTimeout(r, 2_200));
  const second = await runner.runNext();
  assert.equal(second.status, 'failed');
  assert.equal(calls, 2, '失败不得登记键，否则第二次同键收口被吞（finding ⑦）');

  const sealed = (runner as unknown as { sealed: Set<string> }).sealed;
  assert.equal(sealed.size, 0, '两次都失败 → 键一个都不登记');
});
