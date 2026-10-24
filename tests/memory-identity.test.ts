/**
 * tests/memory-identity.test.ts —— 人格文件 IDENTITY.md（M3，2026-10-23）。
 *
 * 守住四条：
 *   1. 文件不存在 = 空串，不是错误，也不记 memory_missed；
 *   2. 超过 1 KB 截断（每轮都注入，不能让一份散文撑爆上下文）；
 *   3. 写入超过 1 KB 被拒（HARD_LIMIT），不静默截断主人刚写的内容；
 *   4. 没写人格时，请求体不产出 `sys:identity` 消息（与加功能前逐字一致）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import { readIdentityMd } from '../src/memory/inject.ts';
import { LIMIT_IDENTITY_MD } from '../src/memory/limits.ts';
import { RunContext } from '../src/runner/dot.ts';

test('文件不存在：空串，不报错', async () => {
  const bridge = makeStubFsOpsBridge();
  const id = await readIdentityMd(bridge, 'dot1');
  assert.equal(id.text, '');
  assert.equal(id.truncated, false);
});

test('有内容：原样读回；超过 1 KB 截断', async () => {
  const bridge = makeStubFsOpsBridge();
  bridge.put('IDENTITY.md', '叫主人老张，语气简短。');
  const ok = await readIdentityMd(bridge, 'dot1');
  assert.equal(ok.text, '叫主人老张，语气简短。');
  assert.equal(ok.truncated, false);

  bridge.put('IDENTITY.md', 'x'.repeat(LIMIT_IDENTITY_MD.hard + 100));
  const cut = await readIdentityMd(bridge, 'dot1');
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= LIMIT_IDENTITY_MD.hard);
});

test('buildContextBundle 注入 identityMd，并计入文件预算', async () => {
  const tmp = makeTempDataDir();
  const bridge = makeStubFsOpsBridge();
  try {
    bridge.put('MEMORY.md', 'updated: 2026-01-01\n## Interests\n- dotd\n');
    bridge.put('IDENTITY.md', '叫主人老张。');
    const mem = new MemoryServiceImpl({ db: tmp.db, bridge, outboxPath: tmp.outboxPath });
    const bundle = await mem.buildContextBundle('dot1', '任意任务', 4000);
    assert.equal(bundle.identityMd, '叫主人老张。');
    assert.ok(bundle.usedTokens > 0);
  } finally {
    tmp.cleanup();
  }
});

test('writeIdentity：超过 1 KB 拒绝；没 homeWriter 时说清楚；正常写入落盘', async () => {
  const tmp = makeTempDataDir();
  const bridge = makeStubFsOpsBridge();
  try {
    const mem = new MemoryServiceImpl({ db: tmp.db, bridge, outboxPath: tmp.outboxPath });
    const tooBig = await mem.writeIdentity('dot1', 'x'.repeat(LIMIT_IDENTITY_MD.hard + 1));
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error, 'HARD_LIMIT');

    const noWriter = await mem.writeIdentity('dot1', '短一点');
    assert.equal(noWriter.ok, false);
    assert.equal(noWriter.error, 'READONLY_PHASE');

    const writes: Array<{ path: string; text: string }> = [];
    const withWriter = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, text) => {
        writes.push({ path, text });
        return true;
      },
    });
    const ok = await withWriter.writeIdentity('dot1', '叫主人老张。');
    assert.equal(ok.ok, true);
    assert.deepEqual(writes, [{ path: 'IDENTITY.md', text: '叫主人老张。' }]);
  } finally {
    tmp.cleanup();
  }
});

test('请求体：没写人格 → 不产出 sys:identity；写了 → 产出且内容原样', () => {
  const ctx = new RunContext('测试任务');
  const none = ctx.buildMessages({ memoryMd: '', manualExcerpts: [], summary: null });
  assert.equal(none.find((m) => m.id === 'sys:identity'), undefined);

  const ctx2 = new RunContext('测试任务');
  const withId = ctx2.buildMessages({
    memoryMd: '',
    identityMd: '叫主人老张，语气简短。',
    manualExcerpts: [],
    summary: null,
  });
  const note = withId.find((m) => m.id === 'sys:identity');
  assert.ok(note !== undefined);
  assert.match(note.content, /叫主人老张/);
  assert.match(note.content, /IDENTITY\.md/);
});
