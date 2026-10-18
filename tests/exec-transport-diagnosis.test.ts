/**
 * tests/exec-transport-diagnosis.test.ts —— 传输层失败必须给出可定位的诊断。
 *
 * 现场（2026-10-18 容器故障测试）：任务执行中 `docker kill` 容器，工具返回
 *
 *     {"code":"transport_error","message":"fetch failed","retryable":true}
 *
 * 模型据此判断"是工具到执行器之间的传输层故障，重试无意义"——**推理完全正确**，
 * 但它（和主人）拿到的信息只有 `fetch failed`，看起来像网络问题，实际是容器没了。
 *
 * 修法：失败时补一次轻量诊断（先看 fleet 状态机，再看端点），把"容器挂了"翻译成
 * 人话写进 message。关键纪律：**诊断只帮忙、不掩盖**——探测本身失败就返回原错误。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');

test('failDispatch 会做诊断并把结果拼进 message', () => {
  const idx = src.indexOf('private async failDispatch(');
  assert.ok(idx > 0, '必须有 failDispatch');
  const body = src.slice(idx, src.indexOf('\n  }', idx) + 4);
  assert.ok(body.includes('diagnoseTransportFailure'), '必须调用诊断');
  assert.ok(
    body.includes('diagnosis === null ? errText(cause)'),
    '没诊断出来时必须保持原始错误（不能掩盖）',
  );
  assert.ok(body.includes('${diagnosis}'), '有诊断时必须拼进 message');
});

test('诊断先看 fleet 状态机（最便宜且最准确）', () => {
  const idx = src.indexOf('private async diagnoseTransportFailure');
  assert.ok(idx > 0);
  const body = src.slice(idx, idx + 1600);
  assert.ok(body.includes('getContainer('), '必须先查容器状态');
  assert.ok(
    body.includes("'unhealthy'") && body.includes("'lost'"),
    '要覆盖 unhealthy/lost 等"容器没了"的状态',
  );
  // 端点探测必须有超时，不能拖住主流程
  assert.ok(body.includes('AbortSignal.timeout'), '端点探测必须有超时');
});

test('诊断函数自身出错时返回 null（不因为诊断把错误变成另一种错误）', () => {
  const idx = src.indexOf('private async diagnoseTransportFailure');
  const body = src.slice(idx, idx + 2000);
  assert.ok(body.includes('catch'), '诊断必须自带 catch');
  assert.match(body, /catch\s*\{\s*\n?\s*return null;/, '诊断失败一律返回 null');
});
