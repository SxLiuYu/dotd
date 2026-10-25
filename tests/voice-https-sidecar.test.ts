/**
 * tests/voice-https-sidecar.test.ts —— 8443 到底有没有真的起来。
 *
 * 背景：`docker/compose.voice.yml` 映射 `8443:8443`，`docs/voice-quickstart.md`
 * 写"只暴露 8000/8443"，上游 README 写"手机同 WiFi 访问 https://<IP>:8443"。
 * 但合并后只跑 one_system 一个进程，上游那个"watchdog 再拉 https_server.py"
 * 的机制不存在了 —— 部署机上 `ss -ltnp` 只有 7788/8000，8443 从来没监听。
 *
 * 手机浏览器只在 HTTPS 下给麦克风权限，所以这不是端口洁癖，是"手机能不能说话"。
 * 这条门禁跑 Python 侧 unittest（真的起 TLS server 并完成握手）。
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

test('8443 HTTPS 副本（真起 TLS + 证书落数据目录）', { skip, timeout: 90_000 }, () => {
  const r = spawnSync(PY!, ['-m', 'unittest', 'voice.integration.test_https_sidecar', '-v'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
