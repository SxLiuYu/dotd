/**
 * tests/connections.test.ts —— 已连接应用总览（纯函数，零 IO）
 *
 * 重点盯四件事：
 *   1. 状态必须能区分「没配」「配了没用过」「配了但坏了」——
 *      混成一句「不可用」就等于把排查的起点抹掉了。
 *   2. 被禁用的模型端点必须出现在列表里（这是最容易被误判成「没配」的一格）。
 *   3. 排序必须确定（kind 固定顺序 + 同 kind 内 id 字典序），否则「哪一行变了」失去意义。
 *   4. 渲染文本里绝不能出现凭证：token / 密码 / secret / chat id 全文。
 *      这条是硬红线 —— 总览要打进终端和日志，一次泄露就是永久泄露。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_TOKEN_ENV } from '../src/connectors/registry.ts';
import type { ConnectorInfo } from '../src/connectors/registry.ts';
import {
  CONNECTION_STATUS_TEXT,
  buildConnections,
  connectionSummary,
  renderConnections,
} from '../src/surfaces/connections.ts';
import type {
  ConnectionInput,
  ConnectionKind,
  ConnectionMailAccount,
  ConnectionRow,
} from '../src/surfaces/connections.ts';

/** 造一个邮箱账号，默认是「配好但没用过」的干净态。 */
const mkMail = (id: string, over: Partial<ConnectionMailAccount> = {}): ConnectionMailAccount => ({
  id,
  label: id,
  email: `${id}@example.com`,
  imapHost: 'imap.example.com',
  status: 'active',
  lastOkAt: null,
  lastError: null,
  ...over,
});

const gh = (status: ConnectorInfo['status']): ConnectorInfo => ({
  id: 'github',
  name: 'GitHub',
  desc: 'Issues / Pulls（未认证公开 API，限速 60 请求/小时）',
  status,
});

const rss: ConnectorInfo = {
  id: 'rss',
  name: 'RSS/Atom 订阅',
  desc: '拉取 RSS 2.0 / Atom 源并解析为条目（无凭证概念）',
  status: 'ready',
};

/** 全空输入：所有子系统都没配。极端情况必须能出总览（HTTP 行永远在）。 */
const base = (): ConnectionInput => ({
  mailAccounts: [],
  calendar: { dir: 'D:/dotd/ics', sources: [], errors: [] },
  connectors: [],
  mcpServers: [],
  models: [],
  channel: { feishuAppId: '', ownerChatCount: 0, httpHost: '127.0.0.1', httpPort: 8787 },
});

const pick = (rows: ConnectionRow[], kind: ConnectionKind, id: string): ConnectionRow | undefined =>
  rows.find((r) => r.kind === kind && r.id === id);

const pickAll = (rows: ConnectionRow[], kind: ConnectionKind): ConnectionRow[] =>
  rows.filter((r) => r.kind === kind);

// ── 1. 状态词表 ────────────────────────────────────────────────
test('状态词表覆盖全部五种状态且是中文', () => {
  const all = ['connected', 'ready', 'public_only', 'not_configured', 'error'] as const;
  assert.equal(all.length, 5);
  for (const s of all) assert.equal(typeof CONNECTION_STATUS_TEXT[s], 'string');
  assert.equal(CONNECTION_STATUS_TEXT.connected, '已连接');
  assert.equal(CONNECTION_STATUS_TEXT.not_configured, '未配置');
  assert.equal(CONNECTION_STATUS_TEXT.error, '异常');
});

// ── 2. 排序 ────────────────────────────────────────────────────
test('排序：kind 按 邮箱→日历→连接器→MCP→模型→通知 固定，同 kind 内按 id 字典序', () => {
  const rows = buildConnections({
    mailAccounts: [mkMail('b'), mkMail('a')], // 故意逆序传入
    calendar: { dir: 'D:/ics', sources: [{ name: 'work', eventCount: 3, errors: [] }], errors: [] },
    connectors: [rss, gh('public-only')], // 故意把 rss 放前面，排序后 github 应在前
    mcpServers: [{ name: 'playwright', toolCount: 4 }, { name: 'fs', toolCount: 9 }],
    models: [
      { tier: 'secondary', endpoint: 'https://b.example/v1', model: 'm-b', enabled: true },
      { tier: 'primary', endpoint: 'https://a.example/v1', model: 'm-a', enabled: true },
    ],
    channel: { feishuAppId: 'cli_x', ownerChatCount: 2, httpHost: '0.0.0.0', httpPort: 8787 },
  });
  assert.deepEqual(rows.map((r) => r.kind), [
    'mail',
    'mail',
    'calendar',
    'connector',
    'connector',
    'mcp',
    'mcp',
    'model',
    'model',
    'channel',
    'channel',
  ]);
  assert.deepEqual(pickAll(rows, 'mail').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(pickAll(rows, 'connector').map((r) => r.id), ['github', 'rss']);
  assert.deepEqual(pickAll(rows, 'mcp').map((r) => r.id), ['fs', 'playwright']);
  // 模型端点按 tier 再 endpoint，而不是按 id 字典序；name 带 host 让同 tier 的两行可辨
  assert.deepEqual(pickAll(rows, 'model').map((r) => r.name), ['primary · a.example', 'secondary · b.example']);
  assert.deepEqual(pickAll(rows, 'model').map((r) => r.name), ['primary · a.example', 'secondary · b.example']);
});
test('邮箱：有成功记录 → connected，detail 写「label（email）最近成功 <时间>」，不给 hint', () => {
  const row = pick(
    buildConnections({
      ...base(),
      mailAccounts: [
        mkMail('work', { label: '工作邮箱', email: 'me@corp.com', lastOkAt: '2026-10-23T08:00:00Z' }),
      ],
    }),
    'mail',
    'work',
  );
  assert.equal(row?.status, 'connected');
  assert.match(row?.detail ?? '', /工作邮箱（me@corp\.com）最近成功 2026-10-23T08:00:00Z/);
  assert.equal(row?.hint, undefined);
});

test('邮箱：成功过但也留了失败记录 → 仍是 connected（偶发失败不降级成异常）', () => {
  const row = pick(
    buildConnections({
      ...base(),
      mailAccounts: [
        mkMail('work', { lastOkAt: '2026-10-23T08:00:00Z', lastError: 'timeout after 15s' }),
      ],
    }),
    'mail',
    'work',
  );
  assert.equal(row?.status, 'connected');
  assert.match(row?.detail ?? '', /最近成功/);
});

test('邮箱：从未成功 + 有失败原文 → error，detail 带错误原文并给排查 hint', () => {
  const row = pick(
    buildConnections({
      ...base(),
      mailAccounts: [mkMail('work', { lastError: 'LOGIN failed: authentication failed' })],
    }),
    'mail',
    'work',
  );
  assert.equal(row?.status, 'error');
  assert.match(row?.detail ?? '', /最近失败：LOGIN failed: authentication failed/);
  assert.match(row?.hint ?? '', /检查密码\/应用专用密码或网络/);
});

test('邮箱：active 但从未用过（无成功也无失败）→ ready，detail 写「已配置，尚未使用过」', () => {
  const row = pick(buildConnections({ ...base(), mailAccounts: [mkMail('work')] }), 'mail', 'work');
  assert.equal(row?.status, 'ready');
  assert.equal(row?.detail, '已配置，尚未使用过');
  assert.equal(row?.hint, undefined);
});

test('邮箱：disabled → not_configured（禁用不是故障，但也不是已连接）', () => {
  const row = pick(
    buildConnections({ ...base(), mailAccounts: [mkMail('old', { status: 'disabled' })] }),
    'mail',
    'old',
  );
  assert.equal(row?.status, 'not_configured');
  assert.match(row?.detail ?? '', /已禁用/);
  assert.equal(typeof row?.hint, 'string');
});

// ── 4. 日历（永远一行）─────────────────────────────────────────
test('日历：无错误 → ready，detail 写「N 个日历源 / M 个事件」（事件数求和）', () => {
  const rows = buildConnections({
    ...base(),
    calendar: {
      dir: 'D:/ics',
      sources: [
        { name: 'work', eventCount: 3, errors: [] },
        { name: 'personal', eventCount: 4, errors: [] },
      ],
      errors: [],
    },
  });
  const row = pick(rows, 'calendar', 'calendar');
  assert.equal(row?.status, 'ready');
  assert.equal(row?.detail, '2 个日历源 / 7 个事件');
  assert.equal(row?.name, '日历');
});

test('日历：有源但解析出错 → error，detail 只带第一个错误 + 「共 N 个」', () => {
  const row = pick(
    buildConnections({
      ...base(),
      calendar: {
        dir: 'D:/ics',
        sources: [{ name: 'work', eventCount: 2, errors: ['work.ics 第 12 行不是合法 iCalendar'] }],
        errors: ['work.ics 第 12 行不是合法 iCalendar', 'bad.ics 编码不是 UTF-8'],
      },
    }),
    'calendar',
    'calendar',
  );
  assert.equal(row?.status, 'error');
  assert.match(row?.detail ?? '', /work\.ics 第 12 行不是合法 iCalendar/);
  assert.match(row?.detail ?? '', /共 2 个错误/);
  assert.equal((row?.detail ?? '').includes('bad.ics'), false, '第二个错误只报数量，不堆原文');
  assert.match(row?.hint ?? '', /\.ics/);
});

test('日历：一个源都没有且目录出错 → not_configured，hint 指向该放 .ics 的目录', () => {
  const row = pick(
    buildConnections({
      ...base(),
      calendar: { dir: 'D:/dotd/ics', sources: [], errors: ['ENOENT: 目录不存在'] },
    }),
    'calendar',
    'calendar',
  );
  assert.equal(row?.status, 'not_configured');
  assert.match(row?.detail ?? '', /ENOENT/);
  assert.match(row?.hint ?? '', /把 \.ics 文件放进 D:\/dotd\/ics/);
});

test('日历：无论多少个源都只产生一行（不按源展开）', () => {
  const rows = buildConnections({
    ...base(),
    calendar: {
      dir: 'D:/ics',
      sources: [
        { name: 'a', eventCount: 1, errors: [] },
        { name: 'b', eventCount: 1, errors: [] },
        { name: 'c', eventCount: 1, errors: [] },
      ],
      errors: [],
    },
  });
  assert.equal(pickAll(rows, 'calendar').length, 1);
});

// ── 5. 连接器 ──────────────────────────────────────────────────
test('连接器：registry 的 status 直接映射（connected / ready / public-only）', () => {
  const rows = buildConnections({
    ...base(),
    connectors: [gh('connected'), rss],
  });
  assert.equal(pick(rows, 'connector', 'github')?.status, 'connected');
  assert.equal(pick(rows, 'connector', 'rss')?.status, 'ready');
  assert.equal(pick(rows, 'connector', 'rss')?.hint, undefined);

  const pub = buildConnections({ ...base(), connectors: [gh('public-only')] });
  assert.equal(pick(pub, 'connector', 'github')?.status, 'public_only');
  const hint = pick(pub, 'connector', 'github')?.hint ?? '';
  assert.match(hint, /设置 DOTD_GITHUB_TOKEN 环境变量可提高限额/);
  assert.ok(hint.includes(GITHUB_TOKEN_ENV), 'hint 里的变量名要与 registry 的常量同源');
});

test('连接器：detail 用 registry 的 desc，不自己编状态描述', () => {
  const row = pick(buildConnections({ ...base(), connectors: [gh('public-only')] }), 'connector', 'github');
  assert.equal(row?.detail, 'Issues / Pulls（未认证公开 API，限速 60 请求/小时）');
  assert.equal(row?.name, 'GitHub');
});// ── 6. MCP ─────────────────────────────────────────────────────
test('MCP：一个 server 都没配 → 一行 not_configured，hint 指向 config/mcp-servers.yml', () => {
  const rows = buildConnections({ ...base(), mcpServers: [] });
  const row = pick(rows, 'mcp', 'mcp');
  assert.equal(row?.status, 'not_configured');
  assert.equal(row?.name, 'MCP 工具通道');
  assert.match(row?.hint ?? '', /config\/mcp-servers\.yml/);
  assert.equal(pickAll(rows, 'mcp').length, 1);
});

test('MCP：每个 server 一行，status=connected，detail 写工具数', () => {
  const rows = buildConnections({
    ...base(),
    mcpServers: [
      { name: 'fs', toolCount: 9 },
      { name: 'playwright', toolCount: 4 },
    ],
  });
  assert.equal(pickAll(rows, 'mcp').length, 2);
  assert.equal(pick(rows, 'mcp', 'fs')?.status, 'connected');
  assert.equal(pick(rows, 'mcp', 'fs')?.detail, '9 个工具');
  assert.equal(pick(rows, 'mcp', 'playwright')?.detail, '4 个工具');
  assert.equal(pick(rows, 'mcp', 'fs')?.hint, undefined);
});

// ── 7. 模型端点 ────────────────────────────────────────────────
test('模型端点：禁用的端点也要出现，状态 not_configured，detail 含「已禁用」', () => {
  const rows = buildConnections({
    ...base(),
    models: [
      { tier: 'primary', endpoint: 'https://api.example.com/v1', model: 'gpt-x', enabled: true },
      { tier: 'secondary', endpoint: 'https://backup.example.com/v1', model: 'gpt-y', enabled: false },
    ],
  });
  assert.equal(pickAll(rows, 'model').length, 2, '配了但关着的端点不能消失在总览里');
  const off = pick(rows, 'model', 'secondary/https://backup.example.com/v1');
  assert.equal(off?.status, 'not_configured');
  assert.match(off?.detail ?? '', /已禁用/);
  assert.match(off?.detail ?? '', /backup\.example\.com/, '关着的端点也要说清是哪一个');
  assert.match(off?.hint ?? '', /config\/models\.yml/);
});

test('模型端点：启用的端点 connected，detail 写 endpoint 与 model', () => {
  const row = pick(
    buildConnections({
      ...base(),
      models: [{ tier: 'primary', endpoint: 'https://api.example.com/v1', model: 'gpt-x', enabled: true }],
    }),
    'model',
    'primary/https://api.example.com/v1',
  );
  assert.equal(row?.status, 'connected');
  assert.match(row?.detail ?? '', /https:\/\/api\.example\.com\/v1/);
  assert.match(row?.detail ?? '', /gpt-x/);
  assert.equal(row?.hint, undefined);
});

test('模型端点：排序按 tier 再 endpoint（不是按 id 字母序）', () => {
  const rows = buildConnections({
    ...base(),
    models: [
      { tier: 'secondary', endpoint: 'https://z/v1', model: 'm1', enabled: true },
      { tier: 'primary', endpoint: 'https://b/v1', model: 'm2', enabled: true },
      { tier: 'primary', endpoint: 'https://a/v1', model: 'm3', enabled: true },
    ],
  });
  assert.deepEqual(pickAll(rows, 'model').map((r) => r.id), [
    'primary/https://a/v1',
    'primary/https://b/v1',
    'secondary/https://z/v1',
  ]);
});

test('模型端点：不改动调用方传入的数组顺序（排序只是渲染需求）', () => {
  const models = [
    { tier: 'secondary', endpoint: 'https://z/v1', model: 'm1', enabled: true },
    { tier: 'primary', endpoint: 'https://a/v1', model: 'm2', enabled: true },
  ];
  buildConnections({ ...base(), models });
  assert.deepEqual(models.map((m) => m.tier), ['secondary', 'primary']);
});

// ── 8. 通知与控制台 ────────────────────────────────────────────
test('通知：app_id 与主人会话都有 → connected，detail 只报会话数量', () => {
  const row = pick(
    buildConnections({ ...base(), channel: { feishuAppId: 'cli_x', ownerChatCount: 2, httpHost: '127.0.0.1', httpPort: 8787 } }),
    'channel',
    'feishu',
  );
  assert.equal(row?.status, 'connected');
  assert.equal(row?.detail, 'app_id 已配，主人会话 2 个');
  assert.equal(row?.hint, undefined);
});

test('通知：有 app_id 但没主人会话 → error（入站会被 403 丢弃，不能当未配置糊过去）', () => {
  const row = pick(
    buildConnections({ ...base(), channel: { feishuAppId: 'cli_x', ownerChatCount: 0, httpHost: '127.0.0.1', httpPort: 8787 } }),
    'channel',
    'feishu',
  );
  assert.equal(row?.status, 'error');
  assert.match(row?.detail ?? '', /未配主人会话，入站消息会被 403 丢弃/);
  assert.match(row?.hint ?? '', /owner_chat_id/);
});

test('通知：app_id 为空 → not_configured，hint 指向 config.yml 的 feishu: 段', () => {
  const row = pick(buildConnections(base()), 'channel', 'feishu');
  assert.equal(row?.status, 'not_configured');
  assert.match(row?.hint ?? '', /~\/\.dotd\/config\.yml/);
  assert.match(row?.hint ?? '', /feishu:/);
});

test('通知与控制台：HTTP 行永远存在且是 connected，detail 是 http://host:port', () => {
  const rows = buildConnections(base());
  const http = pick(rows, 'channel', 'http');
  assert.equal(http?.status, 'connected');
  assert.equal(http?.detail, 'http://127.0.0.1:8787');
  const custom = pick(
    buildConnections({ ...base(), channel: { feishuAppId: '', ownerChatCount: 0, httpHost: '0.0.0.0', httpPort: 9090 } }),
    'channel',
    'http',
  );
  assert.equal(custom?.detail, 'http://0.0.0.0:9090');
});// ── 9. 渲染 ────────────────────────────────────────────────────
test('渲染：按 kind 分组、组标题中文、空组不出现、行格式与统计行逐字对齐', () => {
  // 故意打乱传入顺序：分组顺序由 KIND_ORDER 决定，不该跟着入参走
  const rows: ConnectionRow[] = [
    { kind: 'channel', id: 'http', name: 'HTTP 控制台', status: 'connected', detail: 'http://127.0.0.1:8787' },
    {
      kind: 'mail',
      id: 'work',
      name: '工作邮箱',
      status: 'connected',
      detail: '工作邮箱（me@corp.com）最近成功 2026-10-23T08:00:00Z',
    },
    {
      kind: 'connector',
      id: 'github',
      name: 'GitHub',
      status: 'public_only',
      detail: 'Issues / Pulls',
      hint: '设置 DOTD_GITHUB_TOKEN 环境变量可提高限额',
    },
  ];
  const text = renderConnections(rows);
  assert.equal(
    text,
    [
      '邮箱',
      '  · 工作邮箱 — 已连接：工作邮箱（me@corp.com）最近成功 2026-10-23T08:00:00Z',
      '连接器',
      '  · GitHub — 仅公开接口：Issues / Pulls（设置 DOTD_GITHUB_TOKEN 环境变量可提高限额）',
      '通知与控制台',
      '  · HTTP 控制台 — 已连接：http://127.0.0.1:8787',
      '共 3 项，connected 2 项，需处理 1 项',
    ].join('\n'),
  );
  // 空组不出现
  assert.equal(text.includes('日历'), false);
  assert.equal(text.includes('MCP'), false);
  assert.equal(text.includes('模型端点'), false);
});

test('渲染：六种来源齐全时六个中文组标题都出现且顺序固定', () => {
  const rows = buildConnections({
    mailAccounts: [mkMail('work')],
    calendar: { dir: 'D:/ics', sources: [{ name: 'work', eventCount: 1, errors: [] }], errors: [] },
    connectors: [rss],
    mcpServers: [{ name: 'fs', toolCount: 9 }],
    models: [{ tier: 'primary', endpoint: 'https://api.example.com/v1', model: 'gpt-x', enabled: true }],
    channel: { feishuAppId: 'cli_x', ownerChatCount: 1, httpHost: '127.0.0.1', httpPort: 8787 },
  });
  const text = renderConnections(rows);
  const titles = ['邮箱', '日历', '连接器', 'MCP', '模型端点', '通知与控制台'];
  const positions = titles.map((t) => text.indexOf('\n' + t + '\n') + 1 || text.indexOf(t));
  assert.ok(positions.every((p) => p >= 0), '六个组标题都要出现');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '组顺序必须与 KIND_ORDER 一致');
  assert.match(text, /共 7 项/);
});

// ── 10. 统计 ───────────────────────────────────────────────────
test('统计：issues 含 error / not_configured / public_only，ready 两边都不算', () => {
  const rows: ConnectionRow[] = [
    { kind: 'mail', id: 'a', name: 'a', status: 'connected', detail: '' },
    { kind: 'mail', id: 'b', name: 'b', status: 'ready', detail: '' },
    { kind: 'mail', id: 'c', name: 'c', status: 'error', detail: '' },
    { kind: 'connector', id: 'd', name: 'd', status: 'public_only', detail: '' },
    { kind: 'mcp', id: 'e', name: 'e', status: 'not_configured', detail: '' },
  ];
  assert.deepEqual(connectionSummary(rows), { total: 5, connected: 1, issues: 3 });
  assert.deepEqual(connectionSummary([]), { total: 0, connected: 0, issues: 0 });
});

// ── 11. hint 只给没连上的行 ────────────────────────────────────
test('hint 只在 not_configured / public_only / error 时给，connected 与 ready 不给', () => {
  const rows = buildConnections({
    mailAccounts: [mkMail('ok', { lastOkAt: '2026-10-23T08:00:00Z' }), mkMail('fresh'), mkMail('bad', { lastError: 'boom' }), mkMail('off', { status: 'disabled' })],
    calendar: { dir: 'D:/ics', sources: [], errors: ['ENOENT'] },
    connectors: [gh('public-only'), rss],
    mcpServers: [],
    models: [{ tier: 'primary', endpoint: 'https://api.example.com/v1', model: 'gpt-x', enabled: false }],
    channel: { feishuAppId: '', ownerChatCount: 0, httpHost: '127.0.0.1', httpPort: 8787 },
  });
  for (const r of rows) {
    const label = `${r.kind}/${r.id}(${r.status})`;
    if (r.status === 'connected' || r.status === 'ready') {
      assert.equal(r.hint, undefined, label + ' 不该有 hint：能用的东西不需要指路');
    } else {
      assert.ok((r.hint ?? '').length > 0, label + ' 必须有 hint：没连上就要说清下一步');
    }
  }
});// ── 12. 极端输入 ───────────────────────────────────────────────
test('极端输入：全空也能出总览（不抛异常，HTTP 行永远在，空的 kind 不产生行）', () => {
  let rows: ConnectionRow[] = [];
  assert.doesNotThrow(() => {
    rows = buildConnections(base());
  });
  const http = pick(rows, 'channel', 'http');
  assert.equal(http?.status, 'connected');
  assert.equal(pickAll(rows, 'mail').length, 0, '没有邮箱账号就不该有邮箱行');
  assert.equal(pickAll(rows, 'connector').length, 0);
  assert.equal(pickAll(rows, 'model').length, 0);
  // 日历与 MCP 空配置各留一行「未配置/就绪」，比什么都不显示更能让人想起来去补
  assert.equal(pick(rows, 'calendar', 'calendar')?.status, 'ready');
  assert.equal(pick(rows, 'mcp', 'mcp')?.status, 'not_configured');
  assert.ok(renderConnections(rows).length > 0);
  assert.match(renderConnections([]), /共 0 项，connected 0 项，需处理 0 项/);
});

test('极端输入：脏 status（既不是 active 也不是 disabled）也归到 not_configured，不抛', () => {
  let rows: ConnectionRow[] = [];
  assert.doesNotThrow(() => {
    rows = buildConnections({ ...base(), mailAccounts: [mkMail('weird', { status: 'archived' })] });
  });
  assert.equal(pick(rows, 'mail', 'weird')?.status, 'not_configured');
});

// ── 13. 绝不泄露凭证 ───────────────────────────────────────────
test('不泄露凭证：渲染文本里没有 token / 密码 / secret / chat id 全文', () => {
  const rows = buildConnections({
    ...base(),
    mailAccounts: [
      mkMail('work', { label: '工作邮箱', email: 'me@corp.com', lastError: 'LOGIN failed: authentication failed' }),
    ],
    connectors: [gh('public-only')],
    models: [{ tier: 'primary', endpoint: 'https://api.example.com/v1', model: 'gpt-x', enabled: true }],
    // 真实值：app_id 与会话都「配好了」，主人会话有 2 个（真实 chat id 根本不在接口里）
    channel: { feishuAppId: 'cli_a1b2c3d4', ownerChatCount: 2, httpHost: '127.0.0.1', httpPort: 8787 },
  });
  const text = renderConnections(rows);
  for (const leak of ['secret', 'token=', 'oc_', 'Bearer', 'password', 'Authorization', 'app_secret', 'cli_a1b2c3d4']) {
    assert.equal(text.includes(leak), false, '渲染文本不该出现 ' + leak);
  }
  // 反过来：主人有权知道的必须在（不然就是另一种坏：什么都看不到）
  assert.ok(text.includes('me@corp.com'), '邮箱地址要显示');
  assert.ok(text.includes('https://api.example.com/v1'), '端点地址要显示');
  assert.ok(text.includes('主人会话 2 个'), '会话只报数量');
  assert.ok(text.includes('app_id 已配'), 'app_id 只报是否配置');
});

test('不泄露凭证：飞书 hint 里只出现配置项名，不出现任何值', () => {
  const text = renderConnections(buildConnections(base()));
  assert.match(text, /feishu:/);
  assert.equal(text.includes('oc_'), false);
  assert.equal(text.includes('cli_'), false);
});
