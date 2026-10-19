/**
 * tests/dotd-probe-ps1.test.ts —— Windows 侧探针的静态守卫。
 *
 * 现场（2026-10-19）：探针第一次写完，测试时"停掉 daemon 仍然静默通过"。
 * 根因是 `Test-Port` 的返回值：
 *
 *     try {
 *       $ok = $task.Wait(3000)
 *       $connected = $client.Connected     // ← ConnectAsync 抛异常时这行走不到
 *       return ($ok -and $connected)
 *     } catch { return $false }
 *
 * 异常时 `$connected` 还是 `$null`，`$ok -and $null` 得到 `$null`；
 * 调用方 `if ($daemonOk)` 把 `$null` 当**真** → 故障被静默吞掉。
 *
 * 这个测试扫源码，确保 Test-Port 每个出口都显式返回 [bool]。
 * 不依赖 PowerShell 运行时，纯文本断言。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'scripts', 'dotd-probe.ps1'), 'utf8');

/** 取出 Test-Port 函数体。 */
function testPortBody(): string {
  const start = src.indexOf('function Test-Port');
  assert.ok(start >= 0, '探针里应有 Test-Port 函数');
  // 到下一个顶层 function 或文件尾
  const rest = src.slice(start);
  const m = /\nfunction\s+\w/.exec(rest);
  return m === null ? rest : rest.slice(0, m.index);
}

test('Test-Port: 每个 return 都显式返回 [bool] 或字面量（防 $null 被当真）', () => {
  const body = testPortBody();
  const returns = [...body.matchAll(/return\s+(.+?)[\r\n]/g)].map((m) => m[1]!.trim());
  assert.ok(returns.length > 0, 'Test-Port 应有 return 语句');
  for (const r of returns) {
    const ok =
      r.startsWith('[bool]') ||
      r === '$true' ||
      r === '$false' ||
      r === '([bool]$false)' ||
      r === '([bool]$true)';
    assert.ok(ok, `Test-Port 的 return 必须显式布尔，实际是：${r}`);
  }
});

test('Test-Port: 有 finally 关闭 TcpClient（防句柄泄漏）', () => {
  const body = testPortBody();
  assert.ok(/finally\s*\{/.test(body), 'Test-Port 应有 finally 块关闭连接');
  assert.ok(/\$client\.Close\(\)/.test(body), 'finally 里应调用 Close');
});

test('探针必须能区分"WSL 活着"与"WSL 整个没了"（两者的告警措辞不同）', () => {
  assert.ok(/wslAlive/.test(src), '探针应判断 WSL 是否存活');
  assert.ok(
    src.includes('WSL entirely unresponsive'),
    '应有针对"WSL 整体无响应"的专门措辞 —— 这正是本探针存在的理由',
  );
});

test('探针从 WSL 外读凭据，WSL 挂了时读不到应有兜底', () => {
  // 凭据来自 \\wsl.localhost\...：WSL 真挂时这个路径会失败，必须有 catch
  assert.ok(/wsl\.localhost.*_tokens_src\.env/s.test(src), '凭据路径应指向 WSL 内文件');
  assert.ok(
    /cannot read credentials/.test(src),
    '读不到凭据时要有明确的日志分支（不然 WSL 挂了会静默）',
  );
});
