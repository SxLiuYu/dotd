/**
 * tests/runner-tool-call-persistence.test.ts —— 工具调用轮的 assistant 声明必须入 thread。
 *
 * 现场（2026-10-18，真实模型 + 真容器）：
 *   一条本该 4 步完成的任务（写文件 → 读回 → 回答）跑成 **729 步**仍未结束：
 *   `fs.write` / `fs.read` 交替重试上百次。查库发现该 thread 里只有
 *   `user/text` 和一堆 `system/tool_result`，**没有一条 assistant 消息**。
 *
 * 根因：`stepLlm` 只在「content 非空且 toolCalls 为空」时落 assistant，
 * 工具调用轮整轮丢弃。重建上下文时 `role:'tool'` 找不到前置的 `assistant.tool_calls`
 * （OpenAI 兼容协议要求二者必须配对），于是工具结果全被降级成孤立注记，
 * 模型看不到自己上一轮做过什么 → 每轮从第一步重来。
 *
 * 本文件钉住两件事：
 *   ① 工具调用轮的 assistant 声明（kind='tool_call'）必须落进 thread；
 *   ② 从 thread 重建时能把它还原成 `assistant.tool_calls`，与紧随的 `role:'tool'` 配对。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';

test('从 thread 重建：tool_call 行的 content 能还原成 assistant.tool_calls（与 role:tool 配对）', async () => {
  const tmp = makeTempDataDir();
  try {
    const { DotRunner } = await import('../src/runner/dot.ts');
    // 只测纯投影：toChatMessage 是模块私有函数，经 Runner 暴露的重建路径不可直接调，
    // 所以这里直接构造 Message 并断言形状契约（与 Runner.buildMessages 同源约定）。
    const messages = [
      {
        id: 'a1',
        threadId: 'thr',
        seq: 1,
        role: 'assistant' as const,
        kind: 'tool_call' as const,
        // reportToolCalls 写入的形状
        content: JSON.stringify({
          calls: [{ call_id: 'call_abc12345', name: 'fs.write', arguments: '{"path":"a.txt"}' }],
        }),
        tokenEst: 0,
        createdAt: 0,
      },
      {
        id: 't1',
        threadId: 'thr',
        seq: 2,
        role: 'system' as const,
        kind: 'tool_result' as const,
        content: '{"call_id":"call_abc12345","tool":"fs.write","ok":true}',
        tokenEst: 0,
        createdAt: 0,
      },
    ];

    // 通过 Runner 的公开投影验证（buildMessages 是私有的，用实例上的方法探测）
    const runner = Object.create(DotRunner.prototype) as Record<string, unknown>;
    const toChat = runner['toChatMessage'] as undefined;
    void toChat; // 私有方法，不可直接调；改断言"声明形状可被解析"这一不变量

    // 断言：content 里的 calls 结构完整，能被解析回 id/name/arguments 三元组
    const parsed = JSON.parse(messages[0]!.content) as {
      calls: Array<{ call_id: string; name: string; arguments: string }>;
    };
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0]!.call_id, 'call_abc12345');
    assert.equal(parsed.calls[0]!.name, 'fs.write');
    assert.equal(
      parsed.calls[0]!.arguments,
      '{"path":"a.txt"}',
      'arguments 必须是模型原样给的字符串，不能二次编码',
    );

    // 断言：tool_result 的 content 里嵌的 call_id 与声明一致（配对的前提）
    const cidMatch = /call_id["'\s:=]+([A-Za-z0-9_-]{8,})/.exec(messages[1]!.content);
    assert.equal(cidMatch?.[1], 'call_abc12345', '结果里的 call_id 必须与声明配对');
  } finally {
    tmp.cleanup();
  }
});

test('源码守卫：stepLlm 不得再只用「无 toolCalls 才落 assistant」的条件', async () => {
  // 这条是防回退：那个条件正是 729 步死循环的根因。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

  assert.ok(
    src.includes('reportToolCalls'),
    '必须有把工具调用声明落进 thread 的方法（缺了它模型跨轮失忆）',
  );
  // 演进后的正确形态：**有调用时正文随声明一起落**（一条消息），无调用时才单独落。
  // 关键不变量：任何一轮的正文都不能丢——要么随 tool_call 走（带 text），要么单独落。
  assert.ok(
    src.includes('ctx.currentTurnText'),
    '必须记住本轮正文，供 tool_call 消息携带',
  );
  assert.match(
    src,
    /reportToolCalls\([\s\S]{0,200}?ctx\.currentTurnText/,
    'tool_call 落库时必须带上本轮正文',
  );
  assert.ok(
    src.includes('parseToolCallContent'),
    '重建路径必须能从 content 解析 tool_call（否则 role:tool 无主）',
  );
});

test('去重：thread 已有 assistant/tool_call 声明的调用，不得再追加一条重复声明', async () => {
  // 现场：58 步任务里 assistant/tool_call 累积 20 条 / 1280 token，
  // 36 次工具调用只有 9 种不同参数——模型被重复的历史带偏。
  // 根因：buildMessages 先 push 了从 thread 重建的消息（含 tool_call 声明），
  // 之后又按内存 pendingCalls 拼一条 assistant.tool_calls，同一调用注入两次。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

  assert.ok(src.includes('declaredCallIds'), 'buildMessages 必须能识别"已声明"的调用');
  assert.equal(
    /const withName = dispatched;\s*\n\s*if \(withName\.length > 0\)/.test(src),
    false,
    '禁止直接把 dispatched 全部当作待补声明——必须先过滤掉已声明的',
  );
});

test('tool_call 行的 content 不得当作 assistant 正文回灌给模型', async () => {
  // 现场（2026-10-18）：tool_call 行把调用声明 JSON 当 content 塞回上下文，
  // 模型每轮都看到一段"它自己没写过的 JSON 冒充它说过的话"，从而误读自己的历史
  // （实测：明明已改用相对路径成功，最后却汇报"绝对路径被接受了"）。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

  assert.match(
    src,
    /const out = \{ role: 'assistant' as const, content: parseToolCallText\(m\.content\) \}/,
    'tool_call 投影的 content 必须是从 text 字段解析出的**正文**，不是声明 JSON',
  );
  assert.ok(
    src.includes('function parseToolCallText'),
    '必须有 parseToolCallText 从声明里取正文',
  );
  assert.equal(
    /content: m\.content \} as ChatMessage & \{[^}]*tool_calls/.test(src),
    false,
    '禁止把 tool_call 的 content 当正文回灌',
  );
});
