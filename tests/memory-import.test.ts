/**
 * tests/memory-import.test.ts —— 旧助手记忆导入（M4，2026-10-24）。
 *
 * 守四件事：
 *   1. 交接提示词包含"别带敏感信息 / 标推断 / 控制篇幅"这三条硬约束；
 *   2. 落盘路径必须是合法的 note 名（`notes/YYYY-MM-DD-import-<slug>.md`）；
 *   3. 16 KB 上限，超了拒绝而不是静默截断；
 *   4. 同一天同一来源重复导入 = 同一个路径（不堆 -2/-3），来源非法直接拒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_PROMPT,
  MAX_IMPORT_BYTES,
  buildImportNote,
  importNotePath,
  sourceSlug,
} from '../src/surfaces/memory-import.ts';
import { isNotePath } from '../src/memory/limits.ts';

const NOW = new Date('2026-10-24T09:30:00Z');

test('交接提示词：敏感内容 / 推断标注 / 篇幅上限三条都在', () => {
  assert.match(HANDOFF_PROMPT, /跳过敏感内容/);
  assert.match(HANDOFF_PROMPT, /\[推断\]/);
  assert.match(HANDOFF_PROMPT, /2000 字/);
  assert.match(HANDOFF_PROMPT, /只输出这份快照本身/);
});

test('sourceSlug：大小写/符号归一；纯中文退回 unknown 路径', () => {
  assert.equal(sourceSlug('ChatGPT'), 'chatgpt');
  assert.equal(sourceSlug(' my/old bot '), 'my-old-bot');
  assert.equal(sourceSlug('助手'), '');
  assert.equal(importNotePath('助手', NOW), 'notes/2026-10-24-import-unknown.md');
});

test('生成路径是合法 note（过 limits.isNotePath），且同一天同来源幂等', () => {
  const a = buildImportNote({ text: '## 偏好\n- 喜欢简短回答', source: 'ChatGPT', now: NOW });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.path, 'notes/2026-10-24-import-chatgpt.md');
  assert.equal(isNotePath(a.path), true, '路径必须过 NOTE_NAME_RE，否则写不进去');
  const again = buildImportNote({ text: '## 偏好\n- 喜欢更短的', source: 'chatgpt', now: NOW });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.path, a.path, '同一天同来源必须幂等');
});

test('内容头部带来源与导入时间（给未来的自己看）', () => {
  const r = buildImportNote({ text: '## 习惯\n- 早起', source: 'claude', now: NOW });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.content, /^source: claude\n/);
  assert.match(r.content, /imported_at: 2026-10-24T09:30:00\.000Z/);
  assert.match(r.content, /## 习惯\n- 早起\n$/);
  assert.equal(r.bytes, Buffer.byteLength(r.content, 'utf8'));
});

test('16 KB 上限：刚好内可过，超一截拒绝（不静默截断）', () => {
  const base = '## 偏好\n';
  const fit = base + 'x'.repeat(MAX_IMPORT_BYTES - base.length - 200);
  const ok = buildImportNote({ text: fit, source: 'chatgpt', now: NOW });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.ok(ok.bytes <= MAX_IMPORT_BYTES);

  const big = base + 'x'.repeat(MAX_IMPORT_BYTES);
  const bad = buildImportNote({ text: big, source: 'chatgpt', now: NOW });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error, 'TOO_LARGE');
    assert.match(bad.message, /拆成几份/);
  }
});

test('空内容 / 非法来源都明确拒绝', () => {
  const empty = buildImportNote({ text: '   \n', source: 'chatgpt', now: NOW });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error, 'EMPTY');

  const badSource = buildImportNote({ text: '## 偏好\n- a', source: '我的助手', now: NOW });
  assert.equal(badSource.ok, false);
  if (!badSource.ok) assert.equal(badSource.error, 'BAD_SOURCE');
});

test('CRLF 归一成 LF（旧助手多半是 Windows 换行）', () => {
  const r = buildImportNote({ text: '## 偏好\r\n- a\r\n', source: 'chatgpt', now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content.includes('\r'), false);
});

test('writeNote：只收 notes/YYYY-MM-DD-<slug>.md；写成功后进索引', async () => {
  const { MemoryServiceImpl } = await import('../src/memory/MemoryService.ts');
  const { makeStubFsOpsBridge } = await import('../src/memory/fsops-stub.ts');
  const { makeTempDataDir } = await import('./helpers.ts');
  const tmp = makeTempDataDir();
  try {
    const bridge = makeStubFsOpsBridge();
    bridge.put('MEMORY.md', 'updated: 2026-01-01\n## Interests\n');
    const writes: Array<{ path: string; text: string }> = [];
    const mem = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, text) => {
        writes.push({ path, text });
        return true;
      },
    });

    // 非 notes、非法命名、MEMORY.md 一律拒 —— 导入不能变成绕过记忆规范的旁路。
    for (const bad of ['MEMORY.md', 'notes/voice-proof.md', 'manuals/x.md', '../escape.md']) {
      const r = await mem.writeNote('dot1', bad, 'x');
      assert.equal(r.ok, false, `应拒绝 ${bad}`);
    }

    const built = buildImportNote({ text: '## 偏好\n- 简短', source: 'chatgpt', now: NOW });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const ok = await mem.writeNote('dot1', built.path, built.content);
    assert.equal(ok.ok, true);
    assert.deepEqual(writes, [{ path: built.path, text: built.content }]);

    const idx = tmp.db
      .prepare("SELECT path FROM mem_files_index WHERE dot_id = 'dot1' AND area = 'notes'")
      .all() as Array<{ path: string }>;
    assert.deepEqual(idx.map((r) => r.path), [built.path], '导入的笔记要进索引（可被检索/整理）');
  } finally {
    tmp.cleanup();
  }
});
