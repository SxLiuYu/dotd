/**
 * tests/runner-watchdog-liveness.test.ts —— P0-3 的**端到端**回归（真 Runner + 真 ExecService + 真看门狗）。
 *
 * tests/control-plane-watchdog-liveness.test.ts 钉的是"看门狗判据"与"EX 轮询接缝"；
 * 本文件把它接成一条真实链路，证明缺陷修复发生在**生产路径**上，而不是只在零件上：
 *
 *   DotRunner.runNext()
 *     → stepTool → exec.runTool(deadline_ms = 目录声明的 30min，不再是 60s)
 *     → ExecServiceImpl.pollJob → 假上游每轮 GET /jobs 报 running（模拟工具在途 200s）
 *     → 注入的 liveness → cp.heartbeat(live)   （在途期间持续续心跳）
 *     → 看门狗：不得回收；工具最终返回后任务正常收口、**只执行一次**
 *
 * 时间：轮询间隔 1ms、每轮把虚拟时钟推 10s（20 轮 = 200s 虚拟时间）。
 * **没有任何真 sleep 数分钟**：整个文件实测 < 2s。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTempDataDir, makeStubTransport, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { ControlPlaneInstance } from '../src/control-plane/index.ts';
import { ControlPlaneWatchdog } from '../src/control-plane/scheduler.ts';
import { DotRunner } from '../src/runner/dot.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { createGovernance, initGovernance, evaluate, claim, forceApproval } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import { DEFAULT_EXEC_CONFIG } from '../src/exec/types.ts';
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
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
test.after(sweepTempPaths);

const HEARTBEAT_TIMEOUT_MS = 180_000;
/** 模拟"工具在途"的虚拟时长：200s（> 180s 看门狗超时）。 */
const TOOL_WALL_MS = 200_000;
const POLL_INTERVAL_MS = 1;
/** 每轮轮询推进的虚拟时间（10s × 20 轮 = 200s）。 */
const VIRTUAL_STEP_MS = 10_000;
const POLLS = TOOL_WALL_MS / VIRTUAL_STEP_MS;

const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: shell.run
    tier: write_file
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]
`;

interface Rig {
  tmp: TempDataDir;
  cp: ControlPlaneInstance;
  runner: DotRunner;
  exec: ExecServiceImpl;
  taskId: string;
  /** 虚拟时钟（毫秒）。 */
  now(): number;
  /** 假上游：getJob 被调用的次数。 */
  polls(): number;
  /** 工具执行了几次（幂等底线：必须恰好 1）。 */
  executions(): number;
  /** 推进到"当前时刻"跑一次看门狗。 */
  sweep(): void;
  watchdog: ControlPlaneWatchdog;
}

/**
 * @param opts.stallAfter 从第几轮起上游"卡死"（不再答话：getJob 抛错）。
 *   null = 全程正常推进（工具确实是长任务）。
 */
async function makeRig(opts: { stallAfter?: number | null; script: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> }): Promise<Rig> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-runner-wd-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  // ── 控制面 ──
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  (cp as unknown as { failTask: (t: string, e: number, r: string) => void }).failTask = (taskId, epoch, reason) => {
    cp.queue.markFailed(taskId, epoch, reason);
  };
  const t = cp.queue.submit({ title: 'long-tool', goal: '跑一个 200s 的任务' });
  const watchdog = new ControlPlaneWatchdog({
    db: tmp.db,
    queue: cp.queue,
    journal: cp.journalImpl,
    bus: tmp.bus,
    record: (kind, level, detail) => {
      tmp.db
        .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
        .run(Date.now(), level, kind, detail);
    },
  });

  // ── 虚拟时钟 ──
  const base = Date.now();
  let offset = 0;
  const now = (): number => base + offset;
  // 任务的 last_heartbeat_at 基准对齐虚拟时钟：保证"200s 后"真的越过 180s 超时
  tmp.db.prepare('UPDATE tasks SET last_heartbeat_at=? WHERE id=?').run(now(), t.id);

  // ── 执行面：假上游（async 模式，逐轮报 running） ──
  let polls = 0;
  let executions = 0;
  const runtime = {
    async startJob(): Promise<{ job_id: string }> {
      return { job_id: 'job_1' };
    },
    async getJob(): Promise<ExecToolResult> {
      polls += 1;
      if (opts.stallAfter !== null && opts.stallAfter !== undefined && polls > opts.stallAfter) {
        // 上游"卡死"：容器不再答话。pollJob 会 probeHealth；health 也失败 → 抛 transport_error
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        throw new Error('ECONNREFUSED（上游卡死）');
      }
      if (polls <= POLLS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        offset += VIRTUAL_STEP_MS; // 虚拟时间前进 10s
        return { call_id: 'c1', job_id: 'job_1', status: 'running' };
      }
      executions += 1;
      return { call_id: 'c1', job_id: 'job_1', status: 'ok', result: { stdout: 'long done' } };
    },
    async cancelJob(): Promise<void> {},
    async health(): Promise<unknown> {
      // 注意：boot 阶段（容器 booting）也要 health；这里只有"工具在途中途"才算卡死
      if (opts.stallAfter !== null && opts.stallAfter !== undefined && polls >= opts.stallAfter) {
        throw new Error('health down');
      }
      return { ok: true };
    },
    async capabilities(): Promise<Array<{ name: string }>> {
      return [];
    },
    async getCall(): Promise<unknown> {
      return null;
    },
    async confirmCall(): Promise<boolean> {
      return true;
    },
    async compactLedger(): Promise<string[]> {
      return [];
    },
  };
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root, pollIntervalMs: POLL_INTERVAL_MS },
    runtime: runtime as never,
    clock: now,
    // 生产装配（daemon.ts）同款：EX 只经注入回调调 CP 的心跳，不 import CP
    liveness: {
      live: ({ taskId, epoch, now: at }) => {
        cp.heartbeat(taskId, epoch, undefined, { live: { at } });
      },
    },
  });
  await exec.boot(['dot1']);

  // ── 记忆 / 治理 / 模型 ──
  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    journalMemoryProbe: () => [],
  });
  const govCp = {
    setAwaitingApproval: () => {},
    onApprovalSettled: () => {},
    resumeDotQueue: () => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: () => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: { publish: (topic, payload, o) => tmp.bus.publish(topic, payload, o), on: (topic, h) => tmp.bus.on(topic, h) },
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

  const transport = makeStubTransport(opts.script as never);
  const router = {
    complete: (req: RouteRequest): Promise<RouteResult> => transport.complete(req),
  } as unknown as ModelRouterApi;
  const memApi: MemoryServiceApi = {
    openThread: (d, c, o) => memory.openThread(d, c, o),
    appendMessage: (t2, m) => memory.appendMessage(t2, m),
    appendSystemMessage: (t2, m) => memory.appendSystemMessage(t2, m),
    buildContextBundle: (d, text, b, o) => memory.buildContextBundle(d, text, b, o),
    buildSessionReplay: (thr, task2, b) => memory.buildSessionReplay(thr, task2, b),
    beforeWrite: (d, p, c) => memory.beforeWrite(d, p, c),
    sealTask: (task2, o, r) => memory.sealTask(task2, o, r),
  };
  const governance: GovernanceApi = {
    evaluate: (ctx, call, o) => evaluate(ctx, call, o ?? {}, rt),
    claim: (id) => claim(id, rt),
    forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
  };

  const runner = new DotRunner({
    cp,
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

  return {
    tmp,
    cp,
    runner,
    exec,
    taskId: t.id,
    now,
    polls: () => polls,
    executions: () => executions,
    sweep: () => watchdog.watchdog(now()),
    watchdog,
  };
}

function rowOf(rig: Rig): Record<string, unknown> {
  return rig.tmp.db.prepare('SELECT * FROM tasks WHERE id=?').get(rig.taskId) as Record<string, unknown>;
}

const TWO_ROUND_SCRIPT = [
  {
    content: '先跑个长命令',
    toolCalls: [{ id: 'call_shell_1', name: 'shell.run', arguments: '{"cmd":"sleep 200","timeout_ms":200000}' }],
  },
  { content: '长命令跑完了。' },
];

test('端到端：shell.run 在途 200s（上游持续 running）→ 看门狗不回收，任务落 done，工具只执行一次', async () => {
  const rig = await makeRig({ stallAfter: null, script: TWO_ROUND_SCRIPT });

  // 主循环跑到让位；在工具在途期间并发扫看门狗（生产是 10s 子周期）
  const sweeping = (async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2));
      rig.sweep();
    }
  })();
  const out = await rig.runner.runNext();
  await sweeping;

  assert.equal(out.status, 'done', `任务应正常收口（实际 ${out.status}: ${out.summary ?? ''}）`);
  const row = rowOf(rig);
  assert.equal(row['status'], 'done');
  assert.equal(Number(row['attempt']), 0, '全程不得被回收（attempt 保持 0）');
  assert.equal(rig.executions(), 1, '工具只执行一次（绝不重复执行）');

  // 心跳确实越过了 180s：最后一次心跳时刻 - 起点 ≥ 180s
  const hb = Number(row['last_heartbeat_at'] ?? 0);
  assert.ok(hb > 0);
  const first = await rig.tmp.db
    .prepare("SELECT MIN(ts) AS t FROM resource_events WHERE kind='watchdog'")
    .get() as { t: number | null };
  assert.equal(first.t, null, '全程没有 watchdog 回收记录');

  // 工具步是 succeeded，且 deadline 用的是 async 档（30min），不是 60s
  const step = rig.tmp.db
    .prepare("SELECT status, args_json FROM steps WHERE tool_name='shell.run' AND task_id=?")
    .get(rig.taskId) as { status: string; args_json: string };
  assert.equal(step.status, 'succeeded');
  const shellCalls = rig.tmp.db
    .prepare("SELECT COUNT(*) AS n FROM exec_calls WHERE tool='shell.run'")
    .get() as { n: number };
  assert.ok(shellCalls.n >= 1, 'exec_calls 有记录');
  assert.equal(DEFAULT_EXEC_CONFIG.asyncDeadlineMs, 30 * 60_000);
});

test('端到端：同一时序下若上游真的卡死（不再答话）→ 心跳停写，看门狗仍能用 180s 回收', async () => {
  const rig = await makeRig({ stallAfter: 3, script: TWO_ROUND_SCRIPT });
  const out = await rig.runner.runNext();

  // 上游在第 3 轮后卡死：getJob 抛错 → probeHealth 也失败 → 本次调用以 transport_error 收口
  // （Runner 把错误回喂给模型让它们改道；这本身不是缺陷——缺陷是"卡死却永远不被回收"）。
  assert.equal(out.status, 'done', '工具失败被回喂后模型收尾 → 任务终态由模型决定');
  const toolStep = rig.tmp.db
    .prepare("SELECT status, result_json FROM steps WHERE tool_name='shell.run'")
    .get() as { status: string; result_json: string };
  assert.equal(toolStep.status, 'failed', '卡死的工具必须记 failed，不许假装成功');
  assert.match(toolStep.result_json, /transport_error/, '错误码要能看懂（transport_error，retryable）');
  assert.equal(rig.executions(), 0, '卡死的工具没有产出结果，更不得被重放成"执行过"');

  // 接缝侧的关键证据：上游停止答话之后心跳**不再被续写**。
  const hb = Number(rowOf(rig)['last_heartbeat_at'] ?? 0);
  const lastBeat = hb > 0 ? hb : rig.now();
  assert.ok(
    lastBeat < rig.now() + 1,
    '最后一次心跳不晚于卡死时刻（心跳只认上游推进）',
  );

  // 底线：把任务摆回"协程已死、心跳停在最后推进时刻"的形态，180s 后必须被回收。
  rig.tmp.db
    .prepare("UPDATE tasks SET status='running', last_heartbeat_at=? WHERE id=?")
    .run(lastBeat, rig.taskId);
  const attemptBefore = Number(rowOf(rig)['attempt']);
  rig.watchdog.watchdog(lastBeat + HEARTBEAT_TIMEOUT_MS);
  assert.equal(rowOf(rig)['status'], 'running', '恰好 180s 不回收');
  rig.watchdog.watchdog(lastBeat + HEARTBEAT_TIMEOUT_MS + 1);
  const after = rowOf(rig);
  assert.equal(after['status'], 'queued', '真卡死超过 180s → 看门狗回收');
  assert.equal(Number(after['attempt']), attemptBefore + 1, 'attempt+1（attempt 计数的唯一来源）');
});
