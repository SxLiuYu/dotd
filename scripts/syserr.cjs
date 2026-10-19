const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.dotd/dotd.db', { readOnly: true });

console.log('=== system_error 统计 ===');
for (const r of db.prepare(`
  SELECT substr(content,1,80) c, COUNT(*) n, MAX(created_at) last
  FROM mem_messages WHERE kind='system_error'
  GROUP BY substr(content,1,80) ORDER BY n DESC LIMIT 6
`).all()) {
  const t = r.last ? new Date(Number(r.last)).toLocaleString('zh-CN') : '?';
  console.log(`  ${String(r.n).padStart(4)} 次  最近: ${t}`);
  console.log(`        ${String(r.c).replace(/\s+/g, ' ')}`);
}

console.log();
console.log('=== 最近 24 小时还有 system_error 吗 ===');
const recent = db.prepare(`
  SELECT COUNT(*) c FROM mem_messages WHERE kind='system_error' AND created_at > ?
`).get(Date.now() - 86400000);
console.log(`  ${recent.c} 次`);
db.close();
