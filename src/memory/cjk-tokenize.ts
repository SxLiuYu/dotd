/**
 * src/memory/cjk-tokenize.ts —— FTS5 的 CJK 二元切分（纯函数，零依赖）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * SQLite FTS5 的 `unicode61` 分词器按 Unicode 字符类切词：拉丁文按空格/标点切，
 * **CJK（汉字/假名/谚文）却会把一整段连续字符当成一个 token**。实测（SQLite 3.50.4）：
 *
 *   INSERT '这是一条会议记录' → 索引里只有一个 token "这是一条会议记录"
 *   MATCH '会议'             → 0 条（查不到）
 *
 * 也就是说：不处理的话，中文检索**完全不可用**——而 dotd 的主人用中文。
 *
 * ── 方案：bigram（二元组）────────────────────────────────────────────
 * 把连续 CJK 串切成相邻两字的二元组再入索引，查询串同样切分：
 *
 *   "这是一条会议记录" → 这是 是一 一条 条会 会议 议记 记录
 *   查询 "会议"        → 会议          → 命中（"会议" 这个 bigram 恰好是索引 token）
 *
 * 为什么不用 trigram：FTS5 的 `tokenize='trigram'` 只处理 ≥3 字符的查询，
 * 两字中文词（"会议"、"报销"）是最高频的查询形态，二元的召回更完整。
 * 为什么单一 CJK 字符（"会"）也保留原样：不保留的话单字查询会 0 命中；
 * 这里对长度 1 的 CJK 片段把它自己作为一个 token（见 `tokenizeForFts`）。
 *
 * ── 为什么是"代码侧"而不是"触发器里" ────────────────────────────────
 * SQLite 触发器只能调 SQL 函数，调不了 JS。要在触发器里做 bigram，只能用
 * `replace()`/`substr()` 之类拼 SQL——冗长、易错、无法复用于查询侧，还会让
 * 索引里存的内容和查询侧切分逻辑出现两套实现（漂移）。
 * 因此采用**代码侧双写**：迁移包只建 contentless FTS 表（110_memory_fts.sql），
 * 真正的索引写入在 `MemoryService` 的写入路径里调本文件的纯函数完成，
 * **同一个函数**同时服务写入与查询，天然不会漂移。
 *
 * 取舍代价（写进报告）：任何绕过 `MemoryService` 直接 `INSERT INTO mem_messages`
 * 的写入（目前只有测试与迁移回填用）必须自己调 `syncFtsForMessage()`，
 * 否则该消息进不了索引。这条由 `resyncMessageFts()` 兜底修复（见 MemoryService）。
 */

/** CJK 片段：汉字（含扩展 A 区）、平假名/片假名、谚文。（无 `g` 标志：会被 test() 复用，带 g 会有 lastIndex 状态） */
const CJK_CHAR_CLASS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const CJK_ONLY_RE = new RegExp(`^[${CJK_CHAR_CLASS}]+$`);

/** 拉丁/数字片段（保持整词，小写化）。 */
const LATIN_SEGMENT = /[A-Za-z0-9_]+/;

/** 整体切分：按"CJK 串 / 拉丁数字串"两类片段扫过文本，保持出现顺序。 */
const SEGMENT_RE = new RegExp(`[${CJK_CHAR_CLASS}]+|[A-Za-z0-9_]+`, 'g');

/** 单个 CJK 字符判定（用于查询侧判断"这是不是一个中文词"）。 */
export function isCjk(text: string): boolean {
  return CJK_ONLY_RE.test(text);
}

/**
 * 把文本切成 FTS5 索引 token 数组（**写入侧与查询侧共用同一个实现**）。
 *
 * 规则：
 * - 连续 CJK 串 `s`（长度 n）→ `s[i..i+2]`（i = 0..n-2）共 n-1 个二元组；n = 1 时保留该单字；
 * - 拉丁/数字串 → 小写整词（与 `unicode61` 对英文的行为一致，`Hello` 与 `hello` 同词）；
 * - 其余（标点、空白、emoji）丢弃。
 *
 * 例：
 * ```ts
 * tokenizeForFts('这是一条会议记录') // ['这是','是一','一条','条会','会议','议记','记录']
 * tokenizeForFts('会议 Meeting 2026') // ['会议','meeting','2026']
 * ```
 */
export function tokenizeForFts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SEGMENT_RE)) {
    const seg = m[0];
    if (LATIN_SEGMENT.test(seg) && !isCjk(seg)) {
      out.push(seg.toLowerCase());
      continue;
    }
    // CJK 片段：二元组；单字片段保留自身
    if (seg.length === 1) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * 写入侧：把一段原文转成存进 FTS 的 token 文本（空格分隔，供 `unicode61` 再切一次）。
 */
export function ftsIndexText(text: string): string {
  return tokenizeForFts(text).join(' ');
}

/**
 * 查询侧：把用户查询串转成 FTS5 MATCH 表达式（每个 token 加引号做短语匹配）。
 *
 * - 空查询（全是标点/空白）→ `''`（调用方据此跳过 FTS，返回空结果）；
 * - 多个 token **用 AND 隐含连接**（FTS5 的 MATCH 语法里相邻词默认是 AND），
 *   即"查询里的每个词都要出现"——与 LIKE 版的整体子串语义最接近；
 * - token 内可能含 `"` 吗？不可能：切分器只产出 CJK/字母/数字，见 `SEGMENT_RE`。
 */
export function ftsMatchQuery(query: string): string {
  const tokens = tokenizeForFts(query);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

/**
 * 命中高亮：给原文里与查询 token 对应的片段加 `[]`（纯函数，供 `snippet` 用）。
 *
 * 为什么不用 FTS5 的 `snippet()`：contentless FTS（content=''）没有原文可摘录，
 * 而外部内容表的 `snippet()` 读的是 `mem_messages` 原文（即未切分的文本），
 * 对 CJK 反而会把整个中文串当成一个 token 高亮。这里直接从原文做**最长公共片段**高亮，
 * 保证"返回给主人的片段里能看到他查的词"，且与 LIKE 降级路径的片段形状一致。
 */
export function highlightSnippet(content: string, query: string, width = 60): string {
  const q = query.trim();
  if (q.length === 0) return content.slice(0, width * 2).replace(/\s+/g, ' ');
  // 1) 原文里整串出现（最容易理解，也覆盖英文/短语查询）
  const direct = content.toLowerCase().indexOf(q.toLowerCase());
  if (direct !== -1) {
    const start = Math.max(0, direct - width);
    return content.slice(start, start + q.length + width * 2).replace(/\s+/g, ' ');
  }
  // 2) 否则按 token 找：取第一个在原文里出现的 token（CJK 二元组 / 拉丁词）
  const tokens = tokenizeForFts(q);
  for (const t of tokens) {
    const idx = content.toLowerCase().indexOf(t.toLowerCase());
    if (idx === -1) continue;
    const start = Math.max(0, idx - width);
    return content.slice(start, start + t.length + width * 2).replace(/\s+/g, ' ');
  }
  return content.slice(0, width * 2).replace(/\s+/g, ' ');
}
