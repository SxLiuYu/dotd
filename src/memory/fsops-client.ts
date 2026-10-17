/**
 * src/memory/fsops-client.ts —— 执行面 home 文件系统桥客户端（契约 S4' / M4）。
 *
 * 铁律（memory.md §3.1）：
 * - 铁律 A：文件记忆的写与整理/归档发生在容器内；宿主机 daemon 不直接 walk 卷目录。
 * - 铁律 B：daemon 侧唯一"读"路径 = 经 agent-runtime 的 home 文件系统桥
 *   （execution.md §5 HTTP API，:9223，Bearer token 鉴权）。
 *
 * 接缝（接缝契约 S4'/M4，本契约裁定为 EX 必须承接的新端点，阶段一交付）：
 *   POST /fs/ops {op:'read'|'list'|'stat'|'rename', path, target?, dotId}
 *   Bearer 鉴权、与 fs.* 同沙箱、rename 限 home 内、仅宿主 token 可调（不进模型工具面）。
 *
 * 降级语义（§3.1 末 / §4.2）：桥不可用 → 本次注入仅 SQLite 部分并在 messages 记
 * kind='system_error' 注记 + memory_missed=1，不阻塞任务。因此本客户端的每个方法
 * 都返回 null / 空数组而非抛错；只有"协议错误"（桥返回了无法解析的形状）才抛，
 * 由调用方转成降级。
 */

export type FsOpsOp = 'read' | 'list' | 'stat' | 'rename';

export interface FsOpsListEntry {
  /** home 相对路径（目录项）。 */
  path: string;
  name: string;
  /** 目录项类型（桥的 list 返回形状；实现按 execution.md §5.2 对齐）。 */
  type: 'file' | 'dir';
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface FsOpsStat {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface FsOpsBridge {
  /** 实现名（诊断用，如 'http' | 'stub'）。 */
  readonly kind: string;
  /** 桥是否可用（不可用时所有操作降级为空/null，绝不抛）。 */
  available(): Promise<boolean> | boolean;
  read(dotId: string, path: string): Promise<string | null>;
  list(dotId: string, path: string): Promise<FsOpsListEntry[]>;
  stat(dotId: string, path: string): Promise<FsOpsStat | null>;
  rename(dotId: string, from: string, to: string): Promise<boolean>;
}

export interface FsOpsHttpOptions {
  /** agent-runtime 基址（execution.md §5：默认 http://127.0.0.1:9223）。 */
  baseUrl?: string;
  /** 宿主 Bearer token（仅宿主 token 可调，S4'）。 */
  token?: string;
  /** 单次请求超时 ms。 */
  timeoutMs?: number;
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:9223';

/**
 * 真实桥客户端（HTTP + Bearer）。任何网络/协议失败都降级为 null / 空数组 /
 * false——记忆模块"不炸主循环"的错误约定（§8）。
 */
export class FsOpsHttpBridge implements FsOpsBridge {
  readonly kind = 'http';
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FsOpsHttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.DOTD_AGENT_RUNTIME_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.token = opts.token ?? process.env.DOTD_AGENT_RUNTIME_TOKEN ?? null;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(
    dotId: string,
    op: FsOpsOp,
    path: string,
    target?: string,
  ): Promise<unknown | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
      const res = await this.fetchImpl(`${this.baseUrl}/fs/ops`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ op, path, target, dotId }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (typeof body !== 'object' || body === null) return null;
      return body as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  available(): boolean {
    // 保守：可达性探测由调用方按需发一次 read 判定；此处只报告"配了基址"。
    return this.baseUrl.length > 0;
  }

  async read(dotId: string, path: string): Promise<string | null> {
    const body = await this.call(dotId, 'read', path);
    if (body === null) return null;
    const text = (body as { content?: unknown }).content;
    if (typeof text === 'string') return text;
    if (typeof text === 'object' && text !== null && typeof (text as { text?: unknown }).text === 'string') {
      return (text as { text: string }).text;
    }
    return null;
  }

  async list(dotId: string, path: string): Promise<FsOpsListEntry[]> {
    const body = await this.call(dotId, 'list', path);
    if (body === null) return [];
    const entries = (body as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    const out: FsOpsListEntry[] = [];
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const p = typeof r.path === 'string' ? r.path : typeof r.name === 'string' ? r.name : null;
      if (p === null) continue;
      out.push({
        path: p,
        name: typeof r.name === 'string' ? r.name : p,
        type: r.type === 'dir' ? 'dir' : 'file',
        sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : undefined,
        mtimeMs: typeof r.mtimeMs === 'number' ? r.mtimeMs : undefined,
      });
    }
    return out;
  }

  async stat(dotId: string, path: string): Promise<FsOpsStat | null> {
    const body = await this.call(dotId, 'stat', path);
    if (body === null) return null;
    const st = (body as { stat?: unknown }).stat ?? body;
    if (typeof st !== 'object' || st === null) return null;
    const r = st as Record<string, unknown>;
    if (typeof r.sizeBytes !== 'number') return null;
    return {
      path: typeof r.path === 'string' ? r.path : path,
      sizeBytes: r.sizeBytes,
      mtimeMs: typeof r.mtimeMs === 'number' ? r.mtimeMs : 0,
      isDir: r.isDir === true,
    };
  }

  async rename(dotId: string, from: string, to: string): Promise<boolean> {
    const body = await this.call(dotId, 'rename', from, to);
    if (body === null) return false;
    const ok = (body as { ok?: unknown }).ok;
    return ok !== false;
  }
}

/** 无桥时的占位（容器未跑/桥不可用）：一切操作降级为空。 */
export const NULL_FS_OPS_BRIDGE: FsOpsBridge = {
  kind: 'none',
  available: () => false,
  read: async () => null,
  list: async () => [],
  stat: async () => null,
  rename: async () => false,
};
