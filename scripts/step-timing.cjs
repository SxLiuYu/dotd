const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.dotd/dotd.db', { readOnly: true });

const cands = db.prepare(`
  SELECT t.id, t.title, COUNT(s.seq) steps
  FROM tasks t LEFT JOIN steps s ON s.task_id = t.id
  WHERE t.status='done' AND t.created_at > ?
  GROUP BY t.id ORDER BY steps DESC LIMIT 3
`).all(Date.now() - 3 * 3600 * 1000);
for (const c of cands) console.log(`  ${c.steps} 步  ${String(c.title).slice(0, 50)}`);
console.log();

const t = cands[0];
if (!t) { db.close(); process.exit(0); }

console.log(`=== 明细: ${t.id} 共 ${t.steps} 步 ===`);
let llmTotal = 0;
let toolTotal = 0;
for (const r of db.prepare(`
  SELECT seq, kind, tool_name, status, started_at, finished_at, substr(args_json,1,42) a
  FROM steps WHERE task_id=? ORDER BY seq
`).all(t.id)) {
  const dur = r.started_at && r.finished_at ? Number(r.finished_at) - Number(r.started_at) : 0;
  if (r.kind === 'llm') llmTotal += dur;
  else toolTotal += dur;
  console.log(
    `  ${String(r.seq).padStart(2)} ${String(r.kind).padEnd(5)} ${String(r.tool_name || '').padEnd(10)} ${String(r.status).padEnd(10)} ${(dur / 1000).toFixed(1).padStart(6)}s  ${String(r.a || '').replace(/\s+/g, ' ').slice(0, 40)}`,
  );
}
console.log();
console.log(`  LLM 总耗时: ${(llmTotal / 1000).toFixed(1)}s`);
console.log(`  工具总耗时: ${(toolTotal / 1000).toFixed(1)}s`);
db.close();
