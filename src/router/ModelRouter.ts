/**
 * src/router/ModelRouter.ts —— 模型路由与容灾（MR 模块唯一对外门面）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md；契约指 接缝契约.md）:
 * - §5.1 进程内 API:`load(deps)` / `complete` / `stream` / `trackForEvent` / `snapshot` /
 *   `manualProbe` / `resetBreaker` / `reloadConfig` / `onApprovalResult` / `emergencyActive`。
 * - §4.2 route() 主流程:单向降级扫描（tier1→2→3→4 一次一圈，绝不向上涨档重试）、
 *   预算切分、breaker 闸门、half_open 并发裁决、Tier2 槽位与 busy 规则。
 * - §4.3 mode 状态机与 emergencyActive 位；§4.4 池两级测试；§4.5 求救（账本先行）；
 *   §4.6 侦察（只侦察不接入）；§4.7 流式首字节分界 + 启动对账；§4.8 callAndSettle 记账。
 * - 契约 T1:调用面唯一；作废名 completeMain/completeLow/NoChannelAvailable/waiting_model。
 * - 契约 T2:TaskImpactProvider 由 CP taskImpact() 实现、load 注入（snake_case）。
 * - 契约 T3:OUTBOX 路径 ~/.dotd/OUTBOX.md；MR 增只读方法 outboxUnresolvedSignatures()。
 * - 契约 J4/T6:四个定时任务（pool.probe.* / recon.scan / breaker.probe_timer / router.janitor）
 *   挂 CP registerInternalJob，run 回调直调（CP 无 tick 事件发布）。
 * - 契约 J1：RouteRequest.attemptId = journal 步骤 callId；非 journal 上下文 = 'nonj:'+ULID；
 *   attemptSeq 由路由在单次 route 调用内自增，经 RouteMeta 回传并落 model_call_log。
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { EventBus } from '../shared/bus.ts';
import { StreamToolCallAccumulator, type AggregatedToolCall } from '../shared/tool-stream.ts';
import type {
  BreakerState,
  ChatChunk,
  ChatMessage,
  EndpointDef,
  FailureKind,
  NotificationChannels,
  RouteMeta,
  RouteRequest,
  RouteResult,
  RouterMode,
  RouterSnapshot,
  TaskImpactProvider,
  ToolSpec,
  Track,
  TryRecord,
} from '../shared/contracts.ts';
import {
  AllEndpointsDownError,
  AuthConfigError,
  NoQualifiedPrimaryError,
  StreamInterruptedError,
} from '../shared/errors.ts';
import { Breaker } from './breaker.ts';
import {
  badProtocolDetail,
  classifyError,
  isModelScopedKind,
  localGate,
  modelChain,
  pickCandidates,
} from './candidates.ts';
import { loadModelsConfig } from './config.ts';
import { AlertManager, type FailingEndpoint, makeSignature } from './alert.ts';
import { HealthTracker, type EndpointHealth } from './health.ts';
import { CacheTracker, type EndpointCacheRate } from './cache.ts';
import {
  judgeDifficulty,
  matchesLightEvent,
  resolveTrack,
  trackFor,
  type Difficulty,
  type DifficultyPolicy,
} from './difficulty.ts';
import { MODE_SEVERITY } from './mode.ts';
import { ModeManager } from './mode.ts';
import { OutboxWriter } from './outbox.ts';
import { PoolManager } from './pool.ts';
import { ReconScanner } from './recon.ts';
import { RouterRuntime, SlotSemaphore } from './runtime.ts';
import type { AlertChannelName, ChatCall, ModelTransport, ModelsConfig, ProbeResult, WarmState } from './types.ts';
import {
  createModelTransport,
  EmptyResponseError,
  HttpTransport,
  isEmptyShellResponse,
  StubTransport,
} from './transport.ts';
import { expandHome } from './paths.ts';

/**
 * §4.1 bad_protocol：响应 200 但 tool_call 参数不是合法 JSON。
 * 名字与 candidates.ts classifyError 的 `e.name === 'BadProtocolError'` 分支对齐
 * （该分支是熔断器归类用的，不新增 shared/errors.ts 类——错误分类不进跨模块契约）。
 */
class BadProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadProtocolError';
  }
}

/** 单候选最小可用预算（§4.2:remaining < MIN_USEFUL_MS(5000) 才 break）。 */
const MIN_USEFUL_MS = 5000;
/**
 * 缓存命中率在排序键里的权重（见 candidateRankKey 的分层理由）。
 * 只够在健康度几乎相同时打破平局，不足以让一个高缓存但低成功率的端点翻盘。
 */
const CACHE_RANK_WEIGHT = 0.05;
/** 轨默认总预算（§4.2 预算规则:primary 300s / light 60s）。 */
const DEFAULT_BUDGET_MS: Record<Track, number> = { primary: 300_000, light: 60_000 };
/** 本地闸门预算（§4.2 localGate(ep, 2000)）。 */
const LOCAL_GATE_BUDGET_MS = 2000;
/** ensureToolQualified 现测上限（§4.4:min(40s, remaining/2)）。 */
const POOL_QUALIFY_CAP_MS = 40_000;
/** 池 health 探测超时（§4.4 第 1 条:5s）。 */
const HEALTH_PROBE_MS = 5000;
/** 合成探活（breaker.probe_timer 的 light ping）超时。 */
const PROBE_CHAT_MS = 8000;

// ═══════════════════════════════════════════════════════════════════
// P1-1 生产请求闸的参数（取值依据见各处注释）
// ═══════════════════════════════════════════════════════════════════

/**
 * 生产排队上限：拿到端点槽位前最多等多久。
 *
 * 取值依据：`DEFAULT_BUDGET_MS.primary = 300_000`（轨总预算），一个请求在单个端点上的
 * 合理排队不该吃掉整个预算；`MIN_USEFUL_MS = 5000`（剩余预算不足以再试一个候选的下限）。
 * 取 **30s**：
 *  - 远大于单次模型请求的典型耗时（秒级到十几秒），足够把"并发请求"排成一列逐个通过；
 *  - 又明显小于轨预算（300s/1），排队超时后仍有充足预算换端点/等重试；
 *  - 与 `local.queue_reject_ms` 的默认 8000ms 同量级偏宽松——本地引擎 8s 排队失败是
 *    "启动期 warm 没跟上"的语义，而生产并发排队是**常态**，不该同样苛刻。
 */
const PRODUCTION_QUEUE_MS = 30_000;

/**
 * 未声明并发能力的**远程**端点，生产闸的默认容量。
 *
 * 取值依据（重要，别想当然）：
 *  - 远程 OpenAI 兼容服务（OpenRouter 等）的 capacity 是**服务端共享配额**，
 *    我们本地既测不到也不该猜；设成 1 会把本来能并行的调用强行串行化，
 *    反而拖慢每个任务（收益为负）；设成很大则等于没有闸。
 *  - 这里取 **4**：与 `DEFAULT_CP.maxRunningTasks` 的"人工开并发时通常会开到几"对齐，
 *    足以让 2–4 个任务并行跑不同的模型请求，同时又不至于把远端打成 429 风暴。
 *  - 真正有单并发约束的端点**应当显式声明**（`local.max_concurrency` 或 `max_concurrency`），
 *    声明了就严格按声明值排队——本常量只是"没声明时"的保守兜底。
 */
const DEFAULT_REMOTE_CONCURRENCY = 4;

/**
 * 端点生产并发容量（按可靠性递减）。
 *
 * 1. `ep.local.max_concurrency`：本地引擎的硬上限（Colibrì 无 batching，=1），最权威；
 * 2. `ep.maxConcurrency`：远程端点的可选显式声明；
 * 3. `DEFAULT_REMOTE_CONCURRENCY`：未声明时的兜底。
 */
function capacityOf(ep: EndpointDef): number {
  if (ep.local !== undefined && ep.local.max_concurrency > 0) return ep.local.max_concurrency;
  if (ep.maxConcurrency !== undefined && ep.maxConcurrency > 0) return ep.maxConcurrency;
  return DEFAULT_REMOTE_CONCURRENCY;
}

/** 心跳调度器（契约 J4:ControlPlane.registerInternalJob 的 spec 形状）。 */
export interface HeartbeatApi {
  registerInternalJob(spec: {
    name: string;
    kind: 'light' | 'heavy';
    cron?: string;
    everyMs?: number;
    run: () => Promise<void>;
  }): void;
}

export interface ModelRouterDeps {
  db: DatabaseSync;
  /** 配置目录（含 models.yml / free-models.yml）。 */
  configDir: string;
  scheduler: HeartbeatApi;
  /** 通知通道模块；阶段一传 null（全程落 OUTBOX.md，§4.5 通道可用性判定）。 */
  channels: NotificationChannels | null;
  bus: EventBus;
  /** 契约 T2:队列模块注入；未注入时求救模板打"未知（队列未上报）"。 */
  taskImpact?: TaskImpactProvider;
  /** transport 注入（测试直接注入 StubTransport；缺省按 DOTD_MODEL_TRANSPORT 选路）。 */
  transport?: ModelTransport;
  /** 时钟注入（测试假时钟）。 */
  now?: () => number;
}

/** 一次 route 调用内的尝试记录（§4.2 tried 数组）。 */
interface TryEntry extends TryRecord {
  failure?: FailureKind;
}

/** model_call_log.outcome 的合法值（DDL CHECK 逐字）。 */
type CallOutcome =
  | 'ok'
  | 'fail'
  | 'breaker_skip'
  | 'throttle_skip'
  | 'half_open_busy_skip'
  | 'stream_broken';

/**
 * ModelRouter。
 *
 * 线程模型（契约 D2/CT）:单进程、单写者，全部同步事务；无锁无并发队列，
 * 半开并发裁决靠内存计数器 + half_open_max_concurrency=1（§4.1）。
 */
export class ModelRouter {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus;
  private readonly scheduler: HeartbeatApi;
  private readonly now: () => number;

  private cfg!: ModelsConfig;
  private readonly configDir: string;
  private readonly transport: ModelTransport;
  private breaker!: Breaker;
  private modeMgr!: ModeManager;
  private alerts!: AlertManager;
  private outbox!: OutboxWriter;
  private pool!: PoolManager;
  private recon!: ReconScanner;
  /** 端点健康度评分（迁移自 PilotDeck ProviderHealthTracker；无自有表，从 breaker_sample 现算）。 */
  private health!: HealthTracker;
  /** 提示缓存命中率（迁移自 PilotDeck cache-aware switching；无自有表，从 model_call_log 现算）。 */
  private cache!: CacheTracker;
  private readonly runtime = new RouterRuntime();

  /** 内存态:全部候选（tier1/2 配置 + tier3 池）。Tier4 只在 recon 提案里。 */
  private endpoints: EndpointDef[] = [];
  /** Tier2 warm 状态（按端点 id 索引）。 */
  private readonly warm = new Map<string, WarmState>();
  /**
   * P1-1 生产请求信号量（按端点 id）。与 `runtime` 的探活槽**刻意分开**：
   * 那套只服务 tier2 本地引擎 + busy 记账；这套是"所有 tier 的在途模型请求数"闸，
   * 超限排队、排队超时才降级，且**绝不**参与熔断结算。
   */
  private readonly productionSlots = new Map<string, SlotSemaphore>();
  /** route() 内置 helpDirty 位（§4.5 同签名节流，1min 心跳结算）。 */
  private helpDirty = false;
  /** 当前实际服务端点（mode 恢复判定/模板"当前承载"）。 */
  private servedBy: string | null = null;
  private disposed = false;

  private constructor(deps: ModelRouterDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.scheduler = deps.scheduler;
    this.now = deps.now ?? Date.now;
    this.configDir = deps.configDir;
    this.transport = deps.transport ?? createModelTransport();
  }

  /**
   * §5.1 `load(deps)`:读配置 → 建熔断/mode/求救/池/侦察 → **同步执行 §4.7 启动对账** →
   * 注册四个定时任务（契约 J4/T6）。
   */
  static load(deps: ModelRouterDeps): ModelRouter {
    const self = new ModelRouter(deps);
    self.loadConfigFiles();
    self.breaker = new Breaker({ db: deps.db, cfg: self.cfg.breaker, now: self.now });
    self.breaker.loadFromDb();
    self.health = new HealthTracker({ breaker: self.breaker, now: self.now });
    self.cache = new CacheTracker({ db: deps.db, now: self.now });
    // §3.1/§5.3：熔断器状态迁移必须广播 router.breaker_changed（channel='breaker'，
    // bus.ts:55 已预留主题）。熔断既可能改变可服务端点集合（mode 重算），也是
    // Web UI / CLI 观察面的事件源——不发布则 UI 只能靠轮询，且降级无声。
    self.breaker.onTransition = (e) => {
      self.bus.publish('router.breaker_changed', {
        type: 'breaker_changed',
        endpointId: e.endpointId,
        track: e.track,
        from: e.from,
        to: e.to,
      });
      self.recomputeMode();
    };
    self.outbox = new OutboxWriter(expandHome(self.cfg.alerts.outbox_path), self.now);
    self.pool = new PoolManager({ db: deps.db, now: self.now });
    self.pool.loadFile(self.poolFilePath());
    self.modeMgr = new ModeManager({ db: deps.db, bus: deps.bus, breaker: self.breaker, now: self.now });
    self.alerts = new AlertManager({
      db: deps.db,
      cfg: self.cfg.alerts,
      channels: deps.channels,
      outbox: self.outbox,
      taskImpact: deps.taskImpact ?? null,
      now: self.now,
    });
    self.recon = new ReconScanner({
      db: deps.db,
      bus: deps.bus,
      cfg: self.cfg.recon,
      pool: self.pool,
      now: self.now,
    });
    self.rebuildEndpoints();
    self.reconcileOnBoot();
    self.registerJobs();
    return self;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 配置
  // ═══════════════════════════════════════════════════════════════════

  /**
   * free-models.yml 的落盘路径（§2.1：`free_models_file: config/free-models.yml`）。
   *
   * 该键声明在 models.yml **内部**，故基准是 models.yml 所在目录（= configDir）。但
   * 示例 `dotd/config/models.yml` 写的是 `config/free-models.yml`——若只按 configDir 直拼会
   * 得到 `<configDir>/config/free-models.yml`（真实 daemon 下即 `config/config/…`，永远找不到，
   * 池静默变空）。因此按下列顺序取**第一个已存在**的候选，都不存在时用最后一个作默认：
   *   1. `~` 开头 → expandHome（契约 T3 同款约定）；
   *   2. 绝对路径 → 原样；
   *   3. `resolve(configDir, p)`（声明的相对路径，直拼 configDir）；
   *   4. `resolve(configDir, basename(p))`（models.yml 同级的池文件——示例配置的真实意图，
   *      也是测试往临时 configDir 写池文件时的命中路径）；
   *   5. `resolve(cwd, p)`（cwd=仓库根时的兼容路径）。
   */
  private poolFilePath(): string {
    const p = this.cfg.free_models_file;
    if (p.startsWith('~')) return expandHome(p);
    if (isAbsoluteish(p)) return p;
    const base = basename(p);
    const declared = resolve(this.configDir, p);
    const sibling = resolve(this.configDir, base);
    if (existsSync(declared)) return declared;
    if (existsSync(sibling)) return sibling;
    const fromCwd = resolve(process.cwd(), p);
    if (existsSync(fromCwd)) return fromCwd;
    // 都没有：默认落 models.yml 同级（新建池文件的语义最直观，reload 后即生效）
    return sibling;
  }

  /**
   * 读 models.yml（GOV §2.3 同款:校验失败 = ConfigError = 拒启动，不静默回落默认值）。
   */
  private loadConfigFiles(): void {
    this.cfg = loadModelsConfig(join(this.configDir, 'models.yml'));
  }

  /** models.yml 热加载（文件监听自动触发；runtime 重建语义见 §4.7）。 */
  reloadConfig(): void {
    const prevIds = new Set(this.endpoints.map((e) => e.id));
    this.loadConfigFiles();
    this.pool.loadFile(this.poolFilePath());
    this.breaker.allowHalfOpenAfterReload();
    this.rebuildEndpoints();
    // §4.7 reload diff 三类：新增建 sem / 删除待回收 / 改容量 resize
    for (const ep of this.endpoints) {
      if (ep.local !== undefined) this.runtime.ensure(ep.id, ep.local.max_concurrency);
    }
    const nextIds = new Set(this.endpoints.map((e) => e.id));
    for (const id of prevIds) if (!nextIds.has(id)) this.runtime.markRemoved(id);
    this.runtime.recycleRemoved(this.now());
    this.recomputeMode();
    this.bus.publish('config.models_reloaded', { endpoints: this.endpoints.length });
  }

  private rebuildEndpoints(): void {
    const list: EndpointDef[] = [];
    for (const ep of this.cfg.endpoints) {
      list.push(ep);
      if (ep.local !== undefined) {
        this.runtime.ensure(ep.id, ep.local.max_concurrency);
        if (!this.warm.has(ep.id)) {
          this.warm.set(ep.id, { healthOkSince: null, graceUntil: null, lastWarmOkAt: null });
        }
      }
    }
    list.push(...this.pool.poolEndpoints());
    this.endpoints = list;
  }

  /**
   * §5.7 求救投递的真实形状（顺序 + 兜底文件），供 `/api/channels` 与 `dotd sos-test`
   * 如实上报。此前 CLI 自检把"telegram 未装配"硬编码成结论，而 2026-10-17 起求救
   * 已经改走飞书——自检说的话与现实相反，比没有自检更糟。
   */
  alertsRoute(): { order: readonly AlertChannelName[]; outboxPath: string } {
    return { order: this.cfg.alerts.channel_order, outboxPath: this.cfg.alerts.outbox_path };
  }

  // ═══════════════════════════════════════════════════════════════════
  // §4.7 启动对账（load() 末尾同步执行）
  // ═══════════════════════════════════════════════════════════════════

  private reconcileOnBoot(): void {
    // 1. alert_dispatch pending 超 2min → 补投一次，失败标 lost（§4.5）
    void this.alerts.reconcilePending();
    // 2/3. recon_candidate approved↔free-models.yml 双向核对
    this.recon.reconcile();
    this.pool.retryPendingFileWrites();
    // 4. 从 router_state 恢复 mode/emergencyActive，立即重算校验
    this.modeMgr.recompute({
      candidates: this.endpoints,
      isToolQualified: (ep) => this.isCertFresh(ep),
      servedBy: null,
    });
  }

  private isCertFresh(ep: EndpointDef): boolean {
    const entry = this.pool.findEntry(ep.id);
    if (entry === undefined) return false;
    return this.pool.hasFreshCertification(entry);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 定时任务（契约 J4/T6：registerInternalJob，run 回调直调）
  // ═══════════════════════════════════════════════════════════════════

  private registerJobs(): void {
    // breaker.probe_timer（1min）：扫 next_probe_at 到期者 + 结算 helpDirty + 重试写文件
    this.scheduler.registerInternalJob({
      name: 'breaker.probe_timer',
      kind: 'light',
      everyMs: 60_000,
      run: async () => {
        if (this.disposed) return;
        await this.probeTick();
      },
    });
    // router.janitor（每日）：表回收 + 候选 TTL
    this.scheduler.registerInternalJob({
      name: 'router.janitor',
      kind: 'light',
      everyMs: 24 * 3_600_000,
      run: async () => {
        if (this.disposed) return;
        this.janitorTick();
      },
    });
    // recon.scan（6h，仅非 NORMAL）
    this.scheduler.registerInternalJob({
      name: 'recon.scan',
      kind: 'light',
      everyMs: this.cfg.recon.interval_ms,
      run: async () => {
        if (this.disposed) return;
        if (this.modeMgr.current === 'NORMAL') return;
        await this.recon.scan(this.transport, this.modeMgr.current);
      },
    });
    // pool.probe.*（30min，light 轨）
    for (const ep of this.pool.poolEndpoints()) {
      this.scheduler.registerInternalJob({
        name: `pool.probe.${ep.id}`,
        kind: 'light',
        everyMs: 30 * 60_000,
        run: async () => {
          if (this.disposed) return;
          await this.poolProbe(ep.id);
        },
      });
    }
  }

  /** 1min 心跳:半开探活到期 + helpDirty 结算 + 文件重试 + slot 回收。 */
  private async probeTick(): Promise<void> {
    this.runtime.recycleRemoved(this.now());
    this.pool.retryPendingFileWrites();
    // 半开合成探活（§4.1 末段）：无真实流量时由定时器合成最小请求
    for (const { endpointId, track } of this.breaker.dueProbes(this.now())) {
      const ep = this.endpoints.find((e) => e.id === endpointId);
      if (ep === undefined) continue;
      if (!this.breaker.maybeHalfOpen(endpointId, track)) continue;
      // light 轨发 8-token 的 ping；primary 轨不发合成探活（工具调用质量无法用 ping 验）
      if (track !== 'light') continue;
      try {
        const slot = await this.tryAcquireSlot(ep);
        if (slot === null) continue;
        try {
          await this.transport.chat(
            this.chatCall(ep, 'light', [{ role: 'user', content: 'ping' }], undefined, undefined, PROBE_CHAT_MS, true),
          );
          this.breaker.settle({ endpointId, track: 'light', ok: true });
        } catch (err) {
          const { kind } = classifyError(err);
          this.breaker.settle({ endpointId, track: 'light', ok: false, kind });
        } finally {
          slot.release();
        }
      } catch {
        // 探活失败不影响心跳
      }
    }
    // 结算 helpDirty（§4.5 同签名节流：mode 一变差 1min 内发出）
    if (this.helpDirty) {
      this.helpDirty = false;
      await this.maybeSendHelp();
    }
  }

  /** 每日 janitor（§3.2 体积与回收）。 */
  private janitorTick(): void {
    this.breaker.janitor(this.now());
    this.pool.janitor();
    this.recon.janitor();
    // model_call_log：30 天回收，>20 万行时截老
    this.db
      .prepare('DELETE FROM model_call_log WHERE ts < ?')
      .run(this.now() - 30 * 86_400_000);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM model_call_log').get() as { n: number };
    if (count.n > 200_000) {
      this.db
        .prepare(
          `DELETE FROM model_call_log WHERE id IN (
             SELECT id FROM model_call_log ORDER BY id ASC LIMIT ?)`,
        )
        .run(count.n - 200_000);
    }
  }

  /** 池 health 探测（§4.4 第 1 条；失败 → 两轨各记一个 pool_unverified 样本）。 */
  private async poolProbe(endpointId: string): Promise<void> {
    const ep = this.endpoints.find((e) => e.id === endpointId);
    if (ep === undefined) return;
    const r = await this.pool.probeHealth(this.transport, ep);
    if (!r.ok) {
      for (const track of ['light', 'primary'] as const) {
        this.breaker.settle({ endpointId, track, ok: false, kind: 'pool_unverified', detail: r.detail });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 核心调用面（契约 T1：唯一）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 非流式路由（§4.2 route() 主流程）。
   *
   * 单向降级:tier1→2→3→4 一次一圈，**失败永远向前降级，绝不向上涨档重试**；
   * 预算耗尽（remaining < MIN_USEFUL_MS）自然止损；候选数不设硬上限。
   */
  async complete(req: RouteRequest): Promise<RouteResult> {
    const deadline = req.deadlineMs ?? DEFAULT_BUDGET_MS[req.track];
    const startedAt = this.now();
    const tried: TryEntry[] = [];
    let attemptSeq = 0;

    for (const ep of pickCandidates(
      this.endpoints,
      this.modeMgr.current,
      req.track,
      (id, t) => this.candidateRankKey(id, t),
    )) {
      if (req.signal?.aborted === true) break;
      const remaining = deadline - (this.now() - startedAt);
      if (remaining < MIN_USEFUL_MS) break;

      const b = this.breaker.view(ep.id, req.track);
      if (b.state === 'open') {
        // auth 熔断：open 后首个到达请求转抛 AuthConfigError（§5.2 错误契约）
        if (this.breaker.isAuthLocked(ep.id, req.track) && b.lastKind === 'auth') {
          throw new AuthConfigError(ep.id);
        }
        this.noteSkip(req, ep, tried, 'breaker_skip', attemptSeq++);
        continue;
      }
      // 半开探活槽：本迭代持有、出口必须还。原先只靠 breaker.transition() 释放，而
      // half_open_success_needed=2 时首次成功并不迁移状态——槽就此泄漏，之后每个请求都被
      // half_open_busy_skip 挡死，端点卡在半开状态直到重启（2026-10-17 实测：tier1 恢复时
      // 3 个在途任务全部 busy_skip，只能重启 daemon 清掉泄漏的槽）。
      const halfOpenLease =
        b.state === 'half_open' ? this.breaker.halfOpenSlot(ep.id, req.track) : null;
      if (halfOpenLease !== null && !halfOpenLease.tryAcquire()) {
        // §4.1 并发裁决：第 2..N 个并发请求按 open 对待，不等待、不入窗、不改状态
        this.noteSkip(req, ep, tried, 'half_open_busy_skip', attemptSeq++);
        continue;
      }
      try {
        if (b.throttledUntil !== null && b.throttledUntil > this.now()) {
          this.noteSkip(req, ep, tried, 'throttle_skip', attemptSeq++);
          continue;
        }

        // Tier3 + primary：工具合格证闸门（§4.4 ensureToolQualified）
        if (ep.tier === 3 && req.track === 'primary') {
          const q = await this.ensureToolQualified(ep, remaining);
          if (!q.ok) {
            this.noteFail(req, ep, tried, 'pool_unverified', attemptSeq++, q.detail, { settle: true });
            continue;
          }
        }

        const cap = this.capFor(ep, remaining);

        // Tier2：本地闸门 + 槽位（§4.2 逐字）
        if (ep.tier === 2) {
          const gate = await localGate(
            this.transport,
            ep,
            this.warmState(ep.id),
            this.now,
            LOCAL_GATE_BUDGET_MS,
          );
          if (!gate.ok) {
            if (gate.warming) {
              // 宽限期内 warm 未过 = 加载中：跳过该端点但**不入窗**（§2.1）
              this.noteFail(req, ep, tried, 'engine_unavailable', attemptSeq++, gate.reason, {
                settle: false,
              });
              continue;
            }
            this.noteFail(req, ep, tried, 'engine_unavailable', attemptSeq++, gate.reason, {
              settle: true,
            });
            continue;
          }
          const lease = await this.acquireSlot(ep);
          if (lease === null) {
            // busy 规则（§4.1）：单次不入窗；连续达 busy_consec_limit 才记 engine_unavailable
            const nowBusy = this.runtime.get(ep.id)?.busyConsec ?? 0;
            this.noteFail(req, ep, tried, 'engine_unavailable', attemptSeq++, '槽位 busy', {
              settle: nowBusy >= this.cfg.breaker.busy_consec_limit,
            });
            continue;
          }
          try {
            return await this.runWithProductionSlot(ep, req, cap, tried, () => attemptSeq++);
          } catch {
            // 记账（tried + model_call_log + 熔断结算）已在 runModelChain 内逐模型完成，
            // 这里只负责"换下一个端点"——再记一次会把一次失败算成两次，窗口比例被污染。
            continue;
          } finally {
            lease.release();
          }
        }

        // Tier1/Tier3/Tier4
        try {
          return await this.runWithProductionSlot(ep, req, cap, tried, () => attemptSeq++);
        } catch {
          // 同 Tier2 分支：失败记账已在 runModelChain 内完成
          continue;
        }
      } finally {
        halfOpenLease?.release();
      }
    }

    // §4.3 末条「降级即求救评估」：一圈扫描走完仍无承载（含 breaker 结算后新开的端点），
    // 必须在抛耗尽错误前重算 mode——否则 tier1 刚 open、tier2 无 primary 时 mode 仍停在
    // NORMAL，LOCAL_FALLBACK/TOTAL_OUTAGE 永远不会被观测到，求救与 emergencyActive 全丢失。
    this.recomputeMode();
    throw this.buildExhaustedError(tried, req.track);
  }

  /**
   * 流式（§4.7）。
   *
   * 分界点 = 首字节:`meta()` 在选定端点、首个 chunk 下发前 resolve；首字节前的失败等价于
   * 非流式（换下一候选）；首字节后断流**绝不自动换端点重放**（重发会吐重复内容，
   * 直接违反 journal"绝不重复执行"）——抛 StreamInterruptedError 交调用方裁决。
   *
   * 工具调用（roadmap P0-2）：transport 逐块吐 `ChatChunk.toolCalls` 增量，本方法用
   * `StreamToolCallAccumulator`（shared/tool-stream.ts，容错规则只此一份）边收边聚合；
   * 回合正常结束后通过返回对象的 `toolCalls()` 交出**成品**。调用方必须**等流读完**
   * 再读 `toolCalls()`（未读完时它反映的是"目前收到多少"，不是定稿）。
   */
  stream(req: RouteRequest): AsyncIterable<ChatChunk> & {
    meta(): Promise<RouteMeta>;
    /** 回合结束后的完整工具调用（无调用 = 空数组）。流未读完时为当前进度。 */
    toolCalls(): AggregatedToolCall[];
  } {
    const deadline = req.deadlineMs ?? DEFAULT_BUDGET_MS[req.track];
    const startedAt = this.now();
    const tried: TryEntry[] = [];
    let attemptSeq = 0;
    let streamStarted = false;
    let consumed = 0;
    let text = '';
    const self = this;
    // 工具调用增量聚合器：**每次尝试新建**（换候选/换模型时不能串账）。
    // 当前这轮（成功那轮）的聚合器存这里，收口后由 handle.toolCalls() 读出。
    let toolAcc = new StreamToolCallAccumulator();

    let metaResolve!: (m: RouteMeta) => void;
    let metaReject!: (e: unknown) => void;
    const metaPromise = new Promise<RouteMeta>((res, rej) => {
      metaResolve = res;
      metaReject = rej;
    });
    // 调用方可能只迭代不读 meta()：内部吞掉 rejection 防未处理告警
    metaPromise.catch(() => undefined);

    async function* gen(): AsyncGenerator<ChatChunk> {
      // 选端点：复用非流式的闸门序列，但在"发首个 chunk 前"才算失败
      for (const ep of pickCandidates(
        self.endpoints,
        self.modeMgr.current,
        req.track,
        (id, t) => self.candidateRankKey(id, t),
      )) {
        if (req.signal?.aborted === true) break;
        const remaining = deadline - (self.now() - startedAt);
        if (remaining < MIN_USEFUL_MS) break;
        const b = self.breaker.view(ep.id, req.track);
        if (b.state === 'open') {
          if (self.breaker.isAuthLocked(ep.id, req.track) && b.lastKind === 'auth') {
            const authErr = new AuthConfigError(ep.id);
            metaReject(authErr);
            throw authErr;
          }
          self.noteSkip(req, ep, tried, 'breaker_skip', attemptSeq++);
          continue;
        }
        // 半开探活槽：本迭代持有、出口必须还（同 complete()，理由见那边的注释）。
        const halfOpenLease =
          b.state === 'half_open' ? self.breaker.halfOpenSlot(ep.id, req.track) : null;
        if (halfOpenLease !== null && !halfOpenLease.tryAcquire()) {
          self.noteSkip(req, ep, tried, 'half_open_busy_skip', attemptSeq++);
          continue;
        }
        try {
          if (b.throttledUntil !== null && b.throttledUntil > self.now()) {
            self.noteSkip(req, ep, tried, 'throttle_skip', attemptSeq++);
            continue;
          }
          if (ep.tier === 3 && req.track === 'primary') {
            const q = await self.ensureToolQualified(ep, remaining);
            if (!q.ok) {
              self.noteFail(req, ep, tried, 'pool_unverified', attemptSeq++, q.detail, { settle: true });
              continue;
            }
          }
          let lease: { release(): void } | null = null;
          if (ep.tier === 2) {
            const gate = await localGate(
              self.transport,
              ep,
              self.warmState(ep.id),
              self.now,
              LOCAL_GATE_BUDGET_MS,
            );
            if (!gate.ok) {
              self.noteFail(req, ep, tried, 'engine_unavailable', attemptSeq++, gate.reason, {
                settle: !gate.warming,
              });
              continue;
            }
            lease = await self.acquireSlot(ep);
            if (lease === null) {
              const nowBusy = self.runtime.get(ep.id)?.busyConsec ?? 0;
              self.noteFail(req, ep, tried, 'engine_unavailable', attemptSeq++, '槽位 busy', {
                settle: nowBusy >= self.cfg.breaker.busy_consec_limit,
              });
              continue;
            }
          }
          const cap = self.capFor(ep, remaining);
          // 端点内模型链（迁移自 PilotDeck runFallbackChain）：**只在首字节前**降级到
          // 备用模型。首字节后模型锁定——重放会吐重复内容，直接违反 journal
          // 「绝不重复执行」，所以断流仍走 StreamInterruptedError 交调用方裁决。
          const chain = modelChain(ep, req.track);
          try {
            for (let i = 0; i < chain.length; i++) {
              const model = chain[i];
              if (model === undefined) continue;
              const mySeq = attemptSeq++;
              const isLast = i === chain.length - 1;
              const streamT0 = self.now();
              // 每次尝试一个全新聚合器：换模型/换候选时工具调用不能串账。
              toolAcc = new StreamToolCallAccumulator();
              const myAcc = toolAcc;
              try {
                const handle = self.transport.stream(
                  self.chatCall(ep, req.track, req.messages, req.tools, req.tool_choice, cap.total_ms, false, req, model),
                );
                for await (const chunk of handle) {
                  if (!streamStarted) {
                    streamStarted = true;
                    // 首字节前 resolve（§4.7 分界点）
                    metaResolve({
                      endpointId: ep.id,
                      tier: ep.tier,
                      model,
                      degraded: isDegraded(ep, req.track),
                      attemptSeq: mySeq,
                      tried: tried.map(toTryRecord),
                      streamStarted: true,
                    });
                  }
                  // 工具调用增量：先入聚合器（不受"正文为空则不 yield"影响——
                  // 纯工具轮的 delta 为空，旧实现会把它整块丢掉）。
                  if (chunk.toolCalls !== undefined && chunk.toolCalls.length > 0) {
                    myAcc.push(chunk.toolCalls);
                  }
                  if (chunk.delta.length > 0) {
                    text += chunk.delta;
                    yield chunk;
                  } else if (chunk.toolCalls !== undefined && chunk.toolCalls.length > 0) {
                    // 不带正文的工具增量也要往下传（调用方据此知道"这是工具轮"），
                    // 但 `text` 不计入——首字节后断流的 textSoFar 语义保持不变。
                    yield chunk;
                  }
                  if (chunk.done === true) break;
                }
                const usage = await handle.usage();
                consumed = usage?.completionTokens ?? 0;
                // 零用量空壳：流式路径同一个坑（handle 跑完、一个 delta 都没有、
                // usage 也是空的）。**没向调用方吐过任何字节、也没收到工具调用**
                // 才够资格重试，否则就是 §4.7 首字节后断流，绝不重放。
                if (
                  isEmptyShellResponse({ content: text, toolCalls: undefined }, usage) &&
                  text.length === 0 &&
                  myAcc.size === 0
                ) {
                  throw new EmptyResponseError(
                    `端点 ${ep.id} 模型 ${model} 返回零用量空壳（流式无正文、completion_tokens=${consumed}）`,
                  );
                }
                self.logCall(req, ep, 'ok', mySeq, undefined, usage ?? null, model, self.now() - streamT0);
                self.breaker.settle({ endpointId: ep.id, track: req.track, ok: true });
                self.servedBy = ep.id;
                self.recomputeMode();
                return;
              } catch (err) {
                // 零用量空壳优先于 streamStarted 判定：空壳时一个 delta 都没 yield 过
                // （下面 text.length === 0 就是证据），调用方手里没有任何字节，
                // 重放不违反 §4.7「首字节后绝不重放」——那条规则保护的是**已交付的内容**。
                // 注意 streamStarted 在"首 chunk 是空 delta + done"时也会被置真，
                // 所以不能靠它区分；靠 text 长度。
                if (err instanceof EmptyResponseError && text.length === 0 && !isLast) {
                  self.noteModelFail(req, ep, tried, 'empty_response', mySeq, model);
                  continue;
                }
                if (streamStarted) {
                  // 首字节后断流：绝不重放（§4.7）
                  self.breaker.settle({ endpointId: ep.id, track: req.track, ok: false, kind: 'network', detail: String(err) });
                  self.logCall(req, ep, 'stream_broken', mySeq, 'network', null, model, self.now() - streamT0);
                  throw new StreamInterruptedError(consumed, text, { cause: err });
                }
                const { kind, retryAfterMs } = classifyError(err);
                if (isLast || !isModelScopedKind(kind)) {
                  // 端点级故障（auth/engine/pool）或链尾：结算熔断后换端点。
                  // 端点级故障不能继续试本端点的下一个模型——凭据/引擎坏了，
                  // 换模型照样挂，白烧一遍链尾。
                  self.noteFail(req, ep, tried, kind, mySeq, String(err), { settle: true, retryAfterMs }, model);
                  if (kind === 'auth') self.helpDirty = true;
                  break;
                }
                // 模型级故障：记账但不入窗，继续试下一个模型（同 complete() 分支）
                self.noteModelFail(req, ep, tried, kind, mySeq, model);
              }
            }
          } finally {
            lease?.release();
          }
        } finally {
          halfOpenLease?.release();
        }
      }
      // 首字节前全候选耗尽：meta() 与 stream() 同步抛耗尽错误（§4.7，meta() 永不挂起）
      if (!streamStarted) {
        // 与非流式同一不变量：失败路径也要重算 mode（§4.3 降级即求救评估）
        self.recomputeMode();
        const err = self.buildExhaustedError(tried, req.track);
        metaReject(err);
        throw err;
      }
    }

    return {
      [Symbol.asyncIterator]: () => gen(),
      meta(): Promise<RouteMeta> {
        return metaPromise;
      },
      toolCalls(): AggregatedToolCall[] {
        return toolAcc.settle();
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // §4.4 池合格证 / §4.2 本地槽位
  // ═══════════════════════════════════════════════════════════════════

  /**
   * ensureToolQualified（§4.4）:
   * 有新鲜合格证 → ok；无 → 在 `min(40s, remaining/2)` 内现测，成功写证、失败返回 not-ok。
   */
  private async ensureToolQualified(
    ep: EndpointDef,
    remaining: number,
  ): Promise<{ ok: boolean; detail: string }> {
    if (this.isCertFresh(ep)) return { ok: true, detail: '合格证新鲜' };
    const budget = Math.min(POOL_QUALIFY_CAP_MS, Math.max(remaining / 2, MIN_USEFUL_MS));
    const r = await this.pool.toolRoundtrip(this.transport, ep, budget);
    return { ok: r.ok, detail: r.detail };
  }

  private warmState(endpointId: string): WarmState {
    let w = this.warm.get(endpointId);
    if (w === undefined) {
      w = { healthOkSince: null, graceUntil: null, lastWarmOkAt: null };
      this.warm.set(endpointId, w);
    }
    return w;
  }

  /** 单候选超时切分（§4.2 cap 规则:total 不超过 remaining/2，下限 MIN_USEFUL_MS）。 */
  private capFor(
    ep: EndpointDef,
    remaining: number,
  ): { connect_ms: number; idle_ms: number; total_ms: number } {
    return {
      connect_ms: ep.timeouts.connect_ms,
      idle_ms: ep.timeouts.idle_ms,
      total_ms: Math.min(ep.timeouts.total_ms, Math.max(remaining / 2, MIN_USEFUL_MS)),
    };
  }

  /** 获取 Tier2 槽位；busy 时按 §4.1 bumpBusy。 */
  private async acquireSlot(ep: EndpointDef): Promise<{ release(): void } | null> {
    if (ep.local === undefined) return { release: () => undefined };
    const sem = this.runtime.ensure(ep.id, ep.local.max_concurrency);
    const lease = await sem.tryAcquire(ep.local.queue_reject_ms);
    if (lease === null) {
      this.runtime.bumpBusy(ep.id);
      return null;
    }
    this.runtime.clearBusy(ep.id);
    return { release: () => lease.release() };
  }

  /**
   * 过生产信号量再跑模型链（P1-1）。
   *
   * 语义与 `runModelChain` 完全一致，只多一道"按端点排队"：
   *  - 拿到槽位 → 跑链 → finally 归还；
   *  - 排队超时（`PRODUCTION_QUEUE_MS`）→ **不记端点故障**、不 bump busy、不入熔断窗口，
   *    只记一条 `engine_unavailable` 的 tried 记录并抛可重试错误，让上层换端点/降级。
   *    这与现有 busy 规则（§4.1：单次 busy 不入窗）保持同口径。
   */
  private async runWithProductionSlot(
    ep: EndpointDef,
    req: RouteRequest,
    cap: { connect_ms: number; idle_ms: number; total_ms: number },
    tried: TryEntry[],
    nextSeq: () => number,
  ): Promise<RouteResult> {
    const slot = await this.acquireProductionSlot(ep);
    if (slot === null) {
      const err = new Error(
        `端点 ${ep.id} 生产并发已满且排队超时（${PRODUCTION_QUEUE_MS}ms，capacity=${capacityOf(ep)}）`,
      );
      this.noteFail(req, ep, tried, 'engine_unavailable', nextSeq(), err.message, { settle: false });
      throw err;
    }
    try {
      return await this.runModelChain(ep, req, cap, tried, nextSeq);
    } finally {
      slot.release();
    }
  }

  /** 探活用（不 bump busy）。 */
  private async tryAcquireSlot(ep: EndpointDef): Promise<{ release(): void } | null> {
    if (ep.local === undefined) return { release: () => undefined };
    const sem = this.runtime.ensure(ep.id, ep.local.max_concurrency);
    const lease = await sem.tryAcquire(ep.local.queue_reject_ms);
    return lease === null ? null : { release: () => lease.release() };
  }

  // ═══════════════════════════════════════════════════════════════════
  // P1-1 生产请求信号量（§4.1 槽位规则的**生产侧**补充，与探活分开）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 生产请求闸：按端点限制**同时在途的模型请求数**，超出则**排队**（不是快速失败）。
   *
   * 为什么必须与 `acquireSlot`/`tryAcquireSlot` 分开：
   *  - 那套只对 `ep.local !== undefined` 生效，且只在 `tier === 2` 分支里调用；
   *    Tier1/Tier3/Tier4 的生产主路径（`runModelChain`）**完全没有闸**。
   *  - 它的语义是"本地引擎健康探活 + busy 记账"（`bumpBusy` 会参与熔断结算）。
   *    生产并发是另一回事：这里**绝不 bump busy、绝不入窗**，排队等待也不记为故障。
   *
   * 容量从哪来（按可靠性递减）：
   *  1. `ep.local.max_concurrency`（本地引擎声明的硬上限，最权威）；
   *  2. `ep.maxConcurrency`（远程端点可选声明，见 config.ts）；
   *  3. 未声明 = `DEFAULT_REMOTE_CONCURRENCY`（保守：远程端点按"未知能力"当 1 处理？
   *     **不是**——见下面的取值依据）。
   *
   * 取值依据见 {@link defaultProductionConcurrency}。
   */
  private productionSem(ep: EndpointDef): SlotSemaphore {
    let sem = this.productionSlots.get(ep.id);
    if (sem === undefined) {
      sem = new SlotSemaphore(capacityOf(ep));
      this.productionSlots.set(ep.id, sem);
    } else {
      const want = capacityOf(ep);
      if (sem.capacity !== want) sem.resize(want);
    }
    return sem;
  }

  /**
   * 取一次生产请求许可（排队上限 `PRODUCTION_QUEUE_MS`）。
   *
   * 返回 null = 排队超时：调用方按**可重试的暂时性不可用**处理（换端点/降级），
   * 而不是记为端点故障——这与 `busy` 的记账规则一致（单次不入窗）。
   */
  private async acquireProductionSlot(ep: EndpointDef): Promise<{ release(): void } | null> {
    const lease = await this.productionSem(ep).tryAcquire(PRODUCTION_QUEUE_MS);
    return lease === null ? null : { release: () => lease.release() };
  }


  // ═══════════════════════════════════════════════════════════════════
  // §4.8 callAndSettle：成功/失败都落 model_call_log（tried 与日志一一对）
  // ═══════════════════════════════════════════════════════════════════

  private async callAndSettle(
    ep: EndpointDef,
    req: RouteRequest,
    cap: { connect_ms: number; idle_ms: number; total_ms: number },
    mySeq: number,
    tried: TryEntry[],
    /** 链内第几个模型；缺省 = 主模型（迁移前行为）。 */
    model?: string,
  ): Promise<RouteResult> {
    const startedAt = this.now();
    const modelName = model ?? modelOf(ep, req.track);
    const outcome = await this.transport.chat(
      this.chatCall(ep, req.track, req.messages, req.tools, req.tool_choice, cap.total_ms, false, req, modelName),
    );
    const usage = outcome.usage;
    // §4.1 bad_protocol：响应 200 但 tool_call 参数不是合法 JSON → 抛 BadProtocolError
    // （classifyError 认它 → kind='bad_protocol'，模型级，换链上下一个模型）。
    // **不在这里**标记 capabilities.tool_calling：那是端点级判决，而这里的证据只来自
    // 一个模型。2026-10-17 修：原先在此处直接把端点记为 'no'，等于一个模型的坏响应
    // 杀死整个端点的 primary 资格——fallback 链下一个模型明明成功了，端点却因这个标记
    // 被 pickCandidates 滤掉，直到配置 reload。端点级判决挪到 runModelChain 的链尾。
    // 2026-10-25：错误消息带上"哪个工具、参数多长、JSON 错在哪"（不含参数内容）。
    // 原来只有一句"参数不是合法 JSON"，线上连撞 9 次也分不清是模型胡说还是被截断。
    const bad = badProtocolDetail(outcome.response);
    if (bad !== null) {
      throw new BadProtocolError(`tool_call 格式非法（§4.1 bad_protocol）：${bad}`);
    }
    // 零用量空壳（迁移自 PilotDeck "zero-usage retry"）：200 + 有 choices 却什么都没
    // 生成。**必须在 settle 之前拦**——拦在后面的话 breaker 会记一个 ok 样本，
    // 而 Runner 那侧会把它当成功收口（toolCalls 空 → doneFlag 置真、摘要留空），
    // 于是"端点很健康"和"任务完成了"两个假象同时成立，没有任何地方会发现。
    // kind='empty_response' 是模型级的（见 contracts.ts），换链下一个模型重试。
    if (isEmptyShellResponse(outcome.response, usage)) {
      throw new EmptyResponseError(
        `端点 ${ep.id} 模型 ${modelName} 返回零用量空壳（无正文、无工具调用、completion_tokens=${
          usage?.completionTokens ?? 0
        }）`,
      );
    }
    this.breaker.settle({
      endpointId: ep.id,
      track: req.track,
      ok: true,
      latencyMs: this.now() - startedAt,
    });
    this.logCall(req, ep, 'ok', mySeq, undefined, usage ?? null, modelName, this.now() - startedAt);
    const entry = this.tryEntry(ep, req.track, 'ok', undefined, modelName);
    entry.ms = this.now() - startedAt;
    tried.push(entry);
    this.servedBy = ep.id;
    this.recomputeMode();
    return {
      meta: {
        endpointId: ep.id,
        tier: ep.tier,
        model: modelName,
        degraded: isDegraded(ep, req.track),
        attemptSeq: mySeq,
        tried: tried.map(toTryRecord),
        streamStarted: false,
      },
      response: outcome.response,
      usage,
    };
  }

  /**
   * 端点内模型链尝试（迁移自 PilotDeck `runFallbackChain`）。
   *
   * 语义（与 PilotDeck 逐条对齐）：
   * - 链 = `[models[track], ...fallbackModels[track]]`，按序试，试完才换端点；
   * - 模型级故障（isModelScopedKind）→ 记 tried + model_call_log，**不结算熔断**，
   *   继续试下一个模型。端点与凭据是好的，坏的是这一个模型；
   * - 端点级故障（auth / engine_unavailable / pool_unverified）或链尾 →
   *   记账 + 结算熔断，然后把错误抛给外层换下一个端点。
   *
   * 未配 fallbackModels 时链只有一个元素，路径与迁移前逐字等价。
   */
  private async runModelChain(
    ep: EndpointDef,
    req: RouteRequest,
    cap: { connect_ms: number; idle_ms: number; total_ms: number },
    tried: TryEntry[],
    nextSeq: () => number,
  ): Promise<RouteResult> {
    const chain = modelChain(ep, req.track);
    // 链不为空（pickCandidates 已保证 models[track] 存在）；空链是配置漂移，按端点级失败抛
    if (chain.length === 0) {
      throw new Error(`端点 ${ep.id} 在 ${req.track} 轨上没有可用模型`);
    }
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      if (model === undefined) continue;
      const seq = nextSeq();
      const isLast = i === chain.length - 1;
      const t0 = this.now();
      try {
        return await this.callAndSettle(ep, req, cap, seq, tried, model);
      } catch (err) {
        const { kind, retryAfterMs } = classifyError(err);
        const latencyMs = this.now() - t0;
        // 端点级故障：立刻收手换端点，别在同一个坏端点上把剩下的模型也烧一遍
        if (isLast || !isModelScopedKind(kind)) {
          this.noteFail(req, ep, tried, kind, seq, String(err), { settle: true, retryAfterMs, latencyMs }, model);
          if (kind === 'auth') this.helpDirty = true; // 鉴权故障 = 需要人（§4.2）
          // 整条链都以 bad_protocol 收场，才够格判"这个端点不会工具调用"。
          // 单个模型的坏响应不配做端点级判决——那正是 2026-10-17 修掉的连坐。
          if (kind === 'bad_protocol' && req.track === 'primary') this.markNoToolCalling(ep);
          throw err;
        }
        // 模型级故障：记账但不入窗（见 isModelScopedKind 的判据说明）
        this.noteModelFail(req, ep, tried, kind, seq, model, latencyMs);
      }
    }
    /* c8 ignore next —— chain.length > 0 已由上面的空链检查保证 */
    throw new Error(`端点 ${ep.id} 模型链耗尽`);
  }

  private chatCall(
    ep: EndpointDef,
    track: Track,
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    toolChoice: RouteRequest['tool_choice'],
    totalMs: number,
    probe: boolean,
    req?: RouteRequest,
    /** 链内指定的模型名；缺省 = 主模型。 */
    model?: string,
  ): ChatCall {
    return {
      endpoint: ep,
      track,
      model: model ?? modelOf(ep, track),
      messages,
      tools,
      tool_choice: toolChoice,
      maxTokens: req?.maxTokens,
      temperature: req?.temperature,
      signal: req?.signal,
      cap: {
        connect_ms: ep.timeouts.connect_ms,
        idle_ms: ep.timeouts.idle_ms,
        total_ms: Math.min(ep.timeouts.total_ms, totalMs),
      },
      probe,
    };
  }

  private logCall(
    req: RouteRequest,
    ep: EndpointDef,
    outcome: CallOutcome,
    attemptSeq: number,
    kind: FailureKind | undefined,
    usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number } | null,
    model?: string,
    latencyMs?: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO model_call_log
           (attempt_id, attempt_seq, event_id, track, endpoint_id, model, degraded, outcome, kind,
            latency_ms, prompt_tokens, completion_tokens, cached_prompt_tokens, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        req.attemptId,
        attemptSeq,
        req.eventId ?? null,
        req.track,
        ep.id,
        model ?? modelOf(ep, req.track),
        isDegraded(ep, req.track) ? 1 : 0,
        outcome,
        kind ?? null,
        latencyMs ?? null,
        usage?.promptTokens ?? null,
        usage?.completionTokens ?? null,
        // 没报就是 NULL，不是 0：本地 Colibrì 没有缓存概念，记 0 会把
        // "不支持缓存"和"支持但没命中"在缓存命中率上混成一个数。
        usage?.cachedPromptTokens ?? null,
        this.now(),
      );
  }

  /** 闸门跳过（breaker_skip/throttle_skip/half_open_busy_skip）:入 tried + 日志，不入窗。 */
  private noteSkip(
    req: RouteRequest,
    ep: EndpointDef,
    tried: TryEntry[],
    outcome: 'breaker_skip' | 'throttle_skip' | 'half_open_busy_skip',
    seq: number,
  ): void {
    tried.push(this.tryEntry(ep, req.track, outcome));
    this.logCall(req, ep, outcome, seq, undefined, null);
  }

  /**
   * 端点级判决：这个端点不会工具调用，本会话内不再选它做 primary
   * （pickCandidates 按 capabilities.tool_calling==='no' 滤除；reload 后复位）。
   *
   * 只由 `runModelChain` 在**整条链都以 bad_protocol 收场**时调用。单个模型的坏
   * tool_call 不配做这个判决——2026-10-17 修的连坐：原先一个模型就能把端点记 'no'，
   * 于是 fallback 链换个模型成功也没用，端点照样被滤掉，直到配置 reload。
   */
  private markNoToolCalling(ep: EndpointDef): void {
    if (ep.capabilities === undefined) ep.capabilities = { tool_calling: 'no', context: 0 };
    else ep.capabilities.tool_calling = 'no';
  }

  /**
   * 失败记账（§4.2/§4.1）:入 tried + 日志 +（可选）breaker 结算。
   * `settle:false` 用于"宽限期内加载中"与"单次槽位 busy"——排队不是故障，不入窗。
   *
   * `model` 由 fallback 链传入：链尾失败也必须是**真正失败的那个模型**，
   * 否则 model_call_log.model 回落成主模型，同端点多条尝试的账就串了。
   * `latencyMs` 同上：不记的话 latency_ms 列永远是 NULL，"哪个端点真的快"无从判断。
   */
  private noteFail(
    req: RouteRequest,
    ep: EndpointDef,
    tried: TryEntry[],
    kind: FailureKind,
    seq: number,
    detail: string,
    opts: { settle: boolean; retryAfterMs?: number | null; latencyMs?: number | null },
    model?: string,
  ): void {
    tried.push(this.tryEntry(ep, req.track, 'fail', kind, model));
    if (opts.settle) {
      this.breaker.settle({
        endpointId: ep.id,
        track: req.track,
        ok: false,
        kind,
        retryAfterMs: opts.retryAfterMs ?? null,
        detail,
      });
    }
    this.logCall(req, ep, 'fail', seq, kind, null, model, opts.latencyMs ?? null);
  }

  /**
   * 模型级失败记账（fallback 链专用）：入 tried + model_call_log，**不结算熔断**。
   *
   * 端点与凭据都是好的，坏的只是这一个模型。把样本记到端点窗口上会连坐——
   * 唯一 primary 端点被一个限流的模型拖进熔断，整条降级链就断了。
   * 端点级故障走 noteFail（settle:true），两者分工见 isModelScopedKind。
   */
  private noteModelFail(
    req: RouteRequest,
    ep: EndpointDef,
    tried: TryEntry[],
    kind: FailureKind,
    seq: number,
    model: string,
    latencyMs?: number | null,
  ): void {
    tried.push(this.tryEntry(ep, req.track, 'fail', kind, model));
    this.logCall(req, ep, 'fail', seq, kind, null, model, latencyMs ?? null);
  }

  private tryEntry(
    ep: EndpointDef,
    track: Track,
    outcome: CallOutcome,
    kind?: FailureKind,
    model?: string,
  ): TryEntry {
    const entry: TryEntry = {
      endpointId: ep.id,
      tier: ep.tier,
      track,
      ok: outcome === 'ok',
      at: this.now(),
    };
    if (kind !== undefined) entry.failure = kind;
    if (model !== undefined) entry.model = model;
    return entry;
  }

  /**
   * §4.2 buildExhaustedError（唯一裁决函数，补 rev1 缺口 13）:
   * 1. primary + 有池端点被合格证挡下 + 无其他硬故障 + 有待批侦察候选 → NoQualifiedPrimaryError；
   * 2. primary + 全被 open/throttle/half_open_busy 挡下 + 已有开放 help → AllEndpointsDownError(helpAlreadyOpen=true)；
   * 3. 其余 → AllEndpointsDownError。
   */
  private buildExhaustedError(tried: TryEntry[], track: Track): Error {
    const kinds = tried.map((t) => t.failure).filter((k): k is FailureKind => k !== undefined);
    const ids = tried.map((t) => t.endpointId);
    const skipOnly = tried.length > 0 && tried.every((t) => t.failure === undefined);
    if (
      track === 'primary' &&
      kinds.some((k) => k === 'pool_unverified') &&
      !kinds.some((k) =>
        ['server_error', 'timeout', 'network', 'quota', 'auth', 'engine_unavailable', 'rate_limit'].includes(k),
      ) &&
      this.recon.pendingCount() > 0
    ) {
      return new NoQualifiedPrimaryError(ids);
    }
    if (track === 'primary' && skipOnly && this.alerts.helpOpen()) {
      return new AllEndpointsDownError(ids, true);
    }
    return new AllEndpointsDownError(ids);
  }

  // ═══════════════════════════════════════════════════════════════════
  // mode 重算与求救
  // ═══════════════════════════════════════════════════════════════════

  private recomputeMode(): void {
    const before = this.modeMgr.current;
    const next = this.modeMgr.recompute({
      candidates: this.endpoints,
      isToolQualified: (ep) => this.isCertFresh(ep),
      servedBy: this.servedBy,
    });
    if (next !== before) {
      if (MODE_SEVERITY[next] > MODE_SEVERITY[before]) {
        // mode 变差 → 求救评估（§4.3 末条：降级即求救评估，1min 心跳内发出）
        this.helpDirty = true;
      } else {
        // mode 变好 → 恢复通报（§4.3 末条：升级必发恢复通报，§4.5 收敛规则）。
        // 由 onChange 钩子异步触发，不阻塞 route() 主路径；收敛核对用 breaker 视图。
        void this.maybeSendRecovery(before, next);
      }
    }
  }

  /** §4.3 末条/§4.5：mode 变好时收敛未解决的 help 并发恢复通报。 */
  private async maybeSendRecovery(from: RouterMode, to: RouterMode): Promise<void> {
    try {
      await this.alerts.sendRecovery({
        mode: to,
        currentSignature: makeSignature(to, this.collectFailing(), this.currentServingTier()),
        isOpenNow: (f) => {
          const v = this.breaker.view(f.endpoint_id, f.track);
          return v.state === 'open';
        },
        servedBy: this.servedBy,
        // sinceMs 是**历时**（毫秒）而非时刻：modeMgr.since 是进入当前 mode 的 epoch，
        // 原样传进去会让模板算出"历时 17872134h"（2026-10-17 全方位测试实锤）。
        // now() 兜底 clamp 防时钟回拨出负数。
        sinceMs: Math.max(0, this.now() - this.modeMgr.since),
      });
    } catch {
      // 恢复通报失败不影响路由本身（下轮 mode 变化会再触发）
    }
  }

  /** §4.5 maybeSendHelp（由 1min 心跳 helpDirty 结算）。 */
  private async maybeSendHelp(): Promise<void> {
    const failing = this.collectFailing();
    const tier = this.currentServingTier();
    await this.alerts.maybeSendHelp({
      mode: this.modeMgr.current,
      failing,
      tier,
      servedBy: this.servedBy,
    });
  }

  private collectFailing(): FailingEndpoint[] {
    const out: FailingEndpoint[] = [];
    for (const row of this.breaker.allRows()) {
      if (row.state !== 'open') continue;
      out.push({
        endpoint_id: row.endpoint_id,
        track: row.track,
        kind: row.last_kind ?? 'unknown',
        consec: row.consec_failures,
      });
    }
    return out;
  }

  private currentServingTier(): number {
    const ep = this.endpoints.find((e) => e.id === this.servedBy);
    return ep?.tier ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 状态与运维（§5.1）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 读 routing.light_events 前缀匹配；入口模块用（契约 M7:memory.* 事件同样走 light）。
   *
   * 只认事件类型，**不掺形状判据**：这里拿不到请求体，掺了只会拿一个空 input 去判，
   * 而空 input 必然是 trivial——等于把 default_track 整个废掉、所有事件都往 light 跑。
   * 形状判据是另一条路，入口是 `trackForRequest()`。
   */
  trackForEvent(eventType: string): Track {
    return matchesLightEvent(eventType, this.cfg.routing.light_events)
      ? 'light'
      : this.cfg.routing.default_track;
  }

  /**
   * 按请求形状判轨道（2026-10-17 迁移自 PilotDeck 的 difficulty judge）。
   *
   * 与 `trackForEvent` 的分工：那个按**事件类型**（调用方显式声明"这是低智能活"），
   * 这个按**请求形状**（带 tools → 必然 primary）。两者串联，事件类型优先。
   *
   * 为什么形状判据值得单独一个入口：dotd 的主循环每步都带 tools，而 light 轨
   * 端点（本地 OLMoE）实测无工具能力——判错一次不是多花钱，是任务步骤拿不到工具。
   * 所以这里只认"请求自己长什么样"，不猜任务语义（判据全文见 difficulty.ts）。
   */
  trackForRequest(req: {
    tools?: readonly ToolSpec[] | undefined;
    toolChoice?: RouteRequest['tool_choice'];
    messages: readonly ChatMessage[];
  }): Track {
    return resolveTrack(judgeDifficulty(req), this.difficultyPolicy());
  }

  /** routing.light_difficulties → 策略对象（每次现构，配置 reload 后立即生效）。 */
  private difficultyPolicy(): DifficultyPolicy {
    return {
      lightDifficulties: this.cfg.routing.light_difficulties.filter(
        (d): d is Difficulty => d === 'trivial' || d === 'simple' || d === 'moderate',
      ),
      defaultTrack: this.cfg.routing.default_track,
    };
  }

  get emergencyActive(): boolean {
    return this.modeMgr.emergencyActive;
  }

  /** 当前 mode（CLI/测试用）。 */
  get mode(): RouterMode {
    return this.modeMgr.current;
  }

  /** Web UI / CLI `dotd models status` 消费（契约 T1:熔断状态查询只走 snapshot）。 */
  snapshot(): RouterSnapshot {
    const mv = this.modeMgr.view();
    const role = (v: {
      state: BreakerState;
      consecFailures: number;
      nextProbeAt: number | null;
      throttledUntil: number | null;
      lastKind: FailureKind | null;
    }): RouterSnapshot['endpoints'][number]['roles']['primary'] => ({
      breaker: v.state,
      consecFailures: v.consecFailures,
      nextProbeAt: v.nextProbeAt,
      throttledUntil: v.throttledUntil,
      lastKind: v.lastKind,
    });
    const endpoints = this.endpoints.map((ep) => {
      const base = {
        id: ep.id,
        tier: ep.tier,
        emergencyEligible: ep.emergencyEligible,
        roles: {
          primary: role(this.breaker.view(ep.id, 'primary')),
          light: role(this.breaker.view(ep.id, 'light')),
        },
      };
      // 健康度按轨各算一份，UI 取 primary 的那份（light 的留着自己看）。
      // score === null（样本不足）时整个字段省略——省得 UI 画一个 0% 的假进度条。
      const h = this.health.score(ep.id, 'primary');
      if (h.score === null) return base;
      return {
        ...base,
        health: {
          samples: h.samples,
          successRate: h.successRate,
          latencyP50: h.latencyP50,
          latencyP95: h.latencyP95,
          score: h.score,
          cooldownRemainingMs: h.cooldownRemainingMs,
        },
      };
    });
    const pool = this.pool.poolEndpoints().map((ep) => ({
      id: ep.id,
      lastVerifiedAt: ep.lastVerifiedAt ?? null,
      qualifiedForPrimary: this.isCertFresh(ep),
    }));
    const last = this.alerts.lastAlertInfo();
    return {
      mode: mv.mode,
      emergencyActive: mv.emergencyActive,
      endpoints,
      pool,
      pendingRecon: this.recon.pendingCount(),
      openAlerts: this.alerts.openAlerts(),
      lastAlert:
        last === null
          ? null
          : { signature: last.signature, sentAt: last.sentAt, channel: last.channel },
    };
  }

  /**
   * 单端点×轨道的健康度评分（CLI `dotd models health` / 排查"为什么这个端点排在后面"）。
   *
   * 与 snapshot() 的区别：这里给**全量字段**（含 p50/p95 分位与 cooldownFactor），
   * snapshot 只给 UI 画图要的那六个。评分为派生量，随时可重算，无持久化。
   */
  endpointHealth(endpointId: string, track: Track): EndpointHealth {
    return this.health.score(endpointId, track);
  }

  /**
   * 缓存命中率（CLI `dotd models cache` / 排查"为什么这个端点排在前面"）。
   * 无数据时返回的 samples=0，调用方据此说"该 provider 不报命中数"而不是"命中率 0%"。
   */
  endpointCacheRate(endpointId: string, track: Track): EndpointCacheRate | null {
    return this.cache.hitRate(endpointId, track);
  }

  /**
   * 同 tier 排序用的复合键（pickCandidates 的 rankKey 参数）。
   *
   * 合成本次迁移的两个信号，**优先级严格分层**：
   * 1. 健康度（health.rankKey）：主信号。样本不足 → 返回 null，调用方保持声明顺序；
   * 2. 缓存命中率：只在健康度有分时作为**同一档内的微调**（权重 0.05）。
   *
   * 为什么缓存只能是微调而不能与健康度平权：健康度量的是"这个端点会不会失败、
   * 有多慢"，缓存量的是"这个端点的 prompt 有多热"。把后者提到同一量级，
   * 就等于让一个"缓存全命中但 60% 成功率"的端点压过"缓存全 miss 但 99% 成功率"的
   * 端点——为了省一点算力把请求送给更可能失败的端点，这个交易不划算。
   * 0.05 的权重只够在两端点健康度几乎相同时打破平局。
   *
   * 无缓存数据时（当前部署的全部端点都是如此）第二项恒为 0，排序与只有健康度时
   * 逐字一致——这是有意的：不为一个尚无数据的信号改变现有行为。
   */
  private candidateRankKey(endpointId: string, track: Track): number | null {
    const h = this.health.rankKey(endpointId, track);
    if (h === null) return null;
    const c = this.cache.hitRate(endpointId, track);
    const hit = c?.hitRate ?? 0;
    return h + CACHE_RANK_WEIGHT * hit;
  }

  /** CLI 主动触发探测。 */
  async manualProbe(
    endpointId: string,
    kind: 'health' | 'tool_roundtrip' | 'breaker',
  ): Promise<ProbeResult> {
    const ep = this.endpoints.find((e) => e.id === endpointId);
    const at = this.now();
    if (ep === undefined) {
      return { endpointId, kind, ok: false, detail: '端点不存在', at, latencyMs: 0 };
    }
    if (kind === 'breaker') {
      const b = this.breaker.view(endpointId, 'primary');
      return {
        endpointId,
        kind,
        ok: b.state === 'closed',
        detail: `primary=${b.state} light=${this.breaker.view(endpointId, 'light').state}`,
        at,
        latencyMs: 0,
      };
    }
    if (kind === 'health') {
      const started = this.now();
      const url = ep.local?.health_url ?? `${ep.baseUrl}/models`;
      const r = await this.transport.get(ep, url, { timeoutMs: HEALTH_PROBE_MS });
      return {
        endpointId,
        kind,
        ok: r.ok && r.status >= 200 && r.status < 300,
        detail: `HTTP ${r.status}${r.error !== undefined ? ` ${r.error}` : ''}`,
        at,
        latencyMs: this.now() - started,
      };
    }
    const started = this.now();
    const r = await this.pool.toolRoundtrip(this.transport, ep);
    return { endpointId, kind, ok: r.ok, detail: r.detail, at, latencyMs: this.now() - started };
  }

  /** 主人手动放行（如换 key 后，§5.1）。 */
  resetBreaker(endpointId: string, track?: Track): void {
    this.breaker.reset(endpointId, track);
    this.recomputeMode();
  }

  /** 契约 T3:MEM 轮转 OUTBOX 经此判定（不开 SELECT 例外）。 */
  outboxUnresolvedSignatures(): string[] {
    return this.alerts.outboxUnresolvedSignatures();
  }

  /**
   * §4.6 第 4 步 / 契约 J6:审批回调（唯一审批种类 = 侦察候选）。
   * 治理发 `approval:decided`（载荷 subject.kind='recon_candidate', id, verdict）。
   */
  onApprovalResult(kind: 'recon_candidate', id: string, approved: boolean, note?: string): void {
    if (kind !== 'recon_candidate') return;
    if (approved) {
      this.recon.approve(id, note ?? 'owner');
    } else {
      this.recon.reject(id, note ?? '主人拒绝', 'owner');
    }
    this.rebuildEndpoints();
  }

  /** 人工触发一次侦察（CLI/测试）。 */
  async runReconScan(): Promise<{ proposed: number; sourceError: string | null }> {
    const r = await this.recon.scan(this.transport, this.modeMgr.current);
    return { proposed: r.proposed.length, sourceError: r.sourceError };
  }

  /** 人工触发一次池探测（CLI/测试）。 */
  async runPoolProbe(endpointId: string): Promise<{ ok: boolean; detail: string }> {
    const ep = this.endpoints.find((e) => e.id === endpointId);
    if (ep === undefined) return { ok: false, detail: '端点不存在' };
    await this.poolProbe(endpointId);
    return { ok: true, detail: '已执行 health 探测' };
  }

  /** 人工触发 help 重投（CLI `dotd models resend-help`）。 */
  async resendLostHelp(): Promise<number> {
    return this.alerts.resendLost();
  }

  /** 测试/诊断:当前配置端点。 */
  listEndpoints(): EndpointDef[] {
    return [...this.endpoints];
  }

  // ── models.yml 热加载（2026-10-25 接线）────────────────────────────────
  //
  // 此前 `reloadConfig()` 只有测试在调，`reload_debounce_ms` 是个**死配置项**，
  // 而注释/文档一直写着"改一行配置热切换"。结果是：改完 models.yml 必须重启
  // daemon，主人看到的却是"保存了但没生效"。
  //
  // 由装配层显式调用 startWatching()（不在构造函数里自动起）：测试会创建
  // 大量 router，自动监听文件描述符会泄漏，也让"读配置"变成有副作用的操作。
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  /** 开始监听 models.yml（幂等；daemon 装配层调用）。 */
  startWatching(): void {
    if (this.watcher !== null || this.disposed) return;
    const file = join(this.configDir, 'models.yml');
    try {
      this.watcher = watch(file, { persistent: false }, () => this.scheduleReload());
    } catch (cause) {
      // 监听起不来不能影响启动：退化为"改配置需重启"，并且要说出来
      console.error(`[router] models.yml 热加载未启用（${String(cause)}），改配置后需重启`);
    }
  }

  /** 停止监听（dispose 会调；测试可手动调）。 */
  stopWatching(): void {
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // 已关
      }
      this.watcher = null;
    }
  }

  /**
   * 防抖后重载。**配置写坏时必须保住旧配置**：编辑器保存瞬间可能是半个文件，
   * 直接抛出去会让一次误存变成"模型全灭"。所以失败只喊、不换配置。
   */
  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    const delay = Math.max(100, this.cfg.reload_debounce_ms);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      try {
        this.reloadConfig();
        console.error(`[router] models.yml 已热加载（${this.endpoints.length} 个端点）`);
      } catch (cause) {
        console.error(`[router] models.yml 热加载失败，继续用旧配置：${String(cause)}`);
        this.bus.publish('config.models_reload_failed', { error: String(cause) });
      }
    }, delay);
    this.reloadTimer.unref?.();
  }

  /** 释放（daemon 关停）:停掉心跳回调与配置监听。 */
  dispose(): void {
    this.disposed = true;
    this.stopWatching();
  }

  /** 测试/诊断:1min 心跳回调本体（breaker.probe_timer）。 */
  async runProbeTick(): Promise<void> {
    await this.probeTick();
  }

  /** 测试/诊断:每日 janitor 回调本体（router.janitor）。 */
  runJanitor(): void {
    this.janitorTick();
  }

  /** 测试/诊断:OUTBOX 全文（断言账本先行落盘）。 */
  outboxText(): string {
    return this.outbox.readAll();
  }

  /** 测试/诊断:待收敛 help 签名（契约 T3 判定用的同一集合）。 */
  openAlertSignatures(): string[] {
    return this.alerts.outboxUnresolvedSignatures();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════════════

function modelOf(ep: EndpointDef, track: Track): string {
  return ep.models[track] ?? ep.models.primary ?? ep.models.light ?? '';
}

/**
 * §4.3 degraded 位:非标准档位承载 primary 时为 true。
 * - tier2 显式授权降格（主人给 tier2 写了 models.primary）；
 * - tier3/4 池与侦察候选承载 primary。
 */
function isDegraded(ep: EndpointDef, track: Track): boolean {
  if (track !== 'primary') return false;
  return ep.tier >= 2;
}

function toTryRecord(t: TryEntry): TryRecord {
  const rec: TryRecord = {
    endpointId: t.endpointId,
    tier: t.tier,
    track: t.track,
    ok: t.ok,
    at: t.at,
  };
  if (t.failure !== undefined) rec.kind = t.failure;
  if (t.model !== undefined) rec.model = t.model;
  if (t.ms !== undefined) rec.ms = t.ms;
  return rec;
}

function isAbsoluteish(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

export { HttpTransport, StubTransport };
