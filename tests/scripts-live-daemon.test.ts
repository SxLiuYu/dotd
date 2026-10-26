/**
 * tests/scripts-live-daemon.test.ts —— 体检读的是「在跑的那个 daemon」，不是它自己。
 *
 * 现场（2026-10-26 live，修完 §18.13 之后同一台机器）：
 *
 * ```
 * 体检：⚠️ DOTD_FLEET 未设置 → 实际生效 stub（不起容器）
 * 实际：/proc/<daemon>/environ → DOTD_FLEET=docker
 *
 * 体检：⚠️ openrouter-main 的默认地址 127.0.0.1:3065 连不上
 * 实际：/proc/<daemon>/environ → DOTD_MODEL_HOST=http://172.17.48.1:13065（relay，通着）
 * ```
 *
 * `DOTD_FLEET` / `DOTD_MODEL_HOST` 由启动器导出给 **daemon 子进程**，人手动跑
 * `npm run doctor` 的 shell 里没有。doctor 用「实际生效」这四个字报自己 shell 的缺席，
 * 是同一个缺陷的第四例（前三例见 docs §18.11–18.13）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RUNTIME_KNOBS,
  liveDaemon,
  overlayRuntimeEnv,
  parseProcEnv,
  scanDaemons,
} from '../scripts/lib/live-daemon.mjs';
import { runChecks, STATUS } from '../scripts/doctor.mjs';

/** 造一个假的 /proc：`{ pid: { cmdline: [...], environ: {K: V} } }`。 */
function fakeProc(spec: Record<string, { cmdline: string[]; environ?: Record<string, string> }>) {
  const root = mkdtempSync(join(tmpdir(), 'dotd-proc-'));
  for (const [pid, info] of Object.entries(spec)) {
    mkdirSync(join(root, pid), { recursive: true });
    writeFileSync(join(root, pid, 'cmdline'), info.cmdline.join('\0') + '\0', 'utf8');
    const env = Object.entries(info.environ ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\0');
    writeFileSync(join(root, pid, 'environ'), env.length > 0 ? env + '\0' : '', 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('① parseProcEnv：/proc 的 NUL 分隔形态', () => {
  test('解析 NAME=value，值里的 = 不被截断', () => {
    assert.deepEqual(parseProcEnv('A=1\u0000B=x=y\u0000'), { A: '1', B: 'x=y' });
  });

  test('空文本 / 无 = 的垃圾项 → 空对象（不是 undefined）', () => {
    assert.deepEqual(parseProcEnv(''), {});
    assert.deepEqual(parseProcEnv('\u0000garbage\u0000=leading\u0000'), {});
  });
});

describe('② scanDaemons：只认 daemon 入口（src/daemon.ts 或 dist/daemon.js），不误伤别的进程', () => {
  test('认出 daemon，且排除自己（selfPid）', () => {
    const p = fakeProc({
      101: { cmdline: ['/usr/bin/node', '--import', 'tsx', '/root/dotd/src/daemon.ts'], environ: { DOTD_FLEET: 'docker' } },
      999: { cmdline: ['/usr/bin/node', 'scripts/doctor.mjs'] },
    });
    try {
      const found = scanDaemons({ procRoot: p.root, selfPid: 999 });
      assert.equal(found.length, 1);
      const d = found[0];
      assert.ok(d !== undefined);
      assert.equal(d.pid, 101);
      assert.equal(d.env.DOTD_FLEET, 'docker');
    } finally {
      p.cleanup();
    }
  });

  test('Windows 路径写法也认（`\\src\\daemon.ts`），但不能被 `daemon.tsx` 骗', () => {
    const p = fakeProc({
      1: { cmdline: ['node.exe', 'D:\\dotd\\src\\daemon.ts'] },
      2: { cmdline: ['node', 'src/daemon.tsx'] },
      3: { cmdline: ['node', 'src/not-daemon.ts'] },
      4: { cmdline: ['vim', 'src/daemon.ts'] }, // 参数恰好匹配 —— 不额外猜"这是编辑器"，
      // 但 environ 里没有 DOTD_*，只会产出空 env；真正的判据在 ambig/计数上（见③）。
    });
    try {
      const pids = scanDaemons({ procRoot: p.root, selfPid: 0 }).map((d) => d.pid);
      assert.ok(pids.includes(1), 'Windows 反斜杠路径要认');
      assert.ok(!pids.includes(2), 'daemon.tsx 不是 daemon');
      assert.ok(!pids.includes(3), 'not-daemon.ts 不是 daemon');
    } finally {
      p.cleanup();
    }
  });

  test('构建产物形态 `dist/daemon.js` 也认（one_system 优先起它）', () => {
    // 托管部署里 dotd_command() 有 dist/daemon.js 就优先用它。只认 src/daemon.ts 的话，
    // 一旦跑过构建，doctor / 重启库就"看不见 daemon" —— 于是把自己的盲区报成环境问题。
    const p = fakeProc({
      10: { cmdline: ['/usr/bin/node', '/root/dotd/dist/daemon.js'], environ: { DOTD_FLEET: 'docker' } },
      11: { cmdline: ['node.exe', 'D:\\dotd\\dist\\daemon.js'] },
      12: { cmdline: ['node', 'dist/daemon.jsx'] },
    });
    try {
      const found = scanDaemons({ procRoot: p.root, selfPid: 0 });
      const pids = found.map((d) => d.pid);
      assert.ok(pids.includes(10), 'Linux 绝对路径要认');
      assert.ok(pids.includes(11), 'Windows 反斜杠路径要认');
      assert.ok(!pids.includes(12), 'daemon.jsx 不是 daemon');
      assert.equal(found.find((d) => d.pid === 10)?.env.DOTD_FLEET, 'docker');
    } finally {
      p.cleanup();
    }
  });

  test('没有 /proc（Windows/macOS）→ 空数组，不抛', () => {
    assert.deepEqual(scanDaemons({ procRoot: join(tmpdir(), 'definitely-not-proc-xyz') }), []);
  });

  test('environ 读不到（hidepid）→ 仍然算"在跑"，env 是空对象', () => {
    const p = fakeProc({ 5: { cmdline: ['node', '/repo/src/daemon.ts'] } });
    try {
      const found = scanDaemons({ procRoot: p.root, selfPid: 0 });
      assert.equal(found.length, 1);
      const d = found[0];
      assert.ok(d !== undefined);
      assert.deepEqual(d.env, {});
    } finally {
      p.cleanup();
    }
  });
});

describe('③ overlayRuntimeEnv：只叠白名单，且运行期优先', () => {
  test('daemon 有值的键覆盖 shell（这正是 live 那两条误报的修法）', () => {
    const { env, overlaid } = overlayRuntimeEnv({
      shellEnv: { DOTD_FLEET: undefined, DOTD_MODEL_HOST: undefined },
      liveEnv: { DOTD_FLEET: 'docker', DOTD_MODEL_HOST: 'http://172.17.48.1:13065' },
    });
    assert.equal(env.DOTD_FLEET, 'docker');
    assert.equal(env.DOTD_MODEL_HOST, 'http://172.17.48.1:13065');
    assert.deepEqual(overlaid.sort(), ['DOTD_FLEET', 'DOTD_MODEL_HOST']);
  });

  test('令牌不在白名单里（不需要就不要多取）', () => {
    for (const secret of ['DOTD_MASTER_TOKEN', 'DOTD_RO_TOKEN', 'DOTD_MAIL_KEY']) {
      assert.ok(!RUNTIME_KNOBS.includes(secret), `${secret} 不该被体检拿来用`);
    }
    const { env } = overlayRuntimeEnv({
      shellEnv: {},
      liveEnv: { DOTD_MASTER_TOKEN: 'secret-from-daemon', DOTD_FLEET: 'docker' },
    });
    assert.equal(env.DOTD_MASTER_TOKEN, undefined, '白名单外的键一律不落进体检环境');
  });

  test('两边一致时不算"被覆盖"（说明里不该出现假的来源）', () => {
    const { overlaid } = overlayRuntimeEnv({
      shellEnv: { DOTD_FLEET: 'docker' },
      liveEnv: { DOTD_FLEET: 'docker' },
    });
    assert.deepEqual(overlaid, []);
  });

  test('daemon 里该键为空串 → 不覆盖（空不等于设置）', () => {
    const { env, overlaid } = overlayRuntimeEnv({ shellEnv: { DOTD_FLEET: 'stub' }, liveEnv: { DOTD_FLEET: '' } });
    assert.equal(env.DOTD_FLEET, 'stub');
    assert.deepEqual(overlaid, []);
  });
});

describe('④ liveDaemon：0 个 / 1 个 / 多个 三种情形', () => {
  test('没有 daemon → null（调用方据此说"按当前 shell 判断"）', () => {
    assert.equal(liveDaemon({ scan: () => [] }), null);
  });

  test('恰好一个 → 带上 pid 与覆盖后的环境', () => {
    const got = liveDaemon({
      shellEnv: { DOTD_FLEET: undefined },
      scan: () => [{ pid: 42, cmdline: [], env: { DOTD_FLEET: 'docker' } }],
    });
    assert.ok(got !== null && !('ambiguous' in got), '应当认出唯一 daemon');
    assert.equal(got.pid, 42);
    assert.equal(got.env.DOTD_FLEET, 'docker');
    assert.deepEqual(got.overlaid, ['DOTD_FLEET']);
  });

  test('多个 → 明确报歧义，不挑一个当代言人', () => {
    const got = liveDaemon({
      scan: () => [
        { pid: 1, cmdline: [], env: { DOTD_FLEET: 'docker' } },
        { pid: 2, cmdline: [], env: { DOTD_FLEET: 'stub' } },
      ],
    });
    assert.ok(got !== null && 'ambiguous' in got, '两个进程不能被收敛成一个');
    assert.equal(got.ambiguous.length, 2, '两个都报出来，让人自己看');
  });
});

describe('⑤ doctor 真的用运行期环境（否则前面全是空转）', () => {
  function sandbox() {
    const home = mkdtempSync(join(tmpdir(), 'dotd-doctor-live-'));
    mkdirSync(join(home, '.dotd'), { recursive: true });
    writeFileSync(
      join(home, '.dotd', 'config.yml'),
      [
        'version: 1',
        'surfaces:',
        '  http:',
        '    host: 127.0.0.1',
        '    port: 7788',
        '    master_token: "test-master"',
        '    readonly_tokens: []',
      ].join('\n'),
      'utf8',
    );
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }
  const probeOk = async () => ({ ok: true, detail: 'TCP 可连', latencyMs: 1 });
  // 返回类型用 runChecks 的真实元素类型（`DoctorResult`），否则 `fleet.status`
  // 这类字段访问全是 TS2339 —— 而 `as` 断言会把"声明文件与实现不一致"盖住。
  const byName = (rs: Array<Awaited<ReturnType<typeof runChecks>>[number]>, n: string) => {
    const r = rs.find((x) => x.name === n);
    assert.ok(r !== undefined, `缺体检项 ${n}`);
    return r;
  };

  test('shell 里没有 DOTD_FLEET，但 daemon 里是 docker → 报 docker，不报"未设置"', async () => {
    const s = sandbox();
    try {
      const results = await runChecks({
        env: { HY3_API_KEY: 'k' }, // 人手动跑的裸 shell：没有 DOTD_FLEET
        home: s.home,
        repoRoot: process.cwd(),
        probe: probeOk,
        live: () => ({
          pid: 4242,
          env: { HY3_API_KEY: 'k', DOTD_FLEET: 'docker' },
          overlaid: ['DOTD_FLEET'],
        }),
      });
      const fleet = byName(results, 'fleet');
      assert.equal(fleet.status, STATUS.OK, `daemon 明明跑着 docker：${fleet.title} / ${fleet.detail}`);
      assert.match(fleet.title, /docker/);
      assert.match(fleet.detail, /4242/, '要说清这个值来自哪个进程');
    } finally {
      s.cleanup();
    }
  });

  test('看不见 daemon 时必须说出来（不能把 shell 的缺席当机器结论）', async () => {
    const s = sandbox();
    try {
      const results = await runChecks({
        env: { HY3_API_KEY: 'k' },
        home: s.home,
        repoRoot: process.cwd(),
        probe: probeOk,
        live: () => null,
      });
      const fleet = byName(results, 'fleet');
      assert.equal(fleet.status, STATUS.WARN);
      assert.match(fleet.detail, /没找到运行中的 daemon/, '要交代"这是按当前 shell 判断的"');
    } finally {
      s.cleanup();
    }
  });

  test('多个 daemon → 说明里报歧义，仍然按 shell 判断', async () => {
    const s = sandbox();
    try {
      const results = await runChecks({
        env: { HY3_API_KEY: 'k' },
        home: s.home,
        repoRoot: process.cwd(),
        probe: probeOk,
        live: () => ({
          ambiguous: [
            { pid: 1, cmdline: [], env: {} },
            { pid: 2, cmdline: [], env: {} },
          ],
        }),
      });
      const fleet = byName(results, 'fleet');
      assert.match(fleet.detail, /2 个 daemon 进程/);
      assert.equal(fleet.status, STATUS.WARN);
    } finally {
      s.cleanup();
    }
  });

  test('显式传 env 的调用不扫 /proc（测试结论不该取决于这台机器有没有 daemon）', async () => {
    const s = sandbox();
    try {
      // 不给 live：runChecks 在 opts.env 存在时必须自己关掉扫描。
      // 若它偷偷扫了，这台机器上真跑着 daemon 时 fleet 会变成 OK —— 这条会红。
      const results = await runChecks({
        env: { HY3_API_KEY: 'k' },
        home: s.home,
        repoRoot: process.cwd(),
        probe: probeOk,
      });
      const fleet = byName(results, 'fleet');
      assert.equal(fleet.status, STATUS.WARN, '显式 env 下只看 env');
      assert.match(fleet.detail, /没找到运行中的 daemon/, '要说清这次没有用运行期取值');
    } finally {
      s.cleanup();
    }
  });
});
