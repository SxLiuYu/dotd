import type { ComponentType } from 'react';
import { ChatView } from './views/ChatView.tsx';
import { FeedView } from './views/FeedView.tsx';
import { QueueView } from './views/QueueView.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { ApprovalsView } from './views/ApprovalsView.tsx';
import { EventsView } from './views/EventsView.tsx';
import { ModelsView } from './views/ModelsView.tsx';
import { LogsView } from './views/LogsView.tsx';
import { ProfileView } from './views/ProfileView.tsx';

/**
 * web-ui/src/views.tsx —— 七视图登记表（surfaces.md §7 主视图集）。
 *
 * 每个视图的数据源与 http.ts 的实现逐条对齐（不是我方注释的臆测）：
 * - 聊天 Chat：POST /api/messages（http.ts:483）+ GET /api/conversations?thread=（http.ts:542）
 *   + SSE /api/stream?topics=chat（§4.5）
 * - 队列 Queue：GET /api/queue?status=<csv>（http.ts:508）+ POST /api/queue/:id/cancel（http.ts:529）
 *   + SSE topics=queue
 * - 活动 Activity（2026-10-21 新增）：GET /api/activity?limit=&status=
 *   只读、无 SSE —— 活动是已结束的事实，不会自己变（理由见 ActivityView 文件头）。
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
    id: 'feed',
    title: '动态',
    source: 'GET /api/feed?limit= → tasks/approvals/crontabs/events/日历的只读时间线；GET /api/tasks/:id 看单条摘要',
    Component: FeedView,
  },
  {
    id: 'queue',
    title: '队列',
    source: 'GET /api/queue?status=<csv> → cp.list() 投影；POST /api/queue/:id/cancel；SSE topics=queue',
    Component: QueueView,
  },
  {
    id: 'activity',
    title: '活动',
    source: 'GET /api/activity?limit=&status= → tasks + 全库状态计数（只读，无 SSE）',
    Component: ActivityView,
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
  {
    id: 'profile',
    title: '人格',
    source: 'GET /api/memory/identity · PUT /api/memory/identity → /dot/home/IDENTITY.md（≤1 KB，每轮任务注入）',
    Component: ProfileView,
  },
];

/** 供 App.tsx 的顶栏复用同一份数据源说明。 */
export function sourceOf(id: string): string {
  return VIEWS.find((v) => v.id === id)?.source ?? '';
}
