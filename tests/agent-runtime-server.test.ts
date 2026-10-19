/**
 * tests/agent-runtime-server.test.ts —— server.ts 派发/端点层单测（审码 issue A/E/F/G/H/I/J 的回归防线）。
 *
 * 隔离策略（与 browser 测试同哲学）：不起真 HTTP 端口、不起真 chromium、不碰真 /opt/agent-state。
 * - FsTools/ShellTools/BrowserHolder 全部走构造函数注入（homeRoot 指临时目录、factory 是进程内假工厂）。
 * - HTTP 层用 `start()` 监听 127.0.0.1 的随机端口，用 fetch 打真请求（Bearer 鉴权、路由、状态码都覆盖到）。
 *
 * 覆盖的审码问题：
 * - A：jobsStart→beginJob→settleJob 全链路活着（GET /jobs/{id}、cancel、DELETE /jobs 不再 404）
 * - E：每 profile 并发页面达到 MAX_PAGES_PER_CTX → too_many_pages
 * - F：browserCall 只 enter 一次、finally exit 一次（in-flight 不泄漏）
 * - G：崩溃 context 的下一次 acquire 自动重开（不返回同一个已死 context）
 * - H：browser.* 缺顶层 identity → identity_required（契约 G1 fail-closed）
 * - I：done 项重放时 args_hash 不一致 → call_id_reuse_mismatch
 * - J：error 项把 doing 行从 ledger 收掉（同 call_id 二次派发不再恒 running）
 * - C：/fs/ops 返回宿主 MEM FsOpsHttpBridge 读的扁平形状
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntime, DEFAULT_TOKEN_PATH, FINISHED_JOBS_KEEP, type RuntimeConfig } from '../agent-runtime/server.ts';
import {
  ERROR_CODES,
  type ToolCall,
  type ToolResult,
} from '../agent-runtime/protocol.ts';
import { FsTools } from '../agent-runtime/fs.ts';
import type { SpawnAdapter, SpawnOutcome } from '../agent-runtime/shell.ts';
import {
  BrowserHolder,
  MAX_PAGES_PER_CTX,
  identityHash,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserPage,
  type ChromiumFactory,
} from '../agent-runtime/browser.ts';
import { XvfbManager, type XvfbSpawn } from '../agent-runtime/xvhfd.ts';

// ── 脚手架 ───────────────────────────────────────────────────────────

interface Tmp {
  dir: string;
  homeRoot: string;
  ledgerPath: string;
  cleanup(): void;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), 'dotd-agent-runtime-server-'));
  const homeRoot = join(dir, 'home');
  mkdirSync(homeRoot, { recursive: true });
  let cleaned = false;
  return {
    dir,
    homeRoot,
    ledgerPath: join(dir, 'state', 'ledger.jsonl'),
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function call(callId: string, tool: ToolCall['tool'], args: Record<string, unknown> = {}, identity?: string): ToolCall {
  return {
    call_id: callId,
    task_id: 'task1',
    dot_id: 'dot1',
    tool,
    args,
    deadline_ms: 30_000,
    issued_at: '2026-10-15T00:00:00.000Z',
    ...(identity !== undefined ? { identity } : {}),
  };
}

/** 假 spawn：立即返回，记录每次调用（uid/gid 由 ShellTools 传入）。 */
function fakeSpawn(log: Array<Record<string, unknown>>): SpawnAdapter {
  return {
    run(cmd: string, opts: Record<string, unknown>): Promise<SpawnOutcome> {
      log.push({ cmd, uid: opts.uid, gid: opts.gid });
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        killed: false,
      });
    },
  };
}

// ── 假浏览器（进程内，零外部依赖）────────────────────────────────────

class FakePage implements BrowserPage {
  url_ = 'about:blank';
  title_ = '';
  closed = false;
  constructor(private readonly ctx: FakeCtx) {}
  async goto(url: string): Promise<void> {
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
    this.closed = true;
    // 与 playwright 一致：页面关闭后 ctx.pages() 不再含它
    this.ctx.openPages.splice(this.ctx.openPages.indexOf(this), 1);
  }
}

class FakeCtx implements BrowserContextLike {
  readonly openPages: FakePage[] = [];
  closed = false;
  dead = false;
  readonly kind: 'persistent' | 'ephemeral';
  constructor(kind: 'persistent' | 'ephemeral') {
    this.kind = kind;
  }
  async pages(): Promise<BrowserPage[]> {
    return this.openPages;
  }
  async newPage(): Promise<BrowserPage> {
    const p = new FakePage(this);
    this.openPages.push(p);
    return p;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** 测试用：标记 context 已死（chromium process exit 的等价物）。 */
  kill(): void {
    this.dead = true;
  }
}

/** 带 isConnected 探针的 FakeCtx（BrowserHolder.alive 走这条路）。 */
class ProbeCtx extends FakeCtx {
  constructor(kind: 'persistent' | 'ephemeral') {
    super(kind);
  }
  isConnected(): boolean {
    return !this.dead;
  }
}

interface FakeFactoryLog {
  persistent: string[];
  ephemeral: number;
  ctxs: FakeCtx[];
}

function makeFakeFactory(): { factory: ChromiumFactory; log: FakeFactoryLog } {
  const log: FakeFactoryLog = { persistent: [], ephemeral: 0, ctxs: [] };
  let shared: BrowserLike | null = null;
  return {
    log,
    factory: {
      async launchPersistentContext(userDataDir: string): Promise<BrowserContextLike> {
        log.persistent.push(userDataDir);
        const c = new ProbeCtx('persistent');
        log.ctxs.push(c);
        return c;
      },
      async launch(): Promise<BrowserLike> {
        log.ephemeral += 1;
        shared ??= {
          async newContext(): Promise<BrowserContextLike> {
            const c = new ProbeCtx('ephemeral');
            log.ctxs.push(c);
            return c;
          },
          async close(): Promise<void> {},
          isConnected(): boolean {
            return true;
          },
        } satisfies BrowserLike;
        return shared;
      },
    },
  };
}

/** 假 Xvfb（不起真二进制；接口见 xvhfd.ts 的 XvfbSpawn）。 */
class FakeXvfb implements XvfbSpawn {
  aliveFlag = true;
  stops = 0;
  private readonly cbs: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  start(): boolean {
    return true;
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

const fakeXvfbSpawn = new FakeXvfb();

function noopLog(): void {}

/**
 * 端口分配：每个 runtime 拿一个递增端口。同一测试文件里多个 runtime 前后脚
 * 起落，若都抢 9223，前一个的 keep-alive 连接还没断完就会撞 ECONNRESET。
 * 串行（describe 不并发）+ 端口错开即可稳定。
 */
let portSeq = 19_200;

async function makeRuntime(
  tmp: Tmp,
  over: Partial<RuntimeConfig> = {},
): Promise<{ rt: AgentRuntime; factoryLog: FakeFactoryLog; spawnLog: Array<Record<string, unknown>>; base: string; stop(): Promise<void> }> {
  portSeq += 1;
  const spawnLog: Array<Record<string, unknown>> = [];
  const { factory, log } = makeFakeFactory();
  const rt = new AgentRuntime({
    token: 'test-token-000',
    port: portSeq,
    host: '127.0.0.1',
    stateDir: join(tmp.dir, 'state'),
    ledgerPath: tmp.ledgerPath,
    homeRoot: tmp.homeRoot,
    log: noopLog,
    fsTools: new FsTools({ homeRoot: tmp.homeRoot }),
    shellTools: undefined,
    spawnAdapter: fakeSpawn(spawnLog),
    browserFactory: factory,
    xvfbSpawn: fakeXvfbSpawn,
    ...over,
  });
  await rt.start();
  const port = (rt as unknown as { cfg: { port: number } }).cfg.port;
  return {
    rt,
    factoryLog: log,
    spawnLog,
    base: `http://127.0.0.1:${port}`,
    stop: () => rt.stop(),
  };
}

/** 打一个带 Bearer 的请求。 */
async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: 'Bearer test-token-000',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * 走 /jobs/start（browser.* 在能力目录里是 async，与宿主 src/exec/protocol.ts
 * 的目录一致）并轮询到终态，返回终态 ToolResult。
 * 这正是宿主 ExecService.startJob → pollJob 的主路径（§5.5）。
 */
async function asyncCall(
  base: string,
  c: ToolCall,
): Promise<{ status: string; result?: unknown; error?: { code?: string } }> {
  const started = await req(base, 'POST', '/jobs/start', c);
  const jobId = (started.body as { job_id?: string }).job_id;
  if (jobId === undefined) {
    // 端点层就拒了（如 mode 不匹配、identity 缺失）：回执即终态
    const b = started.body as { status?: string; error?: { code?: string } };
    return { status: b.status ?? 'error', ...(b.error !== undefined ? { error: b.error } : {}) };
  }
  for (let i = 0; i < 200; i++) {
    const view = (await req(base, 'GET', `/jobs/${jobId}`)).body as {
      state?: string;
      result?: unknown;
      error?: { code?: string };
    };
    if (view.state === 'done') return { status: 'ok', ...(view.result !== undefined ? { result: view.result } : {}) };
    if (view.state === 'error') return { status: 'error', ...(view.error !== undefined ? { error: view.error } : {}) };
    if (view.state === 'cancelled') return { status: 'cancelled' };
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`job ${jobId} 未在 2s 内收敛`);
}

// ═══════════════════════════════════════════════════════════════════
// A：jobs 全链路（审码 issue A —— beginJob/registerJob 从未被调用）
// ═══════════════════════════════════════════════════════════════════

test('A: jobs/start 真链路：GET /jobs/{id} 有视图、终态落 result、DELETE 可清理', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  // shell.run 是 async → 走 /jobs/start
  const started = await req(env.base, 'POST', '/jobs/start', call('j1', 'shell.run', { cmd: 'echo hi', timeout_ms: 1000 }));
  assert.equal(started.status, 200);
  const jobId = (started.body as { job_id?: string }).job_id;
  assert.ok(jobId !== undefined && jobId.length > 0, '回执必须带 job_id');

  // 轮询到终态（轮询而不是 sleep：后台 dispatch 完成即 settleJob）
  let view: Record<string, unknown> | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await req(env.base, 'GET', `/jobs/${jobId}`);
    view = r.body as Record<string, unknown>;
    if (view.state !== 'running') break;
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(view?.state, 'done', 'settleJob 必须把终态写进 job 视图');
  assert.equal(view?.call_id, 'j1');
  assert.ok(Array.isArray(view?.events) && (view.events as unknown[]).length >= 2, 'started + finished 两个事件');

  // DELETE /jobs 清理
  const cleaned = await req(env.base, 'DELETE', '/jobs');
  assert.deepEqual(cleaned.body, { removed: 1 });
  const gone = await req(env.base, 'GET', `/jobs/${jobId}`);
  assert.equal(gone.status, 404, '清理后 job 视图 404（此前 beginJob 缺失时这里恒 404）');
});

test('A: GET /jobs/{未知 id} → 404 job_not_found（端点表行为，非链路断裂）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'GET', '/jobs/job_does_not_exist');
  assert.equal(r.status, 404);
  assert.equal((r.body as { error?: { code?: string } }).error?.code, ERROR_CODES.job_not_found);
});

test('A: POST /jobs/{id}/cancel 有句柄可调（JobEntry.cancel 已接线）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  // 慢 shell：让 job 停在 running，才能观测 cancel 真的作用在 job 上
  const slowSpawn: SpawnAdapter = {
    run(): Promise<SpawnOutcome> {
      return new Promise((resolve) => setTimeout(() => resolve({ code: 0, signal: null, stdout: '', stderr: '', killed: false }), 3000));
    },
  };
  const { factory, log } = makeFakeFactory();
  const rt = new AgentRuntime({
    token: 'test-token-000',
    port: (portSeq += 1),
    host: '127.0.0.1',
    stateDir: join(tmp.dir, 'state'),
    ledgerPath: tmp.ledgerPath,
    homeRoot: tmp.homeRoot,
    log: noopLog,
    fsTools: new FsTools({ homeRoot: tmp.homeRoot }),
    spawnAdapter: slowSpawn,
    browserFactory: factory,
    xvfbSpawn: fakeXvfbSpawn,
  });
  t.after(() => rt.stop());
  await rt.start();
  const base = `http://127.0.0.1:${(rt as unknown as { cfg: { port: number } }).cfg.port}`;
  void log;

  const started = await req(base, 'POST', '/jobs/start', call('jc', 'shell.run', { cmd: 'sleep 1', timeout_ms: 5000 }));
  const jobId = (started.body as { job_id?: string }).job_id as string;
  assert.equal((await req(base, 'GET', `/jobs/${jobId}`)).body.state, 'running', '慢调用期间 job 是 running');

  const cancelled = await req(base, 'POST', `/jobs/${jobId}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body as { status?: string }).status, 'cancelled');

  const view = await req(base, 'GET', `/jobs/${jobId}`);
  assert.equal((view.body as { state?: string }).state, 'cancelled', 'cancel 必须落到 job 视图');

  // 幂等：二次 cancel 不炸
  const again = await req(base, 'POST', `/jobs/${jobId}/cancel`);
  assert.equal(again.status, 200);
});

test('A: /jobs/start 拒绝 sync 工具（应走 /tools/call）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'POST', '/jobs/start', call('s1', 'fs.read', { path: 'a.md' }));
  assert.equal((r.body as { error?: { code?: string } }).error?.code, ERROR_CODES.wrong_endpoint_for_mode);
});

// ═══════════════════════════════════════════════════════════════════
// E：每 profile 并发页面上限（审码 issue E —— CtxEntry.pages 恒 0）
// ═══════════════════════════════════════════════════════════════════

test('E: 并发页面达到 MAX_PAGES_PER_CTX → too_many_pages（acquire 不再只看 enter 计数）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  // 前 MAX_PAGES_PER_CTX 次：每次把上一页 close 掉（FakePage.close → openPages 移除），
  // 于是 pages() 为空 → 每次都走 newPage 分支 → 每次都撞页数记账。
  for (let i = 0; i < MAX_PAGES_PER_CTX; i++) {
    const r = await asyncCall(env.base, call(`p${i}`, 'browser.open', { url: 'https://x.test/' }, 'alice'));
    assert.equal(r.status, 'ok', `第 ${i + 1} 次 open 应成功`);
    const opened = env.factoryLog.ctxs[0]!.openPages;
    assert.equal(opened.length, 1, `第 ${i + 1} 次调用新开了一页（上一页已关）`);
    // 关掉刚开的页，但**不关 context**：CtxEntry.pages 的记账仍在
    await opened[0]!.close();
    assert.equal(env.factoryLog.ctxs[0]!.openPages.length, 0, '页面关闭后 ctx.pages() 为空');
  }
  assert.equal(env.rt.browser.pageCount(identityHash('alice')), MAX_PAGES_PER_CTX, 'notePage 记账到上限');

  // 第 N+1 次：pages() 为空 → 走 newPage 分支 → 页数已满 → 拒绝
  const over = await asyncCall(env.base, call('pover', 'browser.open', { url: 'https://x.test/' }, 'alice'));
  assert.equal(over.status, 'error');
  assert.equal(
    over.error?.code,
    ERROR_CODES.too_many_pages,
    `超过 ${MAX_PAGES_PER_CTX} 个并发页面必须拒绝（EX §6.1）`,
  );

  // 记账确实按身份分开：换身份（新 context）又能开
  const other = await asyncCall(env.base, call('pother', 'browser.open', { url: 'https://x.test/' }, 'bob'));
  assert.equal(other.status, 'ok', '页数按身份分别记账');
});

// ═══════════════════════════════════════════════════════════════════
// F：in-flight 不泄漏（审码 issue F —— enter 两次、exit 一次）
// ═══════════════════════════════════════════════════════════════════

test('F: browserCall 前后 enter/exit 配对，in-flight 归零（busy 判据可用）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  for (let i = 0; i < 4; i++) {
    const r = await asyncCall(env.base, call(`f${i}`, 'browser.open', { url: 'https://x.test/' }, 'alice'));
    assert.equal(r.status, 'ok');
  }
  const stats = env.rt.browser.stats();
  const key = identityHash('alice');
  assert.equal(stats.inflight[key], 0, '四次调用后 in-flight 必须归零（否则 LRU/老化/hardReset 的 busy 判据全失效）');
  assert.equal(stats.contexts, 1);
  assert.equal(stats.pages[key], 1, '四次调用复用同一个页面（pages() 非空 → 不 newPage）');
});

test('F: 调用抛错时 finally 也 exit（异常路径不泄漏 in-flight）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  // browser.open 不带 url → browserCall 内 return errorResult，finally 仍要 exit
  const r = await asyncCall(env.base, call('ferr', 'browser.open', {}, 'alice'));
  assert.equal(r.error?.code, ERROR_CODES.bad_args);
  const stats = env.rt.browser.stats();
  for (const v of Object.values(stats.inflight)) assert.equal(v, 0);
});

// ═══════════════════════════════════════════════════════════════════
// G：崩溃 context 自动重开（审码 issue G —— isConnected 存在却没用）
// ═══════════════════════════════════════════════════════════════════

test('G: context 崩溃后下一次 browser.* 自动重开，不返回同一个已死 context', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const first = await asyncCall(env.base, call('g1', 'browser.open', { url: 'https://x.test/' }, 'alice'));
  assert.equal(first.status, 'ok');
  assert.equal(env.factoryLog.ctxs.length, 1, '首次 acquire 起一个 persistent context');

  // 杀掉它（chromium process exit 的等价物）
  const dead = env.factoryLog.ctxs[0]!;
  dead.kill();

  const second = await asyncCall(env.base, call('g2', 'browser.open', { url: 'https://x.test/' }, 'alice'));
  assert.equal(second.status, 'ok', '崩溃后应自动重开并成功');
  assert.equal(env.factoryLog.ctxs.length, 2, '必须 launch 一个新 context（而不是复用已死的）');
  assert.notEqual(env.factoryLog.ctxs[1], dead);
  assert.equal(dead.closed, true, '旧 context 被 closeEntry 收掉');
});

// ═══════════════════════════════════════════════════════════════════
// H：契约 G1 fail-closed（审码 issue H —— 缺 identity 被当成 ephemeral）
// ═══════════════════════════════════════════════════════════════════

test('H: browser.* 缺顶层 identity → identity_required，不降级为匿名档', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await asyncCall(env.base, call('h1', 'browser.open', { url: 'https://x.test/' }));
  assert.equal(r.error?.code, ERROR_CODES.identity_required);
  assert.equal(env.factoryLog.ctxs.length, 0, 'fail-closed：一个 context 都不起');

  // 'anon' 是显式匿名档（合法），与"缺失"不同
  const anon = await asyncCall(env.base, call('h2', 'browser.open', { url: 'https://x.test/' }, 'anon'));
  assert.equal(anon.status, 'ok');
  assert.equal(env.factoryLog.ephemeral, 1, 'anon 走 ephemeral 分支');
});

// ═══════════════════════════════════════════════════════════════════
// I：args_hash 比对（审码 issue I —— 重派路径从不比对）
// ═══════════════════════════════════════════════════════════════════

test('I: done 项重放时 args_hash 不一致 → call_id_reuse_mismatch（绝不静默重放旧结果）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  writeFileSync(join(tmp.homeRoot, 'a.md'), 'AAA');
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const first = await req(env.base, 'POST', '/tools/call', call('i1', 'fs.read', { path: 'a.md' }));
  assert.equal((first.body as { status?: string }).status, 'ok');
  assert.equal(env.rt.ledger.lookup('i1').kind, 'done');

  // 同 call_id、不同 args（call_id 全局唯一，这是调用方违规）
  const second = await req(env.base, 'POST', '/tools/call', call('i1', 'fs.read', { path: 'b.md' }));
  assert.equal((second.body as { error?: { code?: string } }).error?.code, ERROR_CODES.call_id_reuse_mismatch);

  // 同 call_id、同 args → 正常重放（ledger 的 args_hash 比对在重放路径上真的执行）
  const replay = await req(env.base, 'POST', '/tools/call', call('i1', 'fs.read', { path: 'a.md' }));
  assert.equal((replay.body as { status?: string }).status, 'ok');
  const replayed = (replay.body as { result?: { content?: string } }).result;
  assert.equal(replayed?.content, 'AAA', '重放的是第一次的结果，不是第二次 args 的');
});

// ═══════════════════════════════════════════════════════════════════
// J：error 项收掉 doing 行（审码 issue J —— 二次派发恒 running）
// ═══════════════════════════════════════════════════════════════════

test('J: error 后同 call_id 二次派发不再恒 running（doing 行被收掉）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  // 读一个不存在的文件 → error 路径
  const first = await req(env.base, 'POST', '/tools/call', call('j1', 'fs.read', { path: 'nope.md' }));
  assert.equal((first.body as { status?: string }).status, 'error');

  const second = await req(env.base, 'POST', '/tools/call', call('j1', 'fs.read', { path: 'nope.md' }));
  assert.equal((second.body as { status?: string }).status, 'error', '二次派发仍应是 error，不是 running');

  // ledger 里不再有 doing 行（append-only：追加一行带 error_reason 的 aborted 收行）
  const lookup = env.rt.ledger.lookup('j1');
  assert.equal(lookup.kind, 'aborted', 'error 项不再占 doing 位');
  if (lookup.kind === 'aborted') {
    assert.equal(lookup.record.error_reason, 'tool_error', '收行必须带原因，与重启扫描的 aborted 区分');
  }
});

test('J: ok 项之后 ledger 有 done 行（重放窗口在）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  writeFileSync(join(tmp.homeRoot, 'ok.md'), 'hello');
  const r = await req(env.base, 'POST', '/tools/call', call('j2', 'fs.read', { path: 'ok.md' }));
  assert.equal((r.body as { status?: string }).status, 'ok');
  assert.equal(env.rt.ledger.lookup('j2').kind, 'done');
});

// ═══════════════════════════════════════════════════════════════════
// C：/fs/ops 扁平形状（审码 issue C —— 宿主 MEM 三读全空）
// ═══════════════════════════════════════════════════════════════════

test('C: /fs/ops 返回宿主 FsOpsHttpBridge 读的扁平字段（content/entries/stat）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  writeFileSync(join(tmp.homeRoot, 'a.md'), 'hello');
  mkdirSync(join(tmp.homeRoot, 'notes'), { recursive: true });
  writeFileSync(join(tmp.homeRoot, 'notes', 'b.md'), 'xy');
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const read = await req(env.base, 'POST', '/fs/ops', { op: 'read', path: 'a.md' });
  assert.equal(read.status, 200);
  assert.equal(read.body.content, 'hello', 'MEM 的 read() 读 body.content');
  assert.equal(read.body.ok, true);

  const list = await req(env.base, 'POST', '/fs/ops', { op: 'list', path: '.' });
  const entries = list.body.entries as Array<Record<string, unknown>>;
  const a = entries.find((e) => e.name === 'a.md');
  assert.ok(a !== undefined);
  assert.equal(a.sizeBytes, 5, 'MEM 的 list() 读 entries[].sizeBytes（camelCase）');
  assert.equal(typeof a.mtimeMs, 'number');

  const stat = await req(env.base, 'POST', '/fs/ops', { op: 'stat', path: 'a.md' });
  const st = stat.body.stat as Record<string, unknown>;
  assert.equal(st.sizeBytes, 5, 'MEM 的 stat() 读 body.stat.sizeBytes');
  assert.equal(st.isDir, false);

  const renamed = await req(env.base, 'POST', '/fs/ops', { op: 'rename', path: 'a.md', target: 'c.md' });
  assert.equal(renamed.body.ok, true, 'MEM 的 rename() 判定 body.ok !== false');
  assert.equal(renamed.body.target, 'c.md');
});

test('C: /fs/ops 路径越界 → ok:false + path_outside_home（与宿主侧 checkHomePath 双查）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'POST', '/fs/ops', { op: 'read', path: '../../etc/passwd' });
  assert.equal(r.body.ok, false);
  assert.ok(String((r.body as { error?: { code?: string } }).error?.code).length > 0);
});

// ═══════════════════════════════════════════════════════════════════
// 端点表其余条目（审码 issue K 顺带覆盖：路由 + 鉴权 + 未授权）
// ═══════════════════════════════════════════════════════════════════

test('端点表: 无 Bearer → 401（含 /fs/ops 与 /tools/call）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  for (const [method, path] of [
    ['GET', '/healthz'],
    ['POST', '/tools/call'],
    ['POST', '/fs/ops'],
    ['GET', '/capabilities'],
  ] as const) {
    const res = await fetch(`${env.base}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path} 未授权必须 401`);
  }
});

test('端点表: healthz 不回显 token，只给 token_epoch', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'GET', '/healthz');
  assert.equal(r.body.state, 'ok');
  assert.match(String(r.body.token_epoch), /^[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(r.body).includes('test-token-000'), false, '响应体绝不含 token 明文');
});

test('端点表: /capabilities 列出模型面工具 + sideEffect', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'GET', '/capabilities');
  const caps = r.body.capabilities as Array<{ name: string; mode: string; sideEffect?: string }>;
  assert.deepEqual(caps.map((c) => c.name).sort(), ['browser.act', 'browser.close', 'browser.open', 'browser.snapshot', 'fs.list', 'fs.read', 'fs.remove', 'fs.stat', 'fs.write', 'net.get', 'net.post', 'shell.run']);
  const fsRead = caps.find((c) => c.name === 'fs.read');
  assert.equal(fsRead?.mode, 'sync');
  assert.equal(fsRead?.sideEffect, 'safe');
});

test('M: /fs/ops 不在能力目录 → 模型工具面结构性不可见（S4 撇号桥的等效防护）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  const r = await req(env.base, 'GET', '/capabilities');
  const names = (r.body.capabilities as Array<{ name: string }>).map((c) => c.name);
  assert.equal(names.includes('fs.ops'), false, 'fs/ops 绝不能进模型工具面');
  assert.equal(names.includes('fs/ops'), false);

  // 即便模型硬编一个 tool 名走 /tools/call，也只会拿到 unknown_tool
  const attempt = await req(env.base, 'POST', '/tools/call', call('m1', 'fs.ops' as ToolCall['tool'], { op: 'read', path: 'a.md' }));
  assert.equal((attempt.body as { error?: { code?: string } }).error?.code, ERROR_CODES.unknown_tool);
});

test('端点表: GET /calls/{id} 同步调用也可取回终态（§5.4-2 reconcile 路径）', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  writeFileSync(join(tmp.homeRoot, 'a.md'), 'hello');
  const env = await makeRuntime(tmp);
  t.after(() => env.stop());

  await req(env.base, 'POST', '/tools/call', call('c1', 'fs.read', { path: 'a.md' }));
  const r = await req(env.base, 'GET', '/calls/c1');
  assert.equal((r.body as { status?: string }).status, 'ok');
  const result = r.body.result as { content?: string };
  assert.equal(result.content, 'hello');
});

// ── B 的 server 层落点：降级事件经 log 出口（DEV-4「记降级事件」）────────

test('B: shell 降级（canSetUid=false）发 exec.shell.uid_degraded 事件到 log 出口', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const lines: string[] = [];
  const spawnLog: Array<Record<string, unknown>> = [];
  const { factory, log: flog } = makeFakeFactory();
  const rt = new AgentRuntime({
    token: 'test-token-000',
    port: (portSeq += 1),
    host: '127.0.0.1',
    stateDir: join(tmp.dir, 'state'),
    ledgerPath: tmp.ledgerPath,
    homeRoot: tmp.homeRoot,
    // 钉死前提：这台机器没有 setuid 能力。缺省判据是 process.getuid?.()===0，
    // 在 WSL root 下恒 true（不降级）、Windows 下恒 false——不钉的话这条断言
    // 换台机器就红，红的原因还是环境不是代码（2026-10-17 WSL 全量实测）。
    canSetUid: () => false,
    log: (line) => lines.push(line),
    fsTools: new FsTools({ homeRoot: tmp.homeRoot }),
    spawnAdapter: fakeSpawn(spawnLog),
    browserFactory: factory,
    xvfbSpawn: fakeXvfbSpawn,
  });
  t.after(() => rt.stop());
  await rt.start();
  const base = `http://127.0.0.1:${(rt as unknown as { cfg: { port: number } }).cfg.port}`;
  void flog;

  // 容器外（Windows）process.getuid 不存在 → canSetUid()=false → 降级事件必须发出。
  // shell.run 是 async → 走 /jobs/start 轮询终态。
  const r = await asyncCall(base, call('b1', 'shell.run', { cmd: 'echo hi', timeout_ms: 1000 }));
  assert.equal(r.status, 'ok', '降级不阻断调用（仍返回结果）');

  const degrade = lines.find((l) => l.includes('exec.shell.uid_degraded'));
  assert.ok(degrade !== undefined, '降级必须有事件出口（DEV-4），不是只留注释');

  // spawn 侧收到了 RUNTIME_UID（1000）而非 1001：容器外拿不到 CapAdd SETUID
  assert.equal(spawnLog.length, 1);
  assert.equal(spawnLog[0]!.uid, 1000, '降级时 uid 落到 runtime 自己的 1000（不假装是 1001）');

  // 结果里 degraded 标记为 true（宿主/审计可见）
  const res = r.result as { degraded?: boolean } | undefined;
  assert.equal(res?.degraded, true, '降级执行必须在结果里如实标记');
});

test('B 反面：有 setuid 能力（canSetUid=true）→ 不发降级事件、uid 用 1001', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const lines: string[] = [];
  const spawnLog: Array<Record<string, unknown>> = [];
  const { factory } = makeFakeFactory();
  const rt = new AgentRuntime({
    token: 'test-token-000',
    port: (portSeq += 1),
    host: '127.0.0.1',
    stateDir: join(tmp.dir, 'state'),
    ledgerPath: tmp.ledgerPath,
    homeRoot: tmp.homeRoot,
    canSetUid: () => true,
    log: (line) => lines.push(line),
    fsTools: new FsTools({ homeRoot: tmp.homeRoot }),
    spawnAdapter: fakeSpawn(spawnLog),
    browserFactory: factory,
    xvfbSpawn: fakeXvfbSpawn,
  });
  t.after(() => rt.stop());
  await rt.start();
  const base = `http://127.0.0.1:${(rt as unknown as { cfg: { port: number } }).cfg.port}`;

  const r = await asyncCall(base, call('b1', 'shell.run', { cmd: 'echo hi', timeout_ms: 1000 }));
  assert.equal(r.status, 'ok');
  assert.ok(
    !lines.some((l) => l.includes('exec.shell.uid_degraded')),
    '有能力就别假报降级（否则审计里全是噪声，真降级反而看不出来）',
  );
  assert.equal(spawnLog[0]!.uid, 1001, '不降级时 uid 用 SHELL_UID 1001');
  const res = r.result as { degraded?: boolean } | undefined;
  assert.notEqual(res?.degraded, true);
});

// ── O：Xvfb 进程组（审码 issue O —— detached/进程组 kill）─────────────

test('O: XvfbManager.stop 调 spawnImpl.stop（真实实现里杀整个进程组）', (t) => {
  const s = new FakeXvfb();
  const m = new XvfbManager({ spawnImpl: s });
  m.start();
  m.stop();
  assert.equal(s.stops, 1, 'stop 必须真的下发到 spawn 实现');
  assert.equal(m.alive, false);
  // 进程组杀的真实实现断言在 xvhfd.ts 的 NodeXvfbSpawn.stop：
  // `process.kill(-child.pid, 'SIGTERM')` + detached 进程组（审码 issue O 的落点）。
});

test('O: Xvfb 崩溃事件可观察（crashed），且不自行重开（视同 runtime 崩溃）', () => {
  const s = new FakeXvfb();
  const m = new XvfbManager({ spawnImpl: s });
  const crashed: unknown[] = [];
  m.on('crashed', (d) => crashed.push(d));
  m.start();
  s.crash();
  assert.equal(crashed.length, 1);
  assert.deepEqual(crashed[0], { display: ':99' });
  assert.equal(m.alive, false);
});

// ── P：jobs Map 有界（2026-10-17 修：DELETE /jobs 无调用方 → 只增不减）─────

test('P: 已结束 job 只留一小段环形缓冲，running 的一条都不动', async (t) => {
  const tmp = makeTmp();
  t.after(() => tmp.cleanup());
  const rt = new AgentRuntime({
    token: 'test-token-000',
    port: 0,
    host: '127.0.0.1',
    stateDir: join(tmp.dir, 'state'),
    ledgerPath: tmp.ledgerPath,
    homeRoot: tmp.homeRoot,
    log: noopLog,
    fsTools: new FsTools({ homeRoot: tmp.homeRoot }),
    spawnAdapter: fakeSpawn([]),
    browserFactory: makeFakeFactory().factory,
    xvfbSpawn: fakeXvfbSpawn,
  });
  const jobs = rt as unknown as {
    jobs: Map<string, { state: string }>;
    registerJob(e: {
      job_id: string;
      call_id: string;
      tool: string;
      state: 'running' | 'done' | 'error' | 'cancelled';
      started_at: string;
      cancel: () => void;
    }): unknown;
  };

  // ① 一条在途 + 远超缓冲上限的已结束记录
  jobs.registerJob({
    job_id: 'job_live',
    call_id: 'live',
    tool: 'shell.run',
    state: 'running',
    started_at: new Date().toISOString(),
    cancel: () => {},
  });
  for (let i = 0; i < FINISHED_JOBS_KEEP + 40; i++) {
    jobs.registerJob({ job_id: `job_done_${i}`, call_id: `c${i}`, tool: 'shell.run', state: 'done', started_at: new Date().toISOString(), cancel: () => {} });
  }

  assert.equal(jobs.jobs.has('job_live'), true, 'running 的 job 永不被淘汰');
  assert.ok(jobs.jobs.size <= FINISHED_JOBS_KEEP + 1, `Map 必须有界，实际 ${jobs.jobs.size}`);
  assert.equal(jobs.jobs.has('job_done_0'), false, '最早的已结束记录先淘汰');
  assert.equal(jobs.jobs.has(`job_done_${FINISHED_JOBS_KEEP + 39}`), true, '最新的已结束记录还在（迟到轮询能读到）');
});
