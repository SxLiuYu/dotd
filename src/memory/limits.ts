/**
 * src/memory/limits.ts —— 文件记忆的策略层限额（§3.4 硬数字）与 token 估算（§4.2）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/memory.md）：
 * - §3.4 大小上限表：软限（告警）/ 硬限（拒绝/强制整理）逐行落地为常量。
 *   rev2「与执行面限额的关系」：EX 物理兜底（fs.read≤4MB/fs.write≤8MB/home 卷 2GB）保留不动，
 *   本表是策略层、全部严于兜底；冲突时以更严者生效。
 * - §3.4 末段：一个 20 KB 的 note 会被记忆层拒绝，即使 fs.write 允许——即
 *   `checkFileLimits` 返回 error='HARD_LIMIT' 而非放行。
 * - §3.4 告警实现：写工具返回值附 `{warning:"MEMORY.md 3.1/4 KB，建议合并 Interests 第4、7条"}`。
 * - §3.2 格式约定：notes 命名 `YYYY-MM-DD-<kebab-slug>.md`（月度摘要 `YYYY-MM-digest.md`、
 *   `_compactions.md` 下划线留痕不计入文件数上限）。
 * - §4.2 预算函数：估算统一 chars/3.5；文件记忆部分 ≤2500 tokens、会话历史部分 ≤4000 tokens；
 *   超预算砍序：manuals 片段 → 消息条数 → context_summary 最后才动。
 * - §5.3 mem_files_index 索引范围：MEMORY.md + notes/ + manuals/ 的 *.md；
 *   排除 .archive/**、.tmp/**、.dotd/**（§6.2：.dotd/.tmp 永不入索）。
 */

import type { HomeRelPath, MemoryArea, MemoryWriteResult } from '../shared/contracts.ts';

// ═══════════════════════════════════════════════════════════════════
// §1 大小上限（§3.4 表逐行）
// ═══════════════════════════════════════════════════════════════════

export interface FileLimit {
  soft: number;
  hard: number;
}

/** §3.4 表：MEMORY.md 软 3 KB / 硬 4 KB。 */
export const LIMIT_MEMORY_MD: FileLimit = { soft: 3 * 1024, hard: 4 * 1024 };
/**
 * 人格文件（M3，2026-10-23）：1 KB 硬上限。
 *
 * 为什么不并进 MEMORY.md：那是「关于主人的事实」，这是「它该怎么跟主人说话」。
 * 两者变化频率不同、预算也该分开；人格每轮都注入，1 KB 是刻意的紧箍咒——
 * 写成长篇大论就不再是人格，而是 prompt 垃圾。
 */
export const LIMIT_IDENTITY_MD: FileLimit = { soft: 768, hard: 1024 };
/** §3.4 表：单个 note / manual 软 8 KB / 硬 16 KB。 */
export const LIMIT_NOTE_OR_MANUAL: FileLimit = { soft: 8 * 1024, hard: 16 * 1024 };
/** §3.4 表：notes/ 未归档文件数软 60 / 硬 120（触发强制整理 §4.5）。 */
export const LIMIT_NOTES_COUNT: { soft: number; hard: number } = { soft: 60, hard: 120 };
/** §3.4 表：manuals/ 总大小软 200 KB / 硬 512 KB。 */
export const LIMIT_MANUALS_BYTES: { soft: number; hard: number } = {
  soft: 200 * 1024,
  hard: 512 * 1024,
};
/** §3.4 表：home 全量（不含 .archive/.dotd/.tmp）软 1 MB / 硬 2 MB。 */
export const LIMIT_HOME_BYTES: { soft: number; hard: number } = {
  soft: 1024 * 1024,
  hard: 2 * 1024 * 1024,
};
/** §3.4 表：.archive/ 硬 32 MB，按批次 FIFO。 */
export const LIMIT_ARCHIVE_BYTES: { hard: number } = { hard: 32 * 1024 * 1024 };

// ═══════════════════════════════════════════════════════════════════
// §2 预算与估算（§4.2）
// ═══════════════════════════════════════════════════════════════════

/** §4.2：估算统一 chars/3.5（中英混排近似，无 tokenizer 依赖）。 */
export const CHARS_PER_TOKEN = 3.5;

/** §4.2：文件记忆部分预算上限（MEMORY.md + manuals 片段）。 */
export const BUDGET_FILE_MEMORY_TOKENS = 2500;
/** §4.2：会话历史部分预算上限（context_summary + 消息）。 */
export const BUDGET_SESSION_TOKENS = 4000;
/** §4.2：MEMORY.md 必进且 ≤4 KB；manuals 匹配 top-2，每篇截前 1 KB。 */
export const MANUALS_TOP_N = 2;
export const MANUAL_EXCERPT_CHARS = 1024;
/** §4.2：thread 有历史时默认注入近 8 条消息（§4.4 摘要失败时同样退化为 8 条 + 旧 summary）。 */
export const DEFAULT_RECENT_MESSAGES = 8;
/** §4.4：thread 消息数 >64 或注入估算超 4000 tokens → 投递摘要任务。 */
export const SUMMARIZE_MESSAGE_THRESHOLD = 64;
/** §4.4：新 context_summary ≤600 tokens。 */
export const SUMMARY_TOKEN_LIMIT = 600;

/** §4.2：chars → tokens 估算（向上取整，宁紧勿松）。 */
export function estimateTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** §4.2：文本 → tokens 估算。 */
export function tokensOfText(text: string): number {
  return estimateTokens(text.length);
}

// ═══════════════════════════════════════════════════════════════════
// §3 home 相对路径域（§3.1 布局 + §3.2 格式 + §6.2 索引范围）
// ═══════════════════════════════════════════════════════════════════

/** §3.1 保留前缀：记忆层不索引、不整理、不注入。 */
export const RESERVED_PREFIXES = ['.dotd/', '.tmp/', '.archive/'] as const;

export const HOME_INDEX_ROOT = 'MEMORY.md';
/** 人格文件（M3）：与 MEMORY.md 同级，但**不进** mem_files_index（它不是笔记，不参与检索）。 */
export const HOME_IDENTITY = 'IDENTITY.md';
export const HOME_NOTES_DIR = 'notes/';
export const HOME_MANUALS_DIR = 'manuals/';

/** §3.2 notes 命名：`YYYY-MM-DD-<kebab-slug>.md`。 */
const NOTE_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/;
/** §3.2 月度摘要 `YYYY-MM-digest.md` 与下划线留痕 `_compactions.md` 不计入文件数上限。 */
const NOTE_EXEMPT_RE = /^(\d{4}-\d{2}-digest\.md|_.*\.md)$/;

/**
 * 路径规范化（HomeRelPath 域）：
 * - 统一为正斜杠、去掉前导 `./` 与重复斜杠；
 * - 拒绝绝对路径、盘符路径与 `..` 逃逸（fs.* 沙箱同源要求）。
 */
export function normalizeHomePath(path: HomeRelPath): HomeRelPath | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  let p = path.replace(/\\/g, '/');
  // **家目录前缀不是逃逸**（2026-10-18 修）：原来一律拒绝绝对路径，
  // 但 fs.read 却接受 /dot/home/x（自动规范化）—— 一读一写两种行为，
  // 模型必然学到错的经验：读成功了就以为写也行，于是反复用绝对路径写、被拒、再试。
  // 这里把家目录前缀**连同其后的斜杠**一起剥掉；其余绝对路径（/etc、/root、C:）仍然拒。
  // `home` 后面必须紧跟 `/` 或结尾，否则 `/dot/homework/x` 会被误剥成 `work/x`。
  p = p.replace(/^\/dot\/home(?:\/|$)/, '');
  p = p.replace(/^dot\/home(?:\/|$)/, '');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  p = p.replace(/^\.\//, '');
  p = p.replace(/\/{2,}/g, '/');
  if (p.startsWith('/') || p.includes('../') || p.endsWith('/..')) return null;
  if (p === '.' || p === '..') return null;
  return p;
}

/** 是否落在记忆层保留前缀内（不索引/不整理/不注入）。 */
export function isReservedPath(path: HomeRelPath): boolean {
  return RESERVED_PREFIXES.some((pre) => path.startsWith(pre));
}

/**
 * 记忆层**管辖范围**判定（写检查点 M6 的唯一判据）。
 *
 * 与"能不能写进 home"是两件事：
 * - 本函数回答"这个路径属于长期记忆的组织范围吗"——只有 `MEMORY.md`、`notes/`、
 *   `manuals/` 三处属于，它们有命名规范（notes 必须是 `YYYY-MM-DD-slug.md`）、
 *   容量配额与软硬限。
 * - `home` 下其余路径（工作文件、临时产物、脚本、`.archive/`、`.tmp/`）**不受记忆层
 *   管辖**，它们的可写性由执行面护栏（必须留在 /dot/home 内、不许 `..` 逃逸、
 *   不许碰保留前缀）决定。
 *
 * 为什么需要这一条：改之前写检查点对任意路径都跑记忆规则，于是写一个普通工作文件
 * 会被"路径不在记忆规范内"拒掉——模型只能反复重试同一个写操作。
 * 判据只在这里维护一份，`beforeWrite` 与测试都调它。
 */
export function isMemoryPath(path: HomeRelPath): boolean {
  const norm = normalizeHomePath(path);
  if (norm === null) return false;
  if (isReservedPath(norm)) return false;
  if (norm === HOME_INDEX_ROOT) return true;
  if (norm.startsWith(HOME_NOTES_DIR) && norm.endsWith('.md')) {
    const rest = norm.slice(HOME_NOTES_DIR.length);
    return rest.length > 0 && !rest.includes('/');
  }
  if (norm.startsWith(HOME_MANUALS_DIR) && norm.endsWith('.md')) return true;
  return false;
}

/**
 * §3.2 + §6.2 索引范围判定：仅 MEMORY.md、notes/*.md、manuals/**\/*.md 入活跃索引；
 * .archive/**、.tmp/**、.dotd/** 永不入索。
 */
export function classifyHomeArea(path: HomeRelPath): MemoryArea | null {
  const norm = normalizeHomePath(path);
  if (norm === null) return null;
  if (isReservedPath(norm)) return null;
  if (norm === HOME_INDEX_ROOT) return 'memory';
  if (norm.startsWith(HOME_NOTES_DIR) && norm.endsWith('.md')) {
    const rest = norm.slice(HOME_NOTES_DIR.length);
    return rest.length > 0 && !rest.includes('/') ? 'notes' : null;
  }
  if (norm.startsWith(HOME_MANUALS_DIR) && norm.endsWith('.md')) return 'manuals';
  return null;
}

/** §3.2：合法 note 文件名（含月度摘要与下划线留痕）。 */
export function isNotePath(path: HomeRelPath): boolean {
  const norm = normalizeHomePath(path);
  if (norm === null || !norm.startsWith(HOME_NOTES_DIR)) return false;
  const name = norm.slice(HOME_NOTES_DIR.length);
  return NOTE_NAME_RE.test(name) || NOTE_EXEMPT_RE.test(name);
}

/**
 * §3.2/§3.4：是否属于"不计入文件数上限"的豁免形态
 * （月度摘要 `YYYY-MM-digest.md` / 下划线留痕 `_*.md`）。
 * 与 NOTE_EXEMPT_RE 同源，供 notes_count 统计与写前检查共用。
 */
export function isNoteExempt(path: HomeRelPath): boolean {
  const norm = normalizeHomePath(path);
  if (norm === null || !norm.startsWith(HOME_NOTES_DIR)) return false;
  return NOTE_EXEMPT_RE.test(norm.slice(HOME_NOTES_DIR.length));
}

/** §3.2：manuals/<domain>/*.md 至少两层路径。 */
export function isManualPath(path: HomeRelPath): boolean {
  const norm = normalizeHomePath(path);
  if (norm === null || !norm.startsWith(HOME_MANUALS_DIR) || !norm.endsWith('.md')) return false;
  return norm.slice(HOME_MANUALS_DIR.length).includes('/');
}

// ═══════════════════════════════════════════════════════════════════
// §4 写前检查点（§5.2 检查点 1 / §3.4 告警实现）
// ═══════════════════════════════════════════════════════════════════

/** 目标对象的当前规模画像（由调用方从 mem_files_index / 桥汇总）。 */
export interface HomeUsage {
  /** 目标路径当前字节数（已存在则计入，用于"写后大小"判定）。 */
  targetBytes: number;
  /** home 活跃集当前总字节（不含 .archive/.dotd/.tmp）。 */
  activeBytes: number;
  /** notes/ 未归档文件数（不含月度摘要与下划线留痕）。 */
  notesCount: number;
  /** manuals/ 当前总字节。 */
  manualsBytes: number;
  /** 是否处于只读期（home 硬限超限 → 整理后放行，§3.4）。 */
  readonlyPhase: boolean;
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/**
 * §5.2 检查点 1（fs.write 前）：限额判定 + 软限 warning 文本。
 * 返回 error 时调用方必须拒绝写入；warning 非空时由 Runner 附回工具响应（S5/M6）。
 */
export function checkFileLimits(
  path: HomeRelPath,
  content: string,
  usage: HomeUsage,
): MemoryWriteResult {
  const norm = normalizeHomePath(path);
  if (norm === null) {
    return { ok: false, error: 'HARD_LIMIT', warning: `非法 home 相对路径：${path}` };
  }
  if (usage.readonlyPhase) {
    return { ok: false, error: 'READONLY_PHASE', warning: 'home 已超硬限：进入只读期，整理后放行' };
  }

  const area = classifyHomeArea(norm);
  if (area === null) {
    return {
      ok: false,
      error: 'HARD_LIMIT',
      warning: `路径不在记忆规范内（仅 MEMORY.md/notes/*.md/manuals/**/*.md 可写）：${norm}`,
    };
  }
  if (area === 'notes' && !isNotePath(norm)) {
    return {
      ok: false,
      error: 'HARD_LIMIT',
      warning: `note 命名须为 YYYY-MM-DD-<slug>.md（月度摘要 YYYY-MM-digest.md）：${norm}`,
    };
  }

  // 单文件限额（写后大小 = 当前占用 - 目标已存在字节 + 新内容字节）
  const limit =
    area === 'memory' ? LIMIT_MEMORY_MD : LIMIT_NOTE_OR_MANUAL;
  const nextBytes = Math.max(0, usage.activeBytes - usage.targetBytes) + Buffer.byteLength(content, 'utf8');
  const fileBytes = Buffer.byteLength(content, 'utf8');
  if (fileBytes > limit.hard) {
    return {
      ok: false,
      error: 'HARD_LIMIT',
      warning: `${norm} ${kb(fileBytes)}/${kb(limit.hard)} KB 超硬限，须拆分或合并`,
    };
  }

  // 目录级限额（同样按写后大小判定）
  if (area === 'notes' && !NOTE_EXEMPT_RE.test(norm.slice(HOME_NOTES_DIR.length))) {
    const isNew = usage.targetBytes === 0;
    const nextCount = usage.notesCount + (isNew ? 1 : 0);
    if (nextCount > LIMIT_NOTES_COUNT.hard) {
      return {
        ok: false,
        error: 'NOTES_COUNT_LIMIT',
        warning: `notes/ 未归档 ${nextCount}/${LIMIT_NOTES_COUNT.hard} 超硬限，先跑整理`,
      };
    }
  }
  if (area === 'manuals') {
    const nextManuals = Math.max(0, usage.manualsBytes - usage.targetBytes) + fileBytes;
    if (nextManuals > LIMIT_MANUALS_BYTES.hard) {
      return {
        ok: false,
        error: 'HARD_LIMIT',
        warning: `manuals/ 合计 ${kb(nextManuals)}/${kb(LIMIT_MANUALS_BYTES.hard)} KB 超硬限`,
      };
    }
  }
  if (nextBytes > LIMIT_HOME_BYTES.hard) {
    return {
      ok: false,
      error: 'HOME_CAPACITY',
      warning: `home 活跃集 ${kb(nextBytes)}/${kb(LIMIT_HOME_BYTES.hard)} KB 超硬限，进入只读期`,
    };
  }

  // 软限：放行但附精简建议（§3.4 告警实现）
  if (fileBytes > limit.soft) {
    return {
      ok: true,
      warning:
        area === 'memory'
          ? `${norm} ${kb(fileBytes)}/${kb(LIMIT_MEMORY_MD.soft)} KB 超软限，建议合并 Interests 第4、7条`
          : `${norm} ${kb(fileBytes)}/${kb(limit.soft)} KB 超软限，建议拆分`,
    };
  }
  if (area === 'notes' && !NOTE_EXEMPT_RE.test(norm.slice(HOME_NOTES_DIR.length))) {
    const isNew = usage.targetBytes === 0;
    const nextCount = usage.notesCount + (isNew ? 1 : 0);
    if (nextCount > LIMIT_NOTES_COUNT.soft) {
      return {
        ok: true,
        warning: `notes/ 未归档 ${nextCount}/${LIMIT_NOTES_COUNT.soft} 超软限，建议投递 memory-compaction`,
      };
    }
  }
  if (area === 'manuals' && usage.manualsBytes > LIMIT_MANUALS_BYTES.soft) {
    return { ok: true, warning: `manuals/ 合计已超软限，建议合并同域手册` };
  }
  if (nextBytes > LIMIT_HOME_BYTES.soft) {
    return { ok: true, warning: `home 活跃集 ${kb(nextBytes)}/${kb(LIMIT_HOME_BYTES.soft)} KB 超软限` };
  }
  return { ok: true };
}

/** 是否只读期（§3.4：home 全量超硬限 → 只读期，整理后放行）。 */
export function isReadonlyPhase(activeBytes: number): boolean {
  return activeBytes > LIMIT_HOME_BYTES.hard;
}
