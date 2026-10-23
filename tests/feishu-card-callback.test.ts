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

console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
