/**
 * tests/daemon-memory-api-wiring.test.ts —— Runner 的 memory 端口必须转发 refreshContextSummary。
 *
 * 现场（2026-10-19）：`thread.context_summary` 在 **422 个线程里全是 null** ——
 * §4.4 的会话摘要机制有完整实现、有触发判据（>64 条消息）、有注入的 summarize，
 * 但**从来没生成过一条摘要**。
 *
 * 根因：daemon 里有两个 memory 适配器：
 *   - `memPortOf()`  → 给 SF 面用（openThread/appendMessage/listThreads/listMessages）
 *   - `memApiOf()`   → **给 Runner 用**（buildSessionReplay/sealTask/needsMemoryRedo…）
 * 而 `refreshContextSummary` 只被误加到 memPortOf 上，Runner 用的 memApiOf 漏了它。
 * 契约里它是 `?` 可选方法，所以类型检查不报错 —— Runner 静默走了"旧装配没有它"的降级分支。
 *
 * 这个测试做源码守卫：两个适配器都必须转发。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');

/** 取出某个适配器函数的函数体（粗略：从签名到下一个顶层 function）。 */
function adapterBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `daemon.ts 里应有 ${name}()`);
  const rest = src.slice(start);
  const m = /\nfunction \w+\(/.exec(rest.slice(1));
  return m === null ? rest : rest.slice(0, m.index! + 1);
}

test('memApiOf（Runner 用的）必须转发 refreshContextSummary', () => {
  const body = adapterBody('memApiOf');
  assert.ok(
    /refreshContextSummary\s*:/.test(body),
    'memApiOf 必须转发 refreshContextSummary —— 它是 Runner 唯一的摘要入口，漏了就等于摘要机制不存在',
  );
});

test('memPortOf（SF 用的）也转发 refreshContextSummary', () => {
  const body = adapterBody('memPortOf');
  assert.ok(/refreshContextSummary\s*:/.test(body), 'memPortOf 也应转发（保持一致，避免以后又改错地方）');
});

test('Runner 构造时 memory 用的是 memApiOf 而不是 memPortOf（钉住这个易错点）', () => {
  const idx = src.indexOf('new DotRunner(');
  assert.ok(idx > 0, '应有 DotRunner 构造');
  const call = src.slice(idx, idx + 3000);
  assert.ok(/memory:\s*memApiOf\(/.test(call), 'Runner 的 memory 端口应来自 memApiOf');
});
