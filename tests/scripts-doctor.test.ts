/**
 * tests/scripts-doctor.test.ts —— `npm run doctor` 的判据测试。
 *
 * doctor 的**全部价值**在于：把"静默失败"变成"拦住你"。所以测试重点不是
 * "它能跑"，而是"它真的会拦住"——
 *   - DOTD_FLEET 拼错必须 warn（这是本项目最贵的一个坑：静默回落 stub，
 *     daemon 照常起、任务照常"跑完"，只是所有工具执行都是假的）；
 *   - tier1 没 key 必须 fail（缺 key 不是启动期错误，tier1 又是唯一能承载
 *     primary 轨的端点，现象是"daemon 正常起、交互任务全挂起"）；
 *   - 严格占位符没值必须 fail；非严格占位符（FEISHU_* 等）缺席是合法的，不能误报。
 *
 * 全部通过注入 env / home / probe 完成，**不碰真实环境、不发网络请求**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECKS,
  STATUS,
  STRICT_ENV_KEYS,
  expectedUserVersion,
  exitCodeFor,
  expandWithDefault,
  formatReport,
  parseTier1Endpoint,
  resolveFleet,
  resolveModelTransport,
  runChecks,
} from '../scripts/doctor.mjs';
import type { DoctorResult } from '../scripts/doctor.mjs';

// cwd 无关：从本文件位置推仓库根（README「已知限制」记录过 process.cwd() 拼路径的脆性，
// 那类写法在非仓库根目录跑就 ENOENT —— 这里直接用 import.meta.url）。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sandbox(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dotd-doctor-'));
  mkdirSync(join(home, '.dotd'), { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function writeConfig(home: string, body: string): void {
  writeFileSync(join(home, '.dotd', 'config.yml'), body, 'utf8');
}

const BASE_CFG = `version: 1
surfaces:
  http:
    host: 127.0.0.1
    port: 7788
    master_token: "\${DOTD_MASTER_TOKEN}"
    readonly_tokens: ["\${DOTD_RO_TOKEN}"]
  hooks:
    - source: grafana
      secret: "\${HOOK_GRAFANA}"
  feishu:
    app_id: "\${FEISHU_APP_ID}"
`;

const probeOk = async () => ({ ok: true, detail: 'TCP 可连', latencyMs: 1 });
const probeDown = async () => ({ ok: false, detail: 'ECONNREFUSED', latencyMs: 1 });

function byName(results: DoctorResult[], name: string): DoctorResult {
  const r = results.find((x) => x.name === name);
  assert.ok(r !== undefined, `缺体检项 ${name}`);
  return r;
}

// ── 1. 纯函数：真值表 ────────────────────────────────────────────────────

test('resolveFleet：只有精确 "stub"/"docker" 才生效，其余（含未设）静默回落 stub 并 warn', () => {
  assert.deepEqual(
    { e: resolveFleet('docker').effective, w: resolveFleet('docker').warn },
    { e: 'docker', w: null },
  );
  assert.deepEqual(
    { e: resolveFleet('stub').effective, w: resolveFleet('stub').warn },
    { e: 'stub', w: null },
  );
  // 以下全部是"看起来配了、其实没配"的形态
  for (const raw of ['Docker', 'DOCKER', 'real', 'docker ', 'true', '']) {
    const r = resolveFleet(raw);
    assert.equal(r.effective, 'stub', `'${raw}' 必须回落 stub`);
    assert.equal(typeof r.warn, 'string', `'${raw}' 必须给出警告，不能静默`);
  }
  // 未设置：能跑，但要明确告诉主人"你现在跑的是假容器"
  const unset = resolveFleet(undefined);
  assert.equal(unset.effective, 'stub');
  assert.ok(unset.warn !== null && unset.warn.includes('DOTD_FLEET'), '未设置也要警告');
});

test('resolveModelTransport：缺省是真实 HTTP（与 fleet 的缺省正好相反）', () => {
  assert.equal(resolveModelTransport(undefined).effective, 'real-http');
  assert.equal(resolveModelTransport('').effective, 'real-http');
  assert.equal(resolveModelTransport('stub').effective, 'stub');
  // 拼错 = 真实 HTTP（会真发请求、真烧钱），这一点必须让人看见
  assert.equal(resolveModelTransport('Stub').effective, 'real-http');
});

test('parseTier1Endpoint：从仓库真实 models.yml 里认出 tier1 与它的 key 变量', () => {
  const endpoints = parseTier1Endpoint(
    [
      'version: 1',
      'endpoints:',
      '  - id: openrouter-main',
      '    tier: 1',
      '    base_url: http://127.0.0.1:7863/v1   # 注释不算',
      '    api_key_env: HY3_API_KEY',
      '    models:',
      '      primary: hy3',
      '  - id: local',
      '    tier: 2',
      '    base_url: http://127.0.0.1:8001/v1',
      'routing:',
      '  default_track: primary',
    ].join('\n'),
  );
  assert.equal(endpoints.length, 1, '只认 tier:1');
  const ep = endpoints[0]!;
  assert.equal(ep.id, 'openrouter-main');
  assert.equal(ep.baseUrl, 'http://127.0.0.1:7863/v1', '行尾注释必须剥掉');
  assert.equal(ep.apiKeyEnv, 'HY3_API_KEY');
  assert.equal(ep.primaryModel, 'hy3');
});

test('expandWithDefault：${VAR:-默认} 在缺席时用默认值，不算缺', () => {
  assert.deepEqual(expandWithDefault('${A:-http://h:1}', {}), { value: 'http://h:1', resolved: true });
  assert.deepEqual(expandWithDefault('${A:-http://h:1}', { A: 'http://x:2' }), { value: 'http://x:2', resolved: true });
  const missing = expandWithDefault('${A}', {});
  assert.equal(missing.resolved, false);
  assert.equal(missing.missing, 'A');
  // 普通字面量原样返回
  assert.deepEqual(expandWithDefault('http://127.0.0.1:7863/v1', {}), {
    value: 'http://127.0.0.1:7863/v1',
    resolved: true,
  });
});

test('STRICT_ENV_KEYS：严格展开的只有四处；FEISHU_* 等缺席是合法的', () => {
  assert.deepEqual(
    [...STRICT_ENV_KEYS].sort(),
    ['DOTD_DB_PATH', 'DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA'],
  );
  for (const k of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'TG_BOT_TOKEN']) {
    assert.equal(STRICT_ENV_KEYS.has(k), false, `${k} 走非严格展开，不应被当成"缺了就起不来"`);
  }
});

test('expectedUserVersion：取 db/migrations 的最高 NNN（不是硬编码常量）', () => {
  assert.equal(typeof expectedUserVersion(repoRoot), 'number');
  const dir = mkdtempSync(join(tmpdir(), 'dotd-mig-'));
  try {
    mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'db', 'migrations', '000_a.sql'), '');
    writeFileSync(join(dir, 'db', 'migrations', '090_b.sql'), '');
    writeFileSync(join(dir, 'db', 'migrations', '100_c.sql'), '');
    writeFileSync(join(dir, 'db', 'migrations', 'README.md'), '');
    assert.equal(expectedUserVersion(dir), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(expectedUserVersion(join(tmpdir(), '绝不存在的目录-xyz')), null);
});

// ── 2. 整轮体检：拦住真实故障 ────────────────────────────────────────────

test('体检项清单是契约：顺序与名字固定（删一项就会有测试红）', () => {
  assert.deepEqual([...CHECKS], [
    'node',
    'repo',
    'surfaces-config',
    'placeholders',
    'fleet',
    'model-transport',
    'tier1-endpoint',
    'tier1-key',
    'db',
    'home-dir',
    'mcp',
  ]);
});

test('配置缺 ~/.dotd/config.yml → fail，并指向 npm run init-config', async () => {
  const s = sandbox();
  try {
    const results = await runChecks({ env: {}, home: s.home, repoRoot, probe: probeOk });
    const r = byName(results, 'surfaces-config');
    assert.equal(r.status, STATUS.FAIL);
    assert.match(String(r.next), /init-config/);
    assert.equal(exitCodeFor(results), 1, '有 fail 就必须非零退出');
  } finally {
    s.cleanup();
  }
});

test('严格占位符没值 → fail；FEISHU_* 缺席不误报', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r' }, // 缺 HOOK_GRAFANA
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const r = byName(results, 'placeholders');
    assert.equal(r.status, STATUS.FAIL);
    assert.ok(r.detail.includes('HOOK_GRAFANA'), '要点名缺哪个');
    assert.ok(!r.detail.includes('FEISHU_APP_ID'), '非严格键缺席不该报');
  } finally {
    s.cleanup();
  }

  const s2 = sandbox();
  try {
    writeConfig(s2.home, BASE_CFG);
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h' },
      home: s2.home,
      repoRoot,
      probe: probeOk,
    });
    assert.equal(byName(results, 'placeholders').status, STATUS.OK, '三个严格键齐了就应通过');
  } finally {
    s2.cleanup();
  }
});

test('DOTD_FLEET 拼错 → warn（不是 fail：daemon 能起，但它干的是假活）', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_FLEET: 'Docker' },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const r = byName(results, 'fleet');
    assert.equal(r.status, STATUS.WARN);
    assert.ok(r.detail.includes('回落 stub') || r.detail.includes('静默忽略'), '要把"已回落 stub"说出来');
  } finally {
    s.cleanup();
  }
});

test('tier1 端点连不上 → fail；连得上但没 key → 也 fail（这是"静默全灭"的根因）', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const env = { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h' };
    const down = await runChecks({ env, home: s.home, repoRoot, probe: probeDown });
    assert.equal(byName(down, 'tier1-endpoint').status, STATUS.FAIL);

    const upNoKey = await runChecks({ env, home: s.home, repoRoot, probe: probeOk });
    assert.equal(byName(upNoKey, 'tier1-endpoint').status, STATUS.OK);
    const key = byName(upNoKey, 'tier1-key');
    assert.equal(key.status, STATUS.FAIL, '端点活着但没有 key，必须拦住');
    assert.match(key.next ?? '', /tokens\.env/, '要告诉人怎么写进 tokens.env（否则重启即丢）');

    const upKey = await runChecks({
      env: { ...env, HY3_API_KEY: 'sk-某值' },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const okKey = byName(upKey, 'tier1-key');
    assert.equal(okKey.status, STATUS.OK);
    assert.ok(!okKey.detail.includes('sk-某值'), '绝不能把 key 的值打出来');
  } finally {
    s.cleanup();
  }
});

test('全部正常时退出码为 0，且报告里给得出结论', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const results = await runChecks({
      env: {
        DOTD_MASTER_TOKEN: 'm',
        DOTD_RO_TOKEN: 'r',
        HOOK_GRAFANA: 'h',
        DOTD_FLEET: 'docker',
        HY3_API_KEY: 'k',
      },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    assert.equal(exitCodeFor(results), 0, `不该有 fail：${JSON.stringify(results.filter((r) => r.status === 'fail'))}`);
    const text = formatReport(results);
    assert.ok(text.includes('结论：'), '人读模式下必须有结论行');
    assert.ok(results.every((r) => typeof r.title === 'string' && r.title.length > 0));
  } finally {
    s.cleanup();
  }
});

// ── 3. P2-1 MCP：声明了但起不来要判 fail；没声明要判 skip（不制造噪音） ──────────

/** 造一份只含 MCP 声明的临时配置，返回路径。 */
function writeMcp(dir: string, body: string): string {
  const p = join(dir, 'mcp-servers.yml');
  writeFileSync(p, body, 'utf8');
  return p;
}

test('MCP：未声明任何 server（仓库默认 servers: []）→ skip「未启用」，不是 warn/fail', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const env = { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', HY3_API_KEY: 'k' };
    // 用仓库里真实的那份（默认空）
    const results = await runChecks({
      env: { ...env, DOTD_MCP_CONFIG: join(repoRoot, 'config', 'mcp-servers.yml') },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const mcp = byName(results, 'mcp');
    assert.equal(mcp.status, STATUS.SKIP, '默认配置下 MCP 未启用 → skip（不制造噪音）');
    assert.match(mcp.title, /未启用/);
    assert.equal(mcp.next, null, 'skip 不该给"下一步"（没事可做）');
  } finally {
    s.cleanup();
  }
});

test('MCP：文件不存在 → skip「未启用」，不判失败', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const results = await runChecks({
      env: {
        DOTD_MASTER_TOKEN: 'm',
        DOTD_RO_TOKEN: 'r',
        HOOK_GRAFANA: 'h',
        DOTD_MCP_CONFIG: join(s.home, 'no-such-mcp.yml'),
      },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    assert.equal(byName(results, 'mcp').status, STATUS.SKIP);
  } finally {
    s.cleanup();
  }
});

test('MCP：声明了不存在的 command → **fail**，并给出可操作的修法', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const p = writeMcp(s.home, 'servers:\n  - name: ghost\n    command: no-such-command-xyz-123\n');
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_MCP_CONFIG: p },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const mcp = byName(results, 'mcp');
    assert.equal(mcp.status, STATUS.FAIL, '声明了但 command 找不到 = 每次调用都会失败，必须拦住');
    assert.match(mcp.title, /起不来/);
    assert.match(mcp.detail, /ghost.*no-such-command-xyz-123/, '要点名是哪个 server、哪个 command');
    assert.match(mcp.next ?? '', /command\/args/, '下一步要指向怎么改');
    assert.equal(exitCodeFor(results), 1, 'fail 必须让退出码非零');
  } finally {
    s.cleanup();
  }
});

test('MCP：command 对但 args 里的脚本不存在 → fail', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const p = writeMcp(
      s.home,
      'servers:\n  - name: half\n    command: node\n    args: ["scripts/definitely-not-here.mjs"]\n',
    );
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_MCP_CONFIG: p },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const mcp = byName(results, 'mcp');
    assert.equal(mcp.status, STATUS.FAIL);
    assert.match(mcp.detail, /definitely-not-here\.mjs/, '要点名缺的是哪个文件');
  } finally {
    s.cleanup();
  }
});

test('MCP：配置写错（缺 command）→ fail 并说明原因', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const p = writeMcp(s.home, 'servers:\n  - name: nocmd\n');
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_MCP_CONFIG: p },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const mcp = byName(results, 'mcp');
    assert.equal(mcp.status, STATUS.FAIL);
    assert.match(mcp.title, /配置写错/);
  } finally {
    s.cleanup();
  }
});

test('MCP：声明正确（本仓库自带的 echo server）→ warn（可用但每次都要审批），不是 fail', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const p = writeMcp(
      s.home,
      'servers:\n  - name: echo\n    command: node\n    args: ["scripts/mcp-echo-server.mjs"]\n',
    );
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_MCP_CONFIG: p },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const mcp = byName(results, 'mcp');
    assert.equal(mcp.status, STATUS.WARN, '能用但要认真读：每次调用走 dangerous 审批');
    assert.match(mcp.title, /1 个 MCP server/);
    assert.match(mcp.detail, /dangerous/, '必须提醒最严档审批');
    assert.match(mcp.next ?? '', /servers: \[\]/, '要给"怎么关掉"的下一步');
  } finally {
    s.cleanup();
  }
});

test('MCP resolveCommand：node 能解析到；明显不存在的命令返回 null；不打印任何密钥', async () => {
  const { resolveCommand } = await import('../scripts/doctor.mjs');
  assert.ok(resolveCommand('node', { env: process.env, repoRoot }) !== null, 'node 应能解析');
  assert.equal(
    resolveCommand('definitely-not-a-command-abc-987', { env: process.env, repoRoot }),
    null,
  );
  // 带路径分隔符时按 repoRoot 解析
  assert.ok(
    resolveCommand('scripts/mcp-echo-server.mjs', { env: process.env, repoRoot }) !== null,
    '相对仓库根的脚本路径应能解析',
  );
  assert.equal(resolveCommand('scripts/nope.mjs', { env: process.env, repoRoot }), null);
});

test('MCP parseMcpServers：与 src/exec/mcp-config.ts 同口径（空表/声明/写错）', async () => {
  const { parseMcpServers } = await import('../scripts/doctor.mjs');
  assert.deepEqual(parseMcpServers('servers: []\n'), { servers: [], error: null });
  assert.deepEqual(parseMcpServers('# 只有注释\n'), { servers: [], error: null });
  const ok = parseMcpServers(
    'servers:\n  - name: echo\n    command: node\n    args: ["a.mjs", "b.mjs"]\n',
  );
  assert.equal(ok.error, null);
  assert.deepEqual(ok.servers, [{ name: 'echo', command: 'node', args: ['a.mjs', 'b.mjs'] }]);
  const bad = parseMcpServers('servers:\n  - name: x\n');
  assert.equal(bad.error !== null, true, '缺 command 必须回报错误（不抛）');
});

test('MCP：doctor 不打印 MCP 配置里的敏感值（env 段一律不进 detail）', async () => {
  const s = sandbox();
  try {
    writeConfig(s.home, BASE_CFG);
    const p = writeMcp(
      s.home,
      'servers:\n  - name: secretive\n    command: node\n    args: []\n    env:\n      API_KEY: sk-super-secret-value\n',
    );
    const results = await runChecks({
      env: { DOTD_MASTER_TOKEN: 'm', DOTD_RO_TOKEN: 'r', HOOK_GRAFANA: 'h', DOTD_MCP_CONFIG: p },
      home: s.home,
      repoRoot,
      probe: probeOk,
    });
    const text = formatReport(results);
    assert.ok(!text.includes('sk-super-secret-value'), '绝不能把 server 的环境变量值打出来');
  } finally {
    s.cleanup();
  }
});
