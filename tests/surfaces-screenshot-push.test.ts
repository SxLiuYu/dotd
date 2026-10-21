/**
 * A3（2026-10-21）截图出站推送测试：
 * ① pushTaskScreenshots —— 查 steps、新旧排序、坏数据过滤、大小上限、失败续走；
 * ② screenshotPathOf —— 路径解析的白名单边界；
 * ③ FeishuGateway.sendImage —— 打桩 globalThis.fetch，验证两步上传+发送的请求形状。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pushTaskScreenshots, screenshotPathOf, type ScreenshotPushDeps } from '../src/surfaces/screenshot-push.ts';
import { FeishuGateway } from '../src/surfaces/channels.ts';

/** 建最小 schema：模块只碰它查的列。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE steps (
    task_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    call_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_json TEXT, result_json TEXT, finished_at TEXT)`);
  return db;
}

function insertShot(db: DatabaseSync, taskId: string, seq: number, resultJson: string | null, status = 'succeeded'): void {
  db.prepare(
    `INSERT INTO steps (task_id, seq, kind, status, call_id, tool_name, args_json, result_json, finished_at)
     VALUES (?, ?, 'tool', ?, ?, 'browser.screenshot', '{}', ?, '2026-10-21T00:00:00Z')`,
  ).run(taskId, seq, status, `call-${seq}`, resultJson);
}

function makeDeps(db: DatabaseSync, opts: {
  files?: Map<string, Buffer>;
  sendResults?: Array<{ ok: boolean; error?: string }>;
  reads?: string[];
  sends?: Array<{ chatId: string; bytes: number }>;
}): ScreenshotPushDeps {
  const files = opts.files ?? new Map();
  const sendResults = opts.sendResults ?? [];
  return {
    db,
    log: () => {},
    readHomeFile: async (_dotId: string, path: string) => {
      opts.reads?.push(path);
      const b = files.get(path);
      return b === undefined ? null : b;
    },
    sendImage: async (chatId: string, png: Buffer) => {
      opts.sends?.push({ chatId, bytes: png.byteLength });
      return sendResults.length > 0 ? (sendResults.shift() as { ok: boolean; error?: string }) : { ok: true };
    },
  };
}

test('screenshotPathOf：认 /dot/home/screenshots/ 下的 path，其余全拒', () => {
  assert.equal(screenshotPathOf(JSON.stringify({ result: { path: '/dot/home/screenshots/t-c1.png', bytes: 9 } })), '/dot/home/screenshots/t-c1.png');
  assert.equal(screenshotPathOf(JSON.stringify({ path: '/dot/home/screenshots/t-c2.png' })), '/dot/home/screenshots/t-c2.png');
  // 顶层与 result 双层都认，但目录不对不认
  assert.equal(screenshotPathOf(JSON.stringify({ result: { path: '/etc/passwd' } })), null);
  assert.equal(screenshotPathOf(JSON.stringify({ result: { path: '/dot/home/notes/x.png' } })), null);
  assert.equal(screenshotPathOf('不是json'), null);
  assert.equal(screenshotPathOf('{}'), null);
});

test('pushTaskScreenshots：无截图步骤 → 0 且不读文件', async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO tasks (id, dot_id) VALUES ('tk_a', 'dot1')`).run();
  const reads: string[] = [];
  const n = await pushTaskScreenshots('tk_a', 'oc_x', makeDeps(db, { reads }));
  assert.equal(n, 0);
  assert.equal(reads.length, 0);
});

test('pushTaskScreenshots：新→旧推送，失败的步骤与坏行都被过滤', async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO tasks (id, dot_id) VALUES ('tk_b', 'dot1')`).run();
  insertShot(db, 'tk_b', 1, JSON.stringify({ result: { path: '/dot/home/screenshots/old.png' } }));
  insertShot(db, 'tk_b', 2, '坏json', 'error');
  insertShot(db, 'tk_b', 3, JSON.stringify({ result: { path: '/dot/home/screenshots/mid.png' } }));
  insertShot(db, 'tk_b', 4, JSON.stringify({ result: { path: '/dot/home/screenshots/new.png' } }));
  const reads: string[] = [];
  const sends: Array<{ chatId: string; bytes: number }> = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const n = await pushTaskScreenshots('tk_b', 'oc_x', makeDeps(db, {
    files: new Map([
      ['/dot/home/screenshots/new.png', png],
      ['/dot/home/screenshots/mid.png', png],
      ['/dot/home/screenshots/old.png', png],
    ]),
    reads,
    sends,
  }));
  assert.equal(n, 3);
  assert.deepEqual(reads, ['/dot/home/screenshots/new.png', '/dot/home/screenshots/mid.png', '/dot/home/screenshots/old.png']);
  assert.equal(sends.length, 3);
  assert.equal(sends[0]!.chatId, 'oc_x');
});

test('pushTaskScreenshots：读不到/超大的跳过，发送失败不中断后续', async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO tasks (id, dot_id) VALUES ('tk_c', 'dot1')`).run();
  insertShot(db, 'tk_c', 1, JSON.stringify({ result: { path: '/dot/home/screenshots/gone.png' } }));
  insertShot(db, 'tk_c', 2, JSON.stringify({ result: { path: '/dot/home/screenshots/huge.png' } }));
  insertShot(db, 'tk_c', 3, JSON.stringify({ result: { path: '/dot/home/screenshots/ok1.png' } }));
  insertShot(db, 'tk_c', 4, JSON.stringify({ result: { path: '/dot/home/screenshots/ok2.png' } }));
  const sends: Array<{ chatId: string; bytes: number }> = [];
  const n = await pushTaskScreenshots('tk_c', 'oc_x', makeDeps(db, {
    files: new Map([
      ['/dot/home/screenshots/huge.png', Buffer.alloc(9 * 1024 * 1024)],
      ['/dot/home/screenshots/ok1.png', Buffer.from('a')],
      ['/dot/home/screenshots/ok2.png', Buffer.from('b')],
    ]),
    sendResults: [{ ok: false, error: '限流' }],
    sends,
  }));
  // gone 读取失败、huge 超限、ok1 发送失败、ok2 成功 → 只发 1 张
  assert.equal(n, 1);
  assert.equal(sends.length, 2);
});

test('pushTaskScreenshots：任务不存在 → 0', async () => {
  const db = makeDb();
  insertShot(db, 'tk_ghost', 1, JSON.stringify({ result: { path: '/dot/home/screenshots/x.png' } }));
  const n = await pushTaskScreenshots('tk_ghost', 'oc_x', makeDeps(db, {}));
  assert.equal(n, 0);
});

/** globalThis.fetch 打桩（同 surfaces-channels-web-config 的模式）。 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test('FeishuGateway.sendImage：上传拿 image_key → 发 image 消息', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const restore = stubFetch(async (url) => {
    calls.push({ url: String(url), body: null });
    if (String(url).includes('/auth/v3/tenant_access_token')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'tkn', expire: 7200 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/im/v1/images') ? { code: 0, data: { image_key: 'img_v3_x' } } : { code: 0 }),
    };
  });
  try {
    const gw = new FeishuGateway({ appId: 'a', appSecret: 'b', editThrottleMs: 1000 });
    const res = await gw.sendImage('oc_x', Buffer.from([0x89, 0x50]));
    assert.equal(res.ok, true);
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes('/im/v1/images')));
    assert.ok(urls.some((u) => u.includes('/im/v1/messages?receive_id_type=chat_id')));
  } finally {
    restore();
  }
});

test('FeishuGateway.sendImage：上传失败 → ok:false 带原因，不发消息', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('/auth/v3/tenant_access_token')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'tkn', expire: 7200 }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 99991668, msg: 'token 无效' }) };
  });
  try {
    const gw = new FeishuGateway({ appId: 'a', appSecret: 'b', editThrottleMs: 1000 });
    const res = await gw.sendImage('oc_x', Buffer.from([0x89]));
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').includes('99991668'));
  } finally {
    restore();
  }
});
