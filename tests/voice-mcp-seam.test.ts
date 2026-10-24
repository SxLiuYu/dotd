/**
 * tests/voice-mcp-seam.test.ts —— dotd ↔ Charlie 工具面（2026-10-23）。
 *
 * 这条接缝**不新写 Python 协议**：Charlie 的每个 `magic-*.py` 已经是一个 FastMCP
 * stdio server，dotd 的 `McpClient` 直接连它。本测试证明三件事：
 *   1. 握手（initialize / notifications/initialized）两边对得上；
 *   2. `tools/list` 能拿到 Charlie 的真实工具（goodnight / execute_scene / …）；
 *   3. 调一个**无副作用**的工具（list_protocols）能拿到结果；白名单之外的调不到。
 *
 * 依赖：本机 Python 且装了 `mcp` 包（Charlie 的 requirements-core 里有）。
 * 缺任一条件就跳过——不能把 Node 门禁绑死在 Python 上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/exec/mcp-client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SERVER = join(REPO, 'voice', 'charlie', 'magic-scenes.py');

function pythonWithMcp(): string | null {
  const candidates = process.env.DOTD_PYTHON ? [process.env.DOTD_PYTHON] : ['python', 'python3'];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import mcp'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const PY = pythonWithMcp();
const skip = PY === null || !existsSync(SERVER) ? '本机没有 Python+ mcp 包或缺少 voice/charlie/magic-scenes.py' : false;

test('Charlie 的场景 server 能被 dotd 的 MCP 客户端直接调用', { skip, timeout: 90_000 }, async () => {
  const client = new McpClient([
    {
      name: 'charlie-scenes',
      command: PY!,
      args: [SERVER],
      timeoutMs: 30_000,
      allowTools: ['goodnight', 'good_morning', 'execute_scene', 'list_protocols'],
    },
  ]);
  try {
    const tools = await client.listTools('charlie-scenes');
    const names = tools.map((t) => t.name);
    for (const want of ['goodnight', 'good_morning', 'execute_scene', 'list_protocols']) {
      assert.ok(names.includes(want), `tools/list 应有 ${want}，实际：${names.join(', ')}`);
    }
    assert.ok(names.every((n) => ['goodnight', 'good_morning', 'execute_scene', 'list_protocols'].includes(n)), '白名单必须生效');

    // 无副作用：只列协议，不执行场景（不会碰空调/电视）
    const r = await client.call('charlie-scenes', 'list_protocols', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.result), /晚安/);

    // 白名单外的工具：即使 server 有，也必须被 dotd 拒绝
    const denied = await client.call('charlie-scenes', 'learn_protocol', { name: 'x', trigger_words: 'y', steps_description: 'z' });
    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'mcp_tool_denied');
  } finally {
    client.dispose();
  }
});
