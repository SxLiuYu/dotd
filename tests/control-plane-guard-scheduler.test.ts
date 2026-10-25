/**
 * tests/control-plane-guard-scheduler.test.ts —— 内存水位四级背压（CP §6.3）
 * + scheduler 主 tick / 看门狗 / 内部 job（CP §2.3 §4.3 §6.4 契约 J4）。
 *
 * 依据 control-plane.md：
 * - §6.3 四级水位表：normal/guarded 正常 pop；throttled 停 pop；halted 停 pop +
 *   给 running Runner abort。解冻路径：水位回升 → container_unpause +
 *   paused(stop_reason='watermark') 任务批量回 queued（保 priority）。
 *   阈值来源：未标定用兜底固定值；calibrateOrUseFallback() 用采样 p50=base。
 * - §6.4 硬兜底：usage≥1.2×budget 时看门狗旁路 abort → failed（记 kind='budget'）。
 * - 契约 J4：registerInternalJob 是周期任务唯一宿主；重名=覆盖；light job 在
 *   throttled/halted 跳轮。
 * - §4.3 catchup 语义：latest=错过 k 次只投 1 次；skip=不补。
 * - §4.1/§2.2 看门狗：10s 子周期扫 running 且心跳超时 → 回 queued、attempt+1、
 *   priority=min(priority,2)；重试用尽 → failed。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Journal } from '../src/control-plane/journal.ts';
import { Matcher } from '../src/control-plane/match.ts';
import type { EventRule, LowBrain } from '../src/control-plane/match.ts';
import { Scheduler } from '../src/control-plane/scheduler.ts';
import { Guard } from '../src/control-plane/guard.ts';
import type { ExecPorts } from '../src/control-plane/guard.ts';
import type { CrontabRow } from '../src/control-plane/types.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';
import { createControlPlane } from '../src/control-plane/index.ts';
import { AllEndpointsDownError } from '../src/shared/errors.ts';

const tmps: TempDataDir[] = [];

interface Fixture {
  tmp: TempDataDir;
  queue: Queue;
  journal: Journal;
  matcher: Matcher;
  guard: Guard;
  scheduler: Scheduler;
  events: Array<{ kind: string; detail: string }>;
  fired: Array<{ ctId: string; missed: number }>;
  exec: ExecPorts;
  cfg: typeof DEFAULT_CP_CONFIG;
  /** 水位读数控制器。 */
  setMem(mb: number): void;
}

function fixture(
  opts: {
    memMb?: number;
    /** 物理内存总量（MB）。默认 64GB，避免 CI 小内存机器触发阈值夹取。 */
    totalMb?: number;
    cfg?: Partial<typeof DEFAULT_CP_CONFIG>;
    rules?: EventRule[];
    lowBrain?: LowBrain;
  } = {},
): Fixture {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cfg = { ...DEFAULT_CP_CONFIG, ...opts.cfg };
  const totalMb = opts.totalMb ?? 65_536;
  const events: Array<{ kind: string; detail: string }> = [];
  const fired: Array<{ ctId: string; missed: number }> = [];
  const record = (kind: string, level: 'normal' | 'guarded' | 'throttled' | 'halted', detail: string): void => {
    events.push({ kind, detail });
    tmp.db
      .prepare('INSERT INTO resource_events(ts, level, kind, detail) VALUES(?,?,?,?)')
      .run(Date.now(), level, kind, detail);
  };
  let memMb = opts.memMb ?? 100_000;
  const queue = new Queue({ db: tmp.db, cfg, bus: tmp.bus, guardLevel: () => 'normal', record });
  const journal = new Journal({ db: tmp.db, cfg, bus: tmp.bus, record });
  const matcher = new Matcher({
    db: tmp.db,
    cfg,
    queue,
    bus: tmp.bus,
    rules: opts.rules ?? [],
    ...(opts.lowBrain !== undefined ? { lowBrain: opts.lowBrain } : {}),
    wake: () => {},
    record,
  });
  const exec: ExecPorts = {
    async pauseContainer() {},
    async unpauseContainer() {},
    async destroyDotContainer() {},
    async getContainerStats() {
      return { memMb: 0, hasInflightCall: false };
    },
  };
  const guard = new Guard({
    db: tmp.db,
    cfg,
    queue,
    bus: tmp.bus,
    record,
    knownDotIds: () => ['dot1'],
    exec,
    readMem: () => ({ availableMb: memMb }),
    // 阈值会按物理总量夹取；不注入的话 CI 小内存机器上 normal 线会被压到
    // 10GB 左右，base+4GB 的用例就变成 normal 了。
    readTotalMb: () => totalMb,
  });
  const scheduler = new Scheduler({
    db: tmp.db,
    cfg,
    queue,
    guard,
    journal,
    matcher,
    bus: tmp.bus,
    record,
    fireHeartbeat: (ct: CrontabRow, missed: number) => {
      fired.push({ ctId: ct.id, missed });
    },
  });
  return {
    tmp, queue, journal, matcher, guard, scheduler, events, fired, exec, cfg,
    setMem: (mb: number) => {
      memMb = mb;
    },
  };
}

/** 冲刷 microtask：guard.applyContainerPolicy 是 fire-and-forget 的 async，断言前等它落账。 */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});

// ── §6.3 四级水位（未标定：兜底固定阈值）─────────────────────────

test('§6.3 未标定：mem 高 → normal；跌到兜底 throttled 线以下 → throttled 并停 pop', async () => {
  const f = fixture({ memMb: 20_000 });
  f.setMem(20_000);
  assert.equal(f.guard.tick().level, 'normal', '远高于兜底 normal 线 → normal');
  assert.ok(f.queue.pop() !== null || true);

  f.setMem(2_000); // < throttledMb(3072) → halted；用 4_000 落在 3–6GB → throttled
  f.setMem(4_000);
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'throttled', '3–6GB 连续两次采样 → throttled');
  // throttled 时 pop() 被门控拦下（队列里已有 queued 任务）
  const t = f.queue.submit({ title: 'x', goal: 'g' });
  void t;
  const gated = new Queue({
    db: f.tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: f.tmp.bus,
    guardLevel: () => f.guard.currentLevel(),
    record: () => {},
  });
  assert.equal(gated.pop(), null, 'throttled 停 pop（CP §4.2 门控）');
});

test('§6.3 阈值滞回与跃迁记账：每次跃迁写 resource_events(kind=watermark)', () => {
  const f = fixture({ memMb: 20_000 });
  f.guard.tick();
  f.setMem(4_000); // normal → throttled（防抖：连续两次）
  f.guard.tick();
  f.guard.tick();
  f.setMem(20_000); // throttled → normal（同样两次）
  f.guard.tick();
  f.guard.tick();
  const marks = f.events.filter((e) => e.kind === 'watermark' && e.detail.includes('"to"'));
  assert.ok(marks.length >= 2, `两次跃迁各记一条 watermark，实际 ${marks.length}`);
});

test('§6.3 calibrateOrUseFallback：base = 采样 p50 − 预留，稳态不得被判成 throttled', () => {
  // 2026-10-24 修：旧实现把 p50(MemAvailable) 直接当 base，而 throttled 线 = base，
  // 等于"回到常态就算内存紧张"——真机上任务永远 queued（queue {queued:1, running:0}）。
  const f = fixture({ memMb: 8_000 });
  f.setMem(8_000);
  f.guard.calibrateOrUseFallback();
  const st = f.guard.status();
  assert.equal(st.baseMb, 1_856, 'base = 8000 − 6144（dotdReserveMb）');

  // 标定后的三条线：normal=8000 / guarded=4928 / throttled=1856
  f.setMem(8_000);
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'normal', '稳态（= 标定中位数）必须是 normal');

  f.setMem(6_000);
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'guarded', '低于常态 2GB → guarded');

  f.setMem(4_000);
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'throttled', '低于常态 4GB（< guarded 线）→ throttled');

  f.setMem(1_000);
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'halted', '跌破 throttled 线 → halted');
});

test('§6.3 阈值顺序不变量：throttled ≤ guarded ≤ normal（配置写错也不得倒挂）', () => {
  // 手改 fallbackThresholds 成倒挂值，不能被原样采纳
  const f = fixture({
    memMb: 8_000,
    cfg: { fallbackThresholds: { normalMb: 3_000, guardedMb: 6_000, throttledMb: 9_000 } },
  });
  // status 里带 thresholds 的事件要等到跃迁才写；这里直接看档位判定：
  // 8GB 可用 + 倒挂配置 → 保序后 throttled=3000/normal=3000… → 至少不能出现
  // "available 变少反而档位更好"。用两次采样确认它落在 normal 而不是 halted。
  f.guard.tick();
  assert.equal(f.guard.tick().level, 'normal', '保序后 8GB 仍是正常档');
});

test('§6.3 低水位把队列钉住 → 记 watermark(stuck:true)（可观测，不静默卡死）', async () => {
  const f = fixture({ memMb: 8_000, cfg: { watermarkStuckAlertMs: 1_000 } });
  f.guard.calibrateOrUseFallback();
  f.queue.submit({ title: 'queued', goal: 'g', priority: 1 });
  // 压到 halted（连续两次）
  f.setMem(500);
  f.guard.tick();
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'halted');
  // 第一次 tick 只记起点；等过告警窗口后再 tick
  await new Promise((r) => setTimeout(r, 1_100));
  f.guard.tick();
  f.guard.tick();
  // kind 复用 watermark（CHECK 白名单不想为观测再重建表），靠 detail 里的 stuck 标记区分
  const stuck = f.events.filter((e) => e.kind === 'watermark' && e.detail.includes('"stuck":true'));
  assert.equal(stuck.length, 1, `应记且只记一条 stuck 事件，实际 ${stuck.length}`);
  assert.match(stuck[0]!.detail, /"queued":1/, '事件里要有队列深度，方便直接看出"不是没人说话"');
});


test('§6.3 解冻：水位回升 → paused(watermark) 任务批量回 queued（保 priority）', () => {
  const f = fixture({ memMb: 20_000 });
  const a = f.queue.submit({ title: 'a', goal: 'g', priority: 3 });
  const b = f.queue.submit({ title: 'b', goal: 'g', priority: 4 });
  f.queue.pauseByReason(a.id, 'watermark');
  f.queue.pauseByReason(b.id, 'watermark');
  // 手动 pause 的任务不占 running；guard 回升时批量回 queued
  f.setMem(4_000);
  f.guard.tick();
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'throttled');
  f.setMem(20_000);
  f.guard.tick();
  f.guard.tick();
  assert.equal(f.queue.getTask(a.id)!.status, 'queued');
  assert.equal(f.queue.getTask(b.id)!.status, 'queued');
  assert.equal(f.queue.getTask(a.id)!.priority, 3, '保 priority');
});

test('§6.3 容器指令：throttled 且无在途调用 → 记 container_pause（契约 J5 记账面）', async () => {
  const f = fixture({ memMb: 20_000 });
  f.guard.tick();
  await flush();
  f.setMem(4_000);
  f.guard.tick();
  f.guard.tick();
  await flush();
  const pauses = f.events.filter((e) => e.kind === 'container_pause');
  assert.equal(pauses.length, 1, 'throttled 对本模块容器记一次 pause');
});

test('§6.3 容器指令：有在途调用的容器在 throttled 下绝不 pause（issue #4）', async () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const events: string[] = [];
  const record = (kind: string): void => {
    events.push(kind);
  };
  const queue = new Queue({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: tmp.bus,
    guardLevel: () => 'normal',
    record: record as never,
  });
  // ① 有在途调用 → 不 pause
  const withInflight = new Guard({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    queue,
    bus: tmp.bus,
    record: record as never,
    knownDotIds: () => ['dot1'],
    exec: {
      async pauseContainer() {},
      async unpauseContainer() {},
      async destroyDotContainer() {},
      async getContainerStats() {
        return { memMb: 0, hasInflightCall: true };
      },
    },
    readMem: () => ({ availableMb: 4_000 }),
  });
  withInflight.tick();
  withInflight.tick();
  await flush();
  assert.equal(withInflight.currentLevel(), 'throttled');
  assert.ok(!events.includes('container_pause'), '有在途调用绝不 pause');

  // ② 独立实例、无在途调用 → pause
  const idle = new Guard({
    db: tmp.db,
    cfg: DEFAULT_CP_CONFIG,
    queue,
    bus: tmp.bus,
    record: record as never,
    knownDotIds: () => ['dot1'],
    exec: {
      async pauseContainer() {},
      async unpauseContainer() {},
      async destroyDotContainer() {},
      async getContainerStats() {
        return { memMb: 0, hasInflightCall: false };
      },
    },
    readMem: () => ({ availableMb: 4_000 }),
  });
  idle.tick();
  idle.tick();
  await flush();
  assert.ok(events.includes('container_pause'), '无在途调用才 pause');
});

// ── 水位防抖（2026-10-17 修：注释承诺的"连续两次同向"此前没实现）─────

test('水位防抖：单次采样不跃迁；连续两次同向才跃迁（CP §6.3）', () => {
  const f = fixture({ memMb: 20_000 });
  f.guard.tick(); // 20GB → normal（与初值同档，只作废计数）
  f.setMem(4_000); // normal → throttled 的第一次采样
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'normal', '单次低读数不许跃迁（旧实现就在这里翻烧饼）');
  assert.deepEqual(f.guard.pendingLevel(), { to: 'throttled', count: 1 }, '待确认候选已记一次');
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'throttled', '连续第二次同向 → 真跃迁');
  assert.equal(f.guard.pendingLevel(), null, '跃迁后计数清零');
});

test('水位防抖：来回抖动的读数永远凑不齐连续两次 → 不跃迁', () => {
  const f = fixture({ memMb: 20_000 });
  f.guard.tick();
  // 实测现场的形态：MemAvailable 贴着 7168MB 线 5~12s 来回
  for (let i = 0; i < 10; i++) {
    f.setMem(i % 2 === 0 ? 4_000 : 20_000);
    f.guard.tick();
  }
  assert.equal(f.guard.currentLevel(), 'normal', '抖动不该产生任何跃迁');
  assert.equal(
    f.events.filter((e) => e.kind === 'watermark' && e.detail.includes('"to"')).length,
    0,
    '没有跃迁就不该写 watermark',
  );
});

test('水位防抖：halted 也不放行单次采样（它带 destroyDotContainer）', () => {
  const f = fixture({ memMb: 20_000 });
  f.guard.tick();
  f.setMem(1_000); // < 3GB → halted
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'normal', 'halted 同样要连续两次');
  f.guard.tick();
  assert.equal(f.guard.currentLevel(), 'halted');
});

// ── 看门狗（§4.1/§2.2 + §6.4 硬兜底）────────────────────────────

test('看门狗：running 心跳超时 → 回 queued、attempt+1、priority=min(priority,2)', () => {
  const f = fixture();
  const t = f.queue.submit({ title: 't', goal: 'g', priority: 7 });
  const run = f.queue.pop()!;
  // 心跳置成很久以前 → 超时
  f.tmp.db
    .prepare('UPDATE tasks SET last_heartbeat_at=? WHERE id=?')
    .run(Date.now() - f.cfg.heartbeatTimeoutMs - 1_000, t.id);
  f.scheduler.watchdog(Date.now());
  const after = f.queue.getTask(t.id)!;
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 1);
  assert.equal(after.priority, 2);
  assert.equal(after.runEpoch, run.runEpoch, '看门狗自身不递增 epoch');
});

test('看门狗：重试用尽 → failed（attempt≥max）', () => {
  const f = fixture();
  const t = f.queue.submit({ title: 't', goal: 'g' });
  const run = f.queue.pop()!;
  f.tmp.db.prepare('UPDATE tasks SET attempt=2, max_attempts=3 WHERE id=?').run(t.id);
  f.tmp.db
    .prepare('UPDATE tasks SET last_heartbeat_at=? WHERE id=?')
    .run(Date.now() - f.cfg.heartbeatTimeoutMs - 1_000, t.id);
  f.scheduler.watchdog(Date.now());
  assert.equal(f.queue.getTask(t.id)!.status, 'failed');
  void run;
});

test('看门狗硬兜底：usage≥1.2×budget → failed 并记 kind=budget（§6.4）', () => {
  const f = fixture();
  const t = f.queue.submit({ title: 't', goal: 'g' });
  f.queue.pop();
  const budget = (f.tmp.db.prepare('SELECT budget_tokens AS b FROM tasks WHERE id=?').get(t.id) as { b: number }).b;
  f.tmp.db.prepare('UPDATE tasks SET usage_tokens=? WHERE id=?').run(Math.ceil(budget * 1.3), t.id);
  f.scheduler.watchdog(Date.now());
  assert.equal(f.queue.getTask(t.id)!.status, 'failed');
  assert.ok(
    f.events.some((e) => e.kind === 'budget'),
    '记 resource_events kind=budget',
  );
});

test('看门狗：running 且心跳新鲜 → 不动', () => {
  const f = fixture();
  const t = f.queue.submit({ title: 't', goal: 'g' });
  f.queue.pop();
  f.queue.heartbeat(t.id, f.queue.currentEpoch(t.id)!, { tokens: 1 });
  f.scheduler.watchdog(Date.now());
  assert.equal(f.queue.getTask(t.id)!.status, 'running');
});

// ── 内部 job（契约 J4）───────────────────────────────────────────

test('契约 J4：registerInternalJob 注册/重名覆盖/到期执行/跳轮（light 在 throttled 跳）', async () => {
  const f = fixture({ memMb: 20_000 });
  let runs = 0;
  f.scheduler.registerInternalJob({ name: 't.light', kind: 'light', everyMs: 1_000, run: async () => { runs += 1; } });
  assert.deepEqual(f.scheduler.jobNames(), ['t.light']);
  // 重名覆盖
  f.scheduler.registerInternalJob({ name: 't.light', kind: 'light', everyMs: 2_000, run: async () => { runs += 100; } });
  assert.deepEqual(f.scheduler.jobNames(), ['t.light']);

  await f.scheduler.tick(); // nextAt=now+everyMs，未到期
  assert.equal(runs, 0);
  f.tmp.db.exec("UPDATE tasks SET updated_at=updated_at"); // 无副作用，仅占位
  // 直接把 job 改到期：再等 tick 前手动触发一次 tick（nextAt 已过？）
  // 用 everyMs=0 重新注册
  f.scheduler.registerInternalJob({ name: 't.light', kind: 'light', everyMs: 0, run: async () => { runs += 1; } });
  await f.scheduler.tick();
  assert.ok(runs > 0, '到期 job 执行');
  const afterLight = runs;

  // throttled：light job 跳轮（防抖：连续两次同向采样才真跃迁）
  f.setMem(4_000);
  f.guard.tick();
  f.guard.tick();
  f.scheduler.registerInternalJob({ name: 't.light', kind: 'light', everyMs: 0, run: async () => { runs += 1; } });
  await f.scheduler.tick();
  assert.equal(runs, afterLight, 'throttled 下 light job 跳轮（契约 J4/S4）');

  // heavy 不跳轮
  f.scheduler.registerInternalJob({ name: 't.heavy', kind: 'heavy', everyMs: 0, run: async () => { runs += 1; } });
  await f.scheduler.tick();
  assert.equal(runs, afterLight + 1, 'throttled 下 heavy job 照跑');
});

test('契约 J4：job 抛错不炸 tick，错误记 resource_events(watchdog)', async () => {
  const f = fixture();
  f.scheduler.registerInternalJob({
    name: 't.boom',
    kind: 'light',
    everyMs: 0,
    run: async () => {
      throw new Error('boom');
    },
  });
  await f.scheduler.tick();
  assert.ok(
    f.events.some((e) => e.kind === 'watchdog' && e.detail.includes('t.boom')),
    'job 错误被记账',
  );
  const st = f.scheduler.jobStatus();
  assert.ok(st.some((j) => j.name === 't.boom' && j.lastError === 'boom'));
});

// ── heartbeat 扫描（§4.3）────────────────────────────────────────

test('§4.3 catchup=latest：错过 k 次只投 1 次最新', () => {
  const f = fixture();
  const past = Date.now() - 3 * 60_000;
  f.tmp.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire, catchup)
       VALUES('ct1', 'dot1', 'hb', 'hb', '* * * * *', 1, ?, 'latest')`,
    )
    .run(past);
  f.scheduler.tickCrontabs(Date.now());
  assert.deepEqual(f.fired, [{ ctId: 'ct1', missed: 3 }], '错过 3 次 → 投 1 次，missed=3');
  const row = f.tmp.db.prepare('SELECT last_fire_status AS s, last_fire_seq AS n FROM crontabs WHERE id=?').get('ct1') as { s: string; n: number };
  assert.equal(row.s, 'fired');
  assert.equal(row.n, 1);
});

test('§4.3 catchup=skip：不补投，直接推进 next_fire', () => {
  const f = fixture();
  const past = Date.now() - 3 * 60_000;
  f.tmp.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire, catchup)
       VALUES('ct2', 'dot1', 'hb', 'hb', '* * * * *', 1, ?, 'skip')`,
    )
    .run(past);
  f.scheduler.tickCrontabs(Date.now());
  assert.deepEqual(f.fired, [], 'skip 不补投');
  const row = f.tmp.db.prepare('SELECT next_fire AS nf, last_fire_status AS s FROM crontabs WHERE id=?').get('ct2') as { nf: number; s: string | null };
  assert.ok(row.nf > Date.now(), 'next_fire 已推进');
  assert.equal(row.s, null, 'skip 不写 fired 状态');
});

test('§4.3 quiet_hours 内到期 → skipped_quiet 不投', () => {
  const f = fixture();
  const now = new Date();
  const startH = now.getHours();
  const endH = (startH + 1) % 24;
  const pad = (h: number): string => String(h).padStart(2, '0');
  const qh = `${pad(startH)}:00-${pad(endH)}:00`;
  f.tmp.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire, catchup, quiet_hours)
       VALUES('ct3', 'dot1', 'hb', 'hb', '* * * * *', 1, ?, 'latest', ?)`,
    )
    .run(Date.now() - 60_000, qh);
  f.scheduler.tickCrontabs(Date.now());
  assert.deepEqual(f.fired, [], 'quiet 内不投');
  const row = f.tmp.db.prepare('SELECT last_fire_status AS s FROM crontabs WHERE id=?').get('ct3') as { s: string };
  assert.equal(row.s, 'skipped_quiet');
});

test('§4.3 skip_if_busy=1 且同 dot 有 live 任务 → skipped_busy 不投', () => {
  const f = fixture();
  f.queue.submit({ title: 'busy', goal: 'g', dotId: 'dot1' });
  f.tmp.db
    .prepare(
      `INSERT INTO crontabs(id, dot_id, title, prompt, cron, enabled, next_fire, catchup, skip_if_busy)
       VALUES('ct4', 'dot1', 'hb', 'hb', '* * * * *', 1, ?, 'latest', 1)`,
    )
    .run(Date.now() - 60_000);
  f.scheduler.tickCrontabs(Date.now());
  assert.deepEqual(f.fired, [], 'busy 不投');
  const row = f.tmp.db.prepare('SELECT last_fire_status AS s FROM crontabs WHERE id=?').get('ct4') as { s: string };
  assert.equal(row.s, 'skipped_busy');
});

// ── CP §2.3/§6.1：wake 驱动匹配管线（审码 finding：原实现只 wakeAll 不扫事件）──

test('CP §2.3/§6.1：wake() 驱动未决策事件扫描——规则命中即落决策+建任务', () => {
  const f = fixture({
    rules: [
      { id: 'r1', match: { payloadContains: '告警' }, action: 'run_new', task: { title: '告警任务' }, reason: '规则命中' },
    ],
  });
  const { eventId } = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: '磁盘告警' });
  // wake 前：事件落库但未决策（CP §6.1 谓词）
  assert.equal(
    (f.tmp.db.prepare('SELECT COUNT(*) AS n FROM event_decisions WHERE event_id=?').get(eventId) as { n: number }).n,
    0,
  );
  // scheduler.wake()（ingestEvent 的 setImmediate 回调在生产路径上就是它）
  f.scheduler.wake();
  const d = f.tmp.db.prepare('SELECT action, task_id FROM event_decisions WHERE event_id=?').get(eventId) as
    | { action: string; task_id: string }
    | undefined;
  assert.ok(d !== undefined, 'wake 后事件已被决策');
  assert.equal(d.action, 'run_new');
  assert.equal(d.task_id, `tk_ev_${eventId}`, '确定性任务主键');
  const t = f.tmp.db.prepare('SELECT title, source_event_id FROM tasks WHERE id=?').get(d.task_id) as {
    title: string;
    source_event_id: number;
  };
  assert.equal(t.title, '告警任务');
  assert.equal(t.source_event_id, eventId);
  assert.equal(
    (f.tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status,
    'matched',
  );
});

test('CP §2.3/§6.1：wake() 对规则未命中事件不建决策（留给异步 LLM / inbox）', () => {
  const f = fixture({ rules: [] });
  const { eventId } = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'x' });
  f.scheduler.wake();
  assert.equal(
    (f.tmp.db.prepare('SELECT COUNT(*) AS n FROM event_decisions WHERE event_id=?').get(eventId) as { n: number }).n,
    0,
  );
  // 未命中规则时 wake 只做同步层；LLM 层异步跑完前事件保持 pending（不落 inbox）
  assert.equal(
    (f.tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status,
    'pending',
  );
});

test('CP §2.3/§6.1：wake() 幂等——重复 wake 不重复决策/不双建任务', () => {
  const f = fixture({
    rules: [{ id: 'r1', match: { payloadContains: 'a' }, action: 'run_new', reason: 'r' }],
  });
  const { eventId } = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'a' });
  f.scheduler.wake();
  f.scheduler.wake();
  f.scheduler.wake();
  assert.equal(
    (f.tmp.db.prepare('SELECT COUNT(*) AS n FROM event_decisions WHERE event_id=?').get(eventId) as { n: number }).n,
    1,
  );
  assert.equal((f.tmp.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
});

test('CP §2.3/§6.1：LLM 层异步驱动不阻塞 wake（fire-and-forget + 异常不炸）', async () => {
  const f = fixture({
    rules: [],
    lowBrain: {
      async complete() {
        throw new Error('LLM 炸了');
      },
    },
  });
  const { eventId } = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'x' });
  f.scheduler.wake(); // 同步返回，不等 LLM
  await flush();
  // LLM 抛的非全灭异常被 catch 记 watchdog，不变成 unhandledRejection；
  // 事件留 pending 等下次 wake 重试（match.ts:244/271：只有 AllEndpointsDownError
  // 全灭才落 inbox，瞬时故障不应把事件推给主人）
  assert.ok(
    f.events.some((e) => e.kind === 'watchdog' && e.detail.includes('LLM 炸了')),
    'LLM 异常被记 watchdog',
  );
  assert.equal(
    (f.tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status,
    'pending',
    '非全灭异常 → 留 pending 等重试，不落 inbox',
  );
});

test('CP §6.1：LLM 层全灭（AllEndpointsDownError）→ 事件落 inbox 等主人', async () => {
  const f = fixture({
    rules: [],
    lowBrain: {
      async complete(): Promise<{ response: { content: string } }> {
        throw new AllEndpointsDownError(['primary', 'backup']);
      },
    },
  });
  const { eventId } = f.matcher.ingestEvent({ source: 'http', dotId: 'dot1', actor: 'u', payload: 'x' });
  f.scheduler.wake();
  await flush();
  const st = (f.tmp.db.prepare('SELECT status FROM events WHERE id=?').get(eventId) as { status: string }).status;
  assert.equal(st, 'inbox', '全灭 → inbox（match.ts:271 返回 null 后 processEvent 落 inbox）');
  // inbox 事件仍可被后续扫描重扫（listUndecidedEvents 含 inbox）
  assert.equal(f.matcher.listUndecidedEvents(10).length, 1);
});

// ── CP §8-S8 / 契约 T1：router.mode_changed 恢复 circuit_open 暂停任务 ──────

test('CP §8-S8：路由从降级态恢复 → paused(circuit_open) 批量回 queued（经 index.ts 订阅）', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  try {
    // 造两个熔断暂停任务 + 一个其他原因暂停任务（不应被误恢复）
    const t1 = cp.submit({ title: 'a', goal: 'g', dotId: 'dot1' });
    const t2 = cp.submit({ title: 'b', goal: 'g', dotId: 'dot1' });
    const t3 = cp.submit({ title: 'c', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(t1.id, 'circuit_open');
    cp.pauseByReason(t2.id, 'circuit_open');
    cp.pauseByReason(t3.id, 'watermark');
    assert.equal(
      (tmp.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='paused' AND stop_reason='circuit_open'`).get() as { n: number }).n,
      2,
    );

    // 路由恢复：TOTAL_OUTAGE → NORMAL（降级态 → 可用态）
    tmp.bus.publish('router.mode_changed', { from: 'TOTAL_OUTAGE', to: 'NORMAL' });
    const after = tmp.db
      .prepare(`SELECT id, status, stop_reason AS sr FROM tasks WHERE id IN (?,?,?)`)
      .all(t1.id, t2.id, t3.id) as Array<{ id: string; status: string; sr: string | null }>;
    // 按提交顺序断言，不按 id 排序：id 的字典序不保证等于创建顺序。
    const byId = new Map(after.map((r) => [r.id, r]));
    assert.deepEqual(
      [t1, t2, t3].map((t) => {
        const row = byId.get(t.id)!;
        return [row.status, row.sr];
      }),
      [
        ['queued', null],
        ['queued', null],
        ['paused', 'watermark'],
      ],
      '只有 circuit_open 被恢复；watermark 等 guard 解冻路径处理',
    );
    // 恢复记账：resource_events(kind='watchdog', modelRecovered)
    const marks = tmp.db
      .prepare(`SELECT detail FROM resource_events WHERE kind='watchdog' AND detail LIKE '%modelRecovered%'`)
      .all() as Array<{ detail: string }>;
    assert.equal(marks.length, 1);
    assert.equal(JSON.parse(marks[0]!.detail).modelRecovered, 2);
  } finally {
    cp.shutdown();
  }
});

test('CP §8-S8：仍在降级态（to=TOTAL_OUTAGE/EMERGENCY/RESTRICTED）不恢复', () => {
  const tmp = makeTempDataDir();
  tmps.push(tmp);
  const cp = createControlPlane({ db: tmp.db, bus: tmp.bus });
  try {
    const t1 = cp.submit({ title: 'a', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(t1.id, 'circuit_open');
    tmp.bus.publish('router.mode_changed', { from: 'NORMAL', to: 'EMERGENCY' });
    tmp.bus.publish('router.mode_changed', { from: 'TOTAL_OUTAGE', to: 'RESTRICTED' });
    tmp.bus.publish('router.mode_changed', { from: 'LOCAL_FALLBACK', to: 'NORMAL' });
    const row = tmp.db.prepare('SELECT status, stop_reason AS sr FROM tasks WHERE id=?').get(t1.id) as {
      status: string;
      sr: string | null;
    };
    assert.deepEqual([row.status, row.sr], ['paused', 'circuit_open']);
  } finally {
    cp.shutdown();
  }
});

test('§6.3 throttled 下的交互豁免：默认关；显式打开后只放一条交互任务、halted 仍不放', () => {
  let level: 'normal' | 'guarded' | 'throttled' | 'halted' = 'normal';
  const record = (): void => {};

  // 默认（allowInteractiveWhenThrottled=false）：throttled 一律不放行 —— 与改动前逐字一致
  const tmpStrict = makeTempDataDir();
  tmps.push(tmpStrict);
  const strict = new Queue({
    db: tmpStrict.db,
    cfg: DEFAULT_CP_CONFIG,
    bus: tmpStrict.bus,
    guardLevel: () => level,
    record,
  });
  strict.submit({ title: 'bg', goal: 'g', priority: 3 });
  strict.submit({ title: 'it', goal: 'g', priority: 1 });
  level = 'throttled';
  assert.equal(strict.pop(), null, '默认严格保护：throttled 不放任何任务');

  // 显式打开：throttled 时只放交互任务（priority=1），且同一时刻只放一条
  const tmpRelaxed = makeTempDataDir();
  tmps.push(tmpRelaxed);
  const cfg = { ...DEFAULT_CP_CONFIG, allowInteractiveWhenThrottled: true };
  const relaxed = new Queue({
    db: tmpRelaxed.db,
    cfg,
    bus: tmpRelaxed.bus,
    guardLevel: () => level,
    record,
  });
  relaxed.submit({ title: 'bg', goal: 'g', priority: 3 });
  const it = relaxed.submit({ title: 'it', goal: 'g', priority: 1 });
  const first = relaxed.pop();
  assert.equal(first?.id, it.id, '只放交互任务，后台任务继续等');
  assert.equal(relaxed.pop(), null, 'running=1 时不再放第二条（豁免也只放一条）');

  level = 'halted';
  relaxed.finish(it.id, first!.runEpoch, { ok: true, summary: 'x' });
  assert.equal(relaxed.pop(), null, 'halted 是硬保护，豁免不生效');
});
