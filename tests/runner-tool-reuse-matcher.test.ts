/**
 * tests/runner-tool-reuse-matcher.test.ts —— S2(b) 的匹配器判据。
 *
 * 背景：提示词 3 次全败（见 docs/prompt-attempts.md），转代码约束。
 * 代码约束的核心风险是**误伤**：把"确实该用 shell.run 的活"判成"有现成工具"。
 *
 * 所以这个测试的重点不是"能匹配上"，而是**不该匹配的别匹配**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// 匹配器是 dot.ts 里的模块级函数，通过动态导入取（未导出则跳过并提示）
import { matchToolForGoal } from '../src/runner/dot.ts';

const WORD_COUNT = {
  name: 'word-count',
  description: '统计一段文本的中文字符数与英文单词数：中文按汉字（CJK 统一表意文字）逐字计数，英文单词按连续字母序列计数，另返回字符总数与分词细节',
};

test('应命中：goal 直接提到工具名', () => {
  const r = matchToolForGoal('用 word-count 统计这段话', [WORD_COUNT]);
  assert.ok(r !== null, '提到工具名必须命中');
  assert.equal(r!.name, 'word-count');
});

test('应命中：goal 与工具描述语义重叠', () => {
  const r = matchToolForGoal('统计一下这句话：中文和英文单词各有多少', [WORD_COUNT]);
  assert.ok(r !== null, '中文 bigram "统计/中文/英文/单词" 应命中');
  assert.equal(r!.name, 'word-count');
});

test('不应命中：无关任务（防误伤）', () => {
  const cases = [
    '把 /dot/home/a.txt 重命名为 b.txt',
    '列出当前目录下所有文件',
    '你好',
    '帮我算一下 350 减 405 等于多少',
    '查一下 https://api.github.com/zen 返回什么',
    '把这份 PDF 转成文本',
  ];
  for (const goal of cases) {
    const r = matchToolForGoal(goal, [WORD_COUNT]);
    assert.equal(r, null, `「${goal}」不该被判成"有现成工具"（会误伤 shell.run）`);
  }
});

test('不应命中：只有一个词重叠（阈值是 2）', () => {
  // "统计" 单个 bigram 重叠，不够
  const r = matchToolForGoal('统计有多少行', [WORD_COUNT]);
  assert.equal(r, null, '单个 bigram 重叠不该命中');
});

test('多个工具时选分数最高的', () => {
  const other = {
    name: 'pdf-extract',
    description: '从 PDF 文件中提取文本内容，支持扫描件 OCR',
  };
  const r = matchToolForGoal('统计这段中文和英文单词数', [other, WORD_COUNT]);
  assert.ok(r !== null);
  assert.equal(r!.name, 'word-count', '应选中语义更接近的那个');
});

test('空工具列表返回 null', () => {
  assert.equal(matchToolForGoal('统计中文字数', []), null);
});
