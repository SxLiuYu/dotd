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
 *
 * 启动方式**照抄 `config/mcp-servers.voice.yml`**：`node scripts/py.mjs <脚本>`。
 * 2026-10-26 之前这里直接 spawn `python`/`python3`，而示例配置写的是
 * `command: python` —— 两者在 Debian/Ubuntu/WSL 上都**必然失败**（没有 `python`；
 * 系统 `python3` 没有 `mcp`）。测试挑了个能跑的解释器，于是接缝是绿的，
 * 用户照文档配的那份却是红的。现在测试和示例走同一条命令。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/exec/mcp-client.ts';
import { parseMcpServersYaml } from '../src/exec/mcp-config.ts';
import { resolvePython } from '../scripts/lib/python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SERVER = join(REPO, 'voice', 'charlie', 'magic-scenes.py');
const PY_LAUNCHER = join(REPO, 'scripts', 'py.mjs');

/** 仓库解析器找到的那个解释器能不能 `import mcp`。 */
function pythonAcceptsMcp(): boolean {
  const py = resolvePython({
    repoRoot: REPO,
    run: (bin, argv) => spawnSync(bin, argv, { encoding: 'utf8' }),
  });
  if (py === null) return false;
  return spawnSync(py.bin, ['-c', 'import mcp'], { encoding: 'utf8' }).status === 0;
}

const ready = pythonAcceptsMcp() && existsSync(SERVER) && existsSync(PY_LAUNCHER);
const skip = ready ? false : '本机没有 Python+ mcp 包，或缺少 voice/charlie/magic-scenes.py';

test('Charlie 的场景 server 能被 dotd 的 MCP 客户端直接调用', { skip, timeout: 120_000 }, async () => {
  // 用**仓库示例里的那一份声明**，不是测试自己另拼一份 —— 否则示例写错了，
  // 测试照样绿（2026-10-26 的 `command: python` 就是这么一直没被发现的）。
  const example = parseMcpServersYaml(readFileSync(join(REPO, 'config', 'mcp-servers.voice.yml'), 'utf8'));
  const cfg = example.find((s) => s.name === 'charlie-scenes');
  assert.ok(cfg !== undefined, '示例里应有 charlie-scenes');
  const client = new McpClient([{ ...cfg, timeoutMs: 30_000 }]);
  try {
    const tools = await client.listTools('charlie-scenes');
    const names = tools.map((t) => t.name);
    const want = ['goodnight', 'good_morning', 'execute_scene', 'list_protocols'];
    for (const w of want) {
      assert.ok(names.includes(w), `tools/list 应有 ${w}，实际：${names.join(', ')}`);
    }
    assert.equal(names.length, cfg.allowTools?.length, '白名单必须生效（不是把所有工具都放行）');
    assert.ok(names.every((n) => cfg.allowTools?.includes(n)), `白名单外的工具不该出现：${names.join(', ')}`);

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

test('家居控制 server（magic-home）能被 dotd 调用，且与语音反射同源', { skip, timeout: 120_000 }, async () => {
  const example = parseMcpServersYaml(readFileSync(join(REPO, 'config', 'mcp-servers.voice.yml'), 'utf8'));
  const cfg = example.find((s) => s.name === 'charlie-home');
  assert.ok(cfg !== undefined, '示例里应有 charlie-home');

  // 临时清单 + 空调干跑：不碰真设备、不碰涂鸦云。
  const dir = mkdtempSync(join(tmpdir(), 'dotd-home-'));
  const manifest = join(dir, 'home-devices.yml');
  writeFileSync(
    manifest,
    [
      'devices:',
      '  - id: ac1',
      '    name: 空调',
      '    kind: ac',
      '    adapter: tuya_ir',
      '    infrared_id: ir-test',
      '    remote_id: ac-test',
    ].join('\n'),
  );

  const client = new McpClient([
    { ...cfg, timeoutMs: 30_000, env: { HOME_DEVICES_FILE: manifest, HOME_AC_DRY_RUN: '1' } },
  ]);
  try {
    const tools = await client.listTools('charlie-home');
    const names = tools.map((t) => t.name);
    for (const w of ['home_list', 'home_control', 'home_status', 'home_reload']) {
      assert.ok(names.includes(w), `tools/list 应有 ${w}，实际：${names.join(', ')}`);
    }
    assert.equal(names.length, cfg.allowTools?.length, '白名单必须生效');

    const listed = await client.call('charlie-home', 'home_list', {});
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.match(String(listed.result), /空调/);

    const r = await client.call('charlie-home', 'home_control', {
      device: '空调',
      action: 'on',
      params: '{"mode":0,"temp":26}',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.result), /联调模式/, 'HOME_AC_DRY_RUN=1 时不该真的发红外码');
  } finally {
    client.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
