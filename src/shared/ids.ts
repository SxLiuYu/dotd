/**
 * src/shared/ids.ts —— 全系统 id 前缀生成器（唯一权威）。
 *
 * 依据（逐字，禁止各模块自行拼前缀）：
 * - 契约 §9：步身份 = `call_id`（ULID）→ newCallId
 * - CP §3.1 tasks DDL 注释：`'tk_'+base36 时间序+rand；事件任务='tk_ev_'+events.id`
 * - 契约 E2/H1：crontabs `'ct_'+nanoid`
 * - 契约 §9：Dot 占位 `dot1`（阶段一唯一；无 dots 表）
 * - EX §5.3：exec_calls/ledger 幂等键 = call_id（与 callId 同一函数）
 * - MR §6.2：非 journal 上下文的模型调用 attemptId = `'nonj:'+ULID`
 */

import { ulid } from './ulid.ts';

/** 契约 §9：步身份 / call_id / attempts / journal_step 一律 ULID。 */
export function newCallId(): string {
  return ulid();
}

/**
 * 非 journal 上下文的模型调用 attemptId（契约 J1）：
 * CP 事件匹配、GOV precheck/postReview、MEM 摘要投递的即时调用。
 * 同一次逻辑调用重试时不变（调用方自己缓存），此处只负责首次生成。
 */
export function newNonJournalAttemptId(): string {
  return `nonj:${ulid()}`;
}

/** 任务 id：`'tk_'+base36 时间序+rand`（CP §3.1 DDL 注释）。 */
export function newTaskId(): string {
  return `tk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 事件派生任务 id：`'tk_ev_'+events.id`（CP §6.1 确定性派生）。
 * 崩溃重放到同一 event 行 → 撞 tasks.id PK → 事务回滚，绝不双建。
 */
export function eventTaskId(eventId: number): string {
  return `tk_ev_${eventId}`;
}

/** 心跳定时 id：`'ct_'+nanoid`（契约 H1 crontabs DDL 注释）。 */
export function newCrontabId(): string {
  return `ct_${ulid()}`;
}

/** 阶段一唯一 Dot 占位（契约 §9：作废 main；无 dots 表）。 */
export const DEFAULT_DOT_ID = 'dot1';

/** 会话/线程 id：`mem_threads.id`，阶段一用 `th_`+ULID（MEM §5.3 由记忆模块生成）。 */
export function newThreadId(): string {
  return `th_${ulid()}`;
}

/** 从 call_id 取毫秒时间戳（审计展示用，避免各模块重复解析）。 */
export { ulidTime as callIdTime, isUlid as isCallId } from './ulid.ts';
