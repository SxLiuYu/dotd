/**
 * tests/shared-tool-stream.test.ts —— 流式工具调用**增量聚合器**（src/shared/tool-stream.ts）。
 *
 * 为什么单独测它：各家 OpenAI 兼容网关的 `delta.tool_calls` 并不统一，聚合规则是整个
 * 流式工具链路里唯一需要"猜"的地方。这里的每条用例对应聚合器文件头的一条容错策略，
 * 并给出"不丢调用、不乱拼参数"的硬断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamToolCallAccumulator } from '../src/shared/tool-stream.ts';
import type { StreamToolCallDelta } from '../src/shared/contracts.ts';

/** 把一段参数串按 4 字节切片，模拟真流式。 */
const slices = (s: string): string[] => s.match(/.{1,4}/gs) ?? [];

test('标准形状：index 相同 → 按序拼接 name 与参数，id 取首块', () => {
  const acc = new StreamToolCallAccumulator();
  const args = '{"path":"/dot/home/notes.md","limit":10}';
  const parts = slices(args);
  acc.push([{ index: 0, id: 'call_a', name: 'fs.read', argumentsDelta: parts[0] ?? '' }]);
  for (const p of parts.slice(1)) acc.push([{ index: 0, argumentsDelta: p }]);
  assert.deepEqual(acc.settle(), [{ id: 'call_a', name: 'fs.read', arguments: args }]);
});

test('容错 1：index 缺失 → 归到"当前打开的调用"（不另开新调用）', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_b', argumentsDelta: '{' }]);
  acc.push([{ name: 'fs.list' } as StreamToolCallDelta]); // 无 index
  acc.push([{ argumentsDelta: '}' } as StreamToolCallDelta]); // 无 index
  assert.deepEqual(acc.settle(), [{ id: 'call_b', name: 'fs.list', arguments: '{}' }]);
});

test('容错 2：多个调用乱序到达 → 按 index 升序输出，各自参数不串', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([
    { index: 1, id: 'call_2', name: 'fs.list', argumentsDelta: '{"p":2}' },
    { index: 0, id: 'call_1', name: 'fs.read', argumentsDelta: '{"p":1}' },
  ]);
  assert.deepEqual(acc.settle(), [
    { id: 'call_1', name: 'fs.read', arguments: '{"p":1}' },
    { id: 'call_2', name: 'fs.list', arguments: '{"p":2}' },
  ]);
});

test('容错 3：一次下发整段参数（非真流式网关）→ 结果与增量一致', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_c', name: 'shell.run', argumentsDelta: '{"cmd":"ls -la"}' }]);
  assert.deepEqual(acc.settle(), [{ id: 'call_c', name: 'shell.run', arguments: '{"cmd":"ls -la"}' }]);
});

test('容错 4：name 被拆成多块 → 拼回全名；重复重发同一段不重复追加', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, name: 'browser', argumentsDelta: '' }]);
  acc.push([{ index: 0, name: '.open' }]);
  acc.push([{ index: 0, name: 'browser' }]); // 幂等重发前缀 → 忽略
  acc.push([{ index: 0, name: 'browser.open' }]); // 整段重复 → 忽略
  acc.push([{ index: 0, argumentsDelta: '{"url":"https://example.com"}' }]);
  assert.deepEqual(acc.settle(), [
    { id: 'call_0', name: 'browser.open', arguments: '{"url":"https://example.com"}' },
  ]);
});

test('容错 5：id 缺失 → 补稳定占位（call_<index>），不伪造到已有调用上', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 3, name: 'fs.stat', argumentsDelta: '{}' }]);
  assert.deepEqual(acc.settle(), [{ id: 'call_3', name: 'fs.stat', arguments: '{}' }]);
});

test('容错 6：同一 index 连续重发新调用（网关每块都 index:0）→ 不互相覆盖', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: 'c1', name: 'fs.read', argumentsDelta: '{"p":1}' }]);
  acc.push([{ index: 0, id: 'c2', name: 'fs.list', argumentsDelta: '{"p":2}' }]);
  assert.deepEqual(acc.settle(), [
    { id: 'c1', name: 'fs.read', arguments: '{"p":1}' },
    { id: 'c2', name: 'fs.list', arguments: '{"p":2}' },
  ]);
});

test('空参数 → {}；无 name 的调用被丢弃（派发出去只会拿到 deny）', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: 'c_ok', name: 'fs.list', argumentsDelta: '' }]);
  acc.push([{ index: 1, id: 'c_noname', argumentsDelta: '{"x":1}' }]);
  assert.deepEqual(acc.settle(), [{ id: 'c_ok', name: 'fs.list', arguments: '{}' }]);
});

test('坏 JSON 参数原样保留（不猜、不修，交由 stepTool 记账）', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: 'c_bad', name: 'fs.read', argumentsDelta: '{"path":' }]);
  assert.deepEqual(acc.settle(), [{ id: 'c_bad', name: 'fs.read', arguments: '{"path":' }]);
});

test('size：纯文本回合（无工具调用）为 0，供空壳判据区分', () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, argumentsDelta: '' }]);
  assert.equal(acc.size, 0);
  acc.push([{ index: 0, name: 'fs.list' }]);
  assert.equal(acc.size, 1);
});
