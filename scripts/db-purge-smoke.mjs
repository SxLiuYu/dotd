#!/usr/bin/env node
/**
 * scripts/db-purge-smoke.mjs —— 清掉冒烟测试在 live 库里留下的残迹（默认只读盘点）。
 *
 * 背景：早期的飞书冒烟探针用假 chat id `oc_smoke_owner` 打 /hooks/feishu，
 * 于是 events / surf_inbound_seen / mem_threads / tasks 里都留下了带这个 id 的行。
 * 2026-10-17 全方位测试把它列为待清理项：这些行不是真实数据，却会出现在
 * /api/queue、记忆检索、事件列表里，干扰判断（"怎么有条 oc_smoke_owner 的任务"）。
 *
 * 设计约束：
 * - 默认 dry-run：一个字节都不写。要真删必须显式 --apply。
 * - --apply 先 `VACUUM INTO` 做一份带时间戳的完整备份，再动手；备份失败即整体放弃。
 * - 只删**匹配 needle 的行**，不做"看起来相关"的级联清理（FK 本就未全局开启，
 *   但乱级联比留孤儿更危险）。
 * - 逐表打印前后行数，收工给一份可核对的清单。
 *
 * 用法（WSL；daemon 在跑也能跑，WAL 下读写不互斥）：
 *   node scripts/db-purge-smoke.mjs                 # 盘点
 *   node scripts/db-purge-smoke.mjs --apply         # 备份 + 真删
 *   node scripts/db-purge-smoke.mjs --needle oc_xxx # 换清理目标
 *   node scripts/db-purge-smoke.mjs --db /path.db   # 换库（默认 ~/.dotd/dotd.db）
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const NEEDLE = argValue('--needle', 'oc_smoke_owner');
const DB = argValue('--db', join(homedir(), '.dotd', 'dotd.db'));

if (!existsSync(DB)) {
  console.error(`库不在：${DB}`);
  process.exit(3);
}

const db = new DatabaseSync(DB);

// 只扫"装外部 id/负载"的列：逐列 LIKE 全表扫一遍太慢，也没意义。
const CANDIDATE = /id|ref|key|chat|actor|source|payload|json|sig|text|content|title|detail/i;
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => String(r.name));

/** 找出哪些表、哪些列装着 needle，以及各自命中多少行。 */
function scan() {
  const out = [];
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => String(c.name));
    const hit = cols.filter((c) => CANDIDATE.test(c));
    if (hit.length === 0) continue;
    const where = hit.map((c) => `${c} LIKE '%${NEEDLE}%'`).join(' OR ');
    let n = 0;
    try {
      n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get()?.n ?? 0);
    } catch {
      continue;
    }
    if (n > 0) out.push({ table: t, cols: hit, where, rows: n });
  }
  return out;
}

const plan = scan();
console.log(`库：${DB}（${(statSync(DB).size / 1024 / 1024).toFixed(1)} MB）`);
console.log(`目标字串：${NEEDLE}`);
console.log(`模式：${APPLY ? '真删（先备份）' : '只读盘点'}`);

if (plan.length === 0) {
  console.log('没有命中行，收工。');
  db.close();
  process.exit(0);
}

for (const p of plan) console.log(`  ${p.table}: ${p.rows} 行`);

if (!APPLY) {
  console.log('\n（dry-run）加 --apply 才会备份并删除。');
  db.close();
  process.exit(0);
}

// ── 备份：VACUUM INTO 出一致性快照；失败就不动 live ──────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const backupDir = join(dirname(DB), 'backups');
const backupPath = join(backupDir, `dotd-pre-purge-${stamp}.db`);
mkdirSync(backupDir, { recursive: true });
try {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
} catch (cause) {
  console.error(`备份失败（${String(cause)}），放弃删除。live 库未动。`);
  db.close();
  process.exit(4);
}
console.log(`\n已备份 → ${backupPath}`);

// ── 删除 ────────────────────────────────────────────────────────────────
let total = 0;
for (const p of plan) {
  const r = db.prepare(`DELETE FROM ${p.table} WHERE ${p.where}`).run();
  const gone = Number(r.changes ?? 0);
  total += gone;
  console.log(`  删 ${p.table}: ${gone} 行`);
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log(`\n合计删除 ${total} 行；已 checkpoint WAL。`);
console.log('复核：');
for (const p of scan()) console.log(`  ⚠️ ${p.table} 仍有 ${p.rows} 行命中`);
const after = scan();
if (after.length === 0) console.log('  干净了。');
db.close();
