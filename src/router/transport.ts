/**
 * src/router/transport.ts —— 模型出网 transport 的两份实现。
 *
 * 依据（逐字可溯）：
 * - CONVENTIONS.md「stub 模式环境变量约定」：`DOTD_MODEL_TRANSPORT=stub` → 模型调用走内存
 *   stub，**不发任何网络请求**。预置响应由测试/CLI 注入；**耗尽即抛错**（等价"全灭"），
 *   不静默返回空。非 stub 值或缺省 = 真实路径。
 * - MR §1.1 边界：模型 HTTP 是路由自己的事（不像 Telegram/SMTP 交给通知通道模块）。
 * - MR §4.6：侦察源**只读元数据**，绝不向候选发 chat/completions 推理请求；
 *   禁止直连 github.com/huggingface.co（用 api.github.com / hf-mirror.com）。
 * - MR §3.1：EndpointDef.style 恒 'openai'（OpenAI 兼容），故只有一份 HTTP 编解码。
 *
 * 环境门控（唯一开关）：`isStubTransport()` 读 DOTD_MODEL_TRANSPORT。
 * 测试不经装配层，直接 `new StubTransport(...)`（CONVENTIONS §7/§8）；
 * daemon/dev 用环境变量选路（`createModelTransport()`）。
 */

import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { ChatResponse, EndpointDef, FailureKind, Track } from '../shared/contracts.ts';
import type {
  ChatCall,
  ChatChunk,
  ChatOutcome,
  GetOutcome,
  MetadataQuery,
  ModelTransport,
  ReconItem,
  Usage,
} from './types.ts';

/** DOTD_MODEL_TRANSPORT === 'stub' 才走 stub（CONVENTIONS §7：非 stub 或缺省 = 真实路径）。 */
export function isStubTransport(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOTD_MODEL_TRANSPORT === 'stub';
}

// ═══════════════════════════════════════════════════════════════════
// 错误分类（MR §4.1 表）——stub 与真实路径共用
// ═══════════════════════════════════════════════════════════════════

/** HTTP 状态码 + 响应体 → FailureKind（MR §4.1 分类表）。 */
export function classifyHttpFailure(status: number, bodyText: string): FailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) {
    // MR §4.1：429 含 quota/credits/balance → quota（长期不可用，backoff 起步 30min）
    if (/\b(quota|credits?|balance|insufficient|billing)\b/i.test(bodyText)) return 'quota';
    return 'rate_limit';
  }
  if (status >= 500) return 'server_error';
  return 'bad_protocol';
}

/** 解析 Retry-After（秒数或 HTTP 日期）；无法解析返回 null。 */
export function parseRetryAfterMs(v: string | string[] | undefined): number | null {
  if (v === undefined) return null;
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw === undefined) return null;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

/** 网络层错误 → FailureKind（MR §4.1：DNS/拒连/断流 = network；超时 = timeout）。 */
export function classifyNetworkError(err: unknown, timedOut: boolean): FailureKind {
  if (timedOut) return 'timeout';
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? '';
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return 'network';
  }
  if (e?.message !== undefined && /socket hang up|aborted|terminated/i.test(e.message)) {
    return 'network';
  }
  return 'network';
}

// ═══════════════════════════════════════════════════════════════════
// 1. stub transport（不发任何网络请求）
// ═══════════════════════════════════════════════════════════════════

/** 一条预置响应（可声明一次失败以构造降级脚本）。 */
export interface StubResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: Usage;
  /** 声明这条命中即抛错（构造"端点挂了"的降级脚本）。 */
  fail?: Error;
}

/** 脚本项 = 预置响应 + 命中条件。 */
export interface StubScriptItem extends StubResponse {
  /** 命中端点 id（必填）。 */
  endpointId: string;
  /** 命中轨道（缺省 = 任意轨）。 */
  track?: import('../shared/contracts.ts').Track;
  /**
   * 命中模型名（缺省 = 该端点任意模型）。
   *
   * 端点内 fallback 链（MR §4.2）要在同一个端点上按模型逐条回放
   * "主模型 429 → 备用模型成功"，只按端点×轨无法表达。
   */
  model?: string;
}

/** 本地引擎（Tier2）探测预置。 */
export interface StubLocalProbe {
  health?: boolean;
  warm?: boolean;
  healthMs?: number;
  warmMs?: number;
}

export interface StubTransportOptions {
  /** 按端点 id × 轨道回放的预置脚本；同一 key 内按入队顺序消费。 */
  script?: StubScriptItem[];
  /** 全局兜底脚本（不限端点/轨道）。 */
  fallback?: StubResponse[];
  /** 本地引擎 health/warm 探测预置，key = 端点 id。 */
  local?: Record<string, StubLocalProbe>;
  /** 侦察元数据源预置（只读元数据，§4.6）。 */
  metadata?: Partial<Record<'openrouter_models' | 'github_curated', { items: ReconItem[] }>>;
}

interface StubLocalState {
  health: boolean;
  warm: boolean;
  healthMs: number;
  warmMs: number;
  /** 挂掉后自动恢复的时刻（"挂一会好"脚本用）。 */
  recoverAt: number | null;
}

/** 脚本键：端点 × 轨 × 模型；任一维缺省即通配。 */
function stubKey(endpointId: string, track?: Track, model?: string): string {
  return `${endpointId}|${track ?? '*'}|${model ?? '*'}`;
}

/**
 * stub transport：按脚本回放，**零网络请求**。
 *
 * 与 tests/helpers.ts 的 `makeStubTransport()`（冒充 ModelRouter.complete 的薄封装）分工不同：
 * 本类是**路由内部**的出网替身，按端点 id × 轨道回放，使 MR 测试能构造
 * "tier1 500 → tier2 成功"的完整降级脚本。预置耗尽 = 抛错（CONVENTIONS §7 逐字语义）。
 */
export class StubTransport implements ModelTransport {
  private readonly script = new Map<string, StubScriptItem[]>();
  private readonly fallback: StubScriptItem[] = [];
  private readonly local = new Map<string, StubLocalState>();
  private readonly meta = new Map<'openrouter_models' | 'github_curated', ReconItem[]>();

  /** 收到的全部 chat/stream 调用（断言 attemptId/track/model 用）。 */
  readonly calls: ChatCall[] = [];
  /** 收到的全部 GET（health/warm/池 /models）。 */
  readonly gets: Array<{ endpointId: string; url: string; apiKeyEnv: string | null }> = [];

  constructor(opts: StubTransportOptions = {}) {
    for (const item of opts.script ?? []) this.push(item.endpointId, item);
    for (const item of opts.fallback ?? []) {
      this.fallback.push({ ...item, endpointId: '*' });
    }
    for (const [id, cfg] of Object.entries(opts.local ?? {})) {
      this.local.set(id, {
        health: cfg.health ?? true,
        warm: cfg.warm ?? true,
        healthMs: cfg.healthMs ?? 5,
        warmMs: cfg.warmMs ?? 5,
        recoverAt: null,
      });
    }
    for (const [k, v] of Object.entries(opts.metadata ?? {})) {
      if (v !== undefined) this.meta.set(k as 'openrouter_models' | 'github_curated', v.items);
    }
  }

  /** 测试辅助：运行时改本地引擎探测结果（模拟 Colibrì 挂掉/过一会恢复）。 */
  setLocal(id: string, patch: StubLocalProbe & { recoverAfterMs?: number }): void {
    const cur =
      this.local.get(id) ?? { health: true, warm: true, healthMs: 5, warmMs: 5, recoverAt: null };
    this.local.set(id, {
      health: patch.health ?? cur.health,
      warm: patch.warm ?? cur.warm,
      healthMs: patch.healthMs ?? cur.healthMs,
      warmMs: patch.warmMs ?? cur.warmMs,
      recoverAt:
        patch.recoverAfterMs === undefined ? cur.recoverAt : Date.now() + patch.recoverAfterMs,
    });
  }

  /** 测试辅助：追加一条脚本（可在测试中途追加）。 */
  push(
    endpointId: string,
    item: StubResponse & { track?: import('../shared/contracts.ts').Track; model?: string },
  ): void {
    const key = stubKey(endpointId, item.track, item.model);
    const arr = this.script.get(key);
    const full: StubScriptItem = { ...item, endpointId };
    if (arr === undefined) this.script.set(key, [full]);
    else arr.push(full);
  }

  /** 剩余未消费的预置响应数（按可命中该项的全部键求和，同键去重）。 */
  pending(
    endpointId?: string,
    track?: import('../shared/contracts.ts').Track,
    model?: string,
  ): number {
    if (endpointId === undefined) {
      let n = this.fallback.length;
      for (const arr of this.script.values()) n += arr.length;
      return n;
    }
    const keys = new Set<string>();
    if (model !== undefined) {
      keys.add(stubKey(endpointId, track, model));
      keys.add(stubKey(endpointId, undefined, model));
    }
    keys.add(stubKey(endpointId, track));
    keys.add(stubKey(endpointId));
    let n = 0;
    for (const k of keys) n += this.script.get(k)?.length ?? 0;
    return n;
  }

  /**
   * 取一条脚本：先精确到模型（fallback 链逐条回放），再退回"该端点任意模型"。
   * 这样没配 model 的老脚本行为逐字不变，配了 model 的只被对应模型命中。
   */
  private take(
    endpointId: string,
    track: import('../shared/contracts.ts').Track,
    model: string,
  ): StubResponse {
    const keys = [
      stubKey(endpointId, track, model),
      stubKey(endpointId, undefined, model),
      stubKey(endpointId, track),
      stubKey(endpointId),
    ];
    for (const k of keys) {
      const arr = this.script.get(k);
      if (arr !== undefined && arr.length > 0) return arr.shift()!;
    }
    if (this.fallback.length > 0) return this.fallback.shift()!;
    throw new Error(`stub transport 预置响应耗尽（endpoint=${endpointId} track=${track} model=${model}）`);
  }

  async chat(call: ChatCall): Promise<ChatOutcome> {
    this.calls.push(call);
    const item = this.take(call.endpoint.id, call.track, call.model);
    if (item.fail !== undefined) throw item.fail;
    return {
      response: { content: item.content, toolCalls: item.toolCalls },
      usage: item.usage ?? { promptTokens: 12, completionTokens: 7 },
    };
  }

  stream(call: ChatCall): AsyncIterable<ChatChunk> & { usage(): Promise<Usage | undefined> } {
    this.calls.push(call);
    const item = this.take(call.endpoint.id, call.track, call.model);
    const parts = item.content.length === 0 ? [] : (item.content.match(/.{1,4}/gs) ?? []);
    const chunks: ChatChunk[] = parts.map((delta) => ({ delta }));
    chunks.push({ delta: '', done: true });
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<ChatChunk> {
        if (item.fail !== undefined) throw item.fail;
        for (const c of chunks) yield c;
      },
      async usage(): Promise<Usage | undefined> {
        if (item.fail !== undefined) throw item.fail;
        return item.usage ?? { promptTokens: 12, completionTokens: 7 };
      },
    };
  }

  async get(
    ep: EndpointDef,
    url: string,
    opts: { timeoutMs: number },
  ): Promise<GetOutcome> {
    this.gets.push({ endpointId: ep.id, url, apiKeyEnv: ep.apiKeyEnv });
    void opts.timeoutMs;
    const st = this.local.get(ep.id);
    if (st === undefined) {
      // 未配本地探测的端点（Tier1/3 的 /models 健康探测）：默认 200
      return { ok: true, status: 200, json: { data: [] }, latencyMs: 3 };
    }
    if (st.recoverAt !== null && Date.now() >= st.recoverAt) {
      st.health = true;
      st.warm = true;
      st.recoverAt = null;
    }
    const isWarm = /\/profile(\?|$)/.test(new URL(url).pathname);
    if (isWarm) {
      return st.warm
        ? { ok: true, status: 200, json: { expert_disk_s: 0 }, latencyMs: st.warmMs }
        : { ok: false, status: 200, json: { expert_disk_s: 12.5 }, latencyMs: st.warmMs };
    }
    return st.health
      ? { ok: true, status: 200, json: { status: 'ok' }, latencyMs: st.healthMs }
      : { ok: false, status: 503, text: 'engine down', latencyMs: st.healthMs };
  }

  async metadata(q: MetadataQuery): Promise<{ ok: boolean; items: ReconItem[]; error?: string }> {
    const all = this.meta.get(q.kind);
    if (all === undefined) return { ok: false, items: [], error: `stub 未预置元数据源 ${q.kind}` };
    const items = q.filter === undefined ? all : all.filter((i) => i.model.includes(q.filter!));
    return { ok: true, items };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2. 真实 HTTP transport（OpenAI 兼容；仅 env 门控调用）
// ═══════════════════════════════════════════════════════════════════

interface RawHttpResult {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  latencyMs: number;
}

/** 带 connect/idle/total 三档超时的裸 HTTP 请求（node:http/https，不装第三方）。 */
async function rawHttp(
  method: 'GET' | 'POST',
  url: string,
  opts: {
    headers?: Record<string, string>;
    body?: string;
    connectMs: number;
    idleMs: number;
    totalMs: number;
    signal?: AbortSignal;
  },
): Promise<RawHttpResult> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const startedAt = Date.now();

  // ── 三档超时的生命周期 ──────────────────────────────────────────────
  //
  // 2026-10-17 修复（回归：tests/router-http-transport.test.ts ⑥）。
  //
  // 原实现把整个生命周期（total 定时器 + idle 定时器 + finish）**全部建在
  // `http.request(url, opts, callback)` 的响应回调里**。Node 的 http 客户端在
  // **收到响应体的第一个字节之前不会调用该回调**——哪怕上游已经把状态行和
  // 头写出来，只要没有 body 字节，回调就不来（实测 Node v24.13.0：不 flush 也不
  // 写任何 body 的 200 响应，5s 内回调从未触发）。于是：
  //   - 上游接了连接、回了头、然后卡住 → total 定时器根本没被 arm，idle 同理
  //     → **永远挂着**，调用方被钉死，三档超时一个都不生效；
  //   - 全量测试套件的表现形式就是"整个 node --test 进程挂住不退出"。
  // 而"上游卡住不回数据"正是这三个超时要防的头号场景，等于防线恰好在这时失效。
  //
  // 修法：把生命周期提到**请求对象**上，与响应回调解耦：
  //   1. 定时器在发请求时立刻 arm；
  //   2. socket 每有活动（连接建立 / 收到数据）就重置 idle 表（idle = 无进展）；
  //   3. connect 通道 = "socket 已建立"仍未发生的判据，与 idle 分开计时；
  //   4. finish 摧毁 **req**（整条 socket）而不只是 res——只 destroy res 时
  //      没有任何事件会落到 req 上，promise 同样永不 settle。
  let settled = false;
  let resolveRes!: (r: RawHttpResult) => void;
  let reject!: (e: Error) => void;
  const p = new Promise<RawHttpResult>((res, rej) => {
    resolveRes = res;
    reject = rej;
  });

  const chunks: Buffer[] = [];
  let res: IncomingMessage | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  /** req 在 finish 内被引用，而 finish 可能先于 req 赋值被调用（同步 signal.aborted 等） */
  let reqRef: import('node:http').ClientRequest | null = null;

  const cleanup = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
  };

  const finish = (err: Error | null): void => {
    if (settled) return;
    settled = true;
    cleanup();
    // destroy 必须落在 req 上（整条 socket）；对已结束的请求重复 destroy 是幂等的，
    // 由 settled 闸门兜住重复调用。
    if (reqRef !== null) reqRef.destroy(err ?? undefined);
    if (res !== null) res.destroy();
    if (err !== null) {
      // 网络层错误统一包成 TransportError，让 classifyError 拿到 kind（MR §4.1）。
      // 但原始 errno 的 `code`（ECONNREFUSED/ENOTFOUND/ECONNRESET…）必须保留：
      // classifyNetworkError 正是按 code 归类，且运维排障时需要看见究竟哪种断法。
      if (err instanceof TransportError) {
        reject(err);
      } else {
        const timedOut = /timeout/i.test(err.message);
        const code = (err as { code?: unknown }).code;
        reject(
          new TransportError(timedOut ? 'timeout' : 'network', err.message, {
            cause: err,
            code: typeof code === 'string' ? code : undefined,
          }),
        );
      }
      return;
    }
    resolveRes({
      status: res?.statusCode ?? 0,
      headers: res?.headers ?? {},
      body: Buffer.concat(chunks).toString('utf8'),
      latencyMs: Date.now() - startedAt,
    });
  };

  const armIdle = (): void => {
    if (settled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => finish(new TransportError('timeout', `idle timeout（${opts.idleMs}ms 无进展）`)),
      opts.idleMs,
    );
  };

  const req = (isHttps ? httpsRequest : httpRequest)(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port === '' ? (isHttps ? 443 : 80) : Number(u.port),
      path: `${u.pathname}${u.search}`,
      method,
      headers: opts.headers,
    },
    (incoming: IncomingMessage) => {
      res = incoming;
      // 收到响应头 = 有进展：算 idle 的一次活动（此刻 body 可能一个字节都还没来）
      armIdle();
      incoming.on('data', (c: Buffer) => {
        chunks.push(c);
        armIdle();
      });
      incoming.on('end', () => finish(null));
      incoming.on('error', (e) => finish(e));
      // 旧版 node 在响应被对端中断时发 'aborted'，新版本走 'error'（ECONNRESET）
      incoming.on('aborted', () => finish(new TransportError('network', 'response aborted')));
    },
  );

  reqRef = req;

  // total 通道：从发请求起计满总预算。放在这里（而不是响应回调里）是本轮修复的核心。
  totalTimer = setTimeout(
    () => finish(new TransportError('timeout', `total timeout（${opts.totalMs}ms 总预算耗尽）`)),
    opts.totalMs,
  );

  // connect 通道：从发请求起就计时，socket 一旦建立即停表。
  // （connect/secureConnect 事件只在 CONNECT 隧道会触发，普通直连靠 socket 的
  //  'connect' 事件；这里两者都听，谁先来算谁。）
  connectTimer = setTimeout(
    () => finish(new TransportError('timeout', `connect timeout（${opts.connectMs}ms 内未建立连接）`)),
    opts.connectMs,
  );

  req.on('socket', (s: import('node:net').Socket) => {
    const connected = (): void => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      armIdle();
    };
    if (s.connecting === false && s.readyState === 'open') connected();
    else {
      s.once('connect', connected);
      // 兜底：socket 已可写（含 keep-alive 复用）也算连通
      if (s.writable === true && s.connecting === false) connected();
    }
    // 收到的任何字节 = 有进展（含上游只回头不吐 body 的情形）
    s.on('data', () => armIdle());
  });

  req.on('error', (e: Error) => {
    if (settled) {
      // 超时/中断路径：req.destroy(err) 会把同一个错误再抛一次，吞掉
      return;
    }
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }
    finish(e);
  });

  if (opts.signal !== undefined) {
    if (opts.signal.aborted) finish(new TransportError('network', 'aborted'));
    else opts.signal.addEventListener('abort', () => finish(new TransportError('network', 'aborted（调用方取消）')), { once: true });
  }
  if (opts.body !== undefined) req.write(opts.body);
  req.end();
  return p;
}

/** transport 内的超时/网络错误（带原始 cause，供 classifyError 归类）。 */
export class TransportError extends Error {
  readonly kind: 'timeout' | 'network';
  /** 原始 socket 层 errno（ECONNREFUSED / ENOTFOUND / ECONNRESET …），无则 undefined。 */
  readonly code?: string;
  constructor(
    kind: 'timeout' | 'network',
    message: string,
    options?: { cause?: unknown; code?: string },
  ) {
    super(message, options);
    this.name = 'TransportError';
    this.kind = kind;
    if (options?.code !== undefined) this.code = options.code;
  }
}

function apiKeyFor(ep: EndpointDef): string | null {
  if (ep.apiKeyEnv === null) return null;
  const v = process.env[ep.apiKeyEnv];
  return v === undefined || v.length === 0 ? null : v;
}

/**
 * 内部 ChatCall.tools（扁平 {name,description,parameters}）→ OpenAI 线格式
 * （{type:'function',function:{name,description,parameters}}）。
 * 上游网关按线格式校验，缺 `type` 字段直接 400（实测：OpenRouter/Nvidia
 * "missing field `type`"）。骨架内部形状不变，编解码归本层（MR §3.1）。
 */
export function toolsForWire(
  tools: ChatCall['tools'],
): Array<{ type: 'function'; function: { name: string; description?: string; parameters?: object } }> | undefined {
  if (tools === undefined) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), parameters: t.parameters ?? { type: 'object', properties: {} } },
  }));
}

/**
 * 工具名消毒 + 还原表。部分上游网关（实测 OpenRouter→Nvidia）只接受
 * `[a-zA-Z0-9_-]`，而契约词表（M5）用点分名（fs.read / browser.open）→ 直接
 * 上送 400 "invalid name"。消毒归 transport（编解码是 transport 的事，MR §3.1），
 * 响应侧按还原表把模型回显的名字映射回契约名，Runner/治理看到的仍是词表名。
 */
export function toolsForWireMapped(tools: ChatCall['tools']): {
  wire: ReturnType<typeof toolsForWire>;
  back: Map<string, string>;
} {
  if (tools === undefined) return { wire: undefined, back: new Map() };
  const back = new Map<string, string>();
  const used = new Set<string>();
  const wire = tools.map((t) => {
    let w = t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (used.has(w)) {
      let i = 1;
      while (used.has(`${w}-${i}`)) i += 1;
      w = `${w}-${i}`;
    }
    used.add(w);
    back.set(w, t.name);
    return {
      type: 'function' as const,
      function: { name: w, ...(t.description !== undefined ? { description: t.description } : {}), parameters: t.parameters ?? { type: 'object', properties: {} } },
    };
  });
  return { wire, back };
}

/** 响应侧还原：模型回显的 sanitized 工具名 → 契约词表名。 */
export function restoreToolCallNames(
  toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }>,
  back: Map<string, string>,
): void {
  for (const tc of toolCalls) {
    const w = tc.function?.name;
    if (w === undefined) continue;
    const orig = back.get(w);
    if (orig !== undefined && tc.function !== undefined) tc.function.name = orig;
  }
}

/**
 * 真实 HTTP transport：OpenAI 兼容 `/chat/completions` + SSE 流式。
 *
 * **仅 env 门控调用**：`createModelTransport()` 只在 DOTD_MODEL_TRANSPORT !== 'stub' 时
 * 返回本实例；stub 模式下本类永不被装配，因此不会发出任何请求。
 */
export class HttpTransport implements ModelTransport {
  async chat(call: ChatCall): Promise<ChatOutcome> {
    const key = apiKeyFor(call.endpoint);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    const mapped = toolsForWireMapped(call.tools);
    const res = await rawHttp('POST', `${call.endpoint.baseUrl}/chat/completions`, {
      headers,
      body: JSON.stringify({
        model: call.model,
        messages: call.messages,
        ...(mapped.wire !== undefined ? { tools: mapped.wire } : {}),
        ...(call.tool_choice !== undefined ? { tool_choice: call.tool_choice } : {}),
        ...(call.maxTokens !== undefined ? { max_tokens: call.maxTokens } : {}),
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        stream: false,
      }),
      connectMs: call.cap.connect_ms,
      idleMs: call.cap.idle_ms,
      totalMs: call.cap.total_ms,
      signal: call.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new HttpFailure(res.status, res.body, parseRetryAfterMs(res.headers['retry-after']));
    }
    return parseChatBody(res.body, res.latencyMs, mapped.back);
  }

  stream(call: ChatCall): AsyncIterable<ChatChunk> & { usage(): Promise<Usage | undefined> } {
    const key = apiKeyFor(call.endpoint);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    let usage: Usage | undefined;
    const self = this;
    const mapped = toolsForWireMapped(call.tools);
    async function* gen(): AsyncGenerator<ChatChunk> {
      const res = await rawHttp('POST', `${call.endpoint.baseUrl}/chat/completions`, {
        headers,
        body: JSON.stringify({
          model: call.model,
          messages: call.messages,
          ...(mapped.wire !== undefined ? { tools: mapped.wire } : {}),
          ...(call.tool_choice !== undefined ? { tool_choice: call.tool_choice } : {}),
          ...(call.maxTokens !== undefined ? { max_tokens: call.maxTokens } : {}),
          ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
          stream: true,
        }),
        connectMs: call.cap.connect_ms,
        idleMs: call.cap.idle_ms,
        totalMs: call.cap.total_ms,
        signal: call.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new HttpFailure(res.status, res.body, parseRetryAfterMs(res.headers['retry-after']));
      }
      // SSE 解析：data: {...} 行；[DONE] 结束。
      const queue: string[] = res.body.split('\n');
      for (const line of queue) {
        const t = line.trim();
        if (t.length === 0 || !t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') break;
        let json: {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        try {
          json = JSON.parse(payload) as typeof json;
        } catch {
          throw new BadProtocolError('SSE data 行不是合法 JSON');
        }
        const u = json.usage;
        if (u !== undefined && u !== null) {
          const cached = usageCacheRead(u);
          usage = {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
          };
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta !== undefined && delta.length > 0) yield { delta };
      }
      yield { delta: '', done: true };
    }
    void self;
    return {
      [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator](),
      async usage(): Promise<Usage | undefined> {
        return usage;
      },
    };
  }

  async get(ep: EndpointDef, url: string, opts: { timeoutMs: number }): Promise<GetOutcome> {
    const key = apiKeyFor(ep);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    const res = await rawHttp('GET', url, {
      headers,
      connectMs: opts.timeoutMs,
      idleMs: opts.timeoutMs,
      totalMs: opts.timeoutMs,
    });
    let json: unknown;
    try {
      json = JSON.parse(res.body) as unknown;
    } catch {
      json = undefined;
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json,
      text: res.body.slice(0, 2000),
      latencyMs: res.latencyMs,
      error: res.status >= 200 && res.status < 300 ? undefined : `HTTP ${res.status}`,
    };
  }

  async metadata(q: MetadataQuery): Promise<{ ok: boolean; items: ReconItem[]; error?: string }> {
    const res = await rawHttp('GET', q.url, {
      headers: { accept: 'application/vnd.github+json' },
      connectMs: 5000,
      idleMs: 10_000,
      totalMs: 20_000,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, items: [], error: `HTTP ${res.status}` };
    }
    try {
      const parsed = JSON.parse(res.body) as unknown;
      if (q.kind === 'github_curated') {
        // api.github.com contents/：{ content: "<base64>", encoding: 'base64' }
        const obj = parsed as { content?: string; encoding?: string };
        if (obj.content === undefined || obj.encoding !== 'base64') {
          return { ok: false, items: [], error: 'github contents 响应缺 base64 content' };
        }
        const text = Buffer.from(obj.content, 'base64').toString('utf8');
        return { ok: true, items: parseCuratedYaml(text) };
      }
      // openrouter_models：{ data: [{ id: 'vendor/model:free', ... }] }
      const obj = parsed as { data?: Array<{ id?: string }> };
      const items: ReconItem[] = [];
      for (const m of obj.data ?? []) {
        if (m.id === undefined) continue;
        if (q.filter !== undefined && !m.id.includes(q.filter)) continue;
        const base = 'https://openrouter.ai/api/v1';
        items.push({
          base_url: base,
          model: m.id,
          api_key_note: 'OPENROUTER_API_KEY',
          evidence: { source_url: 'https://openrouter.ai/api/v1/models', claimed: { id: m.id } },
        });
      }
      return { ok: true, items };
    } catch (cause) {
      return { ok: false, items: [], error: String(cause) };
    }
  }
}

/** HTTP 层失败（携带 status 与 Retry-After，供 §4.1 分类）。 */
export class HttpFailure extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, body: string, retryAfterMs: number | null) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'HttpFailure';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 协议错误（MR §4.1：非 JSON、缺 choices、tool_call 参数非法）。 */
export class BadProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BadProtocolError';
  }
}

/**
 * 零用量空壳（迁移自 PilotDeck 的 "zero-usage retry"）。
 *
 * 症状：HTTP 200、有 choices，但**既没有正文、也没有工具调用，且 completion_tokens
 * 为 0 或整个 usage 缺失**。provider 看似成功，实际什么都没生成。
 *
 * 为什么必须单独一个错误类型、不能并进 BadProtocolError：两者的下游判决不同。
 * bad_protocol 在 primary 轨整链收场时会把 `capabilities.tool_calling` 记 'no'
 * （§4.1）；而空壳**说明不了任何关于工具能力的事**——provider 是过载/降级，
 * 不是不会调工具。混成一类会让一次 OpenRouter 免费路由抖动把好端点永久踢出 primary。
 *
 * 实测依据（记忆 `openrouter-free-route-empty-shell`）：OpenRouter 免费路由约四成
 * 带工具负载的调用回 200 空壳。dotd 此前只挡了"无 choices"那一种（parseChatBody 抛
 * BadProtocolError），**这一种会被当成成功**：breaker 记 ok、Runner 的 feedLlm 见
 * toolCalls 为空就把 doneFlag 置真、summaryText 留空 → 任务以"任务完成"静默收口。
 */
export class EmptyResponseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmptyResponseError';
  }
}

/**
 * 从 usage 对象里取缓存命中 token 数（认不出 → undefined，即"这家不报缓存"）。
 *
 * 只认两种形状，都是 OpenAI 兼容生态里事实上通用的：
 * - `prompt_tokens_details.cached_tokens`（OpenAI / OpenRouter / vLLM）；
 * - 顶层 `cache_read_input_tokens`（Anthropic 原生形状，部分代理会重打成它）。
 *
 * 认不出时返回 undefined 而不是 0：本地 Colibrì 这类没有缓存概念的引擎，
 * 记 0 会让"不支持缓存"和"支持但没命中"在缓存命中率上变成同一个数。
 */
export function usageCacheRead(u: unknown): number | undefined {
  if (u === null || typeof u !== 'object') return undefined;
  const obj = u as Record<string, unknown>;
  const details = obj.prompt_tokens_details;
  if (details !== null && typeof details === 'object') {
    const n = (details as Record<string, unknown>).cached_tokens;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
  }
  const top = obj.cache_read_input_tokens;
  if (typeof top === 'number' && Number.isFinite(top) && top >= 0) return top;
  return undefined;
}

/**
 * 是否零用量空壳（见 EmptyResponseError 的判据）。
 *
 * 三条同时满足才算，故意保守——任何一条不满足就认它是正常响应：
 * 1. 无工具调用（纯工具轮本来就没有正文，那是正常形状）；
 * 2. 正文 trim 后为空；
 * 3. completion_tokens 为 0 或 usage 整体缺失。
 *
 * 第 3 条是防止误伤的闸门：provider 真做了功（报了非零 completion_tokens）却回了
 * 空正文，那是推理类模型把内容放在别的字段，或一个合法的空回答——重试它只是白花钱。
 */
export function isEmptyShellResponse(resp: ChatResponse, usage: Usage | undefined): boolean {
  if (resp.toolCalls !== undefined && resp.toolCalls.length > 0) return false;
  if (resp.content.trim().length > 0) return false;
  return usage === undefined || usage.completionTokens === 0;
}

function parseChatBody(body: string, latencyMs: number, nameBack?: Map<string, string>): ChatOutcome {
  void latencyMs;
  let json: {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  };
  try {
    json = JSON.parse(body) as typeof json;
  } catch (cause) {
    throw new BadProtocolError('响应体不是合法 JSON', { cause });
  }
  const choice = json.choices?.[0];
  if (choice === undefined) {
    // OpenRouter 实测会在 200 里返回无 choices 的壳（Nvidia 免费路由限流/降级时
    // 只回 id+空 message，或回 {error:{...}}）。带上错误字段与体片段才能定位。
    const extra = (json as { error?: { message?: string } }).error?.message;
    throw new BadProtocolError(
      `响应缺 choices${extra !== undefined ? `（upstream error: ${String(extra).slice(0, 160)}）` : ''}：${body.slice(0, 200)}`,
    );
  }
  const msg = choice.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc, i) => {
    const args = tc.function?.arguments ?? '';
    if (args.length > 0) {
      try {
        JSON.parse(args);
      } catch (cause) {
        throw new BadProtocolError('tool_call.arguments 不是合法 JSON', { cause });
      }
    }
    const wireName = tc.function?.name ?? '';
    // 线格式消毒的响应侧还原（请求 tools 送的是 sanitized 名，回显同名 → 映回词表名）
    const name = nameBack !== undefined && nameBack.has(wireName) ? (nameBack.get(wireName) as string) : wireName;
    return { id: tc.id ?? `call_${i}`, name, arguments: args };
  });
  const u = json.usage;
  const cached = usageCacheRead(u);
  return {
    response: { content: msg.content ?? '', toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
    usage:
      u === undefined || u === null
        ? undefined
        : {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
          },
  };
}

/** 解析策展清单 YAML（free-models.yml 同构，极简映射解析）。 */
function parseCuratedYaml(text: string): ReconItem[] {
  const items: ReconItem[] = [];
  const lines = text.split('\n');
  let baseUrl = '';
  let model = '';
  let apiKeyNote: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^-\s+(\S+):\s*(.*)$/.exec(line);
    if (m !== null) {
      if (baseUrl.length > 0 && model.length > 0) {
        items.push({ base_url: baseUrl, model, api_key_note: apiKeyNote });
      }
      baseUrl = '';
      model = '';
      apiKeyNote = undefined;
      const k = m[1]!;
      const v = stripYamlScalar(m[2] ?? '');
      if (k === 'base_url') baseUrl = v;
      else if (k === 'api_key_env') apiKeyNote = v;
      continue;
    }
    const kv = /^(\S+):\s*(.*)$/.exec(line);
    if (kv !== null) {
      const k = kv[1]!;
      const v = stripYamlScalar(kv[2] ?? '');
      if (k === 'base_url') baseUrl = v;
      else if (k === 'api_key_env') apiKeyNote = v;
      else if (k === 'model') model = v;
      else if (k === 'models') model = '';
    }
  }
  if (baseUrl.length > 0 && model.length > 0) {
    items.push({ base_url: baseUrl, model, api_key_note: apiKeyNote });
  }
  return items;
}

function stripYamlScalar(v: string): string {
  const t = v.replace(/\s+#.*$/, '').trim();
  if (t === 'null' || t === '~' || t.length === 0) return '';
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// ═══════════════════════════════════════════════════════════════════
// 3. 工厂（env 门控）
// ═══════════════════════════════════════════════════════════════════

/**
 * 按 env 造 transport：
 * - `DOTD_MODEL_TRANSPORT=stub` → StubTransport（零网络请求；脚本可由
 *   `DOTD_MODEL_STUB_SCRIPT`（JSON 数组）注入，供 CLI/冒烟回放）。
 * - 其它值或缺省 → HttpTransport（真实 OpenRouter HTTP 路径，**会发网络请求**）。
 */
export function createModelTransport(env: NodeJS.ProcessEnv = process.env): ModelTransport {
  if (isStubTransport(env)) {
    const raw = env.DOTD_MODEL_STUB_SCRIPT;
    let script: StubScriptItem[] = [];
    if (raw !== undefined && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) script = parsed as StubScriptItem[];
      } catch {
        // 坏脚本 = 空脚本（耗尽即抛错，不静默成功）
      }
    }
    return new StubTransport({ script });
  }
  return new HttpTransport();
}
