/**
 * tests/scripts-python-resolve.test.ts —— 「找不到 python」不该是机器的错。
 *
 * 现场（2026-10-26，live 机 `node scripts/voice-check.mjs`）：
 *
 *     ❌ Python — 找不到 python
 *     ❌ 一套系统配置 — --check 失败
 *          next: 设置 DOTD_MASTER_TOKEN，或把 tokens.env / config.yml 放到 ~/.dotd
 *
 * 而同一台机器上 one_system **正在正常服务**（8000/8443/7788 全 200，ASR=local）。
 * 两条红都是假的：
 *
 *   1. Debian/Ubuntu/WSL 只装 `python3`，`python` 默认不存在。脚本写死 `'python'`；
 *   2. 第二条是连锁：解释器都找不到，`--check` 当然跑不起来，而 next 文案把
 *      **工具自己的 bug** 说成「你缺 token」。
 *
 * 同一件事还有一个更隐蔽的版本：仓库在 `/mnt/d/dotd` 时，Windows 建的
 * `.venv/Scripts/python.exe` 在 Linux 侧**也看得见**（DrvFs）。第一版解析器
 * "先看 Scripts 再看 bin"，于是在 WSL 里跑起了 Windows 的 python.exe ——
 * 输出 `Python 3.11.9`、`home=C:\Users\1\.dotd`。**能跑，但查的是另一台机器。**
 * 这种"绿得毫无意义"比红更危险，所以两个坑都要钉住。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  majorMinor,
  pythonAtLeast,
  pythonCandidates,
  resolvePython,
  venvPython,
} from '../scripts/lib/python.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 构造一个"只有这些路径存在"的世界。 */
const worldOf = (paths: string[]) => (p: string) => paths.includes(p);

describe('① venvPython：只认当前平台的布局', () => {
  const win = resolve(REPO, '.venv', 'Scripts', 'python.exe');
  const posix = resolve(REPO, '.venv', 'bin', 'python');

  test('Windows 上用 Scripts/python.exe', () => {
    assert.equal(venvPython(REPO, { exists: worldOf([win, posix]), platform: 'win32' }), win);
  });

  test('POSIX 上用 bin/python', () => {
    assert.equal(venvPython(REPO, { exists: worldOf([win, posix]), platform: 'linux' }), posix);
  });

  test('POSIX 上只有 Windows venv → 返回 null（不跨平台借用）', () => {
    assert.equal(
      venvPython(REPO, { exists: worldOf([win]), platform: 'linux' }),
      null,
      '/mnt 下能看见 Scripts/python.exe，但那是另一台机器的解释器',
    );
  });

  test('Windows 上只有 POSIX venv → 同样 null', () => {
    assert.equal(venvPython(REPO, { exists: worldOf([posix]), platform: 'win32' }), null);
  });

  test('都没有 → null', () => {
    assert.equal(venvPython(REPO, { exists: worldOf([]), platform: 'linux' }), null);
  });
});

describe('② pythonCandidates：顺序就是判据', () => {
  test('没设 DOTD_PYTHON → .venv 在最前，然后 python3，最后 python', () => {
    const posixVenv = resolve(REPO, '.venv', 'bin', 'python');
    const c = pythonCandidates({
      env: {},
      repoRoot: REPO,
      exists: worldOf([posixVenv]),
      platform: 'linux',
    });
    assert.equal(c[0], posixVenv);
    assert.deepEqual(c.slice(1), ['python3', 'python'], 'python3 必须在 python 之前');
  });

  test('没有 .venv → 直接 python3 → python（Debian 只有前者）', () => {
    const c = pythonCandidates({ env: {}, repoRoot: REPO, exists: worldOf([]) });
    assert.deepEqual(c, ['python3', 'python']);
  });

  test('显式 DOTD_PYTHON 时**只用它**（不允许被后面的候选顶替）', () => {
    const c = pythonCandidates({
      env: { DOTD_PYTHON: '/opt/py312/bin/python' },
      repoRoot: REPO,
      exists: worldOf([resolve(REPO, '.venv', 'bin', 'python')]),
    });
    assert.deepEqual(c, ['/opt/py312/bin/python'], '"我指定了却跑了别的"是最难查的一类');
  });

  test('DOTD_PYTHON 是空白 → 当成没设', () => {
    assert.deepEqual(
      pythonCandidates({ env: { DOTD_PYTHON: '   ' }, repoRoot: REPO, exists: worldOf([]) }),
      ['python3', 'python'],
    );
  });
});

describe('③ resolvePython：取第一个真能跑的', () => {
  test('python 不存在、python3 存在 → 选中 python3', () => {
    const calls: string[] = [];
    const got = resolvePython({
      env: {},
      repoRoot: REPO,
      exists: worldOf([]),
      run: (bin) => {
        calls.push(bin);
        return bin === 'python3' ? { status: 0, stdout: 'Python 3.12.3\n', stderr: '' } : { status: 127 };
      },
    });
    assert.equal(got?.bin, 'python3');
    assert.match(got?.out ?? '', /3\.12\.3/);
    assert.deepEqual(calls, ['python3'], '找到就不该再试后面的');
  });

  test('一个都跑不起来 → null（不抛异常，体检脚本不能崩）', () => {
    const got = resolvePython({ env: {}, repoRoot: REPO, exists: worldOf([]), run: () => ({ status: 127 }) });
    assert.equal(got, null);
  });

  test('--version 写在 stderr 也能读到（老版本 python 的行为）', () => {
    const got = resolvePython({
      env: {},
      repoRoot: REPO,
      exists: worldOf([]),
      run: () => ({ status: 0, stdout: '', stderr: 'Python 3.10.12\n' }),
    });
    assert.match(got?.out ?? '', /3\.10\.12/);
  });
});

describe('④ 版本比较', () => {
  test('majorMinor 容错', () => {
    assert.deepEqual(majorMinor('Python 3.12.3'), [3, 12]);
    assert.deepEqual(majorMinor('3.9'), [3, 9]);
    assert.equal(majorMinor('nope'), null);
    assert.equal(majorMinor(undefined), null);
  });

  test('pythonAtLeast 的边界', () => {
    assert.equal(pythonAtLeast('Python 3.10.0'), true, '3.10 是门槛本身，要放行');
    assert.equal(pythonAtLeast('Python 3.9.18'), false);
    assert.equal(pythonAtLeast('Python 3.13.0'), true);
    assert.equal(pythonAtLeast('Python 4.0.0'), true);
    assert.equal(pythonAtLeast('garbage'), false);
  });
});

// ── ⑤ npm 入口：`charlie:start` 那条命令本身必须能跑 ────────────────────
//
// 这是同一件事的最后一层，也是最要命的一层：前四节修的是"体检脚本找错了
// 解释器"，而 `package.json` 里 `charlie:start/check/voice:bridge` 写死了
// `python …`，在 Debian/WSL 上**必然** `sh: 1: python: not found`。
// 更糟的是 onboard 把 `npm run charlie:start` 当作"下一步"教给用户 ——
// 新手的第一条命令就失败，然后他会怀疑自己的安装。
//
// 这里用 `DOTD_PYTHON=<node 自己>` 来跑：node 与 python 的共同子集是 `-e`，
// 于是不用伪造解释器也能验证"参数原样传递 + 退出码原样返回"。

function runPy(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts', 'py.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, DOTD_PYTHON: process.execPath, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('⑤ scripts/py.mjs：npm 入口用解析出来的解释器', () => {
  test('参数原样传给解释器', () => {
    const r = runPy(['-e', 'console.log("PY-RAN")']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PY-RAN/);
  });

  test('退出码原样返回（CI 靠它判断成败）', () => {
    assert.equal(runPy(['-e', 'process.exit(7)']).status, 7);
  });

  test('不给参数 → 2 + 用法（不要在没命令时把解释器拉起来）', () => {
    const r = runPy([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /用法/);
  });

  test('DOTD_PYTHON 指向不存在的东西 → 127 + 说清试过哪些', () => {
    const r = runPy(['-e', '0'], { DOTD_PYTHON: resolve(REPO, 'no-such-python') });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /DOTD_PYTHON/);
    assert.match(r.stderr, /python3/, '要列出候选，人才知道下一步该装什么');
  });

  test('package.json 里没有裸 `python` 命令（否则 Debian 上必挂）', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      // 允许 `python3`、`scripts/py.mjs`；不允许命令位置上是裸 `python`。
      assert.doesNotMatch(
        cmd,
        /(^|[\s;&|(])python(\s|$)/,
        `npm script "${name}" 用了裸 python：${cmd}`,
      );
    }
    for (const name of ['charlie:start', 'charlie:check', 'voice:bridge']) {
      assert.match(pkg.scripts[name] ?? '', /scripts\/py\.mjs/, `${name} 必须走 py.mjs`);
    }
  });
});
