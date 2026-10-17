/**
 * tests/win-relay.test.ts —— Windows 侧 TCP 中继的 Host 重写回归。
 *
 * 背景（2026-10-17 全方位测试高危"tier2 双断点"第二断点，实测复现）：
 * 中继旧实现只在一条 TCP 连接的首个请求上重写 Host，而 node 的全局 agent 会
 * keep-alive 复用同一条连接，于是 /health 过了、同连接上的 /profile 与
 * /v1/models 全 403（Colibrì 报「Host header '172.17.48.1' not allowed」），
 * warm 闸永远判不热、tier2 降级链实际是断的。curl 每次新连接所以看不出来。
 *
 * 这里起一个**校验 Host 的假上游** + 一个随机端口中继，用 keep-alive agent
 * （maxSockets=1 强制复用同一条连接）连发多个请求，锁死"每条请求都重写"的语义。
 */

import assert from 'node:assert/strict';
import http, { type Agent } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { after, describe, it } from 'node:test';
import { makeRelayServer } from '../scripts/win-relay.mts';

/** 假上游：只认 Host 白名单，其余一律 403（Colibrì /profile 的行为）。 */
const ALLOWED_HOST = '127.0.0.1:8001';

let upstream: Server;
let relay: Server;
let agent: Agent;
let upstreamPort: number;
let relayPort: number;
const seenHosts: string[] = [];

function listen(srv: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
  });
}

/**
 * 收尾：先杀上游连接、再 close。keep-alive 连接不主动断，close() 会一直挂着
 * （node --test 不会强退进程）；杀掉上游连接后中继的上游 socket 报错，
 * 级联把客户端 socket 也断掉，两个 server 才能真正退空。
 * 注意 net.Server 没有 closeAllConnections（只有 http.Server 有）。
 */
function shutdown(up: Server | undefined, relay: Server | undefined): void {
  agent?.destroy();
  (up as (Server & { closeAllConnections?: () => void }) | undefined)?.closeAllConnections?.();
  relay?.close();
  up?.close();
}

after(() => {
  shutdown(upstream, relay);
});

async function setup(hostRewrite?: string): Promise<void> {
  shutdown(upstream, relay); // 上一个用例遗留的连接先断，否则它们会把进程吊住
  seenHosts.length = 0;
  upstream = http.createServer((req, res) => {
    seenHosts.push(req.headers.host ?? '');
    if (hostRewrite !== undefined && req.headers.host !== ALLOWED_HOST) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end("Host header not allowed");
      return;
    }
    if (req.url === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat(chunks)); // 原样回显，用来验分帧没吃掉/多吞字节
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  upstreamPort = await listen(upstream);
  relay = makeRelayServer(upstreamPort, hostRewrite);
  relayPort = await listen(relay);
  agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); // 强制复用同一条 TCP 连接
}

/** 走中继发一次请求，返回状态码与响应体。 */
function viaRelay(
  method: string,
  path: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: relayPort,
        method,
        path,
        agent,
        headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. 逐条重写：keep-alive 连接上的每个请求都要过 Host 校验
// ═══════════════════════════════════════════════════════════════════

describe('win-relay：Host 重写必须逐条做（旧实现只改首条 → 后续全 403）', () => {
  it('同一条 keep-alive 连接连发三个请求，全部 200 且上游看到的 Host 都被改写', async () => {
    await setup('127.0.0.1:8001');
    const paths = ['/health', '/profile', '/v1/models'];
    for (const p of paths) {
      const r = await viaRelay('GET', p);
      assert.equal(r.status, 200, `${p} 应放行（旧实现在第 2 条起 403）`);
      assert.ok(r.body.includes('"ok":true'), `${p} 响应体应来自假上游，实际：${r.body}`);
    }
    assert.deepEqual(seenHosts, [ALLOWED_HOST, ALLOWED_HOST, ALLOWED_HOST]);
  });

  it('不配 hostRewrite 时原样直传（hy3 那条链路不校验 Host）', async () => {
    await setup();
    const r = await viaRelay('GET', '/health');
    assert.equal(r.status, 200);
    // 直传时 Host 是中继地址本身，上游照单全收
    assert.equal(seenHosts[0], `127.0.0.1:${relayPort}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 分帧：请求体按 Content-Length 切，含 CRLFCRLF 也不能切错
// ═══════════════════════════════════════════════════════════════════

describe('win-relay：Content-Length 分帧', () => {
  it('POST 体里含 \\r\\n\\r\\n 也能完整送达（不会把体当请求头切）', async () => {
    await setup('127.0.0.1:8001');
    const payload = Buffer.from('{"prompt":"a\r\n\r\nb","n":2}', 'utf8');
    const r = await viaRelay('POST', '/echo', payload, { 'content-type': 'application/json' });
    assert.equal(r.status, 200);
    assert.equal(r.body, payload.toString('utf8'));
  });

  it('两个请求共用一个 chunk 到达时也各自成帧', async () => {
    await setup('127.0.0.1:8001');
    // 手写一条粘包连接：两个 GET 一次性写完
    const net = await import('node:net');
    const sock = net.createConnection({ host: '127.0.0.1', port: relayPort });
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    const raw =
      `GET /health HTTP/1.1\r\nHost: 172.17.48.1:18001\r\n\r\n` +
      `GET /profile HTTP/1.1\r\nHost: 172.17.48.1:18001\r\n\r\n`;
    sock.write(raw);
    const got = await new Promise<string>((resolve, reject) => {
      let acc = '';
      sock.on('data', (c: Buffer) => {
        acc += c.toString('latin1');
        if (acc.split('HTTP/1.1 200').length - 1 >= 2) resolve(acc);
      });
      sock.on('error', reject);
    });
    sock.destroy();
    assert.equal(got.split('HTTP/1.1 200').length - 1, 2, '两个响应都该回来');
    assert.deepEqual(seenHosts, [ALLOWED_HOST, ALLOWED_HOST]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. chunked 请求体：不切帧，整段直传
// ═══════════════════════════════════════════════════════════════════

describe('win-relay：chunked 请求体直传', () => {
  it('Transfer-Encoding: chunked 的 POST 原样送达', async () => {
    await setup('127.0.0.1:8001');
    const net = await import('node:net');
    const sock = net.createConnection({ host: '127.0.0.1', port: relayPort });
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    const body = 'hello';
    sock.write(
      `POST /echo HTTP/1.1\r\nHost: 172.17.48.1:18001\r\nTransfer-Encoding: chunked\r\n\r\n` +
        `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
    );
    const got = await new Promise<string>((resolve, reject) => {
      let acc = '';
      sock.on('data', (c: Buffer) => {
        acc += c.toString('latin1');
        if (acc.includes('\r\n\r\n')) resolve(acc);
      });
      sock.on('error', reject);
      setTimeout(() => resolve(acc), 500);
    });
    sock.destroy();
    assert.match(got, /HTTP\/1\.1 200/, 'chunked 请求应放行');
  });
});
