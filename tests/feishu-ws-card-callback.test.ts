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

test('卡片回调的结果卡必须随 route() 返回（2026-10-27，PATCH 被回包冲掉的修复）', () => {
  // 现场：主人点「同意」→ PATCH 全成功 → 客户端先显示已同意 → 又刷回按钮。
  // SDK 的回包协议：handler 的返回值非空才写进 respPayload.data，成为这张卡
  // 的落定状态。route() 返回 void = 回包无卡 = 飞书按点击时版本落定。
  // 所以 card.action.trigger 的结果卡必须被 route() 返回出去。
  assert.ok(
    /eventType === 'card\.action\.trigger'[\s\S]{0,600}?return toCardCallbackResponse\(/.test(ws),
    'route() 里必须把结果卡包好后 return，否则回包无卡，飞书把卡片回退成点击前的样子',
  );
  // 回空包的其它事件保持 undefined（旧行为）。
  assert.ok(ws.includes('return undefined;'), '非卡片事件的回包仍应为空（不引入新的回包语义）');
});

test('结果卡必须包成 {card:{type:"raw",data}}（2026-10-27 二次修：裸卡片飞书不认）', () => {
  // 主人复现「还是刷新回去了」——第一次修只把卡片 return 出去，形状仍是裸卡片。
  // 飞书 v2 回调的响应体是 { card: { type: 'raw'|'template', data: <卡片JSON> } }，
  // 顶层直接放卡片 JSON 是无效结构，飞书解析不到 → 按点击时版本落定。
  // 这条守卫钉住「必须经过 toCardCallbackResponse」，防止有人图省事直接 return card。
  assert.ok(
    /import \{[^}]*toCardCallbackResponse[^}]*\} from '\.\/feishu-card\.ts'/.test(ws),
    'feishu-ws.ts 必须从 feishu-card.ts 导入 toCardCallbackResponse',
  );
  assert.ok(
    !/return card;/.test(ws),
    '不能裸 return card —— 必须是 toCardCallbackResponse(card)，否则回包结构无效',
  );
  const cardSrc = readFileSync(join(here, '..', 'src', 'surfaces', 'feishu-card.ts'), 'utf8');
  assert.ok(
    /card: \{ type: 'raw', data: card \}/.test(cardSrc),
    'toCardCallbackResponse 必须产出 { card: { type: "raw", data } }',
  );
});
