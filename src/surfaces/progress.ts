/**
 * src/surfaces/progress.ts —— 任务过程可视化（T5，2026-10-20）
 *
 * 要解决什么问题
 *   一个跑 10 分钟的任务，主人在飞书那边**什么都看不到**。问"在干嘛"没反应，
 *   于是只能等 —— 而等待和"卡死了"在他眼里是一样的。
 *   Muse 的报道里，记者反复提到"能看着它在做事"这件事让人放心。
 *
 * 数据早就有了，缺的是"说给人听"
 *   `steps` 表记每一步（llm/tool + 状态 + 工具名），
 *   `exec.call.started` / `exec.call.finished` 也在总线上。
 *   所以这个文件不采集任何新数据 —— 它只做两件事：
 *     ① 决定**什么时候**值得打扰主人（节流）
 *     ② 把步骤翻译成**人话**（"正在发邮件"而不是 "mail.send"）
 *
 * 为什么不每一步都推
 *   一个任务可能有 30 步。30 条消息会把飞书刷屏，然后主人关通知 ——
 *   比不推更糟。所以按"步数间隔 + 时间间隔"双阈值，且只在**有意义的转折点**推：
 *   开始、换工具、出错、结束。
 *
 * 为什么不推每一步的工具参数
 *   参数里可能有密钥、路径、长文本。摘要只说"在做什么"，
 *   细节留给任务结束的完整回复和 /tasks/:id。
 */

/** 进度汇报的配置。默认值刻意保守 —— 宁愿少推，不要刷屏。 */
export interface ProgressConfig {
  /** 至少隔几步才推一次。默认 3。 */
  everyNSteps: number;
  /** 至少隔多少毫秒才推一次。默认 90 秒。 */
  minIntervalMs: number;
  /** 总开关。默认关 —— 升级后不会突然开始给主人发进度。 */
  enabled: boolean;
}

export const DEFAULT_PROGRESS: ProgressConfig = {
  everyNSteps: 3,
  minIntervalMs: 90_000,
  enabled: false,
};

/** 一次进度汇报需要的信息。 */
export interface ProgressInput {
  taskId: string;
  /** 任务标题（人话），用于第一行。 */
  title: string;
  /** 已完成的步骤数。 */
  stepCount: number;
  /** 最近几步的记录，新的在前。 */
  recentSteps: Array<{ kind: 'llm' | 'tool'; toolName: string | null; status: string }>;
  /** 当前时刻（epoch ms）。传进来为了可测。 */
  now: number;
  /** 上次推送时刻。null = 从没推过。 */
  lastPushAt: number | null;
  /** 上次推送时的步数。null = 从没推过。 */
  lastPushStep: number | null;
  /** 任务是否刚刚进入"需要人"的状态（审批/失败）。这种必推，不受节流限制。 */
  needsAttention: boolean;
  /**
   * 浏览器画面摘要（T5 判据里"browser.snapshot"那一条）。
   *
   * ⚠️ **不是位图**：browser.snapshot 走的是 Playwright 的 page.snapshot()，
   * 返回 a11y 结构文本。真截图要改容器侧协议 + 飞书发图，记在 docs/backlog.md。
   * 这里给的是"它在看的那个页面现在有什么"，能回答"看到啥了"这个实际问题。
   */
  screen?: string | null;
}

export type ProgressDecision =
  | { push: false; reason: 'disabled' | 'too_soon' | 'too_few_steps' | 'nothing_to_say' }
  | { push: true; text: string; reason: 'start' | 'attention' | 'interval' };

/**
 * 决定要不要推，要推就给出说人话的文本。
 *
 * 顺序：开关 → 需要关注（必推）→ 首次（推）→ 步数够不够 → 时间够不够。
 * "需要关注"插在开关之后、其他之前，因为它是最该让主人知道的：
 * 任务卡住了、要审批了，这时候节省消息是错的。
 */
export function decideProgress(
  input: ProgressInput,
  cfg: ProgressConfig = DEFAULT_PROGRESS,
): ProgressDecision {
  if (!cfg.enabled) return { push: false, reason: 'disabled' };

  // 需要人介入 → 必推，不看节流。理由：这种消息漏掉的代价远大于多推一条。
  if (input.needsAttention) {
    return { push: true, text: renderProgress(input, true), reason: 'attention' };
  }

  // 一次都没推过 → 这是"开始了"，值得说一句。
  if (input.lastPushAt === null) {
    if (input.stepCount === 0) return { push: false, reason: 'nothing_to_say' };
    return { push: true, text: renderProgress(input, false), reason: 'start' };
  }

  // 步数不够：连"上次推完到现在又走了几步"都不够，就别说话。
  const stepDelta = input.stepCount - (input.lastPushStep ?? 0);
  if (stepDelta < cfg.everyNSteps) return { push: false, reason: 'too_few_steps' };

  // 时间不够：步数够了但刚推过不久，还要再等。
  const elapsed = input.now - input.lastPushAt;
  if (elapsed < cfg.minIntervalMs) return { push: false, reason: 'too_soon' };

  return { push: true, text: renderProgress(input, false), reason: 'interval' };
}

/** 工具名 → 人话。查不到就原样返回（不编）。 */
const TOOL_PHRASES: Record<string, string> = {
  'fs.read': '读文件',
  'fs.write': '写文件',
  'fs.list': '看目录',
  'fs.stat': '查文件信息',
  'shell.run': '跑命令',
  'browser.open': '打开网页',
  'browser.snapshot': '看网页内容',
  'browser.click': '点网页上的东西',
  'http.fetch': '访问网址',
  'memory.write': '记住',
  'memory.read': '回忆',
  'schedule.create': '设提醒',
  'schedule.list': '查提醒',
  'mail.list': '看邮件列表',
  'mail.read': '读邮件',
  'mail.search': '搜邮件',
  'mail.draft': '写邮件草稿',
  'mail.send': '发邮件',
  'calendar.list': '看日历',
};

/** 把工具名翻成人话。没登记的照原样吐出来 —— 编一个懂的名字比露原名更糟。 */
export function humanizeTool(tool: string | null): string {
  if (tool === null || tool === '') return '思考中';
  return TOOL_PHRASES[tool] ?? tool;
}

/**
 * 渲染成一段给主人看的文字。
 *
 * 刻意做得短：飞书消息在手机上一屏能看完是上限。
 * "还有 12 步"这种信息比"第 13/25 步，正在调用 fs.read，参数 {...}"
 * 有用得多 —— 主人想知道的是"快好了吗"，不是内部编号。
 */
function renderProgress(input: ProgressInput, attention: boolean): string {
  const head = attention ? '需要你看一下' : '正在做';
  const lines: string[] = [`**${head}**：${input.title.slice(0, 60)}`];

  // 最近在干什么：取最近一条有工具名的，翻成人话。
  const withTool = input.recentSteps.find((s) => s.toolName !== null);
  if (withTool !== undefined) {
    const verb = humanizeTool(withTool.toolName);
    // 失败的一步要显式说"卡在这里"，不然主人以为还在推进。
    const st = withTool.status;
    lines.push(st === 'failed' || st === 'interrupted' ? `卡在：${verb}` : `现在：${verb}`);
  } else if (!attention && input.recentSteps.some((s) => s.kind === 'llm')) {
    lines.push('现在：在思考');
  }

  lines.push(`已经 ${input.stepCount} 步`);

  // 画面：浏览器任务最有价值的一句是"它现在看到什么"。
  // 限长 200 字符 —— 飞书在手机上一屏就那么大，超了等于没有。
  if (input.screen !== undefined && input.screen !== null && input.screen !== '') {
    lines.push('');
    lines.push('页面：' + input.screen);
  }

  if (attention) {
    lines.push('');
    lines.push('（详情在 /tasks 里，或者直接问我）');
  }
  return lines.join('\n');
}