/**
 * tests/progress.test.ts —— T5 过程可视化（2026-10-20）
 *
 * 重点盯三件事：
 *   1. 默认必须**关**（升级后不会突然开始刷屏）
 *   2. 节流双阈值（步数 + 时间）都要真的生效 —— 只查一个就会刷屏或从不说话
 *   3. "需要人介入"必须**突破节流**（这种消息漏掉比多推一条糟得多）
 */
import { decideProgress, decideScreen, humanizeTool, DEFAULT_PROGRESS } from '../src/surfaces/progress.ts';
import { screenOf } from '../src/surfaces/progress-push.ts';
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
  const d = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 3 }), ON);
  ok('第一次会推', d.push === true && d.reason === 'start');
  if (d.push) ok('  文案带任务标题', d.text.includes('整理上周的销售数据'));

  // 2026-10-23：开始的那条别在第 1 步就说。
  // 实测（台账 2026-10-23 01:00:02）主人刚发完消息 1 秒就收到
  //   **正在做**：早间日程提醒 / 现在：在思考 / 已经 1 步
  // —— 他自己知道自己发了。而且这条一推就占住 90 秒时间窗，
  // 反而把第 1 分钟里的真实进展挤掉。门槛与 everyNSteps 对齐。
  const at1 = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 1 }), ON);
  ok('第 1 步不说话（「在思考」没信息量）', at1.push === false && at1.reason === 'nothing_to_say');
  const at2 = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 2 }), ON);
  ok('第 2 步也还早', at2.push === false && at2.reason === 'nothing_to_say');
  const at3 = decideProgress(mk({ lastPushAt: null, lastPushStep: null, stepCount: 3 }), ON);
  ok('走到第 3 步才说第一句', at3.push === true && at3.reason === 'start');
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
    mk({ needsAttention: true, lastPushAt: NOW - 200_000, lastPushStep: 5, stepCount: 5 }),
    ON,
  );
  ok('需要关注时立刻推', d.push === true && d.reason === 'attention');
  if (d.push) {
    ok('  文案说"需要你看一下"', d.text.includes('需要你看一下'));
    ok('  文案指出详情在哪', d.text.includes('/tasks'));
  }

  // 2026-10-23（主人原话「飞书消息又变多了」）：attention 越过**步数**节流，
  // 但不再越过**时间**节流。原来「必推，不看节流」导致一次失败连推三条：
  // 实测 tk_mvk7ok90toir14，92 步任务发了 13 条进度，其中 9 条是 attention，
  // 而真实失败只有 3 次。
  const tooSoon = decideProgress(
    mk({ needsAttention: true, lastPushAt: NOW - 1_000, lastPushStep: 5, stepCount: 5 }),
    ON,
  );
  ok('需要关注但刚推过 → 等一会儿再说', tooSoon.push === false && tooSoon.reason === 'too_soon');
  const firstEver = decideProgress(
    mk({ needsAttention: true, lastPushAt: null, lastPushStep: null, stepCount: 5 }),
    ON,
  );
  ok('从没推过时失败照旧立刻说', firstEver.push === true && firstEver.reason === 'attention');

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


// ── 10. 画面摘要（T5 判据的 browser.snapshot 那一半）──────────
{
  const openRes = JSON.stringify({ url: 'https://example.com/a/b?x=1', title: '示例站首页' });
  const a = screenOf('browser.open', openRes);
  ok('browser.open → 标题 + 域名', a === '示例站首页 — example.com', a ?? 'null');

  const actRes = JSON.stringify({ url: 'https://shop.example.org/cart', ok: true, action: 'click' });
  const b = screenOf('browser.act', actRes);
  ok('browser.act → 说在哪个站做了什么', b !== null && b.includes('shop.example.org'), b ?? 'null');

  // 结构化节点带 name 时优先报内容，比域名有用
  const snapRes = JSON.stringify({ url: 'https://x.com', tree: [{ role: 'heading', name: '登录' }] });
  const c = screenOf('browser.snapshot', snapRes);
  ok('snapshot 结构化节点抽出 name', c === '登录', c ?? 'null');

  // 真取不到任何可读内容时才退回域名 —— 至少主人知道它在看哪个站
  const emptyRes = JSON.stringify({ url: 'https://x.com', tree: [{ role: 'generic', children: [] }] });
  const c2 = screenOf('browser.snapshot', emptyRes);
  ok('snapshot 无可读内容时退回域名', c2 === 'x.com', c2 ?? 'null');

  // 深层嵌套也能挖到（递归 + 深度上限）
  const deepRes = JSON.stringify({
    url: 'https://x.com',
    tree: [{ role: 'document', children: [{ role: 'list', children: [{ role: 'listitem', name: '订单 #42' }] }] }],
  });
  const c3 = screenOf('browser.snapshot', deepRes);
  ok('snapshot 深层节点的 name 被挖到', c3 === '订单 #42', c3 ?? 'null');

  const ariaRes = JSON.stringify({ url: 'https://x.com', tree: '- heading "登录" [level=1]\n- button "提交"' });
  const d = screenOf('browser.snapshot', ariaRes);
  ok('aria 文本被抽成短语', d !== null && d.includes('登录') && d.includes('提交'), d ?? 'null');

  // 坏输入一律 null，不编
  ok('非 JSON 返回 null', screenOf('browser.open', 'not json') === null);
  ok('未知工具返回 null', screenOf('fs.read', openRes) === null);
  ok('无标题无域名返回 null', screenOf('browser.open', JSON.stringify({})) === null);

  // 超长要截断（飞书一屏）
  const long = screenOf('browser.open', JSON.stringify({ title: 'x'.repeat(500), url: 'https://a.b' }));
  ok('画面摘要被截到 200 内', long !== null && long.length <= 200, String(long?.length));
}

// ── 11. 文案里带页面 ─────────────────────────────────────────
{
  const d = decideProgress(mk({ lastPushStep: 5, stepCount: 10, screen: '示例站首页 — example.com' }), ON);
  ok('有画面时文案写"页面："', d.push && d.text.includes('页面：示例站首页'), d.push ? d.text : 'not pushed');

  const n = decideProgress(mk({ lastPushStep: 5, stepCount: 10, screen: null }), ON);
  ok('无画面时不写"页面："', n.push && !n.text.includes('页面：'));
}

// ── 9.1（2026-10-21）：进度要不要附真截图 ────────────────────────────────
//
// 这一组只测**判断**，不测 IO。真正取图/发图在 progress-push 的 sendShot 里，
// 那部分靠集成验证（读容器 home + 发飞书），单测拿 Buffer 假不出来。
console.log('');
console.log('  9.1 截图附带的去重与优先级');

// 没有图就是没有图，不该编一个出来
ok('无图 → 不带', decideScreen(null, null, false) === null);
ok('空串当无图', decideScreen('', null, false) === null);

// 第一次见到这张图 → 带
ok('首次出现 → 带', decideScreen('/dot/home/screenshots/a.png', null, false) === '/dot/home/screenshots/a.png');

// 同一张图已经发过 → 不重复发（否则连续两步推一模一样的图）
ok(
  '同上一条路径 → 不重复发',
  decideScreen('/dot/home/screenshots/a.png', '/dot/home/screenshots/a.png', false) === null,
);

// 换了新图 → 带
ok(
  '换了新图 → 带',
  decideScreen('/dot/home/screenshots/b.png', '/dot/home/screenshots/a.png', false) ===
    '/dot/home/screenshots/b.png',
);

// 需要人介入 → 即使重复也带（这是最该被看见的时刻，去重让位于可见性）
// 2026-10-21 改写：原来这条断言「attention 时重复也要发」。
// 实测推翻（任务 tk_mvi3nk51yqbp4d）：shot 推一次带图，紧接着 attention
// 又带同一张，相隔几秒，主人手机上是同一张图看两遍。
// 关键区分：attention 要保证的是**文字一定到达**（那在 decideProgress 层，
// 越过步数/时间节流），不是**图一定重发** —— 同一张 PNG 看第二遍没有新信息。
ok(
  'attention 时同一张图不重发',
  decideScreen('/dot/home/screenshots/a.png', '/dot/home/screenshots/a.png', true) === null,
);
// 但 attention 遇到**新图**仍要带（不能因为上一条是 attention 就把新图也吞了）
ok(
  'attention 时换了新图仍要带',
  decideScreen('/dot/home/screenshots/b.png', '/dot/home/screenshots/a.png', true) ===
    '/dot/home/screenshots/b.png',
);
// attention 且从没发过图 → 带
ok(
  'attention 时首次有图要带',
  decideScreen('/dot/home/screenshots/a.png', null, true) === '/dot/home/screenshots/a.png',
);

// attention 且无图 → 仍然不带（没有就是没有，不能拿别的东西冒充）
ok('attention 但无图 → 不带', decideScreen(null, '/dot/home/screenshots/a.png', true) === null);

console.log('\n  七、新截图越过节流（2026-10-21 主人选方案 1）\n');

{
  // 现场（实测 tk_mvi2ruzz4pd33b）：browser.screenshot 成功 2 次，
  // 但进度只在第 1 步 start 推过一次 —— 那时截图还没产生。
  // 按日常配置（3 步 / 90 秒），20 秒的任务永远轮不到"带图那一次"，
  // 截图功能等于白做。
  //
  // 所以：新截图越过步数与时间两道节流（但不越过 enabled 与去重）。
  const justPushed = {
    lastPushAt: 1_000_000,
    lastPushStep: 5,
    stepCount: 5, // 步数完全没涨
    now: 1_000_500, // 才过 0.5 秒
    needsAttention: false,
  };

  // 基线：没有新截图时，这个场景必须被节流掉（否则下面的对比无意义）
  const throttled = decideProgress(mk(justPushed), ON);
  ok('无新截图 → 步数不够，不推', throttled.push === false && throttled.reason === 'too_few_steps',
     JSON.stringify(throttled));

  // 有新截图 → 同一个场景必须推
  const withShot = decideProgress(mk({ ...justPushed, freshShot: true }), ON);
  ok('有新截图 → 越过步数节流直接推', withShot.push === true, JSON.stringify(withShot).slice(0, 80));
  ok('reason 标为 shot', withShot.push === true && withShot.reason === 'shot',
     withShot.push ? withShot.reason : 'not pushed');

  // 时间不够也一样要越过
  const timeThrottled = {
    lastPushAt: 2_000_000,
    lastPushStep: 1,
    stepCount: 99, // 步数早就够了
    now: 2_000_100, // 但只过了 0.1 秒
    needsAttention: false,
  };
  const base2 = decideProgress(mk(timeThrottled), ON);
  ok('无新截图 → 时间不够，不推', base2.push === false && base2.reason === 'too_soon', JSON.stringify(base2));
  const shot2 = decideProgress(mk({ ...timeThrottled, freshShot: true }), ON);
  ok('有新截图 → 越过时间节流直接推', shot2.push === true);

  // 但 enabled=false 仍然优先：开关关着就是不发，截图也不例外
  const off = decideProgress(mk({ ...justPushed, freshShot: true }), { ...DEFAULT_PROGRESS, enabled: false });
  ok('开关关着 → 新截图也不推', off.push === false && off.reason === 'disabled', JSON.stringify(off));

  // freshShot 缺省不能改变旧行为
  const noFlag = decideProgress(mk(justPushed), ON);
  ok('freshShot 缺省 = 旧行为不变', noFlag.push === false);
}

console.log('\n  合计 ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
