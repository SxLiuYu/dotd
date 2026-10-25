/**
 * tests/voice-asr-model.test.ts —— 模型下载与"后到也能听"的 Python 门禁。
 *
 * 2026-10-25 在真实容器里踩到两个坑，都不是"缺个包"那么简单：
 *
 *   1. 自动下载**必然失败**：上游 `scripts/download-models.py` 只有一个来源
 *      （GitHub release），在这台机器上 20s 超时、0 字节；hf-mirror 有 1.2MB/s。
 *      entrypoint 把失败写进后台日志，用户看到的是"容器起来了但听不见"。
 *   2. 下载完成也不会自动生效：`SENSE_VOICE_MODEL` 由 apply_env() 在**进程启动
 *      那一刻**决定，后台下完之后 asr_race() 仍是 ('', 'legacy')，必须重启容器。
 *
 * 这条门禁跑 `voice.integration.test_asr_model`（12 条 unittest），覆盖多源顺序、
 * 原子落盘、就绪判定、以及监视线程"模型后到即接管"。
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

test('ASR 模型多源下载 + 后到即接管', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_asr_model', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
