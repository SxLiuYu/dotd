/**
 * src/surfaces/connection-watch.ts —— 已连接应用的「看门狗」（U3 的持续在线那一半）
 *
 * Duet 说的「监控已连接应用」有两条腿：
 *   ① 有一张总览表（`connections.ts`，本轮已做）——回答「我连了什么、现在什么状态」；
 *   ② **持续盯着**，掉线时主动说一声 —— 是这条文件。
 *
 * 为什么不做成「定时轮询每个应用」
 *   dotd 的连接分两种性质，混在一起轮询会白烧请求：
 *   · **推式**（`/hooks/:source` 事件、IMAP IDLE 之类）—— 变化由对端推来，
 *     已经在 `event-rules.yml` + `surf_inbox` 这条链路上，再轮询是重复。
 *   · **拉式**（RSS、GitHub 通知）—— 真需要定时去拉，但那是**任务**
 *     （`schedule.create`），有审批、有超时、有 journal。看门狗不该偷偷替它拉。
 *   所以这里盯的不是「应用里有什么新东西」，而是**「连接本身还活着吗」**：
 *   凭证过期、IMAP 认证失败、模型端点全挂、MCP server 起不来 —— 这些是
 *   「主人以为自己被服务着，其实早就断了」的那类故障，也正是最该主动说的一类。
 *
 * 三个刻意的克制
 *   ① **只在状态变化时说话**（边沿触发，不是电平触发）：一直坏着的连接不每分钟重复一遍。
 *      判据是 `lastReported` 的指纹（status + detail），不是内存里的布尔量 —— 重启后
 *      不该把已经说过的话再说一遍，所以指纹要走注入的 `loadState`/`saveState`（落库）。
 *   ② **恢复也说一句**：断续反复是常态，只说坏不说好，主人会以为一直没恢复。
 *   ③ **没事绝不说话**：全绿时这条路径完全静默，不产生任何消息。
 *
 * 与主动打扰三道闸的关系
 *   与简报同理：这是主人**显式打开**的功能（`surfaces.connection_watch.enabled`），
 *   不再套 `crontabs.proactive` 那三道闸。但**安静时段仍然生效**——坏消息也不该
 *   吵醒人，可以等到早上。这一点与简报不同（简报本身就是定时打扰）。
 */

import type { ConnectionRow } from './connections.ts';

/** 看门狗只关心「这条连接是否可用」，不看它里面有什么内容。 */
export interface WatchSubject {
  kind: ConnectionRow['kind'];
  id: string;
  /** 人看的名字（邮箱 label / 端点 host 之类）。 */
  name: string;
  status: ConnectionRow['status'];
  /** 一行解释（含修复提示时一并进来）。 */
  detail: string;
}

export interface ConnectionWatchConfig {
  enabled: boolean;
  /** 每多少分钟看一次（默认 15；不看内容的检查不必更勤）。 */
  intervalMin: number;
  /** 安静时段边界（'HH:MM'）；起止相等/null 表示不设安静时段。 */
  quietHours: { start: string; end: string } | null;
}

/** 判断「这条连接是否有问题」。`public_only` / `ready` 都不算问题。 */
export function isProblem(status: ConnectionRow['status']): boolean {
  return status === 'error' || status === 'not_configured' || status === 'public_only';
}

/**
 * 从总览行里挑出要盯的 + 当前结论。
 *
 * 为什么 `not_configured` 也算问题：主人配了一半的连接最危险（写了 app_id 却没配会话、
 * 加了 MCP server 但写错路径）。「从没配过」与「配坏了」在总览里长得一样，
 * 所以两边都报——但文案必须能区分（见 `describeProblem`）。
 */
export function watchSubjects(rows: readonly ConnectionRow[]): WatchSubject[] {
  return rows
    .filter((r) => isProblem(r.status))
    .map((r) => ({ kind: r.kind, id: r.id, name: r.name, status: r.status, detail: r.detail }));
}

/** 指纹：状态 + 一行详情。详情变了（比如错误信息换了）也算变化，值得重说一次。 */
export function subjectKey(s: WatchSubject): string {
  return `${s.kind}:${s.id}`;
}

export function subjectFingerprint(s: WatchSubject): string {
  return `${s.status}|${s.detail}`;
}

/** 一条问题通知的正文（纯文本，飞书里能读）。 */
export function renderProblemMessage(subjects: readonly WatchSubject[], atMs: number): string {
  if (subjects.length === 0) return '';
  const stamp = new Date(atMs);
  const hhmm = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [`连接出问题了（${hhmm} 检查）`];
  for (const s of subjects) {
    lines.push(`· ${s.name} — ${statusWord(s.status)}：${s.detail}`);
  }
  lines.push('');
  lines.push('修好后我会再说一句；不想收这类消息就把 surfaces.connection_watch.enabled 关掉。');
  return lines.join('\n');
}

/** 恢复通知：只列「之前有问题、现在好了」的。 */
export function renderRecoveredMessage(
  recovered: readonly { key: string; label: string }[],
  atMs: number,
): string {
  if (recovered.length === 0) return '';
  const stamp = new Date(atMs);
  const hhmm = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [`连接已恢复（${hhmm} 检查）`];
  for (const r of recovered) lines.push(`· ${r.label} 好了`);
  return lines.join('\n');
}

function statusWord(status: ConnectionRow['status']): string {
  switch (status) {
    case 'error':
      return '出错';
    case 'not_configured':
      return '没配好';
    case 'public_only':
      return '仅公开接口';
    case 'ready':
      return '就绪';
    case 'connected':
      return '已连接';
    default:
      return String(status);
  }
}

/**
 * 一次检查的判决：该说什么话。
 *
 * `previous` 是上次**已报告过**的指纹表（key → fingerprint）。
 * 返回的 `next` 要由调用方落库（不管有没有话要说都要存，否则「已说过」会丢）。
 *
 * 四种情况：
 *   · 新问题（不在 previous 或指纹变了）→ problem
 *   · 老问题不变                        → 沉默（`next` 照抄）
 *   · 曾在 previous 里、现在不在问题集    → recovered
 *   · 从没有问题过                      → 沉默（`next` 为空）
 */
export interface WatchVerdict {
  problem: WatchSubject[];
  /** 恢复的连接：名字取自上一次报告时存下的标签（不靠重新猜）。 */
  recovered: { key: string; label: string }[];
  /** 下一次比较用的「指纹 → 人看的名字」表（**必须**落库）。 */
  next: Record<string, string>;
}

/** 一行存储的编码：`status|detail\x00label`（label 放最后，detail 里可能有任意字符）。 */
export function encodeState(s: WatchSubject): string {
  return `${subjectFingerprint(s)}\u0000${s.name}`;
}

/** 解出指纹与标签；格式不对就当「没记录过」（宁可多说一句，不可漏报）。 */
export function decodeState(raw: string): { fingerprint: string; label: string } | null {
  const at = raw.indexOf('\u0000');
  if (at === -1) return null;
  return { fingerprint: raw.slice(0, at), label: raw.slice(at + 1) };
}

export function judgeWatch(
  current: readonly WatchSubject[],
  previous: Readonly<Record<string, string>>,
): WatchVerdict {
  const alive = new Set<string>();
  for (const s of current) alive.add(subjectKey(s));

  const problem: WatchSubject[] = [];
  for (const s of current) {
    const key = subjectKey(s);
    const prev = previous[key];
    const prevFp = prev === undefined ? null : decodeState(prev)?.fingerprint ?? null;
    if (prevFp !== subjectFingerprint(s)) problem.push(s);
  }

  const recovered: { key: string; label: string }[] = [];
  for (const key of Object.keys(previous)) {
    if (alive.has(key)) continue;
    const dec = decodeState(previous[key] ?? '');
    recovered.push({ key, label: dec?.label ?? key });
  }

  const next: Record<string, string> = {};
  for (const s of current) next[subjectKey(s)] = encodeState(s);
  return { problem, recovered, next };
}

/** 安静时段判定（与 crontabs 的 quiet_hours 同语义：跨越午夜也对）。 */
export function inQuietHours(
  hhmm: string,
  quiet: { start: string; end: string } | null,
): boolean {
  if (quiet === null) return false;
  const toMin = (s: string): number | null => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
    if (m === null) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const now = toMin(hhmm);
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  if (now === null || start === null || end === null) return false; // 配错了就不静音，宁可多报
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** 把毫秒时间转成本地 'HH:MM'。 */
export function hhmmOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}