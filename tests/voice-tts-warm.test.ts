/**
 * tests/voice-tts-warm.test.ts —— 启动时 TTS 话术预热的门禁。
 *
 * Python 侧 `voice/integration/tts_warm.py` 把「每次都说同一句」的固定回复
 * 提前合成进进程内缓存（Edge TTS 首包 ~1.1s → 命中 0ms）。
 * 这里只验编排与开关；真实合成归 `DOTD_REAL_AUDIO` 门内的真音频验收。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from '../scripts/lib/python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const PY = resolvePython({
  repoRoot: REPO,
  run: (bin, argv) => spawnSync(bin, argv, { encoding: 'utf8' }),
})?.bin ?? null;
const skip = PY === null ? '本机没有 Python' : false;

test('TTS 话术预热（tts_warm 编排 + 开关）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_tts_warm', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
