/**
 * tests/surfaces-feishu-inbound.test.ts —— 飞书事件订阅入站（challenge/去重/主人闸门/AES）。
 *
 * 覆盖：
 * - classifyFeishuInbound 纯函数：token 校验（含缺失 fail-closed）、url_verification、
 *   im.message.receive_v1 主人/非主人/空文本、其余事件 ack、event_id 缺失拒；
 * - Encrypt Key：AES-256-CBC 解密回环（加密端照飞书官方方案构造）；
 * - handleFeishuCallback：消息事件 → openThread('feishu')+appendMessage+cp.submit
 *   priority 1；重投 dedup → 200 dup 不再建任务；
 * - 真 HTTP server：POST /hooks/feishu 不带 X-Dotd-* HMAC 头也通（专属通道），
 *   challenge 200 回显。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import { createHttpServer } from '../src/surfaces/http.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import {
  classifyFeishuInbound,
  decryptFeishuEncrypt,
  handleFeishuCallback,
  maybeDecryptFeishuBody,
} from '../src/surfaces/feishu-inbound.ts';
import { wsFrameToEnvelope } from '../src/surfaces/feishu-ws.ts';
import type { FeishuInboundDeps } from '../src/surfaces/feishu-inbound.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type { ControlPlane, GovernancePort, MemoryPort, RouterPort } from '../src/shared/contracts.ts';

const VTOKEN = 'v-token-123';
const OWNER_CHAT = 'oc_owner_1';

// ── 一、classifyFeishuInbound 纯函数 ──────────────────────────────────

function cfg(overrides: Partial<{ verificationToken?: string; ownerChatId?: string }> = {}) {
  return { verificationToken: VTOKEN, ownerChatId: OWNER_CHAT, ...overrides };
}

test('challenge：url_verification + token 匹配 → 回 challenge', () => {
  const d = classifyFeishuInbound(
    { type: 'url_verification', token: VTOKEN, challenge: 'ch-abc', Encrypt: 'N' },
    cfg(),
  );
  assert.deepEqual(d, { kind: 'challenge', challenge: 'ch-abc' });
});

test('challenge：token 不匹配 → auth 拒（不回 challenge）', () => {
  const d = classifyFeishuInbound({ type: 'url_verification', token: 'wrong', challenge: 'x' }, cfg());
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'auth');
});

test('challenge：verificationToken 未配置 → 一切请求 auth 拒（fail-closed）', () => {
  const d = classifyFeishuInbound({ type: 'url_verification', token: 'anything', challenge: 'x' }, cfg({ verificationToken: '' }));
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'auth');
});

function messageBody(eventId: string, chatId: string, text: string, messageType = 'text'): unknown {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', token: VTOKEN },
    event: {
      message: {
        chat_id: chatId,
        message_type: messageType,
        content: JSON.stringify({ text }),
      },
      sender: { sender_id: { open_id: 'ou_me' } },
    },
  };
}

test('消息事件：主人会话文本 → kind=message，dedupKey=fs:<event_id>，text 取出', () => {
  const d = classifyFeishuInbound(messageBody('ev_1', OWNER_CHAT, '把报告写完'), cfg());
  assert.equal(d.kind, 'message');
  if (d.kind === 'message') {
    assert.equal(d.dedupKey, 'fs:ev_1');
    assert.equal(d.text, '把报告写完');
    assert.equal(d.chatId, OWNER_CHAT);
    assert.equal(d.raw.dedupKey, 'fs:ev_1');
  }
});

test('消息事件：非主人 chat_id → allowlist 拒', () => {
  const d = classifyFeishuInbound(messageBody('ev_2', 'oc_stranger', 'rm -rf /'), cfg());
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'allowlist');
});

test('消息事件：owner_chat_id 未配置 → allowlist 全拒（fail-closed）', () => {
  const d = classifyFeishuInbound(messageBody('ev_3', OWNER_CHAT, 'hi'), cfg({ ownerChatId: '' }));
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'allowlist');
});

test('消息事件：空文本 / 非 text 类型 → ignore ack（不建任务、不进事件管线）', () => {
  const empty = classifyFeishuInbound(messageBody('ev_4', OWNER_CHAT, '   '), cfg());
  assert.equal(empty.kind, 'ignore');
  if (empty.kind === 'ignore') assert.equal(empty.reason, 'non_text');
  const image = classifyFeishuInbound(messageBody('ev_5', OWNER_CHAT, '', 'image'), cfg());
  assert.equal(image.kind, 'ignore');
  if (image.kind === 'ignore') assert.equal(image.reason, 'non_text');
});

test('消息事件：机器人自身消息（sender_type=app）→ ignore bot_echo（防回环）', () => {
  const body = messageBody('ev_bot', OWNER_CHAT, '这是我自己的回复') as Record<string, unknown>;
  (body['event'] as Record<string, unknown>)['sender'] = { sender_id: { app_id: 'cli_x' }, sender_type: 'app' };
  const d = classifyFeishuInbound(body, cfg());
  assert.equal(d.kind, 'ignore');
  if (d.kind === 'ignore') assert.equal(d.reason, 'bot_echo');
});

test('消息事件：owner_chat_id 逗号分隔多会话，两者都放行，第三个仍拒', () => {
  const multi = cfg({ ownerChatId: 'oc_a, oc_b' });
  assert.equal(classifyFeishuInbound(messageBody('ev_m1', 'oc_a', 'hi'), multi).kind, 'message');
  assert.equal(classifyFeishuInbound(messageBody('ev_m2', 'oc_b', 'hi'), multi).kind, 'message');
  const bad = classifyFeishuInbound(messageBody('ev_m3', 'oc_c', 'hi'), multi);
  assert.equal(bad.kind, 'reject');
  if (bad.kind === 'reject') assert.equal(bad.reason, 'allowlist');
});

test('trustedTransport（长连接）：无 token 的 body 放行；HTTP 路径 fail-closed 不变', () => {
  const noToken = messageBody('ev_ws_1', OWNER_CHAT, '长连接消息');
  // 去掉 header.token 模拟 WS payload（SDK 扁平化后没有可比对的 token）
  (noToken as Record<string, unknown>)['header'] = { event_id: 'ev_ws_1', event_type: 'im.message.receive_v1' };
  assert.equal(classifyFeishuInbound(noToken, cfg({ verificationToken: '' })).kind, 'reject');
  const d = classifyFeishuInbound(noToken, { ...cfg({ verificationToken: '' }), trustedTransport: true });
  assert.equal(d.kind, 'message');
});

test('其余事件类型：只 ack（kind=event），dedupKey 仍 fs:<event_id>', () => {
  const d = classifyFeishuInbound(
    { schema: '2.0', header: { event_id: 'ev_6', event_type: 'im.message.message_read_v1', token: VTOKEN }, event: {} },
    cfg(),
  );
  assert.equal(d.kind, 'event');
  if (d.kind === 'event') assert.equal(d.dedupKey, 'fs:ev_6');
});

test('header.event_id 缺失 → parse 拒（无法去重的入站不留）', () => {
  const d = classifyFeishuInbound(
    { schema: '2.0', header: { event_type: 'im.chat.member.bot.added_v1', token: VTOKEN }, event: {} },
    cfg(),
  );
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'parse');
});

test('token 只可在顶层或 header.token；两者皆无 → auth 拒', () => {
  const d = classifyFeishuInbound({ schema: '2.0', header: { event_id: 'x', event_type: 'a.b' }, event: {} }, cfg());
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'auth');
});

// ── 二A、长连接扁平帧 → v2.0 信封重组 ────────────────────────────────

test('wsFrameToEnvelope：SDK 扁平 payload 重组后 classify 判为 message', () => {
  // SDK handler 实收形状（types/index.d.ts:319138 im.message.receive_v1）
  const flat = {
    event_id: 'ev_ws_9',
    token: 'inner-token-ignored',
    create_time: '1690000000000',
    event_type: 'im.message.receive_v1',
    tenant_key: 'tk1',
    ts: '1690000000000',
    uuid: 'u1',
    type: 'event_callback',
    app_id: 'cli_1',
    sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user', tenant_key: 'tk1' },
    message: {
      message_id: 'om_1',
      chat_id: OWNER_CHAT,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '长连接的任务指令' }),
    },
  };
  const envelope = wsFrameToEnvelope('ev_ws_9', 'im.message.receive_v1', flat);
  const d = classifyFeishuInbound(envelope, { ...cfg({ verificationToken: '' }), trustedTransport: true });
  assert.equal(d.kind, 'message');
  if (d.kind === 'message') {
    assert.equal(d.text, '长连接的任务指令');
    assert.equal(d.chatId, OWNER_CHAT);
    assert.equal(d.eventId, 'ev_ws_9');
  }
});

test('wsFrameToEnvelope：header 字段不混进 event；event_id 缺省回退空串可被 parse 拒', () => {
  const flat = { sender: { sender_type: 'user' }, message: { chat_id: OWNER_CHAT, message_type: 'text', content: '{"text":"x"}' } };
  const envelope = wsFrameToEnvelope(undefined, 'im.message.receive_v1', flat);
  assert.equal((envelope['event'] as Record<string, unknown>)['sender'] !== undefined, true);
  assert.equal((envelope['event'] as Record<string, unknown>)['event_id'], undefined);
  const d = classifyFeishuInbound(envelope, { trustedTransport: true, ownerChatId: OWNER_CHAT });
  assert.equal(d.kind, 'reject');
  if (d.kind === 'reject') assert.equal(d.reason, 'parse');
});

// ── 二、Encrypt Key（AES-256-CBC 回环）───────────────────────────────

function feishuEncrypt(jsonText: string, encryptKey: string): string {
  // 飞书官方方案：key=sha256(encryptKey)，IV=key 前 16 字节
  const key = createHash('sha256').update(encryptKey).digest();
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  return Buffer.concat([c.update(Buffer.from(jsonText, 'utf8')), c.final()]).toString('base64');
}

test('decryptFeishuEncrypt：加密回环 = 原文', () => {
  const plain = JSON.stringify({ type: 'url_verification', token: VTOKEN, challenge: 'ch-enc' });
  const enc = feishuEncrypt(plain, 'encrypt-key-abc');
  assert.equal(decryptFeishuEncrypt(enc, 'encrypt-key-abc'), plain);
});

test('maybeDecryptFeishuBody：{encrypt} → 解出内层 JSON 再分类（challenge 可回显）', () => {
  const inner = { type: 'url_verification', token: VTOKEN, challenge: 'ch-enc' };
  const wrapped = { encrypt: feishuEncrypt(JSON.stringify(inner), 'encrypt-key-abc') };
  const r = maybeDecryptFeishuBody(wrapped, { appId: '', appSecret: '', encryptKey: 'encrypt-key-abc', editThrottleMs: 1500 });
  assert.equal(r.ok, true);
  if (r.ok) {
    const d = classifyFeishuInbound(r.body, cfg());
    assert.deepEqual(d, { kind: 'challenge', challenge: 'ch-enc' });
  }
});

test('maybeDecryptFeishuBody：收到加密但本侧无 key → 如实拒', () => {
  const wrapped = { encrypt: 'AAAA' };
  const r = maybeDecryptFeishuBody(wrapped, { appId: '', appSecret: '', encryptKey: '', editThrottleMs: 1500 });
  assert.equal(r.ok, false);
});

// ── 三、handleFeishuCallback：任务链 + 去重 ──────────────────────────

/** 真 DB（helpers 已 migrate 到终态）：surf_inbound_seen 由 070 迁移建出，
 *  消息去重路径直接打在真表上（同时验收迁移包本身）。缺省自建临时库并由
 *  调用方 cleanup；HTTP harness 传入自己的库，不重复创建。 */
function makeDeps(own?: TempDataDir) {
  const dir = own ?? makeTempDataDir();
  const events: Array<Record<string, unknown>> = [];
  const submits: Array<Record<string, unknown>> = [];
  const threads: Array<{ dotId: string; channel: string; opts?: Record<string, unknown> }> = [];
  const messages: Array<{ threadId: string; content: string }> = [];
  const seen = new Map<string, number>();
  let nextId = 10;
  const deps: FeishuInboundDeps = {
    db: dir.db,
    cp: {
      ingestEvent(req: Record<string, unknown>) {
        events.push(req);
        const key = String(req['dedupKey']);
        if (seen.has(key)) return { eventId: seen.get(key)!, dup: true };
        const id = ++nextId;
        seen.set(key, id);
        return { eventId: id, dup: false };
      },
      submit(req: Record<string, unknown>) {
        submits.push(req);
        return { id: 'tk_fs_1', status: 'queued' } as never;
      },
    } as unknown as ControlPlane,
    mem: {
      async openThread(dotId: string, channel: string, opts?: Record<string, unknown>) {
        threads.push({ dotId, channel, ...(opts !== undefined ? { opts } : {}) });
        return 'th_fs';
      },
      async appendMessage(threadId: string, msg: { content: string }) {
        messages.push({ threadId, content: msg.content });
        return { id: 'm1', seq: 1 };
      },
    } as unknown as MemoryPort,
    bus: { publish() {} },
    cfg: { appId: '', appSecret: '', verificationToken: VTOKEN, encryptKey: '', ownerChatId: OWNER_CHAT, editThrottleMs: 1500 },
  };
  return { deps, events, submits, threads, messages, dir };
}

test('消息回调：openThread(feishu)+appendMessage+submit(priority 1)+202', async () => {
  const { deps, submits, threads, messages, dir } = makeDeps();
  try {
    const out = await handleFeishuCallback(messageBody('ev_10', OWNER_CHAT, '整理今天的 CVE 通报'), deps);
    assert.equal(out.httpStatus, 202);
    assert.equal(threads[0]!.channel, 'feishu');
    assert.equal(messages[0]!.content, '整理今天的 CVE 通报');
    assert.equal(submits[0]!.priority, 1);
    assert.equal(submits[0]!.goal, '整理今天的 CVE 通报');
  } finally {
    dir.cleanup();
  }
});

test('消息重投：同 event_id 第二次 → 200 dup，不再建任务（surf_inbound_seen 真表）', async () => {
  const { deps, submits, events, dir } = makeDeps();
  try {
    const first = await handleFeishuCallback(messageBody('ev_11', OWNER_CHAT, '只做一次'), deps);
    assert.equal(first.httpStatus, 202);
    const second = await handleFeishuCallback(messageBody('ev_11', OWNER_CHAT, '只做一次'), deps);
    assert.equal(second.httpStatus, 200);
    assert.equal(submits.length, 1);
    // 消息路径**不进** CP 事件管线（WSL 实测：进了会被 §6 匹配再建 tk_ev_* 重复任务）
    assert.equal(events.length, 0);
    const row = dir.db.prepare("SELECT source FROM surf_inbound_seen WHERE dedup_key='fs:ev_11'").get() as { source: string };
    assert.equal(row.source, 'feishu');
  } finally {
    dir.cleanup();
  }
});

test('ignore 类消息（bot 回环/非文本）：200 ack，零副作用（不建任务、不落 seen 表、不进事件管线）', async () => {
  const { deps, submits, events, dir } = makeDeps();
  try {
    const botBody = messageBody('ev_13', OWNER_CHAT, '我自己的回复') as Record<string, unknown>;
    (botBody['event'] as Record<string, unknown>)['sender'] = { sender_type: 'app' };
    const out = await handleFeishuCallback(botBody, deps);
    assert.equal(out.httpStatus, 200);
    assert.deepEqual(out.body, { ignored: true, eventId: 'ev_13' });
    const img = await handleFeishuCallback(messageBody('ev_14', OWNER_CHAT, '', 'image'), deps);
    assert.equal(img.httpStatus, 200);
    assert.equal(submits.length, 0);
    assert.equal(events.length, 0);
    const row = dir.db.prepare("SELECT COUNT(*) AS c FROM surf_inbound_seen").get() as { c: number };
    assert.equal(row.c, 0);
  } finally {
    dir.cleanup();
  }
});

test('非消息事件回调：ingestEvent 落流 + 202 ack（dup 时 200）', async () => {
  const { deps, submits, dir } = makeDeps();
  try {
    const body = { schema: '2.0', header: { event_id: 'ev_12', event_type: 'im.chat.updated_v1', token: VTOKEN }, event: {} };
    const out = await handleFeishuCallback(body, deps);
    assert.equal(out.httpStatus, 202);
    const out2 = await handleFeishuCallback(body, deps);
    assert.equal(out2.httpStatus, 200);
    assert.equal(submits.length, 0);
  } finally {
    dir.cleanup();
  }
});

test('token 错的回调：401，不落任何 CP 调用', async () => {
  const { deps, events, submits, dir } = makeDeps();
  try {
    const out = await handleFeishuCallback({ type: 'url_verification', token: 'bad', challenge: 'x' }, deps);
    assert.equal(out.httpStatus, 401);
    assert.equal(events.length, 0);
    assert.equal(submits.length, 0);
  } finally {
    dir.cleanup();
  }
});

// ── 四、真 HTTP：/hooks/feishu 专属通道（无 HMAC 头）─────────────────

function makeFullConfig(feishu: Partial<SurfacesConfig['feishu']> = {}): SurfacesConfig {
  return {
    http: { host: '127.0.0.1', port: 0, masterToken: 'm', readonlyTokens: [], allowedOrigins: [] },
    hooks: [],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: VTOKEN, encryptKey: '', ownerChatId: OWNER_CHAT, editThrottleMs: 1500, ...feishu },
    ui: { streamDeltas: true },
    progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
    brief: { enabled: false, time: '08:30', chatId: null, windowMin: 180, maxChars: 1200 },
    connWatch: { enabled: false, intervalMin: 15, quietHours: null },
  };
}

interface Harness {
  dir: TempDataDir;
  server: Server;
  base: string;
  sse: SseBus;
}

async function startServer(feishu: Partial<SurfacesConfig['feishu']> = {}): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = new SseBus({ db: dir.db, bus });
  const { deps } = makeDeps(dir);
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: deps.cp,
    gov: { decide: () => Promise.resolve({ ok: true }), listPending: () => [], getApproval: () => Promise.resolve(null) } as unknown as GovernancePort,
    mem: deps.mem,
    router: { snapshot: () => ({}) } as unknown as RouterPort,
    channels: null,
    sse,
    cfg: makeFullConfig(feishu),
    webRoot: dir.root,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}`, sse };
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((res) => h.server.close(() => res()));
  h.sse.detach();
  h.dir.cleanup();
}

test('HTTP /hooks/feishu：challenge 握手不带任何 HMAC 头 → 200 {challenge}', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/hooks/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', token: VTOKEN, challenge: 'ch-http' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { challenge: 'ch-http' });
  } finally {
    await close(h);
  }
});

test('HTTP /hooks/feishu：token 不符 → 401 auth', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/hooks/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageBody('ev_http_1', OWNER_CHAT, 'hi')),
    });
    // messageBody 的 header.token = VTOKEN —— 换个坏 token
    const bad = structuredClone(messageBody('ev_http_2', OWNER_CHAT, 'hi')) as Record<string, unknown>;
    (bad['header'] as Record<string, unknown>)['token'] = 'not-the-token';
    const res2 = await fetch(`${h.base}/hooks/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 202); // 正确 token 的消息 → 建任务
    assert.equal(res2.status, 401);
  } finally {
    await close(h);
  }
});

test('HTTP /hooks/feishu：未登记进 hooks[] 也不 401（专属通道先于通用 HMAC）', async () => {
  // makeFullConfig 的 hooks:[] —— 通用路径会因 source 未登记直接 401；
  // feishu 分支在登记检查**之前**短路，能走到 token 校验。
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/hooks/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', token: VTOKEN, challenge: 'c2' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await close(h);
  }
});

test('HTTP /hooks/feishu：加密回调（{encrypt}）→ 解密后回显 challenge', async () => {
  const EK = 'ek-http-key';
  const h = await startServer({ encryptKey: EK });
  try {
    const inner = JSON.stringify({ type: 'url_verification', token: VTOKEN, challenge: 'ch-enc-http' });
    const res = await fetch(`${h.base}/hooks/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ encrypt: feishuEncrypt(inner, EK) }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { challenge: 'ch-enc-http' });
  } finally {
    await close(h);
  }
});
