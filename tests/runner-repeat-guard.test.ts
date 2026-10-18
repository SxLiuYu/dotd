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
    /const key = `\$\{call\.name\}::\$\{repeatSignature\(call\.arguments\)\}`;/,
    'key 必须含工具名 + 语义签名（剔除 timeout 类参数）',
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
  assert.match(src, /skips > REPEAT_MAX_SKIPS/, '超过跳过上限必须兜底收口');
  // 关键：护栏计数必须**按 taskId 分桶**且跨 run_epoch 保留（崩溃恢复后不能失忆）
  assert.match(src, /repeatGuard\.get\(taskId\)/, '计数必须按 taskId 分桶');
  assert.ok(
    src.includes('计数按 taskId 分桶、跨 run_epoch 保留'),
    'runTask 不得在开头清空计数（崩溃重领会失忆）',
  );
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

test('判重必须忽略 timeout_ms：改超时不算"新调用"', async () => {
  // 现场（2026-10-18）：模型反复执行 `echo A`，每次把 timeout_ms 从 5000 改成 10000 再改回。
  // 原始参数串因此不同 → 护栏认为"不同调用" → 计数到不了硬上限 →
  // 实测 18 次 shell.run 仍未触发，任务原地打转。
  const { repeatSignatureForTest } = await import('../src/runner/dot.ts');
  const a = JSON.stringify({ cmd: 'echo A', timeout_ms: 5000 });
  const b = JSON.stringify({ cmd: 'echo A', timeout_ms: 10000 });
  const c = JSON.stringify({ cmd: 'echo B', timeout_ms: 5000 });

  assert.equal(
    repeatSignatureForTest(a),
    repeatSignatureForTest(b),
    '只有 timeout_ms 不同 → 必须是同一个签名',
  );
  assert.notEqual(
    repeatSignatureForTest(a),
    repeatSignatureForTest(c),
    '命令本身不同 → 必须是不同签名（不能误判成重复）',
  );
  // 键顺序不影响签名
  assert.equal(
    repeatSignatureForTest(JSON.stringify({ timeout_ms: 5000, cmd: 'echo A' })),
    repeatSignatureForTest(a),
    '键顺序不该影响签名',
  );
});

test("判据是「结果没变化」而非单纯次数：结果一致的重复提前收尾", async () => {
  // 现场（2026-10-18 二次校准）：把硬阈降到 3 会误伤"合法重复 8 次再收尾"的场景；
  // 保持 4 又拦不住"同一命令每次返回完全相同结果"的真打转。
  // 正确判据：同一调用 + 结果一字不差 → 这必然是原地打转。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'runner', 'dot.ts'), 'utf8');

  assert.match(src, /sameResultCount/, '必须统计"结果与上次相同"的次数');
  assert.match(src, /const sameResult = rec\.sameResultCount \?\? 0;/, '必须取同结果计数');
  assert.match(src, /if \(sameResult >= 2\)/, '同结果第 2 次就要强令收尾');
  assert.match(src, /if \(sameResult >= 4\) return 'stop';/, '同结果必须有 stop 出口（否则无限循环）');
  assert.ok(
    src.includes('结果没变化才是真打转'),
    '必须有这条判据的说明（否则后来人会把次数当唯一判据又踩一遍）',
  );
});
