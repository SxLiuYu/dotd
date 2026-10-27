/**
 * tests/feishu-owner-chats.test.ts —— B1（修 F5）多主人会话投递的硬判据
 *
 * 现场事实（2026-10-22 实测）：FEISHU_OWNER_CHAT_ID 长度 71 = 两个合法
 * oc_+32 会话 id 用逗号连接。入站闸门早就用 Set 放行全部
 * （feishu-inbound.ts:164/214），但出站三处写死 split(',')[0] →
 * **第二个主人会话永远收不到审批卡片**，任务卡在 awaiting_approval 直到 24h 过期。
 *
 * 这个文件钉四件事（按本轮「函数对但没人调用」的教训，判据必须落在接线层）：
 *   1. 切换点：parseOwnerChatIds 是唯一的「配置串 → 会话列表」入口；
 *   2. 广播：审批卡片对 N 个会话发 N 张，且一个会话失败不连累其它会话；
 *   3. **一对多的代价**：CardRegistry 必须收集全部 messageId，落定时遍历更新，
 *      并且逐条 catch（不是第一条失败就整批不更新）；
 *   4. 接线：源码级断言，钉住 daemon.ts 真的用上了上面的能力，
 *      以及「回复回原会话绝不能广播」这条反向不变量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CardRegistry,
  dedupeChatIds,
  parseOwnerChatIds,
  pushApprovalCards,
  resolveApprovalCards,
  type ApprovalCardDeps,
  type CardSender,
} from '../src/surfaces/feishu-approval.ts';
import type { ApprovalView } from '../src/shared/contracts.ts';

const CHAT_A = 'oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAT_B = 'oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 42,
  seq: 7,
  kind: 'tool_call',
  tier: 'dangerous',
  status: 'pending',
  summary: 'mail.send：给 laowang@example.com 发信',
  fullParams: { tool: 'mail.send', to: ['laowang@example.com'] },
  reason: '对外发送邮件',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  taskRef: { taskId: 'tk_x', journalStepId: 'st_1' },
  ...over,
});
/** 读仓库源文件（源码级判据用）。相对测试文件定位，不依赖 cwd。 */
function readRepo(rel: string): string {
  return readFileSync(new URL(rel, new URL('../', import.meta.url)), 'utf8');
}

/** 含全部关键词的行（源码级判据的基本单元：按行判，不写跨行大正则）。 */
function linesWith(src: string, ...needles: string[]): string[] {
  return src.split(String.fromCharCode(10)).filter((l) => needles.every((n) => l.includes(n)));
}

// ── 1. 切换点：配置串 → 会话列表 ────────────────────────────────

test('parseOwnerChatIds：逗号分隔的多会话一个都不能丢（F5 的根因就在这）', () => {
  const got = parseOwnerChatIds(CHAT_A + ',' + CHAT_B);
  assert.equal(got.length, 2, '两个主人会话都要在列表里');
  assert.deepEqual(got, [CHAT_A, CHAT_B]);
});

test('parseOwnerChatIds：现场配置的形状（长度 71 = oc_+32 × 2 逗号连接）', () => {
  // 只测**形状**，不碰任何真实值（会话 id 不进测试文件）。
  const raw = 'oc_' + 'a'.repeat(32) + ',' + 'oc_' + 'b'.repeat(32);
  assert.equal(raw.length, 71, '与现场 FEISHU_OWNER_CHAT_ID 同长度');
  const ids = parseOwnerChatIds(raw);
  assert.equal(ids.length, 2);
  for (const id of ids) {
    assert.match(id, /^oc_[A-Za-z0-9]{32}$/);
    assert.equal(id.length, 35);
  }
});

test('parseOwnerChatIds：空/缺省/只有逗号 → 空列表（不返回 [undefined] 也不返回空串）', () => {
  assert.deepEqual(parseOwnerChatIds(undefined), []);
  assert.deepEqual(parseOwnerChatIds(null), []);
  assert.deepEqual(parseOwnerChatIds(''), []);
  assert.deepEqual(parseOwnerChatIds('  ,  '), [], '空段必须滤掉，否则 sendChat(空串) 会假装投递成功');
});

test('parseOwnerChatIds：吞空格 + 去重（同一个群写两遍只投一次）', () => {
  const got = parseOwnerChatIds(' ' + CHAT_A + ' , ' + CHAT_B + ' , ' + CHAT_A + ' ');
  assert.deepEqual(got, [CHAT_A, CHAT_B], '去重保序：重复投递是打扰，不是广播');
});

test('dedupeChatIds：空列表 / undefined / null 都不炸', () => {
  assert.deepEqual(dedupeChatIds([]), []);
  assert.deepEqual(dedupeChatIds(undefined), []);
  assert.deepEqual(dedupeChatIds(null), []);
  assert.deepEqual(dedupeChatIds([CHAT_B, '', '   ', CHAT_A, CHAT_B]), [CHAT_B, CHAT_A]);
});
// ── 2. 广播：审批卡片发到每个主人会话 ───────────────────────────

/** 记账型假发送器：可指定某些会话失败 / 抛异常 / 不返回 messageId。 */
function fakeSender(
  opts: { failOn?: Record<string, string>; throwOn?: string[]; noMessageIdFor?: string[] } = {},
): CardSender & { sent: Array<{ chatId: string; card: unknown }>; updated: string[] } {
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const updated: string[] = [];
  let n = 0;
  return {
    sent,
    updated,
    sendCard: async (chatId, card) => {
      sent.push({ chatId, card });
      if (opts.throwOn !== undefined && opts.throwOn.includes(chatId)) throw new Error('连接被重置');
      const err = opts.failOn === undefined ? undefined : opts.failOn[chatId];
      if (err !== undefined) return { ok: false, error: err };
      const skip = opts.noMessageIdFor !== undefined && opts.noMessageIdFor.includes(chatId);
      const messageId = skip ? undefined : 'om_' + String(++n);
      return messageId === undefined ? { ok: true } : { ok: true, messageId };
    },
    updateCard: async (messageId) => (updated.push(messageId), { ok: true }),
  };
}

test('审批卡片广播到全部主人会话（F5 的正解：第二个会话也收得到）', async () => {
  const sender = fakeSender();
  const logs: string[] = [];
  const ids = await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_B], log: (m) => logs.push(m) }, view());
  assert.deepEqual(sender.sent.map((s) => s.chatId), [CHAT_A, CHAT_B], '两个会话各发一张，不是只发第一个');
  assert.equal(ids.length, 2, '两张卡片的 messageId 都要返回（落定时要遍历改）');
  assert.ok(logs.some((l) => l.includes('已推送')));
});

test('每个会话拿到的是同一张卡片内容（不许两端看到不同决定）', async () => {
  const sender = fakeSender();
  await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_B] }, view());
  assert.equal(JSON.stringify(sender.sent[0] === undefined ? null : sender.sent[0].card), JSON.stringify(sender.sent[1] === undefined ? null : sender.sent[1].card));
});

test('一个会话发送失败不影响另一个（至少有一个主人能看到待批事项）', async () => {
  const failOn: Record<string, string> = {};
  failOn[CHAT_A] = '飞书限流';
  const sender = fakeSender({ failOn });
  const logs: string[] = [];
  const ids = await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_B], log: (m) => logs.push(m) }, view());
  assert.equal(sender.sent.length, 2, '第一个失败后必须继续投第二个');
  assert.equal(ids.length, 1, '只返回成功的那张卡片');
  assert.ok(logs.some((l) => l.includes('卡片推送失败') && l.includes(CHAT_A)), '失败要留痕且说清是哪个会话');
});

test('一个会话抛异常也不中断广播循环', async () => {
  const sender = fakeSender({ throwOn: [CHAT_A] });
  const ids = await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_B], log: () => {} }, view());
  assert.equal(sender.sent.length, 2);
  assert.equal(ids.length, 1);
});

test('飞书不返回 messageId 时不算失败，只是那张卡片后续改不动（如实少一条）', async () => {
  const sender = fakeSender({ noMessageIdFor: [CHAT_B] });
  const ids = await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_B] }, view());
  assert.equal(sender.sent.length, 2);
  assert.equal(ids.length, 1);
});

test('chatIds 为空 = 如实不推送（不假装发了）', async () => {
  const sender = fakeSender();
  const logs: string[] = [];
  const ids = await pushApprovalCards({ sender, chatIds: [], log: (m) => logs.push(m) }, view());
  assert.equal(sender.sent.length, 0);
  assert.deepEqual(ids, []);
  assert.ok(logs.some((l) => l.includes('owner_chat_id')));
});

test('chatIds 里重复的会话只投一次（同一群两张待批卡片是打扰）', async () => {
  const sender = fakeSender();
  await pushApprovalCards({ sender, chatIds: [CHAT_A, CHAT_A, CHAT_B] }, view());
  assert.deepEqual(sender.sent.map((s) => s.chatId), [CHAT_A, CHAT_B]);
});
// ── 3. 一对多的代价：CardRegistry 与卡片更新 ───────────────────

test('CardRegistry：一个 approvalId 收集多张卡片（set 是幂等追加，不是覆盖）', () => {
  const r = new CardRegistry();
  r.set(42, 'om_1');
  r.set(42, 'om_2');
  r.set(43, 'om_3');
  assert.deepEqual(r.getMany(42), ['om_1', 'om_2']);
  assert.deepEqual(r.getMany(43), ['om_3']);
  assert.deepEqual(r.getMany(999), [], '没记过 → 空数组，不是 undefined');
  assert.equal(r.size(), 2, 'size() = 记了几条审批');
  assert.equal(r.totalCards(), 3, 'totalCards() = 卡片张数');
});

test('CardRegistry：同一个 messageId 重复 set 不记两遍（否则同一张卡片被改两次）', () => {
  const r = new CardRegistry();
  r.set(42, 'om_1');
  r.set(42, 'om_1');
  assert.deepEqual(r.getMany(42), ['om_1']);
});

test('CardRegistry：getMany 返回副本，调用方改不动内部状态', () => {
  const r = new CardRegistry();
  r.set(42, 'om_1');
  r.getMany(42).push('om_inject');
  assert.deepEqual(r.getMany(42), ['om_1']);
});

test('CardRegistry：delete 清掉该审批的全部卡片', () => {
  const r = new CardRegistry();
  r.set(42, 'om_1');
  r.set(42, 'om_2');
  r.delete(42);
  assert.deepEqual(r.getMany(42), []);
  assert.equal(r.totalCards(), 0);
});

test('落定后遍历更新全部卡片（漏一条就是挂着按钮的旧卡片 + 一堆迟到裁决噪音）', async () => {
  const sender = fakeSender();
  const r = new CardRegistry();
  r.set(42, 'om_1');
  r.set(42, 'om_2');
  const deps: ApprovalCardDeps = {
    sender,
    chatIds: [CHAT_A, CHAT_B],
    getApprovalView: (id) => (id === 42 ? view({ status: 'approved' }) : null),
  };
  const out = await resolveApprovalCards(deps, r.getMany(42), 42, '飞书');
  assert.deepEqual(sender.updated, ['om_1', 'om_2'], '两张都要改');
  assert.equal(out.updated, 2);
  assert.equal(out.failed, 0);
});

test('返回值带上结果卡（回调响应要用它钉住落定状态，2026-10-27）', async () => {
  // 现场：PATCH 全部成功（日志「已改 2/2 张卡片」），但被点击那张卡的
  // 最终状态由**回调响应**决定 —— 回包里没有卡，飞书就把卡片按点击时
  // 的版本落定，按钮又回来了。所以 resolveApprovalCards 必须把结果卡
  // 交出来，让 feishu-ws 放进响应体。
  const sender = fakeSender();
  const out = await resolveApprovalCards(
    { sender, chatIds: [CHAT_A], getApprovalView: () => view({ status: 'approved' }) },
    ['om_1'],
    42,
    '飞书',
  );
  assert.ok(out.card !== undefined, '结果卡必须随返回值出来');
  const title = (out.card as { header?: { title?: { content?: string } } }).header?.title?.content ?? '';
  assert.ok(title.includes('已同意'), `标题应是已同意：${title}`);
  const cardJson = JSON.stringify(out.card);
  assert.ok(!cardJson.includes('"action"'), '结果卡不能再有按钮块');
});

test('拒绝落定时返回的是灰色的已拒绝卡', async () => {
  const sender = fakeSender();
  const out = await resolveApprovalCards(
    { sender, chatIds: [CHAT_A], getApprovalView: () => view({ status: 'rejected' }) },
    ['om_1'],
    42,
    '飞书',
  );
  assert.ok(out.card !== undefined);
  assert.equal((out.card as { header?: { template?: string } }).header?.template, 'grey');
});

test('某条卡片更新失败/抛异常不连累其它条（逐条 catch，不是第一条挂了就整批不更新）', async () => {
  const updated: string[] = [];
  const sender: CardSender = {
    sendCard: async () => ({ ok: true, messageId: 'om_x' }),
    updateCard: async (messageId) => {
      updated.push(messageId);
      if (messageId === 'om_1') throw new Error('message 已被撤回');
      if (messageId === 'om_2') return { ok: false, error: '限流' };
      return { ok: true };
    },
  };
  const logs: string[] = [];
  const out = await resolveApprovalCards(
    { sender, chatIds: [CHAT_A], log: (m) => logs.push(m), getApprovalView: () => view({ status: 'approved' }) },
    ['om_1', 'om_2', 'om_3'],
    42,
    '飞书',
  );
  assert.deepEqual(updated, ['om_1', 'om_2', 'om_3'], '第一条抛异常、第二条返失败，第三条仍要试');
  assert.equal(out.updated, 1);
  assert.equal(out.failed, 2);
  assert.ok(logs.some((l) => l.includes('卡片改写异常')));
  assert.ok(logs.some((l) => l.includes('卡片改写失败')));
});

test('拿不到审批最新状态时一张都不改，但如实报失败数', async () => {
  const sender = fakeSender();
  const out = await resolveApprovalCards({ sender, chatIds: [CHAT_A], getApprovalView: () => null }, ['om_1', 'om_2'], 99, '飞书');
  assert.deepEqual(sender.updated, []);
  assert.equal(out.updated, 0);
  assert.equal(out.failed, 2);
  assert.equal(out.card, undefined, '状态都拿不到，没有结果卡可回');
});

test('发送器没有 updateCard 能力时直接返回（旧行为，不抛）', async () => {
  const sender: CardSender = { sendCard: async () => ({ ok: true, messageId: 'om_1' }) };
  const out = await resolveApprovalCards({ sender, chatIds: [CHAT_A] }, ['om_1'], 42, '飞书');
  assert.equal(out.updated, 0);
  assert.equal(out.failed, 0);
  assert.equal(out.card, undefined);
});
// ── 4. 出站回路：claimAndSend 的投递目标（真调 startFeishuOutbound）──
//
// 为什么不打源码 grep 而要走真函数：本轮已经吃过「函数写得对但没人调用」的亏。
// 这里把 approval:created / governance:quarantine / task.state 三路事件真投一遍，
// 断言「谁收到了什么」。源码级接线判据放 scripts/regress/card-criteria.sh
// （daemon.ts 在 lead 名下，改没改由那边的 grep 兜住）。

import { makeTempDataDir } from './helpers.ts';
import { startFeishuOutbound } from '../src/surfaces/feishu-outbound.ts';

function seedThread(
  dir: ReturnType<typeof makeTempDataDir>,
  threadId: string,
  channel: 'feishu' | 'web' | 'event',
  externalRef: string | null,
  taskId: string,
): void {
  const now = Date.now();
  dir.db
    .prepare('INSERT INTO mem_threads (id,dot_id,channel,external_ref,status,pinned,context_summary_upto_seq,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(threadId, 'dot1', channel, externalRef, 'active', 0, 0, now, now);
  dir.db
    .prepare('INSERT INTO tasks (id,title,goal,status,priority,created_at,updated_at,thread_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(taskId, '发报价单', '发报价单', 'awaiting_approval', 1, now, now, threadId);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('审批卡片只投来源会话（2026-10-27：主人报「不要在私聊和群聊都问我」）', async () => {
  const dir = makeTempDataDir();
  const logs: string[] = [];
  const cardCalls: string[] = [];
  try {
    seedThread(dir, 'thr_b1', 'feishu', 'feishu:' + CHAT_A, 'tk_b1');
    const gw = { sendText: async (chatId: string, text: string) => (cardCalls.push('text:' + chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: (m) => logs.push(m),
      approvalCards: {
        chatIds: [CHAT_A, CHAT_B],
        send: async (_v, chatId) => (cardCalls.push('card:' + chatId), { ok: true, messageId: 'om_' + chatId.slice(3, 5) }),
      },
    });
    try {
      dir.bus.publish('approval:created', view({ taskRef: { taskId: 'tk_b1', journalStepId: 'st_1' } }), { dotId: 'dot1' });
      await settle();
      // 任务从 CHAT_A 来 → 只问 CHAT_A。同一个人的第二个窗口不该收到同一条问题：
      // 两边各弹一张，答了这边那边还挂着，两边都点又成了迟到裁决。
      assert.deepEqual(cardCalls, ['card:' + CHAT_A], '来源会话存在时只投它，不广播');
      const rows = dir.db
        .prepare("SELECT chat_id, ok FROM surf_outbound_log WHERE kind = 'approval_card' ORDER BY id")
        .all() as Array<{ chat_id: string; ok: number }>;
      assert.equal(rows.length, 1, '审计按实际投递留痕，不能还按广播记两行');
      assert.deepEqual(rows.map((r) => r.chat_id), [CHAT_A]);
      assert.equal(rows[0] === undefined ? null : rows[0].ok, 1);
      // 文本兜底不该再发一次（卡片已送达 = 这条事件已认领）
      assert.equal(cardCalls.filter((c) => c.startsWith('text:')).length, 0, '卡片成功后不能再发文本');
      assert.ok(logs.some((l) => l.includes('来源会话')), '日志要说清这是来源会话投递');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('审批卡片投递失败：落审计、如实报错，且退回纯文本（不是静默丢）', async () => {
  const dir = makeTempDataDir();
  const logs: string[] = [];
  const texts: string[] = [];
  try {
    seedThread(dir, 'thr_b1', 'feishu', 'feishu:' + CHAT_A, 'tk_b1');
    const gw = { sendText: async (chatId: string) => (texts.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: (m) => logs.push(m),
      approvalCards: {
        chatIds: [CHAT_A, CHAT_B],
        send: async () => ({ ok: false, error: '限流' }),
      },
    });
    try {
      dir.bus.publish('approval:created', view({ taskRef: { taskId: 'tk_b1', journalStepId: 'st_1' } }), { dotId: 'dot1' });
      await settle();
      const rows = dir.db
        .prepare("SELECT chat_id, ok, error FROM surf_outbound_log WHERE kind = 'approval_card' ORDER BY id")
        .all() as Array<{ chat_id: string; ok: number; error: string | null }>;
      assert.equal(rows.length, 2, '每次尝试都要留一行（来源会话失败后会再试下一个主人会话）');
      assert.ok(rows.every((r) => r.ok === 0));
      assert.match(logs.join(String.fromCharCode(10)), /卡片失败（限流）/);
      assert.deepEqual(texts, [CHAT_A], '卡片挂了要退回纯文本，否则主人根本不知道有事要他决定');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('审批卡片：无来源会话时只问第一个主人会话（问题只该问一遍）', async () => {
  const dir = makeTempDataDir();
  const cardCalls: string[] = [];
  const logs: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: { sendText: async () => ({ ok: true }) },
      log: (m) => logs.push(m),
      approvalCards: {
        chatIds: [CHAT_A, CHAT_B],
        send: async (_v, chatId) => (cardCalls.push(chatId), { ok: true, messageId: 'om_' + chatId.slice(3, 5) }),
      },
    });
    try {
      dir.bus.publish('approval:created', view({ taskRef: { taskId: 'tk_ev', journalStepId: 'st_1' } }), { dotId: 'dot1' });
      await settle();
      // 定时任务没有来源会话，但「提问」只该出现一次：广播等于同一件事问两遍，
      // 一端答了另一端还挂着按钮（主人报的就是这个）。
      assert.deepEqual(cardCalls, [CHAT_A], '无来源时只问第一个主人会话，不广播');
      const rows = dir.db
        .prepare("SELECT chat_id FROM surf_outbound_log WHERE kind = 'approval_card' ORDER BY id")
        .all() as Array<{ chat_id: string }>;
      assert.deepEqual(rows.map((r) => r.chat_id), [CHAT_A]);
      assert.ok(logs.some((l) => l.includes('第一个主人会话')), '日志要说清无来源时取了第一个');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('审批卡片：第一个会话发不出去时换下一个（不能没有窗口问）', async () => {
  const dir = makeTempDataDir();
  const cardCalls: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: { sendText: async () => ({ ok: true }) },
      log: () => {},
      approvalCards: {
        chatIds: [CHAT_A, CHAT_B],
        send: async (_v, chatId) =>
          chatId === CHAT_A
            ? { ok: false, error: '限流' }
            : (cardCalls.push(chatId), { ok: true, messageId: 'om_b' }),
      },
    });
    try {
      dir.bus.publish('approval:created', view({ taskRef: { taskId: 'tk_ev', journalStepId: 'st_1' } }), { dotId: 'dot1' });
      await settle();
      assert.deepEqual(cardCalls, [CHAT_B], '第一个挂了要换下一个，成功了就停，不再往后发');
      const rows = dir.db
        .prepare("SELECT chat_id, ok FROM surf_outbound_log WHERE kind = 'approval_card' ORDER BY id")
        .all() as Array<{ chat_id: string; ok: number }>;
      assert.deepEqual(rows.map((r) => r.chat_id), [CHAT_A, CHAT_B], '两次尝试都要留痕');
      assert.deepEqual(rows.map((r) => r.ok), [0, 1]);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('全部会话都发不出去才退回纯文本（退路必须留着）', async () => {
  const dir = makeTempDataDir();
  const texts: string[] = [];
  try {
    seedThread(dir, 'thr_b1', 'feishu', 'feishu:' + CHAT_A, 'tk_b1');
    const gw = { sendText: async (chatId: string) => (texts.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: () => {},
      approvalCards: { chatIds: [CHAT_A, CHAT_B], send: async () => ({ ok: false, error: '卡片接口变更' }) },
    });
    try {
      dir.bus.publish('approval:created', view({ taskRef: { taskId: 'tk_b1', journalStepId: 'st_1' } }), { dotId: 'dot1' });
      await settle();
      assert.deepEqual(texts, [CHAT_A], '文本兜底仍只回原会话，不广播（卡片已经试过两个会话了）');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('反向不变量：任务回复走来源会话，绝不广播（B1 唯一禁止项）', async () => {
  const dir = makeTempDataDir();
  const sent: Array<{ chatId: string; text: string }> = [];
  try {
    // 任务来自 CHAT_A 的飞书会话，但 fallbackChatIds 配了两个主人会话。
    seedThread(dir, 'thr_b1', 'feishu', 'feishu:' + CHAT_A, 'tk_b1');
    dir.db
      .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('m1', 'thr_b1', 1, 'assistant', 'text', '报价单已发出', 'tk_b1', 10, Date.now());
    const gw = {
      sendText: async (chatId: string, text: string) => (sent.push({ chatId, text }), { ok: true }),
    };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: () => {},
      fallbackChatIds: [CHAT_A, CHAT_B],
    });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_b1', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(sent, [{ chatId: CHAT_A, text: '报价单已发出' }], '来源会话存在时只回它，第二个会话不该收到回复');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('无来源会话（定时任务线程）→ 兜底广播到全部主人会话（F5 第二处）', async () => {
  const dir = makeTempDataDir();
  const sent: string[] = [];
  const logs: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    dir.db
      .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('m1', 'thr_ev', 1, 'assistant', 'text', '该喝水了', 'tk_ev', 10, Date.now());
    const gw = { sendText: async (chatId: string) => (sent.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: (m) => logs.push(m),
      fallbackChatIds: [CHAT_A, CHAT_B],
    });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_ev', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(sent, [CHAT_A, CHAT_B], '定时提醒两个会话都要收到（原来只投第一个）');
      assert.ok(logs.some((l) => l.includes('全部主人会话') && l.includes('2 个')));
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('dot 被隔离的系统通知 → 广播到全部主人会话（F5 那处的后果：第二个主人只看到任务莫名失败）', async () => {
  const dir = makeTempDataDir();
  const sent: string[] = [];
  try {
    const gw = { sendText: async (chatId: string) => (sent.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: () => {},
      fallbackChatIds: [CHAT_A, CHAT_B],
    });
    try {
      dir.bus.publish('governance:quarantine', { dotId: 'dot1', decisionId: 'dc_1', approvalId: null, reason: 'recreate>3/24h' });
      await settle();
      assert.deepEqual(sent, [CHAT_A, CHAT_B]);
      const rows = dir.db
        .prepare("SELECT chat_id FROM surf_outbound_log WHERE kind = 'task_reply' ORDER BY id")
        .all() as Array<{ chat_id: string }>;
      assert.deepEqual(rows.map((r) => r.chat_id), [CHAT_A, CHAT_B], '系统通知的广播同样逐会话留痕');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('兼容旧单值 fallbackChatId：装配层没改时行为 = 只有一个会话（不静默扩大到全部）', async () => {
  const dir = makeTempDataDir();
  const sent: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    dir.db
      .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('m1', 'thr_ev', 1, 'assistant', 'text', '该喝水了', 'tk_ev', 10, Date.now());
    const gw = { sendText: async (chatId: string) => (sent.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({
      db: dir.db,
      bus: dir.bus,
      gateway: gw,
      log: () => {},
      fallbackChatId: CHAT_A,
    });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_ev', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(sent, [CHAT_A]);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('兜底列表为空 = 一条都不发，也不认领幂等键（配好了下次还能补发）', async () => {
  const dir = makeTempDataDir();
  const sent: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    dir.db
      .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('m1', 'thr_ev', 1, 'assistant', 'text', '该喝水了', 'tk_ev', 10, Date.now());
    const gw = { sendText: async (chatId: string) => (sent.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {}, fallbackChatIds: [] });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_ev', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(sent, []);
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});

test('广播是同一次认领里发完的：事件重投时整条跳过，不会只补发一半或发重一半', async () => {
  const dir = makeTempDataDir();
  const sent: string[] = [];
  try {
    seedThread(dir, 'thr_ev', 'event', null, 'tk_ev');
    dir.db
      .prepare('INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,task_id,token_est,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('m1', 'thr_ev', 1, 'assistant', 'text', '该喝水了', 'tk_ev', 10, Date.now());
    const gw = { sendText: async (chatId: string) => (sent.push(chatId), { ok: true }) };
    const stop = startFeishuOutbound({ db: dir.db, bus: dir.bus, gateway: gw, log: () => {}, fallbackChatIds: [CHAT_A, CHAT_B] });
    try {
      dir.bus.publish('task.state', { taskId: 'tk_ev', from: 'running', to: 'done', epoch: 1 });
      await settle();
      dir.bus.publish('task.state', { taskId: 'tk_ev', from: 'running', to: 'done', epoch: 1 });
      await settle();
      assert.deepEqual(sent, [CHAT_A, CHAT_B], '第二次重投必须整条跳过（幂等键是事件级，不是事件×会话级）');
    } finally {
      stop();
    }
  } finally {
    dir.cleanup();
  }
});