/**
 * tests/scripts-config-dir.test.ts —— 「daemon 读哪份配置」只有一份判据，且它必须和实现一致。
 *
 * 现场（2026-10-26，同类缺陷第七例的潜伏形态）：
 *
 *   scripts/verify-goal.sh 数 `config/tools.yml` 的白名单条数
 *   daemon 读                `<configDir>/tools.yml`
 *
 * live 上两份内容当时**恰好一样**（实测 models/tools/rules/mcp-servers/free-models/
 * event-rules 全部 SAME），所以这条判据绿着。但它绿的原因是"有人手同步了两份文件"，
 * 不是"看对了地方" —— 只要有人改运行期那份（换工具白名单、加规则），
 * verify-goal 就会继续拿仓库副本打分。
 *
 * 修法：把判据抽成 `scripts/lib/config-dir.sh`（bash 侧），与
 * `scripts/lib/env.mjs::resolveConfigDir`（Node 侧）**逐条对齐**。
 * 这个测试就是对齐的证明 —— 两边对同一组环境必须给出同一个答案。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfigDir } from '../scripts/lib/env.mjs';

const REPO = join(import.meta.dirname, '..');
const LIB = join(REPO, 'scripts', 'lib', 'config-dir.sh');

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
const bashOk = BASH.status === 0;

const sh = (p: string) => p.replace(/\\/g, '/');

/** 一个临时世界：home 下可选地存在 `<home>/.dotd/models.yml`。 */
function world(opts: { hosted?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotd-cfgdir-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.dotd'), { recursive: true });
  mkdirSync(join(root, 'repo', 'config'), { recursive: true });
  mkdirSync(join(root, 'repo', 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(root, 'repo', 'scripts', 'lib', 'config-dir.sh'), readFileSync(LIB, 'utf8'), 'utf8');
  if (opts.hosted) writeFileSync(join(home, '.dotd', 'models.yml'), 'endpoints: []\n', 'utf8');
  return { root, home, repo: join(root, 'repo'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** bash 侧：source 库，打印 dotd_config_dir()。 */
function bashDir(w: ReturnType<typeof world>, env: Record<string, string>) {
  const script = `cd ${sh(JSON.stringify(w.repo))}\n. scripts/lib/config-dir.sh\ndotd_config_dir\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
      HOME: w.home,
      DOTD_HOME: '',
      DOTD_CONFIG_DIR: '',
      DOTD_CONFIG: '',
      ...env,
    },
  });
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Git Bash 输出的是 MSYS 形态（`/c/Users/...`），Node 给的是 Windows 形态。
 * 两边要比较就得先归一到同一形态 —— 用 cygpath -m（没有 cygpath 就是 Linux，原样返回）。
 * 不归一的话这条测试会永远红，而红的原因跟被测代码无关（又一个"测试自己找错地方"）。
 */
function canonical(p: string): string {
  const r = spawnSync('bash', ['-c', 'command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || printf %s "$1"', 'x', p], {
    encoding: 'utf8',
  });
  const out = (r.stdout ?? '').trim();
  return norm(out.length > 0 ? out : p);
}

describe('① bash 侧与 Node 侧对同一环境给同一个答案', { skip: !bashOk }, () => {
  // 环境里出现的路径一律从 w.root 派生（Windows 形态），否则 `/tmp/x` 这种
  // POSIX 字面量在 Windows 上两边解释不同 —— 那是测试的失真，不是判据的问题。
  const cases: Array<{ name: string; hosted?: boolean; env: (w: ReturnType<typeof world>) => Record<string, string> }> = [
    { name: '两者都没设 + 有托管记号 → ~/.dotd', hosted: true, env: () => ({}) },
    { name: '两者都没设 + 无托管记号 → 仓库 config', hosted: false, env: () => ({}) },
    {
      name: 'DOTD_CONFIG_DIR 最优先',
      hosted: true,
      env: (w) => ({ DOTD_CONFIG_DIR: join(w.root, 'some-cfg') }),
    },
    {
      name: 'DOTD_CONFIG 取所在目录',
      hosted: false,
      env: (w) => ({ DOTD_CONFIG: join(w.root, 'other', 'dotd.yml') }),
    },
    {
      name: 'DOTD_HOME 决定托管目录',
      hosted: false,
      env: (w) => ({ DOTD_HOME: join(w.root, 'dotd-data') }),
    },
    {
      name: 'DOTD_CONFIG_DIR 压过 DOTD_CONFIG',
      hosted: false,
      env: (w) => ({ DOTD_CONFIG_DIR: join(w.root, 'a'), DOTD_CONFIG: join(w.root, 'b', 'c.yml') }),
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const w = world({ hosted: c.hosted });
      try {
        const env = c.env(w);
        const r = bashDir(w, env);
        assert.equal(r.status, 0, r.stderr);
        const bash = canonical(r.stdout.trim());
        const node = canonical(
          resolveConfigDir({
            env: { ...env },
            repoRoot: w.repo,
            home: w.home,
            // 只有 <home>/.dotd/models.yml 真的存在才算托管记号（DOTD_HOME 指向的
            // 临时目录不存在 → 不是托管）。
            exists: (p: string) => c.hosted === true && p === join(w.home, '.dotd', 'models.yml'),
          }),
        );
        assert.equal(bash, node, `bash 与 Node 判据不一致（${c.name}）`);
      } finally {
        w.cleanup();
      }
    });
  }

  test('~ 展开：DOTD_CONFIG_DIR=~/.dotd 不当作字面量', () => {
    const w = world({ hosted: false });
    try {
      const r = bashDir(w, { DOTD_CONFIG_DIR: '~/.dotd' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(canonical(r.stdout.trim()), canonical(join(w.home, '.dotd')));
    } finally {
      w.cleanup();
    }
  });
});

describe('② 调用方都走这份判据（不许再写死仓库 config/）', { skip: !bashOk }, () => {
  test('verify-goal.sh 数的是 daemon 真读的那份 tools.yml', () => {
    const text = readFileSync(join(REPO, 'scripts', 'verify-goal.sh'), 'utf8');
    assert.match(text, /lib\/config-dir\.sh/, '必须共用判据');
    assert.match(text, /dotd_config_file tools\.yml/, '要按判据取路径');
    assert.doesNotMatch(
      text,
      /readFileSync\(\s*["']config\/tools\.yml["']/,
      '不许再直接读仓库副本：daemon 读的是 <configDir>/tools.yml（第七例）',
    );
  });

  test('model-switch.sh 的「运行期」也来自同一判据', () => {
    const text = readFileSync(join(REPO, 'scripts', 'lib', 'model-switch.sh'), 'utf8');
    assert.match(text, /lib\/config-dir\.sh/);
    assert.match(text, /dotd_config_file models\.yml/);
  });
});
