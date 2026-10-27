/**
 * tests/home-devices.test.ts —— 把 Python 侧的家居控制单测接进门禁。
 *
 * Python 侧（voice/integration/test_home_devices.py）覆盖：
 *   - 设备清单：读 YAML、坏条目跳过、门锁/摄像头拒绝登记、环境变量兜底；
 *   - 语句解析：空调模式/温度/风速、灯的开光与亮度、越界温度当没听懂；
 *   - 不误动：否定句 / 疑问句 / 认不出设备 / 同房间歧义一律返回 None；
 *   - 执行：适配器成功失败都如实回报，history 记账，结构化入口与语音入口同源。
 *
 * 这里只负责「跑它并如实报告」。没 Python 或没 PyYAML 就跳过。
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
});
const skip = PY === null ? '本机没有 Python' : false;

test('家居控制：清单、解析、不误动、如实回报（Python unittest）', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!.bin, ['-m', 'unittest', 'voice.integration.test_home_devices', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // 条数会随用例增加，这里只钉「确实跑了」和「全绿」，避免每加一条就改门禁。
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
