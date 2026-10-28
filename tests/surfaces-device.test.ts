/**
 * tests/surfaces-device.test.ts —— 语音设备面（阶段 2）的 HTTP 证据。
 *
 * 守的边界（docs/voice-merge-plan.md 阶段 2）：
 * 1. 设备 token 只在创建时返回一次，库里只有 sha256；
 * 2. 设备只能读自己设备产生的任务（跨设备一律 404，不泄露存在性）；
 * 3. 设备 token 不能当 master 用（/api/queue 等一条都不放）；
 * 4. 设备永远不能批准危险动作（403 + audit_log 记账）；
 * 5. 反射层记账（voice_events）落库，且不吞掉审计失败。
 *
 * 起真实 HTTP server（随机端口，127.0.0.1），库用临时目录里迁移到 200 的真实 SQLite。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createHttpServer, hashDeviceToken, localDay } from '../src/surfaces/http.ts';
import { collectProof } from '../src/surfaces/proof.ts';
import { accountDeviceTaskTokens } from '../src/surfaces/device-usage.ts';
import type { HttpDeps } from '../src/surfaces/http.ts';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type {
  ControlPlane,
  GovernancePort,
  MemoryPort,
  RouterPort,
  Task,
} from '../src/shared/contracts.ts';

const MASTER = 'master-token-test';

function makeConfig(): SurfacesConfig {
  return {
    http: {
      host: '127.0.0.1',
      port: 0,
      masterToken: MASTER,
      readonlyTokens: [],
      allowedOrigins: [],
    },
    hooks: [],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
    ui: { streamDeltas: true },
    progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
    brief: { enabled: false, time: '08:30', chatId: null, windowMin: 180, maxChars: 1200 },
    connWatch: { enabled: false, intervalMin: 15, quietHours: null },
  };
}

/** 最小 CP：submit 把任务记在内存里，getTask/getJournal 读它。 */
function makeCp(): { cp: ControlPlane; tasks: Map<string, Task> } {
  const tasks = new Map<string, Task>();
  let n = 0;
  const cp = {
    ingestEvent: () => ({ eventId: 1, dup: false }),
    submit: (input: { title: string; goal: string; priority: number; dotId: string; threadId?: string }) => {
      n += 1;
      const id = `tk_${String(n).padStart(3, '0')}`;
      const now = 1_000_000 + n;
      const task: Task = {
        id,
        dotId: input.dotId,
        title: input.title,
        goal: input.goal,
        status: 'queued',
        priority: input.priority,
        runAt: null,
        sourceEventId: null,
        sessionId: input.threadId ?? null,
        threadId: input.threadId ?? null,
        attempt: 0,
        maxAttempts: 3,
        runEpoch: 0,
        lastHeartbeatAt: null,
        budgetTokens: 0,
        usageTokens: 0,
        resumeFromSeq: null,
        stopReason: null,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(id, task);
      return task;
    },
    list: () => [],
    cancel: () => ({ ok: true }),
    getTask: (id: string) => tasks.get(id) ?? null,
    getJournal: () => [],
    getGuardStatus: () => ({}),
  } as unknown as ControlPlane;
  return { cp, tasks };
}

/** 最小 MemoryPort：openThread 真的写 mem_threads，归属校验才有真数据可查。 */
function makeMem(db: DatabaseSync): MemoryPort {
  let n = 0;
  return {
    openThread: (dotId, channel, opts) => {
      const externalRef = opts?.externalRef ?? null;
      if (externalRef !== null) {
        const existing = db
          .prepare('SELECT id FROM mem_threads WHERE channel = ? AND external_ref = ?')
          .get(channel, externalRef) as { id?: string } | undefined;
        if (existing?.id !== undefined) return Promise.resolve(existing.id);
      }
      n += 1;
      const id = `thr_${String(n).padStart(3, '0')}`;
      db.prepare(
        `INSERT INTO mem_threads
           (id, dot_id, channel, external_ref, title, origin_task_id, status, pinned,
            context_summary, context_summary_upto_seq, last_active_at, last_task_finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'active', 0, NULL, 0, ?, NULL, ?)`,
      ).run(id, dotId, channel, externalRef, opts?.title ?? null, 1_000_000, 1_000_000);
      return Promise.resolve(id);
    },
    appendMessage: () => Promise.resolve({ id: 'm', seq: 1 }),
    listThreads: () => Promise.resolve([]),
    listMessages: () => Promise.resolve([]),
  };
}

const fakeGov: GovernancePort = {
  decide: () => Promise.resolve({ ok: true }),
  listPending: () => [],
  getApproval: () => Promise.resolve(null),
};

const fakeRouter: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };

interface Harness {
  dir: TempDataDir;
  server: Server;
  base: string;
  sse: SseBus;
  bus: EventBus;
  tasks: Map<string, Task>;
  cp: ControlPlane;
}

async function startServer(): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = new SseBus({ db: dir.db, bus });
  const { cp, tasks } = makeCp();
  const deps: HttpDeps = {
    db: dir.db,
    bus,
    cp,
    gov: fakeGov,
    mem: makeMem(dir.db),
    router: fakeRouter,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
  };
  const server = createHttpServer(deps);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}`, sse, bus, tasks, cp };
}

async function close(h: Harness): Promise<void> {
  // SSE 连接是长连接：只调 close() 会一直等它自己断开，测试就挂在这儿。
  h.server.closeAllConnections?.();
  await new Promise<void>((res) => h.server.close(() => res()));
  h.sse.detach();
  h.dir.cleanup();
}

/**
 * 从 SSE 流里读到**至少一帧事件**为止。
 * 跳过 `: ok` / `: ping` 注释帧（连接建立与保活都会写），只等 `event:` 行。
 */
async function readSome(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let out = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => setTimeout(() => res(null), 250)),
    ]);
    if (r === null) continue;
    if (r.done) break;
    out += dec.decode(r.value, { stream: true });
    if (/(^|\n)event: /.test(out)) break;
  }
  return out;
}

const masterAuth = { authorization: `Bearer ${MASTER}` };

async function createDevice(
  h: Harness,
  name = '客厅小屏',
): Promise<{ id: string; token: string; name: string }> {
  const res = await fetch(`${h.base}/api/devices`, {
    method: 'POST',
    headers: { ...masterAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; token: string; name: string };
}

// ═══════════════════════════════════════════════════════════════════
// 一、设备注册 / 列表 / 吊销
// ═══════════════════════════════════════════════════════════════════

test('POST /api/devices：201 且只返回一次明文 token，库里只有 sha256', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    assert.match(dev.id, /^dev_[0-9a-f]{16}$/);
    assert.match(dev.token, /^dt_[0-9a-f]{64}$/);

    const row = h.dir.db
      .prepare('SELECT token_hash AS h, status FROM devices WHERE id = ?')
      .get(dev.id) as { h: string; status: string };
    assert.equal(row.status, 'active');
    assert.equal(row.h, hashDeviceToken(dev.token));
    assert.notEqual(row.h, dev.token, '库里绝不能存明文');

    const list = await fetch(`${h.base}/api/devices`, { headers: masterAuth });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { devices: Array<Record<string, unknown>> };
    assert.equal(body.devices.length, 1);
    assert.equal('token' in body.devices[0]!, false, '列表不能回 token');
    assert.equal('tokenHash' in body.devices[0]!, false, '列表也不能回 hash');
    assert.equal(body.devices[0]!.name, '客厅小屏');
  } finally {
    await close(h);
  }
});

test('POST /api/devices：空名字 400；非 master 401', async () => {
  const h = await startServer();
  try {
    const bad = await fetch(`${h.base}/api/devices`, {
      method: 'POST',
      headers: { ...masterAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(bad.status, 400);

    const anon = await fetch(`${h.base}/api/devices`, { method: 'POST' });
    assert.equal(anon.status, 401);
  } finally {
    await close(h);
  }
});

test('DELETE /api/devices/:id：吊销后同一 token 立即 401（覆盖全部 /api/device/*）', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    // 吊销前先拿到一个归属该设备的 taskId，用来打 device_task
    const warm = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '开灯' }),
    });
    const { taskId } = (await warm.json()) as { taskId: string };

    const del = await fetch(`${h.base}/api/devices/${dev.id}`, { method: 'DELETE', headers: masterAuth });
    assert.equal(del.status, 200);

    const auth = { authorization: `Bearer ${dev.token}` };
    const routes: Array<[string, RequestInit]> = [
      ['/api/device/turn', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"text":"开灯"}' }],
      ['/api/device/stream?task=' + taskId, { headers: auth }],
      ['/api/device/events', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"kind":"reflex"}' }],
      ['/api/device/tasks/' + taskId, { headers: auth }],
      ['/api/device/approvals/1', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"verdict":"approve"}' }],
    ];
    for (const [path, init] of routes) {
      const res = await fetch(`${h.base}${path}`, init);
      assert.equal(res.status, 401, `${path} 吊销后必须是 401，实际 ${res.status}`);
      // 401 是一次 DB 查 token 的结果，不是"过期时间"——吊销即生效
      await res.body?.cancel().catch(() => undefined);
    }

    const again = await fetch(`${h.base}/api/devices/${dev.id}`, { method: 'DELETE', headers: masterAuth });
    assert.equal(again.status, 404, '重复吊销 404，不假装成功');
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 二、turn → task → 读回
// ═══════════════════════════════════════════════════════════════════

test('/api/device/turn：建 voice 会话（external_ref=device），同设备第二次复用同一会话', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const call = (text: string) =>
      fetch(`${h.base}/api/device/turn`, {
        method: 'POST',
        headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });

    const r1 = await call('今天天气怎么样');
    assert.equal(r1.status, 202);
    const b1 = (await r1.json()) as { taskId: string; threadId: string; deviceId: string; status: string };
    assert.equal(b1.deviceId, dev.id);
    assert.equal(b1.status, 'queued');

    const thread = h.dir.db
      .prepare('SELECT channel, external_ref AS ext, title FROM mem_threads WHERE id = ?')
      .get(b1.threadId) as { channel: string; ext: string; title: string };
    assert.equal(thread.channel, 'voice');
    assert.equal(thread.ext, dev.id);
    assert.equal(thread.title, '客厅小屏');

    const r2 = await call('那明天呢');
    const b2 = (await r2.json()) as { threadId: string };
    assert.equal(b2.threadId, b1.threadId, '同一设备连续对话应复用会话');

    const task = h.tasks.get(b1.taskId)!;
    assert.equal(task.priority, 1, '语音是主人的交互任务，优先级 1');
    assert.equal(task.goal, '今天天气怎么样');
  } finally {
    await close(h);
  }
});

test('/api/device/turn：不能借 threadId 钻进别的设备的会话', async () => {
  const h = await startServer();
  try {
    const a = await createDevice(h, 'A');
    const b = await createDevice(h, 'B');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '开灯' }),
    });
    const { threadId } = (await turn.json()) as { threadId: string };

    const steal = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '把客厅灯关了', threadId }),
    });
    assert.equal(steal.status, 404);
  } finally {
    await close(h);
  }
});

test('/api/device/tasks/:id：自己的任务能读，别人的任务 404', async () => {
  const h = await startServer();
  try {
    const a = await createDevice(h, 'A');
    const b = await createDevice(h, 'B');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '开灯' }),
    });
    const { taskId } = (await turn.json()) as { taskId: string };

    const own = await fetch(`${h.base}/api/device/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(own.status, 200);
    const body = (await own.json()) as { task: { id: string }; summary: { state: string; stateLine: string } };
    assert.equal(body.task.id, taskId);
    assert.equal(body.summary.state, 'queued');
    assert.match(body.summary.stateLine, /排队|等/);

    const other = await fetch(`${h.base}/api/device/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    assert.equal(other.status, 404, '跨设备读任务必须 404（不泄露存在性）');
  } finally {
    await close(h);
  }
});

test('设备 token 不能当 master 用：/api/queue 403（有身份、无权限）', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const res = await fetch(`${h.base}/api/queue`, {
      headers: { authorization: `Bearer ${dev.token}` },
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'device_scope');
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 三、stream / 审批 / 记账
// ═══════════════════════════════════════════════════════════════════

test('/api/device/stream：缺 task 400；别人的 task 404', async () => {
  const h = await startServer();
  try {
    const a = await createDevice(h, 'A');
    const b = await createDevice(h, 'B');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '开灯' }),
    });
    const { taskId } = (await turn.json()) as { taskId: string };

    const noTask = await fetch(`${h.base}/api/device/stream`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(noTask.status, 400);

    const other = await fetch(`${h.base}/api/device/stream?task=${taskId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    assert.equal(other.status, 404);
  } finally {
    await close(h);
  }
});

test('/api/device/stream：断线重连不带头 → 从设备游标续读（阶段 3 第 3 条）', async () => {
  const h = await startServer();
  h.sse.attach();
  try {
    const dev = await createDevice(h, 'A');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第一句' }),
    });
    const { taskId } = (await turn.json()) as { taskId: string };

    // 第一次连接：收到实时帧后断开
    const first = await fetch(`${h.base}/api/device/stream?task=${taskId}`, {
      headers: { authorization: `Bearer ${dev.token}`, accept: 'text/event-stream' },
    });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    h.bus.publish('chat.delta', { taskId, delta: '第一帧' }, { dotId: 'dot1' });
    const chunk = await readSome(reader);
    assert.match(chunk, /event: chat\.chat\.delta/);
    await first.body!.cancel().catch(() => undefined);

    // 断线后服务端又产生一帧；重连**不带 Last-Event-ID**
    h.bus.publish('chat.final', { taskId, text: '第一帧之后的终稿' }, { dotId: 'dot1' });
    const second = await fetch(`${h.base}/api/device/stream?task=${taskId}`, {
      headers: { authorization: `Bearer ${dev.token}`, accept: 'text/event-stream' },
    });
    const missed = await readSome(second.body!.getReader());
    assert.match(missed, /event: chat\.chat\.final/, `重连应补回断线期间的帧，实际收到：${missed}`);
    assert.match(missed, /第一帧之后的终稿/);
    assert.doesNotMatch(missed, /event: chat\.chat\.delta/, '已下发过的帧不得重发');
    await second.body!.cancel().catch(() => undefined);
  } finally {
    await close(h);
  }
});

test('/api/device/approvals/:id：恒 403，并写一条 device_approval_denied 审计', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const res = await fetch(`${h.base}/api/device/approvals/42`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; approvalId: string };
    assert.equal(body.error, 'device_approval_forbidden');
    assert.equal(body.approvalId, '42');

    const row = h.dir.db
      .prepare("SELECT action, decision, reason FROM audit_log WHERE action='device_approval_denied'")
      .get() as { action: string; decision: string; reason: string } | undefined;
    assert.ok(row !== undefined, '拒绝也必须留痕');
    assert.equal(row.decision, 'denied');
    assert.match(row.reason, /dev_/);
  } finally {
    await close(h);
  }
});

test('/api/device/events：记 voice_events + audit_log；坏 kind 400', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const ok = await fetch(`${h.base}/api/device/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'scene.goodnight', detail: '关灯  拉窗帘' }),
    });
    assert.equal(ok.status, 201);

    const ev = h.dir.db
      .prepare('SELECT device_id AS d, kind, detail FROM voice_events WHERE id = ?')
      .get(((await ok.json()) as { id: number }).id) as { d: string; kind: string; detail: string };
    assert.equal(ev.d, dev.id);
    assert.equal(ev.kind, 'scene.goodnight');
    assert.equal(ev.detail, '关灯 拉窗帘', 'detail 归一化空白');

    const audited = h.dir.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='voice_reflex'")
      .get() as { n: number };
    assert.equal(audited.n, 1);

    const bad = await fetch(`${h.base}/api/device/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'Scene Goodnight' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await close(h);
  }
});

test('/api/device/events：latencyMs 收口（语音反射延迟的唯一观测点，2026-10-27）', async () => {
  // 为什么这条重要：指标里"语音反射 p50/p95"完全依赖这一列。收口写错两种方向都糟：
  //   · 把非反射事件的 null 记成 0 → 分位数被拉成"极快"，报喜不报忧；
  //   · 把设备挂起后补报的 5 分钟当成反射 → p95 变成毫无意义的量级。
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const post = async (body: Record<string, unknown>): Promise<number> => {
      const r = await fetch(`${h.base}/api/device/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 201);
      const j = (await r.json()) as { id: number };
      const row = h.dir.db
        .prepare('SELECT latency_ms AS l FROM voice_events WHERE id = ?')
        .get(j.id) as { l: number | null };
      return row.l as number;
    };

    assert.equal(await post({ kind: 'scene', detail: '开灯', latencyMs: 320 }), 320);
    assert.equal(await post({ kind: 'scene', detail: '开灯', latencyMs: 0 }), 0, '0 毫秒是合法读数，不是"没报"');
    assert.equal(await post({ kind: 'offline', detail: '断网' }), null as unknown as number, '没报就是 null，不能当 0');
    assert.equal(await post({ kind: 'scene', detail: 'x', latencyMs: 'abc' }), null as unknown as number, '非数字当没报');
    assert.equal(await post({ kind: 'scene', detail: 'x', latencyMs: -5 }), null as unknown as number, '负数当没报');
    assert.equal(
      await post({ kind: 'scene', detail: 'x', latencyMs: 300_000 }),
      null as unknown as number,
      '超过 60 秒已经不是反射（多半是挂起后补报），不能进分位数',
    );
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 四、凭证里的设备维度（阶段 2 第 6 条）
// ═══════════════════════════════════════════════════════════════════
test('collectProof：语音任务带 device（id/name/status/channel），普通任务不带这个键', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h, '厨房屏');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '开灯' }),
    });
    const { taskId } = (await turn.json()) as { taskId: string };

    const voice = collectProof(h.dir.db, h.cp, taskId, 1_700_000_000_000);
    assert.ok(voice !== null);
    assert.equal(voice.device?.id, dev.id);
    assert.equal(voice.device?.name, '厨房屏');
    assert.equal(voice.device?.status, 'active');
    assert.equal(voice.device?.channel, 'voice');

    // 同一份 journal 两次导出一致（hash 不含 generatedAt）。
    const again = collectProof(h.dir.db, h.cp, taskId, 1_700_000_111_111);
    assert.equal(again!.bundleHash, voice.bundleHash);

    // 非语音任务：没有 device 键（老凭证的 bundleHash 不变）。
    const threadId = await h.cp.getTask(taskId)!.threadId;
    assert.ok(threadId);
    h.dir.db
      .prepare("UPDATE mem_threads SET channel='web', external_ref=NULL WHERE id=?")
      .run(threadId);
    const web = collectProof(h.dir.db, h.cp, taskId, 1_700_000_000_000);
    assert.equal('device' in web!, false);
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 五、阶段 3：轮换 / 单设备并发 / 配额
// ═══════════════════════════════════════════════════════════════════

test('POST /api/devices/:id/rotate：旧令牌立即 401，新令牌可用', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const rot = await fetch(`${h.base}/api/devices/${dev.id}/rotate`, { method: 'POST', headers: masterAuth });
    assert.equal(rot.status, 200);
    const fresh = ((await rot.json()) as { token: string }).token;
    assert.notEqual(fresh, dev.token);
    assert.match(fresh, /^dt_[0-9a-f]{64}$/);

    const old = await fetch(`${h.base}/api/device/tasks/tk_none`, {
      headers: { authorization: `Bearer ${dev.token}` },
    });
    assert.equal(old.status, 401, '旧令牌必须当场失效');

    const now = await fetch(`${h.base}/api/device/tasks/tk_none`, {
      headers: { authorization: `Bearer ${fresh}` },
    });
    assert.equal(now.status, 404, '新令牌能过鉴权（任务不存在 → 404）');
  } finally {
    await close(h);
  }
});

test('/api/device/turn：同一设备有在途任务 → 409 device_busy', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '先说一句' }),
    });
    const { taskId, threadId } = (await turn.json()) as { taskId: string; threadId: string };

    // 真库里的 tasks 行（测试的 fake cp 不写表）—— 模拟还在跑。
    h.dir.db
      .prepare(
        `INSERT INTO tasks (id, dot_id, title, goal, status, priority, thread_id, created_at, updated_at)
         VALUES (?, 'dot1', '在途', '在途', 'running', 1, ?, ?, ?)`,
      )
      .run(taskId, threadId, Date.now(), Date.now());

    const busy = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '再说一句' }),
    });
    assert.equal(busy.status, 409);
    const body = (await busy.json()) as { error: string; taskId: string };
    assert.equal(body.error, 'device_busy');
    assert.equal(body.taskId, taskId);
  } finally {
    await close(h);
  }
});

test('/api/device/turn：每日任务配额耗尽 → 429 device_quota', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    h.dir.db.prepare('UPDATE devices SET daily_tasks = 1 WHERE id = ?').run(dev.id);
    const call = () =>
      fetch(`${h.base}/api/device/turn`, {
        method: 'POST',
        headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '第一句' }),
      });

    assert.equal((await call()).status, 202);
    const second = await call();
    assert.equal(second.status, 429);
    const body = (await second.json()) as { error: string; kind: string; used: number; limit: number };
    assert.equal(body.error, 'device_quota');
    assert.equal(body.kind, 'tasks');
    assert.equal(body.used, 1);
    assert.equal(body.limit, 1);

    // 列表里能看到用量
    const list = await fetch(`${h.base}/api/devices`, { headers: masterAuth });
    const rows = ((await list.json()) as { devices: Array<{ usedTasks: number; dailyTasks: number }> }).devices;
    assert.equal(rows[0]!.usedTasks, 1);
    assert.equal(rows[0]!.dailyTasks, 1);
  } finally {
    await close(h);
  }
});

test('/api/device/turn：字符配额（daily_chars=3）→ 429，且不写用量', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h);
    h.dir.db.prepare('UPDATE devices SET daily_chars = 3 WHERE id = ?').run(dev.id);
    const res = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这句话太长了' }),
    });
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as { kind: string }).kind, 'chars');
    const usage = h.dir.db.prepare('SELECT COUNT(*) AS n FROM device_usage').get() as { n: number };
    assert.equal(usage.n, 0, '被拒的请求不能计入用量');
  } finally {
    await close(h);
  }
});

// ── 阶段 3：token 配额（每设备每日，按任务终态增量记账）────────────────

test('设备 token 配额：终态按增量记账；同一任务重复终态不重复计', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h, 'A');
    const nowMs = Date.now();
    const threadId = 'thr_quota_1';
    h.dir.db
      .prepare('INSERT INTO mem_threads (id, dot_id, title, channel, external_ref, last_active_at, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(threadId, 'dot1', 'A', 'voice', dev.id, nowMs, nowMs);
    h.dir.db
      .prepare('INSERT INTO tasks (id, dot_id, title, goal, status, priority, thread_id, usage_tokens, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('tk_quota_1', 'dot1', 't', 'g', 'done', 1, threadId, 1234, nowMs, nowMs);

    const first = accountDeviceTaskTokens(h.dir.db, 'tk_quota_1', nowMs);
    assert.equal(first.attributed, true);
    assert.equal(first.delta, 1234);
    const second = accountDeviceTaskTokens(h.dir.db, 'tk_quota_1', nowMs);
    assert.equal(second.delta, 0, '同一任务重复终态不得重复计费');

    // 任务重跑把 usage 涨了 → 只补差额
    h.dir.db.prepare('UPDATE tasks SET usage_tokens = 2000 WHERE id = ?').run('tk_quota_1');
    const third = accountDeviceTaskTokens(h.dir.db, 'tk_quota_1', nowMs);
    assert.equal(third.delta, 766);

    const used = h.dir.db
      .prepare('SELECT tokens FROM device_usage WHERE device_id = ? AND day = ?')
      .get(dev.id, localDay(nowMs)) as { tokens: number };
    assert.equal(used.tokens, 2000);

    // 非语音任务：没有 external_ref → 不计
    h.dir.db
      .prepare('INSERT INTO mem_threads (id, dot_id, title, channel, last_active_at, created_at) VALUES (?,?,?,?,?,?)')
      .run('thr_normal', 'dot1', 'n', 'web', nowMs, nowMs);
    h.dir.db
      .prepare('INSERT INTO tasks (id, dot_id, title, goal, status, priority, thread_id, usage_tokens, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('tk_normal', 'dot1', 't', 'g', 'done', 5, 'thr_normal', 999, nowMs, nowMs);
    assert.equal(accountDeviceTaskTokens(h.dir.db, 'tk_normal', nowMs).attributed, false);
  } finally {
    await close(h);
  }
});

test('/api/device/turn：token 配额耗尽 → 429 device_quota(kind=tokens)，话术含「额度」', async () => {
  const h = await startServer();
  try {
    const dev = await createDevice(h, 'A');
    h.dir.db.prepare('UPDATE devices SET daily_tokens = 100 WHERE id = ?').run(dev.id);
    const day = localDay(Date.now());
    h.dir.db
      .prepare('INSERT INTO device_usage (device_id, day, tasks, chars, tokens, updated_at) VALUES (?,?,?,?,?,?)')
      .run(dev.id, day, 0, 0, 150, Date.now());

    const res = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '再说一句' }),
    });
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error: string; kind: string; message: string };
    assert.equal(body.error, 'device_quota');
    assert.equal(body.kind, 'tokens');
    assert.match(body.message, /额度/);
  } finally {
    await close(h);
  }
});
