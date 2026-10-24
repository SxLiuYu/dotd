/**
 * src/surfaces/task-summary.ts —— L1：一个任务"现在怎么样"的一行摘要（M2，2026-10-23）。
 *
 * 为什么单独一层
 *   `task-view.ts` 回答的是工程师的问题：花了多少 token、每一步多久、卡在哪一步。
 *   主人打开界面时问的是另外三个问题：**它在干嘛、多久了、要不要我出手**。
 *   这两组问题共用同一批事实（tasks / steps / plan），但口径不同；
 *   混在一个投影里会让两边都写不清，所以这里只做"人话那一层"。
 *
 * 三条纪律
 *   1. **不编 ETA。** 没有计划就没有"还剩几步"；只有当前步、已用时、心跳年龄。
 *   2. **不把"没记录"说成"没进展"。** 刚建的任务没有 step，就如实说"还没有第一步记录"。
 *   3. **沉默要能被解释。** 在途步会让心跳静止；这时说"这一步已进行 X 分钟"，
 *      而不是按心跳年龄喊"卡住了"——后者是误报（看门狗的老盲区，见 README「已知限制」）。
 */

import type { Plan } from '../runner/plan.ts';
import type { Step, Task } from '../shared/contracts.ts';
import { humanizeTool } from './progress.ts';

/** 与 CP 的看门狗阈值同值（`src/control-plane/types.ts` 的 heartbeatTimeoutMs）。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 180_000;
/** 单个在途步超过这个时长且心跳也停了，才提示"可能卡住"（避免 200s 长命令误报）。 */
export const LONG_STEP_MS = 10 * 60_000;

export interface TaskSummary {
  /** 原样带出任务状态，方便调用方做分支（running / awaiting_approval / …）。 */
  state: string;
  /** 界面/飞书直接显示的那一句。 */
  stateLine: string;
  /** 当前在做的动作（人话）；没有工具步时为 null。 */
  doing: string | null;
  /** 从第一步开始算的已用时；queued 为 null。 */
  elapsedMs: number | null;
  /** 距上次心跳多久；没有心跳记录为 null。 */
  heartbeatAgeMs: number | null;
  /** 心跳停了、且没有正在进行的步骤（或该步已超长时间）。 */
  stalled: boolean;
  /** 计划里的下一步（没有计划 = null；不猜）。 */
  next: string | null;
  /** 现在是否必须主人出手（审批 / 暂停）。 */
  needsOwner: boolean;
  /** 计划进度；没有计划为 null。 */
  progress: { done: number; total: number } | null;
}

export interface TaskSummaryInput {
  task: Task;
  steps: Step[];
  /** P2-2 计划（`DOTD_PLAN` 关闭时恒为 null）。 */
  plan?: Plan | null;
  /** `task_results.summary`（终态时才有）。 */
  resultSummary?: string | null;
  now: number;
  heartbeatTimeoutMs?: number;
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function nextFromPlan(plan: Plan | null | undefined): string | null {
  if (plan === null || plan === undefined) return null;
  const doing = plan.items.find((i) => i.status === 'doing');
  if (doing !== undefined) return doing.text;
  const todo = plan.items.find((i) => i.status === 'todo');
  return todo?.text ?? null;
}

/**
 * 纯投影：任务 + 步骤 + 计划 → 一行摘要。
 */
export function buildTaskSummary(input: TaskSummaryInput): TaskSummary {
  const { task, now } = input;
  const timeout = input.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const steps = [...input.steps].sort((a, b) => a.seq - b.seq);
  const inFlight = steps.find((s) => s.finishedAt === null);
  const last = steps.length > 0 ? steps[steps.length - 1]! : null;
  const lastTool = inFlight !== null && inFlight !== undefined
    ? inFlight
    : [...steps].reverse().find((s) => s.toolName !== null) ?? null;

  const firstStartedAt = steps.length > 0 ? steps[0]!.startedAt : null;
  const elapsedMs =
    task.status === 'queued' || firstStartedAt === null ? null : Math.max(0, now - firstStartedAt);
  const heartbeatAgeMs = task.lastHeartbeatAt === null ? null : Math.max(0, now - task.lastHeartbeatAt);
  const longStep = inFlight !== undefined && inFlight !== null && now - inFlight.startedAt > LONG_STEP_MS;
  const stalled =
    task.status === 'running' &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs > timeout &&
    (inFlight === undefined || inFlight === null || longStep);

  const doing = lastTool === null ? null : humanizeTool(lastTool.toolName);
  const next = nextFromPlan(input.plan);
  const progress =
    input.plan === undefined || input.plan === null
      ? null
      : {
          done: input.plan.items.filter((i) => i.status === 'done').length,
          total: input.plan.items.length,
        };

  let stateLine: string;
  let needsOwner = false;

  switch (task.status) {
    case 'queued':
      stateLine = '排队中，还没开始';
      break;
    case 'running': {
      if (stalled) {
        stateLine = `心跳已停 ${heartbeatAgeMs === null ? '未知时长' : fmtDuration(heartbeatAgeMs)}，可能卡住`;
      } else if (inFlight !== undefined && inFlight !== null) {
        const verb = inFlight.kind === 'llm' ? '在思考' : humanizeTool(inFlight.toolName);
        stateLine = `正在：${verb}（这一步已 ${fmtDuration(now - inFlight.startedAt)}）`;
      } else if (last !== null) {
        const verb = last.kind === 'llm' ? '在思考' : humanizeTool(last.toolName);
        stateLine = `正在：${verb}（第 ${steps.length} 步）`;
      } else {
        stateLine = '已开始，还没有第一步记录';
      }
      if (elapsedMs !== null && !stalled) stateLine += `，已跑 ${fmtDuration(elapsedMs)}`;
      break;
    }
    case 'awaiting_approval':
      needsOwner = true;
      stateLine =
        doing === null
          ? '停在一项需要你确认的动作上'
          : `停在审批：${doing}（你确认后从这里继续）`;
      break;
    case 'paused':
      needsOwner = true;
      stateLine =
        task.stopReason === null ? '暂停中' : `暂停中（${task.stopReason}）`;
      break;
    case 'done':
      stateLine = input.resultSummary !== null && input.resultSummary !== undefined && input.resultSummary.length > 0
        ? `已办完：${clip(input.resultSummary, 60)}`
        : '已办完';
      break;
    case 'failed':
      stateLine = input.resultSummary !== null && input.resultSummary !== undefined && input.resultSummary.length > 0
        ? `没办成：${clip(input.resultSummary, 60)}`
        : task.stopReason === null
          ? '没办成（原因见任务详情）'
          : `没办成（${task.stopReason}）`;
      break;
    case 'cancelled':
      stateLine = '已取消';
      break;
    default:
      stateLine = `状态：${task.status}`;
  }

  return {
    state: task.status,
    stateLine,
    doing,
    elapsedMs,
    heartbeatAgeMs,
    stalled,
    next,
    needsOwner,
    progress,
  };
}
