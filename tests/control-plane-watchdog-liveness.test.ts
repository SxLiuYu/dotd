/**
 * tests/control-plane-watchdog-liveness.test.ts —— P0-3「看门狗误回收」回归（roadmap P0-3）。
 *
 * 缺陷本体（HEAD b7e7ee5 实测）：
 *   - 心跳只在 Runner 步尾写（src/runner/dot.ts `afterStep()`，每轮工具结束后一次）；
 *   - `ExecService.runTool` 在途期间（async 工具允许 30 分钟）心跳**完全静止**；
 *   - `heartbeatTimeoutMs=180_000` → **任何超过 3 分钟的工具调用必被误回收**：
 *     任务被标 interrupted、回 queued、attempt+1、整体重跑 → 副作用干两遍。
 *
 * 本文件钉死互相制约的四件事（缺一条，修复就会走向反面）：
 *   A. **阳性（误杀）**：工具在途、上游 `/jobs/{id}` 持续报 running（= 工具确实在跑）时，
 *      即使已过 200s 虚拟时间，看门狗**不得**回收 —— "绝不重复执行"的底线。
 *   B. **阴性（真卡死）**：上游停止推进时心跳必须停写，看门狗仍在 180s 内回收。
 *      修"误杀"不能换来"永不回收"。
 *   C. **接缝**：心跳由 ExecService 经**注入的回调**调出（EX 不直写 CP 的表，CONVENTIONS §4）；
 *      每轮**成功**的 GET /jobs 最多续一次，清账/报错后不再续。
 *   D. **同源 deadline**：`deadline_ms` 对 async 工具体应取 `ExecConfig.asyncDeadlineMs`，
 *      而不是 Runner 的 `toolDeadlineMs`（缺省 60s）——否则 3 分钟以上的工具
 *      在看门狗启动前就已被本地 deadline 掐死，修复毫无意义。
 *
 * 时间控制（**禁止真 sleep**）：所有"过了 200s"都由显式虚拟 now 表达
 * （`Scheduler.watchdog(now)` / 心跳回调的 `now`）。真实耗时只有毫秒级轮询间隔。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { ControlPlaneInstance } from '../src/control-plane/index.ts';
import { ControlPlaneWatchdog } from '../src/control-plane/scheduler.ts';
import {
  ExecServiceImpl,
  resolveToolDeadlineMs,
  pollJobOnceWithLiveness,
} from '../src/exec/ExecService.ts';
import type { ExecLiveness } from '../src/exec/ExecService.ts';
import { DEFAULT_EXEC_CONFIG } from '../src/exec/types.ts';
import { CAPABILITY_CATALOG } from '../src/exec/protocol.ts';
import { toolDeadlineMsFor } from '../src/runner/dot.ts';
import type { Capability, ExecToolResult } from '../src/shared/contracts.ts';

const tmps: TempDataDir[] = [];
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

/** 真实看门狗超时（CP §4.1）：本文件所有"180s 内回收"的判据都用它。 */
const HEARTBEAT_TIMEOUT_MS = 180_000;

/** 读一条任务的原始行（直接读同一连接：CP 实例不暴露 db，测试用 tmp.db 就是同一库）。 */
function rowOf(tmp: TempDataDir, id: string): Record<string, unknown> {
  return tmp.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown>;
}

/**
 * 造一条 `status='running'` 的任务：CP submit → pop。
 * pop 内写入新鲜心跳（CP §4.2），与生产路径一致——`last_heartbeat_at` 不是测试编出来的值。
 */
function runningTask(cp: ControlPlaneInstance, tmp: TempDataDir): { id: string; epoch: number; hb: number } {
  const t = cp.queue.submit({ title: 'long-tool', goal: 'run a 200s shell.run' });
  const run = cp.pop('dot1');
  assert.ok(run !== null, 'maxRunning=1 下首条任务必须能领到');
  const hb = Number(rowOf(tmp, t.id)['last_heartbeat_at']);
  assert.ok(hb > 0, 'pop 必须写入初始心跳（CP §4.2）');
  return { id: t.id, epoch: run.runEpoch, hb };
}

function watchdogOf(cp: ControlPlaneInstance, tmp: TempDataDir): ControlPlaneWatchdog {
  return new ControlPlaneWatchdog({
    db: tmp.db,
    queue: cp.queue,
    journal: cp.journalImpl,
    bus: tmp.bus,
    record: (kind, level, detail) => {
      tmp.db
        .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
        .run(Date.now(), level, kind, detail);
    },
  });
}

/** pollJob 接缝测试用的固定输入（任务/调用的身份）。 */
const INPUT = { taskId: 't1', epoch: 1, callId: 'c1', dotId: 'dot1', tool: 'shell.run' } as const;

// ═══════════════════════════════════════════════════════════════════
// A. 阳性：工具在途 200s（上游持续 running）→ 看门狗不得回收
// ═══════════════════════════════════════════════════════════════════

test('阳性：工具在途 200s、上游持续报 running → 心跳续写，看门狗不回收、任务仍 running', () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  const t = runningTask(cp, tmp);
  const wd = watchdogOf(cp, tmp);

  // 工具在途：ExecService.pollJob 每轮 getJob 成功（上游在推进）→ 调心跳回调。
  // 虚拟时钟：从 pop 时刻起每 10s 上游推进一次，持续 240s（远超 180s 超时）。
  for (let elapsed = 0; elapsed <= 240_000; elapsed += 10_000) {
    const now = t.hb + elapsed;
    const r = cp.heartbeat(t.id, t.epoch, undefined, { skipBudget: true, live: { at: now } });
    assert.equal(r.aborted, false, `第 ${elapsed / 1000}s 的心跳不得被围栏拒绝`);
    // 每 30s 跑一次看门狗（生产是 10s 子周期，这里加密采样更严）
    if (elapsed % 30_000 === 0) wd.watchdog(now);
  }

  // 关键断言：超过 180s 超时之后任务**仍在 running**，没被误回收
  wd.watchdog(t.hb + 200_000);
  wd.watchdog(t.hb + 240_000);
  const row = rowOf(tmp, t.id);
  assert.equal(row['status'], 'running', '工具在途 200s 不得被看门狗误回收（副作用会干两遍）');
  assert.equal(Number(row['run_epoch']), t.epoch, 'run_epoch 不得被回收流程改写');
  assert.equal(Number(row['attempt']), 0, 'attempt 不得 +1（+1 就等于重跑）');
  assert.equal(Number(row['last_heartbeat_at']), t.hb + 240_000, '心跳时刻 = 最后一次上游推进时刻');
  const reclaims = tmp.db
    .prepare("SELECT COUNT(*) AS n FROM resource_events WHERE kind='watchdog' AND detail LIKE ?")
    .get(`%"taskId":"${t.id}"%`) as { n: number };
  assert.equal(reclaims.n, 0, '不得留下 watchdog 回收记录');
});

// ═══════════════════════════════════════════════════════════════════
// B. 阴性：真卡死（上游停止推进）→ 180s 后仍必须被回收
// ═══════════════════════════════════════════════════════════════════

test('阴性：前 150s 上游在推进、之后真卡死（无心跳）→ 180s 后看门狗照常回收（interrupted+queued+attempt+1）', () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  const t = runningTask(cp, tmp);
  const wd = watchdogOf(cp, tmp);

  // 先造一个在途的 started 工具步：看门狗回收时应把它标 interrupted（CP §4.1）
  const step = cp.journal.beginTool(t.id, t.epoch, 'shell.run', { cmd: 'sleep 200' }, 'unknown');

  // 0..150s：上游活着，心跳每 10s 续一次（修复后的正确行为）
  for (let elapsed = 0; elapsed <= 150_000; elapsed += 10_000) {
    cp.heartbeat(t.id, t.epoch, undefined, { skipBudget: true, live: { at: t.hb + elapsed } });
  }
  const lastBeat = t.hb + 150_000;
  wd.watchdog(lastBeat);
  assert.equal(rowOf(tmp, t.id)['status'], 'running', '150s < 180s，不得回收');

  // 150s 之后工具真卡死：没有任何心跳续写。判据是严格大于 → 测 180s 整与 +1ms
  wd.watchdog(lastBeat + HEARTBEAT_TIMEOUT_MS);
  assert.equal(rowOf(tmp, t.id)['status'], 'running', '恰好 180s 不得回收（判据是严格大于）');

  wd.watchdog(lastBeat + HEARTBEAT_TIMEOUT_MS + 1);
  const row = rowOf(tmp, t.id);
  assert.equal(row['status'], 'queued', '真卡死 180s 后必须回收（回 queued）');
  assert.equal(Number(row['attempt']), 1, 'attempt+1');
  assert.equal(Number(row['priority']), 2, 'priority=min(priority,2)');
  assert.equal(row['last_heartbeat_at'], null, '回收时清空心跳');
  assert.equal(Number(row['run_epoch']), t.epoch, '看门狗自身不递增 epoch（CP §7.1 步骤 3）');

  const st = tmp.db
    .prepare('SELECT status, result_json AS r FROM steps WHERE call_id=?')
    .get(step.callId) as { status: string; r: string | null };
  // 真实终态必须是 interrupted（不是 skipped）：这一步**已经派发出去、结果未知**，
  // Runner 重建上下文时只对 interrupted 步注入"上一步结果未知，先观测再决定"的恢复注记
  // （dot.ts 的 feedSystemNote(noteText(s))）。skipped 的契约语义是"治理拒绝、从未打算执行"，
  // 拿它当回收终态会把事故伪装成正常跳过，模型下一轮就会直接重做。
  assert.equal(st.status, 'interrupted', '孤儿 started 工具步必须标 interrupted（不是 skipped）');
  assert.equal(st.r, 'watchdog_reclaim', '并记 watchdog_reclaim 原因（who/what 都要能追溯）');

  const ev = tmp.db
    .prepare("SELECT COUNT(*) AS n FROM resource_events WHERE kind='watchdog' AND detail LIKE ?")
    .get(`%"taskId":"${t.id}"%`) as { n: number };
  assert.equal(ev.n, 1, '恰好一条 watchdog 回收记录');
});

test('阴性：续过心跳也救不了真卡死——最后一次推进后 +181s 必回收（心跳只认上游推进）', () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  const t = runningTask(cp, tmp);
  const wd = watchdogOf(cp, tmp);

  // 上游推进到 100s 就没了（容器卡住/挂起，getJob 不再成功 → 回调不触发）
  const lastBeat = t.hb + 100_000;
  cp.heartbeat(t.id, t.epoch, undefined, { skipBudget: true, live: { at: lastBeat } });
  for (const at of [lastBeat + 60_000, lastBeat + HEARTBEAT_TIMEOUT_MS - 1]) wd.watchdog(at);
  assert.equal(rowOf(tmp, t.id)['status'], 'running', '最后推进后 180s 内是允许的');
  wd.watchdog(lastBeat + HEARTBEAT_TIMEOUT_MS + 1);
  assert.equal(
    rowOf(tmp, t.id)['status'],
    'queued',
    '180s 后必须回收：心跳只认"上游有推进"，不认"我还在跑"',
  );
});

// ═══════════════════════════════════════════════════════════════════
// C. 接缝：每轮成功 GET /jobs 恰好续一次心跳；报错/终态后不再续
// ═══════════════════════════════════════════════════════════════════

/** 只实现 pollJob 用到的 getJob 的假上游（零网络、行为可控、可脚本化）。 */
function fakeJobSource(script: Array<'running' | 'ok' | 'throw'>): {
  calls: number;
  getJob: () => Promise<ExecToolResult>;
} {
  const src = {
    calls: 0,
    async getJob(): Promise<ExecToolResult> {
      src.calls += 1;
      const step = script.shift() ?? 'ok';
      if (step === 'throw') throw new Error('ECONNREFUSED');
      if (step === 'running') return { call_id: 'c1', job_id: 'job_1', status: 'running' };
      return { call_id: 'c1', job_id: 'job_1', status: 'ok', result: { done: true } };
    },
  };
  return src;
}

function recordingLiveness(): { seen: number[]; liveness: ExecLiveness } {
  const seen: number[] = [];
  return {
    seen,
    liveness: {
      live({ now }) {
        seen.push(now);
      },
    },
  };
}

test('接缝：pollJob 每轮只取一次 GET /jobs；报 running 才续一次心跳（终态不续）', async () => {
  const src = fakeJobSource(['running', 'running', 'running', 'ok']);
  const { seen, liveness } = recordingLiveness();
  let clock = 1_000;
  // 一轮 = 一次取数（pollJob 自己负责 sleep/守卫，见 pollJobOnceWithLiveness 注释）
  const results: ExecToolResult[] = [];
  for (let i = 0; i < 4; i++) {
    results.push(await pollJobOnceWithLiveness(() => src.getJob(), INPUT, liveness, () => (clock += 500)));
  }
  assert.equal(src.calls, 4, '4 轮 = 4 次取数（一轮绝不多取）');
  assert.deepEqual(
    results.map((r) => r.status),
    ['running', 'running', 'running', 'ok'],
  );
  assert.deepEqual(seen, [1_500, 2_000, 2_500], '只有 running 的轮次续心跳；读到终态的那轮不续');
});

test('接缝：getJob 抛错不续心跳，异常原样冒泡给 pollJob（由它走 probeHealth 分支）', async () => {
  const src = fakeJobSource(['running', 'throw']);
  const { seen, liveness } = recordingLiveness();
  await pollJobOnceWithLiveness(() => src.getJob(), INPUT, liveness, () => Date.now());
  await assert.rejects(
    pollJobOnceWithLiveness(() => src.getJob(), INPUT, liveness, () => Date.now()),
    /ECONNREFUSED/,
    '上游报错必须冒泡（不能吞）',
  );
  assert.equal(src.calls, 2);
  assert.equal(seen.length, 1, '只有成功且 running 的那一轮续心跳');
});

test('接缝：心跳回调自身抛错不得炸掉工具调用（心跳只是附带动作，判死另有看门狗）', async () => {
  const src = fakeJobSource(['running', 'running', 'ok']);
  const errors: unknown[] = [];
  const results: ExecToolResult[] = [];
  for (let i = 0; i < 3; i++) {
    results.push(
      await pollJobOnceWithLiveness(
        () => src.getJob(),
        INPUT,
        {
          live() {
            throw new Error('heartbeat db is locked');
          },
        },
        () => Date.now(),
        (err) => errors.push(err),
      ),
    );
  }
  assert.deepEqual(
    results.map((r) => r.status),
    ['running', 'running', 'ok'],
    '心跳失败只记日志，工具轮询照常推进',
  );
  assert.equal(errors.length, 2, '两次 running 轮次的心跳失败都被上报（而不是静默吞掉、也不是抛出）');
});

// ── 回归：曾在这里写出死循环（2026-10-18 实测：exec-idempotency 两个用例挂死 400s+）──
test('回归：pollJob 单轮语义——上游永远 running 时也「一轮只取一次」，绝不内部自旋', async () => {
  // 旧实现把"取到非 running 为止"的循环塞进了这个 helper：于是 pollJob 的
  // 容器运行期守卫（容器转 unhealthy → 立刻收手）永远等不到执行，
  // tests/exec-idempotency.test.ts 的"运行期守卫"用例直接挂死到 deadline。
  let calls = 0;
  const foreverRunning = async (): Promise<ExecToolResult> => {
    calls += 1;
    return { call_id: 'c1', job_id: 'job_1', status: 'running' };
  };
  const { seen, liveness } = recordingLiveness();
  const res = await pollJobOnceWithLiveness(foreverRunning, INPUT, liveness, () => 1);
  assert.equal(res.status, 'running');
  assert.equal(calls, 1, '上游一直 running：一轮也只取一次就返回（控制权交回 pollJob）');
  assert.equal(seen.length, 1, '续一次心跳');
});

test('回归：容器在轮询期间转 unhealthy → runTool 在远早于 deadline 时收手（不再是忙等/挂死）', async () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  // 真实 ExecService + stub fleet：stub 的 shell.run handler 恒回 running，
  // startJob 会等 handler 返回后才去轮询，因此这里能真正进入 pollJob。
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root, pollIntervalMs: 5 },
    stubRuntime: {
      handlers: {
        'shell.run': async (c) => ({ call_id: c.call_id, status: 'running' as const }),
      },
    },
  });
  await exec.boot(['dot-a']);
  const startedAt = Date.now();
  const p = exec.runTool({
    call_id: 'uh-regress-1',
    task_id: 't1',
    dot_id: 'dot-a',
    tool: 'shell.run',
    args: { cmd: 'sleep 1', timeout_ms: 1000 },
    deadline_ms: 60_000,
    issued_at: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(exec.fleet.getCall('uh-regress-1')?.state, 'running', '调用应在途');
  exec.fleet.transition('dot-a', 'unhealthy', { reason: '测试：运行期失康' });
  const r = await p;
  assert.equal(r.status, 'error');
  assert.equal(r.error?.code, 'container_unhealthy');
  assert.ok(
    Date.now() - startedAt < 10_000,
    `必须远早于 deadline 收手，实际 ${Date.now() - startedAt}ms（若这里超时 = 轮询内部自旋了）`,
  );
});

test('接缝：真 ExecService.runTool 跑「在途 3 轮」的 async 工具，心跳按轮次落库（端到端）', async () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  const t = runningTask(cp, tmp);

  let polls = 0;
  let tick = 0;
  const beatRanks: number[] = [];
  const runtime = {
    async startJob(): Promise<{ job_id: string }> {
      return { job_id: 'job_1' };
    },
    async getJob(): Promise<ExecToolResult> {
      polls += 1;
      if (polls <= 3) {
        // ⚠ 这里**不能**有真实等待：pollJob 的 deadline = clock() + deadline_ms，而本用例
        // 的 clock 是"每次调用 +1"的注入钟。若在取数里 await 真实定时器，getJob 返回时
        // 墙钟仍在 deadline 之前、但当轮结束后的 `clock() > deadline` 判定会因**注入钟
        // 多走了一格**而在第 3 轮提前 break —— 这正是并行 4 路时 4≠5 的 flaky 根因
        // （与负载无关，是"用墙钟换逻辑轮次"）。
        // 改为不等待：每一轮都由确定的状态机驱动（3 次 running → 第 4 次 ok）。
        return { call_id: 'c1', job_id: 'job_1', status: 'running' };
      }
      return { call_id: 'c1', job_id: 'job_1', status: 'ok', result: { stdout: 'ok' } };
    },
    async cancelJob(): Promise<void> {},
    async health(): Promise<unknown> {
      return { ok: true };
    },
    async capabilities(): Promise<Array<{ name: string }>> {
      return [];
    },
    async getCall(): Promise<unknown> {
      return null;
    },
    async confirmCall(): Promise<boolean> {
      return true;
    },
    async compactLedger(): Promise<string[]> {
      return [];
    },
  };
  const liveness: ExecLiveness = {
    live: ({ taskId, epoch, now }) => {
      beatRanks.push(now - t.hb);
      cp.heartbeat(taskId, epoch, undefined, { skipBudget: true, live: { at: now } });
    },
  };
  // 注入时钟：整个调用期间只走 4 个值（真实毫秒级，不 sleep）
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root, pollIntervalMs: 2 },
    runtime: runtime as never,
    clock: () => {
      tick += 1;
      return t.hb + tick;
    },
  });
  exec.setLiveness(liveness);
  await exec.boot(['dot1']);

  const res = await exec.runTool({
    call_id: 'c1',
    task_id: t.id,
    dot_id: 'dot1',
    tool: 'shell.run',
    args: { cmd: 'sleep 200', timeout_ms: 3000 },
    deadline_ms: 30 * 60_000,
    issued_at: new Date().toISOString(),
  });
  assert.equal(res.status, 'ok', '假上游最终 ok');
  assert.equal(polls, 4, '3 轮 running + 1 轮终态');
  // 派发时 1 次（startJob 已证明上游可达）+ 3 轮 running 各 1 次；读到终态的那轮**不续**
  // （没有"在途"可言 —— 这就是"心跳只认上游在推进"的收紧语义）。
  assert.equal(beatRanks.length, 4, '派发 1 次 + 3 轮 running 各 1 次（终态轮不续）');
  assert.deepEqual([...beatRanks].sort((a, b) => a - b), beatRanks, '心跳时刻单调不减');
  assert.equal(new Set(beatRanks).size, 4, '四次心跳取自四个不同的取数时刻（不是 setInterval 自走）');
  assert.equal(
    Number(rowOf(tmp, t.id)['last_heartbeat_at']),
    t.hb + Math.max(...beatRanks),
    '最后一次心跳确实落进了库里',
  );
});

// ═══════════════════════════════════════════════════════════════════
// D. 同源 deadline：async 工具不该被 Runner 的 60s 本地上限提前掐死
// ═══════════════════════════════════════════════════════════════════

test('deadline：Runner 不再把 sync 档的 60s 发给 async 工具；async 侧缺省 = 目录声明的 30min', () => {
  // ① Runner 的选档（缺陷真正发生的地方：曾对 11 个工具一律发 toolDeadlineMs）。
  // 这里直接用真实能力目录（shell.run=async/1800000、fs.read=sync）。
  const capOf = (name: string): Capability => {
    const c = CAPABILITY_CATALOG.find((x) => x.name === name);
    assert.ok(c !== undefined, `能力目录缺 ${name}`);
    return c;
  };
  const asCap = (c: Capability): { mode: 'sync' | 'async'; maxDeadlineMs: number } => ({
    mode: c.mode,
    maxDeadlineMs: c.max_deadline_ms,
  });

  assert.equal(
    toolDeadlineMsFor(60_000, asCap(capOf('shell.run'))),
    DEFAULT_EXEC_CONFIG.asyncDeadlineMs,
    'async 工具（shell.run）不得被 Runner 的 60s 口径掐断',
  );
  assert.equal(toolDeadlineMsFor(60_000, asCap(capOf('browser.act'))), 30 * 60_000, 'browser.* 同为 async 档');
  assert.equal(toolDeadlineMsFor(60_000, asCap(capOf('fs.read'))), 60_000, 'sync 工具仍旧用调用方给的 60s');
  assert.equal(toolDeadlineMsFor(2_000, asCap(capOf('fs.write'))), 2_000, 'sync 工具的收紧值不被放大');
  assert.equal(toolDeadlineMsFor(60_000, undefined), 60_000, '目录里没有的工具按 sync 档保守处理（不放大上限）');
  assert.equal(toolDeadlineMsFor(7_000, { mode: 'async', maxDeadlineMs: 0 }), 30 * 60_000, 'async 缺上限回落 30min');

  // ② ExecService 侧的缺省填充（同一套常量，防两处再次分叉）
  assert.equal(resolveToolDeadlineMs('shell.run', undefined), DEFAULT_EXEC_CONFIG.asyncDeadlineMs);
  assert.equal(resolveToolDeadlineMs('fs.read', 2_000), 2_000);
  assert.equal(resolveToolDeadlineMs('shell.run', 300_000), 300_000, '显式更小的 async 上限照用');
  assert.equal(DEFAULT_EXEC_CONFIG.asyncDeadlineMs, 30 * 60_000);
  assert.ok(
    HEARTBEAT_TIMEOUT_MS < DEFAULT_EXEC_CONFIG.asyncDeadlineMs,
    '心跳超时必须小于异步工具上限，否则长工具永远没有完成的机会',
  );
});
