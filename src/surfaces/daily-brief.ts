/**
 * src/surfaces/daily-brief.ts —— 每日简报的纯聚合与渲染（对标 Claude Duet 的"每天一份简报"）
 *
 * 要解决什么问题
 *   dotd 早就能主动说话（定时任务 + proactive 的三道闸），但那套闸只回答"能不能说"，
 *   不回答"说什么"。于是主人一天收到的是**一堆孤立的小消息**：一条任务跑完了、
 *   一条审批等着、日历里有三个会 —— 每条都得他自己拼成"我今天要操心什么"。
 *
 *   简报把这事压成**一条**消息，段序固定：今日日程 → 等你批的事 → 近 24 小时结果
 *   → 今天还会跑 → 邮件。固定段序不是为了好看，是为了让主人形成肌肉记忆：
 *   第二段永远是"要我点头的事"，扫一眼就够。
 *
 * 为什么整份文件都是纯函数（不读库、不发消息、不取时间）
 *   ① 可测：简报的坑几乎全在**渲染与裁剪**上（字符上限、段序、空段），
 *      这些不需要数据库就能验完；
 *   ② 可重放：接线层负责取数，取完把数据扔进来 —— 同一份数据必然得到同一段文本。
 *      线上"简报内容怪"时能拿快照离线复现，不用在 daemon 里加日志；
 *   ③ 时段判定（该不该发）也放这里：它只依赖 nowMs 和一行配置，若拆到调度器里，
 *      改口径时必然只改一处，然后"设置里的 08:00"和"实际推送时间"对不上。
 *   所以 nowMs 一律由调用方传入，模块内部**不碰** Date.now()。
 *
 * 有一条口径贯穿全文：**读失败不等于没有**。
 *   日历报错、邮件检查失败、审批卡在 executing —— 都必须如实写进简报。
 *   因为"今天没事"和"我不知道今天有没有事"对主人是两个完全不同的结论，
 *   而后者被说成前者，才是这类简报最伤人的失败方式。
 */

/** 日程条目（接线层从 calendar.ListResult 映射过来）。 */
export interface BriefCalendarEvent {
  /** epoch ms；null = 这条日程的时刻读不出来（不是"全天"）。 */
  startMs: number | null;
  allDay: boolean;
  summary: string;
  location?: string;
}

/** 一条待批审批（调用方只传 status='pending' 的）。 */
export interface BriefApproval {
  seq: number;
  summary: string;
  tier: string;
  createdAt: string;
}

/** 近 24 小时的任务结果。 */
export interface BriefTaskStats {
  done: number;
  failed: number;
  running: number;
  queued: number;
  /** 失败任务的标题，最多取前 3 条渲染。可以是空数组（那就只留汇总）。 */
  failedTitles: string[];
}

/** 今天还会触发的定时任务。 */
export interface BriefCrontab {
  name: string;
  /** epoch ms；null = 算不出下次触发时间。 */
  nextFireAt: number | null;
}

/** 邮件概况。unread 为 null 表示"查不到"，不是"0 封"。 */
export interface BriefMail {
  unread: number | null;
  error?: string;
}

/** 一次简报的全部素材。全由接线层取好传进来。 */
export interface BriefInput {
  nowMs: number;
  calendar: { events: BriefCalendarEvent[]; errors: string[] };
  /** 只传 status='pending' 的审批。 */
  approvals: BriefApproval[];
  /** 卡在 executing 的审批条数。这是缺陷（卡住不收口），要如实说，不能藏。 */
  executingApprovals?: number;
  /** 近 24 小时。 */
  tasks: BriefTaskStats;
  /** 今天还会触发的定时任务（调用方已按触发时间排好序）。 */
  crontabs?: BriefCrontab[];
  mail?: BriefMail;
}

/** 段 id。顺序即渲染顺序。 */
export type BriefSectionId = 'calendar' | 'approvals' | 'tasks' | 'crontabs' | 'mail';

/** 渲染好的一段。lines 为空表示这一段是空的（不该出现在结果里）。 */
export interface BriefSection {
  id: BriefSectionId;
  title: string;
  lines: string[];
}

/** 最终产物。text 就是可以直接发出去的那条消息。 */
export interface DailyBrief {
  sections: BriefSection[];
  text: string;
  /** 因为没内容被整段省略的 id（用于日志/观测"今天为什么只有两段"）。 */
  omittedSections: BriefSectionId[];
}

/** 默认字符上限。手机端飞书卡片正文读起来舒服的长度，再长就没人看了。 */
export const BRIEF_MAX_CHARS = 1200;

/** 每段的条数上限。超出部分用一行"还有 N 个"带过，不静默丢弃。 */
const CALENDAR_MAX = 8;
const APPROVAL_MAX = 5;
const FAILED_TITLE_MAX = 3;
const CRONTAB_MAX = 5;
/** shouldSendBrief 的默认补发窗口（分钟）：daemon 中午重启不该补发早间简报。 */
const DEFAULT_WINDOW_MIN = 180;

/** 全空时的那一句。单独拎出来，因为规则要求它是**恰好**这一句。 */
const EMPTY_TEXT = '今天没有需要你关注的事。';

/**
 * 把毫秒格式成本地 HH:MM。
 * 时间读不出来（NaN）也返回「时刻未知」—— 简报宁可说不知道，也不猜一个时间。
 */
function hhmm(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '时刻未知';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 标题/说明为空时给个占位，免得行看起来像断掉了。 */
function orFallback(s: string, fallback: string): string {
  const t = s.trim();
  return t === '' ? fallback : t;
}

/** 裁剪时接在段尾的标记。N = 被省掉的字符数（如实说省了多少，不是"略"）。 */
function omitMarker(n: number): string {
  return '…（还有 ' + n + ' 字被省略）';
}

// ── 各段的构造 ────────────────────────────────────────────────────────────
// 每个构造函数**总是**返回一段（lines 可能为空）。空段由 buildDailyBrief 统一过滤，
// 这样"哪段该出现"只有一处判断，渲染和 omittedSections 不会打架。

/**
 * 今日日程。
 * 时间口径：allDay 优先于 startMs —— 全天事件本来就没有"几点"，即便带了时间也不该渲染成 09:00。
 * 日历错误必须单独成行：读失败时 events 会是空的，若不说，主人会以为今天真的没会。
 */
function buildCalendarSection(cal: BriefInput['calendar']): BriefSection {
  const lines: string[] = [];
  const events = cal.events;
  for (const e of events.slice(0, CALENDAR_MAX)) {
    const when = e.allDay ? '全天' : e.startMs === null ? '时刻未知' : hhmm(e.startMs);
    let line = '· ' + when + '  ' + orFallback(e.summary, '（无标题）');
    const loc = e.location === undefined ? '' : e.location.trim();
    if (loc !== '') line += '（' + loc + '）';
    lines.push(line);
  }
  if (events.length > CALENDAR_MAX) {
    lines.push('…还有 ' + (events.length - CALENDAR_MAX) + ' 个日程');
  }
  const errors = cal.errors;
  if (errors.length > 0) {
    // 只说前 3 条，但条数报总数 —— 主人要知道"有几处读不出来"。
    const shown = errors
      .slice(0, 3)
      .map((x) => x.trim())
      .filter((x) => x !== '')
      .join('；');
    let line = '日历有 ' + errors.length + ' 个问题：' + (shown === '' ? '（无详细信息）' : shown);
    if (errors.length > 3) line += ' …（只列了前 3 条）';
    lines.push(line);
  }
  return { id: 'calendar', title: '今日日程', lines };
}

/**
 * 等你批的事。
 * 行内带 #seq：主人回复时可以直接说"批 12 号"，比复述标题省事。
 * 带 tier：这一条是 auto 还是 confirm，决定他要不要细看。
 */
function buildApprovalSection(list: BriefApproval[], executing: number | undefined): BriefSection {
  const lines: string[] = [];
  for (const a of list.slice(0, APPROVAL_MAX)) {
    const tier = a.tier.trim();
    let line = '· #' + a.seq + ' ' + orFallback(a.summary, '（无说明）');
    if (tier !== '') line += '（' + tier + '）';
    lines.push(line);
  }
  if (list.length > APPROVAL_MAX) {
    // 不能只列 5 条就完事：主人得知道还有别的在等，否则"批完这 5 条就没事了"是错觉。
    lines.push('…还有 ' + (list.length - APPROVAL_MAX) + ' 条等你批');
  }
  const stuck = executing === undefined ? 0 : executing;
  if (stuck > 0) {
    // 这是缺陷状态（既没批完也没卡死到能报警），单独一句，别混在待批列表里。
    lines.push('另有 ' + stuck + ' 条审批卡在执行中（可能卡住，需要收口）');
  }
  return { id: 'approvals', title: '等你批的事', lines };
}

/**
 * 近 24 小时结果。
 * 汇总行固定用「完成/失败/在跑/排队」四项 —— 顺序不变，主人才会比大小。
 * 全 0 视为空段：一条任务都没跑过的一天，写"完成 0 / 失败 0"只是噪音。
 */
function buildTaskSection(t: BriefTaskStats): BriefSection {
  const lines: string[] = [];
  if (t.done + t.failed + t.running + t.queued > 0) {
    lines.push('· 完成 ' + t.done + ' / 失败 ' + t.failed + ' / 在跑 ' + t.running + ' / 排队 ' + t.queued);
    if (t.failed > 0) {
      // 失败标题最多 3 条；总数已经在上面那行里了，所以这里不必再补"还有 N 条"。
      for (const title of t.failedTitles.slice(0, FAILED_TITLE_MAX)) {
        const s = title.trim();
        if (s !== '') lines.push('· 失败：' + s);
      }
    }
  }
  return { id: 'tasks', title: '近 24 小时结果', lines };
}

/** 今天还会跑。时间在前，理由同 calendar 的 renderList：主人先想知道"几点"。 */
function buildCrontabSection(list: BriefCrontab[] | undefined): BriefSection {
  const lines: string[] = [];
  const items = list === undefined ? [] : list;
  for (const c of items.slice(0, CRONTAB_MAX)) {
    const when = c.nextFireAt === null ? '时间未知' : hhmm(c.nextFireAt);
    lines.push('· ' + when + '  ' + orFallback(c.name, '（无名称）'));
  }
  if (items.length > CRONTAB_MAX) {
    lines.push('…还有 ' + (items.length - CRONTAB_MAX) + ' 个定时任务');
  }
  return { id: 'crontabs', title: '今天还会跑', lines };
}

/**
 * 邮件。
 * 三种状态互斥且必须分清：查不到（unread === null）≠ 检查失败（error）≠ 0 封。
 * 有 error 时不再补一句"未读未知"—— 同一次检查失败里那两个字是废话。
 * unread === 0 且没 error 视为空段：零未读不值得占一段。
 */
function buildMailSection(mail: BriefMail | undefined): BriefSection {
  const lines: string[] = [];
  if (mail !== undefined) {
    const err = mail.error === undefined ? '' : mail.error.trim();
    if (err !== '') lines.push('· 邮件检查失败：' + err);
    if (mail.unread === null) {
      if (err === '') lines.push('· 未读未知');
    } else if (mail.unread > 0) {
      lines.push('· 未读 ' + mail.unread + ' 封');
    }
  }
  return { id: 'mail', title: '邮件', lines };
}

// ── 渲染与裁剪 ────────────────────────────────────────────────────────────

/** 把若干段拼成最终文本：段内 标题+行，段间单换行（手机端一行空白都是浪费）。 */
function joinSections(list: BriefSection[]): string {
  return list
    .map((s) => (s.lines.length === 0 ? s.title : s.title + '\n' + s.lines.join('\n')))
    .join('\n');
}

/**
 * 把一段的正文裁到 budget 个字以内，末尾换成省略标记。
 * 返回 null = 这一段连标记都放不下，调用方应整段拿掉（继续裁上一段）。
 *
 * 逐字回收而不是按行裁：一段可能只有一行（比如邮件报错），按行裁会整行没了，
 * 那就从"说了半句"退化成"什么都没说"。
 */
function trimBody(body: string, budget: number): string[] | null {
  if (budget >= body.length) return body === '' ? [] : body.split('\n');
  if (budget <= 0) return null;
  // 标记长度随 N 的位数变化，所以从大到小试，直到放得下。
  for (let keep = Math.min(body.length, budget); keep >= 0; keep--) {
    const marker = omitMarker(body.length - keep);
    const need = keep + (keep > 0 ? 1 : 0) + marker.length;
    if (need > budget) continue;
    const head = body.slice(0, keep);
    if (head === '') return [marker];
    const parts = head.split('\n');
    // head 恰好切在换行上时会多出一个空元素，别让它变成空行。
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return [...parts, marker];
  }
  return null;
}

/**
 * 从**最后一段**开始裁，前面的段完整保留。
 *
 * 为什么从后往前：段序本身就是优先级。日程和待批是"今天必须你动"的事，
 * 定时任务和邮件是"知道了就好"。要牺牲就先牺牲后者。
 * 外层还有一道 text.slice 保底 —— 上限是硬约束，宁可切在半句话上也不许超。
 */
function fitSections(sections: BriefSection[], cap: number): { sections: BriefSection[]; text: string } {
  const work = sections.map((s) => ({ id: s.id, title: s.title, lines: [...s.lines] }));
  let text = joinSections(work);
  for (let i = work.length - 1; i >= 0 && text.length > cap; i--) {
    const sec = work[i];
    if (sec === undefined) continue;
    const over = text.length - cap;
    const body = sec.lines.join('\n');
    const trimmed = trimBody(body, body.length - over);
    if (trimmed === null) {
      work.splice(i, 1);
    } else {
      sec.lines = trimmed;
    }
    text = joinSections(work);
  }
  if (text.length > cap) text = text.slice(0, cap);
  return { sections: work, text };
}

/**
 * 装配一份简报。
 *
 * maxChars 缺省 BRIEF_MAX_CHARS；传 0 或负数会退化成空串 —— 小到装不下任何内容的
 * 上限只能换来空消息，这是"字数是硬约束"的直接代价，调用方该给个合理值。
 */
export function buildDailyBrief(input: BriefInput, maxChars: number = BRIEF_MAX_CHARS): DailyBrief {
  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : BRIEF_MAX_CHARS;

  // 段序是硬约定（日程 → 待批 → 结果 → 定时任务 → 邮件），这里就是唯一的定义处。
  const all: BriefSection[] = [
    buildCalendarSection(input.calendar),
    buildApprovalSection(input.approvals, input.executingApprovals),
    buildTaskSection(input.tasks),
    buildCrontabSection(input.crontabs),
    buildMailSection(input.mail),
  ];

  const kept = all.filter((s) => s.lines.length > 0);
  const fitted = fitSections(kept, cap);

  let text = fitted.text;
  if (kept.length === 0) {
    // 规则要求这一句"恰好"，所以不带任何标题/日期；上限紧到连它都装不下就截断。
    text = EMPTY_TEXT.length > cap ? EMPTY_TEXT.slice(0, cap) : EMPTY_TEXT;
  }

  // 省略的段 = 本来就没内容的 + 被上限裁到一点不剩的。用"最终渲染了什么"反推，
  // 所以这里不需要在裁剪过程中另外记账，也不会漏掉任何一段。
  const rendered = new Set(fitted.sections.map((s) => s.id));
  const omittedSections: BriefSectionId[] = all.filter((s) => !rendered.has(s.id)).map((s) => s.id);
  return { sections: fitted.sections, text, omittedSections };
}

/** 取渲染文本。留着这个函数是为了让接线层不必知道 text 是"算好的"还是"现拼的"。 */
export function renderBriefText(b: DailyBrief): string {
  return b.text;
}

// ── 发不发 ────────────────────────────────────────────────────────────────

/** 本地时区的 'YYYY-MM-DD'。跨天判定必须用本地日界，不能用 UTC —— 否则东八区早上 7 点还是"昨天"。 */
export function briefDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  if (Number.isNaN(d.getTime())) return '';
  return (
    String(d.getFullYear()).padStart(4, '0') +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** 解析 'HH:MM'。容忍一位小时（'8:05'），因为人写配置就是这么写的。 */
function parseHhmm(spec: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) return null;
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/**
 * 现在该不该发今天的简报。
 *
 * 顺序（日志里要看到最根本的那个原因）：
 *   ① 开关    关了就什么都不问。
 *   ② 配置格式 bad_time —— 坏配置和"还没到点"是两件事，混在一起会让人以为等等就好。
 *   ③ 当天已发 already_sent —— 用本地日界比对 lastSentDay。
 *   ④ 没到点   not_yet。
 *   ⑤ 过窗口   too_late：daemon 中午重启时不该补发早间的"今日日程"，
 *              那时段的简报已经没用了，发出去只是噪音。
 *
 * 窗口边界用 `>`：恰好迟到 windowMin 分钟仍然发。
 * 宁可多一条"迟到的简报"，也不要因为差一分钟就整天沉默 —— 沉默无法排查。
 */
export function shouldSendBrief(input: {
  enabled: boolean;
  /** 'HH:MM' */
  time: string;
  lastSentDay: string | null;
  nowMs: number;
  /** 补发窗口（分钟），默认 180。 */
  windowMin?: number;
}): { send: boolean; reason: 'ok' | 'disabled' | 'not_yet' | 'already_sent' | 'too_late' | 'bad_time' } {
  if (!input.enabled) return { send: false, reason: 'disabled' };

  const hm = parseHhmm(input.time);
  if (hm === null) return { send: false, reason: 'bad_time' };

  const day = briefDayKey(input.nowMs);
  if (day !== '' && input.lastSentDay === day) return { send: false, reason: 'already_sent' };

  const d = new Date(input.nowMs);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const planMin = hm.h * 60 + hm.m;
  // 时钟比计划早 → 等。跨午夜时这自然成立：23:50 的计划在次日 00:05 属于"还没到点"。
  if (nowMin < planMin) return { send: false, reason: 'not_yet' };

  const raw = input.windowMin;
  const windowMin = raw === undefined || !Number.isFinite(raw) ? DEFAULT_WINDOW_MIN : Math.max(0, Math.trunc(raw));
  if (nowMin - planMin > windowMin) return { send: false, reason: 'too_late' };

  return { send: true, reason: 'ok' };
}