/**
 * tests/progress-push.test.ts —— 进度推送的**边沿语义**回归（2026-10-23）
 *
 * 为什么单独建这个文件：
 *   原来只有 progress.test.ts 测纯判断函数 decideProgress，而这个文件负责接线
 *   （读 steps 表 → 算 needsAttention → 调 sender）。于是「一次失败引发连推」
 *   这种接线层缺陷没有任何测试能拦住 —— 主人原话「飞书消息又变多了」就是它的报警。
 *
 * 现场（daemon 日志，任务 tk_mvk7ok90toir14，92 步）：
 *   推了进度（attention，18 步）
 *   推了进度（attention，19 步）   ← 同一个失败，连推
 *   推了进度（attention，20 步）
 *   ...（17 次 too_soon）...
 *   推了进度（attention，46 步）   ← 第二次失败，又连推 3 条
 *   推了进度（attention，48 步）
 *   推了进度（attention，50 步）
 *   ...（13 次 too_soon）...
 *   推了进度（attention，79 步）   ← 第三次失败，又连推 3 条
 *   推了进度（attention，81 步）
 *   推了进度（attention，83 步）
 *   13 条进度消息里 9 条是 attention，而真实失败只有 3 次（seq 18/46/79）。
 *
 * 根因两层：
 *   ① needsAttention 是电平（最近 5 步里有 failed），不是边沿（新出了一个失败）；
 *   ② decideProgress 里 attention 不看任何节流。
 * 两层叠加 ⇒ 一次失败炸出 N 条。这里把两层都钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startProgressPush } from '../src/surfaces/progress-push.ts';

/** 最小 steps 表：只用得到 seq/kind/tool_name/status/result_json 五列。 */
function makeDb(): { db: DatabaseSync; addStep: (seq: number, status: string, tool?: string) => void; addTask: (id: string) => void } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, dot_id TEXT);`);
  db.exec(`
    CREATE TABLE steps (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      tool_name TEXT,
      status TEXT NOT NULL,
      result_json TEXT
    );
  `);
  db.exec(`
    CREATE TABLE surf_outbound_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      dedup_key TEXT,
      chat_id TEXT,
      ok INTEGER,
      error TEXT,
      text_preview TEXT,
      at TEXT
    );
  `);
  return {
    db,
    addTask: (id) => {
      db.prepare('INSERT OR REPLACE INTO tasks (id, title, dot_id) VALUES (?, ?, ?)').run(id, '测试任务', 'dot1');
    },
    addStep: (seq, status, tool) => {
      db.prepare(
        'INSERT INTO steps (task_id, seq, kind, tool_name, status, result_json) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('tk_t', seq, tool === undefined ? 'llm' : 'tool', tool ?? null, status, null);
    },
  };
}

/** 手动驱动总线：返回触发一个 exec.call.finished 的函数。 */
type Handler = (e: { payload: unknown }) => void | Promise<void>;
function makeBus() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(topic: string, h: Handler): () => void {
      const list = handlers.get(topic) ?? [];
      list.push(h);
      handlers.set(topic, list);
      return () => undefined;
    },
    async emit(topic: string, payload: unknown): Promise<void> {
      for (const h of handlers.get(topic) ?? []) await h({ payload });
    },
  };
}

test('一个失败只推一次，不是推一片（边沿而非电平）', async () => {
  const { db, addStep, addTask } = makeDb();
  addTask('tk_t');
  const bus = makeBus();
  const sent: string[] = [];
  let clock = 1_760_000_000_000;

  startProgressPush({
    db,
    bus,
    sender: {
      send: async (_chatId, text) => {
        sent.push(text);
        return { ok: true };
      },
    },
    chatId: 'oc_test',
    cfg: { enabled: true, everyNSteps: 3, minIntervalMs: 1 }, // 节流压到最小，只测边沿
    log: () => undefined,
    now: () => clock,
  });

  // 新门槛（2026-10-23）：走到第 everyNSteps 步才说第一句，「在思考」那种不算数。
  // 前两步必须完全安静 —— 这也是主人的噪音源之一。
  addStep(1, 'succeeded');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c1', status: 'ok' });
  assert.equal(sent.length, 0, '第 1 步不该说话');
  clock += 1000;
  addStep(2, 'succeeded');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c2', status: 'ok' });
  assert.equal(sent.length, 0, '第 2 步也不该说话');

  // 第 3 步 → 首推（start），lastPushAt 定下来
  clock += 1000;
  addStep(3, 'succeeded');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c3', status: 'ok' });
  assert.equal(sent.length, 1, '走到第 3 步该推一条 start');

  // 第 4 步失败 → 该推一条 attention
  clock += 1000;
  addStep(4, 'failed', 'shell.run');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c4', status: 'error' });
  assert.equal(sent.length, 2, '新失败该推一条 attention');

  // 第 5、6 步成功，但 recent 里仍能看到 seq=4 的 failed。
  // 这就是现场那个「连推」的条件 —— 现在必须安静。
  clock += 1000;
  addStep(5, 'succeeded', 'fs.read');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c5', status: 'ok' });
  clock += 1000;
  addStep(6, 'succeeded', 'fs.read');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c6', status: 'ok' });
  assert.equal(sent.length, 2, '同一个失败不该被报第二遍、第三遍');

  // 新的一次失败 → 又是一个新事件，该说
  clock += 1000;
  addStep(7, 'failed', 'shell.run');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'c7', status: 'error' });
  assert.equal(sent.length, 3, '换了新失败 seq 要再说一次');
});

test('同一个失败只报一次，即使中间隔了很多步', async () => {
  const { db, addStep, addTask } = makeDb();
  addTask('tk_t');
  const bus = makeBus();
  const sent: string[] = [];
  let clock = 1_760_000_000_000;
  startProgressPush({
    db,
    bus,
    sender: { send: async (_c, t) => { sent.push(t); return { ok: true }; } },
    chatId: 'oc_test',
    cfg: { enabled: true, everyNSteps: 1, minIntervalMs: 1 },
    log: () => undefined,
    now: () => clock,
  });

  addStep(1, 'failed', 'shell.run');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'a1', status: 'error' });
  // 第一次是 start（lastPushAt 为 null 时先判 start）—— 不管推的哪条，记下条数
  const base = sent.length;
  assert.ok(base >= 1, '第一次要有反应');

  // 走满 12 步都没再失败。recent 只保留 5 步，失败会滑出窗口；
  // 但即便它还在窗口内，也不该再推 attention。
  for (let seq = 2; seq <= 13; seq++) {
    clock += 1000;
    addStep(seq, 'succeeded', 'fs.read');
    await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'a' + seq, status: 'ok' });
  }
  const attentionTexts = sent.filter((t) => t.includes('需要你看一下'));
  assert.equal(attentionTexts.length, 1, '同一次失败只该出现一条 attention 文案');
});

test('进度文字落台账：progress_text', async () => {
  const { db, addStep, addTask } = makeDb();
  addTask('tk_t');
  const bus = makeBus();
  let clock = 1_760_000_000_000;
  startProgressPush({
    db,
    bus,
    sender: { send: async () => ({ ok: true }) },
    chatId: 'oc_test',
    cfg: { enabled: true, everyNSteps: 1, minIntervalMs: 1 },
    log: () => undefined,
    now: () => clock,
  });
  addStep(1, 'succeeded');
  await bus.emit('exec.call.finished', { taskId: 'tk_t', callId: 'z1', status: 'ok' });
  const rows = db
    .prepare("SELECT kind, ok, chat_id FROM surf_outbound_log WHERE kind = 'progress_text'")
    .all() as Array<{ kind: string; ok: number; chat_id: string }>;
  assert.equal(rows.length, 1, '推了文字就该有 progress_text 台账');
  assert.equal(rows[0]!.ok, 1);
  assert.equal(rows[0]!.chat_id, 'oc_test');
});
