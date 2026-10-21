/**
 * tests/connectors/github.test.ts —— GitHub 连接器（打桩 fetch，全程离线不碰网）。
 *
 * 覆盖 task-2 验收点：正常解析（fixture）、分页 Link 头、rateLeft、超时 → 结构化错误不抛、
 * 无 token / 有 token 的请求头与 registry 状态联动、HTTP 错误 / 坏 JSON / 坏形状的折叠。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectorCatalog, GITHUB_TOKEN_ENV } from '../../src/connectors/registry.ts';
import { githubIssues, githubNotifications, githubPulls } from '../../src/connectors/github.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');

/** 把 globalThis.fetch 换成假实现，返回还原函数（写法与 surfaces-channels-web-config.test.ts 一致）。 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

function jsonRes(body: string | unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
test('github.notifications：正常解析 fixture（reason / subject.title / repo / rateLeft）', async () => {
  const restore = stubFetch(async (url) => {
    assert.match(url, /\/notifications/);
    return jsonRes(fixture('github-notifications.json'), 200, { 'x-ratelimit-remaining': '58' });
  });
  try {
    process.env[GITHUB_TOKEN_ENV] = 'gh_test_token';
    const res = await githubNotifications();
    assert.equal(res.ok, true);
    assert.equal(res.rateLeft, 58);
    assert.equal(res.data?.length, 2);
    assert.equal(res.data?.[0]?.reason, 'mention');
    assert.equal(res.data?.[0]?.title, 'fix: connector rate limit');
    assert.equal(res.data?.[0]?.subjectType, 'Issue');
    assert.equal(res.data?.[0]?.repo, 'octo/hello');
    assert.equal(res.data?.[0]?.unread, true);
    assert.equal(res.data?.[1]?.reason, 'review_requested');
    assert.equal(res.data?.[1]?.unread, false);
  } finally {
    delete process.env[GITHUB_TOKEN_ENV];
    restore();
  }
});

test('github.notifications：无 token → 结构化 no_token，不发起网络请求', async () => {
  const saved = process.env[GITHUB_TOKEN_ENV];
  delete process.env[GITHUB_TOKEN_ENV];
  const restore = stubFetch(async () => {
    throw new Error('测试失败：无 token 不该发起请求');
  });
  try {
    const res = await githubNotifications();
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^no_token:/);
  } finally {
    if (saved !== undefined) process.env[GITHUB_TOKEN_ENV] = saved;
    restore();
  }
});

test('github.issues：query 带 state=open&sort=updated；剥离混进来的 PR；客户端兜底倒序', async () => {
  let seenUrl = '';
  const restore = stubFetch(async (url) => {
    seenUrl = url;
    return jsonRes(fixture('github-issues.json'), 200, { 'x-ratelimit-remaining': '57' });
  });
  try {
    const res = await githubIssues('octo', 'hello');
    assert.equal(res.ok, true);
    assert.match(seenUrl, /\/repos\/octo\/hello\/issues/);
    assert.match(seenUrl, /state=open/);
    assert.match(seenUrl, /sort=updated/);
    assert.match(seenUrl, /direction=desc/);
    assert.equal(res.rateLeft, 57);
    // fixture 里 #15 带 pull_request 键（其实是 PR），被剥掉；剩下两条按 updated 倒序
    assert.deepEqual(res.data?.map((i) => i.number), [18, 12]);
    assert.equal(res.data?.[0]?.labels.join(','), 'triage', 'labels 既收对象也收字符串');
    assert.equal(res.data?.[1]?.labels.join(','), 'bug');
    assert.equal(res.data?.[1]?.user, 'alice');
  } finally {
    restore();
  }
});
test('github.pulls：正常解析（draft / user），query 带 state=open&sort=updated', async () => {
  let seenUrl = '';
  const restore = stubFetch(async (url) => {
    seenUrl = url;
    return jsonRes(fixture('github-pulls.json'));
  });
  try {
    const res = await githubPulls('octo', 'hello', { perPage: 10 });
    assert.equal(res.ok, true);
    assert.match(seenUrl, /\/repos\/octo\/hello\/pulls/);
    assert.match(seenUrl, /state=open/);
    assert.match(seenUrl, /per_page=10/);
    assert.equal(res.data?.length, 2);
    assert.equal(res.data?.[0]?.number, 9);
    assert.equal(res.data?.[0]?.draft, true);
    assert.equal(res.data?.[1]?.draft, false);
    assert.equal(res.data?.[1]?.user, 'erin');
  } finally {
    restore();
  }
});

test('分页：Link 头 rel=next/prev → nextPage/prevPage 页码', async () => {
  const link = '<https://api.github.com/notifications?page=2>; rel="next", <https://api.github.com/notifications?page=1>; rel="prev"';
  const restore = stubFetch(async () => jsonRes([], 200, { link }));
  try {
    process.env[GITHUB_TOKEN_ENV] = 'gh_test_token';
    const res = await githubNotifications({ page: 1 });
    assert.equal(res.ok, true);
    assert.equal(res.nextPage, 2);
    assert.equal(res.prevPage, 1);
  } finally {
    delete process.env[GITHUB_TOKEN_ENV];
    restore();
  }
});

test('无 Link 头 → nextPage/prevPage 均为 undefined，不影响 ok', async () => {
  const restore = stubFetch(async () => jsonRes([]));
  try {
    process.env[GITHUB_TOKEN_ENV] = 'gh_test_token';
    const res = await githubNotifications();
    assert.equal(res.ok, true);
    assert.equal(res.nextPage, undefined);
    assert.equal(res.prevPage, undefined);
  } finally {
    delete process.env[GITHUB_TOKEN_ENV];
    restore();
  }
});

test('凭证联动：无 token 请求不带 authorization 头，registry 判 public-only', async () => {
  const saved = process.env[GITHUB_TOKEN_ENV];
  delete process.env[GITHUB_TOKEN_ENV];
  let seenHeaders: Record<string, string> = {};
  const restore = stubFetch(async (_url, init) => {
    seenHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
    return jsonRes([]);
  });
  try {
    const gh = connectorCatalog().find((c) => c.id === 'github');
    assert.equal(gh?.status, 'public-only');
    const res = await githubIssues('octo', 'hello');
    assert.equal(res.ok, true, '未认证仍可查公开仓库');
    assert.equal(seenHeaders['authorization'], undefined, '无 token 不得带 authorization 头');
    assert.equal(seenHeaders['user-agent'], 'dotd-connector');
  } finally {
    if (saved !== undefined) process.env[GITHUB_TOKEN_ENV] = saved;
    restore();
  }
});
test('凭证联动：有 token 请求带 Bearer 头，registry 判 connected', async () => {
  const saved = process.env[GITHUB_TOKEN_ENV];
  process.env[GITHUB_TOKEN_ENV] = 'gh_secret_123';
  let seenHeaders: Record<string, string> = {};
  const restore = stubFetch(async (_url, init) => {
    seenHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
    return jsonRes([]);
  });
  try {
    const gh = connectorCatalog().find((c) => c.id === 'github');
    assert.equal(gh?.status, 'connected');
    const res = await githubPulls('octo', 'hello');
    assert.equal(res.ok, true);
    assert.equal(seenHeaders['authorization'], 'Bearer gh_secret_123');
  } finally {
    if (saved !== undefined) process.env[GITHUB_TOKEN_ENV] = saved;
    else delete process.env[GITHUB_TOKEN_ENV];
    restore();
  }
});

test('HTTP 错误：403 → 结构化 {ok:false}，带 status 与 rateLeft，不抛', async () => {
  const restore = stubFetch(async () =>
    jsonRes({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
  );
  try {
    const res = await githubIssues('octo', 'hello');
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.rateLeft, 0);
    assert.match(res.error ?? '', /^http_403:/);
    assert.match(res.error ?? '', /rate limit/);
  } finally {
    restore();
  }
});

test('网络错误：fetch reject → 结构化 network 错误，不抛', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    const res = await githubIssues('octo', 'hello');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^network: fetch failed/);
  } finally {
    restore();
  }
});

test('超时：AbortSignal 触发 → 结构化 timeout 错误，不抛（15s 默认可被 opts 收短）', async () => {
  const restore = stubFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  });
  try {
    const res = await githubIssues('octo', 'hello', { timeoutMs: 30 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^timeout:/);
    assert.match(res.error ?? '', /30ms/);
  } finally {
    restore();
  }
});

test('坏 JSON：响应体不是合法 JSON → 结构化 bad_json，不抛', async () => {
  const restore = stubFetch(async () => jsonRes('not json at all'));
  try {
    const res = await githubIssues('octo', 'hello');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^bad_json:/);
  } finally {
    restore();
  }
});

test('坏形状：JSON 是对象不是数组 → 结构化 bad_shape，不抛', async () => {
  const restore = stubFetch(async () => jsonRes({ message: 'unexpected object' }));
  try {
    const res = await githubPulls('octo', 'hello');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^bad_shape:/);
  } finally {
    restore();
  }
});