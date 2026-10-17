/**
 * db/conn.ts —— 全 daemon 共享的唯一 SQLite 连接。
 *
 * 依据（逐字对应设计文档）：
 * - 契约 D2：全 daemon 共享一条连接；`WAL + synchronous=FULL + busy_timeout=5000` 由启动者设一次。
 *   db/migrations/000_control_plane.sql 顶部三条 PRAGMA 即"启动者设一次"的落点，因此本文件
 *   不再自设 PRAGMA，只负责"打开同一个库文件"。
 * - 契约 D1：唯一库文件 `~/.dotd/dotd.db`（WSL 内 daemon 用户的 HOME 下）。路径可由环境变量
 *   `DOTD_DB_PATH` 覆盖（GOV 模块经此注入，见 governance.md §7 头注 / 契约 D1）。
 * - 契约 D2：`foreign_keys` 不全局 ON——DDL 中的 REFERENCES 仅供人阅读，约束靠"写入顺序自律"。
 * - WAL/busy 之外不允许第二进程写库（契约 D2）：CLI 只走 HTTP，不直连库。
 *
 * 运行环境 = 本机原生 Windows Node 24（不在 WSL）。内置 `node:sqlite` 已由骨架验证可用：
 *   node -e "new (require('node:sqlite').DatabaseSync)(':memory:'); console.log('OK')"  → OK
 * 因此**不引入 better-sqlite3**（设计文档 §9.6 依赖清单里的 better-sqlite3 由此条替代，
 * 改动的理由与影响记录在 dotd/CONVENTIONS.md「依赖决策」节）。
 */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 契约 D1：唯一库文件路径（可被 DOTD_DB_PATH 覆盖；测试注入临时目录）。 */
export function resolveDbPath(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.DOTD_DB_PATH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dotd', 'dotd.db');
}

/**
 * 契约 D1 的三条启动 PRAGMA，由启动者设一次。与 db/migrations/000_control_plane.sql 头部
 * 三条同值、重复执行无害；迁移 runner 也会调一次，保证任何入口路径都设过。
 *
 * 注意（node:sqlite 实测）：`PRAGMA synchronous` 不允许在事务内执行，所以本函数**只能在
 * 事务外调用**——migrate.ts 正是因此把各迁移包里的 PRAGMA 语句拆到 BEGIN 之前。
 */
export function ensurePragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=FULL;');
  db.exec('PRAGMA busy_timeout=5000;');
}

/**
 * 打开（必要时创建目录）唯一库文件，返回进程内共享连接。
 *
 * 调用方约定：整个 daemon 生命周期内**只调一次**，之后把返回值传给各模块 init
 * （daemon.ts 装配层的 openDb→migrate→模块 init 顺序）。
 * PRAGMA 在此设一次（契约 D1「启动者设一次」）；建表归 migrate.ts。
 */
export function openDb(path?: string): DatabaseSync {
  const dbPath = resolveDbPath(path);
  const dir = dbPath.replace(/[\\/][^\\/]*$/, '');
  if (dir && dir !== dbPath) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensurePragmas(db);
  return db;
}
