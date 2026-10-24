/**
 * src/surfaces/memory-import.ts —— 旧助手记忆导入（M4 / 语音阶段 4，2026-10-24）。
 *
 * 解决的问题：主人从 ChatGPT / 另一台 Charlie 搬过来时，记忆在别人手里。
 * 我们能做的是给一段**可复制的交接提示词**，让旧助手按我们的格式整理出一份快照，
 * 再把它落成一条普通笔记（`notes/YYYY-MM-DD-import-<source>.md`）。
 *
 * 三条硬约束（都是"别把脏东西带进来"）：
 *  1. 只写 notes/，**不自动改 MEMORY.md** —— 整理记忆交给一次正常任务，人来拍板；
 *  2. 上限 16 KB（与 notes 的硬限一致），超了 413，提示拆分；
 *  3. 文件名受 `limits.ts` 的 NOTE_NAME_RE 约束（小写 slug），source 只允许 [a-z0-9-]。
 *
 * 纯函数、零 IO：HTTP 层负责读写，CLI 只负责打印/投递。
 */

/** 交接提示词：让旧助手把"关于我的事实"整理成可直接落盘的一页。 */
export const HANDOFF_PROMPT = [
  '我要换一个助手。请帮我整理一份「关于我的便携式记忆快照」，我会把它交给新助手。',
  '',
  '要求：',
  '1. 每条一行，只写**有依据**的事实（我说过的、你确认过的），不要推测我的性格或贴标签。',
  '2. 拿不准的条目行首标 `[推断]`；不要把它们和确定的事实混在一起。',
  '3. 跳过敏感内容：健康状况、财务状况、心理状态、证件号码、住址门牌、密码密钥。',
  '4. 分四段输出：`## 偏好`、`## 习惯`、`## 正在进行的事`、`## 联系与称呼`。',
  '5. 每段最多 15 条；总量控制在 2000 字以内。宁少勿多，新助手会自己去问我。',
  '6. 只输出这份快照本身，不要解释、不要寒暄、不要加结尾总结。',
].join('\n');

/** 与 notes 的硬限一致（`limits.ts` 的 LIMIT_NOTE_OR_MANUAL.hard）。 */
export const MAX_IMPORT_BYTES = 16 * 1024;

export interface ImportNoteInput {
  /** 旧助手给的快照正文。 */
  text: string;
  /** 来源标识（chatgpt / claude / charlie …），会进文件名。 */
  source: string;
  /** 当前时间（注入，便于测试）。 */
  now: Date;
}

export type ImportNoteResult =
  | { ok: true; path: string; content: string; bytes: number }
  | { ok: false; error: 'EMPTY' | 'TOO_LARGE' | 'BAD_SOURCE'; message: string };

/** source → 文件名 slug：只留小写字母/数字，其余折叠成 `-`。 */
export function sourceSlug(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/** 本地日期 YYYY-MM-DD（与 `localDay` 同口径，但不依赖时区库）。 */
export function localDayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 目标路径：`notes/YYYY-MM-DD-import-<slug>.md`。
 *
 * 幂等：同一天、同一个来源 → 同一个路径（重导就覆盖那条，不堆一堆 -2、-3）。
 */
export function importNotePath(source: string, now: Date): string {
  return `notes/${localDayOf(now)}-import-${sourceSlug(source) || 'unknown'}.md`;
}

/**
 * 生成要落盘的笔记（含来源头）。
 *
 * 头三行是给未来的自己看的：谁给的、什么时候导的、导入通道。正文原样保留，
 * 不做"智能清洗"——清洗属于一次正常任务，而且会掩盖旧助手编造的内容。
 */
export function buildImportNote(input: ImportNoteInput): ImportNoteResult {
  const body = input.text.replace(/\r\n/g, '\n').trim();
  if (body.length === 0) {
    return { ok: false, error: 'EMPTY', message: '导入内容是空的（先让旧助手整理一份快照）' };
  }
  const slug = sourceSlug(input.source);
  if (slug.length === 0) {
    return { ok: false, error: 'BAD_SOURCE', message: 'source 只能用字母/数字（例如 chatgpt、charlie）' };
  }
  const header = [
    `source: ${slug}`,
    `imported_at: ${input.now.toISOString()}`,
    `channel: dotd-import/v1`,
    '',
  ].join('\n');
  const content = `${header}${body}\n`;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: 'TOO_LARGE',
      message: `导入内容 ${bytes} 字节超过上限 ${MAX_IMPORT_BYTES}；请按主题拆成几份分别导入`,
    };
  }
  return { ok: true, path: importNotePath(slug, input.now), content, bytes };
}
