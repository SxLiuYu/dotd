/**
 * src/router/pool.ts —— Tier3 策展池（free-models.yml）两级测试与合格证。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §4.4 第 1 条 health：每 30min 心跳 `pool.probe.${id}` light 任务触发，
 *   `GET {base_url}/models` 5s 超时，期望 200 且 JSON 数组含声明模型名。
 *   失败 → 向该端点 light/primary 两轨各记一个窗口样本，kind=`pool_unverified`
 *   （常规退避起步 60s；**不是** engine_unavailable——定义域见 §4.1 表边界裁决）。
 * - §4.4 第 2 条 tool_roundtrip：health 通过后、且 last_verified 过期或从未验、
 *   或被首次选为 primary 候选时按需执行。两轮（tool_choice 定点 + auto 续话），
 *   每 round 20s；任一轮超时/格式非法 → 失败，kind=bad_protocol。
 * - §4.4 预算：`ensureToolQualified(ep, deadline)` 在 `min(40s, remaining/2)` 内现测。
 * - §4.4 记账：测试请求计入 breaker_sample（失败照熔断），**不计 model_call_log**
 *   （probe 不是业务调用，记 pool_probe_result 即可）。
 * - §4.4 频率守卫：同端点 tool_roundtrip 每 15min 至多一次。
 * - §4.6 第 4 步：批准后写 free-models.yml（文件写幂等：同 base_url+model 已存在则只
 *   touch updated_at，不重复追加）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EndpointDef, Track } from '../shared/contracts.ts';
import type { FreeModelEntry, FreeModelsFile, ModelTransport } from './types.ts';

/** health 探测超时（§4.4 第 1 条：5s）。 */
export const POOL_HEALTH_TIMEOUT_MS = 5000;
/** tool_roundtrip 每 round 预算（§4.4：每 round 20s）。 */
export const POOL_ROUNDTRIP_ROUND_MS = 20_000;
/** ensureToolQualified 现测上限（§4.4：min(40s, remaining/2)）。 */
export const POOL_QUALIFY_BUDGET_MS = 40_000;
/** 同端点 tool_roundtrip 频率守卫（§4.4：每 15min 至多一次）。 */
export const POOL_ROUNDTRIP_GUARD_MS = 15 * 60_000;
/** 合格证默认过期时间（§2.2 verify_staleness_ms 缺省 24h）。 */
export const POOL_VERIFY_STALENESS_DEFAULT_MS = 86_400_000;

/** 微型工具往返测试的探针工具（§4.4 逐字；ToolSpec 形状，ChatCall.tools 直接用）。 */
const PROBE_TOOL = {
  name: 'echo',
  description: '原样回显给定文本',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};
const PROBE_TEXT = 'ping-dotd';

export interface PoolStore {
  db: DatabaseSync;
  now?: () => number;
}

/**
 * 池管理器：文件加载 + 两级探测 + 合格证。
 *
 * 合格证的事实源 = `free-models.yml` 的 `last_verified`（§4.4 末句："config 层把该条目
 * last_verified 写为当前时间（原子写文件 + 同步内存态）"）。
 */
export class PoolManager {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  /** 内存态（与文件同步；写文件失败时保留内存态并标记待重写）。 */
  private file: FreeModelsFile = { version: 1, updated_at: null, models: [] };
  private filePath: string | null = null;
  /** 上次 tool_roundtrip 时刻（频率守卫）。 */
  private lastRoundtripAt = new Map<string, number>();
  /** 文件写失败的重试队列（§4.7 启动对账第 2 步：1min 心跳重试写文件）。 */
  private readonly pendingFileWrites = new Set<string>();

  constructor(store: PoolStore) {
    this.db = store.db;
    this.now = store.now ?? Date.now;
  }

  // ── 文件读写 ─────────────────────────────────────────────────────

  /** 加载 free-models.yml（首次或 reload）。文件不存在 = 空池。 */
  loadFile(path: string): void {
    this.filePath = path;
    if (!existsSync(path)) {
      this.file = { version: 1, updated_at: null, models: [] };
      return;
    }
    const parsed = parseFreeModelsYaml(readFileSync(path, 'utf8'));
    this.file = parsed;
  }

  get fileLoaded(): boolean {
    return this.filePath !== null;
  }

  /** 池条目 → EndpointDef（tier 3）。 */
  poolEndpoints(): EndpointDef[] {
    const out: EndpointDef[] = [];
    for (const m of this.file.models) {
      const model = m.models[0] ?? '';
      const ep: EndpointDef = {
        id: m.id,
        tier: 3,
        baseUrl: m.base_url,
        apiKeyEnv: m.api_key_env,
        models: { primary: model, light: model },
        style: m.style,
        enabled: true,
        timeouts: { connect_ms: 5000, idle_ms: 20_000, total_ms: 60_000 },
        emergencyEligible: m.emergency_eligible,
      };
      if (m.capabilities !== undefined) ep.capabilities = m.capabilities;
      if (m.rate !== undefined) ep.rate = m.rate;
      if (m.last_verified !== null) ep.lastVerifiedAt = m.last_verified;
      out.push(ep);
    }
    return out;
  }

  /** 当前是否持有新鲜合格证（§4.4 ensureToolQualified 语义第一分支）。 */
  hasFreshCertification(entry: FreeModelEntry): boolean {
    if (entry.last_verified === null) return false;
    const staleness = entry.verify_staleness_ms || POOL_VERIFY_STALENESS_DEFAULT_MS;
    return this.now() - entry.last_verified < staleness;
  }

  findEntry(endpointId: string): FreeModelEntry | undefined {
    return this.file.models.find((m) => m.id === endpointId);
  }

  /**
   * §4.6 第 4 步：把批准候选写入 free-models.yml。
   * 幂等（同 base_url+model 已存在则只 touch updated_at，不重复追加）；
   * 写失败保留在重试队列，由心跳重试（§4.7 启动对账第 2 步）。
   */
  addApprovedCandidate(entry: {
    id: string;
    base_url: string;
    model: string;
    api_key_env: string | null;
  }): { ok: boolean; error?: string; duplicate: boolean } {
    if (this.filePath === null) {
      return { ok: false, error: 'free_models_file 未加载', duplicate: false };
    }
    const dup = this.file.models.some(
      (m) => m.base_url === entry.base_url && m.models.includes(entry.model),
    );
    if (!dup) {
      this.file.models.push({
        id: entry.id,
        base_url: entry.base_url,
        api_key_env: entry.api_key_env,
        models: [entry.model],
        style: 'openai',
        capabilities: { tool_calling: 'unknown', context: 0 },
        last_verified: null,
        verify_staleness_ms: POOL_VERIFY_STALENESS_DEFAULT_MS,
        emergency_eligible: true, // 池内条目默认 true——池本身就是应急档（§2.2）
      });
    }
    this.file.updated_at = new Date(this.now()).toISOString();
    try {
      this.writeFileAtomic();
      this.pendingFileWrites.delete(entry.id);
      return { ok: true, duplicate: dup };
    } catch (cause) {
      this.pendingFileWrites.add(entry.id);
      return { ok: false, error: String(cause), duplicate: dup };
    }
  }

  /** 心跳重试写文件（§4.7：失败 1min 后重试，成功即出队）。 */
  retryPendingFileWrites(): string[] {
    const done: string[] = [];
    if (this.filePath === null || this.pendingFileWrites.size === 0) return done;
    try {
      this.writeFileAtomic();
      for (const id of this.pendingFileWrites) done.push(id);
      this.pendingFileWrites.clear();
    } catch {
      // 磁盘满/EACCES：留队列下次再试
    }
    return done;
  }

  pendingFileWriteCount(): number {
    return this.pendingFileWrites.size;
  }

  /** 文件中的 base_url+model 集合（§4.7 启动对账第 3 步双向核对）。 */
  filePairs(): Array<{ base_url: string; model: string }> {
    const out: Array<{ base_url: string; model: string }> = [];
    for (const m of this.file.models) for (const model of m.models) out.push({ base_url: m.base_url, model });
    return out;
  }

  private writeFileAtomic(): void {
    if (this.filePath === null) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, serializeFreeModelsYaml(this.file), 'utf8');
  }

  // ── 探测（§4.4 两级测试）─────────────────────────────────────────

  /**
   * health 探测：`GET {base_url}/models`，5s，期望 200 且 JSON 数组含声明模型名。
   * 落 `pool_probe_result(probe_kind='health')`。
   */
  async probeHealth(
    transport: ModelTransport,
    ep: EndpointDef,
  ): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = this.now();
    const r = await transport.get(ep, `${ep.baseUrl}/models`, { timeoutMs: POOL_HEALTH_TIMEOUT_MS });
    const latencyMs = this.now() - started;
    const ok =
      r.ok &&
      r.status >= 200 &&
      r.status < 300 &&
      containsModel(r.json, ep.models.light ?? ep.models.primary ?? '');
    const detail = ok
      ? 'health 通过（/models 含声明模型）'
      : `health 失败：HTTP ${r.status}${r.error !== undefined ? ` ${r.error}` : ''}`;
    this.recordProbe(ep.id, 'health', ok, { latency_ms: latencyMs, status: r.status });
    return { ok, detail, latencyMs };
  }

  /**
   * tool_roundtrip 微型工具调用往返测试（§4.4 第 2 条逐字）。
   *
   * round 1：tool_choice 定点 echo，通过判据 = tool_calls[0].function.name==='echo'
   *   且 JSON.parse(arguments).text==='ping-dotd'。
   * round 2（条件）：把 round1 的 tool result 发回，tool_choice='auto'，
   *   通过判据 = finish_reason 正常、content 非空。
   * 任一轮超时/格式非法 → 失败，kind=bad_protocol。
   *
   * 成功 → 写合格证（last_verified=now，文件原子写 + 同步内存态）。
   */
  async toolRoundtrip(
    transport: ModelTransport,
    ep: EndpointDef,
    budgetMs: number = POOL_ROUNDTRIP_ROUND_MS,
  ): Promise<{ ok: boolean; detail: string; kind?: 'bad_protocol' | 'timeout' }> {
    const started = this.now();
    const last = this.lastRoundtripAt.get(ep.id) ?? 0;
    if (this.now() - last < POOL_ROUNDTRIP_GUARD_MS) {
      return { ok: false, detail: `频率守卫：${POOL_ROUNDTRIP_GUARD_MS / 60000}min 内已测过` };
    }
    this.lastRoundtripAt.set(ep.id, this.now());
    const model = ep.models.primary ?? ep.models.light ?? '';
    const cap = { connect_ms: 5000, idle_ms: budgetMs, total_ms: budgetMs };

    // round 1
    let r1;
    try {
      r1 = await transport.chat({
        endpoint: ep,
        track: 'primary',
        model,
        messages: [{ role: 'user', content: `Call the echo tool with text '${PROBE_TEXT}'.` }],
        tools: [PROBE_TOOL],
        tool_choice: 'required',
        temperature: 0,
        maxTokens: 64,
        cap,
        probe: true,
      });
    } catch (cause) {
      const timedOut = isTimeoutish(cause);
      this.recordProbe(ep.id, 'tool_roundtrip', false, {
        latency_ms: this.now() - started,
        round: 1,
        error: String(cause),
      });
      return { ok: false, detail: `round1 失败：${String(cause)}`, kind: timedOut ? 'timeout' : 'bad_protocol' };
    }
    const tc = r1.response.toolCalls?.[0];
    const nameOk = tc?.name === 'echo';
    let argsOk = false;
    let echoed: string | null = null;
    if (tc !== undefined) {
      try {
        const args = JSON.parse(tc.arguments) as { text?: unknown };
        echoed = typeof args.text === 'string' ? args.text : null;
        argsOk = args.text === PROBE_TEXT;
      } catch {
        argsOk = false;
      }
    }
    if (!nameOk || !argsOk) {
      this.recordProbe(ep.id, 'tool_roundtrip', false, {
        latency_ms: this.now() - started,
        round: 1,
        tool_name: tc?.name ?? null,
        args_valid: argsOk,
      });
      return {
        ok: false,
        detail: `round1 未过判据（name=${tc?.name ?? 'none'} text=${fmtEcho(echoed)}）`,        kind: 'bad_protocol',
      };
    }

    // round 2：把 tool result 发回，tool_choice='auto'
    try {
      const r2 = await transport.chat({
        endpoint: ep,
        track: 'primary',
        model,
        messages: [
          { role: 'user', content: `Call the echo tool with text '${PROBE_TEXT}'.` },
          {
            role: 'assistant',
            content: '',
            tool_call_id: tc?.id ?? 'call_probe_1',
            name: 'echo',
          },
          { role: 'tool', content: PROBE_TEXT, tool_call_id: tc?.id ?? 'call_probe_1' },
        ],
        tools: [PROBE_TOOL],
        tool_choice: 'auto',
        temperature: 0,
        maxTokens: 64,
        cap,
        probe: true,
      });
      if (r2.response.content.trim().length === 0) {
        this.recordProbe(ep.id, 'tool_roundtrip', false, {
          latency_ms: this.now() - started,
          round: 2,
          error: 'content 为空',
        });
        return { ok: false, detail: 'round2 content 为空（不能吃工具结果继续说话）', kind: 'bad_protocol' };
      }
    } catch (cause) {
      const timedOut = isTimeoutish(cause);
      this.recordProbe(ep.id, 'tool_roundtrip', false, {
        latency_ms: this.now() - started,
        round: 2,
        error: String(cause),
      });
      return { ok: false, detail: `round2 失败：${String(cause)}`, kind: timedOut ? 'timeout' : 'bad_protocol' };
    }

    this.recordProbe(ep.id, 'tool_roundtrip', true, {
      latency_ms: this.now() - started,
      rounds: 2,
      tool_name: 'echo',
      args_valid: true,
    });
    this.certify(ep.id);
    return { ok: true, detail: 'tool_roundtrip 通过（2 轮）' };
  }

  /** 写合格证：last_verified=now（原子写文件 + 同步内存态，§4.4 末句）。 */
  private certify(endpointId: string): void {
    const entry = this.findEntry(endpointId);
    if (entry === undefined) return;
    entry.last_verified = this.now();
    this.file.updated_at = new Date(this.now()).toISOString();
    try {
      this.writeFileAtomic();
      this.pendingFileWrites.delete(endpointId);
    } catch {
      this.pendingFileWrites.add(endpointId);
    }
  }

  /** 写 pool_probe_result（只留每端点最新 + 7 天历史，§3.2 体积回收）。 */
  private recordProbe(
    endpointId: string,
    kind: 'health' | 'tool_roundtrip',
    ok: boolean,
    detail: Record<string, unknown>,
  ): void {
    const ts = this.now();
    this.db
      .prepare(
        'INSERT INTO pool_probe_result (endpoint_id, probe_kind, ok, detail, ts) VALUES (?,?,?,?,?)',
      )
      .run(endpointId, kind, ok ? 1 : 0, JSON.stringify(detail), ts);
    // 每端点保留最新 1 条 + 7 天内历史
    this.db
      .prepare(
        `DELETE FROM pool_probe_result WHERE endpoint_id = ?
         AND ts < ?
         AND id NOT IN (SELECT MAX(id) FROM pool_probe_result WHERE endpoint_id = ?)`,
      )
      .run(endpointId, ts - 7 * 86_400_000, endpointId);
  }

  /** janitor：探测历史回收（返回删除行数）。 */
  janitor(): number {
    const r = this.db
      .prepare(
        `DELETE FROM pool_probe_result WHERE ts < ?
         AND id NOT IN (SELECT MAX(id) FROM pool_probe_result GROUP BY endpoint_id)`,
      )
      .run(this.now() - 7 * 86_400_000);
    return Number(r.changes);
  }
}

function containsModel(json: unknown, model: string): boolean {
  if (model.length === 0) return false;
  const data = (json as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(data)) return false;
  return data.some((m) => {
    const id = (m as { id?: unknown } | undefined)?.id;
    return id === model;
  });
}

function isTimeoutish(err: unknown): boolean {
  const e = err as { kind?: string; message?: string } | null;
  if (e?.kind === 'timeout') return true;
  return e?.message !== undefined && /timeout|timed out/i.test(e.message);
}

function fmtEcho(t: string | null): string {
  return t === null ? 'null' : JSON.stringify(t);
}

// ── free-models.yml 解析/序列化（极简映射，不引第三方 YAML 库）────────

/** 解析 free-models.yml（MR §2.2 条目形状）。 */
export function parseFreeModelsYaml(text: string): FreeModelsFile {
  const out: FreeModelsFile = { version: 1, updated_at: null, models: [] };
  const lines = text.split('\n');
  let inModels = false;
  let cur: FreeModelEntry | null = null;
  const flush = (): void => {
    if (cur !== null) out.models.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    const noComment = raw.replace(/(^|\s)#.*$/, '');
    if (noComment.trim().length === 0) continue;
    const top = /^(\S+):\s*(.*)$/.exec(noComment);
    if (top !== null && !/^\s/.test(noComment)) {
      const k = top[1]!;
      const v = top[2] ?? '';
      if (k === 'models') {
        flush();
        inModels = true;
        continue;
      }
      if (inModels) inModels = false;
      if (k === 'version') out.version = Number(v) || 1;
      if (k === 'updated_at') out.updated_at = v === 'null' || v.length === 0 ? null : v;
      continue;
    }
    if (!inModels) continue;
    const item = /^\s*-\s+(\S+):\s*(.*)$/.exec(noComment);
    if (item !== null) {
      flush();
      cur = newEntry();
      if (item[1] === 'models' && (item[2] ?? '').trim().startsWith('[')) {
        cur.models = parseModelList(item[2] ?? '');
        continue;
      }
      applyField(cur, item[1] as keyof FreeModelEntry, item[2] ?? '');
      continue;
    }
    const kv = /^\s+(\S+):\s*(.*)$/.exec(noComment);
    if (kv !== null && cur !== null) {
      const key = kv[1] as keyof FreeModelEntry;
      // models: [a, b] 行内数组
      if (key === 'models' && (kv[2] ?? '').trim().startsWith('[')) {
        cur.models = parseModelList(kv[2] ?? '');
        continue;
      }
      applyField(cur, key, kv[2] ?? '');
    }
  }
  flush();
  return out;
}

function newEntry(): FreeModelEntry {
  return {
    id: '',
    base_url: '',
    api_key_env: null,
    models: [],
    style: 'openai',
    capabilities: { tool_calling: 'unknown', context: 0 },
    rate: undefined,
    last_verified: null,
    verify_staleness_ms: POOL_VERIFY_STALENESS_DEFAULT_MS,
    emergency_eligible: true,
  };
}

function applyField(entry: FreeModelEntry, key: keyof FreeModelEntry, value: string): void {
  const v = stripScalar(value);
  switch (key) {
    case 'id':
      entry.id = v;
      break;
    case 'base_url':
      entry.base_url = v;
      break;
    case 'api_key_env':
      entry.api_key_env = v.length === 0 || v === 'none' ? null : v;
      break;
    case 'style':
      entry.style = 'openai';
      break;
    case 'last_verified':
      entry.last_verified = v.length === 0 || v === 'null' ? null : Date.parse(v);
      break;
    case 'verify_staleness_ms':
      entry.verify_staleness_ms = Number(v) || POOL_VERIFY_STALENESS_DEFAULT_MS;
      break;
    case 'emergency_eligible':
      entry.emergency_eligible = v !== 'false';
      break;
    default:
      break;
  }
}

/** models: [...] 行内数组（极简：方括号列表）。 */
export function parseModelList(value: string): string[] {
  const t = value.trim();
  if (!t.startsWith('[')) return [];
  return t
    .slice(1, t.endsWith(']') ? -1 : undefined)
    .split(',')
    .map((s) => stripScalar(s))
    .filter((s) => s.length > 0);
}

function stripScalar(v: string): string {
  const t = v.replace(/\s+#.*$/, '').trim();
  if (t === 'null' || t === '~') return '';
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 序列化回 free-models.yml（幂等写：同 base_url+model 不重复追加，§4.6 第 4 步）。 */
export function serializeFreeModelsYaml(file: FreeModelsFile): string {
  const lines: string[] = [];
  lines.push('# free-models.yml —— Tier 3 策展免费池（MR §2.2；由 ModelRouter 维护）');
  lines.push(`version: ${file.version}`);
  lines.push(`updated_at: ${file.updated_at ?? 'null'}`);
  lines.push('models:');
  for (const m of file.models) {
    lines.push(`  - id: ${m.id}`);
    lines.push(`    base_url: ${m.base_url}`);
    lines.push(`    api_key_env: ${m.api_key_env ?? 'none'}`);
    lines.push(`    models: [${m.models.join(', ')}]`);
    lines.push(`    style: ${m.style}`);
    lines.push(
      `    capabilities: { tool_calling: ${m.capabilities?.tool_calling ?? 'unknown'}, context: ${m.capabilities?.context ?? 0} }`,
    );
    if (m.rate !== undefined) lines.push(`    rate: { rpm: ${m.rate.rpm}, rpd: ${m.rate.rpd} }`);
    lines.push(
      `    last_verified: ${m.last_verified === null ? 'null' : new Date(m.last_verified).toISOString()}`,
    );
    lines.push(`    verify_staleness_ms: ${m.verify_staleness_ms}`);
    lines.push(`    emergency_eligible: ${m.emergency_eligible}`);
  }
  lines.push('');
  return lines.join('\n');
}
