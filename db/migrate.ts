/**
 * db/migrate.ts —— PRAGMA user_version 迁移 runner（契约 D1–D3）。
 *
 * 契约原文依据：
 * - D1「并发架构」：全 daemon 共享一条连接，WAL + synchronous=FULL + busy_timeout=5000
 *   由启动者设一次；唯一库文件 ~/.dotd/dotd.db；WAL/busy 之外不允许第二进程写库。
 * - D2「DDL 风格」：foreign_keys 不全局 ON（DDL 的 REFERENCES 仅供人阅读，约束靠写入顺序自律）；
 *   同属主 FK 允许；跨模块禁止 REFERENCES。**改表结构必须走迁移包**。
 * - D3「迁移与启动」：SQLite 迁移机制明确为 user_version + 迁移 SQL 文件，不引入 ORM 或
 *   迁移框架。迁移失败 → 拒启动（daemon 侧写 OUTBOX.md，见 CONTEXT 与 CP §7.1 步骤 1）。
 *
 * 版本映射：db/migrations/NNN_*.sql 的 NNN 即目标 user_version
 *   000→0, 010→10, 020→20, 030→30, 040→40, 050→50, 060→60, 070→70,
 *   080→80, 090→90, 100→100
 * （§9.7 里程碑 D1 验收：迁移到 050 后 `PRAGMA user_version` 应为 50；
 *   060 是 2026-10-16 mem_threads.channel 扩 'feishu' 的重建迁移；
 *   070 建 surf_inbound_seen（SF 入站幂等表）；
 *   080 建 endpoint_grants（SF 授权记录）与 last_hit_at 列；
 *   090 补 model_call_log.latency_ms 的既有缺口；
 *   100 补 model_call_log.cached_prompt_tokens（2026-10-17 cache-aware switching 迁移）。
 *   终态 100。**新增迁移包必须同步 src/daemon.ts 的 expectedVersion**，
 *   否则新库首次启动即 MigrationError 拒启动。）
 *
 * 000 基线判定（本文件特有难点）：全新库的 user_version 默认就是 0，而 000 包自己写的也是
 * `PRAGMA user_version=0`，所以"跑没跑过 000"无法从 user_version 区分——必须靠表存在性探测：
 * `events` 表在，即认为 000 基线已应用，跳过 000。这样重复启动不会重复建表。
 *
 * 已验证的 node:sqlite 语义（Node 24.13.0，node:sqlite）：
 * - `db.exec()` 可一次执行含注释的多语句包；整包塞进 `BEGIN IMMEDIATE … COMMIT` 时，
 *   任一句失败 → 整包回滚（探针实测：坏包回滚后连第一条 CREATE TABLE 都不存在）。
 * - `PRAGMA synchronous=FULL` **不允许在事务内执行**（报 "Safety level may not be changed
 *   inside a transaction"，即使值与默认 2 相同）。因此本 runner 把每个包里的 PRAGMA 语句
 *   从事务中拆出、在 BEGIN 之前单独执行——这也是必须做语句级切分的真正原因。
 * - `PRAGMA journal_mode=WAL` 在事务内可执行，但同样统一拆出，保持规则简单一致。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { ensurePragmas } from './conn.ts';
import { MigrationError } from '../src/shared/errors.ts';

export interface MigrationResult {
  /** 迁移前的 user_version */
  from: number;
  /** 迁移后的 user_version（等于已应用包的最大 NNN，全新库跑完八包为 70） */
  to: number;
  /** 本次实际执行的包文件名，按执行顺序 */
  applied: string[];
}

export interface MigrationPackage {
  /** 文件名，如 000_control_plane.sql */
  file: string;
  /** 目标 user_version（文件名前缀 NNN） */
  version: number;
  /** 事务外执行的语句（PRAGMA 等启动期设置） */
  pragmas: string[];
  /** 事务内执行的语句（DDL） */
  ddl: string[];
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** 读当前 user_version。 */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const v = row?.user_version;
  return typeof v === 'number' ? v : 0;
}

/**
 * 表存在性探测。迁移基线判定（events 表）与各模块 `exists(...)` 幂等短路（CP §7.1 步骤 6、
 * execution.md §9 等）都走它，避免各处重复拼 sqlite_master 查询。
 */
export function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
    .get(name) as { x?: number } | undefined;
  return row !== undefined;
}

/** 去掉注释，保留字符串字面量与标识符；仅用于判定语句种类，不用于执行。 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 按 `;` 切分 SQL 包，跳过注释与字符串字面量内部的 `;`。
 * §9.2 的 DDL 中没有出现在字符串字面量内的分号（骨架期已逐条核过），但后续模块新增迁移包时
 * 不依赖这条假设——切分器本身正确处理引号与注释。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const flush = (): void => {
    if (cur.trim().length > 0) statements.push(cur);
    cur = '';
  };
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        cur += sql.slice(i);
        i = n;
      } else {
        cur += sql.slice(i, end + 1);
        i = end + 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        cur += sql.slice(i);
        i = n;
      } else {
        cur += sql.slice(i, end + 2);
        i = end + 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';') {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return statements;
}

/** 读取并按 NNN 前缀排序全部迁移包；PRAGMA 语句与 DDL 语句分开存放。 */
export function loadPackages(dir: string = MIGRATIONS_DIR): MigrationPackage[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (cause) {
    throw new MigrationError(`读不到迁移目录 ${dir}`, null, { cause });
  }
  const packages: MigrationPackage[] = [];
  for (const file of files) {
    const m = /^(\d{3})_[^.]*\.sql$/.exec(file);
    if (m === null) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const pragmas: string[] = [];
    const ddl: string[] = [];
    for (const stmt of splitStatements(sql)) {
      const body = stripComments(stmt).trim();
      if (body.length === 0) continue;
      if (/^PRAGMA\b/i.test(body)) pragmas.push(stmt);
      else ddl.push(stmt);
    }
    packages.push({ file, version: Number(m[1]), pragmas, ddl });
  }
  packages.sort((a, b) => a.version - b.version || a.file.localeCompare(b.file));
  return packages;
}

/**
 * 把迁移推进到最新版本。幂等：已应用的包跳过，可反复调用。
 *
 * 启动序列（CP §7.1 步骤 1）：openDb → **migrate** → 其余模块 init。
 * 失败时抛 MigrationError，且**不留下半套表结构**（每包一个事务，失败即回滚）。
 */
/**
 * 迁移目录里最大的 NNN —— 「库应当到达的版本」的唯一权威来源。
 *
 * 为什么要导出它（2026-10-22）：user_version 的终态此前被 5 个测试文件钉死成字面量 170，
 * 于是每加一个迁移包就得记得改那 5 处，漏一处就是一片红 —— 而红的原因是"数字没跟上"，
 * 不是"迁移没跑"。docs/handoff.md §4.3 记的正是这类"把数字钉死"的坑。
 * 断言改成 `user_version === latestMigrationVersion()` 之后：不变量（终态 = 最大 NNN）
 * 仍然被钉住，具体数字不再需要人手抄一遍。
 */
export function latestMigrationVersion(dir: string = MIGRATIONS_DIR): number {
  const packages = loadPackages(dir);
  if (packages.length === 0) {
    throw new MigrationError(`迁移目录 ${dir} 下没有 NNN_*.sql 迁移包`, null);
  }
  return packages[packages.length - 1]!.version;
}

export function migrate(
  db: DatabaseSync,
  opts: { dir?: string; expectedVersion?: number } = {},
): MigrationResult {
  const dir = opts.dir ?? MIGRATIONS_DIR;

  // 契约 D1：WAL/FULL/busy_timeout 由启动者设一次（与 000 包头部三条 PRAGMA 同值，重复无害）。
  ensurePragmas(db);

  const packages = loadPackages(dir);
  if (packages.length === 0) {
    throw new MigrationError(`迁移目录 ${dir} 下没有 NNN_*.sql 迁移包`, null);
  }
  const target = packages[packages.length - 1]!.version;
  const from = getUserVersion(db);

  // 000 基线探测：全新库 user_version 默认 0，而 000 写的也是 0，只能靠 events 表判断。
  const baselineApplied = hasTable(db, 'events');
  const applied: string[] = [];

  for (const pkg of packages) {
    // 已应用判定：
    // - 非 000 包：version <= from 即已应用（user_version 单调递增）。
    // - 000 包：全新库 user_version 默认 0，而 000 写的也是 0，无法用版本号区分"从未迁移"与
    //   "刚迁移完"；因此看 events 表——表在即基线已应用（无论 from 是 0 还是 50）。
    //   已迁移到更高版本的库若缺 events 表属于库损坏，重跑 000 会让 CREATE TABLE 失败并
    //   抛 MigrationError，这是期望行为（拒启动），不做"自动补表"的猜测。
    const alreadyApplied =
      pkg.version > 0 ? pkg.version <= from : baselineApplied;
    if (alreadyApplied) continue;

    // PRAGMA 语句在事务外执行（node:sqlite 实测：synchronous 不允许事务内改）。
    try {
      for (const p of pkg.pragmas) db.exec(p);
    } catch (cause) {
      throw new MigrationError('执行 PRAGMA 失败', pkg.file, { cause });
    }

    try {
      db.exec('BEGIN IMMEDIATE');
      for (const stmt of pkg.ddl) db.exec(stmt);
      db.exec(`PRAGMA user_version=${pkg.version}`);
      db.exec('COMMIT');
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 事务已由 SQLite 自动回滚时忽略
      }
      throw new MigrationError('应用迁移失败，已回滚', pkg.file, { cause });
    }
    applied.push(pkg.file);
  }

  const to = getUserVersion(db);
  if (opts.expectedVersion !== undefined && to !== opts.expectedVersion) {
    throw new MigrationError(
      `迁移后 user_version=${to}，期望 ${opts.expectedVersion}`,
      null,
    );
  }
  if (to !== target) {
    throw new MigrationError(`迁移后 user_version=${to}，目录中最大版本为 ${target}`, null);
  }

  const integrity = db.prepare('PRAGMA integrity_check').get() as
    | { integrity_check?: string }
    | undefined;
  if (integrity?.integrity_check !== undefined && integrity.integrity_check !== 'ok') {
    throw new MigrationError(`迁移后 integrity_check 未通过：${integrity.integrity_check}`, null);
  }

  return { from, to, applied };
}
