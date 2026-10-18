/**
 * tests/exec-mcp-gateway.test.ts —— P2-1 端到端取证：真 MCP server。
 *
 * ## 证明什么
 * 不是"单测通过"，而是这条**完整链路**真的能跑：
 *
 *   模型看到 `mcp.call`（工具面）
 *     → Runner 派发 → governance 审批（dangerous 档，一律人工）
 *     → ExecService 宿主侧网关 → 真 spawn scripts/mcp-echo-server.mjs
 *     → stdio JSON-RPC 往返 → 结果回到模型
 *
 * ## 默认关闭（头号断言）
 * 未声明任何 MCP server 时：`mcp.call` **不出现在工具面**，`getCapabilities` 与
 * 引入本功能前逐字一致（11 名）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import { TOOL_NAMES } from '../src/exec/protocol.ts';
import type { TempDataDir } from './helpers.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { McpClient } from '../src/exec/mcp-client.ts';
import { parseMcpServersYaml, loadMcpServers } from '../src/exec/mcp-config.ts';
import type { ExecToolCall } from '../src/shared/contracts.ts';

const tmps: TempDataDir[] = [];
const clients: McpClient[] = [];
const execs: ExecServiceImpl[] = [];
test.afterEach(() => {
  for (const e of execs.splice(0)) {
    try {
      e.dispose();
    } catch {
      // 已关
    }
  }
  for (const c of clients.splice(0)) {
    try {
      c.dispose();
    } catch {
      // 已关
    }
  }
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ECHO_SERVER = join(REPO_ROOT, 'scripts', 'mcp-echo-server.mjs');

function echoClient(): McpClient {
  const c = new McpClient([
    {
      name: 'echo',
      command: process.execPath,
      args: [ECHO_SERVER],
      timeoutMs: 10_000,
      allowTools: ['echo', 'add', 'env', 'boom'],
    },
  ]);
  clients.push(c);
  return c;
}

function makeExec(mcp: McpClient): { tmp: TempDataDir; exec: ExecServiceImpl } {
  const tmp = makeTempDataDir({ pool: true });
  tmps.push(tmp);
  const exec = new ExecServiceImpl({
    db: tmp.db,
    bus: tmp.bus,
    cfg: { tokenDir: tmp.root },
    mcp,
  });
  execs.push(exec);
  return { tmp, exec };
}

function mcpCall(id: string, server: string, tool: string, args: Record<string, unknown>): ExecToolCall {
  return {
    call_id: id,
    task_id: 't1',
    dot_id: 'dot1',
    tool: 'mcp.call' as never,
    args: { server, tool, arguments: args },
    deadline_ms: 60_000,
    issued_at: new Date().toISOString(),
  };
}

// 工具面基线：从契约派生，而不是手抄——手抄会在加工具时静默过期
// （2026-10-18 加 schedule.* 时就撞到了）。
// 注意：宿主侧工具（schedule.*）**对模型可见**（getCapabilities 会列出来），
// 只是执行时不进容器。所以基线必须包含它们。
const ELEVEN = [...TOOL_NAMES].sort();

test('默认关闭：未声明任何 MCP server → getCapabilities 里没有 mcp.call（工具面不变）', async () => {
  const { exec } = makeExec(new McpClient([]));
  await exec.boot(['dot1']);
  const caps = await exec.getCapabilities('dot1');
  const names = caps.map((c) => c.name);
  assert.equal(names.includes('mcp.call'), false, '未声明 server 时，模型不得看到 mcp.call');
  assert.deepEqual(names.slice().sort(), ELEVEN, '仍是那批容器工具（逐字不变）');
});

test('默认关闭：未声明 server 时调 mcp.call 会明确报 mcp_not_configured（不是静默失败）', async () => {
  const { exec } = makeExec(new McpClient([]));
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c1', 'echo', 'echo', { text: 'x' }));
  assert.equal(r.status, 'error');
  assert.equal(r.error?.code, 'mcp_not_configured');
  assert.equal(r.error?.retryable, false, '配置问题不是可重试错误');
});

test('默认关闭：config/mcp-servers.yml 就是空的（servers: []）', () => {
  const servers = loadMcpServers(join(REPO_ROOT, 'config', 'mcp-servers.yml'));
  assert.deepEqual(servers, [], '仓库默认配置必须零声明（默认关闭）');
});

test('声明 server 后：工具面多出 mcp.call，且 sideEffect=unknown（→ 治理按最严档）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const caps = await exec.getCapabilities('dot1');
  const gw = caps.find((c) => c.name === 'mcp.call');
  assert.ok(gw !== undefined, '声明后模型应能看到 mcp.call');
  assert.equal(gw!.sideEffect, 'unknown', '外部工具行为未知 → 必须标 unknown');
  assert.equal(caps.length, ELEVEN.length + 1, '全部工具 + 1 个网关');
});

test('端到端：mcp.call → 真 spawn scripts/mcp-echo-server.mjs → 结果回到调用方', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);

  const text = '你好，这是从 dotd 发出的调用';
  const r = await exec.runTool(mcpCall('c1', 'echo', 'echo', { text }));
  assert.equal(r.status, 'ok', `调用应成功，实际 ${JSON.stringify(r.error)}`);
  const payload = (r.result as { mcp: { echoed: string; length: number } }).mcp;
  assert.equal(payload.echoed, text, '文本原样往返');
  assert.equal(payload.length, text.length, '服务端算出的长度也回来了（证明是 server 真算的）');
});

test('端到端：结构化参数与结构化结果（add 2+40=42）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c2', 'echo', 'add', { a: 2, b: 40 }));
  assert.equal(r.status, 'ok');
  assert.equal((r.result as { mcp: { sum: number } }).mcp.sum, 42);
});

test('端到端：证明 server 是独立子进程（pid 与宿主不同）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c3', 'echo', 'env', {}));
  assert.equal(r.status, 'ok');
  const env = (r.result as { mcp: { pid: number; envKeysPresent: string[] } }).mcp;
  assert.notEqual(env.pid, process.pid, 'MCP server 必须跑在独立进程里（不是宿主内联）');
  assert.equal(
    env.envKeysPresent.includes('DOTD_MCP_SERVER_NAME'),
    true,
    '宿主传给 server 的标识变量确实到位（DOTD_MCP_SERVER_NAME）',
  );
});

test('端到端：工具自身报错 → 以 mcp_tool_error 可读地回到模型（带原文）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c4', 'echo', 'boom', {}));
  assert.equal(r.status, 'error');
  assert.equal(r.error?.code, 'mcp_tool_error');
  assert.match(String(r.error?.message), /故意抛出的错误/, '错误原文要能看见，模型才能改道');
});

test('端到端：白名单挡住未授权的工具（不转发）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c5', 'echo', 'slow', { ms: 1 }));
  assert.equal(r.status, 'error');
  assert.equal(r.error?.code, 'mcp_tool_denied', '白名单外的工具必须被拒');
});

test('端到端：未知 server 名 → mcp_unknown_server（并列出可用的）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const r = await exec.runTool(mcpCall('c6', 'nope', 'echo', { text: 'x' }));
  assert.equal(r.status, 'error');
  assert.equal(r.error?.code, 'mcp_unknown_server');
  assert.match(String(r.error?.message), /echo/, '错误里要告诉模型有哪些可用 server');
});

test('幂等：同一 call_id 重复调用只打到 server 一次（ledger 重放）', async () => {
  const { exec } = makeExec(echoClient());
  await exec.boot(['dot1']);
  const call1 = mcpCall('dup-1', 'echo', 'echo', { text: 'once' });
  const r1 = await exec.runTool(call1);
  const r2 = await exec.runTool(call1);
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.ok(
    JSON.stringify(r2.result ?? {}).includes('result_hash'),
    '第二次应是重放（result_hash），而不是再跑一次外部进程',
  );
});

test('超时：server 卡住时按 timeoutMs 断开并报 mcp_timeout', async () => {
  const client = new McpClient([
    { name: 'slow', command: process.execPath, args: [ECHO_SERVER], timeoutMs: 300 },
  ]);
  clients.push(client);
  const r = await client.call('slow', 'slow', { ms: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'mcp_timeout');
});

test('配置：解析声明形状（name/command/args/timeout_ms/allow_tools/env）', () => {
  const specs = parseMcpServersYaml(`
# 注释行
servers:
  - name: echo
    command: node
    args: ["scripts/mcp-echo-server.mjs"]
    timeout_ms: 5000
    allow_tools: [echo, add]
    env:
      FOO: bar
  - name: other
    command: /usr/bin/thing
    args: []
`);
  assert.equal(specs.length, 2);
  assert.equal(specs[0]!.name, 'echo');
  assert.equal(specs[0]!.command, 'node');
  assert.deepEqual(specs[0]!.args, ['scripts/mcp-echo-server.mjs']);
  assert.equal(specs[0]!.timeoutMs, 5000);
  assert.deepEqual(specs[0]!.allowTools, ['echo', 'add']);
  assert.deepEqual(specs[0]!.env, { FOO: 'bar' });
  assert.equal(specs[1]!.name, 'other');
});

test('配置：空表 = 关闭；缺 name/command 抛错（写错的配置必须见光）', () => {
  assert.deepEqual(parseMcpServersYaml('servers: []\n'), []);
  assert.deepEqual(parseMcpServersYaml('# 只有注释\n'), []);
  assert.throws(() => parseMcpServersYaml('servers:\n  - command: node\n'), /缺 name/);
  assert.throws(() => parseMcpServersYaml('servers:\n  - name: x\n'), /缺 command/);
});

test('配置：文件不存在 = 关闭（不抛）', () => {
  assert.deepEqual(loadMcpServers(join(REPO_ROOT, 'config', '__no_such_mcp__.yml')), []);
});
