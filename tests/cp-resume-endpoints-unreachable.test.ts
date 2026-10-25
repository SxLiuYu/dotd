/**
 * tests/cp-resume-endpoints-unreachable.test.ts —— 网关不可达的暂停任务必须能被恢复。
 *
 * 现场（2026-10-19，跨两轮）：
 *  第 73 轮把「模型不可用」拆成三种 stop_reason
 *  （circuit_open / no_qualified_primary / endpoints_unreachable），
 *  但 **resumeCircuitOpenTasks 的 SQL 还只写死了 `stop_reason='circuit_open'`** ——
 *  `endpoints_unreachable`（网关不可达，最常见的那个）永远不会被恢复。
 *
 *  也就是说：上一轮修了"标对原因"，这一轮才补上"按原因恢复"。
 *
 * 这个测试钉住三件事：
 *  ① circuit_open 和 endpoints_unreachable 都会被恢复
 *  ② no_qualified_primary **不**自动恢复（配置问题，改配置后手动 resume）
 *  ③ watermark / budget / tool_risk 不受影响（各有自己的解冻路径）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createControlPlane } from '../src/control-plane/index.ts';
import { EventBus } from '../src/shared/bus.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMigratedTemplateDb } from '../db/template.ts';

function fixture(): { cp: ReturnType<typeof createControlPlane>; bus: EventBus; db: ReturnType<typeof openMigratedTemplateDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dotd-resume-'));
  const db = openMigratedTemplateDb(join(dir, 't.db'));
  const bus = new EventBus();
  const cp = createControlPlane({ db, bus });
  // 只 shutdown，不删临时目录：Windows 上 sqlite 文件句柄释放有延迟，rmSync 会 EPERM
  return { cp, bus, db, cleanup: () => { cp.shutdown(); } };
}

test('网关不可达(endpoints_unreachable)也会被自动恢复', () => {
  const { cp, bus, db, cleanup } = fixture();
  try {
    const a = cp.submit({ title: 'a', goal: 'g', dotId: 'dot1' });
    const b = cp.submit({ title: 'b', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(a.id, 'circuit_open');
    cp.pauseByReason(b.id, 'endpoints_unreachable');

    // 端点恢复：发 breaker_closed
    bus.publish('router.breaker_changed', { endpointId: 'e1', track: 'primary', from: 'open', to: 'closed' });

    const rows = db.prepare('SELECT id, status, stop_reason FROM tasks WHERE id IN (?,?) ORDER BY id').all(a.id, b.id) as Array<{ status: string; stop_reason: string | null }>;
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.status, 'queued', '两种原因都应回 queued');
      assert.equal(r.stop_reason, null, '恢复后清掉 stop_reason');
    }
  } finally {
    cleanup();
  }
});

test('配置问题(no_qualified_primary)不自动恢复', () => {
  const { cp, bus, db, cleanup } = fixture();
  try {
    const c = cp.submit({ title: 'c', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(c.id, 'no_qualified_primary');

    bus.publish('router.breaker_changed', { endpointId: 'e1', track: 'primary', from: 'open', to: 'closed' });

    const r = db.prepare('SELECT status, stop_reason FROM tasks WHERE id=?').get(c.id) as { status: string; stop_reason: string | null };
    assert.equal(r.status, 'paused', '配置问题不该被端点恢复顺手拉起');
    assert.equal(r.stop_reason, 'no_qualified_primary');
  } finally {
    cleanup();
  }
});

test('其它暂停原因(watermark/budget/tool_risk)不受影响', () => {
  const { cp, bus, db, cleanup } = fixture();
  try {
    const reasons = ['watermark', 'budget', 'tool_risk'] as const;
    const ids = reasons.map((r) => {
      const t = cp.submit({ title: r, goal: 'g', dotId: 'dot1' });
      cp.pauseByReason(t.id, r);
      return t.id;
    });

    bus.publish('router.breaker_changed', { endpointId: 'e1', track: 'primary', from: 'open', to: 'closed' });

    for (const [i, id] of ids.entries()) {
      const r = db.prepare('SELECT status, stop_reason FROM tasks WHERE id=?').get(id) as { status: string; stop_reason: string | null };
      assert.equal(r.status, 'paused', `${reasons[i]} 不该被模型恢复路径带走`);
    }
  } finally {
    cleanup();
  }
});

// ── 2026-10-25：重启后事件不补发，靠"最近一次成功调用"兜底恢复 ──────────────

test('resumePausedAfterModelOk：暂停早于最近一次成功 → 回队', () => {
  const { cp, db, cleanup } = fixture();
  try {
    const a = cp.submit({ title: 'a', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(a.id, 'endpoints_unreachable');
    const pausedAt = (db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(a.id) as { updated_at: number }).updated_at;

    assert.equal(cp.resumePausedAfterModelOk(pausedAt - 1), 0, '成功发生在暂停之前 → 不恢复');
    let r = db.prepare('SELECT status FROM tasks WHERE id=?').get(a.id) as { status: string };
    assert.equal(r.status, 'paused');

    assert.equal(cp.resumePausedAfterModelOk(pausedAt + 1), 1, '成功发生在暂停之后 → 恢复');
    const after = db.prepare('SELECT status, stop_reason FROM tasks WHERE id=?').get(a.id) as { status: string; stop_reason: string | null };
    assert.equal(after.status, 'queued');
    assert.equal(after.stop_reason, null);
  } finally {
    cleanup();
  }
});

test('resumePausedAfterModelOk：只碰 circuit_open / endpoints_unreachable，不碰配置与资源类暂停', () => {
  const { cp, db, cleanup } = fixture();
  try {
    const transient = ['circuit_open', 'endpoints_unreachable'] as const;
    const sticky = ['no_qualified_primary', 'watermark', 'budget', 'tool_risk'] as const;
    const ids = new Map<string, string>();
    for (const reason of [...transient, ...sticky]) {
      const t = cp.submit({ title: reason, goal: 'g', dotId: 'dot1' });
      cp.pauseByReason(t.id, reason);
      ids.set(reason, t.id);
    }
    const n = cp.resumePausedAfterModelOk(Date.now() + 60_000);
    assert.equal(n, 2, '只有两种"模型不可用"原因可恢复');

    for (const reason of transient) {
      const r = db.prepare('SELECT status FROM tasks WHERE id=?').get(ids.get(reason)!) as { status: string };
      assert.equal(r.status, 'queued', `${reason} 应回队`);
    }
    for (const reason of sticky) {
      const r = db.prepare('SELECT status, stop_reason FROM tasks WHERE id=?').get(ids.get(reason)!) as { status: string; stop_reason: string | null };
      assert.equal(r.status, 'paused', `${reason} 不该被模型恢复路径带走`);
      assert.equal(r.stop_reason, reason);
    }
  } finally {
    cleanup();
  }
});

test('resumePausedAfterModelOk：非法时间戳不恢复（避免把"0"当成功过）', () => {
  const { cp, db, cleanup } = fixture();
  try {
    const a = cp.submit({ title: 'a', goal: 'g', dotId: 'dot1' });
    cp.pauseByReason(a.id, 'endpoints_unreachable');
    assert.equal(cp.resumePausedAfterModelOk(0), 0);
    assert.equal(cp.resumePausedAfterModelOk(Number.NaN), 0);
    const r = db.prepare('SELECT status FROM tasks WHERE id=?').get(a.id) as { status: string };
    assert.equal(r.status, 'paused');
  } finally {
    cleanup();
  }
});
