/**
 * tests/voice-tts-edge-fallback.test.ts —— 设备播报链的免费兜底门禁。
 *
 * Python 侧 `voice/integration/tts_edge_fallback.py`：ESP32 播报走
 * `app.xiaozhi_ws._synth_mp3`，它自带 baidu → finna → stepfun → macOS `say`，
 * 既不看 TTS_PRIORITY 也不含 edge。没配 key 的机器上设备一句都说不出话，
 * 而 `[tts-warm]` 却是 3/3 —— 两道门各查各的。
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

test('设备播报 Edge 兜底（上游全灭才接管）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_tts_edge_fallback', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
