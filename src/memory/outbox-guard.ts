/**
 * src/memory/outbox-guard.ts —— OUTBOX.md 体积守门（§3.6 / 契约 T3）。
 *
 * 依据（逐字可溯）：
 * - memory.md §3.6（rev2 重写：所有权让渡，格式对齐模型路由）：
 *   - 位置：`~/.dotd/OUTBOX.md`（daemon 宿主机文件；接缝契约 T3 最终裁定宿主侧，
 *     model-router.md:113 的 `/dot/state/` 作废；alerts.outbox_path 仍是唯一配置源）。
 *   - 追加格式：以模型路由定稿为准：`## [YYYY-MM-DD HH:mm] HELP <sig>` + 模板正文 +
 *     `---` 分隔的**块结构**；恢复状态以路由 alert_dispatch 表为准，OUTBOX 内不回写。
 *   - 本模块保留的职责 = 体积守门：超 64 KB / 200 个块时按**块**轮转进
 *     `.dotd/archive/outbox-<批次>.md`（仍在 ~/.dotd/ 下，daemon 自己就是写者之一，
 *     不依赖容器）；**未收敛（HELP 块签名在 alert_dispatch 中无 resolved_at）的块永不轮转**。
 *   - 文件监听器可 tail 此文件自检（保持块首行可被 `tail -n 20` 直读）。
 * - 契约 T3：MEM 轮转经 MR 只读方法 `outboxUnresolvedSignatures()` 判定收敛，
 *   不开 SELECT 例外；查不到表/无探针时保守全留。
 * - S9：格式以 model-router.md:526 为准；本模块只按块边界轮转。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** §3.6：体积阈值。 */
export const OUTBOX_MAX_BYTES = 64 * 1024;
export const OUTBOX_MAX_BLOCKS = 200;

/** 块结构：`## [YYYY-MM-DD HH:mm] HELP <sig>` 起，至下一个块首行前（含 `---` 分隔）。 */
export interface OutboxBlock {
  /** 块首行原文（`tail -n 20` 可直读）。 */
  head: string;
  /** HELP 签名（无法解析时为空串 → 视为未收敛，永不轮转）。 */
  signature: string;
  /** 块全文（含尾部 `---` 与空行）。 */
  text: string;
  start: number;
  end: number;
}

const HEAD_RE = /^##\s*\[([^\]]*)\]\s*(HELP|ALERT|INFO)\s*(\S*)/;

/**
 * 按块切分 OUTBOX.md。块首行 = `## [...]` 起；其后到下一个块首行（或 EOF）为一个块。
 * 第一个块首行之前的内容（前言）保留在 blocks[0] 之外，由 preamble 承载，轮转时不丢。
 */
export function splitOutboxBlocks(content: string): { preamble: string; blocks: OutboxBlock[] } {
  const lines = content.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    if (HEAD_RE.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  if (starts.length === 0) return { preamble: content, blocks: [] };
  const preamble = content.slice(0, starts[0]!);
  const blocks: OutboxBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : content.length;
    const text = content.slice(start, end);
    const head = text.split('\n', 1)[0] ?? '';
    const m = HEAD_RE.exec(head);
    blocks.push({ head, signature: m?.[3] ?? '', text, start, end });
  }
  return { preamble, blocks };
}

export interface OutboxGuardResult {
  rotated: number;
  kept: number;
  archivePath: string | null;
  /** 未收敛块数（永不轮转）。 */
  unresolvedKept: number;
}

export interface OutboxGuardDeps {
  outboxPath: string;
  /** 契约 T3：MR outboxUnresolvedSignatures()；缺省 = 查不到（保守全留）。 */
  unresolvedSignatures?: () => string[] | Promise<string[]>;
  now?: () => number;
}

/**
 * §3.6 守门。幂等：未超阈值时不动文件。
 *
 * 轮转策略：从最老的块开始轮转，遇到未收敛块即停（未收敛块永不轮转；其后更新的块
 * 也不轮转——它们通常是对同一故障的后续通报，同进同出）。
 */
export async function runOutboxGuard(deps: OutboxGuardDeps): Promise<OutboxGuardResult> {
  const now = deps.now ?? Date.now;
  const empty: OutboxGuardResult = { rotated: 0, kept: 0, archivePath: null, unresolvedKept: 0 };
  if (!existsSync(deps.outboxPath)) return empty;

  const content = readFileSync(deps.outboxPath, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const { preamble, blocks } = splitOutboxBlocks(content);
  if (blocks.length === 0) return { ...empty, kept: 0 };

  const unresolved = new Set<string>(
    // 契约 T3：无探针（查不到 alert_dispatch / MR 未注入）时保守全留——
    // 宁可让 OUTBOX 涨，也不把可能未收敛的求救块轮转掉。
    deps.unresolvedSignatures !== undefined ? await deps.unresolvedSignatures() : ['__all__'],
  );
  const isUnresolved = (b: OutboxBlock): boolean =>
    b.signature.length === 0 || unresolved.has(b.signature) || unresolved.has('__all__');

  const over = bytes > OUTBOX_MAX_BYTES || blocks.length > OUTBOX_MAX_BLOCKS;
  if (!over) {
    return { ...empty, kept: blocks.length, unresolvedKept: blocks.filter(isUnresolved).length };
  }

  // 找到第一条"可轮转后缀"的起点：未收敛块及其后的块全部保留
  let keepFrom = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    if (isUnresolved(blocks[i]!)) {
      keepFrom = i;
      break;
    }
  }
  const rotatable = blocks.slice(0, keepFrom);
  if (rotatable.length === 0) {
    // 全是未收敛块：什么都不做（§3.6「未收敛的块永不轮转」优先于体积阈值）
    return { ...empty, kept: blocks.length, unresolvedKept: blocks.length };
  }

  // §3.6：轮转目标 = OUTBOX.md 同级 `.dotd/archive/`。
  // 注意：OUTBOX.md 本身就在 ~/.dotd/ 下，所以正确路径是 ~/.dotd/.dotd/archive/
  // （双 .dotd 是有意的——外层是数据根、内层是 daemon 自管的隐藏子目录）。
  // 这里只拼 dirname(outboxPath) + '.dotd/archive'，不对 outboxPath 再做
  // HOME 展开之类的猜测：路径必须由调用方传绝对路径（见 expandHome）。
  const archiveDir = join(dirname(deps.outboxPath), '.dotd', 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const batch = new Date(now()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const archivePath = join(archiveDir, `outbox-${batch}.md`);
  const header = `<!-- OUTBOX 轮转批次 ${new Date(now()).toISOString()}（按块轮转；块首行格式未改动，可被 tail 直读） -->\n`;
  writeFileSync(archivePath, header + rotatable.map((b) => b.text).join(''), 'utf8');

  const keptText = preamble + blocks.slice(keepFrom).map((b) => b.text).join('');
  // 原子替换：tmp + rename（§2 原则 3 崩溃安全）
  const tmpPath = `${deps.outboxPath}.tmp`;
  writeFileSync(tmpPath, keptText, 'utf8');
  renameSync(tmpPath, deps.outboxPath);

  return {
    rotated: rotatable.length,
    kept: blocks.length - rotatable.length,
    archivePath,
    unresolvedKept: blocks.length - keepFrom,
  };
}

/**
 * §3.6：daemon 自己作为写者之一时的追加入口（块格式由 MR 定稿，这里只追加不改写）。
 * 仅用于崩溃恢复路径（integrity_check 失败 → append 一条 HELP 块，§6.3）。
 */
export function appendOutboxBlock(
  outboxPath: string,
  signature: string,
  body: string,
  at: number = Date.now(),
): void {
  const ts = new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  const block = `## [${ts}] HELP ${signature}\n${body}\n---\n\n`;
  if (existsSync(outboxPath)) appendFileSync(outboxPath, block, 'utf8');
  else {
    mkdirSync(dirname(outboxPath), { recursive: true });
    writeFileSync(outboxPath, block, 'utf8');
  }
}
