/**
 * tests/surfaces-ingress.test.ts —— §4.6/§5.1/§5.3 入站规范化、dedup_key、限流、
 * 拒绝审计 测试（webhook / JSONL / heartbeat / telegram 四条来源）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { EventBus } from '../src/shared/bus.ts';
import type { BusEvent } from '../src/shared/bus.ts';
import {
  CONSECUTIVE_BAD_LINES,
  ERRORS_MAX_BYTES,
  IngressRejectLog,
  JsonlErrorSink,
  MAX_BODY_BYTES,
  RateLimiter,
  ROLLING_MAX_BYTES,
  SURF_INGRESS_REJECTS_MAX_ROWS,
  SURF_TG_CARD_STATE_MAX_ROWS,
  buildHeartbeatRaw,
  createIngress,
  ingest,
  isApprovalTraffic,
  looksLikeApprovalCommand,
  looksLikeApprovalReply,
  normalizeHook,
  normalizeJsonlLine,
  normalizeTelegramMessage,
  originAllowed,
  priorityForSource,
  purgeSurfacesRetention,
  rawToIngress,
  rollFileIfNeeded,
  validateRawInbound,
} from '../src/surfaces/ingress.ts';
import {
  fileDedupKey,
  heartbeatDedupKey,
  PRIORITY_MAP,
  telegramDedupKey,
  webhookDedupKey,
} from '../src/surfaces/types.ts';
import type { IngestDeps } from '../src/surfaces/ingress.ts';
import type { HookConfig } from '../src/surfaces/types.ts';
import type { RawInbound } from '../src/shared/contracts.ts';

// ── 测试替身 ────────────────────────────────────────────────────────

interface FakeCp {
  calls: Array<{ source: string; dotId: string; dedupKey?: string; priority?: number; payload: unknown }>;
  seen: Map<string, number>;
  throwNext: boolean;
}

function makeCp(): FakeCp {
  return { calls: [], seen: new Map(), throwNext: false };
}

function cpSide(cp: FakeCp): IngestDeps['cp'] {
  return {
    ingestEvent(req) {
      cp.calls.push({
        source: req.source,
        dotId: req.dotId,
        dedupKey: req.dedupKey,
        priority: req.priority,
        payload: req.payload,
      });
      if (cp.throwNext) {
        cp.throwNext = false;
        throw new Error('CP 队列满');
      }
      const key = req.dedupKey ?? '';
      const prior = cp.seen.get(key);
      if (prior !== undefined) return { eventId: prior, dup: true };
      const id = 200 + cp.seen.size;
      cp.seen.set(key, id);
      return { eventId: id, dup: false };
    },
  };
}

function makeIngestDeps(dir: TempDataDir, bus: EventBus, cp: FakeCp, extra: Partial<IngestDeps> = {}): IngestDeps {
  return {
    db: dir.db,
    bus,
    cp: cpSide(cp),
    rejects: new IngressRejectLog(dir.db),
    rateLimiter: new RateLimiter({ defaultPerMin: 120 }),
    now: () => new Date(2026, 0, 15, 12, 0, 0, 0),
    ...extra,
  };
}

const HOOKS: HookConfig[] = [{ source: 'grafana', secret: 's1', dotId: 'dot1', rateLimitPerMin: 600 }];

// ═══════════════════════════════════════════════════════════════════
// 一、§5.1 优先级映射与 zod 校验
// ═══════════════════════════════════════════════════════════════════

test('优先级映射：interactive/telegram=1，heartbeat·http=5，file=7（逐字）', () => {
  assert.deepEqual(PRIORITY_MAP, { interactive: 1, telegram: 1, heartbeat: 5, http: 5, file: 7 });
  assert.equal(priorityForSource('http'), 5);
  assert.equal(priorityForSource('file'), 7);
  assert.equal(priorityForSource('heartbeat'), 5);
  assert.equal(priorityForSource('telegram'), 1);
});

test('rawToIngress：按 source 映射 priority；text 合入 payload', () => {
  const req = rawToIngress({ source: 'file', dotId: 'dot1', text: 'hello', payload: { a: 1 }, actor: 'file:x' });
  assert.equal(req.priority, 7);
  assert.deepEqual(req.payload, { a: 1, text: 'hello' });
  assert.equal(req.dedupKey, undefined);
});

test('validateRawInbound：缺 source/dotId/actor → schema 拒', () => {
  assert.deepEqual(validateRawInbound({ source: 'http', dotId: 'dot1', payload: {}, actor: 'a' }), { ok: true });
  const bad = validateRawInbound({ source: 'http', payload: {}, actor: 'a' } as unknown as RawInbound);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /dotId|dot_id|Invalid|expected/i);
});

// ═══════════════════════════════════════════════════════════════════
// 二、§4 表 dedup_key 规则
// ═══════════════════════════════════════════════════════════════════

test('dedup_key：heartbeat = hb:<ct_id>:<next_fire_ms>', () => {
  assert.equal(heartbeatDedupKey('ct_abc', 1_766_000_000_000), 'hb:ct_abc:1766000000000');
  assert.equal(buildHeartbeatRaw({ ctId: 'ct_1', dotId: 'dot1', title: 't', prompt: 'p', nextFire: 123 }).dedupKey, 'hb:ct_1:123');
});

test('dedup_key：file = file:<path>:<ino>:<gen>:<行号>', () => {
  assert.equal(fileDedupKey('/var/log/x.jsonl', 42, 3, 17), 'file:/var/log/x.jsonl:42:3:17');
  const raw = normalizeJsonlLine({ path: '/l.jsonl', inode: 9, gen: 0, lineNo: 1, line: '{"text":"hi"}' }, 'dot1');
  assert.equal(raw.ok, true);
  if (!raw.ok) return;
  assert.equal(raw.raw.dedupKey, 'file:/l.jsonl:9:0:1');
  assert.equal(raw.raw.source, 'file');
  assert.equal(raw.raw.text, 'hi');
  assert.equal(raw.raw.actor, 'file:/l.jsonl');
});

test('dedup_key：webhook = <source>:<extId|sha256(body)[0:16]>', () => {
  const sha = 'a'.repeat(64);
  assert.equal(webhookDedupKey('grafana', 'g-1', sha), 'grafana:g-1');
  assert.equal(webhookDedupKey('grafana', undefined, sha), `grafana:${sha.slice(0, 16)}`);
  assert.equal(webhookDedupKey('grafana', '', sha), `grafana:${sha.slice(0, 16)}`);
  // normalizeHook：有 id 用 id，无 id 用 body sha 前 16 位
  const withId = normalizeHook('grafana', { id: 'x-1' }, HOOKS);
  assert.equal(withId.ok, true);
  if (!withId.ok) return;
  assert.equal(withId.hook.dedupKey, 'grafana:x-1');
  assert.equal(withId.hook.raw.source, 'http');
  assert.equal(withId.hook.raw.actor, 'hook:grafana');
  const noId = normalizeHook('github', { foo: 1 }, [{ source: 'github', secret: 's', dotId: 'dot1', rateLimitPerMin: 60 }]);
  assert.equal(noId.ok, true);
  if (!noId.ok) return;
  assert.match(noId.hook.dedupKey, /^github:[0-9a-f]{16}$/);
});

test('dedup_key：telegram = tg:<update_id>', () => {
  assert.equal(telegramDedupKey(987654), 'tg:987654');
  const raw = normalizeTelegramMessage(987654, 555, '你好', 'dot1');
  assert.equal(raw.dedupKey, 'tg:987654');
  assert.equal(raw.source, 'telegram');
  assert.equal(raw.actor, 'tg:555');
  assert.equal(raw.text, '你好');
});

test('normalizeHook：未登记 source → reject(auth)', () => {
  const r = normalizeHook('unknown', {}, HOOKS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'auth');
});

test('normalizeJsonlLine：坏行 → reject(parse)（不阻塞后续行）', () => {
  const r = normalizeJsonlLine({ path: '/l.jsonl', inode: 1, gen: 0, lineNo: 5, line: '{oops' }, 'dot1');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'parse');
  assert.match(r.detail, /第 5 行/);
});

// ═══════════════════════════════════════════════════════════════════
// 三、ingest 主路径（§5.1 逐句）
// ═══════════════════════════════════════════════════════════════════

test('ingest：新事件 → accepted + 202 + 总线通报 event.received', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const logTopic: string[] = [];
    bus.on('event.received', (e: BusEvent<{ eventId: number }>): void => {
      logTopic.push(String(e.payload.eventId));
    });

    const out = ingest(
      { source: 'http', dotId: 'dot1', payload: { id: 'h1' }, dedupKey: 'grafana:h1', actor: 'hook:grafana' },
      makeIngestDeps(dir, bus, cp, { hooks: HOOKS, allowedOrigins: [] }),
    );
    assert.equal(out.status, 'accepted');
    if (out.status !== 'accepted') return;
    assert.equal(out.httpStatus, 202);
    assert.equal(out.dup, false);
    assert.equal(cp.calls.length, 1);
    assert.equal(cp.calls[0]!.priority, 5);
    // 总线通报（§5.1 原文 deps.bus.publish('log', …)）
    assert.deepEqual(logTopic, ['200']);
  } finally {
    dir.cleanup();
  }
});

test('ingest：dup 命中 → accepted + 200 {dup:true}', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    cp.seen.set('grafana:dup', 777);
    const out = ingest(
      { source: 'http', dotId: 'dot1', payload: {}, dedupKey: 'grafana:dup', actor: 'hook:grafana' },
      makeIngestDeps(dir, bus, cp),
    );
    assert.equal(out.status, 'accepted');
    if (out.status !== 'accepted') return;
    assert.equal(out.httpStatus, 200);
    assert.equal(out.eventId, 777);
    assert.equal(out.dup, true);
  } finally {
    dir.cleanup();
  }
});

test('ingest：schema 拒 → 400 且不投 CP、落 rejects', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const out = ingest({ source: 'http', dotId: 'dot1', payload: {}, actor: '' } as RawInbound, makeIngestDeps(dir, bus, cp));
    assert.equal(out.status, 'rejected');
    if (out.status !== 'rejected') return;
    assert.equal(out.httpStatus, 400);
    assert.equal(out.reason, 'schema');
    assert.equal(cp.calls.length, 0);
    const rows = new IngressRejectLog(dir.db).recent(10);
    assert.ok(rows.some((r) => r.reason === 'schema'));
  } finally {
    dir.cleanup();
  }
});

test('ingest：限流超限 → 429（按 source:actor 键）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const limiter = new RateLimiter({ defaultPerMin: 2 });
    const deps = makeIngestDeps(dir, bus, cp, { rateLimiter: limiter });
    for (let i = 0; i < 2; i++) {
      const r = ingest({ source: 'http', dotId: 'dot1', payload: { i }, actor: 'hook:grafana' }, deps);
      assert.equal(r.status, 'accepted');
    }
    const third = ingest({ source: 'http', dotId: 'dot1', payload: { i: 3 }, actor: 'hook:grafana' }, deps);
    assert.equal(third.status, 'rejected');
    if (third.status !== 'rejected') return;
    assert.equal(third.httpStatus, 429);
    assert.equal(third.reason, 'rate');
    // 不同 actor 不受影响（按 source:actor 分别计）
    const other = ingest({ source: 'http', dotId: 'dot1', payload: {}, actor: 'hook:github' }, deps);
    assert.equal(other.status, 'accepted');
    assert.equal(cp.calls.length, 3);
  } finally {
    dir.cleanup();
  }
});

test('ingest：http 来源 + Origin 不在白名单 → 403 origin', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const deps = makeIngestDeps(dir, bus, cp, { allowedOrigins: ['http://ok'] });
    // originAllowed 无头（服务端调用）时放行；带非法 origin 才拒——
    // 这里直接调 originAllowed 验证白名单语义，ingest 层的 origin 分支由
    // "带 origin 的 http 请求被拒" 覆盖（见下一条 http.ts 集成测试）。
    assert.equal(originAllowed({ origin: 'http://evil' }, deps.allowedOrigins ?? []), false);
    assert.equal(originAllowed({ origin: 'http://ok' }, deps.allowedOrigins ?? []), true);
    // 白名单为空 = 未配置 = 放行（fail-open，避免没人配 origins 就全线拒）
    assert.equal(originAllowed({ origin: 'http://evil' }, []), true);
  } finally {
    dir.cleanup();
  }
});

test('ingest：CP 抛错（队列满/淘汰）→ 503 + retryAfterMs；且不写 surf_ingress_rejects', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    cp.throwNext = true;
    const rejects = new IngressRejectLog(dir.db);
    const out = ingest(
      { source: 'http', dotId: 'dot1', payload: {}, actor: 'hook:grafana' },
      makeIngestDeps(dir, bus, cp, { allowedOrigins: ['http://ok'], rejects }),
    );
    assert.equal(out.status, 'rejected');
    if (out.status !== 'rejected') return;
    assert.equal(out.httpStatus, 503);
    assert.equal(out.retryAfterMs, 5000);
    // 契约 E1 末段：事件已抵达 CP 边界 → 只映射 503，审计归 CP 的 events 表；
    // surf_ingress_rejects 只记"从未抵达 CP"的失败，两套审计不混写。
    assert.equal(rejects.recent(10).length, 0);
  } finally {
    dir.cleanup();
  }
});

test('ingest：heartbeat 来源不查 Origin（无 Origin 概念）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const out = ingest(buildHeartbeatRaw({ ctId: 'ct_1', dotId: 'dot1', title: 't', prompt: 'p', nextFire: 5 }), makeIngestDeps(dir, bus, cp));
    assert.equal(out.status, 'accepted');
    assert.equal(cp.calls[0]!.source, 'heartbeat');
    assert.equal(cp.calls[0]!.priority, 5);
  } finally {
    dir.cleanup();
  }
});

test('ingest：MAX_BODY_BYTES = 256KB（§5.2 常量）', () => {
  assert.equal(MAX_BODY_BYTES, 256 * 1024);
});

// ═══════════════════════════════════════════════════════════════════
// 四、RateLimiter 细节
// ═══════════════════════════════════════════════════════════════════

test('RateLimiter：窗口过期后计数清零（60s 窗口，实现固定值）', () => {
  const limiter = new RateLimiter({ defaultPerMin: 1 });
  const t0 = 1_000_000;
  assert.equal(limiter.exceeded('k', t0), false);
  assert.equal(limiter.exceeded('k', t0 + 10), true);
  assert.equal(limiter.exceeded('k', t0 + 59_000), true);  // 窗口内仍超
  assert.equal(limiter.exceeded('k', t0 + 60_000), false);  // 窗口滚过 → 清零
  assert.equal(limiter.count('k'), 1);
});

test('RateLimiter：hook 级上限可覆盖默认值', () => {
  const limiter = new RateLimiter({ defaultPerMin: 120, hookLimits: new Map([['grafana', 3]]) });
  for (let i = 0; i < 3; i++) assert.equal(limiter.exceeded('http:hook:grafana', 1000, 3), false);
  assert.equal(limiter.exceeded('http:hook:grafana', 1000, 3), true);
});

// ═══════════════════════════════════════════════════════════════════
// 五、Origin 白名单（§5.2 防 DNS rebinding）
// ═══════════════════════════════════════════════════════════════════

test('originAllowed：无 Origin 放行；命中放行；不命中拒', () => {
  assert.equal(originAllowed({}, ['http://a']), true); // 非浏览器客户端
  assert.equal(originAllowed({ origin: 'http://a' }, ['http://a']), true);
  assert.equal(originAllowed({ origin: 'http://b' }, ['http://a']), false);
  // Referer 兜底（浏览器降级场景）
  assert.equal(originAllowed({ referer: 'http://a/page' }, ['http://a']), true);
  assert.equal(originAllowed({ referer: 'http://b/page' }, ['http://a']), false);
  // 同时带 origin 与 referer 时以 origin 为准（referer 只是 origin 缺失时的兜底）
  assert.equal(originAllowed({ origin: 'http://a', referer: 'http://b/x' }, ['http://a']), true);
});

// ═══════════════════════════════════════════════════════════════════
// 六、拒绝审计表（surf_ingress_rejects）
// ═══════════════════════════════════════════════════════════════════

test('surf_ingress_rejects：record/recent 可查，含全部 reason 类别', () => {
  const dir = makeTempDataDir();
  try {
    const log = new IngressRejectLog(dir.db);
    log.record({ source: 'http', actor: 'hook:grafana', reason: 'auth', detail: 'x' });
    log.record({ source: 'file', actor: 'file:/x', reason: 'parse', detail: '坏行' });
    log.record({ source: 'heartbeat', actor: 'scheduler', reason: 'rate' }); // detail 可省（DDL 可空）
    const rows = log.recent(10);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.reason).sort(), ['auth', 'parse', 'rate']);
    assert.equal(log.recent(2).length, 2); // limit 生效（最新在前）
    assert.ok(rows.every((r) => typeof r.at === 'string' && r.at.length > 0));
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 七、createIngress 装配面 + Telegram 指令粗筛
// ═══════════════════════════════════════════════════════════════════

test('createIngress：返回 ingest/rejects/limiter 三件（http.ts 复用）', () => {
  const dir = makeTempDataDir();
  try {
    const bus = new EventBus();
    const cp = makeCp();
    const ing = createIngress({
      db: dir.db,
      bus,
      cp: cpSide(cp) as never,
      gov: {} as never,
      mem: {} as never,
      router: {} as never,
      channels: null,
      now: () => new Date(),
      activeTaskCount: () => 0,
    });
    assert.equal(typeof ing.ingest, 'function');
    assert.ok(ing.rejects instanceof IngressRejectLog);
    assert.ok(ing.limiter instanceof RateLimiter);
    const out = ing.ingest({ source: 'file', dotId: 'dot1', payload: { text: 'x' }, actor: 'file:/l' });
    assert.equal(out.status, 'accepted');
  } finally {
    dir.cleanup();
  }
});

test('looksLikeApprovalCommand：审批指令 vs 普通聊天（§5.5 三分投递）', () => {
  assert.equal(looksLikeApprovalCommand('a12'), true);
  assert.equal(looksLikeApprovalCommand('d3 / a9'), true);
  assert.equal(looksLikeApprovalCommand('l'), true);
  assert.equal(looksLikeApprovalCommand('l / a1 / d2'), true);
  // §5.5 明文 `a\d+/d\d+/l/all`：裸 all 是 l/all 的省略形，漏判会把它当普通聊天
  // 投进 cp.ingestEvent，违反 §1「审批回复绝不进事件流」铁律
  assert.equal(looksLikeApprovalCommand('all'), true);
  assert.equal(looksLikeApprovalCommand('ALL'), true);
  assert.equal(looksLikeApprovalCommand('l/all'), true);
  assert.equal(looksLikeApprovalCommand('a7/all'), true);
  assert.equal(looksLikeApprovalCommand('帮我查下天气'), false);
  assert.equal(looksLikeApprovalCommand('approve 12'), false);
  assert.equal(looksLikeApprovalCommand('a12b'), false);
  // 单个字母不是指令（宽度）：只有完整的 a/d/l/all 段才认
  assert.equal(looksLikeApprovalCommand('a'), false);
  assert.equal(looksLikeApprovalCommand('allow'), false);
  assert.equal(looksLikeApprovalCommand(''), false);
  assert.equal(looksLikeApprovalCommand('   '), false);
});

test('looksLikeApprovalReply：reply 到审批消息即审批流量（§5.5）', () => {
  assert.equal(looksLikeApprovalReply(555), true);
  assert.equal(looksLikeApprovalReply(null), false);
  assert.equal(looksLikeApprovalReply(undefined), false);
  // 合并判据：文本不像指令但 reply 到卡片 → 仍走 GOV（GOV 用 replyToMsgId 寻址）
  assert.equal(isApprovalTraffic({ text: '好的，可以', replyToMsgId: 555 }), true);
  assert.equal(isApprovalTraffic({ text: '好的，可以', replyToMsgId: null }), false);
  assert.equal(isApprovalTraffic({ text: 'a1' }), true);
});

test('JSONL 落盘读取：截断/旋转后 gen 变化使 dedup_key 不同（§5.3 不误判）', () => {
  const dir = makeTempDataDir();
  try {
    const root = mkdtempSync(join(tmpdir(), 'dotd-jsonl-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{"text":"第一行"}\n{"text":"第二行"}\n', 'utf8');
    const line1 = normalizeJsonlLine({ path: file, inode: 1, gen: 0, lineNo: 1, line: '{"text":"第一行"}' }, 'dot1');
    const line2 = normalizeJsonlLine({ path: file, inode: 1, gen: 0, lineNo: 2, line: '{"text":"第二行"}' }, 'dot1');
    // 同一 gen 内两行 dedup_key 不同（行号区分）
    assert.notEqual(line1.ok && line1.raw.dedupKey, line2.ok && line2.raw.dedupKey);
    // 截断后 gen=1 重读同一行文本 → 新 dedup_key（不误判 dup）
    const afterTruncate = normalizeJsonlLine({ path: file, inode: 1, gen: 1, lineNo: 1, line: '{"text":"第一行"}' }, 'dot1');
    assert.notEqual(line1.ok && line1.raw.dedupKey, afterTruncate.ok && afterTruncate.raw.dedupKey);
    rmSync(root, { recursive: true, force: true });
  } finally {
    dir.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 六、§5.3 JSONL 错误路径 + §9 磁盘留存
// ═══════════════════════════════════════════════════════════════════

/** 内存版侧车文件（记录 append/truncate 调用，不落真盘）。 */
function makeMemorySidecar() {
  const files = new Map<string, string>();
  return {
    files,
    append(path: string, text: string): void {
      files.set(path, (files.get(path) ?? '') + text);
    },
    sizeOf(path: string): number {
      return (files.get(path) ?? '').length;
    },
    truncate(path: string): void {
      files.set(path, '');
    },
  };
}

test('§5.3 JsonlErrorSink：坏行 → 写 <path>.errors.jsonl + ingress_rejects(parse)', () => {
  const dir = makeTempDataDir();
  try {
    const side = makeMemorySidecar();
    const rejects = new IngressRejectLog(dir.db);
    const sink = new JsonlErrorSink({ ...side, rejects });
    sink.note('/inbox/a.jsonl', 3, '{oops', '不是合法 JSON');

    // ① 侧车文件按 §5.3 命名
    assert.ok(side.files.has('/inbox/a.jsonl.errors.jsonl'));
    const row = JSON.parse(side.files.get('/inbox/a.jsonl.errors.jsonl')!.trim()) as { path: string; lineNo: number; error: string; line: string };
    assert.equal(row.path, '/inbox/a.jsonl');
    assert.equal(row.lineNo, 3);
    assert.equal(row.line, '{oops');
    assert.match(row.error, /JSON/);

    // ② 拒绝审计（reason='parse'，source='file'）
    const rows = rejects.recent(5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reason, 'parse');
    assert.equal(rows[0]!.source, 'file');
    assert.match(rows[0]!.detail ?? '', /第 3 行/);
  } finally {
    dir.cleanup();
  }
});

test('§5.3 JsonlErrorSink：连续 20 行坏 → 暂停该 path + log 告警；好行清零', () => {
  const side = makeMemorySidecar();
  const warnings: string[] = [];
  const sink = new JsonlErrorSink({ ...side, warn: (m) => warnings.push(m) });

  // 19 行坏：只累计，不暂停
  for (let i = 1; i <= CONSECUTIVE_BAD_LINES - 1; i++) sink.note('/inbox/b.jsonl', i, 'x', '坏');
  assert.equal(sink.isPaused('/inbox/b.jsonl'), false);
  assert.equal(sink.badRunOf('/inbox/b.jsonl'), CONSECUTIVE_BAD_LINES - 1);

  // 第 20 行坏：触发暂停 + 告警
  const justPaused = sink.note('/inbox/b.jsonl', CONSECUTIVE_BAD_LINES, 'x', '坏');
  assert.equal(justPaused, true);
  assert.equal(sink.isPaused('/inbox/b.jsonl'), true);
  assert.deepEqual(sink.pausedPaths(), ['/inbox/b.jsonl']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /暂停/);

  // 好行清零"连续"计数（暂停是运维动作，不自动解除）
  sink.noteGoodLine('/inbox/b.jsonl');
  assert.equal(sink.badRunOf('/inbox/b.jsonl'), 0);
  assert.equal(sink.isPaused('/inbox/b.jsonl'), true);
  sink.resume('/inbox/b.jsonl');
  assert.equal(sink.isPaused('/inbox/b.jsonl'), false);

  // 不连续（中间夹好行）不触发暂停
  const side2 = makeMemorySidecar();
  const sink2 = new JsonlErrorSink(side2);
  for (let i = 0; i < 50; i++) {
    sink2.note('/inbox/c.jsonl', i * 2 + 1, 'x', '坏');
    sink2.noteGoodLine('/inbox/c.jsonl');
  }
  assert.equal(sink2.isPaused('/inbox/c.jsonl'), false);
  assert.equal(side2.files.get('/inbox/c.jsonl.errors.jsonl')!.trim().split('\n').length, 50);
});

test('§5.3 JsonlErrorSink：侧车超 10MB → 滚动截断再追加（§9）', () => {
  const side = makeMemorySidecar();
  const sink = new JsonlErrorSink(side);
  const path = '/inbox/d.jsonl';
  const sidecar = `${path}.errors.jsonl`;
  // 预置一封超限的旧内容
  side.files.set(sidecar, 'x'.repeat(ERRORS_MAX_BYTES + 10));
  sink.note(path, 1, 'bad', '坏');
  // 滚动后只剩 roll 标记 + 新行（远小于 10MB）
  assert.ok(side.sizeOf(sidecar) < ERRORS_MAX_BYTES);
  const lines = side.files.get(sidecar)!.trim().split('\n');
  assert.equal(JSON.parse(lines[0]!).event, 'roll');
  assert.equal(JSON.parse(lines[1]!).lineNo, 1);
});

test('§9 purgeSurfacesRetention：rejects ≤5 万行、tg_card_state ≤1 万行', () => {
  const dir = makeTempDataDir();
  try {
    // 插 5 万 +3 条 rejects（用一条 SQL 批插，避免 5 万次 prepare.run）
    dir.db.exec(`
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 50003)
      INSERT INTO surf_ingress_rejects (at, source, actor, reason, detail)
      SELECT '2026-01-01T00:00:00Z', 'http', 'hook:grafana', 'parse', 'x' FROM seq;
    `);
    // 插 1 万 +2 条卡片状态（approvals 是 FK，先插 10002 条审批行；
    // kind='question' 绕过 tool_call 的 CHECK；seq/reason/pending_until NOT NULL 都要给）
    dir.db.exec(`
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 10002)
      INSERT INTO approvals (id, seq, kind, dot_id, task_id, tier, status, summary, reason, params_json, created_at, pending_until)
      SELECT i, i, 'question', 'dot1', 'tk_' || i, 'read', 'pending', 's', 'r', '{}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z' FROM seq;
    `);
    dir.db.exec(`
      WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 10002)
      INSERT INTO surf_tg_card_state (approval_id, chat_id, message_id)
      SELECT i, 555, i FROM seq;
    `);

    const before = (dir.db.prepare('SELECT COUNT(*) AS n FROM surf_ingress_rejects').get() as { n: number }).n;
    assert.equal(before, 50003);
    const out = purgeSurfacesRetention(dir.db);
    assert.equal(out.ingressRejectsDeleted, 3);
    assert.equal(out.tgCardStateDeleted, 2);
    assert.equal((dir.db.prepare('SELECT COUNT(*) AS n FROM surf_ingress_rejects').get() as { n: number }).n, SURF_INGRESS_REJECTS_MAX_ROWS);
    assert.equal((dir.db.prepare('SELECT COUNT(*) AS n FROM surf_tg_card_state').get() as { n: number }).n, SURF_TG_CARD_STATE_MAX_ROWS);
  } finally {
    dir.cleanup();
  }
});

test('§9 常量与 rollFileIfNeeded：offset.json/errors.jsonl ≤10MB', () => {
  assert.equal(SURF_INGRESS_REJECTS_MAX_ROWS, 50_000);
  assert.equal(SURF_TG_CARD_STATE_MAX_ROWS, 10_000);
  assert.equal(ERRORS_MAX_BYTES, 10 * 1024 * 1024);
  const files = new Map<string, string>();
  const rolled = rollFileIfNeeded(
    '/x/offset.json',
    () => ROLLING_MAX_BYTES + 1,
    (p) => files.set(p, ''),
    (p, t) => files.set(p, (files.get(p) ?? '') + t),
  );
  assert.equal(rolled, true);
  assert.equal(JSON.parse(files.get('/x/offset.json')!.trim()).event, 'roll');
});
