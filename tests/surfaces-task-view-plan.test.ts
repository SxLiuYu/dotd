/**
 * tests/surfaces-task-view-plan.test.ts —— P2-2 可观测性：`dotd task <id> --verbose` 里的计划。
 *
 * 证明② 的"最后一公里"：计划不只是内存里的一份字符串，而是能从
 * `GET /api/tasks/:id?verbose=1` 真读出来（主人用 CLI 看到的就是这个路由）。
 *
 * 链路：Runner 写 thread（`mem_messages`，system/text + PLAN_MARKER）
 *   → 本路由按 task_id 读回 → `plansFromMessages` 取当前版 → `buildTaskView` 投影 → JSON。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import { createHttpServer } from '../src/surfaces/http.ts';
import type { ControlPlane } from '../src/shared/contracts.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type { GovernancePort, MemoryPort, RouterPort } from '../src/shared/contracts.ts';
import { serializePlan, type Plan } from '../src/runner/plan.ts';

const TOKEN = 'test-master-token-for-plan';

function makeConfig(overrides: Partial<SurfacesConfig['http']> = {}): SurfacesConfig {
  return {
    http: {
      host: '127.0.0.1',
      port: 0,
      masterToken: TOKEN,
      readonlyTokens: [],
      allowedOrigins: ['http://127.0.0.1:5173'],
      ...overrides,
    },
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

/** 最小 CP 替身：只有 task 明细路由用到的两个方法。 */
function makeCp(taskId: string): ControlPlane {
  return {
    getTask: () => ({
      id: taskId,
      dotId: 'dot1',
      title: '整理笔记',
      goal: '把 notes 整理成清单',
      status: 'done',
      priority: 1,
      attempt: 0,
      maxAttempts: 3,
      budgetTokens: 100000,
      runEpoch: 1,
      threadId: 'thr_plan',
      sessionId: 'thr_plan',
      resumeFromSeq: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      runAt: null,
      lastHeartbeatAt: null,
      stopReason: null,
    }),
    getJournal: () => [],
  } as unknown as ControlPlane;
}

async function start(taskId = 'tk_plan_1'): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = new SseBus({ db: dir.db, bus });
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: makeCp(taskId),
    gov: { decide: async () => ({ ok: true }) } as unknown as GovernancePort,
    mem: {} as unknown as MemoryPort,
    router: { snapshot: () => ({}) } as unknown as RouterPort,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}` };
}

async function stop(h: Harness): Promise<void> {
  await new Promise<void>((res) => h.server.close(() => res()));
  h.dir.cleanup();
}

/** 按 Runner 的写法把一条计划塞进 mem_messages（system/text + 标记）。 */
function seedPlan(dir: TempDataDir, taskId: string, plan: Plan, seq = 1): void {
  const thread = dir.db.prepare(`SELECT id FROM mem_threads LIMIT 1`).get() as { id: string } | undefined;
  const threadId = thread?.id;
  if (threadId === undefined) {
    dir.db
      .prepare(
        `INSERT INTO mem_threads(id, dot_id, channel, title, status, origin_task_id, last_active_at, created_at)
         VALUES('thr_plan','dot1','web','整理笔记','active',?,?,?)`,
      )
      .run(taskId, Date.now(), Date.now());
  }
  dir.db
    .prepare(
      `INSERT INTO mem_messages(id, thread_id, seq, role, kind, content, task_id, token_est, created_at)
       VALUES(?, 'thr_plan', ?, 'system', 'text', ?, ?, 0, ?)`,
    )
    .run(`msg_plan_${seq}`, seq, serializePlan(plan), taskId, Date.now());
}

async function getJson(h: Harness, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('可观测②：GET /api/tasks/:id?verbose=1 带出计划（版本/条目/进度对照）', async () => {
  const h = await start();
  try {
    seedPlan(h.dir, 'tk_plan_1', {
      version: 2,
      items: [
        { index: 1, text: '读目录', status: 'done' },
        { index: 2, text: '写清单', status: 'doing' },
        { index: 3, text: '发给主人', status: 'todo' },
      ],
      revisionReason: '多了一步',
    });
    const r = await getJson(h, '/api/tasks/tk_plan_1?verbose=1');
    assert.equal(r.status, 200);
    const view = r.body['view'] as Record<string, unknown>;
    assert.ok(view !== undefined, 'verbose=1 必须带 view');
    const plan = view['plan'] as Record<string, unknown> | null;
    assert.ok(plan !== null, '计划必须出现在 TaskView 里');
    assert.equal(plan!['version'], 2);
    assert.equal(plan!['revisions'], 1);
    assert.equal(plan!['completed'], 1);
    assert.equal(plan!['total'], 3);
    assert.equal(plan!['revisionReason'], '多了一步');
    assert.deepEqual(
      (plan!['items'] as Array<{ statusLabel: string }>).map((i) => i.statusLabel),
      ['已完成', '进行中', '未开始'],
    );
  } finally {
    await stop(h);
  }
});

test('可观测②：多版本时取最后一条（当前计划），不是首版', async () => {
  const h = await start();
  try {
    seedPlan(h.dir, 'tk_plan_1', {
      version: 1,
      items: [{ index: 1, text: '旧计划', status: 'todo' }],
      revisionReason: '',
    }, 1);
    seedPlan(h.dir, 'tk_plan_1', {
      version: 2,
      items: [{ index: 1, text: '新计划', status: 'doing' }],
      revisionReason: '改了',
    }, 2);
    const r = await getJson(h, '/api/tasks/tk_plan_1?verbose=1');
    const plan = (r.body['view'] as Record<string, unknown>)['plan'] as Record<string, unknown>;
    assert.equal(plan['version'], 2);
    assert.equal((plan['items'] as Array<{ text: string }>)[0]!.text, '新计划');
  } finally {
    await stop(h);
  }
});

test('可观测②：没有计划的任务 → view.plan 为 null（功能关闭时零变化）', async () => {
  const h = await start();
  try {
    const r = await getJson(h, '/api/tasks/tk_plan_1?verbose=1');
    assert.equal(r.status, 200);
    assert.equal((r.body['view'] as Record<string, unknown>)['plan'], null);
  } finally {
    await stop(h);
  }
});

test('可观测②：不带 verbose 的响应体与改动前一致（不塞计划，零回归）', async () => {
  const h = await start();
  try {
    seedPlan(h.dir, 'tk_plan_1', {
      version: 1,
      items: [{ index: 1, text: '读目录', status: 'todo' }],
      revisionReason: '',
    });
    const r = await getJson(h, '/api/tasks/tk_plan_1');
    assert.equal(r.status, 200);
    assert.equal(r.body['view'], undefined, '非 verbose 不带 view');
    assert.equal(r.body['plan'], undefined, '也不额外塞 plan 字段');
  } finally {
    await stop(h);
  }
});
