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

test('探针文件必须是 CRLF 换行（PowerShell 5 解析纯 LF 会静默丢函数体）', () => {
  // 现场（2026-10-19）：探针用纯 LF 写入后，`Write-Log "heartbeat ..."` 那行
  // 在函数里被静默跳过 —— 日志永远看不到心跳，但检查逻辑"看起来在跑"。
  // 根因是 PowerShell 5 的 -File 解析器对纯 LF 的 .ps1 有缺陷。
  // 这条断言把换行符钉住，防止编辑器/工具再次写回 LF。
  const raw = readFileSync(join(here, '..', 'scripts', 'dotd-probe.ps1'));
  const crlf = (raw.toString('binary').match(/\r\n/g) ?? []).length;
  const lfOnly = (raw.toString('binary').match(/(?<!\r)\n/g) ?? []).length;
  assert.ok(crlf > 0, '探针 .ps1 必须是 CRLF 换行');
  assert.equal(lfOnly, 0, `不允许出现裸 LF（发现 ${lfOnly} 处）`);
});

test('探针健康时要写心跳（否则无法区分"在跑"和"假死"）', () => {
  assert.ok(/heartbeat ok/.test(src), '健康分支应写 heartbeat 日志');
});

test('Write-Log 用 AppendAllText 而不是 Add-Content（并发拉取时不被文件锁打断）', () => {
  // 计划任务每分钟拉起一个探针；Add-Content 并发时会因文件占用抛异常，
  // 而异常发生在函数内会**静默中断整个 Invoke-Check**。
  assert.ok(/AppendAllText/.test(src), 'Write-Log 应使用 [IO.File]::AppendAllText');
  assert.ok(/catch\s*\{[\s\S]{0,200}?\}/.test(src.slice(src.indexOf('function Write-Log'), src.indexOf('function Write-Log') + 900)), 'Write-Log 内要有 try/catch 兜底');
});