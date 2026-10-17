/**
 * src/exec/types.ts —— 执行面模块私有类型（不进 contracts.ts）。
 *
 * 铁律（CONVENTIONS.md §4「模块边界」）：跨模块可见的类型一律在 src/shared/contracts.ts
 * （ExecToolCall/ExecToolResult/Capability/ContainerStats/DotExecStatus/SideEffect/ToolName），
 * 本文件只放**模块内部**的形状：状态机状态、配置、事件载荷、后端接口、报告。
 *
 * 依据（逐字可溯）：
 * - execution.md §4.1 状态机十六态（DDL containers.state CHECK 同集）
 * - execution.md §9 DDL：exec_dots / image_builds / containers / exec_identities /
 *   exec_volumes / exec_calls / exec_disk_policy
 * - execution.md §10 ExecService 事件流 + boot/reconcile/recreate 的返回结构
 */

import { fileURLToPath } from 'node:url';
import type { Capability, DotExecStatus, ExecToolCall, ExecToolResult } from '../shared/contracts.ts';

// ═══════════════════════════════════════════════════════════════════
// 状态机（execution.md §4.1，与 db/migrations/030_execution.sql 的 CHECK 逐字一致）
// ═══════════════════════════════════════════════════════════════════

export const CONTAINER_STATES = [
  'absent',
  'image_ready',
  'created',
  'booting',
  'ready',
  'busy',
  'idle',
  'suspended',
  'idle_stop_requested',
  'stopped',
  'quarantined',
  'unhealthy',
  'create_failed',
  'build_failed',
  'removed',
  'lost',
] as const;

export type ContainerState = (typeof CONTAINER_STATES)[number];

/** 合法状态迁移表（execution.md §4.1 状态图 + 状态表"出口"列）。 */
export const CONTAINER_TRANSITIONS: Record<ContainerState, readonly ContainerState[]> = {
  absent: ['image_ready'],
  image_ready: ['created', 'create_failed', 'build_failed'],
  created: ['booting'],
  booting: ['ready', 'unhealthy'],
  ready: ['busy', 'idle', 'suspended', 'unhealthy', 'lost', 'removed'],
  busy: ['ready', 'unhealthy', 'lost', 'removed'],
  idle: ['ready', 'suspended', 'unhealthy', 'lost', 'removed'],
  suspended: ['ready', 'idle_stop_requested', 'unhealthy', 'lost', 'removed'],
  idle_stop_requested: ['stopped', 'booting', 'unhealthy', 'lost', 'removed'],
  stopped: ['booting', 'removed', 'lost'],
  unhealthy: ['booting', 'quarantined', 'lost', 'removed'],
  quarantined: ['booting', 'removed', 'lost'],
  create_failed: ['absent', 'removed'],
  build_failed: ['absent', 'removed'],
  removed: ['absent'],
  // lost→absent：recreate 前置（createAndStart §4.1 注释"removed/lost 终态先回
  // absent 再建"；原表漏此格导致 stub 后端重启后 recreate 抛非法迁移、容器永卡 lost）
  lost: ['booting', 'removed', 'absent'],
};

/** 活跃 = 非 removed/lost（DDL 部分唯一索引 ux_containers_active_dot 的同义词）。 */
export function isActiveState(s: ContainerState): boolean {
  return s !== 'removed' && s !== 'lost';
}

/** 是否可以接收新的工具调用（ready/busy 可接；busy 允许并发排队，见 §4.1）。 */
export function canAcceptCalls(s: ContainerState): boolean {
  return s === 'ready' || s === 'busy';
}

// ═══════════════════════════════════════════════════════════════════
// 配置（execution.md §4.2「全部常量集中 execConfig」+ §4.3 资源闸门 + §8 磁盘预算）
// ═══════════════════════════════════════════════════════════════════

/** 契约 J5：配额唯一事实源 = exec_dots.limits_json，默认 memMb=1536 / cpuMillis=2000。 */
export interface ContainerLimits {
  memMb: number;
  cpuMillis: number;
  homeQuotaMb: number;
  profileQuotaMb: number;
}

export const DEFAULT_LIMITS: ContainerLimits = {
  memMb: 1536,
  cpuMillis: 2000,
  homeQuotaMb: 2048, // EX §8：home 卷 2GB/Dot
  profileQuotaMb: 2048, // EX §8：profile 卷 2GB/Dot
};

/** state 卷（ledger）预算 64MB（EX §8）。 */
export const STATE_QUOTA_MB = 64;

export interface ExecConfig {
  /** 执行面后端：'stub' = 内存假容器（DOTD_FLEET=stub）；'docker' = dockerode 真实路径。 */
  fleet: 'stub' | 'docker';
  /** 契约 §2.2：固定 DOCKER_API_VERSION=1.52，区间 [1.44,1.52]。 */
  dockerApiVersion: string;
  dockerApiMin: string;
  dockerApiMax: string;
  /** docker unix socket（daemon 与 dockerd 同在 WSL，EX §2.1）。 */
  dockerSocketPath: string;
  /** 镜像 tag 的 pw_version 段（EX §3.1/§3.2）。 */
  pwVersion: string;
  /** agent-runtime 版本（EX §3.2 tag 第二段；增删工具 bump）。 */
  runtimeVer: string;
  /** docker 网络名（EX §2.1：bridge + enable_icc=false）。 */
  networkName: string;
  /** 容器内 agent-runtime 端口（EX §5.2）。 */
  runtimePort: number;
  /** sync 工具 deadline 上限 60s（EX §5.2）。 */
  syncDeadlineMs: number;
  /** async 工具全局 deadline 上限 30min（EX §10 Capability.max_deadline_ms / Q5）。 */
  asyncDeadlineMs: number;
  /** boot 内 healthcheck 等待上限 30s（EX §4.1 booting）。 */
  bootHealthTimeoutMs: number;
  /** healthcheck 连续失败 3 次 → unhealthy（EX §4.1）。 */
  healthFailLimit: number;
  /** idle 超时默认 900s（EX §4.1，可被 exec_dots.idle_timeout_s 覆盖）。 */
  idleTimeoutMs: number;
  /** 二级节能：suspended 后再空闲多久 stop（0=关闭，EX §4.1）。 */
  deepStopAfterMs: number;
  /** recreate > 3 次/24h → quarantined（EX §4.1 / S6）。 */
  recreateLimitPer24h: number;
  /** 轮询 /jobs/{id} 的间隔（EX §5.5）。 */
  pollIntervalMs: number;
  /** 容器日志尾部保留（EX §9 image_builds.log_tail 同理）。 */
  logTailChars: number;
  /** 资源闸门（EX §4.3）。 */
  gate: { maxActiveContainers: number; maxMemBudgetTotalMb: number; minMemAvailableMb: number };
  /** token bind 文件目录（EX §2.1-4：WSL 本地文件系统，非卷）。 */
  tokenDir: string;
  /** 镜像构建上下文根：exec-image/Dockerfile 与 agent-runtime/ 的父目录（§3.2 内存 tar）。 */
  repoRoot: string;
  /** profile 目录哈希长度（EX §6.1 identityHash）。 */
  profileHashChars: number;
  /** 磁盘预算键默认值（EX §8，进 exec_disk_policy）。 */
  diskPolicyDefaults: Record<string, number>;
}

/** 构建上下文根 = src/exec/ 的上两级目录（仓库根）；DOTD_REPO_ROOT 覆盖（WSL 部署用）。 */
function deriveRepoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)); // .../dotd/（带尾斜杠）
}

export const DEFAULT_EXEC_CONFIG: ExecConfig = {
  fleet: 'stub',
  dockerApiVersion: '1.52',
  dockerApiMin: '1.44',
  dockerApiMax: '1.52',
  dockerSocketPath: '/var/run/docker.sock',
  pwVersion: '1.49.1',
  runtimeVer: '0.1.0',
  networkName: 'dotd',
  runtimePort: 9223,
  syncDeadlineMs: 60_000,
  asyncDeadlineMs: 30 * 60_000,
  bootHealthTimeoutMs: 30_000,
  healthFailLimit: 3,
  idleTimeoutMs: 15 * 60_000,
  deepStopAfterMs: 0,
  recreateLimitPer24h: 3,
  pollIntervalMs: 500,
  logTailChars: 4000,
  gate: { maxActiveContainers: 2, maxMemBudgetTotalMb: 4096, minMemAvailableMb: 4096 },
  tokenDir: '/var/lib/dotd/tokens',
  repoRoot: deriveRepoRoot(),
  profileHashChars: 16,
  diskPolicyDefaults: {
    image_tags: 2,
    home_quota_mb: 2048,
    profile_quota_mb: 2048,
    state_quota_mb: 64,
    tmp_mb: 256,
    container_log_mb: 20,
    disk_free_min_mb: 5120, // EX §8 系统级：free < 5GB 触发 DiskGardener
    disk_critical_free_mb: 2048, // EX S6：free < 2GB → exec.disk.pressure{critical}
  },
};

/** 从环境变量派生配置（CONVENTIONS.md §7：DOTD_FLEET=stub 由 daemon 装配层读取）。 */
export function execConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExecConfig {
  const fleet = env.DOTD_FLEET;
  return {
    ...DEFAULT_EXEC_CONFIG,
    fleet: fleet === 'stub' ? 'stub' : fleet === 'docker' ? 'docker' : DEFAULT_EXEC_CONFIG.fleet,
    tokenDir: env.DOTD_TOKEN_DIR ?? DEFAULT_EXEC_CONFIG.tokenDir,
    dockerSocketPath: env.DOTD_DOCKER_SOCKET ?? DEFAULT_EXEC_CONFIG.dockerSocketPath,
    repoRoot: env.DOTD_REPO_ROOT ?? DEFAULT_EXEC_CONFIG.repoRoot,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 事件载荷（execution.md §10 事件流；主题名见 bus.ts TOPICS）
// ═══════════════════════════════════════════════════════════════════

export interface ExecContainerEvent {
  dotId: string;
  from: ContainerState | null;
  to: ContainerState;
  reason?: string;
  at: string;
}

export interface ExecUnhealthyEvent {
  dotId: string;
  failures: number;
  error?: string;
  at: string;
}

export interface ExecQuarantinedEvent {
  dotId: string;
  recreateCount: number;
  windowHours: number;
  reason: string;
  at: string;
}

export interface ExecCallEvent {
  callId: string;
  dotId: string;
  taskId: string;
  tool: string;
  mode: 'sync' | 'async';
  jobId?: string;
  at: string;
}

export interface ExecCallFinishedEvent extends ExecCallEvent {
  status: 'ok' | 'error' | 'cancelled';
  errorCode?: string;
  wallMs: number;
}

export interface ExecInterruptedEvent {
  callId: string;
  dotId: string;
  taskId: string;
  reason: 'aborted' | 'not_found' | 'ledger_lost' | 'container_lost';
  at: string;
}

export interface ExecBrowserEvent {
  dotId: string;
  identity?: string;
  cause?: string;
  at: string;
}

export interface ExecDiskPressureEvent {
  volume: string;
  usedMb: number;
  quotaMb: number;
  critical: boolean;
  at: string;
}

export interface ExecDiskGardenedEvent {
  freedMb: number;
  steps: string[];
  at: string;
}

export interface ExecDockerUnavailableEvent {
  error: string;
  at: string;
  /** 连续不可用起始时间（ISO8601），供 S6「>5min」判定。 */
  since: string;
}

// ═══════════════════════════════════════════════════════════════════
// boot / reconcile / recreate 报告（EX §10 boot(dotIds) → BootReport）
// ═══════════════════════════════════════════════════════════════════

export interface BootReport {
  /** docker ping 是否可用（false ⇒ degraded，未做任何容器动作）。 */
  dockerAvailable: boolean;
  /** 本次 boot 实际创建的 dot 列表。 */
  created: string[];
  /** 状态未变化的 dot（已 ready 等）。 */
  adopted: string[];
  /** 走 recreate 的 dot（lost/unhealthy/exited 等）。 */
  recreated: string[];
  /** boot 内对缺失容器 create/boot 失败的 dot → 原因。 */
  failed: Array<{ dotId: string; reason: string }>;
  /** reconcile 阶段对 open calls 的逐条判定。 */
  reconciled: ReconcileEntry[];
  /** SQLite 无账但 docker 侧存在的容器（EX §13.1：只标记 orphan，不擅杀）。 */
  orphans: string[];
  /** boot 内部发生的不影响主流程的告警（如 API 版本漂移）。 */
  warnings: string[];
}

export interface ReconcileEntry {
  callId: string;
  dotId: string;
  /**
   * done = 取回结果（不重派）；doing = 续轮询；aborted/not_found = interrupted；
   * result_compacted = §5.4-4 压缩项（确认幂等成功但结果不可取回，不得重派）。
   */
  outcome: 'done' | 'doing' | 'interrupted' | 'skipped' | 'result_compacted';
  jobId?: string;
  /** outcome='interrupted' 时的原因。 */
  reason?: string;
  at: string;
}

export interface RecreateReport {
  dotId: string;
  /** 是否因 recreate 次数超限进入 quarantined（S6）。 */
  quarantined: boolean;
  recreateCount: number;
  reconciled: ReconcileEntry[];
}

// ═══════════════════════════════════════════════════════════════════
// 行投影（DB → TS；EX 表只读自己的表，见契约 D4）
// ═══════════════════════════════════════════════════════════════════

export interface ExecDotRow {
  dot_id: string;
  runtime_ver: string;
  limits_json: string;
  idle_timeout_s: number;
  deep_stop_after_s: number;
  enabled: number;
}

export interface ContainerRow {
  id: number;
  dot_id: string;
  docker_container_id: string | null;
  state: ContainerState;
  endpoint: string | null;
  token_hash: string | null;
  last_health_at: string | null;
  last_busy_at: string | null;
  recreate_count: number;
  updated_at: string;
}

export interface ExecCallRow {
  call_id: string;
  job_id: string | null;
  task_id: string;
  dot_id: string;
  tool: string;
  mode: 'sync' | 'async';
  args_hash: string;
  state: 'sent' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  result_hash: string | null;
  error_code: string | null;
  sent_at: string;
  finished_at: string | null;
}

export interface ExecIdentityRow {
  id: number;
  dot_id: string;
  identity_key: string;
  profile_hash: string;
  last_used_at: string | null;
}

export interface ExecVolumeRow {
  name: string;
  dot_id: string;
  kind: 'home' | 'profiles' | 'state';
  quota_mb: number;
  usage_mb: number | null;
  created_at: string;
}

export interface ImageBuildRow {
  id: number;
  tag: string;
  digest: string | null;
  pw_version: string;
  status: 'building' | 'ready' | 'failed' | 'superseded';
  log_tail: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface DiskPolicyRow {
  key: string;
  value_mb: number;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════
// 后端接口（fleet.ts 实现；stub / docker 两个实现共用同一接口）
// ═══════════════════════════════════════════════════════════════════

/** dockerode 侧容器状态（`InspectContainer` 的 State 投影）。 */
export interface DockerContainerState {
  Status: string; // created|running|paused|exited|dead
  Running: boolean;
  Paused: boolean;
  ExitCode: number;
  StartedAt: string;
}

/** dockerode `listContainers` 行投影。 */
export interface DockerContainerListItem {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

/** 容器创建参数（EX §4.2 伪码的常量集中版）。 */
export interface ContainerSpec {
  name: string;
  hostname: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  hostConfig: Record<string, unknown>;
  networkAliases: string[];
}

/** 容器后端（fleet 内部）：stub 用内存假实现，docker 用 dockerode。 */
export interface ContainerBackend {
  readonly kind: 'stub' | 'docker';
  /** `GET /_ping`。stub 恒真。 */
  ping(): Promise<boolean>;
  /** `docker version` 的 Server.APIVersion（stub 返回 config.dockerApiVersion）。 */
  serverApiVersion(): Promise<string>;
  /** `docker images` 是否含 tag。 */
  hasImage(tag: string): Promise<boolean>;
  /** `docker buildImage`（内存 tar 流）。返回日志行序列。 */
  buildImage(tag: string, pwVersion: string, onLine?: (line: string) => void): Promise<{ digest: string }>;
  /** `docker create`。返回 64 位容器 id。 */
  createContainer(spec: ContainerSpec): Promise<string>;
  /** `docker start`。 */
  startContainer(id: string): Promise<void>;
  /** `docker pause` / `unpause`（幂等由调用方保证）。 */
  pauseContainer(id: string): Promise<void>;
  unpauseContainer(id: string): Promise<void>;
  /** `docker stop`（grace 秒后 KILL）。 */
  stopContainer(id: string, graceSeconds?: number): Promise<void>;
  /** `docker rm -f`。 */
  removeContainer(id: string): Promise<void>;
  /** `docker inspect` 的 State。容器不存在返回 null。 */
  inspectContainer(id: string): Promise<DockerContainerState | null>;
  /** `docker ps -a` + label 过滤（EX §13.1：label.dotd.managed=1）。 */
  listManagedContainers(): Promise<DockerContainerListItem[]>;
  /** 容器 IP（bridge 网内，用于拼 endpoint http://IP:9223）。 */
  containerIp(id: string): Promise<string | null>;
  /** `docker stats`（契约 J5：归 EX，用 dockerode stats API，不写 CLI 子进程）。 */
  containerStats(id: string): Promise<{ memMb: number } | null>;
  /** `GET /networks/{id}` 的 IPAM.Config[0].Gateway（EX §2.1-2：不写死 172.17.0.1）。 */
  networkGateway(network: string): Promise<string | null>;
  /**
   * 确保 daemon 侧的 `dotd` bridge 网络存在（EX §2.1：由 daemon 创建，
   * com.docker.network.bridge.enable_icc=false）；幂等——已存在直接返回。
   * 必须在 HostNetGuard 读网关与 createContainer 挂网之前调用。stub 空实现。
   */
  ensureNetwork(): Promise<void>;
  /** 卷是否存在 / 卷用量 MB（DiskGardener 白名单核对）。 */
  volumeExists(name: string): Promise<boolean>;
  volumeUsageMb(name: string): Promise<number | null>;
  /** 数据盘可用 MB（`df`，EX §8 系统级）。 */
  diskFreeMb(): Promise<number>;
  /**
   * 宿主上**所有** docker 卷名（EX §8 步骤②：prune 无主卷的枚举源；
   * 调用方用 exec_volumes 白名单过滤后才删）。stub 返回 seed 进来的卷名。
   */
  listVolumeNames(): Promise<string[]>;
  /** `docker builder prune -f`（EX §8 步骤②：回收构建缓存；返回回收 MB 近似）。 */
  builderPrune(): Promise<{ freedMb: number }>;
  /**
   * 宿主**内存**可用 MB（execution.md:225：每次放行前读 /proc/meminfo 的 MemAvailable）。
   * 与 diskFreeMb 是两回事：闸门 minMemAvailableMb 判据用这个，磁盘回收用 diskFreeMb。
   * stub 返回可注入的预置值（测试用）；真实路径读 /proc/meminfo，读不到回 MAX_SAFE_INTEGER（不阻塞闸门）。
   */
  memAvailableMb(): Promise<number>;
  /** 删除镜像 tag（EX §8 镜像回收）。 */
  removeImage(tag: string): Promise<void>;
  /** 删除无主卷（DiskGardener；调用方已排除在册卷）。 */
  removeVolume(name: string): Promise<void>;
}

/**
 * agent-runtime HTTP 客户端（协议层，EX §5.2 端点表）。
 * 宿主 daemon 与容器同在 WSL bridge 网内，HTTP over 容器 IP:9223 + Bearer token。
 */
export interface RuntimeClient {
  /** `GET /healthz`。 */
  health(endpoint: string, token: string): Promise<{
    state: 'ok';
    version: string;
    uptime: number;
    mem_used_mb: number;
    token_epoch: number;
  }>;
  /** `POST /tools/call`（sync 工具）。 */
  callSync(endpoint: string, token: string, call: ExecToolCall): Promise<ExecToolResult>;
  /** `POST /jobs/start`（async 工具）。 */
  startJob(endpoint: string, token: string, call: ExecToolCall): Promise<{ job_id: string }>;
  /** `GET /jobs/{job_id}`。 */
  getJob(endpoint: string, token: string, jobId: string): Promise<ExecToolResult>;
  /** `GET /calls/{call_id}`（按 call_id 取回任意调用终态，含同步；§5.4 修订新增）。 */
  getCall(endpoint: string, token: string, callId: string): Promise<ExecToolResult>;
  /**
   * `POST /calls/{call_id}/confirm`（EX §5.4-4：压缩的**唯一**准入条件）。
   * 宿主（ExecService）在 journal 回报"该 done 已入账"后调用，容器侧 markConfirmed；
   * 只有 confirmed 的 done 项才允许被 compact() 瘦身。容器无此端点时静默失败不抛。
   */
  confirmCall(endpoint: string, token: string, callId: string): Promise<boolean>;
  /**
   * `POST /ledger/compact`（EX §8：state 卷 64MB 上限 / §5.4-4 超 5000 行）。
   * 触发容器侧 compact()；返回被压缩的 call_id 列表。容器无此端点回空数组。
   */
  compactLedger(endpoint: string, token: string): Promise<string[]>;
  /** `POST /jobs/{job_id}/cancel`。 */
  cancelJob(endpoint: string, token: string, jobId: string): Promise<void>;
  /** `DELETE /jobs`（清理已结束 job 记录）。 */
  deleteJobs(endpoint: string, token: string): Promise<void>;
  /** `GET /capabilities`。 */
  capabilities(endpoint: string, token: string): Promise<Capability[]>;
  /** `POST /fs/ops`（契约 S4'/M4：MEM 注入读取/索引对账/原子写桥；仅宿主 token 可调）。 */
  fsOps(
    endpoint: string,
    token: string,
    req: FsOpsRequest,
  ): Promise<FsOpsResponse>;
}

/** 契约 S4'/M4：`POST /fs/ops` 请求（Bearer 鉴权、与 fs.* 同沙箱、rename 限 home 内）。 */
export interface FsOpsRequest {
  op: 'read' | 'list' | 'stat' | 'rename';
  path: string;
  target?: string;
  /** 对账透传，容器不理解（agent-runtime/protocol.ts:483 为可选；宿主侧由 ExecService 补）。 */
  dotId?: string;
}

/**
 * fsOps 响应。形状与容器侧 `agent-runtime/fs.ts` 的 fsOpsOk 逐字对齐
 * （size 与 sizeBytes、mtime 与 mtimeMs 双写），使 MEM 的
 * `src/memory/fsops-client.ts`（读 sizeBytes/mtimeMs）无论走 ExecService 桥
 * 还是直连容器 agent-runtime 都拿到同一形状。
 */
export interface FsOpsResponse {
  op: FsOpsRequest['op'];
  ok: boolean;
  /** op='read'：UTF-8 文本或 base64（fs.read 同契约）。 */
  content?: string;
  encoding?: 'utf8' | 'base64';
  /** op='list'：目录项（path 为 home 相对路径，name 为 basename）。 */
  entries?: Array<{
    name: string;
    path?: string;
    type: 'file' | 'dir' | 'other';
    size?: number;
    sizeBytes?: number;
    mtime?: string;
    mtimeMs?: number;
  }>;
  /** op='stat'：嵌套 stat 对象（MEM 读 stat.sizeBytes / stat.mtimeMs）。 */
  stat?: {
    path?: string;
    type: 'file' | 'dir' | 'other';
    size?: number;
    sizeBytes?: number;
    mtime?: string;
    mtimeMs?: number;
    isDir?: boolean;
  };
  /** op='rename'：目标路径回显。 */
  target?: string;
  error?: { code: string; message: string };
}

// ═══════════════════════════════════════════════════════════════════
// 服务内部依赖（ExecService 构造参数）
// ═══════════════════════════════════════════════════════════════════

/** 能力目录条目（容器 GET /capabilities 的宿主侧缓存；J2 sideEffect 已入 Capability）。 */
export interface CapabilityEntry extends Capability {
  /** 容器未返回该字段时的安全默认（契约 J2：未声明按 unknown）。 */
  declared: boolean;
}

/** 一次 runTool 的派发结果（内部：含 exec_calls 落库与事件）。 */
export interface DispatchOutcome {
  result: ExecToolResult;
  /** 是否首次执行（false = ledger 重放，不再发事件）。 */
  replayed: boolean;
}

/** Web UI/CLI 快照（EX §10 getDotStatus；S4 数据源全为表）。 */
export interface DotStatusSnapshot extends DotExecStatus {
  endpoint: string | null;
  inflight: number;
  lastHealthAt: string | null;
  recreateCount: number;
  profileCount: number;
  volumes: Array<{ name: string; kind: string; quotaMb: number; usageMb: number | null }>;
}
