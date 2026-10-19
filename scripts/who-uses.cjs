const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.dotd/dotd.db', { readOnly: true });

// 真实的飞书用户消息：来源是 thread 的 external_ref
console.log('=== 线程来源分布 ===');
for (const r of db.prepare(`
  SELECT channel, COUNT(*) c, MAX(created_at) last FROM mem_threads GROUP BY channel ORDER BY c DESC
`).all()) {
  const t = r.last ? new Date(Number(r.last)).toLocaleString('zh-CN') : '?';
  console.log(`  ${String(r.channel).padEnd(10)} ${String(r.c).padStart(4)} 个线程   最近: ${t}`);
}

console.log();
console.log('=== 我的测试任务 vs 可能的真实任务 ===');
const all = db.prepare("SELECT title FROM tasks").all();
const testPatterns = [
  /probe/i, /health/i, /ABS-PATH/i, /TEST/i, /验证/i, /只回复/i, /只回/i,
  /创建.*\.txt/i, /计算 \d+\*/i, /写入/i, /确认/i, /读.*health/i, /zen/i,
  /主人发来/i, /smoke/i, /HEALTH/i, /计算 25\*4/i, /144\*7/i, /ab-test/i,
  /周报/i, /预算计算/i, /今天几号/i, /收入 25000/i, /什么操作系统/i,
  /读取 \/etc/i, /\/root\/\.dotd/i, /读容器/i,
];
let testCount = 0;
let other = [];
for (const r of all) {
  const title = String(r.title || '');
  if (testPatterns.some((p) => p.test(title))) testCount += 1;
  else other.push(title);
}
console.log(`  像是我的测试: ${testCount} / ${all.length}`);
console.log(`  其他: ${other.length}`);
console.log();
console.log('=== 其他任务的标题（前 20）===');
for (const t of other.slice(0, 20)) console.log(`  ${t.slice(0, 70)}`);
db.close();
