/**
 * tests/router-usage-shape.guard.test.ts —— 静态守卫：测试里不许用 `as` 强转伪造 `Usage`。
 *
 * 为什么要这个文件：tests/router-zero-usage-cache.test.ts 里曾用
 * `usage: { promptTokens: 100, completionTokens: 0 } as Usage` 构造 stub 响应。
 * 它骗过了 tsc（因为 `cachedPromptTokens` 是**可选**字段），但运行期语义是错的：
 *
 *   StubTransport.chat 把 `item.usage` 原样当响应 usage 返回（transport.ts:268）
 *   → ModelRouter.logCall 落库 `usage?.cachedPromptTokens ?? null`（ModelRouter.ts:1035）
 *   → "没写这个字段" 变成 NULL，而 NULL 被 CacheTracker 当成"该 provider 不报缓存"
 *     并从分子分母里剔除（cache.ts:107）。
 *
 * 于是"我以为我造了一个缓存全命中的端点"与"实际造了一个没有缓存数据的端点"之间
 * 只差一个被 `as` 静默吃掉的字段名拼写。这类 bug 不会红，只会让断言在验别的命题——
 * 正是本文件要挡的东西。
 *
 * 判据（两条，互相独立）：
 * 1. **形体**：router 测试里凡出现 `as Usage` / `as StubResponse` 之类的强转即失败，
 *    必须改用 helper（见 router-zero-usage-cache.test.ts 的 `usageOf()`）。
 * 2. **字段完整**：helper `usageOf()` 必须真实覆盖 `Usage` 的每个字段——
 *    从 src/router/types.ts 读接口体、抽出字段名，逐个确认 helper 的签名/实现里提到
 *    它。这样将来给 `Usage` 加必填字段时，helper 会立刻红，而不是继续静默漏字段。
 *
 * 只读文件文本，不 import 被测模块、不碰数据库。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** 读 router 相关测试文件的文本（含本文件自身所在的目录）。 */
function routerTestFiles(): Array<{ name: string; text: string }> {
  return readdirSync(HERE)
    .filter((f) => f.startsWith('router-') && f.endsWith('.test.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(HERE, f), 'utf8') }));
}

/** 从 src/router/types.ts 抽出 `export interface Usage { … }` 的字段名。 */
function usageFieldNames(): string[] {
  const src = readFileSync(join(REPO, 'src/router/types.ts'), 'utf8');
  const m = /export interface Usage \{\r?\n([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(m !== null, '在 src/router/types.ts 里找不到 `export interface Usage { … }`——守卫失效');
  const body = m[1] ?? '';
  // 去掉块注释后再抓 `字段名` 或 `字段名?` 后面跟冒号的声明
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const names: string[] = [];
  for (const line of noComments.split('\n')) {
    const f = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
    if (f !== null && f[1] !== undefined) names.push(f[1]);
  }
  return names;
}

describe('守卫：测试不许伪造 Usage 形状', () => {
  it('Usage 接口字段可被解析（守卫自身不空转）', () => {
    const fields = usageFieldNames();
    assert.deepEqual(
      fields,
      ['promptTokens', 'completionTokens', 'cachedPromptTokens'],
      'Usage 字段变了：请同步更新 router-zero-usage-cache.test.ts 的 usageOf() 与本守卫的期望',
    );
  });

  it('router 测试里不出现 `as Usage` / `as StubResponse` 之类强转', () => {
    const offenders: string[] = [];
    // 本文件自己在注释/字符串里引用这些模式（它就是讲这件事的），跳过。
    const SELF = 'router-usage-shape.guard.test.ts';
    for (const { name, text } of routerTestFiles()) {
      if (name === SELF) continue;
      // 注释里提到 `as Usage` 是在解释"曾经踩过的坑"，不算违规：
      // 先剥掉块注释与行注释再搜。
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // 只盯**带可选字段**、且漏字段会改变统计语义的类型。
      // ChatResponse 不在此列：它只有 content/toolCalls，缺省即"没有工具调用"，
      // 强转不会伪造出与"未提供"混淆的第三种状态。
      const re = /\bas\s+(Usage|StubResponse|StubScriptItem)\b/g;
      for (const hit of code.matchAll(re)) {
        offenders.push(`${name}: \`${hit[0]}\``);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些强转会让缺失字段被静默当成 undefined/NULL，进而改变缓存/健康统计的语义。\n' +
        '请改用显式 helper（router-zero-usage-cache.test.ts 的 usageOf()）。\n实际命中：' +
        offenders.join(', '),
    );
  });

  it('usageOf() helper 覆盖 Usage 的每一个字段（加必填字段时这里会先红）', () => {
    const text = readFileSync(join(HERE, 'router-zero-usage-cache.test.ts'), 'utf8');
    const m = /function usageOf\(([\s\S]*?)\)\s*:\s*Usage\s*\{([\s\S]*?)\n\}/.exec(text);
    assert.ok(m !== null, 'router-zero-usage-cache.test.ts 里找不到 usageOf(): Usage 的实现');
    const signature = m[1] ?? '';
    const impl = m[2] ?? '';
    const missing = usageFieldNames().filter(
      (f) => !signature.includes(f) || !impl.includes(f),
    );
    assert.deepEqual(
      missing,
      [],
      `usageOf() 没覆盖 Usage 的这些字段：${missing.join(', ')}——它们会静默变成 undefined`,
    );
  });

  it('usageOf() 对"没报缓存"与"报了 0 命中"给出可区分的形状', () => {
    // 这是本守卫存在的实际理由：undefined（不报）与 0（报了没命中）必须不同。
    // 直接复用生产里判这两者差异的函数逻辑（等价实现见 cache.ts:107），
    // 不 import 被测模块，只做形状断言。
    const text = readFileSync(join(HERE, 'router-zero-usage-cache.test.ts'), 'utf8');
    assert.ok(text.includes('cachedPromptTokens === undefined ? {} : { cachedPromptTokens }'),
      'usageOf() 必须用条件展开：不传缓存数时**不带**该字段，而不是写 0');
  });
});
