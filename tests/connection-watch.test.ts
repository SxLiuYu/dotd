/**
 * tests/connection-watch.test.ts —— 连接看门狗（U3 的「持续在线」那一半）。
 *
 * 这个文件守的核心是一句话：**只在变化时说，且说过就不再重复**。
 * 一条连接一直坏着，主人不该每 15 分钟收到同一句；坏过一次又好了，他该知道。
 *
 * 分两层：
 *   ① judgeWatch / inQuietHours / render* 是纯函数，逐条钉语义；
 *   ② startConnectionWatch 用假时钟 + 假发送器，钉住「状态落库早于推送」
 *      与「安静时段只记不推」这两条容易写反的顺序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hhmmOf,
  inQuietHours,
  isProblem,
  judgeWatch,
  renderProblemMessage,
  renderRecoveredMessage,
  watchSubjects,
} from '../src/surfaces/connection-watch.ts';
import type { WatchSubject } from '../src/surfaces/connection-watch.ts';
import type { ConnectionRow } from '../src/surfaces/connections.ts';
import { startConnectionWatch } from '../src/surfaces/connection-watch-push.ts';

function row(
  kind: ConnectionRow['kind'],
  id: string,
  name: string,
  status: ConnectionRow['status'],
  detail: string,
): ConnectionRow {
  return { kind, id, name, status, detail };
}

// ═══════════════════════════════════════════════════════════════════
// 一、什么是「问题」
// ═══════════════════════════════════════════════════════════════════

test('isProblem：error / not_configured / public_only 算出问题，connected 与 ready 不算', () => {
  assert.equal(isProblem('error'), true);
  assert.equal(isProblem('not_configured'), true, '配了一半的连接最危险：写了 app_id 却没配会话');
  assert.equal(isProblem('public_only'), true, '未认证会被限速，值得说一次');
  assert.equal(isProblem('connected'), false);
  assert.equal(isProblem('ready'), false);
});

test('watchSubjects：从总览行里只挑有问题的，且原样保留 name/detail', () => {
  const rows: ConnectionRow[] = [
    row('calendar', 'calendar', '日历', 'ready', '3 个日历源 / 12 个事件'),
    row('connector', 'github', 'GitHub', 'public_only', 'Issues / Pulls'),
    row('model', 'primary/a.example', 'primary · a.example', 'error', '401 未授权'),
  ];
  const subs = watchSubjects(rows);
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((s) => s.id), ['github', 'primary/a.example']);
  assert.equal(subs[1]?.detail, '401 未授权');
});
// ═══════════════════════════════════════════════════════════════════
// 二、判「该不该说」——边沿触发
// ═══════════════════════════════════════════════════════════════════

test('judgeWatch：从没问题到有问题 → 报；下一次同样的状态 → 沉默', () => {
  const s: WatchSubject = { kind: 'connector', id: 'github', name: 'GitHub', status: 'error', detail: '401' };
  const first = judgeWatch([s], {});
  assert.equal(first.problem.length, 1, '第一次发现坏，要说');
  const second = judgeWatch([s], first.next);
  assert.equal(second.problem.length, 0, '还坏着，但已经说过了，不再重复');
  assert.deepEqual(second.next, first.next, '状态表不能因为沉默就被清空');
});

test('judgeWatch：坏着但 detail 变了（错误信息换了）→ 重说一次', () => {
  const a: WatchSubject = { kind: 'connector', id: 'github', name: 'GitHub', status: 'error', detail: '401' };
  const b: WatchSubject = { ...a, detail: '429 限速' };
  const first = judgeWatch([a], {});
  const second = judgeWatch([b], first.next);
  assert.equal(second.problem.length, 1, '换了一种坏法，值得再说一句');
});

test('judgeWatch：好了 → 报恢复，且名字取自上次存下的标签（不是 key 原文）', () => {
  const s: WatchSubject = { kind: 'connector', id: 'github', name: 'GitHub', status: 'error', detail: '401' };
  const first = judgeWatch([s], {});
  const second = judgeWatch([], first.next);
  assert.equal(second.problem.length, 0);
  assert.equal(second.recovered.length, 1);
  assert.equal(second.recovered[0]?.label, 'GitHub', '恢复通知要说人名，不能说 connector:github');
  assert.equal(second.recovered[0]?.key, 'connector:github');
  assert.deepEqual(second.next, {}, '恢复了就不再记着它');
});

test('judgeWatch：从没问题到现在也没问题 → 完全沉默，不发任何消息', () => {
  const v = judgeWatch([], {});
  assert.equal(v.problem.length, 0);
  assert.equal(v.recovered.length, 0);
  assert.deepEqual(v.next, {});
});

test('judgeWatch：状态表被写坏（格式不对）→ 当作没记录过，宁可多说一句', () => {
  const s: WatchSubject = { kind: 'mcp', id: 'fs', name: 'fs-server', status: 'error', detail: '起不来' };
  const v = judgeWatch([s], { 'mcp:fs': 'garbage-without-separator' });
  assert.equal(v.problem.length, 1, '解不出来就当没说过：漏报比多说一句危险');
});
// ═══════════════════════════════════════════════════════════════════
// 三、安静时段
// ═══════════════════════════════════════════════════════════════════

test('inQuietHours：不跨午夜 09:00-18:00', () => {
  const q = { start: '09:00', end: '18:00' };
  assert.equal(inQuietHours('08:59', q), false);
  assert.equal(inQuietHours('09:00', q), true, '含起点');
  assert.equal(inQuietHours('17:59', q), true);
  assert.equal(inQuietHours('18:00', q), false, '不含终点');
});

test('inQuietHours：跨午夜 23:00-07:30（与 crontabs.quiet_hours 同语义）', () => {
  const q = { start: '23:00', end: '07:30' };
  assert.equal(inQuietHours('22:59', q), false);
  assert.equal(inQuietHours('23:00', q), true);
  assert.equal(inQuietHours('03:00', q), true);
  assert.equal(inQuietHours('07:29', q), true);
  assert.equal(inQuietHours('07:30', q), false);
  assert.equal(inQuietHours('12:00', q), false);
});

test('inQuietHours：null 或起止相等 → 不静音', () => {
  assert.equal(inQuietHours('03:00', null), false);
  assert.equal(inQuietHours('23:00', { start: '23:00', end: '23:00' }), false, '起止相等是不设，不是全天静音');
});

test('inQuietHours：格式写错 → 不静音（宁可多报，也别因为笔误把故障全吞了）', () => {
  assert.equal(inQuietHours('03:00', { start: '25:00', end: '07:00' }), false);
  assert.equal(inQuietHours('garbage', { start: '23:00', end: '07:00' }), false);
});

test('hhmmOf：本地时间补零到 HH:MM', () => {
  const d = new Date(2026, 9, 22, 7, 5, 0);
  assert.equal(hhmmOf(d.getTime()), '07:05');
});

// ═══════════════════════════════════════════════════════════════════
// 四、文案
// ═══════════════════════════════════════════════════════════════════

test('renderProblemMessage：逐条列出名字 + 状态词 + detail，并给出关掉的办法', () => {
  const at = new Date(2026, 9, 22, 9, 30, 0).getTime();
  const msg = renderProblemMessage(
    [
      { kind: 'connector', id: 'github', name: 'GitHub', status: 'public_only', detail: '未认证限速 60/h' },
      { kind: 'mcp', id: 'fs', name: 'fs-server', status: 'error', detail: '起不来' },
    ],
    at,
  );
  assert.match(msg, /^连接出问题了（09:30 检查）/);
  assert.match(msg, /GitHub — 仅公开接口：未认证限速 60\/h/);
  assert.match(msg, /fs-server — 出错：起不来/);
  assert.match(msg, /surfaces\.connection_watch\.enabled 关掉/, '要告诉主人怎么让它闭嘴');
});

test('renderProblemMessage：空列表 → 空串（调用方据此不发消息）', () => {
  assert.equal(renderProblemMessage([], Date.now()), '');
});

test('renderRecoveredMessage：只说「好了」，不带 detail', () => {
  const at = new Date(2026, 9, 22, 9, 30, 0).getTime();
  const msg = renderRecoveredMessage([{ key: 'connector:github', label: 'GitHub' }], at);
  assert.match(msg, /^连接已恢复（09:30 检查）/);
  assert.match(msg, /GitHub 好了/);
  assert.equal(renderRecoveredMessage([], at), '');
});
// ═══════════════════════════════════════════════════════════════════
// 五、ticker：顺序与开关
// ═══════════════════════════════════════════════════════════════════

interface Harness {
  sends: Array<{ chatId: string; text: string }>;
  records: Array<{ chatId: string; ok: boolean; text: string }>;
  saved: Array<Record<string, string>>;
  logs: string[];
}

// 启动那一轮是 queueMicrotask：先让它落定，用例才好量「显式 tick 的增量」。
// 直接 await tick() 会让启动轮和显式轮撞在一起，断言 saved.length===1 就会偶发变 2。
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

function makeTicker(opts: {
  rows: () => ConnectionRow[];
  initial?: Record<string, string>;
  enabled?: boolean;
  quietHours?: { start: string; end: string } | null;
  atMs?: number;
  sendFails?: boolean;
  targets?: string[];
}): { ticker: { stop(): void; tick(): Promise<void> }; h: Harness; state(): Record<string, string> } {
  const h: Harness = { sends: [], records: [], saved: [], logs: [] };
  let state: Record<string, string> = { ...(opts.initial ?? {}) };
  const ticker = startConnectionWatch({
    cfg: {
      enabled: opts.enabled ?? true,
      intervalMin: 15,
      quietHours: opts.quietHours ?? null,
    },
    now: () => opts.atMs ?? new Date(2026, 9, 22, 10, 0, 0).getTime(),
    rows: opts.rows,
    loadState: () => state,
    saveState: (s) => {
      state = { ...s };
      h.saved.push({ ...s });
    },
    targets: () => opts.targets ?? ['oc_owner'],
    sendText: (chatId, text) => {
      if (opts.sendFails === true) return Promise.resolve({ ok: false, error: 'network' });
      h.sends.push({ chatId, text });
      return Promise.resolve({ ok: true });
    },
    record: (r) => h.records.push({ chatId: r.chatId, ok: r.ok, text: r.text }),
    log: (m) => h.logs.push(m),
  });
  return { ticker, h, state: () => state };
}

test('ticker：发现问题 → 发一条；再跑一次 → 不再发（边沿触发）', async () => {
  const bad = (): ConnectionRow[] => [row('connector', 'github', 'GitHub', 'error', '401 未授权')];
  const { ticker, h } = makeTicker({ rows: bad });
  await ticker.tick();
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0]?.text ?? '', /GitHub — 出错：401 未授权/);
  await ticker.tick();
  assert.equal(h.sends.length, 1, '同一状态第二次跑不该再发');
  ticker.stop();
});

test('ticker：全绿时一个字都不发，也不写台账', async () => {
  const { ticker, h } = makeTicker({ rows: () => [row('calendar', 'calendar', '日历', 'ready', '3 个源')] });
  await settle();                    // 先让「启动即查」那一轮落定，再量下面的增量
  const savedBefore = h.saved.length;
  await ticker.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.records.length, 0);
  assert.equal(h.saved.length - savedBefore, 1, '没话说也要落状态：否则「已说过」会丢');
  ticker.stop();
});

test('ticker：状态先落库再推送（推送失败也不会重复报）', async () => {
  const bad = (): ConnectionRow[] => [row('mcp', 'fs', 'fs-server', 'error', '起不来')];
  const { ticker, h, state } = makeTicker({ rows: bad, sendFails: true });
  await ticker.tick();
  assert.equal(h.saved.length, 1, '落库发生在推送之前');
  assert.equal(state()['mcp:fs']?.includes('fs-server'), true);
  assert.equal(h.sends.length, 0);
  assert.equal(h.records.length, 1, '失败也要记，主人问「怎么没收到」时查得到');
  assert.equal(h.records[0]?.ok, false);
  const before = h.records.length;
  await ticker.tick();
  assert.equal(h.records.length, before, '第二轮不该因为上一轮发送失败就重发');
  ticker.stop();
});

test('ticker：安静时段只落状态、不推送', async () => {
  const bad = (): ConnectionRow[] => [row('connector', 'github', 'GitHub', 'error', '401')];
  const { ticker, h, state } = makeTicker({
    rows: bad,
    quietHours: { start: '09:00', end: '18:00' },
    atMs: new Date(2026, 9, 22, 10, 0, 0).getTime(),
  });
  await ticker.tick();
  assert.equal(h.sends.length, 0, '安静时段不推');
  assert.equal(h.records.length, 0);
  assert.equal(state()['connector:github'] !== undefined, true, '但要记住，出了安静时段不再重说');
  assert.match(h.logs.join(' '), /安静时段/);
  ticker.stop();
});

test('ticker：恢复时发一条「好了」，且说人话', async () => {
  const bad = (): ConnectionRow[] => [row('connector', 'github', 'GitHub', 'error', '401')];
  const g = makeTicker({ rows: bad });
  await g.ticker.tick();
  const savedState = g.state();
  g.ticker.stop();

  const good = makeTicker({ rows: () => [], initial: savedState });
  await good.ticker.tick();
  assert.equal(good.h.sends.length, 1);
  assert.match(good.h.sends[0]?.text ?? '', /GitHub 好了/);
  good.ticker.stop();
});

test('ticker：enabled=false 时一个查询都不发（连 rows 都不调）', async () => {
  let called = 0;
  const { ticker, h } = makeTicker({
    enabled: false,
    rows: () => {
      called += 1;
      return [];
    },
  });
  await ticker.tick();
  assert.equal(called, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.saved.length, 0);
  ticker.stop();
});

test('ticker：取总览抛错 → 只记日志，不推送', async () => {
  const { ticker, h } = makeTicker({
    rows: () => {
      throw new Error('db locked');
    },
  });
  await ticker.tick();
  assert.equal(h.sends.length, 0);
  assert.match(h.logs.join(' '), /取连接总览失败.*db locked/);
  ticker.stop();
});

test('ticker：没有可发的会话 → 落状态但不发，日志说清原因', async () => {
  const { ticker, h } = makeTicker({
    rows: () => [row('mcp', 'fs', 'fs', 'error', 'x')],
    targets: [],
  });
  await settle();
  const savedBefore = h.saved.length;
  await ticker.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.saved.length - savedBefore, 1);
  assert.match(h.logs.join(' '), /没有可发的会话/);
  ticker.stop();
});
test('ticker：启动即跑一次（不等第一个 interval，否则重启后头 15 分钟是盲的）', async () => {
  // 真 daemon 上抓到过的缺陷：只挂 setInterval 时，进程起来到第一个 interval 之间
  // 完全没检查，宕机期间坏掉的连接要等满 interval_min 才被告知。
  const bad = (): ConnectionRow[] => [row('connector', 'github', 'GitHub', 'error', '401 未授权')];
  const { ticker, h } = makeTicker({ rows: bad });
  // 启动那一轮是 queueMicrotask（不阻塞返回），给它几拍
  for (let i = 0; i < 20 && h.saved.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(h.saved.length, 1, '启动后应立刻检查一次并落库');
  assert.equal(h.sends.length, 1, '启动那一轮发现问题就该推送');
  ticker.stop();
});

test('ticker：enabled=false 时启动那一轮也不动（连 rows 都不调）', async () => {
  let called = 0;
  const { ticker, h } = makeTicker({
    enabled: false,
    rows: () => {
      called++;
      return [row('mcp', 'fs', 'fs', 'error', 'x')];
    },
  });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(called, 0, '关掉时启动不该读总览');
  assert.equal(h.sends.length, 0);
  assert.equal(h.saved.length, 0);
  ticker.stop();
});
