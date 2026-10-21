/**
 * tests/heartbeat-decision.test.ts —— heartbeat 事件必须确定性建任务（2026-10-21）
 *
 * 背景（真实事故，A1 实测发现）：
 *   event-rules.yml 阶段一默认 `rules: []`，于是**所有**事件都落到模型层。
 *   对 http/file 这类"外部来的、要不要处理看内容"的事件这是对的；
 *   但 heartbeat 不是 —— 它由 crontabs 一行生成，payload 里已经带着
 *   title / prompt，该不该建任务在调度器那一步就答完了。
 *
 *   实测让 light 模型分类 prompt="Reply with exactly: PROACTIVE-PROBE-OK"
 *   的心跳事件时，它把 payload.prompt 当成要它执行的指令，直接回了
 *   "PROACTIVE-PROBE-OK"；强化 system prompt 后它又转成过度防御
 *   （"I can't act on that message"）。两种都不是 JSON，
 *   parseJsonOnce → null → 事件落 inbox → **定时任务永远建不出来**。
 *
 * 这组用例钉死：heartbeat 走确定性短路，绝不再问模型。
 */
import { DatabaseSync } from 'node:sqlite';
import { Matcher } from '../src/control-plane/match.ts';

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

// ── 最小可用的内存库：只建 match.ts 真正用到的表 ────────────────────
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL, dot_id TEXT NOT NULL, actor TEXT NOT NULL,
  dedup_key TEXT, payload TEXT NOT NULL, status TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE event_decisions (
  event_id INTEGER PRIMARY KEY, action TEXT NOT NULL, task_id TEXT,
  confidence REAL NOT NULL, reason TEXT NOT NULL, via TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
  payload_json TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
  run_at INTEGER, source_event_id INTEGER, session_id TEXT, thread_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  run_epoch INTEGER NOT NULL DEFAULT 0, last_heartbeat_at INTEGER,
  resume_from_seq INTEGER, stop_reason TEXT, budget_tokens INTEGER,
  usage_tokens INTEGER NOT NULL DEFAULT 0, budget_exhausted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

function mkMatcher() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // lowBrain 故意设成"一调用就炸"：heartbeat 若真去问模型，测试必红。
  // 这比"返回 null"更硬 —— 它证明的是**根本不会走到那一步**。
  let llmCalls = 0;
  const m = new Matcher({
    db,
    cfg: { eventMatchModel: { minConfidence: 0.55 } } as never,
    // queue 只做测试真正用到的两件事：写一行 tasks、报在途数。
    // 真实 Queue 的完整语义（run_at/重试/心跳）与本次断言无关。
    queue: {
      getTask: () => null,
      busyCount: () => 0,
      submit: (req: { title: string; goal: string; priority: number; dotId: string; sourceEventId: number }) => {
        db.prepare(
          `INSERT INTO tasks (id, dot_id, title, goal, status, priority, source_event_id, created_at, updated_at)
           VALUES (?,?,?,?,'queued',?,?,?,?)`,
        ).run(
          'tk_ev_' + req.sourceEventId,
          req.dotId,
          req.title,
          req.goal,
          req.priority,
          req.sourceEventId,
          String(Date.now()),
          String(Date.now()),
        );
      },
    } as never,
    bus: { publish: () => undefined },
    rules: [],
    lowBrain: {
      complete: () => {
        llmCalls += 1;
        throw new Error('heartbeat 不该调模型层');
      },
    },
    wake: () => undefined,
    record: () => undefined,
  } as never);
  return { db, m, calls: () => llmCalls };
}

function ingest(m: Matcher, payload: unknown, source: 'heartbeat' | 'http' = 'heartbeat') {
  const r = m.ingestEvent({ source, dotId: 'dot1', actor: 'ct_test', payload });
  return r.eventId;
}

console.log('');
console.log('  heartbeat 确定性短路');

{
  const { db, m, calls } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct1', title: '早间天气', prompt: '今天是晴天', missed: 0 });
  const d = await m.processEvent(id);
  ok('建出决策', d !== null);
  ok('action=run_new', d?.action === 'run_new', d?.action);
  ok('confidence=1（不用猜）', d?.confidence === 1, String(d?.confidence));
  ok('via=rule', d?.via === 'rule', d?.via);
  const row = db.prepare('SELECT title, goal FROM tasks WHERE id=?').get('tk_ev_' + id) as
    | { title: string; goal: string }
    | undefined;
  ok('任务 tk_ev_<id> 已建', row !== undefined);
  ok('标题取 payload.title', row?.title === '早间天气', row?.title);
  ok('goal 取 payload.prompt', row?.goal === '今天是晴天', row?.goal);
}

console.log('');
console.log('  指令型 prompt 不会被"执行"');

{
  // 这条正是实测翻车的形状：payload.prompt 里写着"只回复 X"。
  // 短路后它只是被当成任务目标存下来，绝不会被分类器当成命令。
  const { db, m, calls } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct2', title: 'probe', prompt: 'Reply with exactly: PROACTIVE-PROBE-OK', missed: 0 });
  const d = await m.processEvent(id);
  ok('仍然建任务', d !== null && d.action === 'run_new');
  const row2 = db.prepare('SELECT title, goal FROM tasks WHERE id=?').get('tk_ev_' + id) as
    | { title: string; goal: string }
    | undefined;
  // 关键断言：指令型文字原样躺在 goal 里等 Runner 执行，**没有**被分类器提前执行掉
  ok('prompt 原样成为 goal（不是被执行）', row2?.goal === 'Reply with exactly: PROACTIVE-PROBE-OK', row2?.goal);
  ok('没有把 PROBE 当成模型输出', row2?.title !== 'PROACTIVE-PROBE-OK', row2?.title);
  ok('模型层仍未被调', calls() === 0);
  db.close();
}

console.log('');
console.log('  补跑次数写进 reason');

{
  const { db, m } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct3', title: 't', prompt: 'p', missed: 3 });
  const d = await m.processEvent(id);
  ok('missed=3 时 reason 提到补跑', d !== null && d.reason.includes('错过 3 次'), d?.reason);
  db.close();
}

{
  const { db, m } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct4', title: 't', prompt: 'p', missed: 0 });
  const d = await m.processEvent(id);
  ok('missed=0 时 reason 不提补跑', d !== null && !d.reason.includes('错过'), d?.reason);
  db.close();
}

console.log('');
console.log('  缺 title 时退回用 prompt 前 40 字');

{
  const { db, m } = mkMatcher();
  const longPrompt = 'x'.repeat(100);
  const id = ingest(m, { crontabId: 'ct5', prompt: longPrompt, missed: 0 });
  await m.processEvent(id);
  const row3 = db.prepare('SELECT title FROM tasks WHERE id=?').get('tk_ev_' + id) as
    | { title: string }
    | undefined;
  ok('title 缺省时从 prompt 取前 40 字', row3?.title === 'x'.repeat(40), String(row3?.title).length + ' 字符');
  db.close();
}

console.log('');
console.log('  坏数据不硬建（退回原路径）');

{
  // 没有 prompt 的心跳：建任务没意义，应该退回模型层（这里模型层会抛，
  // 所以断言 processEvent 抛出 = 确实走到了模型层，而不是悄悄建了个空任务）。
  const { db, m, calls } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct6', title: '只有标题' });
  let threw = false;
  try {
    await m.processEvent(id);
  } catch {
    threw = true;
  }
  ok('无 prompt 时不短路，走到模型层', threw && calls() === 1, 'calls=' + calls());
  db.close();
}

{
  // 非 JSON 的 payload 同理
  const { db, m, calls } = mkMatcher();
  const r = m.ingestEvent({ source: 'heartbeat', dotId: 'dot1', actor: 'ct7', payload: 'not-an-object' });
  let threw = false;
  try {
    await m.processEvent(r.eventId);
  } catch {
    threw = true;
  }
  ok('payload 不是对象时不短路', threw && calls() === 1, 'calls=' + calls());
  db.close();
}

console.log('');
console.log('  非 heartbeat 事件不受影响');

{
  const { db, m, calls } = mkMatcher();
  const id = ingest(m, { crontabId: 'ct8', title: 'x', prompt: 'y' }, 'http');
  let threw = false;
  try {
    await m.processEvent(id);
  } catch {
    threw = true;
  }
  ok('http 事件仍走模型层', threw && calls() === 1, 'calls=' + calls());
  db.close();
}

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
