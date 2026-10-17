/**
 * agent-runtime/browser.ts —— BrowserHolder + stealth 注入点（EX §6）。
 *
 * 设计原文（execution.md §6.1/6.2/6.3，逐条落地）：
 * - Xvfb 由 xvhfd.ts 负责，本文件只消费 `DISPLAY`。
 * - BrowserHolder 单例持有 chromium（**进程级复用**，跨调用不重开）。
 * - stealth 注入：`playwright-extra` + `puppeteer-extra-plugin-stealth/evasions/*`
 *   （版本锁进 package-lock），在 newContext/launchPersistentContext 时启用；
 *   阶段三增强只替换注入实现，不改协议。
 * - **每身份一个 persistent context**：
 *   `chromium.launchPersistentContext('/dot/profiles/<identity>/', …)`。
 * - MAX_CONTEXTS=2 / MAX_PAGES_PER_CTX=3；LRU 驱逐；memUsedMb()>budget×0.8
 *   触发 hardReset('mem_highwater')；context 存活 >30min 且非 busy → 强制回收。
 * - 契约 G1 增补：`identity:'anon'|null → ephemeral context 不入台账`
 *   （非持久 profile，不落 exec_identities）。
 *
 * **隔离原则（本任务的测试策略）**：所有 playwright/stealth 依赖都收敛在
 * `ChromiumFactory` + `StealthInjector` 两个接口后面，容器外测试注入假实现即可
 * 全链路打桩，不需要真浏览器、不需要 node_modules 里有 playwright。
 *
 * **依赖落点（审码 issue N）**：playwright/playwright-extra/puppeteer-extra-plugin-stealth
 * 的确切版本写在 package.json 的 `optionalDependencies`（精确 pin，无 ^），
 * 镜像构建时由 `npm ci --include=dev`（execution.md §3.1）装上；
 * 本文件**不 import 它们**——容器外 typecheck/测试因此零依赖，
 * 真实 stealth 实现在镜像内经 `StealthInjector` 注入（阶段三只替换该实现，不改协议）。
 */

import { createHash } from 'node:crypto';
import type { ToolResult } from './protocol.ts';
import { ERROR_CODES, errorResult, okResult } from './protocol.ts';

/** EX §6.1 常量（逐字）。 */
export const MAX_CONTEXTS = 2;
export const MAX_PAGES_PER_CTX = 3;
export const HIGH_WATER_RATIO = 0.8;
/** EX §6.2 进程/信号层：单 context 存活 >30 min 且非 busy → 强制回收。 */
export const CONTEXT_MAX_AGE_MS = 30 * 60_000;
/** profile 卷挂载点（EX §4.2 Binds）。 */
export const PROFILES_ROOT = '/dot/profiles';

/** EX §6.1：identityHash = sha256(identity).slice(0,16)（防目录名注入）。 */
export function identityHash(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
}

/** 是否持久 profile（契约 G1：'anon'/null = ephemeral，不入 exec_identities 台账）。 */
export function isPersistentIdentity(identity: string | null | undefined): boolean {
  return typeof identity === 'string' && identity.length > 0 && identity !== 'anon';
}

// ── 可注入的浏览器面（打桩边界）──────────────────────────────────────

/** 最小 Browser/Context/Page 形状（只覆盖我们用到的 playwright 子集）。 */
export interface BrowserPage {
  goto(url: string, opts?: { timeoutMs?: number }): Promise<void>;
  click(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeoutMs?: number }): Promise<void>;
  press(selector: string, key: string, opts?: { timeoutMs?: number }): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  scroll(dy: number): Promise<void>;
  title(): Promise<string>;
  url(): string;
  /** 可读快照（a11y 树/简化 DOM）。 */
  snapshot(): Promise<{ text: string; html?: string }>;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  pages(): Promise<BrowserPage[]>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
  /** stealth 注入后的句柄（测试里可为 undefined）。 */
  readonly kind: 'persistent' | 'ephemeral';
}

export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface ChromiumFactory {
  /** EX §6.1：launchPersistentContext(userDataDir, opts)。 */
  launchPersistentContext(
    userDataDir: string,
    opts: Record<string, unknown>,
  ): Promise<BrowserContextLike>;
  /** 契约 G1：ephemeral（identity:'anon'/null）分支。 */
  launch(opts?: Record<string, unknown>): Promise<BrowserLike>;
}

/** stealth 注入点（EX §6.1；阶段三只替换实现，不改协议）。 */
export interface StealthInjector {
  /** 在 newContext/launchPersistentContext 时调用的参数改写器。 */
  applyLaunchArgs(args: string[]): string[];
  applyContextOptions(opts: Record<string, unknown>): Record<string, unknown>;
}

export const noopStealth: StealthInjector = {
  applyLaunchArgs: (a) => a,
  applyContextOptions: (o) => o,
};

// ── 内存探针（可注入）───────────────────────────────────────────────

export interface MemProbe {
  /** 容器当前 RSS（MB）。 */
  usedMb(): number;
}

export const defaultMemProbe: MemProbe = {
  usedMb: () => Math.round(process.memoryUsage().rss / 1024 / 1024),
};

// ── context 记录 ────────────────────────────────────────────────────

interface CtxEntry {
  key: string;
  identity: string | null;
  persistent: boolean;
  ctx: BrowserContextLike;
  browser: BrowserLike | null;
  createdAt: number;
  lastUsedAt: number;
  /** in-flight 调用数（busy 判据，EX §6.2）。 */
  inflight: number;
  pages: number;
}

export type BrowserEventKind = 'browser.crashed' | 'browser.reset';

export interface BrowserHolderDeps {
  factory: ChromiumFactory;
  memProbe?: MemProbe;
  stealth?: StealthInjector;
  /** 容器内存预算 MB（EX §4.2 默认 1536；exec_dots.limits_json.memMb）。 */
  budgetMb?: number;
  /** 每 context JS 堆上限（EX §6.1 --js-flags=--max-old-space-size=…）。 */
  perCtxJsHeapMB?: number;
  profilesRoot?: string;
  now?: () => number;
  /** 事件出口（exec.browser.crashed / exec.browser.reset，EX §10 事件流）。 */
  onEvent?: (kind: BrowserEventKind, detail: Record<string, unknown>) => void;
  /** Xvfb DISPLAY（§6.1：随进程存活，崩溃视同 runtime 崩溃）。 */
  display?: string;
}

/**
 * EX §6.1 BrowserHolder（进程级复用，跨调用不重开 chromium）。
 *
 * 调用方（server.ts）只经由 `withContext()` 拿 context；驱逐/回收/崩溃重开的
 * 细节全部封在里面，协议层看不到。
 */
export class BrowserHolder {
  private readonly factory: ChromiumFactory;
  private readonly memProbe: MemProbe;
  private readonly stealth: StealthInjector;
  private readonly budgetMb: number;
  private readonly perCtxJsHeapMB: number;
  private readonly profilesRoot: string;
  private readonly now: () => number;
  private readonly onEvent?: (kind: BrowserEventKind, detail: Record<string, unknown>) => void;
  private readonly display: string;

  private readonly ctxs = new Map<string, CtxEntry>();
  /** chromium 进程级单例（persistent context 自带进程，ephemeral 走这里）。 */
  private sharedBrowser: BrowserLike | null = null;
  private hardResetCount = 0;

  constructor(deps: BrowserHolderDeps) {
    this.factory = deps.factory;
    this.memProbe = deps.memProbe ?? defaultMemProbe;
    this.stealth = deps.stealth ?? noopStealth;
    this.budgetMb = deps.budgetMb ?? 1536;
    this.perCtxJsHeapMB = deps.perCtxJsHeapMB ?? 512;
    this.profilesRoot = deps.profilesRoot ?? PROFILES_ROOT;
    this.now = deps.now ?? (() => Date.now());
    this.onEvent = deps.onEvent;
    this.display = deps.display ?? ':99';
  }

  /** EX §6.1 acquire(identity)（契约 G1：'anon'/null → ephemeral）。 */
  async acquire(identity: string | null | undefined): Promise<BrowserContextLike> {
    this.reapAged();
    const persistent = isPersistentIdentity(identity);
    const key = persistent ? identityHash(identity as string) : 'ephemeral';
    const hit = this.ctxs.get(key);
    if (hit !== undefined && this.alive(hit)) {
      hit.lastUsedAt = this.now();
      return hit.ctx;
    }
    // EX §6.2：崩溃的 context 标脏后**下次调用前自动重开**（原实现只留注释，
    // 实测连续两次 acquire 拿到的是同一个已死 context——审码 issue G）。
    if (hit !== undefined) {
      await this.closeEntry(hit, 'crashed_reopen');
      this.onEvent?.('browser.crashed', { key, at: this.now() });
    }
    if (this.ctxs.size >= MAX_CONTEXTS) await this.evictLRU();
    if (this.memProbe.usedMb() > this.budgetMb * HIGH_WATER_RATIO) {
      await this.hardReset('mem_highwater');
    }
    const entry = persistent
      ? await this.launchPersistent(identity as string, key)
      : await this.launchEphemeral(key);
    this.ctxs.set(key, entry);
    return entry.ctx;
  }

  /**
   * context 是否还活着（EX §6.2）。
   * persistent context 自带浏览器进程，只能借 `pages()`/句柄判活；此处用
   * playwright 的 `isConnected` 语义：工厂实现可选择暴露，缺省视为活着
   * （保守：不误杀健康 context）。
   */
  private alive(e: CtxEntry): boolean {
    const probe = e.ctx as unknown as { isConnected?: () => boolean };
    if (typeof probe.isConnected === 'function') {
      try {
        return probe.isConnected();
      } catch {
        return false;
      }
    }
    return true;
  }

  private async launchPersistent(identity: string, key: string): Promise<CtxEntry> {
    const userDataDir = `${this.profilesRoot}/${key}`;
    const ctx = await this.factory.launchPersistentContext(
      userDataDir,
      this.stealth.applyContextOptions({
        headless: false, // §6.1：headed，经自拉的 Xvfb :99
        viewport: { width: 1280, height: 900 },
        args: this.stealth.applyLaunchArgs([
          '--disable-dev-shm-usage', // /dev/shm 小，必关
          `--js-flags=--max-old-space-size=${this.perCtxJsHeapMB}`,
        ]),
      }),
    );
    return {
      key,
      identity,
      persistent: true,
      ctx,
      browser: null,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      inflight: 0,
      pages: 0,
    };
  }

  private async launchEphemeral(key: string): Promise<CtxEntry> {
    let browser = this.sharedBrowser;
    if (browser === null || !browser.isConnected()) {
      browser = await this.factory.launch({
        headless: false,
        args: this.stealth.applyLaunchArgs([
          '--disable-dev-shm-usage',
          `--js-flags=--max-old-space-size=${this.perCtxJsHeapMB}`,
        ]),
      });
      this.sharedBrowser = browser;
    }
    const ctx = await browser.newContext(
      this.stealth.applyContextOptions({ viewport: { width: 1280, height: 900 } }),
    );
    return {
      key,
      identity: null,
      persistent: false,
      ctx,
      browser,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      inflight: 0,
      pages: 0,
    };
  }

  /** 关最久未用的 context（EX §6.1 evictLRU）。busy 的不动。 */
  private async evictLRU(): Promise<void> {
    let victim: CtxEntry | null = null;
    for (const e of this.ctxs.values()) {
      if (e.inflight > 0) continue;
      if (victim === null || e.lastUsedAt < victim.lastUsedAt) victim = e;
    }
    if (victim === null) return; // 全 busy：让位给 deadline，不硬杀
    await this.closeEntry(victim, 'lru');
  }

  /** EX §6.2：单 context 存活 >30min 且非 busy → 强制回收。 */
  private reapAged(): void {
    const now = this.now();
    for (const e of [...this.ctxs.values()]) {
      if (e.inflight > 0) continue;
      if (now - e.lastUsedAt > CONTEXT_MAX_AGE_MS) {
        void this.closeEntry(e, 'aged').catch(() => undefined);
      }
    }
  }

  /**
   * EX §6.2 高水位：关所有 context → 关浏览器 → 重开。
   * profile 卷内数据不丢（持久 context 的 userDataDir 在卷上）。
   */
  async hardReset(reason: string): Promise<void> {
    for (const e of [...this.ctxs.values()]) {
      if (e.inflight > 0) continue;
      await this.closeEntry(e, reason);
    }
    if (this.sharedBrowser !== null) {
      try {
        await this.sharedBrowser.close();
      } catch {
        // 已崩：忽略
      }
      this.sharedBrowser = null;
    }
    this.hardResetCount++;
    this.onEvent?.('browser.reset', { reason, at: this.now() });
  }

  private async closeEntry(e: CtxEntry, reason: string): Promise<void> {
    this.ctxs.delete(e.key);
    try {
      await e.ctx.close();
    } catch {
      // 崩溃的 context close 会抛：忽略（下次调用前自动重开，EX §6.2）
    }
    if (!e.persistent && e.browser !== null && e.browser === this.sharedBrowser) {
      // ephemeral 共享浏览器在所有 ephemeral context 关闭后才关
      let stillUsed = false;
      for (const other of this.ctxs.values()) {
        if (other.browser === e.browser) stillUsed = true;
      }
      if (!stillUsed) {
        try {
          await e.browser.close();
        } catch {
          // 忽略
        }
        this.sharedBrowser = null;
      }
    }
    this.onEvent?.('browser.reset', { key: e.key, reason });
  }

  /** EX §6.3：browser.close(identity) —— 关 context，profile 留卷上。 */
  async closeIdentity(identity: string | null | undefined): Promise<boolean> {
    const key = isPersistentIdentity(identity) ? identityHash(identity as string) : 'ephemeral';
    const e = this.ctxs.get(key);
    if (e === undefined) return false;
    await this.closeEntry(e, 'explicit_close');
    return true;
  }

  /**
   * EX §8 profile 卷回收：清 chromium 缓存目录（水位 80% 时由空闲期调用）。
   * 仅在 context 关闭时才清（design 逐字：unlink，context 关闭时才清）。
   */
  async cleanProfileCaches(): Promise<string[]> {
    const cleared: string[] = [];
    // EX §8 逐字点名的可清理项（glob 语义，实际 unlink 在容器内执行）：
    const targets = [
      'Default/Cache',
      'Default/Code Cache',
      'Default/GPU Cache',
      'Default/Service Worker',
      'Crashpad',
    ];
    for (const e of [...this.ctxs.values()]) {
      if (e.inflight > 0) continue; // context 关闭时才清（design 逐字）
      if (!e.persistent) continue; // ephemeral 无卷上 profile
      for (const t of targets) cleared.push(t);
    }
    return cleared;
  }

  /** in-flight 计数（server.ts 在工具前后调，busy 判据）。 */
  enter(key: string): void {
    const e = this.ctxs.get(key);
    if (e !== undefined) {
      e.inflight++;
      e.lastUsedAt = this.now();
    }
  }

  exit(key: string): void {
    const e = this.ctxs.get(key);
    if (e !== undefined && e.inflight > 0) e.inflight--;
  }

  /**
   * 页数 +1（EX §6.1 每 profile 并发页面上限的记账口）。
   * 与 `enter/exit`（busy 判据）**分开**：原实现用 enter 累计页数，
   * 而 enter 还兼 in-flight，两个语义互相污染（审码 issue E/F）。
   */
  notePage(key: string): void {
    const e = this.ctxs.get(key);
    if (e !== undefined) e.pages++;
  }

  /** 当前该身份的并发页数（上限判据）。 */
  pageCount(key: string): number {
    return this.ctxs.get(key)?.pages ?? 0;
  }

  stats(): {
    running: boolean;
    contexts: number;
    hardResets: number;
    pages: Record<string, number>;
    inflight: Record<string, number>;
  } {
    const pages: Record<string, number> = {};
    const inflight: Record<string, number> = {};
    for (const [k, e] of this.ctxs) {
      pages[k] = e.pages;
      inflight[k] = e.inflight;
    }
    return {
      running: this.ctxs.size > 0,
      contexts: this.ctxs.size,
      hardResets: this.hardResetCount,
      pages,
      inflight,
    };
  }

  async closeAll(): Promise<void> {
    for (const e of [...this.ctxs.values()]) await this.closeEntry(e, 'shutdown');
    if (this.sharedBrowser !== null) {
      try {
        await this.sharedBrowser.close();
      } catch {
        // 忽略
      }
      this.sharedBrowser = null;
    }
  }

  /** DISPLAY（EX §6.1：Xvfb :99）。 */
  get displayEnv(): string {
    return this.display;
  }
}

/** 浏览器崩溃 → 当次调用返回 error{code:'browser_crashed', retryable:true}（EX §6.2）。 */
export function browserCrashed(callId: string, cause: unknown): ToolResult {
  return errorResult(callId, ERROR_CODES.browser_crashed, `chromium 崩溃：${String(cause)}`, true);
}

export function browserOk(callId: string, result: unknown): ToolResult {
  return okResult(callId, result);
}
