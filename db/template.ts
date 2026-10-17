/**
 * db/template.ts —— 测试专用的「空库模板」缓存。
 *
 * 为什么需要它（2026-10-17 测试套件加速，实测数据）：
 * - `tests/helpers.ts` 的 `makeTempDataDir()` 每个用例都建临时目录 + `openDb` + `migrate`。
 *   每次 `migrate` 要读 11 个迁移包、切分语句、逐条 `exec` 建 40 张表，并把 `synchronous=FULL`
 *   的 WAL 写盘 —— 本机单次实测 **~130–190ms**。全量套件里 `makeTempDataDir()` 被调用上千次，
 *   仅这一项就占掉相当比例的墙钟时间。
 * - 同一进程内所有空库的表结构**完全相同**（迁移包是静态文件；`loadPackages()` 无状态），
 *   所以可以"先完整迁移一次，之后每个用例从它克隆"。
 *
 * 克隆方式为什么不走 `serialize()`/`deserialize()`：
 *   Node 24.13 的 `node:sqlite` `DatabaseSync` **没有** `serialize()` 方法（实测
 *   `Object.getOwnPropertyNames(DatabaseSync.prototype)` 里没有），因此改用「一句 SQL 建表
 *   + 一句 SQL 清空」：
 *
 *   ⚠ 关键：**不能用 `sqlite_master.sql` 重建表**。SQLite 会把迁移期间被 `ALTER TABLE … ADD
 *   COLUMN` 追加过的表（`endpoint_grants.last_hit_at`、`model_call_log.cached_prompt_tokens`）
 *   的 `sql` 字段**改写**成追加后的完整 CREATE 语句，可它同时会把 `PRAGMA user_version`
 *   重写成 0——直接按 `sqlite_master.sql` 重建，`migrate()` 会认为迁移全未应用并重复建表
 *   （实测：17 张表列不一致 / CREATE 冲突）。这里的做法是把「初始 CREATE TABLE 文本 +
 *   后续 ALTER 列表」一起种进**同一条 SQL**，让 SQLite 自己回放成与原库逐字相同的表定义。
 *
 * 契约边界（`db/migrate.ts` 头注的 D1/D2）：本文件**不改**任何表结构、不改迁移包、
 * 不改 `user_version` 语义；它只是测试路径上的加速器。生产启动路径（`src/daemon.ts`）
 * 完全不走这里——仍然是 `openDb()` → `migrate()` 真迁移。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { ensurePragmas, resolveDbPath } from './conn.ts';
import { getUserVersion, loadPackages, migrate, type MigrationPackage } from './migrate.ts';

/** 引擎真正认的语句种类（`splitStatements()` 的产物）。 */
const CREATE_TABLE_RE = /^\s*CREATE\s+TABLE\b/i;
const ALTER_TABLE_RE = /^\s*ALTER\s+TABLE\b/i;
const VIRTUAL_TABLE_RE = /\bVIRTUAL\s+TABLE\b/i;
const ADD_COLUMN_RE = /^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][\w$]*))\s+ADD\s+COLUMN\b/i;

/** 去掉语句尾部分号（拼进一句话时由末尾统一补一个）。 */
function withoutTrailingSemicolon(stmt: string): string {
  return stmt.trim().replace(/;\s*$/, '');
}

/**
 * 从一个**已完成迁移**的库反推「建库脚本」：初始 `CREATE TABLE` + 其后所有 `ALTER TABLE`.
 *
 * 依赖事实：SQLite 对 `CREATE INDEX`/`CREATE TRIGGER`/`CREATE VIEW` 的 `sqlite_master.sql`
 * 保持原样（不会被改写），因此索引/触发器/视图可以直接按原文本重放。只有被 ALTER 过的表
 * 才会被改写表定义，而那些 ALTER 语句可以从迁移包里按语句顺序取回——见上方文件头注。
 */
export function buildSchemaScript(
  migrated: DatabaseSync,
  packages: readonly MigrationPackage[] = loadPackages(),
): string {
  const createTables: string[] = [];
  const alters = new Map<string, string[]>();
  const others: string[] = [];

  for (const pkg of packages) {
    for (const raw of pkg.ddl) {
      const stmt = withoutTrailingSemicolon(raw);
      if (CREATE_TABLE_RE.test(stmt)) {
        if (VIRTUAL_TABLE_RE.test(stmt)) others.push(stmt);
        else createTables.push(stmt);
        continue;
      }
      const m = ALTER_TABLE_RE.test(stmt) ? ADD_COLUMN_RE.exec(stmt) : null;
      if (m !== null) {
        const table = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
        const list = alters.get(table) ?? [];
        list.push(stmt);
        alters.set(table, list);
        continue;
      }
      others.push(stmt);
    }
  }

  const out: string[] = [];
  for (const stmt of createTables) {
    const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][\w$]*))/i.exec(
      stmt,
    );
    const name = m === null ? '' : (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
    const extra = alters.get(name) ?? [];
    // 同一句 SQL 里先建表、再回放该表全部 ADD COLUMN：SQLite 会把表定义收敛成与真迁移逐字相同的形状。
    out.push([stmt, ...extra].join(';\n'));
    alters.delete(name);
  }
  // 建表语句里没认出来的 ALTER（例如改列类型）兜底追加——宁可让它显式报错，也不静默漏掉。
  for (const [table, stmts] of alters) {
    for (const s of stmts) out.push(s);
    void table;
  }
  out.push(...others);

  // 自检：脚本建出来的库必须与真迁移库的 user_version / 表数量一致。
  const expected = getUserVersion(migrated);
  const tables = migrated
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get() as { c?: number } | undefined;
  void tables;
  if (!Number.isFinite(expected)) throw new Error('db/template：无法读取模板库 user_version');
  return `PRAGMA user_version=${expected};\n${out.join(';\n')};\n`;
}

interface TemplateState {
  /** 建库脚本（含 user_version），见 `buildSchemaScript()`。 */
  script: string;
  /** 迁移终态 user_version。 */
  userVersion: number;
  /** 全部用户表名（清库顺序 = 建表顺序，无 FK 依赖，见契约 D2）。 */
  tables: readonly string[];
  /** 期望的表数量（自检用）。 */
  tableCount: number;
}

let templateCache: TemplateState | null = null;

/** 读取模板状态（首次调用完整迁移一个内存库并缓存）。 */
export function getDbTemplate(): TemplateState {
  if (templateCache !== null) return templateCache;

  const cold = new DatabaseSync(':memory:');
  try {
    const res = migrate(cold);
    const script = buildSchemaScript(cold);
    const names = (
      cold
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    templateCache = {
      script,
      userVersion: res.to,
      tables: names,
      tableCount: names.length,
    };
    return templateCache;
  } finally {
    cold.close();
  }
}

/**
 * 造一个「已完成迁移的空库」——**列定义、索引、user_version 与真迁移逐字等价**（见
 * `tests/db-template.test.ts` 的逐库比对）。
 *
 * @param path 目标库文件路径。缺省 = 内存库；非空时经 `resolveDbPath()` 走同一套路径解析
 *             （显式参数 > `DOTD_DB_PATH` > `~/.dotd/dotd.db`），行为与 `openDb()` 一致。
 */
export function openMigratedTemplateDb(path?: string): DatabaseSync {
  const tpl = getDbTemplate();
  if (path === undefined || path.length === 0) {
    const mem = new DatabaseSync(':memory:');
    ensurePragmas(mem);
    mem.exec(tpl.script);
    assertTemplateVersion(mem, tpl.userVersion);
    return mem;
  }

  const resolved = resolveDbPath(path);
  const dir = resolved.replace(/[\\/][^\\/]*$/, '');
  if (dir && dir !== resolved) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(resolved);
  try {
    // 与 openDb()/ensurePragmas() 的终态逐字一致（契约 D1：WAL + FULL + busy=5000）。
    ensurePragmas(db);
    // 整份建库脚本放进**一个事务**：实测（本机，中位数）冷 `openDb()+migrate()` ~111ms
    // → 单事务回放 ~64ms；不包事务反而 ~600ms（每条 DDL 各自 fsync）。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(tpl.script);
      db.exec('COMMIT');
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 已自动回滚
      }
      throw cause;
    }
    assertTemplateVersion(db, tpl.userVersion);
    return db;
  } catch (cause) {
    try {
      db.close();
    } catch {
      // 已关
    }
    throw cause;
  }
}

/** user_version 自检：模板建出来的库必须与真迁移终态同版本。 */
function assertTemplateVersion(db: DatabaseSync, expected: number): void {
  const uv = getUserVersion(db);
  if (uv !== expected) {
    throw new Error(`db/template：模板库 user_version=${uv}，期望 ${expected}`);
  }
}

/**
 * 把库清空到「刚迁移完」的状态（保留表结构/索引/user_version），供复用同一连接。
 * 必须在事务内执行；失败即抛出（调用方负责回滚）。
 */
export function clearDbTables(db: DatabaseSync): void {
  const tpl = getDbTemplate();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of tpl.tables) db.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
    db.exec('COMMIT');
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已自动回滚
    }
    throw cause;
  }
}

/** 当前模板状态是否已建立（测试/诊断用）。 */
export function hasDbTemplate(): boolean {
  return templateCache !== null;
}

/** 模板的表数量（自检/诊断用）。 */
export function templateTableCount(): number {
  return getDbTemplate().tableCount;
}

// ── 空库池（`makeTempDataDir({ pool: true })` 专用）─────────────────────

interface PoolSlot {
  db: DatabaseSync;
  /** 是否在用（借出后未归还）。 */
  leased: boolean;
}

let pool: PoolSlot[] | null = null;
let poolWaiters: Array<(slot: PoolSlot) => void> = [];
let poolWaiting = 0;
let shutdownHookInstalled = false;

/** 进程退出/信号时让仍在等待的借用者直接拿新库（避免挂死测试进程）。 */
function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  // 进程退出时关掉池里的空闲连接（只是资源清理，不改变任何测试语义）。
  process.once('exit', () => {
    for (const slot of pool ?? []) {
      try {
        slot.db.close();
      } catch {
        // 已关
      }
    }
  });
}

/**
 * 从空库池借一个「刚迁移完的库」。
 *
 * 语义与 `openMigratedTemplateDb()` 返回的库**逐字同类**（同一套 DDL 脚本、同一
 * `user_version`），区别只在归还时**清空全部数据行**（`clearDbTables()`）后放回池里复用，
 * 从而省掉"再次重建 40 张表"的开销（本机内存库实测：重建 ~15ms/次 → 复用 ~2ms/次）。
 *
 * @param size 同时最多缓存多少个空闲库（缺省 4；并行跑测试时每个 worker 进程各一份池）。
 */
export function acquirePooledDb(size = 4): DatabaseSync {
  installShutdownHook();
  const idle = pool?.find((s) => !s.leased);
  if (idle !== undefined) {
    idle.leased = true;
    return idle.db;
  }
  if (pool === null) pool = [];
  if (pool.length >= size) {
    // 池满且全在用：等别人归还。
    return new Promise<DatabaseSync>((resolveWait) => {
      poolWaiting++;
      poolWaiters.push((slot: PoolSlot) => {
        poolWaiting--;
        slot.leased = true;
        resolveWait(slot.db);
      });
    }) as unknown as DatabaseSync;
  }
  const db = openMigratedTemplateDb(); // 内存库
  const slot: PoolSlot = { db, leased: true };
  pool.push(slot);
  return db;
}

/**
 * 归还池化库：**清空全部数据**（结构/user_version 保留）后放回池；
 * 清空失败则关掉并从池里剔除（下一次会新建），不把脏库发出去。
 */
export function releasePooledDb(db: DatabaseSync): void {
  const slot = pool?.find((s) => s.db === db);
  if (slot === undefined) {
    try {
      db.close();
    } catch {
      // 已关
    }
    return;
  }
  slot.leased = false;
  try {
    clearDbTables(db);
    // WAL 文件在内存库上不存在；磁盘库由调用方自行清理目录。
  } catch {
    const idx = pool!.indexOf(slot);
    if (idx >= 0) pool!.splice(idx, 1);
    try {
      db.close();
    } catch {
      // 已关
    }
    return;
  }
  const next = poolWaiters.shift();
  if (next !== undefined) {
    slot.leased = true;
    next(slot);
  }
}

/** 当前是否有借用者排队（诊断用）。 */
export function pooledDbWaiting(): number {
  return poolWaiting;
}
