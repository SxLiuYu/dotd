/**
 * agent-runtime/tools.ts —— 自造工具（2026-10-19，目标 S2）
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 之前 dotd 只能用 15 个写死的工具。遇到"每周抓一次招聘信息"这种活，
 * 模型每次都得重新写脚本，写完就丢 —— **能力不会积累**。
 * 对标 OpenAI bot，这是硬差距：那边写过的脚本下次能接着用。
 *
 * ── 设计 ────────────────────────────────────────────────────────────
 * 工具 = 磁盘上的一个目录：
 *
 *   /dot/home/tools/<name>/
 *     manifest.json     { name, description, params, entry, returns, createdAt }
 *     run.sh | run.py   entry 指向的可执行文件
 *
 * 调用约定（刻意做得笨拙但可靠）：
 *   - 宿主把参数序列化成**一个 JSON** 塞进 argv[1]，不走环境变量、不走 stdin 管道，
 *     避免 shell 转义地狱（实测：中文/引号/换行经过 bash -c 全容易出事）。
 *   - 工具把结果 PRINT 到 stdout（纯文本或一行 JSON 都行），exit code 表示成败。
 *   - stdout 超过 32KB 截断（防止工具刷屏把上下文撑爆）。
 *
 * ── 安全 ────────────────────────────────────────────────────────────
 * 写工具和执行工具都是**破坏性动作**，宿主侧一律 dangerous 档（需主人审批）。
 * 本文件只负责"存取与执行"，审批在 GOV 层。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TOOLS_DIR_NAME = 'tools';
/** 单次工具输出上限（超出截断） */
const MAX_OUTPUT_BYTES = 32 * 1024;
/** 工具执行默认超时 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 工具清单里的一条（给模型看的） */
export interface ToolManifest {
  name: string;
  description: string;
  /** 参数说明：{ 参数名: 说明 }。工具收到的是 JSON 对象。 */
  params: Record<string, string>;
  /** 入口文件名（相对工具目录），如 'run.sh' / 'run.py' */
  entry: string;
  /** 返回什么（一句话，帮助模型判断该怎么用） */
  returns?: string;
  createdAt?: string;
}

export interface ToolInvokeResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true = 输出被截断过 */
  truncated: boolean;
  elapsedMs: number;
}

/** 工具名合法：小写字母数字与连字符，2..40 字符（要当目录名用，必须保守） */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * 造工具 / 写工具实现。
 *
 * 为什么把写文件和写 manifest 合成一个动作：分开写会出现"manifest 有了但
 * 脚本没写"的半成品，下次 list 时模型看到一个调不通的工具，比没这个工具更糟。
 */
export interface CreateToolInput {
  name: string;
  description: string;
  params?: Record<string, string>;
  entry?: string;
  returns?: string;
  /** 入口文件内容 */
  script: string;
}

export interface ToolsDeps {
  homeRoot: string;
  /** 可注入的 spawn（测试打桩） */
  spawnFn?: typeof spawn;
  now?: () => string;
}

export class ToolStore {
  private readonly homeRoot: string;
  private readonly spawnFn: typeof spawn;
  private readonly now: () => string;

  constructor(deps: ToolsDeps) {
    this.homeRoot = resolve(deps.homeRoot);
    this.spawnFn = deps.spawnFn ?? spawn;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private get toolsRoot(): string {
    return join(this.homeRoot, TOOLS_DIR_NAME);
  }

  private dirOf(name: string): string {
    return join(this.toolsRoot, name);
  }

  /** 校验工具名；不合法返回 null（调用方给 bad_args）。 */
  private safeName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const n = raw.trim();
    return NAME_RE.test(n) ? n : null;
  }

  /** 读一个工具的 manifest；读不到/坏掉返回 null。 */
  readManifest(name: string): ToolManifest | null {
    const dir = this.dirOf(name);
    const f = join(dir, 'manifest.json');
    if (!existsSync(f)) return null;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<ToolManifest>;
      if (typeof raw.description !== 'string' || typeof raw.entry !== 'string') return null;
      return {
        name,
        description: raw.description,
        params: raw.params ?? {},
        entry: raw.entry,
        returns: raw.returns,
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * tool.list：列出全部可用工具。
   *
   * 坏掉的工具（manifest 读不出、入口文件不存在）**也要列出来并标注 broken** ——
   * 静默隐藏会让模型以为"没有这个工具"，然后重复造一个同名的，问题更难查。
   */
  list(): Array<ToolManifest & { broken?: string }> {
    if (!existsSync(this.toolsRoot)) return [];
    const out: Array<ToolManifest & { broken?: string }> = [];
    for (const name of readdirSync(this.toolsRoot).sort()) {
      if (!NAME_RE.test(name)) continue;
      const dir = this.dirOf(name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const m = this.readManifest(name);
      if (m === null) {
        out.push({ name, description: '(manifest 损坏)', params: {}, entry: '', broken: 'manifest_unreadable' });
        continue;
      }
      if (!existsSync(join(dir, m.entry))) {
        out.push({ ...m, broken: 'entry_missing' });
        continue;
      }
      out.push(m);
    }
    return out;
  }

  /**
   * tool.create：落盘一个工具。
   *
   * 同名已存在时的策略：**覆盖**（模型反复迭代同一个工具是常态，禁止覆盖会让它
   * 每次换个名字，最后攒一堆 xxx-v2/xxx-final）。旧版本进 .archive/ 留底。
   */
  create(input: CreateToolInput): { ok: true; manifest: ToolManifest; path: string } | { ok: false; error: string } {
    const name = this.safeName(input.name);
    if (name === null) {
      return { ok: false, error: `工具名不合法（要求小写字母开头、只含小写字母数字连字符、2-40 字符）：${String(input.name)}` };
    }
    if (typeof input.description !== 'string' || input.description.trim().length === 0) {
      return { ok: false, error: 'description 不能为空（要说清楚这个工具干什么，模型靠它决定何时用）' };
    }
    if (typeof input.script !== 'string' || input.script.trim().length === 0) {
      return { ok: false, error: 'script 不能为空（工具的实现代码）' };
    }
    const entry = (typeof input.entry === 'string' && input.entry.trim().length > 0 ? input.entry.trim() : 'run.sh');
    // 入口名不许带路径分隔符 —— 防止 script 写到工具目录外面去
    if (entry.includes('/') || entry.includes('\\') || entry === '.' || entry === '..') {
      return { ok: false, error: `entry 必须是纯文件名（不带路径）：${entry}` };
    }

    const dir = this.dirOf(name);
    mkdirSync(dir, { recursive: true });

    // 覆盖前归档旧版本（沿用 fs.write 的 .archive 思路，只是换成工具自己的一份）
    const oldManifest = this.readManifest(name);
    if (oldManifest !== null) {
      try {
        const archiveDir = join(dir, '.archive');
        mkdirSync(archiveDir, { recursive: true });
        const stamp = this.now().replace(/[:.]/g, '-');
        for (const f of [oldManifest.entry, 'manifest.json']) {
          const src = join(dir, f);
          if (existsSync(src)) writeFileSync(join(archiveDir, `${stamp}__${f}`), readFileSync(src));
        }
      } catch {
        // 归档失败不挡新建（归档是保险，不是门槛）
      }
    }

    const manifest: ToolManifest = {
      name,
      description: input.description.trim(),
      params: input.params ?? {},
      entry,
      returns: input.returns,
      createdAt: this.now(),
    };

    const entryAbs = join(dir, entry);
    writeFileSync(entryAbs, input.script, 'utf8');
    try {
      chmodSync(entryAbs, 0o755);
    } catch {
      // 某些文件系统不支持 chmod；执行时会退化成解释器调用
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    return { ok: true, manifest, path: `${TOOLS_DIR_NAME}/${name}` };
  }

  /** 决定用什么解释器跑入口文件（按扩展名）。 */
  private commandFor(entry: string, argsJson: string): { cmd: string; args: string[] } {
    const e = entry.toLowerCase();
    if (e.endsWith('.py')) return { cmd: 'python3', args: [entry, argsJson] };
    if (e.endsWith('.mjs') || e.endsWith('.js')) return { cmd: 'node', args: [entry, argsJson] };
    if (e.endsWith('.sh')) return { cmd: 'bash', args: [entry, argsJson] };
    // 其它当作可执行文件
    return { cmd: `./${entry}`, args: [argsJson] };
  }

  /**
   * tool.invoke：执行工具。
   *
   * 参数走 argv[1]（JSON 字符串），不走环境变量/stdin —— 实测经过 bash -c
   * 时，带引号和换行的内容只有 argv 是可靠的。
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<ToolInvokeResult | { ok: false; error: string }> {
    const safe = this.safeName(name);
    if (safe === null) return { ok: false, error: `工具名不合法：${name}` };
    const manifest = this.readManifest(safe);
    if (manifest === null) return { ok: false, error: `没有这个工具：${safe}（先用 tool.list 看看有哪些）` };
    const dir = this.dirOf(safe);
    if (!existsSync(join(dir, manifest.entry))) {
      return { ok: false, error: `工具 ${safe} 的入口文件缺失（${manifest.entry}）—— 可能是建到一半失败了` };
    }

    const { cmd, args: cmdArgs } = this.commandFor(manifest.entry, JSON.stringify(args ?? {}));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    return await new Promise<ToolInvokeResult>((done) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;

      const child = this.spawnFn(cmd, cmdArgs, {
        cwd: dir,
        shell: false,
        // 工具只该碰自己的目录：显式给一个干净的环境
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.homeRoot, LANG: 'C.UTF-8' },
      });

      const append = (target: 'out' | 'err', chunk: Buffer): void => {
        const s = chunk.toString('utf8');
        if (target === 'out') {
          if (stdout.length + s.length > MAX_OUTPUT_BYTES) {
            stdout += s.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stdout.length));
            truncated = true;
          } else stdout += s;
        } else {
          if (stderr.length + s.length > MAX_OUTPUT_BYTES) {
            stderr += s.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stderr.length));
          } else stderr += s;
        }
      };

      child.stdout?.on('data', (c: Buffer) => append('out', c));
      child.stderr?.on('data', (c: Buffer) => append('err', c));
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        done({ ok: false, exitCode: -1, stdout, stderr: String(err.message), truncated, elapsedMs: Date.now() - started });
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        done({
          ok: code === 0,
          exitCode: code ?? -1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          truncated,
          elapsedMs: Date.now() - started,
        });
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        done({ ok: false, exitCode: -1, stdout, stderr: `工具执行超时（${timeoutMs}ms）`, truncated, elapsedMs: Date.now() - started });
      }, timeoutMs);
      child.on('close', () => clearTimeout(timer));
    });
  }
}
