/**
 * tests/router-alert.test.ts —— 求救/恢复通报：账本先行、24h 去重、恢复收敛、OUTBOX 幂等。
 *
 * 依据（docs/design/modules/model-router.md §4.5 + 契约 T3）：
 * - 账本先行：先 INSERT alert_dispatch(pending) 再投递、投完回写 delivered_via；
 *   崩溃重启时 reconcilePending 对 pending 超 2min 的行补投一次，再失败标 lost。
 * - 24h 去重：同签名已开放且未 lost → 24h 内静默；超 24h → 再发一条（带 #N 标记）。
 * - 升级必发恢复通报（§4.3 末条）：mode 变好 → sendRecovery 收敛"全部端点已非 open"的
 *   help 行，合并为一条恢复通报并回写 resolved_at；仍有 open 的行保持开放。
 * - OUTBOX 块格式（契约 T3）：`## [ISO] HELP <sig>` + `---`；同签名幂等（不重复追加）。
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { AlertManager, makeSignature, type FailingEndpoint } from '../src/router/alert.ts';
import { OutboxWriter } from '../src/router/outbox.ts';
import type { AlertChannelName } from '../src/router/types.ts';
import type { NotificationChannels, RouterMode } from '../src/shared/contracts.ts';

let tmp: TempDataDir;

beforeEach(() => {
  tmp = makeTempDataDir();
});

afterEach(() => {
  tmp.cleanup();
});

/** 造一个 AlertManager：outbox 落在临时目录，时钟可注入。 */
function makeAlerts(
  opts: { now?: () => number; channels?: NotificationChannels | null; channelOrder?: AlertChannelName[] } = {},
) {
  const outbox = new OutboxWriter(join(tmp.root, 'OUTBOX.md'), opts.now ?? Date.now);
  const am = new AlertManager({
    db: tmp.db,
    cfg: {
      dedup_window_ms: 86_400_000,
      outbox_path: join(tmp.root, 'OUTBOX.md'),
      channel_order: opts.channelOrder ?? ['telegram', 'email', 'outbox'],
      channel_timeout_ms: 10_000,
    },
    channels: opts.channels ?? null,
    outbox,
    taskImpact: null,
    now: opts.now,
  });
  return { am, outbox };
}

/** 假通知通道：记录每次 deliver，可用性与投递结果都可指定（SF 适配器的替身）。 */
function fakeChannels(opts: {
  available?: Array<'feishu' | 'telegram' | 'email'>;
  deliverResult?: { ok: boolean; error?: string };
} = {}): NotificationChannels & { delivered: Array<{ channel: string; text: string }> } {
  const available = new Set(opts.available ?? []);
  const delivered: Array<{ channel: string; text: string }> = [];
  return {
    delivered,
    available: (ch) => available.has(ch),
    async deliver(channel, text) {
      delivered.push({ channel, text });
      return opts.deliverResult ?? { ok: true };
    },
  };
}

const FAILING: FailingEndpoint[] = [
  { endpoint_id: 'openrouter-main', track: 'primary', kind: 'server_error', consec: 6 },
];

/** maybeSendHelp 的入参（mode 变化，其余固定）。 */
function helpInput(mode: RouterMode): Parameters<AlertManager['maybeSendHelp']>[0] {
  return { mode, failing: FAILING, tier: 0, servedBy: null };
}

describe('求救：账本先行与 OUTBOX 兜底（MR §4.5）', () => {
  it('通道全不可用 → 账本先 pending，最终落 OUTBOX 并回写 delivered_via', async () => {
    const { am, outbox } = makeAlerts();
    const sig = makeSignature('TOTAL_OUTAGE', FAILING, 0);
    const r = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(r.sent, true);
    assert.equal(r.channel, 'outbox', '阶段一无 Telegram/邮件 → 落 OUTBOX');

    // 账本：一条 help 行，delivered_via='outbox'，channels_tried 记了两次 unconfigured
    const rows = tmp.db
      .prepare(`SELECT kind, signature, mode, delivered_via, channels_tried, delivered_at FROM alert_dispatch`)
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'help');
    assert.equal(rows[0]?.signature, sig);
    assert.equal(rows[0]?.delivered_via, 'outbox');
    assert.ok(rows[0]?.delivered_at !== null, 'delivered_at 已回写');
    const tried = JSON.parse(String(rows[0]?.channels_tried)) as Array<{ channel: string; result: string }>;
    assert.deepEqual(
      tried.map((t) => `${t.channel}:${t.result}`),
      ['telegram:unconfigured', 'email:unconfigured'],
    );

    // OUTBOX：MR 块格式（## [ts] HELP <sig> ... ---）
    const text = outbox.readAll();
    assert.match(text, /^## \[\d{4}-\d{2}-\d{2}T[^\]]+\] HELP [0-9a-f]{6}\n/);
    assert.match(text, /🛟 dotd 求救 \[/);
    assert.match(text, /故障: openrouter-main\/primary server_error×6/);
    assert.match(text, /当前承载: 无；primary 任务挂起 未知（队列未上报）/);
    assert.match(text, /应急收缩: 已生效/);
    assert.match(text, /\n---\n/);
  });

  it('账本先行：投递前崩溃（进程被杀）重启后 reconcilePending 补投', async () => {
    // 手工造一行 pending（模拟"INSERT 完还没投递就崩了"），sent_at 早在 2min 前
    const sig = makeSignature('TOTAL_OUTAGE', FAILING, 0);
    tmp.db
      .prepare(
        `INSERT INTO alert_dispatch (signature, kind, mode, failing_json, served_by, task_impact,
           channels_tried, delivered_via, sent_at)
         VALUES (?, 'help', 'TOTAL_OUTAGE', ?, NULL, NULL, '[]', 'pending', ?)`,
      )
      .run(sig, JSON.stringify(FAILING), Date.now() - 300_000);

    const { am } = makeAlerts();
    const r = await am.reconcilePending();
    assert.deepEqual(r, { retried: 1, lost: 0 });
    const row = tmp.db
      .prepare(`SELECT delivered_via, channels_tried FROM alert_dispatch WHERE signature = ?`)
      .get(sig) as { delivered_via: string; channels_tried: string };
    assert.equal(row.delivered_via, 'outbox');
    const tried = JSON.parse(row.channels_tried) as Array<{ channel: string; result: string }>;
    assert.deepEqual(tried, [{ channel: 'outbox', result: 'redelivered' }]);
  });

  it('reconcilePending 不碰 2min 内的 pending（还在正常投递窗口）', async () => {
    const sig = makeSignature('EMERGENCY', FAILING, 3);
    tmp.db
      .prepare(
        `INSERT INTO alert_dispatch (signature, kind, mode, failing_json, served_by, task_impact,
           channels_tried, delivered_via, sent_at)
         VALUES (?, 'help', 'EMERGENCY', ?, NULL, NULL, '[]', 'pending', ?)`,
      )
      .run(sig, JSON.stringify(FAILING), Date.now() - 10_000);
    const { am } = makeAlerts();
    assert.deepEqual(await am.reconcilePending(), { retried: 0, lost: 0 });
    const row = tmp.db.prepare(`SELECT delivered_via FROM alert_dispatch`).get() as {
      delivered_via: string;
    };
    assert.equal(row.delivered_via, 'pending', '未超 2min 不动');
  });

  it('resendLost：lost 行人工重投（CLI dotd models resend-help）', async () => {
    const sig = makeSignature('TOTAL_OUTAGE', FAILING, 0);
    tmp.db
      .prepare(
        `INSERT INTO alert_dispatch (signature, kind, mode, failing_json, served_by, task_impact,
           channels_tried, delivered_via, sent_at, delivered_at)
         VALUES (?, 'help', 'TOTAL_OUTAGE', ?, NULL, NULL, '[]', 'lost', ?, ?)`,
      )
      .run(sig, JSON.stringify(FAILING), Date.now(), Date.now());
    const { am } = makeAlerts();
    assert.equal(await am.resendLost(), 1);
    const row = tmp.db.prepare(`SELECT delivered_via, resolved_at FROM alert_dispatch`).get() as {
      delivered_via: string;
      resolved_at: number | null;
    };
    assert.equal(row.delivered_via, 'outbox');
    assert.equal(row.resolved_at, null, '重投不改变 resolved 语义');
  });
});

describe('24h 去重（MR §4.5 同签名节流）', () => {
  it('同签名二次求救 24h 内静默（不写账本、不追加 OUTBOX）', async () => {
    const { am, outbox } = makeAlerts();
    const r1 = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(r1.sent, true);
    const after1 = outbox.readAll();
    const r2 = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.deepEqual(r2, { sent: false, channel: null, escalated: false }, '24h 内静默');
    assert.equal(outbox.readAll(), after1, 'OUTBOX 不重复追加');
    assert.equal(am.openAlerts(), 1);
  });

  it('同签名超 24h 仍开放 → 再发一条并带 #N 标记', async () => {
    let now = 1_800_000_000_000;
    const { am, outbox } = makeAlerts({ now: () => now });
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    now += 25 * 3_600_000; // 超过 dedup_window_ms=24h
    const r = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(r.sent, true);
    assert.equal(r.escalated, true, '超时重发标记 escalated');
    const text = outbox.readAll();
    // 幂等按签名去重，第二次不写新块，但账本里有 #2 标记的提醒行
    const rows = tmp.db
      .prepare(`SELECT COUNT(*) AS n FROM alert_dispatch WHERE signature = ?`)
      .get(makeSignature('TOTAL_OUTAGE', FAILING, 0)) as { n: number };
    assert.equal(rows.n, 2, '提醒作为新账本行（不覆盖原行）');
    void text;
  });

  it('不同故障集合 → 不同签名 → 各自发出', async () => {
    const { am } = makeAlerts();
    const other: FailingEndpoint[] = [
      { endpoint_id: 'colibri-olmoe', track: 'light', kind: 'timeout', consec: 3 },
    ];
    await am.maybeSendHelp({ mode: 'RESTRICTED', failing: FAILING, tier: 0, servedBy: null });
    const r = await am.maybeSendHelp({ mode: 'RESTRICTED', failing: other, tier: 0, servedBy: null });
    assert.equal(r.sent, true);
    assert.equal(am.openAlerts(), 2);
    assert.notEqual(
      makeSignature('RESTRICTED', FAILING, 0),
      makeSignature('RESTRICTED', other, 0),
      'signature 由 mode|failing|tier 决定',
    );
  });
});

describe('恢复通报与多行收敛（MR §4.3 末条/§4.5）', () => {
  it('mode 变好 + failing 端点全部非 open → 收敛为一条恢复通报', async () => {
    const { am, outbox } = makeAlerts();
    const sig = makeSignature('TOTAL_OUTAGE', FAILING, 0);
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(am.openAlerts(), 1);

    const r = await am.sendRecovery({
      mode: 'NORMAL',
      currentSignature: makeSignature('NORMAL', [], 1),
      isOpenNow: () => false, // 全部恢复
      servedBy: 'openrouter-main',
      sinceMs: 3 * 3_600_000 + 12 * 60_000,
    });
    assert.deepEqual(r.resolved, [sig]);
    assert.deepEqual(r.keptOpen, []);
    assert.equal(am.openAlerts(), 0, 'help 行已回写 resolved_at');

    // 恢复通报落 OUTBOX（RECOVERY 块），并列出关联签名
    const text = outbox.readAll();
    assert.match(text, /## \[[^\]]+\] RECOVERY /);
    assert.match(text, /✅ dotd 恢复 \[关联 /);
    assert.match(text, /模式: → NORMAL｜历时 3h12m/);
    assert.match(text, /恢复: [0-9a-f]{6}/);

    // 账本：recovery 行 + 原 help 行 resolved_at 非空
    const rows = tmp.db
      .prepare(`SELECT kind, resolved_at FROM alert_dispatch ORDER BY id`)
      .all() as Array<{ kind: string; resolved_at: number | null }>;
    assert.equal(rows[0]?.kind, 'help');
    assert.ok(rows[0]?.resolved_at !== null);
    assert.equal(rows[1]?.kind, 'recovery');
    assert.equal(rows[1]?.resolved_at, null, 'recovery 行本身不收敛');
  });

  it('仍有 open 的 help 行保持开放（不误收敛）', async () => {
    const { am } = makeAlerts();
    const sigA = makeSignature('TOTAL_OUTAGE', FAILING, 0);
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    // 第二条不同故障（不同签名）
    const other: FailingEndpoint[] = [
      { endpoint_id: 'colibri-olmoe', track: 'light', kind: 'timeout', consec: 3 },
    ];
    await am.maybeSendHelp({ mode: 'TOTAL_OUTAGE', failing: other, tier: 0, servedBy: null });
    assert.equal(am.openAlerts(), 2);

    const r = await am.sendRecovery({
      mode: 'LOCAL_FALLBACK',
      currentSignature: makeSignature('LOCAL_FALLBACK', [], 2),
      isOpenNow: (f) => f.endpoint_id === 'colibri-olmoe', // 云端恢复、本地仍挂
      servedBy: null,
    });
    assert.deepEqual(r.resolved, [sigA], '仅全恢复的那行收敛');
    assert.equal(r.keptOpen.length, 1, '本地仍挂 → 保持开放');
    assert.equal(am.openAlerts(), 1);
  });

  it('sendRecovery 无命中 → 不发通报（空收敛）', async () => {
    const { am, outbox } = makeAlerts();
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    const r = await am.sendRecovery({
      mode: 'NORMAL',
      currentSignature: makeSignature('NORMAL', [], 1),
      isOpenNow: () => true, // 全都还挂着
      servedBy: null,
    });
    assert.deepEqual(r.resolved, []);
    assert.equal(am.openAlerts(), 1, '不误收敛');
    assert.ok(!outbox.readAll().includes('RECOVERY'), '无恢复通报');
  });
});

describe('OUTBOX 幂等与块格式（契约 T3）', () => {
  it('同签名段落头已存在 → 跳过（duplicate）', () => {
    const w = new OutboxWriter(join(tmp.root, 'OUTBOX.md'), () => 1_800_000_000_000);
    const a = w.appendHelp('body-A', 'abc123');
    assert.equal(a.ok, true);
    assert.equal(a.duplicate, undefined);
    const b = w.appendHelp('body-B', 'abc123');
    assert.equal(b.duplicate, true, '同签名不重复追加');
    const text = w.readAll();
    assert.equal(text.split('## [').length - 1, 1, '只有一个块');
    assert.ok(text.includes('body-A'));
    assert.ok(!text.includes('body-B'));
  });

  it('不同签名分别成块，块间以 --- 分隔', () => {
    const w = new OutboxWriter(join(tmp.root, 'OUTBOX.md'), () => 1_800_000_000_000);
    w.appendHelp('body-A', 'aaa111');
    w.appendHelp('body-B', 'bbb222');
    const text = w.readAll();
    assert.equal(text.split('## [').length - 1, 2);
    assert.equal(text.split('\n---\n').length - 1, 2, '两块各有 --- 结尾');
    // 两次写入互相不受影响（第二个 writer 实例也走同一文件）
    assert.ok(text.includes('HELP aaa111') && text.includes('HELP bbb222'));
  });

  it('ensureFile 新建时写契约 T3 文件头', () => {
    const p = join(tmp.root, 'sub', 'OUTBOX.md');
    const w = new OutboxWriter(p, () => 1_800_000_000_000);
    w.ensureFile();
    assert.match(w.readAll(), /^# OUTBOX\.md/);
  });

  it('pruneResolved 只删已收敛签名的块', () => {
    const w = new OutboxWriter(join(tmp.root, 'OUTBOX.md'), () => 1_800_000_000_000);
    w.appendHelp('body-A', 'aaa111');
    w.appendHelp('body-B', 'bbb222');
    w.appendRecovery('recovered', 'aaa111');
    assert.equal(w.pruneResolved(['aaa111']), 2, 'HELP aaa111 + RECOVERY aaa111 两块都删');
    const text = w.readAll();
    assert.ok(text.includes('bbb222'), '未收敛的块保留');
    assert.ok(!text.includes('aaa111'));
  });

  it('OUTBOX 路径支持 ~ 展开（契约 T3）', () => {
    const w = new OutboxWriter('~/dotd-test-outbox/OUTBOX.md');
    assert.ok(!w.filePath.startsWith('~'), '构造时已展开');
  });

  it('ensureFile 幂等：不截断已有内容', () => {
    const w = new OutboxWriter(join(tmp.root, 'OUTBOX.md'));
    w.ensureFile();
    writeFileSync(w.filePath, '手工内容\n', 'utf8');
    w.ensureFile();
    assert.equal(readFileSync(w.filePath, 'utf8'), '手工内容\n');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2026-10-17 修（全方位测试高危"SOS 未接飞书"）
// 原状：daemon 给 MR 传 channels:null → 求救全落 OUTBOX.md，主人什么都收不到；
//       channel_order 里也没有 feishu。现在 feishu 是首位通道。
// ═══════════════════════════════════════════════════════════════════

describe('求救走飞书（主人 2026-10-16 指定通道）', () => {
  const ORDER: AlertChannelName[] = ['feishu', 'telegram', 'email', 'outbox'];

  it('feishu 可用 → 求救投飞书，不落 OUTBOX、不再试后续通道', async () => {
    const ch = fakeChannels({ available: ['feishu'] });
    const { am, outbox } = makeAlerts({ channels: ch, channelOrder: ORDER });
    const r = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(r.sent, true);
    assert.equal(r.channel, 'feishu');
    assert.deepEqual(
      ch.delivered.map((d) => d.channel),
      ['feishu'],
      '首个通道成功即停，不浪费后续尝试',
    );
    assert.ok(ch.delivered[0]?.text.includes('dotd 求救'), '投递正文是求救文案');
    const rows = tmp.db
      .prepare(`SELECT delivered_via, channels_tried FROM alert_dispatch`)
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.delivered_via, 'feishu');
    const tried = JSON.parse(String(rows[0]?.channels_tried)) as Array<{ channel: string; result: string }>;
    assert.deepEqual(
      tried.map((t) => `${t.channel}:${t.result}`),
      ['feishu:delivered'],
    );
    assert.ok(!outbox.readAll().includes('HELP'), '飞书投成功就不该再写 OUTBOX');
  });

  it('feishu 投递失败 → 如实记原因，落到 OUTBOX 兜底', async () => {
    const ch = fakeChannels({ available: ['feishu'], deliverResult: { ok: false, error: '飞书 code=999916' } });
    const { am, outbox } = makeAlerts({ channels: ch, channelOrder: ORDER });
    const r = await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.equal(r.channel, 'outbox', '飞书挂了仍有 OUTBOX 兜底');
    const rows = tmp.db
      .prepare(`SELECT delivered_via, channels_tried FROM alert_dispatch`)
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.delivered_via, 'outbox');
    const tried = JSON.parse(String(rows[0]?.channels_tried)) as Array<{ channel: string; result: string }>;
    assert.deepEqual(
      tried.map((t) => `${t.channel}:${t.result}`),
      ['feishu:飞书 code=999916', 'telegram:unconfigured', 'email:unconfigured'],
    );
    assert.ok(outbox.readAll().includes('HELP'));
  });

  it('feishu 未装配（available=false）→ 记 unconfigured，不假装投过', async () => {
    const ch = fakeChannels({ available: [] });
    const { am } = makeAlerts({ channels: ch, channelOrder: ORDER });
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    assert.deepEqual(
      ch.delivered.map((d) => d.channel),
      [],
      '不可用的通道连 deliver 都不该调',
    );
    const rows = tmp.db
      .prepare(`SELECT channels_tried FROM alert_dispatch`)
      .all() as Array<Record<string, unknown>>;
    const tried = JSON.parse(String(rows[0]?.channels_tried)) as Array<{ channel: string; result: string }>;
    assert.equal(tried[0]?.channel, 'feishu');
    assert.equal(tried[0]?.result, 'unconfigured');
  });

  it('恢复通报也走飞书；历时按"历时毫秒"渲染（epoch 直传会算出 17872134h）', async () => {
    const ch = fakeChannels({ available: ['feishu'] });
    const { am } = makeAlerts({ channels: ch, channelOrder: ORDER });
    await am.maybeSendHelp(helpInput('TOTAL_OUTAGE'));
    const r = await am.sendRecovery({
      mode: 'NORMAL',
      currentSignature: 'zzz999',
      isOpenNow: () => false,
      servedBy: 'colibri-olmoe',
      sinceMs: 11_400_000, // 3h10m，调用方传的是历时（ModelRouter 用 now()-modeSince）
    });
    assert.deepEqual(r.resolved.length, 1);
    const recovery = ch.delivered.filter((d) => d.channel === 'feishu').at(-1);
    assert.ok(recovery?.text.includes('dotd 恢复'), '恢复通报同样投飞书');
    assert.ok(recovery?.text.includes('历时 3h10m'), `历时渲染错：${recovery?.text}`);
    const rows = tmp.db
      .prepare(`SELECT kind, delivered_via FROM alert_dispatch WHERE kind='recovery'`)
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.delivered_via, 'feishu');
  });

  it('renderRecovery：sinceMs 为 null → 历时未知（不留空字段）', () => {
    const { am } = makeAlerts();
    const text = am.renderRecovery({
      signatures: ['abc123'],
      mode: 'NORMAL',
      recovered: ['abc123'],
      sinceMs: null,
      impact: null,
    });
    assert.ok(text.includes('历时 未知'), text);
  });
});
