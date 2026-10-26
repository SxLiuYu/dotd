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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfigDir } from '../scripts/lib/env.mjs';
import { resolveConfigFile as resolveConfigFileScript } from '../scripts/lib/env.mjs';
import { resolveConfigFile as resolveConfigFileDaemon } from '../src/surfaces/config.ts';

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
 * Windows 路径 → WSL 路径（`D:\dotd` → `/mnt/d/dotd`）。
 *
 * 只有走 `wsl.exe` 跑 Python 时才需要。转错的代价是"在 WSL 里找不到仓库"，
 * 那会表现为 `NO_PYTHON:*`，而上一版正是把这种失败当成了测试通过。
 */
function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
  if (m === null) return norm(p);
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

/**
 * 跑 Python 的方式。本机 `python3` 是 Windows 应用商店的转发器（status 9009、
 * 无输出），所以优先尝试 WSL 里的真解释器 —— 仓库就在同一个 `/mnt/d/...` 下。
 *
 * 两个实测坑：
 * - `wsl.exe … -- python3 -c '代码'` 会经中间那层 bash，引号被吃掉，
 *   报 `syntax error near unexpected token '('`；`--exec` 是直接 exec，不经过 shell。
 * - 判据是"能 `import voice.integration.one_system`"，不是"能 `print(1)`"：
 *   后者只证明有解释器，不证明它找得到仓库（上一版因此静默跳过）。
 */
const PY_CMD: string[] | null = (() => {
  const probe = (cmd: string[]): boolean => {
    const wsl = cmd[0] === 'wsl.exe';
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), '-c', 'import voice.integration.one_system as m; print(m.DEFAULT_HTTP_PORT)'], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
        ...(wsl ? { PYTHONPATH: toWslPath(REPO) } : {}),
      },
    });
    return r.status === 0 && (r.stdout ?? '').trim() === '7788';
  };
  const cands: string[][] = [[process.env['PYTHON'] ?? 'python3']];
  if (process.platform === 'win32') {
    cands.push(['wsl.exe', '-d', 'Ubuntu-24.04', '--exec', 'python3']);
    cands.push(['wsl.exe', '-d', 'Ubuntu-24.04', '--', 'python3']);
  }
  for (const c of cands) if (probe(c)) return c;
  return null;
})();

/** 把一段 Python 代码交给上面的解释器跑；返回 stdout 或 `NO_PYTHON:<原因>`。 */
function runPy(code: string): string {
  if (PY_CMD === null) return 'NO_PYTHON:本机与 WSL 都没有能导入本仓库的 python3';
  const wsl = PY_CMD[0] === 'wsl.exe';
  const r = spawnSync(PY_CMD[0]!, [...PY_CMD.slice(1), '-c', code], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
      // `-c` 的 sys.path[0] 是 cwd，但 wsl.exe 把 Windows cwd 翻成什么路径
      // 不值得赌；直接给 PYTHONPATH，导入失败就一定是代码问题而不是找路问题。
      ...(wsl ? { PYTHONPATH: toWslPath(REPO) } : {}),
    },
  });
  // 失败要把原因带回调用方 —— 上一版只返回 'NO_PYTHON'，测试就 `continue` 了，
  // 于是"Python 跑不起来"被当成"这条测试通过"（同类缺陷）。
  if (r.error !== undefined) return `NO_PYTHON:${r.error.message}`;
  if (r.status !== 0) return `NO_PYTHON:status=${r.status} ${(r.stderr ?? '').trim()}`;
  return (r.stdout ?? '').trim();
}

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

describe('③ 「监听端口」也只有一个判据：环境变量 > 配置 > 7788', { skip: !bashOk }, () => {
  // 现场（2026-10-26，同类缺陷第十四例）：
  //
  //   DOTD_HTTP_PORT=7799 node src/daemon.ts     ← 实测仍监听 7788（daemon 不读它）
  //   one_system.resolve_http_port()             ← 却说 7799，反代发往 7799
  //   scripts/soak.sh                            ← 也按 7799 探活
  //
  // 结果：8000 上的 /api 全 502，而三处各自的日志都正常。修的是 daemon 侧，
  // 让它也认这个变量；这个测试钉住"两侧对同一组输入给同一个答案"。

  /** 真跑 daemon 侧的解析（不 mock），拿最终 port。 */
  function daemonPort(env: Record<string, string>, cfgPort = 7788): string {
    const dir = mkdtempSync(join(tmpdir(), 'dotd-port-'));
    try {
      writeFileSync(
        join(dir, 'config.yml'),
        [
          'version: 1',
          'surfaces:',
          '  http:',
          '    host: 127.0.0.1',
          `    port: ${cfgPort}`,
          '    master_token: "t"',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(dir, 'probe.mjs'),
        [
          `import { loadSurfacesConfig } from ${JSON.stringify(pathToFileURL(join(REPO, 'src', 'surfaces', 'config.ts')).href)};`,
          'try { process.stdout.write(String(loadSurfacesConfig(process.argv[2]).http.port)); }',
          'catch (e) { process.stdout.write("THROWN:" + e.message); }',
        ].join('\n'),
        'utf8',
      );
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, 'probe.mjs'), join(dir, 'config.yml')], {
        encoding: 'utf8',
        cwd: REPO,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
          ...env,
        },
      });
      if (r.error !== undefined) return 'NO_BASH';
      return (r.stdout ?? '').trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 真跑 one_system 侧的解析。 */
  function supervisorPort(env: Record<string, string>, cfgPort = 7788): string {
    const dir = mkdtempSync(join(tmpdir(), 'dotd-port-py-'));
    try {
      writeFileSync(
        join(dir, 'config.yml'),
        ['version: 1', 'surfaces:', '  http:', `    port: ${cfgPort}`, '    master_token: "t"', ''].join('\n'),
        'utf8',
      );
      // WSL 里跑时临时目录要换成它认得的路径（`C:/…` → `/mnt/c/…`）。
      // 不转的话 `resolve_paths` 会在 WSL 里去找一个不存在的 `C:/…`，
      // 于是一定 return 7788 —— 测试就变成"恒等"，测不出任何东西。
      const wsl = PY_CMD !== null && PY_CMD[0] === 'wsl.exe';
      const pyDir = wsl ? toWslPath(dir) : dir;
      // 变量**当字面量传进脚本**，不靠进程环境：
      // `wsl.exe` 不会把 Windows 侧的环境变量转进去，除非 key 列在 `WSLENV` 里
      // （实测：不列 → Python 读到的 `DOTD_HTTP_PORT` 是 None）。
      // 靠环境传就会得到"设了 7799、被测函数看见 None"，测试自己造了个假前提。
      const envLit = `{${Object.entries(env).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
      return runPy([
        'from voice.integration.one_system import resolve_paths, resolve_http_port',
        `paths = resolve_paths({"CHARLIE_HOME": ${JSON.stringify(pyDir)}})`,
        `try: print(resolve_http_port(paths, ${envLit}))`,
        'except Exception as e: print("THROWN:" + str(e))',
      ].join('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }


  /** 两侧对同一组输入必须给同一个答案。 */
  test('两侧对同一组输入必须给同一个答案', { skip: PY_CMD === null ? '本机与 WSL 都没有能导入本仓库的 python3' : false }, () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 7788], // 都没设 → 配置的端口
      [{ DOTD_HTTP_PORT: '7799' }, 7788], // 只设环境变量 → 两侧都该是 7799
      [{ DOTD_HTTP_PORT: '9001' }, 8123], // 环境变量压过配置
    ];
    for (const [env, cfgPort] of cases) {
      const d = daemonPort(env, cfgPort);
      const s = supervisorPort(env, cfgPort);
      // 前置条件已经证明两个运行时都能跑，所以这里的失败**不许**被跳过：
      // 那就是被测代码/测试自己不干活。
      assert.doesNotMatch(d, /^NO_/, `daemon 侧没跑起来：${d}`);
      assert.doesNotMatch(s, /^NO_/, `supervisor 侧没跑起来：${s}`);
      assert.equal(d, s, `daemon(${d}) 与 supervisor(${s}) 对 ${JSON.stringify(env)} 判得不一样`);
    }
  });

  test('环境变量非法时两侧都拒绝启动（不静默回落到 7788）', { skip: PY_CMD === null ? '本机与 WSL 都没有能导入本仓库的 python3' : false }, () => {
    for (const bad of ['abc', '0', '70000']) {
      const d = daemonPort({ DOTD_HTTP_PORT: bad });
      const s = supervisorPort({ DOTD_HTTP_PORT: bad });
      assert.doesNotMatch(d, /^NO_/, `daemon 侧没跑起来（${bad}）：${d}`);
      assert.doesNotMatch(s, /^NO_/, `supervisor 侧没跑起来（${bad}）：${s}`);
      assert.match(d, /THROWN:.*DOTD_HTTP_PORT/, `daemon 侧对 ${bad} 没有拒绝：${d}`);
      assert.match(s, /THROWN:.*DOTD_HTTP_PORT/, `supervisor 侧对 ${bad} 没有拒绝：${s}`);
    }
  });

  test('soak.sh 探的端口也走同一个变量（别自己发明一个）', () => {
    const text = readFileSync(join(REPO, 'scripts', 'soak.sh'), 'utf8');
    assert.match(text, /DOTD_HTTP_PORT/, 'soak 探活必须认这个变量');
  });
});

describe('④ config.yml 只有一处判据（同一进程里两处读，不许各找各的）', () => {
  // 现场（2026-10-26，同类缺陷第十五例）：
  //
  //   DOTD_HOME=/tmp/h17    → config.yml: port 7001 / token dotdhome / reserve 2222
  //   HOME=/tmp/hh17        → .dotd/config.yml: port 7000 / token home  / reserve 1111
  //
  //   同一个进程里：
  //     loadSurfacesConfig()          → port 7000  token home     ← 读 HOME 那份
  //     cpReserveMbFromEnvOrConfig()  → 2222                       ← 读 DOTD_HOME 那份
  //
  // 也就是 surfaces: 节（端口 / master_token / 飞书密钥）来自用户 HOME，
  // 其余键来自数据目录 —— 两边日志都正常，人看不出来。

  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'dotd-cfgfile-'));
  }

  test('daemon 与脚本侧对同一组环境给同一个 config.yml 路径', () => {
    const root = scratch();
    try {
      const hosted = join(root, 'hosted');
      mkdirSync(hosted, { recursive: true });
      const home = join(root, 'home');
      mkdirSync(join(home, '.dotd'), { recursive: true });
      const cases: Array<Record<string, string>> = [
        {},
        { DOTD_HOME: hosted },
        { DOTD_CONFIG: join(root, 'x.yml') },
        { DOTD_CONFIG: join(root, 'x.yml'), DOTD_HOME: hosted },
      ];
      for (const env of cases) {
        // 案例 2/4 要证明「DOTD_HOME 里有文件才用它」：真放一份进去。
        if (typeof env['DOTD_HOME'] === 'string') writeFileSync(join(hosted, 'config.yml'), 'version: 1\n', 'utf8');
        const a = norm(resolveConfigFileDaemon({ env, home, exists: existsSync }));
        const b = norm(resolveConfigFileScript({ env, home }));
        assert.equal(a, b, `两侧对 ${JSON.stringify(env)} 判得不一样：daemon=${a} 脚本=${b}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DOTD_HOME 里有 config.yml 就用它（不再偷偷读 HOME）', () => {
    const root = scratch();
    try {
      const hosted = join(root, 'hosted');
      mkdirSync(hosted, { recursive: true });
      writeFileSync(join(hosted, 'config.yml'), 'version: 1\n', 'utf8');
      const env = { DOTD_HOME: hosted, DOTD_CONFIG: '' };
      const p = norm(resolveConfigFileDaemon({ env, home: join(root, 'home'), exists: existsSync }));
      assert.ok(p.endsWith('/hosted/config.yml'), `应落在 DOTD_HOME 下，实际 ${p}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DOTD_HOME 里没有 config.yml → 回落 ~/.dotd（老布局不许因这次修正起不来）', () => {
    const root = scratch();
    try {
      const hosted = join(root, 'hosted');
      mkdirSync(hosted, { recursive: true });
      const home = join(root, 'home');
      const env = { DOTD_HOME: hosted, DOTD_CONFIG: '' };
      const a = norm(resolveConfigFileDaemon({ env, home, exists: existsSync }));
      const b = norm(resolveConfigFileScript({ env, home }));
      assert.ok(a.endsWith('/.dotd/config.yml'), `应回落到 ~/.dotd，实际 ${a}`);
      assert.equal(a, b, '两侧必须一起回落，否则又是一处判据');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('三侧（daemon / 脚本 / supervisor）对同一组环境给同一个 config.yml 路径', {
    skip: PY_CMD === null ? '本机与 WSL 都没有能导入本仓库的 python3' : false,
  }, () => {
    const root = scratch();
    try {
      const hosted = join(root, 'hosted');
      mkdirSync(hosted, { recursive: true });
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(hosted, 'config.yml'), 'version: 1\n', 'utf8');
      // WSL 只认 /mnt 形态的路径；把两个目录都转过去再喂给 Python。
      const wsl = PY_CMD![0] === 'wsl.exe';
      const wslHosted = wsl ? toWslPath(hosted) : hosted;
      const wslHome = wsl ? toWslPath(home) : home;

      const missing = join(hosted, 'nope');
      const probes: Array<{ name: string; hostedExists: boolean; wantHosted: boolean }> = [
        // ① DOTD_HOME 里有 config.yml → 用它（第十五例的核心）
        { name: 'DOTD_HOME 有 config.yml', hostedExists: true, wantHosted: true },
        // ② DOTD_HOME 里没有 → 回落 ~/.dotd
        { name: 'DOTD_HOME 无 config.yml', hostedExists: false, wantHosted: false },
      ];

      for (const c of probes) {
        const pyDotdHome = c.hostedExists ? wslHosted : toWslPath(missing);
        const py = runPy([
          'from voice.integration.one_system import resolve_paths',
          `print(resolve_paths({"DOTD_HOME": ${JSON.stringify(pyDotdHome)}, "HOME": ${JSON.stringify(wslHome)}}).config_file)`,
        ].join('\n'));
        assert.doesNotMatch(py, /^NO_PYTHON/, `supervisor 侧没跑起来（${c.name}）：${py}`);
        // Python 返回 /mnt/... 形态，两侧各自按自己那套路径归一后比较。
        const pyWant = c.wantHosted ? `${norm(wslHosted)}/config.yml` : '/.dotd/config.yml';
        assert.ok(norm(py).endsWith(pyWant), `supervisor 侧没按判据取（${c.name}）：${py}`);

        // daemon/脚本侧吃原生路径 —— 把 `/mnt/c/...` 喂给 Windows 的 existsSync
        // 只会恒为 false，测出来的"回落"跟被测逻辑无关（又一处"测试自己找错地方"）。
        const env = { DOTD_HOME: c.hostedExists ? hosted : missing, HOME: home };
        const want = c.wantHosted ? `${norm(hosted)}/config.yml` : '/.dotd/config.yml';
        const daemon = norm(resolveConfigFileDaemon({ env, home, exists: existsSync }));
        assert.ok(daemon.endsWith(want), `daemon 侧没按判据取（${c.name}）：${daemon}`);
        const script = norm(resolveConfigFileScript({ env, home }));
        assert.equal(daemon, script, `daemon 与脚本判据不一致（${c.name}）`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('daemon 里读 config.yml 的两处走同一个函数（不是各 join 一遍）', () => {
    const src = readFileSync(join(REPO, 'src', 'daemon.ts'), 'utf8');
    assert.match(src, /readFileSync\(resolveConfigFile\(/, '水位预留必须按 config.yml 判据取路径');
    // 只查**代码行**：那条注释里正引着旧写法当反例，扫描整段文本会误中自己
    // （同类缺陷的"检索会误中自己"，soak 报告的护栏也踩过一次）。
    const codeLines = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
    assert.ok(
      !codeLines.some((l) => /join\(cfg\.dataDir, 'config\.yml'\)/.test(l)),
      '不许再自己拼 <dataDir>/config.yml —— 那是第十五例（与 surfaces 节分叉）',
    );
    const cfg = readFileSync(join(REPO, 'src', 'surfaces', 'config.ts'), 'utf8');
    assert.match(cfg, /configPath \?\? resolveConfigFile\(\)/, 'loadSurfacesConfig 缺省必须走同一判据');
    assert.doesNotMatch(
      cfg,
      /path = configPath \?\? process\.env\.DOTD_CONFIG/,
      '旧写法（只认 DOTD_CONFIG 和 ~/.dotd）要删干净',
    );
  });

  test('doctor 的 surfaces-config 也用同一判据（不许自己拼 ~/.dotd）', () => {
    const src = readFileSync(join(REPO, 'scripts', 'doctor.mjs'), 'utf8');
    assert.match(src, /resolveConfigFile\(\{ env: runtimeEnv, home \}\)/);
    assert.doesNotMatch(src, /join\(home, '\.dotd', 'config\.yml'\)/, 'doctor 不许自己拼路径');
  });

  test('init-config 的"下一步"说的是它真正写的那份', () => {
    const src = readFileSync(join(REPO, 'scripts', 'init-config.mjs'), 'utf8');
    assert.match(src, /起 daemon（读 \$\{CONFIG_PATH\}）/, '提示里的路径必须来自实际写的位置');
    assert.doesNotMatch(src, /起 daemon（默认读 ~\/\.dotd\/config\.yml）/, '旧提示会把人指到另一份文件');
  });
});
