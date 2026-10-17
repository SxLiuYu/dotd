/**
 * src/memory/rows.ts —— node:sqlite 行对象 ↔ TS 投影的桥。
 *
 * 背景（CONVENTIONS.md「数据库约定」）：node:sqlite 查询结果是
 * `[Object: null prototype]`（无原型对象），`JSON.stringify` 正常但不要往上挂属性；
 * 且 API 是同步的（`prepare().get()/.all()/.run()`、`exec()`），没有 async 变体。
 * 本文件只做"读列 + 判型"，不持有连接、不执行 SQL。
 */

import type {
  Message,
  MsgKind,
  MsgRole,
  Thread,
  ThreadChannel,
  ThreadStatus,
} from '../shared/contracts.ts';

export type Row = Record<string, unknown>;

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Message.taskId/eventId 在契约里是可选字段（string | undefined），不是可空。 */
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function int(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return fallback;
}

const CHANNELS: readonly ThreadChannel[] = ['web', 'telegram', 'feishu', 'cli', 'email', 'event', 'heartbeat'];
const STATUSES: readonly ThreadStatus[] = ['active', 'idle', 'sealed', 'purged'];
const ROLES: readonly MsgRole[] = ['user', 'assistant', 'system'];
const KINDS: readonly MsgKind[] = [
  'text',
  'tool_call',
  'tool_result',
  'approval_request',
  'approval_verdict',
  'task_start',
  'task_end',
  'memory_note',
  'system_error',
];

export function toChannel(v: unknown): ThreadChannel {
  const s = str(v, 'event');
  return (CHANNELS as readonly string[]).includes(s) ? (s as ThreadChannel) : 'event';
}

export function toThreadStatus(v: unknown): ThreadStatus {
  const s = str(v, 'active');
  return (STATUSES as readonly string[]).includes(s) ? (s as ThreadStatus) : 'active';
}

export function toRole(v: unknown): MsgRole {
  const s = str(v, 'system');
  return (ROLES as readonly string[]).includes(s) ? (s as MsgRole) : 'system';
}

export function toKind(v: unknown): MsgKind {
  const s = str(v, 'text');
  return (KINDS as readonly string[]).includes(s) ? (s as MsgKind) : 'text';
}

/** mem_threads 行 → Thread（列名见 db/migrations/040_memory.sql，DDL 不可改）。 */
export function toThread(r: Row): Thread {
  return {
    id: str(r.id, ''),
    dotId: str(r.dot_id, 'dot1'),
    channel: toChannel(r.channel),
    externalRef: strOrNull(r.external_ref),
    title: strOrNull(r.title),
    originTaskId: strOrNull(r.origin_task_id),
    status: toThreadStatus(r.status),
    pinned: int(r.pinned, 0) === 1,
    contextSummary: strOrNull(r.context_summary),
    contextSummaryUptoSeq: int(r.context_summary_upto_seq, 0),
    lastActiveAt: int(r.last_active_at, 0),
    lastTaskFinishedAt: typeof r.last_task_finished_at === 'number' ? r.last_task_finished_at : null,
    createdAt: int(r.created_at, 0),
  };
}

/** mem_messages 行 → Message。 */
export function toMessage(r: Row): Message {
  return {
    id: str(r.id, ''),
    threadId: str(r.thread_id, ''),
    seq: int(r.seq, 0),
    role: toRole(r.role),
    kind: toKind(r.kind),
    content: str(r.content, ''),
    taskId: strOrUndef(r.task_id),
    eventId: strOrUndef(r.event_id),
    tokenEst: int(r.token_est, 0),
    createdAt: int(r.created_at, 0),
  };
}
