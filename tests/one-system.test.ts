/**
 * tests/one-system.test.ts —— 阶段 1「一套壳」（2026-10-23）。
 *
 * 守四件事：
 *   1. `--check` 能在一个临时 home 里解析出配置/token/端口/控制台产物；
 *   2. `/health` 聚合 voice + kernel，而不是只报 Charlie；
 *   3. `/console/api/*` 反代到 dotd，并在**服务端**注入 master token；
 *   4. token 不会从浏览器 query 透传（`?token=...` 被剥掉）。
 *
 * 这里不证明 dotd 真能起任务，也不证明 Charlie 的完整依赖都装好了——
 * 只证明「壳」的协议与鉴权边界。需要 Python + fastapi/uvicorn/httpx。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function pythonBin(): string | null {
  for (const bin of process.env.DOTD_PYTHON ? [process.env.DOTD_PYTHON] : ['python', 'python3']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const PY = pythonBin();
const depsOk =
  PY !== null &&
  spawnSync(PY, ['-c', 'import fastapi, uvicorn, httpx'], { encoding: 'utf8' }).status === 0;
const skip = depsOk ? false : '本机没有 Python 或缺少 fastapi/uvicorn/httpx';

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolvePromise(port));
    });
    s.on('error', reject);
  });
}

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'charlie-one-'));
  writeFileSync(
    join(dir, 'config.yml'),
    ['surfaces:', '  http:', '    host: 127.0.0.1', '    port: 7790', '    master_token: "test-token"', ''].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'tokens.env'), 'export DOTD_MASTER_TOKEN="test-token"\n', 'utf8');
  return dir;
}


interface FakeDotd {
  server: Server;
  port: number;
  seen: Array<{ path: string; auth: string | undefined; query: string }>;
  close(): Promise<void>;
}

async function startFakeDotd(): Promise<FakeDotd> {
  const seen: FakeDotd['seen'] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push({ path: url.pathname, auth: req.headers.authorization, query: url.search });
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'dotd', apiVersion: 1 }));
      return;
    }
    if (url.pathname === '/api/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [], generatedAt: 1 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxied');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    server,
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('--check：临时 home → 配置、token、端口、控制台都解析出来', { skip, timeout: 30_000 }, () => {
  const home = makeHome();
  try {
    const r = spawnSync(PY!, ['-m', 'voice.integration.one_system', '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, CHARLIE_HOME: home, DOTD_CONFIG: '', DOTD_HOME: '', DOTD_CONFIG_DIR: '' },
      timeout: 20_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out.ok, true);
    assert.equal(out.home, home);
    assert.equal(out.token, 'set');
    assert.equal(out.dotdPort, 7790);
    assert.equal(out.consoleBuilt, true);
    assert.equal(out.apiVersion, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('代理壳：/health 聚合、/console/api 注入 token、query token 被剥掉', { skip, timeout: 60_000 }, async () => {
  const home = makeHome();
  const fake = await startFakeDotd();
  // freePort() 只保证「此刻」空闲；并行测试可能在我们 spawn 前抢走同一端口，
  // 结果 curl 打到别人的 404 上。启动失败就换端口重试。
  let child: ChildProcess | null = null;
  let port = 0;
  let stderr = '';
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    port = await freePort();
    stderr = '';
    const candidate = spawn(
      PY!,
      [
        '-m',
        'voice.integration.one_system',
        '--proxy-only',
        '--port',
        String(port),
        '--dotd-port',
        String(fake.port),
        '--token',
        'test-token',
      ],
      {
        cwd: REPO,
        env: { ...process.env, CHARLIE_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    candidate.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline && candidate.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        lastError = `health=${res.status}`;
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (ready) {
      child = candidate;
      break;
    }
    candidate.kill();
    await new Promise((r) => setTimeout(r, 200));
    lastError += `; exit=${candidate.exitCode}; stderr=${stderr.slice(-300)}`;
  }
  assert.ok(child !== null, `代理壳没有就绪：${lastError}`);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const h = (await health.json()) as Record<string, unknown>;
    assert.equal(h.voice, 'ok');
    assert.equal(h.kernel, 'proxy-only');

    const api = await fetch(`http://127.0.0.1:${port}/console/api/health`);
    assert.equal(api.status, 200);
    const body = (await api.json()) as { apiVersion: number; service: string };
    assert.equal(body.service, 'dotd');
    assert.equal(body.apiVersion, 1);
    assert.equal(fake.seen.at(-1)?.auth, 'Bearer test-token', '服务端必须注入 master token');

    // 浏览器带来的 token 不能透传（proxy 会剥掉并换成服务端的）
    const feed = await fetch(`http://127.0.0.1:${port}/console/api/feed?limit=1&token=browser-token`);
    assert.equal(feed.status, 200);
    const last = fake.seen.at(-1)!;
    assert.equal(last.query.includes('token='), false, 'query 里的 token 必须被剥掉');
    assert.equal(last.query.includes('limit=1'), true);

    // 控制台静态页挂在 /console/
    const page = await fetch(`http://127.0.0.1:${port}/console/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /<div id="root">|<script/);
  } finally {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    if (stderr.includes('Traceback')) {
      console.error(stderr);
    }
  }
});
