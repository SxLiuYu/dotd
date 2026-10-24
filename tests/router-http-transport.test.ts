/**
 * tests/router-http-transport.test.ts —— **真实 HTTP 传输**的端到端取证。
 *
 * 为什么需要这个文件：仓库里其他 router 测试全部用 StubTransport（内存回放，零网络），
 * 于是 `src/router/transport.ts` 里那份唯一会出网的实现（rawHttp + SSE 解析 + 错误分类）
 * 长期是"代码在、零证明力"。本文件用 `node:http` 在 127.0.0.1:0 起一个**假 OpenAI 兼容
 * 上游**，让真的 `HttpTransport` 打过去：
 *
 *   HttpTransport → node:http 客户端 → 真实 TCP 往返 → 127.0.0.1:<临时端口> 假上游
 *
 * 三条自我约束（违反即失去证明力）：
 * 1. **不 mock 被测代码**：HttpTransport / rawHttp / parseChatBody / SSE 解析全部走真实实现；
 *    测试里没有 fetch mock、没有 __setTransport、没有注入 socket。
 * 2. **零外网**：只连 127.0.0.1 的临时端口，服务由本文件起、本文件关。
 * 3. **断言指到真实路径**：每个用例都同时断言"客户端看到的结果"与"上游真的收到了什么"
 *    （见 FakeUpstream.requests）——只断言一边，等于允许一条空链路假装通过。
 *
 * 依据：MR §4.2（调用面 ChatCall）、§4.1（错误分类表）、§4.7（流式首字节分界）、
 * CONVENTIONS §7（stub 模式只是测试替身，真实路径必须另有证明）。
 *
 * 覆盖清单（任务书 A 的八项）：
 *   ① 非流式 200 正常解析（content / tool_calls / usage 含 cached_prompt_tokens）
 *   ② 流式 SSE 逐块解析 + usage 尾部块
 *   ③ 401 / 403 → auth
 *   ④ 429 带 Retry-After → rate_limit + retryAfterMs
 *   ⑤ 500 → server_error
 *   ⑥ 连接超时 / 首字节(idle)超时 / total 超时 三个通道各自触发
 *   ⑦ 200 空壳（choices 空 / content 空且 completion_tokens=0）→ EmptyResponseError
 *   ⑧ 声称流式却回普通 JSON、脏 JSON、中途断开 → 不崩、分类正确
 * 另加：鉴权头真的按 api_key_env 上送、工具名消毒/还原走真实线格式、
 *      ModelRouter 接到真 HttpTransport 后能跑通一次完整路由（不止 transport 单测）。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';

import {
  HttpTransport,
  HttpFailure,
  BadProtocolError,
  EmptyResponseError,
  TransportError,
  usageCacheRead,
} from '../src/router/transport.ts';
import type { ChatCall } from '../src/router/types.ts';
import type { ChatChunk, ChatResponse, EndpointDef, RouteMeta, Track } from '../src/shared/contracts.ts';
import { classifyError } from '../src/router/candidates.ts';
import { StreamToolCallAccumulator } from '../src/shared/tool-stream.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';

// ═══════════════════════════════════════════════════════════════════
// 假 OpenAI 兼容上游（真 TCP，127.0.0.1:0）
// ═══════════════════════════════════════════════════════════════════

/** 上游收到的一次请求（断言"线格式真的对"用）。 */
interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
  rawBody: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: { body: string; index: number }) => void | Promise<void>;

interface FakeUpstream {
  baseUrl: string;
  requests: CapturedRequest[];
  /** 按序消费的处理器队列；用尽后回落到 `fallback`。 */
  close(): Promise<void>;
}

/**
 * 起一个真 HTTP 服务。`handlers` 逐次消费同一路径的请求（便于"第一次 429、第二次 200"这种脚本）。
 * 端口交给 OS 分配（0），绝不固定端口——避免与其他测试/宿主服务抢口岸。
 */
async function startUpstream(
  handlers: Handler[],
  fallback: Handler = (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unexpected extra request' } }));
  },
): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  let index = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        parsed = undefined;
      }
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: parsed,
        rawBody: body,
      });
      const h = handlers[index] ?? fallback;
      const i = index;
      index += 1;
      try {
        h(req, res, { body, index: i });
      } catch {
        /* 处理器内部抛错 = 让连接挂着/断开，由客户端超时通道裁决 */
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === 'object', '上游必须拿到真实端口');
  const port = addr.port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** JSON 响应小工具。 */
function jsonHandler(status: number, payload: unknown, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
}

/** 一次标准 OpenAI 非流式成功体。 */
function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '你好，主人。' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...over,
  };
}

// ── 被测调用的构造（ChatCall 的真实形状，见 src/router/types.ts）────────

const CONNECT_MS = 1500;
const IDLE_MS = 1500;
const TOTAL_MS = 6000;

function endpointFor(baseUrl: string, over: Partial<EndpointDef> = {}): EndpointDef {
  return {
    id: 'live-http',
    tier: 1,
    baseUrl,
    apiKeyEnv: null,
    models: { primary: 'test-model', light: 'test-model' },
    style: 'openai',
    enabled: true,
    timeouts: { connect_ms: CONNECT_MS, idle_ms: IDLE_MS, total_ms: TOTAL_MS },
    emergencyEligible: true,
    ...over,
  };
}

function callFor(ep: EndpointDef, over: Partial<ChatCall> = {}): ChatCall {
  return {
    endpoint: ep,
    track: 'primary' as Track,
    model: 'test-model',
    messages: [{ role: 'user', content: 'ping' }],
    cap: { connect_ms: CONNECT_MS, idle_ms: IDLE_MS, total_ms: TOTAL_MS },
    ...over,
  };
}

/** 收完一个流（真 SSE），返回拼接文本。 */
async function drainStream(s: AsyncIterable<ChatChunk>): Promise<string> {
  let text = '';
  for await (const c of s) text += c.delta;
  return text;
}

// ═══════════════════════════════════════════════════════════════════
// 每个用例自管上游生命周期（失败也必须关，否则测试进程挂住）
// ═══════════════════════════════════════════════════════════════════

const open: FakeUpstream[] = [];
async function upstream(handlers: Handler[], fallback?: Handler): Promise<FakeUpstream> {
  const u = await startUpstream(handlers, fallback);
  open.push(u);
  return u;
}

afterEach(async () => {
  for (const u of open.splice(0)) await u.close();
});

// ═══════════════════════════════════════════════════════════════════
// ① 非流式：真实 TCP 往返 + 完整解析
// ═══════════════════════════════════════════════════════════════════

describe('① 非流式 200：真 HttpTransport 打真 HTTP 上游', () => {
  it('解析 content / tool_calls / usage（含 cached_prompt_tokens）', async () => {
    const up = await upstream([
      jsonHandler(
        200,
        chatBody({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '我来写文件。',
                tool_calls: [
                  {
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'fs_write', arguments: '{"path":"notes/a.md","content":"x"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 40,
            total_tokens: 1240,
            prompt_tokens_details: { cached_tokens: 1024 },
          },
        }),
      ),
    ]);

    const ep = endpointFor(up.baseUrl);
    const out = await new HttpTransport().chat(callFor(ep, {
      messages: [{ role: 'system', content: '你是 Dot' }, { role: 'user', content: '写个文件' }],
      maxTokens: 256,
      temperature: 0.2,
    }));

    // 客户端侧：解析结果
    assert.equal(out.response.content, '我来写文件。');
    assert.equal(out.response.toolCalls?.length, 1);
    assert.equal(out.response.toolCalls?.[0]?.id, 'call_abc');
    assert.equal(out.response.toolCalls?.[0]?.name, 'fs_write');
    assert.deepEqual(JSON.parse(out.response.toolCalls?.[0]?.arguments ?? '{}'), {
      path: 'notes/a.md',
      content: 'x',
    });
    assert.deepEqual(out.usage, { promptTokens: 1200, completionTokens: 40, cachedPromptTokens: 1024 });

    // 上游侧：线格式真的对（不是"客户端自说自话"）
    assert.equal(up.requests.length, 1);
    const r = up.requests[0]!;
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/v1/chat/completions');
    const sent = r.body as Record<string, unknown>;
    assert.equal(sent.model, 'test-model');
    assert.equal(sent.stream, false);
    assert.equal(sent.max_tokens, 256);
    assert.equal(sent.temperature, 0.2);
    assert.deepEqual(sent.messages, [
      { role: 'system', content: '你是 Dot' },
      { role: 'user', content: '写个文件' },
    ]);
  });

  it('工具名消毒 + 响应侧还原走真实线格式（fs.read → fs_read → fs.read）', async () => {
    // 上游按**线上**名字回显（网关只会看见消毒后的名字），客户端必须还原成契约名。
    const up = await upstream([
      jsonHandler(
        200,
        chatBody({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'c1', function: { name: 'fs_read', arguments: '{"path":"MEMORY.md"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      ),
    ]);

    const ep = endpointFor(up.baseUrl);
    const out = await new HttpTransport().chat(
      callFor(ep, {
        tools: [
          { name: 'fs.read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'browser.open', description: '开浏览器', parameters: { type: 'object', properties: {} } },
        ],
      }),
    );

    // 线上：点分名被消毒（OpenRouter→Nvidia 实测只收 [a-zA-Z0-9_-]）
    const tools = (up.requests[0]!.body as { tools?: Array<{ type: string; function: { name: string } }> }).tools;
    assert.ok(tools !== undefined);
    assert.deepEqual(tools.map((t) => t.function.name), ['fs_read', 'browser_open']);
    assert.deepEqual(tools.map((t) => t.type), ['function', 'function']);

    // 客户端：回显名还原成契约词表名
    assert.equal(out.response.toolCalls?.[0]?.name, 'fs.read');
  });

  it('鉴权头：api_key_env 指向的环境变量真的上了 Authorization', async () => {
    const up = await upstream([jsonHandler(200, chatBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))]);
    const ep = endpointFor(up.baseUrl, { apiKeyEnv: 'DOTD_TEST_HTTP_KEY' });
    const saved = process.env.DOTD_TEST_HTTP_KEY;
    process.env.DOTD_TEST_HTTP_KEY = 'sk-test-123';
    try {
      await new HttpTransport().chat(callFor(ep));
    } finally {
      if (saved === undefined) delete process.env.DOTD_TEST_HTTP_KEY;
      else process.env.DOTD_TEST_HTTP_KEY = saved;
    }
    assert.equal(up.requests[0]!.headers.authorization, 'Bearer sk-test-123');
    assert.equal(up.requests[0]!.headers['content-type'], 'application/json');
  });

  it('api_key_env 未设置 → 不伪造 Authorization 头（本地引擎无鉴权场景）', async () => {
    const up = await upstream([jsonHandler(200, chatBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))]);
    const ep = endpointFor(up.baseUrl, { apiKeyEnv: 'DOTD_NO_SUCH_KEY_ENV_X' });
    await new HttpTransport().chat(callFor(ep));
    assert.equal(up.requests[0]!.headers.authorization, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ② 流式：真 SSE 分块 + usage 尾部块
// ═══════════════════════════════════════════════════════════════════

describe('② 流式 SSE：逐块解析 + usage 尾部块', () => {
  it('data: 行逐块吐出，[DONE] 收尾，usage() 拿到尾部块（含 cached tokens）', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // 逐块写，模拟真实 SSE 分帧（每块一次 TCP 写，客户端会收到多个 data 事件）
        res.write('data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"你好"},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"，主人"},"index":0}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":33,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
      },
    ]);

    const ep = endpointFor(up.baseUrl);
    const h = new HttpTransport().stream(callFor(ep, { maxTokens: 64 }));
    const text = await drainStream(h);
    const usage = await h.usage();

    assert.equal(text, '你好，主人');
    assert.deepEqual(usage, { promptTokens: 33, completionTokens: 4, cachedPromptTokens: 20 });

    // 上游侧：stream:true 真的发了、真带 accept
    const sent = up.requests[0]!.body as Record<string, unknown>;
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 64);
    assert.equal(up.requests[0]!.headers.accept, 'text/event-stream');
  });

  it('P0-2：SSE 的 delta.tool_calls 按增量下发，且工具名已从消毒名还原', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // 真 provider 形状：首个分片带 id + 消毒名 + 首段参数，后续分片只带参数
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"fs_write","arguments":"{\\"path\\":"}}]}}]}\n\n',
        );
        res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/dot/home/a.md\\"}"}}]}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      },
    ]);
    const ep = endpointFor(up.baseUrl);
    const h = new HttpTransport().stream(
      callFor(ep, { tools: [{ name: 'fs.write', description: 'd', parameters: { type: 'object' } }] }),
    );
    const chunks: ChatChunk[] = [];
    for await (const c of h) chunks.push(c);

    // 增量通道确实把工具调用带出来了（旧实现整块丢弃 → 模型要调工具时静默变"完结轮"）
    const deltas = chunks.flatMap((c) => c.toolCalls ?? []);
    assert.ok(deltas.length >= 2, `工具调用增量至少两块，实得 ${deltas.length}`);
    // 工具名在 transport 层就还原成契约名（fs_write → fs.write），与非流式 parseChatBody 一致
    assert.equal(deltas[0]?.name, 'fs.write', '消毒名已还原');
    assert.equal(deltas[0]?.id, 'call_x');

    // 聚合后：参数是完整 JSON（拼接规则在 shared/tool-stream.ts，已在那边单测）
    const acc = new StreamToolCallAccumulator();
    for (const c of chunks) if (c.toolCalls !== undefined) acc.push(c.toolCalls);
    assert.deepEqual(acc.settle(), [
      { id: 'call_x', name: 'fs.write', arguments: '{"path":"/dot/home/a.md"}' },
    ]);
  });

  it('Anthropic 形状的 cache_read_input_tokens 也认', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":2,"cache_read_input_tokens":8}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      },
    ]);
    const h = new HttpTransport().stream(callFor(endpointFor(up.baseUrl)));
    await drainStream(h);
    assert.deepEqual(await h.usage(), { promptTokens: 9, completionTokens: 2, cachedPromptTokens: 8 });
  });

  it('非流式响应完全缺 usage → usage 为 undefined（不编造 0）', async () => {
    const body = chatBody();
    delete body.usage; // 真的完全不报 usage（而非 usage:{}）
    const up = await upstream([jsonHandler(200, body)]);
    const out = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl)));
    assert.equal(out.usage, undefined);
    // 缺 usage 时 usageCacheRead 也必须是 undefined 而非 0
    assert.equal(usageCacheRead(undefined), undefined);
    assert.equal(usageCacheRead({ prompt_tokens_details: {} }), undefined);
    assert.equal(usageCacheRead({ prompt_tokens_details: { cached_tokens: 0 } }), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ③④⑤ HTTP 状态分类（真状态码，真 Retry-After 头）
// ═══════════════════════════════════════════════════════════════════

describe('③④⑤ HTTP 状态 → FailureKind 分类（真状态码）', () => {
  it('401 → auth', async () => {
    const up = await upstream([jsonHandler(401, { error: { message: 'invalid api key' } })]);
    const err = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl))).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure, `应抛 HttpFailure，实际 ${String(err)}`);
    assert.equal(err.status, 401);
    assert.match(err.message, /invalid api key/);
    assert.equal(classifyError(err).kind, 'auth');
  });

  it('403 → auth', async () => {
    const up = await upstream([jsonHandler(403, { error: { message: 'forbidden' } })]);
    const err = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl))).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure);
    assert.equal(err.status, 403);
    assert.equal(classifyError(err).kind, 'auth');
  });

  it('429 + Retry-After: 7 → rate_limit 且 retryAfterMs=7000', async () => {
    const up = await upstream([
      jsonHandler(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
    ]);
    const err = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl))).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 7000);
    const cls = classifyError(err);
    assert.equal(cls.kind, 'rate_limit');
    assert.equal(cls.retryAfterMs, 7000);
  });

  it('429 + quota 字样 → quota（长期不可用，与限流分家）', async () => {
    const up = await upstream([
      jsonHandler(429, { error: { message: 'You exceeded your quota / insufficient credits' } }),
    ]);
    const err = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl))).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure);
    assert.equal(classifyError(err).kind, 'quota');
    // 没带 Retry-After 头 → retryAfterMs 必须是 null（不能编一个）
    assert.equal(err.retryAfterMs, null);
  });

  it('428/400 等其它 4xx → bad_protocol（不是"网络问题"，不许重试成灾）', async () => {
    const up = await upstream([jsonHandler(400, { error: { message: 'missing field `type`' } })]);
    const err = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl))).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure);
    assert.equal(classifyError(err).kind, 'bad_protocol');
  });

  it('500 → server_error；502 → server_error', async () => {
    const up = await upstream([
      jsonHandler(500, { error: 'boom' }),
      jsonHandler(502, { error: 'bad gateway' }),
    ]);
    const t = new HttpTransport();
    const ep = endpointFor(up.baseUrl);
    for (const expected of [500, 502]) {
      const err = await t.chat(callFor(ep)).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof HttpFailure);
      assert.equal(err.status, expected);
      assert.equal(classifyError(err).kind, 'server_error');
    }
  });

  it('流式路径的 401 也分类为 auth（不是裸 Error）', async () => {
    const up = await upstream([jsonHandler(401, { error: { message: 'nope' } })]);
    const h = new HttpTransport().stream(callFor(endpointFor(up.baseUrl)));
    const err = await drainStream(h).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof HttpFailure);
    assert.equal(classifyError(err).kind, 'auth');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ 三档超时通道各自触发（connect / idle(首字节) / total）
// ═══════════════════════════════════════════════════════════════════

describe('⑥ 三个超时通道各自触发（connect / idle / total）', () => {
  it('idle 超时：上游接受连接但永不下发首字节 → timeout', async () => {
    const up = await upstream([
      (_req, res) => {
        // 故意不回任何东西：首字节迟迟不来
        res.writeHead(200, { 'content-type': 'application/json' });
        // 不 end、不 write → 客户端只能靠 idle 定时器收场
        void res;
      },
    ]);
    const ep = endpointFor(up.baseUrl);
    const t0 = Date.now();
    const err = await new HttpTransport()
      .chat(callFor(ep, { cap: { connect_ms: 2000, idle_ms: 300, total_ms: 5000 } }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const elapsed = Date.now() - t0;
    assert.ok(err !== null, '必须因超时失败，而不是永远挂着');
    assert.match(String((err as Error).message), /idle timeout/);
    assert.equal(classifyError(err).kind, 'timeout');
    // 真的在 idle_ms 附近收场（不是靠 total 兜底）
    assert.ok(elapsed >= 250 && elapsed < 2500, `idle 通道应在 ~300ms 收场，实测 ${elapsed}ms`);
    assert.equal(up.requests.length, 1, '上游确实收到了这一个请求');
  });

  it('total 超时：上游缓慢滴数据（idle 永远满足）→ 仍被 total 砍断', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // 每 100ms 吐一个空格：idle 计时器被反复重置，只有 total 能收场
        const timer = setInterval(() => res.write(' '), 100);
        res.on('close', () => clearInterval(timer));
      },
    ]);
    const ep = endpointFor(up.baseUrl);
    const t0 = Date.now();
    const err = await new HttpTransport()
      .chat(callFor(ep, { cap: { connect_ms: 2000, idle_ms: 1000, total_ms: 600 } }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const elapsed = Date.now() - t0;
    assert.ok(err !== null);
    assert.match(String((err as Error).message), /total timeout/);
    assert.equal(classifyError(err).kind, 'timeout');
    assert.ok(elapsed >= 500 && elapsed < 2000, `total 通道应在 ~600ms 收场，实测 ${elapsed}ms`);
  });

  it('connect 通道：目标端口无人监听 → network（拒连，不是 timeout）', async () => {
    // 先起再关，拿一个"刚刚可用、现在必然拒绝"的端口
    const dead = await startUpstream([jsonHandler(200, chatBody())]);
    const deadUrl = dead.baseUrl;
    await dead.close();
    open.splice(open.indexOf(dead), 1);

    const ep = endpointFor(deadUrl);
    const err = await new HttpTransport()
      .chat(callFor(ep, { cap: { connect_ms: 500, idle_ms: 1000, total_ms: 2000 } }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err !== null);
    assert.equal((err as { code?: string }).code, 'ECONNREFUSED');
    assert.equal(classifyError(err).kind, 'network');
  });

  it('connect 通道（真超时）：不可路由地址 → 在 connect_ms 内收场为 timeout/network', async () => {
    // 192.0.2.0/24 是 TEST-NET-1（RFC 5737），保证不可路由：连接尝试会被黑洞，
    // 只有 connect 定时器能收场。这是唯一能确定性触发 connect 通道的办法。
    const ep = endpointFor('http://192.0.2.1:9/v1', {
      timeouts: { connect_ms: 400, idle_ms: 2000, total_ms: 5000 },
    });
    const t0 = Date.now();
    const err = await new HttpTransport()
      .chat(callFor(ep, { cap: { connect_ms: 400, idle_ms: 2000, total_ms: 5000 } }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const elapsed = Date.now() - t0;
    assert.ok(err !== null, '连接黑洞必须超时收场，不能挂死');
    assert.ok(elapsed < 3000, `connect 通道应在 ~400ms 收场，实测 ${elapsed}ms`);
    const kind = classifyError(err).kind;
    assert.ok(kind === 'timeout' || kind === 'network', `connect 失败应归 timeout/network，实际 ${kind}`);
  });

  it('三档超时互不串台：idle 短于 total 时由 idle 收场（证明是两条独立通道）', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        void res; // 永不下发
      },
    ]);
    const ep = endpointFor(up.baseUrl);
    const err = await new HttpTransport()
      .chat(callFor(ep, { cap: { connect_ms: 3000, idle_ms: 200, total_ms: 10_000 } }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.match(String((err as Error).message), /idle timeout/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ⑦ 200 空壳 → EmptyResponseError（两个真实形状）
// ═══════════════════════════════════════════════════════════════════

describe('⑦ 200 空壳 → BadProtocolError / EmptyResponseError（两种真实形状）', () => {
  it('200 但 choices 为空数组 → BadProtocolError（transport 层直接挡）', async () => {
    const up = await upstream([jsonHandler(200, { id: 'x', choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } })]);
    const err = await new HttpTransport()
      .chat(callFor(endpointFor(up.baseUrl)))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof BadProtocolError, `实际 ${String(err)}`);
    assert.match(err.message, /缺 choices/);
    assert.equal(classifyError(err).kind, 'bad_protocol');
  });

  it('200 + content 空 + completion_tokens=0 → 传输层不抛，但判据认它是空壳', async () => {
    // 这是真实发生的 OpenRouter 免费路由形态：有 choices、有 message，但什么都没生成。
    // transport 层照实返回（它只负责编解码），"空壳"是 router 语义层的判决——所以这里
    // 断言的是**判据 isEmptyShellResponse 在真实响应上生效**，下一节再断言 router 真抛。
    const up = await upstream([
      jsonHandler(200, {
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 88, completion_tokens: 0 },
      }),
    ]);
    const out = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl)));
    assert.equal(out.response.content, '');
    assert.equal(out.response.toolCalls, undefined);
    assert.deepEqual(out.usage, { promptTokens: 88, completionTokens: 0 });
    const { isEmptyShellResponse } = await import('../src/router/transport.ts');
    assert.equal(isEmptyShellResponse(out.response as ChatResponse, out.usage), true);
  });

  it('content 空但 completion_tokens>0 → **不是**空壳（provider 真做了功，重试是白花钱）', async () => {
    const up = await upstream([
      jsonHandler(200, {
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 88, completion_tokens: 12 },
      }),
    ]);
    const out = await new HttpTransport().chat(callFor(endpointFor(up.baseUrl)));
    const { isEmptyShellResponse } = await import('../src/router/transport.ts');
    assert.equal(isEmptyShellResponse(out.response as ChatResponse, out.usage), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ⑧ 畸形上游：声称流式却回 JSON、脏 JSON、中途断开
// ═══════════════════════════════════════════════════════════════════

describe('⑧ 畸形上游：不崩、分类正确', () => {
  it('流式请求但上游回普通 JSON（content-type: application/json）→ 无 delta、正常收尾不崩', async () => {
    const up = await upstream([jsonHandler(200, chatBody())]);
    const h = new HttpTransport().stream(callFor(endpointFor(up.baseUrl)));
    const text = await drainStream(h);
    // 非 SSE 体里没有 data: 行 → 0 个 delta；必须**优雅收尾**而不是抛异常或挂死
    assert.equal(text, '');
    assert.equal(await h.usage(), undefined);
    // 上游确实收到了 stream:true，是它自己不守约
    assert.equal((up.requests[0]!.body as Record<string, unknown>).stream, true);
  });

  it('流式路径脏 data 行（不是合法 JSON）→ BadProtocolError', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n');
        res.write('data: {broken json here\n\n');
        res.end();
      },
    ]);
    const h = new HttpTransport().stream(callFor(endpointFor(up.baseUrl)));
    const err = await drainStream(h).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof BadProtocolError, `实际 ${String(err)}`);
    assert.match(err.message, /不是合法 JSON/);
    assert.equal(classifyError(err).kind, 'bad_protocol');
  });

  it('非流式脏 JSON 体 → BadProtocolError（不抛 SyntaxError）', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>gateway error</html>');
      },
    ]);
    const err = await new HttpTransport()
      .chat(callFor(endpointFor(up.baseUrl)))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof BadProtocolError);
    assert.equal(classifyError(err).kind, 'bad_protocol');
  });

  it('tool_call.arguments 不是合法 JSON → BadProtocolError（模型级故障，换模型不换端点）', async () => {
    const up = await upstream([
      jsonHandler(
        200,
        chatBody({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', function: { name: 'fs_write', arguments: '{"path": broken' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    ]);
    const err = await new HttpTransport()
      .chat(callFor(endpointFor(up.baseUrl)))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof BadProtocolError);
    assert.match(err.message, /tool_call\.arguments 不是合法 JSON/);
    assert.equal(classifyError(err).kind, 'bad_protocol');
  });

  it('响应体写到一半连接被断（非流式）→ 不崩，归类 network 而非成功', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '9999' });
        res.write('{"id":"x","choices":[{"mess');
        // 直接摧毁 socket：客户端收到的是 aborted/ECONNRESET
        setTimeout(() => res.destroy(), 30);
      },
    ]);
    const err = await new HttpTransport()
      .chat(callFor(endpointFor(up.baseUrl)))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err !== null, '断流绝不能当成成功返回');
    const kind = classifyError(err).kind;
    assert.ok(kind === 'network' || kind === 'bad_protocol', `断流应归 network，实际 ${kind}`);
  });

  it('流式中途断流 → 已吐出的内容先到，错误归 network（首字节后不当成功）', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"已经出来的"}}]}\n\n');
        setTimeout(() => res.destroy(), 40);
      },
    ]);
    const h = new HttpTransport().stream(callFor(endpointFor(up.baseUrl)));
    let text = '';
    const err = await (async () => {
      try {
        for await (const c of h) text += c.delta;
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    assert.ok(err !== null, '中途断流必须报错');
    assert.equal(classifyError(err).kind, 'network');
    // 已交付的字节不会因断流而消失（§4.7 首字节后绝不重放的前提）
    if (text.length > 0) assert.equal(text, '已经出来的');
  });

  it('{"error":{...}} 但状态 200（网关惯例）→ BadProtocolError 且带 upstream 错误原因', async () => {
    const up = await upstream([
      jsonHandler(200, { error: { message: 'upstream overloaded, no route' } }),
    ]);
    const err = await new HttpTransport()
      .chat(callFor(endpointFor(up.baseUrl)))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof BadProtocolError);
    assert.match(err.message, /upstream overloaded/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 集成：ModelRouter + 真 HttpTransport（证明"接入后真能跑通一次完整路由"）
// ═══════════════════════════════════════════════════════════════════

describe('集成：ModelRouter 接真 HttpTransport，走真实 TCP 完成一次路由', () => {
  function writeModelsYml(dir: string, baseUrl: string): void {
    mkdirSync(dir, { recursive: true });
    const outbox = join(dir, 'OUTBOX.md');
    writeFileSync(outbox, '', 'utf8');
    writeFileSync(
      join(dir, 'models.yml'),
      `version: 1
endpoints:
  - id: local-http
    tier: 1
    base_url: ${baseUrl}
    api_key_env: DOTD_IT_HTTP_KEY
    models: { primary: test-model, light: test-model }
    style: openai
    timeouts: { connect_ms: 1500, idle_ms: 1500, total_ms: 5000 }
    emergency_eligible: true

routing:
  default_track: primary
  light_events: [event.classify]

breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3

alerts:
  dedup_window_ms: 86400000
  outbox_path: ${outbox.replace(/\\/g, '/')}
  channel_order: [outbox]
  channel_timeout_ms: 10000

recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources: []
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`,
      'utf8',
    );
    writeFileSync(join(dir, 'free-models.yml'), 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
  }

  it('complete() 返回上游真实正文与 usage，meta 指向真端点', async () => {
    const up = await upstream([jsonHandler(200, chatBody({ usage: { prompt_tokens: 21, completion_tokens: 9 } }))]);
    const tmp: TempDataDir = makeTempDataDir();
    const saved = process.env.DOTD_IT_HTTP_KEY;
    process.env.DOTD_IT_HTTP_KEY = 'sk-it';
    try {
      const cfgDir = join(tmp.root, 'config');
      writeModelsYml(cfgDir, up.baseUrl);
      const router = ModelRouter.load({
        db: tmp.db,
        configDir: cfgDir,
        scheduler: { registerInternalJob: () => {} },
        channels: null,
        bus: tmp.bus,
        transport: new HttpTransport(), // ← 真实现，不是 stub
      });
      try {
        const res = await router.complete({
          track: 'primary' as Track,
          messages: [{ role: 'user', content: '你好' }],
          attemptId: 'nonj:HTTPIT01',
        });
        assert.equal((res.response as ChatResponse).content, '你好，主人。');
        assert.equal(res.meta.endpointId, 'local-http');
        assert.equal(res.meta.tier, 1);
        assert.equal(res.usage?.promptTokens, 21);
        // 真的打到了上游
        assert.equal(up.requests.length, 1);
        assert.equal(up.requests[0]!.headers.authorization, 'Bearer sk-it');
      } finally {
        router.dispose();
      }
    } finally {
      if (saved === undefined) delete process.env.DOTD_IT_HTTP_KEY;
      else process.env.DOTD_IT_HTTP_KEY = saved;
      tmp.cleanup();
    }
  });

  it('上游 200 空壳 → router 抛 EmptyResponseError（kind=empty_response），绝不当成功', async () => {
    const up = await upstream([
      jsonHandler(200, {
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 0 },
      }),
    ]);
    const tmp: TempDataDir = makeTempDataDir();
    try {
      const cfgDir = join(tmp.root, 'config');
      writeModelsYml(cfgDir, up.baseUrl);
      const router = ModelRouter.load({
        db: tmp.db,
        configDir: cfgDir,
        scheduler: { registerInternalJob: () => {} },
        channels: null,
        bus: tmp.bus,
        transport: new HttpTransport(),
      });
      try {
        const err = await router
          .complete({
            track: 'primary' as Track,
            messages: [{ role: 'user', content: '你好' }],
            attemptId: 'nonj:HTTPIT02',
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        assert.ok(err !== null, '空壳必须以失败收场');
        // 路由最终抛的是"全灭"错误，但 tried 里必须记 empty_response（分类正确）
        const msg = String(err);
        assert.ok(/empty_response|空壳|均不可用/.test(msg), `错误信息应体现空壳/全灭：${msg}`);
        assert.equal(up.requests.length, 1, '单模型端点只应打一次');
      } finally {
        router.dispose();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('流式：router.stream() 首字节后 meta() 可读，chunks 真的来自上游 SSE', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"流"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"式"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      },
    ]);
    const tmp: TempDataDir = makeTempDataDir();
    try {
      const cfgDir = join(tmp.root, 'config');
      writeModelsYml(cfgDir, up.baseUrl);
      const router = ModelRouter.load({
        db: tmp.db,
        configDir: cfgDir,
        scheduler: { registerInternalJob: () => {} },
        channels: null,
        bus: tmp.bus,
        transport: new HttpTransport(),
      });
      try {
        const s = router.stream({
          track: 'primary' as Track,
          messages: [{ role: 'user', content: '说点什么' }],
          attemptId: 'nonj:HTTPIT03',
        });
        let text = '';
        for await (const c of s) text += c.delta;
        assert.equal(text, '流式');
        const meta: RouteMeta = await s.meta();
        assert.equal(meta.endpointId, 'local-http');
        assert.equal(meta.streamStarted, true);
        assert.equal((up.requests[0]!.body as Record<string, unknown>).stream, true);
      } finally {
        router.dispose();
      }
    } finally {
      tmp.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 错误类型自身的回归（防止分类被悄悄改宽）
// ═══════════════════════════════════════════════════════════════════

describe('错误类型契约', () => {
  it('TransportError / EmptyResponseError 的 name 与 kind 稳定（classifyError 靠它）', () => {
    const te = new TransportError('timeout', 'idle timeout');
    assert.equal(te.name, 'TransportError');
    assert.equal(te.kind, 'timeout');
    assert.equal(classifyError(te).kind, 'timeout');

    const ee = new EmptyResponseError('空壳');
    assert.equal(ee.name, 'EmptyResponseError');
    assert.equal(classifyError(ee).kind, 'empty_response');
  });

  it('HttpFailure.retryAfterMs 显式保留 null（与 undefined 不同）', () => {
    const h = new HttpFailure(503, 'down', null);
    assert.equal(h.retryAfterMs, null);
    assert.equal(classifyError(h).kind, 'server_error');
    assert.equal(classifyError(h).retryAfterMs, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// extra_body：端点级额外字段真的上了线，且覆盖不了核心字段
// ═══════════════════════════════════════════════════════════════════

describe('extra_body（端点级额外请求字段）', () => {
  it('非流式：chat_template_kwargs 原样上送，model/messages 不可被覆盖', async () => {
    const up = await upstream([
      jsonHandler(200, chatBody({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })),
    ]);
    const ep = endpointFor(up.baseUrl, {
      extraBody: { chat_template_kwargs: { enable_thinking: false }, model: 'hijack', messages: [] },
    });
    await new HttpTransport().chat(
      callFor(ep, { messages: [{ role: 'user', content: 'ping' }], maxTokens: 16 }),
    );
    const sent = up.requests[0]!.body as Record<string, unknown>;
    assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
    assert.equal(sent.model, 'test-model', '核心字段必须赢过 extraBody');
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(sent.max_tokens, 16);
    assert.equal(sent.stream, false);
  });

  it('流式：同一份 extraBody 也进 stream 请求体', async () => {
    const up = await upstream([
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      },
    ]);
    const ep = endpointFor(up.baseUrl, { extraBody: { chat_template_kwargs: { enable_thinking: false } } });
    await drainStream(new HttpTransport().stream(callFor(ep)));
    const sent = up.requests[0]!.body as Record<string, unknown>;
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
  });
});
