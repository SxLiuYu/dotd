/**
 * tests/governance-catalog-coverage.test.ts —— 能力表与治理白名单必须对得上。
 *
 * 为什么需要这个文件（2026-10-22 实测）：
 *
 * 查出 4 个工具「实现写完了、却调用不到」，分两种断法：
 *
 *   1. 白名单断：`fs.grep`（容器侧实现在 agent-runtime/fs.ts:394）、
 *      `memory.search`（宿主侧实现在 daemon.ts:1692）——
 *      实现齐全、能力表里也有名字，但 config/tools.yml 没登记。
 *      而 gate.ts:325 写死「未登记 ⇒ deny」，于是模型每次调用都拿到 deny。
 *      这种失败在日志里长得像「模型自己决定不做」，极难发现。
 *
 *   2. 能力目录断：`calendar.list` / `calendar.conflicts`——
 *      在 daemon.ts:1279/1290 注册了、tools.yml 也登记了，
 *      但 getCapabilities 只合并「既在 CAPABILITY_CATALOG、又在 HOST_SIDE_TOOLS」
 *      的工具（ExecService.ts:1144），两个条件缺一个模型就永远看不见这个名字。
 *      同样的坑 2026-10-18 已经踩过一次（schedule.create，注释还在 ExecService.ts:261）。
 *
 * 当时的测试为什么没抓到：agent-runtime-protocol.test.ts 断言「能力表内部自洽」，
 * governance-review-catalog.test.ts 断言「白名单内部自洽」，
 * **没有任何一条断言两者的交集**。这里补上交集。
 *
 * 这两条断言都直接跑仓库里的真实 config/tools.yml 与真实 CAPABILITY_CATALOG，
 * 不是构造夹具——夹具会跟着实现一起改，就失去了对账意义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CAPABILITY_CATALOG } from '../src/exec/protocol.ts';
import { loadCatalogFile } from '../src/governance/catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_YML = join(HERE, '..', 'config', 'tools.yml');

/** 用真实文件读白名单（不经任何测试夹具）。 */
function registeredNames(): string[] {
  const loaded = loadCatalogFile(TOOLS_YML);
  return [...loaded.catalog.tools.keys()];
}

/**
 * 唯一的合法例外：`mcp.call` 是治理网关工具，它按设计不进 CAPABILITY_CATALOG
 * （见 ExecService.ts 的 MCP_CALL_CAPABILITY 与 visibleCaps：未声明 MCP server 时
 * 它必须**不可见**，不能让模型看到一个永远失败的调用口）。
 */
const ALLOWED_IN_WHITELIST_ONLY = new Set(['mcp.call']);

test('能力表里的每个工具都必须在 tools.yml 登记（否则 gate.ts 一律 deny）', () => {
  const registered = new Set(registeredNames());
  const missing = CAPABILITY_CATALOG.map((c) => c.name).filter((n) => !registered.has(n));
  assert.deepEqual(
    missing,
    [],
    `这些工具在能力表里有、模型也看得见，但 tools.yml 没登记，` +
      `调用会被 gate.ts:327 判「工具未登记」而 deny：${missing.join(', ')}`,
  );
});

test('tools.yml 登记的每个工具都必须有真实去处（能力表或设计上的例外）', () => {
  const caps = new Set(CAPABILITY_CATALOG.map((c) => c.name));
  const orphan = registeredNames().filter(
    (n) => !caps.has(n) && !ALLOWED_IN_WHITELIST_ONLY.has(n),
  );
  assert.deepEqual(
    orphan,
    [],
    `这些工具在白名单里登记了，但既不在能力表、也不是设计上的例外——` +
      `多半是删实现时漏删登记：${orphan.join(', ')}`,
  );
});

test('两侧规模对得上（白名单 = 能力表 + 设计上的例外）', () => {
  const registered = registeredNames();
  assert.equal(
    registered.length,
    CAPABILITY_CATALOG.length + ALLOWED_IN_WHITELIST_ONLY.size,
    '白名单条数 = 能力表条数 + 例外条数',
  );
  assert.equal(new Set(registered).size, registered.length, '白名单里不能有重名工具');
});

test('宿主侧工具必须同时在能力表与 HOST_SIDE_TOOLS（否则模型看不见）', async () => {
  // 这一条防的是「能力目录断」：daemon.registerHostTool 注册了实现，
  // 但如果 getCapabilities 合并时选不中它，模型就永远不知道有这个工具。
  // 直接扫源码拿到真实名单，比手工维护一份列表更难过期。
  const src = readFileSync(join(HERE, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');
  const m = /const HOST_SIDE_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m !== null, 'ExecService.ts 里找不到 HOST_SIDE_TOOLS 集合');
  const body = m[1] ?? '';
  const hostSide = new Set([...body.matchAll(/'([^']+)'/g)].map((x) => x[1] ?? ''));
  assert.ok(hostSide.size > 0, 'HOST_SIDE_TOOLS 不能为空');

  const caps = new Map(CAPABILITY_CATALOG.map((c) => [c.name, c]));
  const invisible = [...hostSide].filter((n) => !caps.has(n));
  assert.deepEqual(
    invisible,
    [],
    `这些工具在 HOST_SIDE_TOOLS 里，但 CAPABILITY_CATALOG 没有它们——` +
      `getCapabilities 只合并两侧都有的（ExecService.ts:1144），` +
      `所以模型永远看不见它们：${invisible.join(', ')}`,
  );
});

test('daemon 注册的宿主工具与 HOST_SIDE_TOOLS 不得脱节', async () => {
  // 反向防：实现了、也登记了白名单，但忘了往 HOST_SIDE_TOOLS 里加，
  // 结果同样是「模型看不见」。以 daemon.ts 里真实的 registerHostTool 调用为准。
  const src = readFileSync(join(HERE, '..', 'src', 'daemon.ts'), 'utf8');
  const declared = [...src.matchAll(/registerHostTool\('([^']+)'/g)].map((m) => m[1] ?? '');
  assert.ok(declared.length > 0, 'daemon.ts 里没扫到任何 registerHostTool，扫描逻辑失效了');

  const esrc = readFileSync(join(HERE, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');
  const m = /const HOST_SIDE_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(esrc);
  assert.ok(m !== null, 'ExecService.ts 里找不到 HOST_SIDE_TOOLS 集合');
  const body = m[1] ?? '';
  const hostSide = new Set([...body.matchAll(/'([^']+)'/g)].map((x) => x[1] ?? ''));

  const forgotten = [...new Set(declared)].filter((n) => !hostSide.has(n));
  assert.deepEqual(
    forgotten,
    [],
    `daemon 里注册了实现，但 HOST_SIDE_TOOLS 没列——模型看不见：${forgotten.join(', ')}`,
  );
});
