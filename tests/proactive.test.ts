/**
 * tests/proactive.test.ts —— T4 主动发起对话的闸门（2026-10-20）
 *
 * 重点盯两件事：
 *   1. 跨午夜的安静时段（'23:00-07:30'）必须真的生效。
 *      写错这里会让主人在凌晨三点被叫醒，或者整天收不到消息 —— 两种都致命。
 *   2. 节流必须落库（lastPushAt 从 DB 读），重启后不能失效。
 *      放内存的话，一次重启就能让"等待 6 小时"归零。
 */
import { shouldPush, isInQuietHours, parseQuietHours } from '../src/surfaces/proactive.ts';

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

/** 造一个本地时间的 epoch ms，避免测试依赖跑在哪个时区。 */
const at = (h: number, m = 0): number => {
  const d = new Date(2026, 9, 20, h, m, 0, 0);
  return d.getTime();
};

const base = {
  proactive: true,
  quietHours: null as string | null,
  throttleHours: 6,
  lastPushAt: null as number | null,
  hasTarget: true,
};

// ── 1. 解析安静时段 ────────────────────────────────────────────
{
  const a = parseQuietHours('23:00-07:30');
  ok('解析 23:00-07:30', a?.startMin === 1380 && a?.endMin === 450);
  const b = parseQuietHours('9:05 - 17:35');
  ok('容忍空格与单位数小时', b?.startMin === 545 && b?.endMin === 1055);
  ok('非法格式返回 null', parseQuietHours('25:00-07:00') === null);
  ok('缺横线返回 null', parseQuietHours('2300') === null);
  ok('乱写返回 null', parseQuietHours('abc') === null);
  ok('小时超界返回 null', parseQuietHours('23:70-07:00') === null);
}

// ── 2. 安静时段判定（跨午夜是重点）────────────────────────────
{
  ok('23:30 在 23:00-07:30 内', isInQuietHours('23:00-07:30', at(23, 30)) === true);
  ok('03:00 在 23:00-07:30 内', isInQuietHours('23:00-07:30', at(3, 0)) === true);
  ok('07:29 在 23:00-07:30 内', isInQuietHours('23:00-07:30', at(7, 29)) === true);
  ok('07:30 已出（右开区间）', isInQuietHours('23:00-07:30', at(7, 30)) === false);
  ok('12:00 不在', isInQuietHours('23:00-07:30', at(12, 0)) === false);
  ok('22:59 不在', isInQuietHours('23:00-07:30', at(22, 59)) === false);

  // 同一天内的区间
  ok('13:00 在 12:00-14:00 内', isInQuietHours('12:00-14:00', at(13, 0)) === true);
  ok('15:00 不在 12:00-14:00', isInQuietHours('12:00-14:00', at(15, 0)) === false);

  ok('null 表示不静音', isInQuietHours(null, at(3, 0)) === false);
  ok('空串表示不静音', isInQuietHours('', at(3, 0)) === false);
  ok('格式错按不静音（不误伤）', isInQuietHours('garbage', at(3, 0)) === false);
  ok('起止相同是空区间', isInQuietHours('10:00-10:00', at(10, 0)) === false);
}

// ── 3. 三道闸 ──────────────────────────────────────────────────
{
  // 没目标
  const r1 = shouldPush({ ...base, hasTarget: false, now: at(12) });
  ok('没会话时拒', r1.allowed === false && r1.reason === 'no_target');

  // 开关关
  const r2 = shouldPush({ ...base, proactive: false, now: at(12) });
  ok('没开主动推送时拒', r2.allowed === false && r2.reason === 'disabled');

  // 安静时段
  const r3 = shouldPush({ ...base, quietHours: '23:00-07:30', now: at(3) });
  ok('安静时段内拒', r3.allowed === false && r3.reason === 'quiet_hours');

  // 节流：上次 2 小时前，节流 6 小时
  const ago2h = at(12) - 2 * 3_600_000;
  const r4 = shouldPush({ ...base, lastPushAt: ago2h, now: at(12) });
  ok('节流窗口内拒', r4.allowed === false && r4.reason === 'throttled');

  // 节流：上次 7 小时前
  const ago7h = at(12) - 7 * 3_600_000;
  const r5 = shouldPush({ ...base, lastPushAt: ago7h, now: at(12) });
  ok('超过节流窗口放行', r5.allowed === true);

  // 从没推过 → 放行
  const r6 = shouldPush({ ...base, lastPushAt: null, now: at(12) });
  ok('从没推过时放行', r6.allowed === true);

  // throttleHours = 0 表示不节流
  const r7 = shouldPush({ ...base, throttleHours: 0, lastPushAt: at(11), now: at(12) });
  ok('throttle=0 不节流', r7.allowed === true);

  // 恰好等于窗口边界
  const exact6h = at(12) - 6 * 3_600_000;
  const r8 = shouldPush({ ...base, lastPushAt: exact6h, now: at(12) });
  ok('恰好到 6 小时放行', r8.allowed === true);
}

// ── 4. 闸门顺序（日志里原因要是最根本的那个）──────────────────
{
  // 开关关 + 也在安静时段 → 应报 disabled，不是 quiet_hours
  const r = shouldPush({ ...base, proactive: false, quietHours: '00:00-23:59', now: at(12) });
  ok('开关优先于安静时段', r.reason === 'disabled');

  // 安静时段 + 也在节流期 → 应报 quiet_hours
  const r2 = shouldPush({
    ...base,
    quietHours: '23:00-07:30',
    lastPushAt: at(3) - 60_000,
    now: at(3),
  });
  ok('安静时段优先于节流', r2.reason === 'quiet_hours');
}

// ── 5. 拒绝时必须给出人话解释 ─────────────────────────────────
{
  const cases = [
    shouldPush({ ...base, hasTarget: false, now: at(12) }),
    shouldPush({ ...base, proactive: false, now: at(12) }),
    shouldPush({ ...base, quietHours: '23:00-07:30', now: at(3) }),
    shouldPush({ ...base, lastPushAt: at(11), now: at(12) }),
  ];
  ok('四种拒绝都有解释', cases.every((c) => typeof c.detail === 'string' && c.detail.length > 0));
  ok('四种拒绝都有原因码', cases.every((c) => c.reason !== undefined));
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);