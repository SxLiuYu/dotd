/**
 * tests/control-plane-journal.test.ts —— journal 两步协议 + CP §7.2 崩溃矩阵逐项。
 *
 * 依据 control-plane.md §5.2（两步写入时序：beginTool=call_sent 行提交先于任何外部调用；
 * endTool=call_done 带 epoch 围栏）、§5.3（unknown 步先 exec.reconcileCall 再决策三分流）、
 * §7.2 崩溃窗口逐项表：
 *
 * | 崩溃在                 | 库状态                  | 恢复                          | 后果 |
 * | beginTool 提交后、执行中| started 孤儿           | resolveOpenStep               | unknown 先 reconcile；safe/replayable 重放 |
 * | endTool 提交前         | started 孤儿（结果丢）  | 同上 + 对账 done 则补记      | 不赌"其实没执行"，向执行面取真值 |
 * | endTool 提交后         | succeeded              | 从尾部重建                    | 结果注入，不重执行 |
 * | finish 事务中          | running 无 task_results| 回 queued attempt+1          | 多数步短路 |
 *
 * 硬保证（§5.3 三条）：已 succeeded 步永不重执行；unknown 先对账再决策；审计闭环
 * （孤儿步转 interrupted 不删）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Journal } from '../src/control-plane/journal.ts';
import type { ExecReconciler, GovernanceForcer } from '../src/control-plane/journal.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';
import { StepLimitError } from '../src/shared/errors.ts';

const tmps: TempDataDir[] = [];

function fixture(opts: {
  exec?: ExecReconciler;
  governance?: GovernanceForcer;
  treatUnknownAsRisk?: boolean;
  blobDir?: string;
  stepSoftLimit?: number;
  stepHardLimit?: number;
} = {}): {
  tmp: TempDataDir;
  queue: Queue;
  journal: Journal;
  taskId: string;
  epoch: number;
} {
  const cfg = {
    ...DEFAULT_CP_CONFIG,
    ...(opts.blobDir !== undefined ? { blobDir: opts.blobDir } : {}),
    ...(opts.stepSoftLimit !== undefined ? { stepSoftLimit: opts.stepSoftLimit } : {}),
    ...(opts.stepHardLimit !== undefined ? { stepHardLimit: opts.stepHardLimit } : {}),
  };
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const queue = new Queue({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {},
  });
  let staleCount = 0;
  const journal = new Journal({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    record: (kind) => {
      if (kind === 'stale_writer') staleCount += 1;
    },
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
    ...(opts.governance !== undefined ? { governance: opts.governance } : {}),
    ...(opts.treatUnknownAsRisk !== undefined ? { treatUnknownAsRisk: opts.treatUnknownAsRisk } : {}),
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  // staleCount 经闭包暴露（供围栏测试断言）
  (fixture as unknown as { lastStale?: number }).lastStale = 0;
  void staleCount;
  return { tmp, queue, journal, taskId: t.id, epoch: run.runEpoch };
}

/** 造一个 started 孤儿步（不写 call 结果），返回 seq/callId。 */
function startOrphan(f: ReturnType<typeof fixture>, se: 'safe' | 'replayable' | 'unknown', tool = 'web.click'): {
  seq: number;
  callId: string;
} {
  return f.journal.beginTool(f.taskId, f.epoch, tool, { url: 'https://x' }, se);
}

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});

// ── §5.2 两步协议 ─────────────────────────────────────────────────

test('beginTool 落 started 行（= call_sent），行提交先于任何外部调用', () => {
  const f = fixture();
  const { seq, callId } = f.journal.beginTool(f.taskId, f.epoch, 'web.click', { url: 'u' }, 'unknown');
  assert.equal(seq, 1);
  assert.ok(callId.length > 0, 'callId = ULID');
  const row = f.tmp.db
    .prepare('SELECT * FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as Record<string, unknown>;
  assert.equal(row['status'], 'started');
  assert.equal(row['kind'], 'tool');
  assert.equal(row['side_effect'], 'unknown');
  assert.equal(row['run_epoch'], f.epoch);
  assert.equal(row['call_id'], callId);
});

test('endTool 落 succeeded（= call_done）并带 epoch 围栏', () => {
  const f = fixture();
  const { seq } = f.journal.beginTool(f.taskId, f.epoch, 'fs.read', { p: '/a' }, 'safe');
  f.journal.endTool(f.taskId, f.epoch, seq, 'succeeded', { content: 'x' });
  const row = f.tmp.db
    .prepare('SELECT status, result_json FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as { status: string; result_json: string };
  assert.equal(row.status, 'succeeded');
  assert.equal(row.result_json, JSON.stringify({ content: 'x' }));
});

test('endTool 迟到（错 epoch）→ 0 行 + 记 stale_writer', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  let stale = 0;
  const queue = new Queue({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {},
  });
  const journal = new Journal({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: tmp.bus,
    record: (kind) => {
      if (kind === 'stale_writer') stale += 1;
    },
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  const { seq } = journal.beginTool(t.id, run.runEpoch, 'fs.read', {}, 'safe');
  journal.endTool(t.id, 999, seq, 'succeeded', 'late');
  const row = tmp.db.prepare('SELECT status FROM steps WHERE task_id=? AND seq=?').get(t.id, seq) as {
    status: string;
  };
  assert.equal(row.status, 'started', '围栏拒 → 行不变');
  assert.ok(stale >= 1);
});

test('契约 J1：beginLlm 也返回 {seq,callId}，llm 步同样填 call_id', () => {
  const f = fixture();
  const { seq, callId } = f.journal.beginLlm(f.taskId, f.epoch, 'sha256:abc');
  const row = f.tmp.db
    .prepare('SELECT kind, call_id, side_effect, args_json FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as { kind: string; call_id: string; side_effect: string; args_json: string };
  assert.equal(row.kind, 'llm');
  assert.equal(row.call_id, callId);
  assert.equal(row.side_effect, 'safe');
  assert.equal(row.args_json, 'sha256:abc', '存 digest 不存全文');
});

test('skipStep 按 call_id 定位，只动 pending/started（契约 J3）', () => {
  const f = fixture();
  const { callId } = f.journal.beginTool(f.taskId, f.epoch, 'shop.checkout', {}, 'unknown');
  f.journal.skipStep(callId, 'deny');
  const row = f.tmp.db.prepare('SELECT status FROM steps WHERE call_id=?').get(callId) as {
    status: string;
  };
  assert.equal(row.status, 'skipped');
});

test('getStepByCallId / stepExists 反查（契约 J1/治理重入核对）', () => {
  const f = fixture();
  const { callId } = f.journal.beginTool(f.taskId, f.epoch, 't', {}, 'safe');
  assert.equal(f.journal.stepExists(callId), true);
  const s = f.journal.getStepByCallId(callId)!;
  assert.equal(s.taskId, f.taskId);
  assert.equal(s.callId, callId);
  assert.equal(f.journal.stepExists('nope'), false);
});

// ── §7.2 崩溃矩阵：第 1 行 beginTool 后执行中 ───────────────────────

test('§7.2 beginTool 提交后执行中：unknown 孤儿 → exec 确认 aborted → interrupted + 不重放（转审批）', async () => {
  // 2026-10-17 健壮性审计修正：执行面的 'aborted' 不保证"未落地"——daemon.ts:485-490
  // 把 ExecService 的 interrupted（container_lost / aborted / not_found 三来源）
  // 全映射成 'aborted'，其中 container_lost 恰恰是"容器被 pause/丢失、结局不明"。
  // 因此 unknown 副作用步一律走 deferred（转审批），只有 safe/replayable 才重放。
  // 回归用例见 tests/control-plane-robustness.test.ts 的 A3/A10。
  const f = fixture({
    exec: {
      reconcileCall: async () => 'aborted',
      getCallResult: async () => null,
    },
  });
  (f.journal as unknown as { deps: { governance?: unknown } }).deps.governance = {
    async requestApproval() {
      return { approvalId: 41 };
    },
  };
  const { seq, callId } = startOrphan(f, 'unknown');
  const outcome = await f.journal.reconcileAndResolve(f.taskId, seq);
  assert.equal(outcome, 'deferred', 'unknown 副作用步不赌"其实没执行"，转审批');
  const row = f.tmp.db.prepare('SELECT status, approval_id FROM steps WHERE call_id=?').get(callId) as {
    status: string;
    approval_id: number | null;
  };
  assert.equal(row.status, 'interrupted', '孤儿步转 interrupted 不删（审计闭环）');
  assert.equal(row.approval_id, 41, '必须落审批单');
  // 注记步已注入（供 Runner 下一步 messages 首条）
  const note = f.tmp.db
    .prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id=? AND tool_name='system.note'")
    .get(f.taskId) as { n: number };
  assert.equal(note.n, 1);
});

test('§7.2 beginTool 后执行中：safe/replayable 孤儿 → interrupted + 重放（不问执行面）', async () => {
  const f = fixture({
    exec: {
      reconcileCall: async () => {
        throw new Error('safe 步不得问执行面');
      },
      getCallResult: async () => null,
    },
  });
  const a = startOrphan(f, 'safe', 'fs.read');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, a.seq), 'replayed');
  const b = startOrphan(f, 'replayable', 'web.read');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, b.seq), 'replayed');
  for (const s of [a, b]) {
    const row = f.tmp.db.prepare('SELECT status FROM steps WHERE call_id=?').get(s.callId) as {
      status: string;
    };
    assert.equal(row.status, 'interrupted');
  }
});

test('§7.2 llm 孤儿 → interrupted + replayed（不重放 LLM 调用，省钱）', async () => {
  const f = fixture();
  const { seq, callId } = f.journal.beginLlm(f.taskId, f.epoch, 'sha256:p');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'replayed');
  const row = f.tmp.db.prepare('SELECT status FROM steps WHERE call_id=?').get(callId) as {
    status: string;
  };
  assert.equal(row.status, 'interrupted');
});

// ── §7.2 崩溃矩阵：第 2 行 endTool 提交前（结果丢） ─────────────────

test('§7.2 endTool 提交前：unknown 孤儿 → exec 确认 done → 补记 succeeded（took_result，不重放）', async () => {
  const f = fixture({
    exec: {
      reconcileCall: async () => 'done',
      getCallResult: async () => ({ resultJson: JSON.stringify({ landed: true }) }),
    },
  });
  const { seq, callId } = startOrphan(f, 'unknown', 'shop.checkout');
  const outcome = await f.journal.reconcileAndResolve(f.taskId, seq);
  assert.equal(outcome, 'took_result', '不赌"其实没执行"，向执行面取真值');
  const row = f.tmp.db
    .prepare('SELECT status, result_json FROM steps WHERE call_id=?')
    .get(callId) as { status: string; result_json: string };
  assert.equal(row.status, 'succeeded');
  assert.equal(row.result_json, JSON.stringify({ landed: true }), '结果补记，不白花');
});

// ── §7.2 崩溃矩阵：第 3 行 endTool 提交后 ──────────────────────────

test('§7.2 endTool 提交后：succeeded 步不进 resolveOpenStep（结果注入，不重执行）', async () => {
  const f = fixture({
    exec: {
      reconcileCall: async () => 'aborted',
      getCallResult: async () => null,
    },
  });
  const { seq, callId } = startOrphan(f, 'unknown', 'shop.checkout');
  f.journal.endTool(f.taskId, f.epoch, seq, 'succeeded', { ok: 1 });
  // 恢复扫描只认 started（CP §4.1 硬门控 3）
  const open = f.queue.openStartedSteps(f.taskId);
  assert.equal(open.length, 0, 'succeeded 不是孤儿');
  // 显式调用也短路（status!=='started' → deferred 且不动行）
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'deferred');
  const row = f.tmp.db.prepare('SELECT status FROM steps WHERE call_id=?').get(callId) as {
    status: string;
  };
  assert.equal(row.status, 'succeeded', '已 succeeded 步永不重执行');
});

// ── §7.2 崩溃矩阵：unknown / unknown_host → 转审批 ─────────────────

test('§7.2 仍未知：interrupted + 注入提示 + 转审批（deferred）', async () => {
  const approvals: Array<{ taskId: string; subject: { journalStep: string } }> = [];
  const f = fixture({
    exec: {
      reconcileCall: async () => 'unknown',
      getCallResult: async () => null,
    },
    governance: {
      requestApproval: async (req) => {
        approvals.push({ taskId: req.taskId, subject: req.subject });
        return { approvalId: 77 };
      },
    },
  });
  const { seq, callId } = startOrphan(f, 'unknown', 'shop.checkout');
  const outcome = await f.journal.reconcileAndResolve(f.taskId, seq);
  assert.equal(outcome, 'deferred');
  assert.equal(approvals.length, 1, 'treatUnknownAsRisk 默认 true → 转审批');
  assert.equal(approvals[0]!.subject.journalStep, callId, 'subject.journalStep = callId');
  const row = f.tmp.db
    .prepare('SELECT status, approval_id FROM steps WHERE call_id=?')
    .get(callId) as { status: string; approval_id: number | null };
  assert.equal(row.status, 'interrupted');
  assert.equal(row.approval_id, 77, '审批单号回写该步');
});

test('unknown_host（未注入 exec）→ 同走转审批路径（保守）', async () => {
  const f = fixture({
    governance: {
      requestApproval: async () => ({ approvalId: 5 }),
    },
  });
  const { seq } = startOrphan(f, 'unknown');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'deferred');
  const row = f.tmp.db
    .prepare('SELECT approval_id FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as { approval_id: number | null };
  assert.equal(row.approval_id, 5);
});

test('treatUnknownAsRisk=false → 只注入提示，不转审批', async () => {
  let called = 0;
  const f = fixture({
    exec: { reconcileCall: async () => 'unknown', getCallResult: async () => null },
    governance: {
      requestApproval: async () => {
        called += 1;
        return { approvalId: 1 };
      },
    },
    treatUnknownAsRisk: false,
  });
  const { seq } = startOrphan(f, 'unknown');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'deferred');
  assert.equal(called, 0);
  const note = f.tmp.db
    .prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id=? AND tool_name='system.note'")
    .get(f.taskId) as { n: number };
  assert.equal(note.n, 1, '提示仍然注入');
});

test('幂等：同一 callId 重复 reconcile 命中同一审批单（不重复签发）', async () => {
  let calls = 0;
  const f = fixture({
    exec: { reconcileCall: async () => 'unknown', getCallResult: async () => null },
    governance: {
      requestApproval: async () => {
        calls += 1;
        return { approvalId: 100 };
      },
    },
  });
  const { seq } = startOrphan(f, 'unknown');
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'deferred');
  // 第二次：步已转 interrupted（非 started）→ 短路，不再请求审批
  assert.equal(await f.journal.reconcileAndResolve(f.taskId, seq), 'deferred');
  assert.equal(calls, 1);
});

// ── §7.4 onExecInterrupted（exec.interrupted 回报驱动） ────────────

test('onExecInterrupted 定位 started 步走同一分流；replayed（无副作用步）时 Runner 原地继续', async () => {
  // 用 safe 步表达"replayed → 原地继续、不外抛 queued"这条编排语义；
  // unknown 步在同一函数里走 deferred（见 robustness 测试 A3/A10）。
  const f = fixture({
    exec: { reconcileCall: async () => 'aborted', getCallResult: async () => null },
  });
  const { seq, callId } = startOrphan(f, 'safe');
  const r = await f.journal.onExecInterrupted(callId);
  assert.ok(r !== null);
  assert.equal(r!.taskId, f.taskId);
  assert.equal(r!.seq, seq);
  assert.equal(r!.outcome, 'replayed');
  // 任务仍在 running（replayed → 原地继续，不外抛 queued）
  assert.equal(f.queue.getTask(f.taskId)!.status, 'running');
});

test('onExecInterrupted：unknown 副作用步返回 deferred（不重放，交审批）', async () => {
  const f = fixture({
    exec: { reconcileCall: async () => 'aborted', getCallResult: async () => null },
  });
  (f.journal as unknown as { deps: { governance?: unknown } }).deps.governance = {
    async requestApproval() {
      return { approvalId: 42 };
    },
  };
  const { callId } = startOrphan(f, 'unknown');
  const r = await f.journal.onExecInterrupted(callId);
  assert.ok(r !== null);
  assert.equal(r!.outcome, 'deferred', 'unknown 步不得判 replayed（重复执行风险）');
});

test('onExecInterrupted 对非 started 步返回 null', async () => {
  const f = fixture();
  const { callId } = f.journal.beginTool(f.taskId, f.epoch, 't', {}, 'safe');
  f.journal.endTool(f.taskId, f.epoch, 1, 'succeeded', 'ok');
  assert.equal(await f.journal.onExecInterrupted(callId), null);
});

// ── §7.4 审批续跑 resumeStep（复用原 call_id）─────────────────────

test('resumeStep：pending 步转 started 且复用原 call_id（契约 J1-2）', () => {
  const f = fixture();
  const { seq, callId } = f.journal.beginTool(f.taskId, f.epoch, 'shop.checkout', { a: 1 }, 'unknown');
  f.journal.markPending(f.taskId, f.epoch, seq, 9);
  f.queue.setAwaitingApproval(f.taskId, f.epoch, 9);

  // CP §7.4 审批续跑完整路径：onApprovalSettled(ok) → queued + resume_from_seq
  // → pop 拿新 epoch → resumeStep 把 pending 步转 started、复用原 call_id。
  f.queue.onApprovalSettled(f.taskId, 9, true);
  const back = f.queue.getTask(f.taskId)!;
  assert.equal(back.status, 'queued');
  assert.equal(back.resumeFromSeq, seq);

  const run2 = f.queue.pop()!;
  assert.equal(run2.runEpoch, f.epoch + 1);
  const out = f.journal.resumeStep(f.taskId, run2.runEpoch, seq, '{"a":2}');
  assert.equal(out.callId, callId, '复用原 call_id，不重派');
  const row2 = f.tmp.db
    .prepare('SELECT status, args_json, run_epoch FROM steps WHERE call_id=?')
    .get(callId) as { status: string; args_json: string; run_epoch: number };
  assert.equal(row2.status, 'started');
  assert.equal(row2.args_json, '{"a":2}', '以治理 final_params_json 执行');
  assert.equal(row2.run_epoch, run2.runEpoch);
});

test('markPending：pending 是"等待"不是孤儿——恢复扫描不认它（issue #5a）', () => {
  const f = fixture();
  const { seq } = f.journal.beginTool(f.taskId, f.epoch, 'shop.checkout', {}, 'unknown');
  f.journal.markPending(f.taskId, f.epoch, seq, 3);
  const row = f.tmp.db
    .prepare('SELECT status, approval_id FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as { status: string; approval_id: number };
  assert.equal(row.status, 'pending');
  assert.equal(row.approval_id, 3);
  assert.equal(f.queue.openStartedSteps(f.taskId).length, 0, 'pending 不算孤儿');
});

// ── §5.4 journal 大小控制 ─────────────────────────────────────────

test('§5.4 args >32KB → 落 journal-blobs/<task>.<seq>.json，列里只存引用串', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = { ...DEFAULT_CP_CONFIG, blobDir: tmp.blobDir };
  const queue = new Queue({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {},
  });
  const journal = new Journal({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    record: () => {},
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  const big = 'x'.repeat(40 * 1024);
  const { seq } = journal.beginTool(t.id, run.runEpoch, 'fs.write', { data: big }, 'unknown');
  const row = tmp.db
    .prepare('SELECT args_json FROM steps WHERE task_id=? AND seq=?')
    .get(t.id, seq) as { args_json: string };
  assert.equal(row.args_json, `@blob:journal-blobs/${t.id}.${seq}.json`);
  // 文件真的落盘了（blobDir 是绝对路径，装配层从 dataDir 推出）
  const content = readFileSync(join(tmp.blobDir, `${t.id}.${seq}.json`), 'utf8');
  assert.ok(content.includes(big));
});

test('§5.4 result >32KB 同样走 blob（endTool 截断）', () => {
  const f = fixture({ blobDir: 'journal-blobs' });
  const { seq } = f.journal.beginTool(f.taskId, f.epoch, 'fs.read', {}, 'safe');
  const big = 'y'.repeat(40 * 1024);
  f.journal.endTool(f.taskId, f.epoch, seq, 'succeeded', big);
  const row = f.tmp.db
    .prepare('SELECT result_json FROM steps WHERE task_id=? AND seq=?')
    .get(f.taskId, seq) as { result_json: string };
  assert.equal(row.result_json, `@blob:journal-blobs/${f.taskId}.${seq}.json`);
});

// ── tail / openStepNotes / pendingNotes（§7.3 重建读取侧） ─────────

test('tail 按 seq 升序返回末尾 n 步（§7.3 第 3 步用）', () => {
  const f = fixture();
  f.journal.beginTool(f.taskId, f.epoch, 'a', {}, 'safe');
  f.journal.beginTool(f.taskId, f.epoch, 'b', {}, 'safe');
  f.journal.beginTool(f.taskId, f.epoch, 'c', {}, 'safe');
  const tail = f.journal.tail(f.taskId, 2);
  assert.deepEqual(
    tail.map((s) => s.toolName),
    ['b', 'c'],
    '末尾 2 步且保持 seq 升序',
  );
});

// ── CP §5.4 步数上限（审码 finding：types.ts 只声明配置、journal 无消费 = 死配置；
//    执行主体已从 Runner 移到 journal.nextSeq——所有写步入口都过它）──────

test('§5.4 步数硬上限：越线抛 StepLimitError（调用方转 failed(stop_reason=budget)）', () => {
  const f = fixture({ stepSoftLimit: 2, stepHardLimit: 3 });
  f.journal.beginTool(f.taskId, f.epoch, 'a', {}, 'safe'); // seq 1
  f.journal.beginTool(f.taskId, f.epoch, 'b', {}, 'safe'); // seq 2（软上限线）
  f.journal.beginTool(f.taskId, f.epoch, 'c', {}, 'safe'); // seq 3（=硬上限，允许）
  assert.throws(
    () => f.journal.beginTool(f.taskId, f.epoch, 'd', {}, 'safe'), // seq 4 > 3
    (err: unknown) => {
      assert.ok(err instanceof StepLimitError, '抛跨模块错误 StepLimitError（shared/errors.ts 登记）');
      assert.equal(err.code, 'STEP_LIMIT_EXCEEDED');
      assert.equal(err.taskId, f.taskId);
      assert.equal(err.hardLimit, 3);
      return true;
    },
  );
  // 越线未落第 4 步（步数不越账）
  assert.equal(f.journal.tail(f.taskId).length, 3);
});

test('§5.4 步数软上限：首次越线记 watchdog warning 不阻断；每任务只警告一次', () => {
  const marks: string[] = [];
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = { ...DEFAULT_CP_CONFIG, stepSoftLimit: 2, stepHardLimit: 100 };
  const queue = new Queue({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: () => {},
  });
  const journal = new Journal({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    record: (kind, _level, detail) => {
      if (kind === 'watchdog') marks.push(detail);
    },
  });
  const t = queue.submit({ title: 't', goal: 'g' });
  const run = queue.pop()!;
  journal.beginTool(t.id, run.runEpoch, 'a', {}, 'safe'); // seq 1
  assert.equal(marks.length, 0, '未越软线不警告');
  journal.beginTool(t.id, run.runEpoch, 'b', {}, 'safe'); // seq 2 = 软线 → 首次警告
  journal.beginTool(t.id, run.runEpoch, 'c', {}, 'safe'); // seq 3 > 软线但不重复警告
  journal.beginTool(t.id, run.runEpoch, 'd', {}, 'safe'); // seq 4
  assert.equal(marks.length, 1, '每任务只记一条软上限 warning（防日志轰炸）');
  const payload = JSON.parse(marks[0]!) as { warning: string; steps: number; softLimit: number };
  assert.equal(payload.warning, 'step_soft_limit');
  assert.equal(payload.softLimit, 2);
  assert.ok(payload.steps >= 2);
  // 软上限不阻断：步数照常落账
  assert.equal(journal.tail(t.id).length, 4);
});
