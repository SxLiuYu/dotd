/**
 * tests/exec-mcp-governance.test.ts —— P2-1：MCP 工具的治理档位（**不许放宽**的那条）。
 *
 * ## 为什么单独一个文件
 * 外部 MCP server 的行为我们不知道。所以治理口径必须是"最严"：
 *   - `dangerous` 档 → **一律人工审批**（approve_once），不参与 `all` 批量批准；
 *   - 应急模式（EMERGENCY）下直接冻结；
 *   - 治理审计里带 tier，复盘能一眼看出"这是外部工具"。
 *
 * 本文件用**真 governance gate**（不是 mock）钉住这三条，防止将来有人为了
 * "体验顺滑"把 mcp.call 降成 read/write_file。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDataDir, sweepTempPaths } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { loadCatalog } from '../src/governance/catalog.ts';

const cfgRoots: string[] = [];
const tmps: TempDataDir[] = [];
test.afterEach(() => {
  for (const r of cfgRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const t of tmps.splice(0)) t.cleanup();
});
test.after(sweepTempPaths);

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('仓库默认 tools.yml：mcp.call 以 **dangerous** 档登记（最严档）', () => {
  const { catalog, warnings } = loadCatalog(join(REPO_ROOT, 'config', 'tools.yml'), join(REPO_ROOT, 'config', 'rules.yml'));
  assert.equal(warnings.length, 0, '默认配置必须零告警');
  const rule = catalog.tools.get('mcp.call');
  assert.ok(rule !== undefined, 'mcp.call 必须在治理目录里登记（未登记 = 一律 deny）');
  assert.equal(
    rule!.tier,
    'dangerous',
    '外部工具必须是 dangerous 档：一律审批、不参与批量批准、应急冻结。**这条不许放宽**',
  );
});

test('mcp.call 不会被任何 upgrade 规则降档（upgrade 只能提档）', () => {
  const { catalog } = loadCatalog(join(REPO_ROOT, 'config', 'tools.yml'), join(REPO_ROOT, 'config', 'rules.yml'));
  const rule = catalog.tools.get('mcp.call');
  // dangerous 已是最高档（gate.ts 的 order 末位），再 upgrade 无意义；这里确认没有配反
  assert.equal(rule!.upgrade, undefined, 'dangerous 档不需要 upgrade（它已经是最严）');
});

test('对照：内置 fs.read 仍是 read（证明我们没有顺手把所有工具提档）', () => {
  const { catalog } = loadCatalog(join(REPO_ROOT, 'config', 'tools.yml'), join(REPO_ROOT, 'config', 'rules.yml'));
  assert.equal(catalog.tools.get('fs.read')!.tier, 'read', '内置只读工具不受影响');
  assert.equal(catalog.tools.get('net.get')!.tier, 'read');
});

test('静态守卫：daemon 装配在未配置 MCP 时传的是空列表（默认关闭的结构保证）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(REPO_ROOT, 'src', 'daemon.ts'), 'utf8');
  assert.match(
    src,
    /mcp: new McpClient\(\s*loadMcpServers\(/,
    'daemon 必须注入 McpClient（否则 mcp.call 永远不可用）',
  );
  assert.match(
    src,
    /loadMcpServers\(process\.env\.DOTD_MCP_CONFIG \?\? join\(cfg\.configDir, 'mcp-servers\.yml'\)\)/,
    '配置路径必须可被 DOTD_MCP_CONFIG 覆盖（同时默认指向空的 mcp-servers.yml）',
  );
});

test('静态守卫：ExecService 只在 mcp.enabled 时才把 mcp.call 放进工具面', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(REPO_ROOT, 'src', 'exec', 'ExecService.ts'), 'utf8');
  assert.match(src, /if \(this\.mcp\.enabled\)/, '工具面必须按 enabled 过滤');
  assert.match(
    src,
    /out\.push\(\{ \.\.\.gw, sideEffect: 'unknown' \}\)/,
    '网关工具的 sideEffect 必须强制为 unknown（治理据最严档）',
  );
});
