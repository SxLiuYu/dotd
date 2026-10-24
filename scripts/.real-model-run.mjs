#!/usr/bin/env node
/**
 * scripts/.real-model-run.mjs —— 阶段 2 止损线的一次性验收（2026-10-23）。
 *
 * 做三件事，全部用**真模型**（不在内存里自说自话）：
 *   1. 起一个真 daemon（临时 home / 临时库），models.yml 指向本机 hy3 网关；
 *   2. `fake-device.mjs --runs 5` 量首条增量与端到端延迟；
 *   3. 再跑一个需要工具的任务，导出 `dotd prove` 的 PROOF.md / proof.json。
 *
 * 产物写到 docs/acceptance/voice-real-model/（run.json / PROOF.md / proof.json）。
 * 不打印任何密钥；HY3_API_KEY 从 ~/.dotd/tokens.env 读进子进程环境。
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'docs', 'acceptance', 'voice-real-model');
const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = 'real-model-smoke';
const MODEL = process.env.DOTD_SMOKE_MODEL ?? 'hy3';
// 语音要的是「第一句」延迟，不是总时长：
//  - hy3 / Qwen3 默认都带隐式思考，第一个 content 分片要等思考结束（hy3 默认 3.3s，关掉 1.7–2.6s）；
//  - 网关只认 chat_template_kwargs 里的 `enable_thinking:false`，顶层同名字段被忽略
//    （Qwen3.8-Flash 实测仍是 31s）。
// DOTD_SMOKE_THINKING_OFF=0 可关掉这条，用来复现"不配置 extra_body"的基线。
const THINKING_OFF = process.env.DOTD_SMOKE_THINKING_OFF !== '0';
const EXTRA = THINKING_OFF
  ? '    extra_body: { chat_template_kwargs: { enable_thinking: false } }\n'
  : '';
const MODELS = `version: 1
endpoints:
  - id: local-hy3
    tier: 1
    base_url: http://172.17.48.1:13065/v1
    api_key_env: HY3_API_KEY
    models: { primary: ${MODEL}, light: ${MODEL} }
    style: openai
${EXTRA}    timeouts: { connect_ms: 5000, idle_ms: 60000, total_ms: 180000 }
`;

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

// 调试开关：只跑少量轮次 / 跳过工具任务（默认全量，验收用默认值）。
const SIMPLE_RUNS = Math.max(1, Number(process.env.DOTD_SMOKE_RUNS ?? 5) || 5);
const SKIP_TOOL = process.env.DOTD_SMOKE_SKIP_TOOL === '1';

const tokens = loadTokensEnv();
if (!tokens.HY3_API_KEY) {
  console.error('~/.dotd/tokens.env 里没有 HY3_API_KEY，无法用真模型');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'dotd-real-'));
const dataDir = join(tmp, 'data');
const cfgDir = join(tmp, 'config');
mkdirSync(dataDir, { recursive: true });
mkdirSync(cfgDir, { recursive: true });
cpSync(join(REPO, 'config'), cfgDir, { recursive: true });
writeFileSync(join(cfgDir, 'models.yml'), MODELS, 'utf8');

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
  // 刻意**不设** DOTD_MODEL_TRANSPORT=stub：走真 HttpTransport。
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
// 真模型的失败原因（paused / 400 / 协议不符）只在 daemon 日志里，必须落盘可查。
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
  process.exit(2);
}

function runFake(args) {
  const r = spawnSync(process.execPath, ['scripts/fake-device.mjs', ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.status !== 0) {
    console.error(`fake-device 退出 ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return { status: r.status, json: safeJson(r.stdout) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── 1. 简单问答 ×N：量延迟 ─────────────────────────────────────────
console.log(`▶ 真模型：${SIMPLE_RUNS} 轮简单问答`);
const latency = runFake([
  '--base', BASE,
  '--master', MASTER,
  '--create',
  '--runs', String(SIMPLE_RUNS),
  '--timeout', '120000',
  '--text', '用一句话说说你现在能帮我做什么。',
  '--json',
]);

// ── 2. 工具任务 ×1：拿 ≥3 步的凭证 ────────────────────────────────
let toolRun = { status: 0, json: null };
if (SKIP_TOOL) {
  console.log('▶ 跳过工具任务（DOTD_SMOKE_SKIP_TOOL=1）');
} else {
console.log('▶ 真模型：一个需要工具的任务（凭证样例）');
toolRun = runFake([
  '--base', BASE,
  '--master', MASTER,
  '--create',
  '--runs', '1',
  '--timeout', '180000',
  '--text',
  '请分两步做：第一步用 fs.list 列出当前工作目录（path 用 "."）；第二步用 fs.write 把「语音凭证样例」写进 notes/2026-10-23-voice-proof.md。做完后用一句话告诉我结果。',
  '--json',
]);
}

const taskId = toolRun.json?.results?.[0]?.taskId;
let proof = null;
if (taskId) {
  const r = await fetch(`${BASE}/api/tasks/${encodeURIComponent(taskId)}/proof`, {
    headers: { authorization: `Bearer ${MASTER}` },
  });
  if (r.ok) proof = await r.json();
}

mkdirSync(OUT, { recursive: true });
if (proof) {
  writeFileSync(join(OUT, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
  const cli = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/surfaces/cli.ts', 'prove', taskId, '--out', OUT],
    {
      cwd: REPO,
      env: { ...env, DOTD_URL: BASE, DOTD_MASTER_TOKEN: MASTER },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  if (cli.status !== 0) console.error(`dotd prove 退出 ${cli.status}\n${cli.stderr}`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  model: `${MODEL} @ 172.17.48.1:13065 (real HTTP, no stub)`,
  latency,
  toolTask: { run: toolRun, proof: proof === null ? null : {
    taskId,
    bundleHash: proof.bundleHash,
    steps: proof.steps.length,
    toolSteps: proof.counts.toolSteps,
    tools: proof.steps.filter((s) => s.kind === 'tool').map((s) => s.tool),
    device: proof.device ?? null,
    status: proof.task.status,
  } },
};
writeFileSync(join(OUT, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log('\n=== 结果 ===');
console.log(
  `简单问答：${latency.json?.passed ?? 0}/${latency.json?.runs ?? 0} 成功 · ` +
    `首条增量 P50 ${latency.json?.firstDeltaP50Ms ?? '—'}ms · 端到端 P50 ${latency.json?.endToEndP50Ms ?? '—'}ms · ` +
    `P95 ${latency.json?.endToEndP95Ms ?? '—'}ms`,
);
console.log(
  `工具任务：status=${proof?.task?.status ?? '—'} · steps=${proof?.steps?.length ?? '—'} · ` +
    `toolSteps=${proof?.counts?.toolSteps ?? '—'} · tools=${(proof?.steps ?? []).filter((s) => s.kind === 'tool').map((s) => s.tool).join(',') || '—'}`,
);
console.log(`凭证：${taskId ?? '—'} · bundleHash ${proof?.bundleHash?.slice(0, 16) ?? '—'}…`);
console.log(`产物：${OUT}`);

child.kill('SIGTERM');
await sleep(800);
// `DOTD_SMOKE_KEEP=1` 保留临时 home + 库，用来查"某一步为什么 failed"。
if (process.env.DOTD_SMOKE_KEEP === '1') console.log(`保留临时目录：${tmp}`);
else rmSync(tmp, { recursive: true, force: true });
process.exit(0);
