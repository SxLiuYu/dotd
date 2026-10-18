/**
 * tests/surfaces-thread-reuse.test.ts —— POST /api/messages 带 threadId 必须复用会话。
 *
 * 现场（2026-10-18 多轮会话测试）：
 *   同一条 thread 里问"我刚才让你记的暗号是什么"，模型答
 *   「这个会话刚开场——你发的这条是第一句话…所以我们目前还没聊过别的事」。
 *
 * 根因：`http.ts` 的 messages 分支**无条件** `openThread(dotId,'web')` 新建会话，
 * 完全忽略请求体里的 threadId。于是每次 POST 都是新会话，多轮对话永远接不上。
 *
 * 本文件钉住：
 *   ① 带已知 threadId → 复用（新任务挂到同一个 thread）；
 *   ② 带不存在的 threadId → 404，不静默新建（否则主人以为接上了其实没接）；
 *   ③ 不带 threadId → 照旧新建（兼容原有调用方）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'surfaces', 'http.ts'), 'utf8');

test('messages 分支会读取请求体里的 threadId', () => {
  assert.match(
    src,
    /const requested = \(body as \{ threadId\?: unknown \}\)\.threadId;/,
    '必须从请求体读 threadId',
  );
});

test('带已知 threadId 时复用，而不是无条件 openThread 新建', () => {
  // 反例守卫：不能出现"先无条件 openThread 再赋值"的老写法
  const openCall = src.indexOf('await deps.mem.openThread(dotId');
  assert.ok(openCall >= 0, '仍应保留新建路径（不带 threadId 时用）');
  // openThread 必须出现在 else 分支里（即"没带 threadId"才新建）
  const messagesStart = src.indexOf("case 'messages': {");
  const requestedDecl = src.indexOf('const requested = (body as { threadId', messagesStart);
  assert.ok(messagesStart >= 0 && requestedDecl > messagesStart, '必须先读 threadId 再决定');
  assert.ok(
    src.slice(requestedDecl, openCall).includes('} else {'),
    'openThread 必须落在 else（未提供 threadId）分支里',
  );
});

test('不存在的 threadId 返回 404，不静默新建', () => {
  const block = src.slice(
    src.indexOf('const requested = (body as { threadId'),
    src.indexOf('await deps.mem.appendMessage(threadId', src.indexOf('const requested = (body as { threadId')),
  );
  assert.ok(block.includes('404'), '未知会话必须 404');
  assert.ok(block.includes('not_found'), '错误码用 not_found');
  assert.ok(block.includes('listThreads'), '必须真的校验会话存在');
});
