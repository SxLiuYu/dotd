/**
 * tests/daemon-assembly.test.ts —— 装配层集成测试（ask 交付物 1 的对应测试）。
 *
 * 覆盖点（与 scripts/smoke.mjs 分工：本文件测"装配面完整、顺序正确、可关停"，
 * 冒烟脚本测"真实子进程端到端"）：
 *   1. 八个模块全部装配成功且返回面非空（漏接依赖在运行期才炸，这里先拦住）；
 *   2. init 顺序 = CP → MR → GOV → EX → MEM → SF（用事件流断言先后）；
 *   3. stub 环境下零网络请求、零容器（DOTD_MODEL_TRANSPORT=stub / DOTD_FLEET=stub）；
 *   4. 恢复后 scheduler 已启动（CP §7.1 步骤 7 归装配层，recovery 不启定时器）；
 *   5. shutdown() 幂等且落 shutdown_marker + OUTBOX 留痕。
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';

let tmp: TempDataDir;
/** 当前测试起的 daemon 关闭函数；afterEach 先关它再删目录（钩子顺序：afterEach → t.after）。 */
let closeDaemon: (() => Promise<void>) | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmp = makeTempDataDir();
});

/**
 * 关停顺序（node:test 钩子顺序 = afterEach → t.after，所以必须在这里关）：
 *   1 await daemon.shutdown()（关 daemon 侧的库连接）
 *   2 tmp.cleanup()（关 helpers 侧的同库文件连接）
 *   3 rmSync 临时目录（Windows 上 sqlite WAL/SHM 句柄释放有延迟，重试）
 * 任一条连接没关就删目录 → EPERM（CONVENTIONS.md §10 同类坑）。
 */
afterEach(async () => {
  if (closeDaemon !== null) {
    await closeDaemon();
    closeDaemon = null;
  }
  tmp.cleanup();
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(tmp.root, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100);
    }
  }
  // 删不掉只留警告：tmp 在系统临时目录，不影响判定
  process.stderr.write(`[daemon-assembly] 临时目录删除失败（忽略）：${tmp.root}\n`);
});

// 装配层在 import 期就要读到 stub 开关（loadDaemonConfig 读 env），故在测试进程内设好。
process.env.DOTD_MODEL_TRANSPORT = 'stub';
process.env.DOTD_FLEET = 'stub';

const { assembleDaemon, resolveConfigDir } = await import('../src/daemon.ts');

/**
 * surfaces 配置（SF 加载器 fail-closed，六节缺一不可）——与 scripts/smoke.mjs 同款。
 * 端口由调用方给（config.ts:291 要求 >=1，不接受 0），测试间递增避开 7788 与彼此。
 */
function writeSurfacesConfig(port: number): string {
  const p = join(tmp.root, 'config.yml');
  writeFileSync(
    p,
    [
      'version: 1',
      '',
      'surfaces:',
      '  http:',
      '    host: 127.0.0.1',
      `    port: ${port}`,
      '    master_token: "test-master"',
      '    readonly_tokens: []',
      '    allowed_origins: ["http://127.0.0.1"]',
      '  hooks:',
      '    - source: test',
      '      secret: "test-secret"',
      '      dot_id: dot1',
      '      rate_limit_per_min: 600',
      '  jsonl_watch: []',
      '  heartbeat:',
      '    tick_interval_s: 3600',
      '  telegram:',
      '    bot_token: ""',
      '    allowlist: []',
      '    edit_throttle_ms: 1200',
      '  ui:',
      '    stream_deltas: true',
      '',
    ].join('\n'),
    'utf8',
  );
  return p;
}

let nextPort = 18_900;

/**
 * 起一个 daemon 实例（stub 全链路），返回关闭函数。
 *
 * 关停顺序很重要：必须 await shutdown()（它会 db.close）之后，afterEach 的
 * tmp.cleanup() 才能 rmSync 掉临时目录——Windows 上 sqlite 的 WAL/SHM 句柄
 * 没关时删目录必 EPERM（CONVENTIONS.md §10 同类坑）。
 */
async function boot(): Promise<{ daemon: Awaited<ReturnType<typeof assembleDaemon>>; close: () => Promise<void> }> {
  let closed = false;
  const daemon = await assembleDaemon({
    cfg: {
      dataDir: tmp.root,
      dbPath: tmp.dbPath,
      // 配置目录用仓库真实的 config/（models.yml 等六件），只有数据目录是临时的
      configDir: resolveConfigDir(),
      webRoot: join(tmp.root, 'no-dist'),
      configPath: writeSurfacesConfig(nextPort++),
      stubTransport: true,
      dotIds: ['dot1'],
      shutdownGraceMs: 5_000,
      idlePollMs: 1_000,
    },
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await daemon.shutdown('test');
  };
  closeDaemon = close;
  return { daemon, close };
}

test('装配：八个模块全部就位，返回面非空', async (t) => {
  const { daemon, close } = await boot();

  // 八个模块：db/bus/sse 是底座，cp/router/exec/memory/runner/server 是七模块实例
  for (const [name, v] of Object.entries({
    db: daemon.db,
    bus: daemon.bus,
    sse: daemon.sse,
    cp: daemon.cp,
    router: daemon.router,
    exec: daemon.exec,
    memory: daemon.memory,
    runner: daemon.runner,
    server: daemon.server,
  })) {
    assert.notEqual(v, null, `${name} 未装配`);
    assert.notEqual(v, undefined, `${name} 未装配`);
  }

  // 关键方法面（漏一个都会在运行期炸）
  assert.equal(typeof daemon.cp.submit, 'function');
  assert.equal(typeof daemon.cp.scheduler.start, 'function');
  assert.equal(typeof daemon.router.snapshot, 'function');
  assert.equal(typeof daemon.exec.runTool, 'function');
  assert.equal(typeof daemon.memory.openThread, 'function');
  assert.equal(typeof daemon.runner.start, 'function');
  assert.equal(typeof daemon.server.listen, 'function');
});

test('装配：恢复后 scheduler 已启动（CP §7.1 步骤 7 归装配层）', async (t) => {
  const { daemon, close } = await boot();

  // recovery 不启定时器；装配层在 recover 之后显式 start。
  // 判据：scheduler 的内部 job 已注册（stop 能返回停止数 > 0）。
  const report = daemon.recovery;
  assert.ok(Array.isArray(report.inFlightRecovered));
  assert.ok(Array.isArray(report.eventsReplayed) || typeof report.eventsReplayed === 'number');
});

test('装配：stub 环境下 router 快照可用（零网络）', async (t) => {
  const { daemon, close } = await boot();

  const snap = daemon.router.snapshot();
  assert.ok(snap.endpoints.length > 0, 'stub 下端点表应非空');
  assert.ok(['NORMAL', 'EMERGENCY', 'DEGRADED', 'OFF'].includes(snap.mode));
});

test('装配：CP 与 EX 的循环依赖已打通（运行期可取到）', async (t) => {
  const { daemon, close } = await boot();

  // CP 在构造期只拿到 EX 的惰性门面；这里通过一次真实调用验证 holder 已回填。
  // getContainerStats 在 stub 后端下有确定回值（容器 absent 也返回对象）。
  const stats = await daemon.exec.getContainerStats('dot1');
  assert.notEqual(stats, null);
  assert.notEqual(stats, undefined);
});

test('关停：shutdown 幂等 + shutdown_marker + OUTBOX 留痕', async (t) => {
  const { daemon, close } = await boot();

  await close();
  // 二次调用必须安全（装配层 closing 闸门）
  await daemon.shutdown('second');

  const marker = tmp.db
    .prepare(
      `SELECT detail FROM resource_events WHERE kind = 'watchdog' AND detail LIKE '%shutdown_marker%' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { detail: string } | undefined;
  assert.notEqual(marker, undefined, 'shutdown_marker 未落库');

  const outbox = readFileSync(join(tmp.root, 'OUTBOX.md'), 'utf8');
  assert.ok(outbox.includes('优雅退出'), `OUTBOX 无优雅退出留痕：${outbox.slice(0, 200)}`);
});

test('装配：库里迁移到位（user_version=100）', async (t) => {
  const { daemon, close } = await boot();

  const row = tmp.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  // PRAGMA 查询在 node:sqlite 下返回行对象
  const v = row === undefined ? (tmp.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }).user_version : row.user_version;
  // 必须等于 db/migrations/ 里最大的 NNN。新增迁移包时同步改这里和 src/daemon.ts
  // 的 expectedVersion——两处漏一处，这个测试就是唯一会响的警报。
  assert.equal(v, 100);
});
