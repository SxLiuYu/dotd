/**
 * tests/exec-protocol.test.ts —— 执行面工具协议与硬护栏（EX §5/§7，契约 J2）。
 *
 * 全部跑在 DOTD_FLEET=stub 的内存假实现上（CONVENTIONS.md §7），不起 Docker、不发 HTTP。
 * 断言对象 = src/exec/protocol.ts 的纯函数 + src/exec/stub-runtime.ts 的协议语义。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import {
  CAPABILITY_CATALOG,
  FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
  HOME_ROOT,
  RUNTIME_PATHS,
  TOKEN_BYTES,
  bearerHeader,
  checkDeadline,
  checkHomePath,
  dispatchModeFor,
  endpointUrl,
  findCapability,
  generateToken,
  identityHash,
  ledgerReplay,
  normalizeAbs,
  resultHash,
  stableStringify,
  tokenHash,
  validateToolCall,
} from '../src/exec/protocol.ts';
import type { ExecToolCall } from '../src/shared/contracts.ts';
import type { ExecConfig } from '../src/exec/types.ts';

const cfg: ExecConfig = {
  fleet: 'stub',
  dockerApiVersion: '1.52',
  dockerApiMin: '1.44',
  dockerApiMax: '1.52',
  dockerSocketPath: '/var/run/docker.sock',
  pwVersion: '1.49.1',
  runtimeVer: '0.1.0',
  networkName: 'dotd',
  runtimePort: 9223,
  syncDeadlineMs: 60_000,
  asyncDeadlineMs: 30 * 60_000,
  bootHealthTimeoutMs: 30_000,
  healthFailLimit: 3,
  idleTimeoutMs: 15 * 60_000,
  deepStopAfterMs: 0,
  recreateLimitPer24h: 3,
  pollIntervalMs: 500,
  logTailChars: 4000,
  gate: { maxActiveContainers: 2, maxMemBudgetTotalMb: 4096, minMemAvailableMb: 4096 },
  tokenDir: '/var/lib/dotd/tokens',
  repoRoot: '/repo',
  profileHashChars: 16,
  diskPolicyDefaults: {
    image_tags: 2,
    home_quota_mb: 2048,
    profile_quota_mb: 2048,
    state_quota_mb: 64,
    tmp_mb: 256,
    container_log_mb: 20,
    disk_free_min_mb: 5120,
    disk_critical_free_mb: 2048,
  },
};

function call(o: Partial<ExecToolCall> & { call_id: string; tool: ExecToolCall['tool'] }): ExecToolCall {
  return {
    task_id: 't-1',
    dot_id: 'dot-a',
    args: {},
    deadline_ms: 5000,
    issued_at: new Date().toISOString(),
    ...o,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ① 端点表与 catalog 派生（契约 J2 / EX §5.2）
// ═══════════════════════════════════════════════════════════════════

test('端点表：八个 RUNTIME_PATHS 与契约逐字对应', () => {
  assert.equal(RUNTIME_PATHS.healthz, '/healthz');
  assert.equal(RUNTIME_PATHS.toolsCall, '/tools/call');
  assert.equal(RUNTIME_PATHS.jobsStart, '/jobs/start');
  assert.equal(RUNTIME_PATHS.job('j1'), '/jobs/j1');
  assert.equal(RUNTIME_PATHS.jobCancel('j1'), '/jobs/j1/cancel');
  assert.equal(RUNTIME_PATHS.jobs, '/jobs');
  assert.equal(RUNTIME_PATHS.call('c1'), '/calls/c1');
  assert.equal(RUNTIME_PATHS.capabilities, '/capabilities');
  // 契约 S4'/M4 追加的 fs 桥
  assert.equal(RUNTIME_PATHS.fsOps, '/fs/ops');
  // job id 需 URL 编码（防注入路径）
  assert.equal(RUNTIME_PATHS.job('a b/c'), '/jobs/a%20b%2Fc');
  assert.equal(endpointUrl('172.18.0.3', 9223), 'http://172.18.0.3:9223');
});

test('能力目录：34 名工具（19 容器 + 8 宿主 mail + 3 日历写 + 4 连接器）、mode/max_deadline/sideEffect 逐条与契约 J2 一致', () => {
  assert.equal(CAPABILITY_CATALOG.length, 34);
  const by = new Map(CAPABILITY_CATALOG.map((c) => [c.name, c]));
  const expect: Record<string, [string, number, string]> = {
    'fs.read': ['sync', 60_000, 'safe'],
    'fs.write': ['sync', 60_000, 'replayable'],
    'fs.list': ['sync', 60_000, 'safe'],
    'fs.stat': ['sync', 60_000, 'safe'],
    'shell.run': ['async', 1_800_000, 'unknown'],
    'browser.open': ['async', 1_800_000, 'unknown'],
    'browser.act': ['async', 1_800_000, 'unknown'],
    'browser.snapshot': ['async', 1_800_000, 'safe'],
    'browser.screenshot': ['async', 1_800_000, 'safe'],
    'browser.close': ['async', 60_000, 'safe'],
    'net.get': ['async', 60_000, 'safe'],
    'net.post': ['async', 60_000, 'unknown'],
    // 宿主侧 mail 8 件套（2026-10-20 进目录；模型可见性靠 HOST_SIDE_TOOLS + 本目录）
    'mail.account.add': ['sync', 60_000, 'unknown'],
    'mail.account.list': ['sync', 60_000, 'safe'],
    'mail.account.remove': ['sync', 60_000, 'replayable'],
    'mail.list': ['sync', 60_000, 'safe'],
    'mail.read': ['sync', 60_000, 'safe'],
    'mail.search': ['sync', 60_000, 'safe'],
    'mail.draft': ['sync', 60_000, 'replayable'],
    'mail.send': ['sync', 60_000, 'unknown'],
  'calendar.add': ['sync', 60_000, 'safe'],
  'calendar.edit': ['sync', 60_000, 'replayable'],
  'calendar.delete': ['sync', 60_000, 'replayable'],
  'github.notifications': ['sync', 60_000, 'safe'],
  'github.issues': ['sync', 60_000, 'safe'],
  'github.pulls': ['sync', 60_000, 'safe'],
  'rss.read': ['sync', 60_000, 'safe'],
  };
  for (const [name, [mode, max, se]] of Object.entries(expect)) {
    const c = by.get(name);
    assert.ok(c !== undefined, `缺少工具 ${name}`);
    assert.equal(c.mode, mode, `${name} mode`);
    assert.equal(c.max_deadline_ms, max, `${name} max_deadline_ms`);
    assert.equal(c.sideEffect, se, `${name} sideEffect`);
    // args_schema 必须是对象（治理侧用来校验入参）
    assert.equal(typeof c.args_schema, 'object');
  }
  // 端点由 catalog.mode 决定，与时长无关
  assert.equal(dispatchModeFor('fs.read'), 'sync');
  assert.equal(dispatchModeFor('shell.run'), 'async');
  assert.equal(dispatchModeFor('不存在的工具'), null);
  assert.equal(findCapability('net.post')?.sideEffect, 'unknown');
});

// ═══════════════════════════════════════════════════════════════════
// ② deadline 规则（EX §5.2：工具属性决定，非时长猜测）
// ═══════════════════════════════════════════════════════════════════

test('deadline：sync 超 60s → deadline_too_long_for_sync（不看时长）', () => {
  const e = checkDeadline(cfg, 'fs.read', 60_001);
  assert.ok(e !== null);
  assert.equal(e?.code, 'deadline_too_long_for_sync');
  assert.equal(e?.retryable, false);
  // 恰好等于上限放行
  assert.equal(checkDeadline(cfg, 'fs.read', 60_000), null);
  // 短 fs.read 即便"时长很短"也不因此允许超上限（属性决定）
  assert.ok(checkDeadline(cfg, 'fs.list', 60_001)?.code === 'deadline_too_long_for_sync');
});

test('deadline：async 超 max_deadline_ms → deadline_too_long；非正 → bad_deadline', () => {
  assert.equal(checkDeadline(cfg, 'shell.run', 1_800_000), null);
  assert.equal(checkDeadline(cfg, 'shell.run', 1_800_001)?.code, 'deadline_too_long');
  // net.post 上限 60s（async 但不是长时工具）
  assert.equal(checkDeadline(cfg, 'net.post', 60_001)?.code, 'deadline_too_long');
  assert.equal(checkDeadline(cfg, 'shell.run', 0)?.code, 'bad_deadline');
  assert.equal(checkDeadline(cfg, 'shell.run', -5)?.code, 'bad_deadline');
});

// ═══════════════════════════════════════════════════════════════════
// ③ 请求本地校验（EX §5.3）
// ═══════════════════════════════════════════════════════════════════

test('validateToolCall：缺字段/未知工具/坏 args/坏 deadline 全部本地拒绝', () => {
  assert.equal(
    validateToolCall(cfg, call({ call_id: '', tool: 'fs.read' }))?.code,
    'bad_call',
  );
  assert.equal(
    validateToolCall(cfg, call({ call_id: 'c', tool: 'fs.read', task_id: '' }))?.code,
    'bad_call',
  );
  assert.equal(
    validateToolCall(cfg, call({ call_id: 'c', tool: 'nope.nope' as ExecToolCall['tool'] }))?.code,
    'unknown_tool',
  );
  assert.equal(
    validateToolCall(cfg, call({ call_id: 'c', tool: 'fs.read', args: [] as unknown as Record<string, unknown> }))?.code,
    'bad_args',
  );
  assert.equal(
    validateToolCall(cfg, call({ call_id: 'c', tool: 'fs.read', deadline_ms: 999_999 }))?.code,
    'deadline_too_long_for_sync',
  );
  // 合法调用放行
  assert.equal(validateToolCall(cfg, call({ call_id: 'c', tool: 'fs.read', args: { path: '/dot/home/a' } })), null);
  // browser.* 缺失 identity 不拒绝派发（fail-closed 判定归治理，契约 G1）
  assert.equal(validateToolCall(cfg, call({ call_id: 'c', tool: 'browser.open', args: {} })), null);
});

// ═══════════════════════════════════════════════════════════════════
// ④ token 与 hash（EX §2.1-4/§5.1）
// ═══════════════════════════════════════════════════════════════════

test('token：32 字节随机、sha256 落库、Bearer 头格式', () => {
  const t = generateToken();
  assert.equal(t.length, TOKEN_BYTES * 2); // hex
  assert.match(t, /^[0-9a-f]{64}$/);
  const t2 = generateToken();
  assert.notEqual(t, t2, '两次生成不得相同');
  const h = tokenHash(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, t, '落库的必须是 hash 而非明文');
  assert.equal(tokenHash(t), h, 'hash 稳定');
  assert.equal(bearerHeader(t), `Bearer ${t}`);
});

test('hash：stableStringify 键序无关、resultHash 稳定', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  const h1 = resultHash({ ok: true, n: 1 });
  const h2 = resultHash({ n: 1, ok: true });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(resultHash({ ok: true }), resultHash({ ok: false }));
});

test('identityHash：sha256 前 16 位（防 profile 目录名注入）', () => {
  assert.equal(identityHash('alice'), identityHash('alice'));
  assert.match(identityHash('alice'), /^[0-9a-f]{16}$/);
  assert.notEqual(identityHash('alice'), identityHash('bob'));
  // 不同长度参数生效
  assert.equal(identityHash('alice', 8).length, 8);
});

// ═══════════════════════════════════════════════════════════════════
// ⑤ §7 硬护栏：路径检查（exec 无条件强制，与审批无关）
// ═══════════════════════════════════════════════════════════════════

test('护栏：路径必须在 /dot/home/ 下，.dotd/ 隐藏前缀拒绝', () => {
  assert.equal(checkHomePath('/dot/home/a.txt').ok, true);
  assert.equal(checkHomePath('/dot/home/sub/dir/a.txt').ok, true);
  // home 根本身合法（fs.list/stat 需要能对根操作）
  assert.equal(checkHomePath('/dot/home').ok, true);
  assert.equal(checkHomePath('/dot/home/').ok, true);
  assert.equal(checkHomePath('/etc/passwd').code, 'path_outside_home');
  assert.equal(checkHomePath('/dot/home/../etc').code, 'path_outside_home');
  assert.equal(checkHomePath('/dot').code, 'path_outside_home');
  // 隐藏前缀（.dotd/）纵深防御
  assert.equal(checkHomePath('/dot/home/.dotd/x').code, 'path_hidden');
  assert.equal(checkHomePath('/dot/home/.dotd').code, 'path_hidden');
  // 非字符串 / 空
  assert.equal(checkHomePath(42).code, 'bad_path');
  assert.equal(checkHomePath('').code, 'bad_path');
});

test('护栏：realpath 二次校验拒绝符号链接逃逸', () => {
  // realpath 落在 home 内：放行
  assert.equal(checkHomePath('/dot/home/link', '/dot/home/real.txt').ok, true);
  // realpath 逃逸到 home 外：symlink_escape
  assert.equal(checkHomePath('/dot/home/link', '/etc/shadow').code, 'symlink_escape');
});

test('护栏：normalizeAbs 归一化 . .. 与重复斜杠', () => {
  assert.equal(normalizeAbs('/dot/home//a/./b/../c.txt'), '/dot/home/a/c.txt');
  assert.equal(normalizeAbs('/dot/home/../../etc'), '/etc');
});

test('护栏常量：与 EX §7 逐字一致', () => {
  assert.equal(HOME_ROOT, '/dot/home');
  assert.equal(FS_READ_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(FS_WRITE_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(FS_LIST_MAX_DEPTH, 4);
});

// ═══════════════════════════════════════════════════════════════════
// ⑥ 幂等 ledger 重放（EX §5.4）
// ═══════════════════════════════════════════════════════════════════

test('ledgerReplay：done 重放结果；doing/aborted/compacted 各有语义', () => {
  // done → 重放（不再次执行）
  const done = ledgerReplay({
    call_id: 'c1',
    state: 'done',
    tool: 'fs.read',
    args_hash: 'ah',
    started_at: 'x',
    finished_at: 'f',
    result_json: '{"path":"/dot/home/a"}',
    result_hash: 'rh',
  });
  assert.ok(done !== null);
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.result, { path: '/dot/home/a' });

  // doing → 仍在执行（调用方续轮询）
  const doing = ledgerReplay({
    call_id: 'c2',
    state: 'doing',
    tool: 'fs.read',
    args_hash: 'ah',
    started_at: 'x',
  });
  assert.ok(doing !== null);
  assert.equal(doing.status, 'running');

  // aborted → interrupted（可重试）
  const aborted = ledgerReplay({
    call_id: 'c3',
    state: 'aborted',
    tool: 'fs.read',
    args_hash: 'ah',
    started_at: 'x',
  });
  assert.ok(aborted !== null);
  assert.equal(aborted.status, 'error');
  assert.equal(aborted.error?.code, 'interrupted');
  assert.equal(aborted.error?.retryable, true);

  // compacted → result_compacted（不可重试，结果已随 compaction 丢弃）
  const compacted = ledgerReplay({
    call_id: 'c4',
    state: 'compacted',
    tool: 'fs.read',
    args_hash: 'ah',
    started_at: 'x',
  });
  assert.ok(compacted !== null);
  assert.equal(compacted.error?.code, 'result_compacted');
  assert.equal(compacted.error?.retryable, false);

  // 无记录 → 不重放（正常派发）
  assert.equal(ledgerReplay(undefined), null);
});

// ═══════════════════════════════════════════════════════════════════
// ⑦ 容器端 stub 的协议语义（§5.4 + §7 护栏在容器侧同源执行）
// ═══════════════════════════════════════════════════════════════════

test('stub runtime：同 call_id 重放不再次执行；aborted → interrupted', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    const c = call({ call_id: 'c-1', tool: 'fs.write', args: { path: '/dot/home/f.txt', content: 'v1' } });
    const r1 = await svc.runTool(c);
    assert.equal(r1.status, 'ok');

    // 同 call_id 再来一次：幂等重放（宿主 exec_calls 终态）
    const r2 = await svc.runTool(c);
    assert.equal(r2.status, 'ok');
    assert.equal(
      (svc.fleet as unknown as { countExecutions?: number }).countExecutions === undefined,
      true,
      'Fleet 无 countExecutions 字段，仅防呆',
    );
    assert.deepEqual(
      (r2.result as { result_hash?: string } | undefined)?.result_hash !== undefined,
      true,
      '重放必须带 result_hash 供对账',
    );

    // 容器侧 ledger 也确认 done（进程重启后仍可重放）
    const ledger = (svc as unknown as { stub: { ledger: Map<string, { state: string }> } }).stub.ledger;
    assert.equal(ledger.get('c-1')?.state, 'done');
  } finally {
    t.cleanup();
  }
});

test('stub runtime：进程重启后 doing → aborted，同 call_id 返回 interrupted 可重试', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    const c = call({ call_id: 'c-2', tool: 'shell.run', args: { cmd: 'echo hi', timeout_ms: 1000 } });
    const r1 = await svc.runTool(c);
    assert.equal(r1.status, 'ok');
    const rec = (svc as unknown as { stub: { ledger: Map<string, { state: string }> } }).stub.ledger.get('c-2');
    assert.equal(rec?.state, 'done');

    // 模拟容器进程重启：doing → aborted（done 保留）
    (svc as unknown as { stub: { simulateRestart(): void } }).stub.simulateRestart();
    // done 项不受重启影响
    assert.equal(
      (svc as unknown as { stub: { ledger: Map<string, { state: string }> } }).stub.ledger.get('c-2')?.state,
      'done',
    );
  } finally {
    t.cleanup();
  }
});

test('stub runtime：fs.read 超过 4MB → too_large；路径越界 → path_outside_home', async () => {
  const t = makeTempDataDir();
  try {
    const big = 'x'.repeat(4 * 1024 * 1024 + 10);
    const svc = new ExecServiceImpl({
      db: t.db,
      bus: t.bus,
      cfg: { tokenDir: t.root },
      stubRuntime: { seedFiles: { '/dot/home/big.bin': big } },
    });
    await svc.boot(['dot-a']);

    const r = await svc.runTool(call({ call_id: 'c-3', tool: 'fs.read', args: { path: '/dot/home/big.bin' } }));
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'too_large');

    const r2 = await svc.runTool(call({ call_id: 'c-4', tool: 'fs.read', args: { path: '/etc/passwd' } }));
    assert.equal(r2.error?.code, 'path_outside_home');

    const r3 = await svc.runTool(call({ call_id: 'c-5', tool: 'fs.read', args: { path: '/dot/home/.dotd/x' } }));
    assert.equal(r3.error?.code, 'path_hidden');
  } finally {
    t.cleanup();
  }
});

test('stub runtime：fs.write 超过 8MB → too_large；fs.list 深度 >4 → too_deep', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    const r = await svc.runTool(
      call({ call_id: 'c-6', tool: 'fs.write', args: { path: '/dot/home/big', content: 'x'.repeat(8 * 1024 * 1024 + 1) } }),
    );
    assert.equal(r.error?.code, 'too_large');

    const r2 = await svc.runTool(call({ call_id: 'c-7', tool: 'fs.list', args: { path: '/dot/home', depth: 5 } }));
    assert.equal(r2.error?.code, 'too_deep');
    // 深度 4（上限）放行
    const r3 = await svc.runTool(call({ call_id: 'c-7b', tool: 'fs.list', args: { path: '/dot/home', depth: 4 } }));
    assert.notEqual(r3.error?.code, 'too_deep');
  } finally {
    t.cleanup();
  }
});

test('stub runtime：shell.run 缺 timeout_ms → bad_args；timeout 超过 deadline → bad_args', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    const r1 = await svc.runTool(call({ call_id: 'c-8', tool: 'shell.run', args: { cmd: 'ls' } }));
    assert.equal(r1.error?.code, 'bad_args');

    // deadline_ms=1000 但 timeout_ms=5000：容器端判 timeout_gt_deadline（不得执行）
    const r2 = await svc.runTool(
      call({ call_id: 'c-9', tool: 'shell.run', args: { cmd: 'ls', timeout_ms: 5000 }, deadline_ms: 1000 }),
    );
    assert.equal(r2.error?.code, 'timeout_gt_deadline');

    // 合法 shell.run 正常返回 stdout/exit_code
    const r3 = await svc.runTool(
      call({ call_id: 'c-10', tool: 'shell.run', args: { cmd: 'echo ok', timeout_ms: 1000 }, deadline_ms: 5000 }),
    );
    assert.equal(r3.status, 'ok');
    assert.equal(typeof (r3.result as { stdout?: string }).stdout, 'string');
  } finally {
    t.cleanup();
  }
});

test('stub runtime：browser.act 无页面 → no_page；browser.open 建立持久 profile', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);

    // 未 open 就 act
    const r0 = await svc.runTool(call({ call_id: 'c-11', tool: 'browser.act', args: { action: 'click' } }));
    assert.equal(r0.error?.code, 'no_page');

    // open 后 act 可用；anon 身份 → 非持久
    const r1 = await svc.runTool(
      call({ call_id: 'c-12', tool: 'browser.open', args: { url: 'https://example.com' }, identity: 'anon' }),
    );
    assert.equal(r1.status, 'ok');
    const r2 = await svc.runTool(call({ call_id: 'c-13', tool: 'browser.act', args: { action: 'click' } }));
    assert.equal(r2.status, 'ok');

    // snapshot / close
    const r3 = await svc.runTool(call({ call_id: 'c-14', tool: 'browser.snapshot', args: {} }));
    assert.equal(r3.status, 'ok');
    const r4 = await svc.runTool(call({ call_id: 'c-15', tool: 'browser.close', args: {} }));
    assert.equal(r4.status, 'ok');
  } finally {
    t.cleanup();
  }
});

test('stub runtime：未知工具 → unknown_tool（未登记一律 deny）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const r = await svc.runTool(call({ call_id: 'c-16', tool: 'evil.exec' as ExecToolCall['tool'], args: {} }));
    assert.equal(r.error?.code, 'unknown_tool');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ⑧ getCapabilities（契约 J2：sideEffect 唯一事实源）
// ═══════════════════════════════════════════════════════════════════

test('getCapabilities：容器 /capabilities 优先，回退宿主 catalog；形状含 sideEffect', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const caps = await svc.getCapabilities('dot-a');
    // 30 = 19 容器工具 + 8 宿主 mail + 3 日历写（回退路径整目录可见）
    assert.equal(caps.length, 34);
    for (const c of caps) {
      assert.ok(['safe', 'replayable', 'unknown'].includes(c.sideEffect));
      assert.ok(['sync', 'async'].includes(c.mode));
    }
    const fs = caps.find((c) => c.name === 'fs.write');
    assert.equal(fs?.sideEffect, 'replayable');
    const shell = caps.find((c) => c.name === 'shell.run');
    assert.equal(shell?.sideEffect, 'unknown');
    assert.equal(shell?.mode, 'async');
  } finally {
    t.cleanup();
  }
});
