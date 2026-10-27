/**
 * tests/voice-log-triage.test.ts —— 日志降噪门禁。
 *
 * Python 侧 `voice/integration/log_triage.py`：合并后大脑是 dotd，所以 Charlie
 * 自己那一套"缺 LLM key / 百度 400 / demo 模式 / 可选工具没装"是**预期状态**，
 * 但上游每次启动都会打一屏 WARNING + 配置指引。这里只降这几类已知的架构内失败，
 * 别的失败原因（缺包、鉴权、MCP 起不来）必须原样告警 —— 判错方向就会把真故障
 * 一起吞掉，所以这条门禁是必需的。
 *
 * 反面清单同样重要（测试里逐条钉住）：缺密钥点名、SenseVoice 模型缺失（=设备聋）、
 * ffmpeg 缺失（=音频转码必需）、运行期的百度失败 —— 一条都不许降。
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

test('日志降噪（只降已知架构内失败，不吞真故障）', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_log_triage', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
