/**
 * src/control-plane/guard.ts —— 内存水位四级背压 + 首启自动基线标定（R6，CP §6.3）。
 *
 * 阈值来源（CP §6.3，issue #19 的根因）：`.wslconfig memory=32GB`；netfuzz 常驻 ~20GB 是
 * **基线噪声**、不假设被驱逐（Colibrì 也按尽力而为不计入可让渡，CT:36）。本模块**不写死
 * 绝对阈值**，首启进入标定模式：采样 MemAvailable 分布取 `p50=base`；再定
 *   normal≥base+cfg.dotdReserveMb(默认6GB) / guarded≥base+3GB / throttled≥base / halted<base
 *
 * MVP 兜底固定值（未标定前）：normal≥10GB / guarded 6–10GB / throttled 3–6GB / halted<3GB
 * （较旧稿 8/5/2.5 整体抬高，避免 netfuzz 在场时永久 throttled）。
 *
 * 每条跃迁写 resource_events（kind='watermark'）。
 * 容器指令（pause/unpause/kill）归执行面实施（契约 J5：CP 只按周期调用 EX API，
 * 不写 docker CLI 子进程）——本文件只产出"决策"与"曾 pause 过的容器集合"账本，
 * 具体指令经注入的 execPorts 下发，未注入时只记资源事件。
 */

import { freemem } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { ControlPlaneConfig, ResourceEventLevel, ResourceEventRow } from './types.ts';
import type { Queue } from './queue.ts';

export type GuardLevel = 'normal' | 'guarded' | 'throttled' | 'halted';

/**
 * 水位跃迁防抖：目标档需连续这么多次采样一致才真正跃迁（CP §6.3）。
 * 主循环 5s 一跳，2 次 ≈ 10s 持续偏差才算数——足以压掉 MemAvailable 的抖动，
 * 又不至于在真的内存滑坡时反应迟钝。
 */
export const GUARD_DEBOUNCE_TICKS = 2;

/** 执行面容器指令口（契约 J5；缺省 = 只记账不下发）。 */
export interface ExecPorts {
  pauseContainer(dotId: string): Promise<void>;
  unpauseContainer(dotId: string): Promise<void>;
  destroyDotContainer(dotId: string, opts: { keepVolumes: boolean }): Promise<void>;
  getContainerStats(dotId: string): Promise<{ memMb: number; hasInflightCall: boolean }>;
}

export interface GuardDeps {
  db: DatabaseSync;
  cfg: ControlPlaneConfig;
  queue: Queue;
  bus: { publish(topic: string, payload: unknown, opts?: { dotId?: string }): unknown };
  record(kind: string, level: ResourceEventLevel, detail: string): void;
  /** 本模块曾 pause 过的容器集合对应的 dotId 列表（解冻用）。 */
  knownDotIds(): string[];
  exec?: ExecPorts;
  /** 宿主内存读数（WSL 内核视角；测试可注入假值）。缺省 = /proc/meminfo 语义的 freemem。 */
  readMem?(): { availableMb: number };
  /** 环境变量表（缺省 process.env）；DOTD_GUARD_BASE_MB 钉基线用。 */
  env?: NodeJS.ProcessEnv;
}

/** CP §8 getGuardStatus 返回面。 */
export interface GuardStatus {
  level: GuardLevel;
  memAvailableMb: number;
  baseMb: number;
  daemonRssMb: number;
  recent: ResourceEventRow[];
}

export class Guard {
  private level: GuardLevel = 'normal';
  private baseMb: number | null = null;
  /** 标定采样（30min 的 MemAvailable 样本）。 */
  private samples: number[] = [];
  private calibrating = true;
  private calibrateStartedAt = Date.now();
  /** 本模块曾 pause 的 dotId 集合（解冻路径 CP §6.3）。 */
  private readonly pausedDots = new Set<string>();
  /** daemonRss 连续超限计数（CP §6.3：连续 3 次只拒绝新建 merge/note，绝不自杀）。 */
  private rssOverCount = 0;
  /** 防抖状态：连续同向采样的目标档与计数（见 applyLevel）。 */
  private debounceTo: GuardLevel | null = null;
  private debounceCount = 0;
  private readonly deps: GuardDeps;
  private readonly cfg: ControlPlaneConfig;

  constructor(deps: GuardDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    // 运维覆盖：DOTD_GUARD_BASE_MB 直接钉死基线（跳过标定）。
    // 场景：宿主机常态内存被 WSL vmmem 占据时，自然基线标定会把档位永久压在
    // throttled——但 dotd 的重内存工作负载本来在容器侧，宿主机余量不该封死队列。
    const pin = (deps.env ?? process.env).DOTD_GUARD_BASE_MB;
    if (pin !== undefined && pin.length > 0) {
      const n = Number(pin);
      if (!Number.isFinite(n) || n < 0) throw new Error(`DOTD_GUARD_BASE_MB 非法：${pin}`);
      this.baseMb = Math.round(n);
      this.calibrating = false;
    }
  }

  /** CP §6.3 guard.calibrateOrUseFallback()：未标定完用兜底固定值。 */
  calibrateOrUseFallback(): void {
    if (this.baseMb !== null) {
      this.calibrating = false;
      return;
    }
    this.sample();
    if (this.samples.length === 0) return;
    this.baseMb = percentile(this.samples, 0.5);
    this.calibrating = false;
    this.deps.record(
      'watermark',
      'normal',
      JSON.stringify({ calibrated: true, baseMb: this.baseMb }),
    );
  }

  /** 每 5s 的 memory guard 主循环（CP §6.3 / CP §2.1-④）。 */
  tick(): GuardStatus {
    const mem = this.readMemAvailable();
    if (this.calibrating) {
      this.sample(mem.availableMb);
      const elapsed = Date.now() - this.calibrateStartedAt;
      if (elapsed >= this.cfg.calibrateMs || this.samples.length >= 360) {
        this.baseMb = percentile(this.samples, 0.5);
        this.calibrating = false;
        this.deps.record(
          'watermark',
          'normal',
          JSON.stringify({ calibrated: true, baseMb: this.baseMb, samples: this.samples.length }),
        );
      }
    }
    this.applyLevel(mem.availableMb);
    this.checkDaemonRss();
    this.unfreezeIfRecovered();
    return this.status(mem.availableMb);
  }

  /** CP §8 getGuardStatus。 */
  status(memAvailableMb = this.readMemAvailable().availableMb): GuardStatus {
    const recent = this.deps.db
      .prepare('SELECT * FROM resource_events ORDER BY id DESC LIMIT 20')
      .all() as unknown as ResourceEventRow[];
    return {
      level: this.level,
      memAvailableMb,
      baseMb: this.baseMb ?? 0,
      daemonRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      recent,
    };
  }

  currentLevel(): GuardLevel {
    return this.level;
  }

  /** 当前待确认的跃迁候选（防抖计数中）；无则 null。测试与状态页可读。 */
  pendingLevel(): { to: GuardLevel; count: number } | null {
    return this.debounceTo === null ? null : { to: this.debounceTo, count: this.debounceCount };
  }

  // ── 水位计算（滞回：进 guarded 需 <进入线，退 guarded 需 ≥normal 线）─────

  private applyLevel(memAvailableMb: number): void {
    const t = this.thresholds();
    let next: GuardLevel;
    if (memAvailableMb < t.throttledMb) next = 'halted';
    else if (memAvailableMb < t.guardedMb) next = 'throttled';
    else if (memAvailableMb < t.normalMb) next = 'guarded';
    else next = 'normal';
    if (next === this.level) {
      // 回到当前档：防抖计数作废（同向连续性断了）
      this.debounceTo = null;
      this.debounceCount = 0;
      return;
    }

    // 滞回（CP §6.3）：从低往高走时，退出 guarded 需 ≥ normal 线，其余同理——
    // 实现为"升级立即、降级需越过目标档的进入线"，即上面判定本身就是进入线语义。
    //
    // 防抖（CP §6.3，2026-10-17 修）：**连续两次同向采样**才允许跃迁。此前只写了
    // 注释没实现——单次采样即跃迁，MemAvailable 贴着 7168MB 线抖动时水位 5~12s 来回
    // 翻烧饼，实测已误入 throttled→pause 容器再 unpause（DB/docker 状态分裂）。
    // 5s tick × 2 ≈ 10s 持续才算数；halted 也一样等第二次（它带 destroyDotContainer，
    // 比 pause 更不能被一次瞬时低读数触发）。来回抖动的样本永远凑不齐连续两次。
    if (this.debounceTo === next) this.debounceCount += 1;
    else {
      this.debounceTo = next;
      this.debounceCount = 1;
    }
    if (this.debounceCount < GUARD_DEBOUNCE_TICKS) return;

    this.debounceTo = null;
    this.debounceCount = 0;
    const from = this.level;
    this.level = next;
    this.deps.record(
      'watermark',
      next,
      JSON.stringify({ from, to: next, memAvailableMb, thresholds: t }),
    );
    this.deps.bus.publish('guard.level', { from, to: next, memAvailableMb });
    void this.applyContainerPolicy(next);
  }

  /** 四档阈值：标定后用相对基线，未标定用兜底固定值。 */
  private thresholds(): { normalMb: number; guardedMb: number; throttledMb: number } {
    if (this.baseMb === null) {
      return { ...this.cfg.fallbackThresholds };
    }
    const base = this.baseMb;
    return {
      normalMb: base + this.cfg.dotdReserveMb,
      guardedMb: base + 3 * 1024,
      throttledMb: base,
    };
  }

  // ── 容器指令（CP §6.3 表；实施归 EX，契约 J5）────────────────────────

  private async applyContainerPolicy(level: GuardLevel): Promise<void> {
    const exec = this.deps.exec;
    for (const dotId of this.deps.knownDotIds()) {
      if (level === 'guarded') {
        // guarded 绝不 pause：CP §6.3 表里 guarded 仍正常 pop、只是留观察余量；
        // 且 unfreezeIfRecovered 在 guarded 就解冻——同档既 pause 又 unpause 是
        // 同 tick 竞态，实测（WSL 2026-10-16）造成 DB/docker 状态分裂。
        continue;
      } else if (level === 'throttled') {
        // 仅对**无在途调用**的容器 pause；正 await exec.runTool 的绝不 pause（issue #4）。
        if (!this.pausedDots.has(dotId) && !(await this.hasInflight(dotId))) {
          this.pausedDots.add(dotId);
          this.deps.record('container_pause', 'throttled', JSON.stringify({ dotId }));
          if (exec !== undefined) await exec.pauseContainer(dotId).catch(() => {});
        }
      } else if (level === 'halted') {
        // 有在途调用的容器 kill（记 container_kill），idle 的 pause。
        if (await this.hasInflight(dotId)) {
          this.deps.record('container_kill', 'halted', JSON.stringify({ dotId }));
          if (exec !== undefined) {
            await exec.destroyDotContainer(dotId, { keepVolumes: true }).catch(() => {});
          }
          this.pausedDots.delete(dotId);
        } else if (!this.pausedDots.has(dotId)) {
          this.pausedDots.add(dotId);
          this.deps.record('container_pause', 'halted', JSON.stringify({ dotId, idle: true }));
          if (exec !== undefined) await exec.pauseContainer(dotId).catch(() => {});
        }
      }
    }
  }

  /** 解冻路径（CP §6.3 补 issue #4 缺口）：水位回升对本模块曾 pause 过的集合 unpause。 */
  private unfreezeIfRecovered(): void {
    if (this.level === 'normal' || this.level === 'guarded') {
      // 容器解冻（有 pause 过才做）
      if (this.pausedDots.size > 0) {
        const exec = this.deps.exec;
        for (const dotId of [...this.pausedDots]) {
          this.deps.record('container_unpause', this.level, JSON.stringify({ dotId }));
          if (exec !== undefined) void exec.unpauseContainer(dotId).catch(() => {});
        }
        this.pausedDots.clear();
      }
      // 水位回升把 paused(stop_reason='watermark') 任务批量回 queued（保 priority）。
      // 注意：与上面的容器解冻是两件事——pausedDots 为空（如水位从未进过 throttled，
      // 但别处 pauseByReason 落过 watermark 暂停）时这条也必须跑。
      const res = this.deps.db
        .prepare(
          `UPDATE tasks SET status='queued', stop_reason=NULL, updated_at=?
           WHERE status='paused' AND stop_reason='watermark'`,
        )
        .run(Date.now());
      if (res.changes > 0) {
        this.deps.bus.publish('task.state', { to: 'queued', resumed: res.changes });
      }
    }
  }

  private async hasInflight(dotId: string): Promise<boolean> {
    const exec = this.deps.exec;
    if (exec === undefined) return false;
    try {
      const stats = await exec.getContainerStats(dotId);
      return stats.hasInflightCall;
    } catch {
      return false;
    }
  }

  // ── daemon 自身 RSS（CP §6.3）───────────────────────────────────────

  /**
   * daemonRss = process.memoryUsage().rss（软上限 cfg.daemonRssMaxMb=1024，超限先 GC 提示，
   * 连续 3 次超限只拒绝新建 merge/note，绝不自杀）。
   */
  private checkDaemonRss(): void {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    const limit = this.cfg.daemonRssMaxMb;
    if (rssMb > limit) {
      this.rssOverCount += 1;
      this.deps.record('watermark', 'normal', JSON.stringify({ daemonRssMb: Math.round(rssMb) }));
      if (this.rssOverCount >= 3) {
        this.rejectNewMerges = true;
      }
    } else {
      this.rssOverCount = 0;
      this.rejectNewMerges = false;
    }
  }

  /** 连续 3 次 RSS 超限 → 拒绝新建 merge/note（CP §6.3；绝不自杀）。 */
  rejectNewMerges = false;

  // ── 读数 ───────────────────────────────────────────────────────────

  private readMemAvailable(): { availableMb: number } {
    if (this.deps.readMem !== undefined) return this.deps.readMem();
    // WSL 内核视角的 MemAvailable ≈ os.freemem()（Linux 语义）；Windows 原生下
    // freemem 同样给出"可用物理内存"，是尽力而为的等价读数（CP 开放问题 #3）。
    return { availableMb: Math.round(freemem() / 1024 / 1024) };
  }

  private sample(value?: number): void {
    const v = value ?? this.readMemAvailable().availableMb;
    if (this.samples.length < 2048) this.samples.push(v);
  }
}

/** p50 分位（CP §6.3：取 MemAvailable 分布的 p50=base）。 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}
