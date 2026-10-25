/**
 * tests/scripts-env-layered.test.ts —— 「缺 key」不能是"读错了地方"。
 *
 * 现场（2026-10-26，live 机 `node scripts/onboard.mjs`）：
 *
 *     ⚠️  模型端点: 缺模型 key：HY3_API_KEY / OPENROUTER_API_KEY / BACKUP_API_KEY
 *
 * 三个 key **都在** `~/.dotd/tokens.env` 里，daemon 启动时 source 的正是它，
 * 模型一路正常。错的只有体检：它只读 `process.env`，而交互式 shell 不 source
 * tokens.env —— 于是"文件里有、进程里没有"被报成"机器上没有"。
 *
 * 判据的定义就是这段：**key 的真相 = 进程环境 ∪ `<home>/tokens.env`，进程优先**
 * （与 shell `source` + 显式覆盖的语义一致）。写成测试是为了让"只查 process.env"
 * 这个错误不能悄悄回来。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join, resolve } from 'node:path';

import { configDirIsHostedGuess, isEnvRef, layeredEnv, parseEnvFile, resolveConfigDir, tokenFiles, usableToken } from '../scripts/lib/env.mjs';

// 路径一律用 join 拼：lib 里也是 join（Windows 上是反斜杠），写死 '/' 会
// 在 Linux 绿、Windows 红 —— 那种"只在某台机器上过"的测试比没有更糟。
const UHOME = join('/home', 'u');
// 常规形态：CHARLIE_HOME / DOTD_HOME 指到自定义目录（Docker 里是 /data）。
const HOME = join(UHOME, 'charlie-home');
const homeTokens = join(HOME, 'tokens.env');
// 兜底路径：home 没指到别处时 daemon 也会看 ~/.dotd/tokens.env。
const DOTD_HOME = join(UHOME, '.dotd');
const dotdTokens = join(DOTD_HOME, 'tokens.env');

/** 造一个只有这些文件存在、内容是这些的世界。 */
function world(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    read: (p: string) => {
      if (!(p in files)) throw new Error(`no such file: ${p}`);
      return files[p]!;
    },
  };
}

describe('① parseEnvFile：tokens.env 是数据不是脚本', () => {
  test('export 前缀 / 引号 / 空格变体 / 注释 / CRLF / BOM', () => {
    const text = [
      '\uFEFF# 注释',
      'export A=1',
      "B='two words'",
      'C="quoted"',
      'D = spaced',
      '',
      'E=',
      'not a kv line',
      'F=a=b=c',
    ].join('\r\n');
    assert.deepEqual(parseEnvFile(text), {
      A: '1',
      B: 'two words',
      C: 'quoted',
      D: 'spaced',
      E: '',
      F: 'a=b=c',
    });
  });

  test('非字符串输入返回空对象（体检脚本不该崩）', () => {
    assert.deepEqual(parseEnvFile(null), {});
    assert.deepEqual(parseEnvFile(undefined), {});
    // 类型上不可能，但运行期（JS 调用方）可能塞进来别的；不能因此崩掉整个体检。
    assert.deepEqual(parseEnvFile(42 as unknown as string), {});
  });

  test('值里的 # 不当注释（只有行首井号才是）', () => {
    assert.deepEqual(parseEnvFile('K=abc#def'), { K: 'abc#def' });
  });
});

describe('② tokenFiles：home 就是 ~/.dotd 时不重复读', () => {
  test('常规两处', () => {
    assert.deepEqual(tokenFiles(HOME, UHOME), [homeTokens, dotdTokens]);
  });

  test('home == ~/.dotd → 去重成一条', () => {
    assert.deepEqual(tokenFiles(join(UHOME, '.dotd'), UHOME), [dotdTokens]);
  });
});

describe('③ layeredEnv：文件里的 key 也算"有"', () => {
  test('只存在于 tokens.env 的 key → has() 为真（这条就是 live 上的假红）', () => {
    const w = world({ [homeTokens]: 'HY3_API_KEY=abc\nBACKUP_API_KEY=bak\n' });
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...w });
    assert.equal(keys.has('HY3_API_KEY'), true, 'daemon 能用它，体检就不能说没有');
    assert.equal(keys.has('BACKUP_API_KEY'), true);
    assert.equal(keys.has('NOT_THERE'), false);
  });

  test('缺失时 get() 返回空串，不是 undefined', () => {
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...world({}) });
    assert.equal(keys.get('NOPE'), '');
  });

  test('进程环境优先于文件（显式覆盖）', () => {
    const w = world({ [homeTokens]: 'HY3_API_KEY=from-file\n' });
    const keys = layeredEnv({
      home: HOME,
      homedir: UHOME,
      processEnv: { HY3_API_KEY: 'from-env' },
      ...w,
    });
    assert.equal(keys.get('HY3_API_KEY'), 'from-env');
  });

  test('进程环境里是**空串**时退到文件（空值等于没设）', () => {
    const w = world({ [homeTokens]: 'HY3_API_KEY=from-file\n' });
    const keys = layeredEnv({
      home: HOME,
      homedir: UHOME,
      processEnv: { HY3_API_KEY: '' },
      ...w,
    });
    assert.equal(keys.get('HY3_API_KEY'), 'from-file');
  });

  test('两个文件都有 → 先读到的（<home>/tokens.env）优先', () => {
    const w = world({
      [homeTokens]: 'K=home\n',
      [dotdTokens]: 'K=dotd\n',
    });
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...w });
    assert.equal(keys.get('K'), 'home');
  });

  test('sources 只记路径，不记值（报错时可以说清"我看的是哪儿"）', () => {
    const w = world({ [homeTokens]: 'HY3_API_KEY=sk-secret-value\n' });
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...w });
    assert.equal(keys.sources.HY3_API_KEY, homeTokens);
    assert.doesNotMatch(JSON.stringify(keys.sources), /sk-secret-value/);
  });

  test('文件读不动 → 跳过，不抛（一个坏文件不该让体检整体失败）', () => {
    const keys = layeredEnv({
      home: HOME,
      homedir: UHOME,
      processEnv: {},
      exists: (p) => p === homeTokens,
      read: () => {
        throw new Error('EACCES');
      },
    });
    assert.equal(keys.has('ANY'), false);
  });
});

describe('④ onboard 的判据：模型 key 用合并后的眼光', () => {
  test('models.yml 声明的三个 key，只有文件里有 → 判定"已配置"', () => {
    // 复刻 live 实况：process.env 里一个都没有，全在 tokens.env
    const w = world({
      [homeTokens]: [
        'HY3_API_KEY=a',
        'OPENROUTER_API_KEY=b',
        'BACKUP_API_KEY=c',
      ].join('\n'),
    });
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...w });
    const declared = ['HY3_API_KEY', 'OPENROUTER_API_KEY', 'BACKUP_API_KEY'];
    assert.equal(declared.filter((n) => keys.has(n)).length, 3);
  });

  // live 上的真实现场（2026-10-26）：tokens.env 里**有这两行**，但值是空的 ——
  // `export OPENROUTER_API_KEY=`。所以「只报了 HY3_API_KEY」是**诚实**结论，
  // 不是漏报。这条测试把"有行 ≠ 有值"钉住，免得以后有人把 has() 改成
  // "键名出现过"，把一台真缺 key 的机器报成全绿。
  test('有行但值为空 → 不算有（live 上 OPENROUTER/BACKUP 就是这样）', () => {
    const w = world({
      [homeTokens]: [
        'HY3_API_KEY=a',
        'export OPENROUTER_API_KEY=',
        'export BACKUP_API_KEY=',
      ].join('\n'),
    });
    const keys = layeredEnv({ home: HOME, homedir: UHOME, processEnv: {}, ...w });
    assert.equal(keys.has('HY3_API_KEY'), true);
    assert.equal(keys.has('OPENROUTER_API_KEY'), false, '空值等于没配，否则模型会拿空 key 去请求');
    assert.equal(keys.has('BACKUP_API_KEY'), false);
  });
});

describe('⑤ usableToken：`${VAR}` 是引用，不是令牌', () => {
  test('init-config 生成的 ${DOTD_MASTER_TOKEN} 不算令牌', () => {
    // live 的 config.yml 第 53 行长这样，长度 20 —— 最朴素的"≥16 就行"会把
    // 它判成真令牌（onboard 那一行一直是假绿）。
    assert.equal(usableToken('${DOTD_MASTER_TOKEN}'), null);
    assert.equal(isEnvRef('${DOTD_MASTER_TOKEN}'), true);
  });

  test('带默认值的引用同样不算', () => {
    assert.equal(usableToken('${DOTD_MASTER_TOKEN:-change-me}'), null);
  });

  test('真令牌要过长度与 change-me 两道', () => {
    assert.equal(usableToken('0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
    assert.equal(usableToken('short'), null);
    assert.equal(usableToken('change-me-please-change-me'), null);
    assert.equal(usableToken(undefined), null);
    assert.equal(usableToken(''), null);
  });

  test('引用只在**整串**时才算引用（令牌里带 $ 不该被误杀）', () => {
    assert.equal(isEnvRef('abc${X}def'), false);
    assert.equal(usableToken('abc$0123456789abcdef'), 'abc$0123456789abcdef');
  });
});

describe('⑥ resolveConfigDir：三处审计脚本必须看 daemon 读的那一份', () => {
  // 现场（2026-10-26）：doctor / onboard / probe-live-model 各自拼路径。
  // doctor 看仓库模板、onboard 也看仓库模板、probe 还是仓库模板 —— 而 daemon
  // 在托管部署里读 `~/.dotd`（`DOTD_CONFIG_DIR` 由 one_system 设）。
  // 于是同一台机器上「体检看模板、daemon 跑运行时」，结论可以完全相反。
  // 判据收成一份放在 lib 里，这条测试钉住它与 `src/daemon.ts::resolveConfigDir` 同形。

  const repo = join('/srv', 'dotd');
  // 设了 DOTD_CONFIG_DIR 的分支会走 `resolve()`（daemon 侧也是 resolve），
  // 期待值同样过一遍：Windows 上 `/home/u` 是"当前盘根"，join 与 resolve 不同形。
  const abs = (p: string) => resolve(p);
  // **每个调用都显式给 home**：默认分支会去看 `<home>/.dotd/models.yml` 是否存在，
  // 用真 home 的测试在"这台机器托管跑过"时会红/绿翻转 —— 那种只在某台机器上过的
  // 测试比没有更糟。`emptyHome` 里什么文件都没有。
  const emptyHome = join('/home', 'nobody');
  const noModels = { exists: () => false };
  const hostedHome = join('/home', 'hosted');

  test('没设 DOTD_CONFIG_DIR → 仓库 config/', () => {
    // 这条分支是 `join(repoRoot, 'config')`（与 daemon 逐字一致，不做 resolve），
    // 所以期望值也用 join —— 用 resolve 会在 Windows 上把 `/srv` 变成 `D:\srv`。
    assert.equal(
      resolveConfigDir({ env: {}, repoRoot: repo, home: emptyHome, ...noModels }),
      join(repo, 'config'),
    );
    assert.equal(
      resolveConfigDir({ env: { DOTD_CONFIG_DIR: '' }, repoRoot: repo, home: emptyHome, ...noModels }),
      join(repo, 'config'),
    );
    assert.equal(
      resolveConfigDir({ env: { DOTD_CONFIG_DIR: '   ' }, repoRoot: repo, home: emptyHome, ...noModels }),
      join(repo, 'config'),
      '纯空白等于没设',
    );
  });

  test('设了 → 用它（托管部署里就是 ~/.dotd）', () => {
    assert.equal(
      resolveConfigDir({ env: { DOTD_CONFIG_DIR: join('/home', 'u', '.dotd') }, repoRoot: repo }),
      abs(join('/home', 'u', '.dotd')),
    );
  });

  test('~ 要展开（人和脚本都爱写 ~/.dotd）', () => {
    assert.equal(
      resolveConfigDir({ env: { DOTD_CONFIG_DIR: '~/.dotd' }, repoRoot: repo, home: join('/home', 'u') }),
      abs(join('/home', 'u', '.dotd')),
    );
    assert.equal(
      resolveConfigDir({ env: { DOTD_CONFIG_DIR: '~' }, repoRoot: repo, home: join('/home', 'u') }),
      abs(join('/home', 'u')),
    );
  });

  test('相对路径按 cwd 解析成绝对路径（daemon 侧也是 resolve）', () => {
    const got = resolveConfigDir({ env: { DOTD_CONFIG_DIR: 'cfg' }, repoRoot: repo });
    assert.ok(isAbsolute(got), `要绝对路径：${got}`);
    assert.ok(got.endsWith('cfg'));
  });

  // ── 分支 2：DOTD_CONFIG 所在目录 ──────────────────────────────────
  //
  // one_system 的判据是 `config_dir = DOTD_CONFIG_DIR or config_file.parent`
  // （voice/integration/one_system.py:103）。审计脚本不跟这条走，就会在
  // "只设了 DOTD_CONFIG、没设 DOTD_CONFIG_DIR"的部署里看仓库模板。
  test('只设了 DOTD_CONFIG → 用它所在目录（与 one_system 同判据）', () => {
    assert.equal(
      resolveConfigDir({
        env: { DOTD_CONFIG: join('/data', 'charlie', 'config.yml') },
        repoRoot: repo,
        home: emptyHome,
        ...noModels,
      }),
      abs(join('/data', 'charlie')),
    );
    assert.equal(
      resolveConfigDir({
        env: { DOTD_CONFIG: '~/alt/config.yml' },
        repoRoot: repo,
        home: hostedHome,
        ...noModels,
      }),
      abs(join(hostedHome, 'alt')),
      '~ 也要展开（DOTD_CONFIG 与 DOTD_CONFIG_DIR 同一套展开规则）',
    );
  });

  test('DOTD_CONFIG_DIR 优先于 DOTD_CONFIG（前者更具体）', () => {
    assert.equal(
      resolveConfigDir({
        env: { DOTD_CONFIG_DIR: join('/x', 'cfg'), DOTD_CONFIG: join('/data', 'config.yml') },
        repoRoot: repo,
        home: emptyHome,
        ...noModels,
      }),
      abs(join('/x', 'cfg')),
    );
  });

  // ── 分支 3：托管布局记号 ──────────────────────────────────────────
  //
  // 现场：live 上 `npm run doctor` 打 `MCP 未启用 — /root/dotd/config/mcp-servers.yml`，
  // 而 daemon（one_system 托管）读 `/root/.dotd/mcp-servers.yml`。那个 shell 里
  // 两个环境变量都没有，所以只看变量就永远只能看到仓库模板 —— 体检看的是
  // "没人读的文件"，却把结论报成"这台机器没配"。
  test('两个变量都没设，但 <home>/.dotd/models.yml 在 → 认成托管布局', () => {
    const exists = (p: string): boolean => p === join(hostedHome, '.dotd', 'models.yml');
    assert.equal(
      resolveConfigDir({ env: {}, repoRoot: repo, home: hostedHome, exists }),
      abs(join(hostedHome, '.dotd')),
    );
  });

  test('只有 ~/.dotd/config.yml（裸 init-config 的开发机）→ 仍是仓库 config/', () => {
    // models.yml 是托管启动器刷进去的记号；开发机只有 init-config 写的 config.yml。
    // 用 config.yml 当记号会把开发机也误导到 ~/.dotd —— 那里的 models.yml 不存在，
    // 于是 doctor 报"缺 models.yml"，而 daemon 明明跑得好好的。
    const exists = (p: string): boolean => p === join(hostedHome, '.dotd', 'config.yml');
    assert.equal(
      resolveConfigDir({ env: {}, repoRoot: repo, home: hostedHome, exists }),
      join(repo, 'config'),
    );
  });

  test('显式设了变量时不做布局推断（配置就是配置）', () => {
    assert.equal(
      resolveConfigDir({
        env: { DOTD_CONFIG_DIR: join('/x', 'cfg') },
        repoRoot: repo,
        home: hostedHome,
        exists: () => true,
      }),
      abs(join('/x', 'cfg')),
    );
    assert.equal(
      configDirIsHostedGuess({ env: { DOTD_CONFIG_DIR: join('/x', 'cfg') }, home: hostedHome, exists: () => true }),
      false,
    );
  });
});

