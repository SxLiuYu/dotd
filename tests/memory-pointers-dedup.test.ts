/**
 * tests/memory-pointers-dedup.test.ts —— MEMORY.md 的 Pointers 不能重复。
 *
 * 现场（2026-10-19）：主人交代"项目代号 PHOENIX / 下周一演示 / 负责支付"三件事，
 * 两轮任务各自写了一条笔记（`phoenix-payment-demo.md` 和 `phoenix-project-demo.md`，
 * 内容实质相同），两条都进了 MEMORY.md 的 Pointers。
 *
 * Pointers 是有条数上限的展示列表（实测只显示 10 条，而 notes 有 20 个），
 * 重复项会挤掉真正该被看到的条目。
 *
 * 修法只做**路径级去重**（同一个 path 只留最后一条），不动"什么算同一件事"的语义判断
 * —— 那是模型的活，这里只保证"同一个文件不在列表里出现两次"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMemoryMd } from '../src/memory/inject.ts';

test('同一 path 出现多次时，Pointers 只保留一条（且是最后一条）', () => {
  const md = `# MEMORY (index)
updated: 2026-10-19

## Interests

## Current concerns
- PHOENIX 项目

## Pointers
- notes/a.md # 旧说明
- notes/b.md
- notes/a.md # 新说明
`;
  const parsed = parseMemoryMd(md);
  const paths = parsed.pointers.map((p) => p.path);
  assert.equal(paths.filter((p) => p === 'notes/a.md').length, 1, 'notes/a.md 应只出现一次');
  assert.equal(paths.length, 2, '总共应有 2 条（a 和 b）');
  // 保留最后一条
  const a = parsed.pointers.find((p) => p.path === 'notes/a.md');
  assert.equal(a?.note, '新说明', '重复项应保留后写的那条（更新的）');
});

test('没有重复时行为不变（顺序保持）', () => {
  const md = `## Pointers
- notes/x.md # X
- notes/y.md # Y
- notes/z.md # Z
`;
  const parsed = parseMemoryMd(md);
  assert.deepEqual(
    parsed.pointers.map((p) => p.path),
    ['notes/x.md', 'notes/y.md', 'notes/z.md'],
  );
});
