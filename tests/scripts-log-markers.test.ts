/**
 * tests/scripts-log-markers.test.ts —— 脚本 grep 的日志标记，源码里必须真有人打印。
 *
 * 现场（2026-10-26，同类缺陷第十例）：
 *
 *   scripts/run-diag.sh      grep 'DIAG-INV' /tmp/dotd-wsl.log   ← 全仓库没人打印，开关也没人读
 *   scripts/verify-summary.sh grep 'DIAG-SUM' ...                ← 只作为注释里的举例存在
 *
 * 两个脚本都拿"找不到"当结论（「buildMessages 没走到诊断点」「hasFn 应为 true」），
 * 而真相是**它们在找一个不存在的字符串**。这种失败最贵：看起来像被测代码有问题，
 * 于是有人去改被测代码。
 *
 * 判据：脚本里 `grep <模式> /tmp/dotd-wsl.log` 的每个候选（按 | 拆开、≥3 字符），
 * 必须在 src/ 或 voice/ 的**非注释行**里出现过。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const SCRIPTS = join(REPO, 'scripts');

// 日志**格式**（正则里带 \d、[^ ] 之类）没法按字面找，跳过这几个。
const NOT_LITERALS = new Set(['.', '.*']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|py)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 源码但去掉注释行 —— 注释里提到某个标记，不等于有人打印它。 */
function codeOnly(files: string[]): string {
  return files
    .map((p) => {
      const isPy = p.endsWith('.py');
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return isPy ? !t.startsWith('#') : !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
        })
        .join('\n');
    })
    .join('\n');
}

type Cand = { script: string; pattern: string; alts: string[] };

function candidates(): Cand[] {
  const out: Cand[] = [];
  for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
    const text = readFileSync(join(SCRIPTS, name), 'utf8');
    for (const raw of text.split('\n')) {
      // 注释里"提到"某个标记不算 —— run-diag.sh 的注释里就写着旧的 grep 行。
      const line = raw.trimStart().startsWith('#') ? '' : raw;
      if (!/\bgrep\b/.test(line) || !/dotd-wsl\.log/.test(line)) continue;
      const quoted = [...line.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
      const pat = quoted.find((q) => q && !q.includes('dotd-wsl.log'));
      if (!pat) continue;
      const alts = pat.split('|').filter((a) => a.length >= 3 && !NOT_LITERALS.has(a));
      if (alts.length) out.push({ script: name, pattern: pat, alts });
    }
  }
  return out;
}

describe('脚本 grep 的日志标记必须有源码出处', () => {
  const src = codeOnly([...walk(join(REPO, 'src')), ...walk(join(REPO, 'voice'))]);

  test('至少扫到几条（否则说明本测试自己找错了地方）', () => {
    assert.ok(candidates().length >= 8, `只扫到 ${candidates().length} 条 grep，检查器很可能失效了`);
  });

  for (const c of candidates()) {
    test(`${c.script} → ${c.pattern}`, () => {
      // 多候选（a|b|c）只要有**一个**能匹配真实日志就算合格：脚本本意就是"任一出现"。
      // 单候选则必须真有人打印。两种情况都能抓住"整条 grep 永远匹配不到"。
      const hit = c.alts.some((a) => src.includes(a));
      assert.ok(
        hit,
        `${c.script} 在日志里找 ${JSON.stringify(c.alts)}，但 src/ 与 voice/ 里没有任何一行打印它 —— ` +
          '脚本会永远"找不到"，然后把这件事报成被测代码的问题',
      );
    });
  }

  test('不许再出现「诊断开关没有任何代码读」的写法', () => {
    // run-diag.sh 原来的形状：export DOTD_DIAG_INV=1，然后 grep 那个标记。
    for (const name of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
      const text = readFileSync(join(SCRIPTS, name), 'utf8');
      for (const m of text.matchAll(/^\s*(?:export\s+)?(DOTD_[A-Z0-9_]*DIAG[A-Z0-9_]*)/gm)) {
        const knob = m[1] ?? '';
        assert.ok(
          src.includes(knob),
          `${name} 设置了 ${knob}，但没有一行代码读过它 —— 那个"诊断开关"是装饰品（第十例）`,
        );
      }
    }
  });
});
