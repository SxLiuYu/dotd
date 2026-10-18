/**
 * tests/router-wire-multimodal.test.ts —— 图片要真的发给模型，而不是只给路径。
 *
 * 现场（2026-10-19）：飞书图片已能下载到 home，任务目标里也写明了路径，但实测
 * 模型回答「我这边没有直接的看图能力，是用脚本解析 PNG 像素得出的结论」——
 * 它只能靠 python 解 zlib 读像素，纯色块能凑合，**真实截图根本没法看**。
 *
 * 而模型本身是有视觉能力的（实测 glm/Qwen/deepseek 都能认出纯色方块的颜色）。
 * 缺的是"把图发给它"这一环：`ChatMessage` 只有 content 字符串。
 *
 * 修法：`ChatMessage`/`Message` 加可选 `images`；传输层唯一收口 `toWireMessages`
 * 把它们拼成 OpenAI 的 `content: [{type:'text'},{type:'image_url'}]`。
 * **没有 images 的消息逐字原样返回**（零行为变化）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toWireMessages } from '../src/router/transport.ts';
import type { ChatMessage } from '../src/shared/contracts.ts';

test('无 images 的消息逐字原样返回（零行为变化）', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ];
  const out = toWireMessages(msgs) as unknown[];
  assert.deepEqual(out, msgs, '没有附件的消息必须一个字节都不变');
});

test('带 images 的消息 → content 变成片段数组', () => {
  const msgs: ChatMessage[] = [
    {
      role: 'user',
      content: '这张图是什么颜色？',
      images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    },
  ];
  const out = toWireMessages(msgs) as Array<Record<string, unknown>>;
  const c = out[0]!['content'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(c), 'content 必须变成数组');
  assert.equal(c.length, 2, '一段文本 + 一张图');
  assert.deepEqual(c[0], { type: 'text', text: '这张图是什么颜色？' });
  assert.deepEqual(c[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAAA' },
  });
  // images 字段本身不该出现在线上（它是内部约定）
  assert.equal(out[0]!['images'], undefined, 'images 不能漏到请求体里');
});

test('多条图片 → 多个 image_url 片段', () => {
  const msgs: ChatMessage[] = [
    {
      role: 'user',
      content: '比较这两张',
      images: [
        { url: 'data:image/png;base64,AA' },
        { url: 'data:image/jpeg;base64,BB' },
      ],
    },
  ];
  const c = (toWireMessages(msgs) as Array<{ content: unknown[] }>)[0]!.content;
  assert.equal(c.length, 3, '一段文本 + 两张图');
});

test('混合消息：只有带图的那条被改，其余不动', () => {
  const plain: ChatMessage = { role: 'assistant', content: '好的' };
  const withImg: ChatMessage = { role: 'user', content: '看图', images: [{ url: 'data:x' }] };
  const out = toWireMessages([plain, withImg]) as Array<Record<string, unknown>>;
  assert.equal(typeof out[0]!['content'], 'string', '无图那条仍是字符串');
  assert.ok(Array.isArray(out[1]!['content']), '有图那条是数组');
});

test('源码守卫：toChatMessage 不得丢掉 images', async () => {
  // 现场（2026-10-19）：loadGoalImages 成功、"已加载任务图片"日志也打了，
  // 但 toChatMessage 只返回 { role, content }，附件被整条丢掉 ——
  // 模型收到的仍是纯文本，只能自己写 python 解 PNG 像素。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

  const idx = src.indexOf('function toChatMessage(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n}', src.indexOf('return {', idx)) + 2);
  assert.ok(
    /m\.images === undefined \? \{\} : \{ images: m\.images \}/.test(body),
    'toChatMessage 必须把 images 透传出去（否则多模态在最后一跳丢失）',
  );
});
