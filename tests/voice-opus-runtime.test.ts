/**
 * tests/voice-opus-runtime.test.ts —— Python 侧 libopus 发现的回归门禁。
 *
 * 背景：opuslib 是 ctypes 绑定，找不到 libopus 时抛的是 Exception 而不是
 * ImportError，上游 `except ImportError` 兜不住 → 语音进程在 import 阶段直接死。
 * Windows 上系统没有 libopus，但 PyAV 自带一份，voice/integration/opus_runtime.py
 * 负责把它接上。这段逻辑一旦回退，`npm test` 里的合成音频链路也会跟着炸
 * （2026-10-24 实际发生过），所以在这里钉住。
 *
 * 纯 Python 标准库，不需要 opuslib/PyAV/音频设备。
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

test('libopus 发现与窄补丁（opus_runtime）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_opus_runtime', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
