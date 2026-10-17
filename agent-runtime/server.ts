/**
 * agent-runtime/server.ts —— 工具协议服务器（EX §5.2 端点总表的逐条实现）。
 *
 * 监听 `0.0.0.0:9223`（EX §5.2），全部请求带 `Authorization: Bearer <token>`
 * （token 由宿主生成、只读 bind 进 `/run/dotd/token`，EX §5.1）。
 *
 * 端点（execution.md §5.2 总表 + 契约 S4' 新增 /fs/ops）：
 * | 方法 | 路径 | 语义 |
 * | GET  | /healthz          | {state:'ok', version, uptime, mem_used_mb, token_epoch}（不回显 token） |
 * | POST | /tools/call       | 同步短调用（mode='sync' 的工具），HTTP 响应即终态 |
 * | POST | /jobs/start       | 异步长调用（mode='async'），返回 job_id |
 * | GET  | /jobs/{job_id}    | 轮询 {state, call_id, events[], result?, error?} |
 * | GET  | /calls/{call_id}  | 按 call_id 取回任意调用（含同步）的终态——读 ledger 的 done 项重放 |
 * | POST | /jobs/{job_id}/cancel | 协作式取消 |
 * | DELETE | /jobs           | 清理已结束 job 记录 |
 * | GET  | /capabilities     | 工具目录 {name, mode, max_deadline_ms, args_schema, sideEffect} |
 * | POST | /fs/ops           | 契约 S4'：read/list/stat/rename，宿主侧桥；**不在能力目录**（模型工具面不可见）|
 *
 * 幂等核心（EX §5.4）：
 *   rec = ledger.get(call_id)
 *   done → 直接重放 rec.result；doing → running + 现有 job_id；
 *   aborted（启动时清理所得）→ error{code:'interrupted', retryable:true}
 *   exec 永不自动重试；重派换新 call_id 是 journal 的决定（契约 J1-1）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import type { ToolCall, ToolResult, Capability, HealthReport, JobView, JobEvent } from './protocol.ts';
import {
  CAPABILITIES,
  ERROR_CODES,
  ProtocolError,
  capabilityOf,
  errorResult,
  hashArgs,
  okResult,
  parseFsOpsRequest,
  parseToolCall,
  parseToolResult,
  runningResult,
  cancelledResult,
  SYNC_MAX_DEADLINE_MS,
} from './protocol.ts';
import { Ledger } from './ledger.ts';
import { FsTools } from './fs.ts';
import { ShellTools, type SpawnAdapter } from './shell.ts';
import { BrowserHolder, MAX_PAGES_PER_CTX, identityHash, browserCrashed, isPersistentIdentity } from './browser.ts';
import { XvfbManager, type XvfbSpawn } from './xvhfd.ts';

/** agent-runtime 版本（参与镜像 tag 计算；增删工具必须 bump，EX S2）。 */
export const RUNTIME_VERSION = '0.1.0';

/**
 * 已结束 job 的保留条数。宿主在读到终态后还可能再轮询一次 GET /jobs/{id}，
 * 所以不能一结束就删；但也不能永不删——DELETE /jobs 是全库唯一清理入口，
 * 而宿主从来没有调用方，长跑容器里 jobs Map 只增不减（2026-10-17 实测）。
 * 留一小段环形缓冲：够覆盖"终态后的迟到轮询"，又把 Map 钉在有界水位。
 */
export const FINISHED_JOBS_KEEP = 64;

/**
 * playwright 的最小形状（只覆盖我们用到的两个入口）。
 * 真实类型来自镜像内的 `playwright@1.49.1`（§9.6 严格锁）；此处不引该包的类型，
 * 使容器外 typecheck 不依赖 playwright 安装。
 */
interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    opts: Record<string, unknown>,
  ): Promise<unknown>;
  launch(opts: Record<string, unknown>): Promise<unknown>;
}

/** token 只读 bind 路径（EX §5.1 / Dockerfile ENV DOTD_TOKEN_PATH）。 */
export const DEFAULT_TOKEN_PATH = '/run/dotd/token';
/** state 卷上的 ledger 路径（EX §5.4）。 */
export const DEFAULT_STATE_DIR = '/opt/agent-state';

export interface RuntimeConfig {
  port?: number;
  host?: string;
  tokenPath?: string;
  stateDir?: string;
  /** 直接给 token（测试用；缺省从 tokenPath 读）。 */
  token?: string;
  /** 容器内存预算 MB（exec_dots.limits_json.memMb 默认 1536，契约 J5）。 */
  memBudgetMb?: number;
  ledgerPath?: string;
  /** 依赖注入（测试打桩边界）。 */
  fsTools?: FsTools;
  shellTools?: ShellTools;
  spawnAdapter?: SpawnAdapter;
  /** home 卷根（测试注入临时目录；容器内恒 /dot/home）。 */
  homeRoot?: string;
  /**
   * 进程是否具备 setuid 能力（原样传给 ShellTools）。
   * 缺省 = `process.getuid?.() === 0`，这个判据**跟着运行环境变**：Windows 上
   * getuid 不存在 → false（降级），WSL root 下恒 true（不降级）。测试要断言
   * 降级路径就必须把它钉死，否则同一条断言换台机器就红——2026-10-17 WSL 全量
   * 测试里唯一那条失败就是这么来的。
   */
  canSetUid?: () => boolean;
  browserFactory?: BrowserHolder extends never ? never : import('./browser.ts').ChromiumFactory;
  xvfbSpawn?: XvfbSpawn;
  /** 日志出口（默认 console；测试可捕获）。 */
  log?: (line: string) => void;
}

// ── job 登记（async 调用的内存视图）─────────────────────────────────

interface JobEntry {
  job_id: string;
  call_id: string;
  tool: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  events: JobEvent[];
  result?: ToolResult;
  started_at: string;
  finished_at?: string;
  /** 协作式取消句柄（EX §5.2 POST /jobs/{job_id}/cancel）。 */
  cancel: () => void;
}

export class AgentRuntime {
  readonly ledger: Ledger;
  readonly fs: FsTools;
  readonly shell: ShellTools;
  readonly browser: BrowserHolder;
  readonly xvfb: XvfbManager;

  private readonly cfg: Required<
    Pick<RuntimeConfig, 'port' | 'host' | 'stateDir'>
  > &
    RuntimeConfig;
  private readonly token: string;
  private readonly log: (line: string) => void;
  private readonly jobs = new Map<string, JobEntry>();
  /** job_id → 协作式取消句柄（EX §5.2 POST /jobs/{id}/cancel）。 */
  private readonly jobsCancels = new Map<string, { cancelled: boolean }>();
  private jobSeq = 0;
  private server: Server | null = null;
  private readonly bootedAt = Date.now();

  constructor(cfg: RuntimeConfig = {}) {
    this.cfg = {
      port: cfg.port ?? 9223,
      host: cfg.host ?? '0.0.0.0',
      stateDir: cfg.stateDir ?? DEFAULT_STATE_DIR,
      ...cfg,
    };
    this.log = cfg.log ?? ((line) => console.log(line));
    this.token = cfg.token ?? readToken(cfg.tokenPath ?? DEFAULT_TOKEN_PATH);

    const ledgerPath = cfg.ledgerPath ?? `${this.cfg.stateDir}/ledger.jsonl`;
    this.ledger = new Ledger({ filePath: ledgerPath });

    this.fs = cfg.fsTools ?? new FsTools();
    this.shell =
      cfg.shellTools ??
      new ShellTools({
        ...(cfg.spawnAdapter !== undefined ? { spawnAdapter: cfg.spawnAdapter } : {}),
        ...(cfg.homeRoot !== undefined ? { homeRoot: cfg.homeRoot } : {}),
        ...(cfg.canSetUid !== undefined ? { canSetUid: cfg.canSetUid } : {}),
        onDegrade: (detail) => this.log(`[event] ${detail.kind} ${JSON.stringify(detail)}`),
      });

    this.xvfb = new XvfbManager({
      ...(cfg.xvfbSpawn !== undefined ? { spawnImpl: cfg.xvfbSpawn } : {}),
    });
    this.browser = new BrowserHolder({
      factory: this.requireBrowserFactory(cfg),
      memProbe: {
        usedMb: () =>
          Math.round((process.memoryUsage().rss + process.memoryUsage().heapUsed) / 1024 / 1024),
      },
      budgetMb: cfg.memBudgetMb ?? 1536,
      onEvent: (kind, detail) => this.log(`[event] exec.browser.${kind} ${JSON.stringify(detail)}`),
    });
  }

  private requireBrowserFactory(cfg: RuntimeConfig): import('./browser.ts').ChromiumFactory {
    if (cfg.browserFactory !== undefined) return cfg.browserFactory;
    // 容器内：动态加载 playwright（design §9.6：严格锁 1.49.1，锁进 package-lock）。
    // 用间接 specifier（变量）避开 TS 对未安装包的静态解析——容器外 typecheck
    // 与容器外测试都不需要 playwright；真实容器里这条路径照常工作。
    const spec = 'playwright';
    return {
      launchPersistentContext: async (dir, opts) => {
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
          chromium: PlaywrightChromium;
        };
        return (await mod.chromium.launchPersistentContext(dir, {
          ...opts,
          env: { ...this.xvfb.envPatch() },
        })) as unknown as import('./browser.ts').BrowserContextLike;
      },
      launch: async (opts) => {
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
          chromium: PlaywrightChromium;
        };
        return (await mod.chromium.launch({
          ...opts,
          env: { ...this.xvfb.envPatch() },
        })) as unknown as import('./browser.ts').BrowserLike;
      },
    };
  }

  /** 启动：Xvfb → ledger 中断清理 → HTTP listen。 */
  async start(): Promise<void> {
    this.ledger.recoverInterrupted();
    this.xvfb.start();
    await new Promise<void>((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.listen(this.cfg.port, this.cfg.host, () => resolve());
      this.server = server;
    });
    this.log(
      `[agent-runtime] ${RUNTIME_VERSION} listening on ${this.cfg.host}:${this.cfg.port} host=${hostname()}`,
    );
  }

  async stop(): Promise<void> {
    this.xvfb.stop();
    this.jobsCancels.clear();
    await this.browser.closeAll();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      // server.close() 只停 accept，**不关已建立的 keep-alive 连接**：
      // Node 18 起 fetch/undici 默认 keep-alive，宿主 daemon 的轮询连接会一直
      // 挂着，close 的回调因此可能很久不触发（优雅关停变慢），同端口复用也会撞
      // ECONNRESET。Node ≥18.2 提供 closeAllConnections()，显式断开。
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ── HTTP 路由 ─────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') {
        this.cors(res);
        res.writeHead(204).end();
        return;
      }
      if (!this.authorized(req)) {
        this.json(res, 401, errorResult('', ERROR_CODES.unauthorized, 'Bearer token 无效', false));
        return;
      }
      switch (true) {
        // GET /healthz —— 不回显 token（EX §5.1）
        case req.method === 'GET' && path === '/healthz': {
          const report: HealthReport = {
            state: 'ok',
            version: RUNTIME_VERSION,
            uptime_s: Math.round(uptime()),
            mem_used_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            token_epoch: this.tokenEpoch(),
          };
          this.json(res, 200, report);
          return;
        }
        // GET /capabilities
        case req.method === 'GET' && path === '/capabilities': {
          this.json(res, 200, { capabilities: [...CAPABILITIES] });
          return;
        }
        // POST /tools/call
        case req.method === 'POST' && path === '/tools/call': {
          const body = await readBody(req);
          const call = parseToolCall(JSON.parse(body));
          const result = await this.toolsCall(call);
          this.json(res, httpStatus(result), result);
          return;
        }
        // POST /jobs/start
        case req.method === 'POST' && path === '/jobs/start': {
          const body = await readBody(req);
          const call = parseToolCall(JSON.parse(body));
          const result = await this.jobsStart(call);
          this.json(res, httpStatus(result), result);
          return;
        }
        // GET /jobs/{job_id}
        case req.method === 'GET' && path.startsWith('/jobs/'): {
          const jobId = decodeURIComponent(path.slice('/jobs/'.length));
          const view = this.jobView(jobId);
          if (view === undefined) {
            this.json(res, 404, errorResult('', ERROR_CODES.job_not_found, `job ${jobId} 不存在`, false));
            return;
          }
          this.json(res, 200, view);
          return;
        }
        // POST /jobs/{job_id}/cancel
        case req.method === 'POST' && /^\/jobs\/[^/]+\/cancel$/.test(path): {
          const jobId = decodeURIComponent(path.slice('/jobs/'.length, -'/cancel'.length));
          const result = this.jobCancel(jobId);
          this.json(res, result === undefined ? 404 : 200, result ?? errorResult('', ERROR_CODES.job_not_found, `job ${jobId} 不存在`, false));
          return;
        }
        // DELETE /jobs
        case req.method === 'DELETE' && path === '/jobs': {
          this.json(res, 200, { removed: this.jobsCleanup() });
          return;
        }
        // GET /calls/{call_id} —— 按 call_id 取回任意调用（含同步）的终态
        case req.method === 'GET' && path.startsWith('/calls/'): {
          const callId = decodeURIComponent(path.slice('/calls/'.length));
          const result = this.callReplay(callId);
          if (result === undefined) {
            this.json(res, 404, errorResult(callId, ERROR_CODES.not_found, `call ${callId} 无记录`, false));
            return;
          }
          this.json(res, httpStatus(result), result);
          return;
        }
        // POST /fs/ops（契约 S4'：仅宿主 token 可调，不进模型工具面）
        case req.method === 'POST' && path === '/fs/ops': {
          const body = await readBody(req);
          const ops = parseFsOpsRequest(JSON.parse(body));
          // **扁平形状**（FsOpsResponse）：宿主 MEM 的 FsOpsHttpBridge 读
          // body.content / body.entries[].sizeBytes / body.stat.sizeBytes。
          // 原先原样透出 fs.* 的 ToolResult（{ok, result:{...}}），宿主三读全空、
          // rename 恒 true——铁律 B 静默降级（审码 issue C）。
          this.json(res, 200, this.fs.fsOps(ops.op, ops.path, ops.target));
          return;
        }
        default: {
          this.json(res, 404, errorResult('', ERROR_CODES.not_found, `${req.method ?? '?'} ${path} 无对应端点`, false));
          return;
        }
      }
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : ERROR_CODES.bad_request;
      const msg = e instanceof Error ? e.message : String(e);
      this.json(res, code === ERROR_CODES.unknown_tool ? 400 : 400, errorResult('', code, msg, false));
    }
  }

  /**
   * Bearer 鉴权（EX §5.1）。
   *
   * **关于契约 S4'「/fs/ops 仅宿主 token 可调」（审码 issue M，如实记录）**：
   * 容器内只有**一个** token（宿主生成、ro-bind 进 /run/dotd/token，EX §5.1），
   * 宿主侧 ExecService.fsOps 与 runTool 走的是同一个 `fleet.currentToken()`
   * （src/exec/ExecService.ts:716），宿主 MEM 的 FsOpsHttpBridge 也只发这一个
   * Bearer（src/memory/fsops-client.ts:83）。协议里没有第二个 token 的载体，
   * 所以「仅宿主 token 可调」在本容器内**无法结构性区分**——这是宿主侧契约的
   * 缺口，不是本模块能单方面补的（补了宿主不认，MEM 全桥立刻断）。
   *
   * 现有的等效防护（EX §7.1 已声明并接受）：
   *  - /fs/ops **不在能力目录**（CAPABILITIES 无此项）→ 模型工具面不可见，
   *    模型只能经 Runner→ExecService 的 /tools/call 面发起调用，永远到不了这里；
   *  - 冒用本容器 token 的爆炸半径仅限本容器 HTTP，且受幂等 ledger 保护
   *    （execution.md:381 的显式接受项）。
   * 阶段三若要真正做到 token 分离，需宿主先提供第二个 bind 文件 +
   * ExecService/fsops-client 双 token 协议，届时本模块加一个
   * `hostToken` 配置项即可，不动端点形状。
   */
  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return false;
    const m = /^Bearer\s+(.+)$/.exec(h.trim());
    if (m === null) return false;
    return timingSafeEqual(m[1] ?? '', this.token);
  }

  /** 不回显 token：只给一个可轮换纪元标识（token 轮换后 epoch 变，EX §5.1）。 */
  private tokenEpoch(): string {
    return hashArgs(this.token).slice(0, 12);
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    this.cors(res);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // ── 派发（EX §5.4 handleCall 逐字）────────────────────────────────

  /**
   * POST /tools/call —— 同步端点。只接受 catalog mode='sync' 的工具；
   * sync 工具强制 `deadline_ms ≤ 60_000`，超限直接
   * `error{code:'deadline_too_long_for_sync'}`（EX §5.2 末段）。
   */
  async toolsCall(call: ToolCall): Promise<ToolResult> {
    const cap = capabilityOf(call.tool);
    if (cap === undefined) {
      return errorResult(call.call_id, ERROR_CODES.unknown_tool, `工具未登记：${call.tool}`, false);
    }
    if (cap.mode !== 'sync') {
      return errorResult(
        call.call_id,
        ERROR_CODES.wrong_endpoint_for_mode,
        `${call.tool} mode='${cap.mode}'，应走 /jobs/start`,
        false,
      );
    }
    if (call.deadline_ms > SYNC_MAX_DEADLINE_MS) {
      return errorResult(
        call.call_id,
        ERROR_CODES.deadline_too_long_for_sync,
        `sync 工具 deadline_ms ≤ ${SYNC_MAX_DEADLINE_MS}（收到 ${call.deadline_ms}）`,
        false,
      );
    }
    return this.dispatch(call);
  }

  /**
   * POST /jobs/start —— 异步端点。只接受 mode='async' 的工具；
   * 立即返回 `{status:'running', job_id}`，执行在后台继续。
   *
   * §5.5 主路径（宿主 ExecService.startJob → pollJob）要求这条链路**真的活着**：
   *   beginJob 登记 running → 后台 dispatch → settleJob 落终态，
   *   于是 GET /jobs/{id} 有视图、POST /jobs/{id}/cancel 有句柄可调、
   *   DELETE /jobs 有可清理项。缺任何一环宿主侧立刻 job_not_found。
   */
  async jobsStart(call: ToolCall): Promise<ToolResult> {
    const cap = capabilityOf(call.tool);
    if (cap === undefined) {
      return errorResult(call.call_id, ERROR_CODES.unknown_tool, `工具未登记：${call.tool}`, false);
    }
    if (cap.mode !== 'async') {
      return errorResult(
        call.call_id,
        ERROR_CODES.wrong_endpoint_for_mode,
        `${call.tool} mode='sync'，应走 /tools/call`,
        false,
      );
    }
    const existing = this.ledger.lookup(call.call_id);
    if (existing.kind === 'doing') {
      const jobId = existing.record.job_id;
      if (jobId !== undefined) return runningResult(call.call_id, jobId);
    }
    const jobId = this.nextJobId();
    // 协作式取消句柄（EX §5.2「进程 SIGTERM / 页面 close」）：置位后
    // 1) 后台 dispatch 若已跑完则忽略；2) 在跑的 browser/shell 调用见
    //    cancelled 标志提前收尾。此处只做状态置位（取消的最终落账由
    //    dispatch 的 cancelled 分支写 ledger）。
    const job = { cancelled: false };
    this.jobsCancels.set(jobId, job);
    this.beginJob(jobId, call.call_id, call.tool, () => {
      job.cancelled = true;
      // 浏览器页面 close（§5.2：协作式取消的一种）
      if (call.tool.startsWith('browser.')) {
        void this.browser.closeIdentity(call.identity ?? 'ephemeral').catch(() => undefined);
      }
    });
    const ack = this.dispatch(call, jobId); // 不 await：后台跑
    void ack
      .then((r) => this.settleJob(jobId, r))
      .catch((e: unknown) => this.settleJob(jobId, errorResult(call.call_id, ERROR_CODES.bad_request, String(e), false)));
    return runningResult(call.call_id, jobId);
  }

  /** 幂等分派（EX §5.4 的 handleCall 主体）。 */
  private async dispatch(call: ToolCall, jobId?: string): Promise<ToolResult> {
    const argsHash = hashArgs(call.args);
    const rec = this.ledger.lookup(call.call_id);
    if (rec.kind === 'done' || rec.kind === 'compacted') {
      // 契约 J1：args_hash 比对是 journal 幂等的**最后防线**。同 call_id 不同
      // args = 调用方违规（call_id 全局唯一），绝不静默重放旧结果——
      // 在 HTTP 入口这一层挡住（ledger.start 的比对只在全新派发路径上执行）。
      if (rec.record.args_hash !== argsHash) {
        return errorResult(
          call.call_id,
          ERROR_CODES.call_id_reuse_mismatch,
          `call_id ${call.call_id} 已被不同 args 使用（${rec.record.args_hash} → ${argsHash}）；J1 重派请换新 call_id`,
          false,
          { ...(jobId !== undefined ? { job_id: jobId } : {}) },
        );
      }
      // done → 重放 result；compacted → result_compacted（EX §5.4-4）
      return this.replay(rec.record, jobId);
    }
    if (rec.kind === 'doing') {
      return runningResult(call.call_id, rec.record.job_id ?? jobId);
    }
    if (rec.kind === 'aborted') {
      // 两种 aborted 语义必须分开（否则 J 修了等于没修）：
      // 1. 重启扫描 doing→aborted（无 error_reason）：真被打断 → interrupted(retryable)，
      //    宿主据此报控制面、由 journal 决定是否重派（§5.4-1/§5.4-3）；
      // 2. 上一次派发自已失败、由 dropDoing 收行（有 error_reason）：
      //    失败不是副作用，宿主可以立刻用同一 call_id 重派（工具错误不产生
      //    未完成的外部效果，重派不违反"绝不重复执行"）。
      if (rec.record.error_reason === undefined) {
        return errorResult(
          call.call_id,
          ERROR_CODES.interrupted,
          '该调用在容器重启前未完成（aborted），exec 永不自动重试；重派请换新 call_id',
          true,
          { ...(jobId !== undefined ? { job_id: jobId } : {}) },
        );
      }
      // 失败收行：走下面的全新派发路径（ledger.start 会把该 call_id 重新置为 doing）
    }
    this.ledger.start(call.call_id, call.tool, argsHash, new Date().toISOString(), jobId);
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await this.execute(call, jobId);
    } catch (e) {
      result = errorResult(
        call.call_id,
        ERROR_CODES.bad_request,
        e instanceof Error ? e.message : String(e),
        false,
      );
    }
    const usage = { wall_ms: Date.now() - started, peak_mem_mb: 0 };
    if (result.status === 'ok') {
      this.ledger.finish(call.call_id, result.result, new Date().toISOString(), jobId);
      result = { ...result, usage, finished_at: new Date().toISOString() };
    } else if (result.status === 'cancelled') {
      this.ledger.abort(call.call_id, new Date().toISOString());
    } else {
      // error 项：从 ledger 里**收掉 doing 行**（EX §5.4 + 契约 J1）。
      // 原实现只留一句"error 不进 ledger"的注释，但 doing 行已由上面的
      // start() 落盘，结果是同 call_id 二次派发恒返回 running、宿主按注释
      // 重派反被 ledger 挡死。失败不是副作用：清掉 doing 行后，
      // 宿主换不换 call_id 都由 journal 决定，exec 永不自动重试。
      this.ledger.dropDoing(call.call_id);
    }
    return result;
  }

  /** done 项重放（EX §5.4-1：done 项原样保留、直接重放）。 */
  private replay(record: import('./ledger.ts').LedgerRecord, jobId?: string): ToolResult {
    if (record.state === 'compacted' || record.compacted === true) {
      return errorResult(
        record.call_id,
        ERROR_CODES.result_compacted,
        '该调用已确认幂等成功，但结果已被压缩（不可取回）',
        false,
        {
          ...(record.result_hash !== undefined ? { result: { result_hash: record.result_hash } } : {}),
          ...(jobId !== undefined ? { job_id: jobId } : {}),
        },
      );
    }
    return okResult(
      record.call_id,
      record.result_json,
      { wall_ms: 0, peak_mem_mb: 0 },
      jobId ?? record.job_id,
    );
  }

  /** GET /calls/{call_id}：读 ledger 的 done 项重放 result（§5.4 reconcile 用）。 */
  callReplay(callId: string): ToolResult | undefined {
    const rec = this.ledger.lookup(callId);
    if (rec.kind === 'missing') return undefined;
    if (rec.kind === 'done') return this.replay(rec.record);
    if (rec.kind === 'doing') return runningResult(callId, rec.record.job_id);
    if (rec.kind === 'compacted') return this.replay(rec.record);
    if (rec.record.error_reason !== undefined) {
      // 上一次派发自已失败（dropDoing 收行）：对账视角同样是"未完成"，
      // 宿主收到 error 后自行重派；此处不报 interrupted（那是重启扫描的语义）。
      return errorResult(
        callId,
        ERROR_CODES.interrupted,
        `该调用上一次派发失败（${rec.record.error_reason}），未产生外部效果`,
        true,
        { ...(rec.record.job_id !== undefined ? { job_id: rec.record.job_id } : {}) },
      );
    }
    return errorResult(
      callId,
      ERROR_CODES.interrupted,
      '容器重启前未完成（aborted）',
      true,
      { ...(rec.record.job_id !== undefined ? { job_id: rec.record.job_id } : {}) },
    );
  }

  /** 工具体路由（容器内唯一执行点）。 */
  private async execute(call: ToolCall, jobId?: string): Promise<ToolResult> {
    const key = isPersistentIdentity(call.identity) ? identityHash(call.identity as string) : 'ephemeral';
    switch (call.tool) {
      case 'fs.read':
        return this.fs.read(call.call_id, call.args);
      case 'fs.write':
        return this.fs.write(call.call_id, call.args);
      case 'fs.list':
        return this.fs.list(call.call_id, call.args);
      case 'fs.stat':
        return this.fs.stat(call.call_id, call.args);
      case 'shell.run':
        return this.shell.run(call.call_id, call.args, call.deadline_ms);
      case 'browser.open':
      case 'browser.act':
      case 'browser.snapshot':
      case 'browser.close':
        return this.browserCall(call, key, jobId);
      case 'net.get':
      case 'net.post':
        // 阶段二（§9.7 D6+）：词表已登记、能力目录已声明，容器内实现留位。
        return errorResult(call.call_id, ERROR_CODES.not_implemented, `${call.tool} 阶段二实现`, false);
      default:
        return errorResult(call.call_id, ERROR_CODES.unknown_tool, `未知工具 ${String(call.tool)}`, false);
    }
  }

  /**
   * 浏览器工具体（EX §6）。
   * 崩溃语义（§6.2）：chromium process exit → context 标脏，下一次 browser.*
   * 调用前自动重开；当前调用返回 error{code:'browser_crashed', retryable:true}。
   *
   * in-flight 记账：**只 enter 一次**（acquire 前后配对），页数由
   * `browser.notePage()` 单独累计。原实现在 newPage 后又 enter 一次而 finally
   * 只 exit 一次，导致 in-flight 只增不减——LRU 驱逐、老化回收、hardReset
   * 的 busy 判据全部失效（审码 issue F）。
   */
  private async browserCall(call: ToolCall, key: string, jobId?: string): Promise<ToolResult> {
    const cancelJob = jobId !== undefined ? this.jobsCancels.get(jobId) : undefined;
    this.browser.enter(key);
    try {
      const ctx = await this.browser.acquire(call.identity);
      const pages = await ctx.pages();
      if (call.tool === 'browser.close') {
        await this.browser.closeIdentity(call.identity);
        return okResult(call.call_id, { closed: true });
      }
      let page = pages[0];
      if (page === undefined) {
        // EX §6.1：每 profile 并发页面上限 MAX_PAGES_PER_CTX。
        // 达到上限就不再新开页，直接报错（不驱逐别人的页）。
        const used = await this.browser.pageCount(key);
        if (used >= MAX_PAGES_PER_CTX) {
          return errorResult(
            call.call_id,
            ERROR_CODES.too_many_pages,
            `该身份已有 ${used} 个并发页面（上限 ${MAX_PAGES_PER_CTX}）；请先关闭旧页或换身份`,
            false,
          );
        }
        page = await ctx.newPage();
        this.browser.notePage(key);
      }
      // 协作式取消（EX §5.2）：cancel 已置位则不再真的驱动页面
      if (cancelJob?.cancelled === true) {
        return cancelledResult(call.call_id, jobId);
      }
      const url = typeof call.args.url === 'string' ? call.args.url : undefined;
      switch (call.tool) {
        case 'browser.open': {
          if (url === undefined) {
            return errorResult(call.call_id, ERROR_CODES.bad_args, 'browser.open 需要 url', false);
          }
          await page.goto(url, { timeoutMs: Math.min(call.deadline_ms, 30_000) });
          return okResult(call.call_id, { url: page.url(), title: await page.title() });
        }
        case 'browser.act':
          return this.browserAct(call, page);
        case 'browser.snapshot':
          return okResult(call.call_id, await page.snapshot());
        default:
          return errorResult(call.call_id, ERROR_CODES.unknown_tool, 'unreachable', false);
      }
    } catch (e) {
      return browserCrashed(call.call_id, e);
    } finally {
      this.browser.exit(key);
    }
  }

  private async browserAct(
    call: ToolCall,
    page: import('./browser.ts').BrowserPage,
  ): Promise<ToolResult> {
    const action = call.args.action;
    const selector = typeof call.args.selector === 'string' ? call.args.selector : undefined;
    const value = typeof call.args.value === 'string' ? call.args.value : undefined;
    const t = Math.min(call.deadline_ms, 30_000);
    switch (action) {
      case 'click':
        if (selector === undefined) return this.needSelector(call);
        await page.click(selector, { timeoutMs: t });
        return okResult(call.call_id, { clicked: selector });
      case 'type':
        if (selector === undefined || value === undefined) return this.needSelector(call, 'value');
        await page.fill(selector, value, { timeoutMs: t });
        return okResult(call.call_id, { filled: selector });
      case 'press':
        if (selector === undefined || value === undefined) return this.needSelector(call, 'value');
        await page.press(selector, value, { timeoutMs: t });
        return okResult(call.call_id, { pressed: selector, key: value });
      case 'select':
        if (selector === undefined || value === undefined) return this.needSelector(call, 'value');
        await page.selectOption(selector, value);
        return okResult(call.call_id, { selected: selector, value });
      case 'scroll': {
        const dy = typeof call.args.dy === 'number' ? call.args.dy : 800;
        await page.scroll(dy);
        return okResult(call.call_id, { scrolled: dy });
      }
      case 'wait': {
        const ms = typeof call.args.timeout_ms === 'number' ? call.args.timeout_ms : 1000;
        await page.waitForTimeout(ms);
        return okResult(call.call_id, { waited_ms: ms });
      }
      default:
        return errorResult(
          call.call_id,
          ERROR_CODES.bad_args,
          `browser.act 的 action 必须是 click|type|wait|press|select|scroll（收到 ${String(action)}）`,
          false,
        );
    }
  }

  private needSelector(call: ToolCall, also?: 'value'): ToolResult {
    return errorResult(
      call.call_id,
      ERROR_CODES.bad_args,
      also === undefined ? 'browser.act 需要 selector' : 'browser.act 需要 selector 与 value',
      false,
    );
  }

  // ── job 视图 ──────────────────────────────────────────────────────

  private nextJobId(): string {
    this.jobSeq += 1;
    return `job_${Date.now().toString(36)}_${this.jobSeq}`;
  }

  private settleJob(jobId: string, result: ToolResult): void {
    const entry = this.jobs.get(jobId);
    this.jobsCancels.delete(jobId); // 终态后取消句柄不再有对象可取消
    if (entry === undefined) return;
    entry.result = result;
    entry.state =
      result.status === 'ok' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'error';
    entry.finished_at = new Date().toISOString();
    entry.events.push({ at: entry.finished_at, kind: 'finished', detail: entry.state });
    this.pruneFinishedJobs();
  }

  /**
   * 有界化 jobs Map：只留最近 FINISHED_JOBS_KEEP 条已结束记录，running 的一条不动。
   * Map 的迭代序即插入序，所以这里天然是"先结束的先淘汰"。
   */
  private pruneFinishedJobs(): void {
    let finished = 0;
    for (const e of this.jobs.values()) if (e.state !== 'running') finished += 1;
    if (finished <= FINISHED_JOBS_KEEP) return;
    for (const [id, e] of [...this.jobs]) {
      if (finished <= FINISHED_JOBS_KEEP) break;
      if (e.state !== 'running') {
        this.jobs.delete(id);
        finished -= 1;
      }
    }
  }

  /** 登记一个 job（jobsStart 内部用；也供测试直接构造）。 */
  registerJob(entry: Omit<JobEntry, 'events'>): JobEntry {
    const full: JobEntry = { ...entry, events: [{ at: entry.started_at, kind: 'started' }] };
    this.jobs.set(full.job_id, full);
    this.pruneFinishedJobs(); // 后置裁剪：新登记的那条自己永远不在淘汰名单里
    return full;
  }

  jobView(jobId: string): JobView | undefined {
    const e = this.jobs.get(jobId);
    if (e === undefined) return undefined;
    const view: JobView = {
      job_id: e.job_id,
      call_id: e.call_id,
      state: e.state,
      events: e.events,
      ...(e.result?.result !== undefined ? { result: e.result.result } : {}),
      ...(e.result?.error !== undefined ? { error: e.result.error } : {}),
      ...(e.finished_at !== undefined ? { finished_at: e.finished_at } : {}),
    };
    return view;
  }

  jobCancel(jobId: string): ToolResult | undefined {
    const e = this.jobs.get(jobId);
    if (e === undefined) return undefined;
    if (e.state === 'running') {
      e.cancel();
      e.state = 'cancelled';
      e.finished_at = new Date().toISOString();
      e.events.push({ at: e.finished_at, kind: 'finished', detail: 'cancelled' });
    }
    // 无论此前是否 running，都回收句柄（幂等：二次 cancel 只是无操作）
    this.jobsCancels.delete(jobId);
    this.pruneFinishedJobs();
    return cancelledResult(e.call_id, e.job_id);
  }

  /** DELETE /jobs：清理已结束 job 记录（幂等）。 */
  jobsCleanup(): number {
    let n = 0;
    for (const [id, e] of [...this.jobs]) {
      if (e.state !== 'running') {
        this.jobs.delete(id);
        this.jobsCancels.delete(id);
        n++;
      }
    }
    return n;
  }

  /** 供 jobsStart 登记 running 态（内部路径）。 */
  beginJob(jobId: string, callId: string, tool: string, cancel: () => void): void {
    this.registerJob({
      job_id: jobId,
      call_id: callId,
      tool,
      state: 'running',
      started_at: new Date().toISOString(),
      cancel,
    });
  }
}

// ── 辅助 ────────────────────────────────────────────────────────────

function readToken(path: string): string {
  if (!existsSync(path)) {
    // 缺 token = 拒绝服务（fail-closed）：容器启动时 bind 一定已就位。
    throw new Error(`token 文件不存在：${path}（EX §5.1：宿主 daemon 生成并 ro-bind）`);
  }
  return readFileSync(path, 'utf8').trim();
}

async function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > limit) throw new ProtocolError('请求体超过 16MB', ERROR_CODES.bad_request);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function httpStatus(r: ToolResult): number {
  if (r.status === 'ok' || r.status === 'running') return 200;
  if (r.error?.code === ERROR_CODES.unauthorized) return 401;
  return 200; // 协议错误一律 200 + 机读 error.code（宿主按 code 分流，不走 HTTP 码）
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 入口（Dockerfile ENTRYPOINT：`node /opt/agent-runtime/dist/server.js`）。 */
async function main(): Promise<void> {
  const runtime = new AgentRuntime({
    // 宿主注入的一直是 DOTD_RUNTIME_PORT（src/exec/protocol.ts 的 containerEnvAndLabels）；
    // 早年容器只读 PORT，于是"端口配了却没人听"——双名分裂。这里以
    // DOTD_RUNTIME_PORT 为准，PORT 只作本地裸跑的兜底（2026-10-17 修）。
    port: Number(process.env.DOTD_RUNTIME_PORT ?? process.env.PORT ?? 9223),
    tokenPath: process.env.DOTD_TOKEN_PATH ?? DEFAULT_TOKEN_PATH,
    stateDir: process.env.DOTD_STATE_DIR ?? DEFAULT_STATE_DIR,
  });
  await runtime.start();
  const shutdown = (): void => {
    void runtime.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// 只有作为入口直接执行时才启动（被测试 import 时不监听端口）
const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('/server.ts') || process.argv[1].endsWith('\\server.ts') ||
    process.argv[1].endsWith('/server.js') || process.argv[1].endsWith('\\server.js'));
if (isMain) {
  void main();
}

export type { Capability, ToolCall, ToolResult };
