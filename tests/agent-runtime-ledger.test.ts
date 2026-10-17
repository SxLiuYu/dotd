/**
 * tests/agent-runtime-ledger.test.ts —— 幂等 ledger 单测（EX §5.4 逐字语义）。
 *
 * 覆盖（docs/design/modules/execution.md §5.4 + 评审修订 1/9）：
 * 1. append/start/finish 基本流，ledger.jsonl 逐行可读
 * 2. 修订 1：重启扫描只把 doing→aborted，done 原样保留、绝不改写
 * 3. handleCall 分流：done 重放 / doing running / aborted interrupted
 * 4. 同 call_id 不同 args_hash → call_id_reuse_mismatch（契约 J1 最后防线）
 * 5. 修订 9：压缩只动「已确认的 done 项」，未确认的永不压缩；重放压缩项 →
 *    error{code:'result_compacted', retryable:false, hash}
 * 6. 半行/坏行容忍（崩溃写在 append 中途）
 * 7. finish 前未 start → ledger_not_started
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Ledger,
  LedgerError,
  DEFAULT_COMPACT_THRESHOLD,
  type LedgerRecord,
} from '../agent-runtime/ledger.ts';
import { hashArgs } from '../agent-runtime/protocol.ts';
// 宿主侧 ledger 重放语义（src/exec/protocol.ts）：容器内 ledger 文件跨 recreate 被它读，
// 因此压缩行的 state 必须让宿主 ledgerReplay 正确分流 result_compacted。
import { ledgerReplay } from '../src/exec/protocol.ts';

// ── 脚手架（CONVENTIONS §10：临时目录，绝不碰真实 /opt/agent-state）────────

interface Tmp {
  dir: string;
  ledgerPath: string;
  cleanup(): void;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), 'dotd-agent-runtime-'));
  const ledgerPath = join(dir, 'state', 'ledger.jsonl');
  mkdirSync(join(dir, 'state'), { recursive: true });
  let cleaned = false;
  return {
    dir,
    ledgerPath,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 造一个工具调用（只取 ledger 需要的字段）。 */
function call(callId: string, tool: LedgerRecord['tool'] = 'fs.read', args: Record<string, unknown> = {}) {
  return { call_id: callId, tool, args };
}

// ── 1. 基本流 ────────────────────────────────────────────────────────

test('ledger: start → finish 写两行，第二行带 result_json', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    const c = call('c1');
    l.start(c.call_id, c.tool, hashArgs(c.args), '2026-10-15T00:00:00.000Z');
    assert.equal(l.lookup('c1').kind, 'doing');
    const done = l.finish('c1', { content: 'hello' }, '2026-10-15T00:00:01.000Z');
    assert.equal(done.state, 'done');
    assert.deepEqual(done.result_json, { content: 'hello' });

    const lines = readFileSync(t.ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).state, 'doing');
    assert.equal(JSON.parse(lines[1]!).state, 'done');
    assert.equal(JSON.parse(lines[1]!).result_json.content, 'hello');
    assert.equal(l.size(), 1); // 同 call_id 两行算一条记录
  } finally {
    t.cleanup();
  }
});

test('ledger: 构造时创建 state 目录（/opt/agent-state 语义）', () => {
  const t = makeTmp();
  try {
    const p = join(t.dir, 'nested', 'deeper', 'ledger.jsonl');
    const l = new Ledger({ filePath: p });
    l.start('c1', 'fs.read', hashArgs({}), '2026-10-15T00:00:00.000Z');
    assert.ok(existsSync(p));
  } finally {
    t.cleanup();
  }
});

// ── 2. 修订 1：中断只对未完成成立 ────────────────────────────────────

test('ledger: 重启扫描 doing→aborted，done 原样保留（修订 1 铁律）', () => {
  const t = makeTmp();
  try {
    const first = new Ledger({ filePath: t.ledgerPath });
    first.start('c-done', 'fs.read', hashArgs({}), '2026-10-15T00:00:00.000Z');
    first.finish('c-done', { content: 'A' }, '2026-10-15T00:00:01.000Z');
    first.start('c-doing', 'fs.read', hashArgs({}), '2026-10-15T00:00:02.000Z');
    // 不 finish：模拟崩溃

    const before = readFileSync(t.ledgerPath, 'utf8');

    const second = new Ledger({ filePath: t.ledgerPath });
    assert.equal(second.lookup('c-done').kind, 'done');
    assert.equal(second.lookup('c-doing').kind, 'aborted');

    // done 项的行**逐字未变**（不改写已完成）
    const after = readFileSync(t.ledgerPath, 'utf8');
    const doneLineBefore = before.split('\n').find((l) => l.includes('c-done') && l.includes('"done"'));
    assert.ok(doneLineBefore !== undefined);
    assert.ok(after.includes(doneLineBefore), 'done 行必须原样保留');
    // 只有 doing 那一行被改写（追加一行 aborted）
    assert.ok(after.split('\n').length > before.split('\n').length);
  } finally {
    t.cleanup();
  }
});

test('ledger: 重启时无 doing 项则不写盘（幂等启动）', () => {
  const t = makeTmp();
  try {
    const first = new Ledger({ filePath: t.ledgerPath });
    first.start('c1', 'fs.read', hashArgs({}), '2026-10-15T00:00:00.000Z');
    first.finish('c1', { ok: true }, '2026-10-15T00:00:01.000Z');
    const before = readFileSync(t.ledgerPath, 'utf8');
    const second = new Ledger({ filePath: t.ledgerPath });
    assert.equal(second.recoverInterrupted(), 0);
    assert.equal(readFileSync(t.ledgerPath, 'utf8'), before);
  } finally {
    t.cleanup();
  }
});

test('ledger: recoverInterrupted 不碰已 aborted 的项（不重复改写）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    l.start('c1', 'fs.read', hashArgs({}), '2026-10-15T00:00:00.000Z');
    l.abort('c1', '2026-10-15T00:00:01.000Z');
    const before = readFileSync(t.ledgerPath, 'utf8');
    assert.equal(l.recoverInterrupted(), 0);
    assert.equal(readFileSync(t.ledgerPath, 'utf8'), before);
    assert.equal(l.lookup('c1').kind, 'aborted');
  } finally {
    t.cleanup();
  }
});

// ── 3. handleCall 分流判据 ───────────────────────────────────────────

test('ledger: lookup 四种判定（missing/doing/done/aborted）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    assert.equal(l.lookup('nope').kind, 'missing');
    l.start('a', 'fs.read', hashArgs({}), 'T0');
    l.start('b', 'fs.read', hashArgs({}), 'T0');
    l.start('c', 'fs.read', hashArgs({}), 'T0');
    l.finish('b', { v: 1 }, 'T1');
    l.abort('c', 'T1');
    assert.equal(l.lookup('a').kind, 'doing');
    assert.equal(l.lookup('b').kind, 'done');
    assert.equal(l.lookup('c').kind, 'aborted');
  } finally {
    t.cleanup();
  }
});

// ── 4. call_id 复用撞车 ──────────────────────────────────────────────

test('ledger: 同 call_id 不同 args_hash → call_id_reuse_mismatch', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    l.start('c1', 'fs.read', hashArgs({ path: 'a.md' }), 'T0');
    assert.throws(
      () => l.start('c1', 'fs.read', hashArgs({ path: 'b.md' }), 'T1'),
      (e: unknown) => e instanceof LedgerError && e.code === 'call_id_reuse_mismatch',
    );
    // 撞车不污染原记录
    assert.equal(l.get('c1')?.args_hash, hashArgs({ path: 'a.md' }));
  } finally {
    t.cleanup();
  }
});

test('ledger: 同 call_id 同 args_hash 的重复 start 合法（幂等重放路径）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    const h = hashArgs({ path: 'a.md' });
    l.start('c1', 'fs.read', h, 'T0');
    assert.doesNotThrow(() => l.start('c1', 'fs.read', h, 'T1'));
  } finally {
    t.cleanup();
  }
});

test('ledger: finish 前未 start → ledger_not_started', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    assert.throws(
      () => l.finish('ghost', { v: 1 }, 'T1'),
      (e: unknown) => e instanceof LedgerError && e.code === 'ledger_not_started',
    );
  } finally {
    t.cleanup();
  }
});

// ── 5. 修订 9：压缩 ──────────────────────────────────────────────────

test('ledger: 未确认的 done 项永不压缩（先确认、后瘦身）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 2 });
    l.start('c1', 'fs.read', hashArgs({}), 'T0');
    l.finish('c1', { big: 'x'.repeat(100) }, 'T1');
    l.start('c2', 'fs.read', hashArgs({}), 'T2');
    l.finish('c2', { big: 'y'.repeat(100) }, 'T3');
    assert.deepEqual(l.compact(), [], '未确认 → 无可压缩');
    assert.equal(l.get('c1')?.compacted, undefined);
    assert.ok(l.get('c1')?.result_json !== undefined);
  } finally {
    t.cleanup();
  }
});

test('ledger: 已确认的 done 项压缩为 result_hash + compacted:true', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 2 });
    l.start('c1', 'fs.read', hashArgs({}), 'T0');
    l.finish('c1', { big: 'x'.repeat(100) }, 'T1');
    l.markConfirmed('c1'); // 宿主确认位
    l.start('c2', 'fs.read', hashArgs({}), 'T2'); // 第二行让 size 到阈值

    const compacted = l.compact();
    assert.deepEqual(compacted, ['c1']);
    const rec = l.get('c1')!;
    assert.equal(rec.compacted, true);
    assert.equal(rec.result_json, undefined, 'result_json 被瘦身掉');
    assert.equal(
      rec.result_hash,
      hashArgs({ big: 'x'.repeat(100) }),
      'result_hash = sha256(result_json)',
    );
    // 重写后文件仍是合法 JSONL 且能再次载入（state 已变 compacted）
    const reloaded = new Ledger({ filePath: t.ledgerPath });
    assert.equal(reloaded.lookup('c1').kind, 'compacted');
    assert.equal(reloaded.get('c1')?.compacted, true);
    assert.equal(reloaded.get('c1')?.result_hash, rec.result_hash);
  } finally {
    t.cleanup();
  }
});

test('ledger: 压缩行的 state 与宿主 ledgerReplay 同判（result_compacted 分流）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 2 });
    l.start('c1', 'fs.read', hashArgs({}), 'T0');
    l.finish('c1', { big: 'x'.repeat(100) }, 'T1');
    l.markConfirmed('c1');
    l.start('c2', 'fs.read', hashArgs({}), 'T2');
    assert.deepEqual(l.compact(), ['c1']);

    // 宿主 ledgerReplay(rec) 读同一份 JSONL：state='compacted' → result_compacted
    const hostView = ledgerReplay({
      call_id: 'c1',
      state: 'compacted',
      tool: 'fs.read',
      args_hash: hashArgs({}),
      started_at: 'T0',
      result_hash: l.get('c1')!.result_hash,
    });
    assert.ok(hostView !== null);
    assert.equal(hostView.status, 'error');
    assert.equal(hostView.error?.code, 'result_compacted');
    assert.equal(hostView.error?.retryable, false);
    assert.deepEqual(hostView.result, { hash: l.get('c1')!.result_hash });
  } finally {
    t.cleanup();
  }
});

test('ledger: 未超阈值不压缩；doing/aborted 项绝不压缩', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 10 });
    l.start('c1', 'fs.read', hashArgs({}), 'T0');
    l.finish('c1', { v: 1 }, 'T1');
    l.markConfirmed('c1');
    assert.deepEqual(l.compact(), []);

    l.start('c2', 'shell.run', hashArgs({}), 'T2'); // doing
    l.start('c3', 'shell.run', hashArgs({}), 'T3');
    l.abort('c3', 'T4');
    // 把阈值降到已满足，再压缩：doing/aborted 仍不动
    const small = new Ledger({ filePath: t.ledgerPath, compactThreshold: 1 });
    const out = small.compact();
    assert.deepEqual(out, ['c1']);
    assert.equal(small.get('c2')?.compacted, undefined);
    assert.equal(small.get('c3')?.compacted, undefined);
  } finally {
    t.cleanup();
  }
});

test('ledger: 压缩保持追加顺序，结果可再次压缩（幂等）', () => {
  const t = makeTmp();
  try {
    // 阈值 3：前两次 finish 时 size=1/2 未到阈值；第三次 finish 后 size=3
    // 触发**自动压缩**（finish 内的 maybeCompact，EX §8 的生产触发点），
    // 因此这里断言的是"自动触发把三条已确认项一次压掉"。
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 3 });
    for (const id of ['c1', 'c2', 'c3']) {
      l.start(id, 'fs.read', hashArgs({ id }), 'T0');
      l.finish(id, { id }, 'T1');
      l.markConfirmed(id);
    }
    // 自动压缩发生在**各次 finish 内**：c1/c2 在后续 finish 顶到阈值时被压，
    // c3 自己 finish 时它还没 confirmed（确认在循环末尾），所以只剩 c3。
    const rest = l.compact();
    assert.deepEqual(rest, ['c3'], 'c3 在 finish 时尚未确认，留给显式压缩');
    assert.deepEqual(l.compact(), [], '已压缩项不重复压');
    const reloaded = new Ledger({ filePath: t.ledgerPath });
    const lines = readFileSync(t.ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, '压缩 = 整文件重写为 3 行');
    assert.equal(JSON.parse(lines[0]!).call_id, 'c1');
    assert.equal(JSON.parse(lines[1]!).call_id, 'c2');
    assert.equal(JSON.parse(lines[2]!).call_id, 'c3');
    assert.equal(reloaded.size(), 3);
    for (const id of ['c1', 'c2', 'c3']) {
      assert.equal(reloaded.lookup(id).kind, 'compacted', `${id} 已被自动压缩`);
    }
  } finally {
    t.cleanup();
  }
});

test('ledger: finish 越过阈值即自动压缩（EX §8 state 卷 64MB 上限的生产触发点）', () => {
  const t = makeTmp();
  try {
    // 阈值 2：第二条 finish 后必须自动压掉第一条（不靠任何显式调用）
    const l = new Ledger({ filePath: t.ledgerPath, compactThreshold: 2 });
    l.start('c1', 'fs.read', hashArgs({}), 'T0');
    l.finish('c1', { v: 1 }, 'T1');
    l.markConfirmed('c1');
    assert.equal(l.lookup('c1').kind, 'done', '未到阈值不压');
    l.start('c2', 'fs.read', hashArgs({}), 'T2');
    l.finish('c2', { v: 2 }, 'T3');
    assert.equal(
      l.lookup('c1').kind,
      'compacted',
      '第二条 finish 把 size 顶到阈值 → 自动压缩已确认的 c1',
    );
    assert.equal(l.lookup('c2').kind, 'done', '未确认的 c2 绝不压');
    // 重载后仍成立（压缩已落盘）
    const reloaded = new Ledger({ filePath: t.ledgerPath });
    assert.equal(reloaded.lookup('c1').kind, 'compacted');
    assert.equal(reloaded.get('c1')?.result_json, undefined);
  } finally {
    t.cleanup();
  }
});

// ── 6. 坏行容忍 ─────────────────────────────────────────────────────

test('ledger: 半行（append 中途崩溃）被跳过，其余记录照常载入', () => {
  const t = makeTmp();
  try {
    const first = new Ledger({ filePath: t.ledgerPath });
    first.start('c1', 'fs.read', hashArgs({}), 'T0');
    first.finish('c1', { v: 1 }, 'T1');
    // 手工追加一行写了一半的 JSON（模拟崩溃在 append 中途）
    writeFileSync(t.ledgerPath, readFileSync(t.ledgerPath, 'utf8') + '{"call_id":"c2","state":"do');

    const second = new Ledger({ filePath: t.ledgerPath });
    assert.equal(second.lookup('c1').kind, 'done');
    assert.equal(second.lookup('c2').kind, 'missing');
    assert.equal(second.size(), 1);
  } finally {
    t.cleanup();
  }
});

test('ledger: 空行与无 call_id 的脏行被忽略', () => {
  const t = makeTmp();
  try {
    writeFileSync(t.ledgerPath, '\n\n{"state":"doing"}\n{"call_id":"","state":"doing"}\n');
    const l = new Ledger({ filePath: t.ledgerPath });
    assert.equal(l.size(), 0);
  } finally {
    t.cleanup();
  }
});

test('ledger: DEFAULT_COMPACT_THRESHOLD = 5000（EX §5.4-4 逐字）', () => {
  assert.equal(DEFAULT_COMPACT_THRESHOLD, 5000);
});

// ── 7. job_id 记账 ───────────────────────────────────────────────────

test('ledger: start/finish 都带 job_id（async 对账续轮询用）', () => {
  const t = makeTmp();
  try {
    const l = new Ledger({ filePath: t.ledgerPath });
    l.start('c1', 'shell.run', hashArgs({}), 'T0', 'job_1');
    assert.equal(l.lookup('c1').kind, 'doing');
    assert.equal(l.get('c1')?.job_id, 'job_1');
    const done = l.finish('c1', { exit_code: 0 }, 'T1', 'job_1');
    assert.equal(done.job_id, 'job_1');
  } finally {
    t.cleanup();
  }
});
