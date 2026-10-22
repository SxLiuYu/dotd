/**
 * src/exec/fleet.ts —— 容器舰队：生命周期状态机 + boot / reconcile / recreate。
 * （execution.md §4、§13；主设计文档 §9.1 目录树点名本文件职责）
 *
 * 分工：
 *  - 本文件 owns「状态机 + 编排」：读/写 containers 表（EX 自有表，契约 D4）、
 *    驱动 ContainerBackend（stub 或 dockerode）、跑 §13.1 boot 与 §13.2 recreate、
 *    对 open calls 做 §5.4 reconcile。
 *  - image.ts owns 镜像构建（ensureImage）；netguard.ts owns iptables；disk.ts owns 磁盘。
 *  - ExecService.ts 是对外唯一入口（协议层派发 + 事件 + 生命周期 API）。
 *
 * DOTD_FLEET=stub（本机此刻无 docker，CONVENTIONS.md §7）：
 *  - fleet='stub' ⇒ 用 `createStubBackend()` 的内存假容器后端，**不起 Docker**，
 *    保留完整状态机与工具协议；幂等语义与真实 ledger 对齐（同 call_id 重放不重跑）。
 *  - fleet='docker' ⇒ `createDockerBackend()`（dockerode，unix socket 直连）；
 *    该路径按文档写但**本机未实测**（无 dockerd），只做类型与流程保证。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type { Capability, ContainerStats, ExecToolCall, ExecToolResult } from '../shared/contracts.ts';
import { newCallId } from '../shared/ids.ts';
import {
  CAPABILITY_CATALOG,
  argsHash,
  containerEnvAndLabels,
  containerHostConfig,
  containerName,
  dispatchModeFor,
  endpointUrl,
  identityHash,
  imageDrift,
  isImageDigest,
  ledgerReplay,
  volumeNames,
  type LedgerRecord,
} from './protocol.ts';
import {
  CONTAINER_TRANSITIONS,
  canAcceptCalls,
  type BootReport,
  type ContainerBackend,
  type ContainerRow,
  type ContainerSpec,
  type ContainerState,
  type DockerContainerListItem,
  type DockerContainerState,
  type DotStatusSnapshot,
  type ExecCallRow,
  type ExecConfig,
  type ExecDotRow,
  type ExecIdentityRow,
  type ExecVolumeRow,
  type ReconcileEntry,
  type RecreateReport,
} from './types.ts';

// ═══════════════════════════════════════════════════════════════════
// 状态机（execution.md §4.1）
// ═══════════════════════════════════════════════════════════════════

/** 非法迁移抛错（与 GOV 的 APPROVAL_TRANSITIONS 同风格）。 */
export class IllegalContainerTransitionError extends Error {
  readonly from: ContainerState;
  readonly to: ContainerState;
  constructor(from: ContainerState, to: ContainerState) {
    super(`非法容器状态迁移：${from} → ${to}`);
    this.name = 'IllegalContainerTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: ContainerState, to: ContainerState): boolean {
  return CONTAINER_TRANSITIONS[from].includes(to);
}

// ═══════════════════════════════════════════════════════════════════
// Fleet
// ═══════════════════════════════════════════════════════════════════

export interface FleetDeps {
  db: DatabaseSync;
  bus: EventBus;
  cfg: ExecConfig;
  backend: ContainerBackend;
  /** 由 image.ts 提供（§13.1 boot：ensureImage 先于 reconcile）。 */
  ensureImage(): Promise<{ tag: string; digest: string | null; ready: boolean }>;
  /** 由 netguard.ts 提供（§13.1 boot：HostNetGuard.install）。 */
  /** 安装/刷新 HostNetGuard；返回安装报告（含 gateway 与规则集），失败抛错。 */
  installNetGuard(): Promise<unknown>;
  /** 读 token 明文（bind 文件）；测试/stub 下由内存目录提供。 */
  readToken(dotId: string): Promise<string | null>;
  /** 写/轮换 token 明文（bind 文件，EX §2.1-4/§5.1）。 */
  writeToken(dotId: string, token: string): Promise<void>;
}

export class Fleet {
  /** §2.2：docker 不可用时置位；runTool 在此标志下立即返回 docker_unavailable 不发送。 */
  degraded = false;
  private degradedSince: string | null = null;
  /** 内存内 token 明文缓存（stub 路径；真实路径只走 bind 文件）。 */
  private readonly memTokens = new Map<string, string>();

  constructor(private readonly deps: FleetDeps) {}

  // ── 表读写（只动 EX 自有表，契约 D4）────────────────────────────────

  private get db(): DatabaseSync {
    return this.deps.db;
  }

  getConfig(): ExecConfig {
    return this.deps.cfg;
  }

  getDot(dotId: string): ExecDotRow | null {
    const row = this.db
      .prepare('SELECT * FROM exec_dots WHERE dot_id = ?')
      .get(dotId) as unknown as ExecDotRow | undefined;
    return row ?? null;
  }

  /** 注册 dot 档案（幂等 INSERT OR IGNORE + 可选的配额/超时更新）。 */
  registerDot(
    dotId: string,
    o: {
      runtimeVer?: string;
      memMb?: number;
      cpuMillis?: number;
      homeQuotaMb?: number;
      profileQuotaMb?: number;
      idleTimeoutS?: number;
      deepStopAfterS?: number;
      enabled?: number;
    } = {},
  ): void {
    const now = new Date().toISOString();
    const cfg = this.deps.cfg;
    const limits = {
      memMb: o.memMb ?? 1536,
      cpuMillis: o.cpuMillis ?? 2000,
      homeQuotaMb: o.homeQuotaMb ?? 2048,
      profileQuotaMb: o.profileQuotaMb ?? 2048,
    };
    const existing = this.getDot(dotId);
    if (existing === null) {
      this.db
        .prepare(
          `INSERT INTO exec_dots (dot_id, runtime_ver, limits_json, idle_timeout_s, deep_stop_after_s, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dotId,
          o.runtimeVer ?? cfg.runtimeVer,
          JSON.stringify(limits),
          o.idleTimeoutS ?? Math.round(cfg.idleTimeoutMs / 1000),
          o.deepStopAfterS ?? Math.round(cfg.deepStopAfterMs / 1000),
          o.enabled ?? 1,
        );
    } else {
      this.db
        .prepare(
          `UPDATE exec_dots SET runtime_ver = ?, limits_json = ?, idle_timeout_s = ?, deep_stop_after_s = ?, enabled = ?
           WHERE dot_id = ?`,
        )
        .run(
          o.runtimeVer ?? existing.runtime_ver,
          JSON.stringify({ ...parseLimits(existing.limits_json), ...limits }),
          o.idleTimeoutS ?? existing.idle_timeout_s,
          o.deepStopAfterS ?? existing.deep_stop_after_s,
          o.enabled ?? existing.enabled,
          dotId,
        );
    }
    // 卷台账（DiskGardener 白名单依据，§8/§9）幂等登记
    const vols = volumeNames(dotId);
    const rows: Array<[string, ExecVolumeRow['kind'], number]> = [
      [vols.home, 'home', limits.homeQuotaMb],
      [vols.profiles, 'profiles', limits.profileQuotaMb],
      [vols.state, 'state', 64],
    ];
    for (const [name, kind, quotaMb] of rows) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO exec_volumes (name, dot_id, kind, quota_mb, usage_mb, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(name, dotId, kind, quotaMb, now);
    }
  }

  limitsOf(dotId: string): { memMb: number; cpuMillis: number; homeQuotaMb: number; profileQuotaMb: number } {
    const dot = this.getDot(dotId);
    if (dot === null) {
      return { memMb: 1536, cpuMillis: 2000, homeQuotaMb: 2048, profileQuotaMb: 2048 };
    }
    return parseLimits(dot.limits_json);
  }

  getContainer(dotId: string): ContainerRow | null {
    const row = this.db
      .prepare('SELECT * FROM containers WHERE dot_id = ? ORDER BY id DESC LIMIT 1')
      .get(dotId) as unknown as ContainerRow | undefined;
    return row ?? null;
  }

  listActiveContainers(): ContainerRow[] {
    return this.db
      .prepare("SELECT * FROM containers WHERE state NOT IN ('removed','lost') ORDER BY id")
      .all() as unknown as ContainerRow[];
  }

  /**
   * 状态迁移（§4.1）。写 containers.state + updated_at，并发
   * `exec.container.state_change` 事件（§10 事件流）。
   */
  transition(dotId: string, to: ContainerState, opts: { reason?: string; from?: ContainerState } = {}): void {
    const row = this.getContainer(dotId);
    const from = opts.from ?? row?.state ?? 'absent';
    if (from === to) return;
    if (!canTransition(from, to)) {
      throw new IllegalContainerTransitionError(from, to);
    }
    const now = new Date().toISOString();
    if (row === null) {
      this.db
        .prepare(
          `INSERT INTO containers (dot_id, docker_container_id, state, endpoint, token_hash, recreate_count, updated_at)
           VALUES (?, NULL, ?, NULL, NULL, 0, ?)`,
        )
        .run(dotId, to, now);
    } else {
      this.db
        .prepare('UPDATE containers SET state = ?, updated_at = ? WHERE id = ?')
        .run(to, now, row.id);
    }
    this.deps.bus.publish('exec.container.state_change', {
      dotId,
      from,
      to,
      reason: opts.reason,
      at: now,
    });
  }

  /** 记录 docker 侧容器 id 与 endpoint（create/start 后）。 */
  attachDocker(dotId: string, dockerId: string, endpoint: string | null): void {
    const row = this.getContainer(dotId);
    if (row === null) return;
    this.db
      .prepare('UPDATE containers SET docker_container_id = ?, endpoint = ?, updated_at = ? WHERE id = ?')
      .run(dockerId, endpoint, new Date().toISOString(), row.id);
  }

  /**
   * **按 docker 实况校正容器记录**（2026-10-20 修，S6 判据内的真缺陷）。
   *
   * 现场：容器工具全部返回 `container_not_ready（容器状态 unhealthy 不可派发）`，
   * 模型连续重试 3 次全失败，最后把 DSML 标签原样吐给主人。
   * 查下去发现 `containers.endpoint` 还是 `172.18.0.3:9223`，
   * 而容器真实 IP 已经是 `172.21.0.2` —— **Docker 网络重排把 IP 换了**。
   *
   * 死锁是这样形成的：
   *   ① `ExecService.probeHealth` 拿**库里的 endpoint** 发 HTTP 探活 → 打不到 → 失败；
   *   ② 连续 3 次失败 → `ready → unhealthy`；
   *   ③ `periodicHealthCheck` 想恢复，但它**又用同一个旧 endpoint 探活** → 还是失败；
   *   ④ `wakeForDispatch` 只认 suspended/idle/stopped/idle_stop_requested，
   *      **unhealthy 不在名单里** → 永远不会被唤醒。
   * 于是「探活失败 → 判 unhealthy → 靠探活恢复 → 探活还失败」成了闭环，
   * 除了人工改库 / 重启 daemon，没有出口。这正是 S6「连续 7 天无人工干预」的硬伤：
   * 只要 Docker 重排一次 IP，容器能力就永久报废，而判据会看到"进程没重启、没句柄泄漏"，
   * 一路绿灯 —— 直到探针成功率掉下来才发现，那时已经白跑了。
   *
   * 修法：探活失败时**不要只信库里的 endpoint**，直接问 docker 要实况：
   *   · 原 container id 还在跑 → 读它现在的 IP，endpoint 不一致就写回；
   *   · 原 id 已不存在（被重建过） → 按 label `dotd.dot=<dotId>` 重新发现。
   * 返回校正后的 endpoint（拿不到返回 null，调用方按失败处理）。
   *
   * 注意：**只改记录，不重启容器** —— 重启是 watchdog/recreate 的职责（职责分开）。
   */
  async resyncEndpointFromDocker(dotId: string): Promise<string | null> {
    const row = this.getContainer(dotId);
    if (row === null) return null;

    const readIp = async (id: string): Promise<string | null> => {
      try {
        const ip = await this.deps.backend.containerIp(id);
        return ip !== null && ip.length > 0 ? ip : null;
      } catch {
        return null;
      }
    };
    const toEndpoint = (ip: string): string => {
      // 端口沿用记录里的（容器内 runtime 端口由镜像固定，IP 变端口不变）
      let port = 9223;
      if (row.endpoint !== null) {
        const m = /:(\d+)$/.exec(row.endpoint);
        if (m !== null) port = Number(m[1]);
      }
      return `http://${ip}:${port}`;
    };

    // ① 原 id 还在：直接读当前 IP
    if (row.docker_container_id !== null) {
      const ip = await readIp(row.docker_container_id);
      if (ip !== null) {
        const ep = toEndpoint(ip);
        if (ep !== row.endpoint) {
          this.db
            .prepare('UPDATE containers SET endpoint = ?, updated_at = ? WHERE id = ?')
            .run(ep, new Date().toISOString(), row.id);
        }
        return ep;
      }
    }

    // ② 原 id 不在了（被重建/被删）：按 label 重新发现
    let list: import('./types.ts').DockerContainerListItem[];
    try {
      list = await this.deps.backend.listManagedContainers();
    } catch {
      return null;
    }
    const mine = list.filter((c) => c.Labels['dotd.dot'] === dotId && c.State === 'running');
    // 多个时取 Id 最大的（与 getContainer 的 `ORDER BY id DESC` 同向：最新建的优先）
    const pick = mine.slice().sort((a, b) => (a.Id < b.Id ? 1 : -1))[0];
    if (pick === undefined) return null;
    const ip = await readIp(pick.Id);
    if (ip === null) return null;
    const ep = toEndpoint(ip);
    this.db
      .prepare('UPDATE containers SET docker_container_id = ?, endpoint = ?, updated_at = ? WHERE id = ?')
      .run(pick.Id, ep, new Date().toISOString(), row.id);
    return ep;
  }

  setTokenHash(dotId: string, hash: string | null): void {
    const row = this.getContainer(dotId);
    if (row === null) return;
    this.db
      .prepare('UPDATE containers SET token_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, new Date().toISOString(), row.id);
  }

  touchHealth(dotId: string): void {
    const row = this.getContainer(dotId);
    if (row === null) return;
    this.db
      .prepare('UPDATE containers SET last_health_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), row.id);
  }

  touchBusy(dotId: string): void {
    const row = this.getContainer(dotId);
    if (row === null) return;
    this.db
      .prepare('UPDATE containers SET last_busy_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), row.id);
  }

  bumpRecreate(dotId: string): number {
    const row = this.getContainer(dotId);
    if (row === null) return 0;
    const next = row.recreate_count + 1;
    this.db
      .prepare('UPDATE containers SET recreate_count = ?, updated_at = ? WHERE id = ?')
      .run(next, new Date().toISOString(), row.id);
    return next;
  }

  /** 24h 窗口内的 recreate 次数（§4.1：>3/24h → quarantined）。当前行计数即窗口计数。 */
  recreateCount(dotId: string): number {
    return this.getContainer(dotId)?.recreate_count ?? 0;
  }

  // ── token（§5.1/§2.1-4）──────────────────────────────────────────

  /** 生成并轮换 token：写 bind 文件 + 库内只存 sha256。 */
  async rotateToken(dotId: string): Promise<string> {
    const { generateToken, tokenHash } = await import('./protocol.ts');
    const token = generateToken();
    await this.deps.writeToken(dotId, token);
    this.memTokens.set(dotId, token);
    // 注意：containers 行可能还不存在（createAndStart 先轮换 token 再建行），
    // 此时 setTokenHash 静默无效；createAndStart 在行建立后会再 set 一次。
    this.setTokenHash(dotId, tokenHash(token));
    return token;
  }

  /** 取当前 token 明文（优先内存缓存 → bind 文件）。 */
  async currentToken(dotId: string): Promise<string | null> {
    const cached = this.memTokens.get(dotId);
    if (cached !== undefined) return cached;
    const fromFile = await this.deps.readToken(dotId);
    if (fromFile !== null) this.memTokens.set(dotId, fromFile);
    return fromFile;
  }

  /** 测试/stub 用：直接塞 token（不走文件系统）。 */
  setMemToken(dotId: string, token: string): void {
    this.memTokens.set(dotId, token);
  }

  /**
   * **清掉 token 缓存**（2026-10-19 修）。
   *
   * 现场：容器重建后容器内会生成新 token，而 memTokens 里还是旧值 ——
   * currentToken 优先返回缓存，于是探活用旧 token 去打新容器，一直 401。
   * 症状是**探活在成功/失败之间反复横跳**（日志里 "连续失败→unhealthy"
   * 和 "恢复→ready" 交替出现），而容器其实是好的。
   *
   * 调用时机：探活失败时先清缓存重读一次；容器 recreate/接管后也清。
   */
  invalidateToken(dotId: string): void {
    this.memTokens.delete(dotId);
  }

  // ── degraded 闸门（§2.2）─────────────────────────────────────────

  /** docker 不可用：置位 + 发事件（S6：持续 >5min 由求救模块按 since 判定）。 */
  markDegraded(error: unknown): void {
    const was = this.degraded;
    this.degraded = true;
    if (!was) this.degradedSince = new Date().toISOString();
    this.deps.bus.publish('exec.docker.unavailable', {
      error: error instanceof Error ? error.message : String(error),
      since: this.degradedSince ?? new Date().toISOString(),
      at: new Date().toISOString(),
    });
  }

  clearDegraded(): void {
    this.degraded = false;
    this.degradedSince = null;
  }

  degradedSinceAt(): string | null {
    return this.degradedSince;
  }

  // ═══════════════════════════════════════════════════════════════════
  // §13.1 boot 序列（幂等；顺序：ping → ensureImage → ensureNetwork → netguard → reconcile → create/boot）
  // ═══════════════════════════════════════════════════════════════════

  async boot(dotIds: string[]): Promise<BootReport> {
    const report: BootReport = {
      dockerAvailable: true,
      created: [],
      adopted: [],
      recreated: [],
      failed: [],
      reconciled: [],
      orphans: [],
      warnings: [],
    };

    // ① docker.ping() 失败 → docker_unavailable，5s 退避由 ExecService 的轮询层负责
    let pingOk = false;
    try {
      pingOk = await this.deps.backend.ping();
    } catch (cause) {
      this.markDegraded(cause);
      report.dockerAvailable = false;
      return report;
    }
    if (!pingOk) {
      this.markDegraded(new Error('docker ping 返回 false'));
      report.dockerAvailable = false;
      return report;
    }
    this.clearDegraded();

    // API 版本漂移告警（§2.2：固定 1.52，区间 [1.44,1.52+]）
    try {
      const api = await this.deps.backend.serverApiVersion();
      if (!inApiRange(api, this.deps.cfg)) {
        report.warnings.push(`docker API 版本 ${api} 不在 [${this.deps.cfg.dockerApiMin},${this.deps.cfg.dockerApiMax}]`);
      }
    } catch {
      report.warnings.push('读不到 docker API 版本');
    }

    // ② ensureImage 先行（§13.1 修订：reconcile 的 recreate 分支才能在 boot 内闭环）
    let image: { tag: string; digest: string | null; ready: boolean };
    try {
      image = await this.deps.ensureImage();
      if (!image.ready) {
        this.markDegraded(new Error('镜像不可用（构建失败）'));
        report.dockerAvailable = false;
        report.failed.push({ dotId: '*', reason: 'image_not_ready' });
        return report;
      }
    } catch (cause) {
      this.markDegraded(cause);
      report.dockerAvailable = false;
      report.failed.push({
        dotId: '*',
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return report;
    }

    // ③ ensureNetwork（§2.1：dotd bridge 由 daemon 创建，enable_icc=false）。
    //    必须先于 HostNetGuard——后者从 GET /networks/dotd 读网关，网络不存在即 404。
    try {
      await this.deps.backend.ensureNetwork();
    } catch (cause) {
      this.markDegraded(cause);
      report.warnings.push(`dotd 网络创建失败：${errText(cause)}`);
    }

    // ④ HostNetGuard.install（§2.1-2，幂等重装）
    try {
      await this.deps.installNetGuard();
    } catch (cause) {
      // 部署预检项（§2.1-2：失败 fail-fast）；stub 下永真
      this.markDegraded(cause);
      report.warnings.push(`HostNetGuard 安装失败：${errText(cause)}`);
    }

    // ⑤ 以 docker ps -a 过滤 label.dotd.managed=1 为实况
    let live: Awaited<ReturnType<ContainerBackend['listManagedContainers']>> = [];
    try {
      live = await this.deps.backend.listManagedContainers();
    } catch (cause) {
      this.markDegraded(cause);
      report.dockerAvailable = false;
      return report;
    }

    for (const row of this.listActiveContainers()) {
      const match = live.find((c) => c.Id === row.docker_container_id);
      try {
        // ── 镜像漂移（F9）：账上这个容器还活着，但它跑的是**旧镜像** ──────────
        // 2026-10-22 现场：exec-image 已换 node:24-slim，而 reconcile 只看"容器在跑 +
        // /healthz 通"就 adopted，于是不管 tag 怎么变，boot 永远接着旧 playwright 容器用
        // —— 容器内 node 仍是 v22、/ms-playwright 仍占 1.4GB，而日志写着"容器已就绪"。
        // handoff §7.1 那条"说上线了而实际没上线"走得就是这个路径：换基座必须让在跑的
        // 容器被重建，否则等于改了个空。
        //
        // 放在循环体**第一件事**（早于 paused 采纳、也早于 lost→recreate 分支），
        // 于是四种实况全过这一道：paused / running / exited / 未知状态。
        // 只挡 running 是不够的：paused 的旧镜像容器同样会被原样收回来。
        //
        // 判据本身在 protocol.ts 的 imageDrift/isImageDigest（纯函数、可单测）：
        // 期望是 digest 就拿容器 ImageID 比，是 tag 就拿 Image 比 —— 必须同一种标识，
        // 混比会恒不相等、每次 boot 都重建一次；任一侧拿不到一律**不判漂移**，
        // 不能把"读不到字段"当成"有问题"去重建生产容器。
        //
        // canRecreate 的必要性：image_ready/created/booting 里的容器是**本次 boot 用
        // 新镜像刚建出来的**，按构造不可能漂移；而对它们调 recreate 会踩非法迁移
        // （这几个状态没有 →removed 的边，见 types.ts CONTAINER_TRANSITIONS），
        // 把一次"漂移"变成一条 boot 失败记录 —— 反而更糟。
        // 判据用 canTransition(state,'removed') 现算而非手写状态名单：以后状态表加边，
        // 这里自动跟上，不必记得来改这一段。
        if (match !== undefined) {
          const want = image.digest ?? image.tag;
          const got = isImageDigest(want) ? match.ImageID : match.Image;
          if (imageDrift(want, got) && canTransition(row.state, 'removed')) {
            const brief = (x: string | undefined): string =>
              (x === undefined ? '∅' : x.length > 24 ? `${x.slice(0, 19)}…` : x);
            report.warnings.push(
              `${row.dot_id} 镜像漂移（容器 ${brief(got)} ≠ 期望 ${brief(want)}）→ 重建`,
            );
            // 状态收敛交给 recreate 自己走（*→removed→absent→created→booting→ready）。
            // 这里不抢先 transition：一是没必要，二是本判断现在跑在所有采纳分支之前，
            // ready 之外的 stopped/quarantined 都不允许 →unhealthy，挑错目标态会抛
            // IllegalContainerTransitionError。
            const r = await this.recreate(row.dot_id, { image });
            report.recreated.push(row.dot_id);
            report.reconciled.push(...r.reconciled);
            if (r.quarantined) report.warnings.push(`${row.dot_id} 进入 quarantined`);
            continue;
          }
        }
        if (row.state === 'suspended' && match?.State === 'paused') {
          report.adopted.push(row.dot_id); // 保持
          continue;
        }
        if (match === undefined) {
          // (*, missing) → lost → recreate（镜像已由 ensureImage 保证）
          this.transition(row.dot_id, 'lost', { reason: 'docker 侧容器消失' });
          const r = await this.recreate(row.dot_id, { image });
          report.recreated.push(row.dot_id);
          report.reconciled.push(...r.reconciled);
          if (r.quarantined) report.warnings.push(`${row.dot_id} 进入 quarantined`);
          continue;
        }
        if (row.state === 'busy' && match.State === 'exited') {
          // 标记待 reconcile 的 calls 走 §5.4，转 recreate
          const r = await this.recreate(row.dot_id, { image });
          report.recreated.push(row.dot_id);
          report.reconciled.push(...r.reconciled);
          continue;
        }
        if (match.State === 'exited') {
          // docker start 一次，失败 → recreate
          try {
            await this.deps.backend.startContainer(match.Id);
            report.adopted.push(row.dot_id);
            await this.reconcileOpenCalls(row.dot_id, report);
          } catch {
            const r = await this.recreate(row.dot_id, { image });
            report.recreated.push(row.dot_id);
            report.reconciled.push(...r.reconciled);
          }
          continue;
        }
        if (match.State === 'running') {
          // unhealthy 也重新 probe：本行 unhealthy 只代表"上次 boot 探活失败"，
          // 而 docker 侧容器此刻在跑（实测 2026-10-16：daemon 重启风暴中一次探测
          // 超时留下 unhealthy，容器此后一直 Up，但派发门禁 canTake 只认
          // ready/busy，工具调用被 container_not_ready 全拒、任务烧光预算）。
          // 状态机只允许 unhealthy→booting（types.ts CONTAINER_TRANSITIONS），
          // 所以先转 booting 再复用 waitHealthy 的 healthcheck 收敛（过→ready，
          // 不过→unhealthy 再 recreate），不新增迁移边。
          if (row.state === 'unhealthy') {
            this.transition(row.dot_id, 'booting', { reason: 'boot 复探：docker 侧在跑，重跑 healthcheck' });
            const token = await this.currentToken(row.dot_id);
            await this.waitHealthy(row.dot_id, row.endpoint, token, report);
            continue;
          }
          if (row.state === 'ready' || row.state === 'busy' || row.state === 'idle') {
            // probe /healthz：OK→接管（重读 bind token 刷 token_hash），败→unhealthy
            const ok = await this.probeHealth(row.dot_id);
            if (ok) {
              this.touchHealth(row.dot_id);
              report.adopted.push(row.dot_id);
              await this.reconcileOpenCalls(row.dot_id, report);
            } else {
              this.transition(row.dot_id, 'unhealthy', { reason: 'boot healthcheck 失败' });
              this.deps.bus.publish('exec.container.unhealthy', {
                dotId: row.dot_id,
                failures: this.deps.cfg.healthFailLimit,
                at: new Date().toISOString(),
              });
              const r = await this.recreate(row.dot_id, { image });
              report.recreated.push(row.dot_id);
              report.reconciled.push(...r.reconciled);
            }
            continue;
          }
          // booting/created/stopped 等：统一交给 startOrBoot 收敛
          await this.startOrBoot(row.dot_id, image, report);
          continue;
        }
        // running 之外的未知状态（dead 等）：保守 recreate
        const r = await this.recreate(row.dot_id, { image });
        report.recreated.push(row.dot_id);
        report.reconciled.push(...r.reconciled);
      } catch (cause) {
        report.failed.push({ dotId: row.dot_id, reason: errText(cause) });
      }
    }

    // ⑤b 占名清障：pending dot 将被重建，但同名容器（dotd-dot-<id>）仍挂在 docker 上
    //    且无账可归——它是本 dot 旧库/旧令牌的残留。"不擅杀"只约束【其他 dot】的
    //    orphan；留着它只会让 createAndStart 永远 409，而失败若无人打印就是静默瘫痪。
    const known = new Set(this.listActiveContainers().map((r) => r.docker_container_id));
    const pendingDots = dotIds.filter((dotId) => {
      const row = this.getContainer(dotId);
      return row === null || row.state === 'removed' || row.state === 'lost' || row.state === 'absent';
    });
    const squatNames = new Set(pendingDots.map(containerName));
    const cleared: string[] = [];
    const orphansLeft: typeof live = [];
    for (const c of live) {
      if (known.has(c.Id)) continue;
      if (c.Names.some((n) => squatNames.has(n.replace(/^\//, '')))) {
        cleared.push(c.Id);
      } else {
        orphansLeft.push(c);
      }
    }
    for (const id of cleared) {
      try {
        await this.deps.backend.removeContainer(id); // removeContainer 已 force:true
        report.warnings.push(`清理占名 orphan ${id.slice(0, 12)}（对应 dot 无活跃行，重建前清障）`);
      } catch (cause) {
        report.warnings.push(`占名 orphan ${id.slice(0, 12)} 清理失败：${errText(cause)}`);
      }
    }

    // 未匹配的 live 容器 → 只标记 orphan 发事件，不擅杀（§13.1）
    for (const c of orphansLeft) {
      report.orphans.push(c.Id);
      this.deps.bus.publish('exec.container.state_change', {
        dotId: c.Labels['dotd.dot'] ?? 'unknown',
        from: null,
        to: 'lost',
        reason: `orphan 容器 ${c.Id.slice(0, 12)}：SQLite 无账，未擅杀`,
        at: new Date().toISOString(),
      });
    }

    // ⑤ 活跃行缺失的 dotIds：create+start（§4.2 参数），booting
    for (const dotId of dotIds) {
      const row = this.getContainer(dotId);
      if (row !== null && row.state !== 'removed' && row.state !== 'lost' && row.state !== 'absent') {
        continue;
      }
      // §4.3 闸门：超限时驱逐最老可逐出容器，仍不行则记 failed（不静默超卖）
      const gate = await this.admit(dotId);
      if (!gate.ok) {
        report.failed.push({
          dotId,
          reason: `闸门拒绝：${gate.reason ?? 'unknown'}（evict=${gate.evict ?? 'none'}）`,
        });
        continue;
      }
      try {
        await this.createAndStart(dotId, image, report);
        report.created.push(dotId);
      } catch (cause) {
        report.failed.push({ dotId, reason: errText(cause) });
      }
    }

    return report;
  }

  /** create + start + booting→ready（healthcheck）+ reconcileOpenCalls。 */
  private async createAndStart(
    dotId: string,
    image: { tag: string; digest: string | null },
    report: BootReport,
  ): Promise<void> {
    const token = await this.rotateToken(dotId);
    const dockerId = await this.deps.backend.createContainer(this.buildSpec(dotId, image));
    // removed/lost 终态先回 absent，否则 image_ready 迁移非法（§4.1）
    const cur = this.getContainer(dotId);
    if (cur !== null && (cur.state === 'removed' || cur.state === 'lost')) {
      this.transition(dotId, 'absent', { reason: 'createAndStart 前置' });
    }
    this.transition(dotId, 'image_ready', { reason: 'ensureImage' });
    this.transition(dotId, 'created', { reason: 'docker create' });
    this.transition(dotId, 'booting', { reason: 'docker start' });
    this.attachDocker(dotId, dockerId, null);
    // 行已建立：补写 token_hash（rotateToken 时行还不存在，写不进去）
    const { tokenHash } = await import('./protocol.ts');
    this.setTokenHash(dotId, tokenHash(token));
    await this.deps.backend.startContainer(dockerId);
    const ip = await this.deps.backend.containerIp(dockerId);
    const endpoint = ip === null ? null : endpointUrl(ip, this.deps.cfg.runtimePort);
    this.attachDocker(dotId, dockerId, endpoint);
    await this.waitHealthy(dotId, endpoint, token, report);
  }

  /** 已存在容器但状态需收敛时的一次 start/boot。 */
  private async startOrBoot(
    dotId: string,
    image: { tag: string; digest: string | null },
    report: BootReport,
  ): Promise<void> {
    const row = this.getContainer(dotId);
    if (row === null) {
      await this.createAndStart(dotId, image, report);
      return;
    }
    if (row.docker_container_id === null) {
      await this.createAndStart(dotId, image, report);
      return;
    }
    if (row.state === 'stopped' || row.state === 'idle_stop_requested' || row.state === 'booting' || row.state === 'created') {
      await this.deps.backend.startContainer(row.docker_container_id);
      this.transition(dotId, 'booting', { reason: 'start' });
      const token = await this.currentToken(dotId);
      const ip = await this.deps.backend.containerIp(row.docker_container_id);
      const endpoint = ip === null ? row.endpoint : endpointUrl(ip, this.deps.cfg.runtimePort);
      this.attachDocker(dotId, row.docker_container_id, endpoint);
      await this.waitHealthy(dotId, endpoint, token, report);
      return;
    }
    // ready/busy/idle/suspended：接管即可
    report.adopted.push(dotId);
  }

  /** §4.2 创建参数（常量集中 execConfig）。 */
  buildSpec(dotId: string, image: { tag: string; digest: string | null }): ContainerSpec {
    const cfg = this.deps.cfg;
    const limits = this.limitsOf(dotId);
    const { env, labels } = containerEnvAndLabels(cfg, dotId, limits);
    const vols = volumeNames(dotId);
    const hostConfig = containerHostConfig(cfg, limits);
    hostConfig.Binds = [
      `${vols.home}:/dot/home`,
      `${vols.profiles}:/dot/profiles`,
      `${vols.state}:/opt/agent-state`, // ledger 独立卷（§7.1），属主 1000/0700
      `${cfg.tokenDir}/${dotId}.token:/run/dotd/token:ro`, // token 只读 bind（§2.1-4）
    ];
    return {
      name: containerName(dotId),
      hostname: `dot-${dotId}`,
      image: image.digest ?? image.tag,
      env,
      labels,
      hostConfig,
      networkAliases: [`dot-${dotId}.exec`],
    };
  }

  /** booting→ready：30s 内 healthcheck 通过；超时→unhealthy（§4.1）。 */
  private async waitHealthy(
    dotId: string,
    endpoint: string | null,
    token: string | null,
    report: BootReport,
  ): Promise<void> {
    const cfg = this.deps.cfg;
    const deadline = Date.now() + cfg.bootHealthTimeoutMs;
    while (Date.now() < deadline) {
      if (endpoint !== null && token !== null) {
        try {
          // 必须看返回值：探活实现是"失败返 false、不抛"（ExecService.probeHealthRaw
          // 内部 catch 后 return false），只 catch 异常会把第一次失败当成成功，
          // 容器没起来也标 ready（WSL 实测：容器启动即崩，boot 仍报 created/ready）。
          if (await this.probeHealthRaw(endpoint, token)) {
            this.touchHealth(dotId);
            this.transition(dotId, 'ready', { reason: 'healthcheck OK' });
            await this.reconcileOpenCalls(dotId, report);
            return;
          }
        } catch {
          // 继续等
        }
      }
      await sleep(cfg.pollIntervalMs);
    }
    this.transition(dotId, 'unhealthy', { reason: 'boot healthcheck 超时' });
    this.deps.bus.publish('exec.container.unhealthy', {
      dotId,
      failures: cfg.healthFailLimit,
      at: new Date().toISOString(),
    });
  }

  /** 探活：经 ExecService 注入的 runtime 客户端（由 ExecService 调 probeHealth 时设置）。 */
  private probeRaw: ((dotId: string) => Promise<boolean>) | null = null;

  /** ExecService 装配后注入（协议客户端在 ExecService 侧，fleet 不 import HTTP）。 */
  setHealthProbe(fn: (dotId: string) => Promise<boolean>): void {
    this.probeRaw = fn;
  }

  async probeHealth(dotId: string): Promise<boolean> {
    if (this.probeRaw !== null) return this.probeRaw(dotId);
    return this.probeHealthViaBackend(dotId);
  }

  /** stub 后端自带 healthz；docker 路径由 ExecService 的 HTTP 客户端承担。 */
  private async probeHealthViaBackend(dotId: string): Promise<boolean> {
    const row = this.getContainer(dotId);
    if (row === null) return false;
    if (row.docker_container_id === null) return false;
    const st = await this.deps.backend.inspectContainer(row.docker_container_id);
    return st !== null && st.Running && !st.Paused;
  }

  /** ExecService 注入的裸探活（endpoint+token）。 */
  private probeHealthRawFn: ((endpoint: string, token: string) => Promise<boolean>) | null = null;

  setRawHealthProbe(fn: (endpoint: string, token: string) => Promise<boolean>): void {
    this.probeHealthRawFn = fn;
  }

  private async probeHealthRaw(endpoint: string, token: string): Promise<boolean> {
    if (this.probeHealthRawFn !== null) return this.probeHealthRawFn(endpoint, token);
    // stub 路径：后端 healthz 恒 ok（createStubBackend 内部维护）
    const row = this.listActiveContainers().find((r) => r.endpoint === endpoint);
    if (row === undefined) return false;
    const st = row.docker_container_id === null ? null : await this.deps.backend.inspectContainer(row.docker_container_id);
    return st !== null && st.Running;
  }

  // ═══════════════════════════════════════════════════════════════════
  // §13.2 recreate
  // ═══════════════════════════════════════════════════════════════════

  /**
   * recreate：`docker rm -f old`（home/profiles/state 三卷保留）→ token 轮换 →
   * create+start → booting → healthcheck OK → reconcileOpenCalls。
   * row.recreate_count++；>3/24h 或 recreate 后仍 unhealthy → quarantined + S6 事件。
   */
  async recreate(
    dotId: string,
    o: { image?: { tag: string; digest: string | null } } = {},
  ): Promise<RecreateReport> {
    const image = o.image ?? (await this.deps.ensureImage());
    const row = this.getContainer(dotId);
    const report: RecreateReport = {
      dotId,
      quarantined: false,
      recreateCount: 0,
      reconciled: [],
    };

    if (row?.docker_container_id != null) {
      try {
        await this.deps.backend.removeContainer(row.docker_container_id);
      } catch {
        // 已不在：忽略（recreate 幂等）
      }
    }

    // 终态收敛：removed/lost 均可回 absent 再建
    if (row !== null && (row.state === 'removed' || row.state === 'lost')) {
      this.transition(dotId, 'absent', { reason: 'recreate 前置' });
    } else if (row !== null && row.state !== 'absent') {
      // ready/busy/idle/suspended 等非终态：先经 removed → absent（§4.1 合法链路），
      // 否则 createAndStart 的 image_ready 迁移会踩非法迁移。
      // 注意必须 else：终态分支已把状态迁到 absent，再按 row.state（陈旧值）
      // 走 removed 会踩 absent→removed 非法迁移。
      this.transition(dotId, 'removed', { reason: 'recreate：旧容器已 remove' });
      this.transition(dotId, 'absent', { reason: 'recreate 前置' });
    }

    const count = this.bumpRecreate(dotId);
    report.recreateCount = count;

    const bootReport: BootReport = {
      dockerAvailable: true,
      created: [],
      adopted: [],
      recreated: [],
      failed: [],
      reconciled: [],
      orphans: [],
      warnings: [],
    };
    await this.createAndStart(dotId, image, bootReport);
    report.reconciled.push(...bootReport.reconciled);

    const after = this.getContainer(dotId);
    if (after?.state === 'unhealthy' || count > this.deps.cfg.recreateLimitPer24h) {
      // ready → quarantined 非法（§4.1）：先 unhealthy 再隔离
      if (after?.state !== 'unhealthy') {
        this.transition(dotId, 'unhealthy', { reason: 'recreate 超限，转隔离' });
      }
      this.transition(dotId, 'quarantined', {
        reason: count > this.deps.cfg.recreateLimitPer24h ? 'recreate 超限' : 'recreate 后仍 unhealthy',
      });
      report.quarantined = true;
      this.deps.bus.publish('exec.container.quarantined', {
        dotId,
        recreateCount: count,
        windowHours: 24,
        reason: count > this.deps.cfg.recreateLimitPer24h ? 'recreate_limit_exceeded' : 'still_unhealthy',
        at: new Date().toISOString(),
      });
    }
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════
  // §5.4-3 reconcile：容器 booting→ready 后逐 open call 查 /calls/{call_id}
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 对该 dot `exec_calls` 中 state IN ('sent','running') 的行逐个对账：
   *  done→取回 result 落库回报 journal；doing→取 job_id 续轮询；aborted/404→标 interrupted。
   *  **重派决策（换新 call_id）属于 journal，不属于 exec；exec 永不自动重试**（S1）。
   */
  async reconcileOpenCalls(dotId: string, sink?: { reconciled: ReconcileEntry[] }): Promise<ReconcileEntry[]> {
    const entries: ReconcileEntry[] = [];
    const rows = this.db
      .prepare("SELECT * FROM exec_calls WHERE dot_id = ? AND state IN ('sent','running') ORDER BY sent_at")
      .all(dotId) as unknown as ExecCallRow[];
    const push = (e: ReconcileEntry): void => {
      entries.push(e);
      sink?.reconciled.push(e);
    };
    if (rows.length === 0) return entries;

    const row0 = this.getContainer(dotId);
    const endpoint = row0?.endpoint ?? null;
    const token = await this.currentToken(dotId);
    // 容器不可达的三种判据：库内无 endpoint/token、未注入查询探针、
    // 或容器已不在可服务状态（removed/lost/absent/stopped/...——destroy 后 endpoint 仍在库，
    // 但进程已没了，继续查只会拿到假 running）。
    const serviceable = row0 !== null && canAcceptCalls(row0.state);
    if (endpoint === null || token === null || this.queryCall === null || !serviceable) {
      // 容器不可达：全部报 interrupted（journal 决定是否重派）
      for (const r of rows) {
        this.markCallInterrupted(r.call_id, 'container_lost');
        push({
          callId: r.call_id,
          dotId,
          outcome: 'interrupted',
          reason: 'container_lost',
          at: new Date().toISOString(),
        });
        this.deps.bus.publish('exec.call.interrupted', {
          callId: r.call_id,
          dotId,
          taskId: r.task_id,
          reason: 'container_lost',
          at: new Date().toISOString(),
        });
      }
      return entries;
    }

    for (const r of rows) {
      let res: ExecToolResult;
      try {
        res = await this.queryCall(endpoint, token, r.call_id);
      } catch {
        res = {
          call_id: r.call_id,
          status: 'error',
          error: { code: 'not_found', message: 'GET /calls 404', retryable: false },
        };
      }
      if (res.status === 'ok') {
        // done → 取回 result 落库回报 journal（不重派）
        this.finishCall(r.call_id, 'done', res.result, res.job_id ?? r.job_id);
        push({ callId: r.call_id, dotId, outcome: 'done', jobId: res.job_id ?? r.job_id ??undefined, at: new Date().toISOString() });
        this.deps.bus.publish('exec.call.finished', {
          callId: r.call_id,
          dotId,
          taskId: r.task_id,
          tool: r.tool,
          mode: r.mode,
          jobId: res.job_id ?? r.job_id ??undefined,
          status: 'ok',
          wallMs: 0,
          at: new Date().toISOString(),
        });
      } else if (res.status === 'running') {
        // doing → 取 job_id 续轮询
        this.setCallRunning(r.call_id, res.job_id ?? r.job_id);
        push({ callId: r.call_id, dotId, outcome: 'doing', jobId: res.job_id ?? r.job_id ??undefined, at: new Date().toISOString() });
      } else if (res.error?.code === 'interrupted') {
        this.markCallInterrupted(r.call_id, 'aborted');
        push({ callId: r.call_id, dotId, outcome: 'interrupted', reason: 'aborted', at: new Date().toISOString() });
        this.deps.bus.publish('exec.call.interrupted', {
          callId: r.call_id,
          dotId,
          taskId: r.task_id,
          reason: 'aborted',
          at: new Date().toISOString(),
        });
      } else if (res.error?.code === 'result_compacted') {
        // §5.4-4：调用确认幂等成功（ledger 有 done 项），但结果已被压缩取不回。
        // 落库为 done + result_hash（无 result_json）——**不得重派**（底线：
        // 没有二次执行）；结果丢失由任务语义层/journal 处理。
        this.finishCall(r.call_id, 'done', undefined, res.job_id ?? r.job_id);
        this.setCallResultHash(r.call_id, resultHashOf(res));
        push({
          callId: r.call_id,
          dotId,
          outcome: 'result_compacted',
          jobId: res.job_id ?? r.job_id ?? undefined,
          at: new Date().toISOString(),
        });
        this.deps.bus.publish('exec.call.finished', {
          callId: r.call_id,
          dotId,
          taskId: r.task_id,
          tool: r.tool,
          mode: r.mode,
          jobId: res.job_id ?? r.job_id ?? undefined,
          status: 'ok',
          errorCode: 'result_compacted',
          wallMs: 0,
          at: new Date().toISOString(),
        });
      } else {
        this.markCallInterrupted(r.call_id, 'not_found');
        push({ callId: r.call_id, dotId, outcome: 'interrupted', reason: 'not_found', at: new Date().toISOString() });
        this.deps.bus.publish('exec.call.interrupted', {
          callId: r.call_id,
          dotId,
          taskId: r.task_id,
          reason: 'not_found',
          at: new Date().toISOString(),
        });
      }
    }
    return entries;
  }

  /** ExecService 注入：GET /calls/{call_id}。 */
  private queryCall: ((endpoint: string, token: string, callId: string) => Promise<ExecToolResult>) | null = null;

  setCallQuery(fn: (endpoint: string, token: string, callId: string) => Promise<ExecToolResult>): void {
    this.queryCall = fn;
  }

  // ── exec_calls 行操作（S1：exec_calls 是协议层发送/回执镜像，不是重复记账）──

  /** INSERT 一行（幂等：同 call_id 已存在则忽略）。 */
  recordCallSent(call: ExecToolCall, mode: 'sync' | 'async', jobId: string | null, argsHash: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO exec_calls (call_id, job_id, task_id, dot_id, tool, mode, args_hash, state, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
      )
      .run(
        call.call_id,
        jobId,
        call.task_id,
        call.dot_id,
        call.tool,
        mode,
        argsHash,
        new Date().toISOString(),
      );
  }

  setCallRunning(callId: string, jobId: string | null): void {
    if (jobId !== null) {
      this.db
        .prepare("UPDATE exec_calls SET state = 'running', job_id = ? WHERE call_id = ?")
        .run(jobId, callId);
      return;
    }
    this.db
      .prepare("UPDATE exec_calls SET state = 'running' WHERE call_id = ?")
      .run(callId);
  }

  finishCall(callId: string, state: 'done' | 'error' | 'cancelled', result: unknown, jobId?: string | null): void {
    const hash = result === undefined ? null : sha256Json(result);
    if (jobId !== undefined && jobId !== null) {
      this.db
        .prepare(
          "UPDATE exec_calls SET state = ?, result_hash = ?, error_code = NULL, job_id = ?, finished_at = ? WHERE call_id = ?",
        )
        .run(state, hash, jobId, new Date().toISOString(), callId);
      return;
    }
    this.db
      .prepare(
        "UPDATE exec_calls SET state = ?, result_hash = ?, error_code = NULL, finished_at = ? WHERE call_id = ?",
      )
      .run(state, hash, new Date().toISOString(), callId);
  }

  /**
   * 补写 result_hash（§5.4-4 压缩项专用）。
   * finishCall 的 result 参数是"完整结果对象"，压缩项容器侧只回 hash 不回 result，
   * 因此 done 落库后单独把 result_hash 补上；result_json 宿主从不存（真相在容器 ledger）。
   */
  setCallResultHash(callId: string, hash: string | null): void {
    if (hash === null) return;
    this.db.prepare('UPDATE exec_calls SET result_hash = ? WHERE call_id = ?').run(hash, callId);
  }

  /**
   * 标记失败。行不存在时也要落一行（本地拒绝：degraded / container_not_ready /
   * bad_call / unknown_tool 都发生在"发送前"，但 CP 对账需要看到失败原因）。
   */
  failCall(callId: string, code: string, call?: ExecToolCall): void {
    const now = new Date().toISOString();
    if (call !== undefined) {
      this.db
        .prepare(
          `INSERT INTO exec_calls (call_id, job_id, task_id, dot_id, tool, mode, args_hash, state, error_code, sent_at, finished_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, 'error', ?, ?, ?)
           ON CONFLICT(call_id) DO UPDATE SET state = 'error', error_code = excluded.error_code, finished_at = excluded.finished_at`,
        )
        .run(
          callId,
          call.task_id,
          call.dot_id,
          call.tool,
          dispatchModeFor(call.tool) ?? 'sync',
          argsHash(call.args),
          code,
          call.issued_at,
          now,
        );
      return;
    }
    this.db
      .prepare(
        "UPDATE exec_calls SET state = 'error', error_code = ?, finished_at = ? WHERE call_id = ?",
      )
      .run(code, now, callId);
  }

  markCallInterrupted(callId: string, _reason: string): void {
    this.db
      .prepare(
        "UPDATE exec_calls SET state = 'interrupted', finished_at = ? WHERE call_id = ?",
      )
      .run(new Date().toISOString(), callId);
  }

  cancelCall(callId: string): void {
    this.db
      .prepare(
        "UPDATE exec_calls SET state = 'cancelled', finished_at = ? WHERE call_id = ?",
      )
      .run(new Date().toISOString(), callId);
  }

  getCall(callId: string): ExecCallRow | null {
    const row = this.db.prepare('SELECT * FROM exec_calls WHERE call_id = ?').get(callId) as
      | ExecCallRow
      |undefined;
    return row ?? null;
  }

  openCalls(dotId: string): ExecCallRow[] {
    return this.db
      .prepare("SELECT * FROM exec_calls WHERE dot_id = ? AND state IN ('sent','running') ORDER BY sent_at")
      .all(dotId) as unknown as ExecCallRow[];
  }

  /** 契约 J5：hasInflightCall 判据 = exec_calls.state IN ('sent','running') 存在行。 */
  hasInflightCall(dotId: string): boolean {
    const r = this.db
      .prepare("SELECT 1 AS x FROM exec_calls WHERE dot_id = ? AND state IN ('sent','running') LIMIT 1")
      .get(dotId) as { x?: number } |undefined;
    return r !== undefined;
  }

  // ── 身份台账（§9 exec_identities / S5 登录态审计）────────────────

  /** 登记 identity → profile_hash；幂等（UNIQUE(dot_id, identity_key)）。 */
  setIdentity(dotId: string, identityKey: string): string {
    const hash = identityHash(identityKey, this.deps.cfg.profileHashChars);
    this.db
      .prepare(
        `INSERT INTO exec_identities (dot_id, identity_key, profile_hash, last_used_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dot_id, identity_key) DO UPDATE SET profile_hash = excluded.profile_hash, last_used_at = excluded.last_used_at`,
      )
      .run(dotId, identityKey, hash, new Date().toISOString());
    return hash;
  }

  listIdentities(dotId: string): ExecIdentityRow[] {
    return this.db
      .prepare('SELECT * FROM exec_identities WHERE dot_id = ? ORDER BY id')
      .all(dotId) as unknown as ExecIdentityRow[];
  }

  touchIdentity(dotId: string, identityKey: string): void {
    this.db
      .prepare('UPDATE exec_identities SET last_used_at = ? WHERE dot_id = ? AND identity_key = ?')
      .run(new Date().toISOString(), dotId, identityKey);
  }

  // ── 卷台账（DiskGardener 白名单，§8/§9）──────────────────────────

  listVolumes(dotId?: string): ExecVolumeRow[] {
    if (dotId === undefined) {
      return this.db.prepare('SELECT * FROM exec_volumes ORDER BY name').all() as unknown as ExecVolumeRow[];
    }
    return this.db
      .prepare('SELECT * FROM exec_volumes WHERE dot_id = ? ORDER BY name')
      .all(dotId) as unknown as ExecVolumeRow[];
  }

  updateVolumeUsage(name: string, usageMb: number | null): void {
    this.db
      .prepare('UPDATE exec_volumes SET usage_mb = ? WHERE name = ?')
      .run(usageMb, name);
  }

  /** kill 语义：清掉某 dot 的卷台账（卷本身已由调用方 remove）。 */
  dropVolumes(dotId: string): void {
    this.db.prepare('DELETE FROM exec_volumes WHERE dot_id = ?').run(dotId);
  }

  // ── 资源闸门（§4.3 GlobalScheduler）─────────────────────────────

  /** 已放行容器的内存承诺合计（MB）。 */
  memCommittedMb(): number {
    return this.listActiveContainers().reduce((sum, r) => {
      if (!canAcceptCalls(r.state) && r.state !== 'suspended' && r.state !== 'idle' && r.state !== 'stopped') {
        return sum; // 只统计在册活跃（ready/busy/idle/suspended/stopped/booting/created）
      }
      return sum + this.limitsOf(r.dot_id).memMb;
    }, 0);
  }

  /**
   * admit(containerSpec)：§4.3 闸门。
   *  - activeCount >= maxActiveContainers → 排队（不算失败）
   *  - memCommitted + spec.mem > maxMemBudgetTotalMb → 排队
   *  - MemAvailable < minMemAvailableMb → 拒绝新容器并触发驱逐最老 idle 容器
   *    （execution.md:225「每次放行前读 /proc/meminfo：MemAvailable < 4GB」——
   *     这是**内存**判据，与磁盘余量 diskFreeMb 无关；backend.memAvailableMb()）
   */
  async admit(dotId: string): Promise<{ ok: boolean; reason?: 'max_containers' | 'mem_budget' | 'mem_available'; evict?: string }> {
    const cfg = this.deps.cfg;
    const active = this.listActiveContainers().filter((r) => r.state !== 'absent');
    const self = active.find((r) => r.dot_id === dotId);
    if (self === undefined && active.length >= cfg.gate.maxActiveContainers) {
      const victim = this.oldestEvictable(active, dotId);
      return { ok: false, reason: 'max_containers', evict: victim?.dot_id };
    }
    const want = this.limitsOf(dotId).memMb;
    if (self === undefined && this.memCommittedMb() + want > cfg.gate.maxMemBudgetTotalMb) {
      return { ok: false, reason: 'mem_budget', evict: this.oldestEvictable(active, dotId)?.dot_id };
    }
    // 第三道闸门：宿主内存可用量（不是磁盘）。读不到时不阻塞（返回 MAX_SAFE_INTEGER）。
    const memFreeMb = await this.deps.backend.memAvailableMb();
    if (memFreeMb < cfg.gate.minMemAvailableMb) {
      return { ok: false, reason: 'mem_available', evict: this.oldestEvictable(active, dotId)?.dot_id };
    }
    return { ok: true };
  }

  /** 驱逐顺序（§4.3）：idle/suspended(超预算) → stop；绝不杀 busy。 */
  private oldestEvictable(active: ContainerRow[], exceptDot: string): ContainerRow |undefined {
    const candidates = active.filter(
      (r) => r.dot_id !== exceptDot && (r.state === 'idle' || r.state === 'suspended'),
    );
    candidates.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return candidates[0];
  }

  // ── stats / 状态快照（契约 J5、S4）───────────────────────────────

  /** `getContainerStats(dotId): {memMb, hasInflightCall}`（J5）。 */
  async stats(dotId: string): Promise<ContainerStats> {
    const row = this.getContainer(dotId);
    let memMb = 0;
    if (row?.docker_container_id != null) {
      const s = await this.deps.backend.containerStats(row.docker_container_id);
      memMb = s?.memMb ?? 0;
    }
    return { memMb, hasInflightCall: this.hasInflightCall(dotId) };
  }

  /** S4：getDotStatus 的数据源全为 containers/exec_volumes 表。 */
  status(dotId: string): DotStatusSnapshot {
    const row = this.getContainer(dotId);
    const limits = this.limitsOf(dotId);
    const vols = this.listVolumes(dotId);
    const used = vols.reduce((s, v) => s + (v.usage_mb ?? 0), 0);
    const cap = vols.reduce((s, v) => s + v.quota_mb, 0);
    return {
      dotId,
      state: row?.state ?? 'absent',
      resources: { memMb: limits.memMb, cpuMillis: limits.cpuMillis },
      browser: {
        running: row?.state === 'ready' || row?.state === 'busy',
        contexts: this.listIdentities(dotId).length,
      },
      disk: { usedMb: used, capMb: cap },
      endpoint: row?.endpoint ?? null,
      inflight: this.openCalls(dotId).length,
      lastHealthAt: row?.last_health_at ?? null,
      recreateCount: row?.recreate_count ?? 0,
      profileCount: this.listIdentities(dotId).length,
      volumes: vols.map((v) => ({
        name: v.name,
        kind: v.kind,
        quotaMb: v.quota_mb,
        usageMb: v.usage_mb,
      })),
    };
  }

  /** 能力目录（J2：CP 从 getCapabilities 的缓存读 sideEffect，不维护第二注册表）。 */
  capabilities(): Capability[] {
    return [...CAPABILITY_CATALOG];
  }

  /** 生成一个 job id（async 回执；stub 与 docker 路径同规则）。 */
  newJobId(): string {
    return `job_${newCallId()}`;
  }

  /** stub 后端 ledger 查询入口（stub 路径专用；docker 路径走 HTTP）。 */
  private stubLedger: Map<string, LedgerRecord> | null = null;

  setStubLedger(map: Map<string, LedgerRecord>): void {
    this.stubLedger = map;
  }

  /** stub：按 call_id 查 ledger（等价 GET /calls/{call_id}）。 */
  stubGetCall(callId: string): ExecToolResult | null {
    if (this.stubLedger === null) return null;
    return ledgerReplay(this.stubLedger.get(callId));
  }

  /** stub：ledger 追加/更新（等价 agent-runtime 的 ledger.append）。 */
  stubPutLedger(rec: LedgerRecord): void {
    this.stubLedger?.set(rec.call_id, rec);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════

function parseLimits(json: string): {
  memMb: number;
  cpuMillis: number;
  homeQuotaMb: number;
  profileQuotaMb: number;
} {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      memMb: numOr(o.memMb, 1536),
      cpuMillis: numOr(o.cpuMillis, 2000),
      homeQuotaMb: numOr(o.homeQuotaMb, 2048),
      profileQuotaMb: numOr(o.profileQuotaMb, 2048),
    };
  } catch {
    return { memMb: 1536, cpuMillis: 2000, homeQuotaMb: 2048, profileQuotaMb: 2048 };
  }
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function sha256Json(v: unknown): string {
  // 与 protocol.ts 的 resultHash 同算法（避免循环 import，此处本地实现同式）
  return createHash('sha256').update(stable(v), 'utf8').digest('hex');
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stable(x)).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(',')}}`;
}

/**
 * 从 `result_compacted` 响应里取回容器侧算好的 result_hash（§5.4-4）。
 * ledgerReplay 的 compacted 分支回 `result: { hash }`（protocol.ts:349）；
 * 取不到回 null（此时只落 done 不落 hash，不让对账失败）。
 */
function resultHashOf(res: ExecToolResult): string | null {
  const r = res.result as { hash?: unknown } | undefined;
  if (r === undefined || r === null) return null;
  const h = r.hash;
  return typeof h === 'string' && h.length > 0 ? h : null;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inApiRange(api: string, cfg: ExecConfig): boolean {
  const v = Number.parseFloat(api);
  const min = Number.parseFloat(cfg.dockerApiMin);
  const max = Number.parseFloat(cfg.dockerApiMax);
  if (!Number.isFinite(v) || !Number.isFinite(min) || !Number.isFinite(max)) return false;
  return v >= min && v <= max;
}

// ═══════════════════════════════════════════════════════════════════
// stub 容器后端（DOTD_FLEET=stub：本机无 docker，不起容器）
// ═══════════════════════════════════════════════════════════════════

export interface StubBackendOptions {
  cfg: ExecConfig;
  /**
   * 预置的 docker 侧容器实况。name/labels/image 可缺省。
   *
   * image = 这个容器是用哪个镜像建的。有了它，F9（镜像漂移 -> 重建）和
   * F4（有容器在用的镜像不许回收）才能在 stub 上跑端到端回归; 否则那两个修复
   * 只有纯函数测试覆盖, 接线本身没有回归保护 —— 本轮项目吃过两次
   * 「函数对但没人调用」的亏。
   */
  seedContainers?: Array<{
    id: string;
    state?: string;
    labels?: Record<string, string>;
    name?: string;
    image?: string;
  }>;
  /** ping 是否可用（默认 true）。 */
  pingOk?: boolean;
}

/**
 * stub 后端 = ContainerBackend 的完整实现 + 仅供测试脚本操作"实况"的辅助方法
 * （不进 ContainerBackend 接口，避免真实后端被迫实现它们）。
 */
export type StubBackend = ContainerBackend & {
  seedImage(tag: string): void;
  seedVolume(name: string, usageMb: number): void;
  /** 直接删一个后端卷（测试"宿主有卷但 exec_volumes 未登记"的无主卷场景）。 */
  dropVolume(name: string): void;
  setPing(v: boolean): void;
  setDiskFree(mb: number): void;
  /** 注入宿主 MemAvailable（MB）—— §4.3 第三道闸门（内存，非磁盘）。 */
  setMemAvailable(mb: number): void;
  setState(id: string, status: string): void;
  /** image 见 StubBackendOptions.seedContainers 的注释（F9/F4 的端到端回归靠它）。 */
  seedContainer(c: {
    id: string;
    state?: string;
    labels?: Record<string, string>;
    name?: string;
    image?: string;
  }): void;
  listAll(): Array<{ id: string; status: string; spec: ContainerSpec | null }>;
};

/** 内存假容器后端：完整保留状态机语义，不发任何 Docker/网络请求。 */
export function createStubBackend(o: StubBackendOptions): StubBackend {
  const cfg = o.cfg;
  const containers = new Map<
    string,
    {
      id: string;
      spec: ContainerSpec | null;
      status: string;
      paused: boolean;
      ip: string;
      memMb: number;
      seedName?: string;
      seedLabels?: Record<string, string>;
      /** 这个 seed 容器是用哪个镜像建的; undefined = 不知道（见 StubBackendOptions 注）。 */
      seedImage?: string;
    }
  >();
  for (const s of o.seedContainers ?? []) {
    containers.set(s.id, {
      id: s.id,
      spec: null,
      status: s.state ?? 'running',
      paused: s.state === 'paused',
      ip: `172.18.0.${containers.size + 2}`,
      memMb: 128,
      seedName: s.name,
      seedLabels: s.labels,
      seedImage: s.image,
    });
  }
  const images = new Set<string>();
  const volumes = new Map<string, { name: string; usageMb: number }>();
  let ipSeq = 2;
  let pingOk = o.pingOk ?? true;
  let free = 64 * 1024; // MB（磁盘）
  // §4.3 第三道闸门：宿主内存可用。默认 8GB —— 必须**可注入**，
  // 否则 stub 下 mem_available 判据永假（审码 finding #1）。
  let memFree = 8 * 1024; // MB（MemAvailable）

  const setStatus = (id: string, status: string): void => {
    const c = containers.get(id);
    if (c === undefined) return;
    c.status = status;
    c.paused = status === 'paused';
  };

  return {
    kind: 'stub',

    async ping(): Promise<boolean> {
      return pingOk;
    },

    async serverApiVersion(): Promise<string> {
      return cfg.dockerApiVersion;
    },

    async hasImage(tag: string): Promise<boolean> {
      return images.has(tag);
    },

    async buildImage(tag: string): Promise<{ digest: string }> {
      images.add(tag);
      return { digest: `sha256:${'0'.repeat(64)}` };
    },

    async createContainer(spec: ContainerSpec): Promise<string> {
      // 真实 docker 语义：同名容器占用 → 409 Conflict。stub 必须模拟，
      // 否则"占名 orphan 让 boot 静默瘫痪"（WSL 实测事故）在测试里永不可见。
      for (const c of containers.values()) {
        const name = c.spec !== null ? c.spec.name : c.seedName;
        if (name === spec.name) {
          throw new Error(`409 Conflict: Container name "${spec.name}" already in use`);
        }
      }
      const id = `stub${(Math.random() * 1e16).toString(16).padStart(16, '0')}`;
      ipSeq += 1;
      // 真实 docker 语义：Binds 里的命名卷（非路径 bind）若不存在会自动创建，
      // 之后 `docker volume ls` 可见。stub 必须模拟这一点，否则 DiskGardener 的
      // 无主卷判定（§8 步骤②）会把在册卷误判为"宿主机上有、账本没登记"而误删。
      const rawBinds = spec.hostConfig['Binds'];
      const binds = Array.isArray(rawBinds) ? (rawBinds as unknown[]) : [];
      for (const raw of binds) {
        if (typeof raw !== 'string') continue;
        const bind: string = raw;
        // bind 形如 `<src>:<dst>[:opts]`。src 为命名卷 ⇔ 不含冒号/斜杠/点；
        // 宿主路径 bind（Windows 盘符 `C:\...`、POSIX 绝对路径、相对路径）一律跳过。
        if (/^[A-Za-z]:/.test(bind)) continue; // Windows 盘符：第一个冒号属于盘符
        const sep = bind.indexOf(':');
        if (sep <= 0) continue;
        const src = bind.slice(0, sep);
        if (/[/\\.:]/.test(src)) continue;
        if (!volumes.has(src)) volumes.set(src, { name: src, usageMb: 0 });
      }
      containers.set(id, {
        id,
        spec,
        status: 'created',
        paused: false,
        ip: `172.18.0.${ipSeq}`,
        memMb: 96,
      });
      return id;
    },

    async startContainer(id: string): Promise<void> {
      if (!containers.has(id)) throw new Error(`stub: 容器不存在 ${id}`);
      setStatus(id, 'running');
    },

    async pauseContainer(id: string): Promise<void> {
      if (!containers.has(id)) throw new Error(`stub: 容器不存在 ${id}`);
      setStatus(id, 'paused');
    },

    async unpauseContainer(id: string): Promise<void> {
      if (!containers.has(id)) throw new Error(`stub: 容器不存在 ${id}`);
      setStatus(id, 'running');
    },

    async stopContainer(id: string): Promise<void> {
      if (!containers.has(id)) throw new Error(`stub: 容器不存在 ${id}`);
      setStatus(id, 'exited');
    },

    async removeContainer(id: string): Promise<void> {
      containers.delete(id);
    },

    async inspectContainer(id: string): Promise<import('./types.ts').DockerContainerState | null> {
      const c = containers.get(id);
      if (c === undefined) return null;
      return {
        Status: c.status,
        Running: c.status === 'running' || c.status === 'paused',
        Paused: c.paused,
        ExitCode: c.status === 'exited' ? 0 : 0,
        StartedAt: new Date().toISOString(),
      };
    },

    async listContainerImages(): Promise<string[]> {
      const out: string[] = [];
      for (const c of containers.values()) {
        // 已停止的容器也算：它同样是"还能退回去"的证据（与 docker 后端 all:true 对齐）。
        const img = c.spec !== null ? c.spec.image : c.seedImage;
        if (img !== undefined && img.length > 0) out.push(img);
      }
      return out;
    },

    async listManagedContainers(): Promise<import('./types.ts').DockerContainerListItem[]> {
      const out: import('./types.ts').DockerContainerListItem[] = [];
      for (const c of containers.values()) {
        if (c.spec === null) {
          // seed 进来的容器：无 spec，按 seed name/labels 处理。
          // seedImage 缺省时**两个字段都不填** —— 那是"不知道"，不是"知道且不同";
          // 瞎填会让 imageDrift() 拿到假证据、把测试里的容器判成漂移然后重建。
          const img = c.seedImage;
          const imgDigest = img !== undefined && isImageDigest(img);
          out.push({
            Id: c.id,
            Names: [c.seedName !== undefined ? `/${c.seedName}` : `/stub-${c.id}`],
            Image: img !== undefined && !imgDigest ? img : undefined,
            ImageID: img !== undefined && imgDigest ? img : undefined,
            State: c.status,
            Labels: c.seedLabels ?? {},
          });
          continue;
        }
        // 回填 spec.image：stub 建容器时传进去的就是它的镜像标识，漂移判定因此在单测里
        // 也拿得到真证据。按 kind 分流成和 docker 一样的两个字段（digest -> ImageID、
        // tag -> Image）: 只塞一个的话，另一条判定路径在单测里永远走不到。
        const specDigest = isImageDigest(c.spec.image);
        out.push({
          Id: c.id,
          Names: [`/${c.spec.name}`],
          Image: specDigest ? undefined : c.spec.image,
          ImageID: specDigest ? c.spec.image : undefined,
          State: c.status,
          Labels: c.spec.labels,
        });
      }
      return out;
    },

    async containerIp(id: string): Promise<string | null> {
      return containers.get(id)?.ip ?? null;
    },

    async containerStats(id: string): Promise<{ memMb: number } | null> {
      const c = containers.get(id);
      return c === undefined ? null : { memMb: c.memMb };
    },

    async networkGateway(): Promise<string | null> {
      return '172.18.0.1';
    },

    async ensureNetwork(): Promise<void> {
      // stub：不起 docker，无网络可建（接口占位）
    },

    async volumeExists(name: string): Promise<boolean> {
      return volumes.has(name);
    },

    async volumeUsageMb(name: string): Promise<number | null> {
      return volumes.get(name)?.usageMb ?? null;
    },

    async diskFreeMb(): Promise<number> {
      return free;
    },
    async memAvailableMb(): Promise<number> {
      return memFree;
    },
    async listVolumeNames(): Promise<string[]> {
      return [...volumes.keys()];
    },
    async builderPrune(): Promise<{ freedMb: number }> {
      // stub：无构建缓存可回收，恒 0
      return { freedMb: 0 };
    },

    async removeImage(tag: string): Promise<void> {
      images.delete(tag);
    },

    async removeVolume(name: string): Promise<void> {
      volumes.delete(name);
    },

    // ── 测试辅助（stub 专用，不进 ContainerBackend 接口）────────────
    seedImage(tag: string): void {
      images.add(tag);
    },
    seedVolume(name: string, usageMb: number): void {
      volumes.set(name, { name, usageMb });
    },
    /** 直接删一个后端卷（测试"宿主有卷但 exec_volumes 未登记"的无主卷场景）。 */
    dropVolume(name: string): void {
      volumes.delete(name);
    },
    setPing(v: boolean): void {
      pingOk = v;
    },
    setDiskFree(mb: number): void {
      free = mb;
    },
    /** 注入宿主 MemAvailable（MB）—— §4.3 第三道闸门的测试钩子。 */
    setMemAvailable(mb: number): void {
      memFree = mb;
    },
    /** 直接改容器实况状态（测试 exited/paused 场景）。 */
    setState(id: string, status: string): void {
      setStatus(id, status);
    },
    /** 事后注入一个 docker 侧实况容器（boot 占名/孤儿场景）。 */
    seedContainer(c: {
      id: string;
      state?: string;
      labels?: Record<string, string>;
      name?: string;
      image?: string;
    }): void {
      containers.set(c.id, {
        id: c.id,
        spec: null,
        status: c.state ?? 'running',
        paused: c.state === 'paused',
        ip: `172.18.0.${containers.size + 2}`,
        memMb: 128,
        seedName: c.name,
        seedLabels: c.labels,
        seedImage: c.image,
      });
    },
    listAll(): Array<{ id: string; status: string; spec: ContainerSpec | null }> {
      return [...containers.values()].map((c) => ({ id: c.id, status: c.status, spec: c.spec }));
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// docker 后端（真实路径：dockerode，unix socket 直连）
// ═══════════════════════════════════════════════════════════════════

/** tar-stream pack() 的本模块私有形状（无 bundled 类型；见 tar-stream.d.ts）。 */
type TarPack = {
  entry(h: { name: string; size?: number; mode?: number; type?: 'file' | 'directory' }, data: Buffer, cb?: (err?: Error | null) => void): void;
  entry(h: { name: string; size?: number; mode?: number; type?: 'file' | 'directory' }, cb?: (err?: Error | null) => void): void;
  on(ev: 'data', cb: (c: Buffer) => void): void;
  on(ev: 'end', cb: () => void): void;
  finalize(): void;
};

/**
 * §3.2 内存构建上下文：tar.gz(exec-image/Dockerfile → "Dockerfile" + agent-runtime/**)。
 * 不落盘；返回 Buffer 直接喂 dockerode buildImage（modem 对 Buffer 走 chunked 流）。
 * 排除 node_modules/dist：构建期由 npm ci + tsc 在镜像内重建（依赖锁进 image_builds 审计）。
 */
export async function buildContextTar(repoRoot: string): Promise<Buffer> {
  const { readFile, readdir, stat } = await import('node:fs/promises');
  const path = await import('node:path');
  const zlib = await import('node:zlib');
  // tar-stream 是 CommonJS：动态 import 后 pack() 在 .default 上（与 dockerode 同处理）。
  const tarMod = (await import('tar-stream')) as unknown as { default?: { pack?(): TarPack }; pack?(): TarPack };
  const pack: TarPack | undefined = (tarMod.default ?? tarMod).pack?.();
  if (pack === undefined) throw new Error('tar-stream 加载失败');
  const chunks: Buffer[] = [];
  pack.on('data', (c: Buffer) => chunks.push(c));
  const addFile = async (name: string, abs: string): Promise<void> => {
    const buf = await readFile(abs);
    await new Promise<void>((resolve, reject) =>
      pack.entry({ name, size: buf.length, mode: 0o644, type: 'file' }, buf, (err) =>
        err === undefined || err === null ? resolve() : reject(err),
      ),
    );
  };
  // Dockerfile：exec-image/Dockerfile 在 tar 根即 Dockerfile（dockerfile 查询参数指向根）
  await addFile('Dockerfile', path.join(repoRoot, 'exec-image', 'Dockerfile'));
  // agent-runtime/：源码 + package.json + tsconfig，逐文件平铺（不递归出目录项）
  const arRoot = path.join(repoRoot, 'agent-runtime');
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const ent of await readdir(dir)) {
      if (ent === 'node_modules' || ent === 'dist' || ent === '.gitkeep') continue;
      const abs = path.join(dir, ent);
      const s = await stat(abs);
      if (s.isDirectory()) await walk(abs, `${prefix}${ent}/`);
      else if (s.isFile()) await addFile(`${prefix}${ent}`, abs);
    }
  };
  await walk(arRoot, 'agent-runtime/');
  // end 监听必须在 finalize() 之前挂：tail padding 可能在 finalize 同步路径上冲刷
  const done = new Promise<void>((r) => pack.on('end', () => r()));
  pack.finalize(); // tar-stream 2.x：结束流用 finalize()（end() 不写尾部填充块）
  await done;
  return zlib.gzipSync(Buffer.concat(chunks));
}

/**
 * 网络收敛助手（§2.1 状态收敛修复）：inspect 成功 ≠ 配置合规。
 * 历史事故面：同名网络（如手工 `docker network create dotd` 建的默认 ICC 版本）
 * 会被旧实现直接 early-return，enable_icc=false 隔离承诺静默失效。
 * 收敛动作：Driver 或 Options 任一不符 → remove + 重建。
 * 有容器挂靠时 remove 会被 docker 拒绝（409）→ 抛出（boot 记 degraded/warning，
 * 绝不静默降级放行——隔离是安全承诺，不是优化项）。
 */
export async function convergeNetwork(
  client: {
    inspectNetwork(name: string): Promise<unknown>;
    createNetwork(opts: unknown): Promise<unknown>;
    removeNetwork?(name: string): Promise<unknown>;
  },
  name: string,
  required: { Driver: string; Options: Record<string, string> },
): Promise<'created' | 'converged' | 'unchanged'> {
  let existed: { Driver?: string; Options?: Record<string, string> } | null = null;
  try {
    existed = (await client.inspectNetwork(name)) as { Driver?: string; Options?: Record<string, string> };
  } catch {
    existed = null;
  }
  if (existed === null) {
    await client.createNetwork({ Name: name, ...required });
    return 'created';
  }
  const driverOk = existed.Driver === required.Driver;
  const optsOk = Object.entries(required.Options).every(
    ([k, v]) => existed?.Options?.[k] === v,
  );
  if (driverOk && optsOk) return 'unchanged';
  if (client.removeNetwork === undefined) {
    throw new Error(`网络 ${name} 配置不符（Driver=${existed.Driver} Options=${JSON.stringify(existed.Options)}）且后端不支持 remove`);
  }
  await client.removeNetwork(name);
  await client.createNetwork({ Name: name, ...required });
  return 'converged';
}

/**
 * dockerode 客户端（契约 J5：容器 stats 用 dockerode stats API，不写 docker CLI 子进程；
 * EX §2.1-1 同样禁止 CLI 子进程）。
 */
export function createDockerBackend(cfg: ExecConfig): ContainerBackend {
  // 动态 import：stub 模式下连 dockerode 都不加载（依赖未装也不影响测试）。
  const modem = { socketPath: cfg.dockerSocketPath };
  const client = new DockerLike(modem);
  return {
    kind: 'docker',
    async ping(): Promise<boolean> {
      return client.ping();
    },
    async serverApiVersion(): Promise<string> {
      const v = (await client.version()) as { ApiVersion?: string };
      return v.ApiVersion ?? cfg.dockerApiVersion;
    },
    async hasImage(tag: string): Promise<boolean> {
      const imgs = (await client.listImages()) as Array<{ RepoTags?: string[] }>;
      return imgs.some((i) => (i.RepoTags ?? []).includes(tag));
    },
    async buildImage(tag: string, baseImageTag: string, onLine?: (line: string) => void): Promise<{ digest: string }> {
      // §3.2：ctxTar = tar(exec-image/Dockerfile → Dockerfile, agent-runtime/**) 内存流，不落盘。
      // 上下文根 = cfg.repoRoot（DOTD_REPO_ROOT 可覆盖；WSL 部署时指向 ~/dotd）。
      const context = await buildContextTar(cfg.repoRoot);
      onLine?.(`context: ${(context.length / 1024).toFixed(1)} KB（Dockerfile + agent-runtime，内存 tar.gz）`);
      // 2026-10-21 换 node:24-slim 基座后，Dockerfile 里已无 ARG PW_VERSION，不再传 buildarg
      // （baseImageTag 只用于拼 tag 与落库；传一个没人读的 build arg 会让排障的人以为它在起作用）。
      void baseImageTag;
      const stream = await client.buildImage(context, { t: tag });
      await client.followBuild(stream, onLine);
      const imgs = (await client.listImages()) as Array<{ RepoTags?: string[]; Id?: string }>;
      const hit = imgs.find((i) => (i.RepoTags ?? []).includes(tag));
      if (hit?.Id === undefined || hit.Id.length === 0) throw new Error(`构建结束但未找到镜像 ${tag}`);
      return { digest: hit.Id }; // dockerd 的 Id 自带 sha256: 前缀
    },
    async createContainer(spec: ContainerSpec): Promise<string> {
      // dockerode 5.x 的 Promise 风格 API 返回 Container 实例，容器 id 在小写 .id 上
      // （宿主实测 keys: ['modem','id','defaultOptions']，.Id 为 undefined）；
      // 两种形状都兼容，取不到就抛——否则 undefined 会流进 node:sqlite 的绑定参数被拒。
      const r = (await client.createContainer({
        name: spec.name,
        Image: spec.image,
        Hostname: spec.hostname,
        Env: spec.env,
        Labels: spec.labels,
        HostConfig: spec.hostConfig,
        NetworkingConfig: { EndpointsConfig: { [cfg.networkName]: { Aliases: spec.networkAliases } } },
      })) as { id?: string; Id?: string };
      const id = r.id ?? r.Id;
      if (id === undefined || id.length === 0) throw new Error('createContainer 未返回容器 id');
      return id;
    },
    async startContainer(id: string): Promise<void> {
      await client.startContainer(id);
    },
    async pauseContainer(id: string): Promise<void> {
      await client.pauseContainer(id);
    },
    async unpauseContainer(id: string): Promise<void> {
      await client.unpauseContainer(id);
    },
    async stopContainer(id: string, graceSeconds = 10): Promise<void> {
      await client.stopContainer(id, { t: graceSeconds });
    },
    async removeContainer(id: string): Promise<void> {
      await client.removeContainer(id, { force: true });
    },
    async inspectContainer(id: string): Promise<import('./types.ts').DockerContainerState | null> {
      try {
        const info = (await client.inspectContainer(id)) as {
          State?: { Status?: string; Running?: boolean; Paused?: boolean; ExitCode?: number; StartedAt?: string };
        };
        const st = info.State;
        if (st === undefined) return null;
        return {
          Status: st.Status ?? 'unknown',
          Running: st.Running ?? false,
          Paused: st.Paused ?? false,
          ExitCode: st.ExitCode ?? 0,
          StartedAt: st.StartedAt ?? new Date().toISOString(),
        };
      } catch {
        return null; // 404
      }
    },
    async listContainerImages(): Promise<string[]> {
      // all: true —— 已停止的容器也算：它同样是"还能退回去"的证据（F4）。
      // 不带 label 过滤：回收镜像时任何容器（包括不归本 daemon 管的）用它都算在用。
      try {
        const list = (await client.listContainers({ all: true })) as Array<{
          Image?: string;
          ImageID?: string;
        }>;
        const out: string[] = [];
        for (const c of list) {
          if (c.Image !== undefined && c.Image.length > 0) out.push(c.Image);
          if (c.ImageID !== undefined && c.ImageID.length > 0) out.push(c.ImageID);
        }
        return out;
      } catch {
        // 拿不到就返回空数组。**调用方必须把"查询失败"当作"不许删"**，
        // 见 image.ts 的 reapOldImages —— 少删一个只是占磁盘，多删一个是删掉生产退路。
        return [];
      }
    },

    async listManagedContainers(): Promise<import('./types.ts').DockerContainerListItem[]> {
      const list = (await client.listContainers({ all: true, filters: { label: ['dotd.managed=1'] } })) as Array<{
        Id: string;
        Names?: string[];
        Image?: string;
        ImageID?: string;
        State?: string;
        Labels?: Record<string, string>;
      }>;
      return list.map((c) => ({
        Id: c.Id,
        Names: c.Names ?? [],
        // 漂移判定（F9）要用这两个字段：ImageID 是 sha256 digest，Image 是可读 tag。
        Image: c.Image,
        ImageID: c.ImageID,
        State: c.State ?? 'unknown',
        Labels: c.Labels ?? {},
      }));
    },
    async containerIp(id: string): Promise<string | null> {
      const info = (await client.inspectContainer(id)) as {
        NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
      };
      const nets = info.NetworkSettings?.Networks ?? {};
      for (const n of Object.values(nets)) {
        if (n.IPAddress !== undefined && n.IPAddress.length > 0) return n.IPAddress;
      }
      return null;
    },
    async containerStats(id: string): Promise<{ memMb: number } | null> {
      // dockerode stats API（一次性快照，不开流）
      const s = (await client.containerStats(id, { stream: false })) as {
        memory_stats?: { usage?: number };
      };
      const usage = s.memory_stats?.usage;
      return usage === undefined ? null : { memMb: Math.round(usage / 1048576) };
    },
    async ensureNetwork(): Promise<void> {
      // EX §2.1：`dotd` bridge 由 daemon 创建（enable_icc=false）；
      // HostNetGuard 读网关、createContainer 的 EndpointsConfig 都要求它先存在。
      // 幂等且**收敛**：已存在但配置不符（如手工建的默认 ICC 网络）→ 重建。
      await convergeNetwork(client, cfg.networkName, {
        Driver: 'bridge',
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      });
    },
    async networkGateway(network: string): Promise<string | null> {
      const n = (await client.inspectNetwork(network)) as {
        IPAM?: { Config?: Array<{ Gateway?: string }> };
      };
      return n.IPAM?.Config?.[0]?.Gateway ?? null;
    },
    async volumeExists(name: string): Promise<boolean> {
      try {
        await client.inspectVolume(name);
        return true;
      } catch {
        return false;
      }
    },
    async volumeUsageMb(name: string): Promise<number | null> {
      // §8：用量经容器内 du（/fs/ops 或 shell.run）由 disk.ts 采集；此处留宿主侧近似
      void name;
      return null;
    },
    async listVolumeNames(): Promise<string[]> {
      // EX §8 步骤②：`docker volume ls` 全量卷名（无主卷判定由调用方做）
      const res = (await client.listVolumes()) as {
        Volumes?: Array<{ Name?: string }>;
      };
      return (res.Volumes ?? []).map((v) => v.Name ?? '').filter((n) => n.length > 0);
    },
    async builderPrune(): Promise<{ freedMb: number }> {
      // EX §8 步骤②：`docker builder prune -f`。dockerode 各版本 API 名不一，
      // DockerLike.builderPrune 缺失时抛错（此处按 0 处理，不阻塞回收顺序）。
      try {
        const res = (await client.builderPrune()) as {
          SpaceReclaimed?: number;
          CachesDeleted?: unknown[];
        };
        const bytes = res.SpaceReclaimed;
        return { freedMb: typeof bytes === 'number' ? Math.round(bytes / 1048576) : 0 };
      } catch {
        return { freedMb: 0 };
      }
    },
    async diskFreeMb(): Promise<number> {
      const df = (await client.df()) as { HostInfo?: unknown };
      void df;
      // df 不直接给宿主盘 free；由 disk.ts 读 /proc/mounts + fs.statfs 近似（见 disk.ts）
      return await hostDiskFreeMb();
    },
    async memAvailableMb(): Promise<number> {
      // §4.3 第三道闸门：MemAvailable（execution.md:225）。与磁盘余量无关。
      return await hostMemAvailableMb();
    },
    async removeImage(tag: string): Promise<void> {
      await client.removeImage(tag);
    },
    async removeVolume(name: string): Promise<void> {
      await client.removeVolume(name);
    },
  };
}

/**
 * dockerode 的动态加载包装（缺包时不炸 stub 路径）。
 * dockerode 5.x 无 @types 包，因此这里只声明**本模块用到的最小形状**，
 * 真实类型由 dockerode 自带 d.ts（若日后安装 @types/dockerode 可整体替换本声明）。
 */
type DockerContainerHandle = {
  start(): Promise<unknown>;
  pause(): Promise<unknown>;
  unpause(): Promise<unknown>;
  stop(o: unknown): Promise<unknown>;
  remove(o: unknown): Promise<unknown>;
  inspect(): Promise<unknown>;
  stats(o: unknown): Promise<unknown>;
};
type DockerNetworkHandle = { inspect(): Promise<unknown>; remove(): Promise<unknown> };
type DockerVolumeHandle = { inspect(): Promise<unknown>; remove(): Promise<unknown> };
type DockerImageHandle = { remove(): Promise<unknown> };
type DockerCtor = new (opts: unknown) => {
  ping(): Promise<unknown>;
  version(): Promise<unknown>;
  listImages(): Promise<unknown>;
  /** dockerode 5.0.1：buildImage(source, options[, cb])；无 cb 返回 Promise<Stream>。source 可为 Buffer（tar 流直通）。 */
  buildImage(source: unknown, options: unknown): Promise<unknown>;
  followProgress(stream: unknown, onFinished: (err: Error | null, output: unknown[]) => void, onProgress?: (event: unknown) => void): void;
  createContainer(o: unknown): Promise<unknown>;
  /** EX §2.1：`docker network create`（Promise 风格，只调不取值）。 */
  createNetwork(o: unknown): Promise<unknown>;
  listContainers(o: unknown): Promise<unknown>;
  /** §8 步骤②：`docker volume ls`。 */
  listVolumes(o?: unknown): Promise<unknown>;
  /** §8 步骤②：`docker builder prune -f`（dockerode 5.x 的 builderPrune；旧版无）。 */
  builderPrune?(o?: unknown): Promise<unknown>;
  df(): Promise<unknown>;
  getContainer(id: string): DockerContainerHandle;
  getNetwork(n: string): DockerNetworkHandle;
  getVolume(n: string): DockerVolumeHandle;
  getImage(t: string): DockerImageHandle;
};

class DockerLike {
  private impl: InstanceType<DockerCtor> | null = null;
  constructor(private readonly modem: { socketPath: string }) {}
  private async load(): Promise<InstanceType<DockerCtor>> {
    if (this.impl !== null) return this.impl;
    // dockerode 是 CommonJS 包：ESM 动态 import 后默认导出在 .default 上（tsx/node 皆然）。
    const mod = (await import('dockerode')) as unknown as { default?: DockerCtor; prototype?: unknown };
    const Ctor = (mod.default ?? (mod as unknown as DockerCtor)) as DockerCtor | undefined;
    if (Ctor === undefined) throw new Error('dockerode 加载失败');
    this.impl = new Ctor({ ...this.modem, version: 'v1.52' });
    return this.impl;
  }
  async ping(): Promise<boolean> {
    const d = await this.load();
    await (d.ping as () => Promise<unknown>)();
    return true;
  }
  async version(): Promise<unknown> {
    const d = await this.load();
    return (d.version as () => Promise<unknown>)();
  }
  async listImages(): Promise<unknown> {
    const d = await this.load();
    return (d.listImages as () => Promise<unknown>)();
  }
  async buildImage(source: unknown, options: unknown): Promise<unknown> {
    const d = await this.load();
    return (d.buildImage as (s: unknown, o: unknown) => Promise<unknown>)(source, options);
  }
  /**
   * 消费构建流：逐行回调可读日志，流结束（含 docker 返回的 {"error":...}）后 resolve/reject。
   * onProgress 收 BuildKit / legacy 两种 event（{stream} 或裸对象），统一转字符串。
   */
  async followBuild(stream: unknown, onLine?: (line: string) => void): Promise<void> {
    const d = await this.load();
    return new Promise<void>((resolve, reject) => {
      const fmt = (event: unknown): string => {
        if (typeof event === 'string') return event;
        const e = event as { stream?: string; error?: string };
        return e.stream ?? JSON.stringify(event);
      };
      d.followProgress(
        stream,
        (err: Error | null, output: unknown[]) => {
          if (err !== null && err !== undefined) return reject(err);
          // legacy builder 的错误以 {"error":...} event 混在流里而非 reject：末行命中即判失败。
          const last = output[output.length - 1];
          const errLine = last as { error?: string } | undefined;
          if (errLine !== undefined && typeof errLine.error === 'string') return reject(new Error(errLine.error));
          resolve();
        },
        (event: unknown) => {
          if (onLine !== undefined) for (const l of fmt(event).split('\n')) if (l.trim() !== '') onLine(l);
        },
      );
    });
  }
  /** §8 步骤②：`docker volume ls`。 */
  async listVolumes(): Promise<unknown> {
    const d = await this.load();
    return (d.listVolumes as (o?: unknown) => Promise<unknown>)();
  }
  /** §8 步骤②：`docker builder prune -f`（dockerode 5.x；旧版缺失时抛错由调用方兜）。 */
  async builderPrune(): Promise<unknown> {
    const d = await this.load();
    const fn = d.builderPrune;
    if (fn === undefined) throw new Error('dockerode 不支持 builderPrune');
    return fn.call(d, { all: true });
  }
  async createContainer(opts: unknown): Promise<unknown> {
    const d = await this.load();
    return (d.createContainer as (o: unknown) => Promise<unknown>)(opts);
  }
  /** EX §2.1：建 bridge 网络；调用方保证幂等（先 inspect 不存在才调）。 */
  async createNetwork(opts: unknown): Promise<unknown> {
    const d = await this.load();
    return (d.createNetwork as (o: unknown) => Promise<unknown>)(opts);
  }
  async startContainer(id: string): Promise<void> {
    const d = await this.load();
    await d.getContainer(id).start();
  }
  async pauseContainer(id: string): Promise<void> {
    const d = await this.load();
    await d.getContainer(id).pause();
  }
  async unpauseContainer(id: string): Promise<void> {
    const d = await this.load();
    await d.getContainer(id).unpause();
  }
  async stopContainer(id: string, opts: unknown): Promise<void> {
    const d = await this.load();
    await d.getContainer(id).stop(opts);
  }
  async removeContainer(id: string, opts: unknown): Promise<void> {
    const d = await this.load();
    await d.getContainer(id).remove(opts);
  }
  async inspectContainer(id: string): Promise<unknown> {
    const d = await this.load();
    return d.getContainer(id).inspect();
  }
  async listContainers(opts: unknown): Promise<unknown> {
    const d = await this.load();
    return (d.listContainers as (o: unknown) => Promise<unknown>)(opts);
  }
  async containerStats(id: string, opts: unknown): Promise<unknown> {
    const d = await this.load();
    return d.getContainer(id).stats(opts);
  }
  async inspectNetwork(name: string): Promise<unknown> {
    const d = await this.load();
    return d.getNetwork(name).inspect();
  }
  async removeNetwork(name: string): Promise<unknown> {
    const d = await this.load();
    return d.getNetwork(name).remove();
  }
  async inspectVolume(name: string): Promise<unknown> {
    const d = await this.load();
    return d.getVolume(name).inspect();
  }
  async removeImage(tag: string): Promise<void> {
    const d = await this.load();
    await d.getImage(tag).remove();
  }
  async removeVolume(name: string): Promise<void> {
    const d = await this.load();
    await d.getVolume(name).remove();
  }
  async df(): Promise<unknown> {
    const d = await this.load();
    return (d.df as () => Promise<unknown>)();
  }
}

/** 宿主盘可用 MB（disk.ts 用；WSL 内读 /proc/mounts + fs.statfs）。 */
export async function hostDiskFreeMb(): Promise<number> {
  try {
    const { statfs } = await import('node:fs/promises');
    const st = await statfs('/');
    return Math.round((st.bavail * st.bsize) / 1048576);
  } catch {
    return Number.MAX_SAFE_INTEGER; // 读不到时不阻塞闸门
  }
}

/**
 * 宿主**内存**可用 MB（execution.md:225：每次放行前读 /proc/meminfo 的 MemAvailable）。
 * 部署形态 = WSL 宿主（Linux），/proc/meminfo 一定在；读不到回 MAX_SAFE_INTEGER（不阻塞闸门）。
 * 注意与 hostDiskFreeMb 区分：前者喂 gate.minMemAvailableMb，后者喂 DiskGardener 的磁盘水位。
 */
export async function hostMemAvailableMb(): Promise<number> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('/proc/meminfo', 'utf8');
    // 形如 "MemAvailable:   12345678 kB"
    const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text);
    if (m === null) return Number.MAX_SAFE_INTEGER;
    const kb = Number(m[1]);
    if (!Number.isFinite(kb)) return Number.MAX_SAFE_INTEGER;
    return Math.round(kb / 1024);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
