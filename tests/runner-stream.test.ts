/**
});
  // 与「complete() 路径遇到非熔断类模型错误」的收口对齐。
  //
  // 事实（读码 + 实测）：在这套实现里，complete() 把**所有**异常都算候选失败——
  // 走完候选就抛 AllEndpointsDownError → Runner 收成 paused(circuit_open)。
  // 所以 complete 路径根本**产不出**"failed"型收口（实测：单端点 bad_protocol 也是 paused）。
  // 而流式首字节后断流是 §4.7 明令「绝不重放」→ 只失败一次、不耗候选 → 落到
  // stepLlm 的"其余模型错误"分支，收成 failed。两条路径因此**必然不同**，
  // 而这正是正确的：不重放就不该升级成"全端点都挂了"。
  //
  // 因此这里断言的是"流式断流的收口 == 模型错误分支的收口"（而不是硬拉 complete 对齐）：
  const offline = await fixtureSingleEndpoint({ chatError: makeBadProtocol('上游回了非 JSON') });
  const off = ingestAndDecide(offline.cp);
  await flush();
  const offFirst = await offline.runner.runNext();
  const b = await outcomeFacts(offline, off.taskId, offFirst);
  assert.equal(offline.rec.chat.length, 1, 'complete 路径：单端点一次调用');
  assert.equal(b.status, 'paused', 'complete 路径的失败会升级成全候选耗尽 → paused（既有语义）');
  assert.equal(b.stopReason, 'circuit_open');
  // 对照结论：流式断流**不**走 paused，而是可恢复的 failed；两者都是"安全收口"，
  // 区别只在「有没有把错误升级成全端点不可用」——断流没资格做那个升级。
  assert.equal(first.status, 'failed');
  assert.equal(task['status'], 'queued', '断流后可恢复：回队列等 retry');
  assert.notEqual(task['stop_reason'], 'circuit_open', '断流不得把任务打成熔断暂停');
  // 两条路径都把自己的失败写进 journal（complete 侧记 error 前缀，stream 侧同样）
  const offLlmSteps = stepsOf(offline.tmp, off.taskId).filter((s) => s['kind'] === 'llm');
  assert.match(String(offLlmSteps[0]!['result_json']), /^error:/, 'complete 路径同样以 error: 记');
  assert.match(String(llmSteps[0]!['result_json']), /^error:/, 'stream 路径同样以 error: 记');
/**
 * tests/runner-stream.test.ts —— roadmap P0-2：把流式接到 Runner。
 *
 * 这里验证的是**接线**，不是重造流式：候选扫描 / 首字节分界 / tier 降级 / 熔断结算 /
 * `meta.tried` 记账 / 零用量空壳重试**全在 `ModelRouter.stream()`**（已有
 * `tests/router-stream.test.ts` 覆盖）。本文件只钉四件事：
 *
 * ① 流式增量顺序正确，全部 delta 拼起来与**离线聚合**（同脚本走 complete()）的 assistant
 *    全文逐字相同，且 `chat.final` = 该全文；
 * ② transport 中途（首字节前）抛错 → 走现有错误分类与降级，**收口与 complete() 路径逐字一致**
 *    （这里把两条路径并排跑，逐条断言暂停/失败的分支、stop_reason、journal 记账）；
 * ③ 无 stream 能力 / 开关关闭 / 未注入总线 → `complete()` 路径被调用（spy 断言）；
 * ④ 工具调用回合：轮次由完整回合聚合后再交付（流式协议不承载 tool_calls 分片），
 *    `assistant.tool_calls` 与工具结果按 call_id 配对正确。
 *
 * 装配：真 control-plane / 真 ModelRouter（真 transport 注入）/ 真 ExecService stub fleet /
 * 真 MemoryService；唯一被替换的是「网络那头是谁」（fake ModelTransport）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { EventRule } from '../src/control-plane/match.ts';
import { DotRunner } from '../src/runner/dot.ts';
import type { ChatDeltaPublisher, RunnerOptions } from '../src/runner/dot.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import type { ModelTransport, ChatCall, ChatOutcome, GetOutcome, Usage } from '../src/router/types.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { createGovernance, initGovernance, decide, evaluate, claim, forceApproval } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import type { GovDefaults } from '../src/governance/config.ts';
import { AllEndpointsDownError, StreamInterruptedError } from '../src/shared/errors.ts';
import { StreamToolCallAccumulator } from '../src/shared/tool-stream.ts';
import type {
  ChatChunk,
  ControlPlane,
  ExecToolCall,
  ExecToolResult,
  GovernanceApi,
  HomeRelPath,
  MemoryServiceApi,
  MemoryWriteResult,
  RouteRequest,
  RouteResult,
} from '../src/shared/contracts.ts';

// ── 1. 脚手架 ────────────────────────────────────────────────────────────

const tmps: TempDataDir[] = [];
const cfgRoots: string[] = [];

const TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: fs.list
    tier: read
`;

/** models.yml：一个 tier1 云端点 + 一个 tier2 本地端点（降级链要两个候选）。 */
const MODELS_YML = `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true

  - id: local-llm
    tier: 2
    base_url: http://127.0.0.1:8001/v1
    api_key_env: LOCAL_API_KEY
    models: { primary: olmoe-1b, light: olmoe-1b }
    style: openai
    timeouts: { connect_ms: 100, idle_ms: 1000, total_ms: 2000 }
    local: { health_url: http://127.0.0.1:8001/health, max_concurrency: 1, queue_reject_ms: 50 }

routing:
  default_track: primary
  light_events: [event.classify, memory.summarize]

breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3

alerts:
  dedup_window_ms: 86400000
  channel_order: [outbox]
  channel_timeout_ms: 10000

recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources:
    - type: openrouter_models
      filter: ":free"
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`;

/** 构造一个"上游协议坏了"的端点级错误（classifyError → bad_protocol，不耗模型链）。 */
function makeBadProtocol(message: string): Error {
  return Object.assign(new Error(message), { name: 'BadProtocolError' });
}
/** 单端点版 models.yml（对照用例用，避免多候选耗尽升级为 paused）。 */
const MODELS_YML_ONE = `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true

routing:
  default_track: primary
  light_events: [event.classify, memory.summarize]

breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3

alerts:
  dedup_window_ms: 86400000
  channel_order: [outbox]
  channel_timeout_ms: 10000

recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources: []
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`;
// ── 2. 可控传输面（网络那头是谁）──────────────────────────────────────────

/** 一个端点上的一次模型调用该怎么表现。 */
interface Turn {
  /** 流式增量序列（非流式 chat 用 join('') 作全文）。 */
  chunks?: string[];
  /** 流到第 N 个 chunk **之前**抛错（0 = 首字节前就断）。 */
  streamFailAfter?: number;
  /** 非流式 chat 直接抛错。 */
  chatError?: Error;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: Usage;
}

/**
 * 记录式 fake transport：`stream()` 与 `chat()` 各自记账，
 * 这样测试能直接断言"到底走了哪条路、走了几次、每次的请求是什么"。
 */
interface Recorder {
  chat: ChatCall[];
  stream: ChatCall[];
}

function makeScriptedTransport(script: Record<string, Turn[]>, rec: Recorder): ModelTransport {
  const queues = new Map<string, Turn[]>();
  for (const [id, turns] of Object.entries(script)) queues.set(id, [...turns]);
  const take = (id: string): Turn | undefined => queues.get(id)?.shift();
  const textOf = (t: Turn): string => (t.chunks ?? []).join('');
  return {
    async chat(call: ChatCall): Promise<ChatOutcome> {
      rec.chat.push(call);
      const t = take(call.endpoint.id);
      if (t === undefined) throw new Error(`fake: ${call.endpoint.id} 的 chat 脚本耗尽`);
      if (t.chatError !== undefined) throw t.chatError;
      return {
        response: { content: textOf(t), ...(t.toolCalls !== undefined ? { toolCalls: t.toolCalls } : {}) },
        usage: t.usage ?? { promptTokens: 30, completionTokens: 9 },
      };
    },
    stream(call: ChatCall) {
      rec.stream.push(call);
      const t = take(call.endpoint.id);
      const chunks: ChatChunk[] = (t?.chunks ?? []).map((delta) => ({ delta }));
      // 工具调用按**真流式增量**形状下发（名字首块、参数 4 字节切片），
      // 这样测到的就是生产同一条聚合路径（shared/tool-stream.ts），不是特例。
      for (const [i, tc] of (t?.toolCalls ?? []).entries()) {
        const argChunks = tc.arguments.match(/.{1,4}/gs) ?? [''];
        chunks.push({
          delta: '',
          toolCalls: [{ index: i, id: tc.id, name: tc.name, argumentsDelta: argChunks[0] ?? '' }],
        });
        for (const rest of argChunks.slice(1)) {
          chunks.push({ delta: '', toolCalls: [{ index: i, argumentsDelta: rest }] });
        }
      }
      chunks.push({ delta: '', done: true });
      let usageRead = false;
      const it = (async function* (): AsyncGenerator<ChatChunk> {
        if (t === undefined) throw new Error(`fake: ${call.endpoint.id} 的 stream 脚本耗尽`);
        for (let i = 0; i < chunks.length; i += 1) {
          if (t.streamFailAfter !== undefined && i === t.streamFailAfter) {
            throw new Error('fake: 连接在流式中被重置（ECONNRESET）');
          }
          yield chunks[i]!;
        }
      })();
      // 与 ModelRouter 同语义：回合结束后交出**成品**工具调用（聚合规则用生产那份）。
      const acc = new StreamToolCallAccumulator();
      for (const c of chunks) if (c.toolCalls !== undefined) acc.push(c.toolCalls);
      return Object.assign(it, {
        async usage(): Promise<Usage | undefined> {
          if (usageRead) return undefined;
          usageRead = true;
          if (t === undefined || t.streamFailAfter !== undefined) throw new Error('fake: 流断，无 usage');
          return t.usage ?? { promptTokens: 30, completionTokens: 9 };
        },
        toolCalls() {
          return acc.settle();
        },
      });
    },
    async get(): Promise<GetOutcome> {
      // 本地端点探活恒健康（本文件不测本地闸门）
      return { ok: true, status: 200, json: { status: 'ok' }, latencyMs: 1 };
    },
    async metadata() {
      return { ok: false, items: [], error: 'fake' };
    },
  };
}

// ── 3. 总线记录器（chat.delta / chat.final 的实际 payload）───────────────────

interface BusRecord {
  seq: number;
  topic: string;
  payload: Record<string, unknown>;
  dotId?: string;
}

function makeBusRecorder(inner?: ChatDeltaPublisher): { bus: ChatDeltaPublisher; events: BusRecord[] } {
  const events: BusRecord[] = [];
  let seq = 0;
  return {
    events,
    bus: {
      publish(topic, payload, opts) {
        seq += 1;
        events.push({ seq, topic, payload, ...(opts?.dotId !== undefined ? { dotId: opts.dotId } : {}) });
        return inner?.publish(topic, payload, opts);
      },
    },
  };
}

const deltasOf = (events: BusRecord[]): string[] =>
  events.filter((e) => e.topic === 'chat.delta').map((e) => String(e.payload['delta'] ?? ''));
const finalsOf = (events: BusRecord[]): BusRecord[] => events.filter((e) => e.topic === 'chat.final');

// ── 4. fixture ───────────────────────────────────────────────────────────

interface Fixture {
  tmp: TempDataDir;
  cp: ReturnType<typeof createControlPlane>;
  runner: DotRunner;
  router: ModelRouter;
  rec: Recorder;
  events: BusRecord[];
  memory: MemoryServiceImpl;
  transport: ModelTransport;
}

const RUN_NEW_RULE: EventRule = {
  id: 'r-run',
  match: { source: 'http' },
  action: 'run_new',
  task: { title: '回答', goal: '写一首短诗' },
  reason: '命中 http 规则',
};

/** 一次完整装配（CP → MR → GOV → EX → MEM → Runner），可切换流式/非流式。 */
async function fixture(opts: {
  script: Record<string, Turn[]>;
  /** RunnerOptions 覆写（bus / streamChat / 节流参数）。 */
  runnerOpts?: RunnerOptions;
  /** true = 不给 Runner 注入 bus（验证零行为回退）。 */
  omitBus?: boolean;
  /** 复用同一份 script 给离线对照片（同脚本、同端点顺序）。 */
  tools?: Record<string, (call: ExecToolCall) => ExecToolResult>;
}): Promise<Fixture> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-runner-stream-cfg-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  writeFileSync(join(cfgRoot, 'models.yml'), MODELS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  // 真 ModelRouter + 注入的 fake transport（不发网络）
  const rec: Recorder = { chat: [], stream: [] };
  const transport = makeScriptedTransport(opts.script, rec);
  const router = ModelRouter.load({
    db: tmp.db,
    configDir: cfgRoot,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport,
  });

  // 治理
  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean, _m?: { note?: string; revoke?: string }): void => {},
    resumeDotQueue: (_d: string): void => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: (_c: string) => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: {
      publish: (topic, payload, o) => tmp.bus.publish(topic, payload, o),
      on: (topic, handler) => tmp.bus.on(topic, handler),
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

  const memory = new MemoryServiceImpl({
    db: tmp.db,
    outboxPath: tmp.outboxPath,
    journalMemoryProbe: () => [],
  });
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

  const { bus, events } = makeBusRecorder();
  const runnerOpts: RunnerOptions = {
    log: () => {},
    // 测试里把合帧窗口设为 0：断言的是**内容与顺序**，不是节流时序。
    streamFlushMs: 0,
    streamFlushChars: 1,
    ...(opts.omitBus === true ? {} : { bus }),
    ...opts.runnerOpts,
  };
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
        beforeWrite: (d, p, c) => memory.beforeWrite(d, p, c),
        sealTask: (t, o, r) => memory.sealTask(t, o, r),
      },
      governance: {
        evaluate: (ctx, call, evaluateOpts) => evaluate(ctx, call, evaluateOpts ?? {}, rt),
        claim: (approvalId) => claim(approvalId, rt),
        forceApproval: (taskId, req) => forceApproval(taskId, req, rt),
      },
    },
    runnerOpts,
  );
  return { tmp, cp, runner, router, rec, events, memory, transport };
}

/**
 * 单端点 fixture（models.yml 只留 cloud-main）：用于"一次调用即收口"的对照用例，
 * 避免多候选耗尽把错误升级成 AllEndpointsDownError → paused(circuit_open)。
 */
async function fixtureSingleEndpoint(turn: { chatError?: Error }): Promise<Fixture> {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfgRoot = mkdtempSync(join(tmpdir(), 'dotd-runner-stream-cfg1-'));
  cfgRoots.push(cfgRoot);
  writeFileSync(join(cfgRoot, 'tools.yml'), TOOLS_YML, 'utf8');
  writeFileSync(join(cfgRoot, 'rules.yml'), 'rules: []\n', 'utf8');
  writeFileSync(join(cfgRoot, 'models.yml'), MODELS_YML_ONE, 'utf8');
  writeFileSync(join(cfgRoot, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
  const { catalog } = loadCatalog(join(cfgRoot, 'tools.yml'), join(cfgRoot, 'rules.yml'));

  const rec: Recorder = { chat: [], stream: [] };
  const transport = makeScriptedTransport({ 'cloud-main': [turn] }, rec);
  const router = ModelRouter.load({
    db: tmp.db,
    configDir: cfgRoot,
    scheduler: { registerInternalJob: () => {} },
    channels: null,
    bus: tmp.bus,
    transport,
  });
  const govCp = {
    setAwaitingApproval: (_t: string, _e: number, _a: number): void => {},
    onApprovalSettled: (_t: string, _a: number, _ok: boolean, _m?: { note?: string; revoke?: string }): void => {},
    resumeDotQueue: (_d: string): void => {},
  };
  const govDeps: GovDeps = {
    controlPlane: govCp,
    journal: { stepExists: (_c: string) => true },
    router: { async complete() { return { response: { content: '{"ok":true}' } }; } },
    bus: {
      publish: (topic, payload, o) => tmp.bus.publish(topic, payload, o),
      on: (topic, handler) => tmp.bus.on(topic, handler),
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
    } satisfies GovDefaults,
  };
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
  govCp.setAwaitingApproval = (taskId, epoch, approvalId) => cp.setAwaitingApproval(taskId, epoch, approvalId);
  govCp.onApprovalSettled = (taskId, approvalId, ok, meta) => cp.onApprovalSettled(taskId, approvalId, ok, meta);

  const { bus, events } = makeBusRecorder();
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
    // 不注入 bus → 走 complete()，与流式路径形成对照
    { log: () => {}, streamFlushMs: 0, streamFlushChars: 1 },
  );
  void bus;
  return { tmp, cp, runner, router, rec, events, memory, transport };
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

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

/** 事件进赶 → run_new 规则 → 入队，返回派生任务 id。 */
function ingestAndDecide(cp: ReturnType<typeof createControlPlane>): { eventId: number; taskId: string } {
  const ing = cp.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: { q: '写诗' } });
  void cp.matcher.processEvent(ing.eventId);
  return { eventId: ing.eventId, taskId: `tk_ev_${ing.eventId}` };
}

/** 一轮诗：分 5 段吐，覆盖"多 delta + 标点/换行/多字节"的边界。 */
const POEM_CHUNKS = ['春眠', '不觉晓，', '\n处处', '闻啼鸟。', '\n花落知多少。'];
const POEM = POEM_CHUNKS.join('');

// ── 5. ① 增量顺序 + 与离线聚合逐字相同 ──────────────────────────────────

test('① 流式：delta 顺序正确、拼接 = chat.final = assistant 全文，且与离线聚合逐字相同', async () => {
  const online = await fixture({ script: { 'cloud-main': [{ chunks: POEM_CHUNKS }] } });
  const { taskId } = ingestAndDecide(online.cp);
  await flush();
  const out = await online.runner.runNext();

  assert.equal(out.status, 'done', '流式回合应正常收尾');
  // —— 走的是流式，不是 complete ——
  assert.equal(online.rec.stream.length, 1, 'router.stream 被调用 1 次');
  assert.equal(online.rec.chat.length, 0, '流式路径不得调用 complete()');

  // —— delta 顺序与拼接 ——
  const deltas = deltasOf(online.events);
  assert.deepEqual(deltas, POEM_CHUNKS, 'delta 逐段按到达顺序上总线（≥5 次，未丢未并错）');
  assert.equal(deltas.join(''), POEM, 'delta 拼接 = 原文');

  // —— chat.final 覆盖全文 ——
  const finals = finalsOf(online.events);
  assert.equal(finals.length, 1, '每回合恰好一条 chat.final');
  const final = finals[0]!;
  assert.equal(final.payload['text'], POEM, 'chat.final.text = 全文（前端据此覆盖 delta 行）');
  assert.equal(final.payload['taskId'], taskId, 'chat.final 带 taskId（前端按 taskId 聚合）');
  assert.equal(final.payload['toolCalls'], 0, 'chat.final 带 toolCalls 计数（纯文本轮 = 0）');
  assert.equal(typeof final.payload['threadId'], 'string', 'chat.final 带 threadId（前端按 threadId 过滤）');
  assert.equal(final.payload['kind'], 'chat.final', 'kind 字段与 http.ts:522 同形');

  // delta 帧 payload 形状：{taskId, threadId, callId, delta}
  const d0 = online.events.find((e) => e.topic === 'chat.delta')!;
  assert.equal(d0.payload['taskId'], taskId);
  assert.equal(typeof d0.payload['threadId'], 'string');
  assert.equal(typeof d0.payload['callId'], 'string', 'callId 让前端按 LLM 步区分（attemptId=callId）');
  assert.equal(d0.payload['callId'], String(stepsOf(online.tmp, taskId).find((s) => s['kind'] === 'llm')!['call_id']),
    'delta.callId = journal 的 LLM 步 call_id（契约 J1 同一身份）');
  assert.equal(d0.dotId, 'dot1', 'publish 带 dotId（SSE 按 dotId 过滤）');

  // —— 与 thread 落库的 assistant 全文一致 ——
  const threadId = String(taskOf(online.tmp, taskId)!['thread_id']);
  const assistants = msgsOf(online.tmp, threadId).filter((m) => m['role'] === 'assistant' && m['kind'] === 'text');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]!['content'], POEM, '⑩ assistant 全文入 thread');

  // —— 离线聚合对照：同一份脚本走 complete() ——
  const offline = await fixture({
    script: { 'cloud-main': [{ chunks: POEM_CHUNKS }] },
    omitBus: true,
  });
  const off = ingestAndDecide(offline.cp);
  await flush();
  const offOut = await offline.runner.runNext();
  assert.equal(offOut.status, 'done');
  assert.equal(offline.rec.chat.length, 1, '无总线 → 走 complete()');
  assert.equal(offline.rec.stream.length, 0, '无总线 → 绝不调用 stream()');

  const offThread = String(taskOf(offline.tmp, off.taskId)!['thread_id']);
  const offAssistant = msgsOf(offline.tmp, offThread).filter((m) => m['role'] === 'assistant' && m['kind'] === 'text');
  assert.equal(offAssistant.length, 1);

  // 逐字对比：最终 assistant 消息（流式 vs 离线）
  assert.equal(
    assistants[0]!['content'],
    offAssistant[0]!['content'],
    '流式与离线聚合的 assistant 全文必须逐字相同',
  );
  assert.equal(out.summary, offOut.summary, '任务 summary 也逐字相同');
  assert.equal(String(taskOf(online.tmp, taskId)!['stop_reason']), String(taskOf(offline.tmp, off.taskId)!['stop_reason']));

  online.router.dispose();
  offline.router.dispose();
});

test('①b 长回答：delta 合帧生效（500 段流落成 ≤50 帧），chat.final 仍完整', async () => {
  const many = Array.from({ length: 500 }, (_, i) => `第${i}段;`);
  const full = many.join('');
  const f = await fixture({
    script: { 'cloud-main': [{ chunks: many }] },
    // 用**默认**节流参数（50ms / 32 字），验证真实合帧行为
    runnerOpts: { streamFlushMs: 50, streamFlushChars: 32 },
  });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  const deltas = deltasOf(f.events);
  assert.ok(deltas.length >= 1, '至少下发一次增量');
  // 合帧后帧数由"每帧 ≥32 字"决定：16000 字 → ≤500 帧，而原始 500 段流若逐条直发也是 500 帧，
  // 所以这里断言的是**每帧平均 ≥ 1 段**且总帧数 < 原始段数（证明发生了合并）。
  assert.ok(deltas.length < many.length, `节流：500 段流 → 实际 ${deltas.length} 帧（<500）`);
  assert.ok(
    deltas.every((d) => d.length > 0),
    '不产生空帧',
  );
  assert.equal(deltas.join(''), full, '合帧不丢字、不乱序');
  assert.equal(finalsOf(f.events)[0]!.payload['text'], full, 'chat.final 完整');
  f.router.dispose();
});

// ── 6. ② 失败/降级语义与 complete() 路径逐字一致 ─────────────────────────

/** 跑一个任务，返回可比较的收口事实（两条路径并排断言用）。 */
async function outcomeFacts(
  f: Fixture,
  taskId: string,
  first?: { status: string; summary?: string },
): Promise<{
  status: string;
  summary: string | undefined;
  taskStatus: unknown;
  stopReason: unknown;
  llmStepStatus: unknown;
  llmStepResult: unknown;
  assistantContents: string[];
}> {
  const out = first ?? (await f.runner.runNext());
  const llmSteps = stepsOf(f.tmp, taskId).filter((s) => s['kind'] === 'llm');
  const threadId = String(taskOf(f.tmp, taskId)!['thread_id'] ?? '');
  return {
    status: out.status,
    summary: (out as { summary?: string }).summary,
    taskStatus: taskOf(f.tmp, taskId)!['status'],
    stopReason: taskOf(f.tmp, taskId)!['stop_reason'],
    llmStepStatus: llmSteps[0]?.['status'] ?? null,
    llmStepResult: llmSteps[0]?.['result_json'] ?? null,
    assistantContents: threadId === ''
      ? []
      : msgsOf(f.tmp, threadId)
          .filter((m) => m['role'] === 'assistant' && m['kind'] === 'text')
          .map((m) => String(m['content'])),
  };
}



test('② 首字节前全候选耗尽：流式与 complete() 的收口逐字一致（paused + circuit_open）', async () => {
  const brokenDown = (): Record<string, Turn[]> => ({
    'cloud-main': [{ chatError: new AllEndpointsDownError(['cloud-main#primary'], false), streamFailAfter: 0 }],
    'local-llm': [{ chatError: new AllEndpointsDownError(['local-llm#primary'], false), streamFailAfter: 0 }],
  });
  const online = await fixture({ script: brokenDown() });
  const offline = await fixture({ script: brokenDown(), omitBus: true });
  const on = ingestAndDecide(online.cp);
  const off = ingestAndDecide(offline.cp);
  await flush();

  const a = await outcomeFacts(online, on.taskId);
  const b = await outcomeFacts(offline, off.taskId);

  // 路径确实不同（否则这条对照没有意义）
  assert.equal(online.rec.stream.length, 2, '流式路径逐候选试过（cloud-main → local-llm）');
  assert.equal(online.rec.chat.length, 0, '流式路径没有回退到 complete()');
  assert.equal(offline.rec.chat.length, 2, '离线路径逐候选试过');
  assert.equal(offline.rec.stream.length, 0);

  // 收口事实逐字段相同
  assert.equal(a.status, 'paused');
  assert.equal(a.taskStatus, 'paused');
  assert.equal(a.stopReason, 'circuit_open', '熔断耗尽 → pauseByReason(circuit_open)');
  assert.deepEqual(a.status, b.status);
  assert.equal(a.taskStatus, b.taskStatus);
  assert.equal(a.stopReason, b.stopReason);
  assert.equal(a.llmStepStatus, b.llmStepStatus, 'journal 的 LLM 步状态一致');
  assert.deepEqual(a.assistantContents, b.assistantContents, '不落任何 assistant 正文');

  // 零增量：首字节前失败不该往前端吐任何东西
  assert.deepEqual(deltasOf(online.events), [], '首字节前失败 → 无 chat.delta');
  assert.deepEqual(finalsOf(online.events), [], '失败回合 → 无 chat.final');

  online.router.dispose();
  offline.router.dispose();
});

test('② 首字节前首候选失败：降级到下一候选（等价非流式换端点），meta.tried 记账不绕过', async () => {
  const online = await fixture({
    script: {
      'cloud-main': [{ streamFailAfter: 0 }],
      'local-llm': [{ chunks: ['本地', '回答'] }],
    },
  });
  const { taskId } = ingestAndDecide(online.cp);
  await flush();
  const out = await online.runner.runNext();
  assert.equal(out.status, 'done', '首字节前失败 → 换候选后成功，不是硬失败');
  assert.equal(online.rec.stream.length, 2, '两个候选都被试过');
  assert.equal(online.rec.chat.length, 0, '全程走流式，不混用 complete()');
  assert.equal(online.rec.stream[1]!.endpoint.id, 'local-llm', '第二个候选是 tier2 本地端点');
  assert.equal(out.summary, '本地回答');

  // 首字节前失败已入 breaker 窗口（记账由 ModelRouter 完成，Runner 没有绕过它）
  const samples = online.tmp.db
    .prepare(`SELECT ok, kind FROM breaker_sample WHERE endpoint_id='cloud-main'`)
    .all() as Array<Record<string, unknown>>;
  assert.ok(samples.length >= 1, 'cloud-main 的失败样本已入窗（tried/breaker 记账未被绕过）');
  // 降级痕迹在 model_call_log 里可查
  const log = online.tmp.db
    .prepare(`SELECT endpoint_id, outcome, kind FROM model_call_log ORDER BY id`)
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    log.map((r) => `${r.endpoint_id}:${r.outcome}`),
    ['cloud-main:fail', 'local-llm:ok'],
    `meta.tried 同源的调用日志：${JSON.stringify(log)}`,
  );
  online.router.dispose();
});

test('② 首字节后断流：clean abort → 计入一条可恢复错误（failed，同 complete 的模型错误分支）', async () => {
  const online = await fixture({
    script: {
      // 注意 fake 语义：`streamFailAfter: N` = **yield 第 N 个 chunk 之前**抛错，
      // 所以这里吐 1 段后断（首字节后断流，而非首字节前失败）。
      'cloud-main': [{ chunks: ['半句', '就断'], streamFailAfter: 1 }],
      // 若路由错误重放，这条会被消费
      'local-llm': [{ chunks: ['不该出现'] }],
    },
  });
  const { taskId } = ingestAndDecide(online.cp);
  await flush();
  // 失败收口 → attempt<max → 回 queued 且带退避（run_at=now+backoff），所以本轮之后
  // pop 会返回 null（还不到重试时间）。这里断言的是**这一次收口**的形态：
  // "可恢复"体现为 status=queued（而不是 failed/paused），attempt 已计入。
  const first = await online.runner.runNext();
  const after = await online.runner.runNext();
  assert.equal(after.status, 'none', '重试有退避，本轮不会立刻重跑（事务边界正确）');

  // 不重放：只有一次 stream 调用，没有第二个端点
  assert.equal(online.rec.stream.length, 1, '首字节后断流绝不自动换端点重放');
  assert.equal(online.rec.stream[0]!.endpoint.id, 'cloud-main');

  // 可恢复错误：返回 failed（对应一次尝试失败），任务回 queued 等重试；不是 paused、不是 done
  const task = taskOf(online.tmp, taskId)!;
  assert.equal(first.status, 'failed', '断流 = 失败收口，不得把半句当成功');
  assert.equal(task['status'], 'queued', '可恢复：任务回队列等重试（不是终态 failed/paused）');
  // 回 queued 时 Queue 会清 stop_reason（等待下一次尝试，不是终态原因）
  assert.equal(task['stop_reason'], null, '重试中不写终态 stop_reason');
  assert.ok(Number(task['attempt']) >= 1, `计入 attempt：${String(task['attempt'])}`);
  assert.match(String(first.summary), /模型调用失败/, 'summary 走统一的"模型调用失败：…"口径');
  assert.match(String(first.summary), /STREAM_INTERRUPTED/, 'errText 带机读码（DotdError.code）');

  // journal：LLM 步的**失败以 payload 前缀 `error:` 表达**，不是 status
  // （CP journal.endLlm 无条件写 status='succeeded'，见 src/control-plane/journal.ts:168-180;
  //  这是既有约定，两条路径（complete/stream）完全一致，本用例不改动它）。
  const llmSteps = stepsOf(online.tmp, taskId).filter((s) => s['kind'] === 'llm');
  assert.equal(llmSteps.length, 1);
  assert.match(String(llmSteps[0]!['result_json']), /^error:/, 'endLlm 记 error:<原因>');
  assert.match(
    String(llmSteps[0]!['result_json']),
    /STREAM_INTERRUPTED/,
    'journal 里能看出断流原因（errText 带机读码）',
  );

  // 已吐出的增量上了总线（前端可回显），但没有 chat.final（回合未成功收尾）
  assert.deepEqual(deltasOf(online.events).join(''), '半句', '已交付的增量不丢');
  assert.deepEqual(finalsOf(online.events), [], '失败回合不推 chat.final');

  // 与「complete() 路径的失败收口」对读（本仓库的既有语义，实测确认）：
  //
  // complete() 把**所有**异常都算候选失败 —— 走完候选就抛 AllEndpointsDownError，
  // Runner 收成 paused(circuit_open)。所以 complete 路径**产不出** failed 型收口
  // （实测：单端点 bad_protocol 也是 paused）。
  // 而流式首字节后断流是 §4.7 明令「绝不重放」→ 只失败一次、不耗候选 → 落到 stepLlm
  // 的"其余模型错误"分支，收成 failed（可恢复，回队列重试）。
  // 两条路径因此**必然不同**，而这正是对的：不重放就不该升级成"全端点都挂了"。
  const offline = await fixtureSingleEndpoint({ chatError: makeBadProtocol('上游回了非 JSON') });
  const off = ingestAndDecide(offline.cp);
  await flush();
  const offFirst = await offline.runner.runNext();
  const b = await outcomeFacts(offline, off.taskId, offFirst);
  const offLlmSteps = stepsOf(offline.tmp, off.taskId).filter((s) => s['kind'] === 'llm');
  assert.equal(offline.rec.chat.length, 1, 'complete 路径：单端点一次调用');
  assert.equal(b.status, 'paused', 'complete 的失败会耗尽候选 → paused（既有语义，未改）');
  assert.equal(b.stopReason, 'circuit_open');
  // 断流侧：可恢复的 failed，**不**升级成熔断暂停
  assert.equal(first.status, 'failed');
  assert.equal(task['status'], 'queued', '断流后可恢复：回队列等 retry');
  assert.notEqual(task['stop_reason'], 'circuit_open', '断流不得把任务打成熔断暂停');
  // 记法差异（如实）：断流走 endLlm 记 'error:…'；耗尽分支不记 endLlm，步停在 started。
  // 耗尽分支**不调 endLlm**（步停在 started，由看门狗/恢复收口）——这与断流分支不同，
  assert.match(String(llmSteps[0]!['result_json']), /^error:/, 'stream 路径同样以 error: 记');
  offline.router.dispose();
});

// ── 7. ③ 无 stream 能力 / 开关关闭 / 未注入总线 → complete() 被调用 ─────────

test('③ 没有 stream 方法 → complete() 路径被调用（spy 断言，且 stream 一次都不调）', async () => {
  const f = await fixture({ script: { 'cloud-main': [{ chunks: POEM_CHUNKS }] }, omitBus: true });
  // 老装配形态：router 只有 complete()（没有 stream 方法），但总线与开关都在场
  const withoutStream = {
    complete: (req: RouteRequest): Promise<RouteResult> => f.router.complete(req),
  };
  const runner = new DotRunner(
    {
      cp: (f.runner as unknown as { cp: ControlPlane }).cp,
      router: withoutStream as unknown as ConstructorParameters<typeof DotRunner>[0]['router'],
      exec: (f.runner as unknown as { exec: ConstructorParameters<typeof DotRunner>[0]['exec'] }).exec,
      memory: (f.runner as unknown as { memory: ConstructorParameters<typeof DotRunner>[0]['memory'] }).memory,
      governance: (f.runner as unknown as { governance: ConstructorParameters<typeof DotRunner>[0]['governance'] })
        .governance,
    },
    { log: () => {}, bus: makeBusRecorder().bus, streamChat: true, streamFlushMs: 0, streamFlushChars: 1 },
  );
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(f.rec.chat.length, 1, 'complete() 被调用一次（spy 记账）');
  assert.equal(f.rec.stream.length, 0, '没有 stream 能力时一次也不碰 stream()');
  assert.equal(out.summary, POEM, '结果与流式聚合相同');
  void taskId;
  f.router.dispose();
});
test('③ 开关 DOTD_STREAM_CHAT=off → 即使总线与 stream 都在也走 complete()（回退开关）', async () => {
  const prev = process.env.DOTD_STREAM_CHAT;
  process.env.DOTD_STREAM_CHAT = 'off';
  try {
    const f = await fixture({ script: { 'cloud-main': [{ chunks: POEM_CHUNKS }] }, omitBus: true });
    // 总线在场 + env 关闭：RunnerOptions 不传 streamChat，交给 env 决定
    const withBus = new DotRunner(
      runnerDepsOf(f),
      { log: () => {}, bus: makeBusRecorder().bus, streamFlushMs: 0, streamFlushChars: 1 },
    );
    const t1 = ingestAndDecide(f.cp);
    await flush();
    const out = await withBus.runNext();
    assert.equal(out.status, 'done');
    assert.equal(f.rec.chat.length, 1, 'env=off → 走 complete()');
    assert.equal(f.rec.stream.length, 0, 'env=off → 不调用 stream()');
    void t1;
  } finally {
    if (prev === undefined) delete process.env.DOTD_STREAM_CHAT;
    else process.env.DOTD_STREAM_CHAT = prev;
  }
});

test('③ 未注入总线（旧装配）→ 逐字走 complete()，不发布任何 chat.*', async () => {
  const f = await fixture({ script: { 'cloud-main': [{ chunks: POEM_CHUNKS }] }, omitBus: true });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  assert.equal(f.rec.chat.length, 1);
  assert.equal(f.rec.stream.length, 0);
  assert.deepEqual(f.events, [], '无总线 → 零 chat.* 事件');
  // 行为与基线一致：assistant 全文照旧入 thread
  const threadId = String(taskOf(f.tmp, taskId)!['thread_id']);
  const assistants = msgsOf(f.tmp, threadId).filter((m) => m['role'] === 'assistant' && m['kind'] === 'text');
  assert.equal(assistants[0]!['content'], POEM);
  f.router.dispose();
});

/** 把一个 fixture 的依赖面原样搬给另一个 Runner（③ 的开关注入用）。 */
function runnerDepsOf(f: Fixture): ConstructorParameters<typeof DotRunner>[0] {
  const r = f.runner as unknown as { cp: unknown; router: unknown; exec: unknown; memory: unknown; governance: unknown };
  return {
    cp: r.cp as ControlPlane,
    router: r.router as ConstructorParameters<typeof DotRunner>[0]['router'],
    exec: r.exec as ConstructorParameters<typeof DotRunner>[0]['exec'],
    memory: r.memory as ConstructorParameters<typeof DotRunner>[0]['memory'],
    governance: r.governance as ConstructorParameters<typeof DotRunner>[0]['governance'],
  };
}

// ── 8. ④ 工具调用回合：完整回合聚合后才派发，配对正确 ────────────────────

test('④ 防假完成（最重要）：流式回合里模型返回 tool_calls → 工具确实被执行，任务不提前 done', async () => {
  // 这条钉的是 roadmap P0-2 最危险的坑：流式通道原先没有工具调用通道，
  // 若把"流式回合"当成纯文本完结轮，模型要调工具时任务会 done 而工具从未执行
  // （静默假完成）。现在 ChatChunk.toolCalls（增量）→ 聚合器 → stream.toolCalls()（成品）
  // 已打通，下面逐条断言"工具真的跑了"。
  const executed: string[] = [];
  const f = await fixture({
    script: {
      'cloud-main': [
        // 第 1 轮（流式）：模型先说话，再要调 fs.list —— 工具调用经增量下发
        {
          chunks: ['我先看一下目录。'],
          toolCalls: [{ id: 'call_live', name: 'fs.list', arguments: '{"path":"/dot/home"}' }],
        },
        // 第 2 轮（流式）：收尾
        { chunks: ['目录已看完，任务完成。'] },
      ],
    },
    tools: {
      'fs.list': (call) => {
        executed.push(call.call_id);
        return {
          call_id: call.call_id,
          status: 'ok',
          result: { entries: [{ name: 'MEMORY.md' }] },
          usage: { wall_ms: 1, peak_mem_mb: 1 },
          finished_at: new Date().toISOString(),
        };
      },
    },
  });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();

  // ① 走了流式（不是退回 complete）
  assert.equal(f.rec.stream.length, 2, '两轮都走 router.stream（含工具轮）');
  assert.equal(f.rec.chat.length, 0, '全程未回退 complete()');

  // ② 工具**确实被执行**（防假完成的硬证据，不只是"任务 done"）
  assert.equal(executed.length, 1, '工具被执行恰好一次');
  const toolSteps = stepsOf(f.tmp, taskId).filter((s) => s['kind'] === 'tool');
  assert.equal(toolSteps.length, 1, '工具步落 journal');
  assert.equal(toolSteps[0]!['tool_name'], 'fs.list');
  assert.equal(toolSteps[0]!['status'], 'succeeded');
  assert.equal(executed[0], String(toolSteps[0]!['call_id']), '派发用的 call_id 与 journal 一致');
  assert.ok(
    String(toolSteps[0]!['result_json']).includes('MEMORY.md'),
    '工具结果真的拿到了（不是空跑）',
  );

  // ③ 工具在**流结束之后**才派发：第 2 轮请求里已经带着工具结果
  assert.equal(f.rec.stream.length, 2, '工具派发后才发起第二轮');
  const secondReq = f.rec.stream[1]!;
  const toolMsgs = secondReq.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1, '工具结果以 role=tool 回喂第二轮');
  assert.equal(toolMsgs[0]!.tool_call_id, String(toolSteps[0]!['call_id']), 'tool_call_id 严格配对');
  assert.ok(String(toolMsgs[0]!.content).includes('MEMORY.md'), '回喂的是工具真实输出');
  const assistantWithCalls = secondReq.messages.find(
    (m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls !== undefined,
  ) as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } | undefined;
  assert.ok(assistantWithCalls !== undefined, 'assistant.tool_calls 声明在请求里');
  assert.equal(assistantWithCalls.tool_calls![0]!.id, String(toolSteps[0]!['call_id']), '声明与结果 call_id 配对');
  assert.equal(assistantWithCalls.tool_calls![0]!.function.name, 'fs.list', '工具名正确');
  assert.equal(
    assistantWithCalls.tool_calls![0]!.function.arguments,
    '{"path":"/dot/home"}',
    '参数 JSON 由增量分片拼回原文（逐字）',
  );

  // ④ 任务没有提前 done：经过两次 LLM 步才收口，且 summary 是**第二轮**的收尾语
  const llmSteps = stepsOf(f.tmp, taskId).filter((s) => s['kind'] === 'llm');
  assert.equal(llmSteps.length, 2, '两个 LLM 步（工具轮 + 收尾轮）');
  assert.equal(out.status, 'done');
  assert.equal(out.summary, '目录已看完，任务完成。', '收口用的是收尾轮，不是工具轮');
  assert.notEqual(out.summary, '我先看一下目录。', '绝不能用工具轮的正文当答案收尾');

  // ⑤ 工具轮的正文照样流给前端；chat.final 只由**收尾轮**发出
  //    （与 reportAssistant 同口径：带 tool_calls 的轮次不入 thread、也不推 final，
  //     否则前端会把"我这就去看"当成答案定稿）。
  assert.deepEqual(deltasOf(f.events).slice(0, 1), ['我先看一下目录。'], '工具轮正文增量先到');
  const finals = finalsOf(f.events);
  assert.equal(finals.length, 1, '只有收尾轮推 chat.final（工具轮不裁定稿）');
  assert.equal(finals[0]!.payload['text'], '目录已看完，任务完成。');
  // 定稿一定排在所有 delta 之后
  const lastDeltaSeq = Math.max(...f.events.filter((e) => e.topic === 'chat.delta').map((e) => e.seq));
  assert.ok(finals[0]!.seq > lastDeltaSeq, 'chat.final 排在全部 delta 之后（前端靠它覆盖）');

  f.router.dispose();
});

test('④b 流式回合只有工具调用、没有正文 → 也绝不当成完结轮（空正文兜底）', async () => {
  // 无正文的纯工具轮是最容易被误判成"完结"的形状：delta 全程为空。
  const f = await fixture({
    script: {
      'cloud-main': [
        { chunks: [], toolCalls: [{ id: 'call_only', name: 'fs.list', arguments: '{"path":"/dot/home"}' }] },
        { chunks: ['看完了。'] },
      ],
    },
    tools: {
      'fs.list': (call) => ({
        call_id: call.call_id,
        status: 'ok',
        result: { entries: [] },
        usage: { wall_ms: 1, peak_mem_mb: 1 },
        finished_at: new Date().toISOString(),
      }),
    },
  });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  const toolSteps = stepsOf(f.tmp, taskId).filter((s) => s['kind'] === 'tool');
  assert.equal(toolSteps.length, 1, '纯工具轮同样派发了工具');
  assert.equal(out.summary, '看完了。', '收口来自第二轮');
  assert.equal(f.rec.stream.length, 2);
  f.router.dispose();
});
// ── 9. 零行为回退：无总线时 journal / 请求体 / attemptId 记账与基线一致 ─────

test('零行为回退：无总线时单次 complete、journal 一步、attemptId 记账不变', async () => {
  const f = await fixture({ script: { 'cloud-main': [{ chunks: ['答案。'] }] }, omitBus: true });
  const { taskId } = ingestAndDecide(f.cp);
  await flush();
  const out = await f.runner.runNext();
  assert.equal(out.status, 'done');
  const llmSteps = stepsOf(f.tmp, taskId).filter((s) => s['kind'] === 'llm');
  assert.equal(llmSteps.length, 1, '一轮对话 = 一个 LLM 步');
  assert.equal(f.rec.chat.length, 1, '恰好一次 complete()');
  assert.equal(f.rec.chat[0]!.track, 'primary', '主循环走 primary 轨');
  // 契约 J1 的 attemptId 落在 model_call_log（Router 的手册义务：随每个候选记一行），
  // **不**透传给 transport —— 这一点 complete() 与 stream() 两条路径相同（见同目录诊断）。
  const logged = f.tmp.db
    .prepare('SELECT attempt_id FROM model_call_log ORDER BY id')
    .all() as Array<Record<string, unknown>>;
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!['attempt_id'], String(llmSteps[0]!['call_id']), '契约 J1：attemptId = journal 步 callId');

  // 流式路径同样把 attemptId 记进 model_call_log（账本语义不因走流式而改变）
  const s = await fixture({ script: { 'cloud-main': [{ chunks: ['答案。'] }] } });
  const sTask = ingestAndDecide(s.cp);
  await flush();
  await s.runner.runNext();
  const sSteps = stepsOf(s.tmp, sTask.taskId).filter((x) => x['kind'] === 'llm');
  const sLogged = s.tmp.db
    .prepare('SELECT attempt_id FROM model_call_log ORDER BY id')
    .all() as Array<Record<string, unknown>>;
  assert.equal(sLogged.length, 1);
  assert.equal(sLogged[0]!['attempt_id'], String(sSteps[0]!['call_id']), '流式路径 attemptId 也 = callId');
  f.router.dispose();
  s.router.dispose();
});
