/**
 * tests/voice-audio-chain.test.ts —— 无硬件条件下的音频链路自测接入门禁。
 *
 * Python 侧（voice/integration/test_audio_chain.py）用合成 PCM 跑通：
 *   hello 握手 → listen/start → VAD 端点 → ASR 接缝 → 大脑接缝 → TTS 帧回发；
 *   以及「静音不触发回复」。
 *
 * 明确不覆盖：真麦克风/真 ASR 准确率/真 TTS 音质/真 Opus 编解码
 * （本机没有 opuslib、ffmpeg；编解码在测试里被替身替换）。真机仍要单验。
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

test('音频链路（合成 PCM → VAD → ASR/大脑接缝 → TTS 回发）', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_audio_chain', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
