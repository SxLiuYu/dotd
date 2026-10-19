import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * tests/surfaces-feishu-file-message.test.ts —— 飞书文件消息（PDF/Excel/Word）。
 *
 * 2026-10-19：主人发 PDF 时 content 只有 {file_key, file_name}，原来一律 ignore ——
 * bot 当没看见。对标 OpenAI bot 这是明显缺口（它支持上传 PDF/Excel）。
 *
 * 已验证：分类器正确识别（本文件）。
 * 未能端到端验证的部分（如实记录）：飞书限制 **bot 不能下载自己发出的文件消息的资源**
 * （报 "File not in msg"），所以只能靠主人真发一个文件来验证下载那一步。
 * 下载端点与参数按官方文档实现：GET /im/v1/messages/{message_id}/resources/{file_key}?type=file
 */

import { classifyFeishuInbound } from '../src/surfaces/feishu-inbound.ts';

const base = (msgType: string, content: unknown) => ({
  schema: '2.0',
  header: { event_id: `ev_${msgType}`, event_type: 'im.message.receive_v1' },
  event: {
    message: {
      message_id: 'om_test_1',
      chat_id: 'oc_owner',
      message_type: msgType,
      content: JSON.stringify(content),
    },
    sender: { sender_type: 'user' },
  },
});

const cfg = { ownerChatId: 'oc_owner', dotId: 'dot1', trustedTransport: true };

test('PDF 文件消息 → 建任务，带 fileKey/fileName/messageId', () => {
  const d = classifyFeishuInbound(base('file', { file_key: 'file_v3_x', file_name: '报告.pdf' }), cfg);
  assert.equal(d.kind, 'message');
  if (d.kind === 'message') {
    assert.equal(d.fileKey, 'file_v3_x');
    assert.equal(d.fileName, '报告.pdf');
    assert.equal(d.messageId, 'om_test_1');
  }
});

test('Excel / Word 同样识别', () => {
  for (const name of ['销售数据.xlsx', '会议纪要.docx']) {
    const d = classifyFeishuInbound(base('file', { file_key: 'fk', file_name: name }), cfg);
    assert.equal(d.kind, 'message', `${name} 应建任务`);
    if (d.kind === 'message') assert.equal(d.fileName, name);
  }
});

test('文件消息缺 file_key → ignore（不建空任务）', () => {
  const d = classifyFeishuInbound(base('file', {}), cfg);
  assert.equal(d.kind, 'ignore');
  if (d.kind === 'ignore') assert.ok(d.detail.includes('file_key'));
});

test('附言与文件并存时，附言作为 text', () => {
  const body = base('file', { file_key: 'fk', file_name: 'a.pdf' });
  (body.event.message as Record<string, unknown>)['content'] = JSON.stringify({
    file_key: 'fk',
    file_name: 'a.pdf',
  });
  const d = classifyFeishuInbound(body, cfg);
  assert.equal(d.kind, 'message');
  if (d.kind === 'message') assert.ok(d.text.includes('a.pdf'), '默认 text 会带上文件名');
});
