/**
 * tests/progress.test.ts —— T5 过程可视化（2026-10-20）
 *
 * 重点盯三件事：
 *   1. 默认必须**关**（升级后不会突然开始刷屏）
 *   2. 节流双阈值（步数 + 时间）都要真的生效 —— 只查一个就会刷屏或从不说话
 *   3. "需要人介入"必须**突破节流**（这种消息漏掉比多推一条糟得多）
 */
import { decideProgress, humanizeTool, DEFAULT_PROGRESS } from '../src/surfaces/progress.ts';
import type { ProgressInput } from '../src/surfaces/progress.ts';

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

const ON = { enabled: true, everyNSteps: 3, minIntervalMs: 90_000 };
const NOW = 1_760_000_000_000;

const mk = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  taskId: 'tk_1',
  title: '整理上周的销售数据',
  stepCount: 5,
  recentSteps: [
    { kind: 'tool', toolName: 'fs.read', status: 'succeeded' },
    { kind: 'llm', toolName: null, status: 'succeeded' },
  ],
  now: NOW,
  lastPushAt: NOW - 200_000,
  lastPushStep: 2,
  needsAttention: false,
  ...over,
});

// ── 1. 默认关 ──────────────────────────────────────────────────
{
  ok('默认 enabled = false', DEFAULT_PROGRESS.enabled === false);
  const d = decideProgress(mk(), DEFAULT_PROGRESS);
  ok('默认配置下不推', d.push === false && d.reason === 'disabled');
}

// ── 2. 首次推送 ────────────────────────────────────────────────
{
  const d = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 1 }), ON);
  ok('第一次会推', d.push === true && d.reason === 'start');
  if (d.push) ok('  文案带任务标题', d.text.includes('整理上周的销售数据'));

  const d0 = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 0 }), ON);
  ok('还没走步时不推', d0.push === false && d0.reason === 'nothing_to_say');
}

// ── 3. 步数阈值 ────────────────────────────────────────────────
{
  // 上次推到 5，现在 7 → 差 2，不够 3
  const d = decideProgress(mk({ lastPushStep: 5, stepCount: 7 }), ON);
  ok('步数不够时不推', d.push === false && d.reason === 'too_few_steps');

  // 差正好 3 → 够
  const d2 = decideProgress(mk({ lastPushStep: 5, stepCount: 8 }), ON);
  ok('步数刚好够时推', d2.push === true && d2.reason === 'interval');

  // 差 10 → 够
  const d3 = decideProgress(mk({ lastPushStep: 5, stepCount: 15 }), ON);
  ok('步数远超时推', d3.push === true);
}

// ── 4. 时间阈值 ────────────────────────────────────────────────
{
  // 步数够（差 5）但只过了 30 秒
  const d = decideProgress(mk({ lastPushStep: 5, stepCount: 10, lastPushAt: NOW - 30_000 }), ON);
  ok('时间不够时不推', d.push === false && d.reason === 'too_soon');

  // 过了 90 秒刚好
  const d2 = decideProgress(mk({ lastPushStep: 5, stepCount: 10, lastPushAt: NOW - 90_000 }), ON);
  ok('时间刚好够时推', d2.push === true);

  // 过了 5 分钟
  const d3 = decideProgress(mk({ lastPushStep: 5, stepCount: 10, lastPushAt: NOW - 300_000 }), ON);
  ok('时间充裕时推', d3.push === true);
}

// ── 5. 双阈值必须都满足（只查一个就会出问题）──────────────────
{
  // 步数够但时间不够 → 不推
  const a = decideProgress(mk({ lastPushStep: 0, stepCount: 50, lastPushAt: NOW - 1_000 }), ON);
  ok('步数够但时间不够 → 不推', a.push === false && a.reason === 'too_soon');

  // 时间够但步数不够 → 不推
  const b = decideProgress(mk({ lastPushStep: 10, stepCount: 11, lastPushAt: NOW - 3_600_000 }), ON);
  ok('时间够但步数不够 → 不推', b.push === false && b.reason === 'too_few_steps');
}

// ── 6. 需要人介入必须突破节流 ──────────────────────────────────
{
  const d = decideProgress(
    mk({ needsAttention: true, lastPushAt: NOW - 1_000, lastPushStep: 5, stepCount: 5 }),
    ON,
  );
  ok('需要关注时立刻推', d.push === true && d.reason === 'attention');
  if (d.push) {
    ok('  文案说"需要你看一下"', d.text.includes('需要你看一下'));
    ok('  文案指出详情在哪', d.text.includes('/tasks'));
  }

  // 连默认关都要让位于"需要人"吗？—— 不。开关是主人的最终决定。
  const off = decideProgress(mk({ needsAttention: true }), DEFAULT_PROGRESS);
  ok('开关关时连"需要关注"也不推', off.push === false && off.reason === 'disabled');
}

// ── 7. 工具名翻人话 ────────────────────────────────────────────
{
  ok('mail.send → 发邮件', humanizeTool('mail.send') === '发邮件');
  ok('shell.run → 跑命令', humanizeTool('shell.run') === '跑命令');
  ok('未登记的原样返回', humanizeTool('weird.tool') === 'weird.tool');
  ok('null → 思考中', humanizeTool(null) === '思考中');
  ok('空串 → 思考中', humanizeTool('') === '思考中');
}

// ── 8. 文案要短、要说人话 ─────────────────────────────────────
{
  const d = decideProgress(mk({ lastPushStep: 5, stepCount: 10 }), ON);
  if (d.push) {
    ok('文案不超过 8 行', d.text.split('\n').length <= 8, String(d.text.split('\n').length) + ' 行');
    ok('文案有步数', d.text.includes('步'));
    ok('文案把工具翻成人话', d.text.includes('读文件') && !d.text.includes('fs.read'));
    ok('不泄露参数', !d.text.includes('{'));
  } else {
    ok('文案不超过 8 行', false, '应该是 push');
    ok('文案有步数', false);
    ok('文案把工具翻成人话', false);
    ok('不泄露参数', false);
  }

  // 标题过长要截断
  const long = decideProgress(
    mk({ title: 'x'.repeat(200), lastPushStep: 5, stepCount: 10 }),
    ON,
  );
  if (long.push) ok('超长标题被截断', long.text.length < 400, String(long.text.length) + ' 字符');
  else ok('超长标题被截断', false);
}

// ── 9. 卡住的步骤要显式说"卡在" ───────────────────────────────
{
  const stuck = decideProgress(
    mk({
      lastPushStep: 5,
      stepCount: 10,
      recentSteps: [{ kind: 'tool', toolName: 'browser.open', status: 'failed' }],
    }),
    ON,
  );
  ok('失败步骤说"卡在"', stuck.push && stuck.text.includes('卡在'), stuck.push ? stuck.text.split('\n')[1] : '');
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);