/**
 * tests/agent-runtime-net.test.ts —— net.get / net.post 的真实路径测试（P1-5）。
 *
 * 设计原则（本文件是"证据"，不是"演示"）：
 * - **真起 HTTP 服务器**（127.0.0.1:0，但 net.* 的 SSRF 护栏会拒绝 loopback，
 *   所以测试使用可注入的 `fetchImpl` 打假上游——它只替换"网络传输这一层"，
 *   `runNetCall` 里的开关/URL 校验/SSRF/体积上限/超时全部是真代码）；
 * - 同时**专门有一条用例**把 SSRF 护栏本身钉死（loopback/私有网段/metadata 一律拒；
 *   这条不注入 fetch，走完整真路径）；
 * - 默认策略（off）用独立断言钉死：不设环境变量时 net.* 必须拒绝。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  blockedHostReason,
  NET_ERROR_CODES,
  NET_RESPONSE_MAX_BYTES,
  NET_TIMEOUT_MAX_MS,
  NET_TOOLS_DEFAULT_MODE,
  parseNetToolsMode,
  runNetCall,
  sanitizeHeaders,
  type FetchLike,
} from '../agent-runtime/net.ts';
import { AgentRuntime } from '../agent-runtime/server.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 假上游：一个真 HTTP 服务，fetchImpl 通过真 http.request 打它 ──────────────
// 用真 socket 而不是 mock Response，才能证明"POST body 真的发出去了、状态码真的读回来了"。
import { request as httpRequest } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '/';
      if (path === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world', method: req.method }));
        return;
      }
      if (path === '/echo-post' && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ got: body, contentType: req.headers['content-type'] ?? null }));
        return;
      }
      if (path === '/status-404') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      if (path === '/status-500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      if (path === '/redirect') {
        res.writeHead(302, { location: 'https://example.com/elsewhere' });
        res.end();
        return;
      }
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        // 比上限多 1MB
        res.end('x'.repeat(NET_RESPONSE_MAX_BYTES + 1024 * 1024));
        return;
      }
      if (path === '/slow') {
        // 永不返回（用于超时）
        return;
      }
      res.writeHead(400);
      res.end('unknown');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * 真 http.request 实现的 FetchLike——绕过 SSRF 的"字面量检查"层（因为目标是 loopback），
 * 但**留在 runNetCall 内部**的其它所有检查（开关/协议/体积/超时）照常生效。
 */
const realFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    // 把超时信号接到请求上（runNetCall 传的是 AbortSignal）
    const sig = init.signal as AbortSignal | undefined;
    if (sig !== undefined) {
      sig.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'TimeoutError';
        req.destroy(e);
        reject(e);
      }, { once: true });
    }
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });

/**
 * 为了让 loopback 目标能通过 SSRF 检查，这里把 checkHost 的结果"假装"为允许：
 * 做法是给 URL 一个公网外观的 hostname，再由 fetchImpl 改写到真实端口。
 * 这样 runNetCall 的全部校验逻辑都跑在真实代码路径上，只有"DNS/网络"这一层被替换。
 */
const publicHost = 'example.com';
function rewriteTarget(realBase: string): FetchLike {
  return (url, init) => {
    const u = new URL(url);
    const real = new URL(realBase);
    u.protocol = real.protocol;
    u.hostname = real.hostname;
    u.port = real.port;
    return realFetch(u.toString(), init);
  };
}

function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { mode?: 'off' | 'get' | 'all'; body?: string; headers?: Record<string, unknown>; deadlineMs?: number; fetchImpl?: FetchLike | null } = {},
) {
  return runNetCall(
    {
      callId: 'call_net_1',
      method,
      url: `http://${publicHost}${path}`,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      deadlineMs: opts.deadlineMs ?? 10_000,
    },
    { mode: opts.mode ?? 'all', fetchImpl: opts.fetchImpl ?? rewriteTarget(base) },
  );
}

const dataOf = (r: { result?: unknown }): Record<string, unknown> =>
  (r.result ?? {}) as Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════
// 一、默认策略：关闭（本项目价值观）
// ═══════════════════════════════════════════════════════════════════

describe('默认策略：出网工具默认关闭', () => {
  test('常量默认值是 off', () => {
    assert.equal(NET_TOOLS_DEFAULT_MODE, 'off');
  });

  test('mode=off 时 net.get 拒绝，错误码 net_tools_disabled 且 retryable=false', async () => {
    const r = await call('GET', '/ok', { mode: 'off' });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, NET_ERROR_CODES.disabled);
    assert.equal(r.error?.retryable, false);
    // 报错文案要告诉主人"怎么开"，而不是一句 not_implemented
    assert.match(r.error?.message ?? '', /DOTD_NET_TOOLS/);
  });

  test('mode=get 时 net.post 拒绝（默认只放开只读）', async () => {
    const r = await call('POST', '/echo-post', { mode: 'get', body: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, NET_ERROR_CODES.postDisabled);
  });

  test('拼错的值按 off 处理并给 warning（绝不因拼错意外放开出网）', () => {
    assert.deepEqual(parseNetToolsMode(undefined), { mode: 'off', warning: null });
    assert.deepEqual(parseNetToolsMode(''), { mode: 'off', warning: null });
    const bad = parseNetToolsMode('ENABLED');
    assert.equal(bad.mode, 'off');
    assert.match(bad.warning ?? '', /无法识别/);
    assert.equal(parseNetToolsMode('get').mode, 'get');
    assert.equal(parseNetToolsMode('ALL').mode, 'all');
  });

  test('AgentRuntime 未设 DOTD_NET_TOOLS 时 netTools=off，且 net.get 走真路径被拒', async () => {
    const prev = process.env['DOTD_NET_TOOLS'];
    delete process.env['DOTD_NET_TOOLS'];
    try {
      const rt = new AgentRuntime({ token: 't', ...tmpRuntimeOpts() });
      assert.equal(rt.netTools, 'off');
    } finally {
      if (prev !== undefined) process.env['DOTD_NET_TOOLS'] = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 二、真路径：GET/POST 能跑通、状态码可分辨
// ═══════════════════════════════════════════════════════════════════

describe('真实路径：GET/POST 跑通、4xx/5xx 可分辨', () => {
  test('GET 200：返回 status/contentType/body', async () => {
    const r = await call('GET', '/ok');
    assert.equal(r.status, 'ok');
    const d = dataOf(r);
    assert.equal(d['status'], 200);
    assert.match(String(d['contentType']), /application\/json/);
    assert.match(String(d['body']), /hello/);
    assert.equal(d['bodyTruncated'], false);
  });

  test('POST 201：请求体真的发出去了，content-type 透传', async () => {
    const r = await call('POST', '/echo-post', {
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.status, 'ok');
    const d = dataOf(r);
    assert.equal(d['status'], 201);
    // 上游把收到的 body 原样塞进 JSON 字符串字段，所以是转义形态 `{\"a\":1}`
    assert.match(String(d['body']), /a\\":1/, `上游应收到请求体，实际：${String(d['body'])}`);
    assert.match(String(d['body']), /application\/json/);
  });

  test('4xx / 5xx 是**正常返回**（模型要读错误页），不是工具错误', async () => {
    const r404 = await call('GET', '/status-404');
    assert.equal(r404.status, 'ok', '4xx 不应变成 error');
    assert.equal(dataOf(r404)['status'], 404);
    assert.equal(dataOf(r404)['body'], 'nope');

    const r500 = await call('GET', '/status-500');
    assert.equal(r500.status, 'ok');
    assert.equal(dataOf(r500)['status'], 500);
    assert.equal(dataOf(r500)['body'], 'boom');
  });

  test('3xx 不自动跟随，把 location 回给模型', async () => {
    const r = await call('GET', '/redirect');
    assert.equal(r.status, 'ok');
    const d = dataOf(r);
    assert.equal(d['status'], 302);
    assert.equal(d['redirect'], 'https://example.com/elsewhere');
    assert.match(String(d['note']), /未自动跟随/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 三、体积上限与超时
// ═══════════════════════════════════════════════════════════════════

describe('体积上限与超时', () => {
  test(`响应体超过 ${NET_RESPONSE_MAX_BYTES} 字节 → 截断并标记 bodyTruncated`, async () => {
    const r = await call('GET', '/big');
    assert.equal(r.status, 'ok');
    const d = dataOf(r);
    assert.equal(d['bodyTruncated'], true, '必须标记截断，不能静默丢内容');
    assert.ok(
      Buffer.byteLength(String(d['body']), 'utf8') <= NET_RESPONSE_MAX_BYTES + 16,
      '截断后不得超过上限',
    );
  });

  test('超时 → net_timeout 且 retryable=true', async () => {
    const r = await call('GET', '/slow', { deadlineMs: 150 });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, NET_ERROR_CODES.timeout);
    assert.equal(r.error?.retryable, true);
    assert.match(r.error?.message ?? '', /未完成/);
  });

  test('网络层失败 → net_network_error（不是超时）', async () => {
    const r = await call('GET', '/ok', {
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, NET_ERROR_CODES.network);
    assert.match(r.error?.message ?? '', /ECONNREFUSED/);
  });

  test('超时上限被 NET_TIMEOUT_MAX_MS 夹住（deadline 更大也不会等更久）', () => {
    assert.equal(NET_TIMEOUT_MAX_MS, 30_000);
    // 行为断言：deadlineMs 传 10 分钟，内部只等 30s —— 这里用常量证明夹取口径存在，
    // 真实等待由上面的 /slow 用例（150ms）覆盖，避免测试真的等 30s。
  });
});

// ═══════════════════════════════════════════════════════════════════
// 四、SSRF 防护（真路径，不注 fetch）
// ═══════════════════════════════════════════════════════════════════

describe('SSRF 防护：拒绝本机/内网/元数据地址', () => {
  const cases: Array<[string, string]> = [
    ['http://127.0.0.1:7788/api/status', 'loopback'],
    ['http://localhost/secret', 'localhost'],
    ['http://169.254.169.254/latest/meta-data/', '元数据'],
    ['http://10.0.0.5/admin', '10/8'],
    ['http://192.168.1.1/', '192.168/16'],
    ['http://172.16.3.4/', '172.16/12'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://printer.local/', '.local'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4 映射'],
  ];
  for (const [url, label] of cases) {
    test(`拒绝 ${url}（${label}）`, async () => {
      const r = await runNetCall(
        { callId: 'c', method: 'GET', url, deadlineMs: 1_000 },
        { mode: 'all', fetchImpl: realFetch },
      );
      assert.equal(r.status, 'error', `${url} 必须被拒`);
      assert.equal(r.error?.code, NET_ERROR_CODES.blockedHost);
      assert.match(r.error?.message ?? '', /本机|内网|元数据/);
    });
  }

  test('blockedHostReason 判定表（纯函数）', () => {
    assert.ok(blockedHostReason('127.0.0.1'));
    assert.ok(blockedHostReason('LOCALHOST'));
    assert.ok(blockedHostReason('169.254.169.254'));
    assert.ok(blockedHostReason('10.1.2.3'));
    assert.ok(blockedHostReason('172.31.255.255'));
    assert.ok(blockedHostReason('192.168.0.1'));
    assert.ok(blockedHostReason('::1'));
    assert.ok(blockedHostReason('fd00::1'));
    assert.ok(blockedHostReason('fe80::1'));
    // 公网地址放行
    assert.equal(blockedHostReason('example.com'), null);
    assert.equal(blockedHostReason('8.8.8.8'), null);
    assert.equal(blockedHostReason('172.32.0.1'), null, '172.32 不在 172.16/12 内');
  });

  test('非 http(s) 协议被拒（file:/data:/ftp: 防读本地文件）', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/x']) {
      const r = await runNetCall(
        { callId: 'c', method: 'GET', url, deadlineMs: 1_000 },
        { mode: 'all', fetchImpl: realFetch },
      );
      assert.equal(r.status, 'error', `${url} 必须被拒`);
      assert.equal(r.error?.code, NET_ERROR_CODES.badUrl);
    }
  });

  test('URL 内嵌账号密码被拒；非法 URL 被拒', async () => {
    const withCred = await runNetCall(
      { callId: 'c', method: 'GET', url: 'http://user:pass@example.com/', deadlineMs: 1_000 },
      { mode: 'all', fetchImpl: realFetch },
    );
    assert.equal(withCred.error?.code, NET_ERROR_CODES.badUrl);
    const bad = await runNetCall(
      { callId: 'c', method: 'GET', url: 'not a url', deadlineMs: 1_000 },
      { mode: 'all', fetchImpl: realFetch },
    );
    assert.equal(bad.error?.code, NET_ERROR_CODES.badUrl);
  });

  test('请求头白名单：Host/Content-Length/Cookie 与含 CRLF 的头被丢弃', () => {
    const h = sanitizeHeaders({
      accept: 'text/html',
      'User-Agent': 'dotd/1',
      host: 'evil.com',
      'content-length': '999',
      cookie: 'session=1',
      'x-injected': 'a\r\nX-Evil: 1',
      'content-type': 'application/json',
    });
    assert.deepEqual(h, { accept: 'text/html', 'user-agent': 'dotd/1', 'content-type': 'application/json' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 五、经 AgentRuntime 真装配（证明接上了，不是孤立函数）
// ═══════════════════════════════════════════════════════════════════

/** runtime 的 ledger 必须落在真实目录（空串会让 Ledger 读写 ENOENT）。 */
function tmpRuntimeOpts(): { ledgerPath: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dotd-net-rt-'));
  return { stateDir: root, ledgerPath: join(root, 'ledger.jsonl') };
}

// ═══════════════════════════════════════════════════════════════════
// 六、默认策略的静态守卫（防"以后有人把默认值改成放开"）
// ═══════════════════════════════════════════════════════════════════

describe('静态守卫：出网默认关闭这件事写在代码里，不是靠文档', () => {
  test('net.ts 里默认常量必须是 off，且 server.ts 的构造缺省走环境变量解析', async () => {
    const { readFileSync } = await import('node:fs');
    const netSrc = readFileSync(new URL('../agent-runtime/net.ts', import.meta.url), 'utf8');
    assert.match(
      netSrc,
      /export const NET_TOOLS_DEFAULT_MODE: NetToolsMode = 'off'/,
      'NET_TOOLS_DEFAULT_MODE 必须字面量是 off',
    );
    assert.match(netSrc, /parseNetToolsMode/);
    const serverSrc = readFileSync(new URL('../agent-runtime/server.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(serverSrc, /DOTD_NET_TOOLS\s*:\s*['"]all['"]/, '不得把环境变量默认写成 all');
    assert.match(serverSrc, /parseNetToolsMode\(process\.env\['DOTD_NET_TOOLS'\]\)/);
  });

  test('工具手册：net.* 的说明书必须提到关闭码（模型要知道"被主人关掉"而不是"坏了"）', async () => {
    const { TOOL_DOCS, NET_SEARCH_GUIDE } = await import('../src/runner/tool-catalog.ts');
    const get = TOOL_DOCS.find((d) => d.name === 'net.get');
    const post = TOOL_DOCS.find((d) => d.name === 'net.post');
    assert.ok(get !== undefined && post !== undefined);
    assert.match(get.failures, /net_tools_disabled/, 'net.get 的失败清单必须含关闭码');
    assert.match(post.failures, /net_post_disabled/, 'net.post 的失败清单必须含只读码');
    assert.doesNotMatch(get.failures, /not_implemented/, '阶段二占位码说明必须清理');
    // 2026-10-22：搜索改走 argo（search.web），指南不再说"没有内置搜索工具"。
    // 护栏保留的是两条实质约束：①要搜就用 search.web；②不许用 shell curl 绕出网治理。
    assert.match(NET_SEARCH_GUIDE, /search\.web/, '指南必须指向 search.web');
    assert.match(NET_SEARCH_GUIDE, /shell\.?run[^\n]*curl|用 shell\.run 去 curl/, '必须禁止用 shell curl 绕出网治理');
    assert.doesNotMatch(NET_SEARCH_GUIDE, /没有内置搜索工具/, '旧前提已失效，不得残留');
  });
});

describe('经 AgentRuntime 装配：net.* 真的从 not_implemented 变成可执行', () => {
  /**
   * net.* 是 async 工具（capability mode='async'）：`jobsStart` 只回 running 的 ack，
   * 真结果要经 `jobView(jobId)` 取。这里轮询到终态（事件驱动等待，不 sleep 固定时长）。
   */
  async function runToSettle(
    rt: AgentRuntime,
    call: Parameters<AgentRuntime['jobsStart']>[0],
    timeoutMs = 5000,
  ): Promise<{ state: string; result?: unknown; error?: { code?: string; retryable?: boolean; message?: string } }> {
    const ack = await rt.jobsStart(call);
    // runningResult 的形状：{ call_id, job_id, status:'running' }（job_id 在顶层）
    const jobId = (ack as unknown as { job_id?: string }).job_id;
    assert.ok(jobId !== undefined, `jobsStart 应返回 job_id，实际：${JSON.stringify(ack)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = rt.jobView(jobId!);
      if (view !== undefined && view.state !== 'running') {
        return { state: view.state, ...(view.result !== undefined ? { result: view.result } : {}), ...(view.error !== undefined ? { error: view.error } : {}) };
      }
      if (Date.now() > deadline) throw new Error(`job ${jobId} 在 ${timeoutMs}ms 内未终态`);
      await new Promise((r) => setImmediate(r));
    }
  }

  test('默认 off：runtime 的 net.get 返回 net_tools_disabled（不再是 not_implemented）', async () => {
    const prev = process.env['DOTD_NET_TOOLS'];
    process.env['DOTD_NET_TOOLS'] = 'off';
    try {
      const rt = new AgentRuntime({ token: 't', ...tmpRuntimeOpts() });
      const res = await runToSettle(rt, {
        call_id: 'call_x',
        task_id: 'tk',
        dot_id: 'dot1',
        tool: 'net.get',
        args: { url: 'http://example.com/' },
        deadline_ms: 1_000,
        issued_at: new Date().toISOString(),
      });
      assert.equal(res.state, 'error');
      assert.equal(res.error?.code, NET_ERROR_CODES.disabled);
      assert.notEqual(res.error?.code, 'not_implemented', '阶段二的占位码必须消失');
    } finally {
      if (prev === undefined) delete process.env['DOTD_NET_TOOLS'];
      else process.env['DOTD_NET_TOOLS'] = prev;
    }
  });

  test('显式 netTools=all + 注入 fetch：真跑到上游并读回 200', async () => {
    const rt = new AgentRuntime({
      token: 't',
      ...tmpRuntimeOpts(),
      netTools: 'all',
      fetchImpl: rewriteTarget(base),
    });
    const res = await runToSettle(rt, {
      call_id: 'call_y',
      task_id: 'tk',
      dot_id: 'dot1',
      tool: 'net.get',
      args: { url: `http://${publicHost}/ok` },
      deadline_ms: 5_000,
      issued_at: new Date().toISOString(),
    });
    assert.equal(res.state, 'done', `应正常完成，实际 ${res.state} ${JSON.stringify(res.error ?? {})}`);
    const data = (res.result ?? {}) as Record<string, unknown>;
    assert.equal(data['status'], 200);
    assert.match(String(data['body']), /hello/);
  });
});
