import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir } from './helpers.ts';
import { Queue } from '../src/control-plane/queue.ts';
import { Guard } from '../src/control-plane/guard.ts';
import { DEFAULT_CP_CONFIG } from '../src/control-plane/types.ts';

/**
 * 内存水位 guard 的**基线标定方向错了**（2026-10-22 真机定位）。
 *
 * 现场：机器 24GB，系统空闲，MemAvailable ≈ 22.4GB。
 *   guard 标定 baseMb = p50(MemAvailable) ≈ 22348
 *   normalMb = baseMb + dotdReserveMb(6144) ≈ 28492  ← **大于物理总量 24020**
 * 于是「回到 normal」在物理上不可能，guard 永久停在 throttled：
 *   → 停 pop、给容器 pause → 所有任务卡死。
 * 真机现场就是这个：queue {queued:1, running:0}，容器 quarantined，
 * guard 显示 level=throttled, memAvailableMb=22397, baseMb=22348。
 *
 * 核心错误：把 **「可用内存」** 的 p50 当成 **「系统基线占用」** 来用，
 * 两个量方向相反：
 *   · 「基线占用」应 ≈ MemTotal - MemAvailable ≈ 1.7GB，
 *     normal 线 = 占用回落 + 预留，语义才对得上「余量够不够」；
 *   · 现在 baseMb 是「可用量」，再拿「可用量 + 6GB」去比「可用量」，恒假。
 *
 * 为什么老测试没抓到：它用 8GB 的假读数（base+6144=14144），
 * 阈值始终小于假想的物理总量，所以「阈值 > 总量」这个错误从未暴露。
 * 本测试改用真实机器参数（24GB），错误立刻现形。
 */

function makeGuard(memMb: number, totalMb: number) {
  const tmp = makeTempDataDir();
  const cfg = { ...DEFAULT_CP_CONFIG };
  const queue = new Queue({ db: tmp.db, cfg, bus: tmp.bus, guardLevel: () => 'normal', record: () => {} });
  const guard = new Guard({
    db: tmp.db,
    cfg,
    queue,
    bus: tmp.bus,
    record: () => {},
    knownDotIds: () => [],
    readMem: () => ({ availableMb: memMb }),
    readTotalMb: () => totalMb,
    env: {},
  });
  return guard;
}

const TOTAL_MB = 24_020; // 真机 MemTotal
const AVAIL_MB = 22_400; // 真机空闲时 MemAvailable

test('水位标定不变式：三条阈值都必须落在物理内存内，否则该档位永远不可达', () => {
  const guard = makeGuard(AVAIL_MB, TOTAL_MB);
  guard.calibrateOrUseFallback();
  const st = guard.status();
  assert.ok(st.baseMb > 0, 'baseMb 应已标定出来');

  // 关键验证不看内部阈值，看**行为**：把可用内存设成「系统空闲时的真实值」，
  // 连续两次 tick 后必须能回到 normal。够不到 normal 就意味着这台机器永远卡在低档。
  guard.tick();
  guard.tick();
  assert.equal(
    guard.currentLevel(),
    'normal',
    `可用内存 ${AVAIL_MB}MB（系统空闲）时应当判定为 normal，实际是 ${guard.currentLevel()}。` +
      `\n  标定 baseMb=${st.baseMb}（MemAvailable 的 p50），若阈值仍按 base+dotdReserveMb` +
      `=${st.baseMb + DEFAULT_CP_CONFIG.dotdReserveMb}MB 计算，就超过了物理总量 ${TOTAL_MB}MB，` +
      `于是这台机器「永远回不到 normal」，guard 持续 pause 容器 → 任务全卡死。`,
  );});
