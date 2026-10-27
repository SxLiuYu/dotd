/**
 * tests/voice-memory-push.test.ts —— 把 Python 侧的「单一记忆源 / 单一主动推送」接进门禁。
 *
 * Python 侧（voice/integration/test_memory_push.py）覆盖：
 *   - 历史从 dotd 读回、反射轮次补写、dotd 轮次不重复写、离线回落本地缓存；
 *   - 偏好读写以 dotd 为准（本地只是缓存）；
 *   - 推送豁免类型（提醒/唤醒/健康）不问 dotd；
 *   - dotd 不可达时 fail-closed（可配置 open）；
 *   - 真正的发送口（add_notification / 个性化推荐）被替换。
 *
 * 这里只负责“跑它并如实报告”。没 Python 就跳过。
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

test('单一记忆源 / 单一推送决策（Python unittest）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_memory_push', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 40_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
