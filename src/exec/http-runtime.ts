/**
 * src/exec/http-runtime.ts —— 真实 docker 路径的 RuntimeClient（EX §5.2 端点表）。
 *
 * 背景（审码 finding：真实 docker 路径下 runTool/pollJob/cancelTool/fsOps 全部因
 * "运行时客户端未装配"失败）：stub 形态的 StubRuntime 不是唯一实现。本文件用 Node 内置
 * `fetch` 按 §5.2 端点表逐个实现，`ExecServiceImpl` 在 fleet='docker' 时默认装配它
 * （也可由 daemon 装配层显式注入覆盖）。
 *
 * 部署形态 = 宿主 daemon 与容器同在 WSL bridge 网内：HTTP over 容器 IP:9223 + Bearer token
 * （EX §2.1-3）。端点逐字对应 src/exec/protocol.ts 的 RUNTIME_PATHS。
 *
 * 错误约定：网络失败/非 2xx 一律抛 Error（调用方 Fleet.reconcileOpenCalls /
 * ExecService.pollJob 已按"抛错 → healthcheck 探测 → unhealthy/中断"处理）；
 * 协议级失败（404/409 等）由容器侧以 ToolResult{status:'error'} 的 2xx 响应返回，
 * 不在此处转换。
 */

import type { Capability, ExecToolCall, ExecToolResult } from '../shared/contracts.ts';
import {
  RUNTIME_PATHS,
  bearerHeader,
} from './protocol.ts';
import type { FsOpsRequest, FsOpsResponse, RuntimeClient } from './types.ts';

export interface HttpRuntimeOptions {
  /** 单次请求超时 ms（默认 10s；慢端点由调用方的 deadline 语义兜底）。 */
  timeoutMs?: number;
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** §5.2 端点表的 HTTP 实现（Bearer 鉴权，POST/GET 均 JSON）。 */
export class HttpRuntime implements RuntimeClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpRuntimeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(
    endpoint: string,
    token: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${endpoint}${path}`, {
        method,
        headers: {
          authorization: bearerHeader(token),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${path} → HTTP ${res.status}${text.length > 0 ? `：${text.slice(0, 200)}` : ''}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(endpoint: string, token: string): Promise<{
    state: 'ok';
    version: string;
    uptime: number;
    mem_used_mb: number;
    token_epoch: number;
  }> {
    return await this.req(endpoint, token, 'GET', RUNTIME_PATHS.healthz);
  }

  async callSync(endpoint: string, token: string, call: ExecToolCall): Promise<ExecToolResult> {
    // 请求体必须逐字对齐容器侧 parseToolCall 的必填集（protocol.ts:437-446）：
    // task_id/dot_id/issued_at 漏发会被容器 400 拒（真实容器实测；stub 进程内
    // 传对象不过序列化，所以此前测不出）。
    return this.req<ExecToolResult>(endpoint, token, 'POST', RUNTIME_PATHS.toolsCall, {
      call_id: call.call_id,
      task_id: call.task_id,
      dot_id: call.dot_id,
      tool: call.tool,
      args: call.args,
      deadline_ms: call.deadline_ms,
      issued_at: call.issued_at,
      ...(call.identity === undefined ? {} : { identity: call.identity }),
    });
  }

  async startJob(endpoint: string, token: string, call: ExecToolCall): Promise<{ job_id: string }> {
    return this.req<{ job_id: string }>(endpoint, token, 'POST', RUNTIME_PATHS.jobsStart, {
      call_id: call.call_id,
      task_id: call.task_id,
      dot_id: call.dot_id,
      tool: call.tool,
      args: call.args,
      deadline_ms: call.deadline_ms,
      issued_at: call.issued_at,
      ...(call.identity === undefined ? {} : { identity: call.identity }),
    });
  }

  async getJob(endpoint: string, token: string, jobId: string): Promise<ExecToolResult> {
    // 容器 /jobs/{id} 用的是 job 形状（state: running|done|error|...），
    // 契约 ExecToolResult 用 status。不转换的话 pollJob 读到 undefined，
    // undefined !== 'running' 被当成终态直接返回 → settle 落 else 分支
    // failCall('error')（WSL 实测 2026-10-16：shell.run/browser.* 全部
    // 209ms 内失败，而同一 job 手动轮询明明 done + exit_code 0）。
    const raw = await this.req<Record<string, unknown>>(endpoint, token, 'GET', RUNTIME_PATHS.job(jobId));
    return jobToToolResult(raw, jobId);
  }

  async getCall(endpoint: string, token: string, callId: string): Promise<ExecToolResult> {
    const raw = await this.req<Record<string, unknown>>(endpoint, token, 'GET', RUNTIME_PATHS.call(callId));
    return jobToToolResult(raw, callId);
  }

  async confirmCall(endpoint: string, token: string, callId: string): Promise<boolean> {
    // §5.4-4：压缩的唯一准入条件。容器无此端点（旧版本）时 404 不当错误。
    try {
      await this.req<unknown>(endpoint, token, 'POST', RUNTIME_PATHS.callConfirm(callId), {});
      return true;
    } catch {
      return false;
    }
  }

  async compactLedger(endpoint: string, token: string): Promise<string[]> {
    // §8：state 卷 64MB 上限 / §5.4-4 超 5000 行。容器无此端点回空数组。
    try {
      const res = await this.req<{ compacted?: unknown }>(endpoint, token, 'POST', RUNTIME_PATHS.ledgerCompact, {});
      return Array.isArray(res.compacted) ? (res.compacted as string[]) : [];
    } catch {
      return [];
    }
  }

  async cancelJob(endpoint: string, token: string, jobId: string): Promise<void> {
    await this.req<unknown>(endpoint, token, 'POST', RUNTIME_PATHS.jobCancel(jobId), {});
  }

  async deleteJobs(endpoint: string, token: string): Promise<void> {
    await this.req<unknown>(endpoint, token, 'DELETE', RUNTIME_PATHS.jobs);
  }

  async capabilities(endpoint: string, token: string): Promise<Capability[]> {
    const res = await this.req<{ capabilities?: unknown }>(endpoint, token, 'GET', RUNTIME_PATHS.capabilities);
    // 容器既可能回 {capabilities:[...]} 也可能直接回数组（契约 J2 未定死外壳）
    if (Array.isArray(res)) return res as Capability[];
    return Array.isArray(res.capabilities) ? (res.capabilities as Capability[]) : [];
  }

  async fsOps(endpoint: string, token: string, req: FsOpsRequest): Promise<FsOpsResponse> {
    return await this.req<FsOpsResponse>(endpoint, token, 'POST', RUNTIME_PATHS.fsOps, req);
  }
}

/**
 * 容器 job 响应 → 契约 ExecToolResult（字段名归一）。
 *
 * 容器侧（agent-runtime /jobs/{id}）形状：
 *   {job_id, call_id, state: 'running'|'done'|'error'|'cancelled'|'timeout'|…,
 *    result?: {exit_code,stdout,…}, error?: {code,message,retryable},
 *    events?: […], finished_at?}
 * 契约侧（shared/contracts.ts ExecToolResult）形状：
 *   {call_id, job_id?, status: 'ok'|'error'|'cancelled'|'running', result?, error?, usage?, finished_at?}
 *
 * 映射：done→ok、error/timeout/failed→error、cancelled→cancelled、其余→running。
 * 已是契约形状（带 status）的响应原样返回，兼容容器升级后的双形状。
 */
export function jobToToolResult(raw: Record<string, unknown>, jobId: string): ExecToolResult {
  const callId = typeof raw['call_id'] === 'string' ? raw['call_id'] : '';
  const job = typeof raw['job_id'] === 'string' ? raw['job_id'] : jobId;
  const finishedAt = typeof raw['finished_at'] === 'string' ? raw['finished_at'] : undefined;

  // 已是契约形状（容器新版直接给 status）：只补 job_id 兜底
  if (typeof raw['status'] === 'string') {
    const out = { ...(raw as unknown as ExecToolResult) };
    if (out.job_id === undefined) out.job_id = job;
    return out;
  }

  const state = typeof raw['state'] === 'string' ? raw['state'] : 'unknown';
  const errRaw = raw['error'];
  const err =
    errRaw !== null && typeof errRaw === 'object'
      ? (errRaw as { code?: unknown; message?: unknown; retryable?: unknown })
      : undefined;

  if (state === 'done') {
    return { call_id: callId, job_id: job, status: 'ok', result: raw['result'], finished_at: finishedAt };
  }
  if (state === 'cancelled') {
    return { call_id: callId, job_id: job, status: 'cancelled', finished_at: finishedAt };
  }
  if (state === 'running') {
    return { call_id: callId, job_id: job, status: 'running' };
  }
  // error / timeout / failed / 未知 → error（容器 job 的 error 形状与契约一致）
  return {
    call_id: callId,
    job_id: job,
    status: 'error',
    error: {
      // err 缺失（容器只给 state 没给 error 对象）时 code 回落为 state 名，
      // 绝不返回 undefined——调用方按 code 分派重试策略。
      code: err !== undefined && typeof err.code === 'string' ? err.code : state,
      message: err !== undefined && typeof err.message === 'string' ? err.message : `job ${state}`,
      retryable: err?.retryable === true,
    },
    finished_at: finishedAt,
  };
}
