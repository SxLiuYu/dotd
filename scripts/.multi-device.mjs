#!/usr/bin/env node
/**
 * scripts/.multi-device.mjs —— 阶段 3「一个主人，多台设备」的真机验收（2026-10-24）。
 *
 * 三件事，全部打真 daemon（真 HttpTransport + 真模型；只有容器是 stub）：
 *
 *   A. 并发：**3 台模拟设备各跑 3 轮**（`npm run voice:device -- --runs 3`），同时开跑；
 *      断言互不串台：每台只看到自己的 3 个任务，读别人的任务 404，设备令牌打管理面 403。
 *   B. 单设备闸：同一台设备上一件事没完时再投一句 → `409 device_busy`（多设备并发不受影响）。
 *   C. 共享记忆：设备 A 说「我对花生过敏」→ 设备 B 提问「我对什么过敏」→ B 的回答必须提到花生。
 *      同一 dotId 共享长期记忆，但会话（voice thread）按设备隔离。
 *
 * 产物：docs/acceptance/voice-multi-device/{run.json, daemon.log}
 * 退出码：全过 0；任一断言失败 1。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'docs', 'acceptance', 'voice-multi-device');
const PORT = Number(process.env.DAEMON_PORT ?? 7797);
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = 'multi-device-smoke';
const MODEL = process.env.DOTD_SMOKE_MODEL ?? 'hy3';
const DEVICES = 3;
const RUNS_PER_DEVICE = 3;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 180_000);

function loadTokensEnv() {
  const out = {};
  for (const p of [join(process.env.HOME ?? '', '.dotd', 'tokens.env'), join(process.env.USERPROFILE ?? '', '.dotd', 'tokens.env')]) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim().replace(/^\uFEFF/, '');
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      if (line.startsWith('export ')) line = line.slice(7).trim();
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (k && !(k in out)) out[k] = v;
    }
  }
  return out;
}

const tokens = loadTokensEnv();
if (!tokens.HY3_API_KEY) {
  console.error('~/.dotd/tokens.env 里没有 HY3_API_KEY，无法用真模型');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'dotd-multi-'));
const dataDir = join(tmp, 'data');
const cfgDir = join(tmp, 'config');
mkdirSync(dataDir, { recursive: true });
mkdirSync(cfgDir, { recursive: true });
cpSync(join(REPO, 'config'), cfgDir, { recursive: true });
// 追踪代理（DOTD_SMOKE_TRACE=1）：只记录请求体，再把请求原样转给真网关。
// 用途：判断"B 答不出花生"到底是没注入，还是模型看到了却装作没有。
const TRACE = process.env.DOTD_SMOKE_TRACE === '1';
const UPSTREAM = 'http://172.17.48.1:13065';
const TRACE_PORT = 7811;
const traceLines = [];
let traceServer = null;
if (TRACE) {
  traceServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 非 JSON 原样转发 */
      }
      if (parsed !== null && Array.isArray(parsed.messages)) {
        traceLines.push({
          at: new Date().toISOString(),
          model: parsed.model,
          messages: parsed.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 200),
          })),
        });
      }
      try {
        const upstream = await fetch(`${UPSTREAM}${req.url}`, {
          method: req.method,
          headers: {
            'content-type': req.headers['content-type'] ?? 'application/json',
            accept: req.headers.accept ?? '*/*',
            authorization: req.headers.authorization ?? '',
          },
          body: req.method === 'GET' ? undefined : raw,
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        if (upstream.body === null) {
          res.end();
          return;
        }
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `trace proxy: ${String(err)}` } }));
      }
    });
  });
  await new Promise((r) => traceServer.listen(TRACE_PORT, '127.0.0.1', r));
}
const MODEL_BASE = TRACE ? `http://127.0.0.1:${TRACE_PORT}/v1` : `${UPSTREAM}/v1`;

writeFileSync(
  join(cfgDir, 'models.yml'),
  `version: 1
endpoints:
  - id: local-hy3
    tier: 1
    base_url: ${MODEL_BASE}
    api_key_env: HY3_API_KEY
    models: { primary: ${MODEL}, light: ${MODEL} }
    style: openai
    extra_body: { chat_template_kwargs: { enable_thinking: false } }
    timeouts: { connect_ms: 5000, idle_ms: 90000, total_ms: 240000 }
`,
  'utf8',
);
const cfg = join(tmp, 'config.yml');
writeFileSync(
  cfg,
  [
    'version: 1',
    '',
    'surfaces:',
    '  http:',
    '    host: 127.0.0.1',
    `    port: ${PORT}`,
    `    master_token: "${MASTER}"`,
    '    readonly_tokens: []',
    '    allowed_origins: []',
    '  hooks: []',
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

const env = {
  ...process.env,
  ...tokens,
  DOTD_CONFIG: cfg,
  DOTD_CONFIG_DIR: cfgDir,
  DOTD_DB_PATH: join(dataDir, 'dotd.db'),
  DOTD_HOME: dataDir,
  DOTD_WEB_ROOT: join(REPO, 'web-ui', 'dist'),
  DOTD_FLEET: 'stub',
  DOTD_HTTP_HOST: '127.0.0.1',
  DOTD_HTTP_PORT: String(PORT),
  DOTD_MODEL_TRANSPORT: '',
};

const child = spawn(process.execPath, ['--import', 'tsx', 'src/daemon.ts'], {
  cwd: REPO,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
process.on('exit', () => {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'daemon.log'), log, 'utf8');
    if (traceLines.length > 0) {
      const NL = String.fromCharCode(10);
      writeFileSync(join(OUT, 'prompts.jsonl'), traceLines.map((x) => JSON.stringify(x)).join(NL) + NL, 'utf8');
    }
  } catch {
    /* best-effort */
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', token = MASTER, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

let up = false;
for (let i = 0; i < 240; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* retry */
  }
  await sleep(250);
}
if (!up) {
  console.error(log.slice(-4000));
  child.kill();
  process.exit(2);
}

/** 直接投一句话并等终态（记忆 A/B 用；不走 fake-device，便于拿原始 reply）。 */
async function turnAndWait(token, text, label) {
  const submitted = await api('/api/device/turn', { method: 'POST', token, body: { text } });
  if (submitted.status !== 202 || typeof submitted.body?.taskId !== 'string') {
    return { label, ok: false, reason: `turn HTTP ${submitted.status} ${JSON.stringify(submitted.body)}` };
  }
  const taskId = submitted.body.taskId;
  const startedAt = Date.now();
  while (Date.now() - startedAt < TURN_TIMEOUT_MS) {
    const r = await api(`/api/device/tasks/${encodeURIComponent(taskId)}`, { token });
    if (r.status === 200) {
      const status = r.body?.task?.status;
      if (['done', 'failed', 'cancelled', 'paused', 'awaiting_approval'].includes(status)) {
        return {
          label,
          ok: status === 'done',
          taskId,
          threadId: submitted.body.threadId ?? null,
          status,
          reply: typeof r.body?.reply === 'string' ? r.body.reply : null,
          waitedMs: Date.now() - startedAt,
        };
      }
    }
    await sleep(400);
  }
  return { label, ok: false, taskId, status: 'timeout', reply: null, threadId: submitted.body.threadId ?? null };
}

function runFakeDevice(token, index) {
  return new Promise((res) => {
    // 用和文档一致的入口：npm run voice:device -- --runs 3
    const args = [
      'run',
      'voice:device',
      '--',
      '--base', BASE,
      '--master', MASTER,
      '--device-token', token,
      '--runs', String(RUNS_PER_DEVICE),
      '--timeout', String(TURN_TIMEOUT_MS),
      '--text', '用一句话说说你现在能帮我做什么。',
      '--json',
    ];
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: REPO,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      // `npm run` 会先打印两行横幅（> dotd@… / > node scripts/…），
      // JSON 从第一个独立的 "{" 行开始。
      let json = null;
      const start = stdout.indexOf('{' + String.fromCharCode(10));
      if (start >= 0) {
        try {
          json = JSON.parse(stdout.slice(start));
        } catch {
          json = null;
        }
      }
      res({ index, exit: code, json, stdout: json === null ? stdout.slice(-2000) : undefined, stderr: stderr.slice(-2000) });
    });
  });
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

// ── A. 3 台设备并发 ─────────────────────────────────────────────────
console.log(`\n▶ A. ${DEVICES} 台模拟设备并发 × ${RUNS_PER_DEVICE} 轮`);
const devices = [];
for (let i = 0; i < DEVICES; i++) {
  const created = await api('/api/devices', { method: 'POST', body: { name: `multi-dev-${i + 1}` } });
  if (created.status !== 201 || typeof created.body?.token !== 'string') {
    console.error(`创建设备 ${i + 1} 失败：${created.status} ${JSON.stringify(created.body)}`);
    child.kill();
    process.exit(2);
  }
  devices.push({ id: created.body.id, name: created.body.name, token: created.body.token });
}

const startedAt = Date.now();
const runs = await Promise.all(devices.map((d) => runFakeDevice(d.token, devices.indexOf(d))));
const wallMs = Date.now() - startedAt;

const perDevice = runs.map((r, i) => {
  const d = devices[i];
  const results = r.json?.results ?? [];
  const taskIds = results.map((x) => x.taskId).filter((x) => typeof x === 'string');
  return {
    deviceId: d.id,
    name: d.name,
    exit: r.exit,
    passed: r.json?.passed ?? 0,
    runs: r.json?.runs ?? 0,
    firstDeltaP50Ms: r.json?.firstDeltaP50Ms ?? null,
    endToEndP50Ms: r.json?.endToEndP50Ms ?? null,
    taskIds,
    threads: [...new Set(results.map((x) => x.threadId).filter(Boolean))],
    statuses: results.map((x) => x.status),
    stderr: r.stderr || null,
    stdout: r.stdout,
  };
});

record(
  `3 台设备各自 ${RUNS_PER_DEVICE} 轮全部 done`,
  perDevice.every((d) => d.exit === 0 && d.passed === RUNS_PER_DEVICE),
  perDevice.map((d) => `${d.name}: ${d.passed}/${d.runs}`).join(' · '),
);

const allTaskIds = perDevice.flatMap((d) => d.taskIds);
record(
  `任务互不重叠（${allTaskIds.length} 个 taskId 唯一）`,
  new Set(allTaskIds).size === allTaskIds.length && allTaskIds.length === DEVICES * RUNS_PER_DEVICE,
  `${new Set(allTaskIds).size} unique`,
);

// 并发真的重叠：3 台设备各投一句，记录"首次看到在途"和"收口"时刻，
// 断言存在一个共同时刻三台设备都在途（只看墙钟不可靠：网关会串行排队）。
async function probeOverlap() {
  const subs = [];
  for (const d of devices) {
    const r = await api('/api/device/turn', {
      method: 'POST',
      token: d.token,
      body: { text: '用一句话说明今天适合做什么。' },
    });
    subs.push({ deviceId: d.id, token: d.token, status: r.status, taskId: r.body?.taskId ?? null });
  }
  const state = new Map(
    subs.filter((x) => x.taskId !== null).map((x) => [x.taskId, { firstSeen: null, end: null, status: null }]),
  );
  const t0 = Date.now();
  while (Date.now() - t0 < TURN_TIMEOUT_MS) {
    let pending = 0;
    for (const s of subs) {
      if (s.taskId === null) continue;
      const st = state.get(s.taskId);
      if (st.end !== null) continue;
      const r = await api(`/api/device/tasks/${encodeURIComponent(s.taskId)}`, { token: s.token });
      const status = r.body?.task?.status;
      st.firstSeen ??= Date.now();
      st.status = status;
      if (['done', 'failed', 'cancelled', 'paused'].includes(status)) st.end = Date.now();
      else pending += 1;
    }
    if (pending === 0) break;
    await sleep(150);
  }
  const windows = [...state.entries()].map(([taskId, st]) => ({ taskId, ...st }));
  const overlap =
    windows.length === DEVICES &&
    windows.every((w) => w.firstSeen !== null && w.end !== null) &&
    Math.max(...windows.map((w) => w.firstSeen)) < Math.min(...windows.map((w) => w.end));
  return {
    overlap,
    accepted: subs.filter((x) => x.status === 202).length,
    windows: windows.map((w) => ({ taskId: w.taskId, firstSeen: w.firstSeen, end: w.end, status: w.status })),
    spanMs: windows.length > 0 ? Math.max(...windows.map((w) => w.end ?? 0)) - Math.min(...windows.map((w) => w.firstSeen ?? 0)) : null,
  };
}

const overlapProbe = await probeOverlap();
record(
  '3 台设备同时有在途任务（区间重叠，不是排队假装并发）',
  overlapProbe.overlap && overlapProbe.accepted === DEVICES,
  `accepted ${overlapProbe.accepted}/${DEVICES} · 重叠窗口 ${overlapProbe.spanMs ?? '—'}ms`,
);

// 会话隔离：每台设备一条 voice thread，且互不相同
const threadIds = perDevice.map((d) => d.threads[0] ?? null);
record(
  `每台设备恰好一条会话（各自 ${RUNS_PER_DEVICE} 轮复用同一条），且设备间不同`,
  perDevice.every((d) => d.threads.length === 1) && new Set(threadIds).size === DEVICES,
  threadIds.map((t) => t?.slice(-8) ?? '—').join(' / '),
);

// 越权读别人的任务 → 404；管理面 → 403
const crossRead = await api(`/api/device/tasks/${encodeURIComponent(perDevice[1].taskIds[0])}`, {
  token: devices[0].token,
});
record('设备 A 读设备 B 的任务 → 404', crossRead.status === 404, `HTTP ${crossRead.status}`);

const queueProbe = await api('/api/queue', { token: devices[0].token });
record('设备令牌打管理面 /api/queue → 403 device_scope', queueProbe.status === 403, `HTTP ${queueProbe.status}`);

// ── B. 单设备闸：在途时再投 → 409 ───────────────────────────────────
console.log('\n▶ B. 同一台设备在途时再投一句 → 409');
const busyDevice = devices[0];
const first = await api('/api/device/turn', {
  method: 'POST',
  token: busyDevice.token,
  body: { text: '把一句话分成三步想清楚再回答：现在几点了？' },
});
const second = await api('/api/device/turn', {
  method: 'POST',
  token: busyDevice.token,
  body: { text: '再来一句，应该被拒。' },
});
record(
  '同设备第二句 → 409 device_busy',
  first.status === 202 && second.status === 409 && second.body?.error === 'device_busy',
  `first ${first.status} / second ${second.status} ${second.body?.error ?? ''}`,
);
// 等第一句收口，别把 409 留给后面的记忆测试
if (first.status === 202 && typeof first.body?.taskId === 'string') {
  const t0 = Date.now();
  while (Date.now() - t0 < TURN_TIMEOUT_MS) {
    const r = await api(`/api/device/tasks/${encodeURIComponent(first.body.taskId)}`, { token: busyDevice.token });
    const st = r.body?.task?.status;
    if (['done', 'failed', 'cancelled', 'paused'].includes(st)) break;
    await sleep(400);
  }
}

const dbPath = join(dataDir, 'dotd.db');
function countRows(sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get(...params);
    return Number(Object.values(row ?? { n: 0 })[0] ?? 0);
  } finally {
    db.close();
  }
}

// ── C. 跨设备共享记忆 A/B ────────────────────────────────────────────
console.log('\n▶ C. 跨设备共享记忆：A 说「花生过敏」，B 提问');
const devA = devices[0];
const devB = devices[1];

// 显式要求"先落盘再答应"：实测 hy3（关思考）会口头说"已记住"却不调 fs.write，
// 于是 B 当然查不到 —— 这不是记忆链路的问题，是模型偷懒。先要求，再校验落盘。
const WRITE_TEXT =
  '请把这件事记到长期记忆里：我对花生过敏，涉及食物时要提醒我。' +
  '做法：先调用 fs.write 把这条写进 MEMORY.md 的 Current concerns 段（保留原有段落结构），' +
  '再回复一句确认。不要只口头答应，必须真的调用工具。';
let writeTurn = await turnAndWait(devA.token, WRITE_TEXT, 'A:记住');
let writeSteps = countRows(
  "SELECT COUNT(*) AS n FROM steps WHERE task_id = ? AND tool_name = 'fs.write' AND status = 'succeeded'",
  writeTurn.taskId ?? '',
);
if (writeSteps === 0) {
  console.log('  A 第一次没落盘（模型只口头答应），重试一次并要求用工具');
  writeTurn = await turnAndWait(
    devA.token,
    '现在请立刻调用 fs.write，把「我对花生过敏，涉及食物时提醒我」写入 MEMORY.md 的 Current concerns 段，然后回复确认。',
    'A:记住(重试)',
  );
  writeSteps = countRows(
    "SELECT COUNT(*) AS n FROM steps WHERE task_id = ? AND tool_name = 'fs.write' AND status = 'succeeded'",
    writeTurn.taskId ?? '',
  );
}
console.log(`  A: ${writeTurn.status} · fs.write×${writeSteps} · ${(writeTurn.reply ?? '').slice(0, 60)}`);

const traceMarkB = traceLines.length;
const askTurn = await turnAndWait(devB.token, '我对什么过敏？用一句话回答我。', 'B:提问');
console.log(`  B: ${askTurn.status} · ${(askTurn.reply ?? '').slice(0, 80)}`);
const bInjected = traceLines
  .slice(traceMarkB)
  .some((t) => t.messages.some((m) => m.content.includes('# MEMORY.md') && m.content.includes('花生')));

record(
  'A 真的把事实落盘（fs.write succeeded，不是口头答应）',
  writeSteps > 0,
  `fs.write×${writeSteps} · ${writeTurn.status}`,
);
record(
  'B 的任务上下文里注入了含「花生」的 MEMORY.md（跨设备记忆注入）',
  bInjected,
  TRACE ? (bInjected ? 'prompt 里有' : 'prompt 里没有') : '未开 TRACE（DOTD_SMOKE_TRACE=1 才有证据）',
);
record(
  'B（另一台设备）能召回「花生」',
  askTurn.ok && typeof askTurn.reply === 'string' && /花生/.test(askTurn.reply),
  (askTurn.reply ?? '(空)').slice(0, 120),
);
record(
  '共享记忆但会话隔离：A/B 的 thread 不同',
  typeof writeTurn.threadId === 'string' &&
    typeof askTurn.threadId === 'string' &&
    writeTurn.threadId !== askTurn.threadId,
  `${writeTurn.threadId?.slice(-8) ?? '—'} vs ${askTurn.threadId?.slice(-8) ?? '—'}`,
);

// 反向对照：第三台设备问同一问题也应召回（记忆在 dot 层，不在设备层）
// 第三台设备用**同一句话**问（同题对照：记忆在 dot 层，不该因为换了设备就没了）。
// 换措辞的鲁棒性依赖模型自己想检索词，属模型能力，另记在文档里，不当成链路结论。
const askTurnC = await turnAndWait(devices[2].token, '我对什么过敏？用一句话回答我。', 'C:提问');
record(
  '第三台设备（同题）同样能召回「花生」（记忆属于 dot，不属于设备）',
  askTurnC.ok && typeof askTurnC.reply === 'string' && /花生/.test(askTurnC.reply),
  (askTurnC.reply ?? '(空)').slice(0, 120),
);

// 数据层证据（白盒，读同一份库）：
//  ① 事实只落在 A 的会话里（用户原话不会抄到别人会话）；
//  ② B/C 的会话里出现「花生」= 它们真的答出来了（不是同一段上下文）；
//  ③ B 的凭证里确实调了 memory.search。
const factInA = countRows('SELECT COUNT(*) AS n FROM mem_messages WHERE thread_id = ? AND content LIKE ?', writeTurn.threadId, '%花生%');
const factOutsideA = countRows('SELECT COUNT(*) AS n FROM mem_messages WHERE thread_id <> ? AND content LIKE ?', writeTurn.threadId, '%花生%');
const instructionLeak = countRows(
  'SELECT COUNT(*) AS n FROM mem_messages WHERE thread_id <> ? AND content LIKE ?',
  writeTurn.threadId,
  '%记住一件事%',
);
const bProof = await api(`/api/tasks/${encodeURIComponent(askTurn.taskId)}/proof`);
const searchSteps = Array.isArray(bProof.body?.steps)
  ? bProof.body.steps.filter((st) => st.tool === 'memory.search')
  : [];

record('事实落在 A 的会话里（写进去了）', factInA > 0, `A 里 ${factInA} 条含「花生」`);
record('B/C 的会话里出现「花生」（跨设备答出来了）', factOutsideA > 0, `A 之外 ${factOutsideA} 条`);
record('用户原话没有跨会话抄写（会话隔离，不是共享上下文）', instructionLeak === 0, `泄漏 ${instructionLeak} 条`);
record('B 的凭证里确实调了 memory.search', bProof.status === 200 && searchSteps.length > 0, `memory.search ×${searchSteps.length}`);

const passed = checks.filter((c) => c.ok).length;
const summary = {
  generatedAt: new Date().toISOString(),
  model: `${MODEL} @ 172.17.48.1:13065（真 HTTP；容器 stub）`,
  concurrency: { devices: DEVICES, runsPerDevice: RUNS_PER_DEVICE, wallMs, perDevice, overlapProbe },
  checks,
  memory: { write: writeTurn, askB: askTurn, askC: askTurnC },
  trace: TRACE
    ? traceLines.map((x) => ({
        at: x.at,
        model: x.model,
        hasMemoryNote: x.messages.some((m) => m.content.includes('# MEMORY.md')),
        memoryMentionsPeanut: x.messages.some((m) => m.content.includes('花生')),
        systemBytes: x.messages.filter((m) => m.role === 'system').reduce((n, m) => n + m.content.length, 0),
      }))
    : null,
  passed,
  total: checks.length,
  ok: passed === checks.length,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(`\n=== 结果 ===\n${passed}/${checks.length} 通过 · 墙钟 ${wallMs}ms · 产物 ${OUT}`);
child.kill('SIGTERM');
await sleep(800);
if (process.env.DOTD_SMOKE_KEEP === '1') console.log(`保留临时目录：${tmp}`);
else rmSync(tmp, { recursive: true, force: true });
process.exit(summary.ok ? 0 : 1);
