/**
 * tests/feishu-card-money.test.ts —— 审批卡的金额显示（9.2，2026-10-21）
 *
 * 起因是一个真的 100 倍事故：
 *   amountCents 存的是**分**（spend 契约、spend_ledger.amount_cents 都是分），
 *   但卡片原来直接 String(amt) 打出来 —— 12500 分显示成 "12500 CNY"，
 *   主人会以为要花一万二，实际 125 元。**在花钱的卡上差 100 倍。**
 *
 * 这组用例钉死三件事：
 *   1. 分一定换算成主单位再显示
 *   2. 零位币种（JPY/KRW）不换算
 *   3. 大额提示只在达到阈值时出现，且**不影响审批与否**
 */
import {
  formatMoney,
  isLargeSpend,
  buildApprovalCard,
  LARGE_SPEND_WARN_CENTS,
} from '../src/surfaces/feishu-card.ts';

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

console.log('');
console.log('  金额换算（分 → 主单位）');

// 这条是整个文件的由来：12500 分必须是 125.00，不是 12500
ok('12500 分 = 125.00 元', formatMoney(12500, 'CNY') === 'CNY 125.00', formatMoney(12500, 'CNY'));
ok('100 分 = 1.00 元', formatMoney(100, 'CNY') === 'CNY 1.00', formatMoney(100, 'CNY'));
ok('1 分 = 0.01 元', formatMoney(1, 'CNY') === 'CNY 0.01', formatMoney(1, 'CNY'));
ok('99 分 = 0.99 元', formatMoney(99, 'CNY') === 'CNY 0.99', formatMoney(99, 'CNY'));
ok('1000000 分 = 10000.00 元', formatMoney(1_000_000, 'CNY') === 'CNY 10000.00', formatMoney(1_000_000, 'CNY'));
ok('负数保留符号（冲账行）', formatMoney(-12500, 'CNY') === '-CNY 125.00', formatMoney(-12500, 'CNY'));
ok('缺币种时默认 CNY', formatMoney(12500, '') === 'CNY 125.00', formatMoney(12500, ''));
ok('美元照样换算', formatMoney(1999, 'USD') === 'USD 19.99', formatMoney(1999, 'USD'));

console.log('');
console.log('  零位币种不换算（它们的"分"没有意义）');
ok('JPY 1000 = JPY 1000', formatMoney(1000, 'JPY') === 'JPY 1000', formatMoney(1000, 'JPY'));
ok('KRW 5000 = KRW 5000', formatMoney(5000, 'KRW') === 'KRW 5000', formatMoney(5000, 'KRW'));

console.log('');
console.log('  大额阈值');

ok('刚好到阈值 = 大额', isLargeSpend(LARGE_SPEND_WARN_CENTS, LARGE_SPEND_WARN_CENTS) === true);
ok('差 1 分 = 不是大额', isLargeSpend(LARGE_SPEND_WARN_CENTS - 1, LARGE_SPEND_WARN_CENTS) === false);
ok('远超阈值 = 大额', isLargeSpend(LARGE_SPEND_WARN_CENTS * 10, LARGE_SPEND_WARN_CENTS) === true);
ok('冲账负数按绝对值判', isLargeSpend(-LARGE_SPEND_WARN_CENTS, LARGE_SPEND_WARN_CENTS) === true);
ok('0 = 不是大额', isLargeSpend(0, LARGE_SPEND_WARN_CENTS) === false);

console.log('');
console.log('  卡片渲染（端到端：params → 卡片文案）');

const mkView = (params: Record<string, unknown>) =>
  ({
    id: 1,
    seq: 1,
    taskId: 'tk_1',
    tool: 'shop.checkout',
    tier: 'spend',
    summary: '买一台显示器',
    reason: 'spend 档一律审批',
    fullParams: params,
    pendingUntil: new Date(Date.now() + 3600_000).toISOString(),
  }) as never;

const cardJson = (v: never) => JSON.stringify(buildApprovalCard(v));

// 12500 分的卡里不能出现 "12500 CNY" 这种字样
const c1 = cardJson(mkView({ amountCents: 12500, currency: 'CNY' }));
ok('卡片显示 125.00 而不是 12500', c1.includes('125.00') && !c1.includes('"12500 CNY"'));
ok('未达阈值时不加警示', !c1.includes('金额较大'));

// 大额要显眼
const c2 = cardJson(mkView({ amountCents: 5_000_000, currency: 'CNY' }));
ok('大额卡片带警示', c2.includes('金额较大'), c2.slice(0, 0));
ok('大额仍显示正确金额', c2.includes('50000.00'));

// 裸 amount（旧形态，单位不明）不能装作知道单位
const c3 = cardJson(mkView({ amount: 888 }));
ok('裸 amount 标注未标明单位', c3.includes('未标明单位'));

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
