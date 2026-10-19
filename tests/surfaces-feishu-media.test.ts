/**
 * tests/surfaces-feishu-media.test.ts —— 飞书图片消息（多模态输入）。
 *
 * 现场（2026-10-18 对标 OpenAI bot）：主人发张截图问"这是什么"，
 * bot **当没看见** —— inbound 把非文本消息一律 `ignore: non_text`。
 *
 * 飞书图片消息的 content 只有 `{"image_key":"img_xxx"}`，本体要另调
 * `GET /open-apis/im/v1/images/{image_key}`。本模块把它换成一个 home 内的文件，
 * 再在任务目标里写明路径，模型就能据此作答。
 *
 * 关键纪律：**下载失败也要建任务**，并把失败原因如实写进去——
 * 静默当没收到图会让主人以为 bot 眼瞎。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { imageKeyOf } from '../src/surfaces/feishu-media.ts';
import { classifyFeishuInbound } from '../src/surfaces/feishu-inbound.ts';

test('imageKeyOf：只认 image 类型且有 image_key', () => {
  assert.equal(imageKeyOf('image', '{"image_key":"img_v3_abc"}'), 'img_v3_abc');
  assert.equal(imageKeyOf('text', '{"text":"hi"}'), null, '文本消息没有 image_key');
  assert.equal(imageKeyOf('image', '{}'), null, '没有 image_key');
  assert.equal(imageKeyOf('image', 'not json'), null, '坏 JSON 不抛');
});

test('分类：图片消息不再被 ignore，而是带 imageKey 的 message', () => {
  const body = {
    schema: '2.0',
    header: { event_id: 'ev_img_1', event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: 'om_1',
        chat_id: 'oc_owner',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_xyz' }),
      },
      sender: { sender_type: 'user' },
    },
  };
  const d = classifyFeishuInbound(body, { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true });
  assert.equal(d.kind, 'message', `应建任务，实际 ${d.kind}${'reason' in d ? ':' + d.reason : ''}`);
  if (d.kind === 'message') {
    assert.equal(d.imageKey, 'img_v3_xyz');
    assert.ok(d.text.length > 0, 'text 不能为空（会用来建任务标题）');
  }
});

test('分类：图片消息缺 image_key → 仍然 ignore（不建空任务）', () => {
  const body = {
    schema: '2.0',
    header: { event_id: 'ev_img_2', event_type: 'im.message.receive_v1' },
    event: {
      message: { message_id: 'om_2', chat_id: 'oc_owner', message_type: 'image', content: '{}' },
      sender: { sender_type: 'user' },
    },
  };
  const d = classifyFeishuInbound(body, { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true });
  assert.equal(d.kind, 'ignore');
  if (d.kind === 'ignore') assert.ok(d.detail.includes('image_key'), `detail 应说清原因，实际 ${d.detail}`);
});

// 注：audio 自 2026-10-19 起不再 ignore（改为明确回复"暂不支持转文字"），
// 断言见 tests/surfaces-feishu-audio.test.ts。这里只钉住真正不支持的媒体类型。
test('分类：其它非文本媒体仍然 ignore（不误建任务）', () => {
  // 注意：file / audio 已单独支持（见上面与 audio 用例），这里只测仍不支持的。
  for (const t of ['media', 'sticker', 'video']) {
    const body = {
      schema: '2.0',
      header: { event_id: `ev_${t}`, event_type: 'im.message.receive_v1' },
      event: {
        message: { message_id: 'om', chat_id: 'oc_owner', message_type: t, content: '{"file_key":"f"}' },
        sender: { sender_type: 'user' },
      },
    };
    const d = classifyFeishuInbound(body, { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true });
    assert.equal(d.kind, 'ignore', `${t} 应被忽略`);
  }
});

test('文件消息（PDF/Excel）不再被忽略，而是带 fileKey 的 message', () => {
  // 2026-10-19：主人发 PDF/Excel 时 content 只有 file_key + file_name，
  // 原来一律 ignore —— bot 当没看见。这是对标 OpenAI bot 的明显缺口。
  const body = {
    schema: '2.0',
    header: { event_id: 'ev_file_1', event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: 'om_file_1',
        chat_id: 'oc_owner',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_abc', file_name: '季度报告.pdf' }),
      },
      sender: { sender_type: 'user' },
    },
  };
  const d = classifyFeishuInbound(body, { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true });
  assert.equal(d.kind, 'message', `应建任务，实际 ${d.kind}${'reason' in d ? ':' + d.reason : ''}`);
  if (d.kind === 'message') {
    assert.equal(d.fileKey, 'file_v3_abc');
    assert.equal(d.fileName, '季度报告.pdf');
    assert.equal(d.messageId, 'om_file_1', '下载文件需要 message_id');
    assert.ok(d.text.includes('季度报告.pdf'), 'text 里应带文件名');
  }
});

test('文件消息缺 file_key → ignore（不建空任务）', () => {
  const body = {
    schema: '2.0',
    header: { event_id: 'ev_file_2', event_type: 'im.message.receive_v1' },
    event: {
      message: { message_id: 'om2', chat_id: 'oc_owner', message_type: 'file', content: '{}' },
      sender: { sender_type: 'user' },
    },
  };
  const d = classifyFeishuInbound(body, { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true });
  assert.equal(d.kind, 'ignore');
  if (d.kind === 'ignore') assert.ok(d.detail.includes('file_key'), `detail 应说清原因，实际 ${d.detail}`);
});
