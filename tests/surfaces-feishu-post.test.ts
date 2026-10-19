/**
 * tests/surfaces-feishu-post.test.ts —— 飞书富文本消息（post）必须被处理。
 *
 * 现场（2026-10-19）：主人在飞书里发带格式的消息（加粗、链接、分段、标题），
 * 走的是 `message_type: 'post'`，content 结构是
 * `{zh_cn:{title, content:[[{tag,text,href}...]]}}` —— **没有 text 字段**。
 * 原代码只认 `parsed.text`，于是 rich text 一律落进 `ignore(non_text)`：
 * 主人发了一段排版好的话，bot 当没看见。
 *
 * 修复踩了两个坑（都值得记）：
 *  ① 只加 flatten 不够 —— 下游 `msgType !== 'text'` 又把拍平好的文本丢掉；
 *  ② 拍平函数本身要能处理 title/段落/链接/at/图片/语言回退/坏 JSON。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFeishuInbound, flattenPostContent } from '../src/surfaces/feishu-inbound.ts';

const CHAT = 'oc_owner_chat';

function envelope(type: string, content: unknown): unknown {
  return {
    schema: '2.0',
    header: { event_id: 'ev_x', event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: 'om_x',
        chat_id: CHAT,
        message_type: type,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      },
      sender: { sender_type: 'user' },
    },
  };
}

const CFG = { ownerChatId: CHAT, dotId: 'dot1', trustedTransport: true };

// ── flattenPostContent ──────────────────────────────────────────────

test('flatten：标题 + 多段 + 链接', () => {
  const out = flattenPostContent(
    JSON.stringify({
      zh_cn: {
        title: '项目进度',
        content: [
          [{ tag: 'text', text: '这个季度完成了' }],
          [{ tag: 'text', text: '三件事' }, { tag: 'a', text: '文档', href: 'https://e.com' }],
        ],
      },
    }),
  );
  assert.equal(out, '项目进度\n这个季度完成了\n三件事文档(https://e.com)');
});

test('flatten：@ 与图片占位', () => {
  const out = flattenPostContent(
    JSON.stringify({
      zh_cn: { content: [[{ tag: 'at', text: '张三' }, { tag: 'text', text: ' 看这个 ' }, { tag: 'img' }]] },
    }),
  );
  assert.equal(out, '@张三 看这个 [图片]');
});

test('flatten：非中文语言键也能回退', () => {
  const out = flattenPostContent(
    JSON.stringify({ en_us: { content: [[{ tag: 'text', text: 'hello' }]] } }),
  );
  assert.equal(out, 'hello');
});

test('flatten：坏 JSON / 空结构 → 空串，不抛', () => {
  assert.equal(flattenPostContent('not json'), '');
  assert.equal(flattenPostContent('{}'), '');
});

// ── 端到端：classifyFeishuInbound ───────────────────────────────────

test('post 消息被识别为可执行消息（不是 ignore）', () => {
  const d = classifyFeishuInbound(
    envelope('post', {
      zh_cn: { title: '进度', content: [[{ tag: 'text', text: '三件事' }]] },
    }),
    CFG,
  );
  assert.equal(d.kind, 'message', '富文本应建任务，而不是被当非文本忽略');
  if (d.kind === 'message') {
    assert.match(d.text, /进度/);
    assert.match(d.text, /三件事/);
  }
});

test('纯文本行为不变', () => {
  const d = classifyFeishuInbound(envelope('text', { text: '你好' }), CFG);
  assert.equal(d.kind, 'message');
});

// 注：audio 自 2026-10-19 起不再 ignore（改为明确回复"暂不支持转文字"），
// 断言见 tests/surfaces-feishu-audio.test.ts。这里只钉住真正无声无息的那几类。
test('真正不支持且不常见输入的类型仍然 ignore（media/sticker）', () => {
  for (const t of ['media', 'sticker']) {
    const d = classifyFeishuInbound(envelope(t, { file_key: 'fk' }), CFG);
    assert.equal(d.kind, 'ignore', `${t} 应仍被忽略`);
  }
});
