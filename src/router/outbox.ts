/**
 * src/router/outbox.ts —— OUTBOX.md 兜底通道（阶段一求救的实际落点）。
 *
 * 依据（逐字可溯）：
 * - 契约 T3：路径裁定 `~/.dotd/OUTBOX.md`（宿主侧；MR:116 的 `/dot/state/OUTBOX.md` 是容器
 *   视角路径，作废）；`alerts.outbox_path` 仍是唯一配置源；**写者 = MR**（含阶段一自行追加）；
 *   SF 永不写 OUTBOX。格式裁定：**MR 块格式**（`## [ts] HELP <sig>…` + `---`）为唯一格式，
 *   CP 摘要"[ISO8601] [SOS|ALERT|INFO] 一行格式"作废。
 * - MR §4.5：OUTBOX 追加同样**先 INSERT 后追加文件**（追加幂等检查：grep 同签名段落头存在
 *   则跳过）。最后一级：路由自己实现文件追加，**永不失败**（磁盘满时由 AlertManager 记 lost）。
 * - CONVENTIONS.md §5：OUTBOX 的具体格式归 MR（装配层只负责"追加"这个动作，不要自造格式）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expandHome } from './paths.ts';

/** 段落头（MR 块格式，契约 T3 逐字）。 */
function blockHeader(ts: string, tag: string, sig: string): string {
  return `## [${ts}] ${tag} ${sig}`;
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

/**
 * OUTBOX 写入器。
 *
 * 幂等（§4.5 逐字）：追加前 grep 同签名段落头，已存在则跳过——配合"账本先行"协议，
 * 崩溃重放不会把同一条求救写两遍。
 */
export class OutboxWriter {
  private readonly path: string;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    // 契约 T3：路径支持 `~` 展开为 daemon 用户 HOME（config/dotd.yml 加载约定）
    this.path = expandHome(path);
    this.now = now;
  }

  get filePath(): string {
    return this.path;
  }

  /** 确保文件存在（不截断已有内容）。 */
  ensureFile(): void {
    if (existsSync(this.path)) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, '# OUTBOX.md —— dotd 求救兜底通道（契约 T3：写者=MR，格式=MR 块）\n\n', 'utf8');
  }

  private hasBlock(tag: string, sig: string): boolean {
    if (!existsSync(this.path)) return false;
    const text = readFileSync(this.path, 'utf8');
    return text.includes(`] ${tag} ${sig}`) || text.includes(`${tag} ${sig}`);
  }

  /**
   * 追加一条 HELP 块。
   * 幂等：同签名段落头已存在 → 跳过（返回 `duplicate: true`）。
   */
  appendHelp(body: string, signature: string): { ok: boolean; error?: string; duplicate?: boolean } {
    return this.append('HELP', signature, body);
  }

  /** 追加一条 RECOVERY 块。 */
  appendRecovery(body: string, signatures: string): { ok: boolean; error?: string; duplicate?: boolean } {
    return this.append('RECOVERY', signatures, body);
  }

  /**
   * 通用追加：账本先行协议的**后半段**（调用方必须先 INSERT alert_dispatch）。
   * 永不抛错——失败由返回值的 error 表达（AlertManager 记 lost）。
   */
  private append(
    tag: 'HELP' | 'RECOVERY',
    sig: string,
    body: string,
  ): { ok: boolean; error?: string; duplicate?: boolean } {
    try {
      this.ensureFile();
      if (this.hasBlock(tag, sig)) return { ok: true, duplicate: true };
      const ts = nowIso(this.now());
      const block = `${blockHeader(ts, tag, sig)}\n${body}\n---\n\n`;
      appendFileSync(this.path, block, 'utf8');
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: String(cause) };
    }
  }

  /** 读全文（CLI `dotd outbox` / 测试断言用）。 */
  readAll(): string {
    if (!existsSync(this.path)) return '';
    return readFileSync(this.path, 'utf8');
  }

  /**
   * 轮转（MEM 守门读用，契约 T3：MEM 经 `outboxUnresolvedSignatures()` 判定，
   * 本方法只提供"删掉已收敛段落"的原子操作，判定不在 MR 内）。
   */
  pruneResolved(resolvedSignatures: readonly string[]): number {
    if (!existsSync(this.path) || resolvedSignatures.length === 0) return 0;
    const text = readFileSync(this.path, 'utf8');
    const blocks = text.split(/(?=^## \[)/m);
    const kept: string[] = [];
    let removed = 0;
    for (const b of blocks) {
      const isResolved = resolvedSignatures.some((s) => b.includes(s));
      if (isResolved && b.startsWith('## [')) {
        removed += 1;
        continue;
      }
      kept.push(b);
    }
    if (removed > 0) writeFileSync(this.path, kept.join(''), 'utf8');
    return removed;
  }
}
