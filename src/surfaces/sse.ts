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
  onFrame: (frame: SseFrame) => void;
  /** 已接收的 chat.delta 条数（上限 SSE_DELTA_QUEUE_LIMIT，溢出丢 delta）。 */
  deltas: number;
}

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
  private readonly snapshot: SseSnapshotProvider | undefined;
  private readonly now: () => Date;
  private readonly persistEvery: number;
  /**
   * 环形缓冲容量。**生产缺省 = DEFAULT_SSE_REPLAY_WINDOW（= SSE_REPLAY_WINDOW，5000）**；
   * 测试可经 `SseBusOptions.replayWindow` 注入更小值以避免 O(N²) 的 shift 拷贝。
   */
  private readonly replayWindow: number;
  private readonly ring: SseFrame[] = [];
  private readonly subscribers = new Map<number, Subscriber>();
  private detachFns: Array<() => void> = [];
  private nextSubId = 1;
  private sincePersist = 0;

  constructor(private readonly opts: SseBusOptions) {
    this.cursor = new SseCursorStore(opts.db);
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
        this.record(ev);
        this.fanout(ev);
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

  /** 事件入环形缓冲 + 落盘游标（§4.5：重启续读）。 */
  private record(ev: BusEvent<unknown>): void {
    this.ring.push({ id: ev.seq, channel: ev.channel, kind: ev.kind, data: JSON.stringify(ev) });
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
  private fanout(ev: BusEvent<unknown>): void {
    const frame: SseFrame = { id: ev.seq, channel: ev.channel, kind: ev.kind, data: JSON.stringify(ev) };
    for (const sub of [...this.subscribers.values()]) {
      if (sub.channels.size > 0 && !sub.channels.has(ev.channel)) continue;
      if (sub.dotId !== undefined && ev.dotId !== sub.dotId) continue;
      if (ev.kind === 'chat.delta') {
        sub.deltas++;
        if (sub.deltas > SSE_DELTA_QUEUE_LIMIT) continue; // 溢出丢 delta，靠 chat.final 校正
      }
      try {
        sub.onFrame(frame);
      } catch {
        // 隔离坏订阅者：单个 SSE 客户端断开/异常不得影响总线与其他订阅者
      }
    }
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
    req: { lastEventId: number | null; channels: readonly BusChannel[]; dotId?: string },
    onFrame: (frame: SseFrame) => void,
  ): { initial: SseFrame[]; unsubscribe: () => void; subscriberId: number } {
    const id = this.nextSubId++;
    const sub: Subscriber = {
      id,
      channels: new Set(req.channels),
      dotId: req.dotId,
      onFrame,
      deltas: 0,
    };
    this.subscribers.set(id, sub);

    const plan = this.reconnectPlan(req.lastEventId, req.channels);
    const initial: SseFrame[] = [];
    if (plan.action === 'replay') {
      initial.push(...this.snapshotFrames(req.channels), ...plan.frames);
    } else if (plan.action === 'resync') {
      initial.push(plan.frame, ...this.snapshotFrames(req.channels));
    }
    return {
      initial,
      subscriberId: id,
      unsubscribe: () => {
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
): { topics: BusChannel[]; dotId?: string; lastEventId: number | null } {
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
  const header = lastEventIdHeader?.trim();
  let lastEventId: number | null = null;
  if (header !== undefined && header.length > 0) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) lastEventId = Math.floor(n);
  }
  return { topics, dotId: dot ?? undefined, lastEventId };
}
