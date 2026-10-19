/**
 * tests/memory-summary-input.test.ts —— 摘要输入必须只含对话语义，不能灌工具 JSON。
 *
 * 现场（2026-10-19）：会话摘要机制接通后，生成出来的"摘要"长这样：
 *   【新增对话】 user：创建 a.txt 内容写 111...
 *   system：{"call_id":"01M56WZNHSX...","tool":"fs.write","ok":true,"value":{...}}
 *   system：{"call_id":"01M56WZNKPW...","tool":"fs.write","ok":true,...}
 * 也就是**原始工具 JSON 被截断到 1800 字节**——等于没摘要。
 *
 * 根因：`transcript` 构造是 `usable.map(m => \`${m.role}：${m.content}\`)`，
 * 而 tool_result 的 content 就是完整 JSON。实测一个线程：122 条工具输出 17842 字节
 * vs 5 条对话 220 字节，**工具输出占 99%**，模型被 JSON 淹没。
 *
 * 修法：tool_result 压成记号 `（工具 fs.write✓）`，连续相同再折叠成 `×N`。
 * 实测同线程输入 17842 → 777 字节。
 *
 * 这个测试做源码守卫：确保压缩逻辑在，且没有退回"直接拼 content"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'memory', 'MemoryService.ts'), 'utf8');

/** 只取**代码行**（剥掉注释），避免注释里引用的旧写法造成误判。 */
function transcriptBlock(): string {
  const start = src.indexOf('const transcript = [');
  assert.ok(start > 0, 'MemoryService.ts 里应有 transcript 构造');
  const window = src.slice(Math.max(0, start - 3000), start + 900);
  const isComment = (l: string): boolean => {
    const t = l.trimStart();
    return t.startsWith('//') || t.startsWith('*');
  };
  return window.split('\n').filter((l) => !isComment(l)).join('\n');
}

test('摘要输入必须经过工具输出压缩（不能直接拼 m.content）', () => {
  const block = transcriptBlock();
  assert.ok(
    !/usable\.map\(\(m\) => `\$\{m\.role\}：\$\{m\.content\}`\)/.test(block),
    '不能再用 usable.map(...m.content) 直接拼 —— 那会把工具 JSON 全灌进摘要输入',
  );
  assert.ok(/compressForSummary/.test(block), '应有 compressForSummary 压缩函数');
});

test('连续相同的工具记号要折叠成 ×N（否则 73 行记号照样淹没对话）', () => {
  const block = transcriptBlock();
  assert.ok(/runCount/.test(block), '应有 runCount 计数折叠逻辑');
  assert.ok(/×\$\{runCount\}/.test(block) || /×/.test(block), '折叠后的记号应带 ×N');
});

test('压缩只吃 tool_result，对话消息保持原样', () => {
  const block = transcriptBlock();
  assert.ok(
    /if \(m\.kind !== 'tool_result'\) return/.test(block),
    'compressForSummary 应只处理 tool_result，其它 kind 原样返回',
  );
});
