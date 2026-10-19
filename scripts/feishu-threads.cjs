const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.dotd/dotd.db', { readOnly: true });

console.log('=== 飞书线程 ===');
const threads = db.prepare("SELECT id, dot_id, external_ref, title, created_at FROM mem_threads WHERE channel='feishu'").all();
for (const th of threads) {
  const t = th.created_at ? new Date(Number(th.created_at)).toLocaleString('zh-CN') : '?';
  console.log(`  ${th.id}  ref=${th.external_ref}  ${t}`);
  console.log(`    title: ${th.title || '(无)'}`);
  const msgs = db.prepare("SELECT role, kind, substr(content,1,100) c, created_at FROM mem_messages WHERE thread_id=? ORDER BY seq").all(th.id);
  for (const m of msgs) {
    const mt = m.created_at ? new Date(Number(m.created_at)).toLocaleTimeString('zh-CN') : '?';
    console.log(`      [${mt}] ${m.role}/${m.kind}: ${String(m.c).replace(/\s+/g, ' ')}`);
  }
}

console.log();
console.log('=== 飞书来源的任务 ===');
const tasks = db.prepare(`
  SELECT id, title, status, created_at FROM tasks
  WHERE thread_id IN (SELECT id FROM mem_threads WHERE channel='feishu')
  ORDER BY created_at
`).all();
if (tasks.length === 0) console.log('  （无）');
for (const r of tasks) {
  const t = r.created_at ? new Date(Number(r.created_at)).toLocaleString('zh-CN') : '?';
  console.log(`  [${t}] ${r.status.padEnd(9)} ${String(r.title).slice(0, 55)}`);
}
db.close();
