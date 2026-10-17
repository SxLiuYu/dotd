/**
 * src/shared/bus.ts —— daemon 内进程事件总线（EventBus）。
 *
 * 依据：
 * - SF §4.5：`BusChannel = 'chat'|'approval'|'queue'|'breaker'|'step'|'log'`，
 *   `BusEvent{seq,channel,kind,at,dotId,payload}`，游标 = surf_sse_cursor 的 bus_seq
 *   （+1 每 publish，重启从 surf_sse_cursor 恢复）。
 * - SF §4.5 末段：上游事件名映射 = 直接订阅各模块已发布的事件名，**不重造**。
 * - GOV §8 事件表、MR §5.3、CP §8 onBus、EX §10 事件流：各自的发布名登记在下方
 *   `TOPICS` 常量表里，本文件只做承载，不改写任何模块的发布名。
 *
 * 命名风格说明（重要，勿"统一"）：历史上有两套分隔符并存——
 *   GOV 治理面用冒号：`approval:created`、`governance:quarantine`
 *   其余用点号：`router.mode_changed`、`task.state`、`exec.call.started`
 * 接缝契约逐字采纳了各模块的发布名（SF §4.5"直接订阅，不重造"），因此**保持原样**；
 * 新事件请归入既有前缀族（router./exec./task./approval:/governance:/chat./log.）。
 *
 * 语义：单进程同步派发。handler 抛错不得影响其他 handler（记 log 通道后吞掉），
 * 否则一个坏订阅者会炸掉发布方（主循环）——这是骨架级的稳定性约定。
 */

/** SF §4.5 六通道（BusEvent.channel）。 */
export type BusChannel = 'chat' | 'approval' | 'queue' | 'breaker' | 'step' | 'log';

/** SF §4.5 BusEvent 形状。 */
export interface BusEvent<E = unknown> {
  /** surf_sse_cursor 单调计数器（+1 每 publish）。 */
  seq: number;
  channel: BusChannel;
  kind: string;
  /** ISO8601。 */
  at: string;
  dotId: string;
  payload: E;
}

/** 处理器：同步或异步均可；总线不等待异步 handler（fire-and-forget）。 */
export type BusHandler<E = unknown> = (event: BusEvent<E>) => void | Promise<void>;

/** 取消订阅函数。 */
export type Unsubscribe = () => void;

/** 可订阅的原始 topic（SF §4.5"不重造"——各模块发布名登记于此）。 */
export const TOPICS = {
  // GOV §8 事件表（治理面，冒号族）
  'approval:created': 'approval',
  'approval:decided': 'approval',
  'approval:expired': 'approval',
  'approval:revoked': 'approval',
  'approval:claimed': 'approval',
  'governance:quarantine': 'log',
  'governance:quarantine_lifted': 'log',
  // MR §5.3 发布（router 族，点号）
  'router.mode_changed': 'breaker',
  'router.breaker_changed': 'breaker',
  'router.help_needed': 'log',
  'router.recon_proposal': 'log',
  'router.recovered': 'breaker',
  // CP §8 onBus 的 ControlBusEvent（task/guard 族）
  'task.state': 'queue',
  'task.budget_exhausted': 'queue',
  'guard.level': 'log',
  'event.undecided': 'queue',
  stale_writer: 'log',
  // EX §10 事件流（exec 族）
  'exec.container.state_change': 'log',
  'exec.container.unhealthy': 'log',
  'exec.container.quarantined': 'log',
  'exec.call.started': 'step',
  'exec.call.finished': 'step',
  'exec.call.interrupted': 'step',
  'exec.browser.crashed': 'log',
  'exec.browser.reset': 'log',
  'exec.disk.pressure': 'log',
  'exec.disk.gardened': 'log',
  'exec.docker.unavailable': 'log',
  // SF 自身总线主题（SF §4.5：chat.delta 仅进总线不落库）
  'chat.delta': 'chat',
  'chat.final': 'chat',
  'event.received': 'log',
  // 配置热加载（MR §5.3 订阅）
  'config.models_reloaded': 'log',
} as const satisfies Record<string, BusChannel>;

export type TopicName = keyof typeof TOPICS;

/**
 * 进程事件总线。装配层（daemon.ts）创建唯一实例，按 MR/CP/SF 的 deps.bus 注入各模块。
 * seq 从持久游标恢复（SF §4.5：surf_sse_cursor）。
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<BusHandler<never>>>();
  private seq: number;

  constructor(opts: { startSeq?: number } = {}) {
    this.seq = opts.startSeq ?? 0;
  }

  /** 当前游标（= 最后一次 publish 的 seq；从未发布时为 startSeq）。 */
  currentSeq(): number {
    return this.seq;
  }

  /**
   * 订阅。topic 用 TOPICS 里的字面量；未知 topic 允许订阅（模块可自造内部主题），
   * 但 channel 归类只认 TOPICS 表，否则归 'log'。
   */
  on<E = unknown>(topic: string, handler: BusHandler<E>): Unsubscribe {
    let set = this.handlers.get(topic);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as BusHandler<never>);
    return () => {
      this.handlers.get(topic)?.delete(handler as BusHandler<never>);
    };
  }

  /** 发布。seq 单调 +1；同步派发，handler 抛错被隔离。 */
  publish<E = unknown>(topic: string, payload: E, opts: { dotId?: string; at?: string } = {}): BusEvent<E> {
    const channel: BusChannel = (TOPICS as Record<string, BusChannel | undefined>)[topic] ?? 'log';
    const event: BusEvent<E> = {
      seq: ++this.seq,
      channel,
      kind: topic,
      at: opts.at ?? new Date().toISOString(),
      dotId: opts.dotId ?? 'dot1',
      payload,
    };
    const set = this.handlers.get(topic);
    if (set !== undefined) {
      for (const h of [...set]) {
        try {
          void (h as BusHandler<E>)(event);
        } catch (cause) {
          // 隔离坏订阅者：记 log 通道，绝不影响发布方。
          queueMicrotask(() => {
            try {
              this.publish('event.received', { level: 'error', topic, error: String(cause) });
            } catch {
              // 连错误通路都炸时只能放弃（不应发生）
            }
          });
        }
      }
    }
    return event;
  }

  /** 订阅数（测试/诊断用）。 */
  listenerCount(topic: string): number {
    return this.handlers.get(topic)?.size ?? 0;
  }
}
