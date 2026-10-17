/**
 * src/exec/ExecService.ts —— 执行面对外唯一入口（execution.md §10）。
 *
 * 控制面/治理/记忆/Runner 都只经本服务与执行面交互（S1–S7）。实现要点：
 *  - runTool：非阻塞，resolve 于终态 ToolResult 或 deadline；端点选择 = catalog[tool].mode
 *    （不看时长）；degraded 闸门下**未发送即返回 docker_unavailable(retryable)**（§2.2/评审 #10）。
 *  - 幂等（S1）：同 call_id 至多执行一次工具体；exec_calls 是协议层发送/回执镜像；
 *    exec 永不自动重试（重派换新 call_id 属 journal 决定）。
 *  - cancelTool：幂等；sync 只标本地 timeout，async 经 exec_calls.job_id 走
 *    POST /jobs/{job_id}/cancel。
 *  - getCapabilities：词表（J2 sideEffect）+ mode；治理 tools.yml 登记名必须 ⊆ 本集合。
 *  - setEgressWhitelist → HostNetGuard（§2.1-2）。
 *  - suspendDot/resumeDot（契约 J5：pause/unpause 幂等路径）、destroyDotContainer、
 *    getDotStatus、setIdentityProfile、getContainerStats（J5）。
 *  - fsOps：契约 S4'/M4 的 `/fs/ops` 桥（MEM 注入读取/索引对账/原子写；仅宿主 token 可调）。
 *  - 事件流（§10）：exec.container.{state_change,unhealthy,quarantined} /
 *    exec.call.{started,finished,interrupted} / exec.browser.{crashed,reset} /
 *    exec.disk.{pressure,gardened} / exec.docker.unavailable。
 *
 * DOTD_FLEET=stub：容器与 agent-runtime 都由内存假实现承担（不起 Docker、不发 HTTP），
 * 但**协议形状、幂等 ledger、状态机全部保留**（CONVENTIONS.md §7）。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type {
  Capability,
  ContainerStats,
  ExecService,
  ExecToolCall,
  ExecToolResult,
} from '../shared/contracts.ts';
import { DiskGardener } from './disk.ts';
import { Fleet, createDockerBackend, createStubBackend } from './fleet.ts';
import { HostNetGuard } from './netguard.ts';
import { ImageManager } from './image.ts';
import { createStubRuntime } from './stub-runtime.ts';
import { HttpRuntime } from './http-runtime.ts';
import {
  CAPABILITY_CATALOG,
  FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
  RUNTIME_PATHS,
  argsHash,
  checkHomePath,
  endpointUrl,
  identityHash,
  resultHash,
  tokenHash,
  validateToolCall,
} from './protocol.ts';
import type {
  BootReport,
  ContainerBackend,
  DotStatusSnapshot,
  ExecConfig,
  FsOpsRequest,
  FsOpsResponse,
  ReconcileEntry,
  RuntimeClient,
} from './types.ts';
import { DEFAULT_EXEC_CONFIG } from './types.ts';
import type { StubRuntime, StubRuntimeOptions } from './stub-runtime.ts';

// ═══════════════════════════════════════════════════════════════════
// 在途心跳接缝（P0-3 看门狗误回收）
// ═══════════════════════════════════════════════════════════════════

/**
 * 在途心跳回调（**由装配层注入**，EX 绝不 import CP、更不直写 tasks 表——
 * CONVENTIONS §4 模块边界：EX → CP 只能经注入的回调）。
 *
 * 语义要点（这是"修误杀不能换来永不回收"的关键）：
 *  - EX 只在**上游确实有推进**时调它：`pollJob` 里每轮 `GET /jobs/{id}` **成功返回**
 *    之后一次（含读到终态的那次）。`getJob` 抛错（连接拒绝/5xx）、容器被运行期判死、
 *    本地 deadline 到期 —— 这几种情况**一律不回调**，因此心跳会自然停下，
 *    看门狗 `heartbeatTimeoutMs` 之后照常回收。
 *  - 即"心跳 = 容器还活着的证据"，不是"Runner 协程还在跑的证据"。
 *  - 回调自身抛错只记日志：心跳是附带动作，绝不影响工具结果（判死另有看门狗）。
 */
export interface ExecLiveness {
  live(input: { taskId: string; epoch: number; callId: string; dotId: string; tool: string; now: number }): void;
}

/**
 * 工具调用的 deadline 口径（P0-3 顺带核出的一处分叉）。
 *
 * 事实（实测）：`CAPABILITY_CATALOG` 里 async 工具自带 `max_deadline_ms`（shell.run=1_800_000，
 * 逐字等于 `ExecConfig.asyncDeadlineMs`），而 `validateToolCall` 只**校验**它、不会替你抬。
 * Runner 过去把 `toolDeadlineMs`（缺省 60s，语义正是"sync 上限"）**不加区分**地发给所有工具，
 * 于是 `shell.run` 这类异步工具拿到的 `deadline_ms` 只有 60s：3 分钟以上的工具根本轮不到
 * 看门狗出手，本地 deadline 就先把它标成 timeout（任务重跑，副作用干两遍）。
 *
 * 修复口径：**async 工具按它自己声明的 max_deadline_ms 封顶**；调用方给的值只能在更小时
 * 收紧（同步工具保持原样——它本来就是 60s 档，按调用方口径）。
 * 这同时保证"容器端声明的上限"与"宿主派发的请求"不会再次分叉。
 *
 * 谁负责选档：Runner 侧 `toolDeadlineMsFor()` 按 catalog mode 选（async → 不传/传上限，
 * sync → 传 toolDeadlineMs）；本函数只是把"缺省"填成同一套常量，供两者复用。
 */
export function resolveToolDeadlineMs(tool: string, requested: number | undefined): number {
  const cap = CAPABILITY_CATALOG.find((c) => c.name === tool);
  if (cap?.mode !== 'async') return requested ?? DEFAULT_EXEC_CONFIG.syncDeadlineMs;
  return requested ?? (cap.max_deadline_ms > 0 ? cap.max_deadline_ms : DEFAULT_EXEC_CONFIG.asyncDeadlineMs);
}

/**
 * `pollJob` 单轮取数的语义内核（**抽出来只为可测**）。
 *
 * 一轮 = **恰好一次** `GET /jobs/{id}`：
 *  - 返回**非 running**（终态）：不续心跳（没有"在途"可言），原样返回；
 *  - 返回 **running**：这是"上游确实在推进"的唯一证据 → 续**一次**心跳，原样返回；
 *  - `getJob` 抛错：不续心跳，异常原样冒泡（由 pollJob 走 probeHealth 分支）。
 *
 * ⚠ 这里**绝不能**写成"循环取数直到非 running"：pollJob 自己负责 sleep 与
 * 容器状态守卫，把循环搬进来会 (a) 让运行期守卫（容器转 unhealthy → 立刻收手）
 * 永远等不到执行、(b) 把本来 500ms 一轮的轮询变成零间隔忙等。
 * 心跳是附带动作用：回调抛错只记日志，绝不影响工具结果。
 */
export async function pollJobOnceWithLiveness(
  getJob: () => Promise<ExecToolResult>,
  input: { taskId: string; epoch: number; callId: string; dotId: string; tool: string },
  liveness: ExecLiveness | null,
  now: () => number = Date.now,
  onLivenessError: (err: unknown) => void = () => {},
): Promise<ExecToolResult> {
  const res = await getJob();
  if (res.status === 'running' && liveness !== null) {
    try {
      liveness.live({ ...input, now: now() });
    } catch (err) {
      onLivenessError(err);
    }
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════════
// 服务实现
// ═══════════════════════════════════════════════════════════════════

export interface ExecServiceDeps {
  db: DatabaseSync;
  bus: EventBus;
  cfg?: Partial<ExecConfig>;
  /** 依赖注入（测试替身）；缺省时按 cfg.fleet 自建。 */
  backend?: ContainerBackend;
  runtime?: RuntimeClient;
  /** stub 后端的运行时行为预设（DOTD_FLEET=stub）。 */
  stubRuntime?: StubRuntimeOptions;
  /**
   * 在途心跳回调（P0-3；装配层把 CP 的 heartbeat 接进来，EX 不感知 CP）。
   * 也可装配后用 `setLiveness()` 注入。
   */
  liveness?: ExecLiveness;
  /** 时钟（测试注入虚拟时间用；缺省 Date.now）。 */
  clock?: () => number;
}

export class ExecServiceImpl implements ExecService {
  readonly cfg: ExecConfig;
  readonly fleet: Fleet;
  readonly images: ImageManager;
  readonly netguard: HostNetGuard;
  readonly disk: DiskGardener;

  private readonly backend: ContainerBackend;
  private runtime: RuntimeClient | null;
  private readonly stub: StubRuntime | null;
  /** 能力目录缓存（J2：CP 从 getCapabilities 缓存读 sideEffect）。 */
  private capCache: Capability[] | null = null;
  /** 进行中的轮询（call_id → AbortController 近似：用标志位取消协作）。
   *  条目在 runTool 的 finally 里删掉——否则每次 cancelTool 都留一个永久的
   *  call_id，长跑进程里无界增长（2026-10-17 修：全库没有任何 delete）。 */
  private readonly cancelled = new Set<string>();
  /** 本地 in-flight 计数（busy↔ready 收敛用）。 */
  private inflight = new Map<string, number>();
  /** 在途心跳回调（P0-3：轮询驱动；只看"上游确实答了一次"）。 */
  private liveness: ExecLiveness | null;
  /** 时钟（测试注入虚拟时间；生产恒 Date.now）。 */
  private readonly clock: () => number;

  constructor(private readonly deps: ExecServiceDeps) {
    this.liveness = deps.liveness ?? null;
    this.clock = deps.clock ?? Date.now;
    // 默认值集中在 src/exec/types.ts 的 DEFAULT_EXEC_CONFIG（§7「集中定义」）；
    // 此处只做覆盖合并，不再维护第二份字面量（审码：双份定义会静默分叉）。
    const base: ExecConfig = { ...DEFAULT_EXEC_CONFIG, ...deps.cfg };
    this.cfg = base;

    if (deps.backend !== undefined) {
      this.backend = deps.backend;
      this.stub = null;
    } else if (base.fleet === 'stub') {
      this.backend = createStubBackend({ cfg: base });
      this.stub = createStubRuntime({ cfg: base, backend: this.backend, opts: deps.stubRuntime });
    } else {
      this.backend = createDockerBackend(base);
      this.stub = null;
    }
    // 真实 docker 路径默认装配 HTTP 客户端（§5.2 端点表）；daemon 装配层仍可显式注入覆盖。
    this.runtime = deps.runtime ?? (base.fleet === 'stub' ? this.stub : new HttpRuntime());

    this.fleet = new Fleet({
      db: deps.db,
      bus: deps.bus,
      cfg: base,
      backend: this.backend,
      // 构建后触发 DiskGardener（§8 节律）：ensureImageAndTend 见本文件
      ensureImage: () => this.ensureImageAndTend(),
      installNetGuard: () => this.netguard.install(),
      readToken: (dotId) => this.readToken(dotId),
      writeToken: (dotId, token) => this.writeToken(dotId, token),
    });
    this.images = new ImageManager({ db: deps.db, bus: deps.bus, cfg: base, backend: this.backend });
    this.netguard = new HostNetGuard({ bus: deps.bus, cfg: base, backend: this.backend });
    this.disk = new DiskGardener({
      db: deps.db,
      bus: deps.bus,
      cfg: base,
      backend: this.backend,
      hasInflight: (dotId) => this.fleet.hasInflightCall(dotId),
      cleanProfileCaches: async (dotId) => this.cleanProfileCaches(dotId),
    });

    // 装配协议探针（fleet 不 import HTTP/协议客户端，避免反向依赖）
    this.fleet.setHealthProbe((dotId) => this.probeHealth(dotId));
    this.fleet.setRawHealthProbe((endpoint, token) => this.probeHealthRaw(endpoint, token));
    this.fleet.setCallQuery((endpoint, token, callId) => this.getCallRaw(endpoint, token, callId));
    if (this.stub !== null) {
      this.fleet.setStubLedger(this.stub.ledger);
    }
  }

  // ── token 文件（§2.1-4/§5.1：WSL 本地文件系统，非卷）─────────────

  private tokenDir(): string {
    return this.cfg.tokenDir;
  }

  private async writeToken(dotId: string, token: string): Promise<void> {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    try {
      mkdirSync(this.tokenDir(), { recursive: true });
      // 必须 0644：`:ro` bind 不映射属主，容器以 USER dot（uid 1000）读 /run/dotd/token，
      // 0600 root 属主会 EACCES 直接崩掉 agent-runtime（WSL 实测 exit 1）。
      // 宿主侧全局可读的代价可接受：token 的防护面是网络 Bearer，不是宿主本地用户。
      writeFileSync(`${this.tokenDir()}/${dotId}.token`, token, { mode: 0o644 });
    } catch {
      // 非 WSL/无权限：token 仅在内存（stub 测试路径），不阻塞状态机
    }
  }

  private async readToken(dotId: string): Promise<string | null> {
    const { readFileSync } = await import('node:fs');
    try {
      return readFileSync(`${this.tokenDir()}/${dotId}.token`, 'utf8');
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // §10 boot
  // ═══════════════════════════════════════════════════════════════════

  /** daemon 启动（§13.1 顺序：ping → ensureImage → HostNetGuard → reconcile → create/boot）。 */
  async boot(dotIds: string[]): Promise<BootReport> {
    for (const d of dotIds) this.fleet.registerDot(d);
    const report = await this.fleet.boot(dotIds);
    if (report.dockerAvailable) {
      // DockerGardener 每次构建后/启动时跑一次（§8 节律）；失败不影响 boot
      await this.tendDisk();
    }
    return report;
  }

  /**
   * §8 节律的宿主侧触发点：镜像**构建后**跑一次 DiskGardener。
   * `built=true` 才跑（秒回路径不跑，避免无意义的全盘采集）。
   * 失败静默——磁盘采集/回收绝不阻塞建镜像这条主路径。
   */
  async ensureImageAndTend(): Promise<{ tag: string; digest: string | null; ready: boolean; built: boolean }> {
    const r = await this.images.ensureImage();
    if (r.built) await this.tendDisk();
    return r;
  }

  /** DiskGardener 单次运行（§8：6h cron / 构建后；失败不抛）。 */
  async tendDisk(): Promise<void> {
    try {
      await this.disk.runOnce();
    } catch {
      // 磁盘采集失败不阻塞主路径
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // §10 runTool / cancelTool
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 派发一个已放行调用；非阻塞，resolve 于终态 ToolResult 或 deadline。
   *
   * 幂等（S1/§5.4）：
   *  1. 同 call_id 的 exec_calls 已 done/error/cancelled → 直接落库结果回报（重放回执）；
   *  2. degraded → 未发送即返回 docker_unavailable(retryable)（§2.2，journal 保持 call_sent）；
   *  3. 校验失败（unknown_tool/deadline/路径护栏）→ 本地 error，不发送；
   *  4. 否则按 catalog mode 选端点派发，落 exec_calls。
   */
  async runTool(call: ExecToolCall): Promise<ExecToolResult> {
    const at = new Date().toISOString();

    // ① 幂等重放：exec_calls 已有终态
    const seen = this.fleet.getCall(call.call_id);
    if (seen !== null && seen.state !== 'sent' && seen.state !== 'running') {
      return {
        call_id: call.call_id,
        job_id: seen.job_id ?? undefined,
        status: seen.state === 'done' ? 'ok' : seen.state === 'cancelled' ? 'cancelled' : 'error',
        result: seen.state === 'done' ? { result_hash: seen.result_hash } : undefined,
        error:
          seen.state === 'error'
            ? { code: seen.error_code ?? 'error', message: '回放历史失败结果', retryable: false }
            : undefined,
        finished_at: seen.finished_at ?? at,
      };
    }

    // ② degraded 闸门（§2.2）
    if (this.fleet.degraded) {
      this.fleet.failCall(call.call_id, 'docker_unavailable', call);
      this.deps.bus.publish('exec.call.finished', {
        callId: call.call_id,
        dotId: call.dot_id,
        taskId: call.task_id,
        tool: call.tool,
        mode: this.modeOf(call.tool),
        status: 'error',
        errorCode: 'docker_unavailable',
        wallMs: 0,
        at,
      });
      return {
        call_id: call.call_id,
        status: 'error',
        error: {
          code: 'docker_unavailable',
          message: 'docker 不可用：未发送（journal 保持 call_sent，无重复执行风险）',
          retryable: true,
        },
        finished_at: at,
      };
    }

    // ③ 本地校验（含 §7 硬护栏）
    const invalid = validateToolCall(this.cfg, call);
    if (invalid !== null && invalid !== undefined) {
      this.fleet.failCall(call.call_id, invalid.code, call);
      return { call_id: call.call_id, status: 'error', error: invalid, finished_at: at };
    }

    const mode = this.modeOf(call.tool);
    const aHash = argsHash(call.args);
    // wake-on-demand：节能档（idle/suspended）不是错误，是待唤醒——派发前原地唤醒。
    // 死锁实测（WSL 2026-10-16）：guard 在 guarded 档 pause 空转容器后，派发路径只会
    // 用 container_not_ready 拒绝，等 guard 解冻回升；水位不回升（netfuzz 基线噪声）
    // 容器就永久 sleeping、任务烧光预算。唤醒归派发路径管，解冻只兜底。
    await this.wakeForDispatch(call.dot_id);
    const row = this.fleet.getContainer(call.dot_id);
    const endpoint = row?.endpoint ?? null;
    const token = await this.fleet.currentToken(call.dot_id);

    // 容器未 ready（absent/stopped/...）：不发送
    if (row === null || !canTake(row.state) || endpoint === null || token === null) {
      this.fleet.failCall(call.call_id, 'container_not_ready', call);
      return {
        call_id: call.call_id,
        status: 'error',
        error: {
          code: 'container_not_ready',
          message: `容器状态 ${row?.state ?? 'absent'} 不可派发（需 ready）`,
          retryable: true,
        },
        finished_at: at,
      };
    }

    // ④ 状态机 ready→busy（§4.1：领取调用）
    const prev = this.incInflight(call.dot_id);
    if (prev === 0) this.fleet.transition(call.dot_id, 'busy', { reason: 'runTool' });
    this.fleet.touchBusy(call.dot_id);
    this.fleet.recordCallSent(call, mode, null, aHash);
    this.deps.bus.publish('exec.call.started', {
      callId: call.call_id,
      dotId: call.dot_id,
      taskId: call.task_id,
      tool: call.tool,
      mode,
      at,
    });

    try {
      const res = await this.dispatch(endpoint, token, call, mode);
      return await this.settle(call, mode, res, at);
    } catch (cause) {
      return await this.failDispatch(call, mode, cause, at);
    } finally {
      // 取消标志只用在这一趟派发里：终态即销户，别让 Set 无界长个。
      this.cancelled.delete(call.call_id);
      const left = this.decInflight(call.dot_id);
      if (left === 0 && this.fleet.getContainer(call.dot_id)?.state === 'busy') {
        this.fleet.transition(call.dot_id, 'ready', { reason: 'calls drained' });
      }
    }
  }

  /**
   * 在途心跳回调的装配后注入点（CLI/daemon 装配顺序：先建 EX，再建 CP，
   * 心跳回调要拿到 CP，故不能只在构造参数里给）。传 null 关闭。
   */
  setLiveness(liveness: ExecLiveness | null): void {
    this.liveness = liveness;
  }

  /**
   * 按 catalog mode 派发（§5.2/§10）。
   */
  private async dispatch(
    endpoint: string,
    token: string,
    call: ExecToolCall,
    mode: 'sync' | 'async',
  ): Promise<ExecToolResult> {
    const client = this.requireRuntime();
    if (mode === 'sync') {
      const res = await client.callSync(endpoint, token, call);
      if (res.status === 'running') {
        // sync 端点上不应出现 running；保守当作 error
        return {
          ...res,
          status: 'error',
          error: { code: 'bad_runtime_response', message: 'sync 端点返回 running', retryable: true },
        };
      }
      return res;
    }
    const { job_id } = await client.startJob(endpoint, token, call);
    this.fleet.setCallRunning(call.call_id, job_id);
    this.deps.bus.publish('exec.call.started', {
      callId: call.call_id,
      dotId: call.dot_id,
      taskId: call.task_id,
      tool: call.tool,
      mode,
      jobId: job_id,
      at: new Date().toISOString(),
    });
    // 先续一次：派发本身已经证明上游可达（P0-3：心跳与"容器确实活着"同源）。
    this.beatLive(call);
    return await this.pollJob(endpoint, token, call, job_id);
  }

  /** 续一次在途心跳（回调抛错只记日志：心跳是附带动作）。 */
  private beatLive(call: ExecToolCall): void {
    if (this.liveness === null) return;
    try {
      this.liveness.live({
        taskId: call.task_id,
        epoch: this.epochOf(call.task_id),
        callId: call.call_id,
        dotId: call.dot_id,
        tool: call.tool,
        now: this.clock(),
      });
    } catch (err) {
      // 心跳失败绝不影响工具调用（工具结果才是要保的东西）
      this.deps.bus.publish('exec.call.interrupted', {
        callId: call.call_id,
        dotId: call.dot_id,
        taskId: call.task_id,
        reason: `liveness_error:${errText(err)}`,
        at: new Date().toISOString(),
      });
    }
  }

  /** 当前 run_epoch（心跳围栏用；exec_dots 表不持任务，读 tasks 只读一列）。 */
  private epochOf(taskId: string): number {
    try {
      const row = this.deps.db.prepare('SELECT run_epoch AS e FROM tasks WHERE id=?').get(taskId) as
        | { e: number }
        | undefined;
      return row?.e ?? 0;
    } catch {
      return 0;
    }
  }

  /** 轮询 /jobs/{id} 至 done/error/deadline；deadline 到 → cancel → 标 timeout（§5.5）。 */
  private async pollJob(
    endpoint: string,
    token: string,
    call: ExecToolCall,
    jobId: string,
  ): Promise<ExecToolResult> {
    const client = this.requireRuntime();
    const deadline = this.clock() + call.deadline_ms;
    for (;;) {
      if (this.cancelled.has(call.call_id)) {
        await this.cancelRemote(endpoint, token, jobId);
        this.fleet.cancelCall(call.call_id);
        return {
          call_id: call.call_id,
          job_id: jobId,
          status: 'cancelled',
          finished_at: new Date().toISOString(),
        };
      }
      let res: ExecToolResult;
      // 运行期守卫：容器已被别处判成 unhealthy/lost/removed（健康检查连败、
      // guard 拆除等）时立刻收手。否则轮询会一直打到 deadline 才报 timeout，
      // 任务白烧整段预算，而真正原因（容器已死）藏在错误码后面。
      const live = this.fleet.getContainer(call.dot_id)?.state;
      if (live === 'unhealthy' || live === 'lost' || live === 'removed') {
        await this.cancelRemote(endpoint, token, jobId);
        this.fleet.failCall(call.call_id, 'container_unhealthy');
        return {
          call_id: call.call_id,
          job_id: jobId,
          status: 'error',
          error: {
            code: 'container_unhealthy',
            message: `容器运行期转入 ${live}，本次调用中止（retryable，由重派/重建兜底）`,
            retryable: true,
          },
          finished_at: new Date().toISOString(),
        };
      }
      try {
        // P0-3：本轮**成功**的 GET /jobs 若报 running，就续一次心跳（上游确实在推进的证据）。
        // getJob 抛错时不会回调 → 心跳自然停 → 看门狗照常回收（不掩盖真卡死）。
        // 注意：这里**只取一轮**，sleep/容器守卫/收手判据仍由下面的循环负责。
        res = await pollJobOnceWithLiveness(
          () => client.getJob(endpoint, token, jobId),
          { taskId: call.task_id, epoch: this.epochOf(call.task_id), callId: call.call_id, dotId: call.dot_id, tool: call.tool },
          this.liveness,
          this.clock,
          (err) => {
            this.deps.bus.publish('exec.call.interrupted', {
              callId: call.call_id,
              dotId: call.dot_id,
              taskId: call.task_id,
              reason: `liveness_error:${errText(err)}`,
              at: new Date().toISOString(),
            });
          },
        );
      } catch (cause) {
        // 连接拒绝/5xx → healthcheck 探测（§5.5 失败路径）
        const healthy = await this.probeHealth(call.dot_id);
        if (!healthy) {
          this.fleet.transition(call.dot_id, 'unhealthy', { reason: 'job 轮询失败' });
          this.deps.bus.publish('exec.container.unhealthy', {
            dotId: call.dot_id,
            failures: this.cfg.healthFailLimit,
            error: errText(cause),
            at: new Date().toISOString(),
          });
          throw cause;
        }
        await sleep(this.cfg.pollIntervalMs);
        if (this.clock() > deadline) break;
        continue;
      }
      if (res.status !== 'running') return { ...res, job_id: res.job_id ?? jobId };
      if (this.clock() > deadline) break;
      await sleep(this.cfg.pollIntervalMs);
    }
    // deadline 到：cancel → 标 timeout
    await this.cancelRemote(endpoint, token, jobId);
    this.fleet.failCall(call.call_id, 'timeout');
    return {
      call_id: call.call_id,
      job_id: jobId,
      status: 'error',
      error: { code: 'timeout', message: `deadline_ms=${call.deadline_ms} 已用尽`, retryable: true },
      finished_at: new Date().toISOString(),
    };
  }

  /** 落终态 + 事件（§5.5 journal: UPDATE call_done；状态机 busy→ready 由 runTool 收尾）。 */
  private async settle(
    call: ExecToolCall,
    mode: 'sync' | 'async',
    res: ExecToolResult,
    at: string,
  ): Promise<ExecToolResult> {
    const finishedAt = res.finished_at ?? new Date().toISOString();
    if (res.status === 'ok') {
      this.fleet.finishCall(call.call_id, 'done', res.result, res.job_id ?? null);
    } else if (res.status === 'cancelled') {
      this.fleet.cancelCall(call.call_id);
    } else if (res.error?.code === 'result_compacted') {
      // §5.4-4：调用**确认幂等成功**（容器 ledger 有 done 项），只是结果已被压缩取不回。
      // 落库 done + result_hash（不落 error）——"没有二次执行"这条底线保住，
      // journal 视同 done-但-降级；retryable:false 已由容器侧给出，绝不重派。
      this.fleet.finishCall(call.call_id, 'done', undefined, res.job_id ?? null);
      const hash = (res.result as { hash?: unknown } | undefined)?.hash;
      this.fleet.setCallResultHash(call.call_id, typeof hash === 'string' ? hash : null);
    } else {
      this.fleet.failCall(call.call_id, res.error?.code ?? 'error');
    }
    this.deps.bus.publish('exec.call.finished', {
      callId: call.call_id,
      dotId: call.dot_id,
      taskId: call.task_id,
      tool: call.tool,
      mode,
      jobId: res.job_id,
      status: res.status,
      errorCode: res.error?.code,
      wallMs: res.usage?.wall_ms ?? 0,
      at: finishedAt,
    });
    void at;
    return res;
  }

  private async failDispatch(
    call: ExecToolCall,
    mode: 'sync' | 'async',
    cause: unknown,
    at: string,
  ): Promise<ExecToolResult> {
    this.fleet.failCall(call.call_id, 'transport_error');
    this.deps.bus.publish('exec.call.interrupted', {
      callId: call.call_id,
      dotId: call.dot_id,
      taskId: call.task_id,
      reason: 'container_lost',
      at,
    });
    return {
      call_id: call.call_id,
      status: 'error',
      error: {
        code: 'transport_error',
        message: errText(cause),
        retryable: true,
      },
      finished_at: at,
    };
    void mode;
  }

  /**
   * 取消进行中调用（治理/任务超时驱动）；幂等。
   *  - sync 工具无 job_id → 只标本地 timeout，不强杀（fs 秒级，不值得，§10）；
   *  - async 工具查 exec_calls.job_id → POST /jobs/{job_id}/cancel。
   */
  async cancelTool(callId: string, reason: string): Promise<void> {
    const row = this.fleet.getCall(callId);
    if (row === null) return;
    if (row.state === 'done' || row.state === 'error' || row.state === 'cancelled') return; // 幂等
    this.cancelled.add(callId);
    if (row.mode === 'async' && row.job_id !== null) {
      const c = this.fleet.getContainer(row.dot_id);
      const token = await this.fleet.currentToken(row.dot_id);
      if (c?.endpoint != null && token !== null) {
        try {
          await this.requireRuntime().cancelJob(c.endpoint, token, row.job_id);
        } catch {
          // 容器已不可达：本地标记即可
        }
      }
    }
    this.fleet.cancelCall(callId);
    this.deps.bus.publish('exec.call.finished', {
      callId,
      dotId: row.dot_id,
      taskId: row.task_id,
      tool: row.tool,
      mode: row.mode,
      status: 'cancelled',
      wallMs: 0,
      at: new Date().toISOString(),
    });
    void reason;
  }

  // ═══════════════════════════════════════════════════════════════════
  // §10 查询/生命周期 API
  // ═══════════════════════════════════════════════════════════════════

  /** 能力目录（J2：mode + sideEffect 是权限分级与派发路由的唯一词表）。 */
  async getCapabilities(_dotId: string): Promise<Capability[]> {
    if (this.capCache !== null) return [...this.capCache];
    // 容器在跑时以容器 GET /capabilities 为准（版本化 runtime_ver），否则用宿主内置目录
    const c = this.fleet.getContainer(_dotId);
    const token = await this.fleet.currentToken(_dotId);
    if (c?.endpoint != null && token !== null && this.runtime !== null) {
      try {
        const remote = await this.runtime.capabilities(c.endpoint, token);
        if (remote.length > 0) {
          this.capCache = remote;
          return [...remote];
        }
      } catch {
        // 回落宿主内置目录
      }
    }
    this.capCache = [...CAPABILITY_CATALOG];
    return [...this.capCache];
  }

  /** 契约 J5：stats（内部用 dockerode stats API，CP 只按周期调用）。 */
  async getContainerStats(dotId: string): Promise<ContainerStats> {
    return this.fleet.stats(dotId);
  }

  /** 契约 J5：pause/unpause 幂等路径（EX suspend/resume 命名统一）。 */
  async pauseContainer(dotId: string): Promise<void> {
    await this.suspendDot(dotId);
  }

  async unpauseContainer(dotId: string): Promise<void> {
    await this.resumeDot(dotId);
  }

  /** §4.1：idle → suspended（docker pause 冻结进程，保留内存页与挂载）。 */
  async suspendDot(dotId: string): Promise<void> {
    const row = this.fleet.getContainer(dotId);
    if (row === null) return;
    if (row.state === 'suspended') return; // 幂等
    if (row.docker_container_id != null) {
      try {
        await this.backend.pauseContainer(row.docker_container_id);
      } catch (cause) {
        this.fleet.transition(dotId, 'unhealthy', { reason: errText(cause) });
        return;
      }
    }
    this.fleet.transition(dotId, 'suspended', { reason: 'suspendDot' });
  }

  /** §4.1：suspended → ready（毫秒级恢复）。 */
  async resumeDot(dotId: string): Promise<void> {
    const row = this.fleet.getContainer(dotId);
    if (row === null) return;
    if (row.state === 'ready' || row.state === 'busy') return; // 幂等
    if (row.docker_container_id != null) {
      try {
        await this.backend.unpauseContainer(row.docker_container_id);
      } catch (cause) {
        // resume 失败 → recreate（§4.1）
        await this.fleet.recreate(dotId);
        return;
      }
    }
    if (row.state === 'stopped' || row.state === 'idle_stop_requested') {
      // 第二档节能的恢复要重跑 booting（§4.1）
      await this.fleet.recreate(dotId);
      return;
    }
    this.fleet.transition(dotId, 'ready', { reason: 'resumeDot' });
    await this.fleet.reconcileOpenCalls(dotId);
  }

  /**
   * 派发前按需唤醒（wake-on-demand）：仅对节能档生效，其余状态原样交给调用方门控。
   * suspended→unpause、idle→ready、stopped/idle_stop_requested→recreate，全部复用
   * resumeDot 的既有分支（幂等、失败自动转 recreate）。唤醒失败不抛：调用方读到
   * 仍不可派发的状态会照旧走 container_not_ready（retryable），由重试兜底。
   *
   * unhealthy 刻意**不**在此唤醒：状态机（types.ts CONTAINER_TRANSITIONS）只允许
   * unhealthy→booting/quarantined/lost/removed，resumeDot 的 ready 分支对它是非法的。
   * unhealthy 的恢复归 boot 复探（fleet boot：docker 侧在跑 → 转 booting →
   * 重跑 healthcheck → ready）；运行期 unhealthy 由重试+重启兜底。
   */
  private async wakeForDispatch(dotId: string): Promise<void> {
    const row = this.fleet.getContainer(dotId);
    if (row === null) return;
    if (row.state !== 'suspended' && row.state !== 'idle' && row.state !== 'stopped' && row.state !== 'idle_stop_requested') {
      return;
    }
    try {
      await this.resumeDot(dotId);
    } catch {
      /* 唤醒失败：交给 not-ready 门控与重试路径 */
    }
  }

  /**
   * 显式 recreate（CP 手动重挂 / 健康检查连续失败后调用；§13.2）。
   * recreate 次数超限（>3 次/24h）时 fleet.recreate 内部转 quarantined。
   */
  async recreateContainer(dotId: string): Promise<void> {
    await this.fleet.recreate(dotId);
    await this.fleet.reconcileOpenCalls(dotId);
  }

  /** 按 call_id 直接向容器取回结果（`GET /calls/{call_id}`，幂等）。 */
  async getCallResult(callId: string): Promise<unknown> {
    const row = this.fleet.getCall(callId);
    if (row === null) return null;
    const c = this.fleet.getContainer(row.dot_id);
    const token = await this.fleet.currentToken(row.dot_id);
    if (c?.endpoint == null || token === null) {
      // 宿主侧 ledger 只存 result_hash（EX §5.4：明文结果由容器 ledger 持有），
      // 容器不可达时返回 hash 供对账方判定"有结果但取不回"。
      return row.result_hash === null ? null : { result_hash: row.result_hash };
    }
    return await this.requireRuntime().getCall(c.endpoint, token, callId);
  }

  /**
   * 宿主确认位（EX §5.4-4：压缩的**唯一**准入条件）。
   * 控制面在 journal 回报"该 done 已入账"后调用；只有 confirmed 的 done 项
   * 才允许被 compactLedger 瘦身。容器不可达/非 done 时回 false（不抛）。
   */
  async confirmCallResult(dotId: string, callId: string): Promise<boolean> {
    const c = this.fleet.getContainer(dotId);
    const token = await this.fleet.currentToken(dotId);
    if (c?.endpoint == null || token === null) return false;
    try {
      return await this.requireRuntime().confirmCall(c.endpoint, token, callId);
    } catch {
      return false;
    }
  }

  /**
   * 触发容器侧 ledger 压缩（EX §8：state 卷 64MB 上限；§5.4-4 超 5000 行）。
   * 只压缩「已被控制面确认的 done 项」（未确认的永不压缩）。
   * 返回被压缩的 call_id 列表；容器不可达回空数组。
   */
  async compactLedger(dotId: string): Promise<string[]> {
    const c = this.fleet.getContainer(dotId);
    const token = await this.fleet.currentToken(dotId);
    if (c?.endpoint == null || token === null) return [];
    try {
      return await this.requireRuntime().compactLedger(c.endpoint, token);
    } catch {
      return [];
    }
  }

  /** 销毁容器（卷默认保留，§10；`keepVolumes:true` = kill 语义：连卷一起清）。 */
  async destroyDotContainer(dotId: string, opts: { keepVolumes: boolean } = { keepVolumes: false }): Promise<void> {
    const row = this.fleet.getContainer(dotId);
    if (row?.docker_container_id != null) {
      try {
        await this.backend.removeContainer(row.docker_container_id);
      } catch {
        // 已不在
      }
    }
    if (opts.keepVolumes) {
      // kill 语义：显式清理卷并同步台账（DiskGardener 只动白名单外的未登记卷）
      const vols = this.fleet.listVolumes(dotId);
      for (const v of vols) {
        try {
          await this.backend.removeVolume(v.name);
        } catch {
          // 已不在
        }
      }
      this.fleet.dropVolumes(dotId);
    }
    this.fleet.transition(dotId, 'removed', { reason: 'destroyDotContainer' });
  }

  /** S4：getDotStatus 快照（数据源全为 containers/exec_volumes 表）。 */
  async getDotStatus(dotId: string): Promise<DotStatusSnapshot> {
    const s = this.fleet.status(dotId);
    const stats = await this.getContainerStats(dotId);
    return { ...s, resources: { ...s.resources, memMb: stats.memMb || s.resources.memMb } };
  }

  /**
   * §10 setIdentityProfile → {profileHash}（exec_identities 行 + 目录名 hash）。
   * 契约 S5：identity → profile 目录名 = sha256(identity_key)[0:16]（防目录名注入）。
   * 先 registerDot（幂等）保证 exec_dots 行存在——exec_identities.dot_id 有 FK。
   */
  async setIdentityProfile(dotId: string, identityKey: string): Promise<{ profileHash: string }> {
    this.fleet.registerDot(dotId);
    const hash = this.fleet.setIdentity(dotId, identityKey);
    return { profileHash: hash };
  }

  /** 治理下发宿主侧出站白名单端口（§2.1-2）；boot 时重装同样走这里缓存的策略。 */
  async setEgressWhitelist(ports: number[]): Promise<void> {
    this.netguard.setEgressWhitelist(ports);
    await this.netguard.install();
  }

  // ═══════════════════════════════════════════════════════════════════
  // §5.4 reconcile（崩溃恢复：先 reconcile 取回 done，取不到的才报 interrupted）
  // ═══════════════════════════════════════════════════════════════════

  /** 对单个 open call 对账（契约 §8⑫ 的 exec.reconcileCall(callId)）。 */
  async reconcileCall(callId: string): Promise<ReconcileEntry> {
    const row = this.fleet.getCall(callId);
    if (row === null) {
      return { callId, dotId: 'unknown', outcome: 'interrupted', reason: 'not_found', at: new Date().toISOString() };
    }
    const entries = await this.fleet.reconcileOpenCalls(row.dot_id);
    const hit = entries.find((e) => e.callId === callId);
    if (hit !== undefined) return hit;
    return {
      callId,
      dotId: row.dot_id,
      outcome: 'skipped',
      reason: `exec_calls.state=${row.state}（非 open）`,
      at: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 契约 S4'/M4：POST /fs/ops 桥（MEM 注入读取/索引对账/原子写）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 宿主侧调用容器 `/fs/ops`（Bearer 鉴权、与 fs.* 同沙箱、rename 限 home 内、
   * 仅宿主 token 可调，不进模型工具面）。
   *
   * 宿主侧硬护栏（§7，exec 无条件强制）：
   *  - read/list/stat：路径必须在 /dot/home/ 下，且不在 .dotd/ 隐藏前缀内；
   *  - rename：path 与 target 都必须在 /dot/home/ 内；
   *  - 容器未在跑 → 返回 ok:false + code:'container_not_ready'（MEM 侧降级记 memory_missed）。
   */
  async fsOps(dotId: string, req: FsOpsRequest): Promise<FsOpsResponse> {
    const pathCheck = checkHomePath(req.path);
    if (!pathCheck.ok) {
      return { op: req.op, ok: false, error: { code: pathCheck.code ?? 'bad_path', message: pathCheck.message ?? '' } };
    }
    if (req.op === 'rename') {
      if (typeof req.target !== 'string') {
        return { op: 'rename', ok: false, error: { code: 'bad_target', message: 'rename 必须带 target' } };
      }
      const t = checkHomePath(req.target);
      if (!t.ok) {
        return { op: 'rename', ok: false, error: { code: t.code ?? 'bad_target', message: t.message ?? '' } };
      }
    }
    const row = this.fleet.getContainer(dotId);
    const token = await this.fleet.currentToken(dotId);
    if (row?.endpoint == null || token === null || row.state !== 'ready' && row.state !== 'busy') {
      return {
        op: req.op,
        ok: false,
        error: { code: 'container_not_ready', message: `容器状态 ${row?.state ?? 'absent'}，本次跳过` },
      };
    }
    const client = this.requireRuntime();
    return await client.fsOps(row.endpoint, token, { ...req, dotId });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部工具
  // ═══════════════════════════════════════════════════════════════════

  private modeOf(tool: string): 'sync' | 'async' {
    const cap = CAPABILITY_CATALOG.find((c) => c.name === tool);
    return cap?.mode ?? 'async';
  }

  private requireRuntime(): RuntimeClient {
    if (this.runtime === null) {
      throw new Error('运行时客户端未装配（docker 路径需注入 RuntimeClient）');
    }
    return this.runtime;
  }

  private incInflight(dotId: string): number {
    const n = (this.inflight.get(dotId) ?? 0) + 1;
    this.inflight.set(dotId, n);
    return n - 1;
  }

  private decInflight(dotId: string): number {
    const n = Math.max(0, (this.inflight.get(dotId) ?? 1) - 1);
    this.inflight.set(dotId, n);
    return n;
  }

  /** healthcheck 探活（§4.1/§5.5）。 */
  private async probeHealth(dotId: string): Promise<boolean> {
    const row = this.fleet.getContainer(dotId);
    const token = await this.fleet.currentToken(dotId);
    if (row?.endpoint == null || token === null) return false;
    return this.probeHealthRaw(row.endpoint, token);
  }

  private async probeHealthRaw(endpoint: string, token: string): Promise<boolean> {
    const client = this.runtime;
    if (client === null) return false;
    try {
      await client.health(endpoint, token);
      return true;
    } catch {
      return false;
    }
  }

  /** GET /calls/{call_id}（§5.2：按 call_id 取回任意调用终态）。 */
  private async getCallRaw(endpoint: string, token: string, callId: string): Promise<ExecToolResult> {
    return this.requireRuntime().getCall(endpoint, token, callId);
  }

  private async cancelRemote(endpoint: string, token: string, jobId: string): Promise<void> {
    try {
      await this.requireRuntime().cancelJob(endpoint, token, jobId);
    } catch {
      // 容器不可达：本地标记即可
    }
  }

  private async cleanProfileCaches(dotId: string): Promise<number> {
    const row = this.fleet.getContainer(dotId);
    const token = await this.fleet.currentToken(dotId);
    if (row?.endpoint == null || token === null || this.runtime === null) return 0;
    try {
      const res = await this.runtime.fsOps(row.endpoint, token, {
        op: 'list',
        path: '/dot/profiles',
        dotId,
      });
      // 容器侧负责真实 unlink；宿主只触发并读回条目数作近似 freed 估计
      return (res.entries ?? []).length;
    } catch {
      return 0;
    }
  }

  /** 派生量（测试/审计用）：token 库内投影。 */
  tokenHashOf(token: string): string {
    return tokenHash(token);
  }

  /** 派生量（测试/审计用）：result_hash。 */
  resultHashOf(result: unknown): string {
    return resultHash(result);
  }

  /** 派生量（测试/审计用）：args_hash。 */
  argsHashOf(args: Record<string, unknown>): string {
    return argsHash(args);
  }

  /** 派生量（测试用）：profile 目录名 hash。 */
  profileHashOf(identity: string): string {
    return identityHash(identity, this.cfg.profileHashChars);
  }

  /** 护栏常量导出（测试断言 §7 硬护栏）。 */
  get guards(): {
    readMaxBytes: number;
    writeMaxBytes: number;
    listMaxDepth: number;
    syncDeadlineMs: number;
  } {
    return {
      readMaxBytes: FS_READ_MAX_BYTES,
      writeMaxBytes: FS_WRITE_MAX_BYTES,
      listMaxDepth: FS_LIST_MAX_DEPTH,
      syncDeadlineMs: this.cfg.syncDeadlineMs,
    };
  }

  /** endpoint 拼接（测试用）。 */
  endpointOf(ip: string): string {
    return endpointUrl(ip, this.cfg.runtimePort);
  }

  /** sha256（测试/审计对齐用）。 */
  sha256(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════

function canTake(state: string): boolean {
  return state === 'ready' || state === 'busy';
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

