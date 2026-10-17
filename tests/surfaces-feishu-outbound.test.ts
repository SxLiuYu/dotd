/**
 * tests/surfaces-feishu-outbound.test.ts —— 任务完成 → 回复发回飞书会话（出站回路）。
 *
 * 覆盖：done+assistant 正文外发；幂等（同 taskId 不重发）；非 feishu 渠道不发；
 * failed 无正文发一行状态通知；超长截断；非终态事件不动作；stop 解订后不再动作。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';

import { startFeishuOutbound, feishuChatIdForThread, lastAssistantText } from '../src/surfaces/feishu-outbound.ts';

const CHAT = 'oc_testchat0000000000000000000000';

interface Sent {
  chatId: string;
  text: string;
}

function seed(dir: ReturnType<typeof makeTempDataDir>, channel: 'feishu' | 'web'): void {
  const db = dir.db;
  const now = Date.now();
  db.prepare('INSERT INTO tasks (id,title,goal,status,priority,created_at,updated_at,thread_id) VALUES (?,?,?,?,?,?,?,?)').run(
    'tk_out1', '你好', '你好', 'running', 1, now, now, 'thr_out1',
  );
  db.prepare(
    'INSERT INTO mem_threads (id,dot_id,channel,external_ref,status,pinned,context_summary_upto_seq,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('thr_out1', 'dot1', channel, channel === 'feishu' ? `feishu:${CHAT}` : 'web:u1', 'active', 0, 0, now, now);
}

function putMessage(dir: ReturnType<typeof makeTempDataDir>, seq: number, role: string, content: string, taskId: string | null = 'tk_out1'): void {
  dir.db
    .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`msg_${seq}`, 'thr_out1', seq, role, 'text', content, taskId, 10, Date.now());
}

function fakeGw(): { calls: Sent[]; sendText(chatId: string, text: string): Promise<{ ok: boolean }> } {
  const calls: Sent[] = [];
  return { calls, sendText: async (chatId, text) => (calls.push({ chatId, text }), { ok: true }) };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('feishuChatIdForThread：feishu 渠道解出 chat_id；web 渠道与缺 ref → null', () => {
  const dir = makeTempDataDir();
  try {
    seed(dir, 'feishu');
    assert.equal(feishuChatIdForThread(dir.db, 'thr_out1'), CHAT);
    assert.equal(feishuChatIdForThread(dir.db, 'thr_missing'), null);
    dir.db.prepare("UPDATE mem_threads SET channel='web' WHERE id='thr_out1'").run();
    assert.equal(feishuChatIdForThread(dir.db, 'thr_out1'), null);
  } finally {
    dir.cleanup();
  }
});

test('lastAssistantText：取该任务 seq 最大的 assistant 正文；只有 user/system → null', () => {
  const dir = makeTempDataDir();
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'user', '你好');
    assert.equal(lastAssistantText(dir.db, 'thr_out1', 'tk_out1'), null);
    putMessage(dir, 2, 'assistant', '第一版');
    putMessage(dir, 3, 'assistant', '最终版');
    assert.equal(lastAssistantText(dir.db, 'thr_out1', 'tk_out1'), '最终版');
    // 别的任务号的正文不算
    putMessage(dir, 4, 'assistant', '别的任务', 'tk_other');
    assert.equal(lastAssistantText(dir.db, 'thr_out1', 'tk_out1'), '最终版');
  } finally {
    dir.cleanup();
  }
});

test('done + feishu 来源 → 外发最后 assistant 正文；重复状态事件不重发', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  const logs: string[] = [];
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'user', '你好');
    putMessage(dir, 2, 'assistant', '你好！👋');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: (m) => logs.push(m) });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(gw.calls, [{ chatId: CHAT, text: '你好！👋' }]);
      // CP 同态再 publish 一次（理论不该，防重投）
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.equal(gw.calls.length, 1);
      assert.ok(logs.some((l) => l.includes('已回复 tk_out1')));
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('done 但线程是 web 渠道 → 不外发', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'web');
    putMessage(dir, 1, 'assistant', 'hi');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.equal(gw.calls.length, 0);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('failed：无 assistant 正文也发一行状态通知（带任务标题）', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'user', '查天气');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'failed', epoch: 1 });
      await settle();
      assert.equal(gw.calls.length, 1);
      const call = gw.calls[0];
      assert.ok(call);
      assert.equal(call.chatId, CHAT);
      assert.match(call.text, /^任务未完成（你好）$/);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('超长正文截断到上限并标注；非终态与无 thread 任务不动作', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'assistant', 'A'.repeat(5000));
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'queued', to: 'running', epoch: 1 });
      dir.bus.publish('task.state', { taskId: 'tk_nothr', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.equal(gw.calls.length, 0);
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.equal(gw.calls.length, 1);
      const call = gw.calls[0];
      assert.ok(call);
      assert.ok(call.text.startsWith('A'.repeat(3800)));
      assert.ok(call.text.endsWith('（已截断）'));
      assert.ok(call.text.length < 4000);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('sendText 失败：只落日志、不记录幂等，下轮同态可再发', async () => {
  const dir = makeTempDataDir();
  let n = 0;
  const gw = { sendText: async (): Promise<{ ok: boolean; error?: string }> => ({ ok: ++n === 1 ? false : true, error: n === 1 ? '网络抖' : undefined }) };
  const logs: string[] = [];
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'assistant', '回你');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: (m) => logs.push(m) });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.ok(logs.some((l) => l.includes('出站失败')));
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.equal(n, 2);
      assert.ok(logs.some((l) => l.includes('已回复')));
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('stop() 解订：之后的事件不再触发动作', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'feishu');
    putMessage(dir, 1, 'assistant', 'hi');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    stop();
    dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
    await settle();
    assert.equal(gw.calls.length, 0);
  } finally {
    dir.cleanup();
  }
});
