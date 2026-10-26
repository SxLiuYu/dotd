/**
 * tests/scripts-daemon-restart.test.ts —— 「重启 daemon」必须真的重启，且新进程真的拿到了环境。
 *
 * 现场（2026-10-26，同类缺陷第十一例）见 scripts/lib/daemon-restart.sh 头部。要点：
 *
 * ```
 * pkill -9 -f 'src/daemon.ts'                                  ← 杀的是子进程
 * DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh &  ← 锁还被 supervisor 持着
 *                                                              → 「已有实例持锁」exit 0
 * ```
 *
 * 两行都"成功"（第二行还带着 `&` 和 /dev/null），而**并发额度仍是旧值**，
 * 脚本接着打印「观察到最大并发 running = N」，N 与 2 无关。
 *
 * 这里把库的三条判据钉住：
 *   ① 托管模式下停的是 **supervisor**，不是它的子进程；
 *   ② 锁没空出来 / 启动命令什么都没起 → 非零失败，不许"起了就算"；
 *   ③ 声明的环境必须能从**运行中进程**的 /proc/<pid>/environ 读回，读不到就报变量名。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const LIB_SRC = join(REPO, 'scripts', 'lib', 'daemon-restart.sh');

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
const bashOk = BASH.status === 0;

const SUPERVISOR_ARGV = ['python', '-m', 'voice.integration.one_system', '--port', '8000'];
const DAEMON_ARGV = ['node', '--import', 'tsx', 'src/daemon.ts'];

/**
 * Git Bash 只认正斜杠和 MSYS 路径：任何塞进 bash 脚本里的路径都要转一次。
 * 第一版没转，`cd "C:\Users\…"` 直接失败 —— 测试自己成了"检查器找错地方"。
 */
const sh = (p: string) => p.replace(/\\/g, '/');

/** 假 /proc：每个 pid 一个目录，里面是 NUL 分隔的 cmdline / environ。 */
function fakeProc(root: string) {
  const put = (pid: number, argv: string[], env: Record<string, string> = {}) => {
    const d = join(root, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'cmdline'), argv.join('\0') + '\0', 'utf8');
    const envText = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0');
    writeFileSync(join(d, 'environ'), envText ? envText + '\0' : '', 'utf8');
  };
  return { put };
}

/** 临时仓库（库按 BASH_SOURCE 定位 repo_root，所以必须放成 scripts/lib/…）。 */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'dotd-drestart-'));
  const repo = join(root, 'repo');
  const proc = join(root, 'proc');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(proc, { recursive: true });
  writeFileSync(join(repo, 'scripts', 'lib', 'daemon-restart.sh'), readFileSync(LIB_SRC, 'utf8'), 'utf8');
  return {
    root,
    repo,
    proc,
    lib: join(repo, 'scripts', 'lib', 'daemon-restart.sh'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type World = ReturnType<typeof world>;

/**
 * 「停」的语义：给 supervisor 发 TERM 时，它的子进程随它一起消失
 * （真实现见 KernelSupervisor.stop → 停子进程）。写成一段 bash 注入各用例。
 */
function fakeStop(killLog: string): string {
  return [
    `daemon_kill() { echo "$1:$2" >> ${sh(JSON.stringify(killLog))};`,
    `  if grep -q one_system "$DOTD_PROC_ROOT/$1/cmdline" 2>/dev/null; then`,
    `    rm -rf "$DOTD_PROC_ROOT/$1"; for d in "$DOTD_PROC_ROOT"/*; do`,
    `      grep -q 'src/daemon.ts' "$d/cmdline" 2>/dev/null && rm -rf "$d"; done; return 0; fi;`,
    `  rm -rf "$DOTD_PROC_ROOT/$1"; return 0; }`,
    'daemon_alive() { [ -d "$DOTD_PROC_ROOT/$1" ]; }',
    'daemon_lock_free() { return 0; }',
  ].join('\n');
}

/** 启动命令做的一件事：在假 /proc 里"起"一个新进程（带指定环境）。 */
function fakeBoot(proc: string, pid: number, env: Record<string, string>): string {
  const d = `${sh(proc)}/${pid}`;
  const envText = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\\0');
  return [
    `mkdir -p ${d}`,
    `printf 'node\\0--import\\0tsx\\0src/daemon.ts\\0' > ${d}/cmdline`,
    `printf '${envText}\\0' > ${d}/environ`,
  ].join('\n') + '\n';
}

/**
 * 在临时仓库里跑一段 bash。
 *
 * 启动命令（`DAEMON_RESTART_START`）默认什么都不做 —— 测试里不能真起 daemon，
 * 但**必须让它真的被调用**，否则又回到"看起来跑了"。
 */
function run(
  w: World,
  body: string,
  opts: {
    fake?: (p: ReturnType<typeof fakeProc>) => void;
    start?: string;
    extra?: Record<string, string>;
  } = {},
) {
  const fp = fakeProc(w.proc);
  opts.fake?.(fp);
  const startPath = join(w.root, 'start.sh');
  writeFileSync(startPath, opts.start ?? ':\n', 'utf8');
  const script = `set -uo pipefail\ncd ${sh(JSON.stringify(w.repo))}\n. scripts/lib/daemon-restart.sh\n${body}\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
      DOTD_PROC_ROOT: sh(w.proc),
      DAEMON_RESTART_PORT: '0',
      DAEMON_RESTART_TIMEOUT: '6',
      DAEMON_RESTART_LOCK_WAIT: '2',
      DAEMON_RESTART_LOCK: sh(join(w.root, 'fake.lock')),
      DAEMON_RESTART_START: `sh ${sh(startPath)}`,
      DAEMON_RESTART_PROBE_CMD: '',
      ...opts.extra,
    },
  });
}

/** 所有"要重启 daemon"的脚本都得走这个库。 */
const CALLERS = [
  'ab-models.sh',
  'ab-rounds.sh',
  'ab-switch.sh',
  'model-ab.sh',
  'rebuild-image.sh',
  's2-restart.sh',
  'selftest-concurrency-race.sh',
  'selftest-container-fault.sh',
  'selftest-crash.sh',
  'selftest-model-down.sh',
  'selftest-restart.sh',
  'selftest-true-concurrency.sh',
  'verify-schedule.sh',
  'verify-vision-final.sh',
];

describe('① 分类：谁是 supervisor、谁是它的子进程', { skip: !bashOk }, () => {
  test('按 argv 精确区分，不会把 `-m voice.integration.one_system` 认成 daemon', () => {
    const w = world();
    try {
      const r = run(
        w,
        'echo "D=$(daemon_pids | tr \'\\n\' \' \')"; echo "S=$(daemon_supervisor_pids | tr \'\\n\' \' \')"',
        {
          fake: (p) => {
            p.put(101, SUPERVISOR_ARGV);
            p.put(102, DAEMON_ARGV);
            p.put(103, ['bash', 'scripts/wsl-daemon.sh']);
            p.put(104, ['node', 'dist/daemon.js']); // 构建产物形态（one_system 优先用它）
          },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /D=102 104 /, 'src/daemon.ts 与 dist/daemon.js 都要认');
      assert.match(r.stdout, /S=101 /, 'supervisor 只能是 one_system 那个');
    } finally {
      w.cleanup();
    }
  });
});

describe('② 托管模式：停 supervisor，而不是它的子进程', { skip: !bashOk }, () => {
  test('只对 supervisor 发 TERM；子进程由 supervisor 自己带走', () => {
    const w = world();
    try {
      const killLog = join(w.root, 'kills.log');
      const r = run(
        w,
        [fakeStop(killLog), 'daemon_restart DOTD_MAX_RUNNING=2 && echo REACHED_END'].join('\n'),
        {
          fake: (p) => {
            p.put(101, SUPERVISOR_ARGV);
            p.put(102, DAEMON_ARGV);
          },
          start: fakeBoot(w.proc, 205, { DOTD_MAX_RUNNING: '2' }),
        },
      );
      const kills = existsSync(killLog) ? readFileSync(killLog, 'utf8') : '';
      assert.equal(r.status, 0, r.stderr);
      assert.match(kills, /^101:TERM$/m, '必须对 supervisor 发 TERM');
      assert.doesNotMatch(kills, /^102:/m, '不许单独去杀子进程：supervisor 会用旧环境把它拉回来');
      assert.match(r.stdout, /新 daemon pid=205/);
      assert.match(r.stdout, /✓ DOTD_MAX_RUNNING=2（从 .*\/205\/environ 读回）/);
      assert.match(r.stdout, /REACHED_END/);
    } finally {
      w.cleanup();
    }
  });

  test('非托管（没有 supervisor）：才直接停那个 node 子进程', () => {
    const w = world();
    try {
      const killLog = join(w.root, 'kills.log');
      const r = run(
        w,
        [fakeStop(killLog), 'daemon_restart'].join('\n'),
        {
          fake: (p) => p.put(102, DAEMON_ARGV),
          start: fakeBoot(w.proc, 207, {}),
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(killLog, 'utf8'), /^102:TERM$/m);
      assert.match(r.stdout, /新 daemon pid=207/);
    } finally {
      w.cleanup();
    }
  });
});

describe('③ 起不来 / 锁没空 → 非零失败，不许"起了就算"', { skip: !bashOk }, () => {
  test('单实例锁还被持着：拒绝启动，并且一个进程都不碰', () => {
    const w = world();
    try {
      const marker = join(w.root, 'started.marker');
      const killLog = join(w.root, 'kills.log');
      const r = run(
        w,
        [
          fakeStop(killLog),
          'daemon_lock_free() { return 1; }', // 锁一直被持着（真实现：supervisor 的 flock）
          'daemon_restart DOTD_MAX_RUNNING=2 && echo SHOULD_NOT_PRINT',
        ].join('\n'),
        {
          fake: (p) => {
            p.put(101, SUPERVISOR_ARGV);
            p.put(102, DAEMON_ARGV);
          },
          start: `touch ${sh(JSON.stringify(marker))}\n`,
        },
      );
      assert.notEqual(r.status, 0, '锁没空出来必须失败');
      assert.doesNotMatch(r.stdout, /SHOULD_NOT_PRINT/);
      assert.match(r.stderr, /单实例锁 2s 内没释放/, '要说清卡在哪一步');
      assert.equal(existsSync(marker), false, '锁被占时不许再起一个（那正是 wsl-daemon.sh 静默 exit 0 的场景）');
    } finally {
      w.cleanup();
    }
  });

  test('启动命令什么都没起（模拟 wsl-daemon.sh exit 0）：超时失败并指向日志', () => {
    const w = world();
    try {
      const r = run(
        w,
        [fakeStop(join(w.root, 'kills.log')), 'daemon_restart && echo SHOULD_NOT_PRINT'].join('\n'),
        {
          fake: (p) => {
            p.put(101, SUPERVISOR_ARGV);
            p.put(102, DAEMON_ARGV);
          },
          start: 'exit 0\n', // 什么都没起，且"成功"退出
          extra: { DAEMON_RESTART_TIMEOUT: '2' },
        },
      );
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stdout, /SHOULD_NOT_PRINT/);
      assert.match(r.stderr, /2s 内没等到新的 daemon/, '不许静默：超时就是失败');
      assert.match(r.stderr, /dotd-wsl\.log/, '要告诉人去看哪里');
    } finally {
      w.cleanup();
    }
  });
});

describe('④ 读回：声明了但运行期没有 → 非零 + 报出变量名与实际值', { skip: !bashOk }, () => {
  test('新进程里是旧值 3 → 失败并指明 DOTD_MAX_RUNNING', () => {
    const w = world();
    try {
      const r = run(
        w,
        [fakeStop(join(w.root, 'kills.log')), 'daemon_restart DOTD_MAX_RUNNING=2 && echo SHOULD_NOT_PRINT'].join('\n'),
        {
          fake: (p) => {
            p.put(101, SUPERVISOR_ARGV);
            p.put(102, DAEMON_ARGV);
          },
          // 新进程带着**旧**环境起来 —— 正是"只杀了子进程、supervisor 用旧 env 拉回来"的现场
          start: fakeBoot(w.proc, 206, { DOTD_MAX_RUNNING: '3' }),
        },
      );
      assert.notEqual(r.status, 0, '环境没生效必须非零 —— 否则脚本接着用错误额度做实验');
      assert.doesNotMatch(r.stdout, /SHOULD_NOT_PRINT/);
      assert.match(r.stderr, /DOTD_MAX_RUNNING 没生效：运行期=3（期望 2）/);
      assert.match(r.stderr, /只杀了 node 子进程/, '要把最可能的成因说出来');
    } finally {
      w.cleanup();
    }
  });

  test('daemon_verify_env 可直接用（不重启也能验）', () => {
    const w = world();
    try {
      const r = run(
        w,
        'daemon_verify_env 301 A=1 B=2 && echo V_OK; daemon_verify_env 301 A=9 || echo V_BAD',
        { fake: (p) => p.put(301, ['node', 'x.js'], { A: '1', B: '2' }) },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /✓ A=1/);
      assert.match(r.stdout, /V_OK/);
      assert.match(r.stderr, /✗ A 没生效：运行期=1（期望 9）/);
      assert.match(r.stdout, /V_BAD/);
    } finally {
      w.cleanup();
    }
  });
});

describe('⑤ 真进程：/proc/<pid>/environ 读得出来（不是只在假目录里成立）', { skip: !bashOk }, () => {
  test('子进程的环境变量能被 daemon_env_get 读回', async () => {
    const w = world();
    // 必须在 **bash 里**起子进程：Node 的 spawn 给的是 Windows pid，
    // Git Bash 的 /proc 认的是 MSYS pid（实测 32708 vs 63723，完全对不上）。
    const pidFile = join(w.root, 'child.pid');
    const holder = spawn(
      'bash',
      [
        '-c',
        `DOTD_FAKE_KNOB=two DOTD_FAKE_OTHER='x y' bash -c 'exec -a src/daemon.ts sleep 60' & echo $! > ${sh(JSON.stringify(pidFile))}; wait`,
      ],
      { stdio: 'ignore' },
    );
    try {
      const deadline = Date.now() + 15_000;
      let pid = '';
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          pid = readFileSync(pidFile, 'utf8').trim();
          if (pid) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(pid, /^\d+$/, '没拿到子进程 pid');

      // 等 exec 生效（cmdline 变成 src/daemon.ts）
      for (let i = 0; i < 60; i++) {
        const c = spawnSync('bash', ['-c', `tr '\\0' '\\n' < /proc/${pid}/cmdline 2>/dev/null`], { encoding: 'utf8' });
        if ((c.stdout || '').includes('src/daemon.ts')) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // 真 /proc（不注入 DOTD_PROC_ROOT）+ 真进程
      const script = [
        `. ${sh(JSON.stringify(w.lib))}`,
        `echo "K=$(daemon_env_get ${pid} DOTD_FAKE_KNOB)"`,
        `echo "O=$(daemon_env_get ${pid} DOTD_FAKE_OTHER)"`,
        `echo "MISSING=$(daemon_env_get ${pid} NO_SUCH_KNOB || echo '<absent>')"`,
        `echo "P=$(daemon_pids | grep -c '^${pid}$' || true)"`,
        `echo "V=$(daemon_verify_env ${pid} DOTD_FAKE_KNOB=two >/dev/null 2>&1 && echo ok)"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /K=two/, '必须读到子进程真实的环境');
      assert.match(r.stdout, /O=x y/, '含空格的值也不能被截断');
      assert.match(r.stdout, /MISSING=<absent>/, '不存在的变量要能区分出来（不能返回 0）');
      assert.match(r.stdout, /P=1/, 'daemon_pids 要能在真 /proc 里认出它');
      assert.match(r.stdout, /V=ok/, 'daemon_verify_env 在真进程上也要通过');
    } finally {
      try {
        const pid = readFileSync(pidFile, 'utf8').trim();
        if (pid) spawnSync('bash', ['-c', `kill -KILL ${pid} 2>/dev/null || true`]);
      } catch {
        /* ignore */
      }
      holder.kill('SIGKILL');
      w.cleanup();
    }
  });
});

describe('⑥ 调用方全部改用本库（不许再自己 pkill + 起 wsl-daemon.sh）', { skip: !bashOk }, () => {
  for (const name of CALLERS) {
    test(`${name}`, () => {
      const p = join(REPO, 'scripts', name);
      if (!existsSync(p)) return; // 已被删除也算合格
      const text = readFileSync(p, 'utf8');
      assert.match(text, /lib\/daemon-restart\.sh/, '必须共用同一份重启判据');
      assert.match(text, /\bdaemon_restart\b/, '必须真的调用它');
      assert.doesNotMatch(text, /^\s*pkill\b.*daemon/m, 'pkill -f 会匹配到调用者自己，且绕开 supervisor');
      assert.doesNotMatch(
        text,
        /^\s*(nohup\s+)?(setsid\s+)?bash\s+scripts\/wsl-daemon\.sh/m,
        '直接起 wsl-daemon.sh 在锁被占时是静默 no-op（见 lib 头部 ②）',
      );
    });
  }
});
