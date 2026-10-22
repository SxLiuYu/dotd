/**
 * tests/exec-container-concurrency.test.ts —— P1-1 容器内工具并发闸。
 *
 * ## 为什么需要它
 * `maxRunningTasks > 1` 一旦开启，同一容器就会同时跑多个工具，而 `runTool()` 里
 * **没有任何闸**。真实后果都表现为"工具莫名失败"：
 *   - `browser.*` 撞 Playwright 的页面/上下文上限；
 *   - `shell.run` 抢 CPU，把本来的秒级命令拖到超时。
 *
 * ## 分档口径（Lead 批准）
 *   - `browser.*`：每容器 in-flight **1**；
 *   - `shell.run` ：每容器 **2**；
 *   - `fs.*`     ：**不限**。
 * 超限**排队**、超时降级报 `container_busy`（可重试），**绝不**直接拒。
 *
 * ## 默认值纪律（头号断言）
 * 上限**只在 `maxRunningTasks > 1` 时才有意义**：默认 `maxRunningTasks=1` 时
 * Runner 一次只派发一个工具，闸永远不该触发——行为与今天逐字一致。
 *
 * ## 测试策略
 * 直接测 `containerJailLane`（分档映射）+ `ContainerJail` 的排队语义（导出供测试），
 * 再用**真 runTool** 证明确实挂进了生产路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { ExecServiceImpl, ContainerJail, containerJailLane } from '../src/exec/ExecService.ts';
import { DEFAULT_EXEC_CONFIG } from '../src/exec/types.ts';

const tmps: TempDataDir[] = [];
test.afterEach(() => {
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

// ═══════════════════════════════════════════════════════════════════
// 分档映射
// ═══════════════════════════════════════════════════════════════════

test('分档：browser.* → browser 档；shell.run → shell 档；fs.* / net.* → 不设闸', () => {
  assert.equal(containerJailLane('browser.open'), 'browser');
  assert.equal(containerJailLane('browser.act'), 'browser');
  assert.equal(containerJailLane('browser.snapshot'), 'browser');
  assert.equal(containerJailLane('browser.close'), 'browser');
  assert.equal(containerJailLane('shell.run'), 'shell');
  assert.equal(containerJailLane('fs.read'), null, 'fs.* 本地快操作，不限');
  assert.equal(containerJailLane('fs.write'), null);
  assert.equal(containerJailLane('fs.list'), null);
  assert.equal(containerJailLane('net.get'), null, 'net.* 不在本次分档内（保持不限）');
});

// ═══════════════════════════════════════════════════════════════════
// 头号断言：默认值 = 全不限 = 与今天逐字一致
// ═══════════════════════════════════════════════════════════════════

test('默认值：DEFAULT_EXEC_CONFIG.containerJail 全为 0（不限）——闸永不触发', () => {
  const jail = DEFAULT_EXEC_CONFIG.containerJail;
  assert.ok(jail !== undefined, 'containerJail 默认值必须存在');
  assert.equal(jail.browser, 0, '默认不限 browser（若配成 1 就改变了默认行为）');
  assert.equal(jail.shell, 0, '默认不限 shell');
  assert.equal(jail.fs, 0, '默认不限 fs');
  assert.equal(jail.queueMs, 0, '默认不排队（不引入任何等待）');
});

test('默认值：容量 0 时 acquire 立即返回许可，第二个调用不会被拦', async () => {
  const jail = new ContainerJail({ browser: 0, shell: 0, fs: 0, queueMs: 0 });
  const a = await jail.acquire('dot1', 'browser');
  const b = await jail.acquire('dot1', 'browser');
  assert.ok(a !== null && b !== null, '不限时两个都立即拿到');
  a!.release();
  b!.release();
});

// ═══════════════════════════════════════════════════════════════════
// 排队语义（确定性：受控 promise / 小延时，不依赖墙钟量级）
// ═══════════════════════════════════════════════════════════════════

test('browser 档 = 1：第二个 acquire 必须排队，第一个 release 后才放行', async () => {
  const jail = new ContainerJail({ browser: 1, shell: 0, fs: 0, queueMs: 5000 });
  const first = await jail.acquire('dot1', 'browser');
  assert.ok(first !== null);

  let secondDone = false;
  const secondP = jail.acquire('dot1', 'browser').then((l) => {
    secondDone = true;
    return l;
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(secondDone, false, 'browser 闸=1：第二个必须排队，不能立刻拿到');

  first!.release();
  const second = await secondP;
  assert.ok(second !== null, '第一个释放后，第二个拿到许可（排队后成功，不是失败）');
  second!.release();
});

test('shell 档 = 2：前两个可并跑，第三个排队', async () => {
  const jail = new ContainerJail({ browser: 0, shell: 2, fs: 0, queueMs: 5000 });
  const a = await jail.acquire('dot1', 'shell');
  const b = await jail.acquire('dot1', 'shell');
  assert.ok(a !== null && b !== null, '前两个立即拿到');

  let thirdDone = false;
  const thirdP = jail.acquire('dot1', 'shell').then((l) => {
    thirdDone = true;
    return l;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(thirdDone, false, '第三个必须排队');

  a!.release();
  const third = await thirdP;
  assert.ok(third !== null, '释放一个后第三个拿到');
  b!.release();
  third!.release();
});

test('按容器分账：dot1 的 browser 闸满不影响 dot2', async () => {
  const jail = new ContainerJail({ browser: 1, shell: 0, fs: 0, queueMs: 5000 });
  const d1 = await jail.acquire('dot1', 'browser');
  assert.ok(d1 !== null);
  const d2 = await jail.acquire('dot2', 'browser');
  assert.ok(d2 !== null, '不同容器各自计数，互不影响');
  d1!.release();
  d2!.release();
});

test('按档位分账：browser 满不影响 shell', async () => {
  const jail = new ContainerJail({ browser: 1, shell: 2, fs: 0, queueMs: 5000 });
  const b1 = await jail.acquire('dot1', 'browser');
  assert.ok(b1 !== null);
  const s1 = await jail.acquire('dot1', 'shell');
  assert.ok(s1 !== null, 'browser 满额不阻塞 shell（分档独立计数）');
  b1!.release();
  s1!.release();
});

test('排队超时 → 返回 null（调用方降级为 container_busy，不是挂死）', async () => {
  const jail = new ContainerJail({ browser: 1, shell: 0, fs: 0, queueMs: 60 });
  const first = await jail.acquire('dot1', 'browser');
  assert.ok(first !== null);

  const started = Date.now();
  const timedOut = await jail.acquire('dot1', 'browser');
  const elapsed = Date.now() - started;
  assert.equal(timedOut, null, '排队超时必须返回 null（不挂死）');
  assert.ok(elapsed >= 50, `应等满 queueMs，实际 ${elapsed}ms`);

  first!.release();
});

test('释放后名额归还：连续 acquire/release 50 轮不泄漏', async () => {
  const jail = new ContainerJail({ browser: 1, shell: 0, fs: 0, queueMs: 1000 });
  for (let i = 0; i < 50; i++) {
    const l = await jail.acquire('dot1', 'browser');
    assert.ok(l !== null, `第 ${i} 轮应能拿到许可（泄漏会在这里挂住）`);
    l!.release();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 生产路径：真 runTool 上确实生效
// ═══════════════════════════════════════════════════════════════════

test('生产路径：配了 browser 闸后，真 ExecService 的第二个 browser 调用排队、不报错', async () => {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);

  // 粘门（2026-10-22 修死锁）：pollJob 每 pollIntervalMs 调一次 getJob，
  // 而 getJob 每次都 push 一个新 resolver 并等它 —— 原来的"每次调用一个门"
  // 跟轮询语义天然冲突：gates.splice(0) 只放行当刻排队的那些，2ms 后下一轮
  // 又 push 一个**永远不会被放行**的门，await p1 死等在那里
  // （实测 'Promise resolution is still pending but the event loop has already resolved'）。
  // 改成粘的：放行之后，后续 getJob 立刻返回，测试想验证的时序不变。
  const gates: Array<() => void> = [];
  let released = false;
  const started: string[] = [];
  const runtime = {
    async startJob(_e: string, _t: string, c: { call_id: string }) {
      started.push(c.call_id);
      return { job_id: `job_${c.call_id}` };
    },
    async getJob(_e: string, _t: string, jobId: string) {
      const id = jobId.replace(/^job_/, '');
      if (!released) await new Promise<void>((r) => gates.push(r));
      return { call_id: id, job_id: jobId, status: 'ok', result: {} };
    },
    async cancelJob() {},
    async health() {
      return { ok: true };
    },
    async capabilities() {
      return [];
    },
    async getCall() {
      return null;
    },
    async confirmCall() {
      return true;
    },
    async compactLedger() {
      return [];
    },
  };

  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: {
      tokenDir: tmp.root,
      pollIntervalMs: 2,
      containerJail: { browser: 1, shell: 0, fs: 0, queueMs: 5000 },
    },
    runtime: runtime as never,
  });
  await exec.boot(['dot1']);

  const mk = (id: string) => ({
    call_id: id,
    task_id: 't1',
    dot_id: 'dot1',
    tool: 'browser.open' as never,
    args: { url: 'https://x' },
    deadline_ms: 30_000,
    issued_at: new Date().toISOString(),
  });

  const p1 = exec.runTool(mk('b1'));
  for (let i = 0; i < 400 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ['b1'], 'b1 已进入容器');

  const p2 = exec.runTool(mk('b2'));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(started, ['b1'], 'browser 闸=1：b2 必须排队，不能同时进容器');

  released = true;
  gates.splice(0).forEach((f) => f());
  const r1 = await p1;
  assert.equal(r1.status, 'ok', 'b1 正常成功');

  for (let i = 0; i < 400 && started.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ['b1', 'b2'], 'b1 结束后 b2 才进入（依次放行）');

  released = true;
  gates.splice(0).forEach((f) => f());
  const r2 = await p2;
  assert.equal(r2.status, 'ok', 'b2 排队后成功，不是失败');
});
