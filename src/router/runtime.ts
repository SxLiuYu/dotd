/**
 * src/router/runtime.ts —— Tier2 本地引擎的运行时槽位（§3.1 RouterRuntime）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §3.1 注释：Tier2 的内存槽位信号量与连续 busy 计数存在 RouterRuntime 里，按端点 id
 *   索引，**与配置对象分离**（EndpointDef 是纯配置值对象，不含运行时字段）。
 * - §4.1 busy 规则：槽位获取超时（queue_reject_ms 内没拿到）→ 不直接入窗，busyConsec+1；
 *   未达 busy_consec_limit(3) 时只跳过该端点（排队不是故障）；连续达到 3 → 记一次
 *   engine_unavailable 入窗并按 engine 类退避。**任一成功获取槽位的调用把 busyConsec 清零。**
 * - §4.2：`queue_reject_ms` 只来自 `endpoint.local`，RouteRequest 无覆盖通道。
 * - §4.7 reload 重建语义：新增 id → 建 sem；删除 id → 等在途释放完再回收（上限 5s）；
 *   改 max_concurrency → 重建 sem，容量收缩时超出的在途不抢占、结束后自然收敛。
 * - 机器实测依据（CONTEXT/§4.2 要点）：Colibrì 无 batching（max_kv_slots=1），并发只排队，
 *   max_concurrency=1 是"宁可跳过降级，不可让 8 个请求在本地引擎排队各自超时"的直接落地。
 */

/** 槽位句柄：用完必须 release（route() 用 try/finally）。 */
export interface SlotLease {
  readonly endpointId: string;
  release(): void;
}

interface SemEntry {
  capacity: number;
  inFlight: number;
  /** 等待中的请求数（诊断用）。 */
  waiting: number;
}

/**
 * 计数信号量 + 超时等待。
 *
 * 语义（§4.1/§4.2）：
 * - `tryAcquire(timeoutMs)`：立即可用立即拿；否则排队等待，超过 `queue_reject_ms` 仍未拿到
 *   返回 null（调用方按 busy 规则记账，不视为故障）。
 * - 容量来自端点配置 `local.max_concurrency`，调用方不得覆盖。
 */
export class SlotSemaphore {
  private entry: SemEntry;
  private readonly waiters: Array<{ resolve: (ok: boolean) => void; timer: NodeJS.Timeout }> = [];

  constructor(capacity: number) {
    this.entry = { capacity: Math.max(1, capacity), inFlight: 0, waiting: 0 };
  }

  get capacity(): number {
    return this.entry.capacity;
  }

  get inFlight(): number {
    return this.entry.inFlight;
  }

  get waiting(): number {
    return this.entry.waiting;
  }

  /** 改容量（reload 时 max_concurrency 变化；收缩不抢占在途，§4.7）。 */
  resize(next: number): void {
    this.entry = { ...this.entry, capacity: Math.max(1, next) };
    this.drain();
  }

  tryAcquire(timeoutMs: number): Promise<SlotLease | null> {
    if (this.entry.inFlight < this.entry.capacity) {
      this.entry.inFlight += 1;
      return Promise.resolve(this.makeLease());
    }
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise<SlotLease | null>((resolve) => {
      const w = {
        resolve: (ok: boolean) => {
          clearTimeout(w.timer);
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          this.entry = { ...this.entry, waiting: Math.max(0, this.entry.waiting - 1) };
          if (ok) {
            this.entry.inFlight += 1;
            resolve(this.makeLease());
          } else {
            resolve(null);
          }
        },
        timer: setTimeout(() => w.resolve(false), timeoutMs),
      };
      this.entry = { ...this.entry, waiting: this.entry.waiting + 1 };
      this.waiters.push(w);
    });
  }

  private makeLease(): SlotLease {
    let released = false;
    return {
      endpointId: '',
      release: () => {
        if (released) return;
        released = true;
        this.entry.inFlight -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.entry.inFlight < this.entry.capacity && this.waiters.length > 0) {
      const w = this.waiters[0];
      if (w === undefined) break;
      w.resolve(true);
    }
  }

  /** 在途请求数（含等待者，>0 表示不可立即回收，§4.7 删除 id 时用）。 */
  get busy(): boolean {
    return this.entry.inFlight > 0 || this.entry.waiting > 0;
  }
}

interface SlotRuntimeEntry {
  sem: SlotSemaphore;
  busyConsec: number;
}

/**
 * RouterRuntime（§3.1）：仅 Tier2 端点的内存槽位 + busyConsec。
 *
 * reload 语义（§4.7，三类 diff）：
 * - 新增 id → 建 sem（容量取新配置 max_concurrency）；
 * - 删除 id → `recycleRemoved()` 等在途释放完再回收（上限 5s，超时强制丢弃）；
 * - 改 max_concurrency → resize（收缩不抢占在途）。
 * 其余纯参数（queue_reject_ms/warm_grace_ms）即时生效，无需重建。
 */
export class RouterRuntime {
  private readonly slots = new Map<string, SlotRuntimeEntry>();
  /** 待回收的已删除端点（等在途释放）。 */
  private readonly retired = new Set<string>();
  private retiredAt: number | null = null;
  /** 回收宽限上限（§4.7：上限 5s）。 */
  private static readonly RETIRE_GRACE_MS = 5000;

  /** 确保端点有槽位（容量=配置 max_concurrency）。 */
  ensure(endpointId: string, maxConcurrency: number): SlotSemaphore {
    const cur = this.slots.get(endpointId);
    if (cur !== undefined) {
      if (cur.sem.capacity !== maxConcurrency) cur.sem.resize(maxConcurrency);
      return cur.sem;
    }
    const sem = new SlotSemaphore(maxConcurrency);
    this.slots.set(endpointId, { sem, busyConsec: 0 });
    return sem;
  }

  get(endpointId: string): SlotRuntimeEntry | undefined {
    return this.slots.get(endpointId);
  }

  has(endpointId: string): boolean {
    return this.slots.has(endpointId);
  }

  /** busy 计数 +1，返回新值（§4.1）。 */
  bumpBusy(endpointId: string): number {
    const e = this.slots.get(endpointId);
    if (e === undefined) return 0;
    e.busyConsec += 1;
    return e.busyConsec;
  }

  /** 成功获取槽位后清零（§4.1：任一成功获取槽位的调用把 busyConsec 清零）。 */
  clearBusy(endpointId: string): void {
    const e = this.slots.get(endpointId);
    if (e !== undefined) e.busyConsec = 0;
  }

  /** reload：删除的端点进入待回收集合。 */
  markRemoved(endpointId: string): void {
    if (this.slots.has(endpointId)) {
      this.retired.add(endpointId);
      if (this.retiredAt === null) this.retiredAt = Date.now();
    }
  }

  /**
   * 等在途释放完再回收（§4.7）。返回仍被占用的端点 id（超 5s 由调用方强制丢弃，
   * 在途请求自然失败走降级）。
   */
  recycleRemoved(now = Date.now()): string[] {
    const still: string[] = [];
    for (const id of this.retired) {
      const e = this.slots.get(id);
      if (e === undefined) {
        this.retired.delete(id);
        continue;
      }
      if (!e.sem.busy) {
        this.slots.delete(id);
        this.retired.delete(id);
      } else if (this.retiredAt !== null && now - this.retiredAt > RouterRuntime.RETIRE_GRACE_MS) {
        // 超宽限：强制丢弃信号量对象；在途 lease 仍持有旧 entry，release 自然收敛
        this.slots.delete(id);
        this.retired.delete(id);
      } else {
        still.push(id);
      }
    }
    if (this.retired.size === 0) this.retiredAt = null;
    return still;
  }

  /** 诊断（snapshot/janitor 用）。 */
  stats(): Array<{ endpointId: string; capacity: number; inFlight: number; waiting: number; busyConsec: number }> {
    const out: Array<{
      endpointId: string;
      capacity: number;
      inFlight: number;
      waiting: number;
      busyConsec: number;
    }> = [];
    for (const [id, e] of this.slots) {
      out.push({
        endpointId: id,
        capacity: e.sem.capacity,
        inFlight: e.sem.inFlight,
        waiting: e.sem.waiting,
        busyConsec: e.busyConsec,
      });
    }
    return out;
  }
}
