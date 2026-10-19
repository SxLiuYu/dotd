/**
 * tests/exec-token-cache-invalidation.test.ts —— token 缓存必须有失效入口。
 *
 * 现场（2026-10-19）：容器重建后容器内会生成新 token，而 `fleet.memTokens`
 * 缓存里还是旧值，`currentToken()` 优先返回缓存 —— 于是探活拿**旧 token 打新容器**，
 * 永久 401。症状是**探活在成功/失败之间反复横跳**：
 *
 *   [exec] 容器探活连续失败 3 次：ready → unhealthy
 *   [exec] 容器探活恢复：unhealthy → booting → ready
 *   [exec] 容器探活连续失败 3 次：ready → unhealthy
 *   [exec] 容器探活恢复：unhealthy → booting → ready
 *
 * 容器其实是好的（healthz 从容器内 curl 也返回 401，说明是鉴权不是网络）。
 *
 * 修法：`Fleet.invalidateToken(dotId)`，探活失败时清缓存重读一次。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fleetSrc = readFileSync(join(here, '..', 'src', 'exec', 'fleet.ts'), 'utf8');
const execSrc = readFileSync(join(here, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');

test('Fleet 提供 invalidateToken（token 缓存不是只写不删）', () => {
  assert.ok(/invalidateToken\(dotId: string\)/.test(fleetSrc), '应有 invalidateToken(dotId)');
  const idx = fleetSrc.indexOf('invalidateToken(dotId: string)');
  const body = fleetSrc.slice(idx, idx + 300);
  assert.ok(/memTokens\.delete\(/.test(body), 'invalidateToken 应真的 delete 缓存条目');
});

test('探活失败时会先清 token 缓存再重试一次', () => {
  const idx = execSrc.indexOf('periodicHealthCheck(');
  assert.ok(idx > 0, '应有 periodicHealthCheck');
  const body = execSrc.slice(idx, idx + 3500);
  assert.ok(/invalidateToken\(dotId\)/.test(body), '探活失败路径应清 token 缓存');
  assert.ok(/probeHealth\(dotId\)/.test(body), '清缓存后应重探一次再判定');
});
