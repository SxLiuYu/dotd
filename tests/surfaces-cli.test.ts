/**
 * tests/surfaces-cli.test.ts —— CLI 瘦客户端（§5.6）测试。
 *
 * 覆盖：
 * - token 三顺位解析（--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token）；
 * - base URL 解析（--url > DOTD_URL > 127.0.0.1:7788）；
 * - daemon 不可达 → 退码 7（§5.6 原文）；
 * - 全部命令的 HTTP 形状（ask→POST /api/messages、approvals→GET、approve/deny→decision）；
 * - `approve/deny` 只接受 once|remember|reject 词汇映射；
 * - CLI 不直写 SQLite（用 fetch stub 断言，无 db 依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL, EXIT_UNREACHABLE, buildCli, resolveBaseUrl, resolveToken } from '../src/surfaces/cli.ts';
import type { CliOptions } from '../src/surfaces/cli.ts';

/**
 * 仓库根（dotd/）绝对路径——由本文件位置推导，**不依赖 `process.cwd()`**。
 * 依据 README「测试数字必须说清的一件事」：用 cwd 拼仓库内路径会让测试在非仓库根
 * 目录启动时 ENOENT（例如从 dotd/tests/ 跑）。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 测试辅助：捕获输出与退码，stub fetch ─────────────────────────────

interface Captured {
  out: string[];
  err: string[];
  exits: number[];
  calls: Array<{ url: string; method: string; body: unknown; auth?: string }>;
}

function makeCapture(responder?: (url: string, method: string, body: unknown) => { status: number; body?: unknown }): {
  opts: CliOptions;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], exits: [], calls: [] };
  const opts: CliOptions = {
    exit: (code) => captured.exits.push(code),
    out: (t) => captured.out.push(t),
    err: (t) => captured.err.push(t),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      captured.calls.push({ url, method, body, auth: headers['authorization'] });
      const r = responder?.(url, method, body) ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  };
  return { opts, captured };
}

/** 跑一个命令，返回退出码（无退出 = 0）。 */
async function run(args: string[], opts: CliOptions): Promise<number> {
  const cli = buildCli(opts);
  await cli.parseAsync(['node', 'dotd', ...args]);
  return 0;
}

// ═══════════════════════════════════════════════════════════════════
// 一、token / base URL 解析（§5.6 三顺位）
// ═══════════════════════════════════════════════════════════════════

test('resolveToken：--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token', () => {
  const saved = process.env['DOTD_MASTER_TOKEN'];
  try {
    delete process.env['DOTD_MASTER_TOKEN'];
    // 顺位 1：显式 --token
    assert.equal(resolveToken('explicit'), 'explicit');
    // 顺位 2：环境变量（显式未给）
    process.env['DOTD_MASTER_TOKEN'] = 'from-env';
    assert.equal(resolveToken(undefined), 'from-env');
    // 显式优先于环境
    assert.equal(resolveToken('explicit'), 'explicit');
    // 都没有 → null（由命令自己决定是否可继续）
    delete process.env['DOTD_MASTER_TOKEN'];
    const real = existsSync(join(homedir(), '.dotd', 'cli_token'));
    if (!real) assert.equal(resolveToken(undefined), null);
  } finally {
    if (saved === undefined) delete process.env['DOTD_MASTER_TOKEN'];
    else process.env['DOTD_MASTER_TOKEN'] = saved;
  }
});

test('resolveBaseUrl：--url > DOTD_URL > 127.0.0.1:7788（契约 H2）', () => {
  const saved = process.env['DOTD_URL'];
  try {
    delete process.env['DOTD_URL'];
    assert.equal(resolveBaseUrl(undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:7788');
    process.env['DOTD_URL'] = 'http://10.0.0.2:9000/';
    assert.equal(resolveBaseUrl(undefined), 'http://10.0.0.2:9000'); // 尾斜杠归一
    assert.equal(resolveBaseUrl('http://x:1//'), 'http://x:1');
  } finally {
    if (saved === undefined) delete process.env['DOTD_URL'];
    else process.env['DOTD_URL'] = saved;
  }
});

test('EXIT_UNREACHABLE = 7（§5.6）', () => {
  assert.equal(EXIT_UNREACHABLE, 7);
});

// ═══════════════════════════════════════════════════════════════════
// 二、命令形状（对 HTTP API 的调用）
// ═══════════════════════════════════════════════════════════════════

test('ask → POST /api/messages（Bearer token，text 拼接）', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 202, body: { taskId: 'tk_1', threadId: 'th_1' } }));
  await run(['--token', 'T', '--dot', 'dot1', 'ask', '帮我', '查', '天气'], opts);
  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0]!.method, 'POST');
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/messages');
  assert.deepEqual(captured.calls[0]!.body, { text: '帮我 查 天气', dotId: 'dot1' });
  assert.equal(captured.calls[0]!.auth, 'Bearer T');
  assert.equal(captured.exits.length, 0); // 成功不退出
  assert.ok(captured.out.join('').includes('tk_1'));
});

test('status → 拉 /api/queue + /api/breaker + /api/approvals 三处', async () => {
  const { opts, captured } = makeCapture((url) =>
    url.includes('/api/queue') ? { status: 200, body: { queue: [{ id: 'tk_1' }] } } : { status: 200, body: {} },
  );
  await run(['--token', 'T', 'status'], opts);
  assert.deepEqual(captured.calls.map((c) => c.url), [
    'http://127.0.0.1:7788/api/queue?dot=dot1',
    'http://127.0.0.1:7788/api/breaker',
    'http://127.0.0.1:7788/api/approvals?state=pending',
  ]);
  assert.equal(captured.exits.length, 0);
});

test('approvals → GET /api/approvals?state=pending；空列表给中文提示', async () => {
  const empty = makeCapture(() => ({ status: 200, body: { approvals: [] } }));
  await run(['--token', 'T', 'approvals'], empty.opts);
  assert.equal(empty.captured.calls[0]!.url, 'http://127.0.0.1:7788/api/approvals?state=pending');
  assert.match(empty.captured.out.join(''), /没有待批审批/);

  const rows = makeCapture(() => ({
    status: 200,
    body: { approvals: [{ id: 5, seq: 3, status: 'pending', tier: 't2', summary: 'rm -rf /tmp/x' }] },
  }));
  await run(['--token', 'T', 'approvals'], rows.opts);
  assert.match(rows.captured.out.join(''), /#3/);
  assert.match(rows.captured.out.join(''), /rm -rf/);
});

test('approve once → POST /api/approvals/:id/decision verdict=approve_once', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { ok: true, finalStatus: 'approved' } }));
  await run(['--token', 'T', 'approve', '12', '--note', '确认可以'], opts);
  assert.equal(captured.calls[0]!.method, 'POST');
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/approvals/12/decision');
  // §5.2 gov.decide(id,'web'|'cli',verdict,actor)：CLI 必须带 channel='cli'，
  // 否则 GOV 账里 CLI 裁决全记成 web（§5.6 的 CLI 通道身份丢失）
  assert.deepEqual(captured.calls[0]!.body, { verdict: 'approve_once', channel: 'cli', note: '确认可以' });
});

test('approve remember → verdict=approve_remember', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { ok: true } }));
  await run(['--token', 'T', 'approve', 'remember', '7'], opts);
  assert.deepEqual(captured.calls[0]!.body, { verdict: 'approve_remember', channel: 'cli' });
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/approvals/7/decision');
});

test('deny → verdict=reject（GOV §3.3.1 词汇表只有三档）', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { ok: true, finalStatus: 'rejected' } }));
  await run(['--token', 'T', 'deny', '9'], opts);
  assert.deepEqual(captured.calls[0]!.body, { verdict: 'reject', channel: 'cli' });
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/approvals/9/decision');
});

test('cancel → POST /api/queue/:id/cancel', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { ok: true } }));
  await run(['--token', 'T', 'cancel', 'tk_42'], opts);
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/queue/tk_42/cancel');
  assert.equal(captured.calls[0]!.method, 'POST');
});

test('events → GET /api/events?limit=&since=', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { events: [] } }));
  await run(['--token', 'T', 'events', '--limit', '20', '--since', '100'], opts);
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/events?limit=20&since=100');
});

test('hook → 本地算 HMAC 并 POST /hooks/:source', async () => {
  const saved = process.env['DOTD_HOOK_SECRET_GRAFANA'];
  process.env['DOTD_HOOK_SECRET_GRAFANA'] = 'hook-secret';
  try {
    // 用"原文捕获"变体：不 parse body，验证 CLI 逐字节转发调用方给的 JSON
    const raw: Array<{ url: string; method: string; body: string; ts?: string; nonce?: string; sig?: string }> = [];
    const opts: CliOptions = {
      exit: (c) => { throw new Error(`unexpected exit ${c}`); },
      out: () => undefined,
      err: () => undefined,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        raw.push({
          url: String(input),
          method: (init?.method ?? 'GET').toUpperCase(),
          body: typeof init?.body === 'string' ? init.body : '',
          ts: headers['x-dotd-timestamp'],
          nonce: headers['x-dotd-nonce'],
          sig: headers['x-dotd-signature'],
        });
        return new Response(JSON.stringify({ eventId: 1 }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    };
    const cli = buildCli(opts);
    await cli.parseAsync(['node', 'dotd', '--token', 'T', 'hook', 'grafana', '{"id":"g1"}']);

    assert.equal(raw.length, 1);
    assert.equal(raw[0]!.url, 'http://127.0.0.1:7788/hooks/grafana');
    assert.equal(raw[0]!.body, '{"id":"g1"}'); // 逐字节转发（不重新序列化）
    // 三个 HMAC 头都在，且签名形态正确（服务端用同一串重算即可验）
    assert.match(raw[0]!.ts ?? '', /^\d{10}$/);
    assert.ok((raw[0]!.nonce ?? '').length > 0);
    assert.match(raw[0]!.sig ?? '', /^sha256=[0-9a-f]{64}$/);
  } finally {
    if (saved === undefined) delete process.env['DOTD_HOOK_SECRET_GRAFANA'];
    else process.env['DOTD_HOOK_SECRET_GRAFANA'] = saved;
  }
});

test('hook：缺 secret → 退码 2 且不发请求', async () => {
  const saved = process.env['DOTD_HOOK_SECRET_NOPE'];
  delete process.env['DOTD_HOOK_SECRET_NOPE'];
  try {
    const { opts, captured } = makeCapture();
    const code = await run(['--token', 'T', 'hook', 'nope', '{}'], opts);
    assert.equal(code, 0);
    assert.deepEqual(captured.exits, [2]);
    assert.equal(captured.calls.length, 0);
    assert.match(captured.err.join(''), /secret/);
  } finally {
    if (saved === undefined) delete process.env['DOTD_HOOK_SECRET_NOPE'];
    else process.env['DOTD_HOOK_SECRET_NOPE'] = saved;
  }
});

test('hb list → POST /api/heartbeat {op:"list"}', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { crontabs: [] } }));
  await run(['--token', 'T', 'hb', 'list'], opts);
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/heartbeat');
  assert.deepEqual(captured.calls[0]!.body, { op: 'list', dotId: 'dot1' });
});

test('hb add → 带 cron/prompt/quietHours', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { id: 'ct_1' } }));
  await run(
    ['--token', 'T', 'hb', 'add', '--cron', '0 22 * * *', '--prompt', '每日复盘', '--quiet', '23:00-07:00'],
    opts,
  );
  assert.equal(captured.calls[0]!.method, 'POST');
  const body = captured.calls[0]!.body as Record<string, unknown>;
  assert.equal(body['op'], 'add');
  assert.equal(body['cron'], '0 22 * * *');
  assert.equal(body['prompt'], '每日复盘');
  assert.equal(body['quietHours'], '23:00-07:00');
  assert.equal(body['title'], '每日复盘');
});

test('hb enable/disable/remove → set_enabled / remove', async () => {
  const en = makeCapture(() => ({ status: 200, body: {} }));
  await run(['--token', 'T', 'hb', 'enable', '--id', 'ct_9'], en.opts);
  assert.deepEqual(en.captured.calls[0]!.body, { op: 'set_enabled', ctId: 'ct_9', enabled: true });

  const rm = makeCapture(() => ({ status: 200, body: {} }));
  await run(['--token', 'T', 'hb', 'remove', '--id', 'ct_9'], rm.opts);
  assert.deepEqual(rm.captured.calls[0]!.body, { op: 'remove', ctId: 'ct_9' });
});

// ═══════════════════════════════════════════════════════════════════
// 三、失败语义（§5.6：daemon 不可达退码 7）
// ═══════════════════════════════════════════════════════════════════

test('daemon 不可达 → 退码 7 且不崩栈', async () => {
  const captured: Captured = { out: [], err: [], exits: [], calls: [] };
  const opts: CliOptions = {
    exit: (c) => captured.exits.push(c),
    out: (t) => captured.out.push(t),
    err: (t) => captured.err.push(t),
    fetch: (async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch,
  };
  await run(['--token', 'T', 'ask', 'hi'], opts);
  assert.deepEqual(captured.exits, [EXIT_UNREACHABLE]);
  assert.match(captured.err.join(''), /连不上 daemon/);
});

test('daemon 回 4xx/5xx → 退码 1（不是 7；7 只给"连不上"）', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 401, body: { error: 'auth', message: 'token 无效' } }));
  await run(['--token', 'T', 'approvals'], opts);
  assert.deepEqual(captured.exits, [1]);
  assert.match(captured.err.join(''), /token 无效/);
});

test('未登记命令 → 退码 2 并提示 --help', async () => {
  const { opts, captured } = makeCapture();
  await run(['--token', 'T', 'frobnicate'], opts);
  assert.deepEqual(captured.exits, [2]);
  assert.match(captured.err.join(''), /未知命令/);
});

test('watch 无 token → 退码 2（不发起 SSE）', async () => {
  const saved = process.env['DOTD_MASTER_TOKEN'];
  delete process.env['DOTD_MASTER_TOKEN'];
  try {
    const { opts, captured } = makeCapture();
    await run(['watch'], opts);
    assert.deepEqual(captured.exits, [2]);
    assert.equal(captured.calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env['DOTD_MASTER_TOKEN'];
    else process.env['DOTD_MASTER_TOKEN'] = saved;
  }
});

test('serve：只提示真入口（daemon 装配层在 src/daemon.ts）', async () => {
  const { opts, captured } = makeCapture();
  await run(['serve'], opts);
  assert.equal(captured.calls.length, 0); // 不发 HTTP
  assert.match(captured.out.join(''), /daemon\.ts/);
});

// ═══════════════════════════════════════════════════════════════════
// 四、token 落盘（第三顺位的写入面）
// ═══════════════════════════════════════════════════════════════════

test('resolveToken 顺位 3：~/.dotd/cli_token（临时 HOME 隔离，不碰真实文件）', () => {
  const saved = process.env['DOTD_MASTER_TOKEN'];
  const savedHome = process.env['HOME'];
  const savedUserProfile = process.env['USERPROFILE'];
  const tmp = mkdtempSync(join(tmpdir(), 'dotd-cli-home-'));
  try {
    delete process.env['DOTD_MASTER_TOKEN'];
    process.env['HOME'] = tmp;
    process.env['USERPROFILE'] = tmp;
    mkdirSync(join(tmp, '.dotd'), { recursive: true });
    assert.equal(resolveToken(undefined), null); // 文件还不存在
    writeFileSync(join(tmp, '.dotd', 'cli_token'), 'file-token\n', 'utf8');
    assert.equal(resolveToken(undefined), 'file-token'); // 顺位 3 生效
    process.env['DOTD_MASTER_TOKEN'] = 'env-token';
    assert.equal(resolveToken(undefined), 'env-token'); // 环境变量优先于文件
  } finally {
    if (saved === undefined) delete process.env['DOTD_MASTER_TOKEN'];
    else process.env['DOTD_MASTER_TOKEN'] = saved;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI 不依赖 SQLite（全部经 HTTP；无 db 导入即证明）', async () => {
  // 直接读源码断言：cli.ts 不得 import node:sqlite / db/ 层（§5.6：CLI 不直写库）
  const src = readFileSync(join(REPO_ROOT, 'src', 'surfaces', 'cli.ts'), 'utf8');
  assert.ok(!/node:sqlite/.test(src), 'CLI 不得 import node:sqlite');
  assert.ok(!/from '\.\.\/db\//.test(src), 'CLI 不得 import db 层');
  assert.ok(!/openDb|migrate\(/.test(src), 'CLI 不得开库/迁移');
});

// ═══════════════════════════════════════════════════════════════════
// 六、sos-test：如实报通道现状（不再硬编码"telegram 未装配"）
// ═══════════════════════════════════════════════════════════════════

const CHANNELS_BODY = {
  available: { feishu: true, telegram: false, email: false },
  order: ['feishu', 'telegram', 'email', 'outbox'],
  outboxPath: '/root/.dotd/OUTBOX.md',
  recent: [
    { signature: 'sig1', kind: 'help', mode: 'degraded', deliveredVia: 'feishu', channelsTried: 'feishu' },
  ],
};

test('sos-test：有可用通道 → 报顺序/现状/台账，并说"能送到你眼前"', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: CHANNELS_BODY }));
  const code = await run(['sos-test'], opts);
  assert.equal(code, 0);
  assert.equal(captured.calls[0]!.url, 'http://127.0.0.1:7788/api/channels');
  const text = captured.out.join('');
  assert.match(text, /求救投递顺序：feishu → telegram → email → outbox/);
  assert.match(text, /feishu=可用/);
  assert.match(text, /telegram=不可用/);
  assert.match(text, /最近一条台账：kind=help mode=degraded 实际投递=feishu（试过 feishu）/);
  assert.match(text, /结论：有可用通道/);
});

test('sos-test：三通道全不可用 → 明确说只会落兜底文件（不粉饰）', async () => {
  const { opts, captured } = makeCapture(() => ({
    status: 200,
    body: { ...CHANNELS_BODY, available: { feishu: false, telegram: false, email: false }, recent: [] },
  }));
  await run(['sos-test'], opts);
  const text = captured.out.join('');
  assert.match(text, /台账：alert_dispatch 暂无记录/);
  assert.match(text, /结论：三个实时通道全不可用，求救只会落进 \/root\/\.dotd\/OUTBOX\.md/);
});

test('sos-test：daemon 回的不是预期形状 → 退码 1 且不编结论', async () => {
  const { opts, captured } = makeCapture(() => ({ status: 200, body: { hello: 'world' } }));
  await run(['sos-test'], opts);
  assert.deepEqual(captured.exits, [1]);
  assert.match(captured.err.join(''), /不是预期形状/);
  assert.equal(captured.out.length, 0);
});

test('sos-test：daemon 不可达 → 退码 7（§5.6 原文）', async () => {
  const { opts, captured } = makeCapture();
  opts.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  await run(['sos-test'], opts);
  assert.deepEqual(captured.exits, [7]);
  assert.match(captured.err.join(''), /连不上 daemon/);
});

test('提示里出现的 `dotd <命令>` 必须是真注册过的命令（别再把人指去撞墙）', () => {
  // 2026-10-26 现场：`dotd task <不存在的 id>` 的提示写的是「可用 `dotd queue` 看待办」。
  // `queue` 从来没注册过 —— 人照着敲，得到的是「未知命令：queue」+ exit 2。
  // 「下一步命令」是给人在卡住时看的，它本身不该再把人的路堵死一次。
  const src = readFileSync(join(REPO_ROOT, 'src', 'surfaces', 'cli.ts'), 'utf8');
  const registered = new Set(buildCli().commands.map((c) => c.name()));
  const bad: string[] = [];
  let scanned = 0;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('/**') || line.startsWith('//')) continue;
    // `npm --prefix dotd run serve` 里的 dotd 是包名，不是命令前缀。
    if (line.includes('npm ')) continue;
    for (const m of raw.matchAll(/dotd ([a-z][a-z0-9-]*)/g)) {
      const name = m[1]!;
      scanned += 1;
      if (!registered.has(name)) bad.push(`${name} ← ${line}`);
    }
  }
  assert.deepEqual(bad, [], `这些提示指向了不存在的命令：\n${bad.join('\n')}`);
  // 防"空扫描通过"：正则一旦写错（比如以后改了提示格式），上面那个 deepEqual
  // 会因为 bad 恒空而变成永远绿 —— 那正是本仓库反复踩的"检查器看不见自己"。
  assert.ok(scanned >= 5, `只扫到 ${scanned} 处 \`dotd <命令>\`，正则可能失效了`);
});

test('asChannels：逐字段校验——字段缺失/类型错 → null（不把 undefined 当 false）', async () => {
  const { asChannels } = await import('../src/surfaces/cli.ts');
  assert.equal(asChannels(null), null);
  assert.equal(asChannels({ available: { feishu: true } }), null); // 缺 order
  assert.equal(asChannels({ available: {}, order: [], outboxPath: 'x' }), null); // order 空
  assert.equal(asChannels({ available: {}, order: ['feishu'], outboxPath: 1 }), null); // outboxPath 非串
  // 可用性字段类型不对时按 false 收口（不是把整个响应判废）
  const ok = asChannels({ available: { feishu: 'yes' }, order: ['feishu'], outboxPath: 'p', recent: 'nope' });
  assert.equal(ok?.available.feishu, false);
  assert.deepEqual(ok?.recent, []);
});
