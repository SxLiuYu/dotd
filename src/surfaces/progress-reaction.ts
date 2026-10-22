/**
 * src/surfaces/progress-reaction.ts —— 任务「在做」状态标识（2026-10-22）
 *
 * 为什么有这个东西：主人对 T5 过程播报的原话是
 *   「这个为什么要输出出来，不需要输出，给我答案就行，**或者给我一个助手在做的标识就行了**」
 *
 * 播报（progress-push.ts）的问题不在于措辞，而在于**它是消息**：
 * 每 3 步一条新消息，一个 76 步的任务就是二十多条。主人的会话被"正在思考/正在做"
 * 塞满，真正的答案反而被冲走。他要的是"我知道你在忙"，不是"你给我念进度"。
 *
 * 所以这里用**飞书原生 reaction**：在主人那条消息上挂一个表情，
 * 开始挂、结束撤。零新增消息，零未读，会话列表完全干净。
 *
 * ── 设计约束 ───────────────────────────────────────────────────────
 *
 * 1. **失败必须静默**。挂表情挂了，任务照跑。这是装饰，不是功能；
 *    因为 API 抖动让一个能成的任务失败，是本末倒置。
 *    所以所有路径 try/catch 后 return，只落日志。
 *
 * 2. **reaction_id 必须记住**。飞书撤 reaction 要 `reaction_id`，
 *    而它只在**添加时**返回一次。所以添加成功后要把 id 存进任务状态，
 *    结束时才撤得掉（否则表情永远挂在消息上，比不挂更糟）。
 *    重启会丢内存态 —— 那时**宁可不撤**也不乱撤（撤错别人的表情更糟）。
 *
 * 3. **只对飞书入站消息生效**。Web/CLI 来的任务没有 message_id，
 *    那里的"在做"由前端自己显示，不需要我们发。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 飞书 reaction 的最小能力面（真 FeishuGateway 满足；测试注 fake）。 */
export interface ReactionPort {
  /**
   * 给一条消息加 reaction，返回 reaction_id（撤的时候要用）。
   * 失败返回 null，**不抛**。
   */
  addReaction(messageId: string, emoji: string): Promise<string | null>;
  /** 撤掉 reaction。失败返回 false，**不抛**。 */
  removeReaction(messageId: string, reactionId: string): Promise<boolean>;
}

export interface ProgressReactionDeps {
  db: DatabaseSync;
  /** 事件总线（与 progress-push 同口径：订阅 task.state）。 */
  bus: { on(topic: string, handler: (e: { payload: unknown }) => void | Promise<void>): () => void };
  /** 不注入 = 整个功能不启用（与 progress-push 同口径）。 */
  port?: ReactionPort;
  /** 表情类型。飞书内置名，默认 OnIt（"收到/在做"那个手势）。 */
  emoji?: string;
  log: (line: string) => void;
}

/** 一个任务当前挂着的 reaction（内存态；重启后丢失 = 不撤，见文件头约束 2）。 */
interface Pending {
  messageId: string;
  reactionId: string;
}

const DEFAULT_EMOJI = 'OnIt';

export function startProgressReaction(deps: ProgressReactionDeps): {
  /** 任务开始：挂表情。 */
  begin(taskId: string): Promise<void>;
  /** 任务结束：撤表情。 */
  end(taskId: string): Promise<void>;
  /** 退订事件总线（daemon 关闭时用）。 */
  unsubscribe: () => void;
} {
  const pending = new Map<string, Pending>();
  const emoji = deps.emoji ?? DEFAULT_EMOJI;

  /**
   * 从库里查这个任务对应的飞书消息 id。
   *
   * 为什么查库而不是从事件里传：`begin()` 由 Runner 在 startTask 时调用，
   * 那时只有 taskId。消息 id 在入站时就落库了（feishu-inbound.ts 的
   * `messageId` → tasks 表），这里按 taskId 反查是最小耦合。
   */
  const messageIdOf = (taskId: string): string | null => {
    try {
      // 消息 id 存在 tasks.payload_json 里（飞书入站时写入，见 feishu-inbound.ts）。
      // 没有这一列，也就没有额外迁移成本。
      const row = deps.db
        .prepare(`SELECT payload_json AS pj FROM tasks WHERE id = ?`)
        .get(taskId) as { pj?: string | null } | undefined;
      const raw = row?.pj ?? null;
      if (raw === null || raw.length === 0) return null;
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const mid = obj['feishuMessageId'];
      return typeof mid === 'string' && mid.length > 0 ? mid : null;
    } catch {
      // payload 不是 JSON / 查询失败：安静退出，不因为装饰功能挡住任务。
      return null;
    }
  };

  const api = {
    async begin(taskId: string): Promise<void> {
      if (deps.port === undefined) return;
      if (pending.has(taskId)) return; // 已经挂过（同一任务重入）

      const messageId = messageIdOf(taskId);
      if (messageId === null) return; // Web/CLI 来的任务：没有消息可挂，正常

      try {
        const reactionId = await deps.port.addReaction(messageId, emoji);
        if (reactionId === null) {
          deps.log(`[progress-reaction] ${taskId} 挂表情失败（不影响任务）`);
          return;
        }
        pending.set(taskId, { messageId, reactionId });
      } catch (err) {
        deps.log(`[progress-reaction] ${taskId} 挂表情异常：${String(err)}`);
      }
    },

    async end(taskId: string): Promise<void> {
      const p = pending.get(taskId);
      if (p === undefined) return;
      // **先删本地状态再调 API**：即使 remove 失败，也不该在内存里留垃圾，
      // 更不该在下次重试时拿一个过期的 reaction_id 去撤（可能已经撤过了）。
      pending.delete(taskId);
      if (deps.port === undefined) return;
      try {
        const ok = await deps.port.removeReaction(p.messageId, p.reactionId);
        if (!ok) deps.log(`[progress-reaction] ${taskId} 撤表情失败（会留在消息上）`);
      } catch (err) {
        deps.log(`[progress-reaction] ${taskId} 撤表情异常：${String(err)}`);
      }
    },
  };

  // 订阅 task.state：running 挂、终态撤。与 progress-push.ts:391 同构。
  //
  // 幂等性靠 begin 里的 `pending.has()` 与 end 里的 `undefined` 早退 ——
  // task.state 会重复投递（每次状态跃迁一条），重复挂会在消息上叠出多个表情。
  const unsubscribe = deps.bus.on('task.state', async (e) => {
    const p = e.payload as { taskId?: unknown; to?: unknown };
    if (typeof p.taskId !== 'string') return;
    const to = typeof p.to === 'string' ? p.to : '';
    if (to === 'running' || to === 'awaiting_approval') {
      await api.begin(p.taskId);
      return;
    }
    if (to === 'done' || to === 'failed' || to === 'cancelled') {
      await api.end(p.taskId);
    }
  });

  deps.log(
    `[progress-reaction] 「在做」表情标识已启用（task.state → 主人消息上加/撤 ${emoji}）`,
  );

  return { ...api, unsubscribe };
}
