/**
 * tests/surfaces-insight-routes.test.ts —— D1/D2/D3 三条只读路由的 HTTP 层证据。
 *
 * 为什么单独一个文件（而不是并进 surfaces-http-hmac.test.ts）：
 * 那个文件守的是签名/鉴权/路由表；本文件守的是**「装好了就是装好了，没装就明说」**——
 * `/d/<slug>`、`/api/brief`、`/api/connections` 三条路由在装配缺腿时必须回 503 并说明
 * 缺哪条腿，而不是回一个空页面、一句「今天没事」或一个空数组。
 *
 * 起真实 HTTP server（随机端口，127.0.0.1）。`readHomeFile` 在这里是注入的假实现，
 * 因此本文件**不证明**真容器里的文件读写（那条链路由 exec 侧 fs.read 负责）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/surfaces/http.ts';
import type { HttpDeps } from '../src/surfaces/http.ts';
import type { Server } from 'node:http';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import { SseBus } from '../src/surfaces/sse.ts';
import type { SurfacesConfig } from '../src/surfaces/types.ts';
import type { ConnectionRow } from '../src/surfaces/connections.ts';
import type { DailyBrief } from '../src/surfaces/daily-brief.ts';
import type {
  ControlPlane,
  GovernancePort,
  MemoryPort,
  RouterPort,
} from '../src/shared/contracts.ts';

const MASTER = 'master-token-test';

function makeConfig(): SurfacesConfig {
  return {
    http: {
      host: '127.0.0.1',
      port: 0,
      masterToken: MASTER,
      readonlyTokens: [],
      allowedOrigins: [],
    },
    hooks: [],
    jsonlWatch: [],
    heartbeat: { tickIntervalS: 15 },
    telegram: { botToken: '', allowlist: [], editThrottleMs: 1500 },
    feishu: { appId: '', appSecret: '', verificationToken: '', encryptKey: '', editThrottleMs: 1500 },
    ui: { streamDeltas: true },
    progress: { enabled: false, everyNSteps: 3, minIntervalMs: 90_000 },
    brief: { enabled: false, time: '08:30', chatId: null, windowMin: 180, maxChars: 1200 },
    connWatch: { enabled: false, intervalMin: 15, quietHours: null },
  };
}

const fakeCp = {
  ingestEvent: () => ({ eventId: 1, dup: false }),
  submit: () => ({ id: 'tk', status: 'queued' as const }),
  list: () => [],
  cancel: () => ({ ok: true }),
  getGuardStatus: () => ({}),
} as unknown as ControlPlane;

const fakeGov: GovernancePort = {
  decide: () => Promise.resolve({ ok: true }),
  listPending: () => [],
  getApproval: () => Promise.resolve(null),
};

const fakeMem: MemoryPort = {
  openThread: () => Promise.resolve('th'),
  appendMessage: () => Promise.resolve({ id: 'm', seq: 1 }),
  listThreads: () => Promise.resolve([]),
  listMessages: () => Promise.resolve([]),
};

const fakeRouter: RouterPort = { snapshot: () => ({ mode: 'normal', endpoints: [], tracks: [] }) as never };

interface Harness {
  dir: TempDataDir;
  server: Server;
  base: string;
  sse: SseBus;
}

async function startServer(extra: Partial<HttpDeps> = {}): Promise<Harness> {
  const dir = makeTempDataDir();
  const bus = new EventBus();
  const sse = new SseBus({ db: dir.db, bus });
  const server = createHttpServer({
    db: dir.db,
    bus,
    cp: fakeCp,
    gov: fakeGov,
    mem: fakeMem,
    router: fakeRouter,
    channels: null,
    sse,
    cfg: makeConfig(),
    webRoot: dir.root,
    ...extra,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}`, sse };
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((res) => h.server.close(() => res()));
  h.sse.detach();
  h.dir.cleanup();
}

const auth = { authorization: `Bearer ${MASTER}` };

// ═══════════════════════════════════════════════════════════════════
// 一、GET /d/<slug> —— 仪表盘托管
// ═══════════════════════════════════════════════════════════════════

test('/d/<slug>：装配了 readHomeFile 且文件是 HTML → 200，带 CSP 且 CSP 里没有 script-src', async () => {
  const seen: Array<{ dotId: string; path: string }> = [];
  const h = await startServer({
    dotId: 'dot1',
    readHomeFile: (dotId, path) => {
      seen.push({ dotId, path });
      return Promise.resolve(Buffer.from('<!doctype html><html><body><h1>成本看板</h1></body></html>', 'utf8'));
    },
  });
  try {
    const res = await fetch(`${h.base}/d/costs`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.equal(/script-src/.test(csp), false, 'CSP 绝不能给脚本开口子');
    assert.match(csp, /default-src 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store', '页面会被定时任务重写，不能缓存');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /成本看板/);
    // 读的是容器 home 里的 dashboards/<slug>.html，且带上了 dotId
    assert.deepEqual(seen, [{ dotId: 'dot1', path: 'dashboards/costs.html' }]);
  } finally {
    await close(h);
  }
});

test('/d/<slug>：文件不存在 → 404，并告诉主人「怎么做一个」（不是空白页）', async () => {
  const h = await startServer({ dotId: 'dot1', readHomeFile: () => Promise.resolve(null) });
  try {
    const res = await fetch(`${h.base}/d/never-made`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /没有这个仪表盘/);
    assert.match(body, /dashboards\/never-made\.html/, '要说清它会写到哪个文件');
  } finally {
    await close(h);
  }
});

test('/d/<slug>：slug 不合法 → 404 且说清规则（不做归一化、不放行路径穿越）', async () => {
  let called = 0;
  const h = await startServer({
    readHomeFile: () => {
      called += 1;
      return Promise.resolve(Buffer.from('<!doctype html><html></html>'));
    },
  });
  try {
    for (const bad of ['BAD..slug', '..%2Fetc%2Fpasswd', 'has space', 'UPPER']) {
      const res = await fetch(`${h.base}/d/${bad}`);
      assert.equal(res.status, 404, bad);
      const body = await res.text();
      assert.match(body, /页面名不合法|没给页面名/, bad);
    }
    assert.equal(called, 0, '不合法 slug 绝不能碰到读文件那一层');
  } finally {
    await close(h);
  }
});

test('/d：没给页面名 → 404「没给页面名」，不是 500', async () => {
  const h = await startServer({ readHomeFile: () => Promise.resolve(null) });
  try {
    const res = await fetch(`${h.base}/d`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /没给页面名/);
  } finally {
    await close(h);
  }
});

test('/d/<slug>：内容不像 HTML → 422 dashboard_invalid，不硬发给浏览器', async () => {
  const h = await startServer({
    readHomeFile: () => Promise.resolve(Buffer.from('{"this":"is json"}', 'utf8')),
  });
  try {
    const res = await fetch(`${h.base}/d/jsonish`);
    assert.equal(res.status, 422);
    const body = await res.json() as { error?: string; reason?: string };
    assert.equal(body.error, 'dashboard_invalid');
    assert.equal(body.reason, 'not_html');
  } finally {
    await close(h);
  }
});

test('/d/<slug>：装配缺 readHomeFile → 503 并说明缺哪条腿（不回空页面）', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/d/anything`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /readHomeFile/);
  } finally {
    await close(h);
  }
});

test('/d/<slug>：读文件抛错 → 503 且带上原因（不吞异常假装 404）', async () => {
  const h = await startServer({
    readHomeFile: () => Promise.reject(new Error('container_lost')),
  });
  try {
    const res = await fetch(`${h.base}/d/broken`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /container_lost/);
  } finally {
    await close(h);
  }
});

test('/d/<slug>：不需要 token（页面本身不含数据源凭据），但也不回 SPA index.html', async () => {
  const h = await startServer({ readHomeFile: () => Promise.resolve(null) });
  try {
    const res = await fetch(`${h.base}/d/whatever`); // 故意不带 Authorization
    // 走的是仪表盘分支（404 + 仪表盘文案），而不是静态托管吃掉的 SPA 兜底
    assert.equal(res.status, 404);
    assert.match(await res.text(), /没有这个仪表盘/);
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 二、GET /api/brief —— 每日简报
// ═══════════════════════════════════════════════════════════════════

test('/api/brief：装配了 provider → 200 并原样返回 DailyBrief', async () => {
  const brief: DailyBrief = {
    sections: [{ id: 'approvals', title: '等你批的事', lines: ['· #9001 删除 notes/old.md（dangerous）'] }],
    text: '等你批的事\n· #9001 删除 notes/old.md（dangerous）',
    omittedSections: ['calendar', 'tasks', 'crontabs', 'mail'],
  };
  const h = await startServer({
    brief: (nowMs) => {
      assert.equal(typeof nowMs, 'number', '路由应把「现在」传进去，取数不自己看表');
      return brief;
    },
  });
  try {
    const res = await fetch(`${h.base}/api/brief`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), brief);
  } finally {
    await close(h);
  }
});

test('/api/brief：装配缺 provider → 503，绝不用「今天没事」冒充成功', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/api/brief`, { headers: auth });
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.match(body, /brief/);
    assert.equal(/今天没有需要你关注的事/.test(body), false, '缺腿时不能回一句「今天没事」');
  } finally {
    await close(h);
  }
});

test('/api/brief：provider 抛错 → 500，错误信息带回（不静默成空简报）', async () => {
  const h = await startServer({
    brief: () => {
      throw new Error('calendar dir unreadable');
    },
  });
  try {
    const res = await fetch(`${h.base}/api/brief`, { headers: auth });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /calendar dir unreadable/);
  } finally {
    await close(h);
  }
});

test('/api/brief：没有 token → 401（简报含日程与任务标题，不是公开数据）', async () => {
  const h = await startServer({ brief: () => ({ sections: [], text: '', omittedSections: [] }) });
  try {
    const res = await fetch(`${h.base}/api/brief`);
    assert.equal(res.status, 401);
  } finally {
    await close(h);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 三、GET /api/connections —— 已连接应用总览
// ═══════════════════════════════════════════════════════════════════

test('/api/connections：装配了 provider → 200，返回 rows + summary + 渲染好的 text', async () => {
  const rows: ConnectionRow[] = [
    { kind: 'calendar', id: 'calendar', name: '日历', status: 'ready', detail: '0 个日历源 / 0 个事件' },
    {
      kind: 'connector',
      id: 'github',
      name: 'GitHub',
      status: 'public_only',
      detail: 'Issues / Pulls',
      hint: '设置 DOTD_GITHUB_TOKEN 环境变量可提高限额',
    },
  ];
  const h = await startServer({ connections: () => rows });
  try {
    const res = await fetch(`${h.base}/api/connections`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: ConnectionRow[]; summary: { total: number; connected: number; issues: number }; text: string };
    assert.deepEqual(body.rows, rows, '行必须原样透出，不在路由层改写');
    // summary 与 text 由路由层统一算，保证 `dotd connections` 与 Web 看到的是同一份口径
    assert.deepEqual(body.summary, { total: 2, connected: 0, issues: 1 });
    assert.match(body.text, /日历/);
    assert.match(body.text, /共 2 项，connected 0 项，需处理 1 项/);
  } finally {
    await close(h);
  }
});

test('/api/connections：装配缺 provider → 503（不回空数组冒充「什么都没连」）', async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/api/connections`, { headers: auth });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /connections/);
  } finally {
    await close(h);
  }
});

test('/api/connections：provider 抛错 → 500，错误信息带回', async () => {
  const h = await startServer({
    connections: () => {
      throw new Error('models.yml 解析失败');
    },
  });
  try {
    const res = await fetch(`${h.base}/api/connections`, { headers: auth });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /models\.yml 解析失败/);
  } finally {
    await close(h);
  }
});

test('/api/connections：没有 token → 401（总览里有端点与配置项的轮廓）', async () => {
  const h = await startServer({ connections: () => [] });
  try {
    const res = await fetch(`${h.base}/api/connections`);
    assert.equal(res.status, 401);
  } finally {
    await close(h);
  }
});
