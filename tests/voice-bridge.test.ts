/**
 * tests/voice-bridge.test.ts —— Charlie → dotd 单轮桥（2026-10-23）。
 *
 * 这里不测 Charlie 的 ASR/TTS，只测**接缝**：Python 桥能不能按 dotd 的既有 HTTP 合同
 * 提交、轮询、取回复、拿凭证。用假 dotd（随机端口）跑真 Python 子进程，
 * 所以证明的是「协议对得上」，不是「真模型能回答」。
 *
 * 没装 Python 时跳过（不把 Node 门禁绑在 Python 上）；本机 Python 3.11 实跑为绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from '../scripts/lib/python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BRIDGE = join(REPO, 'voice', 'integration', 'dotd_bridge.py');

const PY = resolvePython({
  repoRoot: REPO,
  run: (bin, argv) => spawnSync(bin, argv, { encoding: 'utf8' }),
})?.bin ?? null;
const skip = PY === null || !existsSync(BRIDGE) ? '本机没有 Python 或缺少 voice/integration/dotd_bridge.py' : false;

interface Harness {
  server: Server;
  base: string;
  close(): Promise<void>;
  calls: string[];
  bodies: Array<Record<string, unknown>>;
}

async function startFakeDotd(opts: {
  statuses?: string[];
  messages?: Array<Record<string, unknown>>;
  proofHash?: string | null;
  onAuth?: (auth: string | undefined) => boolean;
}): Promise<Harness> {
  const statuses = [...(opts.statuses ?? ['running', 'running', 'done'])];
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (opts.onAuth !== undefined && !opts.onAuth(req.headers.authorization)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        send(202, { taskId: 'tk1', threadId: 'th1', status: 'queued' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks/tk1') {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      send(200, { task: { id: 'tk1', status }, summary: { stateLine: '正在处理' } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      send(200, { threadId: 'th1', messages: opts.messages ?? [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks/tk1/proof') {
      if (opts.proofHash === null) {
        send(404, { error: 'not_found' });
      } else {
        send(200, { bundleHash: opts.proofHash ?? 'f'.repeat(64) });
      }
      return;
    }
    send(404, { error: 'not_found', path: url.pathname });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    calls,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function runBridge(args: string[], base: string, token = 'test-token'): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      PY!,
      ['-m', 'voice.integration.dotd_bridge', ...args],
      {
        cwd: REPO,
        env: { ...process.env, DOTD_BASE_URL: base, DOTD_TOKEN: token, DOTD_TIMEOUT: '8' },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

test('桥：提交 → 轮询 → 取 assistant 正文 → 带 bundleHash', { skip, timeout: 30_000 }, async () => {
  const h = await startFakeDotd({
    statuses: ['running', 'running', 'done'],
    messages: [
      { role: 'user', kind: 'text', content: '把报价单核对一下' },
      { role: 'system', kind: 'tool_result', content: '{"ok":true}' },
      { role: 'assistant', kind: 'text', content: '核对完了，两处异常已标出。' },
    ],
  });
  try {
    const r = await runBridge(['--json', '把报价单核对一下'], h.base);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out.ok, true);
    assert.equal(out.status, 'done');
    assert.equal(out.taskId, 'tk1');
    assert.equal(out.threadId, 'th1');
    assert.equal(out.reply, '核对完了，两处异常已标出。');
    assert.equal(out.proofHash, 'f'.repeat(64));
    assert.deepEqual(h.bodies[0], { text: '把报价单核对一下' });
    assert.ok(h.calls.includes('GET /api/conversations?thread=th1&limit=30'));
    assert.ok(h.calls.includes('GET /api/tasks/tk1/proof'));
  } finally {
    await h.close();
  }
});

test('桥：awaiting_approval 不假装完成（needsOwner=true，退出码 1）', { skip, timeout: 30_000 }, async () => {
  const h = await startFakeDotd({ statuses: ['awaiting_approval'] });
  try {
    const r = await runBridge(['--json', '发一封邮件'], h.base);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out.ok, false);
    assert.equal(out.status, 'awaiting_approval');
    assert.equal(out.needsOwner, true);
    assert.match(String(out.reason), /主人确认/);
    assert.equal(h.calls.some((c) => c.includes('/proof')), false, '没到终态就不该去导凭证');
  } finally {
    await h.close();
  }
});

test('桥：dotd 不可达 → status=unreachable，退出码 1（不是静默成功）', { skip, timeout: 20_000 }, async () => {
  const r = await runBridge(['--json', '你好'], 'http://127.0.0.1:9');
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(out.ok, false);
  assert.equal(out.status, 'unreachable');
  assert.match(String(out.reason), /不可达/);
});

test('桥：缺 DOTD_TOKEN → status=config，退出码 2', { skip, timeout: 20_000 }, async () => {
  const r = await runBridge(['--json', '你好'], 'http://127.0.0.1:9', '');
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(out.status, 'config');
  assert.match(String(out.reason), /DOTD_TOKEN/);
});

test('桥：dotd 401 要原样报出来，不吞成「没有回复」', { skip, timeout: 20_000 }, async () => {
  const h = await startFakeDotd({ onAuth: (auth) => auth === 'Bearer good' });
  try {
    const r = await runBridge(['--json', '你好'], h.base, 'bad');
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out.status, 'unreachable');
    assert.match(String(out.reason), /HTTP 401/);
  } finally {
    await h.close();
  }
});
