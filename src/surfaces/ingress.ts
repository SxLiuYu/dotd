/**
 * src/surfaces/ingress.ts —— 事件入口规范化（webhook / JSONL / HTTP 统一入口 `ingest()`）。
 *
 * 依据（surfaces.md §1 铁律三分投递 / §4.6 / §5.1 / §5.2 / §5.3；契约 E1/E2/S-1）：
 * - 本模块只做 **鉴权 → 规范化 → 限流 → 幂等键生成 → 投递**；事件的落库、去重、匹配、
 *   建任务全部在 CP（`cp.ingestEvent`）。审批回复绝不进事件流（走 GOV）。
 * - §4 表 dedup_key 规则：heartbeat `hb:<ct_id>:<next_fire_ms>`、JSONL
 *   `file:<path>:<ino>:<gen>:<行号>`、webhook `<source>:<extId|sha256(body)[0:16]>`、
 *   Telegram `tg:<update_id>`。
 * - §5.1 优先级映射：interactive/telegram=1，heartbeat·http=5，file=7（CP 不再自定档位）。
 * - 从未抵达 CP 的拒绝落 `surf_ingress_rejects`（SF 自有表）；抵达后的 dup 落 CP `events`
 *   —— 两套审计不混写（契约 E1 末段）。
 * - §5.3 JSONL：旋转/截断两类都 `gen++` 从 0 重读；dedup_key 含 gen 所以新内容行
 *   不会误判 dup；offset 只停在完整行边界 + ingest 成功后同事务前进。
 */

import { appendFileSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { EventBus } from '../shared/bus.ts';
import type { IngestEventReq, IngestEventResult, RawInbound } from '../shared/contracts.ts';
import { ConfigError } from '../shared/errors.ts';
import type { HookConfig, IngestOutcome, SurfacesDeps } from './types.ts';
import { PRIORITY_MAP, fileDedupKey, heartbeatDedupKey, telegramDedupKey, webhookDedupKey } from './types.ts';

// ── 拒绝审计（surf_ingress_rejects）────────────────────────────────────

/** §4 表 surf_ingress_rejects.reason CHECK（逐字）。 */
export type RejectReason = 'auth' | 'origin' | 'rate' | 'schema' | 'size' | 'allowlist' | 'parse';

export interface RejectRecord {
  source: RawInbound['source'];
  actor: string | null;
  reason: RejectReason;
  /** 说明（DDL `detail TEXT` 可空；无说明时不写） */
  detail?: string;
}

/** 入站失败审计写入器（§5.1：reject 也必落审计行；契约 E1）。 */
export class IngressRejectLog {
  constructor(private readonly db: DatabaseSync) {}

  record(r: RejectRecord): void {
    this.db
      .prepare(
        `INSERT INTO surf_ingress_rejects (at, source, actor, reason, detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), r.source, r.actor, r.reason, r.detail ?? null);
  }

  /** 读取最近 N 条（CLI `dotd logs` / 测试断言用）。 */
  recent(limit = 50): Array<{ id: number; at: string; source: string; actor: string | null; reason: string; detail: string | null }> {
    return this.db
      .prepare(
        `SELECT id, at, source, actor, reason, detail FROM surf_ingress_rejects
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      at: string;
      source: string;
      actor: string | null;
      reason: string;
      detail: string | null;
    }>;
  }
}

// ── §4.6 RawInbound 的 zod 校验 ───────────────────────────────────────

/** §4.6：source 与 CP events.source CHECK 逐字一致（去掉 email —— email 属阶段二入口）。 */
const rawInboundSchema = z.object({
  source: z.enum(['http', 'file', 'heartbeat', 'telegram']),
  dotId: z.string().min(1),
  text: z.string().optional(),
  payload: z.unknown(),
  dedupKey: z.string().min(1).optional(),
  actor: z.string().min(1),
});

export function validateRawInbound(raw: RawInbound): { ok: true } | { ok: false; error: string } {
  const parsed = rawInboundSchema.safeParse(raw);
  if (parsed.success) return { ok: true };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ');
  return { ok: false, error: issues };
}

// ── §5.1 优先级映射 ──────────────────────────────────────────────────

/** §5.1 表：按来源映射 tasks.priority（interactive=1 / heartbeat·hook=5 / bulk=7）。 */
export function priorityForSource(source: RawInbound['source']): number {
  switch (source) {
    case 'heartbeat':
      return PRIORITY_MAP.heartbeat;
    case 'http':
      return PRIORITY_MAP.http;
    case 'file':
      return PRIORITY_MAP.file;
    case 'telegram':
      return PRIORITY_MAP.telegram;
    default:
      return PRIORITY_MAP.http;
  }
}

// ── 限流器（§5.1：rateLimiter.exceeded(source, actor)）────────────────

/**
 * 令牌桶限流：按 `(source, actor)` 键，每分钟 `limit` 个（hooks 的 rate_limit_per_min）。
 * 非 hooks 来源（file/heartbeat/telegram）用 `defaultPerMin`。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly opts: { defaultPerMin: number; hookLimits?: Map<string, number> } = { defaultPerMin: 120 },
  ) {}

  /** 记录一次并判定是否超限（超限即应拒绝）。 */
  exceeded(key: string, now: number, limit?: number): boolean {
    const lim = limit ?? this.opts.hookLimits?.get(key) ?? this.opts.defaultPerMin;
    const windowMs = 60_000;
    const b = this.buckets.get(key);
    if (b === undefined || now - b.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return false;
    }
    b.count++;
    return b.count > lim;
  }

  /** 当前计数（测试/诊断用）。 */
  count(key: string): number {
    return this.buckets.get(key)?.count ?? 0;
  }
}

// ── Origin 白名单（§5.2：防 DNS rebinding） ───────────────────────────

/**
 * §5.2：带 `Origin`/`Referer` 的请求必须命中白名单。
 * 无 Origin 且无 Referer（curl/服务端/webhook）= 放行；白名单为空 = 一律放行（未配置）。
 */
export function originAllowed(
  headers: { origin?: string; referer?: string },
  allow: readonly string[],
): boolean {
  if (allow.length === 0) return true;
  const origin = headers.origin;
  if (origin !== undefined && origin.length > 0) return allow.includes(origin);
  const referer = headers.referer;
  if (referer !== undefined && referer.length > 0) {
    try {
      const u = new URL(referer);
      return allow.includes(u.origin);
    } catch {
      return false;
    }
  }
  return true; // 无 Origin/Referer：非浏览器客户端
}

// ── §5.1 ingest() 统一入口 ────────────────────────────────────────────

export interface IngestDeps {
  db: DatabaseSync;
  bus: EventBus;
  cp: { ingestEvent(e: IngestEventReq): IngestEventResult };
  rejects?: IngressRejectLog;
  rateLimiter?: RateLimiter;
  /** hooks 配置（限流上限与 dot 归属的来源）。 */
  hooks?: HookConfig[];
  /** 允许的 Origin 白名单（§5.2）。 */
  allowedOrigins?: readonly string[];
  now?(): Date;
}

/**
 * §5.1 原文：
 * ```ts
 * export function ingest(raw: RawInbound, deps: IngressDeps): { eventId: string; dup: boolean } {
 *   const r = zodValidate(raw);
 *   if (rateLimiter.exceeded(raw.source, raw.actor)) { reject('rate'); return http429(); }
 *   if (!originAllowed(raw)) { reject('origin'); return http403(); }
 *   const { eventId, decision } = deps.cp.ingestEvent(rawToIngress(raw));
 *   deps.bus.publish('log', { kind: 'event.received', eventId, source: raw.dotId });
 *   return { eventId, dup: decision === null && alreadyKnown(eventId) };
 * }
 * ```
 * 本实现的收敛点（对接缝契约 E2 的落地）：
 * - `ingestEvent` 返回 `{eventId:number, dup:boolean}`（契约 E2 原文），因此 dup 直接取该字段，
 *   不再有 rev1 的 `decision === null && alreadyKnown(eventId)` 推断（CP 已裁决 dedup 语义）。
 * - CP 因超 `maxQueued=200` 拒绝/淘汰时抛错（CP §4.4），`ingest` 把它映射成
 *  `{status:'rejected', httpStatus:503, retryAfterMs}`（§5.1 末段），由 HTTP 层转 503。
 */
export type IngestResult =
  | { status: 'accepted'; eventId: number; dup: boolean; httpStatus: 202 | 200 }
  | { status: 'rejected'; reason: RejectReason; httpStatus: 400 | 403 | 429 | 503; retryAfterMs?: number };

export function ingest(raw: RawInbound, deps: IngestDeps): IngestResult {
  const now = (deps.now ?? (() => new Date()))();
  const rejects = deps.rejects ?? new IngressRejectLog(deps.db);
  const limiter = deps.rateLimiter ?? new RateLimiter({ defaultPerMin: 120 });
  const actor = raw.actor;

  // ① zod 校验（§4.6 形状；失败 → schema reject）
  const v = validateRawInbound(raw);
  if (!v.ok) {
    rejects.record({ source: raw.source, actor, reason: 'schema', detail: v.error });
    return { status: 'rejected', reason: 'schema', httpStatus: 400 };
  }

  // ② 限流（按 source:actor 键；hooks 用各自 rate_limit_per_min）
  const key = `${raw.source}:${actor}`;
  const hookLimit = deps.hooks?.find((h) => h.source === actor.replace(/^hook:/, ''))?.rateLimitPerMin;
  if (limiter.exceeded(key, now.getTime(), hookLimit)) {
    rejects.record({ source: raw.source, actor, reason: 'rate', detail: `限流：${key}` });
    return { status: 'rejected', reason: 'rate', httpStatus: 429 };
  }

  // ③ Origin 白名单（DNS rebinding 防护；http 来源才可能带 Origin）
  if (raw.source === 'http' && !originAllowed({}, deps.allowedOrigins ?? [])) {
    rejects.record({ source: raw.source, actor, reason: 'origin', detail: 'Origin 不在白名单' });
    return { status: 'rejected', reason: 'origin', httpStatus: 403 };
  }

  // ④ 投递 CP（落库/去重/匹配全在 CP；CP 拒绝/淘汰 → 503 + retryAfterMs）
  //   契约 E1 末段：surf_ingress_rejects 只记「从未抵达 CP 的入站失败」；
  //   抵达 CP 之后的拒绝/淘汰由 CP 自己落在 events 表——两套审计不混写。
  //   CP 抛错时事件已抵达 CP 边界，故不写 rejects，仅映射 HTTP 503。
  let res: IngestEventResult;
  try {
    res = deps.cp.ingestEvent(rawToIngress(raw));
  } catch {
    return { status: 'rejected', reason: 'schema', httpStatus: 503, retryAfterMs: 5_000 };
  }

  // ⑤ 总线通报（§5.1 原文 deps.bus.publish('log', {kind:'event.received', …})）
  deps.bus.publish('event.received', {
    kind: 'event.received',
    eventId: res.eventId,
    source: raw.source,
    dotId: raw.dotId,
    dup: res.dup,
  });

  // §5.2：`POST /hooks/:source` → 202 {eventId}；dup 命中 → 200 {eventId, dup:true}
  return {
    status: 'accepted',
    eventId: res.eventId,
    dup: res.dup,
    httpStatus: res.dup ? 200 : 202,
  };
}

/** RawInbound → CP IngressEventReq（§4.6/C1：不新增顶层字段，业务扩展进 payload）。 */
export function rawToIngress(raw: RawInbound): IngestEventReq {
  const req: IngestEventReq = {
    source: raw.source,
    dotId: raw.dotId,
    actor: raw.actor,
    payload: raw.text === undefined ? raw.payload : { ...(asObject(raw.payload)), text: raw.text },
    priority: priorityForSource(raw.source),
  };
  if (raw.dedupKey !== undefined) req.dedupKey = raw.dedupKey;
  return req;
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

// ── webhook 规范化（§5.2 POST /hooks/:source + §4 dedup_key） ─────────

export interface NormalizedHook {
  raw: RawInbound;
  /** §4 表 webhook 行：`<source>:<extId|sha256(body)[0:16]>`。 */
  dedupKey: string;
}

/**
 * §5.2 `POST /hooks/:source` 的规范化。
 * @param source 路径参数（必须命中 config 的 hooks[].source，否则 reject('auth')）
 * @param body 原始 body（≤256KB，超限在 http.ts 已拦）
 * @param extId `payload.id ?? payload.delivery_id`（GitHub 用 delivery_id）
 */
export function normalizeHook(
  source: string,
  body: unknown,
  hooks: readonly HookConfig[],
  opts: { extId?: string; actor?: string } = {},
): { ok: true; hook: NormalizedHook } | { ok: false; reason: RejectReason; detail: string } {
  const cfg = hooks.find((h) => h.source === source);
  if (cfg === undefined) {
    return { ok: false, reason: 'auth', detail: `未登记的 hook source：${source}` };
  }
  const bodyObj = asObject(body);
  const extId = opts.extId ?? pickExtId(bodyObj);
  const sha = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const dedupKey = webhookDedupKey(cfg.source, extId, sha);
  return {
    ok: true,
    hook: {
      dedupKey,
      raw: {
        source: 'http',
        dotId: cfg.dotId,
        payload: body,
        dedupKey,
        actor: opts.actor ?? `hook:${cfg.source}`,
      },
    },
  };
}

/** §4 表：`payload.id ?? payload.delivery_id`。 */
function pickExtId(body: Record<string, unknown>): string | undefined {
  const id = body['id'];
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  const delivery = body['delivery_id'];
  if (typeof delivery === 'string' || typeof delivery === 'number') return String(delivery);
  return undefined;
}

// ── JSONL 行规范化（§5.3） ───────────────────────────────────────────

export interface JsonlLineInput {
  path: string;
  inode: number;
  /** 旋转/截断代数（§4 surf_jsonl_offset.gen）。 */
  gen: number;
  /** 文件内行号（从 1 起）。 */
  lineNo: number;
  /** 原始行文本（去掉换行符）。 */
  line: string;
}

/**
 * §5.3：单行 JSONL 的规范化。解析失败行不阻塞（调用方写 .errors.jsonl +
 * ingress_rejects(reason='parse')）。
 */
export function normalizeJsonlLine(
  input: JsonlLineInput,
  dotId: string,
): { ok: true; raw: RawInbound } | { ok: false; reason: 'parse'; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.line);
  } catch (cause) {
    return { ok: false, reason: 'parse', detail: `第 ${input.lineNo} 行不是合法 JSON：${String(cause)}` };
  }
  const obj = asObject(parsed);
  const text = typeof obj['text'] === 'string' ? (obj['text'] as string) : undefined;
  const dedupKey = fileDedupKey(input.path, input.inode, input.gen, input.lineNo);
  return {
    ok: true,
    raw: {
      source: 'file',
      dotId,
      payload: parsed,
      text,
      dedupKey,
      actor: `file:${input.path}`,
    },
  };
}

// ── heartbeat 的 RawInbound 构造（§5.4 投递载荷） ─────────────────────

export interface HeartbeatFireInput {
  ctId: string;
  dotId: string;
  title: string;
  prompt: string;
  /** CP crontabs.next_fire（epoch ms）——dedup_key 的天然唯一锚。 */
  nextFire: number;
}

/** §5.4：`deps.cp.ingestEvent({source:'heartbeat', payload:{…}, dedupKey:'hb:<ct_id>:<next_fire>'})`。 */
export function buildHeartbeatRaw(input: HeartbeatFireInput): RawInbound {
  return {
    source: 'heartbeat',
    dotId: input.dotId,
    payload: {
      goal: input.prompt,
      title: input.title,
      ctId: input.ctId,
      dueAt: input.nextFire,
    },
    dedupKey: heartbeatDedupKey(input.ctId, input.nextFire),
    actor: 'scheduler',
  };
}

// ── Telegram 聊天入站（§5.5，阶段二；接线位先定型） ────────────────────

/**
 * §5.5：TG 非指令文本 → ingest(source='telegram', dedupKey='tg:<update_id>')。
 * 指令（`a\d+/d\d+/l/all` 或 reply 到审批消息）不进事件流，整体交 GOV resolveTelegram。
 * 阶段一只做 normalize + 判别函数，轮询循环本身留接线位（§2.2 分期）。
 *
 * @param replyToMsgId 回复的审批卡片 message_id（§5.5：reply 到审批消息即指令，
 *   GOV 用它寻址；非指令消息不带）
 */
export function normalizeTelegramMessage(
  updateId: number,
  chatId: number,
  text: string,
  dotId: string,
  replyToMsgId?: number | null,
): RawInbound {
  const payload: Record<string, unknown> = { updateId, chatId, text };
  if (replyToMsgId !== undefined && replyToMsgId !== null) payload['replyToMsgId'] = replyToMsgId;
  return {
    source: 'telegram',
    dotId,
    text,
    payload,
    dedupKey: telegramDedupKey(updateId),
    actor: `tg:${chatId}`,
  };
}

/**
 * §5.5 粗筛：像审批指令吗？命中 → GOV resolveTelegram（GOV 全权解析寻址）；
 * 未命中 → ingest。这里只做"像不像"的粗判，真解析在 GOV（不得越权）。
 *
 * §5.5 原文正则语义 `a\d+/d\d+/l/all`（连写 `l/all` 是"列全部待批"的合写）：
 * - `a7` / `a7/d9` / `a7 / d9`（分隔符两侧空格宽容）——单条或 ` / ` 组合；
 * - `l` / `l/a7` / `l/all` —— 列表，可带后续指令；
 * - 裸 `all` —— GOV §3.4 词汇的另一种写法（`l/all` 的省略形）。
 *
 * 注意铁律（§1）：审批回复绝不进事件流。粗筛必须**宁宽勿漏**——漏判会把
 * `all` 当普通聊天投进 cp.ingestEvent。多认的代价只是多走一次 GOV 解析
 * （GOV 认不出会回错误提示，不会误执行）。
 */
export function looksLikeApprovalCommand(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 段内 alternation 必须整体成组：否则 `l` 会成为顶层分支、`^l` 无需管尾部
  // （'allow'/'a12b' 会被误判为指令）。宁宽勿漏 ≠ 无边界。
  const seg = '(?:[ad]\\s*\\d+|l|all)';
  // 单段：a7 / d9 / l / all
  if (new RegExp(`^${seg}$`, 'i').test(t)) return true;
  // 组合：以 / 分隔的多段（a7/d9、l/all、a7/d9/all…）
  return new RegExp(`^${seg}(?:\\s*/\\s*${seg})*$`, 'i').test(t);
}

/**
 * §5.5「reply 到审批消息」判定：消息带着对某条审批卡片的回复 →
 * 无论文本是什么都算审批指令（GOV 用 replyToMsgId 寻址，不需要文本里有 id）。
 * 粗筛只回答"像不像"，所以只要 replyToMsgId 非空即命中。
 */
export function looksLikeApprovalReply(replyToMsgId: number | null | undefined): boolean {
  return replyToMsgId !== null && replyToMsgId !== undefined;
}

/** §5.5 入站分流的合并判据（文本粗筛 ∨ reply 判定）。 */
export function isApprovalTraffic(input: { text: string; replyToMsgId?: number | null }): boolean {
  return looksLikeApprovalCommand(input.text) || looksLikeApprovalReply(input.replyToMsgId ?? null);
}

// ── §5.2 入站大小的常量 ──────────────────────────────────────────────

/** §5.2：hooks/API body ≤256KB。 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 装配层入口：构造本模块的入站面（供 http.ts / cli.ts / daemon.ts 复用）。 */
export function createIngress(deps: SurfacesDeps & { db: DatabaseSync }): {
  ingest(raw: RawInbound): IngestResult;
  rejects: IngressRejectLog;
  limiter: RateLimiter;
  /** §5.3：JSONL 坏行侧车 + 连续坏行暂停（轮询循环消费新行前先问 isPaused）。 */
  jsonlErrors: JsonlErrorSink;
} {
  const rejects = new IngressRejectLog(deps.db);
  const limiter = new RateLimiter({
    defaultPerMin: 120,
    hookLimits: new Map((deps as unknown as { hooks?: HookConfig[] }).hooks?.map((h) => [h.source, h.rateLimitPerMin]) ?? []),
  });
  const jsonlErrors = new JsonlErrorSink({
    rejects,
    // 生产装配层补 sizeOf/truncate 才启用 §9 滚动；缺省不滚动（测试注入内存版）
    warn: (m) => deps.bus.publish('log', { kind: 'log', level: 'warn', message: m }),
  });
  return {
    rejects,
    limiter,
    jsonlErrors,
    ingest(raw) {
      return ingest(raw, {
        db: deps.db,
        bus: deps.bus,
        cp: deps.cp,
        rejects,
        rateLimiter: limiter,
      });
    },
  };
}

/** 配置类错误的兜底转换（给 daemon 装配层一个明确入口）。 */
export function assertSurfacesDeps(deps: SurfacesDeps): void {
  if (typeof deps.cp?.ingestEvent !== 'function') {
    throw new ConfigError('surfaces 依赖缺 cp.ingestEvent（契约 E2 唯一机器事件入口）', null);
  }
}

// ── §5.3 JSONL 错误路径（侧车文件 + 坏行暂停）─────────────────────────

/**
 * §5.3 原文：「解析失败行不阻塞：写 `<path>.errors.jsonl` +
 * `ingress_rejects(reason='parse')`；连续 20 行坏 → 暂停该 path + `log` 告警。」
 *
 * `JsonlErrorSink` 把这两句落成可测的实现：
 * - `note(path, lineNo, line, detail)`：写侧车文件 + 记 rejects + 累计连续坏行数；
 * - 连续坏行达到 `CONSECUTIVE_BAD_LINES` → 该 path 进入 `paused` 集合，
 *   调用方（JSONL 轮询/监听循环）先问 `isPaused(path)` 再决定是否消费新行；
 * - 好行到来即清零该 path 的连续计数（"连续"是严格的相邻坏行）。
 *
 * 侧车文件按 §9 滚动截断：超过 `ERRORS_MAX_BYTES` 先 truncate 再追加
 * （老证据被裁，新证据保留——10MB 是磁盘留存上限，不是保留量）。
 */
export const CONSECUTIVE_BAD_LINES = 20;
/** §9：`*.errors.jsonl` ≤10MB 滚动截断。 */
export const ERRORS_MAX_BYTES = 10 * 1024 * 1024;

export interface JsonlErrorSinkDeps {
  /** 写侧车文件（默认 `appendFileSync`；测试可注入内存版）。 */
  append?(path: string, text: string): void;
  /** 侧车文件当前大小（默认 0=不量；测试可注入以驱动滚动分支）。 */
  sizeOf?(path: string): number;
  /** 滚动截断（默认 `truncateSync(path, 0)`）。 */
  truncate?(path: string): void;
  /** `log` 通道告警（§5.3 明文：连续坏行发 log 告警）。 */
  warn?(message: string): void;
  /** 拒绝审计（surf_ingress_rejects，reason='parse'）。 */
  rejects?: IngressRejectLog;
}

export class JsonlErrorSink {
  private readonly badRun = new Map<string, number>();
  private readonly paused = new Set<string>();

  constructor(private readonly deps: JsonlErrorSinkDeps = {}) {}

  /** 该 path 是否因连续坏行被暂停（调用方据此停止消费新行）。 */
  isPaused(path: string): boolean {
    return this.paused.has(path);
  }

  /** 暂停中的 path 列表（CLI/测试观测）。 */
  pausedPaths(): string[] {
    return [...this.paused].sort();
  }

  /** 该 path 当前连续坏行数（观测用）。 */
  badRunOf(path: string): number {
    return this.badRun.get(path) ?? 0;
  }

  /** 好行到达：清零连续坏行计数（不自动解除暂停——恢复是运维动作）。 */
  noteGoodLine(path: string): void {
    this.badRun.delete(path);
  }

  /** 解除暂停（运维/测试用）。 */
  resume(path: string): void {
    this.paused.delete(path);
    this.badRun.delete(path);
  }

  /**
   * 记一条坏行。返回是否刚触发暂停（调用方可据此打一条日志）。
   */
  note(path: string, lineNo: number, line: string, detail: string): boolean {
    // ① 侧车文件 `<path>.errors.jsonl`（先滚动再追加）
    const sidecar = `${path}.errors.jsonl`;
    this.rollIfNeeded(sidecar);
    const row = JSON.stringify({
      at: new Date().toISOString(),
      path,
      lineNo,
      error: detail,
      line: line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line,
    });
    (this.deps.append ?? appendFileSync)(sidecar, `${row}\n`);

    // ② ingress_rejects(reason='parse')——从未抵达 CP 的失败（契约 E1）
    this.deps.rejects?.record({ source: 'file', actor: `file:${path}`, reason: 'parse', detail: `第 ${lineNo} 行：${detail}` });

    // ③ 连续坏行计数与暂停
    const run = (this.badRun.get(path) ?? 0) + 1;
    this.badRun.set(path, run);
    if (run >= CONSECUTIVE_BAD_LINES && !this.paused.has(path)) {
      this.paused.add(path);
      this.deps.warn?.(`JSONL 连续 ${run} 行坏行，已暂停 ${path}（§5.3）；修复后调 resume() 恢复`);
      return true;
    }
    return false;
  }

  private rollIfNeeded(sidecar: string): void {
    const sizeOf = this.deps.sizeOf;
    if (sizeOf === undefined) return; // 未提供大小探测 → 不滚动（生产装配层应提供）
    if (sizeOf(sidecar) <= ERRORS_MAX_BYTES) return;
    (this.deps.truncate ?? truncateSync)(sidecar);
    (this.deps.append ?? appendFileSync)(
      sidecar,
      `${JSON.stringify({ at: new Date().toISOString(), event: 'roll', reason: `超过 ${ERRORS_MAX_BYTES} 字节滚动截断（§9）` })}\n`,
    );
  }
}

// ── §9 磁盘留存（purge / 滚动）────────────────────────────────────────

/**
 * §9 原文：「`surf_ingress_rejects` ≤5 万行、`surf_tg_card_state` ≤1 万行
 * （每日随 GOV `compactAudit` 同期回调 purge）」。
 *
 * `purgeSurfacesRetention` 即那个"同期回调"：删最旧的超限行，保留最新的上限行数。
 * 与 GOV `compactAudit` 同日历日执行（由装配层注册到同一 cron，本函数不持定时器）。
 */
export const SURF_INGRESS_REJECTS_MAX_ROWS = 50_000;
export const SURF_TG_CARD_STATE_MAX_ROWS = 10_000;

export interface RetentionPurgeResult {
  ingressRejectsDeleted: number;
  tgCardStateDeleted: number;
}

export function purgeSurfacesRetention(db: DatabaseSync): RetentionPurgeResult {
  const rejects = db
    .prepare(
      `DELETE FROM surf_ingress_rejects WHERE id <= (
         SELECT MAX(id) - ? FROM surf_ingress_rejects
       )`,
    )
    .run(SURF_INGRESS_REJECTS_MAX_ROWS) as unknown as { changes: number };
  const cards = db
    .prepare(
      `DELETE FROM surf_tg_card_state WHERE rowid <= (
         SELECT MAX(rowid) - ? FROM surf_tg_card_state
       )`,
    )
    .run(SURF_TG_CARD_STATE_MAX_ROWS) as unknown as { changes: number };
  return {
    ingressRejectsDeleted: Number(rejects.changes ?? 0),
    tgCardStateDeleted: Number(cards.changes ?? 0),
  };
}

/**
 * §9：`offset.json`、`*.errors.jsonl` 各 ≤10MB 滚动截断。
 * 通用文件滚动（JSONL 侧车与 TG offset 共用）：超限 → 写一条 roll 标记后从 0 重写。
 */
export const ROLLING_MAX_BYTES = 10 * 1024 * 1024;

export function rollFileIfNeeded(path: string, sizeOf: (p: string) => number, truncate: (p: string) => void, append: (p: string, text: string) => void): boolean {
  if (sizeOf(path) <= ROLLING_MAX_BYTES) return false;
  truncate(path);
  append(path, `${JSON.stringify({ at: new Date().toISOString(), event: 'roll', reason: `超过 ${ROLLING_MAX_BYTES} 字节滚动截断（§9）` })}\n`);
  return true;
}
