/**
 * tests/surfaces-voice-memory.test.ts —— 阶段 5：单一记忆源 + 单一主动推送决策
 *
 * 守的边界（docs/voice-merge-plan.md §5.1 / §5.2）：
 * 1. 语音轮次只在 dotd 有一份事实：反射轮次补写后，Web/管理面读得到；
 * 2. 语音偏好写进 dotd，设备侧与管理面读的是同一张表；跨设备互不可见；
 * 3. 主动推送的「该不该说」由 dotd 回答：总开关 / 安静时段 / 每日上限 / 节流 / 同文去重；
 * 4. 拒绝也留痕（device_push_log），不是只在 Charlie 日志里。
 *
 * 起真实 HTTP server（随机端口，127.0.0.1），库用临时目录里迁移到 212 的真实 SQLite。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createHttpServer } from '../src/surfaces/http.ts';
import type { HttpDeps } from '../src/surfaces/http.ts';
import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type {
  ControlPlane,
  GovernancePort,
  MemoryPort,
  Message,
  RouterPort,
  Task,
} from '../src/shared/contracts.ts';

const MASTER = 'master-token-voice-memory';

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

function makeCp(): ControlPlane {
  const tasks = new Map<string, Task>();
  let n = 0;
  return {
    ingestEvent: () => ({ eventId: 1, dup: false }),
    submit: (input: { title: string; goal: string; priority: number; dotId: string; threadId?: string }) => {
      n += 1;
      const id = `tk_${String(n).padStart(3, '0')}`;
      const now = 1_000_000 + n;
      const task = {
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
      } satisfies Task;
      tasks.set(id, task);
      return task;
    },
    list: () => [],
    cancel: () => ({ ok: true }),
    getTask: (id: string) => tasks.get(id) ?? null,
    getJournal: () => [],
    getGuardStatus: () => ({}),
  } as unknown as ControlPlane;
}

/** 有真消息存储的最小 MemoryPort：这样「Web 读得到」才是被验证的，而不是 mock 恒空。 */
function makeMem(db: DatabaseSync): MemoryPort {
  const msgs = new Map<string, Message[]>();
  let n = 0;
  return {
    openThread: (dotId, channel, opts) => {
      const externalRef = opts?.externalRef ?? null;
      if (externalRef !== null) {
        const existing = db
          .prepare('SELECT id FROM mem_threads WHERE channel = ? AND external_ref = ?')
          .get(channel, externalRef) as { id?: string } | undefined;
        if (existing?.id !== undefined) {
          msgs.set(existing.id, msgs.get(existing.id) ?? []);
          return Promise.resolve(existing.id);
        }
      }
      n += 1;
      const id = `thr_${String(n).padStart(3, '0')}`;
      db.prepare(
        `INSERT INTO mem_threads
           (id, dot_id, channel, external_ref, title, origin_task_id, status, pinned,
            context_summary, context_summary_upto_seq, last_active_at, last_task_finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'active', 0, NULL, 0, ?, NULL, ?)`,
      ).run(id, dotId, channel, externalRef, opts?.title ?? null, 1_000_000, 1_000_000);
      msgs.set(id, []);
      return Promise.resolve(id);
    },
    appendMessage: (threadId, msg) => {
      const list = msgs.get(threadId) ?? [];
      const seq = list.length + 1;
      list.push({
        id: `${threadId}-m${seq}`,
        threadId,
        seq,
        role: msg.role,
        kind: msg.kind,
        content: msg.content,
        tokenEst: 0,
        createdAt: 1_000_000 + seq,
      });
      msgs.set(threadId, list);
      return Promise.resolve({ id: `${threadId}-m${seq}`, seq });
    },
    listThreads: () => Promise.resolve([]),
    listMessages: (threadId, opts) => {
      const list = msgs.get(threadId) ?? [];
      const filtered =
        opts.beforeSeq === undefined ? list : list.filter((m) => m.seq < opts.beforeSeq!);
      return Promise.resolve(filtered.slice(-opts.limit));
    },
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
}

async function startServer(): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = new SseBus({ db: dir.db, bus });
  const deps: HttpDeps = {
    db: dir.db,
    bus,
    cp: makeCp(),
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
  return { dir, server, base: `http://127.0.0.1:${port}` };
}

async function close(h: Harness): Promise<void> {
  h.server.closeAllConnections?.();
  await new Promise<void>((res) => h.server.close(() => res()));
  h.dir.cleanup();
}

const masterAuth = { authorization: `Bearer ${MASTER}` };

async function createDevice(h: Harness, name: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${h.base}/api/devices`, {
    method: 'POST',
    headers: { ...masterAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  const j = (await res.json()) as { id: string; token: string };
  return { id: j.id, token: j.token };
}

function devAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 每个用例都把推送策略恢复默认，避免相互污染。 */
function resetPushEnv(): void {
  for (const k of [
    'DOTD_VOICE_PROACTIVE',
    'DOTD_VOICE_QUIET_HOURS',
    'DOTD_VOICE_PUSH_THROTTLE_HOURS',
    'DOTD_VOICE_PUSH_DAILY_CAP',
    'DOTD_VOICE_PUSH_DEDUPE_MIN',
  ]) {
    delete process.env[k];
  }
}

test('记忆源：语音轮次写进 dotd，设备与管理面读同一份', async (t) => {
  t.after(sweepTempPaths);
  const h = await startServer();
  try {
    const dev = await createDevice(h, '客厅小屏');

    // 走正常语音入口：user 消息当场进 mem_messages。
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: devAuth(dev.token),
      body: JSON.stringify({ text: '帮我记住：我对花生过敏' }),
    });
    assert.equal(turn.status, 202);
    const turnBody = await jsonOf<{ threadId: string; taskId: string }>(turn);
    assert.ok(turnBody.threadId.length > 0);

    let mem = await jsonOf<{ threadId: string | null; messages: Message[]; prefs: unknown[] }>(
      await fetch(`${h.base}/api/device/memory`, { headers: devAuth(dev.token) }),
    );
    assert.equal(mem.threadId, turnBody.threadId);
    assert.equal(mem.messages.length, 1);
    assert.equal(mem.messages[0]!.role, 'user');
    assert.equal(mem.messages[0]!.content, '帮我记住：我对花生过敏');
    assert.deepEqual(mem.prefs, []);

    // 反射轮次（没经过 dotd 任务）补写回来，并验证幂等。
    const mirror = await fetch(`${h.base}/api/device/memory/turn`, {
      method: 'POST',
      headers: devAuth(dev.token),
      body: JSON.stringify({
        userText: '晚安',
        reply: '晚安，空调已关',
        dedupeKey: 'reflex:2026-10-24T22:00',
      }),
    });
    assert.equal(mirror.status, 201);
    const dup = await fetch(`${h.base}/api/device/memory/turn`, {
      method: 'POST',
      headers: devAuth(dev.token),
      body: JSON.stringify({
        userText: '晚安',
        reply: '晚安，空调已关',
        dedupeKey: 'reflex:2026-10-24T22:00',
      }),
    });
    assert.equal(dup.status, 200);
    assert.equal((await jsonOf<{ duplicate: boolean }>(dup)).duplicate, true);

    mem = await jsonOf<{ threadId: string | null; messages: Message[]; prefs: unknown[] }>(
      await fetch(`${h.base}/api/device/memory`, { headers: devAuth(dev.token) }),
    );
    assert.deepEqual(
      mem.messages.map((m) => [m.role, m.content]),
      [
        ['user', '帮我记住：我对花生过敏'],
        ['user', '晚安'],
        ['assistant', '晚安，空调已关'],
      ],
    );

    // 管理面（master）能读到同一条会话（「Web 里记得」）。
    const convo = await jsonOf<{ threadId: string; messages: Message[] }>(
      await fetch(`${h.base}/api/conversations?thread=${turnBody.threadId}`, { headers: masterAuth }),
    );
    assert.equal(convo.threadId, turnBody.threadId);
    assert.equal(convo.messages.length, 3);
  } finally {
    await close(h);
  }
});

test('偏好：设备写、管理面读；跨设备互不可见；可删除', async (t) => {
  t.after(sweepTempPaths);
  const h = await startServer();
  try {
    const a = await createDevice(h, 'A');
    const b = await createDevice(h, 'B');

    const put = await fetch(`${h.base}/api/device/prefs`, {
      method: 'PUT',
      headers: devAuth(a.token),
      body: JSON.stringify({ key: 'tts_voice', value: 'zh_female_qingxin' }),
    });
    assert.equal(put.status, 200);

    const pref = await jsonOf<{ pref: { key: string; value: string } }>(
      await fetch(`${h.base}/api/device/prefs`, {
        method: 'PUT',
        headers: devAuth(a.token),
        body: JSON.stringify({ key: 'wake_word', value: '你好小豆' }),
      }),
    );
    assert.equal(pref.pref.key, 'wake_word');

    const memA = await jsonOf<{ prefs: Array<{ key: string; value: string }> }>(
      await fetch(`${h.base}/api/device/memory`, { headers: devAuth(a.token) }),
    );
    assert.deepEqual(
      memA.prefs.map((p) => [p.key, p.value]).sort(),
      [
        ['tts_voice', 'zh_female_qingxin'],
        ['wake_word', '你好小豆'],
      ],
    );

    const memB = await jsonOf<{ prefs: unknown[] }>(
      await fetch(`${h.base}/api/device/memory`, { headers: devAuth(b.token) }),
    );
    assert.deepEqual(memB.prefs, []);

    const all = await jsonOf<{
      devices: Array<{ deviceId: string; prefs: Array<{ key: string; value: string }> }>;
    }>(await fetch(`${h.base}/api/memory/prefs`, { headers: masterAuth }));
    assert.equal(all.devices.length, 2);
    const aView = all.devices.find((d) => d.deviceId === a.id);
    assert.equal(aView?.prefs.length, 2);
    const bView = all.devices.find((d) => d.deviceId === b.id);
    assert.equal(bView?.prefs.length, 0);

    // 设备 token 打管理面 → 403（有身份、无权限），不是 401。
    const forbidden = await fetch(`${h.base}/api/memory/prefs`, { headers: devAuth(a.token) });
    assert.equal(forbidden.status, 403);

    const del = await fetch(`${h.base}/api/device/prefs/wake_word`, {
      method: 'DELETE',
      headers: devAuth(a.token),
    });
    assert.equal(del.status, 200);
    const delAgain = await fetch(`${h.base}/api/device/prefs/wake_word`, {
      method: 'DELETE',
      headers: devAuth(a.token),
    });
    assert.equal(delAgain.status, 404);
  } finally {
    await close(h);
  }
});

test('主动推送：dotd 说该不该说（开关/安静时段/同文去重/每日上限/节流）', async (t) => {
  t.after(sweepTempPaths);
  resetPushEnv();
  // 测试不假设跑在哪个时区/几点：先显式关掉安静时段，后面单独把窗口设成全天。
  process.env.DOTD_VOICE_QUIET_HOURS = '';
  const h = await startServer();
  try {
    const dev = await createDevice(h, '客厅');
    const decide = async (kind: string, text: string) => {
      const res = await fetch(`${h.base}/api/device/proactive/decide`, {
        method: 'POST',
        headers: devAuth(dev.token),
        body: JSON.stringify({ kind, text }),
      });
      assert.equal(res.status, 200);
      return jsonOf<{ allow: boolean; reason?: string; detail?: string }>(res);
    };

    // 默认允许。
    const first = await decide('weather', '今天下午有雨，记得带伞');
    assert.equal(first.allow, true, JSON.stringify(first));

    // 同文 30 分钟内不重复。
    const dup = await decide('weather', '今天下午有雨，记得带伞');
    assert.equal(dup.allow, false);
    assert.equal(dup.reason, 'duplicate');

    // 换一句、同类：节流（默认 4h）。
    const throttled = await decide('weather', '晚上降温到 12 度');
    assert.equal(throttled.allow, false);
    assert.equal(throttled.reason, 'throttled');

    // 另一类仍然可以（避免一条规则把另一条也饿死）。
    const home = await decide('home', '你到家了，客厅灯已经打开');
    assert.equal(home.allow, true, JSON.stringify(home));

    // 每日上限：1 条/天时，第二类也被拦。
    process.env.DOTD_VOICE_PUSH_DAILY_CAP = '1';
    const capped = await decide('sleep', '该睡了');
    assert.equal(capped.allow, false);
    assert.equal(capped.reason, 'daily_cap');
    delete process.env.DOTD_VOICE_PUSH_DAILY_CAP;

    // 总开关。
    process.env.DOTD_VOICE_PROACTIVE = '0';
    const off = await decide('morning', '早上好');
    assert.equal(off.allow, false);
    assert.equal(off.reason, 'disabled');
    delete process.env.DOTD_VOICE_PROACTIVE;

    // 安静时段：把窗口设成全天。
    process.env.DOTD_VOICE_QUIET_HOURS = '00:00-23:59';
    const quiet = await decide('evening', '今天辛苦了');
    assert.equal(quiet.allow, false);
    assert.equal(quiet.reason, 'quiet_hours');
    // 恢复成「关闭」而不是删掉：删掉会回到默认 23:00-07:30，
    // CI 在 UTC 凌晨跑时后续断言会被安静时段误伤。
    process.env.DOTD_VOICE_QUIET_HOURS = '';

    // 拒绝也留痕，管理面能回放。
    const audit = await jsonOf<{
      devices: Array<{ pushLog: Array<{ allowed: boolean; reason: string | null }> }>;
    }>(await fetch(`${h.base}/api/memory/prefs?device=${dev.id}&push=1`, { headers: masterAuth }));
    const log = audit.devices[0]!.pushLog;
    assert.ok(log.length >= 6, `push log 应有每次决策，实际 ${log.length}`);
    assert.ok(log.some((e) => e.allowed && e.reason === null));
    assert.ok(log.some((e) => !e.allowed && e.reason === 'duplicate'));
    assert.ok(log.some((e) => !e.allowed && e.reason === 'quiet_hours'));
    assert.ok(log.some((e) => !e.allowed && e.reason === 'daily_cap'));
    assert.ok(log.some((e) => !e.allowed && e.reason === 'disabled'));
  } finally {
    resetPushEnv();
    await close(h);
  }
});

test('主动推送：被拒绝的决策不推进节流账本（安静时段结束后第一条仍能说）', async (t) => {
  t.after(sweepTempPaths);
  resetPushEnv();
  const h = await startServer();
  try {
    const dev = await createDevice(h, '书房');
    const decide = async (kind: string, text: string) => {
      const res = await fetch(`${h.base}/api/device/proactive/decide`, {
        method: 'POST',
        headers: devAuth(dev.token),
        body: JSON.stringify({ kind, text }),
      });
      return jsonOf<{ allow: boolean; reason?: string }>(res);
    };

    process.env.DOTD_VOICE_QUIET_HOURS = '00:00-23:59';
    const quiet = await decide('decision', '日历上 10 点有个会');
    assert.equal(quiet.reason, 'quiet_hours');
    process.env.DOTD_VOICE_QUIET_HOURS = '';

    const after = await decide('decision', '日历上 10 点有个会');
    assert.equal(after.allow, true, '安静时段拒绝不该把 last_push_at 推进');
  } finally {
    resetPushEnv();
    await close(h);
  }
});

test('记忆源：设备只能读自己的那条会话（跨设备 404/空）', async (t) => {
  t.after(sweepTempPaths);
  const h = await startServer();
  try {
    const a = await createDevice(h, 'A');
    const b = await createDevice(h, 'B');
    const turn = await fetch(`${h.base}/api/device/turn`, {
      method: 'POST',
      headers: devAuth(a.token),
      body: JSON.stringify({ text: 'A 说的话' }),
    });
    const { threadId } = await jsonOf<{ threadId: string }>(turn);

    // B 用自己的 token 读自己的记忆：没有 A 的会话。
    const memB = await jsonOf<{ threadId: string | null; messages: Message[] }>(
      await fetch(`${h.base}/api/device/memory`, { headers: devAuth(b.token) }),
    );
    assert.equal(memB.threadId, null);
    assert.deepEqual(memB.messages, []);

    // B 指定 A 的 thread 也不行（/api/device/memory 只按自己的设备查，参数里没有 thread）。
    const badBefore = await fetch(`${h.base}/api/device/memory?before=-1`, {
      headers: devAuth(b.token),
    });
    assert.equal(badBefore.status, 400);

    // 管理面能看 A 的会话。
    const convo = await jsonOf<{ messages: Message[] }>(
      await fetch(`${h.base}/api/conversations?thread=${threadId}`, { headers: masterAuth }),
    );
    assert.equal(convo.messages[0]!.content, 'A 说的话');
  } finally {
    await close(h);
  }
});
