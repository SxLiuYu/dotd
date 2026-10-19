/**
 * agent-runtime/fs.ts —— fs.* 工具 + /fs/ops 桥（EX §7 物理实现 + 契约 S4'）。
 *
 * 设计原文（execution.md §7 表）：
 * | 工具 | 行为 | 护栏（本模块强制） |
 * | fs.read | 返回 UTF-8 文本或 base64 | 解析后必须 startsWith('/dot/home/')；拒绝 symlink 逃逸（realpath 双查）；单文件 ≤4MB |
 * | fs.write | 覆盖写，自动建父目录 | 同上；写 home 卷；单文件 ≤8MB |
 * | fs.list / fs.stat | 目录枚举/mtime/size | 同上，深度 ≤4 |
 *
 * 契约 S4'（MEM 的注入读取/索引对账/原子写/清理全靠它）：
 *   `POST /fs/ops {op:'read'|'list'|'stat'|'rename', path, target?, dotId}`，
 *   Bearer 鉴权、与 fs.* 同沙箱、rename 限 home 内、仅宿主 token 可调（不进模型工具面）。
 *
 * 契约 M4/S3：`.dotd/` 前缀降级为纵深防御隐藏（秘密已迁 state 卷）。
 */

import { realpathSync, statSync, lstatSync, existsSync } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, statSync as statSize, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FsOpsListEntry, FsOpsOp, FsOpsResponse, ToolResult } from './protocol.ts';
import {
  ERROR_CODES,
  FS_LIST_MAX_DEPTH,
  FS_READ_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
  errorResult,
  fsOpsError,
  fsOpsOk,
  okResult,
} from './protocol.ts';

/** home 卷挂载点（EX §4.2 Binds / Dockerfile VOLUME）。 */
export const HOME_ROOT = '/dot/home';

/** 纵深防御：模型面不可见的前缀（契约 M4：exec 秘密已迁 state 卷，此仅为目录名隐藏）。 */
const HIDDEN_PREFIX = '.dotd';

export interface FsToolResult {
  ok: boolean;
  result?: ToolResult;
}

/** home 内的合法相对路径（已过全部护栏）。 */
export interface SafePath {
  /** 归一化后的绝对路径。 */
  abs: string;
  /** 相对 home 的路径（正斜杠分隔，供回显）。 */
  rel: string;
}

export class PathViolationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'PathViolationError';
    this.code = code;
  }
}

/**
 * 解析 + 校验路径（EX §7 护栏三条：前缀、symlink 双查、隐藏前缀）。
 *
 * 为什么"双查"：先对**父目录** realpath 再拼 basename，可防 basename 本身是
 * 指向 home 外的 symlink（只查父目录会让 `readlink` 出去的 basename 逃逸）；
 * 再对完整路径 realpath 复查一次，防中间层目录是 symlink。
 *
 * @param homeRoot home 卷根（容器内恒 `/dot/home`；测试注入临时目录）
 */
export function resolveHomePath(
  raw: unknown,
  opts: { homeRoot?: string; allowHidden?: boolean } = {},
): SafePath {
  const homeRoot = resolve(opts.homeRoot ?? HOME_ROOT);
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PathViolationError('path 必须是非空字符串', ERROR_CODES.bad_path);
  }
  let p = raw;
  if (!isAbsolute(p)) {
    // /fs/ops 的 path 是 home 相对路径（契约 S4'）；fs.* 工具语义同 home 相对。
    p = join(homeRoot, p);
  }
  const abs = resolve(p);
  if (!isInHome(abs, homeRoot)) {
    throw new PathViolationError(`路径越出 ${homeRoot}：${raw}`, ERROR_CODES.path_outside_home);
  }
  const rel = toRel(abs, homeRoot);
  if (!opts.allowHidden && rel.split('/')[0] === HIDDEN_PREFIX) {
    throw new PathViolationError(
      `路径位于隐藏前缀 ${HIDDEN_PREFIX}/ 下（契约 M4 纵深防御）`,
      ERROR_CODES.path_hidden,
    );
  }

  // symlink 双查
  const cut = abs.lastIndexOf(sep);
  const parent = cut <= 0 ? sep : abs.slice(0, cut);
  const base = cut <= 0 ? abs.slice(1) : abs.slice(cut + 1);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    // 父目录不存在：交给调用方按 not_a_directory / 创建语义处理
    realParent = parent;
  }
  const realAbs = base.length > 0 ? join(realParent, base) : realParent;
  if (!isInHome(realAbs, homeRoot)) {
    throw new PathViolationError(
      `symlink 逃逸（${raw} → ${realAbs}）`,
      ERROR_CODES.symlink_escape,
    );
  }
  const realRel = toRel(realAbs, homeRoot);
  if (!opts.allowHidden && realRel.split('/')[0] === HIDDEN_PREFIX) {
    throw new PathViolationError(
      `symlink 指向隐藏前缀 ${HIDDEN_PREFIX}/ 下`,
      ERROR_CODES.path_hidden,
    );
  }
  return { abs: realAbs, rel: realRel };
}

function isInHome(abs: string, homeRoot: string): boolean {
  return abs === homeRoot || abs.startsWith(`${homeRoot}${sep}`);
}

function toRel(abs: string, homeRoot: string): string {
  const rel = relative(homeRoot, abs);
  return rel.split(sep).join('/');
}

// ── fs.* 工具实现 ────────────────────────────────────────────────────

export interface FsToolsDeps {
  /** home 卷根（容器内恒 `/dot/home`；测试注入临时目录）。 */
  homeRoot?: string;
  /** 时钟注入（测试用）。 */
  now?: () => string;
  /** 读取接口（测试可打桩）。 */
  readFile?: (p: string) => Buffer;
  /** 写入接口（测试可打桩）。 */
  writeFile?: (p: string, data: string | Buffer) => void;
  /** 目录枚举接口（测试可打桩）。 */
  readdir?: (p: string) => string[];
}

const MAX_ENTRIES = 2000;

/**
 * 覆盖前归档（§3.4 .archive/：硬限 32MB、按时间 FIFO）。
 * 2026-10-18 事故催生：模型把 MEMORY.md 写成空串，一千多字记忆瞬间归零。
 * 防清空只挡"整篇写空"，挡不住"写成别的内容"；留旧版本才是最省的兜底。
 */
const ARCHIVE_DIR = '.archive';
/** 超过这个大小的文件不归档（省得把 .archive 一次撑满）。 */
const ARCHIVE_MAX_FILE_BYTES = 512 * 1024;
/** .archive 总量上限（与 limits.ts 的 LIMIT_ARCHIVE_BYTES.hard 同值）。 */
const ARCHIVE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export class FsTools {
  private readonly homeRoot: string;
  private readonly now: () => string;
  private readonly readFile: (p: string) => Buffer;
  private readonly writeFile: (p: string, data: string | Buffer) => void;
  private readonly readdir: (p: string) => string[];

  constructor(deps: FsToolsDeps = {}) {
    this.homeRoot = deps.homeRoot ?? HOME_ROOT;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.readFile = deps.readFile ?? ((p) => readFileSync(p));
    this.writeFile = deps.writeFile ?? ((p, d) => writeFileSync(p, d));
    this.readdir = deps.readdir ?? ((p) => readdirSync(p));
  }

  /** home 卷根（诊断/测试断言用）。 */
  get root(): string {
    return this.homeRoot;
  }

  /** 解析 + 校验（所有入口共用；home 根可注入）。 */
  private resolve(raw: unknown): SafePath {
    return resolveHomePath(raw, { homeRoot: this.homeRoot });
  }

  /**
   * fs.read（EX §7）：返回 UTF-8 文本或 base64。
   * args: {path, encoding?: 'utf8'|'base64'}
   */
  read(callId: string, args: Record<string, unknown>): ToolResult {
    let safe: SafePath;
    try {
      safe = this.resolve(args.path);
    } catch (e) {
      return pathError(callId, e);
    }
    if (!existsSync(safe.abs) || !lstatSync(safe.abs).isFile()) {
      return errorResult(callId, ERROR_CODES.not_a_file, `不是常规文件：${safe.rel}`, false);
    }
    const size = statSync(safe.abs).size;
    if (size > FS_READ_MAX_BYTES) {
      return errorResult(
        callId,
        ERROR_CODES.too_large,
        `fs.read 单文件上限 4MB（实际 ${size} 字节）`,
        false,
      );
    }
    const buf = this.readFile(safe.abs);
    const enc = args.encoding === 'base64' ? 'base64' : 'utf8';
    return okResult(
      callId,
      {
        path: safe.rel,
        size_bytes: buf.byteLength,
        content_base64: enc === 'base64' ? buf.toString('base64') : undefined,
        content: enc === 'base64' ? undefined : buf.toString('utf8'),
        truncated: false,
      },
      { wall_ms: 0, peak_mem_mb: 0 },
    );
  }

  /**
   * fs.write（EX §7）：覆盖写，自动建父目录。
   * args: {path, content? , content_base64?}；单文件 ≤8MB。
   */
  write(callId: string, args: Record<string, unknown>): ToolResult {
    let safe: SafePath;
    try {
      safe = this.resolve(args.path);
    } catch (e) {
      return pathError(callId, e);
    }
    const b64 = args.content_base64;
    const content = args.content;
    let data: Buffer;
    if (typeof b64 === 'string') {
      data = Buffer.from(b64, 'base64');
    } else if (typeof content === 'string') {
      data = Buffer.from(content, 'utf8');
    } else {
      return errorResult(
        callId,
        ERROR_CODES.bad_args,
        'fs.write 需要 content 或 content_base64',
        false,
      );
    }
    if (data.byteLength > FS_WRITE_MAX_BYTES) {
      return errorResult(
        callId,
        ERROR_CODES.too_large,
        `fs.write 单文件上限 8MB（实际 ${data.byteLength} 字节）`,
        false,
      );
    }
    // **乐观并发控制**（2026-10-18）：读-改-写的场景可以传 expected_size 来做 CAS。
    // 实测：10 个并发进程做"读全文→改→写回"，最终只剩 2 行（丢 9 行）——
    // 后写的直接覆盖先写的。模型"读 MEMORY.md → 改 → 写回"正是这个模式，
    // 在 DOTD_MAX_RUNNING>1 时会真实丢数据。
    // 传了 expected_size 就校验当前大小；不符则拒写，模型重读一遍再改即可。
    const expected = args.expected_size;
    if (typeof expected === 'number' && Number.isInteger(expected) && expected >= 0) {
      let current = -1;
      try {
        current = statSync(safe.abs).size;
      } catch {
        current = -1; // 文件不存在 → 只有 expected_size=0 才允许（视为新建）
      }
      const actual = current < 0 ? 0 : current;
      if (actual !== expected) {
        return errorResult(
          callId,
          ERROR_CODES.stale_write,
          `文件在你读取之后已被改动（期望 ${expected} 字节，实际 ${actual} 字节）。` +
            `请重新 fs.read 拿到最新内容，改好后再次写回。`,
          true,
        );
      }
    }
    // **防误清空**（2026-10-18 实测事故）：模型把 MEMORY.md 当成空字符串整篇写回，
    // fs.write 老实执行了 → 一千多字的记忆被清成 0 字节，而且返回 succeeded，
    // 模型下一轮读到空文件还以为是别的问题。
    // 规则：**用一个空内容覆盖一个非空文件**几乎必然是模型的失误（真要清空该用删除），
    // 因此拒写并返回 empty_overwrite，让它重新读一遍确认。
    if (data.byteLength === 0) {
      let currentSize = 0;
      try {
        currentSize = statSync(safe.abs).size;
      } catch {
        currentSize = 0;
      }
      if (currentSize > 0) {
        return errorResult(
          callId,
          ERROR_CODES.empty_overwrite,
          `拒绝用空内容覆盖已有文件 ${safe.rel}（当前 ${currentSize} 字节）。` +
            `如果你是"读-改-写"时拿到空内容，请重新 fs.read 确认原文；真要清空文件请用 shell.run 的 '> file'。`,
          false,
        );
      }
    }
    // **覆盖前留一份旧版本到 .archive/**（2026-10-18）：上一轮测试中模型把 MEMORY.md
    // 写成空串，一千多字记忆瞬间没了 —— 靠外部手段才恢复。记忆类文件必须能回滚。
    // 只对"已有内容且将被覆盖"的文件做；.archive/ 自身与隐藏目录已在 resolve 时排除。
    const archived = this.archiveBeforeOverwrite(safe);
    mkdirSync(safe.abs.slice(0, safe.abs.lastIndexOf(sep)), { recursive: true });
    this.writeFile(safe.abs, data);
    return okResult(
      callId,
      {
        path: safe.rel,
        size_bytes: data.byteLength,
        written_at: this.now(),
        ...(archived === null ? {} : { archived_as: archived }),
      },
      { wall_ms: 0, peak_mem_mb: 0 },
    );
  }

  /**
   * 覆盖前把旧内容存进 `.archive/<时间戳>-<原名>`，返回归档文件名（失败/无需归档返回 null）。
   *
   * 为什么需要（2026-10-18 真实事故）：模型把 MEMORY.md 写成空串，一千多字记忆瞬间归零。
   * 防清空保护能挡住"整篇写空"，但挡不住"写成别的内容"（比如误删一半、覆盖错文件）。
   * 留一份旧版本是最省的兜底——归档目录本来就在协议里预留了（.archive/，硬限 32MB、FIFO）。
   *
   * 纪律：**归档失败绝不能挡住写入**（它只是保险，不是门槛）。
   */
  private archiveBeforeOverwrite(safe: SafePath): string | null {
    try {
      if (safe.rel.length === 0) return null;
      if (safe.rel.split('/').some((seg) => seg.startsWith('.'))) return null; // 隐藏目录不归档
      const old = this.readFile(safe.abs);
      if (old.byteLength === 0) return null; // 空文件没有可留的
      if (old.byteLength > ARCHIVE_MAX_FILE_BYTES) return null; // 太大跳过（.archive 有 32MB 上限）
      const archiveDirAbs = join(this.homeRoot, ARCHIVE_DIR);
      mkdirSync(archiveDirAbs, { recursive: true });
      const stamp = this.now().replace(/[:.]/g, '-');
      const base = safe.rel.replace(/\//g, '_');
      const name = `${stamp}__${base}`;
      this.writeFile(join(archiveDirAbs, name), old);
      this.pruneArchive(archiveDirAbs);
      return `${ARCHIVE_DIR}/${name}`;
    } catch {
      return null;
    }
  }

  /** .archive/ 按时间 FIFO 修剪到配额内（§3.4：硬限 32MB）。失败静默。 */
  private pruneArchive(dirAbs: string): void {
    try {
      const names = this.readdir(dirAbs).sort(); // 时间戳前缀 → 字典序即时间序
      let total = 0;
      const sizes = new Map<string, number>();
      for (const n of names) {
        try {
          sizes.set(n, statSize(join(dirAbs, n)).size);
          total += sizes.get(n) ?? 0;
        } catch {
          /* 忽略单个文件的 stat 失败 */
        }
      }
      let i = 0;
      while (total > ARCHIVE_MAX_TOTAL_BYTES && i < names.length) {
        const n = names[i]!;
        try {
          unlinkSync(join(dirAbs, n));
          total -= sizes.get(n) ?? 0;
        } catch {
          /* 删不掉就跳过 */
        }
        i += 1;
      }
    } catch {
      /* 修剪是尽力而为 */
    }
  }

  /**
   * fs.list（EX §7）：目录枚举，深度 ≤4。
   * args: {path, depth?}
   */
  list(callId: string, args: Record<string, unknown>): ToolResult {
    let safe: SafePath;
    try {
      safe = this.resolve(args.path);
    } catch (e) {
      return pathError(callId, e);
    }
    const depthRaw = args.depth ?? 1;
    if (typeof depthRaw !== 'number' || !Number.isInteger(depthRaw) || depthRaw < 1) {
      return errorResult(callId, ERROR_CODES.bad_args, 'depth 必须是 ≥1 的整数', false);
    }
    if (depthRaw > FS_LIST_MAX_DEPTH) {
      return errorResult(
        callId,
        ERROR_CODES.too_deep,
        `fs.list 深度上限 ${FS_LIST_MAX_DEPTH}`,
        false,
      );
    }
    if (!existsSync(safe.abs) || !lstatSync(safe.abs).isDirectory()) {
      return errorResult(callId, ERROR_CODES.not_a_directory, `不是目录：${safe.rel}`, false);
    }
    const entries: Array<{ name: string; path: string; type: 'file' | 'dir'; size_bytes?: number }> = [];
    const walk = (abs: string, rel: string, depth: number): void => {
      if (entries.length >= MAX_ENTRIES) return;
      for (const name of this.readdir(abs).sort()) {
        if (entries.length >= MAX_ENTRIES) return;
        if (rel === '' && name === HIDDEN_PREFIX) continue; // 纵深防御
        const childAbs = join(abs, name);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        let isDir = false;
        try {
          isDir = lstatSync(childAbs).isDirectory();
        } catch {
          continue; // 枚举中途消失：跳过（并发删除/清理）
        }
        entries.push(
          isDir
            ? { name, path: childRel, type: 'dir' }
            : {
                name,
                path: childRel,
                type: 'file',
                size_bytes: existsSync(childAbs) ? statSync(childAbs).size : undefined,
              },
        );
        if (isDir && depth > 1) walk(childAbs, childRel, depth - 1);
      }
    };
    walk(safe.abs, safe.rel === '.' ? '' : safe.rel, depthRaw);
    return okResult(callId, { path: safe.rel, entries, truncated: entries.length >= MAX_ENTRIES });
  }

  /** fs.stat（EX §7）：mtime/size。 */
  stat(callId: string, args: Record<string, unknown>): ToolResult {
    let safe: SafePath;
    try {
      safe = this.resolve(args.path);
    } catch (e) {
      return pathError(callId, e);
    }
    const st = lstatSync(safe.abs, { throwIfNoEntry: false });
    if (st === undefined) {
      return errorResult(callId, 'not_a_file', `不存在：${safe.rel}`, false);
    }
    return okResult(callId, {
      path: safe.rel,
      type: st.isDirectory() ? 'dir' : 'file',
      size_bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
    });
  }
  /**
   * fs.remove（2026-10-19）：删除一个文件或空目录。
   *
   * **先归档再删**：文件内容会先复制进 .archive/（与覆盖写同一套 FIFO 配额），
   * 然后才 unlink。这样"删错了"还能从归档捞回来。
   * 目录只允许删空的（rmdir），非空目录报 not_empty —— 避免一条误命令删掉整个目录树。
   */
  async remove(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    let safe: SafePath;
    try {
      safe = this.resolve(args.path);
    } catch (e) {
      return pathError(callId, e);
    }
    let st;
    try {
      st = lstatSync(safe.abs, { throwIfNoEntry: false });
    } catch (e) {
      return errorResult(callId, ERROR_CODES.bad_args, String(e), false);
    }
    if (st === undefined) {
      return errorResult(callId, 'not_a_file', `不存在：${safe.rel}`, false);
    }
    if (st.isDirectory()) {
      try {
        rmdirSync(safe.abs);
        return okResult(callId, { path: safe.rel, removed: true, wasDir: true, archivedTo: null });
      } catch {
        return errorResult(callId, 'not_empty', `目录非空，拒绝删除：${safe.rel}（先清空里面的东西）`, false);
      }
    }
    const archived = this.archiveBeforeOverwrite(safe);
    unlinkSync(safe.abs);
    return okResult(callId, {
      path: safe.rel,
      removed: true,
      wasDir: false,
      archivedTo: archived,
    });
  }

  /**
   * 契约 S4'：POST /fs/ops（read|list|stat|rename），与 fs.* 同沙箱。
   * rename 限 home 内（契约逐字）。
   *
   * **返回扁平形状**（`FsOpsResponse`，protocol.ts）而非 ToolResult：
   * 宿主 `src/memory/fsops-client.ts:116-169` 读 `body.content` /
   * `body.entries[].sizeBytes` / `body.stat.sizeBytes`；包一层 ToolResult
   * 会让这些字段全部读空（静默降级），MEM 铁律 B 直接失效。
   */
  fsOps(op: FsOpsOp, path: string, target?: string): FsOpsResponse {
    let safe: SafePath;
    try {
      safe = this.resolve(path);
    } catch (e) {
      return pathOpsError(op, e);
    }
    switch (op) {
      case 'read': {
        if (!existsSync(safe.abs) || !lstatSync(safe.abs).isFile()) {
          return fsOpsError(op, ERROR_CODES.not_a_file, `不是常规文件：${safe.rel}`);
        }
        const size = statSync(safe.abs).size;
        if (size > FS_READ_MAX_BYTES) {
          return fsOpsError(op, ERROR_CODES.too_large, `fs.read 单文件上限 4MB（实际 ${size} 字节）`);
        }
        const buf = this.readFile(safe.abs);
        return fsOpsOk({ op, content: buf.toString('utf8'), encoding: 'utf8' });
      }
      case 'list': {
        if (!existsSync(safe.abs) || !lstatSync(safe.abs).isDirectory()) {
          return fsOpsError(op, ERROR_CODES.not_a_directory, `不是目录：${safe.rel}`);
        }
        const entries: FsOpsListEntry[] = [];
        const walk = (abs: string, rel: string, depth: number): void => {
          if (entries.length >= MAX_ENTRIES) return;
          for (const name of this.readdir(abs).sort()) {
            if (entries.length >= MAX_ENTRIES) return;
            if (rel === '' && name === HIDDEN_PREFIX) continue; // 纵深防御
            const childAbs = join(abs, name);
            const childRel = rel === '' ? name : `${rel}/${name}`;
            let st;
            try {
              st = lstatSync(childAbs);
            } catch {
              continue; // 枚举中途消失：跳过（并发删除/清理）
            }
            const isDir = st.isDirectory();
            entries.push({
              name,
              path: childRel,
              type: isDir ? 'dir' : 'file',
              ...(isDir ? {} : { size: st.size, sizeBytes: st.size }),
              mtime: new Date(st.mtimeMs).toISOString(),
              mtimeMs: st.mtimeMs,
            });
            if (isDir && depth > 1) walk(childAbs, childRel, depth - 1);
          }
        };
        walk(safe.abs, safe.rel === '.' ? '' : safe.rel, 1);
        return fsOpsOk({ op, entries });
      }
      case 'stat': {
        if (!existsSync(safe.abs)) {
          return fsOpsError(op, ERROR_CODES.not_a_file, `不存在：${safe.rel}`);
        }
        const st = statSync(safe.abs);
        const isDir = st.isDirectory();
        return fsOpsOk({
          op,
          stat: {
            path: safe.rel,
            type: isDir ? 'dir' : 'file',
            size: st.size,
            sizeBytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            mtimeMs: st.mtimeMs,
            isDir,
          },
        });
      }
      case 'rename': {
        let dst: SafePath;
        try {
          dst = this.resolve(target ?? '');
        } catch (e) {
          return pathOpsError(op, e);
        }
        mkdirSync(dst.abs.slice(0, dst.abs.lastIndexOf(sep)), { recursive: true });
        renameSync(safe.abs, dst.abs);
        return fsOpsOk({ op, target: dst.rel });
      }
      default:
        return fsOpsError(op, ERROR_CODES.bad_request, `未知 op：${String(op)}`);
    }
  }
}

/** /fs/ops 的路径错误（码名与 fs.* 护栏同词表：path_outside_home/path_hidden/symlink_escape/bad_path）。 */
function pathOpsError(op: FsOpsOp, e: unknown): FsOpsResponse {
  if (e instanceof PathViolationError) {
    return fsOpsError(op, e.code, e.message);
  }
  return fsOpsError(op, ERROR_CODES.bad_args, String(e));
}

function pathError(callId: string, e: unknown): ToolResult {
  if (e instanceof PathViolationError) {
    return errorResult(callId, e.code, e.message, false);
  }
  return errorResult(callId, ERROR_CODES.bad_args, String(e), false);
}
