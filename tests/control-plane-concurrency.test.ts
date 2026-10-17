/**
 * tests/control-plane-concurrency.test.ts —— P1-1 证明①（对话不被后台饿死）+ 证明②（并发不破幂等/围栏）。
 *
 * ## 缺陷（HEAD）
 * `queue.pop()` 第一行就是 `if (runningCount >= maxRunningTasks) return null;`——
 * **额度一满，连"看看队列里有没有主人对话"这一步都不做**。于是：
 *   后台 heartbeat 任务（priority=5）占满 1 个额度 → 主人在飞书说一句话（priority=1）
 *   只能等那个 30 分钟的后台任务跑完。优先级排序只在"有空位"时生效，饿死窗口是结构性的。
 *
 * ## 修法（本文件验证的契约）
 * 额度满时不再一刀切 return null，而是分两种：
 *  - 有能力腾出位置（interactive 预留额度 / 可抢占的后台任务）→ 让 interactive 进去；
 *  - 否则 → 照旧 null。
 * **默认配置下行为逐字不变**：`maxRunningTasks=1` 且未开启任何预留时，
 * 仍是严格串行，`pop()` 满额即返回 null。
 *
 * ## 本文件钉住
 * ① 后台占满 → 提交 priority=1 → **在有限轮次内被 pop 到**（给出具体轮次与依据）；
 * ② 两条任务并发各跑工具：call_id 不串、run_epoch 围栏各自生效、journal 不交叉；
 * ③ 默认配置（maxRunningTasks=1、无预留）下行为与改动前逐字一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import type { ControlPlaneInstance } from '../src/control-plane/index.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';

const tmps: TempDataDir[] = [];
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

function makeCp(cfg: Partial<typeof DEFAULT_CP_CONFIG> = {}): ControlPlaneInstance & { db: TempDataDir['db'] } {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus, cfg });
  // 测试便利：把底层连接挂到实例上（只看库，不改变被测语义）
  return Object.assign(cp, { db: tmp.db });
}

/** 提交一个任务并返回 id（priority 默认 5 = 后台 heartbeat）。 */
function submit(cp: ControlPlaneInstance, title: string, priority: number): string {
  return cp.queue.submit({ title, goal: title, priority }).id;
}

// ═══════════════════════════════════════════════════════════════════
// ③ 默认行为逐字不变（先钉这个，防止改坏）
// ═══════════════════════════════════════════════════════════════════

test('③-a 默认配置（maxRunningTasks=1、无预留）：满额即 null，严格串行——与改动前一致', () => {
  const cp = makeCp();
  const a = submit(cp, '后台A', 5);
  assert.ok(cp.pop('dot1') !== null, '首个任务能领到');
  assert.equal(cp.queue.runningCount('dot1'), 1);

  submit(cp, '后台B', 5);
  assert.equal(cp.pop('dot1'), null, 'maxRunningTasks=1 且满额 → 必须返回 null（不改默认行为）');

  // 就算排队的是 interactive，默认配置下也不许突破额度
  submit(cp, '主人对话', 1);
  assert.equal(
    cp.pop('dot1'),
    null,
    '默认无预留时，interactive 也不得突破 maxRunningTasks（默认语义保持串行）',
  );
  void a;
});

test('③-b 默认值就是 1（静态守卫：防止有人把默认改成 >1）', () => {
  assert.equal(
    DEFAULT_CP_CONFIG.maxRunningTasks,
    1,
    'maxRunningTasks 默认必须保持 1；开并发要由装配层/环境变量显式声明',
  );
});

// ═══════════════════════════════════════════════════════════════════
// ① 对话不被后台饿死
// ═══════════════════════════════════════════════════════════════════

test('①-a 后台占满额度 → 提交 priority=1 的对话任务 → **1 次 pop 内**就被领到', () => {
  // 显式声明并发额度 2，并给 interactive 预留 1 格
  const cp = makeCp({ maxRunningTasks: 2, interactiveReserve: 1 });

  // 两个后台任务占满 2 个额度
  submit(cp, '后台A', 5);
  submit(cp, '后台B', 5);
  assert.ok(cp.pop('dot1') !== null);
  assert.ok(cp.pop('dot1') !== null);
  assert.equal(cp.queue.runningCount('dot1'), 2, '两个后台任务已占满额度');

  // 主人说话了
  const convo = submit(cp, '主人：今天天气怎么样', 1);

  // 关键断言：不需要等后台跑完，**下一次 pop 就轮到主人**
  const got = cp.pop('dot1');
  assert.ok(got !== null, '额度满时 interactive 任务必须仍能被领到（否则就是饿死）');
  assert.equal(got.id, convo, '领到的必须是那条 interactive 任务');
  assert.equal(
    cp.queue.runningCount('dot1'),
    3,
    'interactive 借用预留格进入（3 = 2 个后台 + 1 个对话），而不是把后台踢掉',
  );
});

test('①-b 预留格用完后，第二个对话任务**不会再**突破额度（预留是有界的，不会无限膨胀）', () => {
  const cp = makeCp({ maxRunningTasks: 2, interactiveReserve: 1 });
  submit(cp, '后台A', 5);
  submit(cp, '后台B', 5);
  cp.pop('dot1');
  cp.pop('dot1');

  submit(cp, '对话1', 1);
  assert.ok(cp.pop('dot1') !== null, '第一个对话任务用掉预留格');

  submit(cp, '对话2', 1);
  assert.equal(cp.pop('dot1'), null, '预留格已用完 → 必须排队（不能无限突破）');
});

test('①-c 无预留配置（interactiveReserve=0）时，interactive 仍能抢占**可抢占**的后台任务', () => {
  // maxRunningTasks=2，预留 0：靠"后台任务可被抢占"这条路径
  const cp = makeCp({ maxRunningTasks: 2, interactiveReserve: 0, preemptiblePriority: 5 });
  const bg1 = submit(cp, '后台A', 5);
  const bg2 = submit(cp, '后台B', 5);
  cp.pop('dot1');
  cp.pop('dot1');
  assert.equal(cp.queue.runningCount('dot1'), 2);

  const convo = submit(cp, '主人说话', 1);
  const got = cp.pop('dot1');
  assert.ok(got !== null, '应通过抢占后台任务腾出位置');
  assert.equal(got.id, convo, '领到的是对话任务');

  // 被抢占的后台任务回到 queued（不丢、不失败），并在稍后可被重新领走
  const running = cp
    .list({ status: ['running'] })
    .map((t) => t.id);
  const queued = cp.list({ status: ['queued'] }).map((t) => t.id);
  assert.equal(running.includes(convo), true, '对话任务在 running');
  const preempted = [bg1, bg2].filter((id) => queued.includes(id));
  assert.equal(preempted.length, 1, '恰好一个后台任务被抢占回 queued（另一个继续跑）');
  assert.equal(
    running.filter((id) => id === bg1 || id === bg2).length,
    1,
    '另一个后台任务仍在 running',
  );
});

test('①-d 抢占回队后的后台任务**保留 attempt，不计为失败**（不惩罚被抢占者）', () => {
  const cp = makeCp({ maxRunningTasks: 1, interactiveReserve: 0, preemptiblePriority: 5 });
  const bg = submit(cp, '后台任务', 5);
  cp.pop('dot1');
  const before = cp.getTask(bg)!;
  const attemptBefore = before.attempt;

  submit(cp, '主人说话', 1);
  const got = cp.pop('dot1');
  assert.ok(got !== null);

  const after = cp.getTask(bg)!;
  assert.equal(after.status, 'queued', '被抢占 → 回 queued');
  assert.equal(
    after.attempt,
    attemptBefore,
    'attempt 不得 +1：被抢占不是任务失败（+1 会让它更快耗尽重试次数）',
  );
  assert.equal(after.stopReason ?? null, null, '不得记 stop_reason（没失败）');
});

// ═══════════════════════════════════════════════════════════════════
// ② 并发不破坏幂等与围栏
// ═══════════════════════════════════════════════════════════════════

test('②-a 两条任务并发：各自 run_epoch 独立、journal 不交叉、call_id 全局唯一不串', () => {
  const cp = makeCp({ maxRunningTasks: 2 });
  const a = submit(cp, '任务A', 5);
  const b = submit(cp, '任务B', 5);

  const ra = cp.pop('dot1')!;
  const rb = cp.pop('dot1')!;
  assert.equal(ra.id, a);
  assert.equal(rb.id, b);
  assert.equal(ra.runEpoch, 1, 'A 的 epoch = 1');
  assert.equal(rb.runEpoch, 1, 'B 的 epoch 也是 1（各自独立计数，不是全局共享）');

  // 两条任务各自写 journal：call_id 必须是**全局唯一**的（steps.call_id 有唯一索引）
  const la = cp.journal.beginLlm(a, ra.runEpoch, 'digestA');
  const lb = cp.journal.beginLlm(b, rb.runEpoch, 'digestB');
  assert.notEqual(la.callId, lb.callId, '两条任务的 LLM 步 call_id 不得相同');

  const ta = cp.journal.beginTool(a, ra.runEpoch, 'fs.read', { path: '/dot/home/a' }, 'safe');
  const tb = cp.journal.beginTool(b, rb.runEpoch, 'fs.write', { path: '/dot/home/b' }, 'safe');
  assert.notEqual(ta.callId, tb.callId, '工具步 call_id 也不得相同');

  cp.journal.endTool(a, ra.runEpoch, ta.seq, 'succeeded', { n: 1 });
  cp.journal.endTool(b, rb.runEpoch, tb.seq, 'succeeded', { n: 2 });

  // journal 不交叉：A 只看到自己的两步，B 同理
  const ja = cp.getJournal(a)!;
  const jb = cp.getJournal(b)!;
  assert.equal(ja.length, 2, 'A 的 journal 只有自己的两步');
  assert.equal(jb.length, 2, 'B 的 journal 只有自己的两步');
  assert.ok(
    ja.every((s) => ja.some((x) => x.callId === s.callId)) && !ja.some((s) => s.callId === tb.callId),
    'A 的 journal 里不得出现 B 的 call_id',
  );
  assert.ok(!jb.some((s) => s.callId === ta.callId), 'B 的 journal 里不得出现 A 的 call_id');
});

test('②-b 围栏各自生效：用错 epoch 收口会被拒，且只影响自己那条', () => {
  const cp = makeCp({ maxRunningTasks: 2 });
  const a = submit(cp, '任务A', 5);
  const b = submit(cp, '任务B', 5);
  const ra = cp.pop('dot1')!;
  const rb = cp.pop('dot1')!;

  // A 用 B 的 epoch（两者都是 1，这里构造一个错误 epoch 验证围栏存在）
  cp.finish(a, ra.runEpoch + 99, { ok: true, summary: 'wrong epoch' });
  assert.equal(cp.getTask(a)!.status, 'running', 'epoch 不符 → 收口被围栏拒绝，A 仍在 running');

  // 正确 epoch 可以收口
  cp.finish(a, ra.runEpoch, { ok: true, summary: 'A done' });
  assert.equal(cp.getTask(a)!.status, 'done', '正确 epoch 收口生效');
  assert.equal(cp.getTask(b)!.status, 'running', 'B 不受 A 收口的影响');
  void rb;
});

test('②-c 心跳围栏独立：A 的迟到心跳不会刷新 B 的 last_heartbeat_at', () => {
  const cp = makeCp({ maxRunningTasks: 2 });
  const a = submit(cp, '任务A', 5);
  const b = submit(cp, '任务B', 5);
  const ra = cp.pop('dot1')!;
  cp.pop('dot1');

  const hbB = cp.getTask(b)!.lastHeartbeatAt;
  // 把 A 的心跳推进到很晚（注入时刻是"虚拟 now"，读回值仍受 fenceUpdate 的 now 约束，
  // 这里只断言"变新了"，不赌精确毫秒）
  cp.queue.heartbeat(a, ra.runEpoch, undefined, { live: { at: Number(hbB) + 999_999 } });
  assert.equal(cp.getTask(b)!.lastHeartbeatAt, hbB, 'B 的心跳不受 A 影响');
  assert.ok(
    Number(cp.getTask(a)!.lastHeartbeatAt) >= Number(hbB),
    'A 自己的心跳更新了（不早于 B 的旧值）',
  );
});

test('②-d 并发下看门狗只回收超时的那条，不误伤健康的另一条', () => {
  const cp = makeCp({ maxRunningTasks: 2 });
  const a = submit(cp, '任务A', 5);
  const b = submit(cp, '任务B', 5);
  cp.pop('dot1');
  cp.pop('dot1');

  const now = Date.now();
  // A 的心跳停在很久以前（卡死），B 心跳新鲜
  cp.db.prepare('UPDATE tasks SET last_heartbeat_at=? WHERE id=?').run(
    now - DEFAULT_CP_CONFIG.heartbeatTimeoutMs - 10_000,
    a,
  );
  cp.queue.heartbeat(b, cp.getTask(b)!.runEpoch, undefined, { live: { at: now } });
  cp.scheduler.watchdog(now);

  assert.equal(cp.getTask(a)!.status, 'queued', '卡死的 A 被回收');
  assert.equal(cp.getTask(b)!.status, 'running', '健康的 B 不受影响（并发下不误伤）');
});

// ═══════════════════════════════════════════════════════════════════
// 并发额度本身
// ═══════════════════════════════════════════════════════════════════

test('额度：maxRunningTasks=3 时最多 3 条 running，第 4 次 pop 返回 null', () => {
  const cp = makeCp({ maxRunningTasks: 3 });
  for (let i = 0; i < 4; i++) submit(cp, `任务${i}`, 5);
  assert.ok(cp.pop('dot1') !== null);
  assert.ok(cp.pop('dot1') !== null);
  assert.ok(cp.pop('dot1') !== null);
  assert.equal(cp.pop('dot1'), null, '第 4 次必须 null');
  assert.equal(cp.queue.runningCount('dot1'), 3);
});

// ═══════════════════════════════════════════════════════════════════
// 装配层：只有显式声明才生效（默认值纪律的装配侧证据）
// ═══════════════════════════════════════════════════════════════════

test('装配：不设任何环境变量 → cpConcurrencyFromEnv() 返回空对象（全走默认，行为不变）', async () => {
  const { cpConcurrencyFromEnv } = await import('../src/daemon.ts');
  const saved = { ...process.env };
  try {
    delete process.env.DOTD_MAX_RUNNING;
    delete process.env.DOTD_INTERACTIVE_RESERVE;
    delete process.env.DOTD_PREEMPTIBLE_PRIORITY;
    assert.deepEqual(cpConcurrencyFromEnv(), {}, '未声明 → 空对象 → 不覆盖任何默认值');
  } finally {
    process.env = saved;
  }
});

test('装配：显式声明才覆盖；非法值抛错拒启动（不静默回落）', async () => {
  const { cpConcurrencyFromEnv } = await import('../src/daemon.ts');
  const saved = { ...process.env };
  try {
    process.env.DOTD_MAX_RUNNING = '3';
    assert.equal(cpConcurrencyFromEnv().maxRunningTasks, 3);

    process.env.DOTD_MAX_RUNNING = '0';
    assert.throws(() => cpConcurrencyFromEnv(), /DOTD_MAX_RUNNING 非法/, '0 并发无意义，必须拒启动');

    process.env.DOTD_MAX_RUNNING = 'abc';
    assert.throws(() => cpConcurrencyFromEnv(), /DOTD_MAX_RUNNING 非法/, '非数字必须拒启动');

    process.env.DOTD_MAX_RUNNING = '2';
    process.env.DOTD_INTERACTIVE_RESERVE = '1';
    process.env.DOTD_PREEMPTIBLE_PRIORITY = '5';
    assert.deepEqual(cpConcurrencyFromEnv(), {
      maxRunningTasks: 2,
      interactiveReserve: 1,
      preemptiblePriority: 5,
    });
  } finally {
    process.env = saved;
  }
});

test('装配：daemon 装配确实把并发配置传给 createControlPlane（静态守卫）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/daemon.ts', import.meta.url)), 'utf8');
  assert.match(
    src,
    /createControlPlane\(\{[\s\S]*?concurrencyCfg/,
    'daemon 必须把并发配置接进 CP（否则环境变量设了也不生效）',
  );
  assert.match(src, /export function cpConcurrencyFromEnv/, '并发配置读取器必须存在且可测');
});

// ═══════════════════════════════════════════════════════════════════
// P1-1 附加：抢占后的 journal 对账（不把"抢占"变成"制造 unknowns"）
// ═══════════════════════════════════════════════════════════════════

test('抢占后对账：被抢占任务的 started 孤儿步会被 reconcileAndResolve 收口（不会遗留 started）', async () => {
  const cp = makeCp({ maxRunningTasks: 1, interactiveReserve: 0, preemptiblePriority: 5 });
  const bg = submit(cp, '后台长任务', 5);
  const run = cp.pop('dot1')!;

  // 后台任务留一个 started 的工具步（模拟"正在等工具返回"）
  const step = cp.journal.beginTool(bg, run.runEpoch, 'fs.read', { path: '/dot/home/a' }, 'safe');
  assert.equal(
    cp.getJournal(bg)!.find((s) => s.callId === step.callId)?.status,
    'started',
    '前置：工具步处于 started',
  );

  // 主人说话 → 触发抢占
  submit(cp, '主人：现在几点了', 1);
  const got = cp.pop('dot1');
  assert.ok(got !== null, '对话任务抢占成功');
  assert.equal(got.id !== bg, true);

  // 对账是 fire-and-forget（pop 在同步事务里），等它跑完
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));

  const after = cp.getJournal(bg)!.find((s) => s.callId === step.callId);
  assert.notEqual(
    after?.status,
    'started',
    '抢占后不得遗留 started 孤儿步（否则等价于"制造 unknowns"）',
  );
  assert.equal(after?.status, 'interrupted', 'safe 副作用步 → 标 interrupted，由重跑的 Runner 重新决策');
});
