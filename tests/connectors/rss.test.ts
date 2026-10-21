/**
 * tests/connectors/rss.test.ts —— RSS/Atom 连接器（打桩 fetch，全程离线不碰网）。
 *
 * 覆盖 task-2 验收点：RSS 2.0 与 Atom 各一 fixture；命名空间容错（content:encoded / dc:date /
 * atom:link）；CDATA 与 HTML 基本实体；去重键 = link；坏 XML / 网络错 / 超时 → 结构化错误不抛。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchFeed } from '../../src/connectors/rss.ts';

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

function xmlRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
}

test('RSS 2.0：标题 CDATA、实体解码、content:encoded 优先、dc:date 兜底', async () => {
  const restore = stubFetch(async (url) => {
    assert.equal(url, 'https://weekly.example.com/rss');
    return xmlRes(fixture('rss2.xml'));
  });
  try {
    const res = await fetchFeed('https://weekly.example.com/rss');
    assert.equal(res.ok, true);
    assert.equal(res.title, '科技周报 & More', 'CDATA 标题按原文收');
    assert.equal(res.items?.length, 2, '同 link 的重复条目应去重（3 条 → 2 条）');
    const first = res.items?.[0];
    assert.equal(first?.title, '一号 & 二号齐发');
    assert.equal(first?.link, 'https://weekly.example.com/posts/1?utm=rss&src=feed');
    assert.equal(first?.published, 'Wed, 11 Feb 2026 08:00:00 GMT');
    assert.equal(first?.text, '正文 加粗 与 "引号"', 'CDATA 包 HTML：解实体 + 剥标签');
    const third = res.items?.[1];
    assert.equal(third?.title, '第三条：无 pubDate 只有 dc:date');
    assert.equal(third?.published, '2026-02-10T12:00:00+08:00', 'dc:date 是 pubDate 缺席时的兜底');
    assert.equal(third?.text, "数字实体 'single' 与 标签", '数字实体与转义标签都处理');
  } finally {
    restore();
  }
});

test('去重键 = link：先到者保留', async () => {
  const restore = stubFetch(async () =>
    xmlRes(
      '<rss version="2.0"><channel><title>t</title>' +
        '<item><title>a</title><link>https://x.example.com/1</link></item>' +
        '<item><title>b</title><link>https://x.example.com/1</link></item>' +
        '<item><title>c</title><link>https://x.example.com/2</link></item>' +
        '</channel></rss>',
    ),
  );
  try {
    const res = await fetchFeed('https://x.example.com/feed');
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.items?.map((i) => i.title),
      ['a', 'c'],
      '第二条同 link 丢弃，保留先到的 a',
    );
  } finally {
    restore();
  }
});
test('Atom：link href 属性（rel=alternate 优先）、published 优先于 updated、content 转义 HTML', async () => {
  const restore = stubFetch(async () => xmlRes(fixture('atom.xml')));
  try {
    const res = await fetchFeed('https://example.org/feed.atom');
    assert.equal(res.ok, true);
    assert.equal(res.title, 'Example Atom');
    assert.equal(res.items?.length, 2);
    const first = res.items?.[0];
    assert.equal(first?.title, 'First post & news');
    assert.equal(first?.link, 'https://example.org/posts/1', 'rel=alternate 优先于 enclosure');
    assert.equal(first?.published, '2026-02-11T09:00:00Z', '<published> 优先于 <updated>');
    assert.equal(first?.text, 'Hello world & friends', '转义 HTML → 纯文本');
    const second = res.items?.[1];
    assert.equal(second?.title, 'Second <update>', '实体解出的尖括号在标题里是字面量');
    assert.equal(second?.link, 'https://example.org/posts/2', '不带 rel 的 link 直接取 href');
    assert.equal(second?.published, '2026-02-12T08:00:00Z', '无 <published> 时退 <updated>');
    assert.equal(second?.text, 'Plain & simple');
  } finally {
    restore();
  }
});

test('命名空间容错：前缀标签按 local name 匹配（fixture 内 content:encoded / dc:date / atom:link 已过）', async () => {
  const restore = stubFetch(async () =>
    xmlRes(
      '<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>' +
        '<dc:title>带前缀的频道标题</dc:title>' +
        '<item><title>ok</title><link>https://x.example.com/9</link><dc:date>2026-01-01T00:00:00Z</dc:date></item>' +
        '</channel></rss>',
    ),
  );
  try {
    const res = await fetchFeed('https://x.example.com/feed');
    assert.equal(res.ok, true);
    // channel 标题仍从标准 <title> 找；item 级 dc:date 已在 RSS 2.0 用例验证过 —— 这里验证带前缀标签不炸解析
    assert.deepEqual(res.items?.map((i) => i.published), ['2026-01-01T00:00:00Z']);
  } finally {
    restore();
  }
});

test('坏 XML：根元素不是订阅源（HTML 页面）→ 结构化 bad_xml，不抛', async () => {
  const restore = stubFetch(async () => xmlRes('<html><body>not a feed</body></html>'));
  try {
    const res = await fetchFeed('https://x.example.com/page');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^bad_xml:/);
  } finally {
    restore();
  }
});

test('截断的 XML：不炸；已完整条目照常收，截断尾巴按已收到的字段尽力保留', async () => {
  const restore = stubFetch(async () =>
    xmlRes(
      '<rss version="2.0"><channel><title>trunc</title>' +
        '<item><title>complete</title><link>https://x.example.com/1</link></item>' +
        '<item><title>cut off</title><link>https://x.example.com/2</lin',
    ),
  );
  try {
    const res = await fetchFeed('https://x.example.com/feed');
    assert.equal(res.ok, true, '解析器容错：截断不炸');
    assert.equal(res.items?.length, 2, '尾巴上开着的 <item> 已挂在树上，按 best-effort 保留');
    assert.equal(res.items?.[0]?.title, 'complete');
    assert.equal(res.items?.[1]?.title, 'cut off');
    assert.equal(res.items?.[1]?.link, 'https://x.example.com/2', 'link 文本已收全，照常可用');
  } finally {
    restore();
  }
});

test('空 feed：有频道无条目 → items 为空数组、不报错', async () => {
  const restore = stubFetch(async () =>
    xmlRes('<rss version="2.0"><channel><title>empty</title></channel></rss>'),
  );
  try {
    const res = await fetchFeed('https://x.example.com/feed');
    assert.equal(res.ok, true);
    assert.equal(res.title, 'empty');
    assert.deepEqual(res.items, []);
  } finally {
    restore();
  }
});
test('HTTP 错误：404 → 结构化 http_404，不抛', async () => {
  const restore = stubFetch(async () => xmlRes('gone', 404));
  try {
    const res = await fetchFeed('https://x.example.com/gone');
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.match(res.error ?? '', /^http_404:/);
  } finally {
    restore();
  }
});

test('网络错误：fetch reject → 结构化 network 错误，不抛', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    const res = await fetchFeed('https://x.example.com/feed');
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
    const res = await fetchFeed('https://slow.example.com/feed', { timeoutMs: 30 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /^timeout:/);
    assert.match(res.error ?? '', /30ms/);
  } finally {
    restore();
  }
});