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
  // 时序：checkRepeat 在派发前跑，读到的 sameResultCount 是"上一轮结束时的状态"，
  // 所以阈值要比直觉次数低 1：1 = 已连续两次同结果，3 = 已连续四次。
  assert.match(src, /if \(sameResult >= 1\)/, '同结果第 2 次就要强令收尾');
  assert.match(src, /if \(sameResult >= 3\) return 'stop';/, '同结果必须有 stop 出口（否则无限循环）');
  assert.ok(
    src.includes('结果没变化才是真打转'),
    '必须有这条判据的说明（否则后来人会把次数当唯一判据又踩一遍）',
  );
});
test('ref 编号**不能**归一化：它不是"换个说法"，是"哪个元素"', async () => {
  // 2026-10-22 真机踩过的坑，写下来防止再犯。
  //
  // 填表任务跑了 64 步，模型把同样三个字段填了 5 遍。args 里 ref 每轮都变
  // （@e18 → @e34 → @e51 → @e67 → @e83），看起来完全符合「模型换个说法换本账」
  // 那个模式，于是我把 ref 也归一化了（\\d+ → #）。
  //
  // **单元测试全绿，真机立刻错**。因为 ref 不是措辞，是**元素身份**：
  //   {"action":"check","ref":"@e104"}   → radio "Large"
  //   {"action":"check","ref":"@e105"}   → checkbox "Bacon"
  // 归一化之后这两条签名相同 ⇒ 「勾选 Large 再勾选 Bacon」被当成同一个动作重复，
  // 护栏会在第 3 次误报"你在原地打转"，把正常的表单填写打断。
  //
  // 正确归因：ref 之所以每轮都变，是因为**模型每次重新快照后拿到新编号**，
  // 而它之所以反复重新快照，是因为提交成功后看不见「页面已经跳走了」——
  // 那是 web.act 不报当前 URL 的缺陷，不是签名的问题。修错了层级。
  //
  // > 判据只能抹掉"换了说法指同一个东西"的差异。
  // > 抹掉"指不同东西"的差异，就会把正常操作判成打转。
  const { repeatSignatureForTest } = await import('../src/runner/dot.ts');
  const sig = (json: string): string => repeatSignatureForTest(json);

  assert.notEqual(
    sig('{"action":"check","ref":"@e104"}'),
    sig('{"action":"check","ref":"@e105"}'),
    '勾选 Large 与勾选 Bacon 是**不同元素**，签名必须不同（否则正常填表被误判成打转）',
  );
  assert.notEqual(
    sig('{"action":"fill","ref":"@e18","text":"张三"}'),
    sig('{"action":"fill","ref":"@e34","text":"张三"}'),
    'ref 不同就是不同元素，签名必须不同',
  );
  // 仍然必须归一化的是这些「换个说法指同一个东西」的参数
  assert.equal(
    sig('{"path":"g1.txt"}'),
    sig('{"path":"/dot/home/g1.txt"}'),
    'path 的同义前缀仍须归一化（2026-10-18 的原缺陷）',
  );
  assert.equal(
    sig('{"command":"ls","timeout_ms":5000}'),
    sig('{"command":"ls","timeout_ms":9000}'),
    'timeout 仍须忽略（不影响"做了什么"）',
  );
});

test('收口注记要摆出「实际调用过哪些工具」——空口劝没用，得给事实', async () => {
  // 2026-10-22 真机两轮，同一个病：
  //
  // 第 35 步 web.act 返回里明明写着 `— 当前页面 — https://httpbin.org/post`（提交成功）,
  // 但模型在收口轮（工具清单被摘掉）答：
  //   「我只有文件读写工具，没有浏览器控制能力，也没有任何执行记录」
  //
  // 第一版注记只是劝：『材料在上文』『别再说没有工具』——真机无效，模型照旧否认。
  // 第二版才想到：repeatGuard 里本来就记着它调过什么，**摆出来**即可。
  //
  // > 模型不是不肯承认，是手上真没有一份「我做过什么」的清单。给它清单。
  const { usedToolsSummary } = await import('../src/runner/dot.ts');

  const bucket = new Map<string, { count: number }>([
    ['web.act::[["action","fill"]]', { count: 6 }],
    ['web.act::[["action","click"]]', { count: 3 }],
    ['browser.open::[["url","https://httpbin.org/forms/post"]]', { count: 1 }],
  ]);
  const line = usedToolsSummary(bucket);
  assert.match(line, /web\.act ×9/, '同类工具要合并计数：6+3=9');
  assert.match(line, /browser\.open ×1/);
  assert.ok(line.indexOf('web.act') < line.indexOf('browser.open'), '按次数从多到少排');

  // 空账：不能吐出空串（否则注记里会出现「实际调用过这些工具：。」）
  assert.match(usedToolsSummary(new Map()), /还没有/);
  assert.match(usedToolsSummary(undefined), /还没有/);

  // 没有 `::` 的脏键：必须原样显示，不能 slice(0,-1) 悄悄截掉一个字符
  const dirty = new Map<string, { count: number }>([['web.act', { count: 2 }]]);
  assert.equal(usedToolsSummary(dirty), 'web.act ×2');
});
