#!/usr/bin/env node
/**
 * scripts/mcp-echo-server.mjs —— 零依赖的 MCP echo server（stdio + JSON-RPC 2.0）。
 *
 * 用途（P2-1 取证）：证明 dotd 的 `mcp.call` 网关能真的把一个**外部进程**的工具
 * 接进模型可用的工具面，并完整走完「模型看到 → Runner 派发 → 治理审批 → 真打到
 * server → 结果回模型」这条链。它不是玩具：它实现的是 MCP 规范里最小的可用子集。
 *
 * ## 协议（MCP / JSON-RPC 2.0 over stdio）
 * - 传输：**每行一个 JSON 对象**（NDJSON）。MCP 的 stdio 规范就是这么定的——
 *   不用 Content-Length 头（那是 LSP 的做法）。
 * - 实现的方法：
 *   - `initialize`            → 交回 protocolVersion / capabilities / serverInfo
 *   - `notifications/initialized`（通知，无 id，**不回包**）
 *   - `tools/list`            → 列出工具（name / description / inputSchema）
 *   - `tools/call`            → 调用工具，返回 `{ content: [...], isError? }`
 *   - `ping`                  → 健康检查
 * - 未知方法 → JSON-RPC error -32601；参数错误 → -32602；工具自身失败 → 结果里 isError。
 *
 * ## 提供给 dotd 的工具
 * 1. `echo`      —— 原样回显，用来验证往返与参数透传
 * 2. `add`       —— 两个数相加，用来验证结构化参数与结果
 * 3. `env`       —— 返回本进程可见的几个环境变量名（安全取证：证明它跑在独立进程里）
 * 4. `slow`      —— 可指定毫秒延迟，用来验证 dotd 侧的超时兜底
 * 5. `boom`      —— 永远抛错，用来验证错误如何回到模型
 *
 * ## 纪律
 * - **零依赖**：只用 node: 内置模块。
 * - 不读 stdin 之外的任何东西、不写文件、不联网——取证要能一眼看穿它做了什么。
 * - stdout **只**用于协议帧；诊断信息一律走 stderr（否则会污染 JSON-RPC 流）。
 *
 * 用法：
 *   node scripts/mcp-echo-server.mjs
 *   （dotd 侧声明见 config/mcp-servers.yml；运行期那份通常在 ~/.dotd/）
 */

import { createInterface } from 'node:readline';

/** MCP 协议版本（2024-11-05 是当前广泛实现的稳定版本）。 */
const PROTOCOL_VERSION = '2024-11-05';

/** 工具表：名字 → { description, inputSchema, run } */
const TOOLS = {
  echo: {
    description: '原样回显收到的文本与参数（验证 dotd → MCP → dotd 的往返）',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要回显的文本' },
      },
      required: ['text'],
    },
    run: (args) => {
      const text = typeof args?.text === 'string' ? args.text : '';
      return { echoed: text, length: text.length, argsSeen: args };
    },
  },
  add: {
    description: '两个数相加',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    run: (args) => {
      const a = Number(args?.a);
      const b = Number(args?.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error('a/b 必须是数字');
      }
      return { sum: a + b };
    },
  },
  env: {
    description: '返回本进程的 pid 与几个环境变量名（证明它跑在独立进程里）',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
      // 只报"名字"与是否设置，不泄露值
      envKeysPresent: ['PATH', 'HOME', 'USERPROFILE', 'DOTD_MCP_SERVER_NAME'].filter(
        (k) => process.env[k] !== undefined,
      ),
    }),
  },
  slow: {
    description: '延迟指定毫秒后返回（验证 dotd 侧超时兜底）',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer', minimum: 0, maximum: 60000 },
      },
      required: ['ms'],
    },
    run: async (args) => {
      const ms = Math.max(0, Math.min(60_000, Number(args?.ms) || 0));
      await new Promise((r) => setTimeout(r, ms));
      return { waited: ms };
    },
  },
  boom: {
    description: '永远失败（验证错误如何回到模型）',
    inputSchema: { type: 'object', properties: {} },
    run: () => {
      throw new Error('这是 echo server 故意抛出的错误');
    },
  },
};

/** JSON-RPC 结果包。 */
function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

/** JSON-RPC 错误包。 */
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** 把工具输出包装成 MCP 的 content 数组（规范形状）。 */
function toolContent(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

/** 处理一条 JSON-RPC 消息；返回要写回的对象，或 null（通知不回包）。 */
async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dotd-echo', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null; // 通知：不回包

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS[name];
      if (tool === undefined) {
        return rpcError(id, -32602, `未知工具：${String(name)}`);
      }
      try {
        const out = await tool.run(args);
        return result(id, toolContent(out));
      } catch (err) {
        // 工具自身失败：按 MCP 规范用 isError 表达（协议层仍是成功响应）
        return result(id, {
          content: [{ type: 'text', text: `工具 ${name} 失败：${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `未实现的方法：${String(method)}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// stdio 主循环
// ───────────────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    send(rpcError(null, -32700, '解析失败：不是合法 JSON'));
    return;
  }
  // 逐条异步处理（保持顺序：用链式 promise 串行化，避免并发写乱序）
  queue = queue.then(async () => {
    try {
      const res = await handle(msg);
      if (res !== null) send(res);
    } catch (err) {
      send(rpcError(msg?.id ?? null, -32603, `内部错误：${err instanceof Error ? err.message : String(err)}`));
    }
  });
});

/** 串行化处理队列（保证响应顺序与请求一致）。 */
let queue = Promise.resolve();

rl.on('close', () => {
  // stdin 关闭 = 宿主退出，本进程跟着退（不留孤儿）
  queue.finally(() => process.exit(0));
});

// 诊断信息一律走 stderr（stdout 只用于协议帧）
process.stderr.write(`[mcp-echo] 已启动 pid=${process.pid} tools=${Object.keys(TOOLS).join(',')}\n`);
