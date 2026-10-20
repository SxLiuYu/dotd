/**
 * src/surfaces/progress-push.ts —— 把进度推到飞书（T5，2026-10-20）
 *
 * progress.ts 只做"要不要推、推什么"的纯判断；这个文件负责接线：
 * 订阅 `exec.call.finished` → 攒步数 → 过闸 → 发消息。
 *
 * 为什么订阅 exec.call.finished 而不是 task.state
 *   task.state 只在任务状态**跃迁**时发（queued→running→done），
 *   一个跑 10 分钟的任务从 running 到 done 之间一条都没有。
 *   exec.call.finished 才是"走了一步"的信号。
 *
 * 为什么不新增一张表记进度
 *   steps 表已经有全部信息（seq/kind/tool_name/status）。
 *   只需要记两个数：上次推到第几步、什么时候推的。放内存即可 ——
 *   进程重启后最坏结果是多重推一条"正在做"，代价很小；
 *   为它加表加迁移不值得。
 */
import type { DatabaseSync } from 'node:sqlite';
import { decideProgress, type ProgressConfig, DEFAULT_PROGRESS } from './progress.ts';

export interface ProgressPushDeps {
  db: DatabaseSync;
  bus: { on(topic: string, handler: (e: { payload: unknown }) => void | Promise<void>): () => void };
  /** 发消息的能力。不注入 = 整个功能不启用。 */
  sender?: { send(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> };
  /** 目标会话。sender 存在时必填；两者都给了才启用。 */
  chatId?: string;
  cfg?: ProgressConfig;
  log: (line: string) => void;
  now?: () => number;
}

interface TaskProgressState {
  lastPushAt: number | null;
  lastPushStep: number | null;
  /** 已经推过的最后一条 step seq，防同一事件重投 */
  lastSeenCallId: string | null;
}

/**
 * 启动进度推送。返回 stop。
 *
 * 注意：**默认不启用**（ProgressConfig.enabled 默认 false）。
 * 调用方必须显式传 enabled: true 才会推 —— 升级后不会突然刷屏。
 */
export function startProgressPush(deps: ProgressPushDeps): () => void {
  const cfg = deps.cfg ?? DEFAULT_PROGRESS;
  const now = deps.now ?? (() => Date.now());

  if (!cfg.enabled || deps.sender === undefined || deps.chatId === undefined || deps.chatId === '') {
    deps.log('[progress] 过程可视化未启用（需要 enabled + sender + chatId 三者齐备）');
    return () => undefined;
  }

  const state = new Map<string, TaskProgressState>();

  const unsubscribe = deps.bus.on('exec.call.finished', async (e) => {
    const p = e.payload as { taskId?: unknown; tool?: unknown; callId?: unknown; status?: unknown };
    if (typeof p.taskId !== 'string' || p.taskId === '') return;

    const taskId = p.taskId;
    const callId = typeof p.callId === 'string' ? p.callId : '';
    const st = state.get(taskId) ?? { lastPushAt: null, lastPushStep: null, lastSeenCallId: null };

    // 同一 callId 重投直接忽略（总线不保证不重投）
    if (callId !== '' && st.lastSeenCallId === callId) return;
    st.lastSeenCallId = callId !== '' ? callId : st.lastSeenCallId;

    // 从库里读真实步数与最近几步 —— 不靠内存计数，
    // 因为审批续跑会让 step 序列跳号，内存计数会漂。
    let stepCount = 0;
    let recent: Array<{ kind: 'llm' | 'tool'; toolName: string | null; status: string }> = [];
    let title = '';
    try {
      const row = deps.db
        .prepare('SELECT count(*) AS c FROM steps WHERE task_id=?')
        .get(taskId) as { c?: number } | undefined;
      stepCount = row?.c ?? 0;
      const rows = deps.db
        .prepare(
          'SELECT kind, tool_name AS toolName, status FROM steps WHERE task_id=? ORDER BY seq DESC LIMIT 5',
        )
        .all(taskId) as Array<{ kind: 'llm' | 'tool'; toolName: string | null; status: string }>;
      recent = rows;
      const t = deps.db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId) as
        | { title?: string }
        | undefined;
      title = t?.title ?? '';
    } catch (cause) {
      deps.log(`[progress] 读步骤失败（${taskId}）：${String(cause)}`);
      return;
    }

    // 失败的一步 = 需要人看一眼
    const needsAttention =
      p.status === 'error' || recent.some((r) => r.status === 'failed' || r.status === 'interrupted');

    const decision = decideProgress(
      {
        taskId,
        title: title !== '' ? title : '任务',
        stepCount,
        recentSteps: recent,
        now: now(),
        lastPushAt: st.lastPushAt,
        lastPushStep: st.lastPushStep,
        needsAttention,
      },
      cfg,
    );

    if (!decision.push) {
      state.set(taskId, st);
      return;
    }

    const r = await deps.sender!.send(deps.chatId!, decision.text);
    if (r.ok) {
      st.lastPushAt = now();
      st.lastPushStep = stepCount;
      deps.log(`[progress] ${taskId} 推了进度（${decision.reason}，${stepCount} 步）`);
    } else {
      // 发失败不落账 —— 下一次还有机会补。落账会让"正好那条最该看的"永久丢失。
      deps.log(`[progress] ${taskId} 进度推送失败：${r.error ?? '?'}`);
    }
    state.set(taskId, st);
  });

  // task 结束时清状态，防 map 无限增长
  const unsubscribeDone = deps.bus.on('task.state', (e) => {
    const p = e.payload as { taskId?: unknown; to?: unknown };
    if (typeof p.taskId !== 'string') return;
    const to = typeof p.to === 'string' ? p.to : '';
    if (to === 'done' || to === 'failed' || to === 'cancelled') state.delete(p.taskId);
  });

  deps.log(
    `[progress] 过程可视化已启用（每 ${cfg.everyNSteps} 步 / 至少隔 ${Math.round(cfg.minIntervalMs / 1000)} 秒）`,
  );

  return () => {
    unsubscribe();
    unsubscribeDone();
  };
}