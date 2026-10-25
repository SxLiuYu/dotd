/**
 * src/shared/money.ts —— 金额显示的唯一实现（分 → 人话）。
 *
 * 为什么从 feishu-card.ts 提出来：审批卡的"要做什么"、审批单 summary、
 * 业务操作摘要（shared/operation.ts）都要显示金额。三处各写一份格式化，
 * 就会出现"卡片上 125 元、列表里 12500"这种同一笔钱两个数的事故。
 *
 * 单位口径：`amountCents` 一律是**分**（spend 契约与 spend_ledger.amount_cents 同）。
 */

/** 大额提示阈值：50000 分 = 500 元。只影响可见性，不改变审批与否。 */
export const LARGE_SPEND_WARN_CENTS = 50_000;

/**
 * 分 → 人话金额。
 *
 * 小币种零位（JPY/KRW 等）不分转元，直接显示整数 —— 它们的"分"没有意义。
 *
 * @param cents 金额，单位分（整数）
 * @param currency ISO4217 三字母
 */
export function formatMoney(cents: number, currency: string): string {
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF']);
  const cur = currency !== '' ? currency : 'CNY';
  if (zeroDecimal.has(cur)) return cur + ' ' + String(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return sign + cur + ' ' + String(yuan) + '.' + String(fen).padStart(2, '0');
}

/**
 * 金额是否超过"多看一眼"阈值。
 *
 * ⚠️ 这**不是**用来"低于阈值就自动放行"的 —— spend 档一律人工审批是
 * GOV §4.1/§4.5 的硬边界，不做数值放宽。它只决定卡片上的提示与视觉。
 */
export function isLargeSpend(cents: number, warnCents: number): boolean {
  return Math.abs(cents) >= warnCents;
}
