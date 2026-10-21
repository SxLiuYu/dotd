/**
 * tests/amount-threshold-rule.test.ts —— 金额阈值规则（Muse B3，2026-10-21）
 *
 * 要解决的问题：Muse 那边审批可以配"超过 ¥500 才问我"。
 * 而本项目的 spend 档是 `一律人工审批`（GOV §2.1 表格逐字、§4.5 记忆永不生效）。
 *
 * 这两件事**不冲突**，但方向必须看清：
 *   清单原话是「加数值阈值规则（"超过 ¥500 才问"）」，字面读=低于阈值不问。
 *   而 rules.yml 只能收紧（GOV §2.6 / catalog.ts:11），命中的动作只能是
 *   approve 或 deny —— **结构上不可能**由此得到"低于阈值就放行"。
 *
 * 所以本轮实现的是阈值的**可用形式**：≥ N 分必问、并可以配套把 N 以下也收紧。
 * 这组用例把「能做什么」和「结构上做不到什么」都钉住，避免以后有人
 * 以为加了这个谓词就等于能免审批花钱。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, loadRulesFile } from '../src/governance/catalog.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const dir = mkdtempSync(join(tmpdir(), 'dotd-amt-'));

const TOOLS = `
tools:
  - name: shop.buy
    tier: spend
    spendParams:
      required: [amountCents, currency, category]
  - name: net.get
    tier: read
    spendParams:
      required: [amountCents, currency, category]
`;

const toolsPath = join(dir, 'tools.yml');
writeFileSync(toolsPath, TOOLS, 'utf8');

/** 载入 tools + 给定 rules 文本，返回 catalog 与 warnings。 */
function load(rulesYaml: string) {
  const base = loadCatalog(toolsPath);
  const rulesPath = join(dir, `rules-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(rulesPath, rulesYaml, 'utf8');
  return loadRulesFile(rulesPath, base.catalog);
}

console.log('');
console.log('  阈值规则能被接受');

{
  const r = load(`
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 50000
    decision: approve
    reason: "单笔 >= 500 元必须人工确认"
`);
  ok('规则未被拒（无 warnings）', r.warnings.length === 0, JSON.stringify(r.warnings));
  ok('规则进入 catalog', r.catalog.rules.length === 1);
  ok('谓词被保留', r.catalog.rules[0]!.match.amountAtLeast === 50000);
}

console.log('');
console.log('  数值校验（坏值不该被当成"配好了"）');

{
  const bad = `
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 0
    decision: approve
    reason: "零"
`;
  let threw = false;
  try {
    load(bad);
  } catch {
    threw = true;
  }
  ok('amountAtLeast: 0 被 zod 拒绝（必须为正）', threw);
}

{
  const bad = `
rules:
  - match:
      tool: shop.buy
      amountAtLeast: -1
    decision: approve
    reason: "负数"
`;
  let threw = false;
  try {
    load(bad);
  } catch {
    threw = true;
  }
  ok('负数被拒', threw);
}

{
  const bad = `
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 12.5
    decision: approve
    reason: "小数"
`;
  let threw = false;
  try {
    load(bad);
  } catch {
    threw = true;
  }
  ok('小数被拒（分必须是整数）', threw);
}

console.log('');
console.log('  硬边界：阈值规则不能用来放宽');

{
  // 这是整个文件最要紧的一条：有人可能会想"加个阈值就不用每次批了"。
  // 结构上做不到 —— 加载时被拒并告警。
  const r = load(`
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 50000
    decision: allow
    reason: "想低于阈值就放行"
`);
  ok('spend + allow 被拒绝', r.catalog.rules.length === 0, JSON.stringify(r.warnings));
  ok(
    '并给出 rule_not_stricter 告警',
    r.warnings.some((w) => w.kind === 'rule_not_stricter'),
    JSON.stringify(r.warnings.map((w) => w.kind)),
  );
}

{
  // review 同样是放宽（review 不保证人看到）
  const r = load(`
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 100
    decision: review
    reason: "想降成审查档"
`);
  ok('spend + review 也被拒绝', r.catalog.rules.length === 0);
}

console.log('');
console.log('  deny 方向可用（更严）');

{
  const r = load(`
rules:
  - match:
      tool: shop.buy
      amountAtLeast: 1000000
    decision: deny
    reason: "单笔超过 1 万元直接拒绝"
`);
  ok('spend + deny 被接受', r.catalog.rules.length === 1, JSON.stringify(r.warnings));
}

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);