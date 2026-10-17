/**
 * src/exec/mcp-client.ts —— MCP 客户端（P2-1：工具扩展点）。
 *
 * ## 存在的理由
 * dotd 的工具面原本是**封闭契约**：11 个工具名定义在 `src/exec/protocol.ts` 与
 * `agent-runtime/protocol.ts` 两份必须逐字同形的表里。加一个工具 = 改契约 + 改两侧 +
 * 改治理词表 + 改测试。对一个标榜"自托管"的项目，这自相矛盾——自托管的价值正是
 * "接得上我自己的东西"。
 *
 * 本模块提供**一个网关型工具** `mcp.call`：把调用转发给配置里声明的外部 MCP server。
 * 11 工具契约**一个字都不改**，扩展点走"外部通道"这条平行路。
 *
 * ## 三个关键判断（详见交付报告）
 * 1. **进程跑在宿主**：MCP server 是宿主上的独立子进程（stdio），不放进容器。
 *    容器是 ReadonlyRootfs + 无包管理器，装不了任意 server；而宿主上的 server 正是
 *    "接上我的东西"的语义。隔离由**治理审批**（dangerous 档）+ 超时 + 输出上限兜底。
 * 2. **一个网关工具，不动态展开**：`mcp.call` 单名。展开成 N 个工具会动 11 名契约与
 *    防漂移测试，而且外部 server 的工具表随进程启动才可知（动态工具名会让
 *    "工具词表"这个安全边界变成运行时可变的——治理无法预先登记）。
 *    代价是模型要多一层参数，用工具描述里的 `tools/list` 引导弥补。
 * 3. **安全边界**：一律 `dangerous` 档（审批 + 不参与批量批准 + 应急冻结）；超时；
 *    输出大小上限；stdout/stderr 分离；server 名必须在配置里显式声明（默认空 = 不启用）。
 *
 * ## 零依赖
 * stdio JSON-RPC 手写（NDJSON，每行一个 JSON 对象——MCP 的 stdio 规范）。
 *
 * @see scripts/mcp-echo-server.mjs 端到端取证用的真 server
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** 一个已声明的 MCP server（来自配置）。 */
export interface McpServerConfig {
  /** 网关里的 `server` 参数值；必须是模型可见的稳定标识。 */
  name: string;
  /** 可执行文件（如 `node`）。 */
  command: string;
  /** 命令行参数（如 `["scripts/mcp-echo-server.mjs"]`）。 */
  args: string[];
  /** 附加环境变量。 */
  env?: Record<string, string>;
  /** 单次调用的超时（毫秒）；缺省 30s。 */
  timeoutMs?: number;
  /**
   * 允许的工具名白名单；空/缺省 = 该 server 声明的全部工具都允许。
   *
   * 为什么需要：外部 server 的行为未知，**能少给就少给**。
   * 配置里写死白名单之后，即使 server 后来多出一个危险工具，模型也调不到。
   */
  allowTools?: string[];
}

/** 一次 tools/call 的返回值（已按 MCP 规范解包）。 */
export interface McpCallResult {
  ok: boolean;
  /** 工具成功时的结构化内容（content[0].text 若是 JSON 则已 parse）。 */
  result?: unknown;
  /** 失败时的错误码（供回喂模型判断改参还是放弃）。 */
  errorCode?:
    | 'mcp_not_configured'
    | 'mcp_unknown_server'
    | 'mcp_unknown_tool'
    | 'mcp_tool_denied'
    | 'mcp_timeout'
    | 'mcp_transport'
    | 'mcp_protocol'
    | 'mcp_tool_error'
    | 'mcp_output_too_large';
  errorMessage?: string;
  /** 工具自身报错（isError=true）时的原始文本。 */
  isToolError?: boolean;
}

/** 单个 server 的连接（懒启动 + 复用 + 崩溃自动重启）。 */
interface Conn {
  child: ChildProcess | null;
  /** 请求 id → 等待者。 */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  ready: Promise<void> | null;
  /** 已 init 的 server 交回的工具名（用于白名单与"工具存在性"检查）。 */
  tools: Set<string>;
  stderrTail: string[];
}

/** 输出上限：防止一个恶意/失控的 server 用巨量输出撑爆上下文。 */
export const MCP_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * MCP 客户端管理器。
 *
 * - **懒启动**：第一次调用某 server 才 spawn（不拖慢 daemon 启动）；
 * - **复用**：同一 server 的所有调用共享一个子进程（MCP 的会话语义）；
 * - **崩溃自愈**：子进程退出 → 连接作废，下次调用重新 spawn；
 * - **零污染**：server 的 stdout 只用于协议帧；stderr 单独收集（只留尾部，避免无界增长）。
 */
export class McpClient {
  private readonly servers: Map<string, McpServerConfig>;
  private readonly conns = new Map<string, Conn>();

  constructor(servers: readonly McpServerConfig[]) {
    this.servers = new Map(servers.map((s) => [s.name, s]));
  }

  /** 已声明的 server 名（供工具描述/诊断用）。 */
  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  /** 是否声明了任何 server（默认空 = MCP 完全关闭）。 */
  get enabled(): boolean {
    return this.servers.size > 0;
  }

  /** 某个 server 配置（测试/诊断）。 */
  configOf(name: string): McpServerConfig | undefined {
    return this.servers.get(name);
  }

  /**
   * 列出一个 server 的工具（用于把可用的外部工具告诉模型）。
   * 懒启动该 server。
   */
  async listTools(serverName: string): Promise<Array<{ name: string; description: string }>> {
    const cfg = this.servers.get(serverName);
    if (cfg === undefined) return [];
    const conn = await this.ensure(serverName, cfg);
    try {
      const res = (await this.request(serverName, conn, 'tools/list', {})) as {
        tools?: Array<{ name?: unknown; description?: unknown }>;
      };
      const tools = Array.isArray(res.tools) ? res.tools : [];
      const allowed = cfg.allowTools;
      return tools
        .filter((t) => typeof t.name === 'string')
        .filter((t) => allowed === undefined || allowed.length === 0 || allowed.includes(String(t.name)))
        .map((t) => ({ name: String(t.name), description: String(t.description ?? '') }));
    } catch {
      return [];
    }
  }

  /**
   * 调一个外部工具。**任何失败都以 `{ok:false, errorCode}` 返回，不抛**——
   * 调用方（ExecService）要把它当成一条普通工具结果回喂给模型。
   */
  async call(serverName: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.enabled) {
      return {
        ok: false,
        errorCode: 'mcp_not_configured',
        errorMessage: '未声明任何 MCP server（config/tools.yml 的 mcp_servers 为空）',
      };
    }
    const cfg = this.servers.get(serverName);
    if (cfg === undefined) {
      return {
        ok: false,
        errorCode: 'mcp_unknown_server',
        errorMessage: `未声明的 MCP server：${serverName}（可用：${this.serverNames().join(', ')}）`,
      };
    }
    // 白名单先于启动：即使 server 挂了也要先拒绝不该调的
    if (cfg.allowTools !== undefined && cfg.allowTools.length > 0 && !cfg.allowTools.includes(tool)) {
      return {
        ok: false,
        errorCode: 'mcp_tool_denied',
        errorMessage: `工具 ${tool} 不在该 server 的白名单内（${cfg.allowTools.join(', ')}）`,
      };
    }

    let conn: Conn;
    try {
      conn = await this.ensure(serverName, cfg);
    } catch (err) {
      return { ok: false, errorCode: 'mcp_transport', errorMessage: `server 启动失败：${errText(err)}` };
    }

    try {
      const res = (await this.request(serverName, conn, 'tools/call', { name: tool, arguments: args })) as {
        content?: Array<{ type?: unknown; text?: unknown }>;
        isError?: unknown;
      };
      const text = Array.isArray(res.content)
        ? res.content
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => String(c.text))
            .join('\n')
        : '';
      if (Buffer.byteLength(text, 'utf8') > MCP_MAX_OUTPUT_BYTES) {
        return {
          ok: false,
          errorCode: 'mcp_output_too_large',
          errorMessage: `输出超过上限 ${MCP_MAX_OUTPUT_BYTES} 字节（截断不回喂）`,
        };
      }
      if (res.isError === true) {
        return { ok: false, errorCode: 'mcp_tool_error', errorMessage: text, isToolError: true };
      }
      // 结果解包：server 常把结构化值 JSON 序列化进 text；能 parse 就交结构化值
      return { ok: true, result: parseMaybeJson(text) };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'MCP_TIMEOUT') {
        return { ok: false, errorCode: 'mcp_timeout', errorMessage: e.message ?? 'MCP 调用超时' };
      }
      return { ok: false, errorCode: 'mcp_protocol', errorMessage: errText(err) };
    }
  }

  /** 关闭全部子进程（daemon 优雅关停）。 */
  dispose(): void {
    for (const [name, conn] of this.conns) {
      this.killConn(name, conn);
    }
    this.conns.clear();
  }

  // ── 连接管理 ───────────────────────────────────────────────────────

  private async ensure(name: string, cfg: McpServerConfig): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing !== undefined && existing.child !== null && existing.child.exitCode === null) {
      if (existing.ready !== null) await existing.ready;
      return existing;
    }
    const conn: Conn = {
      child: null,
      pending: new Map(),
      nextId: 1,
      ready: null,
      tools: new Set(),
      stderrTail: [],
    };
    this.conns.set(name, conn);
    conn.ready = this.start(name, cfg, conn);
    await conn.ready;
    return conn;
  }

  private async start(name: string, cfg: McpServerConfig, conn: Conn): Promise<void> {
    const child = spawn(cfg.command, cfg.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}), DOTD_MCP_SERVER_NAME: name },
      windowsHide: true,
      // 子进程**不得**把宿主的事件循环钉住：否则 daemon 优雅关停时卡在这里，
      // 单测进程跑完也不退出（实测：整个测试文件跑完挂住 5 分钟+）。
      // unref 之后本进程仍能用它正常通信；本进程退出时子进程会随 stdin EOF 自行退出
      // （echo server 就是这么实现的：readline 'close' → exit）。
      detached: false,
    });
    // Node 的 spawn 没有 unref 选项，逐个句柄 unref（只影响"是否阻止退出"，不影响 IO）。
    // 各流类型在 @types/node 里没有声明 unref，故用窄化的结构断言。
    type Unrefable = { unref?: () => void };
    (child as unknown as Unrefable).unref?.();
    (child.stdin as unknown as Unrefable | null)?.unref?.();
    (child.stdout as unknown as Unrefable | null)?.unref?.();
    (child.stderr as unknown as Unrefable | null)?.unref?.();
    conn.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    // readline 会在 input 上挂 listener；它同样不该阻止本进程退出
    (rl as unknown as { unref?: () => void }).unref?.();
    rl.on('line', (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return; // 非 JSON 的噪声行忽略（不炸）
      }
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (id === null) return; // server 主动通知：本客户端不消费
      const waiter = conn.pending.get(id);
      if (waiter === undefined) return;
      conn.pending.delete(id);
      if (msg.error !== undefined) waiter.reject(new Error(msg.error.message ?? 'JSON-RPC 错误'));
      else waiter.resolve(msg.result);
    });

    // stderr：只留尾部（诊断用，不影响协议流）
    child.stderr?.on('data', (buf: Buffer) => {
      conn.stderrTail.push(buf.toString('utf8'));
      if (conn.stderrTail.length > 20) conn.stderrTail.shift();
    });

    child.on('exit', () => {
      // 子进程退出：本连接的 pending 全部失败（调用方拿到 transport 错误）
      for (const [, w] of conn.pending) w.reject(new Error('MCP server 已退出'));
      conn.pending.clear();
      conn.child = null;
      conn.ready = null;
    });
    child.on('error', (err) => {
      for (const [, w] of conn.pending) w.reject(err);
      conn.pending.clear();
      conn.child = null;
      conn.ready = null;
    });

    // 握手：initialize（MCP 要求连接后先握手）
    await this.request(name, conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dotd', version: '1.0.0' },
    });
    // 握手完成通知（规范要求；通知无 id、不等回包）
    this.notify(conn, 'notifications/initialized', {});
  }

  private request(name: string, conn: Conn, method: string, params: unknown): Promise<unknown> {
    const cfg = this.servers.get(name);
    const timeoutMs = cfg?.timeoutMs ?? 30_000;
    const child = conn.child;
    if (child === null || child.stdin === null) {
      return Promise.reject(new Error('MCP server 未运行'));
    }
    const id = conn.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        // 超时：杀掉子进程（它可能卡死），下次调用重启动
        this.killConn(name, conn);
        const e = new Error(`MCP 调用超时（${timeoutMs}ms）：${method}`);
        (e as Error & { code?: string }).code = 'MCP_TIMEOUT';
        reject(e);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      conn.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin!.write(`${payload}\n`, (err) => {
        if (err !== null && err !== undefined) {
          conn.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private notify(conn: Conn, method: string, params: unknown): void {
    try {
      conn.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // 通知失败无影响
    }
  }

  private killConn(name: string, conn: Conn): void {
    const child = conn.child;
    conn.child = null;
    conn.ready = null;
    for (const [, w] of conn.pending) w.reject(new Error('MCP 连接已关闭'));
    conn.pending.clear();
    this.conns.delete(name);
    if (child !== null && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // 已退出
      }
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** text 是 JSON 就返回解析值，否则原样返回字符串。 */
function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (t.length === 0) return '';
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}
