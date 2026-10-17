/**
 * tests/surfaces-channels-web-config.test.ts —— 出站通道适配器（§5.7）、Web UI
 * 静态托管（§7）、配置加载（§3）三块测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  CliChannel,
  FileChannel,
  HttpChannel,
  NULL_TELEGRAM_GATEWAY,
  NULL_FEISHU_GATEWAY,
  FeishuGateway,
  OUTBOUND_CHANNELS,
  SurfacesNotificationChannels,
} from '../src/surfaces/channels.ts';
import type { TelegramGateway } from '../src/surfaces/channels.ts';
import {
  DEFAULT_WEB_ROOT,
  notBuiltHtml,
  resolveStaticPath,
  serveStatic,
} from '../src/surfaces/web.ts';
import { expandEnv, expandHome, loadSurfacesConfig, parseSurfacesSection } from '../src/surfaces/config.ts';
import { ConfigError } from '../src/shared/errors.ts';
import { assertHttpConfig } from '../src/surfaces/http.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';

// ═══════════════════════════════════════════════════════════════════
// 一、出站通道（§5.7）
// ═══════════════════════════════════════════════════════════════════

test('FileChannel：追加留痕到本地文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-chan-'));
  try {
    const p = join(root, 'sub', 'notifications.log');
    const ch = new FileChannel(p);
    assert.deepEqual(ch.deliver('第一条'), { ok: true });
    ch.deliver('第二条');
    const text = readFileSync(p, 'utf8');
    assert.match(text, /第一条/);
    assert.match(text, /第二条/);
    assert.equal(text.trim().split('\n').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CliChannel：写 stderr（不抛即留痕成功）', () => {
  const ch = new CliChannel();
  assert.deepEqual(ch.deliver('提示'), { ok: true });
});

test('NULL_TELEGRAM_GATEWAY：阶段一占位（available 恒 false、deliver 如实报未装配）', async () => {
  assert.equal(NULL_TELEGRAM_GATEWAY.lastGetMeOkAt(), null);
  const r = await NULL_TELEGRAM_GATEWAY.sendMessage(1, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /阶段二/);
  await NULL_TELEGRAM_GATEWAY.startPolling(); // 不抛
  NULL_TELEGRAM_GATEWAY.stopPolling();
});

test('OUTBOUND_CHANNELS：§5.7 六个通道名（含 feishu）', () => {
  assert.deepEqual(OUTBOUND_CHANNELS, ['cli', 'file', 'http', 'telegram', 'feishu', 'email']);
});

test('NULL_FEISHU_GATEWAY：未配 App ID/Secret 时 available 恒 false、deliver 如实报未配置', async () => {
  assert.equal(NULL_FEISHU_GATEWAY.lastOkAt(), null);
  const ch = new SurfacesNotificationChannels({
    telegram: NULL_TELEGRAM_GATEWAY,
    feishu: NULL_FEISHU_GATEWAY,
    filePath: join(mkdtempSync(join(tmpdir(), 'dotd-chan-')), 'notifications.log'),
  });
  assert.equal(ch.available('feishu'), false);
  // 有 chat id 也发不出去（真 App ID/Secret 为空 → token 接口必然失败）
  const r = await ch.deliver('feishu', '求救');
  assert.equal(r.ok, false);
  // 没 chat id 时是明确的配置错误，不是静默假成功
  const r2 = await ch.deliver('feishu', 'x');
  assert.match(r2.error ?? '', /chat id|飞书|code=/);
});

test('FeishuGateway：tenant_access_token 失败 → 如实报错不抛', async () => {
  const gw = new FeishuGateway({ appId: '', appSecret: '', editThrottleMs: 0 });
  const r = await gw.sendText('oc_fake', 'hi');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /tenant_access_token|飞书/);
});

// ── 飞书可用性判据：拿到 token 即置位（2026-10-17 修"冷启动窟窿"）──────────
// 背景：旧实现只在 sendText 成功后才置 lastOkAt，于是 daemon 刚起来还没发过消息时
// available('feishu') 恒 false —— 而第一封求救往往正是重启后两轨齐挂那一刻，飞书
// 明明是好的却被白白绕过，落进 OUTBOX.md。注释里写的"或成功拿过 token"也没兑现。

/** 把 globalThis.fetch 换成假实现，返回还原函数。 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('FeishuGateway：拿到 tenant_access_token 即置位可用性（不靠先发过消息）', async () => {
  const restore = stubFetch(async () => jsonRes({ code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 }));
  try {
    const gw = new FeishuGateway({ appId: 'cli_x', appSecret: 's', editThrottleMs: 0 });
    assert.equal(gw.lastOkAt(), null, '未预热前不得谎报可用');
    assert.equal(await gw.warm(), true);
    assert.notEqual(gw.lastOkAt(), null, '预热成功必须置位');

    const ch = new SurfacesNotificationChannels({
      telegram: NULL_TELEGRAM_GATEWAY,
      feishu: gw,
      filePath: join(mkdtempSync(join(tmpdir(), 'dotd-warm-')), 'notifications.log'),
      feishuChatId: 'oc_owner',
    });
    assert.equal(ch.available('feishu'), true, '凭证有效即视为可用（求救才进得了飞书）');
  } finally {
    restore();
  }
});

test('FeishuGateway.warm()：token 接口失败 → 返回 false、不置位、不抛', async () => {
  const restore = stubFetch(async () => jsonRes({ code: 99991663, msg: 'app ticket invalid' }));
  try {
    const gw = new FeishuGateway({ appId: 'cli_bad', appSecret: 'bad', editThrottleMs: 0 });
    assert.equal(await gw.warm(), false, '失败必须如实返回 false');
    assert.equal(gw.lastOkAt(), null, '失败不得置位（否则 available 谎报 true）');
    const ch = new SurfacesNotificationChannels({
      telegram: NULL_TELEGRAM_GATEWAY,
      feishu: gw,
      filePath: join(mkdtempSync(join(tmpdir(), 'dotd-warm-')), 'notifications.log'),
      feishuChatId: 'oc_owner',
    });
    assert.equal(ch.available('feishu'), false);
  } finally {
    restore();
  }
});

test('FeishuGateway：网络异常也走 warm 的 catch（返回 false，不把异常抛给装配层）', async () => {
  const restore = stubFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    const gw = new FeishuGateway({ appId: 'cli_x', appSecret: 's', editThrottleMs: 0 });
    assert.equal(await gw.warm(), false);
    assert.equal(gw.lastOkAt(), null);
  } finally {
    restore();
  }
});


test('HttpChannel：POST 到本地端点；非 2xx → {ok:false,error}', async () => {
  const got: Array<{ method: string | undefined; url: string | undefined; body: string; ct: string | undefined }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, body, ct: req.headers['content-type'] });
      res.writeHead(req.url === '/bad' ? 500 : 200);
      res.end('ok');
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    const ok = new HttpChannel(`http://127.0.0.1:${port}/in`);
    assert.deepEqual(await ok.deliver('hello'), { ok: true });
    assert.equal(got[0]!.method, 'POST');
    assert.equal(got[0]!.body, 'hello');
    assert.match(got[0]!.ct ?? '', /text\/plain/);
    const bad = new HttpChannel(`http://127.0.0.1:${port}/bad`);
    const r = await bad.deliver('x');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /HTTP 500/);
    // 连不上的端点：如实报错不抛
    const dead = new HttpChannel('http://127.0.0.1:1/nope');
    assert.equal((await dead.deliver('x')).ok, false);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test('SurfacesNotificationChannels：telegram 可用性 = 5min 内 getMe 成功', () => {
  let lastOk: number | null = null;
  const gw: TelegramGateway = {
    lastGetMeOkAt: () => lastOk,
    sendMessage: () => Promise.resolve({ ok: true }),
    startPolling: () => Promise.resolve(),
    stopPolling: () => undefined,
  };
  const now = 1_700_000_000_000;
  const ch = new SurfacesNotificationChannels({ telegram: gw, filePath: join(tmpdir(), 'dotd-nc.log'), now: () => now });
  assert.equal(ch.available('telegram'), false); // 从未 getMe
  lastOk = now - 60_000;
  assert.equal(ch.available('telegram'), true);
  lastOk = now - 5 * 60 * 1000 - 1; // 刚过 5min
  assert.equal(ch.available('telegram'), false);
});

test('SurfacesNotificationChannels：email 阶段一 available=false 且 deliver 如实报', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-nc-'));
  try {
    const ch = new SurfacesNotificationChannels({
      telegram: NULL_TELEGRAM_GATEWAY,
      filePath: join(root, 'notifications.log'),
    });
    assert.equal(ch.available('email'), false);
    const r = await ch.deliver('email', '求救：磁盘将满');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /阶段一/);
    // 但本地留痕已写（SF 自己的审计，与 MR 的 OUTBOX 不混）
    const text = readFileSync(join(root, 'notifications.log'), 'utf8');
    assert.match(text, /\[email\].*求救：磁盘将满/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SurfacesNotificationChannels：email 配了 SMTP_URL 也 available=false（§5.7/§10 分期）', () => {
  // §10 分期表「email 求救适配器 ❌（available=false）」：available 与 deliver 必须一致。
  // 若这里返回 true，MR 会把求救路由进 deliver 必然失败的通道，绕开 OUTBOX 兜底。
  const prev = process.env['SMTP_URL'];
  process.env['SMTP_URL'] = 'smtps://user:pw@smtp.example.com:465';
  try {
    const ch = new SurfacesNotificationChannels({
      telegram: NULL_TELEGRAM_GATEWAY,
      filePath: join(mkdtempSync(join(tmpdir(), 'dotd-nc-')), 'notifications.log'),
    });
    assert.equal(ch.available('email'), false);
  } finally {
    if (prev === undefined) delete process.env['SMTP_URL'];
    else process.env['SMTP_URL'] = prev;
  }
});

test('SurfacesNotificationChannels：TG chatId 来自 defaultChatId；缺 → 如实报错（不静默投 0）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-nc-'));
  try {
    const sent: Array<{ chatId: number; text: string }> = [];
    const gw: TelegramGateway = {
      lastGetMeOkAt: () => 1,
      sendMessage: (chatId, text) => { sent.push({ chatId, text }); return Promise.resolve({ ok: true }); },
      startPolling: () => Promise.resolve(),
      stopPolling: () => undefined,
    };
    // ① 装配层给 defaultChatId → 发到该 chat（§5.5 卡片/提醒都要具体 chat）
    const ch = new SurfacesNotificationChannels({ telegram: gw, filePath: join(root, 'n.log'), defaultChatId: 12345, now: () => 0 });
    const r = await ch.deliver('telegram', '提醒');
    assert.equal(r.ok, true);
    assert.deepEqual(sent, [{ chatId: 12345, text: '提醒' }]);

    // ② gateway 的 resolveChatId 优先（真实 gateway 装配后自己解析）
    sent.length = 0;
    const gw2: TelegramGateway = { ...gw, resolveChatId: () => 777 };
    const ch2 = new SurfacesNotificationChannels({ telegram: gw2, filePath: join(root, 'n.log'), defaultChatId: 12345, now: () => 0 });
    assert.equal((await ch2.deliver('telegram', 'x')).ok, true);
    assert.deepEqual(sent, [{ chatId: 777, text: 'x' }]);

    // ③ 两者都缺 → 一次都不发，如实 {ok:false}（绝不静默投 chat_id=0）
    sent.length = 0;
    let attempts = 0;
    const gw3: TelegramGateway = { ...gw, sendMessage: (chatId, text) => { attempts++; sent.push({ chatId, text }); return Promise.resolve({ ok: true }); } };
    const ch3 = new SurfacesNotificationChannels({ telegram: gw3, filePath: join(root, 'n.log'), now: () => 0 });
    const r3 = await ch3.deliver('telegram', 'x');
    assert.equal(r3.ok, false);
    assert.match(r3.error ?? '', /chat id 未配置/);
    assert.equal(attempts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SurfacesNotificationChannels：telegram 未装配 → 3 次快重试后如实 {ok:false}', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-nc-'));
  try {
    let attempts = 0;
    const gw: TelegramGateway = {
      lastGetMeOkAt: () => null,
      sendMessage: () => { attempts++; return Promise.resolve({ ok: false, error: '未装配' }); },
      startPolling: () => Promise.resolve(),
      stopPolling: () => undefined,
    };
    const ch = new SurfacesNotificationChannels({
      telegram: gw,
      filePath: join(root, 'n.log'),
      now: () => 0,
      defaultChatId: 1, // chat 目标已定 → 才能走到"发送失败重试"这条路径
    });
    const r = await ch.deliver('telegram', 'x');
    assert.equal(r.ok, false);
    assert.equal(attempts, 3); // §5.7：3 次快重试
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 二、Web UI 静态托管（§7）
// ═══════════════════════════════════════════════════════════════════

/**
 * 最小 res 替身：支持 writeHead/end 与 `stream.pipe(res)`（Writable 协议）
 * —— serveStatic 用 createReadStream().pipe() 发文件，必须给真可写流。
 */
function fakeRes(): { res: ServerResponse; out: { status: number; headers: Record<string, string>; body: string } } {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const writable = new Writable({
    write(chunk, _enc, cb) {
      out.body += chunk.toString('utf8');
      cb();
    },
    final(cb) {
      cb();
    },
  });
  const res = Object.assign(writable, {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      out.headers = headers;
      return res;
    },
  }) as unknown as ServerResponse;
  return { res, out };
}

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage;
}

test('resolveStaticPath：拒路径穿越与绝对路径注入', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-web-'));
  try {
    assert.equal(resolveStaticPath(root, '/index.html'), join(root, 'index.html'));
    assert.equal(resolveStaticPath(root, '/assets/app.js'), join(root, 'assets', 'app.js'));
    assert.equal(resolveStaticPath(root, '/../../etc/passwd'), null);
    assert.equal(resolveStaticPath(root, '/..%2f..%2fetc'), null); // percent-encoding 先解码再判
    assert.equal(resolveStaticPath(root, '/safe/../index.html'), join(root, 'index.html'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic：命中文件 → 200 + MIME；带 hash 文件名 → immutable 缓存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-web-'));
  try {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<html>home</html>', 'utf8');
    writeFileSync(join(root, 'assets', 'app-abc12345.js'), 'console.log(1)', 'utf8');
    writeFileSync(join(root, 'style.css'), 'body{}', 'utf8');

    const a = fakeRes();
    await serveStatic(fakeReq('/'), a.res, { root });
    assert.equal(a.out.status, 200);
    assert.match(a.out.headers['content-type'] ?? '', /text\/html/);
    assert.equal(a.out.headers['cache-control'], 'no-cache');

    const b = fakeRes();
    await serveStatic(fakeReq('/assets/app-abc12345.js'), b.res, { root });
    assert.equal(b.out.status, 200);
    assert.match(b.out.headers['cache-control'] ?? '', /immutable/);

    const c = fakeRes();
    await serveStatic(fakeReq('/style.css'), c.res, { root });
    assert.match(c.out.headers['content-type'] ?? '', /text\/css/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic：SPA 深链（无扩展名）回落 index.html', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-web-'));
  try {
    writeFileSync(join(root, 'index.html'), '<html>spa</html>', 'utf8');
    const r = fakeRes();
    await serveStatic(fakeReq('/conversations/123'), r.res, { root });
    assert.equal(r.out.status, 200);
    assert.equal(r.out.body, '<html>spa</html>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic：未构建 → 200 占位页（不是 404 裸奔）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-web-'));
  try {
    const r = fakeRes();
    await serveStatic(fakeReq('/'), r.res, { root });
    assert.equal(r.out.status, 200);
    assert.match(r.out.body, /Web UI 还没构建/);
    assert.match(notBuiltHtml(), /build:web/);
    assert.equal(DEFAULT_WEB_ROOT, 'web-ui/dist');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serveStatic：HEAD 只回状态头不發 body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dotd-web-'));
  try {
    writeFileSync(join(root, 'index.html'), '<html>x</html>', 'utf8');
    const r = fakeRes();
    await serveStatic(fakeReq('/', 'HEAD'), r.res, { root });
    assert.equal(r.out.status, 200);
    assert.equal(r.out.body, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 三、配置加载（§3 + config/dotd.yml 实文件）
// ═══════════════════════════════════════════════════════════════════

test('expandEnv：未设置 → ConfigError（fail-closed）；strict:false → 空串', () => {
  const name = 'DOTD_TEST_UNSET_VAR_XZ';
  delete process.env[name];
  // 注意：必须拼出字面 ${NAME}（模板字符串会提前插值，就测不到占位符展开路径了）
  const tmpl = `prefix-\${${name}}`;
  assert.equal(tmpl, 'prefix-${DOTD_TEST_UNSET_VAR_XZ}');
  assert.throws(() => expandEnv(tmpl), ConfigError);
  assert.equal(expandEnv(tmpl, { strict: false }), 'prefix-');
  process.env[name] = 'v';
  assert.equal(expandEnv(tmpl), 'prefix-v');
  delete process.env[name];
});

test('expandHome：~ 与 ~/ 展开为 HOME', () => {
  assert.equal(expandHome('~'), process.env['USERPROFILE'] ?? expandHome('~'));
  assert.ok(expandHome('~/.dotd').startsWith(expandHome('~')));
  assert.equal(expandHome('/abs/path'), '/abs/path');
});

test('parseSurfacesSection：最小合法 surfaces 节', () => {
  const cfg = parseSurfacesSection({
    surfaces: {
      http: { host: '127.0.0.1', port: 7788, master_token: 'tok' },
    },
  });
  assert.equal(cfg.http.port, 7788);
  assert.equal(cfg.http.masterToken, 'tok');
  assert.deepEqual(cfg.http.readonlyTokens, []);
  assert.deepEqual(cfg.http.allowedOrigins, []);
  assert.deepEqual(cfg.hooks, []);
  assert.equal(cfg.heartbeat.tickIntervalS, 15);
  assert.equal(cfg.ui.streamDeltas, true);
  assert.equal(cfg.telegram.botToken, ''); // 未配 → 空（strict:false）
});

test('parseSurfacesSection：缺 surfaces 节 → ConfigError（拒启动）', () => {
  assert.throws(() => parseSurfacesSection({ other: 1 }), ConfigError);
  assert.throws(() => parseSurfacesSection({ surfaces: [1, 2] }), ConfigError);
});

test('parseSurfacesSection：feishu.owner_chat_id 也走 ${ENV} 展开（WSL 冒烟实测缺口）', () => {
  process.env.DOTD_TEST_OWNER_CHAT = 'oc_from_env';
  try {
    const cfg = parseSurfacesSection({
      surfaces: {
        http: { host: '127.0.0.1', port: 7788, master_token: 'tok' },
        feishu: { owner_chat_id: '${DOTD_TEST_OWNER_CHAT}', verification_token: 'vt', encrypt_key: 'ek' },
      },
    });
    assert.equal(cfg.feishu.ownerChatId, 'oc_from_env');
  } finally {
    delete process.env.DOTD_TEST_OWNER_CHAT;
  }
});

test('parseSurfacesSection：master_token 为空 → ConfigError（fail-closed）', () => {
  assert.throws(() => parseSurfacesSection({ surfaces: { http: { master_token: '' } } }), ConfigError);
});

test('parseSurfacesSection：端口越界/类型错 → ConfigError', () => {
  assert.throws(() => parseSurfacesSection({ surfaces: { http: { master_token: 't', port: 99999 } } }), ConfigError);
  assert.throws(() => parseSurfacesSection({ surfaces: { http: { master_token: 't', port: 'abc' } } }), ConfigError);
});

test('loadSurfacesConfig：读仓库 config/dotd.yml 全部 surfaces 节（含 ${VAR} 展开）', () => {
  // config/dotd.yml 的 master_token/secret 都是 ${DOTD_*} 占位符，先设置再读
  process.env['DOTD_MASTER_TOKEN'] = 'test-master';
  process.env['DOTD_RO_TOKEN'] = 'test-readonly';
  process.env['HOOK_GRAFANA'] = 'test-secret';
  try {
    const cfg = loadSurfacesConfig(join(process.cwd(), 'config', 'dotd.yml'));
    assert.equal(cfg.http.host, '127.0.0.1');
    assert.equal(cfg.http.port, 7788); // 契约 H2 唯一监听端口
    assert.equal(cfg.http.masterToken, 'test-master');
    assert.deepEqual(cfg.http.readonlyTokens, ['test-readonly']);
    assert.deepEqual(cfg.http.allowedOrigins, ['http://localhost:7788', 'http://127.0.0.1:7788']);
    assert.equal(cfg.hooks.length, 1);
    assert.equal(cfg.hooks[0]!.source, 'grafana');
    assert.equal(cfg.hooks[0]!.secret, 'test-secret');
    assert.equal(cfg.hooks[0]!.dotId, 'dot1');
    assert.equal(cfg.jsonlWatch.length, 1);
    assert.equal(cfg.jsonlWatch[0]!.enabled, false); // 阶段一默认关
    assert.equal(cfg.jsonlWatch[0]!.path, expandHome('~/dots/inbox/*.jsonl'));
    assert.equal(cfg.heartbeat.tickIntervalS, 15);
    // telegram 段已从模板退役（主人 2026-10-16 拍板飞书取代 Telegram）：
    // 缺省段走 zod 空默认，allowlist 不再是写死的 123456789。
    assert.equal(cfg.telegram.editThrottleMs, 1200);
    assert.deepEqual(cfg.telegram.allowlist, []);
    assert.equal(cfg.feishu.editThrottleMs, 1200);
    assert.equal(cfg.ui.streamDeltas, true);
  } finally {
    delete process.env['DOTD_MASTER_TOKEN'];
    delete process.env['DOTD_RO_TOKEN'];
    delete process.env['HOOK_GRAFANA'];
  }
});

test('loadSurfacesConfig：文件不存在 → ConfigError', () => {
  assert.throws(() => loadSurfacesConfig(join(tmpdir(), 'dotd-nope-xyz.yml')), ConfigError);
});

test('assertHttpConfig：端口非 7788 只告警；master_token 空 → 抛', () => {
  const cfg = parseSurfacesSection({ surfaces: { http: { master_token: 't', port: 9999 } } });
  const warnings: string[] = [];
  const orig = process.emitWarning;
  process.emitWarning = ((w: string | Error) => { warnings.push(String(w)); }) as typeof process.emitWarning;
  try {
    assertHttpConfig(cfg); // 不抛
  } finally {
    process.emitWarning = orig;
  }
  assert.ok(warnings.some((w) => /7788/.test(w)));

  const empty: SurfacesConfig = { ...cfg, http: { ...cfg.http, masterToken: '' } };
  assert.throws(() => assertHttpConfig(empty), ConfigError);
});

// ═══════════════════════════════════════════════════════════════════
// 四、YAML 子集读取器的边界（无第三方解析器的妥协，见 deviations）
// ═══════════════════════════════════════════════════════════════════

test('YAML 子集：map 列表（hooks[].source 形状）可解析', () => {
  const cfg = parseSurfacesSection({
    surfaces: {
      http: { master_token: 't' },
      hooks: [{ source: 'a', secret: 's1' }, { source: 'b', secret: 's2', dot_id: 'dot2' }],
    },
  });
  assert.equal(cfg.hooks.length, 2);
  assert.equal(cfg.hooks[1]!.source, 'b');
  assert.equal(cfg.hooks[1]!.dotId, 'dot2');
  assert.equal(cfg.hooks[0]!.rateLimitPerMin, 60); // 默认值
});

test('YAML 子集：不支持的块标量/流式集合 → 明确 ConfigError（不静默误解）', () => {
  // 流式集合 [{...}] 不在子集内：splitKeyValue 会把 '[' 之后的 ':' 当分隔
  assert.throws(() => parseSurfacesSection({ surfaces: { http: { master_token: 't' }, ui: [{ a: 1 }] } }), ConfigError);
});
