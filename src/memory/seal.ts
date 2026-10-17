/**
 * src/memory/seal.ts —— 任务结束写入收口（WRITE-SEAL，§4.3）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/memory.md）：
 * ```ts
 * async function sealTask(task: Task, outcome: 'done'|'failed'|'cancelled', reason?: string) {
 *   insertSystemMessage(task.threadId, { kind: 'task_end', outcome, stopReason: reason });
 *   UPDATE mem_threads SET last_task_finished_at = now() WHERE id = task.threadId;  // §6.1 封存锚点
 *   if (outcome === 'done') touchManualsLastUsed(task.newManualIds);
 *   const wroteMemory = await anyMemoryFileTouchedSince(task.startedAt);
 *   if (!wroteMemory) {
 *     if (outcome === 'done') {
 *       injectOnce(task, "若本次有可复用经验，现在写 notes/ 或更新 manuals/，否则回复 SKIP");
 *     }
 *     // failed/cancelled：不追加提醒轮（止损优先），只记 memory_missed=1 供复盘
 *     markMemoryMissed(task.id);
 *   }
 * }
 * ```
 * - §4.3 头注：三种终态全走（rev2）。
 * - §4.3 下半：对控制面的硬要求 S2'——finish()、watchdog 失联回收、背压 kill、
 *   优雅关停等所有使任务进入 failed/cancelled 的收口点都必须调 sealTask。
 *   （接缝契约 M3 裁定：接受；control-plane.md:574 需补。）
 * - §8 错误约定：软线以返回值/落库降级表达，记忆问题不炸主循环。
 *
 * 实现注记：
 * - `anyMemoryFileTouchedSince` 的真源是控制面 journal（steps 表，契约 D4 别人表只读
 *   服务接口），因此经 deps.journalMemoryProbe 注入；无探针时退化为"查不到 = 未写"
 *   （软线语义，宁可多提醒一轮也不谎报已写）。
 * - `markMemoryMissed` 落 mem_maintenance_state（MEM 自有 kv 表，契约 D3），供 §6.3
 *   复盘与 status() 汇总。
 */

import type { SealTaskInput } from './types.ts';

/** §4.3：一次提醒的文案（写死，避免每轮花样导致模型无视）。 */
export const SEAL_REMINDER_TEXT =
  '若本次有可复用经验，现在写 notes/ 或更新 manuals/，否则回复 SKIP';

export interface SealHost {
  appendSystemMessage(
    threadId: string,
    msg: { kind: 'task_end' | 'system_error' | 'text'; content: string; taskId?: string },
  ): Promise<{ id: string; seq: number }>;
  /** UPDATE mem_threads SET last_task_finished_at=now（§6.1 锚点）。 */
  touchThreadFinished(threadId: string, at: number): void;
  /** §4.3 touchManualsLastUsed：刷新 manuals 的 last_used（fs.stat 经桥）。 */
  touchManuals(dotId: string, paths: string[]): Promise<void>;
  /** §4.3 anyMemoryFileTouchedSince：命中 /dot/home 规范路径的步。 */
  probeMemoryWrites(taskId: string, sinceMs: number): Promise<string[]>;
  /** markMemoryMissed(task.id) → mem_maintenance_state。 */
  markMissed(taskId: string, outcome: string, at: number): void;
  /** injectOnce 的一次性判定（同 task 已提醒过则不再提醒）。 */
  hasReminded(taskId: string): boolean;
  markReminded(taskId: string, at: number): void;
}

/**
 * §4.3 sealTask。任何分支都不抛（记忆问题不炸主循环，§8）；
 * 唯一允许的失败是 threadId 缺失——那意味着控制面没建/绑 thread，
 * 记 violation 后返回（S2' 漏调的另一半）。
 */
export async function sealTask(
  host: SealHost,
  task: SealTaskInput,
  outcome: 'done' | 'failed' | 'cancelled',
  stopReason?: string,
): Promise<void> {
  const threadId = task.threadId ?? task.sessionId;
  if (threadId === null || threadId === undefined) {
    // 无法定位 thread：记漏调并返回（控制面侧问题，不炸主循环）
    // at 必须是真实时钟：这个值进 mem_maintenance_state 的 updated_at，
    // at=0 会让 §6.3 复盘的"最近一次漏调"永远看起来发生在 1970 年，
    // 污染观测字段（此前写 0 的实测见 tests/memory-seal.test.ts）。
    host.markMissed(task.id, `no_thread:${outcome}`, task.updatedAt > 0 ? task.updatedAt : Date.now());
    return;
  }
  const now = task.updatedAt > 0 ? task.updatedAt : Date.now();

  await host.appendSystemMessage(threadId, {
    kind: 'task_end',
    taskId: task.id,
    content: JSON.stringify({ outcome, stopReason: stopReason ?? null, taskId: task.id, at: now }),
  });
  host.touchThreadFinished(threadId, now);

  if (outcome === 'done') {
    await host.touchManuals(task.dotId, task.newManualIds ?? []);
  }

  const wrote = (await host.probeMemoryWrites(task.id, task.createdAt)).length > 0;
  if (!wrote) {
    // P1-4（2026-10-18）：这里**不再**追加"提醒"。
    //
    // 老实现走到这里会 appendSystemMessage(SEAL_REMINDER_TEXT)，但 sealTask 由 CP 的
    // 钩子在 queue.finish() **内部**调用——那一刻任务已是终态、Runner 主循环已退出，
    // 不会有任何一轮 LLM 去读这条消息。于是"补写一轮"从未发生，那条提醒只会在
    // 下次同 thread 的任务里当历史噪音出现（= 假提醒）。
    //
    // 现在把"要不要补写"的判定提前到 Runner 收口之前（MemoryService.needsMemoryRedo），
    // 补写轮由 Runner 真的跑一次；这里只做**收口记账**（单一分支，不连写两笔）：
    //   - done 且**从未被提醒过** → 记 'seal_missed'：观测面表明"该提醒却没提醒"，
    //     说明补写轮没跑（装配漏注入 / memoryRedo 关闭 / 判定探针缺失）；
    //   - 其余（done 但已提醒过 = 模型回了 SKIP；以及 failed/cancelled 止损）→ 记 outcome。
    const neverReminded = outcome === 'done' && !host.hasReminded(task.id);
    host.markMissed(task.id, neverReminded ? 'seal_missed' : outcome, now);
  }
}

/**
 * §4.3 `anyMemoryFileTouchedSince` 的路径判据：步记录命中 /dot/home 的规范路径。
 * journal 步里存的是容器绝对路径或 home 相对路径（工具层两种都可能出现），
 * 因此同时认 `/dot/home/` 前缀与规范相对路径前缀。
 *
 * 注：真实实现是 MemoryService 内的 `isMemoryWritePathLoose`（sealHost 装配处
 * `paths.filter(isMemoryWritePathLoose)`）。这里曾有一份零调用者的等价导出副本，
 * 会造成两处语义漂移风险，已删；判据变更请只改 MemoryService 那一处。
 */
