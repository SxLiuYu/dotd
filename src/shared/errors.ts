/**
 * src/shared/errors.ts —— 跨模块错误类（唯一权威）。
 *
 * 依据（逐字）：
 * - 契约 §9 / T1：熔断耗尽 = `AllEndpointsDownError` / `NoQualifiedPrimaryError`
 *   （作废 NoChannelAvailable）
 * - MR §5.2 错误契约表：AuthConfigError / DeadlineBudgetError / StreamInterruptedError
 * - MEM §8 错误约定：只抛 MemoryCapacityError（容量红线，SOS 路径）与
 *   MemoryCorruptionError（integrity_check 失败 → 拒启动）
 * - 契约 D3 / CP §7.1 步骤 1：迁移失败 → 拒启动 + 写 OUTBOX.md
 * - GOV §2.3：zod 校验失败 ⇒ throw ⇒ daemon 拒启动
 *
 * 约定：跨模块错误一律 `instanceof` 判定 + `code` 字段机读；message 给人读。
 * 新增错误类必须在本文件登记，模块内私有错误不得跨模块传递（契约：模块只 import shared）。
 */

/** 所有 dotd 错误的基类（便于 daemon 统一 catch 与日志分级）。 */
export class DotdError extends Error {
  /** 机读码（日志/审计/HTTP 映射用；不随文案改动。 */
  readonly code: string;
  constructor(message: string, code = 'DOTD_ERROR', options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// ── 模型路由（MR §5.2 错误契约表；调用方义务见表内"调用方义务"列）─────────────

/** MR：全部候选试过且失败。调用方义务：置任务 paused(stop_reason='circuit_open')，等 router.mode_changed。 */
export class AllEndpointsDownError extends DotdError {
  /** 已试候选序列（端点 id × track）。 */
  readonly tried: readonly string[];
  /** 本次失败是否已开过 help（账本先行，MR §4.5）。 */
  readonly helpAlreadyOpen: boolean;
  constructor(tried: readonly string[], helpAlreadyOpen = false) {
    super(`全部模型端点均不可用（已试 ${tried.length} 个候选）`, 'ALL_ENDPOINTS_DOWN');
    this.tried = tried;
    this.helpAlreadyOpen = helpAlreadyOpen;
  }
}

/**
 * MR：RESTRICTED 档位下唯一可见的是未持合格证的池模型，且存在待批侦察候选。
 * 抛出点唯一（MR §5.2），调用方义务同 AllEndpointsDownError，且 help 必须附"待批候选"段。
 */
export class NoQualifiedPrimaryError extends DotdError {
  readonly tried: readonly string[];
  constructor(tried: readonly string[]) {
    super('RESTRICTED：无合格 primary 端点，有待批侦察候选', 'NO_QUALIFIED_PRIMARY');
    this.tried = tried;
  }
}

/** MR：流已开始（首字节已下发）后断流。路由绝不自动重放；重放与否是 journal 的业务决策。 */
export class StreamInterruptedError extends DotdError {
  readonly consumedTokens: number;
  readonly textSoFar: string;
  constructor(consumedTokens: number, textSoFar: string, options?: { cause?: unknown }) {
    super('模型流式响应中断（首字节后断流，不重放）', 'STREAM_INTERRUPTED', options);
    this.consumedTokens = consumedTokens;
    this.textSoFar = textSoFar;
  }
}

/** MR：调用方 deadline 耗尽（MR §4.2 循环顶）。 */
export class DeadlineBudgetError extends DotdError {
  constructor(message = '模型调用预算耗尽', options?: { cause?: unknown }) {
    super(message, 'DEADLINE_BUDGET', options);
  }
}

/** MR：鉴权类失败且端点已 open（open 后首个到达请求转抛此错而非继续转发 401）。 */
export class AuthConfigError extends DotdError {
  readonly endpointId: string;
  constructor(endpointId: string, options?: { cause?: unknown }) {
    super(`端点 ${endpointId} 鉴权失败且已熔断：改配置/换 key 后调 resetBreaker`, 'AUTH_CONFIG', options);
    this.endpointId = endpointId;
  }
}

// ── 记忆（MEM §8 错误约定：只抛这两个）────────────────────────────────────────

/** MEM：容量红线。触发 SOS 路径（MR alert 通路），主循环不被炸。 */
export class MemoryCapacityError extends DotdError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MEMORY_CAPACITY', options);
  }
}

/** MEM：integrity_check 失败 → 按 MEM §6.3 拒绝启动，不存在"只读半开"。 */
export class MemoryCorruptionError extends DotdError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MEMORY_CORRUPTION', options);
  }
}

// ── 启动期（拒启动类：抛出即 daemon 不 listen）────────────────────────────────

/** 迁移失败（契约 D3）：user_version 推进失败/完整性检查未过。拒启动 + 写 OUTBOX.md。 */
export class MigrationError extends DotdError {
  /** 失败的迁移包文件名（目录级错误为 null）。 */
  readonly pkg: string | null;
  constructor(message: string, pkg: string | null, options?: { cause?: unknown }) {
    super(pkg === null ? message : `${message}（包：${pkg}）`, 'MIGRATION_FAILED', options);
    this.pkg = pkg;
  }
}

/** 配置校验失败（GOV §2.3 zod 失败 ⇒ throw ⇒ daemon 拒启动；同用于六份 yml 加载）。 */
export class ConfigError extends DotdError {
  /** 出错的文件路径（如 config/tools.yml）。 */
  readonly file: string | null;
  constructor(message: string, file: string | null, options?: { cause?: unknown }) {
    super(file === null ? message : `${message}（文件：${file}）`, 'CONFIG_INVALID', options);
    this.file = file;
  }
}

/** CP §5.4：单任务步数硬上限（默认 2000）。调用方义务：任务 failed(stop_reason='budget')，不经 attempt 重试。 */
export class StepLimitError extends DotdError {
  /** 越线的任务 id。 */
  readonly taskId: string;
  /** 将要写入的步序号（= 已写步数 + 1）。 */
  readonly nextSeq: number;
  /** 触发的硬上限值。 */
  readonly hardLimit: number;
  constructor(taskId: string, nextSeq: number, hardLimit: number, options?: { cause?: unknown }) {
    super(
      `任务 ${taskId} 步数越硬上限（第 ${nextSeq} 步 > ${hardLimit}）`,
      'STEP_LIMIT_EXCEEDED',
      options,
    );
    this.taskId = taskId;
    this.nextSeq = nextSeq;
    this.hardLimit = hardLimit;
  }
}
