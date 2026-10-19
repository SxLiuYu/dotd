/**
 * tests/memory-fts-not-in-hot-path.test.ts —— FTS 全量对账不许在写消息的热路径上。
 *
 * 现场（2026-10-19）：冷启动后第一次发消息要等 15 秒。分层测下来：
 *
 *   openThread:          4.6 ms
 *   appendMessage:   15884.8 ms   ← 就是它
 *   buildContextBundle: 21.8 ms
 *
 * 根因：`ftsProbe()` 里有一句
 *
 *   if (!this.ftsBackfilled) { this.ftsBackfilled = true; this.ensureMessageFts(); }
 *
 * 注释写的是"不进入热路径"，但它**就在热路径上**：
 * ftsProbe ← syncMessageFts ← appendMessage ← POST /api/messages。
 * 冷启动首写触发 `resyncMessageFts()` 全量重灌 5349 条索引 = 15.9 秒。
 *
 * 修法：冷启动对账挪到 daemon 启动期（`memory.ensureMessageFts()`），
 * ftsProbe 只保留轻量探活。
 *
 * 实测效果：POST /api/messages 15.51s → 0.026s（快了约 600 倍），
 *          appendMessage 15884ms → 16.8ms。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const memSrc = readFileSync(join(here, '..', 'src', 'memory', 'MemoryService.ts'), 'utf8');
const daemonSrc = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');

/** 取 ftsProbe 的函数体（代码行，剥注释）。 */
function ftsProbeBody(): string {
  const idx = memSrc.indexOf('private ftsProbe()');
  assert.ok(idx > 0, 'MemoryService.ts 里应有 ftsProbe');
  const window = memSrc.slice(idx, idx + 1600);
  return window
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

test('ftsProbe 不得触发全量对账（ensureMessageFts / resyncMessageFts）', () => {
  const body = ftsProbeBody();
  assert.ok(
    !/ensureMessageFts\(\)/.test(body),
    'ftsProbe 里调 ensureMessageFts 会让首次写消息承担全量重灌（实测 15.9 秒）',
  );
  assert.ok(
    !/resyncMessageFts\(\)/.test(body),
    'ftsProbe 里调 resyncMessageFts 同理 —— 这两者只能出现在启动期',
  );
});

test('daemon 启动期做 FTS 对账', () => {
  assert.ok(
    /memory\.ensureMessageFts\(\)/.test(daemonSrc),
    'daemon 应在启动阶段调用 memory.ensureMessageFts()，把对账开销挪出用户请求路径',
  );
});
