/**
 * tests/recover-text-calls.test.ts —— 正文里的 DSML 调用块（真机缺陷长期无测试）。
 *
 * 这个模块此前**零测试覆盖**（`grep -r recoverTextToolCalls tests/` 为空），
 * 而它守的是一个真实故障面：模型不按协议发 `tool_calls`，而是把调用块
 * 写在正文里。主循环的 completeLlm 接了兜底，但记忆补写轮直接调 router.complete、
 * 绕过了那层归一，于是想写的那条经验被静默丢掉、日志还看不出异常
 * （2026-10-22 真机，见 runner/dot.ts 补写轮那段注释）。
 *
 * 下面用的形状取自真机：
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="bash">
 *   <｜｜DSML｜｜ parameter name="command" string="true">curl -sS ...</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeTextToolCall,
  recoverTextToolCalls,
  stripTextToolCalls,
} from '../src/shared/recover-text-calls.ts';

const SEP = '｜｜DSML｜｜';

/** 造一个与真机同形的调用块（不依赖手写全角竖线，避免手误）。 */
function block(name: string, params: Array<[string, string, boolean?]>): string {
  const body = params
    .map(([k, v, isStr]) => `<${SEP} parameter name="${k}"${isStr === false ? ' string="false"' : ' string="true"'}>${v}</${SEP} parameter>`)
    .join('\n');
  return `<${SEP} calls>\n<${SEP} invoke name="${name}">\n${body}\n</${SEP} invoke>\n</${SEP} calls>`;
}

test('前置检查：只有真有调用块的正文才进入解析', () => {
  assert.equal(looksLikeTextToolCall(block('bash', [['command', 'echo hi']])), true);
  // 只是提到 DSML 但没 invoke → 不当作调用（否则正常回答会被误伤）
  assert.equal(looksLikeTextToolCall('我看到了 DSML 这个词'), false);
  // 有 invoke 但整段没有 DSML → 也不进（可能是普通文本举例）
  assert.equal(looksLikeTextToolCall('<invoke name="x"></invoke>'), false);
  assert.equal(looksLikeTextToolCall('普通回答，没有任何标签'), false);
});

test('捞回单个调用：工具名与字符串参数', () => {
  const out = recoverTextToolCalls(block('bash', [['command', 'curl -sS https://example.com']]));
  assert.equal(out.length, 1, `应捞回 1 个，实际 ${String(out.length)}`);
  assert.equal(out[0]!.name, 'bash');
  assert.deepEqual(JSON.parse(out[0]!.arguments), { command: 'curl -sS https://example.com' });
});

test('捞回多个调用：顺序保持', () => {
  const text = block('fs.write', [['path', '/dot/home/a.md'], ['content', 'A']]) + '\n' + block('fs.read', [['path', '/dot/home/a.md']]);
  const out = recoverTextToolCalls(text);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.name, 'fs.write');
  assert.equal(out[1]!.name, 'fs.read');
});

test('string="false" 的参数按 JSON 解析成数字/布尔/对象', () => {
  const text = block('demo', [
    ['n', '42', false],
    ['flag', 'true', false],
    ['obj', '{"a":1}', false],
  ]);
  const args = JSON.parse(recoverTextToolCalls(text)[0]!.arguments);
  assert.equal(args.n, 42, '应解析成数字而不是字符串 "42"');
  assert.equal(args.flag, true);
  assert.deepEqual(args.obj, { a: 1 });
});

test('string="false" 但内容不是合法 JSON → 退回原文本，不丢整轮调用', () => {
  // 这条是真机最容易踩的：模型给一个"看起来像 JSON 但其实不是"的值。
  // 旧式"一个参数失败就整轮丢弃"会让主人收到一句空话。
  const text = block('demo', [['weird', 'not json at all', false]]);
  const out = recoverTextToolCalls(text);
  assert.equal(out.length, 1, '不能因一个参数解析失败就丢掉整轮调用');
  assert.equal(JSON.parse(out[0]!.arguments).weird, 'not json at all');
});

test('参数正文里含引号与换行也要原样保留', () => {
  const content = 'line1 "quoted" line2\nline3';
  const text = block('fs.write', [['path', '/dot/home/x.md'], ['content', content]]);
  const args = JSON.parse(recoverTextToolCalls(text)[0]!.arguments);
  assert.equal(args.content, content, '正文必须一字不差（按标签扫描而不是正则截断的原因）');
});

test('strip：抹掉调用块后只留模型对人说的话', () => {
  const text = '先说明一下我要做什么。\n' + block('bash', [['command', 'ls']]) + '\n就这样。';
  const kept = stripTextToolCalls(text);
  assert.ok(kept.includes('先说明一下我要做什么。'), '调用块前的话要留住');
  assert.ok(kept.includes('就这样。'), '调用块后的话要留住');
  assert.ok(!kept.includes(SEP), '调用块本身必须抹干净，否则模型下一轮会模仿自己');
});

test('strip：整段都是调用块 → 返回空串（调用方按"无正文"处理）', () => {
  assert.equal(stripTextToolCalls(block('bash', [['command', 'ls']])), '');
});

test('回归：补写轮那种「裸标签被当成无工具调用」必须能被捞回', () => {
  // 2026-10-22 现场：记忆补写轮的 resultJson 就是这种裸标签，
  // 因为补写轮没接兜底，它被记成「补写轮无工具调用（正文 N 字）」，经验静默丢掉。
  const text = block('bash', [['command', 'echo test']]);
  assert.equal(looksLikeTextToolCall(text), true, '前置检查必须认得出来');
  assert.equal(recoverTextToolCalls(text).length, 1, '必须能捞回，补写轮才写得出经验');
});