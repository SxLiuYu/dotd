import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 源码 / 配置 / 文档里**不许出现被吃掉的字符**（2026-10-22）。
 *
 * 现场：src/governance/gate.ts:803-810 的 paramNum 注释，
 * 在提交 10001f0 入库时中文整段变成 `???????`，此后一直没人发现——
 * 因为没有任何测试读注释，而乱码注释只是"读不懂"，不会让代码出错。
 *
 * 代价是真实的：那段注释解释的是「金额阈值谓词为什么只认 number」，
 * 属于安全相关的设计意图。看不出来源，下一个人就会以为是随便写的。
 *
 * 判据：注释行（// 或 * 开头）里出现 4 个以上连续问号。
 * 为什么不查全文件：字符串字面量里合法的 `??` / `???` 是存在的
 * （如 SQL 占位符、正则），只查注释行才不会误伤。
 */
test('静态守卫：注释里不许出现被吃掉的字符（???? 这类乱码）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const targets = ['src', 'agent-runtime', 'config'];
  const bad: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|mts|yml|yaml)$/.test(name)) continue;
      const text = readFileSync(p, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (!/^\s*(\*|\/\/)/.test(line)) continue;
        if (/\?{4,}/.test(line)) {
          bad.push(`${p.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 60)}`);
        }
      }
    }
  };

  for (const t of targets) walk(join(root, t));

  assert.deepEqual(
    bad,
    [],
    `发现被吃掉字符的注释（中文变问号，读不出原意）：\n  ${bad.join('\n  ')}`,
  );
});
