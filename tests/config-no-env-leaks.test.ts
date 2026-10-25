/**
 * tests/config-no-env-leaks.test.ts —— 仓库配置里不许出现「部署环境的事实」。
 *
 * 由来（2026-10-25，真实踩过）：`config/models.yml` 的 tier1 base_url 曾写成
 * `http://172.17.48.1:13065/v1` —— 那是 WSL 里某次部署的默认网关地址。原脚本
 * 用 `sed -i` 直接改写仓库文件，一次把文件拷回 Windows 就被提交进 git。后果：
 *   · Windows 原生跑必连不上；换一台机器必连不上；
 *   · 看配置的人不知道这串 IP 从哪来、该改哪；
 *   · 网关 IP 本身会随 WSL 重启漂移（下一台机器是 172.x.y.z 的另一组值）。
 *
 * 现在的规矩：URL 类配置只能写成 `${ENV_VAR:-本机默认值}`，环境差异由部署脚本
 * 导出环境变量（scripts/wsl-daemon.sh 的 DOTD_MODEL_HOST / DOTD_TIER2_HOST）。
 * 本测试守两件事：
 *   1. 原始 YAML 的 URL 值里不含写死的 RFC1918 地址 / WSL relay 端口；
 *   2. 清掉相关环境变量后，端点默认值仍然落在回环地址（即"没有 env 也能本机跑"）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadModelsConfig } from '../src/router/config.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODELS_YML = join(REPO_ROOT, 'config', 'models.yml');

/** RFC1918 私有网段（127/8 不计：本机默认值是被允许的）。 */
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

/** 只看 YAML 的 URL 值行：注释行跳过（注释里必须允许解释历史地址）。 */
const URL_LINE = /^\s*(?:-\s*)?(?:base_url|url|health_url):\s*(.+?)\s*$/;

test('config/models.yml：URL 值里不含写死的私有网段（环境差异只走 ${ENV:-默认}）', () => {
  const offenders: string[] = [];
  const lines = readFileSync(MODELS_YML, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = URL_LINE.exec(line);
    if (m === null) return;
    // 把 `${NAME:-默认值}` 整组去掉：默认值属于仓库可承诺的部分，但它只允许是本机地址。
    const literal = m[1]!.replace(/\$\{[^}]*\}/g, '');
    if (PRIVATE_IP.test(literal) || /\b13065\b/.test(literal)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(
    offenders,
    [],
    '部署环境地址不能写进仓库配置（改用 ${DOTD_MODEL_HOST:-http://127.0.0.1:...}）：\n' + offenders.join('\n'),
  );
});

test('config/models.yml：不设环境变量时，本机端点（tier1 主通道 / tier2）默认落在回环地址', () => {
  const saved = {
    model: process.env.DOTD_MODEL_HOST,
    tier2: process.env.DOTD_TIER2_HOST,
  };
  delete process.env.DOTD_MODEL_HOST;
  delete process.env.DOTD_TIER2_HOST;
  try {
    const cfg = loadModelsConfig(MODELS_YML);
    const ids = ['openrouter-main', 'colibri-olmoe'];
    for (const id of ids) {
      const e = cfg.endpoints.find((x) => x.id === id);
      assert.ok(e !== undefined, `models.yml 缺少端点 ${id}`);
      assert.match(
        e.baseUrl,
        /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//,
        `端点 ${id} 的默认 base_url 应是本机地址（开箱即可本机跑），实际 ${e.baseUrl}`,
      );
    }
  } finally {
    if (saved.model !== undefined) process.env.DOTD_MODEL_HOST = saved.model;
    if (saved.tier2 !== undefined) process.env.DOTD_TIER2_HOST = saved.tier2;
  }
});
