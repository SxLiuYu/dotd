/**
 * tests/scripts-mcp-example.test.ts —— 「照着示例配，到底能不能起来」。
 *
 * 现场（2026-10-26）：`config/mcp-servers.voice.yml` 是文档教人 `cp` 过去启用的
 * 那份声明，而它同时有两个致命问题：
 *
 *   1. `allow_tools` 用换行块列表 → 旧解析器把 `- goodnight` 读成新 server
 *      → daemon 拒启动；
 *   2. `command: python` → Debian/Ubuntu/WSL 上根本没有 `python`（只有 `python3`），
 *      系统 `python3` 又通常没有 `mcp` 包（依赖只在仓库 `.venv`）。
 *
 * 而 `voice-check.mjs` 当时只判 `existsSync(示例)` —— 两个问题它都看不见，
 * 体检一路 ✅。这里钉住新的判据：
 *   - `inspectMcpServers` 逐条核对 command 可解析、args 里的文件存在；
 *   - `voice-check.mjs` 必须**真的调用**它（不是只判文件在）；
 *   - `resolveCommand` 只有一份实现（doctor 与 voice-check 不许各写一套）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMcpServers } from '../scripts/doctor.mjs';
import { inspectMcpServers } from '../scripts/lib/mcp-example.mjs';
import { looksLikePath, resolveCommand } from '../scripts/lib/command.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

describe('① inspectMcpServers：把「文件在」升级成「能起来」', () => {
  test('command 找不到 → 点名 server 与那条命令', () => {
    const broken = inspectMcpServers(
      [{ name: 'ghost', command: 'no-such-command-xyz-123', args: [] }],
      { repoRoot: REPO, env: { PATH: '/definitely-not-here' } },
    );
    assert.equal(broken.length, 1);
    assert.match(broken[0]!, /ghost/);
    assert.match(broken[0]!, /no-such-command-xyz-123/);
  });

  test('args 里的脚本不存在 → 点名缺的是哪个文件', () => {
    const broken = inspectMcpServers(
      [{ name: 's', command: process.execPath, args: ['scripts/definitely-not-here.mjs'] }],
      { repoRoot: REPO },
    );
    assert.equal(broken.length, 1);
    assert.match(broken[0]!, /definitely-not-here\.mjs/);
  });

  test('都齐全 → 空数组（不制造噪音）', () => {
    assert.deepEqual(
      inspectMcpServers(
        [{ name: 'echo', command: process.execPath, args: ['scripts/mcp-echo-server.mjs'] }],
        { repoRoot: REPO },
      ),
      [],
    );
  });

  test('command 都不在时不再报 args（先修最前面那道门）', () => {
    const broken = inspectMcpServers(
      [{ name: 's', command: 'no-such-command-xyz-123', args: ['scripts/nope.mjs'] }],
      { repoRoot: REPO, env: { PATH: '/definitely-not-here' } },
    );
    assert.equal(broken.length, 1, `不该叠两条：${JSON.stringify(broken)}`);
    assert.match(broken[0]!, /command/);
  });

  test('参数（-m / 非路径）不当作文件检查', () => {
    assert.equal(looksLikePath('-m'), false);
    assert.equal(looksLikePath('voice.integration.one_system'), false);
    assert.equal(looksLikePath('scripts/py.mjs'), true);
    assert.equal(looksLikePath('voice/charlie/magic-scenes.py'), true);
  });
});

describe('② 仓库自带的语音示例必须真的可用', () => {
  test('解析 + 逐条核对都能过', () => {
    const parsed = parseMcpServers(read('config/mcp-servers.voice.yml'));
    assert.equal(parsed.error, null, `示例解析失败：${parsed.error}`);
    assert.deepEqual(
      inspectMcpServers(parsed.servers, { repoRoot: REPO }),
      [],
      '示例是文档里的启用模板：它起不来 = 照文档做必然失败',
    );
  });

  test('不许再用裸 `python` 当 command（Debian/WSL 上没有这个命令）', () => {
    const parsed = parseMcpServers(read('config/mcp-servers.voice.yml'));
    for (const s of parsed.servers) {
      assert.notEqual(s.command, 'python', `${s.name} 又写回裸 python 了`);
      // 依赖只装在 .venv 里，系统解释器通常没有 mcp —— 必须经解析器
      assert.match(s.args[0] ?? '', /scripts\/py\.mjs/, `${s.name} 应经 py.mjs 解析解释器`);
    }
  });
});

describe('③ 判据只有一份（doctor 与 voice-check 不许各写一套）', () => {
  test('voice-check 真的调用 inspectMcpServers，而不是只判文件在', () => {
    const src = read('scripts/voice-check.mjs');
    assert.match(src, /from '\.\/lib\/mcp-example\.mjs'/, '必须 import 共用判据');
    assert.match(src, /inspectMcpServers\(/, '必须真的调用');
    // 反证：以前那行"示例文件在不在"如果还在，就是为了它单独判一次存在
    assert.doesNotMatch(
      src,
      /\['config\/mcp-servers\.voice\.yml'/,
      '只判存在的那一行必须去掉，否则"文件在"依旧冒充"能用"',
    );
  });

  test('doctor 的 resolveCommand 只是转手，实现住在 lib/command.mjs', () => {
    const src = read('scripts/doctor.mjs');
    assert.match(src, /resolveCommandShared\(command, opts\)/, 'doctor 不该自己再实现一遍');
    assert.doesNotMatch(src, /for \(const dir of pathVar\.split/, 'PATH 遍历只该有一处');
  });

  test('resolveCommand：不带分隔符走 PATH，带分隔符走 repoRoot', () => {
    const node = resolveCommand('node', { env: { PATH: process.env.PATH ?? '' }, repoRoot: REPO });
    assert.ok(node !== null, 'PATH 里应当能解析到 node');
    assert.match(node!, /node(\.exe)?$/i);
    assert.ok(resolveCommand('scripts/mcp-echo-server.mjs', { env: {}, repoRoot: REPO }) !== null);
    assert.equal(resolveCommand('scripts/no-such.mjs', { env: {}, repoRoot: REPO }), null);
  });
});
