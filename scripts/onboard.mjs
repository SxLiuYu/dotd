#!/usr/bin/env node
/**
 * scripts/onboard.mjs —— 陌生人第一次：一次体检 + 下一步做什么（阶段 4，2026-10-23）。
 *
 * 它不安装任何东西、不写任何密钥、不打印密钥值。只回答三个问题：
 *   1. 这台机器现在能不能跑（Node / Python / ffmpeg / Docker / 配置 / 模型 key）；
 *   2. 缺的那一项**具体**怎么补（命令或文件路径）；
 *   3. 补完之后第一条能验证成功的命令是什么。
 *
 * 用法：
 *   npm run onboard
 *   npm run onboard -- --json
 *
 * 退出码：0 = 必需项全过；1 = 有必需项缺失（按输出逐条补）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from './lib/python.mjs';
import { layeredEnv, resolveConfigDir, usableToken } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const JSON_OUT = process.argv.includes('--json');

/** @type {Array<{id:string, label:string, level:'required'|'recommended'|'optional', ok:boolean, detail:string, fix?:string}>} */
const checks = [];

function add(id, label, level, ok, detail, fix) {
  checks.push({ id, label, level, ok, detail, ...(fix ? { fix } : {}) });
}

function run(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
    return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

// 注意：这里不再是"把 DOTD_NODE 当作 python 候选"的那种复用（原来 firstVersion
// 会把 DOTD_NODE 也当解释器试，是笔误）。Python 的解析全交给 resolvePython。

// ── 1. Node / Python ────────────────────────────────────────────────

const nodeMajor = Number(process.versions.node.split('.')[0]);
add(
  'node',
  'Node.js ≥ 22',
  'required',
  nodeMajor >= 22,
  `v${process.versions.node}`,
  nodeMajor >= 22 ? undefined : '升级 Node 到 22+：https://nodejs.org/（node:sqlite 需要）',
);

// Python：`python` 在 Debian/Ubuntu/WSL 上默认不存在（只有 `python3`），
// 而且仓库在 /mnt 下时 Windows 的 .venv 也能被看见 —— 解析顺序统一交给
// scripts/lib/python.mjs（显式指定 → 当前平台 .venv → python3 → python）。
const pyResolved = resolvePython({
  repoRoot: REPO,
  run: (bin, args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  },
});
const py = pyResolved ? { bin: pyResolved.bin, out: pyResolved.out } : null;
add(
  'python',
  'Python ≥ 3.10',
  'required',
  py !== null,
  py ? `${py.out}（用 ${py.bin}）` : '未找到 Python 解释器',
  py !== null ? undefined : '装 Python 3.10+（apt install python3 / brew install python），或设 DOTD_PYTHON',
);

// ── 2. 外部二进制 ───────────────────────────────────────────────────

const ff = run('ffmpeg', ['-version']);
add(
  'ffmpeg',
  'ffmpeg（语音编解码）',
  'recommended',
  ff.ok,
  ff.ok ? (ff.out.split('\n')[0] ?? 'ok') : '未找到',
  ff.ok ? undefined : 'apt install ffmpeg / brew install ffmpeg（纯文本任务可以先不装）',
);

const docker = run('docker', ['--version']);
add(
  'docker',
  'Docker（数字工具容器）',
  'optional',
  docker.ok,
  docker.ok ? (docker.out.split('\n')[0] ?? 'ok') : '未找到（box 档位可只用宿主 MCP）',
  docker.ok ? undefined : '需要可跑容器时：https://docs.docker.com/engine/install/',
);

// ── 2.5 语音输入（ASR）── 别让"体检全绿、设备听不见"再发生 ─────────────
//
// 2026-10-25 实测：TTS 修好之后设备仍然不能对话，因为 ASR 整条链都返回空 ——
// SenseVoice 模型文件没下载（237MB，不在仓库里），百度 key 没配，StepFun 没配，
// ASR_PRIORITY 里四个 provider 全灭。而当时的体检（onboard / setup:all --check）
// 只验了 Python 依赖"能 import"，完全看不出这台机器是聋的。这里补一条。
//
// 两个位置都要看：宿主机是 `voice/charlie/models/`（上游 PROJECT_DIR），
// Docker 是数据卷 `<home>/voice/models/`（entrypoint 下到那儿）。只看前者会把
// 容器部署误判成聋的。

// 配置根（后面所有"这台机器有什么"都从这里出发）。
const home = process.env.CHARLIE_HOME ?? process.env.DOTD_HOME ?? join(homedir(), '.dotd');

// key 的"真相" = 进程环境 ∪ `<home>/tokens.env`（后者是 daemon 启动时 source 的那份）。
// 只看 process.env 是错的：交互式 shell 不 source tokens.env，于是 live 机上
// HY3/OPENROUTER/BACKUP **三个 key 都在文件里、daemon 用得正顺**，体检却报"缺模型 key"。
const keys = layeredEnv({ home, homedir: homedir() });

const asrHome = home;
const senseModels = [
  join(asrHome, 'voice', 'models', 'sense-voice', 'model.int8.onnx'),
  join(REPO, 'voice', 'charlie', 'models', 'sense-voice', 'model.int8.onnx'),
].filter((p) => existsSync(p));
// 百度要三个 key 齐全（上游判定如此），只算两个会给出"已配置"的假结论。
const baiduReady = ['BAIDU_APP_ID', 'BAIDU_API_KEY', 'BAIDU_SECRET_KEY'].every((k) => keys.has(k));
const cloudAsr = [
  ...(baiduReady ? ['baidu'] : []),
  ...(keys.has('STEPFUN_KEY') ? ['stepfun'] : []),
];
const localAsr = senseModels.length > 0;
add(
  'asr',
  '语音识别（ASR）',
  'recommended',
  localAsr || cloudAsr.length > 0,
  localAsr
    ? `SenseVoice 本地模型已就位（${senseModels[0]}）`
    : cloudAsr.length > 0
      ? `云端 ASR 已配置：${cloudAsr.join(', ')}`
      : '没有任何可用的 ASR：本地模型没下载，云端 key 也没配（设备会"听不见"）',
  localAsr || cloudAsr.length > 0
    ? undefined
    : [
        '二选一：',
        // 提示里的命令必须**能直接粘贴就跑**：`python` 在 Debian/WSL 上不存在，
        // 所以用这里已经解析出来的解释器（而不是假设叫 python）。
        `  1. 本地（免费、26ms，推荐）："${py?.bin ?? 'python3'}" -m voice.integration.asr_model ` +
          'voice/charlie/models/sense-voice',
        '     直接跑上游脚本常常失败：它只有 GitHub release 一个源，国内会超时',
        '  2. 云端：在 tokens.env 里配 STEPFUN_KEY，或百度 BAIDU_APP_ID/API_KEY/SECRET_KEY',
        'Docker 部署不用管这条：entrypoint 会自己下到 /data/voice/models/。',
      ].join('\n'),
);

// ── 3. 配置根与主人令牌（只看键名，不打印值）─────────────────────────

const cfgPath =
  process.env.DOTD_CONFIG ??
  [
    join(home, 'config.yml'),
    join(homedir(), '.charlie', 'config.yml'),
    join(homedir(), '.dotd', 'config.yml'),
  ].find((p) => existsSync(p)) ??
  join(home, 'config.yml');

const cfgExists = existsSync(cfgPath);
add('config', 'dotd 配置', 'required', cfgExists, cfgExists ? cfgPath : `未找到 ${cfgPath}`, cfgExists ? undefined : 'npm run init-config');

let tokenOk = false;
let tokenSource = '';
if (cfgExists) {
  try {
    const text = readFileSync(cfgPath, 'utf8');
    const m = /master_token:\s*"?([^"\n]+)"?/.exec(text);
    // config.yml 里写的是 `${DOTD_MASTER_TOKEN}`（init-config 的默认形态）时，
    // 它本身**不是**令牌，只是引用。原来只判"长度 ≥16 且不含 change-me"，
    // 于是未展开的占位符长度 20 被当成真令牌 —— live 上这一行一直是假绿
    // （2026-10-26）。daemon 拿到它之后是 expandEnv 展开，空则 fail-closed。
    const tok = usableToken(m?.[1]);
    tokenOk = tok !== null;
    tokenSource = tokenOk ? `${cfgPath} 的 surfaces.http.master_token` : '';
  } catch {
    tokenOk = false;
  }
}
if (!tokenOk) {
  // 同样按 daemon 的眼光看 tokens.env（原来手写正则，漏了 `NAME = value` 的空格变体）。
  const master = usableToken(keys.get('DOTD_MASTER_TOKEN'));
  if (master !== null) {
    tokenOk = true;
    tokenSource = `${keys.sources.DOTD_MASTER_TOKEN ?? 'tokens.env'} 的 DOTD_MASTER_TOKEN`;
  }
}
add(
  'token',
  '主人令牌',
  'required',
  tokenOk,
  tokenOk ? tokenSource : '未配置或仍是占位值',
  tokenOk ? undefined : '在 config.yml 的 surfaces.http.master_token 填 openssl rand -hex 32 的输出',
);

// ── 4. 模型 key（只报端点名，不报 key）─────────────────────────────

// 读的必须是 daemon 会读的那份（2026-10-26）。ModelRouter 读
// `join(cfg.configDir, 'models.yml')`，configDir = `DOTD_CONFIG_DIR ?? repo/config`；
// 托管部署里那是 `~/.dotd/models.yml`。原来 onboard 写死仓库模板：
// 主人在运行时那份里换了 api_key_env（或干脆只改了那份），onboard 却在
// 另一份文件里数 key 名 —— 又一个"检查器看错地方"。
// 判据与 doctor / probe-live-model 共用 `scripts/lib/env.mjs` 的 resolveConfigDir。
const configDir = resolveConfigDir({ repoRoot: REPO, home: homedir() });
const modelCfg = join(configDir, 'models.yml');
const repoModelCfg = join(REPO, 'config', 'models.yml');
let modelOk = false;
let modelDetail =
  modelCfg !== repoModelCfg && existsSync(repoModelCfg)
    ? `未找到 ${modelCfg}（仓库模板 ${repoModelCfg} 存在，但 daemon 不读它）`
    : `未找到 ${modelCfg}`;
if (existsSync(modelCfg)) {
  const text = readFileSync(modelCfg, 'utf8');
  const envNames = [...text.matchAll(/api_key_env:\s*(\S+)/g)].map((m) => m[1]).filter((v) => v && v !== 'none');
  // 与 daemon 同口径：进程环境 ∪ `<home>/tokens.env`（2026-10-26）。
  // 原来只查 process.env，于是 live 机上三个 key 都在 tokens.env 里、daemon 用得
  // 正顺，人一敲 onboard 却看见"缺模型 key" —— 检查器看错了地方，结论却指向用户。
  const present = envNames.filter((name) => keys.has(name));
  const uniq = [...new Set(envNames)];
  modelOk = present.length > 0;
  modelDetail = modelOk
    ? `已配置 ${[...new Set(present)].join(', ')}${keys.sources[present[0]] ? `（来自 ${keys.sources[present[0]]}）` : ''}`
    : `缺模型 key：${uniq.join(' / ') || '（models.yml 未声明）'}${keys.files.length > 0 ? `（查过 ${keys.files.join(' 与 ')}）` : ''}`;
}
add(
  'model',
  '模型端点',
  'recommended',
  modelOk,
  modelDetail,
  modelOk
    ? undefined
    : [
        '免费额度：注册智谱 GLM（https://open.bigmodel.cn/）拿一个永久免费 key；',
        // 说清楚是给**哪份** config 配 key：daemon 读的是上面那个 modelCfg。
        `按 ${modelCfg} 里每个端点声明的 api_key_env 补 key，写进 ${join(home, 'tokens.env')}：`,
        '  HY3_API_KEY=<你的 key>',
        '  （只配了这一个 key 时，先只跑反射层也能用：点灯/场景词/提醒）',
      ].join('\n'),
);

// ── 5. dotd 是否在跑 / 有没有设备 ──────────────────────────────────

const base = (process.env.DOTD_BASE_URL ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
let health = null;
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
  if (res.ok) health = await res.json();
} catch {
  health = null;
}
add(
  'daemon',
  'dotd 内核',
  'optional',
  health !== null,
  health === null ? `未运行（${base}）` : `apiVersion=${health.apiVersion ?? '?'} kernel=ok`,
  health === null ? 'npm run charlie:start（Charlie 会托管它）或 npm run serve' : undefined,
);

if (health !== null) {
  const token = findToken(cfgPath);
  if (token) {
    let deviceLine = null;
    try {
      const res = await fetch(`${base}/api/devices`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const body = await res.json();
        const n = Array.isArray(body.devices) ? body.devices.length : 0;
        deviceLine = {
          ok: n > 0,
          detail: n > 0 ? `${n} 台已注册` : '还没有设备',
          fix: n > 0 ? undefined : 'dotd device add 客厅小屏（然后把两行环境变量给 Charlie）',
        };
      } else {
        // 401 以前被静默吞掉：这一科**整行消失**，看起来像"没有这一项"。
        // 说清楚是"令牌没通过"，否则人会以为设备检查通过或不存在。
        deviceLine = {
          ok: false,
          detail: `令牌被拒（HTTP ${res.status}）`,
          fix: '确认 config.yml 的 master_token 与 daemon 实际用的令牌一致（这里是展开后的值）',
        };
      }
    } catch {
      deviceLine = { ok: false, detail: `连不上 ${base}`, fix: '确认 daemon 在跑' };
    }
    if (deviceLine !== null) {
      add('device', '语音设备', 'optional', deviceLine.ok, deviceLine.detail, deviceLine.fix);
    }
  } else {
    add(
      'device',
      '语音设备',
      'optional',
      false,
      '没有可用的主人令牌，查不了设备',
      '先修上面的「主人令牌」一项',
    );
  }
}

function findToken(path) {
  try {
    const m = /master_token:\s*"?([^"\n]+)"?/.exec(readFileSync(path, 'utf8'));
    const tok = usableToken(m?.[1]);
    if (tok !== null) return tok;
  } catch {
    /* ignore */
  }
  // 第二来源用同一个分层口径（进程环境 ∪ tokens.env），不另抄一份文件列表 ——
  // 抄两份迟早会漂，而漂掉的那份正是「语音设备」这一科的判据。
  const fromEnv = usableToken(keys.get('DOTD_MASTER_TOKEN'));
  return fromEnv;
}

// ── 输出 ────────────────────────────────────────────────────────────

const requiredFailed = checks.filter((c) => c.level === 'required' && !c.ok);
const ok = requiredFailed.length === 0;

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok, home, checks }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

const mark = (c) => (c.ok ? '✅' : c.level === 'required' ? '❌' : '⚠️ ');
console.log('dotd × Charlie 上手体检\n');
for (const c of checks) {
  console.log(`${mark(c)} ${c.label}: ${c.detail}`);
  if (!c.ok && c.fix) console.log(`   → ${c.fix.split('\n').join('\n     ')}`);
}

console.log('');
if (ok) {
  console.log('必需项已齐。下一步：');
  console.log('  1. npm run charlie:start        # 只启动 Charlie，它会托管 dotd');
  console.log('  2. 打开 http://127.0.0.1:8000/health   # voice + kernel 都应为 ok');
  console.log('  3. 浏览器打开 http://127.0.0.1:8000/console/');
  console.log('  4. 说一句话，或先跑假设备：');
  console.log('     DOTD_MASTER_TOKEN=<master> npm run voice:device -- --create');
} else {
  console.log(`还有 ${requiredFailed.length} 个必需项没过：${requiredFailed.map((c) => c.label).join('、')}`);
  console.log('按上面的 → 逐条补齐后重跑：npm run onboard');
}
process.exit(ok ? 0 : 1);
