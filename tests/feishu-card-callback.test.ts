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
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
