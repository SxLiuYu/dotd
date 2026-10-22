/**
 * tests/web-ui-thread-reuse.test.ts —— web 客户端必须回传 threadId。
 *
 * 现场（2026-10-22 查库）：
 *   mem_threads 里 1237 个 web 线程，external_ref 全为 NULL，平均 1-2 条消息。
 *   主人问"我刚才让你记的暗号"，模型看到空会话 → 答"这个会话刚开场"。
 *
 * 与 tests/surfaces-thread-reuse.test.ts 的分工：那个钉**服务端**是否接受 threadId
 * （http.ts 早就支持）；这个钉**客户端**是否真的把它发出去。服务端修好了，
 * 客户端不传，症状一模一样 —— 两头都得钉，否则回退时查不出来是哪边坏的。
 *
 * 根因：ChatView 把返回的 threadId 存进 state（第 112 行 setThreadId），
 * 却从来没在下一轮把它传回 api.send()。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = (p: string): string => readFileSync(join(here, '..', 'web-ui', 'src', p), 'utf8');

test('api.send 接受 threadId 并放进请求体', () => {
  const src = uiSrc('api.ts');
  assert.match(src, /send:\s*\(text: string, opts: \{/, 'send 必须能接收 threadId');
  assert.match(src, /threadId: opts\.threadId/, 'threadId 必须进请求体');
  // 空串/null 不能发出去（后端会把空串当脏 id）
  assert.match(src, /opts\.threadId\.length > 0/, '空 threadId 不应出现在请求体里');
});

test('ChatView 把当前 threadId 回传给 api.send', () => {
  const src = uiSrc(join('views', 'ChatView.tsx'));
  const calls = [...src.matchAll(/api\.send\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, '必须有 api.send 调用');
  for (const args of calls) {
    assert.ok(
      args !== undefined && args.includes('threadId'),
      `api.send 没带 threadId（收到 "${args ?? ''}"）—— 每轮都会新建会话，多轮对话接不上`,
    );
  }
});

test('服务端契约仍然支持 threadId（客户端改了服务端不能掉队）', () => {
  const src = readFileSync(join(here, '..', 'src', 'surfaces', 'http.ts'), 'utf8');
  assert.match(src, /const requested = \(body as \{ threadId\?: unknown \}\)\.threadId;/);
});
