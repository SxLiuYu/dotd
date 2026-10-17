/**
 * tests/exec-http-runtime-shape.test.ts —— HttpRuntime 的响应归一（jobToToolResult）。
 *
 * 背景（WSL 2026-10-16 实测）：容器 /jobs/{id} 返回 job 形状（state 字段），
 * 而契约 ExecToolResult 用 status。未归一时 pollJob 读到 undefined ≠ 'running'
 * 直接当终态返回 → settle 落 else → failCall('error')，shell.run/browser.*
 * 全部 209ms 内假失败（同一 job 手动轮询明明 done + exit_code 0）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobToToolResult } from '../src/exec/http-runtime.ts';

test('job done + result → status ok 且带 result 与 finished_at', () => {
  const out = jobToToolResult(
    {
      job_id: 'job_1', call_id: 'c1', state: 'done',
      result: { exit_code: 0, stdout: 'hi\n' },
      finished_at: '2026-10-16T23:00:00.000Z',
    },
    'job_fallback',
  );
  assert.equal(out.status, 'ok');
  assert.equal(out.job_id, 'job_1');
  assert.equal(out.call_id, 'c1');
  assert.deepEqual(out.result, { exit_code: 0, stdout: 'hi\n' });
  assert.equal(out.finished_at, '2026-10-16T23:00:00.000Z');
});

test('job running → status running（pollJob 继续轮询）', () => {
  const out = jobToToolResult({ job_id: 'j', call_id: 'c', state: 'running' }, 'j');
  assert.equal(out.status, 'running');
  assert.equal(out.result, undefined);
});

test('job error + error 对象 → status error 且 code/message/retryable 保留', () => {
  const out = jobToToolResult(
    {
      job_id: 'j', call_id: 'c', state: 'error',
      error: { code: 'spawn_failed', message: 'no shell', retryable: true },
    },
    'j',
  );
  assert.equal(out.status, 'error');
  assert.equal(out.error?.code, 'spawn_failed');
  assert.equal(out.error?.message, 'no shell');
  assert.equal(out.error?.retryable, true);
});

test('job cancelled → status cancelled', () => {
  const out = jobToToolResult({ job_id: 'j', call_id: 'c', state: 'cancelled' }, 'j');
  assert.equal(out.status, 'cancelled');
});

test('job timeout/未知 state → status error（code 回落为 state 名）', () => {
  const t = jobToToolResult({ job_id: 'j', call_id: 'c', state: 'timeout' }, 'j');
  assert.equal(t.status, 'error');
  assert.equal(t.error?.code, 'timeout');
  assert.equal(t.error?.retryable, false);
  // state 缺省 = 容器响应不完整：按未知终态错误处理，绝不冒充 running
  // （冒充 running 会让 pollJob 无限轮询到 deadline 才超时）。
  const u = jobToToolResult({ job_id: 'j', call_id: 'c' }, 'j');
  assert.equal(u.status, 'error');
  assert.equal(u.error?.code, 'unknown');
});

test('已是契约形状（带 status）→ 原样返回，只补 job_id', () => {
  const out = jobToToolResult(
    { call_id: 'c', status: 'ok', result: { exit_code: 0 } },
    'job_fb',
  );
  assert.equal(out.status, 'ok');
  assert.equal(out.job_id, 'job_fb');
  assert.deepEqual(out.result, { exit_code: 0 });
});

// ── toHomeAbs：记忆桥的相对→绝对路径口径（2026-10-17 实测缺口）───────────
//
// 背景：记忆模块 FsOpsBridge 契约用 home **相对**路径（readMemoryMd 传
// 'MEMORY.md'），而 ExecService.fsOps 的宿主护栏 checkHomePath 只认
// `/dot/home/` 前缀的绝对路径。缺转换时每一次记忆读取都被 path_outside_home
// 拒掉 → buildContextBundle 恒降级 + memory_missed 每任务一条。
import { toHomeAbs, checkHomePath } from '../src/exec/protocol.ts';

test('toHomeAbs：相对路径补 /dot/home/ 前缀', () => {
  assert.equal(toHomeAbs('MEMORY.md'), '/dot/home/MEMORY.md');
  assert.equal(toHomeAbs('notes/x.md'), '/dot/home/notes/x.md');
  assert.equal(toHomeAbs('manuals/deploy/wsl.md'), '/dot/home/manuals/deploy/wsl.md');
});

test('toHomeAbs：已是绝对路径原样返回（幂等）', () => {
  assert.equal(toHomeAbs('/dot/home/MEMORY.md'), '/dot/home/MEMORY.md');
  assert.equal(toHomeAbs('/dot/home'), '/dot/home');
});

test('toHomeAbs：结果必须过 checkHomePath（桥接正确性的判据）', () => {
  for (const p of ['MEMORY.md', 'notes/x.md', 'manuals/a/b.md', '/dot/home/MEMORY.md', '.']) {
    const abs = toHomeAbs(p);
    assert.equal(checkHomePath(abs).ok, true, `${p} → ${abs} 应过宿主护栏`);
  }
  // 反向：不转换就被拒——这正是 2026-10-17 之前的形态
  assert.equal(checkHomePath('MEMORY.md').ok, false);
});

test('toHomeAbs：home 根 "." 归一为 /dot/home（合法，非 /dot/home/.）', () => {
  const abs = toHomeAbs('.');
  assert.equal(abs, '/dot/home/.');
  assert.equal(checkHomePath(abs).ok, true);
});
