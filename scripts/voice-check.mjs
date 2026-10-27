#!/usr/bin/env node
/**
 * scripts/voice-check.mjs —— 合并后的语音端体检（2026-10-23）。
 *
 * 回答一个问题：**这台机器现在能不能把 Charlie 接上 dotd？**
 * 只检查，不安装、不拉镜像、不写配置——缺什么就明说下一步。
 *
 * 检查项：
 *   1. 目录：voice/charlie 与 voice/integration 在不在；
 *   2. Python 3.11+；
 *   3. Python 依赖：mcp / requests（Charlie 的 requirements-core 必需项）；
 *   4. ffmpeg（ASR/TTS 音频链路；没有就明确降级为文本）；
 *   5. dotd：DOTD_BASE_URL + DOTD_TOKEN 都在时，探一次 /api/health；
 *   6. 接缝：`config/mcp-servers.voice.yml` 存在，**而且照着它配能起来**
 *      （解析 + command/args 可解析；只判存在会漏掉"示例本身是坏的"）。
 *   7. 家居：设备清单在不在、登记了几台、每台的适配器缺哪个凭证
 *      （2026-10-26 加：合并后家居控制三层全断，而体检一路 ✅ —— 因为没有一项
 *      问过"灯到底能不能开"）。
 *
 * 退出码：0 = 必需项全过；1 = 有必需项失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMcpServers } from './doctor.mjs';
import { inspectMcpServers } from './lib/mcp-example.mjs';
import { resolvePython, pythonAtLeast } from './lib/python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const rows = [];
function add(name, status, detail, next = '') {
  rows.push({ name, status, detail, next });
}

// 1. 目录
const need = [
  ['voice/charlie/voice_server.py', 'Charlie 主服务'],
  ['voice/charlie/magic-scenes.py', '场景 MCP server'],
  ['voice/integration/dotd_bridge.py', 'Charlie → dotd 桥'],
  ['voice/integration/one_system.py', '一套系统壳（托管/健康/控制台）'],
  ['voice/integration/dotd_memory.py', '记忆源桥（dotd 是唯一事实源）'],
  ['voice/integration/push_gate.py', '主动推送决策桥（dotd 决定该不该说）'],
];
for (const [rel, label] of need) {
  const ok = existsSync(join(REPO, rel));
  add(label, ok ? 'ok' : 'fail', rel, ok ? '' : '重新 clone/checkout 仓库，或确认合并时没有漏文件');
}

// 2/3. Python
//
// `python` 在 Debian/Ubuntu/WSL 上**默认不存在**（只有 `python3`）。原来这里写死
// `'python'`，于是 live 上报了两条红：Python 找不到 → `--check` 跑不起来 →
// 被归因成"缺 token"。而同一台机器上 one_system 正由 .venv 的 python 正常服务。
// 解析顺序见 scripts/lib/python.mjs 的文件头（显式指定 → .venv → python3 → python）。
const pyResolved = resolvePython({ repoRoot: REPO, run: (bin, args) => spawnSync(bin, args, { encoding: 'utf8' }) });
const py = pyResolved?.bin ?? (process.env.DOTD_PYTHON ?? 'python3');
const ver = { status: pyResolved ? 0 : 1, stdout: pyResolved?.out ?? '', stderr: '' };
if (ver.status !== 0) {
  add(
    'Python ≥ 3.10',
    'fail',
    '找不到可用的 Python 解释器',
    '装 Python 3.10+（apt install python3），或设 DOTD_PYTHON 指向解释器',
  );
} else {
  const text = `${ver.stdout}${ver.stderr}`.trim();
  if (!pythonAtLeast(text, 3, 10)) {
    add('Python ≥ 3.10', 'fail', `${text}（太旧）`, '升级到 3.10+；.venv 里的解释器优先，可用 DOTD_PYTHON 指定');
  } else {
    add('Python ≥ 3.10', 'ok', `${text}（用 ${py}）`);
    const mods = spawnSync(py, ['-c', 'import mcp, requests'], { encoding: 'utf8' });
    add(
      'Python 依赖（mcp / requests）',
      mods.status === 0 ? 'ok' : 'fail',
      mods.status === 0 ? '已安装' : (mods.stderr || '').split('\n')[0],
      mods.status === 0 ? '' : `"${py}" -m pip install -r voice/charlie/requirements-core.txt`,
    );
  }
}

// 3b. 记忆与主动推送的归属（阶段 5）
add(
  '记忆源 / 推送决策归属',
  'ok',
  `memory=${(process.env.CHARLIE_MEMORY_SYNC ?? 'on')} push=${(process.env.CHARLIE_PUSH_DECIDER ?? 'dotd')}`,
  '默认都是 dotd；设 CHARLIE_MEMORY_SYNC=off / CHARLIE_PUSH_DECIDER=local 可退回本地',
);

// 3c. MCP 声明示例：不只是"文件在"，而是**照着它配能起来**
//
// 2026-10-26 之前这里只 `existsSync` —— 于是示例里写着 `command: python`
// （Debian/Ubuntu/WSL 上没有这个命令）、`allow_tools` 用块列表（旧解析器读成
// "某个 server 缺 name"，daemon 直接拒启动）时，体检一路 ✅。
// 现在把示例当成真配置解析一遍，并把 command/args 按 daemon 的口径核对。
const examplePath = join(REPO, 'config', 'mcp-servers.voice.yml');
if (!existsSync(examplePath)) {
  add(
    'MCP 声明示例可解析',
    'fail',
    examplePath,
    '重新 clone/checkout 仓库，或确认合并时没有漏文件',
  );
} else {
  const parsed = parseMcpServers(readFileSync(examplePath, 'utf8'));
  if (parsed.error !== null) {
    add(
      'MCP 声明示例可解析',
      'fail',
      `config/mcp-servers.voice.yml：${parsed.error}`,
      '这份示例是文档教人 cp 过去启用的；它解析不了 = 照文档做会让 daemon 拒启动',
    );
  } else {
    const broken = inspectMcpServers(parsed.servers, { repoRoot: REPO });
    add(
      'MCP 声明示例可解析',
      broken.length === 0 ? 'ok' : 'fail',
      broken.length === 0
        ? `${parsed.servers.length} 个 server（${parsed.servers.map((s) => s.name).join(', ')}）`
        : broken.join('; '),
      broken.length === 0 ? '' : '改 config/mcp-servers.voice.yml（它同时是文档里的启用模板）',
    );
  }
}

// 3d. 家居控制：清单 + 凭证
//
// 2026-10-26 的现场：合并后家居控制三层全断（`ac-control` 没有文件、`direct_ac_control`
// 没有调用点、MQTT 模块没登记），而语音体检一路 ✅ —— 因为**没有一项问"灯到底能不能开"**。
// 这里补上：清单在不在、登记了几台、每台的适配器缺哪个凭证。
// 缺清单不算 fail（没设备的机器也该能起），但会说清楚"说了开灯也只会交给模型"。
const homeProbe = pyResolved
  ? spawnSync(
      py,
      [
        '-c',
        [
          'import json, os, sys',
          'sys.path.insert(0, os.getcwd())',
          'from voice.integration.home_devices import load_devices, default_manifest_path',
          'devs = load_devices()',
          'out = {"path": default_manifest_path(), "exists": os.path.isfile(default_manifest_path())}',
          'out["devices"] = [{"name": d.name, "adapter": d.adapter, "kind": d.kind} for d in devs]',
          'print(json.dumps(out, ensure_ascii=False))',
        ].join('; '),
      ],
      { cwd: REPO, encoding: 'utf8', env: { ...process.env } },
    )
  : { status: 127, stdout: '', stderr: '没有可用的 Python 解释器（见上一条）' };
{
  let info = null;
  try {
    info = JSON.parse(homeProbe.stdout);
  } catch {
    info = null;
  }
  if (info === null) {
    add(
      '家居设备清单',
      'skip',
      (homeProbe.stderr || '').trim().split('\n').slice(-1)[0] || '读取失败',
      '缺 PyYAML 时清单读不了：pip install -r voice/requirements-integration.txt',
    );
  } else if (info.devices.length === 0) {
    add(
      '家居设备清单',
      'skip',
      `没有登记设备（${info.path}）`,
      '照 config/home-devices.yml 写一份，或设 TUYA_IR_DEVICE_ID + TUYA_AC_DEVICE_ID 兜底空调',
    );
  } else {
    const byAdapter = {};
    for (const d of info.devices) byAdapter[d.adapter] = (byAdapter[d.adapter] ?? 0) + 1;
    const summary = Object.entries(byAdapter).map(([a, n]) => `${a}×${n}`).join(' ');
    // 凭证只看"配没配"，不打印值
    const needEnv = {
      tuya_ir: ['TUYA_CLIENT_ID', 'TUYA_ACCESS_KEY'],
      tuya_cloud: ['TUYA_API_KEY'],
      mqtt: ['MQTT_BROKER'],
      esp32: [],
    };
    const missing = [];
    for (const a of Object.keys(byAdapter)) {
      for (const k of needEnv[a] ?? []) {
        if (!(process.env[k] ?? '').trim()) missing.push(k);
      }
    }
    add(
      '家居设备清单',
      missing.length === 0 ? 'ok' : 'fail',
      `${info.devices.length} 台（${summary}）` +
        (missing.length === 0 ? '' : `；缺 ${[...new Set(missing)].join(' / ')}`),
      missing.length === 0
        ? ''
        : '把这些凭证写进 ~/.dotd/tokens.env；DP 码与 topic 见 docs/home-control.md',
    );
  }
}

// 4. ffmpeg（可选）
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
add(
  'ffmpeg（可选）',
  ff.status === 0 ? 'ok' : 'skip',
  ff.status === 0 ? (ff.stdout || '').split('\n')[0] : '没装：语音链路不可用，文本桥仍可用',
  ff.status === 0 ? '' : '装 ffmpeg 后再回来，或先用 --json 文本模式',
);

// 4b. 一套壳的配置/令牌/控制台
const check = pyResolved
  ? spawnSync(py, ['-m', 'voice.integration.one_system', '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env },
    })
  : { status: 127, stdout: '', stderr: '没有可用的 Python 解释器（见上一条）' };
if (check.status === 0) {
  try {
    const info = JSON.parse(check.stdout);
    add('一套系统配置', 'ok', `home=${info.home} token=set port=${info.dotdPort}`);
    add(
      'dotd 控制台产物',
      info.consoleBuilt ? 'ok' : 'skip',
      info.consoleBuilt ? 'web-ui/dist/index.html' : '未构建：npm run build:web',
    );
    // 8443：手机浏览器只在 HTTPS 下给麦克风权限，这条不通 = 手机上不能说话。
    // `--check` 只报"会不会起"，这里补一句"证书在不在"——证书是首启自动生成的，
    // 缺失通常意味着上一次启动根本没走到 sidecar。
    add(
      '8443 HTTPS（手机麦克风前置）',
      info.httpsEnabled && info.httpsCert ? 'ok' : 'skip',
      info.httpsEnabled
        ? `port=${info.httpsPort} cert=${info.httpsCert ? '已生成' : '未生成（首次启动会生成）'}`
        : '已关闭（CHARLIE_HTTPS=0）',
      info.httpsEnabled && !info.httpsCert
        ? '首次 `npm run charlie:start` 会自动生成自签证书到 <home>/voice/cert/'
        : '',
    );
    // 「能不能听」。`/health` 的 voice:"ok" 是硬编码的，缺模型/缺 key 时也 ok
    // （2026-10-25 因此把"设备是聋的"报成了全绿），所以这里单独问一次。
    const asr = info.asr ?? { mode: 'unknown', ok: null };
    add(
      '语音识别（能不能听）',
      asr.mode === 'local' || asr.mode === 'cloud' ? 'ok' : asr.mode === 'disabled' ? 'skip' : 'fail',
      asr.mode === 'local'
        ? `本地 SenseVoice：${asr.model}`
        : asr.mode === 'cloud'
          ? `云端 ASR：${(asr.cloud ?? []).join(', ')}`
          : asr.mode === 'disabled'
            ? '已禁用（SENSE_VOICE_DISABLED=1）'
            : '既没有本地模型也没有云端 key —— 设备会"听不见"',
      asr.mode === 'none' || asr.mode === 'unknown'
        ? `"${py}" -m voice.integration.asr_model voice/charlie/models/sense-voice（Docker 会自动下）`
        : '',
    );
  } catch {
    add('一套系统配置', 'fail', '--check 输出不是 JSON', '检查 voice/integration/one_system.py');
  }
} else {
  add(
    '一套系统配置',
    'fail',
    (check.stdout || check.stderr || '').trim().split('\n').slice(-1)[0] || '--check 失败',
    // 这条 next 之前无条件写"设置 DOTD_MASTER_TOKEN" —— 而 127/导入失败时也这么提示，
    // 等于把工具自己的问题说成用户的配置问题（2026-10-26 现场就发生过一次）。
    pyResolved
      ? '设置 DOTD_MASTER_TOKEN，或把 tokens.env / config.yml 放到 ~/.dotd 或 ~/.charlie'
      : '先解决上面的 Python 解释器问题再跑本项',
  );
}

// 5. dotd 探活（可选）
const base = (process.env.DOTD_BASE_URL ?? '').replace(/\/+$/, '');
const token = process.env.DOTD_TOKEN ?? '';
if (base && token) {
  try {
    const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } });
    add('dotd /api/health', res.ok ? 'ok' : 'fail', `${res.status} ${base}`);
  } catch (e) {
    add('dotd /api/health', 'fail', String(e), '确认 daemon 已启动，且 DOTD_BASE_URL 正确');
  }
} else {
  add('dotd /api/health（可选）', 'skip', '未设 DOTD_BASE_URL / DOTD_TOKEN', '要体检真 daemon 就设这两个变量');
}

// 输出
const icon = { ok: '✅', fail: '❌', skip: '⏭' };
for (const r of rows) {
  console.log(`${icon[r.status]} ${r.name} — ${r.detail}`);
  if (r.next) console.log(`     next: ${r.next}`);
}
const failed = rows.filter((r) => r.status === 'fail');
console.log('');
console.log(failed.length === 0 ? '语音端必需项全部通过。' : `${failed.length} 项失败。`);
process.exit(failed.length === 0 ? 0 : 1);
