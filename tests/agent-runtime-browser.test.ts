/**
 * tests/agent-runtime-browser.test.ts —— BrowserHolder + Xvfb + 派发逻辑（全部打桩）。
 *
 * 隔离策略（本任务要求）：浏览器依赖全部收敛在 `ChromiumFactory` 一个接口后，
 * 这里注入**进程内假工厂**（不起真 chromium、不需要 playwright、不需要 Xvfb 二进制），
 * 因此容器外 `node --test` 能跑完整的状态机断言。
 *
 * 覆盖（execution.md §6.1/6.2/6.3 + 契约 G1）：
 * 1. 持久身份 → launchPersistentContext(userDataDir=/dot/profiles/<hash>)
 * 2. 'anon'/null → ephemeral（不入台账，共享 browser.newContext）
 * 3. MAX_CONTEXTS=2 → LRU 驱逐（busy 的不动）
 * 4. 内存高水位 80% → hardReset('mem_highwater')
 * 5. context 存活 >30min 且非 busy → reapAged 回收
 * 6. in-flight 计数 = busy 判据
 * 7. Xvfb：ready/crashed 事件、不自行重开（视同 runtime 崩溃）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserHolder,
  CONTEXT_MAX_AGE_MS,
  HIGH_WATER_RATIO,
  MAX_CONTEXTS,
  MAX_PAGES_PER_CTX,
  PROFILES_ROOT,
  identityHash,
  isPersistentIdentity,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserPage,
  type ChromiumFactory,
} from '../agent-runtime/browser.ts';
import { XvfbManager, XVFB_DISPLAY, type XvfbSpawn } from '../agent-runtime/xvhfd.ts';

// ── 假浏览器面（进程内，零外部依赖）──────────────────────────────────

class FakePage implements BrowserPage {
  url_ = 'about:blank';
  title_ = '';
  gotoCalls: string[] = [];
  constructor(private readonly ctx: FakeCtx) {}
  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
    this.url_ = url;
    this.title_ = `title(${url})`;
  }
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async press(): Promise<void> {}
  async selectOption(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  async scroll(): Promise<void> {}
  async title(): Promise<string> {
    return this.title_;
  }
  url(): string {
    return this.url_;
  }
  async snapshot(): Promise<{ text: string; html?: string }> {
    return { text: `snap:${this.url_}` };
  }
  async close(): Promise<void> {
    this.ctx.openPages.delete(this);
  }
}

class FakeCtx implements BrowserContextLike {
  readonly openPages = new Set<FakePage>();
  closed = false;
  constructor(readonly kind: 'persistent' | 'ephemeral') {}
  async pages(): Promise<BrowserPage[]> {
    return [...this.openPages];
  }
  async newPage(): Promise<BrowserPage> {
    const p = new FakePage(this);
    this.openPages.add(p);
    return p;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser implements BrowserLike {
  connected = true;
  readonly contexts: FakeCtx[] = [];
  async newContext(): Promise<BrowserContextLike> {
    const c = new FakeCtx('ephemeral');
    this.contexts.push(c);
    return c;
  }
  async close(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
}

interface FakeFactoryLog {
  persistent: string[];
  ephemeral: number;
}

function makeFakeFactory(): { factory: ChromiumFactory; log: FakeFactoryLog } {
  const log: FakeFactoryLog = { persistent: [], ephemeral: 0 };
  const shared = new FakeBrowser();
  return {
    log,
    factory: {
      async launchPersistentContext(userDataDir: string): Promise<BrowserContextLike> {
        log.persistent.push(userDataDir);
        return new FakeCtx('persistent');
      },
      async launch(): Promise<BrowserLike> {
        log.ephemeral += 1;
        return shared;
      },
    },
  };
}

// ── 1. 持久身份 ──────────────────────────────────────────────────────

test('browser: 持久身份走 launchPersistentContext，目录名 = identityHash', async () => {
  const { factory, log } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('alice');
  assert.deepEqual(log.persistent, [`${PROFILES_ROOT}/${identityHash('alice')}`]);
  assert.equal(log.ephemeral, 0);
  assert.equal(h.stats().contexts, 1);

  // 复用：第二次 acquire 同一身份不再 launch
  await h.acquire('alice');
  assert.equal(log.persistent.length, 1);
  assert.equal(h.stats().contexts, 1);
});

test('browser: identityHash 稳定且取 sha256 前 16 位', () => {
  const a = identityHash('alice');
  assert.equal(a, identityHash('alice'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, identityHash('bob'));
});

test('browser: anon/null 走 ephemeral，且不落 persistent 台账', async () => {
  const { factory, log } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('anon');
  await h.acquire(null);
  await h.acquire(undefined);
  assert.deepEqual(log.persistent, []);
  assert.equal(log.ephemeral, 1, 'ephemeral 共享同一个 chromium 进程');
  assert.equal(h.stats().contexts, 1, 'anon/null/undefined 共用 ephemeral 槽位');
  assert.equal(isPersistentIdentity('anon'), false);
  assert.equal(isPersistentIdentity(null), false);
  assert.equal(isPersistentIdentity('alice'), true);
});

// ── 2. MAX_CONTEXTS / LRU ────────────────────────────────────────────

test('browser: MAX_CONTEXTS=2 满员后 LRU 驱逐最久未用', async () => {
  const { factory, log } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('a');
  await h.acquire('b');
  assert.equal(h.stats().contexts, 2);
  assert.equal(log.persistent.length, 2);

  // 再开第三个：最久未用的 'a' 被驱逐
  await h.acquire('c');
  assert.equal(h.stats().contexts, 2);
  assert.deepEqual(log.persistent.map((p) => p.slice(-16)), [
    identityHash('a'),
    identityHash('b'),
    identityHash('c'),
  ]);
});

test('browser: 全 busy 时不硬杀（让位给 deadline）', async () => {
  const { factory, log } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('a');
  await h.acquire('b');
  h.enter(identityHash('a'));
  h.enter(identityHash('b'));
  // 两个都 busy：evictLRU 找不到可杀对象 → 不驱逐，但仍为 c 开新 context
  // （design §6.1「busy 的不动」= 不杀别人；让位给 deadline 的语义由
  //  deadline 到点后该调用自行结束、context 变空闲来体现）
  await h.acquire('c');
  assert.equal(log.persistent.length, 3, '未驱逐他人：a/b 均被保留');
  assert.equal(h.stats().contexts, 3, '瞬时超员是允许的（不杀 busy）');
  h.exit(identityHash('a'));
  h.exit(identityHash('b'));
});

test('browser: 常量与 design 逐字一致', () => {
  assert.equal(MAX_CONTEXTS, 2);
  assert.equal(MAX_PAGES_PER_CTX, 3);
  assert.equal(HIGH_WATER_RATIO, 0.8);
  assert.equal(CONTEXT_MAX_AGE_MS, 30 * 60_000);
  assert.equal(PROFILES_ROOT, '/dot/profiles');
});

// ── 3. 高水位 ────────────────────────────────────────────────────────

test('browser: 内存超 80% 预算 → hardReset(mem_highwater) 并上报事件', async () => {
  const { factory } = makeFakeFactory();
  const events: string[] = [];
  let used = 0;
  const h = new BrowserHolder({
    factory,
    budgetMb: 1000,
    memProbe: { usedMb: () => used },
    onEvent: (kind) => events.push(kind),
  });
  await h.acquire('a');
  assert.equal(events.length, 0);

  used = 900; // > 1000*0.8
  await h.acquire('b'); // 触发 hardReset 后再开 b
  assert.equal(h.stats().hardResets, 1);
  assert.ok(events.includes('browser.reset'));
  assert.equal(used, 900);
});

test('browser: 高水位时 busy 的 context 不被 hardReset 杀', async () => {
  const { factory, log } = makeFakeFactory();
  let used = 0;
  const h = new BrowserHolder({
    factory,
    budgetMb: 1000,
    memProbe: { usedMb: () => used },
  });
  await h.acquire('a');
  h.enter(identityHash('a')); // a 正忙
  used = 900;
  await h.acquire('b');
  assert.equal(h.stats().hardResets, 1);
  assert.equal(log.persistent.length, 2, 'busy 的 a 保留，只多开了 b');
});

// ── 4. 老化回收 ──────────────────────────────────────────────────────

test('browser: context 存活 >30min 且非 busy → 回收', async () => {
  const { factory, log } = makeFakeFactory();
  let now = 1_000_000;
  const h = new BrowserHolder({
    factory,
    budgetMb: 1024,
    now: () => now,
  });
  await h.acquire('a');
  now += CONTEXT_MAX_AGE_MS + 1;
  await h.acquire('b'); // reapAged 先跑，把老的 a 收掉
  assert.equal(h.stats().contexts, 1);
  assert.equal(log.persistent.length, 2, '回收后为 b 新开');
});

test('browser: 老化但 busy 的 context 不回收', async () => {
  const { factory, log } = makeFakeFactory();
  let now = 1_000_000;
  const h = new BrowserHolder({ factory, budgetMb: 1024, now: () => now });
  await h.acquire('a');
  h.enter(identityHash('a'));
  now += CONTEXT_MAX_AGE_MS + 1;
  await h.acquire('b');
  assert.equal(log.persistent.length, 2);
  assert.equal(h.stats().contexts, 2, 'busy 的 a 未被回收');
});

// ── 5. in-flight / close ─────────────────────────────────────────────

test('browser: in-flight 计数即 busy 判据；closeIdentity 关 context 留 profile', async () => {
  const { factory } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('a');
  h.enter(identityHash('a'));
  h.enter(identityHash('a'));
  await h.acquire('b');
  assert.equal(h.stats().contexts, 2);
  h.exit(identityHash('a'));
  h.exit(identityHash('a'));

  assert.equal(await h.closeIdentity('a'), true);
  assert.equal(h.stats().contexts, 1);
  assert.equal(await h.closeIdentity('a'), false, '幂等：已关过返回 false');
  assert.equal(await h.closeIdentity('never-seen'), false);
});

test('browser: closeAll 清空所有 context', async () => {
  const { factory } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('a');
  await h.acquire('anon');
  assert.equal(h.stats().contexts, 2);
  await h.closeAll();
  assert.equal(h.stats().contexts, 0);
  assert.equal(h.stats().running, false);
});

test('browser: cleanProfileCaches 只报持久且空闲的 context', async () => {
  const { factory } = makeFakeFactory();
  const h = new BrowserHolder({ factory, budgetMb: 1024 });
  await h.acquire('a');
  await h.acquire('anon');
  h.enter(identityHash('a')); // a 忙 → 不清
  const targets = await h.cleanProfileCaches();
  assert.deepEqual(targets, [], '忙的持久 context 不清（design 逐字：context 关闭时才清）');
  h.exit(identityHash('a'));
  const targets2 = await h.cleanProfileCaches();
  assert.ok(targets2.includes('Default/Cache'));
  assert.ok(targets2.includes('Crashpad'));
  assert.equal(targets2.length, 5, 'ephemeral 无卷上 profile，不计入');
});

// ── 6. Xvfb ─────────────────────────────────────────────────────────

class FakeXvfb implements XvfbSpawn {
  aliveFlag = true;
  startOk = true;
  starts = 0;
  stops = 0;
  private cbs: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  start(): boolean {
    this.starts += 1;
    return this.startOk;
  }
  stop(): void {
    this.stops += 1;
    this.aliveFlag = false;
  }
  alive(): boolean {
    return this.aliveFlag;
  }
  onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.cbs.push(cb);
  }
  /** 测试用：模拟崩溃。 */
  crash(): void {
    this.aliveFlag = false;
    for (const cb of this.cbs) cb({ code: 1, signal: null });
  }
}

test('xvfb: start 幂等，stop 后能重启', () => {
  const s = new FakeXvfb();
  const m = new XvfbManager({ spawnImpl: s });
  assert.equal(m.start(), true);
  assert.equal(m.start(), true);
  assert.equal(s.starts, 1, '已活着 → 不重复 spawn');
  assert.equal(m.alive, true);
  assert.equal(m.displayEnv, XVFB_DISPLAY);
  assert.deepEqual(m.envPatch(), { DISPLAY: ':99' });

  m.stop();
  assert.equal(s.stops, 1);
  assert.equal(m.alive, false);
  assert.equal(m.start(), true);
  assert.equal(s.starts, 2);
});

test('xvfb: 崩溃 → crashed 事件，且**不自行重开**（视同 runtime 崩溃）', () => {
  const s = new FakeXvfb();
  const m = new XvfbManager({ spawnImpl: s });
  const crashed: unknown[] = [];
  m.on('crashed', (d) => crashed.push(d));
  m.on('ready', () => {});
  m.start();
  s.crash();
  assert.equal(crashed.length, 1);
  assert.deepEqual(crashed[0], { display: ':99' });
  assert.equal(s.starts, 1, '不自行重开：交给宿主 healthcheck 失败 → recreate');
  assert.equal(m.alive, false);
});

test('xvfb: spawn 失败 → crashed(spawn_failed)，start 返回 false', () => {
  const s = new FakeXvfb();
  s.startOk = false;
  const m = new XvfbManager({ spawnImpl: s });
  const crashed: unknown[] = [];
  m.on('crashed', (d) => crashed.push(d));
  assert.equal(m.start(), false);
  assert.equal((crashed[0] as { reason?: string }).reason, 'spawn_failed');
});

test('xvfb: 未启动前的退出不误报 crashed', () => {
  const s = new FakeXvfb();
  const m = new XvfbManager({ spawnImpl: s });
  const crashed: unknown[] = [];
  m.on('crashed', (d) => crashed.push(d));
  s.crash();
  assert.equal(crashed.length, 0);
});
