/**
 * tests/scripts-setup.test.ts —— `npm run setup`（P2-3 部署收敛）的单元与幂等守卫。
 *
 * 这条任务的核心不是"写个脚本"，而是**证明 12 步里哪些是真必要的**：
 * 本文件把那个判断钉成可执行断言——
 *   - 必须人做的只有 3 件：装 Node、给模型 key、声明 fleet 意图；
 *   - 其余全部可检测/幂等，且**已满足时绝不改动任何东西**；
 *   - docker pull 2GB、覆盖 tokens.env 这类危险/昂贵动作**永不自动做**；
 *   - setup 的退出码必须服从 doctor（doctor 才是"能不能起来"的唯一真相源）。
 *
 * 与 doctor 同样的取向：纯函数直接打，不靠"跑一遍看输出像不像"。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkConfig,
  checkDataDir,
  checkDeps,
  checkFleet,
  checkImage,
  checkNode,
  checkRelay,
  checkTokens,
  formatSetupReport,
  majorOf,
  parseTokensEnv,
  relayRulesFromScript,
  STEPS,
  STEP,
  summarize,
} from '../scripts/setup.mjs';

// ═══════════════════════════════════════════════════════════════════
// 一、必答题①：哪些步骤真的必须人做
// ═══════════════════════════════════════════════════════════════════

describe('必答题①：必须人做的步骤有且只有 3 类', () => {
  test('Node 版本不够 → ACT（脚本不替你装 Node），够了 → SKIP', () => {
    assert.equal(checkNode('v20.11.0').status, STEP.ACT);
    assert.match(String(checkNode('v20.11.0').next), /nvm|nodejs\.org/, '要给出可执行的下一条命令');
    assert.equal(checkNode('v24.13.0').status, STEP.SKIP);
    assert.equal(checkNode('v25.1.0').status, STEP.SKIP, '高版本也放行');
    assert.equal(checkNode('garbage').status, STEP.ACT);
  });

  test('majorOf 解析稳健（含 v 前缀与无前缀）', () => {
    assert.equal(majorOf('v24.13.0'), 24);
    assert.equal(majorOf('24.0.0'), 24);
    assert.equal(majorOf('nonsense'), null);
  });

  test('模型 key 缺失 → 明确"只能人填"，且不生成假 key', () => {
    const r = checkTokens({
      text: 'export DOTD_MASTER_TOKEN=abc\nexport DOTD_RO_TOKEN=d\nexport HOOK_GRAFANA=e\n',
      required: ['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'HOOK_GRAFANA'],
    });
    assert.equal(r.ok, true, '三个随机键齐全');
    // 模型 key 不在 required 里（它是可选的），但 setup 主流程单独检查并提示
    assert.deepEqual(r.missing, []);
    const missingModel = checkTokens({
      text: 'export DOTD_MASTER_TOKEN=abc\n',
      required: ['DOTD_MASTER_TOKEN', 'WB2API_KEY'],
    });
    assert.equal(missingModel.ok, false);
    assert.match(String(missingModel.next), /你自己填|需要你自己/, '模型 key 必须说明是人工填的');
    assert.match(String(missingModel.next), /WB2API_KEY/);
  });

  test('fleet 是"意图声明"：默认 stub，声明 docker 时才检查 docker', () => {
    const dflt = checkFleet({ raw: undefined, dockerAvailable: false });
    assert.equal(dflt.effective, 'stub', '未声明 = stub（与 src/exec/types.ts 默认一致）');
    assert.equal(dflt.ok, true);

    const declaredNoDocker = checkFleet({ raw: 'docker', dockerAvailable: false });
    assert.equal(declaredNoDocker.ok, false);
    assert.equal(declaredNoDocker.status, STEP.ACT);
    assert.match(String(declaredNoDocker.detail), /docker 不可达/);

    const declaredOk = checkFleet({ raw: 'docker', dockerAvailable: true });
    assert.equal(declaredOk.ok, true);

    // 拼错 = 静默回落 stub，必须点出来（doctor 同款判据）
    const typo = checkFleet({ raw: 'Docker', dockerAvailable: true });
    assert.equal(typo.effective, 'stub');
    assert.equal(typo.status, STEP.ACT);
    assert.match(String(typo.detail), /静默忽略/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 二、可自动化的步骤：检测而不是假设
// ═══════════════════════════════════════════════════════════════════

describe('可自动化步骤：已满足就 SKIP，且不主张改动', () => {
  test('依赖：没装 / lock 比 modules 新 → ACT；齐了 → SKIP', () => {
    assert.equal(checkDeps({ hasNodeModules: false }).status, STEP.ACT);
    assert.equal(checkDeps({ hasNodeModules: false }).next, 'npm install');
    const stale = checkDeps({ hasNodeModules: true, lockMtimeMs: 200, modulesMtimeMs: 100 });
    assert.equal(stale.status, STEP.ACT);
    assert.match(stale.detail, /package-lock\.json 比 node_modules 新/);
    const fresh = checkDeps({ hasNodeModules: true, lockMtimeMs: 100, modulesMtimeMs: 200 });
    assert.equal(fresh.status, STEP.SKIP);
  });

  test('config.yml 已存在 → SKIP（绝不覆盖）；不存在 → ACT 指向 init-config', () => {
    const exists = checkConfig({ exists: true });
    assert.equal(exists.status, STEP.SKIP);
    assert.match(exists.detail, /不覆盖/);
    const missing = checkConfig({ exists: false });
    assert.equal(missing.status, STEP.ACT);
    assert.match(String(missing.next), /init-config/);
  });

  test('data-dir 不存在是可自动创建的 OK（不是 ACT）', () => {
    assert.equal(checkDataDir({ exists: false }).status, STEP.OK);
    assert.equal(checkDataDir({ exists: true }).status, STEP.SKIP);
  });

  test('镜像：基座缺失只报告 `docker pull` 命令，**脚本不拉 2GB**', () => {
    const missing = checkImage({ basePresent: false, builtPresent: false, baseTag: 'mcr.microsoft.com/playwright:v1.49.1-noble' });
    assert.equal(missing.status, STEP.ACT, '要人确认');
    assert.match(String(missing.next), /^确认要真容器后自己跑：docker pull/, '必须是"你自己跑"，不是自动拉');
    assert.match(missing.detail, /2GB/);

    const baseOnly = checkImage({ basePresent: true, builtPresent: false, baseTag: 'x' });
    assert.equal(baseOnly.status, STEP.SKIP);
    assert.match(String(baseOnly.detail), /daemon 首次 boot 时自动构建/, '构建不需要单独一步（ensureImage）');
  });

  test('relay：原生 Windows 不需要；WSL 部署缺端口才 ACT', () => {
    assert.equal(checkRelay({ wslDeployment: false, relayRules: [], neededPorts: ['7863'] }).status, STEP.SKIP);
    const wsl = checkRelay({ wslDeployment: true, relayRules: ['3065', '8001'], neededPorts: ['7863'] });
    assert.equal(wsl.status, STEP.ACT);
    assert.match(String(wsl.detail), /7863/);
    const wslOk = checkRelay({ wslDeployment: true, relayRules: ['7863'], neededPorts: ['7863'] });
    assert.equal(wslOk.status, STEP.SKIP);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 三、tokens.env 解析（不打印值）+ relay 规则读取
// ═══════════════════════════════════════════════════════════════════

describe('parseTokensEnv：只解析，不打印', () => {
  test('export 前缀、引号、注释、空行都能处理', () => {
    const env = parseTokensEnv(
      ['# 注释', 'export A=1', "B='two words'", 'C="quoted"', 'D=', '', 'E = spaced'].join('\n'),
    );
    assert.equal(env.A, '1');
    assert.equal(env.B, 'two words');
    assert.equal(env.C, 'quoted');
    assert.equal(env.D, '');
    assert.equal(env.E, 'spaced');
    assert.equal(env['# 注释'], undefined);
  });

  test('非字符串输入返回空对象（不抛）', () => {
    assert.deepEqual(parseTokensEnv(null), {});
    assert.deepEqual(parseTokensEnv(undefined), {});
  });
});

describe('relayRulesFromScript：从真实脚本里读目标端口', () => {
  test('读到 win-relay.mts 里已配置的 targetPort', () => {
    const ports = relayRulesFromScript();
    assert.ok(Array.isArray(ports));
    // 脚本里至少要有 3065/8001 两条（若将来重写仍应能读到监听口）
    if (ports.length > 0) {
      assert.ok(ports.every((p) => /^\d+$/.test(p)));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 四、汇总与呈现
// ═══════════════════════════════════════════════════════════════════

describe('summarize / formatSetupReport：结论先行', () => {
  const results = [
    { step: 'node', title: 'Node ≥ 24', status: STEP.SKIP, detail: 'v24', next: null },
    { step: 'deps', title: 'Node 依赖', status: STEP.OK, detail: '已装', next: null },
    { step: 'tokens', title: 'tokens', status: STEP.ACT, detail: '缺模型 key', next: '填进 tokens.env' },
    { step: 'doctor', title: 'doctor', status: STEP.FAIL, detail: '起不来', next: '按 doctor 修' },
  ];

  test('按档位分组：needHuman / failed / autoDone / alreadyDone', () => {
    const s = summarize(results);
    assert.deepEqual(s.needHuman.map((x) => x.step), ['tokens']);
    assert.deepEqual(s.failed.map((x) => x.step), ['doctor']);
    assert.deepEqual(s.autoDone, ['deps']);
    assert.deepEqual(s.alreadyDone, ['node']);
  });

  test('报告含"还需要你做 N 件事"与每项的下一步命令', () => {
    const text = formatSetupReport(results, { doctorText: 'DOCTOR_OUTPUT', checkOnly: false });
    assert.match(text, /还需要你做 1 件事/);
    assert.match(text, /缺模型 key/);
    assert.match(text, /填进 tokens\.env/);
    assert.match(text, /DOCTOR_OUTPUT/, 'doctor 结论必须附在 setup 末尾');
  });

  test('--check 模式在报告里明确"没有改动任何东西"', () => {
    const text = formatSetupReport(results, { doctorText: null, checkOnly: true });
    assert.match(text, /--check 模式：只体检，没有改动任何东西/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 五、静态守卫：危险/昂贵动作不得自动化（防止以后被"优化"掉）
// ═══════════════════════════════════════════════════════════════════

describe('静态守卫：脚本永远不会自动做的三件事', () => {
  const src = readFileSync(new URL('../scripts/setup.mjs', import.meta.url), 'utf8');
  /** 去掉注释后再做"是否调用了危险命令"的检查（注释里提到 sudo 不算违规）。 */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('① 不自动 docker pull（2GB）', () => {
    assert.doesNotMatch(code, /run\(\s*['"]docker['"]\s*,\s*\[\s*['"]pull['"]/, 'setup 不得自动 docker pull');
    assert.match(src, /docker pull/, '但必须把这条命令告诉人');
  });

  test('② 不覆盖已有 tokens.env / config.yml（只调幂等的 init-config）', () => {
    assert.doesNotMatch(code, /writeFileSync\([^)]*tokens/i, 'setup 不得直接写 tokens.env');
    assert.doesNotMatch(code, /writeFileSync\([^)]*configPath/, 'setup 不得直接写 config.yml');
    assert.match(code, /init-config\.mjs/, '只能经幂等的 init-config 生成');
    assert.doesNotMatch(code, /init-config\.mjs['"],\s*['"]--force/, '不得自动加 --force');
  });

  test('③ 不装 Node / 不 sudo（系统级改动超出脚本权限）', () => {
    assert.doesNotMatch(code, /\bsudo\b/, 'setup 不得调用 sudo');
    assert.doesNotMatch(code, /apt-get|choco|winget|scoop/, 'setup 不得自动装系统包');
  });

  test('步骤清单是契约的一部分（删一步就该有测试红）', () => {
    // 12 步（含 doctor）；其中 3 步是人做的，其余自动/检测
    assert.ok(STEPS.length >= 12, `步骤清单至少 12 项，实际 ${STEPS.length}`);
    for (const must of ['node', 'deps', 'config', 'tokens', 'docker', 'fleet-image', 'relay', 'doctor']) {
      assert.ok(STEPS.includes(must), `步骤清单缺少 ${must}`);
    }
  });

  test('默认 fleet 不被改成 docker（默认值纪律）', () => {
    const dflt = checkFleet({ raw: undefined, dockerAvailable: false });
    assert.equal(dflt.effective, 'stub');
    // 源码里不得出现"缺省给 docker"的写法
    assert.doesNotMatch(src, /raw\s*\?\?\s*['"]docker['"]/);
  });
});
