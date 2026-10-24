#!/usr/bin/env node
/**
 * scripts/fake-device.mjs —— 假语音设备（阶段 2 验收，2026-10-23）。
 *
 * 它扮演一台 ESP32 之外的「哑终端」：只持设备令牌，只会说一句话、只会听回话。
 * 用来证明这套链路真的通，而不是文档里写着通：
 *
 *   POST /api/device/turn        （文本进）
 *     → GET /api/device/stream   （SSE：首条增量时间）
 *     → GET /api/device/tasks/:id（终态 + 可播报正文）
 *     → GET /api/tasks/:id/proof （设备/会话/步骤，用 master token 读）
 *
 * 用法：
 *   node scripts/fake-device.mjs --create --text "帮我把今天的报价单核对一下"
 *   node scripts/fake-device.mjs --runs 5 --json
 *
 * 环境变量：
 *   DOTD_BASE_URL      默认 http://127.0.0.1:7788
 *   DOTD_MASTER_TOKEN  创建/吊销设备、读凭证时需要
 *   DOTD_DEVICE_TOKEN  已有设备令牌（可跳过 --create）
 *
 * 退出码：0 = 任务 done 且拿到正文；1 = 失败/超时（明细照实打印）。
 */

import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const BASE = (arg('base') ?? process.env.DOTD_BASE_URL ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
const MASTER = arg('master') ?? process.env.DOTD_MASTER_TOKEN ?? '';
const DEVICE_TOKEN = arg('device-token') ?? process.env.DOTD_DEVICE_TOKEN ?? '';
const TEXT = arg('text') ?? '帮我把今天的报价单核对一下';
const RUNS = Math.max(1, Number(arg('runs') ?? 1) || 1);
const TIMEOUT_MS = Math.max(1000, Number(arg('timeout') ?? 90_000) || 90_000);
const CREATE = arg('create', false) !== false;
const JSON_OUT = arg('json', false) !== false;
const REVOKE = arg('revoke', false) !== false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', token = MASTER, body, stream = false } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (stream) return res;
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

/** 创建一个一次性设备；返回 {id, token}。 */
async function createDevice(name = `fake-dev-${randomBytes(2).toString('hex')}`) {
  if (!MASTER) throw new Error('需要 DOTD_MASTER_TOKEN 才能创建设备');
  const r = await api('/api/devices', { method: 'POST', body: { name } });
  if (r.status !== 201 || typeof r.body?.token !== 'string') {
    throw new Error(`创建设备失败：HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { id: r.body.id, token: r.body.token, name };
}

/**
 * 订阅设备流并等终态。
 * 返回 {firstDeltaMs, finalText, terminalMs, reason}。
 */
async function watchStream(token, taskId, startedAt, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let firstDeltaMs = null;
  let finalText = null;
  let terminalMs = null;
  try {
    const res = await fetch(`${BASE}/api/device/stream?task=${encodeURIComponent(taskId)}`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (res.status !== 200 || res.body === null) {
      return { firstDeltaMs, finalText, terminalMs, reason: `stream HTTP ${res.status}` };
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = '';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        // `data:` 是整条总线事件 `{seq,channel,kind,at,dotId,payload}`，
        // taskId / text 都在 payload 里；老格式（扁平的）也一并兼容。
        const payload =
          ev !== null && typeof ev === 'object' && ev.payload !== null && typeof ev.payload === 'object'
            ? ev.payload
            : ev;
        if (payload?.taskId !== taskId) continue;
        // SseBus 发出的是 `<channel>.<kind>`（chat.chat.delta / approval.approval.pending），
        // 这里只关心 kind 部分，否则永远匹配不上。
        const kind = event.includes('.') ? event.slice(event.indexOf('.') + 1) : event;
        const now = Date.now() - startedAt;
        if (firstDeltaMs === null && (kind === 'chat.delta' || kind === 'chat.final')) {
          firstDeltaMs = now;
        }
        if (kind === 'chat.final') {
          finalText = typeof payload.text === 'string' ? payload.text : finalText;
          terminalMs = now;
          ctrl.abort();
          return { firstDeltaMs, finalText, terminalMs, reason: null };
        }
        if (kind === 'approval.pending') {
          terminalMs = now;
          ctrl.abort();
          return { firstDeltaMs, finalText, terminalMs, reason: 'needs_owner' };
        }
      }
    }
    return { firstDeltaMs, finalText, terminalMs, reason: 'stream closed' };
  } catch (err) {
    if (err?.name === 'AbortError') {
      // 调用方在任务收口后主动断开：不是超时，别把原因写错。
      return { firstDeltaMs, finalText, terminalMs, reason: 'stream closed' };
    }
    return { firstDeltaMs, finalText, terminalMs, reason: String(err) };
  } finally {
    clearTimeout(deadline);
  }
}

/** 轮询到终态（SSE 丢帧时的兜底）。 */
async function pollTask(token, taskId, startedAt, signal) {
  const terminal = new Set(['done', 'failed', 'cancelled']);
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (signal?.aborted) break;
    const r = await api(`/api/device/tasks/${encodeURIComponent(taskId)}`, { token });
    if (r.status === 200) {
      const status = r.body?.task?.status;
      if (terminal.has(status) || status === 'awaiting_approval' || status === 'paused') {
        return {
          status,
          reply: typeof r.body?.reply === 'string' ? r.body.reply : null,
          stateLine: r.body?.summary?.stateLine ?? null,
          atMs: Date.now() - startedAt,
        };
      }
    }
    await sleep(350);
  }
  return { status: 'timeout', reply: null, stateLine: null, atMs: Date.now() - startedAt };
}

async function oneRun(deviceToken, text, index) {
  const startedAt = Date.now();
  const submitted = await api('/api/device/turn', {
    method: 'POST',
    token: deviceToken,
    body: { text },
  });
  if (submitted.status !== 202 || typeof submitted.body?.taskId !== 'string') {
    return {
      index,
      ok: false,
      reason: `turn HTTP ${submitted.status} ${JSON.stringify(submitted.body)}`,
    };
  }
  const { taskId, threadId } = submitted.body;

  // SSE 是用来量「首条增量」的；终态以轮询为准 —— 任务收口不保证一定有 chat.final
  // （例如纯工具轮），不能让量延迟的通道反过来决定成败。
  const streamCtrl = new AbortController();
  const streamPromise = watchStream(deviceToken, taskId, startedAt, streamCtrl.signal);
  const polled = await pollTask(deviceToken, taskId, startedAt);
  // 终态检测是 350ms 轮询，SSE 帧可能还在 socket 缓冲里；先让它读完再断开，
  // 否则量到的「首条增量」永远是 null（实测：hy3 的 delta 与 final 几乎同一刻到达）。
  await sleep(700);
  streamCtrl.abort();
  const stream = await streamPromise;

  const reply = stream.finalText ?? polled.reply ?? null;
  const status = polled.status !== 'timeout' ? polled.status : stream.reason === 'needs_owner' ? 'awaiting_approval' : 'done';
  const endToEndMs = polled.atMs;

  let proof = null;
  if (MASTER) {
    const p = await api(`/api/tasks/${encodeURIComponent(taskId)}/proof`, { token: MASTER });
    if (p.status === 200) {
      proof = {
        bundleHash: p.body?.bundleHash ?? null,
        steps: Array.isArray(p.body?.steps) ? p.body.steps.length : 0,
        approvals: Array.isArray(p.body?.approvals) ? p.body.approvals.length : 0,
        device: p.body?.device ?? null,
      };
    }
  }

  return {
    index,
    ok: status === 'done' && typeof reply === 'string' && reply.length > 0,
    taskId,
    threadId,
    deviceId: submitted.body.deviceId,
    status,
    firstDeltaMs: stream.firstDeltaMs,
    endToEndMs,
    reply,
    streamReason: stream.reason,
    proof,
  };
}

function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
  return xs[Math.max(0, idx)];
}

async function main() {
  let device = DEVICE_TOKEN ? { token: DEVICE_TOKEN, id: null, ephemeral: false } : null;
  if (device === null) {
    if (!CREATE) throw new Error('没有设备令牌，也没有 --create（或用 DOTD_DEVICE_TOKEN）');
    device = { ...(await createDevice()), ephemeral: true };
  }

  const results = [];
  for (let i = 0; i < RUNS; i += 1) {
    results.push(await oneRun(device.token, TEXT, i));
  }

  const ok = results.filter((r) => r.ok).length;
  const summary = {
    ok: ok === results.length,
    device: { id: device.id, name: device.name ?? null },
    runs: results.length,
    passed: ok,
    firstDeltaP50Ms: percentile(results.map((r) => r.firstDeltaMs), 50),
    endToEndP50Ms: percentile(results.map((r) => r.endToEndMs), 50),
    endToEndP95Ms: percentile(results.map((r) => r.endToEndMs), 95),
    proofSteps: results[0]?.proof?.steps ?? null,
    bundleHash: results[0]?.proof?.bundleHash ?? null,
    results,
  };

  if (device.ephemeral && REVOKE && MASTER && device.id) {
    const r = await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    summary.revoked = r.status === 200;
  }

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(`设备 ${device.id ?? '(已有令牌)'} · ${summary.passed}/${summary.runs} 成功`);
    console.log(
      `首条增量 P50 ${summary.firstDeltaP50Ms ?? '—'}ms · 端到端 P50 ${summary.endToEndP50Ms ?? '—'}ms · P95 ${summary.endToEndP95Ms ?? '—'}ms`,
    );
    if (summary.bundleHash) {
      console.log(`凭证 ${summary.bundleHash.slice(0, 16)}… · 步骤 ${summary.proofSteps}`);
    }
    for (const r of results) {
      console.log(`  [${r.index}] ${r.status} · ${r.endToEndMs}ms · ${(r.reply ?? r.reason ?? '').slice(0, 60)}`);
    }
  }
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((err) => {
  const payload = { ok: false, error: String(err?.message ?? err) };
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else console.error(payload.error);
  process.exitCode = 1;
});
