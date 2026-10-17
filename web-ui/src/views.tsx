import type { ComponentType } from 'react';
import { ChatView } from './views/ChatView.tsx';
import { QueueView } from './views/QueueView.tsx';
import { ApprovalsView } from './views/ApprovalsView.tsx';
import { EventsView } from './views/EventsView.tsx';
import { ModelsView } from './views/ModelsView.tsx';
import { LogsView } from './views/LogsView.tsx';

/**
 * web-ui/src/views.tsx —— 六视图登记表（surfaces.md §7 主视图集）。
 *
 * 每个视图的数据源与 http.ts 的实现逐条对齐（不是我方注释的臆测）：
 * - 聊天 Chat：POST /api/messages（http.ts:483）+ GET /api/conversations?thread=（http.ts:542）
 *   + SSE /api/stream?topics=chat（§4.5）
 * - 队列 Queue：GET /api/queue?status=<csv>（http.ts:508）+ POST /api/queue/:id/cancel（http.ts:529）
 *   + SSE topics=queue
 * - 审批 Approvals：GET /api/approvals?state=pending（http.ts:557）
 *   + POST /api/approvals/:id/decision（http.ts:587；verdict ∈ approve_once|approve_remember|reject）
 *   + SSE topics=approval
 * - 事件 Events：GET /api/events?since=（http.ts:613；keyset 分页，received_at 排序）
 * - 模型 Models：GET /api/models/rank（http.ts:646）+ GET /api/breaker（http.ts:643）
 *   + SSE topics=breaker
 * - 日志 Logs：SSE /api/stream?topics=log（bus.ts TOPICS 归 log 通道的全部 topic）
 *
 * SSE 断线重连（§4.5）：Last-Event-ID = bus_seq 由 EventSource 原生维持；
 * 超出重放窗 → 服务端先发 resync 帧，各视图收到后重拉对应 REST 快照校正
 * （log 通道无 REST 快照，LogsView 只如实提示丢帧，不假装连续）。
 */
export interface ViewDef {
  id: string;
  title: string;
  /** 数据源说明（与 http.ts 对齐；给后续维护者的接续指引）。 */
  source: string;
  Component: ComponentType;
}

export const VIEWS: ViewDef[] = [
  {
    id: 'chat',
    title: '聊天',
    source: 'POST /api/messages → cp.submit(priority 1)；GET /api/conversations?thread=；SSE topics=chat',
    Component: ChatView,
  },
  {
    id: 'queue',
    title: '队列',
    source: 'GET /api/queue?status=<csv> → cp.list() 投影；POST /api/queue/:id/cancel；SSE topics=queue',
    Component: QueueView,
  },
  {
    id: 'approvals',
    title: '审批',
    source: 'GET /api/approvals?state=pending → gov.listPending()；POST /api/approvals/:id/decision；SSE topics=approval',
    Component: ApprovalsView,
  },
  {
    id: 'events',
    title: '事件',
    source: 'GET /api/events?since= → CP events 表 keyset 分页（received_at 排序）',
    Component: EventsView,
  },
  {
    id: 'models',
    title: '模型',
    source: 'GET /api/models/rank · GET /api/breaker → ModelRouter.snapshot()；SSE topics=breaker',
    Component: ModelsView,
  },
  {
    id: 'logs',
    title: '日志',
    source: 'SSE /api/stream?topics=log；游标 bus_seq（Last-Event-ID 重连）',
    Component: LogsView,
  },
];

/** 供 App.tsx 的顶栏复用同一份数据源说明。 */
export function sourceOf(id: string): string {
  return VIEWS.find((v) => v.id === id)?.source ?? '';
}
