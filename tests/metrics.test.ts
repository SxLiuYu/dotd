/**
 * tests/metrics.test.ts —— 可观测指标的硬判据（2026-10-27）。
 *
 * 要回答的问题：
 *   1. 三个维度的数字**是不是从真数据算出来的**（不是常量、不是猜的）；
 *   2. 边界情形有没有撒谎：没数据时是 null 还是 0？没基线时会不会假装有趋势？
 *   3. 采样落库之后，第二次采样能不能拿它当基线；
 *   4. 只读查询绝不写库（看指标不该改变指标）。
 *
 * 为什么不用「跑一次看输出对不对」的方式测：那样只能证明这次算对了，
 * 证明不了口径。这里每个用例都先**造一批已知数据**，再断言具体的数。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import {
  RUNAWAY_STEP_THRESHOLD,
  collectSample,
  collectSeries,
  persistSample,
  windowDays,
} from '../src/metrics/sample.ts';
import { fmtMs, fmtPct, headline, renderReport } from '../src/metrics/report.ts';
import { metricsView } from '../src/metrics/view.ts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0); // 固定时刻，窗口可复现

/** 造一个任务（终态可选）。 */
function seedTask(
  dir: ReturnType<typeof makeTempDataDir>,
  id: string,
  o: {
    status?: 'done' | 'failed' | 'cancelled' | 'running';
    createdAt: number;
    updatedAt: number;
    attempt?: number;
    stopReason?: string | null;
    threadId?: string | null;
  },
): void {
  dir.db
    .prepare(
      `INSERT INTO tasks (id, dot_id, title, goal, status, priority, attempt, created_at, updated_at, stop_reason, thread_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id, 'dot1', 't-' + id, 'goal', o.status ?? 'done', 5,
      o.attempt ?? 0, o.createdAt, o.updatedAt, o.stopReason ?? null, o.threadId ?? null,
    );
}

/** 造一步 journal 记录。 */
function seedStep(
  dir: ReturnType<typeof makeTempDataDir>,
  taskId: string,
  seq: number,
  o: { kind?: 'llm' | 'tool'; tool?: string | null; status?: string; at: number },
): void {
  dir.db
    .prepare(
      `INSERT INTO steps (task_id, seq, kind, status, call_id, tool_name, run_epoch, started_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(taskId, seq, o.kind ?? 'tool', o.status ?? 'succeeded',
         `call_${taskId}_${seq}`, o.tool ?? null, 1, o.at);
}

/** 造一次模型调用。 */
function seedModelCall(
  dir: ReturnType<typeof makeTempDataDir>,
  o: { track?: string; outcome?: string; latencyMs?: number | null; at: number },
): void {
  dir.db
    .prepare(
      `INSERT INTO model_call_log (attempt_id, attempt_seq, track, endpoint_id, model, outcome, latency_ms, ts)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(`att_${Math.random().toString(36).slice(2)}`, 1, o.track ?? 'primary', 'ep1', 'm1',
         o.outcome ?? 'ok', o.latencyMs ?? null, o.at);
}

/** 造一条审批审计（late_decision 用）。 */
function seedLateDecision(dir: ReturnType<typeof makeTempDataDir>, at: number): void {
  const iso = new Date(at).toISOString().slice(0, 19).replace('T', ' ');
  dir.db
    .prepare(
      `INSERT INTO audit_log (ts, actor, action, reason) VALUES (?,?,?,?)`,
    )
    .run(iso, 'owner', 'late_decision', '已被抢先');
}

test('反应速度：分位数从真实耗时算出，不是常量', () => {
  const dir = makeTempDataDir();
  try {
    // 五个任务，耗时 1s/2s/3s/4s/10s —— p50 应该是 3s，p95 应该接近 10s。
    // 窗口是 [from, to)，落点必须严格早于 NOW，否则会被边界切掉（这正是"没数据"的成因）。
    const durs = [1000, 2000, 3000, 4000, 10_000];
    durs.forEach((d, i) => {
      seedTask(dir, `tk_${i}`, { createdAt: NOW - 5000 - d, updatedAt: NOW - 5000 });
    });
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.speed.taskP50Ms, 3000, 'p50 必须是中位数，不是均值（均值是 4000）');
    assert.equal(s.speed.taskP95Ms, 10_000, 'p95 取最近秩，样本 5 个时落在最大值');
  } finally {
    dir.cleanup();
  }
});

test('反应速度：没有样本时给 null，不是 0（0ms 会被读成"极快"）', () => {
  const dir = makeTempDataDir();
  try {
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.speed.taskP50Ms, null);
    assert.equal(s.speed.taskP95Ms, null);
    assert.equal(s.speed.modelP50Ms, null);
    assert.equal(s.speed.modelP95Ms, null);
  } finally {
    dir.cleanup();
  }
});

test('反应速度：模型延迟只看 outcome=ok，失败的 26s 不能混进 p50', () => {
  const dir = makeTempDataDir();
  try {
    // 三次成功 1s，一次失败 26s（真实数据里 fail 的均值就是 26s）。
    seedModelCall(dir, { latencyMs: 1000, at: NOW - HOUR });
    seedModelCall(dir, { latencyMs: 1000, at: NOW - HOUR });
    seedModelCall(dir, { latencyMs: 1000, at: NOW - HOUR });
    seedModelCall(dir, { outcome: 'fail', latencyMs: 26_000, at: NOW - HOUR });
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.speed.modelP50Ms, 1000, '成功的 p50 不该被失败样本拉高');
    assert.equal(s.quality.modelCalls, 4, '失败调用仍要算进调用总数');
    assert.equal(s.quality.modelBad, 1);
  } finally {
    dir.cleanup();
  }
});

test('反应速度：语音反射没有观测点时如实留 null（不拿别的数凑）', () => {
  const dir = makeTempDataDir();
  try {
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.speed.reflexP50Ms, null);
    assert.equal(s.speed.reflexP95Ms, null);
    const text = renderReport(s);
    assert.ok(text.includes('缺观测点'), '报告必须写明缺观测点，不能默默空着');
  } finally {
    dir.cleanup();
  }
});

test('执行质量：一次跑通率不含重试过的任务（折腾三次最后成了不算一次跑通）', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'a', { status: 'done', attempt: 0, createdAt: NOW - 1000, updatedAt: NOW - 1 });
    seedTask(dir, 'b', { status: 'done', attempt: 2, createdAt: NOW - 1000, updatedAt: NOW - 1 });
    seedTask(dir, 'c', { status: 'failed', attempt: 3, createdAt: NOW - 1000, updatedAt: NOW - 1 });
    seedTask(dir, 'd', { status: 'cancelled', createdAt: NOW - 1000, updatedAt: NOW - 1 });
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.quality.done, 2);
    assert.equal(s.quality.failed, 1);
    assert.equal(s.quality.cancelled, 1);
    // 1 个一次跑通 / 4 个终态 = 0.25
    assert.equal(s.quality.firstTryRate, 0.25, '重试过的 b 不能算一次跑通');
  } finally {
    dir.cleanup();
  }
});

test('执行质量：工具失败率按 steps 算（治理 deny 的调用也算，它们最能说明问题）', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'tk', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    for (let i = 1; i <= 8; i++) {
      seedStep(dir, 'tk', i, { tool: 'fs.read', status: 'succeeded', at: NOW - HOUR });
    }
    for (let i = 9; i <= 10; i++) {
      seedStep(dir, 'tk', i, { tool: 'net.get', status: 'failed', at: NOW - HOUR });
    }
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.quality.toolCalls, 10);
    assert.equal(s.quality.toolErrors, 2);
    assert.equal(s.quality.toolErrRate, 0.2);
  } finally {
    dir.cleanup();
  }
});

test(`空转：单任务步数 ≥ ${RUNAWAY_STEP_THRESHOLD} 才算（本库 1457 个任务里只有 4 个到过）`, () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'normal', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    seedTask(dir, 'runner', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    for (let i = 1; i <= 10; i++) {
      seedStep(dir, 'normal', i, { at: NOW - HOUR });
    }
    for (let i = 1; i <= RUNAWAY_STEP_THRESHOLD + 5; i++) {
      seedStep(dir, 'runner', i, { at: NOW - HOUR });
    }
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.quality.runawayTasks, 1, '只有超阈值的那个算空转');
  } finally {
    dir.cleanup();
  }
});

test('执行质量：迟到裁决占比从审计算（高 = 同一件事被问了多遍）', () => {
  const dir = makeTempDataDir();
  try {
    for (let i = 0; i < 4; i++) {
      dir.db
        .prepare(`INSERT INTO approvals (seq, kind, dot_id, task_id, params_json, summary, reason, status, created_at, pending_until)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(
          i + 1, 'question', 'dot1', 'tk_x', '{}', 's', 'r', 'pending',
          new Date(NOW - HOUR).toISOString().slice(0, 19).replace('T', ' '),
          new Date(NOW + HOUR).toISOString().slice(0, 19).replace('T', ' '),
        );
    }
    seedLateDecision(dir, NOW - HOUR);
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.quality.approvalTotal, 4);
    assert.equal(s.quality.approvalLate, 1);
  } finally {
    dir.cleanup();
  }
});

test('自我进化：记忆存量是当前时点，增量按窗口切', () => {
  const dir = makeTempDataDir();
  try {
    dir.db
      .prepare(`INSERT INTO mem_threads (id,dot_id,channel,status,pinned,context_summary_upto_seq,last_active_at,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('thr_1', 'dot1', 'web', 'active', 0, 0, NOW, NOW);
    // 一个窗口内改的，一个更早的
    dir.db
      .prepare(`INSERT INTO mem_files_index (dot_id,path,area,size_bytes,mtime_ms) VALUES (?,?,?,?,?)`)
      .run('dot1', 'notes/new.md', 'notes', 10, NOW - HOUR);
    dir.db
      .prepare(`INSERT INTO mem_files_index (dot_id,path,area,size_bytes,mtime_ms) VALUES (?,?,?,?,?)`)
      .run('dot1', 'notes/old.md', 'notes', 10, NOW - 100 * HOUR);
    const s = collectSample({ db: dir.db }, windowDays(1, NOW), NOW);
    assert.equal(s.evolution.memThreads, 1);
    assert.equal(s.evolution.memFiles, 2, '存量是全部 2 个');
    assert.equal(s.evolution.memFilesNew, 1, '窗口内新增只算 1 个');
  } finally {
    dir.cleanup();
  }
});

test('自我进化：0 条授权规则必须说出来（那是"每次同类操作还会问一遍"）', () => {
  const dir = makeTempDataDir();
  try {
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    assert.equal(s.evolution.rulesActive, 0);
    const text = renderReport(s);
    assert.ok(text.includes('0 条'), '不能只在数字里躺着，要明说后果');
    assert.ok(text.includes('一次点头'), '要说清 0 条意味着什么');
  } finally {
    dir.cleanup();
  }
});

test('明细：按工具拆开，能看出是谁在拖后腿', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'tk', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    // 每个工具都要 ≥20 次调用才进「最差工具」榜（样本太小的比率没有意义）。
    for (let i = 1; i <= 20; i++) {
      seedStep(dir, 'tk', i, { tool: 'tool.list', status: i <= 2 ? 'failed' : 'succeeded', at: NOW - HOUR });
    }
    for (let i = 21; i <= 40; i++) {
      seedStep(dir, 'tk', i, { tool: 'net.get', status: i <= 34 ? 'failed' : 'succeeded', at: NOW - HOUR });
    }
    const series = collectSeries(dir.db, windowDays(7, NOW));
    const net = series.find((r) => r.dim === 'tool' && r.key === 'net.get');
    assert.ok(net !== undefined, '要有 net.get 这一行');
    assert.equal(net!.n, 20);
    assert.equal(net!.bad, 14);
    // 报告里的「最差工具」按失败率排序，net.get 70% 必须排在 tool.list 10% 前面。
    const text = renderReport(
      collectSample({ db: dir.db }, windowDays(7, NOW), NOW),
      { withDetail: true },
      series,
    );
    const iNet = text.indexOf('net.get');
    const iList = text.indexOf('tool.list');
    assert.ok(iNet > 0 && iList > 0, '两个都要出现');
    assert.ok(iNet < iList, '失败率高的排前面');
  } finally {
    dir.cleanup();
  }
});

test('明细：失败原因单独一维（同一个根因会让一批工具一起倒，只报工具名会带错方向）', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'tk', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    // 真实数据的样子：net.get 和 shell.run 的失败是同一个根因（容器 quarantined）
    const fail = (tool: string, code: string): string =>
      JSON.stringify({ code, message: '容器状态 quarantined 不可派发（需 ready）', retryable: true });
    dir.db
      .prepare(
        `INSERT INTO steps (task_id, seq, kind, status, call_id, tool_name, run_epoch, started_at, result_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('tk', 1, 'tool', 'failed', 'c1', 'net.get', 1, NOW - HOUR, fail('net.get', 'container_not_ready'));
    dir.db
      .prepare(
        `INSERT INTO steps (task_id, seq, kind, status, call_id, tool_name, run_epoch, started_at, result_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('tk', 2, 'tool', 'failed', 'c2', 'shell.run', 1, NOW - HOUR, fail('shell.run', 'container_not_ready'));
    dir.db
      .prepare(
        `INSERT INTO steps (task_id, seq, kind, status, call_id, tool_name, run_epoch, started_at, result_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('tk', 3, 'tool', 'failed', 'c3', 'fs.read', 1, NOW - HOUR,
        JSON.stringify({ code: 'not_found', message: '文件不存在：/dot/home/MEMORY.md' }));

    const series = collectSeries(dir.db, windowDays(7, NOW));
    const byCause = series.filter((r) => r.dim === 'tool_error');
    const top = byCause.sort((a, z) => z.n - a.n)[0];
    assert.equal(top?.key, 'container_not_ready');
    assert.equal(top?.n, 2, '两个不同工具、同一个原因，要合并成一条');

    const text = renderReport(
      collectSample({ db: dir.db }, windowDays(7, NOW), NOW),
      { withDetail: true },
      series,
    );
    assert.ok(text.includes('工具失败原因'), '报告要说清为什么失败');
    assert.ok(text.includes('container_not_ready'), '根因必须出现，不能只报工具名');
  } finally {
    dir.cleanup();
  }
});

test('落库：采样写进 metric_sample 与 metric_series，可复核', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'a', { createdAt: NOW - 1000, updatedAt: NOW - 1 });
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    const series = collectSeries(dir.db, windowDays(7, NOW));
    const id = persistSample(dir.db, s, series);
    const row = dir.db.prepare('SELECT * FROM metric_sample WHERE id=?').get(id) as Record<string, unknown>;
    assert.equal(Number(row['window_from']), NOW - 7 * 86_400_000, '窗口边角落库，任何人可按同参数重算');
    assert.equal(Number(row['tasks_done']), 1);
    assert.equal(Number(row['id']), id);
  } finally {
    dir.cleanup();
  }
});

test('基线：第二次采样能和第一次比，且第一次自己不会被当成基线', () => {
  const dir = makeTempDataDir();
  try {
    // 第一次：五个慢任务（10s），p50 = 10s
    for (let i = 0; i < 5; i++) {
      seedTask(dir, `slow_${i}`, { createdAt: NOW - 5000 - 10_000, updatedAt: NOW - 5000 });
    }
    // 固定时钟：窗口必须以 NOW 为终点，否则「7 天前到现在」跟着机器时间漂，
    // 造的数据会掉到窗口外，读出来是 null 而不是 10s。
    const clock = { db: dir.db, now: () => NOW };
    const first = metricsView(clock, { days: 7, sample: true });
    assert.equal(first.hasBaseline, false, '第一次还没有可比的基线');
    assert.equal(first.sample.speed.taskP50Ms, 10_000);

    // 数据变好：再塞七个快任务（1s），p50 落到 1s，比基线快一个数量级
    for (let i = 0; i < 7; i++) {
      seedTask(dir, `fast_${i}`, { createdAt: NOW - 5000 - 1000, updatedAt: NOW - 5000 });
    }
    const second = metricsView(clock, { days: 7 });
    assert.equal(second.hasBaseline, true, '第二次应能读到第一次的基线');
    assert.equal(second.sample.speed.taskP50Ms, 1000);
    assert.ok(second.text.includes('对比基线'), '文本里要出现对比');
    assert.ok(second.text.includes('改善'), '变快要说改善，不能只给个箭头');
  } finally {
    dir.cleanup();
  }
});

test('定时采样只落库、不动基线（基线是"改之前"的参照，不能被自动采样挪走）', () => {
  const dir = makeTempDataDir();
  try {
    seedTask(dir, 'slow', { createdAt: NOW - 5000 - 10_000, updatedAt: NOW - 5000 });
    const clock = { db: dir.db, now: () => NOW };

    // 主人刻意确认的基线
    const manual = metricsView(clock, { days: 7, sample: true });
    const before = dir.db.prepare('SELECT sample_id FROM metric_baseline ORDER BY id DESC LIMIT 1').get() as
      | { sample_id: number }
      | undefined;
    assert.equal(Number(before?.sample_id), manual.sampleId);

    // 自动采样（部署重启/6 小时一跳）
    const auto = metricsView(clock, { days: 7, sample: true, setBaseline: false });
    assert.ok(auto.sampleId !== null, '自动采样仍要落库，否则趋势是空的');
    const after = dir.db.prepare('SELECT sample_id FROM metric_baseline ORDER BY id DESC LIMIT 1').get() as
      | { sample_id: number }
      | undefined;
    assert.equal(Number(after?.sample_id), manual.sampleId, '基线必须还是主人确认的那一条');
    const baselineRows = dir.db.prepare('SELECT COUNT(*) AS n FROM metric_baseline').get() as
      | { n: number }
      | undefined;
    assert.equal(Number(baselineRows?.n ?? 0), 1, '自动采样不该新增基线行');
  } finally {
    dir.cleanup();
  }
});

test('只读：默认查询不写库（看指标这个动作不该改变指标）', () => {
  const dir = makeTempDataDir();
  try {
    metricsView({ db: dir.db }, { days: 7 });
    const n = dir.db.prepare('SELECT COUNT(*) AS n FROM metric_sample').get() as { n: number };
    assert.equal(n.n, 0, '没传 sample 就一行都不该写');
  } finally {
    dir.cleanup();
  }
});

test('采样表为空时 history 是空数组（不是崩、也不是造一条假的）', () => {
  const dir = makeTempDataDir();
  try {
    const v = metricsView({ db: dir.db }, { days: 7 });
    assert.deepEqual(v.history, []);
    assert.equal(v.sampleId, null);
  } finally {
    dir.cleanup();
  }
});

test('格式化：null 显示成破折号，不是 0 或 NaN', () => {
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtMs(500), '500ms');
  assert.equal(fmtMs(1500), '1.5s');
  assert.equal(fmtMs(120_000), '2min');
  assert.equal(fmtPct(0.194), '19.4%');
});

test('一句话结论：按"会不会影响信任"排序，不是按数字大小', () => {
  const dir = makeTempDataDir();
  try {
    // 造一个空转任务 + 一个工具失败率很高的场景
    seedTask(dir, 'runner', { createdAt: NOW - 5000, updatedAt: NOW - 1 });
    for (let i = 1; i <= RUNAWAY_STEP_THRESHOLD + 1; i++) {
      seedStep(dir, 'runner', i, { tool: 'net.get', status: 'failed', at: NOW - HOUR });
    }
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    const h = headline(s);
    assert.ok(h.includes('空转'), `空转必须出现在结论里：${h}`);
    assert.ok(h.includes('工具失败率'), `工具失败率也要出现：${h}`);
  } finally {
    dir.cleanup();
  }
});

test('一切正常时结论不报警（不能天天喊狼来了）', () => {
  const dir = makeTempDataDir();
  try {
    for (let i = 0; i < 10; i++) {
      seedTask(dir, `ok_${i}`, { createdAt: NOW - 1000, updatedAt: NOW - 1 });
    }
    for (let i = 1; i <= 20; i++) {
      seedStep(dir, 'ok_0', i, { tool: 'fs.read', status: 'succeeded', at: NOW - HOUR });
    }
    seedModelCall(dir, { latencyMs: 800, at: NOW - HOUR });
    const s = collectSample({ db: dir.db }, windowDays(7, NOW), NOW);
    const h = headline(s);
    assert.ok(h.includes('一切正常'), `正常时不该报警：${h}`);
  } finally {
    dir.cleanup();
  }
});
