#!/usr/bin/env node
/**
 * scripts/.pipe-latency.mjs —— 阶段 2「链路开销」的确定性验收（2026-10-23）。
 *
 * 为什么需要它：真网关的 TTFT 在 1.3–21s 之间抖（共享中继），拿它当尺子量不出来
 * "合并链路本身有多慢"。这里起一个**本地 OpenAI 兼容上游**，首 token 固定延迟
 * （默认 300ms），于是：
 *
 *   firstDeltaMs ≈ 上游 TTFT(固定) + dotd 侧开销（派发 / 组 prompt / SSE 扇出）
 *
 * 上游是真的 HTTP + 真的 SSE 分帧，daemon 走真的 HttpTransport，**没有 stub**。
 *
 * 用法：
 *   node scripts/.pipe-latency.mjs            # 5 轮，TTFT=300ms
 *   TTFT_MS=800 RUNS=5 node scripts/.pipe-latency.mjs
 *
 * 产物：docs/acceptance/voice-pipe-latency/{run.json, daemon.log}
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'docs', 'acceptance', 'voice-pipe-latency');
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 7801);
const DAEMON_PORT = Number(process.env.DAEMON_PORT ?? 7798);
const BASE = `http://127.0.0.1:${DAEMON_PORT}`;
const MASTER = 'pipe-latency-smoke';
const TTFT_MS = Math.max(0, Number(process.env.TTFT_MS ?? 300));
const RUNS = Math.max(1, Number(process.env.RUNS ?? 5));
const CHUNKS = 8;
const CHUNK_GAP_MS = 40;

// ── 1. 本地确定性上游（OpenAI 兼容，SSE 真分帧）─────────────────────
const upstream = createServer((req, res) => {
  const hit = `${req.method} ${req.url}`;
  process.stderr.write(`[upstream] ${hit}
`);
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixed-ttft' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${req.method} ${req.url}` } }));
    return;
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 当空请求处理 */
    }
    const stream = body.stream === true;
    const text = '我在，这是一句固定长度的测试回话。';
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fixed',
          object: 'chat.completion',
          model: body.model ?? 'fixed-ttft',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        }),
      );
      return;
    }
    process.stderr.write(`[upstream] stream model=${body.model} tools=${Array.isArray(body.tools) ? body.tools.length : 0}
`);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const frame = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-fixed',
        object: 'chat.completion.chunk',
        model: body.model ?? 'fixed-ttft',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    setTimeout(() => {
      res.write(frame({ role: 'assistant', content: '' }));
      let i = 0;
      const tick = setInterval(() => {
        if (i < CHUNKS) {
          res.write(frame({ content: text.slice(i, i + 3) }));
          i += 3;
          return;
        }
        clearInterval(tick);
        res.write(frame({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }, CHUNK_GAP_MS);
    }, TTFT_MS);
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ── 2. daemon（真 HttpTransport，指向本地上游）───────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'dotd-pipe-'));
const dataDir = join(tmp, 'data');
const cfgDir = join(tmp, 'config');
mkdirSync(dataDir, { recursive: true });
mkdirSync(cfgDir, { recursive: true });
cpSync(join(REPO, 'config'), cfgDir, { recursive: true });
writeFileSync(
  join(cfgDir, 'models.yml'),
  `version: 1
endpoints:
  - id: local-fixed
    tier: 1
    base_url: http://127.0.0.1:${UPSTREAM_PORT}/v1
    api_key_env: none
    models: { primary: fixed-ttft, light: fixed-ttft }
    style: openai
    timeouts: { connect_ms: 5000, idle_ms: 60000, total_ms: 180000 }
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
    `    port: ${DAEMON_PORT}`,
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
  DOTD_CONFIG: cfg,
  DOTD_CONFIG_DIR: cfgDir,
  DOTD_DB_PATH: join(dataDir, 'dotd.db'),
  DOTD_HOME: dataDir,
  DOTD_WEB_ROOT: join(REPO, 'web-ui', 'dist'),
  DOTD_FLEET: 'stub',
  DOTD_HTTP_HOST: '127.0.0.1',
  DOTD_HTTP_PORT: String(DAEMON_PORT),
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
const flushLog = () => {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'daemon.log'), log, 'utf8');
  } catch {
    /* best-effort */
  }
};
process.on('exit', flushLog);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 200; i++) {
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
  upstream.close();
  process.exit(2);
}

// ── 3. 假设备跑 N 轮 ────────────────────────────────────────────────
console.log(`▶ 链路延迟：本地上游 TTFT=${TTFT_MS}ms，${RUNS} 轮`);
// 必须异步：本进程同时是上游模型服务，spawnSync 会堵住事件循环 → 上游不回包。
const childRun = spawn(
  process.execPath,
  [
    'scripts/fake-device.mjs',
    '--base', BASE,
    '--master', MASTER,
    '--create',
    '--runs', String(RUNS),
    '--timeout', '60000',
    '--text', '用一句话说说你现在能帮我做什么。',
    '--json',
  ],
  { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let runStdout = '';
let runStderr = '';
childRun.stdout.on('data', (d) => (runStdout += d));
childRun.stderr.on('data', (d) => (runStderr += d));
const r = await new Promise((res) => childRun.on('close', (status) => res({ status, stdout: runStdout, stderr: runStderr })));

let json = null;
try {
  json = JSON.parse(r.stdout);
} catch {
  /* 失败时下面打印原文 */
}
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'run.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), upstream: { ttftMs: TTFT_MS, chunks: CHUNKS, gapMs: CHUNK_GAP_MS }, runs: RUNS, exit: r.status, result: json, stderr: r.stderr }, null, 2)}\n`,
  'utf8',
);

if (json === null) {
  console.error(`fake-device 退出 ${r.status}\n${r.stdout}\n${r.stderr}`);
} else {
  const deltas = (json.results ?? []).map((x) => x.firstDeltaMs);
  const overhead = deltas.filter((v) => typeof v === 'number').map((v) => v - TTFT_MS);
  const pct = (arr, p) => {
    const vals = arr.filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (vals.length === 0) return null;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil((p / 100) * vals.length) - 1));
    return vals[idx];
  };
  console.log(
    `\n=== 链路 ===\n首条增量 P50 ${json.firstDeltaP50Ms}ms · P95 ${pct(deltas, 95)}ms · ` +
      `端到端 P50 ${json.endToEndP50Ms}ms / P95 ${json.endToEndP95Ms}ms\n` +
      `扣掉上游固定 TTFT(${TTFT_MS}ms)后的 dotd 开销：P50 ${pct(overhead, 50)}ms · P95 ${pct(overhead, 95)}ms\n` +
      `通过 ${json.passed}/${json.runs} · 产物 ${OUT}`,
  );
  for (const x of json.results ?? []) {
    console.log(`  [${x.index}] ${x.status} · first ${x.firstDeltaMs}ms · e2e ${x.endToEndMs}ms · ${x.streamReason}`);
  }
}

child.kill('SIGTERM');
await sleep(600);
upstream.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status === 0 && json?.ok === true ? 0 : 1);
