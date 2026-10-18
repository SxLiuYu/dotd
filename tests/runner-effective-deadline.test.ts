/**
 * tests/runner-effective-deadline.test.ts —— 模型传的 timeout_ms 必须真正生效。
 *
 * 现场（2026-10-18）：模型用 `shell.run` 传 `timeout_ms: 600000`（10 分钟），
 * 但 Runner 侧 sync 档固定 60 秒，**工具参数被完全忽略**。
 * 同一概念（超时）两处说法不一致：工具说"可以等 10 分钟"，Runner 说"我只等 1 分钟"。
 * 模型据此做的判断（"这命令慢，把超时设长点"）全部落空。
 *
 * 规则（取较小值）：
 *   - 模型要求更短 → 听模型的（短超时是它自己的选择）；
 *   - 模型要求更长 → 被档位上限截断（安全兜底不能被工具参数绕过）；
 *   - 参数非法/缺失 → 用档位默认。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

test('runTool 用的是「模型要求」与「档位上限」的较小值', () => {
  assert.ok(src.includes('effectiveDeadlineMs'), '必须有统一的 deadline 选档函数');
  const idx = src.indexOf('private effectiveDeadlineMs(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  }', idx) + 4);
  assert.ok(body.includes('Math.min(want, cap)'), '必须取较小值');
  assert.ok(body.includes("args['timeout_ms']"), '必须读取模型传的 timeout_ms');
});

test('非法 timeout_ms（0/负数/非数字）不生效，回落到档位默认', () => {
  const idx = src.indexOf('private effectiveDeadlineMs(');
  const body = src.slice(idx, src.indexOf('\n  }', idx) + 4);
  assert.match(
    body,
    /typeof want !== 'number' \|\| !Number\.isFinite\(want\) \|\| want <= 0/,
    '必须过滤非正数/非有限值',
  );
  assert.ok(body.includes('return cap'), '非法时回落档位默认');
});

test('派发点已切到 effectiveDeadlineMs（不再是写死的档位值）', () => {
  assert.match(
    src,
    /toolCall\(task, callId, call\.name, args, this\.effectiveDeadlineMs\(call\.name, args\)\)/,
    'runTool 必须用 effectiveDeadlineMs',
  );
});
