/**
 * src/exec/stub-runtime.ts —— DOTD_FLEET=stub 的假容器运行时。
 *
 * 本机此刻无 docker（任务说明 + CONVENTIONS.md §7），因此本文件用内存实现**完整保留**：
 *  - §5.2 端点表语义（healthz / tools/call / jobs/start / jobs/{id} / calls/{id} /
 *    jobs/{id}/cancel / DELETE /jobs / capabilities / fs/ops）
 *  - §5.4 幂等 ledger：append-only JSONL 的内存等价物；`state=='doing'` 的项在
 *    "进程重启"时改标 aborted、`done` 项原样保留（recreate 后可重放，绝不二次执行）
 *  - §7 硬护栏：home 路径约束、.dotd 隐藏前缀、体积上限、目录深度
 *  - fs.* / shell.run / browser.* 的最小语义（browser 只做结构仿真，不起 chromium）
 *
 * 真实 dockerode/docker CLI 路径按文档写（fleet.ts createDockerBackend），但全部经
 * cfg.fleet === 'stub' 门控：stub 模式下**不加载 dockerode、不起子进程、不发 HTTP**。
 */

import { createHash } from 'node:crypto';
import type { Capability, ExecToolCall, ExecToolResult } from '../shared/contracts.ts';
import type {
  ContainerBackend,
  ExecConfig,
  FsOpsRequest,
  FsOpsResponse,
  RuntimeClient,
} from './types.ts';
import {
  CAPABILITY_CATALOG,
  FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
  HOME_ROOT,
  LEDGER_COMPACT_THRESHOLD,
  checkHomePath,
  dispatchModeFor,
  identityHash,
  normalizeAbs,
} from './protocol.ts';
import type { LedgerRecord } from './protocol.ts';

export interface StubRuntimeOptions {
  /** 预置 ledger 记录（测试"recreate 后 done 可重放"场景）。 */
  seedLedger?: LedgerRecord[];
  /** 预置 home 文件系统（path → content；仅 /dot/home 下有效）。 */
  seedFiles?: Record<string, string>;
  /** 工具处理器（未提供时用内置最小语义）。 */
  handlers?: Partial<Record<string, (call: ExecToolCall, ctx: StubCtx) => ExecToolResult | Promise<ExecToolResult>>>;
  /** shell.run 的假输出。 */
  shellOutput?: string;
  /** healthz 是否可用（默认 true）。 */
  healthOk?: boolean;
  /** 容器运行时版本（healthz.version）。 */
  version?: string;
}

export interface StubCtx {
  files: Map<string, string>;
  /** 每个 identity 的浏览器"页面"状态（browser.* 仿真）。 */
  pages: Map<string, { url: string; contexts: number }>;
  ledger: Map<string, LedgerRecord>;
  tokenEpoch: number;
  startedAt: number;
}

export class StubRuntime implements RuntimeClient {
  readonly ledger: Map<string, LedgerRecord>;
  private readonly files: Map<string, string>;
  private readonly pages = new Map<string, { url: string; contexts: number }>();
  private readonly opts: StubRuntimeOptions;
  private readonly cfg: ExecConfig;
  private readonly backend: ContainerBackend;
  private readonly jobs = new Map<string, { call: ExecToolResult; state: 'doing' | 'done' }>();
  private healthOk: boolean;
  private epoch = 1;

  constructor(o: { cfg: ExecConfig; backend: ContainerBackend; opts?: StubRuntimeOptions }) {
    this.cfg = o.cfg;
    this.backend = o.backend;
    this.opts = o.opts ?? {};
    this.healthOk = this.opts.healthOk ?? true;
    this.files = new Map(Object.entries(this.opts.seedFiles ?? {}));
    this.ledger = new Map((this.opts.seedLedger ?? []).map((r) => [r.call_id, r]));
  }

  ctx(): StubCtx {
    return {
      files: this.files,
      pages: this.pages,
      ledger: this.ledger,
      tokenEpoch: this.epoch,
      startedAt: Date.now(),
    };
  }

  /** "进程重启"：doing → aborted；done 原样保留（§5.4-1）。 */
  simulateRestart(): void {
    for (const rec of this.ledger.values()) {
      if (rec.state === 'doing') {
        this.ledger.set(rec.call_id, { ...rec, state: 'aborted' });
      }
    }
    this.epoch += 1;
    this.jobs.clear();
  }

  /** token 轮换后的世代号（healthz.token_epoch）。 */
  tokenEpoch(): number {
    return this.epoch;
  }

  // ── §5.2 端点实现 ────────────────────────────────────────────────

  async health(
    _endpoint: string,
    _token: string,
  ): Promise<{ state: 'ok'; version: string; uptime: number; mem_used_mb: number; token_epoch: number }> {
    if (!this.healthOk) throw new Error('stub: healthz 不可用');
    return {
      state: 'ok',
      version: this.opts.version ?? `agent-runtime-${this.cfg.runtimeVer}`,
      uptime: Math.round((Date.now() - Date.now()) / 1000),
      mem_used_mb: 128,
      token_epoch: this.epoch,
    };
  }

  async callSync(_endpoint: string, _token: string, call: ExecToolCall): Promise<ExecToolResult> {
    return this.handleCall(call);
  }

  async startJob(_endpoint: string, _token: string, call: ExecToolCall): Promise<{ job_id: string }> {
    const jobId = `job_${call.call_id}`;
    // §5.4：doing 即入账（异步工具的 ledger 在派发时就有了 doing 项）
    const rec = this.ledger.get(call.call_id);
    if (rec === undefined) {
      this.ledger.set(call.call_id, {
        call_id: call.call_id,
        state: 'doing',
        tool: call.tool,
        args_hash: hashOf(call.args),
        started_at: new Date().toISOString(),
        job_id: jobId,
      });
    }
    this.jobs.set(jobId, {
      state: 'doing',
      call: { call_id: call.call_id, job_id: jobId, status: 'running' },
    });
    // 立即"跑完"（内存实现无真实异步），落 done 供轮询读到终态
    const result = await this.execute(call);
    this.ledger.set(call.call_id, {
      call_id: call.call_id,
      state: result.status === 'ok' ? 'done' : result.status === 'cancelled' ? 'aborted' : 'aborted',
      tool: call.tool,
      args_hash: hashOf(call.args),
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      result_json: result.status === 'ok' ? JSON.stringify(result.result ?? {}) : undefined,
      job_id: jobId,
    });
    this.jobs.set(jobId, { state: 'done', call: { ...result, job_id: jobId } });
    return { job_id: jobId };
  }

  async getJob(_endpoint: string, _token: string, jobId: string): Promise<ExecToolResult> {
    const j = this.jobs.get(jobId);
    if (j === undefined) {
      return {
        call_id: '',
        job_id: jobId,
        status: 'error',
        error: { code: 'job_not_found', message: `job ${jobId} 不存在（可能已被 DELETE /jobs 清理）`, retryable: false },
      };
    }
    return j.call;
  }

  /** GET /calls/{call_id}：读 ledger 的 done 项重放 result（§5.2/§5.4）。 */
  async getCall(_endpoint: string, _token: string, callId: string): Promise<ExecToolResult> {
    const rec = this.ledger.get(callId);
    if (rec === undefined) {
      return {
        call_id: callId,
        status: 'error',
        error: { code: 'not_found', message: `ledger 无 ${callId}`, retryable: false },
      };
    }
    if (rec.state === 'done') {
      return {
        call_id: callId,
        job_id: rec.job_id,
        status: 'ok',
        result: safeParse(rec.result_json),
        finished_at: rec.finished_at,
      };
    }
    if (rec.state === 'compacted') {
      return {
        call_id: callId,
        status: 'error',
        error: { code: 'result_compacted', message: '结果已压缩', retryable: false },
        result: { hash: rec.result_hash },
      };
    }
    if (rec.state === 'aborted') {
      return {
        call_id: callId,
        status: 'error',
        error: { code: 'interrupted', message: '该调用未完成被打断', retryable: true },
      };
    }
    return { call_id: callId, job_id: rec.job_id, status: 'running' };
  }

  async cancelJob(_endpoint: string, _token: string, jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j === undefined) return;
    this.jobs.set(jobId, { state: 'done', call: { ...j.call, status: 'cancelled' } });
  }

  /**
   * EX §5.4-4：宿主确认位（压缩的唯一准入条件）。
   * stub 的内存 ledger 直接打 confirmed 标记；真实路径由容器侧 markConfirmed 落盘。
   */
  async confirmCall(_endpoint: string, _token: string, callId: string): Promise<boolean> {
    const rec = this.ledger.get(callId);
    if (rec === undefined || rec.state !== 'done') return false;
    this.ledger.set(callId, { ...rec, confirmed: true });
    return true;
  }

  /**
   * EX §8 / §5.4-4：触发压缩。stub 侧按 LEDGER_COMPACT_THRESHOLD 与 confirmed 判据
   * 做同语义瘦身（result_json → result_hash，state 'done' → 'compacted'）。
   * 返回被压缩的 call_id 列表。
   */
  async compactLedger(_endpoint: string, _token: string): Promise<string[]> {
    if (this.ledger.size < LEDGER_COMPACT_THRESHOLD) return [];
    const compacted: string[] = [];
    for (const [id, rec] of this.ledger) {
      if (rec.state !== 'done') continue;
      if (rec.confirmed !== true) continue; // 未确认 → 永不压缩（先确认、后瘦身）
      if (rec.result_json === undefined) continue;
      const hash = createHash('sha256').update(rec.result_json, 'utf8').digest('hex');
      this.ledger.set(id, {
        ...rec,
        state: 'compacted',
        result_hash: hash,
        compacted: true,
        result_json: undefined,
      });
      compacted.push(id);
    }
    return compacted;
  }

  async deleteJobs(_endpoint: string, _token: string): Promise<void> {
    this.jobs.clear();
  }

  async capabilities(_endpoint: string, _token: string): Promise<Capability[]> {
    return [...CAPABILITY_CATALOG];
  }

  async fsOps(_endpoint: string, _token: string, req: FsOpsRequest): Promise<FsOpsResponse> {
    return this.handleFsOps(req);
  }

  // ── 内部：handleCall（§5.4 伪码） ───────────────────────────────

  private async handleCall(call: ExecToolCall): Promise<ExecToolResult> {
    const rec = this.ledger.get(call.call_id);
    if (rec !== undefined) {
      if (rec.state === 'done') {
        return {
          call_id: call.call_id,
          job_id: rec.job_id,
          status: 'ok',
          result: safeParse(rec.result_json),
          finished_at: rec.finished_at,
        };
      }
      if (rec.state === 'doing') {
        return { call_id: call.call_id, job_id: rec.job_id, status: 'running' };
      }
      if (rec.state === 'aborted') {
        return {
          call_id: call.call_id,
          status: 'error',
          error: { code: 'interrupted', message: '上次运行被打断（未完成）', retryable: true },
        };
      }
      if (rec.state === 'compacted') {
        return {
          call_id: call.call_id,
          status: 'error',
          error: { code: 'result_compacted', message: '结果已压缩', retryable: false },
          result: { hash: rec.result_hash },
        };
      }
    }
    const result = await this.execute(call);
    if (result.status === 'ok') {
      this.ledger.set(call.call_id, {
        call_id: call.call_id,
        state: 'done',
        tool: call.tool,
        args_hash: hashOf(call.args),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        result_json: JSON.stringify(result.result ?? {}),
      });
    }
    return result;
  }

  /** 工具体执行（内存语义）。 */
  private async execute(call: ExecToolCall): Promise<ExecToolResult> {
    const started = Date.now();
    const done = (result: unknown, status: 'ok' = 'ok'): ExecToolResult => ({
      call_id: call.call_id,
      status,
      result,
      usage: { wall_ms: Date.now() - started, peak_mem_mb: 64 },
      finished_at: new Date().toISOString(),
    });
    const fail = (code: string, message: string, retryable = false): ExecToolResult => ({
      call_id: call.call_id,
      status: 'error',
      error: { code, message, retryable },
      usage: { wall_ms: Date.now() - started, peak_mem_mb: 8 },
      finished_at: new Date().toISOString(),
    });

    const handler = this.opts.handlers?.[call.tool];
    if (handler !== undefined) return handler(call, this.ctx());

    switch (call.tool) {
      case 'tool.list': {
        // 能力目录（CAPABILITY_CATALOG）里登记了 tool.list，stub 就必须能应答：
        // 2026-10-23 Docker 验收里每个语音任务留下 14 次 unknown_tool，
        // 因为 runner 的工具清单注入每轮都会查一次。镜像模拟没有 tools 目录，
        // 所以答案是「没有自造工具」，而不是报错。
        return done({ tools: [] });
      }
      case 'fs.read': {
        const p = this.resolve(call.args.path);
        if (p === null) return fail(this.resolveErr(call.args.path), `路径不被允许：${String(call.args.path)}`);
        const content = this.files.get(p);
        if (content === undefined) return fail('not_found', `文件不存在：${p}`, true);
        const buf = Buffer.from(content, 'utf8');
        if (buf.byteLength > FS_READ_MAX_BYTES) {
          return fail('too_large', `fs.read 上限 ${FS_READ_MAX_BYTES} 字节`, false);
        }
        return done({ path: p, content, encoding: 'utf8', size: buf.byteLength });
      }
      case 'fs.write': {
        const p = this.resolve(call.args.path);
        if (p === null) return fail(this.resolveErr(call.args.path), `路径不被允许：${String(call.args.path)}`);
        const content = call.args.content;
        if (typeof content !== 'string') return fail('bad_args', 'content 必须为字符串');
        if (Buffer.byteLength(content, 'utf8') > FS_WRITE_MAX_BYTES) {
          return fail('too_large', `fs.write 上限 ${FS_WRITE_MAX_BYTES} 字节`, false);
        }
        this.files.set(p, content);
        return done({ path: p, size: Buffer.byteLength(content, 'utf8') });
      }
      case 'fs.list': {
        const p = this.resolve(call.args.path);
        if (p === null) return fail(this.resolveErr(call.args.path), `路径不被允许：${String(call.args.path)}`);
        const depth = typeof call.args.depth === 'number' ? call.args.depth : 1;
        if (depth > FS_LIST_MAX_DEPTH) return fail('too_deep', `fs.list 深度上限 ${FS_LIST_MAX_DEPTH}`, false);
        const prefix = p === HOME_ROOT ? `${HOME_ROOT}/` : `${p}/`;
        const entries: Array<{ name: string; type: 'file'; size: number }> = [];
        for (const [k, v] of this.files) {
          if (!k.startsWith(prefix)) continue;
          const rel = k.slice(prefix.length);
          if (rel.length === 0) continue;
          if (depth === 1 && rel.includes('/')) continue;
          entries.push({ name: rel, type: 'file', size: Buffer.byteLength(v, 'utf8') });
        }
        return done({ path: p, entries });
      }
      case 'fs.stat': {
        const p = this.resolve(call.args.path);
        if (p === null) return fail(this.resolveErr(call.args.path), `路径不被允许：${String(call.args.path)}`);
        const content = this.files.get(p);
        if (content === undefined) return fail('not_found', `不存在：${p}`, true);
        return done({ path: p, size: Buffer.byteLength(content, 'utf8'), mtime: new Date().toISOString() });
      }
      case 'shell.run': {
        const cmd = call.args.cmd;
        if (typeof cmd !== 'string') return fail('bad_args', 'cmd 必须为字符串');
        if (typeof call.args.timeout_ms !== 'number') {
          return fail('bad_args', 'timeout_ms 必填（§7：超时必填）');
        }
        if (call.args.timeout_ms > call.deadline_ms) {
          return fail('timeout_gt_deadline', 'args.timeout_ms 必须 ≤ deadline_ms');
        }
        return done({
          cmd,
          cwd: HOME_ROOT,
          stdout: this.opts.shellOutput ?? `$ ${cmd}\n(stub) ok\n`,
          stderr: '',
          exit_code: 0,
          truncated: false,
        });
      }
      case 'browser.open': {
        const identity = call.identity ?? 'anon';
        const url = call.args.url;
        if (typeof url !== 'string') return fail('bad_args', 'url 必须为字符串');
        const page = this.pages.get(identity) ?? { url: '', contexts: 0 };
        page.url = url;
        page.contexts += 1;
        this.pages.set(identity, page);
        return done({
          identity,
          url,
          persistent: identity !== 'anon',
          profile_dir: `/dot/profiles/${identityHash(identity, this.cfg.profileHashChars)}`,
        });
      }
      case 'browser.act': {
        const identity = call.identity ?? 'anon';
        const page = this.pages.get(identity);
        if (page === undefined) return fail('no_page', '该 identity 无打开的页面（先 browser.open）', true);
        return done({ identity, action: call.args.action, url: page.url, ok: true });
      }
      case 'browser.snapshot': {
        const identity = call.identity ?? 'anon';
        const page = this.pages.get(identity);
        return done({
          identity,
          url: page?.url ?? null,
          tree: page === undefined ? [] : [{ role: 'document', name: page.url, children: [] }],
        });
      }
      case 'browser.close': {
        const identity = call.identity ?? 'anon';
        this.pages.delete(identity);
        return done({ identity, closed: true });
      }
      case 'net.get': {
        const url = call.args.url;
        if (typeof url !== 'string') return fail('bad_args', 'url 必须为字符串');
        return done({ url, status: 200, body: '' });
      }
      case 'net.post': {
        const url = call.args.url;
        if (typeof url !== 'string') return fail('bad_args', 'url 必须为字符串');
        return done({ url, status: 200, body: '' });
      }
      default:
        return fail('unknown_tool', `未知工具 ${String(call.tool)}`, false);
    }
  }

  /** 契约 S4'/M4：/fs/ops（宿主 token 专用；与 fs.* 同沙箱）。 */
  private handleFsOps(req: FsOpsRequest): FsOpsResponse {
    const p = this.resolve(req.path);
    if (p === null) {
      return { op: req.op, ok: false, error: { code: 'path_outside_home', message: `路径越界：${req.path}` } };
    }
    switch (req.op) {
      case 'read': {
        const content = this.files.get(p);
        if (content === undefined) {
          return { op: 'read', ok: false, error: { code: 'not_found', message: `不存在：${p}` } };
        }
        return { op: 'read', ok: true, content, encoding: 'utf8' };
      }
      case 'list': {
        const prefix = p === HOME_ROOT ? `${HOME_ROOT}/` : `${p}/`;
        const entries: NonNullable<FsOpsResponse['entries']> = [];
        for (const [k, v] of this.files) {
          if (!k.startsWith(prefix)) continue;
          const rel = k.slice(prefix.length);
          if (rel.length === 0 || rel.includes('/')) continue;
          const size = Buffer.byteLength(v, 'utf8');
          // 与容器侧 fs.ts:378-387 同形状：size/sizeBytes、mtime/mtimeMs 双写
          entries.push({
            name: rel,
            path: `${req.path === HOME_ROOT ? '' : req.path}/${rel}`,
            type: 'file',
            size,
            sizeBytes: size,
          });
        }
        return { op: 'list', ok: true, entries };
      }
      case 'stat': {
        const content = this.files.get(p);
        if (content === undefined) {
          return { op: 'stat', ok: false, error: { code: 'not_found', message: `不存在：${p}` } };
        }
        const size = Buffer.byteLength(content, 'utf8');
        // 嵌套 stat（MEM 的 fsops-client.stat 读 stat.sizeBytes/mtimeMs/isDir）
        return {
          op: 'stat',
          ok: true,
          stat: { path: req.path, type: 'file', size, sizeBytes: size, isDir: false },
        };
      }
      case 'rename': {
        if (req.target === undefined) {
          return { op: 'rename', ok: false, error: { code: 'bad_target', message: '缺少 target' } };
        }
        const t = this.resolve(req.target);
        if (t === null) {
          return { op: 'rename', ok: false, error: { code: 'path_outside_home', message: `target 越界：${req.target}` } };
        }
        const content = this.files.get(p);
        if (content === undefined) {
          return { op: 'rename', ok: false, error: { code: 'not_found', message: `不存在：${p}` } };
        }
        this.files.delete(p);
        this.files.set(t, content);
        return { op: 'rename', ok: true, target: t };
      }
    }
  }

  /** 路径归一 + 护栏（与宿主侧 checkHomePath 同规则，双查）。 */
  private resolve(path: unknown): string | null {
    const chk = checkHomePath(path);
    if (!chk.ok) return null;
    return normalizeAbs(path as string);
  }

  /** 路径被拒时的具体码（path_outside_home / path_hidden / bad_path），供错误回传。 */
  private resolveErr(path: unknown): string {
    const chk = checkHomePath(path);
    if (chk.ok) return 'bad_path';
    return chk.code ?? 'path_outside_home';
  }

  /** 派发端点判据（测试断言 mode 与 catalog 一致）。 */
  modeOf(tool: string): 'sync' | 'async' | null {
    return dispatchModeFor(tool);
  }

  /** 关闭 healthz（测试 unhealthy 路径）。 */
  setHealthOk(v: boolean): void {
    this.healthOk = v;
  }

  /** 访问后端（测试改 docker 侧实况）。 */
  rawBackend(): ContainerBackend {
    return this.backend;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════════════

export function createStubRuntime(o: {
  cfg: ExecConfig;
  backend: ContainerBackend;
  opts?: StubRuntimeOptions;
}): StubRuntime {
  return new StubRuntime(o);
}

function hashOf(args: Record<string, unknown>): string {
  return createHash('sha256').update(stable(args), 'utf8').digest('hex');
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stable(x)).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(',')}}`;
}

function safeParse(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { raw: json };
  }
}
