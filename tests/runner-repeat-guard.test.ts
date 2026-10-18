/**
 * tests/runner-repeat-guard.test.ts —— 原地打转护栏。
 *
 * 现场（2026-10-18 多轮复测）：同一条 prompt 下，明确指令 4 步完成，
 * 而"创建…然后读回确认…"跑到 **185 步**——同参数的 fs.write / fs.read 反复执行。
 * 上下文配对已修对（11/11，模型确实看得见每次结果），所以这是**模型侧自我循环**。
 *
 * 护栏是产品侧与模型无关的兜底：
 *   第 3 次同 (工具,参数) → 回喂"你已经做过 N 次"的强注记（仍派发）
 *   第 6 次 → 强制收口
 *
 * 本文件钉住三件事：
 *   ① 阈值常量存在且取值合理（3/6）；
 *   ② 判据是 **工具名 + 参数完全一致**，不同参数不计数（"写完再读"不会误伤）；
 *   ③ 硬上限触发时代码路径真的调用 markDone。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

test('护栏常量存在且取值合理（软 2 / 硬 4）', () => {
  const soft = /const REPEAT_SOFT_LIMIT = (\d+);/.exec(src);
  const hard = /const REPEAT_HARD_LIMIT = (\d+);/.exec(src);
  assert.ok(soft !== null, '必须有 REPEAT_SOFT_LIMIT');
  assert.ok(hard !== null, '必须有 REPEAT_HARD_LIMIT');
  assert.equal(Number(soft[1]), 2);
  assert.equal(Number(hard[1]), 4);
  assert.ok(Number(soft[1]) < Number(hard[1]), '软阈必须早于硬阈');
});

test('判据是「工具名 + 参数完全一致」——不同参数不共享计数', () => {
  // 关键：checkRepeat 的 key 必须是 name + arguments 的完整拼接。
  assert.match(
    src,
    /const key = `\$\{call\.name\}::\$\{call\.arguments\}`;/,
    'key 必须同时含工具名与完整参数串',
  );
  // 反例守卫：不能只按工具名计数（那会把"写完再读"、"读两个文件"误判成打转）
  assert.equal(
    /const key = `\$\{call\.name\}`;/.test(src),
    false,
    '禁止只按工具名计数',
  );
});

test('护栏是两段式：先强令收尾（跳过派发），有上限兜底；且不覆盖模型结论', () => {
  // 设计演进（2026-10-18 实测校准）：
  //   ① 第 2 次：软注记（仍派发）
  //   ② 第 4 次：硬上限 —— **跳过派发**，让下一轮 LLM 在没工具可调时给结论
  //   ③ 连续跳过 REPEAT_MAX_SKIPS 轮仍不收敛 —— 产品侧 markDone 兜底（防外层 while 死转）
  //
  // 为什么不在第 4 次就直接 markDone：那会顶掉模型的正常回答
  // （tests/runner-plan.test.ts 的"8 轮重复后收尾"用例抓到过）。
  assert.ok(src.includes('markDone(summary?: string)'), '必须有 RunContext.markDone');
  assert.match(src, /const REPEAT_MAX_SKIPS = \d+;/, '必须有连续跳过上限');
  assert.match(src, /this\.repeatSkips > REPEAT_MAX_SKIPS/, '超过跳过上限必须兜底收口');
  // 不覆盖模型结论
  assert.match(
    src,
    /if \(this\.summaryText\.length > 0\) return;/,
    'markDone 不得覆盖模型已给出的结论',
  );
});

test('软阈只回喂注记、不阻断派发（给模型自我纠正的机会）', () => {
  const softBlock = /if \(rec\.count < REPEAT_SOFT_LIMIT\) return null;[\s\S]{0,500}?return \{[\s\S]{0,400}?note:/.exec(
    src,
  );
  assert.ok(softBlock !== null, '软阈分支必须返回 { note } 而不是 stop');
});
