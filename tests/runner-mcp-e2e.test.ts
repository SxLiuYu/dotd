/**
 * tests/runner-mcp-e2e.test.ts —— P2-1 **最完整**的端到端取证。
 *
 * 这一条覆盖 Lead 要求的全部环节，一个环节都不跳：
 *
 *   ① 模型看到 `mcp.call`（工具面 / toolSpecs）
 *   → ② Runner 派发（真 DotRunner + 真 ControlPlane）
 *   → ③ 治理拦截（dangerous 档 → awaiting_approval，任务挂起）
 *   → ④ 主人审批（真 governance.decide(approve_once)）
 *   → ⑤ Runner 续跑 → ExecService 宿主网关 → **真 spawn scripts/mcp-echo-server.mjs**
 *   → ⑥ stdio JSON-RPC 往返 → 结果回到模型（下一轮 LLM 的 messages 里看得到）
 *
 * 用的都是真件：真 governance gate/catalog、真 ControlPlane、真 ExecServiceImpl、
 * 真 MCP 子进程。只有模型是 stub（不能依赖网络）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDataDir, makeStubTransport, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import { DotRunner } from '../src/runner/dot.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { McpClient } from '../src/exec/mcp-client.ts';
import { createGovernance, initGovernance, evaluate, claim, forceApproval, decide } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import type {
  ChatMessage,
  ControlPlane,
  ExecToolCall,
  ExecToolResult,
  GovernanceApi,
  MemoryServiceApi,
  ModelRouterApi,
  RouteRequest,
  RouteResult,
} from '../src/shared/contracts.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ECHO_SERVER = join(REPO_ROOT, 'scripts', 'mcp-echo-server.mjs');

const tmps: TempDataDir[] = [];
const cfgRoots: string[] = [];
const disposers: Array<() => void> = [];
test.afterEach(() => {
  for (const d of disposers.splice(0)) {
    try {
      d();
    } catch {
      // 已关
    }
  }
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
test.after(sweepTempPaths);

/** 与仓库 config/tools.yml 同形的治理目录，**含 mcp.call（dangerous）**。 */
const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]
  - name: shell.run
    tier: write_file
  - name: net.get
    tier: read
  - name: net.post
    tier: write_file
  - name: mcp.call
    tier: dangerous
`;

interface Fixture {
  tmp: TempDataDir;
  cp: ReturnType<typeof createControlPlane>;
  runner: DotRunner;
  transport: ReturnType<typeof makeStubTransport>;
  rt: ReturnType<typeof createGovernance>;
  exec: ExecServiceImpl;
}

async function fixture(script: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>): Promise<Fixture> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-mcp-e2e-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  // ── 真治理 ──
  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean, _m?: { note?: string; revoke?: string }): void => {},
    resumeDotQueue: (_d: string): void => {},
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

  // ── 真执行面 + 真 MCP 客户端（真子进程）──
  const mcp = new McpClient([
    { name: 'echo', command: process.execPath, args: [ECHO_SERVER], timeoutMs: 10_000, allowTools: ['echo', 'add'] },
  ]);
  disposers.push(() => mcp.dispose());
  const exec = new ExecServiceImpl({ db: tmp.db, bus: tmp.bus, cfg: { tokenDir: tmp.root }, mcp });
  disposers.push(() => exec.dispose());
  await exec.boot(['dot1']);

  // ── 真记忆 + 真控制面 ──
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    journalMemoryProbe: () => [],
  });
  const cp = createControlPlane({
    db: tmp.db,
    bus: tmp.bus,
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
  });
  govCp.setAwaitingApproval = (taskId, epoch, approvalId) => cp.setAwaitingApproval(taskId, epoch, approvalId);
  govCp.onApprovalSettled = (taskId, approvalId, ok, meta) => cp.onApprovalSettled(taskId, approvalId, ok, meta);

  const transport = makeStubTransport(script as never);
  const router = { complete: (req: RouteRequest): Promise<RouteResult> => transport.complete(req) } as unknown as ModelRouterApi;

  const memApi: MemoryServiceApi = {
    openThread: (d, c, o) => memory.openThread(d, c, o),
    appendMessage: (t, m) => memory.appendMessage(t, m),
    appendSystemMessage: (t, m) => memory.appendSystemMessage(t, m),
    buildContextBundle: (d, text, b, o) => memory.buildContextBundle(d, text, b, o),
    buildSessionReplay: (t, task, b) => memory.buildSessionReplay(t, task, b),
    beforeWrite: (d, p, c) => memory.beforeWrite(d, p, c),
    sealTask: (t, o, r) => memory.sealTask(t, o, r),
    needsMemoryRedo: (t, o) => memory.needsMemoryRedo(t, o),
    hasMemoryReminder: (id) => memory.hasMemoryReminder(id),
    markMemoryReminder: (id, at) => memory.markMemoryReminder(id, at),
  };
  const governance: GovernanceApi = {
    evaluate: (ctx, call, o) => evaluate(ctx, call, o ?? {}, rt),
    claim: (id) => claim(id, rt),
    forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
  };

  const runner = new DotRunner({
    cp: cp as unknown as ControlPlane,
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
  });

  const task = cp.queue.submit({ title: '查一下外部工具', goal: '用外部 echo 工具算 2+40' });
  void task;
  return { tmp, cp, runner, transport, rt, exec };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ═══════════════════════════════════════════════════════════════════
// 完整链路
// ═══════════════════════════════════════════════════════════════════

test('P2-1 端到端：模型看到 mcp.call → 派发 → 治理拦截 → 审批 → 真打到 server → 结果回模型', async () => {
  const fx = await fixture([
    // 第一轮：模型决定调外部工具
    {
      content: '我调一下外部 echo 服务器算个加法。',
      toolCalls: [
        {
          id: 'call_mcp_1',
          name: 'mcp.call',
          arguments: JSON.stringify({ server: 'echo', tool: 'add', arguments: { a: 2, b: 40 } }),
        },
      ],
    },
    // 第二轮：拿到结果后的收尾（断言它能看到 42）
    { content: '外部工具算出来是 42。' },
  ]);

  // ── ① 模型看到 mcp.call（工具面）──
  const caps = await fx.exec.getCapabilities('dot1');
  assert.ok(caps.some((c) => c.name === 'mcp.call'), '① 工具面里有 mcp.call');

  const first = await fx.runner.runNext();

  // ── ②③ Runner 派发 → 治理拦截（dangerous → 挂起等审批）──
  assert.equal(first.status, 'suspended', '②③ dangerous 档 → Runner 让位等审批');
  const taskId = first.taskId;
  const row = fx.tmp.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
  assert.equal(row.status, 'awaiting_approval', '任务进入 awaiting_approval');

  const pendingStep = fx.tmp.db
    .prepare("SELECT call_id, approval_id, tool_name, status FROM steps WHERE task_id=? AND status='pending'")
    .get(taskId) as { call_id: string; approval_id: number; tool_name: string } | undefined;
  assert.ok(pendingStep !== undefined, '工具步标 pending 并绑定审批单');
  assert.equal(pendingStep!.tool_name, 'mcp.call');
  const approvalId = Number(pendingStep!.approval_id);
  assert.ok(approvalId > 0);

  // 审批单本身必须是 dangerous 档（复核治理口径）
  const approval = fx.tmp.db.prepare('SELECT tier, status FROM approvals WHERE id=?').get(approvalId) as {
    tier: string;
    status: string;
  };
  assert.equal(approval.tier, 'dangerous', '审批单档位必须是 dangerous（外部工具最严档）');
  assert.equal(approval.status, 'pending');

  // ── ④ 主人审批（真 decide）──
  const verdict = await decide(approvalId, 'web', 'approve_once', 'owner');
  assert.equal(verdict.ok, true, '④ 审批放行');
  await flush();
  const afterDecide = fx.tmp.db.prepare('SELECT status, resume_from_seq FROM tasks WHERE id=?').get(taskId) as {
    status: string;
    resume_from_seq: number;
  };
  assert.equal(afterDecide.status, 'queued', '放行后回 queued 等 pop');

  // ── ⑤⑥ Runner 续跑 → 真打到 MCP server → 结果回模型 ──
  const second = await fx.runner.runNext();
  assert.equal(second.status, 'done', `⑤⑥ 续跑应完成，实际 ${second.status}: ${second.summary ?? ''}`);

  // 工具步成功，且结果里有 server 真算出的 42
  const doneStep = fx.tmp.db
    .prepare('SELECT status, result_json FROM steps WHERE call_id=?')
    .get(pendingStep!.call_id) as { status: string; result_json: string };
  assert.equal(doneStep.status, 'succeeded', '工具步成功');
  assert.match(doneStep.result_json, /"sum":42/, '结果来自真 MCP server（add 2+40=42）');

  // ── ⑥ 结果真的回到了模型：第二轮请求的 messages 里能看到 42 ──
  assert.equal(fx.transport.requests.length, 2, '共两轮模型调用');
  const secondReq = fx.transport.requests[1]!;
  const allContent = secondReq.messages.map((m) => m.content).join('\n');
  assert.match(allContent, /"sum":42/, '⑥ 第二轮请求里带着工具结果（42），模型据此收尾');
  assert.match(
    allContent,
    /call_id=\S+/,
    '工具结果以 role=tool 回喂，并带 journal call_id（Runner 派发用的是 journal callId，不是模型给的 id）',
  );
  // 工具通道里真的有一条 role=tool（协议配对正确：它必须紧跟在 assistant.tool_calls 之后）
  const toolMsgs = secondReq.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1, '恰好一条 role=tool 结果回喂');
  // ChatMessage 契约里 tool_calls 是可选扩展字段（toChatMessage 通过交叉类型补的），
  // 类型面不声明它，这里按结构读。
  const hasAssistantCalls = secondReq.messages.some((m) => {
    const withCalls = m as ChatMessage & { tool_calls?: unknown[] };
    return m.role === 'assistant' && Array.isArray(withCalls.tool_calls) && withCalls.tool_calls.length > 0;
  });
  assert.ok(hasAssistantCalls, '前面必须有带 tool_calls 的 assistant 消息（OpenAI 兼容协议要求）');
});
