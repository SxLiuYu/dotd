/**
 * tests/feishu-card-callback.test.ts —— 审批卡片点了必须有反应（2026-10-21）
 *
 * 主人原话：「审批电击之后没反应」（点同意，没反应）。
 *
 * 现场复现（真的点了一遍）：
 *   1. 卡片发得出去：surf_outbound_log id=821 `approval #133 卡片`
 *   2. 点击确实到了服务端：日志 7 次
 *      `飞书长连接收到事件 card.action.trigger：chat=- sender=-:- type=- len=0`
 *   3. 但任务一直 `awaiting_approval`，approvals#133 一直 pending
 *
 * 根因不在飞书，也不在协议解析 —— 在**装配**：
 *   daemon.ts 调 startFeishuWs() 时没传 `approval`，
 *   于是 handleFeishuCallback 走 `deps.approval === undefined`
 *   → `{ignored:true, reason:'approval_not_wired'}`，静默丢弃。
 *   卡片这半条链路是通的，另外半条从来没接上。
 *
 * 这组用例钉死两件事：
 *   A. 没装配时必须**如实报错**（不能假装点了）—— 这正是当初能被发现的前提
 *   B. 装配了就必须真的调 GOV decide()，且 approve → approve_once
 *      （卡片只有「一次」和「拒绝」两个按钮，不擅自替主人"记住"）
 */
import { DatabaseSync } from 'node:sqlite';
import { handleFeishuCallback } from '../src/surfaces/feishu-inbound.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE surf_inbound_seen (dedup_key TEXT PRIMARY KEY, source TEXT, actor TEXT, ts INTEGER);
  `);
  return db;
}

/** 造一条飞书卡片按钮回调（按 SDK 扁平帧形状）。 */
function cardFrame(opts: { approvalId: number; verdict: 'approve' | 'reject'; eventId: string }) {
  return {
    schema: '2.0',
    header: { event_id: opts.eventId, event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_owner' },
      action: {
        value: { kind: 'approval', approvalId: opts.approvalId, verdict: opts.verdict },
      },
      context: { open_message_id: 'om_card_1' },
    },
  };
}

const CFG = {
  verificationToken: '',
  ownerChatId: 'oc_owner',
  appId: 'a',
  appSecret: 's',
  editThrottleMs: 1200,
};

console.log('');
console.log('  A. 没装配审批能力 → 如实报错，不假装点了');

{
  const db = mkDb();
  const r = await handleFeishuCallback(cardFrame({ approvalId: 133, verdict: 'approve', eventId: 'ev_a' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
  } as never);
  ok('返回 approval_not_wired 而不是成功', (r.body as { reason?: string }).reason === 'approval_not_wired',
     JSON.stringify(r.body));
  ok('HTTP 仍是 200（飞书不要重投）', r.httpStatus === 200);
}

console.log('');
console.log('  B. 装配了 → 真的调 decide()，approve 映射成 approve_once');

{
  const db = mkDb();
  const calls: Array<{ id: number; verdict: string; operator: string }> = [];
  const r = await handleFeishuCallback(cardFrame({ approvalId: 133, verdict: 'approve', eventId: 'ev_b' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async (id: number, verdict: 'approve' | 'reject', operator: string) => {
        calls.push({ id, verdict, operator });
        return { ok: true, status: 'approved' };
      },
    },
  } as never);

  ok('decide 被调用了恰好一次', calls.length === 1, String(calls.length));
  ok('approvalId 传对', calls[0]?.id === 133, String(calls[0]?.id));
  ok('verdict 原样是 approve（映射在 daemon 层）', calls[0]?.verdict === 'approve', String(calls[0]?.verdict));
  ok('返回 decided:true', (r.body as { decided?: boolean }).decided === true, JSON.stringify(r.body));
}

console.log('');
console.log('  C. 拒绝按钮同理');

{
  const db = mkDb();
  const calls: string[] = [];
  const r = await handleFeishuCallback(cardFrame({ approvalId: 7, verdict: 'reject', eventId: 'ev_c' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async (_id: number, verdict: 'approve' | 'reject') => {
        calls.push(verdict);
        return { ok: true, status: 'rejected' };
      },
    },
  } as never);
  ok('reject 传到 decide', calls[0] === 'reject', String(calls[0]));
  ok('返回 decided:true', (r.body as { decided?: boolean }).decided === true);
}

console.log('');
console.log('  D. 重复点击不能执行两次（飞书会重投）');

{
  const db = mkDb();
  let n = 0;
  const frame = cardFrame({ approvalId: 133, verdict: 'approve', eventId: 'ev_dup' });
  const deps = {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => {
        n++;
        return { ok: true, status: 'approved' };
      },
    },
  } as never;
  await handleFeishuCallback(frame, deps);
  const r2 = await handleFeishuCallback(frame, deps);
  ok('同一 event_id 只裁决一次', n === 1, 'decide 调用 ' + n + ' 次');
  ok('第二次返回 dup', (r2.body as { reason?: string }).reason === 'dup', JSON.stringify(r2.body));
}

console.log('');
console.log('  E. decide 失败要如实说，不能报成功');

{
  const db = mkDb();
  const r = await handleFeishuCallback(cardFrame({ approvalId: 999, verdict: 'approve', eventId: 'ev_e' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => ({ ok: false, reason: 'approval_not_found' }),
    },
  } as never);
  ok('回 ignored + 真实原因', (r.body as { ignored?: boolean; reason?: string }).ignored === true, JSON.stringify(r.body));
  ok('原因透传', (r.body as { reason?: string }).reason === 'approval_not_found', String((r.body as { reason?: string }).reason));
  ok('不返回 decided:true', (r.body as { decided?: boolean }).decided !== true);
}

console.log('');
console.log('');
console.log('  F. question 单选：选项必须随回调变成 note（2026-10-23）');

{
  // 现场：主人点了卡片上的选项按钮，审批落成 approved、任务也续跑了，
  // 但 `ask` 拿到的是 `{answered:false, text:'主人没有回答这个问题…'}`，
  // 模型于是自己编了一条日程出来（tk_mvk9uj7vedr2fx，approvals#150）。
  //
  // 根因是这条链上「主人的答案」根本没被搬运：
  //   buildApprovalCard 的按钮 value 只有 {approvalId, verdict} —— 没有答案位；
  //   parseCardAction 也就不可能返回答案；
  //   daemon 那条 decide 闭包只接收三个参数，note 永远是 undefined；
  //   gate.decide() 见 note 为空就原样回传 params_json；
  //   claim() 带回来的 ownerNote 不存在 → ask 判定「没人回答」。
  // 对 tool_call 单只是少一句补充，对 question 单就是回答丢了。
  const db = mkDb();
  const calls: Array<{ verdict: string; note?: string }> = [];
  const r = await handleFeishuCallback(
    {
      schema: '2.0',
      header: { event_id: 'ev_ans', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_owner' },
        action: {
          value: { kind: 'approval', approvalId: 150, verdict: 'approve', answer: '周会试跑 10-27 10:00' },
        },
        context: { open_message_id: 'om_card_1' },
      },
    },
    {
      db,
      cfg: CFG as never,
      trustedTransport: true,
      approval: {
        decide: async (_id: number, verdict: 'approve' | 'reject', _op: string, note?: string) => {
          calls.push({ verdict, ...(note !== undefined ? { note } : {}) });
          return { ok: true, status: 'approved' };
        },
      },
    } as never,
  );
  ok('答案作为 note 传到 decide（不是丢掉）', calls[0]?.note === '周会试跑 10-27 10:00',
     JSON.stringify(calls[0]));
  ok('verdict 仍是 approve', calls[0]?.verdict === 'approve', String(calls[0]?.verdict));
  ok('返回 decided:true', (r.body as { decided?: boolean }).decided === true, JSON.stringify(r.body));
}

{
  // 没有 answer 字段的普通 tool_call 卡片：note 必须是 undefined，
  // 不能变成空串塞进 params_json（那会让 gate 认为主人留了话）。
  const db = mkDb();
  let got: string | undefined | null = null;
  await handleFeishuCallback(cardFrame({ approvalId: 12, verdict: 'approve', eventId: 'ev_noans' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async (_id: number, _v: 'approve' | 'reject', _o: string, note?: string) => {
        got = note;
        return { ok: true, status: 'approved' };
      },
    },
  } as never);
  ok('普通审批卡片不带 note（保持旧行为）', got === undefined, String(got));
}

console.log('');
console.log('  G. 回包必须带结果卡（2026-10-27，主人报「显示通过后又刷回选择卡片」）');
// 现场实测：PATCH 全部成功（日志「已改 2/2 张卡片」），半小时后 GET 服务端
// 仍是按钮卡片。根因：飞书长连接把 handler 的**返回值**当作这张卡片的落定
// 状态；回包里没有卡，就把卡片按点击时的版本落定，PATCH 被冲掉。
// 所以 decided 路径的 body 必须带 resolveCard 构建的结果卡。

{
  const db = mkDb();
  const resolvedCard = { header: { template: 'green', title: { content: '已同意 · 审批 #133' } } };
  let resolveCalled = 0;
  const r = await handleFeishuCallback(cardFrame({ approvalId: 133, verdict: 'approve', eventId: 'ev_g' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => ({ ok: true, status: 'approved' }),
      resolveCard: async () => {
        resolveCalled++;
        return { card: resolvedCard };
      },
    },
  } as never);
  const body = r.body as { decided?: boolean; card?: unknown };
  ok('resolveCard 被调用', resolveCalled === 1, String(resolveCalled));
  ok('body 带结果卡（回包要用它钉住状态）', body.card !== undefined, JSON.stringify(body).slice(0, 120));
  ok('结果卡就是 resolveCard 给的那张', (body.card as { header?: { title?: { content?: string } } }).header?.title?.content === '已同意 · 审批 #133');
  ok('decided 仍为 true', body.decided === true);
}

{
  // resolveCard 没接 / 返回 void：body 不带 card（回包退回旧行为，不抛）。
  const db = mkDb();
  const r = await handleFeishuCallback(cardFrame({ approvalId: 5, verdict: 'approve', eventId: 'ev_g2' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => ({ ok: true, status: 'approved' }),
    },
  } as never);
  ok('没接 resolveCard 时 body 无 card 字段', (r.body as { card?: unknown }).card === undefined, JSON.stringify(r.body));
}

{
  // 重复点击（飞书重投）：cardFor 能给出当前状态卡时，dup 回包也要带卡 ——
  // 否则重投的回包又把卡片按点击时版本落定一次。
  const db = mkDb();
  const resolvedCard = { header: { title: { content: '已同意 · 审批 #7' } } };
  const frame = cardFrame({ approvalId: 7, verdict: 'approve', eventId: 'ev_g3' });
  const deps = {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => ({ ok: true, status: 'approved' }),
      cardFor: (id: number) => (id === 7 ? resolvedCard : null),
    },
  } as never;
  await handleFeishuCallback(frame, deps);
  const r2 = await handleFeishuCallback(frame, deps);
  const body = r2.body as { reason?: string; card?: unknown };
  ok('重复点击仍报 dup', body.reason === 'dup', JSON.stringify(body));
  ok('dup 回包也带当前状态卡', body.card === resolvedCard);
}

{
  // 迟到点击（另一端已裁决，decide 返回失败）：回包带落定卡，按钮别挂着。
  const db = mkDb();
  const resolvedCard = { header: { title: { content: '已同意 · 审批 #9' } } };
  const r = await handleFeishuCallback(cardFrame({ approvalId: 9, verdict: 'approve', eventId: 'ev_g4' }), {
    db,
    cfg: CFG as never,
    trustedTransport: true,
    approval: {
      decide: async () => ({ ok: false, reason: 'already_decided' }),
      cardFor: () => resolvedCard,
    },
  } as never);
  const body = r.body as { reason?: string; card?: unknown };
  ok('迟到点击如实报原因', body.reason === 'already_decided', JSON.stringify(body));
  ok('迟到点击回包带落定卡', body.card === resolvedCard);
}

console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
