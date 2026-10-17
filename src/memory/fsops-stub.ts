/**
 * src/memory/fsops-stub.ts —— 内存版 /fs/ops 桥（stub 模式，CONVENTIONS §7 同款哲学）。
 *
 * 依据：
 * - CONVENTIONS.md §7「stub 模式环境变量约定」：DOTD_MODEL_TRANSPORT / DOTD_FLEET 两个 stub
 *   变量的共同哲学 = "不接外部世界"时用进程内假实现，语义与真实件对齐。文件记忆侧的同款
 *   假实现即本文件：容器未跑/agent-runtime 不可达时，daemon 与测试都可用它拿到
 *   "读得到 MEMORY.md、能 list/stat/rename"的行为。
 * - memory.md §3.1 铁律 B：daemon 侧唯一读路径 = /fs/ops 桥；本 stub 实现同一接口，
 *   因此调用方（MemoryService）无感知切换。
 *
 * 语义对齐真实桥（接缝契约 S4'）：
 * - rename 限 home 内（不越出根、不写保留前缀之外的目标由调用方保证）；
 * - 路径一律 home 相对路径（HomeRelPath 域），不接受绝对路径；
 * - 不可达/不存在 → null / [] / false（降级，不抛）。
 */

import type { FsOpsBridge, FsOpsListEntry, FsOpsStat } from './fsops-client.ts';
import { normalizeHomePath } from './limits.ts';

export interface StubFsFile {
  content: string;
  mtimeMs?: number;
}

export class StubFsOpsBridge implements FsOpsBridge {
  readonly kind = 'stub';
  /** 是否可用（false 时一切操作降级为空——用于测桥不可用分支）。 */
  availableFlag = true;
  private readonly files = new Map<string, StubFsFile>();
  private readonly dirs = new Set<string>(['', 'notes', 'manuals', '.tmp', '.archive']);

  constructor(initial: Record<string, string | StubFsFile> = {}) {
    for (const [path, v] of Object.entries(initial)) {
      const norm = normalizeHomePath(path);
      if (norm === null) continue;
      this.files.set(norm, typeof v === 'string' ? { content: v } : v);
      const parent = norm.replace(/\/[^/]*$/, '');
      if (parent.length > 0) this.dirs.add(parent);
    }
  }

  available(): boolean {
    return this.availableFlag;
  }

  /** 测试/装配辅助：直接放一个文件（等价容器内 fs.write）。 */
  put(path: string, content: string, mtimeMs?: number): void {
    const norm = normalizeHomePath(path);
    if (norm === null) throw new Error(`stub 桥不接受该路径：${path}`);
    const existing = this.files.get(norm);
    this.files.set(norm, { content, mtimeMs: mtimeMs ?? existing?.mtimeMs ?? Date.now() });
    const parent = norm.replace(/\/[^/]*$/, '');
    if (parent.length > 0) this.dirs.add(parent);
  }

  /** 测试辅助：当前文件快照。 */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, f] of this.files) out[p] = f.content;
    return out;
  }

  private mtime(path: string): number {
    return this.files.get(path)?.mtimeMs ?? Date.now();
  }

  async read(_dotId: string, path: string): Promise<string | null> {
    if (!this.availableFlag) return null;
    const norm = normalizeHomePath(path);
    if (norm === null) return null;
    return this.files.get(norm)?.content ?? null;
  }

  async list(_dotId: string, path: string): Promise<FsOpsListEntry[]> {
    if (!this.availableFlag) return [];
    const norm = normalizeHomePath(path) ?? '';
    const prefix = norm.length === 0 ? '' : `${norm}/`;
    const seen = new Set<string>();
    const out: FsOpsListEntry[] = [];
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        out.push({
          path: p,
          name: rest,
          type: 'file',
          sizeBytes: Buffer.byteLength(this.files.get(p)!.content, 'utf8'),
          mtimeMs: this.mtime(p),
        });
      } else {
        const dir = `${prefix}${rest.slice(0, slash)}`;
        if (seen.has(dir)) continue;
        seen.add(dir);
        out.push({ path: dir, name: rest.slice(0, slash), type: 'dir' });
      }
    }
    return out;
  }

  async stat(_dotId: string, path: string): Promise<FsOpsStat | null> {
    if (!this.availableFlag) return null;
    const norm = normalizeHomePath(path);
    if (norm === null) return null;
    const f = this.files.get(norm);
    if (f !== undefined) {
      return { path: norm, sizeBytes: Buffer.byteLength(f.content, 'utf8'), mtimeMs: this.mtime(norm), isDir: false };
    }
    if (this.dirs.has(norm)) return { path: norm, sizeBytes: 0, mtimeMs: Date.now(), isDir: true };
    return null;
  }

  async rename(_dotId: string, from: string, to: string): Promise<boolean> {
    if (!this.availableFlag) return false;
    const a = normalizeHomePath(from);
    const b = normalizeHomePath(to);
    if (a === null || b === null) return false;
    if (a === b) return true;
    const f = this.files.get(a);
    if (f === undefined) return false;
    this.files.delete(a);
    this.files.set(b, f);
    const parent = b.replace(/\/[^/]*$/, '');
    if (parent.length > 0) this.dirs.add(parent);
    return true;
  }
}

/** 工厂（对齐 tests/helpers.ts 的 makeStubXxx 命名风格）。 */
export function makeStubFsOpsBridge(files: Record<string, string | StubFsFile> = {}): StubFsOpsBridge {
  return new StubFsOpsBridge(files);
}
