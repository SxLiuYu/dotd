/**
 * tests/governance-ask-question.test.ts —— 模型主动向主人提问（`ask`）。
 *
 * 为什么需要这个文件（2026-10-22 第 7 轮）：
 *
 * `docs/gap-vs-muse-dots.md` §0.1 那张 Muse 逐项表里，「主动要信息（缺地址就问）」
 * 长期标着 ✅，证据写的是「`ask_user` 通道在（治理审批面 `/api/approvals`）」。
 * 那条证据是错的：审批面管的是「这个动作准不准做」，不是「这个信息你还没给」。
 * 工具面 46 个里没有一个是「问主人」，`suspend` 只表示等审批。
 *
 * 接线时又挖出一个更深的洞：`decide()` 原样回传发单时的参数，
 * **`note`（主人的回答）虽然写进库、进了 audit，却永远到不了执行方** ——
 * 因为 `claim()` 读的就是 `final_params_json`。于是 `/answer N <文本>` 等于空转。
 * 对工具调用类审批这多半是锦上添花，但 `ask` 的全部语义就是那句回答。
 *
 * 所以这两条断言缺一不可：
 *   1. `ask` 必须签出 `kind=question` 的单，而不是 tool_call；
 *   2. 主人的回答必须经 decide → claim 原样回到执行方手里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, decide, claim } from '../src/governance/gate.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGovFixture as rawFixture, ctxOf } from './governance-support.ts';
import { sweepTempPaths } from './helpers.ts';

test.after(() => { sweepTempPaths(); });

const HERE = dirname(fileURLToPath(import.meta.url));
/** 用仓库**真实** config/tools.yml。默认的 DEFAULT_TOOLS_YML 是给档位用例的最小夹具，
 *  里面没有 ask —— 拿它测白名单接线等于什么都没测（会一律得到「工具未登记」）。 */
const REAL_TOOLS_YML = readFileSync(join(HERE, '..', 'config', 'tools.yml'), 'utf8');
function makeGovFixture() {
  return rawFixture({ toolsYml: REAL_TOOLS_YML });
}

const CALL = {
  callId: 'call_ask_1',
  tool: 'ask',
  params: { question: '收件地址是哪里？', options: '公司|家里' },
};

test('缺参数时问主人：签的必须是 question 单，不是 tool_call', async () => {
  const fx = makeGovFixture();
  try {
    const d = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    assert.equal(d.kind, 'approve', 'ask 必须挂起等回答，不能直接放行');
    const row = fx.db.prepare('SELECT * FROM approvals WHERE id=?').get(
      (d as { approvalId: number }).approvalId,
    ) as Record<string, unknown>;
    assert.equal(row.kind, 'question', '必须是 question 单 —— 审批面不是提问面');
    assert.equal(row.tool, null, 'question 单不挂工具名（它不是工具审批）');
    assert.equal(row.tier, null, 'question 单没有档位（它不是写操作）');
    assert.match(String(row.reason), /收件地址/, '问题原文要进 reason，卡片上才看得见');
    const subject = JSON.parse(String(row.subject_json)) as {
      kind: string;
      prompt: string;
      options?: string[];
    };
    assert.equal(subject.kind, 'question');
    assert.equal(subject.prompt, '收件地址是哪里？');
    assert.deepEqual(subject.options, ['公司', '家里'], 'options 用竖线分隔，拆成候选');
  } finally {
    fx.cleanup();
  }
});

test('主人的回答必须真的回到执行方（note → final_params_json.ownerNote）', async () => {
  const fx = makeGovFixture();
  try {
    const d = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    const id = (d as { approvalId: number }).approvalId;
    // 主人回答（`/answer N 公司前台` 走的就是这条路径：approve_once + note）
    const res = await decide(id, 'web', 'approve_once', 'owner', '公司前台', fx.rt);
    assert.equal(res.ok, true);
    const claimed = await claim(id, fx.rt);
    assert.equal(claimed.ok, true, '回答落定后必须能认领');
    assert.equal(
      (claimed as { finalParams: Record<string, unknown> }).finalParams.ownerNote,
      '公司前台',
      '**这是本文件存在的理由**：原来 final_params_json 原样等于发单参数，' +
        '主人写下的回答就此蒸发，模型问了个寂寞',
    );
    // 原参数不能被 note 顶掉
    assert.equal(
      (claimed as { finalParams: Record<string, unknown> }).finalParams.question,
      '收件地址是哪里？',
      'note 是附加信息，不能覆盖工具本来要的参数',
    );
  } finally {
    fx.cleanup();
  }
});

test('没有 note 时不许凭空造一个 ownerNote', async () => {
  const fx = makeGovFixture();
  try {
    const d = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    const id = (d as { approvalId: number }).approvalId;
    await decide(id, 'web', 'approve_once', 'owner', undefined, fx.rt);
    const claimed = await claim(id, fx.rt);
    assert.equal(
      (claimed as { finalParams: Record<string, unknown> }).finalParams.ownerNote,
      undefined,
      '没回答就是没回答 —— 造一个空串会让下游分不清"主人留空"和"没人答"',
    );
  } finally {
    fx.cleanup();
  }
});

test('question 为空要拒绝：问了个寂寞比不问更糟', async () => {
  const fx = makeGovFixture();
  try {
    const d = await evaluate(ctxOf(), {
      callId: 'call_ask_empty',
      tool: 'ask',
      params: { question: '   ' },
    } as never, {}, fx.rt);
    assert.equal(d.kind, 'deny');
    assert.match((d as { reason: string }).reason, /question 不能为空/);
  } finally {
    fx.cleanup();
  }
});

// ── 同一个问题不许反复开单（2026-10-27 主人报「为什么一个问题要发很多选项卡」）──
//
// 现场 tk_mvq33ahrc52fo1：steps 是 ask → 回答 → ask → 回答，同一个题干同一组选项，
// 17 秒一轮连问 5 次，每次都新签一张审批单（seq 174…178）并推一张卡片。
// 主人那边看到的就是同一张选项卡反复冒出来。

test('同一个问题已得到回答时不再开第二张单，且回答原文回喂给模型', async () => {
  const fx = makeGovFixture();
  try {
    const d1 = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    assert.equal(d1.kind, 'approve');
    const id1 = (d1 as { approvalId: number }).approvalId;
    await decide(id1, 'web', 'approve_once', 'owner', '公司前台', fx.rt);

    // 模型又问一遍同样的问题（换了个 callId，参数一字不差）
    const d2 = await evaluate(
      ctxOf(),
      { callId: 'call_ask_2', tool: 'ask', params: { question: '收件地址是哪里？', options: '公司|家里' } } as never,
      {},
      fx.rt,
    );
    assert.equal(d2.kind, 'deny', '已经答过就别再开单');
    const reason = (d2 as { reason: string }).reason;
    assert.match(reason, /已经问过并得到回答/, reason);
    assert.ok(reason.includes('公司前台'), `回答原文必须回喂给模型：${reason}`);
    assert.ok(reason.includes(String(id1)), '要写明是哪张单，便于事后核对');
    const n = fx.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='question'").get() as { n: number };
    assert.equal(n.n, 1, '不能有第二张 question 单');
  } finally {
    fx.cleanup();
  }
});

test('上一张还在等答时不许再开单（否则同一问题挂两处）', async () => {
  const fx = makeGovFixture();
  try {
    const d1 = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    assert.equal(d1.kind, 'approve');
    const id1 = (d1 as { approvalId: number }).approvalId;

    const d2 = await evaluate(
      ctxOf(),
      { callId: 'call_ask_2', tool: 'ask', params: { question: '收件地址是哪里？', options: '公司|家里' } } as never,
      {},
      fx.rt,
    );
    assert.equal(d2.kind, 'deny');
    assert.match((d2 as { reason: string }).reason, /已经在等回答/);
    assert.ok((d2 as { reason: string }).reason.includes(String(id1)));
    const n = fx.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='question'").get() as { n: number };
    assert.equal(n.n, 1, 'pending 的那张就是唯一一张');
  } finally {
    fx.cleanup();
  }
});

test('同一任务里问不同的问题是允许的（拦的是重复，不是提问）', async () => {
  const fx = makeGovFixture();
  try {
    const d1 = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    const id1 = (d1 as { approvalId: number }).approvalId;
    await decide(id1, 'web', 'approve_once', 'owner', '公司前台', fx.rt);

    const d2 = await evaluate(
      ctxOf(),
      { callId: 'call_ask_2', tool: 'ask', params: { question: '收件人写谁？', options: '张三|李四' } } as never,
      {},
      fx.rt,
    );
    assert.equal(d2.kind, 'approve', '换个问题当然要继续问 —— 拦的是重复，不是提问本身');
    const n = fx.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind='question'").get() as { n: number };
    assert.equal(n.n, 2);
  } finally {
    fx.cleanup();
  }
});

test('不同任务问同一个问题互不影响（去重范围是本任务）', async () => {
  const fx = makeGovFixture();
  try {
    const d1 = await evaluate(ctxOf(), CALL as never, {}, fx.rt);
    const id1 = (d1 as { approvalId: number }).approvalId;
    await decide(id1, 'web', 'approve_once', 'owner', '公司前台', fx.rt);

    const other = { ...ctxOf(), taskRef: { taskId: 'tk_other', journalStepId: 'st_other' } };
    // 不同任务用不同 callId：subject_key 是 `ask:<callId>`，真实运行时 callId 是 ULID。
    // 这里复用一个会撞 uniq_open_subject —— 那是索引在管「同一调用只开一张单」，
    // 与「同任务重复提问」是两件事，别混在一起测。
    const d2 = await evaluate(
      other,
      { callId: 'call_ask_other_task', tool: 'ask', params: { question: '收件地址是哪里？', options: '公司|家里' } } as never,
      {},
      fx.rt,
    );
    assert.equal(d2.kind, 'approve', '另一个任务的问题不该被这个任务的回答挡掉');
  } finally {
    fx.cleanup();
  }
});
