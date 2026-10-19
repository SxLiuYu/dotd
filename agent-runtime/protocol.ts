/**
 * agent-runtime/protocol.ts —— 宿主↔容器工具调用协议（**镜像内副本**，监听侧权威）。
 *
 * 来源（逐字可溯）：
 * - docs/design/modules/execution.md §5.2 端点总表、§5.3 请求/响应类型、
 *   §5.4 幂等 ledger 与中断语义、§10 Capability
 * - docs/design/自主Dot系统设计方案.md §5（执行面核心决策 7/8）
 * - docs/design/modules/接缝契约.md S4'（POST /fs/ops 桥）、J2（Capability.sideEffect）、
 *   G1（顶层 ToolCall.identity）、T5（容器内工具不得直连模型）
 *
 * **为什么是"副本"而不是直接 import 仓库 src**：
 *   镜像构建只 `COPY agent-runtime/ /opt/agent-runtime/`（execution.md §3.1），
 *   容器内不存在 `src/`。宿主侧的同名协议归 `src/exec/protocol.ts`（EX 模块），
 *   本文件必须与它逐字同形。防漂移由 `tests/agent-runtime-protocol.test.ts`
 *   的**双向类型赋值断言**保证（ contracts.ts ↔ 本文件 ），运行期再用
 *   `assertProtocolDrift()` 比对键集合。
 *
 * 术语（契约 §9）：步身份 = `call_id`（ULID，宿主 journal 生成）；agent-runtime
 * **不生成** call_id，因此不需要 ulid 包。
 */

// ═══════════════════════════════════════════════════════════════════
// §1 工具词表（契约 M5 / EX §5.3：11 名，与 config/tools.yml 逐字一致）
// ═══════════════════════════════════════════════════════════════════

export type ToolName =
  | 'fs.read'
  | 'fs.write'
  | 'fs.list'
  | 'fs.stat'
  | 'fs.remove'
  | 'shell.run'
  | 'browser.open'
  | 'browser.act'
  | 'browser.snapshot'
  | 'browser.close'
  | 'net.get'
  | 'net.post'
  | 'tool.list'
  | 'tool.create'
  | 'tool.invoke';

export const TOOL_NAMES: readonly ToolName[] = [
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.stat',
  'fs.remove',
  'shell.run',
  'browser.open',
  'browser.act',
  'browser.snapshot',
  'browser.close',
  'net.get',
  'net.post',
  // S2（2026-10-19）：自造工具
  'tool.list',
  'tool.create',
  'tool.invoke',
];

/** EX §5.2：派发端点判据，由工具属性声明，不由时长猜测。 */
export type ToolMode = 'sync' | 'async';

/** 契约 J2 / §9：副作用档（journal 崩溃恢复分流唯一依据；未声明按 unknown）。 */
export type SideEffect = 'safe' | 'replayable' | 'unknown';

// ═══════════════════════════════════════════════════════════════════
// §2 请求/响应（EX §5.3 逐字）
// ═══════════════════════════════════════════════════════════════════

export interface ToolCall {
  /** ULID，调用方（控制面 journal）生成，全局唯一，幂等键。 */
  call_id: string;
  /** 对账/审计透传，容器不理解其语义。 */
  task_id: string;
  dot_id: string;
  /**
   * 契约 G1：浏览器类工具必填的 profile 身份键（**顶层字段**，
   * 不存在 args.with_identity）。'anon'/null = 非登录态（ephemeral context）；
   * 缺失 = fail-closed 按登录态（治理侧谓词 isLoginSensitive）。
   */
  identity?: string;
  tool: ToolName;
  args: Record<string, unknown>;
  /** 硬超时（毫秒），容器端强制。 */
  deadline_ms: number;
  /** ISO8601。 */
  issued_at: string;
}

export type ToolResultStatus = 'ok' | 'error' | 'cancelled' | 'running';

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ToolUsage {
  wall_ms: number;
  peak_mem_mb: number;
}

export interface ToolResult {
  call_id: string;
  /** async 调用回执携带；ExecService 落 exec_calls.job_id（对账/取消键）。 */
  job_id?: string;
  status: ToolResultStatus;
  /** 工具自定义 JSON（fs.read 含 content_base64，上限 4MB）。 */
  result?: unknown;
  error?: ToolError;
  usage?: ToolUsage;
  finished_at?: string;
}

// ═══════════════════════════════════════════════════════════════════
// §3 能力目录（EX §5.2 /capabilities + §10 Capability + 契约 J2）
// ═══════════════════════════════════════════════════════════════════

export interface Capability {
  name: string;
  mode: ToolMode;
  max_deadline_ms: number;
  /** JSON Schema；治理建权限映射、审批卡片渲染用。 */
  args_schema: object;
  sideEffect: SideEffect;
}

/**
 * sync 工具的 deadline 硬上限（EX §5.2 末段）：agent-runtime 对 sync 工具强制
 * `deadline_ms ≤ 60_000`，超限在 `/tools/call` 直接返回
 * `error{code:'deadline_too_long_for_sync'}`。
 */
export const SYNC_MAX_DEADLINE_MS = 60_000;

/** fs.* 的物理兜底（EX §7 / 契约 M6：更严者生效）。 */
export const FS_READ_MAX_BYTES = 4 * 1024 * 1024;
export const FS_WRITE_MAX_BYTES = 8 * 1024 * 1024;
export const FS_LIST_MAX_DEPTH = 4;

/** shell.run 输出各截 1MB（EX §5.5/§7）。 */
export const SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * 能力目录（agent-runtime 侧权威表；宿主 ExecService.getCapabilities 必须同形，
 * 否则派发端点选择会错位——见 tests 的防漂移断言）。
 *
 * mode 归属依据（EX §5.2 末段判据句）：「fs 工具 catalog 里 mode='sync'
 * （fs.read ≤4MB 本地读，60s 足够），shell/browser 为 'async'」。
 * 即 fs.* = sync，其余（shell/browser/net）= async。
 *
 * sideEffect（契约 J2）**与宿主 src/exec/protocol.ts 的 CAPABILITY_CATALOG 逐字一致**
 * （tests/agent-runtime-protocol.test.ts「防漂移」用例逐项比对 name/mode/sideEffect）：
 * - fs.read/fs.list/fs.stat = safe；fs.write = replayable
 * - browser.open/browser.act = unknown（点击/导航有外部副作用，不可静态判定为可重放；
 *   这与 CP §5.1 分类表一致：`safe` 例子里只列 navigate/snapshot，click 提交归 unknown）
 * - browser.snapshot/browser.close = safe
 * - shell.run = unknown（任意命令）；net.get = safe；net.post = unknown（对外 POST）
 *
 * max_deadline_ms：sync 恒 60s（SYNC_MAX_DEADLINE_MS）；async 与宿主同值
 * （shell/browser.* = 30min，net.* 与 browser.close = 60s）。
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    name: 'fs.read',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  },
  {
    name: 'fs.write',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        content_base64: { type: 'string' },
      },
      additionalProperties: false,
    },
    sideEffect: 'replayable',
  },
  {
    name: 'fs.list',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 }, depth: { type: 'integer', minimum: 1, maximum: FS_LIST_MAX_DEPTH } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  },
  {
    name: 'fs.stat',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  },
  {
    name: 'fs.remove',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    name: 'shell.run',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: {
      type: 'object',
      required: ['cmd', 'timeout_ms'],
      properties: {
        cmd: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 1 },
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    name: 'browser.open',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    name: 'browser.act',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'wait', 'press', 'select', 'scroll'] },
        selector: { type: 'string' },
        value: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    name: 'browser.snapshot',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffect: 'safe',
  },
  {
    name: 'browser.close',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffect: 'safe',
  },
  {
    name: 'net.get',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', minLength: 1 }, headers: { type: 'object' } },
      additionalProperties: false,
    },
    sideEffect: 'safe',
  },
  {
    name: 'net.post',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        headers: { type: 'object' },
      },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    /**
     * 自造工具（S2，2026-10-19）：让 dotd 把写过的脚本沉淀成可复用工具。
     *
     * 三个都是 sync：
     *  - tool.list 只读目录
     *  - tool.create 写文件 + chmod（受宿主 30s deadline 约束）
     *  - tool.invoke 起子进程跑脚本（受宿主 60s deadline 约束）
     */
    name: 'tool.list',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: { type: 'object', required: [], properties: {}, additionalProperties: false },
    sideEffect: 'safe',
  },
  {
    name: 'tool.create',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['name', 'description', 'script'],
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 40 },
        description: { type: 'string', minLength: 1 },
        script: { type: 'string', minLength: 1 },
        entry: { type: 'string' },
        params: { type: 'object' },
        returns: { type: 'string' },
      },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
  {
    name: 'tool.invoke',
    mode: 'sync',
    max_deadline_ms: SYNC_MAX_DEADLINE_MS,
    args_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        args: { type: 'object' },
      },
      additionalProperties: false,
    },
    sideEffect: 'unknown',
  },
];

/** 按工具名取能力项（未登记 = 词表外，治理侧一律 deny）。 */
export function capabilityOf(name: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}

export function isToolName(x: unknown): x is ToolName {
  return typeof x === 'string' && (TOOL_NAMES as readonly string[]).includes(x);
}

// ═══════════════════════════════════════════════════════════════════
// §4 机读错误码（EX §5.4 / §5.2 / §6.2 点名 + 容器内新增）
// ═══════════════════════════════════════════════════════════════════

export const ERROR_CODES = {
  /** EX §5.2：sync 工具 deadline > 60s。 */
  deadline_too_long_for_sync: 'deadline_too_long_for_sync',
  /** EX §5.4-3：ledger 里该项为 aborted（进程重启清理所得）。 */
  interrupted: 'interrupted',
  /** EX §5.4-4：done 但已被压缩（确认幂等成功、结果不可取回）。 */
  result_compacted: 'result_compacted',
  /** EX §6.2：chromium 进程退出。 */
  browser_crashed: 'browser_crashed',
  /** 本文件新增：同 call_id 但 args_hash 不同（防 call_id 复用撞车）。 */
  call_id_reuse_mismatch: 'call_id_reuse_mismatch',
  /**
   * fs.write 的乐观并发控制失败：文件在读取之后被改过（expected_size 不符）。
   * 2026-10-18：实测并发 RMW 会丢 9/10 的更新，加 CAS 后由模型重读重试。
   */
  stale_write: 'stale_write',
  /**
   * 用空内容覆盖非空文件被拒（2026-10-18 实测事故：模型把 MEMORY.md 写成空串，
   * 一千多字记忆被清成 0 字节且返回 succeeded）。
   */
  empty_overwrite: 'empty_overwrite',
  /** 本文件新增：能力目录缺失该工具名。 */
  unknown_tool: 'unknown_tool',
  /** 本文件新增：把 sync 工具发去 /jobs/start（或反之）。 */
  wrong_endpoint_for_mode: 'wrong_endpoint_for_mode',
  /** 本文件新增：job_id 不存在或已清理。 */
  job_not_found: 'job_not_found',
  /** 本文件新增：协议层字段缺失/类型错。 */
  bad_request: 'bad_request',
  /** 本文件新增：鉴权失败。 */
  unauthorized: 'unauthorized',
  /** 本文件新增：HTTP 路径无对应端点。 */
  not_found: 'not_found',
  /** 本文件新增：超时（deadline 到，已协作式取消）。 */
  deadline_exceeded: 'deadline_exceeded',
  /** 本文件新增：stage-2 才实现的工具（net.*）。 */
  not_implemented: 'not_implemented',
  /**
   * 本文件新增：browser.* 缺顶层 identity（契约 G1 缺失即 fail-closed，
   * 绝不落到最弱的 ephemeral 匿名档）。宿主侧 GOV 按登录态送审，
   * 容器侧直接拒绝执行。
   */
  identity_required: 'identity_required',
  /** 本文件新增：单 context 并发页面超 MAX_PAGES_PER_CTX（EX §6.1）。 */
  too_many_pages: 'too_many_pages',
  /**
   * EX §7：home 路径护栏。
   * **码名与宿主 src/exec/protocol.ts checkHomePath 逐字一致**（path_outside_home /
   * path_hidden / symlink_escape / bad_path）：宿主 fsOps 桥与 stub-runtime 直接透传
   * 这些码，容器侧若用别名，宿主侧按 code 分流的地方会失配。
   */
  path_outside_home: 'path_outside_home',
  path_hidden: 'path_hidden',
  symlink_escape: 'symlink_escape',
  bad_path: 'bad_path',
  not_a_file: 'not_a_file',
  not_a_directory: 'not_a_directory',
  too_large: 'too_large',
  /** fs.list 深度超限（宿主 stub 侧同码名）。 */
  too_deep: 'too_deep',
  /** EX §7：shell 参数/执行失败。 */
  bad_args: 'bad_args',
  shell_failed: 'shell_failed',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 协议层错误（解析/校验失败）。跨模块只认 code 字段（CONVENTIONS §6）。 */
export class ProtocolError extends Error {
  readonly code: string;
  constructor(message: string, code: string = ERROR_CODES.bad_request) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

// ═══════════════════════════════════════════════════════════════════
// §5 编解码（纯函数，测试直接打）
// ═══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ProtocolError(`字段 ${field} 必须是非空字符串`, ERROR_CODES.bad_request);
  }
  return v;
}

function requireFiniteNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ProtocolError(`字段 ${field} 必须是正数`, ERROR_CODES.bad_request);
  }
  return v;
}

/**
 * 解析 ToolCall（HTTP body → 协议对象）。
 * 故意**不做** args 的 JSON Schema 校验：args_schema 归治理/宿主侧，
 * 容器侧只保证形状可派发；工内部自行做参数校验并回 bad_args。
 */
export function parseToolCall(input: unknown): ToolCall {
  if (!isPlainObject(input)) {
    throw new ProtocolError('ToolCall 必须是 JSON object', ERROR_CODES.bad_request);
  }
  const tool = input.tool;
  if (!isToolName(tool)) {
    throw new ProtocolError(
      `tool 必须是 11 名工具词表之一（收到 ${JSON.stringify(tool)}）`,
      ERROR_CODES.unknown_tool,
    );
  }
  const args = input.args;
  if (!isPlainObject(args)) {
    throw new ProtocolError('args 必须是 JSON object', ERROR_CODES.bad_request);
  }
  const identity = input.identity;
  if (identity !== undefined && typeof identity !== 'string') {
    throw new ProtocolError('identity 必须是字符串（契约 G1 顶层字段）', ERROR_CODES.bad_request);
  }
  /**
   * 契约 G1：identity 缺失（undefined）且工具为 browser.* → **fail-closed**。
   * 缺省一律当 'anon'（非登录态 ephemeral）会打开 fail-open 面，与契约
   * 「缺失视为 true（按登录态）」相反；此处显式拒绝，由 dispatch 之前的
   * 协议解析层挡下。fs.* 与 shell.* 不受影响（无 identity 概念）。
   */
  if (identity === undefined && tool.startsWith('browser.')) {
    throw new ProtocolError(
      `browser.${tool.slice('browser.'.length)} 缺顶层 identity：契约 G1 缺失即 fail-closed 按登录态，不降级为匿名档`,
      ERROR_CODES.identity_required,
    );
  }
  return {
    call_id: requireString(input.call_id, 'call_id'),
    task_id: requireString(input.task_id, 'task_id'),
    dot_id: requireString(input.dot_id, 'dot_id'),
    ...(identity !== undefined ? { identity } : {}),
    tool,
    args,
    deadline_ms: requireFiniteNumber(input.deadline_ms, 'deadline_ms'),
    issued_at: requireString(input.issued_at, 'issued_at'),
  };
}

/** 解析 ToolResult（回给宿主的对象先过一遍形状校验，防脏数据出网）。 */
export function parseToolResult(input: unknown): ToolResult {
  if (!isPlainObject(input)) {
    throw new ProtocolError('ToolResult 必须是 JSON object', ERROR_CODES.bad_request);
  }
  const status = input.status;
  if (
    status !== 'ok' &&
    status !== 'error' &&
    status !== 'cancelled' &&
    status !== 'running'
  ) {
    throw new ProtocolError(`status 非法：${JSON.stringify(status)}`, ERROR_CODES.bad_request);
  }
  const callId = requireString(input.call_id, 'call_id');
  const jobId = input.job_id;
  if (jobId !== undefined && typeof jobId !== 'string') {
    throw new ProtocolError('job_id 必须是字符串', ERROR_CODES.bad_request);
  }
  const err = input.error;
  if (err !== undefined) {
    if (!isPlainObject(err) || typeof err.code !== 'string' || typeof err.retryable !== 'boolean') {
      throw new ProtocolError('error 必须是 {code,message,retryable}', ERROR_CODES.bad_request);
    }
  }
  return {
    call_id: callId,
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    status,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(err !== undefined
      ? {
          error: {
            code: err.code as string,
            message: typeof err.message === 'string' ? err.message : '',
            retryable: err.retryable as boolean,
          },
        }
      : {}),
    ...(input.usage !== undefined ? { usage: input.usage as ToolUsage } : {}),
    ...(input.finished_at !== undefined ? { finished_at: input.finished_at as string } : {}),
  };
}

/** 契约 S4'：POST /fs/ops 的请求体（MEM 的注入读取/索引对账/原子写/清理全靠它）。 */
export type FsOpsOp = 'read' | 'list' | 'stat' | 'rename';

export interface FsOpsRequest {
  op: FsOpsOp;
  /** home 相对路径（与 fs.* 同沙箱）。 */
  path: string;
  /** rename 的目标（home 相对路径）。 */
  target?: string;
  /** 对账透传，容器不理解。 */
  dotId?: string;
}

export function parseFsOpsRequest(input: unknown): FsOpsRequest {
  if (!isPlainObject(input)) {
    throw new ProtocolError('/fs/ops 请求体必须是 JSON object', ERROR_CODES.bad_request);
  }
  const op = input.op;
  if (op !== 'read' && op !== 'list' && op !== 'stat' && op !== 'rename') {
    throw new ProtocolError(
      `fs/ops op 必须是 read|list|stat|rename（收到 ${JSON.stringify(op)}）`,
      ERROR_CODES.bad_request,
    );
  }
  const path = requireString(input.path, 'path');
  const target = input.target;
  if (target !== undefined && typeof target !== 'string') {
    throw new ProtocolError('target 必须是字符串', ERROR_CODES.bad_request);
  }
  if (op === 'rename' && (typeof target !== 'string' || target.length === 0)) {
    throw new ProtocolError('rename 必须带 target', ERROR_CODES.bad_request);
  }
  const dotId = input.dotId;
  if (dotId !== undefined && typeof dotId !== 'string') {
    throw new ProtocolError('dotId 必须是字符串', ERROR_CODES.bad_request);
  }
  return {
    op,
    path,
    ...(target !== undefined ? { target } : {}),
    ...(dotId !== undefined ? { dotId } : {}),
  };
}

// ── 契约 S4'：/fs/ops 桥的**扁平**响应（MEM 铁律 B 的唯一读路径）────────
//
// 形状依据（宿主侧，逐字对齐）：
// - `dotd/src/shared/contracts.ts:1051` FsOpsResponse
// - `dotd/src/exec/types.ts:498` FsOpsResponse（同名同形）
// - `dotd/src/memory/fsops-client.ts:116-169` FsOpsHttpBridge：
//     read  → 读 `body.content`
//     list  → 读 `body.entries[]`，每项要 `path`/`name`/`type`/`sizeBytes`
//     stat  → 读 `body.stat ?? body`，且**必须**有 `sizeBytes`（camelCase）
//     rename→ 只判 `body.ok !== false`
// 因此**不能**复用 fs.* 的 ToolResult 嵌套形状（{ok, result:{...}}）：
// 那会让宿主 read→null / list→[] / stat→null（静默降级），见审码 issue C。
// 同时给 stub-runtime.ts:414-462 同款扁平形状，三条路径一致。

/** 契约 S4' list 条目（MEM 要 sizeBytes/mtimeMs；mtimeMs 由 ISO 换算）。 */
export interface FsOpsListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  size?: number;
  sizeBytes?: number;
  mtime?: string;
  mtimeMs?: number;
}

/** 契约 S4' stat 载荷（MEM 的 FsOpsStat 读 sizeBytes/mtimeMs/isDir）。 */
export interface FsOpsStat {
  path: string;
  type: 'file' | 'dir' | 'other';
  size?: number;
  sizeBytes: number;
  mtime?: string;
  mtimeMs: number;
  isDir: boolean;
}

/** 契约 S4' 扁平响应（宿主 MEM/ExecService 直接消费，不再包 ToolResult）。 */
export interface FsOpsResponse {
  op: FsOpsOp;
  ok: boolean;
  /** op='read'：UTF-8 文本（base64 时随 encoding 标记）。 */
  content?: string;
  encoding?: 'utf8' | 'base64';
  /** op='list'：目录项。 */
  entries?: FsOpsListEntry[];
  /** op='stat'：mtime/size。 */
  stat?: FsOpsStat;
  /** op='rename'：目标路径回显。 */
  target?: string;
  error?: { code: string; message: string };
}

/** /fs/ops 成功响应（统一出口）。 */
export function fsOpsOk(res: Omit<FsOpsResponse, 'ok'>): FsOpsResponse {
  return { ...res, ok: true };
}

/** /fs/ops 失败响应（机读 code 与 fs.* 护栏同词表，宿主按 code 分流）。 */
export function fsOpsError(op: FsOpsOp, code: string, message: string): FsOpsResponse {
  return { op, ok: false, error: { code, message } };
}

// ── 结果构造器（统一出口，避免各工具手搓形状）──────────────────────

export function okResult(
  callId: string,
  result: unknown,
  usage?: ToolUsage,
  jobId?: string,
): ToolResult {
  return {
    call_id: callId,
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    status: 'ok',
    result,
    ...(usage !== undefined ? { usage } : {}),
    finished_at: new Date().toISOString(),
  };
}

export function errorResult(
  callId: string,
  code: string,
  message: string,
  retryable: boolean,
  extra?: { job_id?: string; result?: unknown; usage?: ToolUsage },
): ToolResult {
  return {
    call_id: callId,
    ...(extra?.job_id !== undefined ? { job_id: extra.job_id } : {}),
    status: 'error',
    error: { code, message, retryable },
    ...(extra?.result !== undefined ? { result: extra.result } : {}),
    ...(extra?.usage !== undefined ? { usage: extra.usage } : {}),
    finished_at: new Date().toISOString(),
  };
}

export function runningResult(callId: string, jobId?: string): ToolResult {
  return {
    call_id: callId,
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    status: 'running',
  };
}

export function cancelledResult(callId: string, jobId?: string): ToolResult {
  return {
    call_id: callId,
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    status: 'cancelled',
    finished_at: new Date().toISOString(),
  };
}

// ── args_hash（EX §5.4 ledger 记账用：sha256(canonical(args))）────────

/**
 * 稳定序列化：对象键排序，保证同 args 跨进程同 hash。
 *
 * **与宿主 `src/exec/protocol.ts` 的 `stableStringify` 逐字同算法**（三处都必须一致，
 * 否则 ledger 的 args_hash 对不上、幂等重放会误判为 call_id_reuse_mismatch）：
 *   1. 标量走 `JSON.stringify(v) ?? 'null'`（undefined → 'null'）
 *   2. 数组按序拼接
 *   3. 对象**先滤掉 value===undefined 的键**，再按键排序
 * 第 3 条是关键：JSON.parse 不会产出 undefined 值，但宿主侧从 DB/事件里读出的
 * args 可能带显式 undefined 键；不滤就会算出不同的 hash。
 * 由 tests/agent-runtime-protocol.test.ts 的「与宿主 argsHash 同值」断言守着。
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',');
  return `{${body}}`;
}

/** sha256(canonicalJson(args)) 的 hex。 */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// §6 healthz / jobs 视图（EX §5.2 端点表的响应形状）
// ═══════════════════════════════════════════════════════════════════

/** GET /healthz（不回显 token）。 */
export interface HealthReport {
  state: 'ok';
  version: string;
  uptime_s: number;
  mem_used_mb: number;
  token_epoch: string;
}

export type JobState = 'running' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  at: string;
  kind: 'started' | 'progress' | 'stdout' | 'stderr' | 'finished';
  detail?: string;
}

/** GET /jobs/{job_id}（EX §5.2：轮询 {state, call_id, events[], result?, error?}）。 */
export interface JobView {
  job_id: string;
  call_id: string;
  state: JobState;
  events: JobEvent[];
  result?: unknown;
  error?: ToolError;
  finished_at?: string;
}
