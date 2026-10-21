/**
 * tests/surfaces-feishu-outbound.test.ts —— 任务完成 → 回复发回飞书会话（出站回路）。
 *
 * 覆盖：done+assistant 正文外发；幂等（同 taskId 不重发）；非 feishu 渠道不发；
 * failed 无正文发一行状态通知；超长截断；非终态事件不动作；stop 解订后不再动作。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';

import {
  formatExpiry,
  renderApprovalCard,
  startFeishuOutbound,
  feishuChatIdForThread,
  lastAssistantText,
} from '../src/surfaces/feishu-outbound.ts';
import type { ApprovalView } from '../src/shared/contracts.ts';

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
      assert.ok(logs.some((l) => l.includes('已发送 tk_out1')));
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
      // 2026-10-21：上限从 3800 收到 600 并改为「折叠 + 指路」。
      // 这串 A 没有句子边界，所以走硬切 —— 断言的就是硬切的下限行为。
      // 2026-10-21 二次修正：原断言是 startsWith('A'.repeat(600))。
      // 那条断言会让「601 字裁成 655 字」通过 —— 因为前 600 字
      // 确实原样保留了，只是后面又加了 55 字提示语，总长反而超过原文。
      // 折叠的第一要务是「别让消息变大」，所以先预留提示语空间（约 55 字），
      // 正文保留约 545 字。这里断言真正的不变量，而不是某次实现的细节。
      assert.ok(call.text.startsWith('A'.repeat(540)), '正文保留大部分（预留提示语空间后）');
      assert.ok(call.text.includes('还有'), '要说清还有多少字没发');
      assert.ok(call.text.includes('dotd task'), '要指路去哪看全文');
      assert.ok(call.text.length <= 600, '不超上限（这才是折叠的定义）');
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
      assert.ok(logs.some((l) => l.includes('已发送')));
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

// ═══════════════════════════════════════════════════════════════════
// 审批推送：任务卡在审批时，主人必须在手机上看到，而不是 24h 后作废
//
// 背景：approval TTL 24h，任务在 awaiting_approval 时 Runner 让位、整个任务停着；
// 而原出站只订阅 task.state 的 done/failed —— 飞书完全静默。
// ═══════════════════════════════════════════════════════════════════

function approvalView(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 42,
    seq: 7,
    kind: 'tool_call',
    tier: 'dangerous',
    status: 'pending',
    summary: 'shell.run: rm -rf /dot/home/notes/old',
    fullParams: { cmd: 'rm -rf /dot/home/notes/old' },
    reason: '危险命令命中规则',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    taskRef: { taskId: 'tk_out1', journalStepId: 'st_1' },
    ...over,
  };
}

test('approval:created → 推一张能看懂的审批卡片（说清要批什么/批了会怎样/怎么回）', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  const logs: string[] = [];
  try {
    seed(dir, 'feishu');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: (m) => logs.push(m) });
    try {
      dir.bus.publish('approval:created', approvalView(), { dotId: 'dot1' });
      await settle();
      assert.equal(gw.calls.length, 1, '必须推一条');
      const text = gw.calls[0]!.text;
      assert.equal(gw.calls[0]!.chatId, CHAT, '发回主人原会话');
      assert.match(text, /需要你批准/, '第一行就说清要你决定什么');
      assert.match(text, /rm -rf/, '要写清具体操作（summary）');
      assert.match(text, /dangerous/, '要带风险档位');
      assert.match(text, /危险命令命中规则/, '要带拦下原因');
      assert.match(text, /批准 42/, '要给出可以直接照做的回复指令');
      assert.match(text, /拒绝 42/);
      assert.match(text, /还有约/, '要说清还有多久过期');
      assert.ok(logs.some((l) => l.includes('已发送 approval:42')));
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('同一条审批重复 publish 不重复推（防重投刷屏）', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'feishu');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    try {
      dir.bus.publish('approval:created', approvalView(), { dotId: 'dot1' });
      dir.bus.publish('approval:created', approvalView(), { dotId: 'dot1' });
      await settle();
      assert.equal(gw.calls.length, 1);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('非飞书来源任务的审批不外发（主人在电脑前，Web UI 已经亮了）', async () => {
  const dir = makeTempDataDir();
  const gw = fakeGw();
  try {
    seed(dir, 'web');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {} });
    try {
      dir.bus.publish('approval:created', approvalView(), { dotId: 'dot1' });
      await settle();
      assert.equal(gw.calls.length, 0);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('审批推送失败只落日志，不影响同一时刻的任务完成回复', async () => {
  const dir = makeTempDataDir();
  let n = 0;
  const calls: Sent[] = [];
  const gw = {
    sendText: async (chatId: string, text: string): Promise<{ ok: boolean; error?: string }> => {
      n += 1;
      if (n === 1) return { ok: false, error: '审批卡片超时' };
      calls.push({ chatId, text });
      return { ok: true };
    },
  };
  const logs: string[] = [];
  try {
    seed(dir, 'feishu');
    putMessage(dir, 2, 'assistant', '干完了');
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: (m) => logs.push(m) });
    try {
      dir.bus.publish('approval:created', approvalView(), { dotId: 'dot1' });
      await settle();
      dir.bus.publish('task.state', { taskId: 'tk_out1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.ok(logs.some((l) => l.includes('approval:42') && l.includes('失败')), '失败要留痕');
      assert.deepEqual(calls, [{ chatId: CHAT, text: '干完了' }], '后续回复照常发出');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('renderApprovalCard：无 summary 时不出现空白；过期的说"已过期"', () => {
  const text = renderApprovalCard(
    approvalView({ summary: '', expiresAt: new Date(Date.now() - 1000).toISOString(), tier: null, reason: '' }),
    null,
  );
  assert.ok(!text.includes('要做的操作：\n'), '不能留空行占位');
  assert.match(text, /已过期/);
  assert.match(text, /tool_call/, '缺 summary 时退回 kind，不出现 undefined');
  assert.ok(!text.includes('undefined'));
});
