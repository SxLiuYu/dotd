/**
 * src/shared/ulid.ts —— ULID 生成器（无第三方依赖）。
 *
 * 为什么必须有时序性：契约 §9 统一术语表把"步身份"定为 `call_id`（ULID），
 * 且 `steps`/`model_call_log`/`exec_calls`/`approvals.journal_step` 全用它做主键/幂等键。
 * ULID 的前 48 位是毫秒时间戳，天然按时间排序——journal 的 `seq` 与 `call_id`
 * 排序方向一致，便于人读审计。
 *
 * 规范：Crockford Base32（去 I/L/O/U），26 字符，48bit 时间 + 80bit 随机。
 * 实现：随机段存为 16 个 5bit 符号的整数数组；同毫秒内整体 +1（向高位进位），
 * 保证同毫秒严格单调递增；跨毫秒重新取随机段。
 */

import { randomFillSync } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SYMBOLS = 16;      // 随机段符号数（80bit = 16 × 5bit）
const TIME_CHARS = 10;   // 时间段字符数（48bit）
const TIME_MASK = 0xffffffffffff; // 48bit

const SYMBOL_VALUE = new Map<string, number>();
for (let i = 0; i < 32; i++) SYMBOL_VALUE.set(CROCKFORD[i]!, i);

let lastMs = -1;
let lastSymbols: number[] = [];

function randomSymbols(): number[] {
  const bytes = randomFillSync(new Uint8Array(16));
  const out: number[] = [];
  for (let i = 0; i < SYMBOLS; i++) {
    out.push(bytes[i]! % 32);
  }
  return out;
}

/** 生成一枚 ULID（26 字符 Crockford Base32）。同毫秒内严格递增。 */
export function ulid(now: number = Date.now()): string {
  const ms = Math.min(Math.max(now, 0), TIME_MASK);
  let symbols: number[];
  if (ms === lastMs) {
    symbols = lastSymbols.slice();
    for (let i = SYMBOLS - 1; i >= 0; i--) {
      const v = symbols[i]! + 1;
      if (v < 32) {
        symbols[i] = v;
        break;
      }
      symbols[i] = 0;
      if (i === 0) symbols = randomSymbols(); // 整段溢出：换随机段（仍唯一，丢单调）
    }
  } else {
    symbols = randomSymbols();
  }
  lastMs = ms;
  lastSymbols = symbols;

  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  for (const s of symbols) out += CROCKFORD[s]!;
  return out;
}

/** 校验 26 位 Crockford Base32（供测试/CLI 断言）。 */
export function isUlid(s: unknown): boolean {
  if (typeof s !== 'string' || s.length !== 26) return false;
  for (const ch of s) if (!SYMBOL_VALUE.has(ch)) return false;
  return true;
}

/** 从 ULID 解回毫秒时间戳（用于只读日志/审计展示）。 */
export function ulidTime(s: string): number {
  if (s.length < TIME_CHARS) throw new RangeError(`ULID 长度不足：${s}`);
  let t = 0;
  for (let i = 0; i < TIME_CHARS; i++) {
    const v = SYMBOL_VALUE.get(s[i]!);
    if (v === undefined) throw new RangeError(`非法 ULID 时间段：${s}`);
    t = t * 32 + v;
  }
  return t;
}
