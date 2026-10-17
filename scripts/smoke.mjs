#!/usr/bin/env node
/**
 * scripts/smoke.mjs —— dotd 端到端冒烟（stub 全链路）。
 *
 * 目标（任务书原文）：
 *   cwd 无关；流程 = 临时数据目录 + stub 模型 / stub fleet 起 daemon 子进程 →
 *   GET /api/status → POST 一条测试事件 → 轮询直至任务 done（含至少一次工具步
 *   入 journal）→ SIGTERM 优雅退出 → 断言全中则 exit 0。
 *
 * 环境约束（CONVENTIONS.md §7 + 本机现状）：
 *   - 本机无 docker、无 OpenRouter key → 全链路走 DOTD_FLEET=stub +
 *     DOTD_MODEL_TRANSPORT=stub（零网络请求、零容器）。
 *   - 数据目录、库、OUTBOX、journal-blobs、exec-tokens 全部指到本脚本自建的
 *     临时目录；绝不碰宿主真实 ~/.dotd。
 *   - HTTP 配置来自自写的临时 config.yml（surfaces 六节缺一不可，SF 加载器
 *     fail-closed），master token 与 hook secret 由本脚本生成。
 *
 * cwd 无关：一切路径从本文件位置（repo 根 / dotd）推导，不读 process.cwd()。
 *
 * 退出码：0 = 全部断言通过；1 = 断言失败；2 = 环境/装配错误（含 daemon 起不来）。
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径（cwd 无关）───────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ── 可调参数 ──────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const POLL_MS = 250;
/** 事件源（config.yml hooks 里登记的 source；HMAC 用它做 secret）。 */
const HOOK_SOURCE = 'smoke';
const MASTER_TOKEN = 'smoke-master-token';
const HOOK_SECRET = 'smoke-hook-secret';
/**
 * 非 stub 模型传输分支的独立开关（默认关闭，原 11 条断言路径逐字不变）。
 *
 * 开 = 模型链路走 **真 HttpTransport**（DOTD_MODEL_TRANSPORT 不设 stub），
 * 但上游是一个本脚本在 127.0.0.1:0 起的**假 OpenAI 兼容服务**——零外网、零凭据。
 * 这样证明的是 `daemon → ModelRouter → HttpTransport → 真 TCP → 上游` 整条链，
 * 而不是 StubTransport 在内存里自说自话。stub 分支仍然保留：它是"路由/编排逻辑"
 * 的证明，假上游分支是"出网编解码"的证明，两者互不替代（CONVENTIONS §7）。
 */
const FAKE_UPSTREAM = process.env.DOTD_SMOKE_FAKE_UPSTREAM === '1';

// ── 断言记录 ──────────────────────────────────────────────────────────

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 临时数据目录 ──────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'dotd-smoke-'));
const dataDir = join(tmp, 'data');
const dbPath = join(dataDir, 'dotd.db');
mkdirSync(dataDir, { recursive: true });

const configPath = join(tmp, 'config.yml');
writeFileSync(
  configPath,
  [
    'version: 1',
    '',
    'surfaces:',
    '  http:',
    '    host: 127.0.0.1',
    '    port: 7788',
    `    master_token: "${MASTER_TOKEN}"`,
    '    readonly_tokens: []',
    '    allowed_origins: ["http://localhost:7788", "http://127.0.0.1:7788"]',
    '  hooks:',
    `    - source: ${HOOK_SOURCE}`,
    `      secret: "${HOOK_SECRET}"`,
    '      dot_id: dot1',
    '      rate_limit_per_min: 600',
    '  jsonl_watch: []',
    '  heartbeat:',
    '    tick_interval_s: 15',
    '  telegram:',
    '    bot_token: ""',
    '    allowlist: []',
    '    edit_throttle_ms: 1200',
    '  ui:',
    '    stream_deltas: true',
    '',
  ].join('\n'),
  'utf8',
);

// ── 起 daemon 子进程 ──────────────────────────────────────────────────

// 脚本按「端点 id × 轨道」回放，耗尽即抛错（router/transport.ts:213）。
// 事件分流器走 light 轨（control-plane/match.ts:251），任务对话走 primary 轨，两者都要预置。
const modelScript = JSON.stringify([
  // ① light 轨：事件分流器的 LLM 层（matchByLlm，严格 JSON 解析一次）
  {
    endpointId: 'openrouter-main',
    track: 'light',
    content: JSON.stringify({
      action: 'run_new',
      confidence: 1,
      reason: '冒烟事件：规则层未命中，LLM 层直接建任务',
      title: '冒烟测试事件',
      goal: '把冒烟笔记写进 notes/2026-10-15-smoke.md，然后收口。',
      priority: 5,
    }),
  },
  // ② primary 轨：任务第一步——工具调用（fs.write 入 journal）
  {
    endpointId: 'openrouter-main',
    track: 'primary',
    content: '先把冒烟笔记写进 home。',
    toolCalls: [
      {
        id: 'smoke-call-1',
        name: 'fs.write',
        arguments: JSON.stringify({
          // §3.2 记忆规范：模型给 home 相对路径 + note 命名 YYYY-MM-DD-<slug>.md
          // （limits.ts:93）；容器绝对路径由 Runner 在 toolCall() 里拼接（dot.ts
          //  withHomeRootArgs，memory.md:237），模型侧绝不出现 /dot/home。
          path: 'notes/2026-10-15-smoke.md',
          content: '# dotd 冒烟\nstub 全链路写入。\n',
        }),
      },
    ],
  },
  // ③ primary 轨：收口轮
  {
    endpointId: 'openrouter-main',
    track: 'primary',
    content: '冒烟任务完成：已写入 notes/2026-10-15-smoke.md。',
  },
]);

const env = {
  ...process.env,
  DOTD_DB_PATH: dbPath,
  DOTD_HOME: dataDir,
  DOTD_CONFIG: configPath,
  DOTD_CONFIG_DIR: join(REPO_ROOT, 'config'),
  DOTD_WEB_ROOT: join(REPO_ROOT, 'web-ui', 'dist'),
  DOTD_MODEL_TRANSPORT: 'stub',
  DOTD_MODEL_STUB_SCRIPT: modelScript,
  DOTD_FLEET: 'stub',
  // 宿主真实 ~/.dotd 绝不被读：db/config/outbox 都已显式覆盖
  HOME: homedir(),
};

// ── 假 OpenAI 兼容上游（仅 DOTD_SMOKE_FAKE_UPSTREAM=1 时启用）───────
//
// 一个真监听在 127.0.0.1:0 的 http 服务：按顺序把上面同一份 modelScript 里的
// content / toolCalls 编成**真 OpenAI 线格式**回给 daemon。daemon 那边不知道它是假的，
// 走的是真 HttpTransport（真 TCP、真 JSON 编解码、真 SSE 路径不涉及——本分支用非流式）。
//
// 为什么要复用 modelScript 而不是另写一份：这保证"stub 分支能跑通的编排"在真传输上
// 也跑通同样的编排，差异只在传输层这一个变量上，对照才有意义。

/** 按端点/轨/模型命中 modelScript，模拟 StubTransport 的 take() 语义（顺序消费）。 */
function makeFakeUpstreamScript(items) {
  const queue = items.map((it) => ({ ...it, used: false }));
  return function take(track, model) {
    for (const it of queue) {
      if (it.used) continue;
      if (it.track !== undefined && it.track !== track) continue;
      if (it.model !== undefined && it.model !== model) continue;
      it.used = true;
      return it;
    }
    return null;
  };
}

/** 把一条脚本项编成 OpenAI chat.completion 线格式。 */
function toWireCompletion(item, model) {
  const toolCalls = (item.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    type: 'function',
    // 上游看到的是消毒后的名字，且**按线上名字回显**——顺带验证 transport 的还原表
    function: { name: String(tc.name).replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: tc.arguments },
  }));
  return {
    id: `chatcmpl-smoke-${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: item.content ?? '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

/**
 * 把一条脚本项编成 OpenAI 兼容 SSE 流（P0-2 之后 daemon 的 Runner 会带 `stream:true`）。
 *
 * 线格式与真 provider 一致：正文按小块下发、工具调用按 `delta.tool_calls[]` 增量下发
 * （index 相同 = 同一调用，参数是文本分片），最后 `[DONE]`。
 * 这样冒烟验证的就是生产那条「SSE 解析 → 增量聚合 → 派发工具」的真实链路。
 */
function toWireStream(item, model) {
  const frames = [];
  const content = String(item.content ?? '');
  // 正文：每 4 字符一块
  for (const piece of content.match(/.{1,4}/gs) ?? []) {
    frames.push({ choices: [{ index: 0, delta: { content: piece } }] });
  }
  // 工具调用：首块带 id/name/首段参数，其余块只带参数分片
  for (const [i, tc] of (item.toolCalls ?? []).entries()) {
    const args = String(tc.arguments ?? '');
    const argPieces = args.match(/.{1,8}/gs) ?? [''];
    frames.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: 'function',
                // 上游看到的是消毒后的名字，且**按线上名字回显**——顺带验证 transport 的还原表
                function: { name: String(tc.name).replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: argPieces[0] ?? '' },
              },
            ],
          },
        },
      ],
    });
    for (const rest of argPieces.slice(1)) {
      frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: rest } }] } }] });
    }
  }
  const finishReason = (item.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop';
  frames.push({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  void model;
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** 起假上游；返回 { baseUrl, requests, close }。 */
async function startFakeUpstream(scriptItems) {
  const take = makeFakeUpstreamScript(scriptItems);
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push({ path: req.url, body: parsed, auth: req.headers.authorization ?? null });
      // 判定轨道：本冒烟里 light 轨只出现在事件分流，primary 轨是任务对话。
      // 上游无法直接看到 track，按 system prompt 兜底识别（见 buildMessages）。
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const sys = msgs.find((m) => m.role === 'system');
      const track = /分流|classify|事件匹配/i.test(String(sys?.content ?? '')) ? 'light' : 'primary';
      const model = String(parsed?.model ?? '');
      const item = take(track, model) ?? take('primary', model);
      if (item === null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }));
        return;
      }
      // P0-2：Runner 现在会带 stream:true → 按 SSE 下发（线格式与真 provider 同形）。
      if (parsed?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(toWireStream(item, model));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(toWireCompletion(item, model)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

let fakeUpstream = null;
let fakeCfgDir = null;
if (FAKE_UPSTREAM) {
  fakeUpstream = await startFakeUpstream(JSON.parse(modelScript));
  // 独立的 config 目录：只覆盖 models.yml（其余 yml 仍指仓库 config/，
  // 靠 DOTD_CONFIG_DIR 指向临时目录 + 把需要的文件复制过来）。
  fakeCfgDir = join(tmp, 'config-fake');
  mkdirSync(fakeCfgDir, { recursive: true });
  for (const f of ['dotd.yml', 'event-rules.yml', 'free-models.yml', 'rules.yml', 'tools.yml']) {
    const src = join(REPO_ROOT, 'config', f);
    if (existsSync(src)) writeFileSync(join(fakeCfgDir, f), readFileSync(src));
  }
  // 把真 config/models.yml 的 base_url 换成本地假上游；端点 id / 模型名 / 超时全部保留，
  // 这样路由层看到的配置与生产同形，唯一的变量是"网络那头是谁"。
  const modelsYml = readFileSync(join(REPO_ROOT, 'config', 'models.yml'), 'utf8');
  const rewritten = modelsYml.replace(
    /^(\s*base_url:\s*)http:\/\/127\.0\.0\.1:7863\/v1\s*$/m,
    `$1${fakeUpstream.baseUrl}`,
  );
  if (rewritten === modelsYml) {
    process.stderr.write('[smoke] 假上游分支：没能在 models.yml 里找到 tier1 base_url，配置改写失败\n');
    await fakeUpstream.close();
    process.exit(2);
  }
  writeFileSync(join(fakeCfgDir, 'models.yml'), rewritten, 'utf8');

  // 切到假上游分支：不设 DOTD_MODEL_TRANSPORT=stub（= 真实路径），config 指向临时目录
  env.DOTD_MODEL_TRANSPORT = '';
  delete env.DOTD_MODEL_STUB_SCRIPT;
  env.DOTD_CONFIG_DIR = fakeCfgDir;
  // 假上游不校验鉴权，但仍给出一个假 key：证明 apiKeyEnv 真的被读并上送
  env.WB2API_KEY = 'smoke-fake-key';
}

const daemon = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'daemon.ts')], {
  cwd: REPO_ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});

let daemonOut = '';
let daemonErr = '';
daemon.stdout.on('data', (b) => {
  daemonOut += b.toString();
});
daemon.stderr.on('data', (b) => {
  daemonErr += b.toString();
});

// ── HTTP 小客户端（原生 fetch）─────────────────────────────────────────

const BASE = 'http://127.0.0.1:7788';

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${MASTER_TOKEN}`,
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:7788',
      ...headers,
    },
    // body 已是字符串（HMAC 按原文签名，绝不能二次 stringify）；对象才序列化。
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（静态托管等） */
  }
  return { status: res.status, json, text };
}

/** §5.2 hooks HMAC：`sha256=hex(hmac(secret, ts\n nonce\n body))`（http.ts:160 hmacSignature）。 */
function hookHeaders(bodyText) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sig = createHmac('sha256', HOOK_SECRET).update(`${ts}\n${nonce}\n${bodyText}`, 'utf8').digest('hex');
  return {
    'x-dotd-timestamp': ts,
    'x-dotd-nonce': nonce,
    'x-dotd-signature': `sha256=${sig}`,
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────

let failed = false;
let exitCode = 2;

try {
  // ① 等 daemon 就绪（HTTP 起来 + 迁移完成）
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let up = false;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) break;
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(POLL_MS);
  }
  check('daemon 子进程存活并完成启动', up, daemon.exitCode !== null ? `子进程已退出 code=${daemon.exitCode}` : '');
  if (daemon.exitCode !== null) {
    process.stderr.write(daemonErr.slice(-4000) + '\n');
    throw new Error('daemon 提前退出');
  }

  // ② GET /api/status（健康探针）
  const status = await api('GET', '/api/status');
  check('GET /api/status → 200 且含 service 字段', status.status === 200 && status.json?.service === 'dotd', `status=${status.status} body=${status.text.slice(0, 200)}`);

  // ②b web-ui 产物被 daemon 静态托管（SF web.ts；dist 未构建时不拒启动、只返回说明页）。
  //     dist 存在时 index.html 与其引用的 JS/CSS 都必须 200——这是"六视图构建产物真的
  //    能被服务"的唯一端到端证据（http.ts 的 static 路由）。
  const distDir = join(REPO_ROOT, 'web-ui', 'dist');
  if (existsSync(join(distDir, 'index.html'))) {
    const html = await api('GET', '/');
    const assetRefs = [...String(html.text).matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
    check('GET / → 200 且是 UI index.html', html.status === 200 && html.text.includes('<div id="root">'), `status=${html.status} bytes=${html.text.length}`);
    let allAssets = assetRefs.length > 0;
    const details = [];
    for (const ref of assetRefs) {
      const a = await api('GET', `/${ref}`);
      if (a.status !== 200) allAssets = false;
      details.push(`${ref}=${a.status}`);
    }
    check('UI 静态资源（JS/CSS）全部 200', allAssets, details.join(' ') || 'index.html 无 assets 引用');
  } else {
    check('GET / → 200 且是 UI index.html', false, `web-ui/dist 不存在（未构建）：${distDir}`);
  }

  // ③ POST 一条测试事件（hooks ingest，HMAC）
  const payload = {
    source: HOOK_SOURCE,
    title: '冒烟测试事件',
    goal: '把冒烟笔记写进 notes/2026-10-15-smoke.md，然后收口。',
    priority: 5,
  };
  const bodyText = JSON.stringify(payload);
  const posted = await api('POST', `/hooks/${HOOK_SOURCE}`, bodyText, {
    'content-type': 'application/json',
    ...hookHeaders(bodyText),
  });
  check(
    'POST /hooks/smoke → 202 {eventId}',
    posted.status === 202 && typeof posted.json?.eventId === 'number',
    `status=${posted.status} body=${posted.text.slice(0, 300)}`,
  );
  const eventId = posted.json?.eventId;

  // ④ 轮询：事件被匹配（event.match 走 light 轨 → run_new 建任务）
  let taskId = null;
  {
    const dl = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < dl && taskId === null) {
      const r = await api('GET', '/api/queue?status=queued,running,awaiting_approval,paused,done,failed,cancelled&limit=200');
      const row = (r.json?.queue ?? []).find((t) => t.id === `tk_ev_${eventId}` || t.title.includes('冒烟测试事件'));
      if (row !== undefined) taskId = row.id;
      else await sleep(POLL_MS);
    }
  }
  check('事件匹配建任务（tk_ev_<eventId>）', taskId !== null, `eventId=${eventId} taskId=${taskId}`);

  // ⑤ 轮询任务终态：done（含 journal 工具步）
  let finalRow = null;
  {
    const dl = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < dl) {
      const r = await api('GET', '/api/queue?status=done,failed,cancelled&limit=200');
      const row = (r.json?.queue ?? []).find((t) => t.id === taskId);
      if (row !== undefined) {
        finalRow = row;
        break;
      }
      await sleep(POLL_MS);
    }
  }
  check('任务到达终态 done', finalRow !== undefined && finalRow.status === 'done', `taskId=${taskId} status=${finalRow?.status ?? 'n/a'}`);

  // ⑥ journal 至少一次工具步入账（直接读库：冒烟进程与 daemon 同机，只读一次）
  let toolStep = null;
  if (taskId !== null) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(`SELECT call_id, tool_name, status, result_json FROM steps WHERE task_id = ? AND kind = 'tool' ORDER BY seq ASC`)
        .all(taskId);
      toolStep = rows[0] ?? null;
    } finally {
      db.close();
    }
  }
  check(
    'journal 含至少一次工具步（fs.write 且 succeeded）',
    toolStep !== null && toolStep.tool_name === 'fs.write' && toolStep.status === 'succeeded',
    toolStep === null
      ? 'steps 无 tool 行'
      : `${toolStep.tool_name} status=${toolStep.status}${toolStep.result_json ? ` result=${String(toolStep.result_json).slice(0, 200)}` : ''}`,
  );

  // ⑦ 优雅退出（退出码 0 + 优雅标记 + OUTBOX 留痕）
  //
  // 平台分层（本机实测，Node v24.13.0 / 原生 Windows）：
  //   Windows 下 spawn 出的子进程，跨进程 kill(SIGTERM/SIGINT/SIGBREAK)、cmd.exe 包装、
  //   进程组 kill 一律被 OS 直接终止，子进程 handler **不执行**（12–25ms 即死、无留痕）。
  //   唯一能触发 handler 的通道是进程内 process.emit(sig)。因此：
  //   - Linux/WSL：直接 daemon.kill('SIGTERM')（生产形态，control-plane.md:60 契约）。
  //   - Windows：经 IPC 让 daemon 自投递 SIGTERM，走**完全相同**的 shutdown() 路径
  //     （停投递 → AbortSignal → 落 journal → markGracefulShutdown → OUTBOX → exit 0），
  //     只是触发源从 OS 信号换成 IPC 消息（src/daemon.ts 的 message 监听）。
  const onWindows = process.platform === 'win32';
  const exitSignal = onWindows ? 'SIGTERM（IPC 触发，Windows 跨进程信号不可达）' : 'SIGTERM';
  const beforeExit = Date.now();
  if (onWindows) {
    daemon.send({ type: 'shutdown' });
  } else {
    daemon.kill('SIGTERM');
  }
  const exited = await Promise.race([
    new Promise((r) => daemon.once('exit', (code, signal) => r({ code, signal }))),
    sleep(35_000).then(() => null),
  ]);
  const exitMs = Date.now() - beforeExit;
  check(
    `${exitSignal} 后 daemon 优雅退出（exitCode=0）`,
    exited !== null && exited.code === 0,
    exited === null
      ? '35s 内未退出'
      : `code=${exited.code} signal=${exited.signal} 用时 ${exitMs}ms${onWindows ? '（Windows 经 IPC 触发同一 shutdown 路径）' : ''}`,
  );

  // ⑧ 优雅退出落痕：resource_events 的 shutdown_marker + OUTBOX.md 追加
  //   落点口径（control-plane/recovery.ts:69-72）：不建 meta 表（契约 D3），
  //   用 resource_events 一行 kind='watchdog' + detail 含 "shutdown_marker" 记录；
  //   cp.shutdown()（control-plane/index.ts:355-359）与 markGracefulShutdown 同口径。
  if (taskId !== null && existsSync(dbPath)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let marker = null;
    try {
      marker =
        db
          .prepare(
            `SELECT kind, detail FROM resource_events WHERE kind = 'watchdog' AND detail LIKE '%shutdown_marker%' ORDER BY id DESC LIMIT 1`,
          )
          .get() ?? null;
    } finally {
      db.close();
    }
    check('优雅停机标记落库（shutdown_marker）', marker !== null, JSON.stringify(marker?.detail ?? null).slice(0, 120));
  }
  const outboxText = existsSync(join(dataDir, 'OUTBOX.md')) ? readFileSync(join(dataDir, 'OUTBOX.md'), 'utf8') : '';
  check('OUTBOX.md 有优雅退出留痕', outboxText.includes('优雅退出'), `bytes=${outboxText.length}`);

  // ⑨【仅假上游分支】真 HttpTransport 链路的独立证据。
  //
  // 前 8 条断言（①–⑧ 原 11 个 check）在两种分支下逐字相同——它们只回答"编排对不对"。
  // 这一条回答另一个问题，只有走真传输时才有意义：
  //   daemon 里的 ModelRouter 是否**真的通过 TCP** 打到了上游、发的是不是合法
  //   OpenAI 线格式（stream:false + tools 带 type:function + 真 Authorization），
  //   以及上游回显的消毒工具名是否被还原成契约名（fs_write → fs.write）。
  // 没有这一条，"冒烟全绿"就只是证明了 stub 在内存里自洽。
  if (FAKE_UPSTREAM) {
    const reqs = fakeUpstream.requests;
    check(
      '假上游分支：daemon 真的通过 TCP 打到了上游（请求数 > 0）',
      reqs.length > 0,
      `收到 ${reqs.length} 个 /chat/completions 请求`,
    );

    const chatReqs = reqs.filter((r) => String(r.path).endsWith('/chat/completions'));
    check(
      '假上游分支：全部请求走 POST /v1/chat/completions',
      chatReqs.length === reqs.length && reqs.length > 0,
      `paths=${[...new Set(reqs.map((r) => r.path))].join(',')}`,
    );

    // 线格式：tools 必须是 {type:'function',function:{name,parameters}}，名字已消毒。
    // P0-2 之后 Runner 走流式 → 请求体 stream:true（假上游按 SSE 回应，见 toWireStream）。
    const withTools = chatReqs.filter((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);
    const wireOk =
      withTools.length > 0 &&
      withTools.every(
        (r) =>
          r.body.tools.every(
            (t) =>
              t.type === 'function' &&
              typeof t.function?.name === 'string' &&
              /^[a-zA-Z0-9_-]+$/.test(t.function.name) &&
              typeof t.function?.parameters === 'object',
          ) &&
          r.body.stream === true,
      );
    check(
      '假上游分支：tools 线格式合法（type=function / 名字已消毒 / stream:true 走 SSE）',
      wireOk,
      withTools.length === 0
        ? '没有带 tools 的请求'
        : `带工具请求 ${withTools.length} 个，示例=${JSON.stringify(withTools[0].body.tools.map((t) => t.function.name))}`,
    );

    // 鉴权头：apiKeyEnv 指向的 WB2API_KEY 必须真的上送
    const authOk = chatReqs.length > 0 && chatReqs.every((r) => r.auth === 'Bearer smoke-fake-key');
    check(
      '假上游分支：Authorization 头按 api_key_env 真的上送',
      authOk,
      `示例=${JSON.stringify(chatReqs[0]?.auth ?? null)}`,
    );

    // 消毒名还原：journal 里记的必须是契约名 fs.write，不是 fs_write
    const journalOk = toolStep !== null && toolStep.tool_name === 'fs.write';
    check(
      '假上游分支：上游回显的消毒工具名已还原为契约名（fs_write → fs.write）',
      journalOk,
      `journal tool_name=${toolStep?.tool_name ?? 'n/a'}`,
    );
  }

  failed = checks.some((c) => !c.ok);
  exitCode = failed ? 1 : 0;
} catch (cause) {
  process.stderr.write(`[smoke] 异常：${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.stderr.write('--- daemon stdout ---\n' + daemonOut.slice(-4000) + '\n');
  process.stderr.write('--- daemon stderr ---\n' + daemonErr.slice(-6000) + '\n');
  exitCode = 2;
} finally {
  if (daemon.exitCode === null) {
    daemon.kill('SIGKILL');
  }
  if (fakeUpstream !== null) {
    try {
      await fakeUpstream.close();
    } catch {
      // 已关
    }
  }
  // Windows 上文件句柄释放有延迟（WAL/SHM），删不掉只留警告，不影响判定
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(200);
    }
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────

const passed = checks.filter((c) => c.ok).length;
process.stdout.write(`\n冒烟结果：${passed}/${checks.length} 通过，退出码 ${exitCode}\n`);
process.exit(exitCode);
