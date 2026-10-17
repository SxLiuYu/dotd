import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/root/.dotd/dotd.db');
const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all();
console.log('tasks cols:', JSON.stringify(cols.map((c) => c.name)));
const rows = db
  .prepare(
    `SELECT id, status, title, stop_reason AS stopReason, updated_at AS updatedAt
     FROM tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT 8`,
  )
  .all();
console.log('未完成任务:', JSON.stringify(rows, null, 1));
const all = db.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all();
console.log('状态分布:', JSON.stringify(all));
