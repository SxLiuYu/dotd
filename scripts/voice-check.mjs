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
 *   6. 接缝：config/mcp-servers.voice.yml 是否存在。
 *
 * 退出码：0 = 必需项全过；1 = 有必需项失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  ['config/mcp-servers.voice.yml', 'MCP 声明示例'],
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
