/**
 * tests/surfaces-observability.test.ts —— P1-6 可观测性：`dotd task --verbose` / `dotd logs`。
 *
 * 这条任务是"把承诺变成可执行断言"的典型：
 * - README 里说 `dotd task <id>` 能看任务、`dotd logs` 能看拒绝审计，
 *   但两处路由（`/api/tasks/:id`、`/api/logs`）此前**根本不存在**，CLI 只能凑近似值；
 * - 主人真正要的三个答案（花了多少 / 卡在哪 / 每一步多久）没有任何视图。
 *
 * 本文件分两层验：
 * 1. **纯投影**（`src/surfaces/task-view.ts`）：给三份事实，逐字段断言成本/耗时/瓶颈口径；
 * 2. **真 HTTP 路由**：起真 server，打 `/api/tasks/:id?verbose=1` 与 `/api/logs`；
 * 3. **CLI 端到端**：用真 CLI + 假 fetch，断言输出是"人话"且回答那三个问题。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { buildTaskView, humanMs, renderTaskView, summarizeStepError } from '../src/surfaces/task-view.ts';
import type { Step, Task } from '../src/shared/contracts.ts';
import { createHttpServer, matchRoute } from '../src/surfaces/http.ts';
import { buildCli, type CliOptions } from '../src/surfaces/cli.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import type { ControlPlane, GovernancePort, MemoryPort, RouterPort } from '../src/shared/contracts.ts';

// ── 事实构造器 ──────────────────────────────────────────────────────

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'tk_obs',
    dotId: 'dot1',
    title: '整理季度会议纪要',
    goal: 'g',
    priority: 1,
    status: 'done',
    attempt: 1,
    runEpoch: 1,
    createdAt: 1_000,
    updatedAt: 9_000,
    ...over,
  } as Task;
}

function mkStep(over: Partial<Step> & { seq: number }): Step {
  return {
    taskId: 'tk_obs',
    kind: 'tool',
    status: 'succeeded',
    callId: null,
    toolName: null,
    argsJson: null,
    resultJson: null,
    sideEffect: null,
    runEpoch: 1,
    approvalId: null,
    startedAt: 0,
    finishedAt: null,
    ...over,
  } as Step;
}

// ═══════════════════════════════════════════════════════════════════
// 一、纯投影：三个问题的口径
// ═══════════════════════════════════════════════════════════════════

describe('buildTaskView：花了多少 / 每一步多久 / 卡在哪', () => {
  test('① 花了多少：token 落到 model_call_log 现成字段，时间按 llm/tool 分别累计', () => {
    const steps = [
      mkStep({ seq: 1, kind: 'llm', callId: 'call_1', startedAt: 1_000, finishedAt: 4_000 }), // 3s
      mkStep({ seq: 2, kind: 'tool', toolName: 'fs.read', startedAt: 4_100, finishedAt: 4_600 }), // 0.5s
      mkStep({ seq: 3, kind: 'llm', callId: 'call_2', startedAt: 5_000, finishedAt: 7_000 }), // 2s
    ];
    const callLogs = [
      { attemptId: 'call_1', outcome: 'ok', latencyMs: 2_900, promptTokens: 100, completionTokens: 20, endpointId: 'ep-a', model: 'm', degraded: 0 },
      { attemptId: 'call_2', outcome: 'ok', latencyMs: 1_900, promptTokens: 140, completionTokens: 30, endpointId: 'ep-b', model: 'm', degraded: 1 },
    ];
    const v = buildTaskView({ task: mkTask(), steps, callLogs, now: 10_000 });

    assert.equal(v.cost.llmMs, 5_000, '两次 LLM 步 3s + 2s');
    assert.equal(v.cost.toolMs, 500, '一次工具步 0.5s');
    assert.equal(v.cost.wallMs, 6_000, '第一步开始(1000) → 最后一步结束(7000)');
    assert.equal(v.cost.promptTokens, 240);
    assert.equal(v.cost.completionTokens, 50);
    assert.equal(v.cost.totalTokens, 290);
    assert.equal(v.cost.modelCalls, 2);
    assert.equal(v.cost.degradedCalls, 1, '有一条 degraded=1');
    assert.deepEqual(v.cost.endpoints.sort(), ['ep-a', 'ep-b']);
  });

  test('② 每一步多久：按 seq 升序，在途步算到 now 并标记 durationOngoing', () => {
    const steps = [
      mkStep({ seq: 2, kind: 'tool', toolName: 'shell.run', startedAt: 2_000, finishedAt: 5_000 }),
      mkStep({ seq: 1, kind: 'llm', callId: 'c1', startedAt: 1_000, finishedAt: 2_000 }),
      mkStep({ seq: 3, kind: 'tool', toolName: 'net.get', status: 'started', startedAt: 6_000, finishedAt: null }),
    ];
    const v = buildTaskView({ task: mkTask({ status: 'running' }), steps, callLogs: [], now: 9_000 });
    assert.deepEqual(v.steps.map((s) => s.seq), [1, 2, 3], '必须按 seq 升序（输入是乱序）');
    assert.equal(v.steps[0]!.durationMs, 1_000);
    assert.equal(v.steps[1]!.durationMs, 3_000);
    assert.equal(v.steps[2]!.durationMs, 3_000, '在途步 = now - startedAt');
    assert.equal(v.steps[2]!.durationOngoing, true);
    assert.equal(v.steps[0]!.durationOngoing, false);
  });

  test('③ 卡在哪：优先报仍未结束的步（这是"现在还卡着"的直接答案）', () => {
    const steps = [
      mkStep({ seq: 1, kind: 'llm', callId: 'c1', startedAt: 1_000, finishedAt: 2_000 }),
      mkStep({ seq: 2, kind: 'tool', toolName: 'browser.act', status: 'started', startedAt: 2_100, finishedAt: null }),
      mkStep({ seq: 3, kind: 'tool', toolName: 'fs.read', status: 'failed', startedAt: 2_500, finishedAt: 2_600, resultJson: JSON.stringify({ error: { code: 'path_outside_home', message: '越界' } }) }),
    ];
    const v = buildTaskView({ task: mkTask({ status: 'running' }), steps, callLogs: [], now: 12_000 });
    assert.equal(v.bottleneck.open.length, 1);
    assert.equal(v.bottleneck.open[0]!.toolName, 'browser.act');
    assert.equal(v.bottleneck.open[0]!.durationMs, 9_900);
    assert.equal(v.bottleneck.failed.length, 1);
    assert.equal(v.bottleneck.failed[0]!.error, 'path_outside_home: 越界');
    // 最慢一步 = 那个在途的 browser.act
    assert.equal(v.bottleneck.slowest!.seq, 2);

    const text = renderTaskView(v);
    assert.match(text, /卡在哪：第 2 步.*browser\.act.*仍在进行/);
  });

  test('全部完成时：报最慢一步，不误报"卡住"', () => {
    const steps = [
      mkStep({ seq: 1, kind: 'llm', callId: 'c1', startedAt: 1_000, finishedAt: 2_000 }),
      mkStep({ seq: 2, kind: 'tool', toolName: 'shell.run', startedAt: 2_000, finishedAt: 9_000 }),
    ];
    const v = buildTaskView({ task: mkTask(), steps, callLogs: [], now: 20_000 });
    assert.equal(v.bottleneck.open.length, 0);
    assert.equal(v.bottleneck.slowest!.seq, 2);
    const text = renderTaskView(v);
    assert.match(text, /最慢一步：第 2 步.*shell\.run.*7\.0s/);
    assert.doesNotMatch(text, /仍在进行/);
  });

  test('空任务（刚入队）不崩，给出可理解的话', () => {
    const v = buildTaskView({ task: mkTask({ status: 'queued' }), steps: [], callLogs: [], now: 5_000 });
    assert.equal(v.cost.totalTokens, 0);
    assert.equal(v.bottleneck.slowest, null);
    assert.match(renderTaskView(v), /还没有任何步骤记录/);
  });

  test('纯函数：不读时钟、不读库（同样输入两次结果一致）', () => {
    const steps = [mkStep({ seq: 1, kind: 'llm', callId: 'c1', startedAt: 1_000, finishedAt: 2_000 })];
    const a = buildTaskView({ task: mkTask(), steps, callLogs: [], now: 3_000 });
    const b = buildTaskView({ task: mkTask(), steps, callLogs: [], now: 3_000 });
    assert.deepEqual(a, b);
  });

  test('summarizeStepError：只抽 code+message，不把整段 result_json 塞进视图', () => {
    assert.equal(summarizeStepError(null), null);
    assert.equal(summarizeStepError('{}'), null);
    assert.equal(summarizeStepError('not json'), null);
    assert.equal(
      summarizeStepError(JSON.stringify({ error: { code: 'too_large', message: 'body 超过 4MB' } })),
      'too_large: body 超过 4MB',
    );
    assert.equal(summarizeStepError(JSON.stringify({ error: { code: 'net_timeout' } })), 'net_timeout');
  });

  test('humanMs 口径', () => {
    assert.equal(humanMs(45), '45ms');
    assert.equal(humanMs(1_500), '1.5s');
    assert.equal(humanMs(184_000), '3m04s');
    assert.equal(humanMs(-1), '—');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 二、路由表：两条"待补"路由真的存在了
// ═══════════════════════════════════════════════════════════════════

describe('路由表：/api/tasks/:id 与 /api/logs 已补齐', () => {
  test('matchRoute 认识两条新路由（此前返回 null = 404）', () => {
    assert.deepEqual(matchRoute('GET', '/api/tasks/tk_abc'), { route: 'task_by_id', params: { id: 'tk_abc' } });
    assert.deepEqual(matchRoute('GET', '/api/logs'), { route: 'logs', params: {} });
    // 带尾斜杠也要认
    assert.deepEqual(matchRoute('GET', '/api/tasks/tk_abc/'), { route: 'task_by_id', params: { id: 'tk_abc' } });
  });

  test('只接受 GET（POST 不误路由）', () => {
    assert.equal(matchRoute('POST', '/api/tasks/tk_abc'), null);
    assert.equal(matchRoute('POST', '/api/logs'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 三、真 HTTP：起 server 打两条路由
// ═══════════════════════════════════════════════════════════════════

function makeConfig(): SurfacesConfig {
  return {
    http: { host: '127.0.0.1', port: 0, masterToken: 'm', readonlyTokens: [], allowedOrigins: [] },
    hooks: [],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
    ui: { streamDeltas: true },
  };
}

interface Harness {
  dir: TempDataDir;
  server: Server;
  base: string;
}

const TASK = mkTask({ id: 'tk_http', title: 'HTTP 任务', status: 'done' });
const STEPS: Step[] = [
  mkStep({ taskId: 'tk_http', seq: 1, kind: 'llm', callId: 'call_h1', startedAt: 1_000, finishedAt: 4_000 }),
  mkStep({ taskId: 'tk_http', seq: 2, kind: 'tool', toolName: 'fs.write', startedAt: 4_000, finishedAt: 4_200 }),
];

async function startHarness(): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = dir.bus;
  const sse = new SseBus({ db: dir.db, bus });
  sse.attach();
  const cp = {
    getTask: (id: string) => (id === 'tk_http' ? TASK : null),
    getJournal: (id: string) => (id === 'tk_http' ? STEPS : []),
    list: () => [],
    snapshot: () => ({}),
    submit: () => TASK,
    cancel: () => undefined,
    resume: () => undefined,
    getGuardStatus: () => ({}),
  } as unknown as ControlPlane;
  const gov: GovernancePort = { decide: () => Promise.resolve({ ok: true }), listPending: () => [], getApproval: () => Promise.resolve(null) };
  const mem: MemoryPort = {
    openThread: () => Promise.resolve('th'),
    appendMessage: () => Promise.resolve({ id: 'm', seq: 1 }),
    listThreads: () => Promise.resolve([]),
    listMessages: () => Promise.resolve([]),
  };
  const router: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };
  // 成本口径的证据：往 model_call_log 写一行，attempt_id = 步 call_id（契约 J1）
  dir.db
    .prepare(
      `INSERT INTO model_call_log (attempt_id, attempt_seq, track, endpoint_id, model, degraded, outcome, latency_ms, prompt_tokens, completion_tokens, ts)
       VALUES ('call_h1', 1, 'primary', 'ep-x', 'model-x', 0, 'ok', 2900, 120, 40, 2000)`,
    )
    .run();
  // 拒绝审计的证据
  dir.db
    .prepare(`INSERT INTO surf_ingress_rejects (at, source, actor, reason, detail) VALUES (?, ?, ?, ?, ?)`)
    .run('2026-10-18T01:00:00.000Z', 'grafana', 'ops', 'auth', 'HMAC 签名不匹配');
  dir.db
    .prepare(`INSERT INTO surf_ingress_rejects (at, source, actor, reason, detail) VALUES (?, ?, ?, ?, ?)`)
    .run('2026-10-18T01:05:00.000Z', 'telegram', null, 'rate', null);

  const server = createHttpServer({
    db: dir.db,
    bus,
    cp,
    gov,
    mem,
    router,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}` };
}

/** §5.2：这些端点要 Bearer master token（只有 /api/stream 允许 ?token=）。 */
async function getJson(h: Harness, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.base}${path}`, { headers: { authorization: 'Bearer m' } });
  return { status: res.status, body: await res.json() };
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  h.dir.cleanup();
}

describe('真 HTTP：GET /api/tasks/:id 与 /api/logs', () => {
  test('GET /api/tasks/:id 返回任务 + 步骤（无 verbose 时不含成本视图）', async () => {
    const h = await startHarness();
    try {
      const r = (await getJson(h, `/api/tasks/tk_http`)) as {
        status: number;
        body: { task: { id: string }; steps: unknown[]; view?: unknown };
      };
      assert.equal(r.status, 200);
      assert.equal(r.body.task.id, 'tk_http');
      assert.equal(r.body.steps.length, 2);
      assert.equal(r.body.view, undefined, '非 verbose 不返回成本视图（省带宽）');
    } finally {
      await stopHarness(h);
    }
  });

  test('GET /api/tasks/:id?verbose=1 返回完整成本/耗时/瓶颈', async () => {
    const h = await startHarness();
    try {
      const r = (await getJson(h, `/api/tasks/tk_http?verbose=1`)) as {
        status: number;
        body: {
          view: {
            cost: { promptTokens: number; completionTokens: number; llmMs: number; toolMs: number; endpoints: string[] };
            steps: Array<{ durationMs: number; model: { promptTokens: number } | null }>;
            bottleneck: { slowest: { seq: number } | null };
          };
        };
      };
      assert.equal(r.status, 200);
      const view = r.body.view;
      assert.equal(view.cost.promptTokens, 120, 'token 取自 model_call_log 现成字段');
      assert.equal(view.cost.completionTokens, 40);
      assert.equal(view.cost.llmMs, 3_000);
      assert.equal(view.cost.toolMs, 200);
      assert.deepEqual(view.cost.endpoints, ['ep-x']);
      assert.equal(view.steps[0]!.model!.promptTokens, 120, 'llm 步按 call_id=attempt_id 关联到调用日志');
      assert.equal(view.bottleneck.slowest!.seq, 1);
    } finally {
      await stopHarness(h);
    }
  });

  test('GET /api/tasks/不存在 → 404 not_found（带可操作提示字段）', async () => {
    const h = await startHarness();
    try {
      const r = (await getJson(h, `/api/tasks/tk_nope`)) as {
        status: number;
        body: { error: string; taskId: string; message: string };
      };
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'not_found');
      assert.equal(r.body.taskId, 'tk_nope');
      assert.match(r.body.message, /不存在/);
    } finally {
      await stopHarness(h);
    }
  });

  test('GET /api/logs 返回拒绝审计（最近的在前）', async () => {
    const h = await startHarness();
    try {
      const r = (await getJson(h, `/api/logs?limit=10`)) as {
        status: number;
        body: { rejects: Array<{ source: string; reason: string; actor: string | null }>; limit: number };
      };
      assert.equal(r.status, 200);
      assert.equal(r.body.rejects.length, 2);
      assert.equal(r.body.rejects[0]!.source, 'telegram', '最近的在前');
      assert.equal(r.body.rejects[1]!.reason, 'auth');
      assert.equal(r.body.limit, 10);
    } finally {
      await stopHarness(h);
    }
  });

  test('GET /api/logs 的 limit 校验（0 / 501 / 非数字 → 400）', async () => {
    const h = await startHarness();
    try {
      for (const bad of ['0', '501', 'abc']) {
        const r = (await getJson(h, `/api/logs?limit=${bad}`)) as { status: number; body: { error: string } };
        assert.equal(r.status, 400, `limit=${bad} 应 400`);
        assert.equal(r.body.error, 'bad_limit');
      }
    } finally {
      await stopHarness(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 四、CLI 端到端：输出要是"人话"，并回答三个问题
// ═══════════════════════════════════════════════════════════════════

function makeCliCapture(responder: (url: string) => { status: number; body: unknown }): {
  opts: CliOptions;
  captured: { out: string[]; err: string[]; urls: string[] };
} {
  const captured = { out: [] as string[], err: [] as string[], urls: [] as string[] };
  const opts: CliOptions = {
    token: 'm',
    url: 'http://127.0.0.1:7788',
    exit: () => undefined,
    out: (t) => captured.out.push(t),
    err: (t) => captured.err.push(t),
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      captured.urls.push(url);
      const r = responder(url);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  };
  return { opts, captured };
}

const VIEW_FIXTURE = buildTaskView({
  task: mkTask(),
  steps: [
    mkStep({ seq: 1, kind: 'llm', callId: 'c1', startedAt: 1_000, finishedAt: 4_000 }),
    mkStep({ seq: 2, kind: 'tool', toolName: 'fs.write', startedAt: 4_000, finishedAt: 4_200 }),
  ],
  callLogs: [
    { attemptId: 'c1', outcome: 'ok', latencyMs: 2_900, promptTokens: 120, completionTokens: 40, endpointId: 'ep-x', model: 'm', degraded: 0 },
  ],
  now: 10_000,
});

describe('CLI：dotd task --verbose / dotd logs', () => {
  test('dotd task <id> --verbose 打的是 /api/tasks/:id?verbose=1 且输出回答三个问题', async () => {
    const c = makeCliCapture(() => ({ status: 200, body: { task: VIEW_FIXTURE.task, steps: VIEW_FIXTURE.steps, view: VIEW_FIXTURE } }));
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'task', 'tk_obs', '--verbose']);
    assert.ok(c.captured.urls[0]!.includes('/api/tasks/tk_obs?verbose=1'), c.captured.urls.join(','));

    const text = c.captured.out.join('\n');
    assert.match(text, /花了多少/, '问题①：花了多少');
    assert.match(text, /输入 120 \+ 输出 40 = 160/, 'token 口径来自 model_call_log');
    assert.match(text, /模型调用 3\.0s、工具执行 200ms/, '时间按 llm/tool 分开');
    assert.match(text, /最慢一步|卡在哪/, '问题③：卡在哪/哪步最慢');
    assert.match(text, /每一步/, '问题②：每一步多久');
    assert.match(text, /1\. 模型调用/, '步骤要逐条列出');
  });

  test('dotd task <id>（无 --verbose）仍可用：简洁版 + 提示加 --verbose', async () => {
    const c = makeCliCapture(() => ({ status: 200, body: { task: VIEW_FIXTURE.task, steps: VIEW_FIXTURE.steps } }));
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'task', 'tk_obs']);
    assert.ok(c.captured.urls[0]!.includes('/api/tasks/tk_obs'));
    assert.ok(!c.captured.urls[0]!.includes('verbose=1'));
    const text = c.captured.out.join('\n');
    assert.match(text, /任务 tk_obs/);
    assert.match(text, /--verbose/, '要引导主人用详细视图');
  });

  test('dotd task 不存在 → 人话 + 下一步命令（不是裸 error 对象）', async () => {
    const c = makeCliCapture(() => ({ status: 404, body: { error: 'not_found', message: '任务 tk_nope 不存在' } }));
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'task', 'tk_nope']);
    const text = c.captured.out.join('\n');
    assert.match(text, /不存在/);
    assert.match(text, /dotd queue/, '要给出下一步命令');
  });

  test('dotd logs 打的是 /api/logs（不再是 /api/guard 凑），并渲染成可读行', async () => {
    const c = makeCliCapture((url) => {
      assert.ok(url.includes('/api/logs?limit=20'), `必须打 /api/logs，实际 ${url}`);
      return {
        status: 200,
        body: {
          rejects: [
            { at: '2026-10-18T01:05:00.000Z', source: 'telegram', actor: null, reason: 'rate', detail: null },
            { at: '2026-10-18T01:00:00.000Z', source: 'grafana', actor: 'ops', reason: 'auth', detail: 'HMAC 签名不匹配' },
          ],
          limit: 20,
        },
      };
    });
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'logs', '--limit', '20']);
    const text = c.captured.out.join('\n');
    assert.match(text, /入站被拒 2 条/);
    assert.match(text, /telegram\s+rate\s+匿名/);
    assert.match(text, /grafana\s+auth\s+ops\s+HMAC 签名不匹配/);
    assert.doesNotMatch(text, /待补/, '不能再出现"待补"说明');
  });

  test('dotd logs 空结果也给人话', async () => {
    const c = makeCliCapture(() => ({ status: 200, body: { rejects: [], limit: 50 } }));
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'logs']);
    assert.match(c.captured.out.join('\n'), /最近没有入站被拒记录/);
  });

  test('--json 时输出机读 JSON（合法可解析）', async () => {
    const c = makeCliCapture(() => ({ status: 200, body: { task: VIEW_FIXTURE.task, steps: VIEW_FIXTURE.steps, view: VIEW_FIXTURE } }));
    const cli = buildCli(c.opts);
    await cli.parseAsync(['node', 'dotd', 'task', 'tk_obs', '--verbose', '--json']);
    const parsed = JSON.parse(c.captured.out.join('')) as { view: { cost: { totalTokens: number } } };
    assert.equal(parsed.view.cost.totalTokens, 160);
  });
});
