/**
 * tests/one-system-supervisor.test.ts —— 把 Python 侧的阶段 1 单测接进门禁。
 *
 * Python 侧（voice/integration/test_one_system.py）覆盖：
 *   - 退避序列；
 *   - tokens.env 的 BOM/export/引号解析；
 *   - 子进程退出后自动重启；
 *   - apiVersion 不匹配 → incompatible；
 *   - TTS 链路默认把免费免 key 的 edge 排第一（否则新机器启动预热 0/3）。
 *
 * 这里只负责“跑它并如实报告”。没 Python 就跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function pythonBin(): string | null {
  for (const bin of process.env.DOTD_PYTHON ? [process.env.DOTD_PYTHON] : ['python', 'python3']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const PY = pythonBin();
const skip = PY === null ? '本机没有 Python' : false;

test('一套壳：托管/重启/版本握手（Python unittest）', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_one_system', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // 不断言具体条数：这份 unittest 会随回归项增加，写死 `Ran 4 tests` 只会
  // 让每次加法都要改门禁（2026-10-25 加了 apply_env 两条就撞上了）。
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
