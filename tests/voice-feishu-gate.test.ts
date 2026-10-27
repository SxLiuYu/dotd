/**
 * tests/voice-feishu-gate.test.ts —— Charlie 自建飞书长连接的闸门门禁。
 *
 * Python 侧 `voice/integration/feishu_gate.py`：默认关（dotd 独占事件订阅，
 * 否则同一条消息事件被处理两次），并在交给上游之前按"线程是否活着"校准
 * `_started` —— 上游把 `_started` 置位后永不复位，线程一旦退出，watchdog
 * 每 60s 的"尝试重启"就变成空喊（现场 163 次，一次没真重启）。
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

test('飞书闸门（默认关 + _started 复位 + 幂等）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_feishu_gate', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
