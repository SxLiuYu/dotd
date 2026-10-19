/**
 * src/memory/inject.ts —— 任务开始注入（READ-INJECT，§4.2 预算函数）与会话重建（§4.1）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/memory.md）：
 * - §3.3 状态机：[任务开始] → READ-INJECT（经桥读 MEMORY.md + 按需读 manuals，拼上下文包）。
 * - §4.2 预算函数：
 *   注入内容 = MEMORY.md（≤4KB，经 /fs/ops 桥原文读取，必进；桥不可用 → 本次跳过并在 messages 记
 *                kind='system_error' 注记 + memory_missed=1，不阻塞任务）
 *              + manuals 匹配片段：任务文本 tokens ∩ 文件头/首行关键词朴素匹配，top-2，每篇截前 1 KB
 *              + thread.context_summary + 近 8 条消息（若该 thread 有历史）
 *              + notes 不注入，只给 MEMORY.md 的 Pointers 列表（Dot 自取）
 *   预算：文件记忆部分 ≤2500 tokens；会话历史部分 ≤4000 tokens；
 *        超预算砍序：manuals 片段 → 消息条数 → context_summary 最后才动。
 *   估算统一 chars/3.5。
 * - §3.2 MEMORY.md 格式：第一行 `updated: <ISO>` 机器可校验；段落名固定
 *   （Interests / Current concerns / Pointers）。
 * - §4.1 恢复重建：Runner 重领任务 → load(task.session_id) → 按 §4.2 预算从新到旧装填，
 *   最老未装部分由 summary 兜底。契约 M1：恢复唯一入口 = buildSessionReplay(threadId, taskId, budget)。
 * - §3.1 铁律 B：daemon 侧唯一读路径 = /fs/ops 桥；容器未在跑时降级（仅 SQLite 部分）。
 */

import type {
  ContextBundle,
  HomeRelPath,
  MemoryArea,
  Message,
  Thread,
} from '../shared/contracts.ts';
import type { FsOpsBridge } from './fsops-client.ts';
import {
  BUDGET_FILE_MEMORY_TOKENS,
  BUDGET_SESSION_TOKENS,
  DEFAULT_RECENT_MESSAGES,
  MANUAL_EXCERPT_CHARS,
  MANUALS_TOP_N,
  tokensOfText,
} from './limits.ts';

// ═══════════════════════════════════════════════════════════════════
// §1 MEMORY.md 解析（§3.2 固定段落）
// ═══════════════════════════════════════════════════════════════════

/** §3.2 MEMORY.md 的三个固定段落。 */
export type MemoryMdSection = 'Interests' | 'Current concerns' | 'Pointers';

export interface ParsedMemoryMd {
  /** 第一行 `updated: <ISO>`（§3.2「机器可校验的第一行时间戳」）。 */
  updated: string | null;
  interests: string[];
  concerns: string[];
  pointers: Array<{ path: HomeRelPath; note: string }>;
  /** 未被固定段落覆盖的原文（主人自写段落，整理不得删改，§9 开放问题 7）。 */
  extras: string[];
}

const SECTION_ALIASES: Record<string, MemoryMdSection> = {
  interests: 'Interests',
  'current concerns': 'Current concerns',
  concerns: 'Current concerns',
  pointers: 'Pointers',
};

/**
 * 解析 MEMORY.md。段落名固定，Dot 整理时只允许增删条目、不改段落结构，
 * 保证 §4.2 预算函数的解析器简单可靠（§3.2 约定）。
 * 解析失败（无标题行）不抛——降级为"整篇当 interests 外的 extras"。
 */
export function parseMemoryMd(text: string): ParsedMemoryMd {
  const out: ParsedMemoryMd = {
    updated: null,
    interests: [],
    concerns: [],
    pointers: [],
    extras: [],
  };
  const lines = text.split(/\r?\n/);
  let current: MemoryMdSection | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (heading !== null) {
      const name = heading[1]!.toLowerCase().replace(/[#*_\s]+$/, '');
      const sec = SECTION_ALIASES[name];
      if (sec !== undefined) {
        current = sec;
        continue;
      }
      out.extras.push(line);
      current = null;
      continue;
    }
    if (current === null) {
      const upd = /^updated\s*:\s*(\S+)/i.exec(trimmed);
      if (upd !== null && out.updated === null) {
        out.updated = upd[1]!;
        continue;
      }
      out.extras.push(line);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const item = bullet !== null ? bullet[1]!.trim() : trimmed;
    if (item.length === 0) continue;
    if (current === 'Interests') out.interests.push(item);
    else if (current === 'Current concerns') out.concerns.push(item);
    else {
      const ptr = /^(\S+)\s*(?:#\s*(.*))?$/.exec(item);
      out.pointers.push({ path: ptr![1]!, note: (ptr![2] ?? '').trim() });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// §2 manuals 关键词匹配（§4.2「朴素匹配」）
// ═══════════════════════════════════════════════════════════════════

/** §4.2：任务文本 tokens ∩ 文件头/首行关键词朴素匹配。 */
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_.+-]{2,}|[\u4e00-\u9fa5]{2,}/g;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.push(m[0]!);
  return out;
}

interface ManualCandidate {
  path: HomeRelPath;
  area: MemoryArea;
  title: string | null;
  tags: string[];
  sizeBytes: number;
}

/** rankManuals 的单条打分明细（测试与诊断用；不影响返回值）。 */
export interface ManualScore {
  path: HomeRelPath;
  /** 加权命中分（旧算法口径：标题/路径 ×2 + tag ×1）。 */
  weighted: number;
  /** 自然词频：命中的 token 在候选文本里出现的总次数（不乘权重）。 */
  tf: number;
  /** 命中 token 的 IDF 之和。 */
  idfSum: number;
  /** 最终分 = Σ(权重 × (1 + ln tf) × idf)。 */
  final: number;
}

/**
 * IDF 语料：候选文本（title + path + tags）切成 token 后的文档集合。
 * 用 `N / (1 + df)` 而不是经典 `log(N/df)`：所有词都出现在所有文档里（df=N）时
 * IDF 退化为 N/(N+1)≈1 而不是 0——这样"全命中"仍然给分（不硬塞的前提不变：
 * 一个词都没命中 → weighted=0 → 直接不进候选列表）。
 */
function buildCorpus(manuals: ManualCandidate[]): { n: number; df: Map<string, number> } {
  const df = new Map<string, number>();
  for (const c of manuals) {
    const seen = new Set(tokenize(`${c.title ?? ''} ${c.path} ${c.tags.join(' ')}`));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { n: Math.max(1, manuals.length), df };
}

/** 单条候选的词频统计：命中的 token 在"标题+路径"与每个 tag 里各出现几次。 */
function countHits(taskTokens: Set<string>, text: string): number {
  let n = 0;
  for (const t of tokenize(text)) if (taskTokens.has(t)) n++;
  return n;
}

/**
 * 从 mem_files_index 的 manuals 行里按关键词匹配打分，取 top-N（§4.2 top-2）。
 *
 * 打分（P1-3 增强，旧算法保留为 `weighted` 分量）：
 *   final = Σ_{命中的 token} weight(token) × (1 + ln tf(token)) × idf(token)
 *   weight = 出现在标题/路径 ×2，出现在 tag ×1（与旧算法一致）
 *   tf     = 该 token 在候选文本中出现的总次数（旧算法只有"0/1 命中"，无词频）
 *   idf    = N / (1 + df)，df = 含该 token 的候选篇数（现算，不落库）
 *
 * 为什么要 TF-IDF：
 * - **词频**：一篇手册反复提到"部署 部署 部署"显然是部署主题，旧算法只给 1 次分；
 * - **IDF**：`notes/`、`dot1`、`md` 这类在每篇路径里都出现的词，旧算法每命中一个都
 *   加 2 分，等于把"噪声词"当强信号；IDF 让它们几乎不计分，而"kafka""报销"这种
 *   稀有词才会把文档推上去。
 *
 * 无命中返回空（不硬塞）——这个语义没变：`weighted === 0` 的候选不进结果。
 */
export function rankManuals(
  taskText: string,
  manuals: ManualCandidate[],
  topN: number = MANUALS_TOP_N,
): ManualCandidate[] {
  return rankManualsScored(taskText, manuals, topN).map((s) => s.candidate);
}

/** 带明细的版本（`rankManuals` 的实现体；测试用它可以断言"哪个词贡献了分"）。 */
export function rankManualsScored(
  taskText: string,
  manuals: ManualCandidate[],
  topN: number = MANUALS_TOP_N,
): Array<{ candidate: ManualCandidate; score: ManualScore }> {
  const q = new Set(tokenize(taskText));
  if (q.size === 0) return [];
  const corpus = buildCorpus(manuals);
  const idfOf = (t: string): number => corpus.n / (1 + (corpus.df.get(t) ?? 0));

  const scored: Array<{ candidate: ManualCandidate; score: ManualScore }> = [];
  for (const c of manuals) {
    const titleText = `${c.title ?? ''} ${c.path}`;
    const tagsText = c.tags.join(' ');
    let weighted = 0;
    let tf = 0;
    let idfSum = 0;
    let final = 0;
    for (const t of q) {
      // 在"标题+路径"里出现的次数（旧口径的 ×2 分量）与 tag 里出现的次数（×1 分量）。
      // 注意必须用**单 token 集合**去统计：countHits 的语义是"这段文本里有多少个词属于给定集合"。
      const inTitle = countHits(new Set([t]), titleText);
      const inTags = countHits(new Set([t]), tagsText);
      if (inTitle === 0 && inTags === 0) continue;
      const weight = inTitle > 0 ? 2 : 1;
      const freq = inTitle + inTags;
      const idf = idfOf(t);
      weighted += weight;
      tf += freq;
      idfSum += idf;
      final += weight * (1 + Math.log(freq)) * idf;
    }
    if (weighted === 0) continue; // 无命中 → 不硬塞（与旧算法一致）
    scored.push({ candidate: c, score: { path: c.path, weighted, tf, idfSum, final } });
  }
  scored.sort(
    (a, b) =>
      b.score.final - a.score.final ||
      b.score.weighted - a.score.weighted ||
      a.candidate.path.localeCompare(b.candidate.path),
  );
  return scored.slice(0, topN);
}

/** 旧算法（token 交集，标题/路径 ×2 + tag ×1）——保留为对照基准，不参与生产路径。 */
export function rankManualsLegacy(
  taskText: string,
  manuals: ManualCandidate[],
  topN: number = MANUALS_TOP_N,
): ManualCandidate[] {
  const q = new Set(tokenize(taskText));
  if (q.size === 0) return [];
  const scored: Array<{ c: ManualCandidate; score: number }> = [];
  for (const c of manuals) {
    let score = 0;
    const titleTokens = new Set(tokenize(`${c.title ?? ''} ${c.path}`));
    for (const t of titleTokens) if (q.has(t)) score += 2;
    for (const tag of c.tags) {
      const tagTokens = tokenize(tag);
      for (const t of tagTokens) if (q.has(t)) score += 1;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.path.localeCompare(b.c.path));
  return scored.slice(0, topN).map((s) => s.c);
}

// ═══════════════════════════════════════════════════════════════════
// §3 预算装填（§4.2 砍序）
// ═══════════════════════════════════════════════════════════════════

export interface InjectSource {
  bridge: FsOpsBridge;
  dotId: string;
  /** mem_files_index 的 manuals 行（用于匹配，不读全文）。 */
  manuals: ManualCandidate[];
}

export interface InjectResult extends ContextBundle {
  /** §4.2 降级标记：桥不可用/读取失败（调用方据此记 system_error + memory_missed）。 */
  bridgeFailed: boolean;
  bridgeError: string | null;
  /** MEMORY.md 原文长度（超 4KB 时注入截断并 warning）。 */
  memoryMdBytes: number;
  memoryMdTruncated: boolean;
  /** 超预算被砍掉的 manuals 条数（观测用）。 */
  droppedManuals: number;
  droppedMessages: number;
  summaryDropped: boolean;
}

/**
 * §3.2 MEMORY.md 空骨架（首次部署时由 daemon 侧补建）。
 *
 * 为什么需要它：home 卷是 docker 命名卷，容器创建时一片空白（Dockerfile 无 COPY
 * 种子），而 §3.3 状态机里没有任何一步负责"建初始 MEMORY.md"——模型自己不写，
 * READ-INJECT 就永远读到空，于是每个任务都记一次 memory_missed 降级注记。
 * 骨架只含 §3.2 固定三段 + 机器可校验的第一行时间戳，Dot 后续自行增删条目。
 */
export function memoryMdSkeleton(now: Date): string {
  const updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `# MEMORY (index)
updated: ${updated}
## Interests
## Current concerns
## Pointers
`;
}

/** 读 MEMORY.md（§4.2：必进；≤4KB；桥不可用返回 null 并降级）。 */
export async function readMemoryMd(
  bridge: FsOpsBridge,
  dotId: string,
  maxBytes: number,
): Promise<{ text: string | null; truncated: boolean; error: string | null }> {
  const text = await bridge.read(dotId, 'MEMORY.md');
  if (text === null) {
    return { text: null, truncated: false, error: 'MEMORY.md 不可读（桥不可用或文件缺失）' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, truncated: false, error: null };
  return { text: text.slice(0, maxBytes), truncated: true, error: null };
}

/**
 * §4.2 注入前的骨架补建判定。
 *
 * 判据刻意从严：只在"桥可达、文件确实不存在"时才交付 seeded=true。桥不可用
 * （容器挂了、鉴权失败）时返回 false，让 buildContextBundle 照旧走降级分支——
 * 把"连不上"误判成"没建过"会让每个任务都试图写一个写不进去的文件。
 *
 * 幂等：并发两次调用最多建一个骨架（第二次 stat 到已存在即跳过）；
 * 已有内容的 MEMORY.md 绝不覆盖（fs.write 是覆盖写，误伤即丢记忆）。
 *
 * 骨架落盘本身不在本函数内：FsOpsBridge 没有 write 原语（契约 S4' 只开
 * read/list/stat/rename），写由工具层的 fs.write 承担。
 */
export async function ensureMemoryMdText(
  bridge: FsOpsBridge,
  dotId: string,
  now: Date = new Date(),
): Promise<{ seeded: boolean; text: string }> {
  const text = memoryMdSkeleton(now);
  if ((await bridge.available()) === false) return { seeded: false, text };
  const st = await bridge.stat(dotId, 'MEMORY.md');
  if (st !== null) return { seeded: false, text };
  const existing = await bridge.read(dotId, 'MEMORY.md');
  if (existing !== null) return { seeded: false, text };
  return { seeded: true, text };
}

/**
 * §4.2 注入主函数。
 *
 * @param thread      该任务的 thread（事件/心跳任务可能还没有 → null）
 * @param summary     thread.context_summary
 * @param messages    该 thread 的消息（调用方负责取；本函数按预算裁剪）
 * @param budgetTokens 总预算（文件 ≤2500 + 会话 ≤4000；传入值仅作为额外上限）
 */
export async function buildContextBundle(
  src: InjectSource,
  taskText: string,
  opts: {
    summary: string | null;
    messages: Message[];
    budgetTokens: number;
  },
): Promise<InjectResult> {
  const fileBudget = Math.min(opts.budgetTokens, BUDGET_FILE_MEMORY_TOKENS);
  const sessionBudget = Math.min(opts.budgetTokens, BUDGET_SESSION_TOKENS);

  // ── 文件记忆部分（≤2500 tokens）────────────────────────────────────
  let memoryMd = '';
  let bridgeFailed = false;
  let bridgeError: string | null = null;
  let memoryMdBytes = 0;
  let memoryMdTruncated = false;

  const md = await readMemoryMd(src.bridge, src.dotId, 4 * 1024);
  if (md.text === null) {
    bridgeFailed = true;
    bridgeError = md.error;
  } else {
    memoryMd = md.text;
    memoryMdBytes = Buffer.byteLength(memoryMd, 'utf8');
    memoryMdTruncated = md.truncated;
  }
  let fileTokens = tokensOfText(memoryMd);

  // manuals 匹配片段（top-2，每篇截前 1KB）；超预算按 score 顺序丢
  const ranked = rankManuals(taskText, src.manuals);
  const manualExcerpts: Array<{ path: HomeRelPath; text: string }> = [];
  let droppedManuals = 0;
  for (const cand of ranked) {
    let text = await src.bridge.read(src.dotId, cand.path);
    if (text === null) continue;
    let excerpt = text.length > MANUAL_EXCERPT_CHARS ? text.slice(0, MANUAL_EXCERPT_CHARS) : text;
    let tokens = tokensOfText(excerpt);
    if (fileTokens + tokens > fileBudget) {
      // 超预算：先尝试截更短，仍不行则丢（砍序第一站）
      excerpt = excerpt.slice(0, Math.max(0, MANUAL_EXCERPT_CHARS / 2));
      tokens = tokensOfText(excerpt);
      if (fileTokens + tokens > fileBudget) {
        droppedManuals += 1;
        continue;
      }
    }
    manualExcerpts.push({ path: cand.path, text: excerpt });
    fileTokens += tokens;
  }

  // ── 会话历史部分（≤4000 tokens）───────────────────────────────────
  const fromNewest = [...opts.messages].reverse();
  const recentMessages: Message[] = [];
  let sessionTokens = 0;
  for (const m of fromNewest) {
    const t = m.tokenEst;
    if (recentMessages.length >= DEFAULT_RECENT_MESSAGES) break;
    if (sessionTokens + t > sessionBudget) break;
    recentMessages.push(m);
    sessionTokens += t;
  }
  const droppedMessages = fromNewest.length - recentMessages.length;
  recentMessages.reverse(); // 输出保持从旧到新

  // context_summary 最后才动（§4.2 砍序末端）；仍超则整段丢
  let summary = opts.summary;
  let summaryDropped = false;
  if (summary !== null && sessionTokens + tokensOfText(summary) > sessionBudget) {
    summary = null;
    summaryDropped = true;
  } else if (summary !== null) {
    sessionTokens += tokensOfText(summary);
  }

  return {
    memoryMd,
    manualExcerpts,
    summary,
    recentMessages,
    usedTokens: fileTokens + sessionTokens,
    bridgeFailed,
    bridgeError,
    memoryMdBytes,
    memoryMdTruncated,
    droppedManuals,
    droppedMessages,
    summaryDropped,
  };
}

// ═══════════════════════════════════════════════════════════════════
// §4 buildSessionReplay 装填（§4.1 / 契约 M1）
// ═══════════════════════════════════════════════════════════════════

/**
 * §4.1 恢复重建：按 §4.2 预算从新到旧装填消息；最老未装部分由 context_summary 兜底
 * （summary 本身作为一条合成 system 消息排在最前，保证 prompt 顺序 = 摘要→旧→新）。
 */
export function packSessionReplay(
  thread: Thread,
  messages: Message[],
  budgetTokens: number,
): Message[] {
  const out: Message[] = [];
  const summary = thread.contextSummary;
  const hasSummary = summary !== null && summary.length > 0;

  // **摘要的预算要先从总预算里扣掉**（2026-10-19 修）。
  //
  // 原来的写法是「先按全预算装最新消息，装完如果还剩预算才加摘要」：
  //   if (... && used < budgetTokens) { 加摘要 }
  // —— 这个条件方向是反的：**会话越长，used 越接近 budgetTokens**，
  // 于是最需要摘要的长会话最可能拿不到摘要。等于"越需要它，越用不上"。
  //
  // 正确做法：先给摘要留出位置，剩下来的预算再装最近的消息。
  // 摘要通常 ≤600 token（§4.4 上限），对 8000 的总预算是小头，
  // 但换来的是「长会话一定记得住开头」。
  const summaryTokens = hasSummary ? tokensOfText(summary) : 0;
  const replayBudget = hasSummary ? Math.max(0, budgetTokens - summaryTokens) : budgetTokens;

  let used = 0;
  const fromNewest = [...messages].reverse();
  const picked: Message[] = [];
  for (const m of fromNewest) {
    if (used + m.tokenEst > replayBudget) break;
    picked.push(m);
    used += m.tokenEst;
  }
  picked.reverse();

  // 摘要排在最近消息**之前**（它代表的是更早的历史）
  if (hasSummary) {
    out.push({
      id: `sum_${thread.id}`,
      threadId: thread.id,
      seq: thread.contextSummaryUptoSeq,
      role: 'system',
      kind: 'text',
      content: summary!,
      tokenEst: summaryTokens,
      createdAt: thread.lastActiveAt,
    });
  }
  out.push(...picked);
  return out;
}
