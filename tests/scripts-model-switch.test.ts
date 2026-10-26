/**
 * tests/scripts-model-switch.test.ts —— 「换 primary 模型」必须改到 daemon 读的那份。
 *
 * 现场（2026-10-26，同类缺陷第九例）：
 *
 * ```
 * $ head -5 scripts/ab-models.sh
 * cd "$HOME/dotd" || exit 1
 * ...
 *   const p = "config/models.yml";        ← 改的是**仓库副本**
 * ```
 *
 * 托管部署里 daemon 读 `~/.dotd/models.yml`（`DOTD_CONFIG_DIR`）。这条链之所以
 * 看起来能工作，全靠 `wsl-daemon.sh` 每次启动时把 `config/*.yml` 拷过去 ——
 * 换成 one_system / charlie:start 重启就**完全没生效**，而脚本照样跑完、
 * 照样打印步数，看起来像"两个模型差不多"。中途失败时文件还留在被改状态。
 *
 * 这个库把它变成三件事：改两处、**读回验证**、EXIT trap 恢复。
 * 这里把三件事都钉住（用真 bash + 假 home，不碰真 ~/.dotd）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const LIB = join(REPO, 'scripts', 'lib', 'model-switch.sh');

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
const bashOk = BASH.status === 0;

const SEED = `endpoints:
  - id: openrouter-main
    tier: 1
    base_url: \${DOTD_MODEL_HOST:-http://127.0.0.1:3065}/v1
    models:
      primary: deepseek-v4.1-flash
      light: deepseek-v4.1-flash
`;

const RUNTIME = `endpoints:
  - id: openrouter-main
    tier: 1
    base_url: http://172.17.48.1:13065/v1
    models:
      primary: deepseek-v4.1-flash
      light: deepseek-v4.1-flash
`;

/** 一个临时世界：home（运行期配置）+ 一份"仓库副本"（种子）。 */
function world(opts: { runtime?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dotd-mswitch-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(join(home, 'home'), { recursive: true }); // $HOME/.dotd
  mkdirSync(join(home, '.dotd'), { recursive: true });
  mkdirSync(join(repo, 'config'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'config', 'models.yml'), SEED, 'utf8');
  const runtime = opts.runtime === null ? null : (opts.runtime ?? RUNTIME);
  const runtimePath = join(home, '.dotd', 'models.yml');
  if (runtime !== null) writeFileSync(runtimePath, runtime, 'utf8');
  return {
    root,
    home,
    repo,
    seedPath: join(repo, 'config', 'models.yml'),
    runtimePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 在"临时仓库"里跑一段 bash（source 库 + 给定测试语句）。 */
function runScript(w: ReturnType<typeof world>, body: string, env: Record<string, string> = {}) {
  // 把库放进临时仓库的 scripts/lib 下：库自己按 BASH_SOURCE 找种子，必须如此。
  // 依赖（config-dir.sh = 「运行期配置在哪」的单一判据、exit-hooks.sh = EXIT 钩子表）
  // 一起放，否则 source 失败、函数全不存在，测试会"绿得莫名其妙"。
  for (const dep of ['model-switch.sh', 'config-dir.sh', 'exit-hooks.sh']) {
    writeFileSync(
      join(w.repo, 'scripts', 'lib', dep),
      readFileSync(join(REPO, 'scripts', 'lib', dep), 'utf8'),
      'utf8',
    );
  }
  const script = `set -uo pipefail\ncd ${JSON.stringify(w.repo)}\n. scripts/lib/model-switch.sh\n${body}\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
      ),
      HOME: w.home,
      // 清掉可能从开发机继承的：否则"运行期"会指到别处，测的东西不成立。
      DOTD_CONFIG_DIR: '',
      DOTD_CONFIG: '',
      DOTD_HOME: '',
      ...env,
    },
  });
}

const primaryOf = (p: string): string =>
  /^\s*primary:\s*(.+)$/m.exec(readFileSync(p, 'utf8'))?.[1]?.trim() ?? '';

describe('① 改的是运行期那份（daemon 真读的），不只是仓库副本', { skip: !bashOk }, () => {
  test('托管布局：两处 primary 都变了', () => {
    const w = world();
    try {
      // 必须在**脚本内**读值：`models_begin` 挂了 EXIT trap，脚本一退出就恢复了
      // （这正是 ③ 要验的行为）。第一版在脚本外用 primaryOf() 读，读到的是恢复后
      // 的原值 —— 那条测试其实在证明"恢复有效"，而不是"改动落到运行期"。
      const r = runScript(
        w,
        [
          'models_begin >/dev/null',
          'models_set_primary new-model',
          'echo "RT=$(sed -n \'s/^[[:space:]]*primary: //p\' "$_MODELS_RUNTIME" | head -1)"',
          'echo "SEED=$(sed -n \'s/^[[:space:]]*primary: //p\' "$_MODELS_SEED" | head -1)"',
        ].join('\n'),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /RT=new-model/, '运行期这份必须变（否则 daemon 看不到）');
      assert.match(r.stdout, /SEED=new-model/, '种子也要变（否则下次启动被覆盖回去）');
      // 退出后应已恢复 —— 与 ③ 呼应，说明上面两条测的是"运行时"而非"运行后"。
      assert.equal(primaryOf(w.runtimePath), 'deepseek-v4.1-flash');
    } finally {
      w.cleanup();
    }
  });

  test('没有托管布局（运行期 = 仓库副本）时只改一份，不报错', () => {
    const w = world({ runtime: null });
    try {
      const r = runScript(
        w,
        'models_begin\nmodels_set_primary lone\necho "SEED=$(sed -n \'s/^[[:space:]]*primary: //p\' "$_MODELS_SEED" | head -1)"',
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SEED=lone/);
    } finally {
      w.cleanup();
    }
  });
});

describe('② 读回验证：没生效就大声失败，而不是继续测', { skip: !bashOk }, () => {
  test('运行期那份被改回旧值时，models_verify_primary 非零退出', () => {
    const w = world();
    try {
      // 直接指定一个"期望"，不改文件 —— 模拟"改了但没落到运行期"。
      const r = runScript(w, 'models_verify_primary something-else && echo SHOULD_NOT_PRINT');
      assert.notEqual(r.status, 0, '没生效必须非零');
      assert.doesNotMatch(r.stdout, /SHOULD_NOT_PRINT/);
      assert.match(r.stderr, /换模型没有生效/);
      assert.match(r.stderr, /~\/\.dotd|运行期/, '要说清该看哪份文件');
      assert.match(r.stderr, /primary=deepseek-v4\.1-flash/, '要报出实际值');
    } finally {
      w.cleanup();
    }
  });

  test('改对了 → 验证通过并打印实际值', () => {
    const w = world();
    try {
      const r = runScript(w, 'models_set_primary want-me\nmodels_verify_primary want-me');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /primary=want-me（已验证）/);
    } finally {
      w.cleanup();
    }
  });
});

describe('③ 退出时恢复两处（Ctrl-C / 断言失败也不会留下烂摊子）', { skip: !bashOk }, () => {
  test('EXIT trap 把运行期与种子都恢复原样', () => {
    const w = world();
    try {
      const r = runScript(
        w,
        [
          'models_begin >/dev/null',
          'models_set_primary temporary',
          'models_set_base_url http://127.0.0.1:59999/v1',
          'echo "改完: $(sed -n \'s/^[[:space:]]*primary: //p\' "$_MODELS_RUNTIME" | head -1)"',
          // 不显式恢复：靠 EXIT trap
        ].join('\n'),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /改完: temporary/, '实验期间应看到新值');
      assert.equal(primaryOf(w.runtimePath), 'deepseek-v4.1-flash', '运行期必须恢复');
      assert.equal(primaryOf(w.seedPath), 'deepseek-v4.1-flash', '种子必须恢复');
      assert.match(readFileSync(w.runtimePath, 'utf8'), /172\.17\.48\.1:13065/, 'base_url 也要恢复');
    } finally {
      w.cleanup();
    }
  });

  test('实验中途失败（非零退出）照样恢复', () => {
    const w = world();
    try {
      const r = runScript(w, 'models_begin >/dev/null\nmodels_set_primary temp\nexit 7');
      assert.equal(r.status, 7);
      assert.equal(primaryOf(w.runtimePath), 'deepseek-v4.1-flash');
      assert.equal(primaryOf(w.seedPath), 'deepseek-v4.1-flash');
    } finally {
      w.cleanup();
    }
  });
});

describe('④ 运行期文件不存在时拒绝开工（而不是测一份没人读的配置）', { skip: !bashOk }, () => {
  test('models_begin 返回非零并说清缺的是哪份', () => {
    const w = world({ runtime: null });
    try {
      // 把 <home>/.dotd/models.yml 删掉，同时让 DOTD_CONFIG_DIR 指过去 →
      // 运行期路径存在但文件不在（真实场景：init-config 还没跑）。
      const r = runScript(w, 'models_begin && echo SHOULD_NOT_PRINT', {
        DOTD_CONFIG_DIR: join(w.home, '.dotd'),
      });
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stdout, /SHOULD_NOT_PRINT/);
      assert.match(r.stderr, /运行期配置不存在/);
    } finally {
      w.cleanup();
    }
  });
});

describe('⑤ 调用方已全部改用它（防止有人再写一段 sed -i）', { skip: !bashOk }, () => {
  // 换模型的那几个必须读回 primary；造"端点全挂"的那个必须读回 base_url。
  const callers: Array<{ name: string; verify: RegExp }> = [
    { name: 'ab-switch.sh', verify: /models_verify_primary/ },
    { name: 'ab-models.sh', verify: /models_verify_primary/ },
    { name: 'ab-rounds.sh', verify: /models_verify_primary/ },
    { name: 'selftest-model-down.sh', verify: /models_verify_base_url/ },
  ];
  for (const { name, verify } of callers) {
    test(`${name} 会 source lib/model-switch.sh 并读回验证`, () => {
      const text = readFileSync(join(REPO, 'scripts', name), 'utf8');
      assert.match(text, /lib\/model-switch\.sh/, '必须共用同一份判据');
      assert.match(text, /models_begin/, '必须备份 + 挂 trap');
      assert.match(text, verify, '必须读回验证（"改完就假定生效"正是原缺陷）');
      assert.doesNotMatch(
        text,
        /^\s*sed -i .*config\/models\.yml/m,
        '不许再自己 sed 仓库副本：判据只能有一份（lib/model-switch.sh）',
      );
    });
  }
});
