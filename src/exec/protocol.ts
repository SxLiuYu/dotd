/**
 * src/exec/protocol.ts —— 宿主 ↔ 容器工具调用协议（execution.md §5）。
 *
 * 本文件承载**宿主侧**的协议要素，且与容器内 agent-runtime 共用同一套常量与编解码：
 *  - §5.2 端点总表（healthz / tools/call / jobs/* / calls/{id} / capabilities / fs/ops）
 *  - §5.3 请求/响应类型（TS 权威在 src/shared/contracts.ts，本文件做校验与默认值）
 *  - §5.4 幂等 ledger 的**宿主侧镜像**语义（args_hash / result_hash / 重放判定）
 *  - §5.1 认证（Bearer token；token 明文只存 bind 文件，库内只存 sha256）
 *  - sync/async 派发判据（§5.2：工具属性决定，不看时长）+ deadline 上限
 *  - §7 硬护栏（home 路径约束、体积上限、目录深度）——这些是 exec 无条件强制的
 *    最后防线（契约 S2：不受审批影响）
 *  - 契约 S4'/M4：`POST /fs/ops` 桥
 *
 * 注意：本文件不含任何 Docker/网络调用（那在 fleet.ts），可在测试里单独跑。
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  Capability,
  ExecToolCall,
  ExecToolResult,
  ToolName,
} from '../shared/contracts.ts';
import { isLoginSensitive } from '../shared/contracts.ts';
import type { ExecConfig } from './types.ts';

// ═══════════════════════════════════════════════════════════════════
// §5.1 认证
// ═══════════════════════════════════════════════════════════════════

/** token 长度 32 字节（EX §5.1）。 */
export const TOKEN_BYTES = 32;

/** 生成 32 字节随机 token（hex）。明文只写 bind 文件，不落 SQLite。 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * token 的库内投影（EX §5.1）：daemon 把 SHA-256 存 containers.token_hash，
 * 明文只存 `/var/lib/dotd/tokens/<dot_id>.token`（bind mount 只读进容器）。
 */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `Authorization: Bearer <token>` 头。 */
export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}

// ═══════════════════════════════════════════════════════════════════
// §5.2 端点总表（agent-runtime 监听 0.0.0.0:9223）
// ═══════════════════════════════════════════════════════════════════

export const RUNTIME_PATHS = {
  healthz: '/healthz',
  toolsCall: '/tools/call',
  jobsStart: '/jobs/start',
  job: (jobId: string): string => `/jobs/${encodeURIComponent(jobId)}`,
  jobCancel: (jobId: string): string => `/jobs/${encodeURIComponent(jobId)}/cancel`,
  jobs: '/jobs',
  call: (callId: string): string => `/calls/${encodeURIComponent(callId)}`,
  callConfirm: (callId: string): string => `/calls/${encodeURIComponent(callId)}/confirm`,
  ledgerCompact: '/ledger/compact',
  capabilities: '/capabilities',
  fsOps: '/fs/ops',
} as const;

/** 拼 endpoint：`http://<ip>:9223`（EX §2.1-3：HTTP over bridge 网容器 IP）。 */
export function endpointUrl(ip: string, port: number): string {
  return `http://${ip}:${port}`;
}

// ═══════════════════════════════════════════════════════════════════
// §5.2 能力目录（CapabilityCatalog）
// ═══════════════════════════════════════════════════════════════════

/** JSON Schema 的最小形状（args_schema）。 */
export type JsonSchema = Record<string, unknown>;

const str = (desc: string): JsonSchema => ({ type: 'string', description: desc });
const obj = (props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

/**
 * 阶段一能力目录（EX §5.2/§7 + 契约 M5 十一名词表）。
 *
 * mode 判据 = 工具属性，不由时长猜测（§5.2）：fs.* 为 sync；shell/browser/net 为 async。
 * sideEffect（契约 J2）是 journal 崩溃恢复分流的唯一依据，未声明按 unknown。
 */
export const CAPABILITY_CATALOG: readonly Capability[] = [
  {
    name: 'fs.read',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: obj({ path: str('绝对路径，必须位于 /dot/home/ 下') }, ['path']),
    sideEffect: 'safe',
  },
  {
    name: 'fs.write',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: obj(
      {
        path: str('绝对路径，必须位于 /dot/home/ 下'),
        content: str('UTF-8 文本'),
        /**
         * 乐观并发控制（2026-10-18）：读-改-写的场景传上 fs.read 看到的 size_bytes。
         * 若文件在此期间被别人改过，写入会被拒（stale_write），模型重新读一遍即可。
         *
         * 为什么需要：实测 10 个并发 RMW 进程写同一文件，最终只剩 2 行（丢 9 行）——
         * 后写的直接覆盖先写的。模型"读 MEMORY.md → 改 → 写回"正是这个模式。
         */
        expected_size: { type: 'integer', minimum: 0 },
      },
      ['path', 'content'],
    ),
    sideEffect: 'replayable',
  },
  {
    name: 'fs.list',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: obj({ path: str('目录绝对路径'), depth: { type: 'integer', minimum: 1, maximum: 4 } }, [
      'path',
    ]),
    sideEffect: 'safe',
  },
  {
    name: 'fs.stat',
    mode: 'sync',
    max_deadline_ms: 60_000,
    args_schema: obj({ path: str('绝对路径') }, ['path']),
    sideEffect: 'safe',
  },
  {
    name: 'fs.remove',
    mode: 'sync',
    // 与其它 fs.* 的 sync 上限对齐（SYNC_MAX_DEADLINE_MS）。
    // 2026-10-19 实测踩坑：原来写 15_000，模型按默认节奏传了更长的 deadline → deadline_too_long，
    // 删除直接失败。删除要先把内容归档再 unlink，本来就比读慢，别卡这么紧。
    max_deadline_ms: 60_000,
    args_schema: obj({ path: str('要删除的文件或空目录（home 内相对路径）') }, ['path']),
    // 删除不幂等（删第二次就是 not_a_file），但内容先进 .archive/ 可恢复，按 unknown 最保守
    sideEffect: 'unknown',
  },
  {
    name: 'shell.run',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: obj(
      {
        cmd: str('bash -c 的命令串（cwd=/dot/home）'),
        timeout_ms: { type: 'integer', minimum: 1 },
      },
      ['cmd', 'timeout_ms'],
    ),
    sideEffect: 'unknown',
  },
  {
    name: 'browser.open',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: obj({ url: str('http(s) URL') }, ['url']),
    sideEffect: 'unknown',
  },
  {
    name: 'browser.act',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: obj(
      {
        action: str('click|type|submit|wait|select|scroll'),
        selector: str('CSS selector 或 role 描述'),
        value: str('type 时的文本'),
      },
      ['action'],
    ),
    sideEffect: 'unknown',
  },
  {
    name: 'browser.snapshot',
    mode: 'async',
    max_deadline_ms: 30 * 60_000,
    args_schema: obj({ selector: str('可选：只截取某区域') }),
    sideEffect: 'safe',
  },
  {
    name: 'browser.close',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: obj({}),
    sideEffect: 'safe',
  },
  {
    // 契约 M5/§9.1 十一名词表成员；宿主侧只做目录登记（容器内实现归 EX 后续）。
    name: 'net.get',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: obj({ url: str('http(s) URL') }, ['url']),
    sideEffect: 'safe',
  },
  {
    name: 'net.post',
    mode: 'async',
    max_deadline_ms: 60_000,
    args_schema: obj({ url: str('http(s) URL'), body: str('请求体') }, ['url']),
    sideEffect: 'unknown',
  },
  {
    /**
     * 宿主侧工具（不在容器里执行）：创建定时任务。
     * 2026-10-18 对标 OpenAI bot 补齐 —— crontabs 表与调度器早就有，只缺创建入口。
     */
    name: 'schedule.create',
    mode: 'sync',
    max_deadline_ms: 10_000,
    args_schema: obj(
      {
        title: str('这条定时任务的名字，如"早间天气"'),
        prompt: str('到点要让 bot 去做的那件事（一句话任务描述）'),
        cron: str('5 段 cron：分 时 日 月 周。例：0 9 * * * = 每天 9:00；0 */2 * * * = 每两小时'),
        quiet_hours: str("安静时段，如 '23:00-07:30'；该时段内不触发（可选）"),
      },
      ['title', 'prompt', 'cron'],
    ),
    // 创建是幂等可重放的（同 title+cron 再建一条不会破坏既有数据）
    sideEffect: 'replayable',
  },
  {
    /** 宿主侧工具：列出已创建的定时任务。 */
    name: 'schedule.list',
    mode: 'sync',
    max_deadline_ms: 10_000,
    args_schema: obj({}, []),
    sideEffect: 'safe',
  },
  {
    /**
     * 宿主侧工具：停用一条定时任务（2026-10-19）。
     *
     * 为什么现在才加：主人说"把那个喝水提醒删了"，模型只能答"我删不掉，你在管理界面操作" ——
     * 因为 removeSchedule 早就实现了（还带幂等修正），但没暴露成工具。
     *
     * 语义是**停用不是硬删**（crontabs.enabled=0）：可以带 includeDisabled 查到，
     * 万一删错了还有救。所以定为 write_file 档而不是 dangerous。
     */
    name: 'schedule.remove',
    mode: 'sync',
    max_deadline_ms: 10_000,
    args_schema: obj(
      { id: str('要停用的定时任务 id（从 schedule.list 拿）') },
      ['id'],
    ),
    sideEffect: 'replayable',
  },
];

/**
 * P2-1：`mcp.call` —— 外部工具网关（**宿主侧**，不进容器）。
 *
 * 刻意**不放进 CAPABILITY_CATALOG**：那张表是 11 名契约（与 `agent-runtime/protocol.ts`
 * 逐字同形、有 40 条防漂移测试）。MCP 网关是"扩展点"，它的可用性取决于运行期配置
 * （是否声明了 server），因此由 ExecService 在 `getCapabilities()` 输出时按需附加——
 * 未声明任何 server 时，模型**看不到这个工具**，11 名契约与所有既有断言一字不变。
 *
 * 参数形状：`{ server, tool, arguments }`。
 * `sideEffect` 恒为 `'unknown'`：外部工具做什么我们不知道 → 治理按最严档处理。
 */
export const MCP_CALL_CAPABILITY: Capability = {
  name: 'mcp.call',
  mode: 'sync',
  max_deadline_ms: 60_000,
  args_schema: obj(
    {
      server: str('已声明的 MCP server 名（见工具说明里列出的可用 server）'),
      tool: str('该 server 暴露的工具名'),
      arguments: { type: 'object', description: '传给外部工具的参数对象（按其 inputSchema 填）' },
    },
    ['server', 'tool'],
  ),
  sideEffect: 'unknown',
};

/** 词表（契约 M5）：治理 tools.yml 登记名必须 ⊆ 本集合。 */
export const TOOL_NAMES: readonly ToolName[] = CAPABILITY_CATALOG.map((c) => c.name as ToolName);

const CATALOG_BY_NAME = new Map<string, Capability>(CAPABILITY_CATALOG.map((c) => [c.name, c]));

export function findCapability(name: string): Capability | null {
  // P2-1：`mcp.call` 不在 11 名契约表里（见 MCP_CALL_CAPABILITY 的注释），
  // 但宿主侧仍需走同一套参数/deadline 校验，所以在这里兜住。
  // 注意顺序：先查正式目录，保证将来若它真进契约也不会被这里遮蔽。
  return CATALOG_BY_NAME.get(name) ?? (name === 'mcp.call' ? MCP_CALL_CAPABILITY : null);
}

/** 派发端点判据（§5.2/§10）：catalog[tool].mode，不看时长。未登记工具 = deny（契约 J2 启动校验）。 */
export function dispatchModeFor(tool: string): 'sync' | 'async' | null {
  return findCapability(tool)?.mode ?? null;
}

/**
 * deadline 校验（§5.2）：sync 工具容器端强制 `deadline_ms ≤ 60_000`，超限在 /tools/call
 * 直接返回 `error{code:'deadline_too_long_for_sync'}`。宿主侧先拦一道，避免白发请求。
 */
export function checkDeadline(cfg: ExecConfig, tool: string, deadlineMs: number): ExecToolResult['error'] | null {
  const cap = findCapability(tool);
  if (cap === null) return null; // 未登记工具的拒绝由 ExecService 统一发 unknown_tool
  if (deadlineMs <= 0) {
    return { code: 'bad_deadline', message: 'deadline_ms 必须为正整数', retryable: false };
  }
  if (cap.mode === 'sync' && deadlineMs > cfg.syncDeadlineMs) {
    return {
      code: 'deadline_too_long_for_sync',
      message: `sync 工具 ${tool} 的 deadline_ms 上限为 ${cfg.syncDeadlineMs}（§5.2：工具属性决定，非时长猜测）`,
      retryable: false,
    };
  }
  const global = Math.min(cap.max_deadline_ms, cfg.asyncDeadlineMs);
  if (deadlineMs > global) {
    return {
      code: 'deadline_too_long',
      message: `工具 ${tool} 的 deadline_ms 上限为 ${global}`,
      retryable: false,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// §5.3 请求校验（宿主侧；容器端 agent-runtime 另有同源校验）
// ═══════════════════════════════════════════════════════════════════

export interface CallValidation {
  ok: boolean;
  error?: ExecToolResult['error'];
}

/** 校验一个待派发的 ToolCall。返回 null = 通过。 */
export function validateToolCall(cfg: ExecConfig, call: ExecToolCall): ExecToolResult['error'] | null {
  if (typeof call.call_id !== 'string' || call.call_id.length === 0) {
    return { code: 'bad_call', message: 'call_id 缺失或非字符串', retryable: false };
  }
  if (typeof call.dot_id !== 'string' || call.dot_id.length === 0) {
    return { code: 'bad_call', message: 'dot_id 缺失', retryable: false };
  }
  if (typeof call.task_id !== 'string' || call.task_id.length === 0) {
    return { code: 'bad_call', message: 'task_id 缺失（对账透传必填）', retryable: false };
  }
  const cap = findCapability(call.tool);
  if (cap === null) {
    return {
      code: 'unknown_tool',
      message: `工具 ${String(call.tool)} 不在能力目录内（未登记一律 deny，契约 J2）`,
      retryable: false,
    };
  }
  if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) {
    return { code: 'bad_args', message: 'args 必须为对象', retryable: false };
  }
  const dl = checkDeadline(cfg, call.tool, call.deadline_ms);
  if (dl !== null) return dl;
  // 契约 G1/S5：browser.* 工具的 identity 由顶层字段承载；exec 保证透传。
  // 缺失时的 fail-closed 判定归治理（isLoginSensitive），exec 不拒绝派发。
  if (call.tool.startsWith('browser.') && call.identity === 'anon') {
    // 'anon' = 非持久 profile，不入 exec_identities 台账（契约 G1 末段）
  }
  return null;
}

/**
 * 契约 G1 谓词的再导出（exec 侧仅用于事件/审计打标，判定权威在治理）。
 * 保留 import 以免本文件"只用类型不用值"被 tree-shake 误判；实际供 ExecService 用。
 */
export { isLoginSensitive };

// ═══════════════════════════════════════════════════════════════════
// §5.4 幂等 ledger 的宿主侧镜像（exec_calls）
// ═══════════════════════════════════════════════════════════════════

/** `args_hash = sha256(args)`（§5.4 ledger.append 的 args_hash 同算法）。 */
export function argsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(args), 'utf8').digest('hex');
}

/** `result_hash`（journal 对账用；§5.4 done 项 result_json 的摘要）。 */
export function resultHash(result: unknown): string {
  return createHash('sha256').update(stableStringify(result), 'utf8').digest('hex');
}

/** 稳定 JSON（键排序），保证同语义 args 得同 hash。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}

/** ledger 记录状态（§5.4：doing / done / aborted / compacted）。 */
export type LedgerState = 'doing' | 'done' | 'aborted' | 'compacted';

/** ledger 单行（JSONL append-only，容器内 state 卷 /opt/agent-state/ledger.jsonl）。 */
export interface LedgerRecord {
  call_id: string;
  state: LedgerState;
  tool: string;
  args_hash: string;
  started_at: string;
  finished_at?: string;
  result_json?: string;
  result_hash?: string;
  job_id?: string;
  /** 宿主确认位（§5.4-4：只有 confirmed 的 done 项才可被压缩）。 */
  confirmed?: boolean;
  /** 兼容标记（§5.4-4 原文「标记 compacted:true」；state 已改 'compacted'）。 */
  compacted?: boolean;
}

/**
 * §5.4 handleCall 的宿主侧等价实现（stub 后端的 ledger 就是内存版本函数）：
 *  - done → 直接重放 result（/jobs/{id} 与 /calls/{call_id} 同语义）
 *  - doing → 返回 status='running' + 现有 job_id（调用方继续轮询）
 *  - aborted → error{code:'interrupted', retryable:true}
 *  - compacted → error{code:'result_compacted', retryable:false, hash}（§5.4-4）
 */
export function ledgerReplay(rec: LedgerRecord | undefined): ExecToolResult | null {
  if (rec === undefined) return null;
  const base = { call_id: rec.call_id, finished_at: rec.finished_at };
  switch (rec.state) {
    case 'done':
      return {
        ...base,
        status: 'ok',
        job_id: rec.job_id,
        result: safeParse(rec.result_json),
      };
    case 'compacted':
      return {
        ...base,
        status: 'error',
        error: {
          code: 'result_compacted',
          message: '该调用已确认幂等成功，但结果已被压缩（result_hash 可对账）',
          retryable: false,
        },
        result: { hash: rec.result_hash },
      };
    case 'aborted':
      return {
        ...base,
        status: 'error',
        error: {
          code: 'interrupted',
          message: '该调用在上一次运行时被打断（未完成），按 §5.4 报 interrupted',
          retryable: true,
        },
      };
    case 'doing':
      return {
        ...base,
        status: 'running',
        job_id: rec.job_id,
      };
  }
}

function safeParse(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { raw: json };
  }
}

/** §5.4-4 压缩：超 5000 行时只压缩"已被控制面确认的 done 项"。 */
export const LEDGER_COMPACT_THRESHOLD = 5000;

// ═══════════════════════════════════════════════════════════════════
// §7 硬护栏（exec 无条件强制，契约 S2：不受审批影响）
// ═══════════════════════════════════════════════════════════════════

/** home 根（EX §7：fs.* 路径解析后必须 startsWith('/dot/home/')）。 */
export const HOME_ROOT = '/dot/home';

/**
 * home 相对路径 → `/fs/ops` 要求的绝对路径（`ExecService.fsOps` 的宿主护栏
 * `checkHomePath` 只认 `/dot/home/` 前缀）。
 *
 * 为什么要它：记忆模块的 `FsOpsBridge` 契约用 home **相对**路径（inject.ts 的
 * `readMemoryMd` 就传 `'MEMORY.md'`），而 exec 侧 `/fs/ops` 走绝对路径。两边
 * 口径差一步，缺转换时每一次记忆读取都被 `path_outside_home` 拒掉，表现为
 * buildContextBundle 恒降级 + memory_missed 每任务一条（2026-10-17 实测）。
 *
 * 幂等：已带 `/dot/home` 前缀的原样返回（容器侧两种都收，宿主护栏只认绝对）。
 */
export function toHomeAbs(p: string): string {
  const trimmed = p.replace(/^\/+/, '');
  if (p === HOME_ROOT || p.startsWith(`${HOME_ROOT}/`)) return p;
  return `${HOME_ROOT}/${trimmed}`;
}

export const FS_READ_MAX_BYTES = 4 * 1024 * 1024; // §7：fs.read 单文件 ≤4MB
export const FS_WRITE_MAX_BYTES = 8 * 1024 * 1024; // §7：fs.write 单文件 ≤8MB
export const FS_LIST_MAX_DEPTH = 4; // §7：fs.list 深度 ≤4
/** 纵深防御（§7.1）：即便 home 内已无秘密，仍隐藏该前缀。 */
export const DOTD_HIDDEN_PREFIX = '/dot/home/.dotd';

export interface PathCheck {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * home 路径约束 + symlink 逃逸防护（§7：realpath 双查）。
 * `real` = realpath 解析后的绝对路径（调用方在容器内解析后传入；宿主侧 stub 用同函数校验）。
 */
export function checkHomePath(path: unknown, real?: string): PathCheck {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, code: 'bad_path', message: 'path 必须为非空字符串' };
  }
  const norm = normalizeAbs(path);
  // home 根本身（/dot/home）与其下（/dot/home/...）都合法；其余一律越界
  if (norm !== HOME_ROOT && !norm.startsWith(`${HOME_ROOT}/`)) {
    return { ok: false, code: 'path_outside_home', message: `路径越界：${norm} 不在 ${HOME_ROOT}/ 下` };
  }
  if (norm.startsWith(`${DOTD_HIDDEN_PREFIX}/`) || norm === DOTD_HIDDEN_PREFIX) {
    return { ok: false, code: 'path_hidden', message: `${DOTD_HIDDEN_PREFIX} 为纵深防御隐藏前缀` };
  }
  if (real !== undefined) {
    const rnorm = normalizeAbs(real);
    if (rnorm !== HOME_ROOT && !rnorm.startsWith(`${HOME_ROOT}/`)) {
      return { ok: false, code: 'symlink_escape', message: `realpath 逃逸：${rnorm}` };
    }
  }
  return { ok: true };
}

/** 归一化：去 `.`/`..`/重复斜杠；保留前导 `/`。 */
export function normalizeAbs(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** 契约 S5/§6.1：identity → profile 目录名 = sha256(identity_key)[0:16]（防目录名注入）。 */
export function identityHash(identity: string, chars = 16): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, chars);
}

/** 卷名（§4.2 Binds / §9 exec_volumes.name）。 */
export function volumeNames(dotId: string): { home: string; profiles: string; state: string } {
  return {
    home: `dot-${dotId}-home`,
    profiles: `dot-${dotId}-profiles`,
    state: `dot-${dotId}-state`,
  };
}

/** 容器名/hostname（§4.2）。 */
export function containerName(dotId: string): string {
  return `dotd-dot-${dotId}`;
}

/** 镜像 tag（§3.2：`dotd/exec:{PW_VERSION}-{runtimeVer}`）。 */
export function imageTag(pwVersion: string, runtimeVer: string): string {
  return `dotd/exec:${pwVersion}-${runtimeVer}`;
}

// ═══════════════════════════════════════════════════════════════════
// §4.2 容器创建参数（常量集中）
// ═══════════════════════════════════════════════════════════════════

/** §4.2 HostConfig 的常量部分（docker 路径用；stub 路径只做记录不执行）。 */
export function containerHostConfig(cfg: ExecConfig, limits: { memMb: number; cpuMillis: number }): Record<string, unknown> {
  return {
    NetworkMode: cfg.networkName,
    Memory: limits.memMb * 1048576,
    MemorySwap: limits.memMb * 1048576, // swap=mem ⇒ 禁 swap
    NanoCpus: limits.cpuMillis * 100_000, // 修订：1 mCPU = 100,000 nanoCPU
    PidsLimit: 512,
    Tmpfs: { '/tmp': 'size=256m,exec' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
    RestartPolicy: { Name: 'no' }, // 由本模块监督重启，防 docker 自动绕过状态机
    OomScoreAdj: 700, // 与 netfuzz 共存：内存压力我们先被 OOM
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    CapAdd: ['SETUID', 'SETGID'], // §7.1：runtime(1000) spawn shell(1001) 所需
    SecurityOpt: ['no-new-privileges:true'],
  };
}

/** §4.2 Env + Labels（token 经 ro bind 挂载，不进 Env）。 */
export function containerEnvAndLabels(
  cfg: ExecConfig,
  dotId: string,
  limits: { memMb: number; cpuMillis: number },
): { env: string[]; labels: Record<string, string> } {
  return {
    env: [
      'DOTD_TOKEN_PATH=/run/dotd/token',
      `DOTD_MEM_BUDGET_MB=${limits.memMb}`,
      `DOTD_CPU_MILLIS=${limits.cpuMillis}`,
      `DOTD_RUNTIME_PORT=${cfg.runtimePort}`,
      'DISPLAY=:99',
      // 出网策略必须**显式传进容器**：容器读自己的 process.env，宿主设了没用。
      // 未配置时不传（容器侧缺省 off），保持"默认关闭"的语义不变。
      ...(cfg.netToolsMode !== undefined ? [`DOTD_NET_TOOLS=${cfg.netToolsMode}`] : []),
      // 契约 T5：容器内工具不得直连模型 ⇒ 不注入任何模型 base_url env（收紧完成）
    ],
    labels: {
      'dotd.managed': '1',
      'dotd.dot': dotId,
      'dotd.runtime': cfg.runtimeVer,
    },
  };
}
