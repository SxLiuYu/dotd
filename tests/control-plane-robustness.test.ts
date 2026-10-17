/**
 * tests/control-plane-robustness.test.ts —— 确定性/健壮性审计的回归用例（2026-10-17）。
 *
 * 本文件只锁「会让用户真实踩到」的缺陷，每条用例都指向真实代码路径（不打桩被测逻辑本身）：
 *
 * A. **崩溃恢复不得把已执行的 unknown 副作用判成可重放**（重复执行）
 *    证据链：daemon.ts:485-490 把 exec 的 'interrupted' 全部适配成契约 'aborted'；
 *    fleet.ts:843-862/895-897/930-932 里 'interrupted' 的来源是 container_lost /
 *    aborted / not_found（都是「结局不明」）；exec/types.ts:71-73 canAcceptCalls 只认
 *    ready|busy，容器被 guard 在 throttled/halted pause 成 suspended 后必然落进
 *    container_lost 分支。旧实现 journal.ts:314-319 对 'aborted' 直接标 interrupted 并
 *    返回 'replayed' → Runner 重放 side_effect='unknown' 的工具（rm / net.post）。
 *
 * D. **终态收口的状态是权威，结果行写失败不得把异常抛回调用方**（静默失败 + 误导性 stale_writer）
 *    旧实现 queue.ts finish() 先 fenceUpdate 改状态、再 writeResult；后者抛错时异常
 *    冒到 Runner → onFatal → 再 finish → status≠running 记 stale_writer。
 *
 * E. **recoverInFlight 必须一任务一隔离，且失败可观测**（daemon 起不来 / 任务永久卡死）
 *    旧实现 recovery.ts:98-106 无 per-task try：一条任务的 exec 对账抛错 →
 *    recoverOnStartup 抛 → cp.recover() 抛 → assembleDaemon 抛 → daemon 根本起不来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Journal } from '../src/control-plane/journal.ts';
import type { ExecReconciler } from '../src/control-plane/journal.ts';
import { Matcher } from '../src/control-plane/match.ts';
import { Scheduler } from '../src/control-plane/scheduler.ts';
import { recoverOnStartup } from '../src/control-plane/recovery.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';
import type { Guard } from '../src/control-plane/guard.ts';
import type { SideEffect } from '../src/shared/contracts.ts';

// ── 脚手架 ──────────────────────────────────────────────────────────

const tmps: TempDataDir[] = [];

interface RobustnessFixture {
  tmp: TempDataDir;
  db: DatabaseSync;
  queue: Queue;
  journal: Journal;
  matcher: Matcher;
  scheduler: Scheduler;
  events: Array<{ kind: string; detail: string }>;
  /** 造一条 running 任务（pop 拿 epoch）。 */
  makeRunning(): { taskId: string; epoch: number };
  /** 给 journal 装治理 forcer（模拟 daemon 的 govHolder.forcer）。 */
  withGovernance(res: { approvalId: number } | Error): void;
}

function makeFixture(opts: { exec?: ExecReconciler } = {}): RobustnessFixture {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = DEFAULT_CP_CONFIG;
  const events: Array<{ kind: string; detail: string }> = [];
  const record = (
    kind: string,
    level: 'normal' | 'guarded' | 'throttled' | 'halted',
    detail: string,
  ): void => {
    events.push({ kind, detail });
    tmp.db
      .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
      .run(Date.now(), level, kind, detail);
  };
  const queue = new Queue({ db: tmp.db, cfg, bus: tmp.bus, guardLevel: () => 'normal', record });
  const journal = new Journal({
    db: tmp.db,
    cfg,
    bus: tmp.bus,
    record,
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
  });
  const matcher = new Matcher({ db: tmp.db, cfg, queue, bus: tmp.bus, rules: [], wake: () => {}, record });
  const scheduler = new Scheduler({
    db: tmp.db,
    cfg,
    queue,
    guard: guardStub(),
    journal,
    matcher,
    bus: tmp.bus,
    record,
    fireHeartbeat: () => {},
  });

  return {
    tmp,
    db: tmp.db,
    queue,
    journal,
    matcher,
    scheduler,
    events,
    makeRunning(): { taskId: string; epoch: number } {
      const t = queue.submit({ title: 't', goal: 'g' });
      const run = queue.pop()!;
      return { taskId: t.id, epoch: run.runEpoch };
    },
    withGovernance(res: { approvalId: number } | Error): void {
      (journal as unknown as { deps: { governance?: unknown } }).deps.governance = {
        async requestApproval() {
          if (res instanceof Error) throw res;
          return res;
        },
      };
    },
  };
}

function guardStub(): Guard {
  return {
    currentLevel: () => 'normal',
    tick: () => ({ level: 'normal' }),
    status: () => ({ level: 'normal' }),
    calibrateOrUseFallback: () => {},
  } as unknown as Guard;
}

function recoveryDepsOf(f: RobustnessFixture): Parameters<typeof recoverOnStartup>[0] {
  return {
    db: f.db,
    queue: f.queue,
    journal: f.journal,
    matcher: f.matcher,
    guard: guardStub(),
    bus: f.tmp.bus,
    record: (kind, level, detail) => {
      f.events.push({ kind, detail });
    },
  };
}

function stepRowOf(f: RobustnessFixture, taskId: string, seq: number): {
  status: string;
  approval_id: number | null;
  result_json: string | null;
} {
  return f.db
    .prepare('SELECT status, approval_id, result_json FROM steps WHERE task_id=? AND seq=?')
    .get(taskId, seq) as { status: string; approval_id: number | null; result_json: string | null };
}

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});

/** daemon.ts:485-490 的真实适配语义：exec 的 interrupted 一律 → 'aborted'。 */
function execReporting(outcome: 'done' | 'aborted' | 'unknown' | 'unknown_host', result?: string): ExecReconciler {
  return {
    async reconcileCall() {
      return outcome;
    },
    async getCallResult() {
      return result === undefined ? null : { resultJson: result };
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// A. 崩溃恢复：unknown 副作用孤儿步在任何对账结局下都不得被判可重放
// ══════════════════════════════════════════════════════════════════

test.describe('A 崩溃恢复对账：unknown 副作用不得重复执行', () => {
  // journal.ts:299-302 —— safe/replayable 仍然重放（正例，防止修 A 时把这条一起改坏）
  test('A1 正例：side_effect=safe 的孤儿步仍判 replayed（重读无副作用，行为不变）', async () => {
    const f = makeFixture();
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'fs.read', { path: '/dot/home/a.md' }, 'safe');

    const outcome = await f.journal.reconcileAndResolve(taskId, seq);

    assert.equal(outcome, 'replayed', 'safe 步继续走重放路径');
    assert.equal(stepRowOf(f, taskId, seq).status, 'interrupted');
  });

  test('A2 正例：side_effect=replayable 的孤儿步仍判 replayed', async () => {
    const f = makeFixture();
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'browser.snapshot', { url: 'u' }, 'replayable');

    assert.equal(await f.journal.reconcileAndResolve(taskId, seq), 'replayed');
  });

  // 核心回归：旧实现在这里返回 'replayed'（journal.ts:314-319），即允许重放 rm/net.post
  test('A3 回归：exec 报 aborted（= interrupted/container_lost）的 unknown 步必须 deferred，不重放', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance({ approvalId: 11 });
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(
      taskId,
      epoch,
      'shell.run',
      { cmd: 'rm -rf /dot/home/notes' },
      'unknown',
    );

    const outcome = await f.journal.reconcileAndResolve(taskId, seq);

    assert.equal(outcome, 'deferred', 'aborted 不再被当成「保证未落地」，必须交主人确认');
    const row = stepRowOf(f, taskId, seq);
    assert.equal(row.status, 'interrupted', '孤儿步仍转 interrupted（§5.3 审计闭环，不删）');
    assert.equal(row.approval_id, 11, '必须落了一张审批单（approval_id 回写该步）');
  });

  test('A4 回归：treatUnknownAsRisk=false 时也不得降级为 replayed（仍 deferred，只是不转审批）', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    (f.journal as unknown as { deps: { treatUnknownAsRisk: boolean } }).deps.treatUnknownAsRisk = false;
    f.withGovernance({ approvalId: 12 });
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'net.post', { url: 'https://x/y' }, 'unknown');

    const outcome = await f.journal.reconcileAndResolve(taskId, seq);

    assert.equal(outcome, 'deferred', '无论 treatUnknownAsRisk 取值，都不许判可重放');
    assert.equal(stepRowOf(f, taskId, seq).approval_id, null, '关闭该开关时不转审批');
  });

  test('A5 回归：unknown / unknown_host 的原行为不变（deferred + 转审批）', async () => {
    for (const outcome of ['unknown', 'unknown_host'] as const) {
      const f = makeFixture({ exec: execReporting(outcome) });
      f.withGovernance({ approvalId: 13 });
      const { taskId, epoch } = f.makeRunning();
      const { seq } = f.journal.beginTool(taskId, epoch, 'web.click', { sel: '#buy' }, 'unknown');

      assert.equal(await f.journal.reconcileAndResolve(taskId, seq), 'deferred', `outcome=${outcome}`);
      assert.equal(stepRowOf(f, taskId, seq).approval_id, 13);
    }
  });

  test('A6 正例：exec 报 done → took_result，补记结果不重放', async () => {
    const ledger = JSON.stringify({ ok: true, from: 'exec-ledger' });
    const f = makeFixture({ exec: execReporting('done', ledger) });
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'echo hi' }, 'unknown');

    assert.equal(await f.journal.reconcileAndResolve(taskId, seq), 'took_result');
    const row = stepRowOf(f, taskId, seq);
    assert.equal(row.status, 'succeeded');
    assert.equal(row.result_json, ledger);
  });

  test('A7 回归：exec.reconcileCall 抛错不得炸恢复（降级 unknown_host + 记账）', async () => {
    const f = makeFixture({
      exec: {
        async reconcileCall() {
          throw new Error('docker socket 不可达');
        },
        async getCallResult() {
          throw new Error('docker socket 不可达');
        },
      },
    });
    f.withGovernance({ approvalId: 14 });
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf x' }, 'unknown');

    const outcome = await f.journal.reconcileAndResolve(taskId, seq);

    assert.equal(outcome, 'deferred');
    assert.equal(stepRowOf(f, taskId, seq).approval_id, 14);
    assert.ok(
      f.events.some((e) => e.detail.includes('reconcile_failed')),
      'exec 对账抛错要记账（不静默）',
    );
  });

  test('A8 回归：exec.getCallResult 抛错（done 但取不回结果）不得炸恢复，且仍不重放', async () => {
    const f = makeFixture({
      exec: {
        async reconcileCall() {
          return 'done';
        },
        async getCallResult() {
          throw new Error('ledger 读取超时');
        },
      },
    });
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf x' }, 'unknown');

    // 取不回结果也不许重放：done 已经证明调用落地过
    assert.equal(await f.journal.reconcileAndResolve(taskId, seq), 'took_result');
    const row = stepRowOf(f, taskId, seq);
    assert.equal(row.status, 'succeeded');
    assert.equal(row.result_json, null, '结果取不回就落 null，但步已终结');
    assert.ok(f.events.some((e) => e.detail.includes('getCallResult_failed')));
  });

  test('A9 回归：治理 forceApproval 抛错不得炸恢复（deferred + 记账）', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance(new Error('治理未就绪'));
    const { taskId, epoch } = f.makeRunning();
    const { seq } = f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf x' }, 'unknown');

    const outcome = await f.journal.reconcileAndResolve(taskId, seq);

    assert.equal(outcome, 'deferred');
    assert.ok(f.events.some((e) => e.detail.includes('recovery_approval_failed')));
  });

  // 端到端：经过 recoverOnStartup 的真实编排（不是直接调 reconcileAndResolve）
  test('A10 端到端：重启恢复把 unknown 的 aborted 孤儿步判 deferred，任务回 queued 且带审批', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance({ approvalId: 21 });
    const { taskId } = f.makeRunning();
    const epoch = f.queue.getTask(taskId)!.runEpoch;
    f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf /dot/home' }, 'unknown');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'deferred' }]);
    assert.deepEqual(report.inFlightRecovered, [taskId]);
    assert.equal(f.queue.getTask(taskId)!.status, 'queued');
    assert.equal(stepRowOf(f, taskId, 1).approval_id, 21);
  });

  // 可观测性补强（2026-10-17）：A 修复把 unknown 步从"可重放"改成"必须审批"，
  // 若启动侧只把 outcome 塞进 openStepsResolved 字符串里，主人无从得知
  // "有几个东西在等我批"。RecoveryReport.inFlightDeferred 是显式事实，daemon 据此打日志。
  test('A10b 可观测：deferred 孤儿步进 inFlightDeferred（带 taskId/seq/tool/approvalId）', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance({ approvalId: 21 });
    const { taskId, epoch } = f.makeRunning();
    f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf /dot/home' }, 'unknown');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.inFlightDeferred, [
      { taskId, seq: 1, tool: 'shell.run', approvalId: 21 },
    ]);
  });

  test('A10c 可观测：治理不可用（无审批单）时仍记 inFlightDeferred 且 approvalId=null', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance(new Error('治理未就绪'));
    const { taskId, epoch } = f.makeRunning();
    f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf x' }, 'unknown');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.inFlightDeferred, [
      { taskId, seq: 1, tool: 'shell.run', approvalId: null },
    ]);
  });

  test('A10d 可观测：safe 步走重放时不进 inFlightDeferred（不制造假审批告警）', async () => {
    const f = makeFixture();
    const { taskId, epoch } = f.makeRunning();
    f.journal.beginTool(taskId, epoch, 'fs.read', { path: '/a' }, 'safe');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.inFlightDeferred, []);
    assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'replayed' }]);
  });

  // 混合：同一条任务上 safe 与 unknown 两种孤儿步各自走对分支
  test('A11 混合：safe 孤儿重放、unknown 孤儿 deferred（同一任务两次对账互不影响）', async () => {
    const f = makeFixture({ exec: execReporting('aborted') });
    f.withGovernance({ approvalId: 22 });
    const { taskId, epoch } = f.makeRunning();
    const safe = f.journal.beginTool(taskId, epoch, 'fs.read', { path: '/dot/home/a' }, 'safe');
    const risky = f.journal.beginTool(taskId, epoch, 'shell.run', { cmd: 'rm -rf x' }, 'unknown');

    assert.equal(await f.journal.reconcileAndResolve(taskId, safe.seq), 'replayed');
    assert.equal(await f.journal.reconcileAndResolve(taskId, risky.seq), 'deferred');
  });

  // 副作用词表全覆盖：每个 unknown 工具都不得被判可重放
  test('A12 遍历：所有声明为 unknown 的工具在 aborted 结局下都 deferred', async () => {
    const tools = ['shell.run', 'net.post', 'shop.checkout', 'browser.act', 'fs.write'] as const;
    for (const tool of tools) {
      const f = makeFixture({ exec: execReporting('aborted') });
      f.withGovernance({ approvalId: 30 });
      const { taskId, epoch } = f.makeRunning();
      const { seq } = f.journal.beginTool(taskId, epoch, tool, { a: 1 }, 'unknown' as SideEffect);
      assert.equal(await f.journal.reconcileAndResolve(taskId, seq), 'deferred', `tool=${tool}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// D. 终态收口：状态是权威，结果行写失败不得抛回调用方
// ══════════════════════════════════════════════════════════════════

test.describe('D 终态收口：writeResult 失败不污染状态机', () => {
  /** 让 task_results 写入必然失败（模拟表锁/磁盘满/schema 漂移）。 */
  function breakTaskResults(db: DatabaseSync): void {
    db.exec('DROP TABLE task_results');
  }

  test('D1 回归：finish(ok:true) 时 writeResult 抛错 → 状态仍 done，且 finish 不抛', () => {
    const f = makeFixture();
    const t = f.queue.submit({ title: 't', goal: 'g' });
    const run = f.queue.pop()!;
    breakTaskResults(f.db);

    // 旧实现：这里抛 "no such table: task_results"，而 tasks.status 已经是 'done'
    assert.doesNotThrow(() => f.queue.finish(t.id, run.runEpoch, { ok: true, summary: '做完了' }));

    assert.equal(f.queue.getTask(t.id)!.status, 'done', '状态是权威，必须落库');
    assert.ok(
      f.events.some((e) => e.detail.includes('writeResult_failed')),
      '写结果失败要记账（不静默）',
    );
  });

  test('D2 回归：finish(ok:false) 走 failed 分支时 writeResult 抛错也不抛', () => {
    const f = makeFixture();
    const t = f.queue.submit({ title: 't', goal: 'g' });
    // attempt 用尽（max_attempts=3）→ finish(false) 应该落到 failed
    f.db.prepare('UPDATE tasks SET attempt=2 WHERE id=?').run(t.id);
    const run = f.queue.pop()!;
    breakTaskResults(f.db);

    assert.doesNotThrow(() => f.queue.finish(t.id, run.runEpoch, { ok: false, summary: '炸了' }));
    assert.equal(f.queue.getTask(t.id)!.status, 'failed');
  });

  test('D3 回归：markFailed（看门狗路径）时 writeResult 抛错也不抛', () => {
    const f = makeFixture();
    const t = f.queue.submit({ title: 't', goal: 'g' });
    const run = f.queue.pop()!;
    breakTaskResults(f.db);

    assert.doesNotThrow(() => f.queue.markFailed(t.id, run.runEpoch, 'watchdog：心跳超时'));
    assert.equal(f.queue.getTask(t.id)!.status, 'failed');
  });

  test('D4 正例：task_results 正常时结果照旧落库（修复不影响正常路径）', () => {
    const f = makeFixture();
    const t = f.queue.submit({ title: 't', goal: 'g' });
    const run = f.queue.pop()!;

    f.queue.finish(t.id, run.runEpoch, { ok: true, summary: '正常完成' });

    const row = f.db
      .prepare('SELECT summary, ok FROM task_results WHERE task_id=?')
      .get(t.id) as { summary: string; ok: number };
    assert.equal(row.summary, '正常完成');
    assert.equal(row.ok, 1);
    assert.equal(f.events.filter((e) => e.detail.includes('writeResult_failed')).length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════
// E. recoverInFlight：一任务一隔离 + 失败可观测 + 兜底归位
// ══════════════════════════════════════════════════════════════════

test.describe('E 崩溃恢复：单任务对账失败不得阻断启动', () => {
  /** 造两条并存的 running 任务（maxRunningTasks 只是 pop 门控，重启不查）。 */
  function twoRunning(f: RobustnessFixture): { a: string; b: string } {
    const a = f.queue.submit({ title: 'a', goal: 'ga' });
    const b = f.queue.submit({ title: 'b', goal: 'gb' });
    for (const id of [a.id, b.id]) {
      f.db.prepare("UPDATE tasks SET status='running', run_epoch=run_epoch+1 WHERE id=?").run(id);
    }
    return { a: a.id, b: b.id };
  }

  test('E1 回归：一条任务的 exec 对账抛错不得让 recoverOnStartup 整体抛错', async () => {
    const f = makeFixture({
      exec: {
        async reconcileCall(callId: string) {
          if (callId === badCall) throw new Error('容器 unreachable');
          return 'unknown_host';
        },
        async getCallResult() {
          return null;
        },
      },
    });
    const ids = twoRunning(f);
    // 两条任务各一个 unknown 孤儿步；把 A 的 call_id 记为「会炸的那条」
    const aStep = f.journal.beginTool(ids.a, 1, 'shell.run', { cmd: 'x' }, 'unknown');
    f.journal.beginTool(ids.b, 1, 'shell.run', { cmd: 'y' }, 'unknown');
    badCall = aStep.callId;

    // 旧实现：reconcileAndResolve 抛 → 整个 recoverOnStartup 抛 → daemon 起不来
    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    // 注：reconcile 抛错现在在 journal 层就降级成 unknown_host，所以这里两条都能走完；
    // 真正验证「per-task try」的是 E2（reclaimInFlight 抛错）。
    assert.equal(report.openStepsResolved.length, 2, '两条任务的孤儿步都被处置');
    assert.equal(report.inFlightFailed.length, 0);
  });

  test('E2 回归：reclaimInFlight 抛错时该任务进 inFlightFailed、记 resource_event、其余任务照常恢复', async () => {
    const f = makeFixture();
    const ids = twoRunning(f);
    // 让 B 的 reclaim 必然抛错（A 正常）：用 fenceUpdate 的 WHERE run_epoch 制造 0 行不抛，
    // 所以直接在 queue 实例上包一层——模拟「库级异常」
    const realReclaim = f.queue.reclaimInFlight.bind(f.queue);
    f.queue.reclaimInFlight = (taskId: string, epoch: number, reason: string): boolean => {
      if (taskId === ids.b) throw new Error('SQLITE_BUSY: database is locked');
      return realReclaim(taskId, epoch, reason);
    };

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.inFlightRecovered, [ids.a], 'A 正常恢复');
    assert.equal(report.inFlightFailed.length, 1, 'B 的对账/归位失败必须可观测');
    assert.equal(report.inFlightFailed[0]!.taskId, ids.b);
    assert.match(report.inFlightFailed[0]!.error, /SQLITE_BUSY/);
    assert.ok(
      f.events.some((e) => e.detail.includes('recovery_failed') && e.detail.includes(ids.b)),
      '失败要落 resource_event（不静默跳过）',
    );
    assert.equal(f.queue.getTask(ids.a)!.status, 'queued');
  });

  test('E3 回归：reconcileAndResolve 抛错时任务被兜底归位为 queued（不得停在 running 永久卡死）', async () => {
    const f = makeFixture();
    const ids = twoRunning(f);
    const realReconcile = f.journal.reconcileAndResolve.bind(f.journal);
    let thrown = false;
    f.journal.reconcileAndResolve = async (taskId: string, seq: number) => {
      if (taskId === ids.b && !thrown) {
        thrown = true;
        throw new Error('对账时库 I/O 错误');
      }
      return realReconcile(taskId, seq);
    };
    f.journal.beginTool(ids.b, 1, 'shell.run', { cmd: 'x' }, 'unknown');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.equal(report.inFlightFailed.length, 1);
    // 关键：不能停在 running（那会白占 maxRunningTasks 额度且无协程持有 → 永久卡死）
    assert.equal(f.queue.getTask(ids.b)!.status, 'queued', '兜底归位为 queued');
    assert.equal(f.queue.getTask(ids.a)!.status, 'queued');
  });

  test('E4 正例：全部正常时 inFlightFailed 为空，编排结果与旧行为一致', async () => {
    const f = makeFixture();
    const { taskId, epoch } = f.makeRunning();
    f.journal.beginTool(taskId, epoch, 'fs.read', { path: '/a' }, 'safe');

    const report = await recoverOnStartup(recoveryDepsOf(f), f.scheduler);

    assert.deepEqual(report.inFlightRecovered, [taskId]);
    assert.deepEqual(report.inFlightFailed, []);
    assert.deepEqual(report.openStepsResolved, [{ taskId, seq: 1, outcome: 'replayed' }]);
  });
});

/** E1 用：需要在 exec stub 里比对会炸的 call_id（fixture 建好后才拿到）。 */
let badCall = '';
