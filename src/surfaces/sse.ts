/**
 * src/surfaces/sse.ts —— SSE 事件总线（bus_seq 游标 + 断线补档）。
 *
 * 依据（surfaces.md §4.5 / §5.2 `GET /api/stream?topics=…` / 契约 S-3）：
 * - `BusChannel = 'chat'|'approval'|'queue'|'breaker'|'step'|'log'`；
 *   `BusEvent{seq,channel,kind,at,dotId,payload}`；全部 publish（含瞬态 chat.delta）
 *   统一取自 bus_seq 计数器（+1 每 publish），重启从 `surf_sse_cursor` 恢复。
 * - 游标**不借** CP events.id（TEXT，不可排序）也不借审批 id（Q3 已裁决，§4.5）。
 * - `Last-Event-ID` 语义：游标落后于 head 且 ≤5000 条内、且该通道可由属主表重建
 *   （approval 由 GOV `listPending()`、queue 由 CP `list()`），则**重放快照事件**；
 *   否则发 `{"kind":"resync"}`，客户端对 queue/breaker/approval 各拉一次 REST 校正。
 * - `chat.delta` 仅进总线不落库，每订阅者队列上限 200，溢出丢 delta，
 *   靠 `chat.final` 校正（SSE_DELTA_QUEUE_LIMIT）。
 * - 上游事件名映射 = 直接订阅 src/shared/bus.ts 的 TOPICS（不重造），本文件只做
 *   "BusEvent → SSE 帧"的序列化、游标推进与重放判定。
 */

import type { DatabaseSync } from 'node:sqlite';
import { TOPICS } from '../shared/bus.ts';
import type { BusChannel, BusEvent, EventBus } from '../shared/bus.ts';
import type { ApprovalView } from '../shared/contracts.ts';
import { SSE_DELTA_QUEUE_LIMIT, SSE_REPLAY_WINDOW } from './types.ts';

/** `surf_sse_cursor` 的固定主键（DDL：CHECK(k = 1)）。 */
const CURSOR_KEY = 1;

/** §4.5：可由属主表重建的通道（approval/queue）；其余通道无重建源，超窗只能 resync。 */
const REPLAYABLE_CHANNELS: readonly BusChannel[] = ['approval', 'queue'];

/** resync 事件的 kind（§4.5 原文 `{"kind":"resync"}`）。 */
export const RESYNC_KIND = 'resync';

/** 重放窗内发的快照事件 kind（替代逐条重放历史事件，避免顺序/去重歧义）。 */
export const SNAPSHOT_KINDS = {
  approval: 'approval.snapshot',
  queue: 'queue.snapshot',
} as const;

/** §4.5 重放/快照的数据源（装配层注入；缺省 = 只发 resync）。 */
export interface SseSnapshotProvider {
  /** approval 通道：GOV listPending()（与 GET /api/approvals 同一数据源）。 */
  approvals(): ApprovalView[];
  /** queue 通道：CP list({status:['queued','running']})（与 GET /api/queue 同一数据源）。 */
  queue(): Array<{ id: string; title: string; status: string; priority: number; dotId: string }>;
}

/** SSE 帧（已序列化好 data 段；测试可直接断言）。 */
export interface SseFrame {
  /** SSE `id:` 字段 = bus_seq（客户端回传 Last-Event-ID）。 */
  id: number;
  channel: BusChannel;
  kind: string;
  /** `data:` 段的完整 JSON 文本。 */
  data: string;
}

/**
 * §4.5 重放环形缓冲的缺省容量（= SSE_REPLAY_WINDOW，5000 帧）。
 *
 * 为什么单独列一个常量：`SseBusOptions.replayWindow` 是**测试专用注入口**——
 * 「环形缓冲只留 N 帧，超出即不可重放」这条用例如果按生产值 5000 跑，需要 push 5005 帧
 * 并每次 `Array.prototype.shift()` 一个 5000 元素数组（主体序列化是 O(5000²) 字节拷贝，
 * 实测单条用例 ~40–80s）。生产路径永远用本常量（见 `SseBus.replayWindow` 的类字段初始化），
 * 只有测试显式传参时才变小；**默认值未变**。
 */
export const DEFAULT_SSE_REPLAY_WINDOW = SSE_REPLAY_WINDOW;

export interface SseBusOptions {
  db: DatabaseSync;
  bus: EventBus;
  snapshot?: SseSnapshotProvider;
  now?(): Date;
  /** 游标落盘节流：每 N 次 publish 落一次（0 = 每次 publish 都落）。默认 0（实时续读）。 */
  persistEvery?: number;
  /**
   * 环形缓冲容量（帧）。**缺省 = DEFAULT_SSE_REPLAY_WINDOW（= SSE_REPLAY_WINDOW = 5000）**，
   * 与契约 §4.5 的「只保留 5000 帧」一致；只有测试为了不跑 O(N²) 时显式传小值。
   */
  replayWindow?: number;
}

/** 单个 SSE 订阅者的登记项。 */
interface Subscriber {
  id: number;
  channels: Set<BusChannel>;
  dotId: string | undefined;
  /** 只收 payload.taskId 等于它的帧（语音设备按任务隔离）。 */
  taskId: string | undefined;
  /** 设备级断点（`/api/device/stream`）：游标按设备落 surf_kv。 */
  deviceId: string | undefined;
  /** 已下发的最大 seq（增量去重用）。 */
  lastSeq: number;
  /** 上次把游标落盘的时刻（节流用）。 */
  lastPersistAt: number;
  onFrame: (frame: SseFrame) => void;
  /** 已接收的 chat.delta 条数（上限 SSE_DELTA_QUEUE_LIMIT，溢出丢 delta）。 */
  deltas: number;
}

/** 设备游标落盘节流：最多每 500ms 写一次，断线/关闭时强制写。 */
const DEVICE_CURSOR_PERSIST_MS = 500;


// ── 持久游标（surf_sse_cursor 单行表，k=1）────────────────────────────

export class SseCursorStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 读当前持久游标；表空（新库）返回 0。 */
  read(): number {
    const row = this.db.prepare('SELECT seq FROM surf_sse_cursor WHERE k = ?').get(CURSOR_KEY) as
      | { seq?: number }
      | undefined;
    const v = row?.seq;
    return typeof v === 'number' ? v : 0;
  }

  /** 写入持久游标（幂等 upsert）。 */
  write(seq: number): void {
    this.db
      .prepare(
        `INSERT INTO surf_sse_cursor (k, seq) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET seq = excluded.seq`,
      )
      .run(CURSOR_KEY, seq);
  }
}

// ── 设备级游标（surf_kv，key = device_sse:<deviceId>）──────────────────
//
// 为什么不用再建一张表：`surf_kv`（迁移 190）就是给这种「一行状态」用的
// （connwatch 也走它）。设备断线重连时 `/api/device/stream` 不带
// `Last-Event-ID`，就从这里续读；一个设备一条，互不影响。
//
// 语义边界：游标是**已下发**的 seq，不是「已确认收到」。最坏情况是设备
// 收到但没处理就断了，重连后会少这几帧 —— 所以设备仍然必须轮询
// `/api/device/tasks/:id` 拿终态，SSE 只负责"先把话流出来"。

export class SseDeviceCursorStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 读设备的已下发 seq；没有记录返回 null（新设备 → 只进实时流）。 */
  read(deviceId: string): number | null {
    const row = this.db.prepare('SELECT value FROM surf_kv WHERE key = ?').get(`device_sse:${deviceId}`) as
      | { value?: string }
      | undefined;
    const n = Number(row?.value);
    return row !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  /** 写设备游标（幂等 upsert；只允许前进，回退直接忽略）。 */
  write(deviceId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO surf_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE CAST(excluded.value AS INTEGER) > CAST(surf_kv.value AS INTEGER)`,
      )
      .run(`device_sse:${deviceId}`, String(seq), Date.now());
  }
}

// ── SSE 总线 ─────────────────────────────────────────────────────────

/**
 * SSE 总线：把进程 EventBus 的 publish 转成 SSE 帧，维护持久游标，
 * 并实现 §4.5 的断线补档/resync 判定。
 *
 * 生命周期：daemon 装配层创建（`new EventBus({startSeq: cursorStore.read()})` 恢复 bus_seq，
 * 再 `sseBus.attach()`），测试直接构造。
 */
export class SseBus {
  private readonly cursor: SseCursorStore;
  private readonly deviceCursor: SseDeviceCursorStore;
  private readonly snapshot: SseSnapshotProvider | undefined;
  private readonly now: () => Date;
  private readonly persistEvery: number;
  /**
   * 环形缓冲容量。**生产缺省 = DEFAULT_SSE_REPLAY_WINDOW（= SSE_REPLAY_WINDOW，5000）**；
   * 测试可经 `SseBusOptions.replayWindow` 注入更小值以避免 O(N²) 的 shift 拷贝。
   */
  private readonly replayWindow: number;
  private readonly ring: SseFrame[] = [];
  /**
   * 帧的筛选元数据（dotId / payload.taskId）。放在 WeakMap 里而不是塞进 SseFrame：
   * SseFrame 的 data 已是序列化后的事件，加字段会改变对外形状与既有断言；
   * 帧被移出环形缓冲后元数据随对象一起回收。
   */
  private readonly meta = new WeakMap<SseFrame, { dotId: string; taskId: string | null }>();
  private readonly subscribers = new Map<number, Subscriber>();
  private detachFns: Array<() => void> = [];
  private nextSubId = 1;
  private sincePersist = 0;

  constructor(private readonly opts: SseBusOptions) {
    this.cursor = new SseCursorStore(opts.db);
    this.deviceCursor = new SseDeviceCursorStore(opts.db);
    this.snapshot = opts.snapshot;
    this.now = opts.now ?? (() => new Date());
    this.persistEvery = opts.persistEvery ?? 0;
    this.replayWindow = opts.replayWindow ?? DEFAULT_SSE_REPLAY_WINDOW;
  }

  /** 当前游标（= 最后一次 publish 的 seq）。 */
  currentSeq(): number {
    return this.opts.bus.currentSeq();
  }

  /** 持久游标（= 已落盘的 seq；重启续读的基准）。 */
  persistedSeq(): number {
    return this.cursor.read();
  }

  /**
   * 订阅 EventBus 的全部已登记 topic，把事件扇出到本模块的各 SSE 订阅者。
   * 幂等：重复调用只挂一组订阅。
   */
  attach(topics: readonly string[] = Object.keys(TOPICS)): void {
    if (this.detachFns.length > 0) return;
    this.detachFns = topics.map((t) =>
      this.opts.bus.on(t, (ev) => {
        const frame = this.frameOf(ev);
        this.record(frame);
        this.fanout(ev, frame);
        this.maybePersist();
      }),
    );
  }

  /** 退订 EventBus 与全部订阅者（测试用）。 */
  detach(): void {
    for (const off of this.detachFns) off();
    this.detachFns = [];
    this.subscribers.clear();
  }

  /** BusEvent → SSE 帧，并记下筛选元数据（dotId / taskId）。 */
  private frameOf(ev: BusEvent<unknown>): SseFrame {
    const frame: SseFrame = { id: ev.seq, channel: ev.channel, kind: ev.kind, data: JSON.stringify(ev) };
    const payload = ev.payload as { taskId?: unknown } | null | undefined;
    const taskId =
      payload !== null && typeof payload === 'object' && typeof payload.taskId === 'string' ? payload.taskId : null;
    this.meta.set(frame, { dotId: ev.dotId, taskId });
    return frame;
  }

  /** 事件入环形缓冲 + 落盘游标（§4.5：重启续读）。 */
  private record(frame: SseFrame): void {
    this.ring.push(frame);
    // 容量缺省即 SSE_REPLAY_WINDOW（5000），行为与原实现逐字一致（只留最近 N 帧）。
    if (this.ring.length > this.replayWindow) this.ring.shift();
  }

  private maybePersist(): void {
    if (this.persistEvery > 0) {
      this.sincePersist++;
      if (this.sincePersist < this.persistEvery) return;
      this.sincePersist = 0;
    }
    this.cursor.write(this.opts.bus.currentSeq());
  }

  /** 扇出到匹配的订阅者（坏订阅者抛错被隔离，不影响其他订阅者）。 */
  private fanout(ev: BusEvent<unknown>, frame: SseFrame): void {
    for (const sub of [...this.subscribers.values()]) {
      if (sub.channels.size > 0 && !sub.channels.has(ev.channel)) continue;
      if (sub.dotId !== undefined && ev.dotId !== sub.dotId) continue;
      if (sub.taskId !== undefined) {
        const payload = ev.payload as { taskId?: unknown } | null | undefined;
        if (payload === null || typeof payload !== 'object' || payload.taskId !== sub.taskId) continue;
      }
      if (ev.kind === 'chat.delta') {
        sub.deltas++;
        if (sub.deltas > SSE_DELTA_QUEUE_LIMIT) continue; // 溢出丢 delta，靠 chat.final 校正
      }
      this.push(sub, frame);
    }
  }

  /**
   * 推进订阅者的断点。`frame.id <= lastSeq` 返回 false：断点重连时客户端可能
   * 同时带 `Last-Event-ID` 和设备游标，两条来源必须收敛成一条不重复的流。
   */
  private advance(sub: Subscriber, frame: SseFrame): boolean {
    if (frame.id <= sub.lastSeq) return false;
    sub.lastSeq = frame.id;
    this.persistDeviceCursor(sub, false);
    return true;
  }

  /** 实时下发给单个订阅者（advance + 回调）。 */
  private push(sub: Subscriber, frame: SseFrame): void {
    if (!this.advance(sub, frame)) return;
    try {
      sub.onFrame(frame);
    } catch {
      // 隔离坏订阅者：单个 SSE 客户端断开/异常不得影响总线与其他订阅者
    }
  }

  /** 设备游标落盘（节流；关闭连接时 force=true）。 */
  private persistDeviceCursor(sub: Subscriber, force: boolean): void {
    if (sub.deviceId === undefined || sub.lastSeq <= 0) return;
    const at = this.now().getTime();
    if (!force && at - sub.lastPersistAt < DEVICE_CURSOR_PERSIST_MS) return;
    sub.lastPersistAt = at;
    try {
      this.deviceCursor.write(sub.deviceId, sub.lastSeq);
    } catch {
      // 游标写不进去不能掐断正在说话的连接；下次重连最多重放几帧（有去重）
    }
  }

  /** 按断点重放环形缓冲里的帧（通道 + dot + 任务三重过滤，跳过 resync）。 */
  private replayFrames(
    from: number,
    req: { channels: readonly BusChannel[]; dotId?: string; taskId?: string },
  ): SseFrame[] {
    const channels = new Set(req.channels);
    const out: SseFrame[] = [];
    for (const f of this.ring) {
      if (f.id <= from || f.kind === RESYNC_KIND) continue;
      if (channels.size > 0 && !channels.has(f.channel)) continue;
      const m = this.meta.get(f);
      if (req.dotId !== undefined && m?.dotId !== req.dotId) continue;
      if (req.taskId !== undefined && m?.taskId !== req.taskId) continue;
      out.push(f);
    }
    return out;
  }

  /**
   * §4.5 Last-Event-ID 语义的判定。
   *
   * @returns `{action:'live'}` 直接进实时流；`{action:'replay',frames}` 补档；
   *          `{action:'resync',frame}` 超窗/无可重建通道，客户端拉 REST 校正。
   */
  reconnectPlan(
    lastEventId: number | null,
    channels: readonly BusChannel[] = [],
  ):
    | { action: 'live' }
    | { action: 'replay'; frames: SseFrame[] }
    | { action: 'resync'; frame: SseFrame } {
    const head = this.opts.bus.currentSeq();
    if (lastEventId === null || lastEventId >= head) return { action: 'live' };

    const lag = head - lastEventId;
    if (lag > this.replayWindow) return { action: 'resync', frame: this.resyncFrame('lag', lag) };

    const wanted =
      channels.length === 0 ? [...REPLAYABLE_CHANNELS] : channels.filter((c) => REPLAYABLE_CHANNELS.includes(c));
    if (wanted.length === 0) return { action: 'resync', frame: this.resyncFrame('no_replayable_channel', lag) };

    const frames = this.ring.filter(
      (f) => f.id > lastEventId && wanted.includes(f.channel) && f.kind !== RESYNC_KIND,
    );
    return { action: 'replay', frames };
  }

  /** 构造 resync 帧（§4.5：`{"kind":"resync"}` + 原因与落后条数）。 */
  resyncFrame(reason: 'lag' | 'no_replayable_channel', lag: number): SseFrame {
    const head = this.opts.bus.currentSeq();
    const ev: BusEvent<{ reason: string; lag: number; head: number }> = {
      seq: head,
      channel: 'log',
      kind: RESYNC_KIND,
      at: this.now().toISOString(),
      dotId: 'dot1',
      payload: { reason, lag, head },
    };
    return { id: head, channel: 'log', kind: RESYNC_KIND, data: JSON.stringify(ev) };
  }

  /**
   * 快照帧：重放窗内（或 resync 后）对可由属主表重建的通道各发一条当前快照，
   * 客户端据此一次性校正，不必重放历史逐条。
   */
  snapshotFrames(channels: readonly BusChannel[]): SseFrame[] {
    if (this.snapshot === undefined) return [];
    const head = this.opts.bus.currentSeq();
    const at = this.now().toISOString();
    const mk = (channel: BusChannel, kind: string, payload: unknown): SseFrame => {
      const ev: BusEvent<unknown> = { seq: head, channel, kind, at, dotId: 'dot1', payload };
      return { id: head, channel, kind, data: JSON.stringify(ev) };
    };
    const want = (c: BusChannel): boolean => channels.length === 0 || channels.includes(c);
    const out: SseFrame[] = [];
    if (want('approval')) out.push(mk('approval', SNAPSHOT_KINDS.approval, this.snapshot.approvals()));
    if (want('queue')) out.push(mk('queue', SNAPSHOT_KINDS.queue, this.snapshot.queue()));
    return out;
  }

  /** 把帧序列化成 SSE 文本（`id:` / `event:` / `data:` 三行 + 空行）。 */
  static formatFrame(frame: SseFrame): string {
    return `id: ${frame.id}\nevent: ${frame.channel}.${frame.kind}\ndata: ${frame.data}\n\n`;
  }

  /**
   * 注册一个 SSE 订阅者，返回连接建立后应立即下发的帧（重放快照 / resync + 快照）
   * 与退订函数。实时帧随后经 `onFrame` 推送。
   */
  subscribe(
    req: {
      lastEventId: number | null;
      channels: readonly BusChannel[];
      dotId?: string;
      taskId?: string;
      /** `/api/device/stream`：设备身份，用于断线续读（surf_kv 里的 device_sse:<id>）。 */
      deviceId?: string;
    },
    onFrame: (frame: SseFrame) => void,
  ): { initial: SseFrame[]; unsubscribe: () => void; subscriberId: number } {
    const id = this.nextSubId++;
    // 任务级（设备）流：断点 = 客户端显式 Last-Event-ID ?? 该设备上次下发的 seq。
    // 控制台流：沿用 §4.5 的 Last-Event-ID 语义（快照/resync）。
    const stored = req.deviceId !== undefined ? this.deviceCursor.read(req.deviceId) : null;
    // 两个断点来源取较大者：设备游标 = 服务端已经发过的，客户端 Last-Event-ID = 它自己确认过的。
    // 取 max 才不会把已经下发的帧再补一遍（增量去重的第一道）。
    const candidates = [req.lastEventId, stored].filter((v): v is number => v !== null);
    const from = candidates.length > 0 ? Math.max(...candidates) : null;
    const sub: Subscriber = {
      id,
      channels: new Set(req.channels),
      dotId: req.dotId,
      taskId: req.taskId,
      deviceId: req.deviceId,
      lastSeq: from ?? 0,
      lastPersistAt: 0,
      onFrame,
      deltas: 0,
    };
    this.subscribers.set(id, sub);

    const initial: SseFrame[] = [];
    if (req.taskId !== undefined) {
      // 任务级流只重放本任务的帧；**不发全局快照**（审批/队列快照属于控制台，
      // 发给设备等于把别的会话的待办泄露给一个语音终端）。
      if (from !== null) {
        const head = this.opts.bus.currentSeq();
        if (head - from > this.replayWindow) {
          initial.push(this.resyncFrame('lag', head - from));
        } else {
          initial.push(...this.replayFrames(from, req));
        }
      }
    } else {
      const plan = this.reconnectPlan(req.lastEventId, req.channels);
      if (plan.action === 'replay') {
        initial.push(...this.snapshotFrames(req.channels), ...plan.frames);
      } else if (plan.action === 'resync') {
        initial.push(plan.frame, ...this.snapshotFrames(req.channels));
      }
    }
    // initial 由调用方（HTTP 层）负责写出，**不再回调 onFrame**：订阅前的历史不进实时回调
    // 是既有契约（tests/surfaces-sse.test.ts）。这里只推进断点与设备游标。
    for (const f of initial) this.advance(sub, f);
    this.persistDeviceCursor(sub, true);

    return {
      initial,
      subscriberId: id,
      unsubscribe: () => {
        this.persistDeviceCursor(sub, true);
        this.subscribers.delete(id);
      },
    };
  }

  /** 当前订阅者数（测试/诊断用；§2.2 资源约束 SSE 连接 ≤8 由 http.ts 强制）。 */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 环形缓冲长度（测试/诊断用）。 */
  buffered(): number {
    return this.ring.length;
  }
}

/**
 * 解析 `GET /api/stream` 的查询参数与 `Last-Event-ID` 头。
 * - `topics=chat,queue`：逗号分隔通道过滤；缺省 = 全部六通道。
 * - `dot=dot1`：可选 dot 过滤。
 * - `Last-Event-ID`：bus_seq；缺省/非法视为 null（新连接）。
 */
export function parseStreamQuery(
  search: string,
  lastEventIdHeader: string | undefined,
): { topics: BusChannel[]; dotId?: string; taskId?: string; lastEventId: number | null } {
  const params = new URLSearchParams(search);
  const valid: readonly string[] = ['chat', 'approval', 'queue', 'breaker', 'step', 'log'];
  const topicsRaw = params.get('topics');
  const topics: BusChannel[] =
    topicsRaw === null
      ? []
      : topicsRaw
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is BusChannel => valid.includes(t));
  const dot = params.get('dot');
  const task = params.get('task');
  const header = lastEventIdHeader?.trim();
  let lastEventId: number | null = null;
  if (header !== undefined && header.length > 0) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) lastEventId = Math.floor(n);
  }
  return { topics, dotId: dot ?? undefined, taskId: task ?? undefined, lastEventId };
}
