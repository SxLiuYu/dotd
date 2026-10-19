/**
 * tests/surfaces-feishu-audio.test.ts —— 语音消息要被明确回复，而不是静默丢弃。
 *
 * 现场（2026-10-19）：主人发语音，`message_type: 'audio'`，content = {file_key, duration}。
 * 原代码没有 audio 分支，落进 `ignore(non_text)` —— **说了半天没有任何反应**，
 * 分不清是没收到、正在处理、还是坏了。这是最差的体验。
 *
 * 当前**没有语音转写能力**（容器无 ffmpeg/whisper，模型配置未声明音频输入），
 * 所以正确的做法不是假装能听懂，而是：
 *   ① 建任务（让主人收到回复）；
 *   ② 明确说"收到了但暂时转不了文字"，并给替代方案。
 *
 * 诚实的能力边界 > 静默失败。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFeishuInbound } from '../src/surfaces/feishu-inbound.ts';

const CHAT = 'oc_owner';
const CFG = { ownerChatId: CHAT, dotId: 'dot1', trustedTransport: true };

function env(type: string, content: unknown): unknown {
  return {
    schema: '2.0',
    header: { event_id: 'ev', event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: 'om',
        chat_id: CHAT,
        message_type: type,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      },
      sender: { sender_type: 'user' },
    },
  };
}

test('语音消息被识别为可执行消息（不是 ignore）', () => {
  const d = classifyFeishuInbound(env('audio', { file_key: 'fk_a', duration: 12000 }), CFG);
  assert.equal(d.kind, 'message', '语音不应被静默丢弃');
  if (d.kind === 'message') {
    assert.match(d.text, /语音/, '回复里要提到"语音"');
    assert.match(d.text, /不支持/, '要明说暂不支持转文字');
    assert.match(d.text, /12 秒/, '有时长就带上，让主人确认是哪条');
  }
});

test('无时长字段也能处理（不崩、不丢）', () => {
  const d = classifyFeishuInbound(env('audio', { file_key: 'fk_b' }), CFG);
  assert.equal(d.kind, 'message');
  if (d.kind === 'message') assert.match(d.text, /语音/);
});

test('content 是坏 JSON 时同样给出明确回复', () => {
  const d = classifyFeishuInbound(env('audio', 'not json at all'), CFG);
  assert.equal(d.kind, 'message', '解析失败也不该消失');
});

test('视频/表情仍然 ignore（确实没能力，且不是常见输入）', () => {
  for (const t of ['media', 'sticker']) {
    const d = classifyFeishuInbound(env(t, { file_key: 'fk' }), CFG);
    assert.equal(d.kind, 'ignore', `${t} 应仍被忽略`);
  }
});
