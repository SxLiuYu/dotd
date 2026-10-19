/**
 * tests/stop-reason-single-source.test.ts —— stop_reason 的三个定义必须一致。
 *
 * stop_reason 现在有**三处**定义：
 *  ① 数据库 CHECK 约束（db/migrations/*.sql，最终值在 140）
 *  ② 契约类型 `StopReason`（src/shared/contracts.ts）
 *  ③ 队列入参 `PauseReason`（src/control-plane/queue.ts 的 pauseByReason 签名）
 *
 * 2026-10-19 踩过的坑：迁移 140 加了两个新值、`pauseByReason` 也改了，
 * 但 **`StopReason` 类型没同步** —— Task.stopReason 对外暴露时用的是它，
 * 于是新原因在类型层面"不存在"（tsc 不报错，因为写入路径用的是另一套字面量）。
 *
 * 这个测试把三者机械对齐，避免下次再靠"记得改"。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { StopReason } from '../src/shared/contracts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** ① 从迁移文件里取最新一份 tasks 表的 stop_reason CHECK 允许值。 */
function valuesFromMigrations(): string[] {
  const dir = join(ROOT, 'db', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  // 从后往前找第一份定义了 stop_reason CHECK 的迁移（重建表的那份最全）
  for (const f of [...files].reverse()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const m = /stop_reason\s+TEXT CHECK \(stop_reason IN\s*\(([^)]*)\)/i.exec(sql);
    if (m) {
      const vals = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
      return [...new Set(vals)].sort();
    }
  }
  throw new Error('迁移里找不到 stop_reason CHECK');
}

/** ② 从 contracts.ts 的 StopReason 类型里取值（源码正则，避免运行时枚举）。 */
function valuesFromType(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'shared', 'contracts.ts'), 'utf8');
  const m = /export type StopReason =([\s\S]*?);/.exec(src);
  assert.ok(m !== null, 'contracts.ts 里应有 StopReason 类型');
  return [...new Set([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!))].sort();
}

/** ③ 从 queue.ts 的 pauseByReason 签名里取值。 */
function valuesFromPauseReason(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'control-plane', 'queue.ts'), 'utf8');
  const m = /pauseByReason\(\s*taskId: string,\s*reason:([\s\S]*?)\): void \{/.exec(src);
  assert.ok(m !== null, 'queue.ts 里应有 pauseByReason 签名');
  return [...new Set([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!))].sort();
}

test('迁移 CHECK 约束 = contracts.StopReason', () => {
  assert.deepEqual(
    valuesFromType(),
    valuesFromMigrations(),
    '类型与数据库约束不一致 —— 新值写不进库，或库里的值类型不认识',
  );
});

test('pauseByReason 接受的原因 ⊆ StopReason（不能凭空造) ', () => {
  const stop = new Set(valuesFromType());
  for (const r of valuesFromPauseReason()) {
    assert.ok(stop.has(r), `pauseByReason 接受 ${r}，但 StopReason 里没有 —— 写进库后类型对不上`);
  }
});

test('三种模型不可用原因都在词表里', () => {
  const stop = valuesFromType();
  for (const r of ['circuit_open', 'no_qualified_primary', 'endpoints_unreachable']) {
    assert.ok(stop.includes(r), `StopReason 应包含 ${r}`);
  }
});

// 编译期断言：新值能被 StopReason 接受
const _typeCheck: StopReason[] = ['endpoints_unreachable', 'no_qualified_primary'];
void _typeCheck;
