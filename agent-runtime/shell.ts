/**
 * agent-runtime/shell.ts —— shell.run（EX §7 + §5.5 + §7.1）。
 *
 * 设计原文（execution.md §7 表末行）：
 *   `shell.run` = `bash -c`（修订：不再是 `bash -lc`），cwd=/dot/home，
 *   超时必填；输出各截 1MB；**env 白名单**（PATH,HOME,LANG,DISPLAY +
 *   注入的模型 base_url 变量，DOTD_* 全剥）；秘密防护见 §7.1；
 *   进程组隔离可 kill；无 tty。
 *
 * §7.1（uid 隔离）：shell 子进程以 **uid 1001** 运行（runtime=1000），
 * 依赖容器 `CapAdd:[SETUID,SETGID]`；Node 进程降权 spawn 需实测（开放问题 Q7）。
 * 本文件把"如何降权"抽成可注入的 `SpawnAdapter`，使逻辑可在无容器环境测试，
 * 也便于 Q7 结论落地时只换一个实现。
 *
 * 契约 T5 收紧：env **不注入**模型 base_url 变量——容器内工具不得直连模型
 * （契约 T5 / MR 铁律），原 §4.2 的占位注入条款作废。
 */

import { spawn } from 'node:child_process';
import type { ToolResult } from './protocol.ts';
import { ERROR_CODES, SHELL_OUTPUT_MAX_BYTES, errorResult, okResult } from './protocol.ts';
import { HOME_ROOT, resolveHomePath, PathViolationError } from './fs.ts';

/** §7.1：shell 子进程 uid/gid（镜像内 useradd -M -u 1001 shell）。 */
export const SHELL_UID = 1001;
export const SHELL_GID = 1001;
/** runtime 自身 uid（镜像内 useradd -m -u 1000 dot）。 */
export const RUNTIME_UID = 1000;

/** EX §7：env 白名单（契约 T5：不注入模型 base_url 变量）。 */
export const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'DISPLAY', 'SHELL'] as const;

/** 可注入的 spawn 面（Q7 实测落地时替换实现，测试可打桩）。 */
export interface SpawnAdapter {
  /**
   * 起一个 uid=1001 的 `bash -c <cmd>`。
   * 返回句柄：退出码/信号 + 两个已截尾的输出缓冲。
   */
  run(
    cmd: string,
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
      timeoutMs: number;
      uid: number;
      gid: number;
      killSignal: NodeJS.Signals;
      /** 降权不被允许（EPERM/EACCES）时回调：宿主经此知道"本次未降权"。 */
      onDegrade?: (cause: unknown) => void;
    },
  ): Promise<SpawnOutcome>;
}

export interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** true = 被超时/取消杀掉（非自然退出）。 */
  killed: boolean;
  /** true = 请求过降权但系统不允许（已按 runtime 自身 uid 重试）。 */
  degraded?: boolean;
  /** spawn 失败原因（bash 不存在等；与 degraded 不同）。 */
  error?: Error;
}

/**
 * 真实实现（Node 24 原生，容器内经 CapAdd SETUID 生效）。
 *
 * **降权是真的降权**：`spawn` 的 `uid`/`gid` 选项让子进程以 1001 启动
 * （Node 内部走 setuid/setgid）。原实现只把 uid/gid 塞进返回值、spawn
 * 完全不传，导致即便镜像 CapAdd 了 SETUID，shell 仍以 runtime 自身 uid
 * （1000）跑——§7.1 的跨 uid 秘密防护（token 0400 / ledger 0700）不成立
 * （审码 issue B）。
 *
 * 降级语义：进程非 root 或无 SETUID 能力时 spawn 带 uid 会 EPERM。
 * 此时**不伪装成功**——经 `opts.onDegrade` 上报降级事件（宿主可见），
 * 再以 runtime 自身 uid 重试一次，让工具仍可执行。
 */
export const defaultSpawnAdapter: SpawnAdapter = {
  run(cmd, opts): Promise<SpawnOutcome> {
    const base = {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      detached: true, // 进程组隔离（EX §7）
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const drive = (child: ReturnType<typeof spawn>, degraded = false): Promise<SpawnOutcome> =>
      new Promise<SpawnOutcome>((resolvePromise) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let settled = false;
        const cap = (s: string, add: string): string => {
          s += add;
          return s.length > SHELL_OUTPUT_MAX_BYTES ? s.slice(0, SHELL_OUTPUT_MAX_BYTES) : s;
        };
        const timer = setTimeout(() => {
          killed = true;
          try {
            process.kill(-child.pid!, opts.killSignal); // 负 pid = 整个进程组
          } catch {
            child.kill(opts.killSignal);
          }
        }, opts.timeoutMs);
        child.stdout?.on('data', (d: Buffer) => {
          stdout = cap(stdout, d.toString('utf8'));
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr = cap(stderr, d.toString('utf8'));
        });
        const settle = (o: SpawnOutcome): void => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolvePromise({ ...o, ...(degraded ? { degraded: true } : {}) });
          }
        };
        child.on('error', (err: Error) => {
          const e = err as NodeJS.ErrnoException;
          if (!degraded && (e.code === 'EPERM' || e.code === 'EACCES')) {
            // 降权不被允许（非 root / 无 CapAdd SETUID）：如实上报 + 降级重试
            clearTimeout(timer);
            opts.onDegrade?.(err);
            void drive(spawn('bash', ['-c', cmd], base), true).then(settle);
            return;
          }
          settle({ code: -1, signal: null, stdout, stderr, killed, error: err });
        });
        child.on('close', (code, signal) => settle({ code, signal, stdout, stderr, killed }));
      });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['-c', cmd], { ...base, uid: opts.uid, gid: opts.gid });
    } catch (e) {
      // 同步抛（极少见）：同样按降级处理
      opts.onDegrade?.(e);
      child = spawn('bash', ['-c', cmd], base);
      return drive(child, true);
    }
    return drive(child);
  },
};

export interface ShellRunArgs {
  cmd: string;
  timeout_ms: number;
  cwd?: string;
}

/** 解析 shell.run 参数（EX §7：超时必填）。 */
export function parseShellArgs(args: Record<string, unknown>): ShellRunArgs {
  const cmd = args.cmd;
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw new PathViolationError('shell.run 需要非空 cmd', ERROR_CODES.bad_args);
  }
  const timeout = args.timeout_ms;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
    throw new PathViolationError('shell.run 需要正整数 timeout_ms（超时必填）', ERROR_CODES.bad_args);
  }
  const cwd = args.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new PathViolationError('cwd 必须是字符串', ERROR_CODES.bad_args);
  }
  return { cmd, timeout_ms: timeout, ...(cwd !== undefined ? { cwd } : {}) };
}

/**
 * env 白名单（EX §7 逐字 + 契约 T5 收紧）：
 *   只放行 PATH, HOME, LANG, DISPLAY, SHELL；其余一律不传。
 *
 * "剥光 DOTD_*"由**白名单本身**保证：out 只从 ENV_WHITELIST 取键，
 * DOTD_* 与 OPENAI_BASE_URL 等根本进不来。原实设在白名单之后又加一圈
 * `delete out[key]`，删的是从未被加入的键——no-op，且给人以双保险已
 * 生效的错觉（审码 issue L）。契约 T5「容器内工具不得直连模型」靠的是
 * **不注入**，而不是注入后再删。
 */
export function buildShellEnv(
  parentEnv: Record<string, string | undefined>,
  home = HOME_ROOT,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_WHITELIST) {
    const v = key === 'HOME' ? home : parentEnv[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface ShellToolsDeps {
  spawnAdapter?: SpawnAdapter;
  /** home 卷根（容器内恒 `/dot/home`；测试注入临时目录）。 */
  homeRoot?: string;
  /** 进程是否具备 setuid 能力（Q7 实测结论注入；false = 记降级事件但仍执行）。 */
  canSetUid?: () => boolean;
  uid?: number;
  gid?: number;
  /** 降级事件出口（EX §10 事件流：exec.shell.uid_degraded）。 */
  onDegrade?: (detail: Record<string, unknown>) => void;
}

export class ShellTools {
  private readonly adapter: SpawnAdapter;
  private readonly homeRoot: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly canSetUid: () => boolean;
  private readonly onDegrade?: (detail: Record<string, unknown>) => void;

  constructor(deps: ShellToolsDeps = {}) {
    this.adapter = deps.spawnAdapter ?? defaultSpawnAdapter;
    this.homeRoot = deps.homeRoot ?? HOME_ROOT;
    this.uid = deps.uid ?? SHELL_UID;
    this.gid = deps.gid ?? SHELL_GID;
    this.canSetUid = deps.canSetUid ?? (() => process.getuid?.() === 0);
    this.onDegrade = deps.onDegrade;
  }

  /**
   * 执行 shell.run（EX §5.5：bash -c args.cmd, cwd=/dot/home, env 剥离 DOTD_*，
   * 独立进程组, 输出流式截尾, args.timeout_ms≤deadline）。
   *
   * @param deadlineMs 调用方给的硬超时（ToolCall.deadline_ms）；timeout_ms 必须 ≤ 它。
   */
  async run(
    callId: string,
    args: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<ToolResult> {
    let parsed: ShellRunArgs;
    try {
      parsed = parseShellArgs(args);
    } catch (e) {
      return errorResult(
        callId,
        e instanceof PathViolationError ? e.code : ERROR_CODES.bad_args,
        String(e instanceof Error ? e.message : e),
        false,
      );
    }
    if (parsed.timeout_ms > deadlineMs) {
      return errorResult(
        callId,
        ERROR_CODES.bad_args,
        `timeout_ms(${parsed.timeout_ms}) 超过 deadline_ms(${deadlineMs})`,
        false,
      );
    }
    // cwd 也走 home 护栏（EX §7：cwd=/dot/home；显式 cwd 必须同沙箱）
    let cwd = this.homeRoot;
    if (parsed.cwd !== undefined) {
      try {
        cwd = resolveHomePath(parsed.cwd, { homeRoot: this.homeRoot }).abs;
      } catch (e) {
        return errorResult(
          callId,
          e instanceof PathViolationError ? e.code : ERROR_CODES.bad_args,
          String(e instanceof Error ? e.message : e),
          false,
        );
      }
    }
    const started = Date.now();
    let degraded = false;
    const wantUid = this.canSetUid();
    const outcome = await this.adapter.run(parsed.cmd, {
      cwd,
      env: buildShellEnv(process.env, this.homeRoot),
      timeoutMs: Math.min(parsed.timeout_ms, deadlineMs),
      uid: wantUid ? this.uid : RUNTIME_UID,
      gid: wantUid ? this.gid : RUNTIME_UID,
      killSignal: 'SIGKILL',
      onDegrade: (cause) => {
        degraded = true;
        this.onDegrade?.({
          kind: 'exec.shell.uid_degraded',
          requested_uid: this.uid,
          fallback_uid: RUNTIME_UID,
          cause: String(cause),
          at: new Date().toISOString(),
        });
      },
    });
    if (!wantUid) {
      // 进程根本不具备 setuid 条件（非 root）：如实标记，不向宿主伪装降权
      degraded = true;
      this.onDegrade?.({
        kind: 'exec.shell.uid_degraded',
        requested_uid: this.uid,
        fallback_uid: RUNTIME_UID,
        cause: 'runtime 非 root 或无 CapAdd SETUID（canSetUid=false）',
        at: new Date().toISOString(),
      });
    }
    const wall = Date.now() - started;
    const usage = { wall_ms: wall, peak_mem_mb: 0 };
    if (outcome.killed) {
      return errorResult(
        callId,
        ERROR_CODES.deadline_exceeded,
        `shell.run 超时（timeout_ms=${parsed.timeout_ms}）`,
        true,
        { result: { exit_code: null, stdout: outcome.stdout, stderr: outcome.stderr }, usage },
      );
    }
    return okResult(
      callId,
      {
        exit_code: outcome.code,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stdout_truncated: outcome.stdout.length >= SHELL_OUTPUT_MAX_BYTES,
        stderr_truncated: outcome.stderr.length >= SHELL_OUTPUT_MAX_BYTES,
        /**
         * 如实回报**实际** uid（EX §7.1 / 审码 issue B）：
         * - 系统允许降权 → SHELL_UID（1001）
         * - EPERM/EACCES 降级 → RUNTIME_UID（1000）+ `degraded:true`
         * 绝不伪装：原实现不看 spawn 结果，root 进程下会向宿主误报 1001。
         */
        uid: outcome.degraded === true || degraded ? RUNTIME_UID : this.uid,
        degraded: outcome.degraded === true || degraded,
      },
      usage,
    );
  }
}
