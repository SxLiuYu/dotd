/**
 * tests/feishu-ws-card-callback.test.ts —— 卡片按钮回调必须有 handler。
 *
 * 现场（2026-10-21）：审批卡片发得出去，出站台账还记着「已发卡片」，
 * 但主人点「同意/拒绝」后 daemon 日志只有：
 *   [warn]: [ 'no card.action.trigger handle' ]
 * 事件被 SDK 丢弃，审批永远 pending、任务卡在 awaiting_approval。
 *
 * 根因：feishu-ws.ts 的 dispatcher.register({...}) 只列了 5 个 im 消息 / chat 成员事件，
 * 唯独漏了 card.action.trigger。而 feishu-inbound.ts 里明明写了完整的解析分支
 * （parseCardAction / 主人闸门 / kind:'card_action'）—— 入站那半条链路早就在，
 * 是**注册表**没把它接上去。
 *
 * 这类缺口单测很难自然覆盖（要连真飞书才触发），所以用静态守卫钉住：
 * inbound 会解析的每种事件类型，ws 必须都注册了 handler。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ws = readFileSync(join(here, '..', 'src', 'surfaces', 'feishu-ws.ts'), 'utf8');
const inbound = readFileSync(join(here, '..', 'src', 'surfaces', 'feishu-inbound.ts'), 'utf8');

function registeredEvents(): string[] {
  const m = /dispatcher\.register\(\{([\s\S]*?)\} as Record/.exec(ws);
  assert.ok(m !== null, 'feishu-ws.ts 里应有 dispatcher.register({...})');
  return [...m![1]!.matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]!);
}

test('card.action.trigger 必须在 dispatcher.register 里（否则按钮点了没人接）', () => {
  assert.ok(
    registeredEvents().includes('card.action.trigger'),
    '漏注册的后果：卡片发得出去、点了没反应，审批永远 pending。' +
      '日志特征：[warn]: no card.action.trigger handle',
  );
});

test('inbound 会处理的事件类型，ws 都得注册（别只写解析不接事件）', () => {
  // inbound 里以 eventType === 'xxx' 形式分支的事件
  const handled = new Set(
    [...inbound.matchAll(/eventType === '([^']+)'/g)].map((x) => x[1]!),
  );
  const reg = new Set(registeredEvents());
  for (const ev of handled) {
    assert.ok(reg.has(ev), `inbound 解析 ${ev}，但 ws 没注册它的 handler —— 这段代码永远不会执行`);
  }
});

test('注册表里每一项都走同一个 route() 包装（避免手写漏掉错误处理）', () => {
  const m = /dispatcher\.register\(\{([\s\S]*?)\} as Record/.exec(ws);
  const body = m![1]!;
  for (const ev of registeredEvents()) {
    assert.ok(
      body.includes(`'${ev}': route('${ev}')`),
      `${ev} 应该写成 route('${ev}')，保持统一错误处理与 trustedTransport 语义`,
    );
  }
});
