/**
 * tests/agent-runtime-axsnapshot.test.ts —— browser.snapshot 的真实实现（W1，2026-10-21）。
 *
 * ## 为什么需要它
 * `BrowserPage.snapshot()` 是 browser.ts 里声明的契约，但容器里跑的是
 * playwright-core 1.49.1，它的 Page 上**既没有 snapshot() 也没有 ariaSnapshot()**
 * （实测 getOwnPropertyNames 两者皆无）。之前 server.ts 直接
 * `as unknown as BrowserContextLike` 强转，类型上通过、运行时一调就
 * browser_crashed —— 契约与实现之间是断的，模型一"看"页面就崩。
 *
 * 修法是在适配层（agent-runtime/server.ts 的 adaptContext/axSnapshot）给每个
 * page 补一个真正的 snapshot()：走 CDP 的 Accessibility.getFullAXTree，这正是
 * ariaSnapshot 内部的同一数据源，等于手工实现官方新 API，零新依赖。
 *
 * ## 这些用例在验什么
 * 渲染规则本身（不是 CDP 有没有被调通 —— 那要真浏览器，只在容器里成立）：
 *   - ignored 节点不能切断子树（实测 RootWebArea 的子节点就是 ignored:none，
 *     整棵页面挂在它下面，早期版本在这里直接 return，快照只剩一行 RootWebArea）
 *   - StaticText 只在父节点已有同名 name 时才去重（否则 listitem/cell 的正文被吞）
 *   - 纯排版容器（none/generic/InlineTextBox）跳过自身、继续下探
 *   - 缩进表示层级、长 name 截断
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../agent-runtime/server.ts';

/** 造一棵 CDP AX 树（字段只放 axSnapshot 用到的）。 */
interface N {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
}

function fakePage(nodes: N[]): never {
  const cdp = {
    send: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      return {};
    },
    detach: async () => undefined,
  };
  return {
    context: () => ({ newCDPSession: async () => cdp }),
  } as never;
}

/** 直接调私有的 axSnapshot（它不碰网络，只依赖注入的假 CDP 会话）。 */
async function snap(nodes: N[]): Promise<string> {
  const rt = Object.create(AgentRuntime.prototype) as unknown as {
    axSnapshot(p: unknown): Promise<{ text: string; html?: string }>;
  };
  const out = await rt.axSnapshot(fakePage(nodes));
  return out.text;
}

test('ignored 节点不切断子树：RootWebArea → ignored:none → heading 仍能出现', async () => {
  // 复刻 Chrome 真实形态：RootWebArea 的唯一子节点是 ignored:none，
  // 真正的页面内容全在它下面。早期版本在这里直接 return，只剩一行 RootWebArea。
  const text = await snap([
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'none' }, ignored: true, childIds: ['4'] },
    { nodeId: '4', parentId: '2', role: { value: 'heading' }, name: { value: '产品列表' } },
  ]);
  assert.equal(text, 'RootWebArea\n  heading: 产品列表');
});

test('StaticText 父节点无 name 时保留（listitem 正文不被吞）', async () => {
  const text = await snap([
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'list' }, childIds: ['3', '5'] },
    { nodeId: '3', parentId: '2', role: { value: 'listitem' }, childIds: ['4'] },
    { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: '笔记本' } },
    { nodeId: '5', parentId: '2', role: { value: 'listitem' }, childIds: ['6'] },
    { nodeId: '6', parentId: '5', role: { value: 'StaticText' }, name: { value: '手机' } },
  ]);
  assert.equal(text, 'RootWebArea\n  list\n    listitem\n      StaticText: 笔记本\n    listitem\n      StaticText: 手机');
});

test('StaticText 与父节点同名时去重（heading 不重复输出两遍）', async () => {
  const text = await snap([
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: '提交' }, childIds: ['3'] },
    { nodeId: '3', parentId: '2', role: { value: 'StaticText' }, name: { value: '提交' } },
  ]);
  assert.equal(text, 'RootWebArea\n  button: 提交');
});

test('纯排版容器跳过自身但继续下探（generic 不产出空行）', async () => {
  const text = await snap([
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['3'] },
    { nodeId: '3', parentId: '2', role: { value: 'link' }, name: { value: '详情' } },
  ]);
  assert.equal(text, 'RootWebArea\n  link: 详情');
});

test('没有可读节点时返回空串（不产出噪声）', async () => {
  const text = await snap([{ nodeId: '1', role: { value: 'RootWebArea' } }]);
  assert.equal(text, 'RootWebArea');
});

test('超长 name 截断到 120 字符，避免单节点撑爆上下文', async () => {
  const long = 'x'.repeat(200);
  const text = await snap([
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'paragraph' }, name: { value: long } },
  ]);
  const line = text.split('\n')[1] ?? '';
  assert.ok(line.endsWith('…'), '应以省略号结尾');
  assert.equal(line.length, '  paragraph: '.length + 118);
});
