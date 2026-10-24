/**
 * tests/cortex-router.test.ts —— 把 Python 侧的「反射 + 皮层」单测接进门禁。
 *
 * Python 侧（voice/integration/test_cortex_router.py）覆盖：
 *   - 反射命中不调用 dotd，但记账；
 *   - 皮层命中返回 dotd 的答复；
 *   - dotd 不可达 → 只执行本地场景并明确说「大脑不在线」；
 *   - 离线记账 spool 的补传与保留；
 *   - install() 幂等、飞书/被打断路径不接管。
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

test('反射/皮层分流：本地反射、dotd 皮层、离线兜底（Python unittest）', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_cortex_router', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // 条数会随用例增加，这里只钉「确实跑了」和「全绿」，避免每加一条就改门禁。
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
