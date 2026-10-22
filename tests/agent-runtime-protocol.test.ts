/**
 * tests/agent-runtime-protocol.test.ts —— 工具协议编解码 + 能力目录 + 防漂移（EX §5.2/§5.3）。
 *
 * 覆盖：
 * 1. parseToolCall / parseToolResult / parseFsOpsRequest 的编解码与错误码
 * 2. hashArgs 稳定性（键序无关、跨进程同值）
 * 3. 能力目录：11 名、mode 归属、sync deadline 硬顶、sideEffect 档位
 * 4. **防漂移**：agent-runtime/protocol.ts ↔ src/shared/contracts.ts 的双向类型
 *    精确断言（镜像内协议与宿主协议必须同形；src/exec/protocol.ts 落地后同断言适用）
 * 5. fs 护栏（EX §7）：path_outside_home / symlink_escape / path_hidden / too_large / too_deep
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CAPABILITIES,
  ERROR_CODES,
  FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
  ProtocolError,
  SYNC_MAX_DEADLINE_MS,
  SHELL_OUTPUT_MAX_BYTES,
  TOOL_NAMES,
  canonicalJson,
  capabilityOf,
  errorResult,
  hashArgs,
  isToolName,
  okResult,
  parseFsOpsRequest,
  parseToolCall,
  parseToolResult,
  runningResult,
  type Capability,
  type SideEffect,
  type ToolCall,
  type ToolName,
  type ToolResult,
} from '../agent-runtime/protocol.ts';
import { FsTools, HOME_ROOT } from '../agent-runtime/fs.ts';
import { ENV_WHITELIST, SHELL_UID, buildShellEnv, parseShellArgs } from '../agent-runtime/shell.ts';

// 跨模块类型：只从 shared/contracts.ts 引（CONVENTIONS §3）
import {
  isLoginSensitive,
  type Capability as ContractCapability,
  type ExecToolCall,
  type ExecToolResult,
  type SideEffect as ContractSideEffect,
} from '../src/shared/contracts.ts';

// 宿主侧协议（src/exec/protocol.ts，EX 模块）：常量与算法必须与容器内逐字同源。
// 注意：只 import **值/常量**做运行期比对，不 import 宿主类型（避免跨模块类型耦合）。
import {
  CAPABILITY_CATALOG,
  FS_LIST_MAX_DEPTH as HOST_FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES as HOST_FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES as HOST_FS_WRITE_MAX_BYTES,
  HOME_ROOT as HOST_HOME_ROOT,
  LEDGER_COMPACT_THRESHOLD as HOST_COMPACT_THRESHOLD,
  TOOL_NAMES as HOST_TOOL_NAMES,
  argsHash as hostArgsHash,
  checkHomePath as hostCheckHomePath,
  identityHash as hostIdentityHash,
  stableStringify,
} from '../src/exec/protocol.ts';

// ── 防漂移：类型级断言（编译期即失败，见 tsc --noEmit）─────────────────
//
// `Exact<A,B>` 用"函数参数逆变探针"判定两个类型是否**结构完全相同**
// （比 extends 更严：会抓出多余/缺失的可选属性）。
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
/** 编译不过就报错（不会留到运行期）。 */
type Expect<T extends true> = T;

type _ToolCallSame = Expect<Exact<ToolCall, ExecToolCall>>;
type _ToolResultSame = Expect<Exact<ToolResult, ExecToolResult>>;
type _CapabilitySame = Expect<Exact<Capability, ContractCapability>>;
type _ToolNameSame = Expect<Exact<ToolName, import('../src/shared/contracts.ts').ToolName>>;
type _SideEffectSame = Expect<Exact<SideEffect, ContractSideEffect>>;
// 契约 G1 谓词必须能直接吃容器内 ToolCall（顶层 identity，无 args.with_identity）
type _G1Consumable = Expect<
  Exact<Parameters<typeof isLoginSensitive>[0], { tool: string; identity?: string | null }>
>;

// 下面这组常量只为"被引用"，防止 noUnusedLocals 误删上面这些类型断言的语义说明。
const _driftProof: [
  _ToolCallSame,
  _ToolResultSame,
  _CapabilitySame,
  _ToolNameSame,
  _SideEffectSame,
  _G1Consumable,
] = [true, true, true, true, true, true];

// ═══════════════════════════════════════════════════════════════════
// 0. 与宿主 src/exec/protocol.ts 的防漂移（运行期比对）
//
// 镜像内只有 agent-runtime/（§3.1 COPY），宿主协议进不了容器，所以"严格对齐"
// 只能靠测试守着：两侧的**词表、mode、sideEffect、护栏常量、hash 算法**必须一致。
// ═══════════════════════════════════════════════════════════════════

test('防漂移: 词表与宿主 CAPABILITY_CATALOG 逐个同形（name/mode/sideEffect）', () => {
  // 宿主侧工具（schedule.* 等）不进容器：它们由 daemon 直接执行，
  // 容器能力目录里不该有。所以对比时只比"容器内工具"。
  const HOST_SIDE_ONLY = new Set([
    'schedule.create', 'schedule.list', 'schedule.remove',
    // mail 8 件套（2026-10-20）：同样只在 daemon 里跑，不进容器
    'mail.account.add', 'mail.account.list', 'mail.account.remove',
    'mail.list', 'mail.read', 'mail.search', 'mail.draft', 'mail.send',
    // 日历写 3 件套（2026-10-21，task-1）：同样只在 daemon 里跑，不进容器
    'calendar.add', 'calendar.edit', 'calendar.delete', 'calendar.list', 'calendar.conflicts', 'calendar.day', 'calendar.rest',
    'github.notifications', 'github.issues', 'github.pulls', 'rss.read',
    'vault.sites',
    // W2（2026-10-21）：浏览器三件套在宿主上跑 agent-browser CLI，不进容器
    'web.snapshot', 'web.read', 'web.act',
    // 2026-10-22：搜索走宿主上的 argo CLI，容器里没有 argo，不进容器
    'search.web', 'search.fetch',
    // 2026-10-22：memory.search 直接读宿主的 mem_messages（FTS5），容器里没有库，不进容器
    'memory.search',
  ]);
  assert.deepEqual(
    CAPABILITIES.map((c) => c.name),
    [...HOST_TOOL_NAMES].filter((n) => !HOST_SIDE_ONLY.has(n)),
    '容器工具词表必须与宿主的容器工具一致',
  );
  for (const mine of CAPABILITIES) {
    const host = CAPABILITY_CATALOG.find((c) => c.name === mine.name);
    assert.ok(host !== undefined, `宿主目录缺少 ${mine.name}`);
    assert.equal(mine.mode, host.mode, `${mine.name} mode 漂移`);
    assert.equal(mine.sideEffect, host.sideEffect, `${mine.name} sideEffect 漂移`);
    assert.equal(
      typeof mine.args_schema,
      typeof host.args_schema,
      `${mine.name} args_schema 类型漂移`,
    );
  }
});

test('防漂移: 护栏常量与宿主逐字一致（§7 硬护栏）', () => {
  assert.equal(HOME_ROOT, HOST_HOME_ROOT);
  assert.equal(FS_READ_MAX_BYTES, HOST_FS_READ_MAX_BYTES);
  assert.equal(FS_WRITE_MAX_BYTES, HOST_FS_WRITE_MAX_BYTES);
  assert.equal(FS_LIST_MAX_DEPTH, HOST_FS_LIST_MAX_DEPTH);
  assert.equal(DEFAULT_COMPACT_THRESHOLD_LEDGER, HOST_COMPACT_THRESHOLD);
});

test('防漂移: args_hash / identity_hash 与宿主同算法同值（幂等对账的前提）', () => {
  const cases: Array<Record<string, unknown>> = [
    { path: 'notes/a.md' },
    { path: 'a.md', depth: 2 },
    { b: 1, a: { y: 1, x: [1, 2] } },
    {},
    { path: 'a.md', extra: undefined }, // 显式 undefined 键必须被滤掉
    { cmd: 'ls -la', timeout_ms: 5000, cwd: 'notes' },
  ];
  for (const args of cases) {
    assert.equal(hashArgs(args), hostArgsHash(args), `args_hash 漂移：${canonicalJson(args)}`);
    assert.equal(canonicalJson(args), stableStringify(args), `序列化漂移：${JSON.stringify(args)}`);
  }
  // identityHash：同输入同值（profile 目录名两侧必须一致，否则登录态对不上）
  for (const id of ['alice', 'bob@example.com', 'anon']) {
    assert.equal(identityHashOf(id), hostIdentityHash(id), `identity_hash 漂移：${id}`);
  }
});

test('防漂移: fs 护栏错误码与宿主 checkHomePath 同码名（宿主按 code 分流）', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    // 每个越界情形：宿主 checkHomePath 的 code 必须等于容器侧回给宿主的 code
    const samples: Array<[string, string]> = [
      ['/etc/passwd', 'path_outside_home'],
      ['../outside.md', 'path_outside_home'],
    ];
    for (const [p, expected] of samples) {
      assert.equal(hostCheckHomePath(p).code, expected, `宿主侧码名变了：${p}`);
      assert.equal(fs.read('c1', { path: p }).error?.code, expected, `容器侧码名漂移：${p}`);
    }
    // 隐藏前缀：宿主与容器都必须给 path_hidden。
    // 宿主的隐藏前缀硬编码为 /dot/home/.dotd（容器内 homeRoot 恰为 /dot/home），
    // 所以宿主侧只能用字面容器路径采样；容器侧 homeRoot 可注入，用临时根验证同一语义。
    mkdirSync(join(t.home, '.dotd'), { recursive: true });
    writeFileSync(join(t.home, '.dotd', 'token'), 's', 'utf8');
    assert.equal(hostCheckHomePath('/dot/home/.dotd/token').code, 'path_hidden');
    assert.equal(fs.read('c1', { path: '.dotd/token' }).error?.code, 'path_hidden');
    // 合法路径：宿主侧给字面 /dot/home 下的路径，容器侧给临时根下的同一相对路径
    assert.equal(hostCheckHomePath('/dot/home/notes/a.md').ok, true);
    assert.equal(fs.read('c1', { path: 'notes/a.md' }).status, 'ok');
  } finally {
    t.cleanup();
  }
});

// 上面用到的两个别名（避免在断言里写长路径）
const DEFAULT_COMPACT_THRESHOLD_LEDGER = 5000;
function identityHashOf(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// 1. parseToolCall
// ═══════════════════════════════════════════════════════════════════

const VALID_CALL = {
  call_id: '01JABCDEF',
  task_id: 'task1',
  dot_id: 'dot1',
  tool: 'fs.read',
  args: { path: 'notes/a.md' },
  deadline_ms: 30_000,
  issued_at: '2026-10-15T00:00:00.000Z',
};

test('parseToolCall: 合法请求解析出全部字段', () => {
  const c = parseToolCall(VALID_CALL);
  assert.equal(c.call_id, '01JABCDEF');
  assert.equal(c.tool, 'fs.read');
  assert.deepEqual(c.args, { path: 'notes/a.md' });
  assert.equal(c.deadline_ms, 30_000);
  assert.equal(c.identity, undefined, 'identity 可缺（非 browser 工具）');
});

test('parseToolCall: identity 是顶层字段（契约 G1，无 args.with_identity）', () => {
  const c = parseToolCall({ ...VALID_CALL, tool: 'browser.open', identity: 'alice' });
  assert.equal(c.identity, 'alice');
  assert.equal(c.args.with_identity, undefined);
  // 契约 G1 谓词能直接消费
  assert.equal(isLoginSensitive(c), true);
  assert.equal(
    isLoginSensitive(parseToolCall({ ...VALID_CALL, tool: 'browser.open', identity: 'anon' })),
    false,
  );
  assert.equal(isLoginSensitive(parseToolCall(VALID_CALL)), false);
});

test('parseToolCall: browser.* 缺 identity → fail-closed 拒绝（契约 G1，不降级匿名档）', () => {
  // 接缝契约 G1：「identity 缺失（undefined）且工具为 browser.* → fail-closed
  // 按登录态」。原实现把缺失一律当 'anon' 落 ephemeral（最弱的匿名档），
  // 与 fail-closed 相反（审码 issue H）。
  assert.throws(
    () => parseToolCall({ ...VALID_CALL, tool: 'browser.open' }),
    (e: unknown) =>
      e instanceof ProtocolError &&
      e.code === ERROR_CODES.identity_required &&
      /identity/.test(e.message),
  );
  // 'anon' 是显式匿名（契约允许的表示法），必须放行
  assert.equal(
    parseToolCall({ ...VALID_CALL, tool: 'browser.open', identity: 'anon' }).identity,
    'anon',
  );
  // 非 browser 工具无 identity 概念，不受影响
  assert.equal(parseToolCall(VALID_CALL).identity, undefined);
});

test('parseToolCall: 未知工具名 → unknown_tool', () => {
  assert.throws(
    () => parseToolCall({ ...VALID_CALL, tool: 'fs.delete' }),
    (e: unknown) => e instanceof ProtocolError && e.code === ERROR_CODES.unknown_tool,
  );
});

test('parseToolCall: 缺字段/空串/非正数 → bad_request', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['缺 call_id', { ...VALID_CALL, call_id: undefined }],
    ['空 task_id', { ...VALID_CALL, task_id: '' }],
    ['args 非对象', { ...VALID_CALL, args: 'x' }],
    ['args 是数组', { ...VALID_CALL, args: [] }],
    ['deadline_ms=0', { ...VALID_CALL, deadline_ms: 0 }],
    ['deadline_ms 非数', { ...VALID_CALL, deadline_ms: '30' }],
    ['缺 issued_at', { ...VALID_CALL, issued_at: undefined }],
  ];
  for (const [name, body] of bad) {
    assert.throws(
      () => parseToolCall(body),
      (e: unknown) => e instanceof ProtocolError && e.code === ERROR_CODES.bad_request,
      name,
    );
  }
});

test('parseToolCall: identity 非字符串 → bad_request', () => {
  assert.throws(
    () => parseToolCall({ ...VALID_CALL, identity: 42 }),
    (e: unknown) => e instanceof ProtocolError && e.code === ERROR_CODES.bad_request,
  );
});

test('parseToolCall: 非 object 输入 → bad_request', () => {
  for (const v of [null, 'x', 42, []]) {
    assert.throws(
      () => parseToolCall(v),
      (e: unknown) => e instanceof ProtocolError,
      JSON.stringify(v),
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. parseToolResult
// ═══════════════════════════════════════════════════════════════════

test('parseToolResult: ok/error/cancelled/running 四态可解析', () => {
  const ok = parseToolResult({
    call_id: 'c1',
    status: 'ok',
    result: { content: 'hi' },
    usage: { wall_ms: 3, peak_mem_mb: 0 },
    finished_at: 'T1',
  });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.result, { content: 'hi' });
  assert.deepEqual(ok.usage, { wall_ms: 3, peak_mem_mb: 0 });

  const err = parseToolResult({
    call_id: 'c1',
    status: 'error',
    error: { code: 'bad_args', message: 'x', retryable: false },
  });
  assert.equal(err.error?.code, 'bad_args');
  assert.equal(err.error?.retryable, false);

  assert.equal(parseToolResult({ call_id: 'c1', status: 'cancelled' }).status, 'cancelled');
  assert.equal(parseToolResult({ call_id: 'c1', status: 'running' }).status, 'running');
  assert.equal(parseToolResult({ call_id: 'c1', status: 'running', job_id: 'j1' }).job_id, 'j1');
});

test('parseToolResult: error 缺 code/retryable → bad_request', () => {
  for (const e of [
    { code: 'x' },
    { code: 'x', message: 'm' },
    { code: 'x', retryable: 'no' },
  ]) {
    assert.throws(
      () => parseToolResult({ call_id: 'c1', status: 'error', error: e }),
      (err: unknown) => err instanceof ProtocolError,
    );
  }
});

test('parseToolResult: status 非法 → bad_request', () => {
  assert.throws(
    () => parseToolResult({ call_id: 'c1', status: 'weird' }),
    (e: unknown) => e instanceof ProtocolError && e.code === ERROR_CODES.bad_request,
  );
});

// ═══════════════════════════════════════════════════════════════════
// 3. parseFsOpsRequest（契约 S4'）
// ═══════════════════════════════════════════════════════════════════

test('parseFsOpsRequest: read/list/stat/rename 四 op', () => {
  assert.deepEqual(parseFsOpsRequest({ op: 'read', path: 'notes/a.md' }), {
    op: 'read',
    path: 'notes/a.md',
  });
  assert.deepEqual(parseFsOpsRequest({ op: 'rename', path: 'a.md', target: 'b.md' }), {
    op: 'rename',
    path: 'a.md',
    target: 'b.md',
  });
  assert.deepEqual(parseFsOpsRequest({ op: 'list', path: 'notes', dotId: 'dot1' }), {
    op: 'list',
    path: 'notes',
    dotId: 'dot1',
  });
});

test('parseFsOpsRequest: rename 必须带 target（契约逐字）', () => {
  assert.throws(
    () => parseFsOpsRequest({ op: 'rename', path: 'a.md' }),
    (e: unknown) => e instanceof ProtocolError && e.code === ERROR_CODES.bad_request,
  );
  assert.throws(() => parseFsOpsRequest({ op: 'rename', path: 'a.md', target: '' }), ProtocolError);
});

test('parseFsOpsRequest: op 非法 / path 空 → bad_request', () => {
  assert.throws(() => parseFsOpsRequest({ op: 'delete', path: 'a.md' }), ProtocolError);
  assert.throws(() => parseFsOpsRequest({ op: 'read', path: '' }), ProtocolError);
  assert.throws(() => parseFsOpsRequest({ op: 'read', path: 'a.md', target: 7 }), ProtocolError);
});

// ═══════════════════════════════════════════════════════════════════
// 4. hashArgs / canonicalJson
// ═══════════════════════════════════════════════════════════════════

test('hashArgs: 同 args 不同键序同 hash（ledger 记账可跨进程比对）', () => {
  const a = hashArgs({ path: 'a.md', depth: 2, opts: { x: 1, y: [1, 2] } });
  const b = hashArgs({ opts: { y: [1, 2], x: 1 }, depth: 2, path: 'a.md' });
  assert.equal(a, b);
  assert.notEqual(a, hashArgs({ path: 'b.md', depth: 2, opts: { x: 1, y: [1, 2] } }));
  assert.notEqual(a, hashArgs({ path: 'a.md', depth: 3, opts: { x: 1, y: [1, 2] } }));
});

test('canonicalJson: 嵌套对象键排序，undefined 值键被滤除（与宿主 stableStringify 同算法）', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([1, 'x', null, true]), '[1,"x",null,true]');
  assert.equal(canonicalJson(undefined), 'null'); // JSON.stringify(undefined) → undefined → 兜底 'null'
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  // 显式 undefined 的键不参与 hash（宿主 stableStringify 同规则）
  assert.equal(canonicalJson({ path: 'a.md', depth: 2, extra: undefined }), '{"depth":2,"path":"a.md"}');
  assert.equal(canonicalJson({ a: undefined }), '{}');
  // 顶层 undefined 值保留为 null（与宿主一致）
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

// ═══════════════════════════════════════════════════════════════════
// 5. 能力目录
// ═══════════════════════════════════════════════════════════════════

test('能力目录: 容器内工具与契约词表一致（宿主侧工具不在其中）', () => {
  const HOST_SIDE_ONLY = new Set(['schedule.create', 'schedule.list', 'schedule.remove']);
  const hostToolsInContainer = [...TOOL_NAMES].filter((n) => HOST_SIDE_ONLY.has(n));
  assert.equal(CAPABILITIES.length, TOOL_NAMES.length - hostToolsInContainer.length);
  assert.equal(new Set(CAPABILITIES.map((c) => c.name)).size, CAPABILITIES.length);
  assert.deepEqual(
    CAPABILITIES.map((c) => c.name),
    [...TOOL_NAMES],
  );
  for (const n of TOOL_NAMES) assert.ok(isToolName(n));
  assert.equal(isToolName('fs.delete'), false);
  assert.equal(isToolName(undefined), false);
});

test('能力目录: mode 归属 = fs.* 为 sync，其余 async（EX §5.2 判据句）', () => {
  const sync = CAPABILITIES.filter((c) => c.mode === 'sync').map((c) => c.name);
  assert.deepEqual(sync, ['fs.read', 'fs.write', 'fs.list', 'fs.grep', 'fs.stat', 'fs.remove', 'tool.list', 'tool.create', 'tool.invoke']);
  for (const c of CAPABILITIES) {
    // sync 判据（2026-10-19 更新）：fs.*（纯本地文件操作）与 tool.*（本地工具存取/子进程，
    // 不走跨机排队）都是 sync；其余 shell/browser/net 是 async（可能长跑、要占 job 槽位）。
    const syncFamily = c.name.startsWith('fs.') || c.name.startsWith('tool.');
    if (syncFamily) assert.equal(c.mode, 'sync', c.name);
    else assert.equal(c.mode, 'async', c.name);
    // sync 一律压在 60s 硬顶内
    if (c.mode === 'sync') assert.ok(c.max_deadline_ms <= SYNC_MAX_DEADLINE_MS, c.name);
  }
});

test('能力目录: sideEffect 档位（契约 J2：未声明按 unknown）', () => {
  // 与宿主 CAPABILITY_CATALOG 逐字一致（防漂移用例另做机器比对）
  const expect: Record<string, SideEffect> = {
    'fs.read': 'safe',
    'fs.write': 'replayable',
    'fs.list': 'safe',
    'fs.grep': 'safe',
    'fs.stat': 'safe',
    'fs.remove': 'unknown',
    'shell.run': 'unknown',
    'browser.open': 'unknown',
    'browser.act': 'unknown',
    'browser.snapshot': 'safe',
    'browser.screenshot': 'safe',
    'browser.close': 'safe',
    'net.get': 'safe',
    'net.post': 'unknown',
    'tool.list': 'safe',
    'tool.create': 'unknown',
    'tool.invoke': 'unknown',
  };
  for (const c of CAPABILITIES) {
    assert.equal(c.sideEffect, expect[c.name], `${c.name} sideEffect`);
    assert.ok(['safe', 'replayable', 'unknown'].includes(c.sideEffect));
  }
  // 每个 catalog 项都带 args_schema（治理建权限映射用）
  for (const c of CAPABILITIES) {
    assert.equal(typeof c.args_schema, 'object');
    assert.ok(c.args_schema !== null);
  }
});

test('capabilityOf: 命中/未命中', () => {
  assert.equal(capabilityOf('shell.run')?.mode, 'async');
  assert.equal(capabilityOf('fs.read')?.mode, 'sync');
  assert.equal(capabilityOf('fs.delete'), undefined);
});

// ═══════════════════════════════════════════════════════════════════
// 6. 结果构造器
// ═══════════════════════════════════════════════════════════════════

test('结果构造器: ok/error/running 形状', () => {
  const ok = okResult('c1', { v: 1 }, { wall_ms: 5, peak_mem_mb: 1 }, 'j1');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.job_id, 'j1');
  assert.equal(typeof ok.finished_at, 'string');

  const e = errorResult('c1', ERROR_CODES.too_large, 'too big', false);
  assert.equal(e.status, 'error');
  assert.equal(e.error?.code, 'too_large');
  assert.equal(e.error?.retryable, false);

  const r = runningResult('c1');
  assert.equal(r.status, 'running');
  assert.equal(r.finished_at, undefined, 'running 无终态时间');
});

test('结果构造器: errorResult 可带 result 与 usage（EX §5.5 截尾输出路径）', () => {
  const e = errorResult('c1', ERROR_CODES.deadline_exceeded, 'timeout', true, {
    result: { exit_code: null, stdout: '...' },
    usage: { wall_ms: 1000, peak_mem_mb: 0 },
  });
  assert.deepEqual(e.result, { exit_code: null, stdout: '...' });
  assert.equal(e.usage?.wall_ms, 1000);
});

test('parseToolResult(okResult(...)) 往返稳定', () => {
  const r = okResult('c1', { content: 'hi' }, { wall_ms: 1, peak_mem_mb: 0 });
  assert.deepEqual(parseToolResult(JSON.parse(JSON.stringify(r))), r);
});

// ═══════════════════════════════════════════════════════════════════
// 7. fs 护栏（EX §7）—— 用临时目录当 home 卷
// ═══════════════════════════════════════════════════════════════════

interface Tmp {
  home: string;
  cleanup(): void;
}

function makeHome(): Tmp {
  const home = mkdtempSync(join(tmpdir(), 'dotd-fs-home-'));
  mkdirSync(join(home, 'notes'), { recursive: true });
  writeFileSync(join(home, 'notes', 'a.md'), 'hello world', 'utf8');
  let cleaned = false;
  return {
    home,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 在临时 home 里写一个文件（自动建父目录，如 notes/2026-10-20.md）。 */
function writeHome(home: string, rel: string, content: string): void {
  const abs = join(home, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

test('fs 护栏: HOME_ROOT 恒 /dot/home（容器内事实源）', () => {
  assert.equal(HOME_ROOT, '/dot/home');
});

test('fs.read: 正常读 + 相对路径归一化', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.read('c1', { path: 'notes/a.md' });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.result, {
      path: 'notes/a.md',
      size_bytes: 11,
      content_base64: undefined,
      content: 'hello world',
      truncated: false,
    });
  } finally {
    t.cleanup();
  }
});

test('fs.read: 绝对路径越出 home → path_outside_home', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.read('c1', { path: '/etc/passwd' });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, ERROR_CODES.path_outside_home);
  } finally {
    t.cleanup();
  }
});

test('fs.read: .. 穿越 → path_outside_home', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    assert.equal(fs.read('c1', { path: '../outside.md' }).error?.code, ERROR_CODES.path_outside_home);
    assert.equal(fs.read('c1', { path: 'notes/../../x' }).error?.code, ERROR_CODES.path_outside_home);
  } finally {
    t.cleanup();
  }
});

test('fs.read: .dotd/ 前缀 → path_hidden（契约 M4 纵深防御）', () => {
  const t = makeHome();
  try {
    mkdirSync(join(t.home, '.dotd'), { recursive: true });
    writeFileSync(join(t.home, '.dotd', 'token'), 'secret', 'utf8');
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.read('c1', { path: '.dotd/token' });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, ERROR_CODES.path_hidden);
  } finally {
    t.cleanup();
  }
});

test('fs.read: 目录/不存在 → not_a_file', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    assert.equal(fs.read('c1', { path: 'notes' }).error?.code, ERROR_CODES.not_a_file);
    assert.equal(fs.read('c1', { path: 'notes/none.md' }).error?.code, ERROR_CODES.not_a_file);
  } finally {
    t.cleanup();
  }
});

test('fs.read: 超过 4MB → too_large（EX §7 物理兜底）', () => {
  const t = makeHome();
  try {
    writeFileSync(join(t.home, 'big.bin'), Buffer.alloc(FS_READ_MAX_BYTES + 1));
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.read('c1', { path: 'big.bin' });
    assert.equal(r.error?.code, ERROR_CODES.too_large);
  } finally {
    t.cleanup();
  }
});

test('fs.write: 覆盖写 + 自动建父目录；>8MB → too_large', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.write('c1', { path: 'deep/nested/x.md', content: 'v1' });
    assert.equal(r.status, 'ok');
    assert.equal(JSON.parse(JSON.stringify(r.result)).size_bytes, 2);
    const big = fs.write('c2', { path: 'big.bin', content: 'x'.repeat(FS_WRITE_MAX_BYTES + 1) });
    assert.equal(big.error?.code, ERROR_CODES.too_large);
    // content_base64 分支
    const b64 = fs.write('c3', { path: 'b.md', content_base64: Buffer.from('hi').toString('base64') });
    assert.equal(b64.status, 'ok');
    // 两者都缺 → bad_args
    assert.equal(fs.write('c4', { path: 'b.md' }).error?.code, ERROR_CODES.bad_args);
  } finally {
    t.cleanup();
  }
});

test('fs.list: 深度上限 4，超出 → too_deep', () => {
  const t = makeHome();
  try {
    let p = t.home;
    for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      p = join(p, d);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'f.md'), 'x', 'utf8');
    }
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.list('c1', { path: '.', depth: 4 });
    assert.equal(r.status, 'ok');
    // depth 语义：1 = 直接子项；depth 4 到达 d1/d2/d3/d4 这四级里的 d3 的文件
    assert.ok(JSON.stringify(r.result).includes('d3/f.md'), 'depth=4 应到 d3 层');
    assert.ok(!JSON.stringify(r.result).includes('d4/f.md'), 'depth=4 不越到 d4 层');
    const over = fs.list('c2', { path: '.', depth: FS_LIST_MAX_DEPTH + 1 });
    assert.equal(over.error?.code, ERROR_CODES.too_deep);
    // 隐藏前缀在枚举中也被滤掉（纵深防御）
    mkdirSync(join(t.home, '.dotd'), { recursive: true });
    const hidden = fs.list('c3', { path: '.', depth: 1 });
    assert.ok(!JSON.stringify(hidden.result).includes('.dotd'));
  } finally {
    t.cleanup();
  }
});

test('fs.list/stat: 非目录 → not_a_directory / 不存在 → not_a_file', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    assert.equal(fs.list('c1', { path: 'notes/a.md' }).error?.code, ERROR_CODES.not_a_directory);
    assert.equal(fs.stat('c2', { path: 'notes/none.md' }).error?.code, ERROR_CODES.not_a_file);
    const st = fs.stat('c3', { path: 'notes/a.md' });
    assert.equal(st.status, 'ok');
    assert.equal(JSON.parse(JSON.stringify(st.result)).size_bytes, 11);
    assert.equal(JSON.parse(JSON.stringify(st.result)).type, 'file');
  } finally {
    t.cleanup();
  }
});

test('fs/ops: 扁平形状，rename 限 home 内（契约 S4-prime + MEM 铁律 B）', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const ok = fs.fsOps('rename', 'notes/a.md', 'notes/b.md');
    assert.equal(ok.op, 'rename');
    assert.equal(ok.ok, true);
    assert.equal(ok.target, 'notes/b.md', 'rename 回显目标（home 相对）');
    // read/list/stat 复用同一套护栏，且都是**扁平**形状
    const out = fs.fsOps('rename', 'notes/b.md', '/tmp/evil.md');
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, ERROR_CODES.path_outside_home);
    assert.equal(fs.fsOps('stat', 'notes/b.md').ok, true);
    assert.equal(fs.fsOps('list', 'notes').ok, true);
  } finally {
    t.cleanup();
  }
});

test('fs/ops: 扁平字段正是宿主 FsOpsHttpBridge 读的那几个（审码 issue C 回归防线）', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeFileSync(join(t.home, 'notes', 'a.md'), 'hello', 'utf8');
    // read：宿主读 body.content
    const r = fs.fsOps('read', 'notes/a.md');
    assert.equal(r.ok, true);
    assert.equal(r.content, 'hello');
    assert.equal(r.encoding, 'utf8');
    // list：宿主读 body.entries[]，每项要 path/name/type + sizeBytes
    const l = fs.fsOps('list', 'notes');
    assert.equal(l.ok, true);
    assert.ok(Array.isArray(l.entries));
    const e0 = l.entries![0]!;
    assert.equal(e0.name, 'a.md');
    assert.equal(e0.path, 'notes/a.md');
    assert.equal(e0.type, 'file');
    assert.equal(e0.sizeBytes, 5, 'MEM 的 FsOpsListEntry.sizeBytes（camelCase）');
    assert.equal(typeof e0.mtimeMs, 'number', 'MEM 的 mtimeMs');
    // stat：宿主读 body.stat，且要求 sizeBytes（camelCase）
    const s = fs.fsOps('stat', 'notes/a.md');
    assert.equal(s.ok, true);
    assert.ok(s.stat !== undefined);
    assert.equal(s.stat!.sizeBytes, 5);
    assert.equal(s.stat!.isDir, false);
    assert.equal(typeof s.stat!.mtimeMs, 'number');
  } finally {
    t.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 8. shell.run 参数/env（EX §7 + 契约 T5）
// ═══════════════════════════════════════════════════════════════════

test('shell 参数: cmd/timeout_ms 必填，cwd 可选', () => {
  assert.deepEqual(parseShellArgs({ cmd: 'ls', timeout_ms: 1000 }), { cmd: 'ls', timeout_ms: 1000 });
  assert.throws(
    () => parseShellArgs({ cmd: 'ls' }),
    (e: unknown) => (e as { code?: string }).code === ERROR_CODES.bad_args,
  );
  assert.throws(
    () => parseShellArgs({ cmd: 'ls', timeout_ms: 0 }),
    (e: unknown) => (e as { code?: string }).code === ERROR_CODES.bad_args,
  );
  assert.throws(
    () => parseShellArgs({ cmd: 'ls', timeout_ms: 1.5 }),
    (e: unknown) => (e as { code?: string }).code === ERROR_CODES.bad_args,
  );
});

test('shell env: 白名单 + HOME 覆写 + 剥光 DOTD_*（契约 T5 不注模型 base_url）', () => {
  const input: Record<string, string | undefined> = {
    PATH: '/usr/bin',
    HOME: '/host/home',
    LANG: 'C.UTF-8',
    DISPLAY: ':0',
    SHELL: '/bin/bash',
    SECRET_TOKEN: 'leak',
    DOTD_MODEL_BASE_URL: 'http://evil',
    DOTD_TOKEN: 'leak',
    AWS_SECRET: 'leak',
  };
  // buildShellEnv 返回的键集合由白名单静态决定，这里用宽松类型接住"不存在的键"
  const env: { readonly [k: string]: string | undefined } = buildShellEnv(input, '/dot/home');
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/dot/home', // 覆写成容器内 home 卷
    LANG: 'C.UTF-8',
    DISPLAY: ':0',
    SHELL: '/bin/bash',
  });
  // 剥光：白名单外的一切键都不出现在输出里（含 DOTD_* 与秘密）
  const stripped = ['DOTD_MODEL_BASE_URL', 'DOTD_TOKEN', 'SECRET_TOKEN', 'AWS_SECRET'];
  for (const k of stripped) {
    assert.equal(Object.prototype.hasOwnProperty.call(env, k), false, `${k} 必须被剥掉`);
  }
  assert.equal(Object.hasOwn(env, 'DOTD_MODEL_BASE_URL'), false, '契约 T5：容器内工具不得直连模型');
  assert.deepEqual(Object.keys(env).sort(), ['DISPLAY', 'HOME', 'LANG', 'PATH', 'SHELL']);
  assert.deepEqual([...ENV_WHITELIST], ['PATH', 'HOME', 'LANG', 'DISPLAY', 'SHELL']);
  assert.equal(SHELL_UID, 1001);
  assert.equal(SHELL_OUTPUT_MAX_BYTES, 1024 * 1024);
});

void _driftProof;

// ═══════════════════════════════════════════════════════════════════
// fs.grep（2026-10-22 新增）
//
// 加它的动机不是"功能补齐"，是**上下文记忆**：
// 在此之前模型的长期记忆只有"被塞进上下文"一条路，而那条路会被 token 预算
// 截断、会被摘要失真污染。没有按内容检索，模型想问"我们之前定过什么"只能
// 猜路径一个个 fs.read —— 实际行为是直接答"我没有上下文"。
// Letta 实测（benchmarking-ai-agent-memory）：只给文件系统工具让 agent 自己
// grep，LoCoMo 74.0%，高于专用记忆工具 Mem0 的 68.5%；结论是"会不会用检索
// 工具比检索机制本身更重要"。所以这些用例盯的是**行为**，不是部署形态。
// ═══════════════════════════════════════════════════════════════════

test('fs.grep: 按内容搜到文件路径 + 行号 + 原文', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'MEMORY.md', '# MEMORY\n- 暗号是 blue-lantern\n- 主人在做 dotd\n');
    writeHome(t.home, 'notes/2026-10-20.md', '今天讨论了烧烤地点\n约在怀柔白河湾\n');

    const r = fs.grep('g1', { path: '.', pattern: '暗号' });
    assert.equal(r.status, 'ok');
    const out = r.result as { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };
    assert.equal(out.matches.length, 1, '应命中 1 行');
    assert.equal(out.matches[0]!.path, 'MEMORY.md');
    assert.equal(out.matches[0]!.line, 2, '行号要准（1-based）');
    assert.ok(out.matches[0]!.text.includes('blue-lantern'), '原文要带回来');
    assert.equal(out.truncated, false);
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 递归子目录，跨文件命中', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'MEMORY.md', '无关内容\n');
    writeHome(t.home, 'notes/a.md', '烧烤方案 A\n');
    writeHome(t.home, 'notes/deep/b.md', '烧烤方案 B\n');

    const r = fs.grep('g2', { path: '.', pattern: '烧烤' });
    const out = r.result as { matches: Array<{ path: string }> };
    const paths = out.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ['notes/a.md', 'notes/deep/b.md'], '子目录也要搜到');
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 默认字面量匹配 —— . 和 * 不当通配符', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'a.md', 'sk-abc123\nskXabc123\n');
    // 字面量 "sk-" 只该命中第一行；若误当正则，"." 会通配到 skX 那行
    const r = fs.grep('g3', { path: '.', pattern: 'sk.abc' });
    const out = r.result as { matches: unknown[] };
    assert.equal(out.matches.length, 0, '字面量含 . 时不应把 . 当通配符');

    const r2 = fs.grep('g4', { path: '.', pattern: 'sk-abc' });
    assert.equal((r2.result as { matches: unknown[] }).matches.length, 1);
  } finally {
    t.cleanup();
  }
});

test('fs.grep: regex=true 才按正则；非法正则报 bad_args 而不是静默降级', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'a.md', 'item-111\nitem-222\nnope\n');
    const r = fs.grep('g5', { path: '.', pattern: 'item-\\d+', regex: true });
    assert.equal((r.result as { matches: unknown[] }).matches.length, 2, '正则应命中 2 行');

    const bad = fs.grep('g6', { path: '.', pattern: 'item-(', regex: true });
    assert.equal(bad.error?.code, ERROR_CODES.bad_args, '非法正则要显式报错，不能悄悄当字面量');
  } finally {
    t.cleanup();
  }
});

test('fs.grep: maxResults 生效并标 truncated + hint（防一次打爆上下文）', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const lines = Array.from({ length: 30 }, (_, i) => `命中行 ${i}`).join('\n');
    writeHome(t.home, 'big.md', `${lines}\n`);

    const r = fs.grep('g7', { path: '.', pattern: '命中行', maxResults: 5 });
    const out = r.result as { matches: unknown[]; truncated: boolean; hint?: string };
    assert.equal(out.matches.length, 5, '要尊重 maxResults');
    assert.equal(out.truncated, true, '截断了必须标记，否则模型以为搜完了');
    assert.ok(typeof out.hint === 'string' && out.hint.length > 0, '要给收窄建议');
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 二进制与超大文件跳过但不报错', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'text.md', '找得到这段话\n');
    // 含 NUL 的二进制
    writeFileSync(join(t.home, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x4e, 0x55, 0x4c]));
    const r = fs.grep('g8', { path: '.', pattern: '找得到' });
    assert.equal(r.status, 'ok', '二进制存在不该让整次搜索失败');
    assert.equal((r.result as { matches: unknown[] }).matches.length, 1);
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 沙箱不越界（与其它 fs.* 同口径）', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    const r = fs.grep('g9', { path: '/etc', pattern: 'root' });
    assert.equal(r.error?.code, 'path_outside_home', '不能借 grep 读宿主机');
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 归档目录垫底 —— 当前文件优先于历史备份', () => {
  // 真实踩到的坑（2026-10-22）：搜 "MEMORY" 时前 5 条全是
  // .archive/*__MEMORY.md 的历史快照，当前 MEMORY.md 一条都进不了结果，
  // 模型想问"现在记着什么"却只拿到旧备份 —— 比没有检索更糟。
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'MEMORY.md', '关键约定：暗号 blue-lantern\n');
    for (let i = 0; i < 5; i += 1) {
      writeHome(t.home, `.archive/2026-10-1${i}__MEMORY.md`, '关键约定：旧暗号 green\n');
    }
    writeHome(t.home, 'backup/MEMORY.md', '关键约定：旧暗号 red\n');

    const r = fs.grep('p1', { path: '.', pattern: '关键约定', maxResults: 3 });
    const out = r.result as { matches: Array<{ path: string }>; truncated: boolean };
    assert.equal(out.matches[0]!.path, 'MEMORY.md', '当前 MEMORY.md 必须排第一');
    // 归档虽垫底，但仍应被搜到（不能直接丢弃：模型可能就是来找旧版本的）
    const all = fs.grep('p2', { path: '.', pattern: '关键约定', maxResults: 50 });
    const paths = (all.result as { matches: Array<{ path: string }> }).matches.map((m) => m.path);
    assert.ok(paths.some((p) => p.startsWith('.archive/')), '归档要能搜到，只是排在后面');
  } finally {
    t.cleanup();
  }
});

test('fs.grep: 同层时浅路径优先', () => {
  const t = makeHome();
  try {
    const fs = new FsTools({ homeRoot: t.home });
    writeHome(t.home, 'notes/deep/x.md', '目标关键词\n');
    writeHome(t.home, 'top.md', '目标关键词\n');
    const r = fs.grep('p3', { path: '.', pattern: '目标关键词', maxResults: 1 });
    assert.equal((r.result as { matches: Array<{ path: string }> }).matches[0]!.path, 'top.md');
  } finally {
    t.cleanup();
  }
});
