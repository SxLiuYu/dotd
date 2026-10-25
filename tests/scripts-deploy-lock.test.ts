/**
 * tests/scripts-deploy-lock.test.ts —— 部署与看门狗不许互相拆台。
 *
 * 现场（2026-10-26 01:20 那次部署）：
 *
 *     [deploy] SIGTERM supervisor+daemon: 645338 645381
 *     [deploy] 30s 还没退，SIGKILL: 651311 651382
 *     [deploy] 启动 daemon（DOTD_REPO_DIR=/root/dotd）
 *
 * 一开始怀疑是 uvicorn 关不掉，单独验了 SIGTERM：`rc=-15 in 1.3s`，退得很干净。
 * 真正的原因在另两边：
 *   - `wsl-deploy.sh` 的重启段是「TERM → 等退干净 → 起新的」，中间若干秒 7788
 *     **故意**不通；
 *   - crontab 每 2 分钟跑 `/usr/local/bin/dotd-watchdog.sh`，它的 `repair_daemon()`
 *     只要 7788 不通就 `setsid bash scripts/dotd-daemon-start.sh`。
 *
 * 于是部署窗口里 watchdog 拉起**第二份 supervisor**，和部署脚本即将启动的那份
 * 抢 8000/7788；部署脚本的收尾 pgrep 再把它 SIGKILL 掉，活下来的孤儿跑的是旧代码。
 * 证据：`/tmp/dotd-wsl.log.prev` 里 `===== 启动 2026-10-26 01:20:01 =====` **出现两次**
 * （同一秒），以及 `[one-system] dotd restarted（累计 2 次）`。
 *
 * 这里守住四件事：
 *   ① 部署窗口有锁，且锁一定被释放（正常退出、失败退出都释放）；
 *   ② watchdog 在锁新鲜时**不自愈**，但检测/告警照旧（部署真挂了仍要报）；
 *   ③ 两条启动路径都不能起第二个实例（flock 单实例闸门）；
 *   ④ 自愈里不得再引用不存在的脚本（`wsl-daemon-start.sh` 从来就没有过，
 *      `repair_container` 的第二条路径因此一直 exit 127，日志里却像"试过了"）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

const DEPLOY = read('scripts/wsl-deploy.sh');
const WATCHDOG = read('scripts/dotd-watchdog.sh');
const DAEMON = read('scripts/wsl-daemon.sh');

/** 去掉注释，避免"注释里提到某命令"被当成真的调用了。 */
const stripComments = (src: string): string =>
  src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('① 部署窗口锁：写下来，并且一定会被释放', () => {
  test('重启段之前就写 deploy.lock（不是之后）', () => {
    const lockAt = DEPLOY.indexOf('deploy.lock');
    assert.ok(lockAt > 0, 'wsl-deploy.sh 必须提到 deploy.lock');
    const pidsAt = DEPLOY.indexOf("pgrep -f 'voice\\.integration\\.one_system|src/daemon\\.ts'", DEPLOY.indexOf('# ── 5.'));
    assert.ok(pidsAt > lockAt, '锁必须在第一次 pgrep/kill 之前写好，否则窗口已经敞开了');
  });

  test('trap EXIT 释放：正常结束、中途 exit 4/5/6 都走同一条路', () => {
    assert.match(DEPLOY, /trap\s+'rm -f "\$DEPLOY_LOCK"'\s+EXIT/, '必须用 trap EXIT 删锁');
    // 失败分支是 `exit 4` / `exit 5` 这类普通退出，EXIT trap 会跑到；
    // 但 SIGKILL 不会 —— 那种情况靠 watchdog 侧的 TTL 兜底（见 ②）。
    assert.doesNotMatch(DEPLOY, /trap\s+.*\bKILL\b/, 'trap 不用管 KILL（也管不了）');
  });

  test('锁文件放在 ~/.dotd（和 live 状态同处），并先建目录', () => {
    assert.match(DEPLOY, /DEPLOY_LOCK="\$HOME\/\.dotd\/deploy\.lock"/);
    const lockAt = DEPLOY.indexOf('date +%s > "$DEPLOY_LOCK"');
    const mkdirAt = DEPLOY.lastIndexOf('mkdir -p "$HOME/.dotd"', lockAt);
    assert.ok(mkdirAt > 0, '写锁之前要 mkdir -p，否则首次部署写不进去');
  });

  // ── 真跑：锁到底会不会在失败退出时被删掉 ─────────────────────────
  //
  // 只断言 `trap ... EXIT` 存在是不够的 —— bash 的 trap 在 `exit 4`、在命令失败
  // 导致 `set -e` 退出、在脚本自然结束时都会触发，但**语法写错就一条都不触发**。
  // 这里把部署脚本里那三行原样切出来，分别在两种出口下跑，看锁的存亡。
  const bashOk2 = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).status === 0;
  const posix2 = (p: string): string => p.replace(/\\/g, '/');

  function lockBlock(): string {
    const start = DEPLOY.indexOf('DEPLOY_LOCK="$HOME/.dotd/deploy.lock"');
    const end = DEPLOY.indexOf('PIDS="$(pgrep', start);
    assert.ok(start > 0 && end > start, '切不出部署锁段（脚本结构变了？）');
    return DEPLOY.slice(start, end);
  }

  test('部署正常收尾 → 锁被删掉（watchdog 立刻能兜底）', { skip: bashOk2 ? false : '本机没有 bash' }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-deploy-'));
    const home = posix2(join(tmp, 'home'));
    const r = spawnSync(
      'bash',
      ['-c', ['set -euo pipefail', 'log() { :; }', `mkdir -p "${home}"`, lockBlock(), 'test -f "$DEPLOY_LOCK" && echo LOCK_WRITTEN', 'exit 0'].join('\n')],
      { encoding: 'utf8', env: { ...process.env, HOME: home } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOCK_WRITTEN/, '脚本跑到那一步时锁必须已经落盘');
    assert.equal(existsSync(join(tmp, 'home/.dotd/deploy.lock')), false, '退出后锁必须没了');
  });

  test('部署中途失败退出（exit 5）→ 锁同样被删掉', { skip: bashOk2 ? false : '本机没有 bash' }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-deploy-'));
    const home = posix2(join(tmp, 'home'));
    const r = spawnSync(
      'bash',
      ['-c', ['set -euo pipefail', 'log() { :; }', `mkdir -p "${home}"`, lockBlock(), 'exit 5'].join('\n')],
      { encoding: 'utf8', env: { ...process.env, HOME: home } },
    );
    assert.equal(r.status, 5, '退出码要原样传出去（部署失败就得失败）');
    assert.equal(existsSync(join(tmp, 'home/.dotd/deploy.lock')), false, '失败路径也必须释放锁');
  });

  test('部署被 SIGKILL → 锁会残留（所以 watchdog 侧必须有 TTL）', {
    // Windows 的 Git-Bash 没有真 SIGKILL：`kill -9 $$` 在 MSYS 里可能既不返回也不
    // 结束进程，本机实测这条会挂住整个测试文件。只在 POSIX 上跑。
    skip: bashOk2 && process.platform !== 'win32' ? false : 'POSIX-only（Windows 无真 SIGKILL）',
  }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-deploy-'));
    const home = posix2(join(tmp, 'home'));
    // kill -9 自己：trap EXIT 不会跑，这正是 TTL 存在的理由
    const r = spawnSync(
      'bash',
      ['-c', ['set -euo pipefail', 'log() { :; }', `mkdir -p "${home}"`, lockBlock(), 'kill -9 $$'].join('\n')],
      { encoding: 'utf8', env: { ...process.env, HOME: home } },
    );
    assert.equal(r.status === null || r.signal === 'SIGKILL', true, `预期被信号杀掉，实际 rc=${r.status}`);
    assert.equal(
      existsSync(join(tmp, 'home/.dotd/deploy.lock')),
      true,
      'SIGKILL 后锁一定在 —— 这条断言是"watchdog 必须有 TTL"的证据',
    );
  });
});

describe('② watchdog：锁新鲜时不自愈，但仍然检测和告警', () => {
  test('有 deploy_in_progress 且带 TTL（不是"有锁就永远不修"）', () => {
    assert.match(WATCHDOG, /deploy_in_progress\(\)/, '需要这个判定函数');
    assert.match(WATCHDOG, /LOCK_TTL=\d+/, 'TTL 必须显式，防部署被 SIGKILL 后永久关闭自愈');
    assert.match(WATCHDOG, /LOCK_FILE=.*deploy\.lock/);
  });

  test('TTL 是有限秒数，且语义是"age < TTL"', () => {
    const m = /LOCK_TTL=(\d+)/.exec(WATCHDOG);
    assert.ok(m, '读不到 LOCK_TTL');
    const ttl = Number(m[1]);
    assert.ok(ttl >= 60 && ttl <= 1800, `TTL 应在 1~30 分钟内（实际 ${ttl}），太短挡不住部署、太长会延误真故障`);
    assert.match(WATCHDOG, /age.*-lt.*LOCK_TTL|LOCK_TTL.*-gt.*age/, '判据必须是"锁还新鲜"，不是"锁存在"');
    assert.match(WATCHDOG, /date \+%s/, '要按秒算年龄');
  });

  test('非数字/缺失内容不当事（读到空文件不能让自愈停摆）', () => {
    assert.match(WATCHDOG, /\[\]|\*\[!0-9\]\*/, '必须显式排除空值和非数字');
  });

  test('四个自愈入口都被闸门挡住', () => {
    const code = stripComments(WATCHDOG);
    const sites = [
      'repair_daemon',
      'repair_docker',
      'repair_container',
      'repair_relay',
    ];
    for (const fn of sites) {
      const call = new RegExp(`if ! c_\\w+; then may_repair && \\{ ${fn} \\|\\| true; \\}; fi`);
      // 容器那条注释里写的是"不等告警阈值"，调用形态一致
      assert.match(code, call, `${fn} 的调用点必须经 may_repair`);
    }
  });

  test('check 调用不被闸门包住（部署期间照样累计失败、照样告警）', () => {
    const code = stripComments(WATCHDOG);
    for (const name of ['daemon', 'docker', 'container', 'relay']) {
      const re = new RegExp(`^check ${name}\\s`, 'm');
      assert.match(code, re, `check ${name} 必须无条件执行 —— 部署真挂了要能报警`);
    }
  });

  test('跳过自愈时写一行日志（事后能解释"为什么没修"）', () => {
    assert.match(WATCHDOG, /logline "自愈:部署进行中/, '静默跳过会让下次排障又回到猜');
  });
});

describe('③ 两条启动路径都不能起第二个实例', () => {
  test('wsl-daemon.sh 用 flock 单实例，拿不到锁就静默退出 0', () => {
    assert.match(DAEMON, /flock -n 9/, '必须用 flock（pidfile 有陈旧 pid 的坑，见脚本注释）');
    assert.match(DAEMON, /exec 9>/, '锁要绑在 fd 上，进程一死自动释放');
    const idx = DAEMON.indexOf('flock -n 9');
    const tail = DAEMON.slice(idx, idx + 400);
    assert.match(tail, /exit 0/, '拿不到锁是"已经有实例"，不是错误 —— exit 0');
  });

  test('锁在日志归档之前拿（否则两份都会 truncate 同一个日志）', () => {
    const lockAt = DAEMON.indexOf('flock -n 9');
    const logAt = DAEMON.indexOf(': > "$LOG"');
    assert.ok(lockAt > 0 && logAt > 0);
    assert.ok(lockAt < logAt, 'flock 必须在 `: > $LOG` 之前，否则后到的那份会把在写的日志清空');
  });

  test('锁文件是固定的绝对路径（不同 cwd/用户下也要互斥）', () => {
    assert.match(DAEMON, /LOCK=\/tmp\/dotd-one-system\.lock/, '不能用相对路径或 $PWD');
  });

  // ── 真跑：从脚本里切出闸门那几行，换成临时锁路径 ──────────────────
  //
  // 为什么不整跑 wsl-daemon.sh：它会 source 凭据、拷 config、检查内存、最后 exec
  // supervisor —— 那是在测部署，不是在测闸门。这里只切闸门，路径做一次替换。
  const bashOk = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).status === 0;
  const skip = bashOk ? false : '本机没有 bash';
  /**
   * bash 的**绝对路径**：下面有一例要传一个不含任何命令的 PATH，用 `'bash'` 会
   * 找不到自己（Windows 上 Node 也会按子进程的 PATH 查找）。Windows 里 `/usr/bin/bash`
   * 这种 MSYS 路径 Node 不认，要先 cygpath -w 换回盘符形式。
   */
  const BASH = (
    spawnSync('bash', ['-c', 'cygpath -w "$(command -v bash)" 2>/dev/null || command -v bash'], {
      encoding: 'utf8',
    }).stdout ?? ''
  ).trim();

  /** bash 只认正斜杠：Windows 的 temp 路径带反斜杠，直接插进脚本会被当转义符。 */
  const posix = (p: string): string => p.replace(/\\/g, '/');

  /** 本机有没有 flock（Windows Git-Bash 没有；WSL/CI 有）。 */
  const hasFlock =
    (spawnSync(BASH || 'bash', ['-c', 'command -v flock'], { encoding: 'utf8' }).stdout ?? '').trim().length > 0;

  function gateBlock(lockPath: string): string {
    const start = DAEMON.indexOf('LOCK=/tmp/dotd-one-system.lock');
    const end = DAEMON.indexOf('LOG=/tmp/dotd-wsl.log');
    assert.ok(start > 0 && end > start, '切不出单实例闸门段（脚本结构变了？）');
    return DAEMON.slice(start, end).replace('/tmp/dotd-one-system.lock', lockPath);
  }

  function runGate(lockPath: string, pathEnv: string): { rc: number; out: string } {
    const r = spawnSync(
      BASH || 'bash',
      ['-c', [gateBlock(lockPath), 'echo CONTINUED'].join('\n')],
      { encoding: 'utf8', env: { ...process.env, PATH: pathEnv } },
    );
    return { rc: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}` };
  }

  test('另一进程持锁 → 本次不启动，stderr 说明原因', {
    // Windows 的 Git-Bash **没有 flock**（本机实测 `command -v flock` 为空），
    // 而 live/CI 都是 Linux（WSL、ubuntu-latest）。没有 flock 时这条测不了，
    // 也不该假装测过；降级路径另有专门一例。
    skip: skip || (hasFlock ? false : '本机没有 flock（Windows Git-Bash），CI/Linux 上会跑'),
  }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-gate-'));
    const lock = posix(join(tmp, 'one.lock'));
    const script = [
      'set -uo pipefail',
      `bash -c 'exec 9>"${lock}"; flock -n 9; sleep 1.5' &`,
      'holder=$!',
      'sleep 0.4',
      gateBlock(lock),
      'echo CONTINUED',
      'wait $holder 2>/dev/null || true',
    ].join('\n');
    const r = spawnSync(BASH || 'bash', ['-c', script], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0, `拿不到锁不是错误（另一份在跑），必须 exit 0；实际 ${r.status}: ${out}`);
    assert.match(out, /已有实例持锁/, '要说清为什么没起');
    assert.doesNotMatch(out, /CONTINUED/, '闸门必须 exit，不能继续往下起服务');
  });

  test('没有 flock 命令 → 放行（宁可少一层保护，也不能永远起不来）', { skip }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-gate-'));
    const lock = posix(join(tmp, 'one.lock'));
    const emptyBin = posix(join(tmp, 'bin'));
    mkdirSync(emptyBin, { recursive: true });
    const { rc, out } = runGate(lock, emptyBin);
    assert.equal(rc, 0, `降级路径必须能启动；实际 rc=${rc}: ${out}`);
    assert.match(out, /没有 flock/, '要留一行说明降级了');
    assert.match(out, /CONTINUED/, '没有 flock 时必须继续启动 —— 否则 daemon 永久起不来');
  });
});

describe('④ 自愈不得引用不存在的脚本', () => {
  test('repair_container 的 fleet 重建走 dotd-daemon-start.sh', () => {
    assert.match(WATCHDOG, /bash scripts\/dotd-daemon-start\.sh/, '真正的启动器是它');
    const scriptsDir = join(REPO, 'scripts');
    assert.ok(
      existsSync(join(scriptsDir, 'dotd-daemon-start.sh')),
      'dotd-daemon-start.sh 必须存在（否则自愈是假的）',
    );
  });

  test('全仓库的 shell 脚本里不再有 wsl-daemon-start.sh（从来没存在过）', () => {
    assert.doesNotMatch(
      stripComments(WATCHDOG),
      /wsl-daemon-start\.sh/,
      '这个文件名不存在，调用必然 exit 127',
    );
  });
});

describe('④b 配置对齐必须改「源」，不是改产物', () => {
  // 现场（2026-10-26 部署）：日志写着
  //     [align] expected_user_version 50 → 90（db.expected_user_version，第 47 行）
  //     [align] 已写入 /root/.dotd/config.yml（备份 …）
  // 部署完 grep 到的却仍是 50、telegram 段也还在。
  //
  // 因为 `wsl-daemon.sh` §3 每次启动都 `cp _config_src.yml ~/.dotd/config.yml`：
  // 真正的 live 配置源是 `_config_src.yml`（git 不跟踪），`~/.dotd/config.yml`
  // 只是它的产物。只对齐产物 = 下一次启动就被抹掉，而日志一路说"已写入"。
  test('部署脚本对 _config_src.yml 也做对齐（否则改完就丢）', () => {
    const code = stripComments(DEPLOY);
    // 对齐目标是这两处：源（下次启动不会被抹掉）+ 产物（本次启动前生效）。
    const loop = /for cfg in ([^\n]+);\s*do/.exec(code);
    assert.ok(loop !== null, '应当有一圈"逐个对齐"的 for 循环');
    assert.match(loop[1]!, /"\$DST\/_config_src\.yml"/, '必须对齐源文件 _config_src.yml');
    assert.match(loop[1]!, /"\$HOME\/\.dotd\/config\.yml"/, '也要对齐产物（本次启动前就生效）');
    assert.match(
      code,
      /align-live-config\.mts[^\n]*--config "\$cfg"/,
      '循环里要真的调用 align',
    );
  });

  test('启动器确实会覆盖产物 —— 所以"只改产物"一定被抹掉', () => {
    // 这条钉住的是**为什么**要改源：只要这行还在，只改产物就是白工。
    // 哪天启动器不再 cp 了，这条会红，那时可以重新讨论。
    assert.match(
      stripComments(DAEMON),
      /cp _config_src\.yml "\$HOME\/\.dotd\/config\.yml"/,
      'wsl-daemon.sh 每次启动都用 _config_src.yml 覆盖产物',
    );
  });

  test('rsync 不同步 `_*`（源文件是部署机私有状态，不能被 --delete 掉）', () => {
    // 用 includes 而不是正则：这里的字面量本身带 `*`，正则转义容易写成
    // "一个或多个反斜杠"（第一版就是那么错的，测试红得莫名其妙）。
    assert.ok(
      DEPLOY.includes("--exclude '_*'"),
      '少了这条，部署会删掉 _tokens_src.env / _config_src.yml',
    );
  });

  // 同一次部署踩到的第二层：`node --import tsx` 按 **cwd** 解析 tsx。
  // 部署是从 /mnt/d/dotd 跑的，那里 node_modules 是 Windows 装的 → esbuild 加载
  // win32 二进制 → TransformError。后面挂着 `|| true`，于是失败**一行日志都没有**，
  // 部署继续，而"对齐"从来没跑过。（当时的现象：日志里有 [align] 已写入，
  // 那是上一版留下的；这一版连那行都没有。）
  test('对齐必须在 $DST 里跑（cwd 决定 tsx/esbuild 用哪套二进制）', () => {
    const code = stripComments(DEPLOY);
    assert.match(
      code,
      /\(cd "\$DST" && node --import tsx \.\/scripts\/align-live-config\.mts/,
      '必须 cd 到 Linux 那份部署目录再跑',
    );
  });

  test('对齐失败不许静默：要打出来并以非零退出', () => {
    const code = stripComments(DEPLOY);
    const alignBlock = code.slice(code.indexOf('align-live-config.mts') - 400, code.indexOf('align-live-config.mts') + 400);
    assert.doesNotMatch(alignBlock, /\|\| true/, '`|| true` 会把配置漂移藏起来');
    assert.match(alignBlock, /exit 7/, '对齐失败要拦住重启');
  });
});

describe('④c 启动器找不到 Python 时必须说话，不能 exec 空串', () => {
  // 现场（2026-10-26 排查链的最后一环）：`PY="$(command -v python3)"` 在 python3
  // 也不存在时得到空串，下一行变成 `exec "" …`，报
  //     /path/wsl-daemon.sh: line 147: : not found
  // 看起来像脚本语法坏了。真相是"这台机器没装 python3"。
  test('PY 为空/不可执行时 exit 1 并给出安装命令', () => {
    const code = stripComments(DAEMON);
    // 必须显式判空，而不是只判 command -v 的结果
    assert.match(code, /if \[ -z "\$PY" \] \|\| \[ ! -x "\$PY" \]/, '要同时判空与可执行');
    assert.match(code, /找不到 Python/, '要说人话');
    assert.match(code, /apt install python3/, '要给安装命令');
    // 判据必须在 exec 之前
    const gateAt = code.indexOf('找不到 Python');
    const execAt = code.indexOf('exec "$PY"');
    assert.ok(gateAt > 0 && execAt > gateAt, '闸门要在 exec 之前');
  });

  test('真跑：PATH 里没有 python3 且没有 .venv → 闸门触发（不是 exec 空串）', () => {
    // 把闸门那段原样切出来跑（不手抄判据）。
    const src = read('scripts/wsl-daemon.sh');
    const start = src.indexOf('PY="$PWD/.venv/bin/python"');
    const end = src.indexOf('exec "$PY"');
    assert.ok(start > 0 && end > start, '切片锚点找不到');
    const body = src.slice(start, end);
    const dir = mkdtempSync(join(tmpdir(), 'dotd-py-'));
    try {
      writeFileSync(join(dir, 'snippet.sh'), `set -u
${body}
exit 0
`, 'utf8');
      const r = spawnSync('bash', [join(dir, 'snippet.sh')], {
        encoding: 'utf8',
        cwd: dir, // 没有 .venv
        env: { PATH: '/nonexistent-py-test', HOME: dir },
        // Windows 上 bash 找不到时给个明确的 skip 而不是假红
      });
      if (r.error !== undefined) return; // 没有可用的 bash：跳过（CI 的 Linux 会跑）
      assert.equal(r.status, 1, `应当 exit 1，实际 ${r.status}；stderr=${r.stderr}`);
      assert.match(r.stderr, /找不到 Python/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('④d 运行期 mcp-servers.yml 是主人的声明，重启不许静默改回模板', () => {
  // 现场（2026-10-26）：`wsl-daemon.sh` 每次启动都 `cp -f config/*.yml ~/.dotd/`，
  // 注释理由是"这些文件本就是 ${ENV} 占位驱动，不含环境事实"。
  // 但 mcp-servers.yml **不成立**：它写的是主人决定接哪些外部程序。而文档教人的
  // 启用方式正是"把 voice 示例放到 ~/.dotd/mcp-servers.yml" —— 无脑覆盖会在下一次
  // 重启把这份决定静默改回 `servers: []`，日志里一个字都没有。
  const loop = (() => {
    const code = stripComments(DAEMON);
    const start = code.indexOf('for f in config/*.yml; do');
    assert.ok(start > 0, '找不到"逐个刷新配置"的循环（锚点变了就更新这条测试）');
    const end = code.indexOf('\ndone', start);
    assert.ok(end > start, '循环没有收尾');
    return code.slice(start, end + '\ndone'.length);
  })();

  test('mcp-servers.yml 只在缺失时播种（不是每次 cp -f）', () => {
    assert.match(loop, /mcp-servers\.yml\)/, '循环里要有针对它的分支');
    const branch = loop.slice(loop.indexOf('mcp-servers.yml)'));
    assert.match(branch, /\[\s*!?\s*-f\s+"\$HOME\/\.dotd\/\$base"\s*\]/i, '要先判存在');
  });

  test('真跑：已有运行期声明 → 不覆盖；缺失 → 播种；其余文件照常刷新', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotd-daemon-cfg-'));
    try {
      const repo = join(dir, 'repo');
      const home = join(dir, 'home');
      mkdirSync(join(repo, 'config'), { recursive: true });
      mkdirSync(join(home, '.dotd'), { recursive: true });
      writeFileSync(join(repo, 'config', 'models.yml'), 'endpoints: []\n');
      writeFileSync(join(repo, 'config', 'mcp-servers.yml'), 'servers: []\n');
      writeFileSync(join(repo, 'config', 'mcp-servers.voice.yml'), 'servers: []\n');
      writeFileSync(join(repo, 'config', 'dotd.yml'), '# init-config 模板\n');
      // 运行期那份是主人写好的
      writeFileSync(join(home, '.dotd', 'mcp-servers.yml'), 'servers:\n  - name: mine\n    command: node\n');
      // models.yml 是旧内容 → 必须被刷新
      writeFileSync(join(home, '.dotd', 'models.yml'), 'stale\n');

      writeFileSync(join(dir, 'snippet.sh'), `${loop}\n`, 'utf8');
      const r = spawnSync('bash', [join(dir, 'snippet.sh')], {
        encoding: 'utf8',
        cwd: repo,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      });
      if (r.error !== undefined) return; // 没有 bash：跳过
      assert.equal(r.status, 0, `片段失败：${r.stderr}`);

      assert.equal(
        readFileSync(join(home, '.dotd', 'mcp-servers.yml'), 'utf8'),
        'servers:\n  - name: mine\n    command: node\n',
        '主人声明的 MCP server 不能被重启抹掉',
      );
      assert.equal(readFileSync(join(home, '.dotd', 'models.yml'), 'utf8'), 'endpoints: []\n', '其余配置照常刷新');
      assert.ok(existsSync(join(home, '.dotd', 'mcp-servers.voice.yml')), '缺失的要播种');
      assert.ok(!existsSync(join(home, '.dotd', 'dotd.yml')), 'init-config 模板不该进运行期目录');
      assert.match(r.stdout, /保留运行期/, '漂移要被说出来，不能无声');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺失时播种，并且日志说清"从模板来的"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotd-daemon-cfg2-'));
    try {
      const repo = join(dir, 'repo');
      const home = join(dir, 'home');
      mkdirSync(join(repo, 'config'), { recursive: true });
      mkdirSync(join(home, '.dotd'), { recursive: true });
      writeFileSync(join(repo, 'config', 'mcp-servers.yml'), 'servers: []\n');
      writeFileSync(join(dir, 'snippet.sh'), `${loop}\n`, 'utf8');
      const r = spawnSync('bash', [join(dir, 'snippet.sh')], {
        encoding: 'utf8',
        cwd: repo,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      });
      if (r.error !== undefined) return;
      assert.equal(r.status, 0, `片段失败：${r.stderr}`);
      assert.equal(readFileSync(join(home, '.dotd', 'mcp-servers.yml'), 'utf8'), 'servers: []\n');
      assert.match(r.stdout, /首次播种/, '要说清这次是从模板来的');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('⑤ 语法闸门：三个脚本必须能被 bash 解析', () => {
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  const hasBash = bash.status === 0;

  for (const rel of ['scripts/wsl-deploy.sh', 'scripts/dotd-watchdog.sh', 'scripts/wsl-daemon.sh']) {
    test(`${rel} 过 bash -n`, { skip: hasBash ? false : '本机没有 bash' }, () => {
      const r = spawnSync('bash', ['-n', join(REPO, rel)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `bash -n ${rel} 失败：${r.stderr}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑦ 看门狗是两份文件：仓库里那份必须跟着部署一起对齐
//
// 现场（2026-10-26）：`/usr/local/bin/dotd-watchdog.sh` 与仓库里的只差一行 ——
// relay 自愈的工作目录。live 那份 10-25 手工改成了 `D:\dotd`，仓库里还写着早已
// 不存在的 `D:\toagi\dotd`。这意味着**按仓库重装一次 watchdog 就会把自愈改回坏的**，
// 而且改了以后没有任何门禁会红。所以：部署时对齐两份，仓库里也不许再留旧路径。
// ═══════════════════════════════════════════════════════════════════

describe('⑦ watchdog 两份拷贝必须对齐', () => {
  test('部署脚本会把它 install 到 /usr/local/bin（幂等：cmp 相同就不动）', () => {
    assert.match(DEPLOY, /WD_DST=\/usr\/local\/bin\/dotd-watchdog\.sh/);
    assert.match(DEPLOY, /cmp -s "\$WD_SRC" "\$WD_DST"/, '内容一致时不该重写（避免无谓 mtime 变化）');
    assert.match(DEPLOY, /install -m 755 "\$WD_SRC" "\$WD_DST"/, '不一致才装，且保持可执行位');
  });

  test('没有 root 时不静默假装成功', () => {
    assert.match(DEPLOY, /无权写 \$WD_DST/, '要明确说 watchdog 还是旧版');
  });

  test('crontab 只在缺失时提醒，不自动改（机器级状态得人拍板）', () => {
    assert.match(DEPLOY, /crontab -l[^|]*\|[^\n]*grep -q 'dotd-watchdog/);
    // 只看**命令位置**的 crontab（行首或 `$( ... )` 里）：
    // 提示文案里出现"crontab 里没有 …"不算调用。
    const cmds = [...DEPLOY.matchAll(/(?:^|\$\(|\|\|?\s*|&&\s*)\s*crontab\b([^\n]*)/gm)].map((m) => m[1] ?? '');
    for (const args of cmds) {
      assert.match(args, /^\s+-l\b/, `只允许 crontab -l（读）；发现 crontab${args}`);
    }
  });

  test('仓库里的 relay 自愈不再指向 D:\\toagi\\dotd', () => {
    const code = stripComments(WATCHDOG);
    assert.doesNotMatch(code, /toagi/, '旧仓库路径会让 relay 自愈每次都失败');
    assert.match(code, /-WorkingDirectory 'D:\\dotd'/, '必须指向现在的仓库位置');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ 真跑一遍判据（不是再读一遍文本）
//
// 前面几节只能证明"代码长这样"，证明不了"锁新鲜时真的不修、锁过期后真的修"。
// 这里把 watchdog 里那段锁函数**原样切出来**（不手抄，避免测的和跑的不是同一份），
// 在临时 HOME 下喂四种锁状态，看 may_repair 的返回值。
// ═══════════════════════════════════════════════════════════════════

describe('⑥ 判据真跑：锁的状态 → 是否允许自愈', () => {
  const bashOk = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).status === 0;
  const skip = bashOk ? false : '本机没有 bash';

  /** 从真实脚本里切出 LOCK_FILE…may_repair 这一段。 */
  function lockBlock(): string {
    const start = WATCHDOG.indexOf('LOCK_FILE=');
    const end = WATCHDOG.indexOf('# 自愈（2026-10-19）');
    assert.ok(start > 0 && end > start, '切不出锁函数段（脚本结构变了？）');
    return WATCHDOG.slice(start, end);
  }

  function runCase(lockContent: string | null, ageSec = 0): { rc: number; log: string } {
    const tmp = mkdtempSync(join(tmpdir(), 'dotd-lock-'));
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.dotd'), { recursive: true });
    if (lockContent !== null) {
      const stamp = lockContent === '${now}' ? String(Math.floor(Date.now() / 1000) - ageSec) : lockContent;
      writeFileSync(join(home, '.dotd', 'deploy.lock'), stamp);
    }
    const log = join(tmp, 'watchdog.log');
    // 只补 logline 的依赖（LOG 变量 + 函数），业务代码一行不改。
    const harness = [
      'set -uo pipefail',
      `LOG='${log.replace(/\\/g, '/')}'`,
      `logline() { printf '%s %s\\n' "$(date '+%F %T')" "$*" >>"$LOG"; }`,
      lockBlock(),
      'if may_repair; then echo REPAIR_ALLOWED; else echo REPAIR_BLOCKED; fi',
    ].join('\n');
    const r = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { rc: r.status ?? -1, log: `${r.stdout}${logText}` };
  }

  test('锁新鲜（刚写）→ 不许自愈，并且日志说明原因', { skip }, () => {
    const { rc, log } = runCase('${now}');
    assert.equal(rc, 0);
    assert.match(log, /REPAIR_BLOCKED/, '部署窗口里 watchdog 不能抢着起进程');
    assert.match(log, /自愈:部署进行中/, '要留一行"为什么没修"');
  });

  test('锁过期（TTL 之后）→ 恢复自愈，不会把看门狗永久关掉', { skip }, () => {
    const ttl = Number(/LOCK_TTL=(\d+)/.exec(WATCHDOG)?.[1] ?? 300);
    const { rc, log } = runCase('${now}', ttl + 30);
    assert.equal(rc, 0);
    assert.match(log, /REPAIR_ALLOWED/, `锁超过 ${ttl}s 必须失效（部署被 SIGKILL 时靠这个兜底）`);
    assert.doesNotMatch(log, /部署进行中/);
  });

  test('没有锁文件 → 自愈（正常运行时的默认）', { skip }, () => {
    const { rc, log } = runCase(null);
    assert.equal(rc, 0);
    assert.match(log, /REPAIR_ALLOWED/);
  });

  test('锁文件是垃圾内容/空 → 当成没锁（宁可修，也不静默躺平）', { skip }, () => {
    for (const junk of ['', 'not-a-number', '   ']) {
      const { rc, log } = runCase(junk);
      assert.equal(rc, 0, `内容 ${JSON.stringify(junk)} 不该让脚本崩`);
      assert.match(log, /REPAIR_ALLOWED/, `内容 ${JSON.stringify(junk)} 应视为没锁`);
    }
  });
});
