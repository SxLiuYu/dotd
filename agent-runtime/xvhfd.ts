/**
 * agent-runtime/xvhfd.ts —— Xvfb 生命周期（EX §6.1）。
 *
 * 设计原文：
 * - 「Xvfb 由 agent-runtime 启动时 spawn（`Xvfb :99`，`DISPLAY=:99`），
 *   随进程存活，崩溃视同 runtime 崩溃（healthcheck 失败→recreate）」
 *   （execution.md §6.1）
 * - 「Xvfb 由 agent-runtime 启动时自行拉起（`xvfb-run` 或 spawn `Xvfb :99`，
 *   见 §6.1），非 Docker init 进程」（execution.md §3.1 注）
 *
 * 因此本模块只做一件事：保证 `DISPLAY=:99` 背后有一个活着的 Xvfb；
 * 崩溃时**不自行重开**（视同 runtime 崩溃，交给宿主 recreate），只如实上报。
 *
 * 隔离：`XvfbSpawn` 可注入，容器外测试用假实现（不起真 X 服务）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const XVFB_DISPLAY = ':99';
export const XVFB_SCREEN = '1280x900x24';

export type XvfbExitInfo = { code: number | null; signal: NodeJS.Signals | null };

export interface XvfbSpawn {
  /**
   * 起 `Xvfb :99 -screen 0 1280x900x24`。
   * 返回 false = 启动失败（如镜像内没装 xvfb）。
   */
  start(cmd: string, args: string[], env: Record<string, string | undefined>): boolean;
  /** 停掉（SIGTERM）。 */
  stop(): void;
  /** 进程是否还活着。 */
  alive(): boolean;
  /** 订阅退出（崩溃通知）。 */
  onExit(cb: (info: XvfbExitInfo) => void): void;
}

/** 真实实现（镜像内 apt 已装 xvfb，execution.md §3.1）。 */
export class NodeXvfbSpawn implements XvfbSpawn {
  private child: ChildProcess | null = null;
  private readonly exits = new Set<(info: XvfbExitInfo) => void>();

  start(cmd: string, args: string[], env: Record<string, string | undefined>): boolean {
    if (this.child !== null && this.child.exitCode === null) return true;
    // detached + 自有进程组：Xvfb 若 fork 出辅助进程，stop() 时能整组收掉，
    // 不留孤儿（原实现无 detached，宿主侧只能看到主 pid——审码 issue O）。
    const child = spawn(cmd, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: true,
    });
    // 让父进程不因子进程的 exit 事件被保持存活（我们显式管生命周期）
    child.unref();
    this.child = child;
    const notify = (info: XvfbExitInfo): void => {
      for (const cb of [...this.exits]) cb(info);
    };
    child.on('exit', (code, signal) => notify({ code, signal }));
    child.on('error', () => notify({ code: null, signal: null }));
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
    try {
      // 负 pid = 整个进程组（detached 时 Xvfb 是组长）
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出
      }
    }
  }

  alive(): boolean {
    return this.child !== null && this.child.exitCode === null && child_alive(this.child);
  }

  onExit(cb: (info: XvfbExitInfo) => void): void {
    this.exits.add(cb);
  }
}

function child_alive(child: ChildProcess): boolean {
  // ChildProcess 没有 isAlive() 的稳定语义，用 pid + exitCode 组合判定。
  return child.pid !== undefined && child.exitCode === null;
}

/**
 * Xvfb 管理器。
 *
 * 事件（经 EventEmitter）：
 * - `ready`：DISPLAY 可用
 * - `crashed`：Xvfb 退出 → 上报宿主（healthcheck 将失败 → recreate）
 */
export class XvfbManager extends EventEmitter {
  private readonly spawnImpl: XvfbSpawn;
  private readonly display: string;
  private started = false;

  constructor(opts: { spawnImpl?: XvfbSpawn; display?: string } = {}) {
    super();
    this.spawnImpl = opts.spawnImpl ?? new NodeXvfbSpawn();
    this.display = opts.display ?? XVFB_DISPLAY;
    this.spawnImpl.onExit(() => {
      if (!this.started) return; // 未启动前的退出不误报
      this.started = false;
      this.emit('crashed', { display: this.display });
    });
  }

  /** 启动（幂等：已在跑则直接返回 true）。 */
  start(): boolean {
    if (this.started && this.spawnImpl.alive()) return true;
    const ok = this.spawnImpl.start('Xvfb', [this.display, '-screen', '0', XVFB_SCREEN], process.env);
    if (!ok) {
      this.emit('crashed', { display: this.display, reason: 'spawn_failed' });
      return false;
    }
    this.started = true;
    this.emit('ready', { display: this.display });
    return true;
  }

  stop(): void {
    if (!this.started) return;
    this.spawnImpl.stop();
    this.started = false;
  }

  get alive(): boolean {
    return this.started && this.spawnImpl.alive();
  }

  get displayEnv(): string {
    return this.display;
  }

  /** 供 shell env 注入（浏览器已移到宿主，不再需要它）。 */
  envPatch(): Record<string, string> {
    return { DISPLAY: this.display };
  }
}
